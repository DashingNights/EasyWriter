//! Shrink Selection (Shift+F8) and moving or copying the selection to the caret (F2 and Shift+F2, then Enter), stage 2b gaps
//! G52 and Home's single-command list (docs/plans/engine/stage2/gaps.md, editing-keys).

use serde_json::Value;
use ew_doc::Pos;

use crate::cmd::caret::{Unit, unit_range};
use crate::cmd::{delete_selection, parse_pos, sel_result};
use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("select.shrink", "Shrink Selection", "Editing › Selection", shrink)
            .params(r#"{"at"?: Pos (where F8 started; default the selection's start)}"#)
            .pure(),
        CommandSpec::new("edit.moveTo", "Move or Copy Text", "Editing", move_to)
            .params(r#"{"anchor": Pos, "focus": Pos, "copy"?: bool} (the text to move, or copy, to the caret)"#),
    ]
}

/// Whether range `outer` holds range `inner` and more.
fn holds_more(outer: &(Pos, Pos), inner: &(Pos, Pos)) -> bool {
    outer.0 <= inner.0 && inner.1 <= outer.1 && outer != inner
}

/// Shift+F8: the selection one step smaller round where F8 started (`at`): the document to the paragraph, the paragraph to the
/// sentence, the sentence to the word, the word to a caret. A caret stays.
fn shrink(s: &mut Session, v: &Value) -> CmdResult {
    let cur = s.sel.ordered();
    if cur.0 == cur.1 {
        return sel_result(s);
    }
    let at = v.get("at").and_then(parse_pos).map(|p| s.doc.clamp(&p)).filter(|p| cur.0 <= *p && *p <= cur.1).unwrap_or_else(|| cur.0.clone());
    let mut next = Selection::caret(at.clone());
    for unit in [Unit::Paragraph, Unit::Sentence, Unit::Word] {
        let r = unit_range(s, &at, unit);
        if holds_more(&cur, &r) {
            next = Selection { anchor: r.0, focus: r.1 };
            break;
        }
    }
    s.sel = next;
    sel_result(s)
}

/// Where position `p`, after `b`, is once `a..b` is deleted without tracking: the rest of `b`'s paragraph joins `a`'s, and the
/// blocks after it in the same container move up by the paragraphs that went. `a` and `b` share a container.
fn after_delete(p: &Pos, a: &Pos, b: &Pos) -> Pos {
    if p.story != b.story || p < b {
        return p.clone();
    }
    if p.path == b.path {
        return Pos { story: a.story, path: a.path.clone(), off: a.off + (p.off - b.off) };
    }
    let depth = a.path.parent().len();
    let gone = b.path.last().saturating_sub(a.path.last()) as u32;
    let mut q = p.clone();
    if q.path.0.len() > depth && q.path.0[..depth] == *a.path.parent() {
        q.path.0[depth] = q.path.0[depth].saturating_sub(gone);
    }
    q
}

/// F2 or Shift+F2 then Enter: the text `anchor..focus` moves (or, with `copy`, is copied) to the caret, as one undo step, and
/// is selected there. Moving text into itself is refused, as Word does.
// ponytail: the moved text must start and end in one container (not across a table's edge); a selection that crosses one is
// refused rather than mapped through the deletion.
fn move_to(s: &mut Session, v: &Value) -> CmdResult {
    let pos = |k: &str| v.get(k).and_then(parse_pos).ok_or_else(|| CmdError::Params(format!("bad `{k}`")));
    let (a, b) = (s.doc.clamp(&pos("anchor")?), s.doc.clamp(&pos("focus")?));
    let (a, b) = if a <= b { (a, b) } else { (b, a) };
    let copy = p::bool(v, "copy").unwrap_or(false);
    if a == b {
        return Err(CmdError::Disabled("edit.moveTo: nothing to move".into()));
    }
    if a.story != b.story || a.path.parent() != b.path.parent() {
        return Err(CmdError::Failed("edit.moveTo: the text to move crosses a table's edge".into()));
    }
    let t = s.sel.focus.clone();
    if !copy && a < t && t < b {
        return Err(CmdError::Failed("edit.moveTo: the text cannot move into itself".into()));
    }
    let frag = s.doc.copy_range(&a, &b);
    let tracked = s.doc.settings.track_changes;
    let (start, end) = if copy || t <= a {
        // The caret comes first (or nothing is deleted): taking the source away after it leaves the caret where it is.
        if !copy {
            s.sel = Selection { anchor: a.clone(), focus: b.clone() };
            delete_selection(s)?;
        }
        s.sel = Selection::caret(t.clone());
        crate::cmd::paste::insert(s, frag)?;
        (t, s.sel.focus.clone())
    } else {
        // The caret comes after the source: insert first, then delete the source, which moves the inserted text up.
        s.sel = Selection::caret(t.clone());
        crate::cmd::paste::insert(s, frag)?;
        let end = s.sel.focus.clone();
        s.sel = Selection { anchor: a.clone(), focus: b.clone() };
        delete_selection(s)?;
        if tracked { (t, end) } else { (after_delete(&t, &a, &b), after_delete(&end, &a, &b)) }
    };
    s.sel = Selection { anchor: start, focus: end };
    sel_result(s)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use ew_doc::StoryRef;

    use crate::Session;

    fn session(text: &str) -> Session {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("document.setText", &json!({ "text": text })).unwrap();
        s
    }
    fn at(block: usize, off: usize) -> serde_json::Value {
        json!({"block": block, "off": off})
    }
    fn selected(s: &Session) -> String {
        let (a, b) = s.sel.ordered();
        s.doc.copy_range(&a, &b).plain_text()
    }

    #[test]
    fn shrink_walks_back_from_the_document_to_a_caret() {
        let mut s = session("One two. Three four.\nNext paragraph.");
        s.run("select.all", &json!({})).unwrap();
        let origin = json!({"at": at(0, 10)}); // in "Three"
        s.run("select.shrink", &origin).unwrap();
        assert_eq!(selected(&s).trim_end(), "One two. Three four.");
        s.run("select.shrink", &origin).unwrap();
        assert_eq!(selected(&s).trim_end(), "Three four.");
        s.run("select.shrink", &origin).unwrap();
        assert_eq!(selected(&s).trim_end(), "Three");
        s.run("select.shrink", &origin).unwrap();
        assert!(s.sel.is_collapsed());
        assert_eq!(s.sel.focus.off, 10);
    }

    #[test]
    fn move_after_the_source_in_one_paragraph_and_undo_as_one_step() {
        let mut s = session("alpha beta gamma");
        s.run("caret.set", &json!({"pos": at(0, 16)})).unwrap();
        s.run("edit.moveTo", &json!({"anchor": at(0, 0), "focus": at(0, 6)})).unwrap();
        assert_eq!(s.doc.plain_text(StoryRef::Body).trim_end(), "beta gammaalpha");
        assert_eq!(selected(&s), "alpha ");
        s.run("edit.undo", &json!({})).unwrap();
        assert_eq!(s.doc.plain_text(StoryRef::Body).trim_end(), "alpha beta gamma");
    }

    #[test]
    fn move_a_paragraph_down_and_copy_one_up() {
        let mut s = session("First\nSecond\nThird");
        s.run("caret.set", &json!({"pos": at(2, 5)})).unwrap();
        s.run("edit.moveTo", &json!({"anchor": at(0, 0), "focus": at(1, 0)})).unwrap();
        assert_eq!(s.doc.plain_text(StoryRef::Body).trim_end(), "Second\nThirdFirst");
        assert_eq!(selected(&s), "First\n");
        s.run("caret.set", &json!({"pos": at(0, 0)})).unwrap();
        s.run("edit.moveTo", &json!({"anchor": at(0, 0), "focus": at(0, 6), "copy": true})).unwrap();
        assert!(s.doc.plain_text(StoryRef::Body).starts_with("SecondSecond"));
    }

    #[test]
    fn move_into_itself_is_refused() {
        let mut s = session("alpha beta");
        s.run("caret.set", &json!({"pos": at(0, 2)})).unwrap();
        assert!(s.run("edit.moveTo", &json!({"anchor": at(0, 0), "focus": at(0, 5)})).is_err());
        assert_eq!(s.doc.plain_text(StoryRef::Body).trim_end(), "alpha beta");
    }
}
