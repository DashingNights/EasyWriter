//! engine-layout-ids (docs/plans/word/briefs/engine-layout-ids.md): the layout names the body's top-level blocks by their
//! stable id ([`ew_doc::Id`], viewport-design.md section 10), not by their number. A body item's path, a page's first
//! block, a floating table's path, the line index's keys and the marks a layout goes on from start with the block's id, so a
//! block added or taken away before them changes none of them: an edit lays out only the pages its text reaches, and the
//! pages after the point where the pagination comes back keep their items as they are.
//!
//! Where a position must still be a block number (a [`Pos`] for the commands, hit testing, painting, the accessibility copy,
//! PDF export) it goes through [`BlockIds`], the one id-to-number map of a layout, which its pages share and each edit
//! updates in place. Paths inside a table keep their row, cell and block numbers: an edit in a table lays the table out again.
//!
//! A block is named by its stable id when it has one no earlier block holds, which every block of a session's document has
//! (the session gives them before it lays out). One without (a document laid out on its own, as the layout's tests do) is
//! named by its number when no block holds that, else by an id above every one the document holds: a document without ids
//! laid out from the start is named by its block numbers.
use std::collections::HashMap;
use std::sync::{Arc, PoisonError, RwLock, RwLockReadGuard};

use ew_doc::{Block, Path, Pos, StoryRef};

/// The names of a layout's body blocks.
#[derive(Default)]
struct Names {
    /// Block number → id.
    ids: Vec<u32>,
    /// Id → block number.
    at: HashMap<u32, u32>,
    /// The next id of the layout's own, for a block whose stable id is unset or held by an earlier block when its number is
    /// held too.
    next: u32,
    /// How many edits the names took in: a layout taken out of step with them (one copied before an edit to the other
    /// copy) is laid out whole.
    edits: u64,
}

impl Names {
    fn of(body: &[Arc<Block>]) -> Names {
        let top = body.iter().map(|b| block_id(b)).max().unwrap_or(0).saturating_add(1);
        let next = top.max(u32::try_from(body.len()).unwrap_or(u32::MAX));
        let mut n = Names { ids: Vec::with_capacity(body.len()), at: HashMap::with_capacity(body.len()), next, edits: 0 };
        for (i, b) in body.iter().enumerate() {
            let id = n.take(block_id(b), i);
            n.ids.push(id);
        }
        n
    }

    /// Names block `block` by `id` when that is set and free, else by its number when that is free, else by an id of the
    /// layout's own.
    fn take(&mut self, id: u32, block: usize) -> u32 {
        let block = u32::try_from(block).unwrap_or(u32::MAX);
        let free = |at: &HashMap<u32, u32>, n: u32| n != u32::MAX && !at.contains_key(&n);
        let name = if id != 0 && free(&self.at, id) {
            id
        } else if free(&self.at, block) {
            block
        } else {
            while !free(&self.at, self.next) {
                self.next = self.next.wrapping_add(1);
            }
            self.next
        };
        self.at.insert(name, block);
        name
    }

    /// Blocks `start..old_end` became `start..new_end` of `body`: their names go and the new blocks' come, and the blocks
    /// after them move. In place: a block added near the start costs one pass over the numbers, nothing per page.
    fn edit(&mut self, body: &[Arc<Block>], start: usize, old_end: usize, new_end: usize) -> Vec<u32> {
        let held = self.ids.get(start..old_end.min(self.ids.len())).unwrap_or_default().to_vec();
        for (i, id) in self.ids.iter().enumerate().take(old_end).skip(start) {
            if self.at.get(id).is_some_and(|b| *b as usize == i) {
                self.at.remove(id);
            }
        }
        let delta = new_end as i64 - old_end as i64;
        if delta != 0 {
            let from = u32::try_from(old_end).unwrap_or(u32::MAX);
            for b in self.at.values_mut().filter(|b| **b >= from) {
                *b = u32::try_from(i64::from(*b) + delta).unwrap_or(*b);
            }
        }
        let fresh: Vec<u32> = (start..new_end).map(|i| body.get(i).map_or(0, |b| block_id(b))).collect();
        let fresh: Vec<u32> = fresh.into_iter().zip(start..).map(|(id, i)| self.take(id, i)).collect();
        let end = old_end.min(self.ids.len());
        self.ids.splice(start.min(end)..end, fresh);
        self.edits += 1;
        held
    }

    /// The number of the block named `id`. A page made by hand (`Page::default()`) has no names: its paths hold numbers.
    fn block(&self, id: u32) -> Option<usize> {
        if self.ids.is_empty() {
            return Some(id as usize);
        }
        self.at.get(&id).map(|b| *b as usize)
    }

    fn id(&self, block: usize) -> Option<u32> {
        if self.ids.is_empty() {
            return u32::try_from(block).ok();
        }
        self.ids.get(block).copied()
    }
}

fn block_id(b: &Block) -> u32 {
    match b {
        Block::Para(p) => p.id.0,
        Block::Table(t) => t.id.0,
        Block::Container(c) => c.id.0,
    }
}

/// A layout's id-to-number map for its body blocks, shared by the layout and its pages (painting a page resolves its
/// items' paths with it) and updated in place by the edits the layout takes in.
///
/// A clone shares the map, so a cloned page or layout resolves its ids against the latest edit, not the one it was made
/// at: `pass.rs` `redo()` renames in place before its fallible steps, and a layout it gives up on is laid out whole with
/// names of its own. Keep a page's own number (its `Pos`) rather than its ids when it must outlive the next edit.
#[derive(Clone, Default)]
pub struct BlockIds(Arc<RwLock<Names>>);

impl std::fmt::Debug for BlockIds {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "BlockIds({} blocks)", self.read().ids.len())
    }
}

impl BlockIds {
    /// The names of `body`'s blocks, for a layout made from the start.
    pub(crate) fn of(body: &[Arc<Block>]) -> BlockIds {
        BlockIds(Arc::new(RwLock::new(Names::of(body))))
    }

    fn read(&self) -> RwLockReadGuard<'_, Names> {
        self.0.read().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes in an edit: blocks `start..old_end` became `start..new_end` of `body` → the ids blocks `start..old_end` had.
    pub(crate) fn edit(&self, body: &[Arc<Block>], start: usize, old_end: usize, new_end: usize) -> Vec<u32> {
        self.0.write().unwrap_or_else(PoisonError::into_inner).edit(body, start, old_end, new_end)
    }

    /// How many edits these names took in.
    pub(crate) fn edits(&self) -> u64 {
        self.read().edits
    }

    /// The number of the body block named `id` (`None`: no block has that name now).
    pub fn block(&self, id: u32) -> Option<usize> {
        self.read().block(id)
    }

    /// The id body block `block` is named by.
    pub fn id(&self, block: usize) -> Option<u32> {
        self.read().id(block)
    }

    /// A layout path in `story` (an item's) as a document path: a body path's first index is the block's id.
    pub fn doc_path(&self, story: StoryRef, path: &Path) -> Option<Path> {
        self.swap_first(story, path, |n, id| n.block(id).and_then(|b| u32::try_from(b).ok()))
    }

    /// A document path in `story` as the layout names it.
    pub fn layout_path(&self, story: StoryRef, path: &Path) -> Option<Path> {
        self.swap_first(story, path, |n, block| n.id(block as usize))
    }

    /// [`Self::doc_path`] for a position.
    pub fn doc_pos(&self, pos: &Pos) -> Option<Pos> {
        Some(Pos { story: pos.story, path: self.doc_path(pos.story, &pos.path)?, off: pos.off })
    }

    /// [`Self::layout_path`] for a position.
    pub fn layout_pos(&self, pos: &Pos) -> Option<Pos> {
        Some(Pos { story: pos.story, path: self.layout_path(pos.story, &pos.path)?, off: pos.off })
    }

    fn swap_first(&self, story: StoryRef, path: &Path, f: impl Fn(&Names, u32) -> Option<u32>) -> Option<Path> {
        let mut p = path.clone();
        if story == StoryRef::Body
            && let Some(first) = p.0.first_mut()
        {
            *first = f(&self.read(), *first)?;
        }
        Some(p)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use ew_doc::{Document, Id, para_block};

    fn body(ids: &[u32]) -> Vec<Arc<Block>> {
        ids.iter()
            .map(|id| {
                let mut p = ew_doc::Paragraph::new();
                p.id = Id(*id);
                para_block(p)
            })
            .collect()
    }

    #[test]
    fn an_edit_moves_the_blocks_after_it_and_names_the_new_ones() {
        let ids = BlockIds::of(&body(&[5, 7, 9, 11]));
        assert_eq!((ids.block(9), ids.id(3)), (Some(2), Some(11)));
        // Block 1 split in two: the second half has a new id.
        let b = body(&[5, 7, 20, 9, 11]);
        assert_eq!(ids.edit(&b, 1, 2, 3), [7]);
        assert_eq!([7, 20, 9, 11].map(|id| ids.block(id)), [Some(1), Some(2), Some(3), Some(4)]);
        assert_eq!(ids.layout_path(StoryRef::Body, &Path(vec![3, 1, 0, 0])), Some(Path(vec![9, 1, 0, 0])));
        assert_eq!(ids.doc_path(StoryRef::Body, &Path(vec![9, 1, 0, 0])), Some(Path(vec![3, 1, 0, 0])));
        assert_eq!(ids.doc_path(StoryRef::Part(3), &Path(vec![9])), Some(Path(vec![9])), "other stories keep numbers");
        // Joined again: the second half's name goes.
        ids.edit(&body(&[5, 7, 9, 11]), 1, 3, 2);
        assert_eq!((ids.block(20), ids.block(11), ids.edits()), (None, Some(3), 2));
    }

    #[test]
    fn blocks_without_a_free_stable_id_are_named_by_their_number_or_an_id_of_the_layouts_own() {
        let doc = Document::from_text("a\nb\nc");
        let ids = BlockIds::of(&doc.body);
        let names: Vec<u32> = (0..3).map(|b| ids.id(b).unwrap()).collect();
        assert_eq!(names, [0, 1, 2], "named by their numbers");
        let ids = BlockIds::of(&body(&[1, 1, 0]));
        assert_eq!((0..3).map(|b| ids.id(b).unwrap()).collect::<Vec<_>>(), [1, 3, 2], "the second 1 and its number are held");
        assert_eq!(BlockIds::default().block(7), Some(7), "a page made by hand holds block numbers");
    }
}
