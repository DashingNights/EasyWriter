//! EasyWriter: stable ids (docs/plans/engine/viewport-design.md section 10, schema version 2). Every block (paragraphs and
//! tables, in cells and in every part too) and every drawing in a paragraph has an id that stays while the document changes
//! around it, so the main thread can key React components, accessibility blocks and object frames by it, and a change can be
//! reported by the blocks it touched. A position (story, path, offset) is no such key: it moves when text before it changes.
//!
//! Ids are given after the fact rather than by every command: [`Ids::fill`] when a document opens, and [`Ids::update`] after
//! each change, which compares the blocks before and after by address (the document is copy-on-write, so a block that changed
//! was copied) and looks only at the blocks that differ. A changed block keeps its id unless an earlier block already holds it,
//! so a split gives the second half a new id, a join keeps the first block's, and a pasted copy of a block gets its own.
use std::collections::{BTreeMap, HashSet};

use super::{Arc, Block, Blocks, Deserialize, Document, Serialize};

/// A stable id; 0 until the session gives one. Equality ignores it: ids name blocks, they are not their content, so two
/// documents with the same content compare equal whatever ids they hold (as [`crate::Paragraph`]'s `rev` does).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Id(pub u32);

impl PartialEq for Id {
    fn eq(&self, _: &Id) -> bool {
        true
    }
}

impl Id {
    /// Not given yet (and not written, so a model the session never held keeps WordCraft's form).
    pub fn is_unset(&self) -> bool {
        self.0 == 0
    }
}

/// How a change touched one block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    Inserted,
    Removed,
    Replaced,
}

/// The blocks a change touched, by stable id (the layout event's `changes`). Changes in a row merge: a block inserted and
/// then edited is inserted, one inserted and then removed is not there at all.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Changes(pub BTreeMap<u32, Change>);

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Adds what `later` did after these.
    pub fn then(&mut self, later: Changes) {
        for (id, c) in later.0 {
            let was = self.0.get(&id).copied();
            let now = match (was, c) {
                (Some(Change::Inserted), Change::Removed) => None,
                (Some(Change::Inserted), _) => Some(Change::Inserted),
                (Some(Change::Removed), Change::Inserted) => Some(Change::Replaced),
                (_, c) => Some(c),
            };
            match now {
                Some(c) => self.0.insert(id, c),
                None => self.0.remove(&id),
            };
        }
    }

    /// The ids of one kind of change, in id order.
    pub fn of(&self, kind: Change) -> Vec<u32> {
        self.0.iter().filter(|(_, c)| **c == kind).map(|(id, _)| *id).collect()
    }
}

/// The ids a document holds and the next one to give, and its blocks as they were when they were last brought up to date:
/// what keeps the ids unique while it changes. The blocks are shared, not copied (a list of `Arc`s per story).
#[derive(Clone, Debug, Default)]
pub struct Ids {
    taken: HashSet<u32>,
    next: u32,
    body: Blocks,
    parts: BTreeMap<u32, Blocks>,
}

/// The id slots of some blocks in document order: each block's (with its address, to tell one the change left alone) followed
/// by those inside it (a paragraph's drawings, a table's cell blocks).
#[derive(Default)]
struct Slots {
    id: Vec<u32>,
    /// The block's address, or 0 for a drawing.
    at: Vec<usize>,
    /// The slots in this one's subtree, itself included.
    span: Vec<usize>,
    /// The id to write over this slot's.
    fix: Vec<Option<u32>>,
}

impl Slots {
    fn of(blocks: &[Arc<Block>]) -> Slots {
        let mut s = Slots::default();
        s.blocks(blocks);
        s.fix = vec![None; s.id.len()];
        s
    }

    fn push(&mut self, id: u32, at: usize) -> usize {
        self.id.push(id);
        self.at.push(at);
        self.span.push(1);
        self.id.len() - 1
    }

    fn blocks(&mut self, blocks: &[Arc<Block>]) {
        for b in blocks {
            match &**b {
                Block::Para(p) => {
                    let i = self.push(p.id.0, Arc::as_ptr(b) as usize);
                    for o in &p.objects {
                        if let Some((_, _, f)) = o.frame() {
                            self.push(f.id.0, 0);
                        }
                    }
                    self.span[i] = self.id.len() - i;
                }
                Block::Table(t) => {
                    let i = self.push(t.id.0, Arc::as_ptr(b) as usize);
                    for c in t.rows.iter().flat_map(|r| &r.cells) {
                        self.blocks(&c.blocks);
                    }
                    self.span[i] = self.id.len() - i;
                }
                Block::Container(c) => {
                    let i = self.push(c.id.0, Arc::as_ptr(b) as usize);
                    for (_, list) in c.regions() {
                        self.blocks(list);
                    }
                    self.span[i] = self.id.len() - i;
                }
            }
        }
    }

    /// Writes the fixes into `blocks` (the blocks these slots were read from), copying only the blocks that hold one.
    fn write(&self, blocks: &mut [Arc<Block>], at: &mut usize) {
        for b in blocks {
            let span = self.span.get(*at).copied().unwrap_or(0);
            if !self.fix.get(*at..*at + span).is_some_and(|f| f.iter().any(Option::is_some)) {
                *at += span;
                continue;
            }
            let i = *at;
            *at += 1;
            match Arc::make_mut(b) {
                Block::Para(p) => {
                    if let Some(id) = self.fix[i] {
                        p.id = Id(id);
                    }
                    for o in &mut p.objects {
                        if let Some(f) = o.float_mut() {
                            if let Some(Some(id)) = self.fix.get(*at) {
                                f.id = Id(*id);
                            }
                            *at += 1;
                        }
                    }
                }
                Block::Table(t) => {
                    if let Some(id) = self.fix[i] {
                        t.id = Id(id);
                    }
                    for c in t.rows.iter_mut().flat_map(|r| &mut r.cells) {
                        self.write(&mut c.blocks, at);
                    }
                }
                Block::Container(c) => {
                    if let Some(id) = self.fix[i] {
                        c.id = Id(id);
                    }
                    if !c.title.is_empty() && let Some(list) = c.region_mut(0) {
                        self.write(list, at);
                    }
                    if let Some(list) = c.region_mut(usize::from(!c.title.is_empty())) {
                        self.write(list, at);
                    }
                }
            }
        }
    }
}

/// The part of two block lists between the blocks they share at the start and at the end (by address) → (start, end in `a`,
/// end in `b`).
fn window(a: &[Arc<Block>], b: &[Arc<Block>]) -> (usize, usize, usize) {
    let p = a.iter().zip(b).take_while(|(x, y)| Arc::ptr_eq(x, y)).count();
    let s = a[p..].iter().rev().zip(b[p..].iter().rev()).take_while(|(x, y)| Arc::ptr_eq(x, y)).count();
    (p, a.len() - s, b.len() - s)
}

impl Ids {
    /// Gives every block and drawing of `doc` that has none, or one an earlier one holds, a new id (a document just opened:
    /// version 1 models and Word files have none) → the ids it holds.
    pub fn fill(doc: &mut Document) -> Ids {
        let mut ids = Ids { next: 1, ..Ids::default() };
        for blocks in stories(doc) {
            let mut s = Slots::of(blocks);
            ids.claim(&mut s);
            s.write(blocks, &mut 0);
        }
        ids.keep(doc);
        ids
    }

    #[inline(never)]
    fn keep(&mut self, doc: &Document) {
        self.body = doc.body.clone();
        self.parts = doc.parts.iter().map(|(k, p)| (*k, p.blocks.clone())).collect();
    }

    /// Brings the ids of `after`, which changes made from the document these ids were last brought up to date with, up to
    /// date → the blocks the changes touched.
    pub fn update(&mut self, after: &mut Document) -> Changes {
        let mut changes = Changes::default();
        let keys: std::collections::BTreeSet<u32> = self.parts.keys().chain(after.parts.keys()).copied().collect();
        for key in std::iter::once(None).chain(keys.into_iter().map(Some)) {
            let mut kept = match key {
                None => std::mem::take(&mut self.body),
                // None: a part the change added
                Some(k) => self.parts.get_mut(&k).map(std::mem::take).unwrap_or_default(),
            };
            let mut gone = Blocks::new(); // a part the change removed: its blocks give way to none
            let now = match key {
                None => &mut after.body,
                Some(k) => after.parts.get_mut(&k).map_or(&mut gone, |p| &mut p.blocks),
            };
            let (start, end_was, end_now) = window(&kept, now);
            if start != end_was || start != end_now {
                self.renew(&kept[start..end_was], &mut now[start..end_now], &mut changes);
                // engine-layout-key: only the blocks the change touched are taken in. Keeping the whole list again (an `Arc`
                // count up and down for each of the Word fixture's blocks) cost about 0.2 ms a key natively.
                kept.splice(start..end_was, now[start..end_now].iter().cloned());
            }
            match key {
                None => self.body = kept,
                Some(k) => {
                    if let Some(v) = self.parts.get_mut(&k) {
                        *v = kept;
                    }
                }
            }
        }
        // A part the change added or removed: the parts are kept again from `after`.
        if self.parts.len() != after.parts.len() || after.parts.keys().any(|k| !self.parts.contains_key(k)) {
            self.keep(after);
        }
        changes
    }

    /// Gives the blocks `now` that replaced `was` their ids and records how the change touched them.
    fn renew(&mut self, was: &[Arc<Block>], now: &mut [Arc<Block>], changes: &mut Changes) {
        let old = Slots::of(was);
        let mut new = Slots::of(now);
        for id in &old.id {
            self.taken.remove(id);
        }
        self.claim(&mut new);
        new.write(now, &mut 0);
        // The blocks by id, before (with their addresses) and after.
        let olds: BTreeMap<u32, usize> = old.id.iter().zip(&old.at).filter(|(_, a)| **a != 0).map(|(id, a)| (*id, *a)).collect();
        let mut news = HashSet::new();
        for (i, &a) in new.at.iter().enumerate().filter(|(_, a)| **a != 0) {
            let id = new.fix[i].unwrap_or(new.id[i]);
            news.insert(id);
            match olds.get(&id) {
                Some(was_at) if *was_at == a => {} // inside a changed table, left alone by the change
                Some(_) => {
                    changes.0.insert(id, Change::Replaced);
                }
                None => {
                    changes.0.insert(id, Change::Inserted);
                }
            }
        }
        for id in olds.keys().filter(|id| !news.contains(*id)) {
            changes.0.insert(*id, Change::Removed);
        }
    }

    /// Gives no id up to `id` from now on: one a block of an undo history read back from a file holds (engine-edit-cost). Those
    /// blocks are not in the document [`Ids::fill`] saw, so a block added later could otherwise take an id a step brings back.
    pub fn reserve(&mut self, id: u32) {
        self.next = self.next.max(id.saturating_add(1));
    }

    /// Takes the ids of slots `s` in order, deciding a new id for each that has none or one already taken.
    fn claim(&mut self, s: &mut Slots) {
        for i in 0..s.id.len() {
            let id = s.id[i];
            if id != 0 && self.taken.insert(id) {
                self.next = self.next.max(id.saturating_add(1));
                continue;
            }
            while self.taken.contains(&self.next) || self.next == 0 {
                self.next = self.next.wrapping_add(1);
            }
            self.taken.insert(self.next);
            s.fix[i] = Some(self.next);
            self.next = self.next.wrapping_add(1);
        }
    }
}

/// The highest id `b` and the blocks and drawings inside it hold (0 when none has one).
pub fn max_id(b: &Block) -> u32 {
    match b {
        Block::Para(p) => p.objects.iter().filter_map(|o| o.frame().map(|(_, _, f)| f.id.0)).fold(p.id.0, u32::max),
        Block::Table(t) => t.rows.iter().flat_map(|r| &r.cells).flat_map(|c| &c.blocks).map(|b| max_id(b)).fold(t.id.0, u32::max),
        Block::Container(c) => {
            let inside = c
                .regions()
                .into_iter()
                .flat_map(|(_, list)| list.as_slice())
                .map(|b| max_id(b))
                .fold(0, u32::max);
            c.id.0.max(inside)
        }
    }
}

/// Every story's blocks: the body's, then each part's.
fn stories(doc: &mut Document) -> Vec<&mut Blocks> {
    let mut out = vec![&mut doc.body];
    out.extend(doc.parts.values_mut().map(|p| &mut p.blocks));
    out
}

impl Document {
    /// Where the drawing with stable id `id` is: its paragraph's story and path and its U+FFFC's byte offset.
    pub fn object_by_id(&self, id: u32) -> Option<crate::Pos> {
        let mut found = None;
        let stories = std::iter::once(crate::StoryRef::Body).chain(self.parts.keys().map(|k| crate::StoryRef::Part(*k)));
        for story in stories {
            for path in self.para_paths(story) {
                let Some(p) = self.para(story, &path) else { continue };
                if let Some((off, _)) = p.objects_with_offsets().find(|(_, o)| o.frame().is_some_and(|(_, _, f)| f.id.0 == id)) {
                    found = Some(crate::Pos::new(story, path, off));
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }
        found
    }

    /// The path of the body paragraph with stable id `id`.
    pub fn para_path_by_id(&self, id: u32) -> Option<crate::Path> {
        self.para_paths(crate::StoryRef::Body).into_iter().find(|p| self.para(crate::StoryRef::Body, p).is_some_and(|d| d.id.0 == id))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::{Paragraph, para_block};

    fn ids(doc: &Document) -> Vec<u32> {
        doc.body.iter().map(|b| b.as_para().map_or(0, |p| p.id.0)).collect()
    }

    #[test]
    fn a_split_gives_the_second_half_a_new_id_and_a_join_keeps_the_first() {
        let mut doc = Document::from_text("one\ntwo\nthree");
        let mut ids_of = Ids::fill(&mut doc);
        assert_eq!(ids(&doc), [1, 2, 3]);
        // Typing in "two": the paragraph is copied, keeps its id and reads as replaced.
        let mut p = doc.body[1].as_para().unwrap().clone();
        p.text.push('!');
        doc.body[1] = para_block(p.clone());
        let c = ids_of.update(&mut doc);
        assert_eq!((ids(&doc), c.of(Change::Replaced)), (vec![1, 2, 3], vec![2]));
        // A split of "two": both halves are copies of it; the second gets a new id.
        doc.body[1] = para_block(p.clone());
        doc.body.insert(2, para_block(p));
        let c = ids_of.update(&mut doc);
        assert_eq!(ids(&doc), [1, 2, 4, 3]);
        assert_eq!((c.of(Change::Replaced), c.of(Change::Inserted)), (vec![2], vec![4]));
        // A join of the halves keeps the first one's id.
        doc.body.remove(2);
        let c = ids_of.update(&mut doc);
        assert_eq!((ids(&doc), c.of(Change::Removed)), (vec![1, 2, 3], vec![4]));
        // A copy of paragraph 1 pasted at the end gets its own id, and the original keeps its block.
        let one = doc.body[0].as_para().unwrap().clone();
        doc.body.push(para_block(one));
        let first = Arc::as_ptr(&doc.body[0]);
        let c = ids_of.update(&mut doc);
        assert_eq!((ids(&doc), c.of(Change::Inserted)), (vec![1, 2, 3, 5], vec![5]));
        assert_eq!(Arc::as_ptr(&doc.body[0]), first, "an untouched block is not copied");
        // Merged: inserted then edited is inserted; inserted then removed is gone.
        let mut all = Changes::default();
        all.then(c.clone());
        all.then(Changes([(5, Change::Replaced)].into()));
        assert_eq!(all.of(Change::Inserted), [5]);
        all.then(Changes([(5, Change::Removed)].into()));
        assert!(all.is_empty());
        assert_eq!(Document::from_text("x").body[0].as_para().unwrap().id, Paragraph::new().id, "ids are not content");
    }

    #[test]
    fn table_cells_and_drawings_get_ids_and_an_edit_in_a_cell_names_its_paragraph() {
        let mut doc = Document::from_text("a");
        doc.body.insert(0, Arc::new(Block::Table(crate::Table::new(2, 2, 200.0))));
        let mut p = Paragraph::with_text("pic", Default::default());
        let image = crate::para::Picture { w: 10.0, h: 10.0, ..Default::default() }.build();
        p.insert_object(0, image, &Default::default()).unwrap();
        doc.body.push(para_block(p));
        let mut ids_of = Ids::fill(&mut doc);
        let json = serde_json::to_string(&doc).unwrap();
        assert!(json.contains(r#""kind":"table","id":1"#), "{}", &json[..120]);
        let obj = doc.object_by_id(8).unwrap();
        assert_eq!(obj.path.0, [2]);
        assert_eq!(doc.para_path_by_id(7).unwrap().0, [2]);
        // An edit in cell (1, 0): the table and the cell's paragraph are replaced, the other cells are not.
        let Block::Table(t) = Arc::make_mut(&mut doc.body[0]) else { panic!() };
        let cell = &mut t.rows[1].cells[0].blocks[0];
        let mut q = cell.as_para().unwrap().clone();
        q.text.push('x');
        *cell = para_block(q);
        let c = ids_of.update(&mut doc);
        assert_eq!(c.of(Change::Replaced), [1, 4]);
        assert!(c.of(Change::Inserted).is_empty() && c.of(Change::Removed).is_empty());
    }

    /// A part added (a footnote, say) reports its blocks inserted once, an edit in it replaced, and taken out removed once;
    /// the body's edits meanwhile report only their own blocks.
    #[test]
    fn a_part_that_comes_and_goes_reports_its_blocks_once() {
        let mut doc = Document::from_text("one\ntwo");
        let mut ids_of = Ids::fill(&mut doc);
        let part = |text: &str| crate::Part { kind: crate::PartKind::Footnote, blocks: vec![para_block(Paragraph::with_text(text, Default::default()))], body: Default::default() };
        doc.parts.insert(7, part("note"));
        let c = ids_of.update(&mut doc);
        assert_eq!((c.of(Change::Inserted), c.of(Change::Replaced)), (vec![3], vec![]));
        let mut p = doc.body[0].as_para().unwrap().clone();
        p.text.push('!');
        doc.body[0] = para_block(p);
        let c = ids_of.update(&mut doc);
        assert_eq!((c.of(Change::Inserted), c.of(Change::Replaced)), (vec![], vec![1]), "an edit in the body names only its block");
        let mut q = doc.parts[&7].blocks[0].as_para().unwrap().clone();
        q.text.push('!');
        doc.parts.get_mut(&7).unwrap().blocks[0] = para_block(q);
        assert_eq!(ids_of.update(&mut doc).of(Change::Replaced), [3], "an edit in the part");
        doc.parts.remove(&7);
        assert_eq!(ids_of.update(&mut doc).of(Change::Removed), [3], "the part taken out");
        assert!(ids_of.update(&mut doc).is_empty(), "nothing changed since");
    }

    /// engine-layout-key: one paragraph of a 15,000-block body edited and brought up to date, 500 times (a measure).
    #[test]
    #[ignore = "a measure: cargo test --release -p ew-doc ids_update_cost -- --ignored --nocapture"]
    fn ids_update_cost() {
        let text = (0..15_000).map(|i| format!("p{i}")).collect::<Vec<_>>().join("\n");
        let mut doc = Document::from_text(&text);
        let mut ids_of = Ids::fill(&mut doc);
        let mut times = Vec::new();
        for _ in 0..500 {
            let mut p = doc.body[5_000].as_para().unwrap().clone();
            p.text.push('x');
            doc.body[5_000] = para_block(p);
            let t = std::time::Instant::now();
            let c = ids_of.update(&mut doc);
            times.push(t.elapsed().as_secs_f64() * 1e3);
            assert_eq!(c.of(Change::Replaced).len(), 1);
        }
        times.sort_by(f64::total_cmp);
        println!("Ids::update after a one-paragraph edit of 15,000 blocks: median {:.3} ms, p95 {:.3}", times[250], times[475]);
    }
}
