//! Insert Cells and Delete Cells that shift cells (stage 2 gap G54), as Word's dialogs do: shift right puts new cells in the
//! selected rows and leaves them longer than the others; shift down and shift up move the selected columns' contents down or
//! up a row each, a new row at the bottom taking what is pushed off, and the cells left behind empty.

use super::cells::{cell, selected_cells};
use super::layout::{fix_caret, touch_cells};
use super::{CmdError, CmdResult, Session, Table, Value, p};

/// The selection's rows and cells: (first row, last row, first cell, last cell), by cell index.
fn rect(s: &Session) -> (usize, usize, usize, usize) {
    let cells = selected_cells(s);
    let rows = cells.iter().map(|x| x.0);
    let cols = cells.iter().map(|x| x.1);
    (rows.clone().min().unwrap_or(0), rows.max().unwrap_or(0), cols.clone().min().unwrap_or(0), cols.max().unwrap_or(0))
}

/// Shifting moves cells by index, which merged cells would scramble, and the moves are no tracked changes.
fn refuse(s: &Session, t: &Table) -> Result<(), CmdError> {
    if t.rows.iter().flat_map(|r| &r.cells).any(|c| c.span() > 1 || c.props.vmerge != ew_doc::props::VMerge::None) {
        return Err(CmdError::Disabled("cells can't shift in a table with merged cells".into()));
    }
    if s.doc.settings.track_changes {
        return Err(CmdError::Disabled("cells can't shift while Track Changes is on".into()));
    }
    Ok(())
}

/// Table Layout › Insert Cells: `shift` right (new cells before the selection in its rows) or down (the selection's columns
/// move down by as many rows as it has, onto new rows at the bottom).
pub(super) fn insert_cells(s: &mut Session, v: &Value) -> CmdResult {
    let (tp, r, c) = cell(s)?;
    let (r0, r1, c0, c1) = rect(s);
    let story = s.sel.focus.story;
    let shift = p::str(v, "shift").unwrap_or("right");
    refuse(s, s.doc.table(story, &tp).ok_or_else(|| CmdError::Failed("no table".into()))?)?;
    let t = s.doc.table_mut(story, &tp)?;
    match shift {
        "right" => {
            let k = c1 - c0 + 1;
            let w = t.grid.get(t.grid_col(r0, c0)).copied().unwrap_or(72.0);
            for row in t.rows.iter_mut().skip(r0).take(r1 - r0 + 1) {
                let like = row.cells.get(c0).cloned().unwrap_or_else(ew_doc::Cell::empty);
                for _ in 0..k {
                    let mut nc = ew_doc::Cell::empty();
                    nc.props = like.props.clone();
                    row.cells.insert(c0.min(row.cells.len()), nc);
                }
            }
            // The longer rows reach k new grid columns; the others end before them (w:gridAfter).
            t.grid.extend(std::iter::repeat_n(w, k));
            for (i, row) in t.rows.iter_mut().enumerate() {
                if !(r0..=r1).contains(&i) {
                    row.props.grid_after += k as u32;
                }
            }
        }
        "down" => {
            let k = r1 - r0 + 1;
            let last = t.rows.len() - 1;
            for _ in 0..k {
                t.insert_row(t.rows.len(), last);
            }
            let n = t.rows.len();
            for col in c0..=c1 {
                for i in (r0..n).rev() {
                    let blocks = if i >= r0 + k { t.rows.get(i - k).and_then(|row| row.cells.get(col)).map(|cl| cl.blocks.clone()) } else { None };
                    if let Some(cl) = t.rows.get_mut(i).and_then(|row| row.cells.get_mut(col)) {
                        cl.blocks = blocks.unwrap_or_else(|| ew_doc::Cell::empty().blocks);
                    }
                }
            }
        }
        x => return Err(CmdError::Params(format!("unknown shift `{x}` (right or down)"))),
    }
    touch_cells(s, &tp)?;
    fix_caret(s, &tp, r, c)
}

/// Delete Cells shift up: the selection's columns move up by as many rows as it has; the bottom cells are left empty.
pub(super) fn delete_cells_up(s: &mut Session) -> CmdResult {
    let (tp, r, c) = cell(s)?;
    let (r0, r1, c0, c1) = rect(s);
    let story = s.sel.focus.story;
    refuse(s, s.doc.table(story, &tp).ok_or_else(|| CmdError::Failed("no table".into()))?)?;
    let t = s.doc.table_mut(story, &tp)?;
    let k = r1 - r0 + 1;
    let n = t.rows.len();
    for col in c0..=c1 {
        for i in r0..n {
            let blocks = t.rows.get(i + k).and_then(|row| row.cells.get(col)).map(|cl| cl.blocks.clone());
            if let Some(cl) = t.rows.get_mut(i).and_then(|row| row.cells.get_mut(col)) {
                cl.blocks = blocks.unwrap_or_else(|| ew_doc::Cell::empty().blocks);
            }
        }
    }
    touch_cells(s, &tp)?;
    fix_caret(s, &tp, r, c)
}

/// Whether Insert Cells and Delete Cells may shift here (the dialog's rows read it).
pub(super) fn shift_off(s: &Session) -> Option<&'static str> {
    let (tp, _, _) = s.doc.cell_of(s.sel.focus.story, &s.sel.focus.path)?;
    let t = s.doc.table(s.sel.focus.story, &tp)?;
    refuse(s, t).err().map(|_| "cells can't shift in a table with merged cells or while Track Changes is on")
}
