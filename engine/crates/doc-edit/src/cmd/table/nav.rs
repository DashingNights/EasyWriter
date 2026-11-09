//! Table reads and the table commands of stage 2's Page and Tables package (docs/plans/engine/stage2.md S3, gaps G26 and G31):
//! `table.get`, the ribbon state of the Table Design and Table Layout controls, Word's table keys (Alt+Home, Alt+End,
//! Alt+PageUp, Alt+PageDown, with Shift), moving a row (Alt+Shift+Up and Down) and clearing direct cell formatting
//! (Ctrl+Alt+U).

use serde_json::{Value, json};
use ew_doc::props::{Align, VAlign, VMerge};
use ew_doc::{Document, Path, Pos, StoryRef, Table};

use super::cells::{cell, cell_text, grid_cols, selected_cells, with_table};
use super::layout::fix_caret;
use super::select::extend_selection;
use crate::{CmdError, CmdResult, Selection, Session, p};

/// The table the caret is in, with the caret's row and cell, or None.
pub(super) fn caret_table(s: &Session) -> Option<(&Table, usize, usize)> {
    let (tp, r, c) = s.doc.cell_of(s.sel.focus.story, &s.sel.focus.path)?;
    Some((s.doc.table(s.sel.focus.story, &tp)?, r, c))
}

/// `table.get`: the caret's table whole: its properties, grid, rows and cells (properties, text, first grid column), the caret's
/// row and cell, the selected cell rectangle (rows and grid columns, both inclusive) and whether it holds a nested table.
pub(super) fn get(s: &Session) -> Value {
    let Some((t, r, c)) = caret_table(s) else { return Value::Null };
    let rows: Vec<Value> = t
        .rows
        .iter()
        .enumerate()
        .map(|(ri, row)| {
            let cells: Vec<Value> = row
                .cells
                .iter()
                .enumerate()
                .map(|(ci, cl)| json!({"props": cl.props, "text": cell_text(cl), "col": t.grid_col(ri, ci)}))
                .collect();
            json!({"props": row.props, "cells": cells})
        })
        .collect();
    let picked = selected_cells(s);
    let rect = (picked.len() > 1).then(|| {
        let (mut r0, mut r1, mut g0, mut g1) = (usize::MAX, 0, usize::MAX, 0);
        for (pr, pc) in &picked {
            let (a, b) = grid_cols(t, *pr, *pc);
            (r0, r1, g0, g1) = (r0.min(*pr), r1.max(*pr), g0.min(a), g1.max(b));
        }
        json!({"rows": [r0, r1], "cols": [g0, g1]})
    });
    let nested = t.rows.iter().flat_map(|row| &row.cells).any(|cl| cl.blocks.iter().any(|b| b.as_para().is_none()));
    json!({"props": t.props, "grid": t.grid, "rows": rows, "row": r, "cell": c, "selection": rect, "nested": nested})
}

/// The caret cell's alignment as `table.cellAlign` names it (topLeft … bottomRight), from its vertical alignment and its first
/// paragraph's alignment.
pub(super) fn cell_align(s: &Session) -> Value {
    let Some((t, r, c)) = caret_table(s) else { return Value::Null };
    let Some(cl) = t.rows.get(r).and_then(|row| row.cells.get(c)) else { return Value::Null };
    let v = match cl.props.valign.unwrap_or(VAlign::Top) {
        VAlign::Top => "top",
        VAlign::Center => "center",
        VAlign::Bottom => "bottom",
    };
    let align = cl.blocks.iter().find_map(|b| b.as_para()).map(|p| s.doc.styles.resolve_para(&p.props).align);
    let h = match align {
        Some(Align::Center) => "Center",
        Some(Align::Right) => "Right",
        _ => "Left",
    };
    // `center` alone is the middle of both, as table.cellAlign names it.
    json!(if v == "center" && h == "Center" { "center".to_string() } else { format!("{v}{h}") })
}

/// The start of cell `c` of row `r` (its first paragraph, even in a nested table).
fn cell_start(doc: &Document, story: StoryRef, tp: &Path, r: usize, c: usize) -> Option<Pos> {
    let mut prefix = tp.0.clone();
    prefix.extend([u32::try_from(r).ok()?, u32::try_from(c).ok()?]);
    let path = doc.para_paths(story).into_iter().find(|q| q.0.starts_with(&prefix))?;
    Some(Pos { story, path, off: 0 })
}

/// The cell of row `r` that covers grid column `g` (the last one when the row is shorter).
fn cell_covering(t: &Table, r: usize, g: usize) -> usize {
    let n = t.rows.get(r).map_or(0, |row| row.cells.len());
    (0..n).find(|c| {
        let (a, b) = grid_cols(t, r, *c);
        a <= g && g <= b
    })
    .unwrap_or(n.saturating_sub(1))
}

/// Word's table keys: `to` rowStart (Alt+Home), rowEnd (Alt+End), columnTop (Alt+PageUp) or columnBottom (Alt+PageDown); with
/// `extend` (Shift) the selection grows to that cell, whole cells as a drag selects them.
pub(super) fn move_to(s: &mut Session, v: &Value) -> CmdResult {
    let (tp, r, c) = cell(s)?;
    let story = s.sel.focus.story;
    let t = s.doc.table(story, &tp).ok_or_else(|| CmdError::Disabled("the cursor isn't in a table".into()))?;
    let g = t.grid_col(r, c);
    let last_row = t.rows.len().saturating_sub(1);
    let (tr, tc) = match p::req_str(v, "to")? {
        "rowStart" => (r, 0),
        "rowEnd" => (r, t.rows.get(r).map_or(0, |row| row.cells.len().saturating_sub(1))),
        "columnTop" => (0, cell_covering(t, 0, g)),
        "columnBottom" => (last_row, cell_covering(t, last_row, g)),
        x => return Err(CmdError::Params(format!("unknown `to` `{x}`"))),
    };
    let at = cell_start(&s.doc, story, &tp, tr, tc).ok_or_else(|| CmdError::Failed("no such cell".into()))?;
    if p::bool(v, "extend").unwrap_or(false) {
        extend_selection(s, at);
    } else {
        s.sel = Selection::caret(at);
    }
    crate::cmd::sel_result(s)
}

/// Whether rows `a` and `b` (next to each other, `a` above) can swap: no cell of either joins a vertical merge, and the row
/// below them does not continue one from them.
fn swappable(t: &Table, a: usize, b: usize) -> bool {
    let merged = |r: usize| t.rows.get(r).is_some_and(|row| row.cells.iter().any(|cl| cl.props.vmerge != VMerge::None));
    let continues = |r: usize| t.rows.get(r).is_some_and(|row| row.cells.iter().any(|cl| cl.props.vmerge == VMerge::Continue));
    !merged(a) && !merged(b) && !continues(b + 1)
}

/// Alt+Shift+Up and Down in a table: the caret's row trades places with the one above or below; the caret goes with it. At the
/// table's edge it stays (Word moves it out of the table; recorded deviation, as on the DOM path).
pub(super) fn move_row(s: &mut Session, v: &Value) -> CmdResult {
    let (tp, r, c) = cell(s)?;
    let up = match p::str(v, "dir").unwrap_or("down") {
        "up" => true,
        "down" => false,
        x => return Err(CmdError::Params(format!("unknown `dir` `{x}`"))),
    };
    let t = s.doc.table(s.sel.focus.story, &tp).ok_or_else(|| CmdError::Disabled("the cursor isn't in a table".into()))?;
    let to = if up { r.checked_sub(1) } else { Some(r + 1).filter(|x| *x < t.rows.len()) };
    let Some(to) = to else { return Err(CmdError::Disabled(if up { "the row is at the top" } else { "the row is at the bottom" }.into())) };
    if !swappable(t, r.min(to), r.max(to)) {
        return Err(CmdError::Disabled("a cell that spans rows is in the way".into()));
    }
    let t = s.doc.table_mut(s.sel.focus.story, &tp)?;
    t.rows.swap(r, to);
    fix_caret(s, &tp, to, c)
}

/// Ctrl+Alt+U (Word's Update AutoFormat): the cells' own shading and borders go, so the table style shows again. A nested
/// table keeps its own.
pub(super) fn clear_direct(s: &mut Session, _: &Value) -> CmdResult {
    with_table(s, |t| {
        for cl in t.rows.iter_mut().flat_map(|row| row.cells.iter_mut()) {
            cl.props.shading = None;
            cl.props.borders = None;
        }
    })
}
