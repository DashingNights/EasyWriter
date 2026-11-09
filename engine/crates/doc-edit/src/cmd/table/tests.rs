use super::*;

/// A 3 by 3 table after a paragraph, its cells holding "r,c", the caret in the middle cell.
fn table() -> (Session, Path) {
    let mut s = Session::new(Document::from_text("before"));
    s.run("caret.docEnd", &json!({})).unwrap();
    s.run("insert.table", &json!({"rows": 3, "cols": 3})).unwrap();
    let (tp, _, _) = s.sel.focus.path.step().unwrap();
    for r in 0..3 {
        for c in 0..3 {
            put(&mut s, &tp, r, c);
            s.run("text.insert", &json!({"text": format!("{r},{c}")})).unwrap();
        }
    }
    put(&mut s, &tp, 1, 1);
    (s, tp)
}

fn put(s: &mut Session, tp: &Path, r: u32, c: u32) {
    let mut path = tp.0.clone();
    path.extend([r, c, 0]);
    s.sel = Selection::caret(Pos { story: StoryRef::Body, path: Path(path), off: 0 });
}

fn state(s: &Session, id: &str) -> (Value, Value) {
    (s.registry.get(id).and_then(|x| x.state).expect("a state reader"))(s)
}

/// The caret cell's (row, cell).
fn at(s: &Session) -> (usize, usize) {
    let (_, r, c) = s.sel.focus.path.step().unwrap();
    (r, c)
}

#[test]
fn table_get_reads_every_row_and_the_caret() {
    let (mut s, _) = table();
    let rev = s.doc.clone();
    let v = s.run("table.get", &json!({})).unwrap();
    assert_eq!(s.doc, rev, "a read changes nothing");
    assert_eq!(v["rows"].as_array().unwrap().len(), 3);
    assert_eq!(v["rows"][2]["cells"][1]["text"], "2,1");
    assert_eq!((v["row"].as_u64(), v["cell"].as_u64()), (Some(1), Some(1)));
    assert_eq!(v["grid"].as_array().unwrap().len(), 3);
    assert_eq!(v["selection"], Value::Null);
    assert_eq!(v["nested"], false);
}

#[test]
fn table_keys_go_to_row_and_column_ends() {
    let (mut s, _) = table();
    s.run("table.moveTo", &json!({"to": "rowStart"})).unwrap();
    assert_eq!(at(&s), (1, 0));
    s.run("table.moveTo", &json!({"to": "rowEnd"})).unwrap();
    assert_eq!(at(&s), (1, 2));
    s.run("table.moveTo", &json!({"to": "columnTop"})).unwrap();
    assert_eq!(at(&s), (0, 2));
    s.run("table.moveTo", &json!({"to": "columnBottom"})).unwrap();
    assert_eq!(at(&s), (2, 2));
    // Shift extends the selection to whole cells.
    s.run("table.moveTo", &json!({"to": "rowStart", "extend": true})).unwrap();
    assert_eq!(selected_cells(&s).len(), 3, "the bottom row's three cells");
    assert!(s.run("table.moveTo", &json!({"to": "sideways"})).is_err());
}

#[test]
fn move_row_swaps_rows_and_keeps_the_caret() {
    let (mut s, tp) = table();
    s.run("table.moveRow", &json!({"dir": "up"})).unwrap();
    let t = s.doc.table(StoryRef::Body, &tp).unwrap();
    assert_eq!(cell_text(&t.rows[0].cells[0]), "1,0");
    assert_eq!(cell_text(&t.rows[1].cells[0]), "0,0");
    assert_eq!(at(&s).0, 0, "the caret goes with its row");
    assert!(s.run("table.moveRow", &json!({"dir": "up"})).is_err(), "the top row stays");
    s.run("table.moveRow", &json!({"dir": "down"})).unwrap();
    assert_eq!(cell_text(&s.doc.table(StoryRef::Body, &tp).unwrap().rows[0].cells[0]), "0,0");
}

#[test]
fn clear_direct_takes_cell_shading_away() {
    let (mut s, tp) = table();
    s.run("table.shading", &json!({"color": "FF0000"})).unwrap();
    assert_eq!(state(&s, "table.shading").1, json!("FF0000"));
    s.run("table.clearDirect", &json!({})).unwrap();
    assert!(s.doc.table(StoryRef::Body, &tp).unwrap().rows.iter().flat_map(|r| &r.cells).all(|c| c.props.shading.is_none()));
    assert_eq!(state(&s, "table.shading").1, Value::Null);
}

#[test]
fn ribbon_states_read_without_a_change() {
    let (mut s, _) = table();
    let doc = s.doc.clone();
    let header = state(&s, "table.repeatHeader").0;
    assert_eq!(s.doc, doc, "reading Repeat Header Rows does not toggle it");
    assert_eq!(header, json!(false));
    s.run("table.repeatHeader", &json!({"value": true})).unwrap();
    assert_eq!(state(&s, "table.repeatHeader").0, json!(true));

    s.run("table.look", &json!({"bandedRows": false})).unwrap();
    assert_eq!(state(&s, "table.look").1["bandedRows"], json!(false));
    s.run("table.cellAlign", &json!({"value": "bottomRight"})).unwrap();
    assert_eq!(state(&s, "table.cellAlign").1, json!("bottomRight"));
    s.run("table.cellAlign", &json!({"value": "center"})).unwrap();
    assert_eq!(state(&s, "table.cellAlign").1, json!("center"));
    s.run("table.rowHeight", &json!({"height": 30.0})).unwrap();
    assert_eq!(state(&s, "table.rowHeight").1, json!(30.0));
    s.run("table.columnWidth", &json!({"width": 100.0})).unwrap();
    assert_eq!(state(&s, "table.columnWidth").1, json!(100.0));
    s.run("table.textDirection", &json!({"value": "down"})).unwrap();
    assert_eq!(state(&s, "table.textDirection").1, json!("down"));

    // Outside a table every reader answers null.
    s.run("caret.docStart", &json!({})).unwrap();
    for id in ["table.look", "table.shading", "table.cellAlign", "table.rowHeight", "table.columnWidth", "table.style"] {
        assert_eq!(state(&s, id).1, Value::Null, "{id}");
    }
}

// engine-gaps-page tests

fn texts(s: &Session, tp: &Path) -> Vec<Vec<String>> {
    let t = s.doc.table(StoryRef::Body, tp).unwrap();
    t.rows.iter().map(|r| r.cells.iter().map(|c| cell_text(c)).collect()).collect()
}

/// Insert Cells and Delete Cells that shift (gap G54): right makes the row longer, down and up move the column's cells.
#[test]
fn cells_shift() {
    let (mut s, tp) = table();
    s.run("table.insertCells", &json!({"shift": "right"})).unwrap();
    assert_eq!(texts(&s, &tp)[1], vec!["1,0", "", "1,1", "1,2"]);
    assert_eq!(s.doc.table(StoryRef::Body, &tp).unwrap().rows[0].props.grid_after, 1, "the other rows end before the new column");
    let (mut s, tp) = table();
    s.run("table.insertCells", &json!({"shift": "down"})).unwrap();
    let t = texts(&s, &tp);
    assert_eq!(t.len(), 4, "a row at the bottom takes what is pushed off");
    assert_eq!(t.iter().map(|r| r[1].clone()).collect::<Vec<_>>(), vec!["0,1", "", "1,1", "2,1"]);
    assert_eq!(t[1][0], "1,0", "the other columns stay");
    let (mut s, tp) = table();
    s.run("table.deleteCells", &json!({"shift": "up"})).unwrap();
    let t = texts(&s, &tp);
    assert_eq!(t.iter().map(|r| r[1].clone()).collect::<Vec<_>>(), vec!["0,1", "2,1", ""]);
    assert_eq!(t.len(), 3);
    let (mut s, _) = table();
    s.run("table.merge", &json!({})).ok();
    s.run("table.selectRow", &json!({})).unwrap();
    s.run("table.merge", &json!({})).unwrap();
    assert!(s.run("table.insertCells", &json!({"shift": "down"})).is_err(), "not with merged cells");
}

/// Ctrl+Enter in a table cell splits the table above the caret's row with a page break between, as Word does; in the first
/// row the break goes before the table.
#[test]
fn page_break_in_a_cell_splits_the_table() {
    let (mut s, tp) = table();
    s.run("text.pageBreak", &json!({})).unwrap();
    let i = tp.last();
    assert!(matches!(&*s.doc.body[i], Block::Table(t) if t.rows.len() == 1));
    assert_eq!(s.doc.body[i + 1].as_para().map(|p| p.text.clone()), Some("\u{000C}".into()));
    assert!(matches!(&*s.doc.body[i + 2], Block::Table(t) if t.rows.len() == 2));
    assert_eq!(s.sel.focus.path.step().map(|(t, r, c)| (t.last(), r, c)), Some((i + 2, 0, 1)), "the caret stays in its cell");
    let (mut s, tp) = table();
    put(&mut s, &tp, 0, 0);
    s.run("text.pageBreak", &json!({})).unwrap();
    assert_eq!(s.doc.body[tp.last()].as_para().map(|p| p.text.clone()), Some("\u{000C}".into()));
    assert!(matches!(&*s.doc.body[tp.last() + 1], Block::Table(t) if t.rows.len() == 3));
    // Not while Track Changes is on, where the split would go untracked.
    let (mut s, tp) = table();
    s.doc.settings.track_changes = true;
    assert!(s.run("text.pageBreak", &json!({})).is_err());
    assert!(matches!(&*s.doc.body[tp.last()], Block::Table(t) if t.rows.len() == 3), "the table stays whole");
}

/// Table Properties' rows and columns by index and the Cell tab on the selected cells (gap G31).
#[test]
fn properties_rows_columns_and_cells() {
    let (mut s, tp) = table();
    s.run("table.properties", &json!({"rows": [{"index": 2, "height": 30.0, "heightRule": "exact", "allowBreak": false}], "columns": [{"index": 0, "width": 50.0}],
        "valign": "bottom", "noWrap": true, "cellMargins": {"top": 2.0, "left": 3.0, "bottom": 4.0, "right": 5.0}})).unwrap();
    let t = s.doc.table(StoryRef::Body, &tp).unwrap();
    assert_eq!((t.rows[2].props.height, t.rows[2].props.height_rule, t.rows[2].props.cant_split), (Some(30.0), HeightRule::Exact, true));
    assert_eq!(t.grid[0], 50.0);
    let c = &t.rows[1].cells[1].props;
    assert_eq!((c.valign, c.no_wrap, c.margins), (Some(VAlign::Bottom), true, Some([2.0, 3.0, 4.0, 5.0])));
}

/// Modify Table Style on a gallery style the document lacks adds it under that id first, as Word adds a built-in style;
/// table.style with its definition does the same for the gallery.
#[test]
fn modify_adds_a_missing_built_in_style() {
    let (mut s, _) = table();
    assert!(s.doc.styles.get("GridTable4-Accent1").is_none());
    s.run("table.modifyStyle", &json!({"style": "GridTable4-Accent1", "name": "Grid Table 4 Accent 1", "wholeTable": {"fill": "DDEEFF"}})).unwrap();
    let st = s.doc.styles.get("GridTable4-Accent1").expect("added");
    assert_eq!(st.name, "Grid Table 4 Accent 1");
    s.run("table.style", &json!({"style": "ListTable3", "define": {"name": "List Table 3", "headerRow": {"bold": true}}})).unwrap();
    assert_eq!(state(&s, "table.style").1, json!("ListTable3"));
    assert!(s.run("table.style", &json!({"style": "Nope"})).is_err(), "without a definition a missing style is refused");
}
