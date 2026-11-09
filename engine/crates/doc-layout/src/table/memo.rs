//! A table's rows as its last layout made them (engine-edit-cost, docs/plans/word/briefs/engine-edit-cost.md), so a key in a
//! cell lays out that cell's row and takes the others over as they were. A row is taken over when it is the same row (its
//! cells' blocks the same pointers, its and their properties equal) at the same place of a table with the same properties,
//! rows and columns, under a row above with the same bottom borders (the row's top band reads them). The column measure of
//! an autofit table is kept per row the same way, since it does not depend on the columns.
//!
//! Only rows that lay out the same wherever the walk is are kept ([`plain`]): paragraphs with no list label, field, note,
//! equation or drawing, and no nested table, merged or turned cell. The memo goes with the paragraph layouts when the
//! environment (styles, numbering, options) changes, and when a font arrives.
//! ponytail: rows holding any of those, and tables in headers, text boxes and other tables, are laid out each time; widen
//! [`plain`] when a table of them is measured slow. A deleted table's memo goes at the next pass (`new_ctx`, engine-fixes-layout).

use std::sync::Arc;

use ew_doc::para::InlineObject;
use ew_doc::props::{Border, Borders, TableProps, TextDirection, VMerge};
use ew_doc::{Block, Row, StoryRef, Table};

use super::{CellBox, RowLayout};
use crate::{Ctx, ViewMode};

/// What every row of a table depends on besides itself, the row above and the columns.
#[derive(Clone, PartialEq)]
struct TableKey {
    props: TableProps,
    rows: usize,
    cols: usize,
    view: ViewMode,
    spacing: Option<u32>,
    grid: (u32, u32, u32, bool),
}

/// A cell's place and bottom border: what the top band of the cell below reads.
#[derive(Clone, PartialEq)]
pub(super) struct Edge {
    g: usize,
    span: usize,
    vmerge: VMerge,
    bottom: Option<Border>,
}

impl Edge {
    pub(super) fn of(cells: &[CellBox]) -> Vec<Edge> {
        cells.iter().map(|c| Edge { g: c.g, span: c.span, vmerge: c.vmerge, bottom: c.borders.bottom }).collect()
    }

    /// A stand-in for a cell taken over: what the row below and the vertical merges read of it.
    pub(super) fn stub(&self) -> CellBox {
        CellBox {
            items: Vec::new(),
            h: 0.0,
            x: 0.0,
            w: 0.0,
            valign: Default::default(),
            fill: None,
            borders: Borders { bottom: self.bottom, ..Default::default() },
            vmerge: self.vmerge,
            margins: [0.0; 4],
            g: self.g,
            span: self.span,
            turned: None,
            end: 0.0,
            band_t: 0.0,
        }
    }
}

/// A row's share of the column measure: its cells' (first grid column, columns, narrowest and widest need) in order, the
/// gaps it leaves before and after them, and whether any cell holds content.
#[derive(Default)]
pub(super) struct Measured {
    pub(super) cells: Vec<(usize, usize, (f32, f32))>,
    pub(super) gaps: Vec<(usize, usize, f32)>,
    pub(super) any: bool,
}

/// A row as the first pass left it (the row above's edges it read, its own, its height, room below and edge) and finished.
pub(super) struct Laid {
    pub(super) above: Vec<Edge>,
    pub(super) cells: Vec<Edge>,
    pub(super) height: f32,
    pub(super) bottom: f32,
    pub(super) edge: f32,
    pub(super) layout: Arc<RowLayout>,
}

/// What is kept of one row: the row it was made from, whether it is kept at all ([`plain`]), its measure and its layout.
pub(super) struct Kept {
    row: Row,
    plain: bool,
    pub(super) measured: Option<Measured>,
    pub(super) laid: Option<Laid>,
}

pub(crate) struct TableMemo {
    key: TableKey,
    /// The columns the rows were laid out in.
    colx: Vec<f32>,
    rows: Vec<Option<Kept>>,
    /// The revision of the paragraph with the word being typed, which lays out without its squiggle: its row is neither
    /// taken over nor kept.
    typing: Option<u64>,
}

impl TableMemo {
    /// The memo of table `t` at `path` taken out of the cache (put back with [`TableMemo::keep`]), less the rows that
    /// changed; an empty one when it has none or the table changed around them. `None` for a table not kept: one in another
    /// story, nested, or a header's (`ctx.pin`), or with the memo turned off.
    pub(super) fn take(ctx: &mut Ctx, story: StoryRef, t: &Table, path: &[u32], depth: usize) -> Option<TableMemo> {
        if story != StoryRef::Body || depth != 1 || ctx.pin.is_some() || ctx.cache.rows_off {
            return None;
        }
        let fonts = ew_fonts::FontDb::global().generation();
        if ctx.cache.tables_fonts != fonts {
            ctx.cache.tables.clear();
            ctx.cache.tables_fonts = fonts;
        }
        let key = TableKey {
            props: t.props.clone(),
            rows: t.rows.len(),
            cols: t.cols(),
            view: ctx.opts.view,
            spacing: ctx.opts.line_spacing_override().map(f32::to_bits),
            grid: ctx.grid.key(),
        };
        let typing = ctx.opts.typing_word.map(|w| w.rev);
        let mut m = ctx.cache.tables.remove(path).filter(|m| m.key == key).unwrap_or(TableMemo { key, colx: Vec::new(), rows: Vec::new(), typing });
        m.typing = typing;
        m.rows.resize_with(t.rows.len(), || None);
        for (k, row) in m.rows.iter_mut().zip(&t.rows) {
            if k.as_ref().is_some_and(|k| !same_row(&k.row, row) || typing.is_some_and(|rev| holds_para(row, rev))) {
                *k = None;
            }
        }
        Some(m)
    }

    /// Row `ri`'s entry, when it is kept (one is made for `row` the first time).
    pub(super) fn kept(&mut self, ctx: &Ctx, ri: usize, row: &Row) -> Option<&mut Kept> {
        let slot = self.rows.get_mut(ri)?;
        if slot.is_none() {
            if self.typing.is_some_and(|rev| holds_para(row, rev)) {
                return None;
            }
            *slot = Some(Kept { row: row.clone(), plain: plain(ctx, row), measured: None, laid: None });
        }
        slot.as_mut().filter(|k| k.plain)
    }

    /// The columns the rows are laid out in now: the layouts made in others go.
    pub(super) fn columns(&mut self, colx: &[f32]) {
        if self.colx != colx {
            self.colx = colx.to_vec();
            self.rows.iter_mut().flatten().for_each(|k| k.laid = None);
        }
    }

    /// Puts the memo back for the table's next layout.
    pub(super) fn keep(self, ctx: &mut Ctx, path: &[u32]) {
        ctx.cache.tables.insert(path.to_vec(), self);
    }
}

/// The same row: equal properties and controls, and cells with equal properties and controls holding the same blocks.
fn same_row(a: &Row, b: &Row) -> bool {
    a.props == b.props
        && a.controls == b.controls
        && a.cells.len() == b.cells.len()
        && a.cells.iter().zip(&b.cells).all(|(x, y)| {
            x.props == y.props
                && x.controls == y.controls
                && x.blocks.len() == y.blocks.len()
                && x.blocks.iter().zip(&y.blocks).all(|(p, q)| Arc::ptr_eq(p, q))
        })
}

/// Whether a paragraph of `row` has revision `rev`.
fn holds_para(row: &Row, rev: u64) -> bool {
    row.cells.iter().flat_map(|c| &c.blocks).any(|b| b.as_para().is_some_and(|p| p.rev == rev))
}

/// Whether `row` lays out the same wherever the walk is: its cells unmerged and unturned, holding paragraphs with no list
/// label (which counts) and no object but bookmarks, comment and permission marks (fields, notes and equations count or read
/// the page; drawings float or read the walk's text box state).
fn plain(ctx: &Ctx, row: &Row) -> bool {
    row.cells.iter().all(|c| {
        c.props.vmerge == VMerge::None
            && c.props.text_direction == TextDirection::Horizontal
            && c.blocks.iter().all(|b| match &**b {
                Block::Para(p) => {
                    p.props.numbering.or_else(|| ctx.doc.styles.resolve_para(&p.props).numbering).is_none_or(|n| n.num == 0)
                        && p.objects.iter().all(|o| {
                            matches!(
                                o,
                                InlineObject::BookmarkStart { .. }
                                    | InlineObject::BookmarkEnd { .. }
                                    | InlineObject::CommentStart { .. }
                                    | InlineObject::CommentEnd { .. }
                                    | InlineObject::PermStart { .. }
                                    | InlineObject::PermEnd { .. }
                            )
                        })
                }
                Block::Table(_) | Block::Container(_) => false,
            })
    })
}
