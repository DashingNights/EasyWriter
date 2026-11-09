//! Several selections at once, Word's multiple selection (EasyWriter's engine-multi-select, docs/plans/engine/stage2.md G22):
//! Ctrl+click, Ctrl+drag and Ctrl+double or triple click add a range (`select.add`, then `keep` on the gesture's later
//! calls), and Select All n Instances (`select.style`), Find In (`edit.advancedFind` with `select`, [`find_in`]), Select Text
//! with Similar Formatting (`select.similar`) and the host (`select.ranges`) make several. The active range stays in
//! `Session::sel`, so every command reads it as before, and the others wait in `Session::multi`, tagged with it: a command
//! that moves the selection drops them, and one range costs nothing more. The ranges are positions, not block ids: a command
//! that keeps them never moves text under them, which a test runs every command to prove.
//!
//! With several ranges, as in Word:
//! - character and paragraph formatting go to every range as one command, so one undo step (format.rs's `apply` and
//!   `resolved` and `selected_paths` read every range; a toggle such as Bold turns on unless every range has it). Change
//!   Case and Clear All Formatting, which read the selection themselves, run once per range.
//! - Copy and Cut take every range in the order they were selected, a paragraph mark between pieces (a 2009 report of Word's
//!   discontinuous selection, thewordoflaw.blogspot.com/2009/11/discontinuous-selection.html: the paste follows the order
//!   the items were selected in, with a paragraph mark between them).
//! - Delete and Backspace remove every range; the caret ends where the first one in the document was, as a column block's
//!   delete leaves it at the block's first row (column.rs). ponytail: no source gives Word's caret after it.
//! - Typing, Paste and every other edit act on the active range alone: the others are deselected first, as VBA's
//!   Selection.ShrinkDiscontiguousSelection keeps only the most recently selected text. Word overtypes one range only: the
//!   Atlantis Word Processor forum lists overtyping every range as something Atlantis does and Word does not.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use ew_doc::edit::Fragment;
use ew_doc::{PartKind, Pos, StoryRef};
use serde_json::{Value, json};

use super::{parse_pos, pos_json, sel_result};
use crate::{CmdError, CmdResult, CommandSpec, Multi, Selection, Session, p};

/// A command's function, as `Session::run` passes it to the dispatchers.
type Run = fn(&mut Session, &Value) -> CmdResult;

/// Find In's kinds of story, as Word's menu orders them, and the parts each searches.
const STORY_PLACES: [(&str, &[PartKind]); 5] = [
    ("headers", &[PartKind::Header, PartKind::Footer]),
    ("footnotes", &[PartKind::Footnote]),
    ("endnotes", &[PartKind::Endnote]),
    ("comments", &[PartKind::Comment]),
    ("textBoxes", &[PartKind::TextBox]),
];

/// Most ranges one call takes from its caller (hostile params): every command while they hold walks them.
const MAX_RANGES: usize = 100_000;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("select.add", "Add to Selection", "Editing › Selection", add)
            .params(r#"{"anchor": Pos, "focus": Pos} (the selection there is stays as another range unless it is a caret)"#)
            .pure(),
        CommandSpec::new("select.ranges", "Select Ranges", "Editing › Selection", ranges)
            .params(r#"{"ranges": [{"anchor": Pos, "focus": Pos}]} (the last one is the active range, where the caret is)"#)
            .pure(),
        CommandSpec::new("select.list", "Selected Ranges", "Editing › Selection", |s, _| Ok(list(s)))
            .params(r#"{} → {ranges: [{anchor, focus}]} in the order they were selected, the active one last"#)
            .pure(),
        CommandSpec::new("select.style", "Select All Instances", "Home › Styles", select_style)
            .params(r#"{"style": id} → {count}: every paragraph of the body in paragraph style `style`, every stretch of text in character style `style`"#)
            .pure(),
        CommandSpec::new("edit.findInPlaces", "Find In Places", "Home › Editing › Find", |s, _| Ok(places(s)))
            .params(r#"{} → {places}: what Find In offers, in the order of Word's menu: "selection" while text is selected, "main", then each kind of story the document holds ("headers", "footnotes", "endnotes", "comments", "textBoxes")"#)
            .pure(),
    ]
}

/// `edit.findInPlaces`.
fn places(s: &Session) -> Value {
    let selected = !s.sel.is_collapsed() || !s.other_ranges().is_empty();
    let stories = STORY_PLACES.iter().filter(|(_, kinds)| !stories_of(s, kinds).is_empty()).map(|(name, _)| *name);
    let all: Vec<&str> = selected.then_some("selection").into_iter().chain(["main"]).chain(stories).collect();
    json!({"places": all})
}

/// The stories Find In searches for a kind of story: each part of `kinds`, but for text boxes only those the main document
/// shows (Word's item is "Text Boxes in Main Document": a text box in a header is not one of them).
fn stories_of(s: &Session, kinds: &[PartKind]) -> Vec<StoryRef> {
    let is = |st: &StoryRef| matches!(st, StoryRef::Part(id) if s.doc.parts.get(id).is_some_and(|p| kinds.contains(&p.kind)));
    if kinds == [PartKind::TextBox] {
        return s.doc.counted_stories().into_iter().filter(is).collect();
    }
    s.doc.parts.keys().map(|id| StoryRef::Part(*id)).filter(is).collect()
}

/// Find In: `edit.advancedFind` with `in` (edit.rs, once it has read the search options) → {count, matches (the first 200),
/// highlight, comment?}; with `select` every match becomes a range of the selection, as Word selects them. `main` searches the
/// body and `selection` every range of the selection, as Word searches each one. A kind of story (`headers` for headers and
/// footers, `footnotes`, `endnotes`, `comments`, `textBoxes`) searches each story of that kind: `count` is every match, and
/// `matches` (what `select` selects) those of the first story holding any, since a selection lies in one story; `comment` names
/// the thread (its first comment) whose comment that story is the text of, and `inComment` that comment. `textBoxes` searches
/// the text boxes the main document shows ([`stories_of`]).
pub(crate) fn find_in(s: &mut Session, v: &Value) -> CmdResult {
    let search = super::edit::search;
    let place = p::str(v, "in").unwrap_or("main");
    let (found, count) = match place {
        "main" => {
            let f = search(s, StoryRef::Body)?;
            let n = f.len();
            (f, n)
        }
        "selection" => {
            // Every range, in document order and apart from one another (`set` joins any that overlap).
            let ranges: Vec<(Pos, Pos)> = s.multi_ranges().unwrap_or_else(|| vec![s.sel.ordered()]).into_iter().filter(|(a, b)| a != b).collect();
            let Some(story) = ranges.first().map(|(a, _)| a.story) else {
                return Err(CmdError::Params("`in: selection` needs a selection".into()));
            };
            let mut f = search(s, story)?;
            f.retain(|(x, y)| {
                let i = ranges.partition_point(|(a, _)| a <= x);
                i > 0 && ranges.get(i - 1).is_some_and(|(_, b)| y <= b)
            });
            let n = f.len();
            (f, n)
        }
        _ => {
            let kinds = STORY_PLACES.iter().find(|(name, _)| *name == place).map(|(_, k)| *k).ok_or_else(|| {
                CmdError::Params(format!("`in` is main, selection, headers, footnotes, endnotes, comments or textBoxes, not `{place}`"))
            })?;
            let (mut first, mut n) = (Vec::new(), 0);
            for story in stories_of(s, kinds) {
                let f = search(s, story)?;
                n += f.len();
                if first.is_empty() {
                    first = f;
                }
            }
            (first, n)
        }
    };
    let matches: Vec<Value> = found.iter().take(200).map(|(a, b)| json!({"start": pos_json(a), "end": pos_json(b)})).collect();
    let mut out = json!({"count": count, "matches": matches, "highlight": s.find.highlight});
    if let Some(StoryRef::Part(part)) = found.first().map(|(a, _)| a.story)
        && let Some((&id, c)) = s.doc.comments.iter().find(|(_, c)| c.part == part)
    {
        // The thread's first comment: a reply's card is its thread's.
        let (mut top, mut parent) = (id, c.parent);
        for _ in 0..s.doc.comments.len() {
            let Some(up) = parent.filter(|p| s.doc.comments.contains_key(p)) else { break };
            (top, parent) = (up, s.doc.comments.get(&up).and_then(|c| c.parent));
        }
        out["comment"] = json!(top);
        out["inComment"] = json!(id);
    }
    if p::bool(v, "select") == Some(true) && !found.is_empty() {
        set(s, found.iter().map(|(a, b)| Selection { anchor: a.clone(), focus: b.clone() }).collect());
    }
    s.find.current = 0;
    s.find.results = found;
    Ok(out)
}

/// Runs a command with the ranges of a multiple selection in mind (called by `Session::run` for every command), then
/// through the column block's dispatch (column.rs), which a multiple selection never meets: making either moves the selection.
pub(crate) fn dispatch(s: &mut Session, id: &str, mutates: bool, run: fn(&mut Session, &Value) -> CmdResult, v: &Value) -> CmdResult {
    let column = super::column::dispatch;
    // Ranges the selection has moved away from are gone.
    if s.multi.as_ref().is_some_and(|m| m.sel != s.sel) {
        s.multi = None;
    }
    let Some(m) = s.multi.clone() else { return column(s, id, mutates, run, v) };
    // A gesture that adds a range goes on (a Ctrl+drag, the sentence of a Ctrl+click): the active range moves, the others stay.
    if p::bool(v, "keep") == Some(true) && id != "select.add" && (id.starts_with("select.") || id.starts_with("caret.")) {
        let r = column(s, id, mutates, run, v)?;
        if s.sel == m.sel {
            s.multi = Some(m);
        } else {
            keep(s, m.others.to_vec());
        }
        return Ok(r);
    }
    match id {
        "edit.copy" => copy(s),
        "edit.cut" => {
            let r = copy(s)?;
            delete(s)?;
            Ok(r)
        }
        "text.delete" | "text.backspace" | "text.deleteWordBack" | "text.deleteWordForward" => {
            delete(s)?;
            sel_result(s)
        }
        "format.changeCase" | "format.clear" | "format.resetChar" => each(s, run, v, m),
        _ if !mutates || every_range(id) => column(s, id, mutates, run, v),
        // Typing, Paste and any other edit: the active range alone.
        _ => {
            s.multi = None;
            column(s, id, mutates, run, v)
        }
    }
}

/// Whether edit `id` keeps a multiple selection: formatting, which goes to every range, and Undo and Repeat, which bring
/// back or repeat a step on them. Commands under those prefixes that move text (a paragraph up, a sort) or put a field in
/// act on the active range alone.
fn every_range(id: &str) -> bool {
    matches!(id, "edit.undo" | "edit.redo" | "edit.undoTo" | "edit.repeat")
        || (id.starts_with("format.") && !matches!(id, "format.enclose" | "format.combineCharacters" | "format.phonetic"))
        || (id.starts_with("para.") && !matches!(id, "para.moveUp" | "para.moveDown" | "para.sort"))
}

/// Makes `list` the selection, its last range the active one. Ranges that overlap are joined first, so no text is in two.
pub(crate) fn set(s: &mut Session, list: Vec<Selection>) {
    let mut list = disjoint(list);
    let Some(active) = list.pop() else { return };
    s.sel = active;
    keep(s, list);
}

/// The active range stays as it is and `others` (in the order selected) become the other ranges, less those in another
/// story than the active one or overlapping it: a range added over another replaces it.
fn keep(s: &mut Session, mut others: Vec<Selection>) {
    let (a, b) = s.sel.ordered();
    others.retain(|r| {
        let (x, y) = r.ordered();
        x.story == a.story && !(x < b && a < y) && !(r.is_collapsed() && a == b && x == a)
    });
    s.multi = (!others.is_empty()).then(|| Multi { sel: s.sel.clone(), others: Arc::new(others), id: NEXT_ID.fetch_add(1, Ordering::Relaxed) });
}

/// `list` with overlapping ranges joined, in the order given when none overlap (the order selected, which Copy keeps), else
/// in document order.
fn disjoint(list: Vec<Selection>) -> Vec<Selection> {
    let mut spans: Vec<(Pos, Pos)> = list.iter().map(Selection::ordered).collect();
    spans.sort();
    if spans.windows(2).all(|w| matches!(w, [(_, b), (x, _)] if b <= x)) {
        return list;
    }
    let mut out: Vec<Selection> = Vec::with_capacity(spans.len());
    for (x, y) in spans {
        match out.last_mut() {
            Some(last) if x < last.focus => last.focus = last.focus.clone().max(y),
            _ => out.push(Selection { anchor: x, focus: y }),
        }
    }
    out
}

fn range_of(v: &Value) -> Result<(Pos, Pos), CmdError> {
    let a = v.get("anchor").and_then(parse_pos).ok_or_else(|| CmdError::Params("bad `anchor`".into()))?;
    let b = v.get("focus").and_then(parse_pos).ok_or_else(|| CmdError::Params("bad `focus`".into()))?;
    Ok((a, b))
}

/// `select.add`: the selection there is (unless it is a caret) joins the other ranges and `anchor..focus` becomes the active
/// one, as a Ctrl+click or Ctrl+drag starts in Word.
fn add(s: &mut Session, v: &Value) -> CmdResult {
    let (a, b) = range_of(v)?;
    let mut others = s.other_ranges().to_vec();
    if !s.sel.is_collapsed() {
        others.push(s.sel.clone());
    }
    s.sel = Selection { anchor: s.doc.clamp(&a), focus: s.doc.clamp(&b) };
    keep(s, others);
    Ok(count(s))
}

/// `select.ranges`: the host's ranges (the registry's x.selection.multi).
fn ranges(s: &mut Session, v: &Value) -> CmdResult {
    let list = v.get("ranges").and_then(Value::as_array).ok_or_else(|| CmdError::Params("`ranges` must be an array".into()))?;
    if list.is_empty() || list.len() > MAX_RANGES {
        return Err(CmdError::Params(format!("`ranges` holds 1 to {MAX_RANGES} ranges")));
    }
    let mut out = Vec::with_capacity(list.len());
    for r in list {
        let (a, b) = range_of(r)?;
        out.push(Selection { anchor: s.doc.clamp(&a), focus: s.doc.clamp(&b) });
    }
    set(s, out);
    Ok(count(s))
}

/// The selection after a command that made ranges: the active one and how many there are.
fn count(s: &Session) -> Value {
    json!({"anchor": pos_json(&s.sel.anchor), "focus": pos_json(&s.sel.focus), "count": s.other_ranges().len() + 1})
}

fn list(s: &Session) -> Value {
    let all: Vec<Value> =
        s.other_ranges().iter().chain([&s.sel]).map(|r| json!({"anchor": pos_json(&r.anchor), "focus": pos_json(&r.focus)})).collect();
    json!({"ranges": all})
}

/// `select.style`: the Styles pane's Select All n Instances, the instances the pane counts (styles.usage): each paragraph of
/// the body whose paragraph style is `style` (no style is Normal), its text, and each stretch of runs in character style
/// `style`. None leaves the selection as it is.
fn select_style(s: &mut Session, v: &Value) -> CmdResult {
    let id = p::req_str(v, "style")?;
    let story = StoryRef::Body;
    let mut found = Vec::new();
    for path in s.doc.para_paths(story) {
        let Some(para) = s.doc.para(story, &path) else { continue };
        let at = |off| Pos { story, path: path.clone(), off };
        if para.props.style.as_deref().unwrap_or("Normal") == id {
            found.push(Selection { anchor: at(0), focus: at(para.len()) });
            continue;
        }
        let mut open = None;
        for (r, c) in para.run_ranges() {
            match (c.style.as_deref() == Some(id), open) {
                (true, None) => open = Some(r.start),
                (false, Some(start)) => {
                    found.push(Selection { anchor: at(start), focus: at(r.start) });
                    open = None;
                }
                _ => {}
            }
        }
        if let Some(start) = open {
            found.push(Selection { anchor: at(start), focus: at(para.len()) });
        }
    }
    let n = found.len();
    if n > 0 {
        set(s, found);
    }
    Ok(json!({"count": n}))
}

/// Copy and Cut: every range in the order selected, a paragraph mark between them.
fn copy(s: &mut Session) -> CmdResult {
    let pieces: Vec<(Pos, Pos)> = s.other_ranges().iter().chain([&s.sel]).map(Selection::ordered).filter(|(a, b)| a != b).collect();
    let mut frag = Fragment::default();
    for (a, b) in &pieces {
        let f = s.doc.copy_range(a, b);
        frag.blocks.extend(f.blocks);
        frag.parts.extend(f.parts);
    }
    if frag.blocks.is_empty() {
        return Ok(json!({"text": ""}));
    }
    s.clipboard_text = frag.clipboard_text();
    s.clip_history.push(&frag, &s.clipboard_text);
    s.clipboard = Some(frag);
    Ok(super::edit::copy_result(s))
}

/// Delete and Backspace: every range, the last in the document first so the positions before it hold, each as one range
/// goes (Track Changes, content controls); the caret ends where the first one was.
fn delete(s: &mut Session) -> Result<(), CmdError> {
    let ranges = s.multi_ranges().unwrap_or_default();
    s.multi = None;
    let mut at = s.sel.ordered().0;
    for (a, b) in ranges.into_iter().rev().filter(|(a, b)| a != b) {
        s.sel = Selection { anchor: a, focus: b };
        at = super::delete_selection(s)?;
    }
    s.sel = Selection::caret(at);
    s.goal_x = None;
    s.pending = None;
    Ok(())
}

/// A command that reads the selection itself (Change Case, Clear All Formatting): once per range, then the ranges are
/// selected again.
fn each(s: &mut Session, run: Run, v: &Value, m: Multi) -> CmdResult {
    let mut all: Vec<Selection> = m.others.iter().cloned().chain([s.sel.clone()]).collect();
    s.multi = None;
    each_range(s, run, v, &mut all, &mut [])?;
    s.sel = all.pop().expect("the active range");
    if s.sel == m.sel && *m.others == all {
        s.multi = Some(m);
    } else {
        keep(s, all);
    }
    sel_result(s)
}

/// Runs `run`, a command that reads the selection itself, with each of `ranges` that holds text as the selection, the last in
/// the document first: several ranges here, a column block's rows in column.rs. Offsets are in bytes, so a run that changes
/// the byte length of its range's last paragraph (a case change: ſ to S, İ to i̇) moves every position of `ranges` and `more`
/// at or after the range's end there, which keeps each range, its own end included, on its text. The selection is left as the
/// last run left it.
pub(crate) fn each_range(s: &mut Session, run: Run, v: &Value, ranges: &mut [Selection], more: &mut [Pos]) -> Result<(), CmdError> {
    let mut order: Vec<usize> = (0..ranges.len()).collect();
    order.sort_by(|&i, &j| ranges[j].ordered().cmp(&ranges[i].ordered()));
    for i in order {
        let (a, b) = ranges[i].ordered();
        if a == b {
            continue;
        }
        let len = |s: &Session| s.doc.para_at(&b).map_or(0, |p| p.len());
        let before = len(s);
        s.sel = Selection { anchor: a, focus: b.clone() };
        run(s, v)?;
        let after = len(s);
        if after != before {
            for p in ranges.iter_mut().flat_map(|r| [&mut r.anchor, &mut r.focus]).chain(more.iter_mut()) {
                if p.story == b.story && p.path == b.path && p.off >= b.off {
                    p.off = (p.off + after).saturating_sub(before);
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use ew_doc::props::Align;
    use ew_doc::{Pos, StoryRef};
    use serde_json::{Value, json};

    use crate::Session;

    /// A session holding `paras`, one paragraph each, with the caret at the start.
    fn session(paras: &[&str]) -> Session {
        let mut s = Session::new(ew_doc::Document::new());
        for (i, t) in paras.iter().enumerate() {
            if i > 0 {
                run(&mut s, "text.newParagraph", json!({}));
            }
            run(&mut s, "text.insert", json!({"text": t}));
        }
        run(&mut s, "caret.docStart", json!({}));
        s
    }

    fn run(s: &mut Session, id: &str, v: Value) -> Value {
        s.run(id, &v).unwrap_or_else(|e| panic!("{id}: {e}"))
    }

    fn at(block: usize, off: usize) -> Value {
        json!({"block": block, "off": off})
    }

    /// Selects block `b`'s `from..to`, then adds each of `more` as another range.
    fn pick(s: &mut Session, b: usize, from: usize, to: usize, more: &[(usize, usize, usize)]) {
        run(s, "select.range", json!({"anchor": at(b, from), "focus": at(b, to)}));
        for (b, from, to) in more {
            run(s, "select.add", json!({"anchor": at(*b, *from), "focus": at(*b, *to)}));
        }
    }

    fn texts(s: &Session) -> Vec<String> {
        s.doc.plain_text(StoryRef::Body).split('\n').map(str::to_string).collect()
    }

    fn bold(s: &Session, b: usize, off: usize) -> bool {
        s.doc.para_at(&Pos::body(b, off)).is_some_and(|p| p.props_of_char(off).bold == Some(true))
    }

    fn count(s: &mut Session) -> usize {
        run(s, "select.list", json!({}))["ranges"].as_array().map_or(0, Vec::len)
    }

    #[test]
    fn formatting_goes_to_every_range_as_one_undo_step() {
        let mut s = session(&["alpha beta gamma delta"]);
        pick(&mut s, 0, 0, 5, &[(0, 11, 16)]); // alpha, gamma
        assert_eq!(count(&mut s), 2);
        run(&mut s, "format.bold", json!({}));
        assert!(bold(&s, 0, 1) && bold(&s, 0, 12) && !bold(&s, 0, 7), "alpha and gamma bold, beta not");
        assert_eq!(count(&mut s), 2, "formatting keeps both ranges");
        run(&mut s, "edit.undo", json!({}));
        assert!(!bold(&s, 0, 1) && !bold(&s, 0, 12), "one Undo takes both back");
        assert_eq!(count(&mut s), 2, "Undo brings both ranges back");
        run(&mut s, "edit.redo", json!({}));
        assert!(bold(&s, 0, 1) && bold(&s, 0, 12));
        assert_eq!(count(&mut s), 2, "so does Redo");
    }

    #[test]
    fn a_toggle_turns_on_unless_every_range_has_it() {
        let mut s = session(&["alpha beta gamma"]);
        pick(&mut s, 0, 0, 5, &[]);
        run(&mut s, "format.bold", json!({}));
        pick(&mut s, 0, 11, 16, &[(0, 0, 5)]); // the bold range is the active one
        run(&mut s, "format.bold", json!({}));
        assert!(bold(&s, 0, 1) && bold(&s, 0, 12), "Bold over a bold and a plain range bolds both");
        run(&mut s, "format.bold", json!({}));
        assert!(!bold(&s, 0, 1) && !bold(&s, 0, 12), "and again takes it off both");
    }

    #[test]
    fn paragraph_formatting_goes_to_every_ranges_paragraphs() {
        let mut s = session(&["one", "two", "three"]);
        pick(&mut s, 0, 0, 2, &[(2, 1, 3)]);
        run(&mut s, "para.alignCenter", json!({}));
        let align = |s: &Session, b| s.doc.para_at(&Pos::body(b, 0)).and_then(|p| p.props.align);
        assert_eq!((align(&s, 0), align(&s, 1), align(&s, 2)), (Some(Align::Center), None, Some(Align::Center)));
    }

    #[test]
    fn copy_and_cut_take_every_range_in_the_order_selected() {
        let mut s = session(&["alpha beta gamma delta"]);
        pick(&mut s, 0, 11, 16, &[(0, 0, 5)]); // gamma first, then alpha
        let r = run(&mut s, "edit.copy", json!({}));
        assert_eq!(r["text"].as_str().map(|t| t.replace("\r\n", "\n")), Some("gamma\nalpha".into()), "a paragraph mark between pieces");
        run(&mut s, "edit.cut", json!({}));
        assert_eq!(texts(&s), [" beta  delta"]);
        assert_eq!(count(&mut s), 1);
    }

    #[test]
    fn delete_removes_every_range_and_typing_only_the_active_one() {
        let mut s = session(&["alpha beta gamma delta"]);
        pick(&mut s, 0, 0, 6, &[(0, 11, 17)]);
        run(&mut s, "text.delete", json!({}));
        assert_eq!(texts(&s), ["beta delta"]);
        assert_eq!(s.sel.focus, Pos::body(0, 0), "the caret where the first range was");
        run(&mut s, "edit.undo", json!({}));
        assert_eq!(count(&mut s), 2);
        run(&mut s, "text.insert", json!({"text": "X"}));
        assert_eq!(texts(&s), ["alpha beta Xdelta"], "typing replaces the active range alone");
        assert_eq!(count(&mut s), 1, "and the others are deselected");
    }

    #[test]
    fn moving_the_caret_drops_the_other_ranges_and_a_gesture_keeps_them() {
        let mut s = session(&["One two. Three four. Five six."]);
        pick(&mut s, 0, 0, 3, &[]);
        run(&mut s, "select.add", json!({"anchor": at(0, 15), "focus": at(0, 15)}));
        run(&mut s, "select.sentence", json!({"keep": true}));
        assert_eq!(count(&mut s), 2, "Ctrl+click: the sentence joins the first range");
        assert_eq!(s.selected_text().replace("\r\n", "\n"), "One\nThree four. ");
        run(&mut s, "caret.right", json!({}));
        assert_eq!(count(&mut s), 1);
    }

    #[test]
    fn similar_formatting_style_instances_and_find_in_make_ranges() {
        let mut s = session(&["alpha beta gamma", "delta"]);
        pick(&mut s, 0, 0, 5, &[(0, 11, 16), (1, 0, 5)]);
        run(&mut s, "format.italic", json!({}));
        run(&mut s, "caret.docStart", json!({}));
        let r = run(&mut s, "select.similar", json!({}));
        assert_eq!((r["ranges"].as_u64(), count(&mut s)), (Some(3), 3), "each italic stretch");
        run(&mut s, "caret.docStart", json!({}));
        let r = run(&mut s, "edit.advancedFind", json!({"text": "a", "select": true}));
        assert_eq!((r["count"].as_u64(), count(&mut s)), (Some(6), 6), "Find In selects every match");
        run(&mut s, "caret.docStart", json!({}));
        run(&mut s, "para.style", json!({"style": "Heading1"}));
        let r = run(&mut s, "select.style", json!({"style": "Normal"}));
        assert_eq!((r["count"].as_u64(), count(&mut s)), (Some(1), 1), "one Normal paragraph left");
        let r = run(&mut s, "select.style", json!({"style": "Heading1"}));
        assert_eq!(r["count"].as_u64(), Some(1));
    }

    #[test]
    fn change_case_goes_to_every_range() {
        let mut s = session(&["alpha beta gamma"]);
        pick(&mut s, 0, 0, 5, &[(0, 11, 16)]);
        run(&mut s, "format.changeCase", json!({"mode": "upper"}));
        assert_eq!(texts(&s), ["ALPHA beta GAMMA"]);
        assert_eq!(count(&mut s), 2);
    }

    #[test]
    fn a_case_change_that_changes_byte_length_keeps_every_range_on_its_text() {
        // ſ (2 bytes) upper-cases to S (1 byte), İ (2 bytes) lower-cases to i̇ (3 bytes): the ranges after it in the
        // paragraph, and the changed range's own end, move with the text.
        let mut s = session(&["ſtar und haus"]);
        pick(&mut s, 0, 0, 5, &[(0, 10, 14)]); // ſtar, haus
        run(&mut s, "format.changeCase", json!({"mode": "upper"}));
        assert_eq!(texts(&s), ["STAR und HAUS"]);
        assert_eq!(s.selected_text().replace("\r\n", "\n"), "STAR\nHAUS");
        run(&mut s, "text.delete", json!({}));
        assert_eq!(texts(&s), [" und "]);

        let mut s = session(&["İSTANBUL VE EV"]);
        pick(&mut s, 0, 0, 9, &[(0, 13, 15)]); // İSTANBUL, EV
        run(&mut s, "format.changeCase", json!({"mode": "lower"}));
        assert_eq!(s.selected_text().replace("\r\n", "\n"), "i\u{307}stanbul\nev");
    }

    #[test]
    fn a_paragraph_style_goes_to_every_range_and_clears_each_ones_direct_size() {
        let mut s = session(&["one", "two", "three"]);
        pick(&mut s, 0, 0, 3, &[(2, 0, 5)]);
        run(&mut s, "format.size", json!({"size": 20}));
        pick(&mut s, 0, 1, 2, &[(2, 1, 2)]);
        run(&mut s, "styles.apply", json!({"style": "Heading 1"}));
        let p = |s: &Session, b| s.doc.para_at(&Pos::body(b, 0)).cloned().unwrap();
        assert_eq!((p(&s, 0).props.style, p(&s, 1).props.style, p(&s, 2).props.style), (Some("Heading1".into()), None, Some("Heading1".into())));
        assert_eq!((p(&s, 0).props_of_char(1).size, p(&s, 2).props_of_char(1).size), (None, None), "direct size cleared in both");
        assert_eq!(count(&mut s), 2);
    }

    /// The ranges are positions, so a command that kept them while it moved text under one would leave it on other text
    /// (engine-multi-select-2 item 5). Every command runs here with several ranges selected and with each of a few common
    /// arguments; where the same set of ranges is still selected after it, each must hold the text it held, a case change
    /// aside (the fixture's text is ASCII, so a case change keeps the set, `each` making a new one only when lengths change). A new
    /// command that fails here moves text: `dispatch` must deselect the other ranges for it (it acts on the active range alone,
    /// as `every_range` decides) or move them with the text.
    #[test]
    fn every_command_that_keeps_the_ranges_keeps_them_on_their_text() {
        let base = session(&["Alpha beta gamma.", "Delta epsilon.", "Zeta eta theta.", "Iota kappa lambda."]).doc.clone();
        let range = |(b0, o0): (usize, usize), (b1, o1): (usize, usize)| json!({"anchor": at(b0, o0), "focus": at(b1, o1)});
        // beta; epsilon. to Zeta (two paragraphs); kappa, the active one.
        let ranges = json!({"ranges": [range((0, 6), (0, 10)), range((1, 6), (2, 4)), range((3, 5), (3, 10))]});
        let args = [
            json!({}),
            json!({"on": true}),
            json!({"on": false}),
            json!({"size": 20}),
            json!({"style": "Heading1"}),
            json!({"mode": "upper"}),
            json!({"color": "#FF0000"}),
            json!({"name": "Arial"}),
            json!({"value": 2}),
            json!({"level": 1}),
            json!({"text": "x"}),
            json!({"by": 1}),
        ];
        let texts = |s: &Session| -> Vec<String> {
            s.other_ranges().iter().chain([&s.sel]).map(|r| {
                let (a, b) = r.ordered();
                s.doc.copy_range(&a, &b).plain_text().to_lowercase()
            }).collect()
        };
        let (mut kept, mut moved) = (0, Vec::new());
        for spec in crate::cmd::registry().all() {
            // These reach outside the session (files), as in hostile_params_never_panic.
            if spec.id.starts_with("file.") || spec.id == "insert.picture" || spec.id == "insert.textFromFile" {
                continue;
            }
            for v in &args {
                let mut s = Session::new(base.clone());
                run(&mut s, "select.ranges", ranges.clone());
                let (before, set) = (texts(&s), s.multi.as_ref().map(|m| m.id));
                let _ = s.run(spec.id, v);
                // Still the same set of ranges (a command that makes a new set, Select Similar say, is not keeping them).
                if s.other_ranges().is_empty() || s.multi.as_ref().map(|m| m.id) != set {
                    continue;
                }
                kept += 1;
                let after = texts(&s);
                if after != before {
                    moved.push(format!("{} {v}: {before:?} became {after:?}", spec.id));
                }
            }
        }
        assert!(moved.is_empty(), "commands that kept the ranges but moved text under them:\n{}", moved.join("\n"));
        assert!(kept > 500, "only {kept} command and argument pairs kept the ranges: the test no longer reaches the commands it checks");
    }

    #[test]
    fn a_column_blocks_rows_stay_on_their_text_after_a_case_change_that_changes_byte_length() {
        // The column block's rows go through the same walk (`each_range`): ſ (2 bytes) upper-cases to S (1 byte).
        // An x leads each paragraph, so AutoCorrect's capital (the first paragraph's) falls outside the block.
        let mut s = session(&["xſab", "xſab"]);
        let c = run(&mut s, "select.column", json!({"anchor": at(0, 1), "focus": at(1, 4)}));
        assert_eq!(c["rows"], json!(["ſa", "ſa"]));
        let r = run(&mut s, "format.changeCase", json!({"mode": "upper"}));
        assert_eq!(texts(&s), ["XSAb", "xSAb"]);
        assert_eq!(r["rows"], json!(["SA", "SA"]), "each row still holds the two letters it held");
    }

    #[test]
    fn find_in_the_selection_searches_every_range() {
        let mut s = session(&["one cat", "two cat", "three cat"]);
        pick(&mut s, 0, 0, 7, &[(2, 0, 9)]); // the first and last paragraphs
        let r = run(&mut s, "edit.advancedFind", json!({"text": "cat", "in": "selection", "select": true}));
        assert_eq!(r["count"].as_u64(), Some(2), "a match in each range, none in the paragraph between");
        assert_eq!(s.selected_text().replace("\r\n", "\n"), "cat\ncat");
    }

    #[test]
    fn find_in_a_kind_of_story_selects_the_matches_of_the_first_one_holding_any() {
        let mut s = session(&["cat in the body"]);
        run(&mut s, "insert.header", json!({"text": "cat and cat"}));
        run(&mut s, "caret.docStart", json!({}));
        let places = run(&mut s, "edit.findInPlaces", json!({}));
        assert_eq!(places["places"], json!(["main", "headers"]), "no selection, and the one kind of story the document holds");
        let r = run(&mut s, "edit.advancedFind", json!({"text": "cat", "in": "headers", "select": true}));
        assert_eq!(r["count"].as_u64(), Some(2));
        assert!(s.in_header_footer(), "the matches are selected in the header");
        assert_eq!(s.selected_text().replace("\r\n", "\n"), "cat\ncat");
        assert!(s.run("edit.advancedFind", &json!({"text": "cat", "in": "footnotes"})).is_ok_and(|r| r["count"] == 0), "a kind the document lacks finds nothing");
        assert!(s.run("edit.advancedFind", &json!({"text": "cat", "in": "margins"})).is_err());
    }

    #[test]
    fn find_in_text_boxes_searches_the_main_document_s_only() {
        let mut s = session(&["cat in the body"]);
        run(&mut s, "insert.header", json!({"text": "Head"}));
        run(&mut s, "insert.textBox", json!({"text": "a cat in the header's box"}));
        run(&mut s, "caret.set", json!({"pos": at(0, 0)}));
        run(&mut s, "insert.textBox", json!({"text": "a cat in the body's box"}));
        run(&mut s, "caret.docStart", json!({}));
        let r = run(&mut s, "edit.advancedFind", json!({"text": "cat", "in": "textBoxes", "select": true}));
        assert_eq!(r["count"].as_u64(), Some(1), "Word's Text Boxes in Main Document: the header's box is not one");
        let StoryRef::Part(part) = s.sel.focus.story else { panic!("the match is selected in a text box") };
        assert_eq!(s.doc.plain_text(StoryRef::Part(part)), "a cat in the body's box");
    }

    #[test]
    fn find_in_comments_names_the_comment_holding_the_matches() {
        let mut s = session(&["cat in the body"]);
        run(&mut s, "select.all", json!({}));
        let top = run(&mut s, "review.newComment", json!({"text": "no match here"}))["id"].clone();
        let reply = run(&mut s, "review.reply", json!({"id": top, "text": "a cat and a cat"}))["id"].clone();
        let r = run(&mut s, "edit.advancedFind", json!({"text": "cat", "in": "comments", "select": true}));
        assert_eq!((r["count"].as_u64(), &r["comment"], &r["inComment"]), (Some(2), &top, &reply), "the thread's card, and the reply that holds the matches");
        assert_eq!(s.selected_text().replace("\r\n", "\n"), "cat\ncat", "Word selects the matches in the comment");
    }

    #[test]
    fn overlapping_ranges_join() {
        let mut s = session(&["alpha beta gamma"]);
        run(&mut s, "select.ranges", json!({"ranges": [{"anchor": at(0, 0), "focus": at(0, 7)}, {"anchor": at(0, 5), "focus": at(0, 10)}, {"anchor": at(0, 11), "focus": at(0, 16)}]}));
        assert_eq!(count(&mut s), 2);
        run(&mut s, "text.delete", json!({}));
        assert_eq!(texts(&s), [" "]);
    }
}
