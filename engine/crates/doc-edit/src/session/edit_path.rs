//! The bounded edit path of the typing keys (EasyWriter's engine-edit-path and engine-keys). Typing, Enter, Backspace and
//! Delete change a few neighbouring blocks of the caret's container (its story or table cell) and nothing else, so
//! [`Session::run`] keeps those blocks and the undo stacks to put back on failure instead of a copy of the whole document
//! (whose copy, comparison and drop cost about as much as the rest of the key), and skips the walks over the whole
//! document after it: tidying the stories and text boxes, which such an edit can't untidy. Content controls, which the
//! handlers would otherwise look up by scanning the story up to three times a key, are found through an index of the
//! top-level blocks holding their markers and the blocks each one spans: made once for the document's revision and carried
//! from key to key, since a key typed where no marker is changes none of them. A key inside a control that spans several
//! paragraphs is bounded too when every control around it takes typing as plain text would (editable, showing no
//! placeholder, taking paragraph breaks): the handlers then do with it what they do with no control.
//!
//! Every other command, and a key where any of this does not hold, takes the whole-document path as before.
use std::collections::HashMap;

use serde_json::Value;
use ew_doc::para::OBJ;
use ew_doc::{Block, Blocks, ControlKind, Document, InlineObject, Paragraph, Path, Pos, StoryRef};

use super::doc_state::Selection;
use super::{Arc, CharProps, Session, Undo};

/// What [`Session::run`] keeps instead of a copy of the document for a bounded edit: the blocks of one container the
/// command may change, from `path` on, and the undo stacks.
pub(super) struct Light {
    pub(super) story: StoryRef,
    /// The range's first block; its parent names the container.
    pub(super) path: Path,
    /// The range's blocks as they were.
    pub(super) blocks: Vec<Arc<Block>>,
    /// The container's length before the command: the blocks after the range move by its change.
    pub(super) len: usize,
    pub(super) sel: Selection,
    /// The undo and redo stacks, the open typing step and the steps evicted so far, as they were.
    pub(super) stacks: (Vec<Arc<Undo>>, Vec<Arc<Undo>>, bool, u64),
}

/// The index bounded edits use, and whether they are on.
#[derive(Default)]
pub(super) struct EditPath {
    /// Off: every command takes the whole-document path (the randomised test's reference).
    off: bool,
    /// The document id and revision the index describes.
    key: Option<(u64, u64)>,
    /// The document id and revision a command left tidy (every story and cell holds a paragraph, no text box story is
    /// left without its box). A bounded edit keeps it so, which makes the tidying after it unneeded.
    tidy: Option<(u64, u64)>,
    /// Per story, the content controls' reach: which top-level blocks hold a marker or wrap, and each control's span.
    reach: HashMap<StoryRef, Reach>,
    /// While a bounded edit runs: its story, the first and last top-level blocks it may change (none reached by a content
    /// control) and the story's top-level length then.
    free: Option<(StoryRef, usize, usize, usize)>,
    /// Bounded edits made so far, for tests and benches.
    done: u64,
}

impl Session {
    /// Turns bounded edits on (the default) or off, so a test can compare them with the whole-document path.
    #[doc(hidden)]
    pub fn set_light_edits(&mut self, on: bool) {
        self.edit_path.off = !on;
        self.edit_path.key = None;
    }

    /// Bounded edits made so far.
    #[doc(hidden)]
    pub fn light_edits(&self) -> u64 {
        self.edit_path.done
    }

    /// The undo steps (`redo` false) or redo steps, oldest first: each one's label, document, selection and the formatting
    /// waiting at the caret. For tests that compare two sessions' histories.
    #[doc(hidden)]
    pub fn history_steps(&self, redo: bool) -> Vec<(&str, &Document, &Selection, &Option<CharProps>)> {
        let steps = if redo { &self.redo } else { &self.history };
        steps.iter().map(|u| (u.label.as_str(), &u.doc, &u.sel, &u.pending)).collect()
    }

    /// The bounded edit for command `id` with `params`, if it is one: a typing key in a container no content control
    /// reaches, in a tidy document, with no overtype, Track Changes, protection, column block, multiple selection or equation. Each of these
    /// could change more than the blocks [`Session::light_range`] names.
    pub(super) fn light_edit(&mut self, id: &str, params: &Value) -> Option<Light> {
        let settings = &self.doc.settings;
        if self.edit_path.off
            || self.join_next
            || self.equation_join_next
            || self.ime_text_join.is_some()
            || self.math.is_some()
            || self.column.is_some()
            || self.multi.is_some()
            || self.prefs.overtype
            || settings.protection.is_some()
            || settings.track_changes
        {
            return None;
        }
        let key = (self.document_id, self.rev);
        if self.edit_path.tidy != Some(key) {
            return None;
        }
        let (path, n) = self.light_range(id, params)?;
        let story = self.sel.focus.story;
        if self.edit_path.key != Some(key) {
            self.edit_path.key = Some(key);
            self.edit_path.reach.clear();
        }
        if !self.edit_path.reach.contains_key(&story) {
            let reach = control_reach(&self.doc, story);
            self.edit_path.reach.insert(story, reach);
        }
        let first = path.last();
        // The top-level blocks the range is in: its own, or the table holding its cell.
        let (t0, t1) = match path.0.as_slice() {
            [_] => (first, first + n - 1),
            [t, ..] => (*t as usize, *t as usize),
            [] => return None,
        };
        if !self.edit_path.reach.get(&story)?.free(t0, t1) {
            return None;
        }
        let top = self.doc.story(story)?.len();
        let container = self.doc.container(story, &path)?;
        let blocks = container.get(first..first + n)?.to_vec();
        let len = container.len();
        self.edit_path.free = Some((story, t0, t1, top));
        Some(Light {
            story,
            path,
            blocks,
            len,
            sel: self.sel.clone(),
            stacks: (self.history.clone(), self.redo.clone(), self.typing_open, self.undo_evicted),
        })
    }

    /// The blocks command `id` can change at the selection, as their container's first block and count, when it changes
    /// nothing else: typed text (not a list label's space, which adds a list), Enter (with the paragraph before where its
    /// AutoFormat may change it), and Backspace or Delete of plain text or of a paragraph mark between two paragraphs (past the
    /// bookmark, comment and permission marks the key steps over, which stay). A
    /// deletion holding an object (a picture, a note reference, a text box, a field) or a section break, or that reaches
    /// into a table, is not one.
    fn light_range(&self, id: &str, params: &Value) -> Option<(Path, usize)> {
        let (a, b) = self.sel.ordered();
        if a.story != b.story || a.path.parent() != b.path.parent() {
            return None;
        }
        let doc = &self.doc;
        let pa = doc.para_at(&a)?;
        // Typing inside an inline control: known without the index, which the whole-document path would make stale again.
        if has_markers(pa) {
            return None;
        }
        let blocks = doc.container(a.story, &a.path)?;
        let (ia, ib) = (a.path.last(), b.path.last());
        let range = |i: usize, j: usize| Some((a.path.with_last(i), j + 1 - i));
        let collapsed = a == b;
        let flag = |k: &str| params.get(k).and_then(Value::as_bool).unwrap_or(false);
        // Where Backspace's character ends and Delete's starts: they step over bookmark, comment and permission marks.
        let (back, fwd) = (pa.before_range_marks(a.off), pa.after_range_marks(a.off));
        match id {
            "text.insert" => {
                let text = params.get("text")?.as_str()?;
                // A space after a list label ("1." or "*") at a paragraph's start makes a list, a new one in the numbering.
                if flag("paragraphs") || text.contains(['\r', '\u{2029}']) || (text == " " && !flag("raw") && a.off <= 2) {
                    return None;
                }
                plain_between(blocks, &a, &b)?;
                range(ia, ib)
            }
            "text.newParagraph" => {
                plain_between(blocks, &a, &b)?;
                // Enter's AutoFormat makes the paragraph before a heading (after an empty one) or gives it a bottom border
                // (after a line of "---" and the like), so the range takes it in where either may happen.
                let line = |t: &str| t.len() >= 3 && t.chars().all(|c| t.starts_with(c) && "-_=*~#".contains(c));
                let before = !collapsed || (self.prefs.autocorrect.heading_styles && pa.is_empty()) || line(&pa.text);
                range(if before { ia.saturating_sub(1) } else { ia }, ib)
            }
            "text.backspace" | "text.delete" if !collapsed => {
                plain_between(blocks, &a, &b)?;
                range(ia, ib)
            }
            "text.backspace" if back > 0 => plain(pa.text.get(pa.backspace_from(back)..back)?).then(|| range(ia, ia))?,
            "text.backspace" => {
                let p = &pa.props;
                // At the paragraph's start: its list number, list indent or first-line indent goes first.
                if p.numbering.is_some_and(|n| n.num != 0) || p.style.as_deref() == Some("ListParagraph") {
                    return range(ia, ia);
                }
                if p.indent_first.is_some_and(|x| x > 0.0) || p.indent_first_chars.is_some_and(|x| x > 0.0) {
                    return range(ia, ia);
                }
                // A left indent may go back a tab stop (Set left- and first-indent with tabs and backspaces).
                if p.indent_left.is_some_and(|x| x > 0.0) || p.indent_left_chars.is_some_and(|x| x > 0.0) {
                    return None;
                }
                if ia == 0 {
                    return range(ia, ia);
                }
                // The paragraph before takes this one; a section break on its mark would join the next section.
                match &**blocks.get(ia - 1)? {
                    Block::Para(q) if q.section.is_none() && !has_markers(q) => range(ia - 1, ia),
                    _ => None,
                }
            }
            "text.delete" if fwd < pa.len() => plain(pa.text.get(fwd..pa.next_boundary(fwd))?).then(|| range(ia, ia))?,
            // Joining the next paragraph takes this one's section break with it, which changes the following section's break
            // too (`Document::delete_range` absorbs it there), outside the range.
            "text.delete" => match blocks.get(ia + 1).map(|b| &**b) {
                Some(Block::Para(q)) if pa.section.is_none() && !has_markers(q) => range(ia, ia + 1),
                // The last paragraph: nothing to join, but its section break would go.
                None if pa.section.is_none() => range(ia, ia),
                _ => None,
            },
            _ => None,
        }
    }

    /// Whether a bounded edit runs where `p` is, in blocks no content control reaches: the content control commands need
    /// not look for one there. The edit's top-level blocks are those it started with, grown or shrunk by the blocks it has
    /// added or taken away so far (they are all next to it).
    pub(crate) fn outside_controls(&self, p: &Pos) -> bool {
        let Some((story, t0, t1, top)) = self.edit_path.free else { return false };
        let (Some(&b), Some(now)) = (p.path.0.first(), self.doc.story(story).map(Vec::len)) else { return false };
        let end = t1 as isize + now as isize - top as isize;
        p.story == story && b as usize >= t0 && b as isize <= end
    }

    /// The bounded edit's command has run (or failed): where it ran is no longer known.
    pub(super) fn light_edit_ran(&mut self) {
        self.edit_path.free = None;
    }

    /// After a mutating command succeeded in the open document: it is tidy now, and after a bounded edit the index
    /// describes it too, its top-level blocks updated for those the edit added or took away.
    pub(super) fn light_edit_done(&mut self, light: Option<&Light>) {
        let key = (self.document_id, self.rev);
        self.edit_path.tidy = Some(key);
        let Some(l) = light else { return };
        self.edit_path.done += 1;
        // An index dropped while the edit ran is made again by the next one.
        if self.edit_path.key.is_none() {
            return;
        }
        if l.path.0.len() == 1 {
            let now = self.doc.story(l.story).map_or(0, Vec::len);
            let (first, n) = (l.path.last(), l.blocks.len());
            if let Some(reach) = self.edit_path.reach.get_mut(&l.story)
                && let Some(n_now) = (n + now).checked_sub(l.len)
            {
                reach.moved(first, n, n_now);
            }
        }
        self.edit_path.key = Some(key);
    }

    /// A failed or empty command put the revision back to `rev`: what the index or the tidy mark learned at another one
    /// (a command nested in it) may not hold for the revision numbers that follow.
    pub(super) fn edit_path_back_to(&mut self, rev: u64) {
        let e = &mut self.edit_path;
        e.key = e.key.filter(|k| k.1 == rev);
        e.tidy = e.tidy.filter(|k| k.1 == rev);
    }

    /// Puts a failed bounded edit back: the range's blocks, the selection and the undo stacks as they were. The index
    /// still holds for the revision `run` puts back.
    pub(super) fn light_edit_failed(&mut self, light: Option<Light>) {
        let Some(l) = light else { return };
        if let Ok(bl) = self.doc.container_mut(l.story, &l.path) {
            let first = l.path.last();
            let end = (first + l.blocks.len() + bl.len()).saturating_sub(l.len).clamp(first, bl.len());
            bl.splice(first.min(end)..end, l.blocks);
        }
        self.sel = l.sel;
        (self.history, self.redo, self.typing_open, self.undo_evicted) = l.stacks;
    }
}

impl Light {
    /// Whether `doc` holds the range as it was: the container the same length and each block the same.
    pub(super) fn unchanged(&self, doc: &Document) -> bool {
        let first = self.path.last();
        doc.container(self.story, &self.path).is_some_and(|bl| {
            bl.len() == self.len && bl.get(first..).is_some_and(|now| self.blocks.iter().zip(now).all(|(x, y)| Arc::ptr_eq(x, y) || x == y))
        })
    }

    /// The paragraph at `at` in the document as it was before the command, `doc` being the document now: the range's
    /// own blocks from the copy kept, the blocks after it where they have moved to.
    pub(super) fn old_para<'a>(&'a self, doc: &'a Document, at: &Pos) -> Option<&'a Paragraph> {
        let d = self.path.0.len() - 1;
        let p = &at.path.0;
        if at.story != self.story || p.len() <= d || p.get(..d) != self.path.0.get(..d) {
            return doc.para_at(at);
        }
        let (first, i) = (self.path.last(), p[d] as usize);
        if i < first {
            return doc.para_at(at);
        }
        if let Some(b) = self.blocks.get(i - first) {
            return para_in(b, p.get(d + 1..)?);
        }
        let now = doc.container(self.story, &self.path)?.len();
        let mut moved = at.path.clone();
        moved.0[d] = u32::try_from((i + now).checked_sub(self.len)?).ok()?;
        doc.para(self.story, &moved)
    }
}

/// The paragraph at `rest` (row, cell, block, and so on) inside `b`; `b` itself when `rest` is empty.
fn para_in<'a>(b: &'a Block, rest: &[u32]) -> Option<&'a Paragraph> {
    match (b, rest) {
        (Block::Para(p), []) => Some(p),
        (b, [r, c, i, rest @ ..]) => para_in(b.list(*r as usize, *c as usize)?.get(*i as usize)?, rest),
        _ => None,
    }
}

/// Whether `text` holds no object (a picture, a note reference, a field or text box anchor, a bookmark or comment mark).
fn plain(text: &str) -> bool {
    !text.contains(OBJ)
}

/// Whether deleting `a..b` (one container's paragraphs) removes only plain text and paragraph marks: every block between
/// them a paragraph, none of its text an object, and no section break on a mark that goes.
fn plain_between(blocks: &Blocks, a: &Pos, b: &Pos) -> Option<()> {
    let (ia, ib) = (a.path.last(), b.path.last());
    let para = |i: usize| blocks.get(i).and_then(|x| x.as_para());
    if ia == ib {
        return plain(para(ia)?.text.get(a.off..b.off)?).then_some(());
    }
    for i in ia..=ib {
        let p = para(i)?;
        let text = if i == ia { p.text.get(a.off..)? } else if i == ib { p.text.get(..b.off)? } else { &p.text };
        if !plain(text) || (i < ib && p.section.is_some()) || has_markers(p) {
            return None;
        }
    }
    Some(())
}

/// The content controls' reach in one story. A control that holds a position starts and ends in the same block list, so it
/// either has a marker in the position's top-level block or spans that block.
pub(super) struct Reach {
    /// Whether each top-level block holds a control's marker or wrap.
    marked: Vec<bool>,
    /// Each control's first and last top-level block, and whether it takes typing as plain text would.
    spans: Vec<(usize, usize, bool)>,
}

impl Reach {
    /// Whether no control's marker is in top-level blocks `t0..=t1` and every control spanning them takes typing as plain
    /// text would.
    fn free(&self, t0: usize, t1: usize) -> bool {
        self.marked.get(t0..=t1).is_some_and(|m| !m.contains(&true)) && self.spans.iter().all(|&(a, b, plain)| plain || b < t0 || a > t1)
    }

    /// A bounded edit made top-level blocks `first..first + n` (marker-free) into `n_now`: the blocks after them moved.
    fn moved(&mut self, first: usize, n: usize, n_now: usize) {
        if first + n > self.marked.len() {
            return;
        }
        self.marked.splice(first..first + n, std::iter::repeat_n(false, n_now));
        let at = |x: usize| if x >= first + n { x + n_now - n } else { x };
        for s in &mut self.spans {
            (s.0, s.1) = (at(s.0), at(s.1));
        }
    }
}

/// The content controls' reach in `story`.
fn control_reach(doc: &Document, story: StoryRef) -> Reach {
    let Some(blocks) = doc.story(story) else { return Reach { marked: Vec::new(), spans: Vec::new() } };
    let marked = blocks.iter().map(|b| has_controls(b)).collect();
    let spans = doc
        .control_ranges(story)
        .into_iter()
        .filter_map(|r| {
            let (a, b) = (*r.start.path.0.first()? as usize, *r.end.path.0.first()? as usize);
            let c = &r.control;
            // As the typing handlers read it (cmd/controls.rs): no refusal, no placeholder to replace, Enter allowed.
            let plain = c.lock.can_edit() && c.kind.takes_typing() && !c.showing_placeholder && !matches!(c.kind, ControlKind::Text { multi_line: false });
            Some((a.min(b), a.max(b), plain))
        })
        .collect();
    Reach { marked, spans }
}

/// Whether `block` holds a content control's marker or wrap anywhere inside it.
fn has_controls(block: &Block) -> bool {
    match block {
        Block::Para(p) => has_markers(p),
        Block::Table(t) => {
            !t.controls.is_empty()
                || t.rows.iter().any(|r| !r.controls.is_empty() || r.cells.iter().any(|c| !c.controls.is_empty() || any_controls(&c.blocks)))
        }
        Block::Container(c) => c.regions().into_iter().any(|(_, list)| any_controls(list)),
    }
}

fn has_markers(p: &Paragraph) -> bool {
    p.objects.iter().any(|o| matches!(o, InlineObject::ControlStart { .. } | InlineObject::ControlEnd))
}

fn any_controls(blocks: &Blocks) -> bool {
    blocks.iter().any(|b| has_controls(b))
}
