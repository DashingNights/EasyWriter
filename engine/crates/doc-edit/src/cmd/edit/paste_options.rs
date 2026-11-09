//! Paste Options after a paste (stage 2b gap G29, docs/plans/engine/stage2/gaps.md clipboard): the engine keeps the last paste
//! (where it went, what the clipboard held, which option it used), so the Paste Options button can paste it again with another
//! option as one undo step. The paste is current while the caret stays at its end and its text is unchanged: typing, a click
//! or an undo ends it, as Word's button goes away then. A table pasted into a table cell keeps the table as it was before the
//! paste, so its choices (Nest Table, Insert as New Rows, Overwrite Cells, Keep Text Only) start again from that table.

use std::sync::Arc;

use serde_json::{Value, json};
use ew_doc::edit::Fragment;
use ew_doc::{Block, Path, Pos, StoryRef, Table};

use crate::{CmdError, CmdResult, CommandSpec, Selection, Session};

/// The last paste: its range, its plain text then, the clipboard data it read and the option it used.
#[derive(Clone, Debug)]
pub struct LastPaste {
    start: Pos,
    end: Pos,
    text: String,
    data: Value,
    option: &'static str,
    /// Table cells pasted into a table (the table choices), list paragraphs pasted (the list choices).
    table: bool,
    list: bool,
    /// For a table pasted into a cell: the table round the caret before the paste.
    cells: Option<Cells>,
}

/// The table a paste went into: where it is and its block before the paste. The paste is current while the table's text is
/// the text it had after the paste (LastPaste.text).
#[derive(Clone, Debug)]
struct Cells {
    story: StoryRef,
    path: Path,
    before: Arc<Block>,
}

/// Where a paste starts: the selection's start and the table block round it (taken before the paste changes it).
pub(crate) struct Mark {
    start: Pos,
    table: Option<(Path, Arc<Block>)>,
}

/// The block at `path` in `story`, shared (not copied).
fn block_arc(s: &Session, story: StoryRef, path: &Path) -> Option<Arc<Block>> {
    s.doc.container(story, path)?.get(path.last()).cloned()
}

/// The text of the table `c` names, as it is now (its cells in order).
fn table_text(s: &Session, c: &Cells) -> Option<String> {
    block_arc(s, c.story, &c.path).map(|b| crate::cmd::tools::compare::block_text(&b))
}

/// Marks where a paste starts, before it runs.
pub(crate) fn mark(s: &Session) -> Mark {
    let start = s.sel.ordered().0;
    let table = s.doc.cell_of(start.story, &start.path).and_then(|(tp, _, _)| block_arc(s, start.story, &tp).map(|b| (tp, b)));
    Mark { start, table }
}

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("edit.pasteOptions", "Paste Options", "Home › Clipboard", |s, _| Ok(state(s).1))
            .when(|s| if current(s).is_some() { None } else { Some("nothing was just pasted") })
            .state(state)
            .pure(),
        CommandSpec::new("edit.repaste", "Paste Options: Paste Again", "Home › Clipboard", repaste)
            .params(r#"{"as": "keepSource"|"merge"|"text"|"nest"|"rows"|"overwrite"|"continueList"|"newList"}"#)
            .when(|s| if current(s).is_some() { None } else { Some("nothing was just pasted") }),
    ]
}

/// Whether `frag` holds a table, and whether it holds list paragraphs.
pub(crate) fn kinds(frag: &Fragment) -> (bool, bool) {
    let table = frag.blocks.iter().any(|b| matches!(b, Block::Table(_)));
    let list = frag.blocks.iter().any(|b| b.as_para().is_some_and(|p| p.props.numbering.is_some()));
    (table, list)
}

/// Records the paste that just ran from `at` to the caret with clipboard `data` and `option`; `(table, list)`: the kinds of
/// what it inserted ([`kinds`]).
pub(crate) fn record(s: &mut Session, at: Mark, data: &Value, option: &'static str, (table, list): (bool, bool)) {
    let Mark { start, table: before } = at;
    let end = s.sel.focus.clone();
    // A table pasted into a cell nests there (Word's Nest Table, the button's checked row).
    let cells = before.filter(|_| table).map(|(path, before)| Cells { story: start.story, path, before });
    let (table, option) = match cells {
        Some(_) => (true, if option == "text" { option } else { "nest" }),
        None => (false, option),
    };
    let text = match &cells {
        Some(c) => table_text(s, c).unwrap_or_default(),
        None => s.doc.copy_range(&start, &end).plain_text(),
    };
    // Only what a paste again needs from the clipboard (not a picture's bytes).
    let mut keep = json!({});
    for k in ["text", "html", "rtf"] {
        if let Some(v) = data.get(k).filter(|v| v.is_string()) {
            keep[k] = v.clone();
        }
    }
    s.clip_history.last = Some(LastPaste { start, end, text, data: keep, option, table, list, cells });
}

/// The last paste while it is still current.
// ponytail: the check copies the pasted range's text while the caret sits at its end (only right after a paste); a revision
// stamp from the session would make it constant time.
fn current(s: &Session) -> Option<&LastPaste> {
    let lp = s.clip_history.last.as_ref()?;
    if !s.sel.is_collapsed() || s.sel.focus != lp.end {
        return None;
    }
    let same = match &lp.cells {
        Some(c) => table_text(s, c).is_some_and(|t| t == lp.text),
        None => lp.start <= lp.end && s.doc.copy_range(&lp.start, &lp.end).plain_text() == lp.text,
    };
    same.then_some(lp)
}

/// The Paste Options button's state: (whether it shows, {option, table, list, options}).
fn state(s: &Session) -> (Value, Value) {
    match current(s) {
        None => (json!(false), Value::Null),
        Some(lp) => {
            let options: &[&str] = if lp.table {
                &["nest", "rows", "overwrite", "text"]
            } else if lp.list {
                &["keepSource", "merge", "text", "continueList", "newList"]
            } else {
                &["keepSource", "merge", "text"]
            };
            (json!(true), json!({"option": lp.option, "table": lp.table, "list": lp.list, "options": options, "end": crate::cmd::pos_json(&lp.end)}))
        }
    }
}

/// Pastes the last paste again with option `as` in its place, as one undo step.
fn repaste(s: &mut Session, v: &Value) -> CmdResult {
    let lp = current(s).cloned().ok_or_else(|| CmdError::Disabled("edit.repaste: nothing was just pasted".into()))?;
    let option = crate::p::req_str(v, "as")?;
    match option {
        "continueList" | "newList" if lp.list => {
            // The numbering commands' own functions, run inside this command so the choice stays one undo step.
            let id = if option == "newList" { "para.restartNumbering" } else { "para.continueNumbering" };
            let f = s.registry.get(id).map(|c| c.run).ok_or_else(|| CmdError::Unknown(id.into()))?;
            s.sel = Selection::caret(lp.start.clone());
            let r = f(s, &json!({}));
            s.sel = Selection::caret(lp.end.clone());
            r?;
            s.clip_history.last = Some(LastPaste { option: if option == "newList" { "newList" } else { "continueList" }, ..lp });
            return crate::cmd::sel_result(s);
        }
        "keepSource" | "merge" | "text" | "nest" => {}
        "rows" | "overwrite" if lp.cells.is_some() => {}
        _ => return Err(CmdError::Params(format!("edit.repaste: `{option}` is not a paste option here"))),
    }
    if let Some(c) = &lp.cells {
        return repaste_table(s, &lp, c, option);
    }
    // The first paste goes first, so the new one takes the formatting before it (Keep Text Only, Merge Formatting), not the
    // first paste's own.
    s.sel = Selection { anchor: lp.start.clone(), focus: lp.end.clone() };
    crate::cmd::delete_selection(s)?;
    match option {
        "merge" => super::paste_merge(s, &lp.data),
        "text" => super::paste_text(s, &lp.data),
        _ => super::paste(s, &lp.data),
    }?;
    // The paste functions recorded it again; keep the choices the first paste offered (a table pasted as text is still one).
    if let Some(now) = s.clip_history.last.as_mut() {
        now.table = lp.table;
        now.list = lp.list;
    }
    crate::cmd::sel_result(s)
}

/// A table pasted into a cell, again with `option`: the table goes back to how it was before the paste, then takes the paste
/// nested (nest), as plain text (text), as new rows above the caret's row (rows) or written over the cells from the caret's
/// cell on (overwrite).
fn repaste_table(s: &mut Session, lp: &LastPaste, c: &Cells, option: &str) -> CmdResult {
    let gone = || CmdError::Failed("edit.repaste: the table is gone".into());
    *s.doc.container_mut(c.story, &c.path)?.get_mut(c.path.last()).ok_or_else(gone)? = c.before.clone();
    s.sel = Selection::caret(lp.start.clone());
    let option = match option {
        "text" => {
            super::paste_text(s, &lp.data)?;
            "text"
        }
        "rows" | "overwrite" => {
            cells_paste(s, lp, c, option == "rows")?;
            if option == "rows" { "rows" } else { "overwrite" }
        }
        _ => {
            super::paste(s, &lp.data)?;
            "nest"
        }
    };
    // The paste functions recorded it again from the table as it is now: keep the table from before the first paste.
    let text = table_text(s, c).ok_or_else(gone)?;
    s.clip_history.last = Some(LastPaste { end: s.sel.focus.clone(), option, text, cells: Some(c.clone()), ..lp.clone() });
    crate::cmd::sel_result(s)
}

/// Insert as New Rows (`rows`: the pasted table's rows above the caret's row, each cut or padded to its cells) or Overwrite
/// Cells (the pasted cells written over the cells from the caret's cell on; those past the table's edge are dropped).
// ponytail: cells are matched by their index in the row, not by grid column, so merged cells in either table shift what
// lands where; walk the grid (Table::grid_col) if that shows.
fn cells_paste(s: &mut Session, lp: &LastPaste, c: &Cells, rows: bool) -> Result<(), CmdError> {
    if s.doc.settings.track_changes {
        return Err(CmdError::Disabled("with Track Changes on, paste a table into cells with Nest Table or Keep Text Only".into()));
    }
    let frag = crate::cmd::paste::paste_fragment(s, &lp.data)?;
    let src: Table = match frag.blocks.iter().find_map(|b| b.as_table()) {
        Some(t) if frag.parts.is_empty() => t.clone(),
        _ => return Err(CmdError::Failed("edit.repaste: the paste holds no table to put in cells".into())),
    };
    let (tp, r, col) = s.doc.cell_of(lp.start.story, &lp.start.path).ok_or_else(|| CmdError::Failed("edit.repaste: the paste was not in a table".into()))?;
    crate::cmd::controls::prepare_edit(s)?;
    let t = s.doc.table_mut(c.story, &tp)?;
    for (i, row) in src.rows.iter().enumerate() {
        if rows {
            // Like the caret's row, which the rows inserted so far moved down to r + i; none past the row limit.
            let n = t.rows.len();
            t.insert_row(r + i, r + i);
            if t.rows.len() == n {
                break;
            }
        }
        let Some(to) = t.rows.get_mut(r + i) else { break };
        for (cell, from) in to.cells.iter_mut().skip(if rows { 0 } else { col }).zip(&row.cells) {
            cell.blocks = from.blocks.clone();
        }
    }
    crate::cmd::table::touch_cells(s, &tp)?;
    // The caret stays in its cell: below the new rows, or at the start of the first cell written over.
    let row = if rows { r + src.rows.len() } else { r };
    let mut path = tp.0.clone();
    path.extend([row as u32, col as u32, lp.start.path.last() as u32]);
    let at = Pos { story: c.story, path: Path(path), off: if rows { lp.start.off } else { 0 } };
    s.sel = Selection::caret(s.doc.clamp(&at));
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use ew_doc::StoryRef;

    use crate::Session;

    #[test]
    fn paste_options_paste_again_as_text_in_one_undo_step_and_end_with_typing() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("document.setText", &json!({"text": "Start "})).unwrap();
        s.run("caret.docEnd", &json!({})).unwrap();
        let html = "<p><b>Bold</b> words</p>";
        s.run("edit.paste", &json!({"html": html, "text": "Bold words"})).unwrap();
        let st = s.registry.get("edit.pasteOptions").unwrap().state.unwrap()(&s);
        assert_eq!(st.0, json!(true));
        assert_eq!(st.1["option"], "keepSource");
        let bold_before = s.doc.para_at(&ew_doc::Pos::body(0, 7)).map(|p| p.props_of_char(7).bold);
        assert_eq!(bold_before, Some(Some(true)));
        s.run("edit.repaste", &json!({"as": "text"})).unwrap();
        assert_eq!(s.doc.plain_text(StoryRef::Body).trim_end(), "Start Bold words");
        let bold_after = s.doc.para_at(&ew_doc::Pos::body(0, 7)).map(|p| p.props_of_char(7).bold.unwrap_or(false));
        assert_eq!(bold_after, Some(false));
        assert_eq!(s.registry.get("edit.pasteOptions").unwrap().state.unwrap()(&s).1["option"], "text");
        // One undo takes the paste again away, a second the first paste.
        s.run("edit.undo", &json!({})).unwrap();
        assert_eq!(s.doc.para_at(&ew_doc::Pos::body(0, 7)).map(|p| p.props_of_char(7).bold), Some(Some(true)));
        // The caret and the text are as after the repaste, but the formatting is the first paste's: the button goes.
        assert_eq!(s.registry.get("edit.pasteOptions").unwrap().state.unwrap()(&s).0, json!(false));
        s.run("caret.docEnd", &json!({})).unwrap();
        s.run("text.insert", &json!({"text": "x"})).unwrap();
        assert!(s.run("edit.repaste", &json!({"as": "merge"})).is_err());
        assert_eq!(s.registry.get("edit.pasteOptions").unwrap().state.unwrap()(&s).0, json!(false));
    }

    /// The cells' texts of the table at `tp`, row by row.
    fn texts(s: &Session, tp: &ew_doc::Path) -> Vec<Vec<String>> {
        let t = s.doc.table(StoryRef::Body, tp).unwrap();
        t.rows.iter().map(|r| r.cells.iter().map(crate::cmd::table::cell_text).collect()).collect()
    }

    #[test]
    fn a_table_pasted_into_a_cell_nests_then_goes_in_as_new_rows_or_over_the_cells() {
        let mut s = Session::new(ew_doc::Document::from_text("before"));
        s.run("caret.docEnd", &json!({})).unwrap();
        s.run("insert.table", &json!({"rows": 2, "cols": 2})).unwrap();
        let (tp, _, _) = s.sel.focus.path.step().unwrap();
        s.run("text.insert", &json!({"text": "x"})).unwrap();
        let first = texts(&s, &tp);
        let html = "<table><tr><td>A</td><td>B</td></tr></table>";
        s.run("edit.paste", &json!({"html": html, "text": "A\tB"})).unwrap();
        let st = s.registry.get("edit.pasteOptions").unwrap().state.unwrap()(&s).1;
        assert_eq!(st["option"], "nest");
        assert_eq!(st["options"], json!(["nest", "rows", "overwrite", "text"]));
        assert_eq!(texts(&s, &tp).len(), 2, "nested: the outer table keeps its rows");
        s.run("edit.repaste", &json!({"as": "rows"})).unwrap();
        assert_eq!(texts(&s, &tp), vec![vec!["A".to_string(), "B".into()], first[0].clone(), first[1].clone()]);
        assert_eq!(s.registry.get("edit.pasteOptions").unwrap().state.unwrap()(&s).1["option"], "rows");
        s.run("edit.repaste", &json!({"as": "overwrite"})).unwrap();
        assert_eq!(texts(&s, &tp), vec![vec!["A".to_string(), "B".into()], first[1].clone()]);
        s.run("edit.repaste", &json!({"as": "text"})).unwrap();
        assert_eq!(texts(&s, &tp)[0][0], "xA\tB");
        // One undo takes the last choice away and leaves the overwrite.
        s.run("edit.undo", &json!({})).unwrap();
        assert_eq!(texts(&s, &tp), vec![vec!["A".to_string(), "B".into()], first[1].clone()]);
    }
}
