//! Move Page (docs/plans/board/design.md section 6, briefs/bd-pagemove.md): the board reorders a document's pages. The blocks
//! one page holds move to before the blocks another page starts with. A paragraph or table the page edge cuts is split there,
//! and each block that now starts a page gets Page Break Before, so every page keeps its content and breaks where it did.
//! One command, so one undo step. The body story only.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{Value, json};
use ew_doc::para::InlineObject;
use ew_doc::props::LineSpacing;
use ew_doc::{Block, Document, Paragraph, Path, Pos, StoryRef};
use ew_doc_layout::{DocLayout, Page, ParaLayout, Placed};

use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("page.move", "Move Page", "Layout › Page", move_page)
            .params(r#"{"from": page index (0-based), "before": page index it moves in front of; the page count puts it last} → {ok, pages}"#),
    ]
}

/// Where a page starts in the body: block `block`, and `at` inside it. 0 is its start. Otherwise `at` is the byte of a
/// paragraph or the row of a table the page edge cuts before. Cuts order as the document does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Cut {
    block: usize,
    at: usize,
}

fn fail(m: &str) -> CmdError {
    CmdError::Failed(m.to_string())
}

/// The layout, laid out to its end.
fn settled(s: &mut Session) -> Arc<DocLayout> {
    let mut l = s.layout();
    for _ in 0..10_000 {
        if l.settled() {
            break;
        }
        l = s.advance_layout(50.0);
    }
    l
}

/// A page's body text pieces (paragraph, first line), in the order they were placed.
fn body_lines(page: &Page) -> impl Iterator<Item = (&Path, &ParaLayout, usize)> {
    page.items.iter().filter_map(|it| match it {
        Placed::Lines { story: StoryRef::Body, path, para, l0, .. } => Some((path, &**para, *l0)),
        _ => None,
    })
}

/// The page's text pieces that belong to the block named `id`.
fn of_block(page: &Page, id: u32) -> impl Iterator<Item = (&Path, &ParaLayout, usize)> {
    body_lines(page).filter(move |(q, ..)| q.0.first() == Some(&id))
}

/// Where page `k` starts. Page 0 starts the body, and the page past the last ends it. A page that starts inside a table row or
/// a quote, code block or box is refused.
fn cut(s: &Session, l: &DocLayout, k: usize) -> Result<Cut, CmdError> {
    let Some(page) = l.pages.get(k).filter(|_| k > 0) else {
        return Ok(Cut { block: if k == 0 { 0 } else { s.doc.body.len() }, at: 0 });
    };
    let Some((path, para, l0)) = body_lines(page).next() else { return Err(fail("This page has no text to move.")) };
    let id = path.0.first().copied();
    let block = page.ids.doc_path(StoryRef::Body, path).and_then(|d| d.0.first().map(|b| *b as usize));
    let (Some(id), Some(block), Some(before)) = (id, block, l.pages.get(k - 1)) else { return Err(fail("This page cannot be moved.")) };
    match s.doc.body.get(block).map(|b| &**b) {
        Some(Block::Para(_)) => Ok(Cut { block, at: if l0 == 0 { 0 } else { para.lines.get(l0).map_or(0, |line| line.start) } }),
        Some(Block::Table(_)) => {
            // A table row's lines run on from the row above: a row the page starts with has lines on the page before it only
            // if it crosses. Header rows repeated at the top of the page are rows below the page before's last.
            let row = |(q, ..): (&Path, &ParaLayout, usize)| q.0.get(1).map(|r| *r as usize);
            let Some(last) = of_block(before, id).filter_map(row).max() else { return Ok(Cut { block, at: 0 }) };
            match of_block(page, id).filter_map(row).filter(|r| *r >= last).min() {
                Some(r) if r > last => Ok(Cut { block, at: r }),
                _ => Err(fail("A table row crosses this page.")),
            }
        }
        Some(Block::Container(_)) if of_block(before, id).next().is_some() => Err(fail("A quote, code block or box crosses this page.")),
        _ => Ok(Cut { block, at: 0 }),
    }
}

/// The bookmarks, comments, editable ranges, fields and content controls a walk of the body has opened and not yet closed.
#[derive(Clone, Default)]
struct Open {
    /// A bookmark by name, a comment or an editable range by id.
    marks: HashSet<(u8, String)>,
    /// Fields and content controls, which close the innermost open one.
    depth: usize,
}

impl Open {
    fn any(&self) -> bool {
        self.depth > 0 || !self.marks.is_empty()
    }

    fn take(&mut self, o: &InlineObject) {
        use InlineObject::*;
        match o {
            BookmarkStart { name } => drop(self.marks.insert((0, name.clone()))),
            BookmarkEnd { name } => drop(self.marks.remove(&(0, name.clone()))),
            CommentStart { id } => drop(self.marks.insert((1, id.to_string()))),
            CommentEnd { id } => drop(self.marks.remove(&(1, id.to_string()))),
            PermStart { id, .. } => drop(self.marks.insert((2, id.to_string()))),
            PermEnd { id } => drop(self.marks.remove(&(2, id.to_string()))),
            FieldStart { .. } | ControlStart { .. } => self.depth += 1,
            FieldEnd | ControlEnd => self.depth = self.depth.saturating_sub(1),
            _ => {}
        }
    }

    /// The first `upto` bytes of a paragraph.
    fn para(&mut self, q: &Paragraph, upto: usize) {
        for (_, o) in q.objects_with_offsets().take_while(|(off, _)| *off < upto) {
            self.take(o);
        }
    }

    /// Whole blocks, and what is inside them: a table's rows and the controls round them, a container's regions.
    fn blocks<'a>(&mut self, blocks: impl IntoIterator<Item = &'a Arc<Block>>) {
        for b in blocks {
            self.block(b, usize::MAX);
        }
    }

    /// Block `b`: all of it, or up to `upto` (a paragraph's byte, a table's row).
    fn block(&mut self, b: &Block, upto: usize) {
        match b {
            Block::Para(q) => self.para(q, upto),
            Block::Table(t) => {
                self.depth += t.controls.open.len();
                for row in t.rows.iter().take(upto) {
                    self.depth = (self.depth + row.controls.open.len()).saturating_sub(row.controls.close as usize);
                    self.blocks(row.cells.iter().flat_map(|c| &c.blocks));
                }
                if upto >= t.rows.len() {
                    self.depth = self.depth.saturating_sub(t.controls.close as usize);
                }
            }
            Block::Container(_) => self.blocks(b.lists().into_iter().flat_map(|(_, _, l)| l)),
        }
    }
}

/// Whether a bookmark, comment, field or content control is open at any of `cuts` (in document order): moving the blocks round
/// the cut would part its start from its end.
fn pair_open(doc: &Document, cuts: &[Cut]) -> bool {
    let mut st = Open::default();
    for (i, b) in doc.body.iter().enumerate() {
        for c in cuts.iter().filter(|c| c.block == i) {
            let mut here = st.clone();
            if c.at > 0 {
                here.block(b, c.at);
            }
            if here.any() {
                return true;
            }
        }
        st.block(b, usize::MAX);
    }
    cuts.iter().any(|c| c.block >= doc.body.len()) && st.any()
}

/// The paragraph between two tables a move would join, which takes no room: its mark is hidden, so the layout leaves its line
/// out while hidden text does not show, and where it does the line is 1 pt with no space round it.
fn separator() -> Arc<Block> {
    let mut q = Paragraph::new();
    q.mark.hidden = Some(true);
    q.mark.size = Some(1.0);
    q.props.space_before = Some(0.0);
    q.props.space_after = Some(0.0);
    q.props.line_spacing = Some(LineSpacing::Exactly(1.0));
    ew_doc::para_block(q)
}

/// The first paragraph of a block: itself, or the first of a table's first cell or a container's first region.
fn first_para(b: &mut Block) -> Option<&mut Paragraph> {
    match b {
        Block::Para(p) => Some(p),
        _ => first_para(Arc::make_mut(b.list_mut(0, 0)?.first_mut()?)),
    }
}

/// Page Break Before on the block at `i` (on a table, on its first cell's first paragraph, as Word keeps it).
fn break_before(s: &mut Session, i: usize) {
    if let Some(b) = s.doc.body.get_mut(i)
        && let Some(para) = first_para(Arc::make_mut(b))
    {
        para.props.page_break_before = Some(true);
        para.touch();
    }
}

fn move_page(s: &mut Session, v: &Value) -> CmdResult {
    let index = |k: &str| p::u64(v, k).map(|n| n as usize).ok_or_else(|| CmdError::Params(format!("`{k}` (page index) is required")));
    let (from, before) = (index("from")?, index("before")?);
    if s.doc.settings.track_changes {
        return Err(fail("Turn off Track Changes to move a page."));
    }
    let l = settled(s);
    let n = l.pages.len();
    if from >= n || before > n {
        return Err(fail("There is no such page."));
    }
    if before == from || before == from + 1 {
        return Ok(json!({"ok": true, "pages": n}));
    }
    let (cf, ce, cb) = (cut(s, &l, from)?, cut(s, &l, from + 1)?, cut(s, &l, before)?);
    // The layout's names for the blocks go with it: it is not read after the document changes.
    drop(l);
    if cf >= ce || !(cb <= cf || cb >= ce) {
        return Err(fail("This page cannot be moved."));
    }
    // A section break ends a paragraph the move crosses: one in the range (when the range starts inside the paragraph, the half
    // with the break is in it; when the range ends inside, it is not), or one in the pages the range passes.
    let ends = |a: usize, b: usize| {
        s.doc.body.get(a..b).is_some_and(|r| r.iter().any(|x| x.as_para().is_some_and(|q| q.section.is_some())))
    };
    if ends(cf.block, ce.block) {
        return Err(fail("A section ends on this page."));
    }
    let (lo, hi) = if before < from { (cb, cf) } else { (ce, cb) };
    if ends(lo.block, hi.block) {
        return Err(fail("A section ends between these pages."));
    }
    let mut cuts = [cf, ce, cb];
    cuts.sort();
    if pair_open(&s.doc, &cuts) {
        return Err(fail("A bookmark, comment, field or content control crosses this page."));
    }
    // Split from the bottom up, so the cuts above keep their block numbers.
    let mut splits: Vec<Cut> = [cf, ce, cb].into_iter().filter(|c| c.at > 0).collect();
    splits.sort();
    splits.dedup();
    for c in splits.iter().rev() {
        if s.doc.body.get(c.block).is_some_and(|b| b.as_table().is_some()) {
            let tail = s.doc.table_mut(StoryRef::Body, &Path::top(c.block))?.split_off(c.at);
            s.doc.insert_block(StoryRef::Body, &Path::top(c.block + 1), Block::Table(tail))?;
        } else {
            s.doc.split_paragraph(&Pos::body(c.block, c.at))?;
        }
    }
    // Where each cut is now: the splits above it add a block each, and a cut that split starts the second half.
    let now = |c: Cut| c.block + splits.iter().filter(|x| **x < c).count() + usize::from(c.at > 0);
    let (i_f, i_e, i_b) = (now(cf), now(ce), now(cb));
    let len = i_e - i_f;
    // The range, the blocks it moved past and the blocks after it, as they stand now: the first block of each starts a page.
    // The last mark is the range's first block, where the caret goes.
    let mut marks = if before < from {
        s.doc.body[i_b..i_e].rotate_right(len);
        [i_b, i_b + len, i_e, i_b]
    } else {
        s.doc.body[i_f..i_b].rotate_left(len);
        [i_f, i_f + (i_b - i_e), i_b, i_f + (i_b - i_e)]
    };
    // Two tables never touch: Word reads them as one table. A paragraph that takes no room goes between them (the marks move
    // down with it), so no page is left holding only that.
    for i in (1..s.doc.body.len()).rev() {
        if s.doc.body[i - 1].as_table().is_some() && s.doc.body[i].as_table().is_some() {
            s.doc.body.insert(i, separator());
            marks.iter_mut().filter(|m| **m >= i).for_each(|m| *m += 1);
        }
    }
    let first = marks[3];
    for i in marks[..3].iter().copied().filter(|i| *i > 0) {
        break_before(s, i);
    }
    // A body ends in a paragraph.
    if s.doc.body.last().is_none_or(|b| b.as_para().is_none()) {
        s.doc.body.push(ew_doc::para_block(Paragraph::new()));
    }
    // A page that was last now ends with the break that ended its page before, and a page moved to the end keeps its own: at
    // the end of the body either would add an empty page, and Page Break Before starts every page now.
    if before == n || from + 1 == n {
        let path = Path::top(s.doc.body.len() - 1);
        while let Some(end) = s.doc.para(StoryRef::Body, &path).filter(|q| q.text.ends_with('\u{c}')).map(|q| q.len()) {
            let at = |off| Pos { story: StoryRef::Body, path: path.clone(), off };
            s.doc.delete_range(&at(end - 1), &at(end))?;
        }
    }
    let at = Pos { path: Path(vec![first as u32, 0, 0, 0]), ..Pos::body(first, 0) };
    let at = if s.doc.body.get(first).is_some_and(|b| b.as_para().is_some()) { Pos::body(first, 0) } else { at };
    s.sel = Selection::caret(s.doc.clamp(&at));
    // The layout is read below, and the revision it is keyed on moves with the command's end.
    s.touch();
    Ok(json!({"ok": true, "pages": settled(s).pages.len()}))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use ew_doc::para::InlineObject;
use ew_doc::props::LineSpacing;
    use ew_doc::{Block, Document, Paragraph, Path, Pos, StoryRef, Table, para_block};
    use serde_json::json;

    use super::body_lines;
    use crate::{Selection, Session};

    /// A document of one page a word: a paragraph each, every one after the first with Page Break Before.
    fn paged(words: &[&str]) -> Session {
        let mut d = Document::new();
        d.body = words
            .iter()
            .enumerate()
            .map(|(i, w)| {
                let mut q = Paragraph::with_text(w, Default::default());
                q.props.page_break_before = (i > 0).then_some(true);
                para_block(q)
            })
            .collect();
        Session::new(d)
    }

    fn paras(s: &Session) -> Vec<String> {
        s.doc.body.iter().filter_map(|b| b.as_para().map(|q| q.text.clone())).collect()
    }

    /// The first twelve characters of the paragraph each page starts with.
    fn firsts(s: &mut Session) -> Vec<String> {
        let l = s.layout();
        l.pages
            .iter()
            .map(|pg| {
                let path = body_lines(pg).next().and_then(|(q, ..)| pg.ids.doc_path(StoryRef::Body, q));
                path.and_then(|d| s.doc.para(StoryRef::Body, &d)).map_or(String::new(), |q| q.text.chars().take(12).collect())
            })
            .collect()
    }

    fn words(s: &Session) -> Vec<String> {
        let mut w: Vec<String> = s.doc.plain_text(StoryRef::Body).split_whitespace().map(str::to_string).collect();
        w.sort();
        w
    }

    /// `n` numbered words.
    fn long(n: usize) -> String {
        (0..n).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn page_move_puts_the_third_page_first_and_one_undo_restores_the_body() {
        let mut s = paged(&["one", "two", "three"]);
        assert_eq!(s.layout().pages.len(), 3);
        let before = s.doc.clone();
        let r = s.run("page.move", &json!({"from": 2, "before": 0})).unwrap();
        assert_eq!(r, json!({"ok": true, "pages": 3}));
        assert_eq!(paras(&s), ["three", "one", "two"]);
        assert_eq!(firsts(&mut s), ["three", "one", "two"], "each page keeps its own paragraph");
        // A document laid out afresh from the moved body paginates the same: the incremental layout is the true one.
        let mut fresh = Session::new(s.doc.clone());
        assert_eq!(firsts(&mut fresh), ["three", "one", "two"]);
        assert!(s.run("edit.undo", &json!({})).is_ok());
        assert!(s.doc.same_content(&before), "one undo restores the body exactly");
        assert_eq!(firsts(&mut s), ["one", "two", "three"]);
    }

    #[test]
    fn page_move_to_the_end_and_to_the_middle_keep_each_page_whole() {
        let mut s = paged(&["one", "two", "three"]);
        s.run("page.move", &json!({"from": 0, "before": 3})).unwrap();
        assert_eq!(firsts(&mut s), ["two", "three", "one"]);
        let mut s = paged(&["one", "two", "three", "four"]);
        s.run("page.move", &json!({"from": 0, "before": 3})).unwrap();
        assert_eq!(firsts(&mut s), ["two", "three", "one", "four"]);
        assert_eq!(s.layout().pages.len(), 4, "the page after the range still starts its own page");
    }

    #[test]
    fn page_move_next_to_itself_is_no_change_and_no_undo_step() {
        let mut s = paged(&["one", "two", "three"]);
        let (doc, mark) = (s.doc.clone(), s.undo_mark());
        for (from, before) in [(1, 1), (1, 2)] {
            let r = s.run("page.move", &json!({"from": from, "before": before})).unwrap();
            assert_eq!(r, json!({"ok": true, "pages": 3}));
        }
        assert!(s.doc.same_content(&doc));
        assert_eq!(s.undo_mark(), mark, "no undo step");
    }

    #[test]
    fn page_move_refuses_what_it_cannot_move_and_changes_nothing() {
        let mut s = paged(&["one", "two", "three"]);
        let mark = s.undo_mark();
        for (from, before) in [(3, 0), (0, 4)] {
            assert!(s.run("page.move", &json!({"from": from, "before": before})).is_err(), "{from} {before}");
        }
        // A section ends on the second page.
        if let Some(Block::Para(q)) = s.doc.body.get_mut(1).map(Arc::make_mut) {
            q.section = Some(Default::default());
        }
        let doc = s.doc.clone();
        let e = s.run("page.move", &json!({"from": 1, "before": 0})).unwrap_err();
        assert_eq!(e.to_string(), "A section ends on this page.");
        assert!(s.doc.same_content(&doc));
        assert_eq!(s.undo_mark(), mark, "a refusal takes no undo step");
    }

    #[test]
    fn page_move_splits_the_paragraph_the_page_edge_cuts() {
        // One paragraph over two pages, then a short page.
        let mut tail = Paragraph::with_text("tail", Default::default());
        tail.props.page_break_before = Some(true);
        let mut d = Document::new();
        d.body = vec![para_block(Paragraph::with_text(&long(900), Default::default())), para_block(tail)];
        let mut s = Session::new(d);
        let n = s.layout().pages.len();
        assert_eq!(n, 3, "the long paragraph fills two pages");
        let (whole, before) = (s.doc.plain_text(StoryRef::Body), words(&s));
        s.run("page.move", &json!({"from": 1, "before": 0})).unwrap();
        let p = paras(&s);
        assert_eq!(p.len(), 3, "the paragraph is two now: {p:?}");
        assert_eq!(format!("{}{}\ntail", p[1], p[0]), whole, "the halves are the paragraph's text in order, cut at the page edge");
        assert_eq!(words(&s), before, "no word is lost or added");
        assert_eq!(s.layout().pages.len(), 3);
        assert!(s.run("edit.undo", &json!({})).is_ok());
        assert_eq!(s.doc.plain_text(StoryRef::Body), whole);
    }

    #[test]
    fn page_move_keeps_three_pages_when_hard_breaks_are_in_one_paragraph() {
        // What Insert > Page Break makes: the break is a character of the paragraph, so each page edge is inside it.
        let cases: [(usize, usize, &[&str]); 3] =
            [(2, 0, &["three", "one\u{c}two"]), (0, 3, &["two\u{c}three", "one"]), (1, 0, &["two\u{c}", "one\u{c}", "three"])];
        for (from, before, want) in cases {
            let mut s = Session::new(Document::from_text("one\u{c}two\u{c}three"));
            assert_eq!(s.layout().pages.len(), 3);
            s.run("page.move", &json!({"from": from, "before": before})).unwrap();
            assert_eq!(paras(&s), want, "{from} {before}");
            assert_eq!(s.layout().pages.len(), 3, "no empty page at the end: {from} {before}");
        }
    }

    /// A table of `rows` single-line rows, "<label> <n>" each.
    fn table_of(label: &str, rows: usize) -> Block {
        let mut t = Table::new(rows, 1, 400.0);
        for (r, row) in t.rows.iter_mut().enumerate() {
            row.cells[0].blocks = vec![para_block(Paragraph::with_text(&format!("{label} {r}"), Default::default()))];
        }
        Block::Table(t)
    }

    /// A table of single-line rows, then a paragraph.
    fn tabled(rows: usize) -> Session {
        let mut d = Document::new();
        d.body = vec![Arc::new(table_of("row", rows)), para_block(Paragraph::with_text("after", Default::default()))];
        Session::new(d)
    }

    #[test]
    fn page_move_splits_a_table_between_rows() {
        let mut s = tabled(120);
        let n = s.layout().pages.len();
        assert!(n >= 3, "the table runs over pages: {n}");
        let before = words(&s);
        s.run("page.move", &json!({"from": 1, "before": 0})).unwrap();
        let tables: Vec<usize> = s.doc.body.iter().filter_map(|b| b.as_table().map(|t| t.rows.len())).collect();
        assert!(tables.len() >= 2 && tables.iter().sum::<usize>() == 120, "the rows are the same rows: {tables:?}");
        assert_eq!(words(&s), before);
        let first = s.doc.body[0].as_table().unwrap().rows[0].cells[0].blocks[0].as_para().unwrap().text.clone();
        assert_ne!(first, "row 0", "the second page's rows come first");
        assert!(s.run("edit.undo", &json!({})).is_ok());
        assert_eq!(s.doc.body.iter().filter(|b| b.as_table().is_some()).count(), 1);
    }

    #[test]
    fn page_move_refuses_a_page_that_starts_inside_a_table_row() {
        // One row holds more than two pages of text, so the second page starts inside it.
        let mut t = Table::new(1, 1, 400.0);
        t.rows[0].cells[0].blocks = vec![para_block(Paragraph::with_text(&long(2500), Default::default()))];
        let mut d = Document::new();
        d.body = vec![Arc::new(Block::Table(t)), para_block(Paragraph::with_text("after", Default::default()))];
        let mut s = Session::new(d);
        assert!(s.layout().pages.len() >= 3);
        let (doc, mark) = (s.doc.clone(), s.undo_mark());
        let e = s.run("page.move", &json!({"from": 1, "before": 0})).unwrap_err();
        assert_eq!(e.to_string(), "A table row crosses this page.");
        assert!(s.doc.same_content(&doc));
        assert_eq!(s.undo_mark(), mark);
    }

    /// One paragraph "alpha\fbravo\fcharlie" (the page edges are at bytes 6 and 12) with `start` before byte `a` and `end` before
    /// byte `b` of its text.
    fn paired(start: InlineObject, end: InlineObject, a: usize, b: usize) -> Session {
        let mut s = Session::new(Document::from_text("alpha\u{c}bravo\u{c}charlie"));
        let q = s.doc.para_mut(StoryRef::Body, &Path::top(0)).unwrap();
        q.insert_object(b, end, &Default::default()).unwrap();
        q.insert_object(a, start, &Default::default()).unwrap();
        s
    }

    fn pairs() -> Vec<(&'static str, InlineObject, InlineObject)> {
        vec![
            ("bookmark", InlineObject::BookmarkStart { name: "B".into() }, InlineObject::BookmarkEnd { name: "B".into() }),
            ("comment", InlineObject::CommentStart { id: 3 }, InlineObject::CommentEnd { id: 3 }),
            ("field", InlineObject::FieldStart { instr: "TC".into(), locked: false, dirty: false }, InlineObject::FieldEnd),
            ("control", InlineObject::ControlStart { control: Default::default() }, InlineObject::ControlEnd),
        ]
    }

    #[test]
    fn page_move_refuses_to_part_a_bookmark_comment_field_or_control_from_its_end() {
        for (what, start, end) in pairs() {
            // From the first page into the second: the second page's edge is between them.
            let mut s = paired(start.clone(), end.clone(), 0, 8);
            let (doc, mark) = (s.doc.clone(), s.undo_mark());
            let e = s.run("page.move", &json!({"from": 1, "before": 0})).unwrap_err();
            assert_eq!(e.to_string(), "A bookmark, comment, field or content control crosses this page.", "{what}");
            assert!(s.doc.same_content(&doc) && s.undo_mark() == mark, "{what}: nothing changed");
            // Both on the first page: the pair moves with its text, start still before end.
            let mut s = paired(start, end, 0, 3);
            s.run("page.move", &json!({"from": 1, "before": 0})).unwrap();
            let kinds: Vec<&InlineObject> = s.doc.body.iter().filter_map(|b| b.as_para()).flat_map(|q| q.objects.iter()).collect();
            assert!(matches!(kinds.as_slice(), [a, b] if std::mem::discriminant(*a) != std::mem::discriminant(*b)), "{what}");
            assert!(matches!(kinds[0], InlineObject::BookmarkStart { .. } | InlineObject::CommentStart { .. } | InlineObject::FieldStart { .. } | InlineObject::ControlStart { .. }), "{what}: start first");
        }
    }

    #[test]
    fn page_move_refuses_a_bookmark_made_with_the_command_across_a_cut() {
        let mut s = Session::new(Document::from_text("alpha\u{c}bravo\u{c}charlie"));
        s.sel = Selection { anchor: Pos::body(0, 0), focus: Pos::body(0, 8) };
        s.run("insert.bookmark", &json!({"name": "Span"})).unwrap();
        let e = s.run("page.move", &json!({"from": 1, "before": 0})).unwrap_err();
        assert_eq!(e.to_string(), "A bookmark, comment, field or content control crosses this page.");
    }

    /// "x" and a break, a table of two rows, a break and "third": three pages.
    fn table_between_breaks() -> Session {
        let mut t = Table::new(2, 1, 400.0);
        for (r, row) in t.rows.iter_mut().enumerate() {
            row.cells[0].blocks = vec![para_block(Paragraph::with_text(&format!("row {r}"), Default::default()))];
        }
        let mut d = Document::new();
        d.body = vec![
            para_block(Paragraph::with_text("x\u{c}", Default::default())),
            Arc::new(Block::Table(t)),
            para_block(Paragraph::with_text("\u{c}third", Default::default())),
        ];
        Session::new(d)
    }

    #[test]
    fn page_move_keeps_a_moved_table_on_a_page_of_its_own() {
        let mut s = table_between_breaks();
        assert_eq!(s.layout().pages.len(), 3);
        // "third" moves in front of the table: the table must start its own page after it.
        let r = s.run("page.move", &json!({"from": 2, "before": 1})).unwrap();
        assert_eq!(r["pages"], 3);
        assert_eq!(s.layout().pages.len(), 3);
    }

    #[test]
    fn page_move_never_leaves_two_tables_touching() {
        let touching = |s: &Session| s.doc.body.windows(2).any(|w| w[0].as_table().is_some() && w[1].as_table().is_some());
        let mut s = tabled(120);
        s.run("page.move", &json!({"from": 1, "before": 0})).unwrap();
        assert!(s.doc.body.iter().filter(|b| b.as_table().is_some()).count() >= 2);
        assert!(!touching(&s), "an empty paragraph is between the parts");
        // A paragraph that kept two tables apart moves away: they are not left touching.
        let table = |label: &str| {
            let mut t = Table::new(2, 1, 400.0);
            for (r, row) in t.rows.iter_mut().enumerate() {
                row.cells[0].blocks = vec![para_block(Paragraph::with_text(&format!("{label} {r}"), Default::default()))];
            }
            Arc::new(Block::Table(t))
        };
        let mut mid = Paragraph::with_text("mid", Default::default());
        mid.props.page_break_before = Some(true);
        let mut d = Document::new();
        d.body = vec![table("a"), para_block(mid), table("b")];
        if let Some(Block::Table(t)) = d.body.get_mut(2).map(Arc::make_mut) {
            if let Some(Block::Para(q)) = t.rows[0].cells[0].blocks.get_mut(0).map(Arc::make_mut) {
                q.props.page_break_before = Some(true);
            }
        }
        let mut s = Session::new(d);
        assert_eq!(s.layout().pages.len(), 3);
        s.run("page.move", &json!({"from": 1, "before": 3})).unwrap();
        assert!(!touching(&s), "{:?}", s.doc.body.iter().map(|b| b.as_table().is_some()).collect::<Vec<_>>());
        assert_eq!(s.layout().pages.len(), 3);
    }

    #[test]
    fn page_move_refuses_to_pass_a_section_break() {
        // Four pages: "alpha" ends a section, then an empty page, "bravo" and "charlie".
        let mut s = paged(&["alpha", "", "bravo", "charlie"]);
        if let Some(Block::Para(q)) = s.doc.body.get_mut(0).map(Arc::make_mut) {
            q.section = Some(Default::default());
        }
        assert_eq!(s.layout().pages.len(), 4);
        let (doc, mark) = (s.doc.clone(), s.undo_mark());
        let e = s.run("page.move", &json!({"from": 3, "before": 0})).unwrap_err();
        assert_eq!(e.to_string(), "A section ends between these pages.");
        let e = s.run("page.move", &json!({"from": 0, "before": 2})).unwrap_err();
        assert_eq!(e.to_string(), "A section ends on this page.");
        assert!(s.doc.same_content(&doc) && s.undo_mark() == mark);
        // Pages that pass no section break move as before.
        s.run("page.move", &json!({"from": 3, "before": 1})).unwrap();
        assert_eq!(paras(&s), ["alpha", "charlie", "", "bravo"]);
    }

    #[test]
    fn page_move_in_a_split_table_leaves_no_page_holding_only_the_gap_between_tables() {
        let mut s = tabled(120);
        let n = s.layout().pages.len();
        assert!(n >= 3);
        s.run("page.move", &json!({"from": 1, "before": 0})).unwrap();
        assert_eq!(s.layout().pages.len(), n, "the pages are the same pages");
        s.run("page.move", &json!({"from": 0, "before": n})).unwrap();
        assert_eq!(s.layout().pages.len(), n);
    }

    /// The most single-line rows a page holds.
    fn page_rows() -> usize {
        let fits = |rows: usize| {
            let mut s = tabled(rows);
            let l = s.layout();
            l.pages.first().is_some_and(|pg| body_lines(pg).any(|(q, ..)| q.0.get(1) == Some(&(rows as u32 - 1))))
        };
        let mut rows = 1;
        while fits(rows + 1) {
            rows += 1;
        }
        rows
    }

    #[test]
    fn page_move_joining_two_full_page_tables_adds_no_page() {
        // A table that fills its page, a page of its own, and a second table that starts a page: the paragraph that moves away
        // leaves the tables touching, and what goes between them must take no room.
        let mut d = Document::new();
        let mut mid = Paragraph::with_text("mid", Default::default());
        mid.props.page_break_before = Some(true);
        let mut second = table_of("b", 2);
        if let Block::Table(t) = &mut second
            && let Some(Block::Para(q)) = t.rows[0].cells[0].blocks.get_mut(0).map(Arc::make_mut)
        {
            q.props.page_break_before = Some(true);
        }
        d.body = vec![Arc::new(table_of("a", page_rows())), para_block(mid), Arc::new(second)];
        let mut s = Session::new(d);
        assert_eq!(s.layout().pages.len(), 3);
        s.run("page.move", &json!({"from": 1, "before": 3})).unwrap();
        assert_eq!(s.doc.body.len(), 4, "tables, a paragraph between them, and the moved page");
        assert_eq!(s.layout().pages.len(), 3, "the paragraph between the tables holds no page");
        let blank = firsts(&mut s).iter().filter(|f| f.is_empty()).count();
        assert_eq!(blank, 0);
    }
}
