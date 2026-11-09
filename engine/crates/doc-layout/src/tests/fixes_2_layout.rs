//! EasyWriter engine-fixes-2-layout: wave E's layout loose ends (docs/plans/word/briefs/engine-fixes-2-layout.md).
use crate::*;
use ew_doc::props::{NumRef, VMerge};
use ew_doc::{Paragraph, Pos, Table, para_block};

/// "label" (kept with the next paragraph when `kept`), a table of 30 rows of two numbered cells (rows the row memo never
/// takes over), the first `headers` of them repeated header rows, and "after".
fn kept_before_table(kept: bool, headers: usize) -> Document {
    let mut d = Document::from_text("label\nafter");
    let id = d.numbering_mut().add_list(ew_doc::ListKind::Numbered);
    d.format_paragraphs(&Pos::body(0, 0), &Pos::body(0, 0), &|p| p.keep_next = Some(kept)).unwrap();
    let mut t = Table::new(30, 2, 468.0);
    for (i, row) in t.rows.iter_mut().enumerate() {
        row.props.header = i < headers;
        for cell in &mut row.cells {
            let mut p = Paragraph::with_text("in a cell", Default::default());
            p.props.numbering = Some(NumRef { num: id, level: 0 });
            cell.blocks = vec![para_block(p)];
        }
    }
    d.insert_block(StoryRef::Body, &Path::top(1), Block::Table(t)).unwrap();
    d
}

/// Keep with next before a table reads the table's header rows and the row after them, so only those are laid out ahead of
/// it: the label's table is laid out once more by three rows, not by all 30. The engine laid the whole table out ahead,
/// and rows with list numbers, fields, nested tables or merged cells, which the row memo does not keep, twice per pass.
#[test]
fn keep_with_next_before_a_table_lays_out_only_the_rows_it_reads() {
    let laid = |kept: bool| {
        let mut cache = LayoutCache::new();
        let l = layout(&kept_before_table(kept, 2), &mut cache, &LayoutOptions::default());
        let label = l.caret(&Pos::body(0, 0)).unwrap().page;
        let row = l.caret(&Pos { story: StoryRef::Body, path: Path(vec![1, 2, 0, 0]), off: 0 }).unwrap().page;
        (cache.rows_laid, (label, row))
    };
    let (plain, kept) = (laid(false), laid(true));
    assert_eq!(plain.0, 30, "each row once without the keep");
    assert_eq!(kept.0 - plain.0, 3, "rows laid out ahead for the label: {}", kept.0 - plain.0);
    assert_eq!(kept.1, plain.1, "and the label and the first row land as they did");
}

/// 24 lines, "label" kept with the table after it, and a table whose first row starts a cell merged down over all four
/// rows (holding `merged` lines), the other cell one line in each row, every row kept from splitting. The page and where
/// the label and the first row are.
fn merged_first_row(merged: usize) -> (u32, u32) {
    let lines: Vec<String> = (0..24).map(|i| format!("filler {i}")).chain(["label".into(), "after".into()]).collect();
    let mut d = Document::from_text(&lines.join("\n"));
    d.format_paragraphs(&Pos::body(24, 0), &Pos::body(24, 0), &|p| p.keep_next = Some(true)).unwrap();
    let mut t = Table::new(4, 2, 468.0);
    for (i, row) in t.rows.iter_mut().enumerate() {
        row.props.cant_split = true;
        row.cells[0].props.vmerge = if i == 0 { VMerge::Restart } else { VMerge::Continue };
        row.cells[1].blocks = vec![para_block(Paragraph::with_text(&format!("row {i}"), Default::default()))];
    }
    t.rows[0].cells[0].blocks = (0..merged).map(|i| para_block(Paragraph::with_text(&format!("merged {i}"), Default::default()))).collect();
    d.insert_block(StoryRef::Body, &Path::top(25), Block::Table(t)).unwrap();
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let label = l.caret(&Pos::body(24, 0)).unwrap().page;
    let row = l.caret(&Pos { story: StoryRef::Body, path: Path(vec![25, 0, 1, 0]), off: 0 }).unwrap().page;
    (label as u32, row as u32)
}

/// A cell merged down from the first row grows the merge's last row, not the first: laying out only the first row ahead
/// must not make it as tall as the merged cell. The label and the first row stay on the first page with a one-line merged
/// cell and with a six-line one.
#[test]
fn a_merge_running_on_past_the_first_row_does_not_grow_it_ahead() {
    assert_eq!(merged_first_row(1), (0, 0), "a one-line merged cell");
    assert_eq!(merged_first_row(6), (0, 0), "a six-line merged cell grows the last row of the merge");
}

/// Probe ef2_tabs_modes_docx.py (.smoke-data/word/fixture/walk): Word lays efl_tabs_docx.py's 22 tab lines out with every
/// character at the same place in compatibility modes 11, 12 and 14 and in a file with no compatibilityMode (which the
/// reader opens as mode 12, `LEGACY_COMPAT_MODE`), and differently in 15; a file in mode 13 it refuses as corrupt. So Word
/// 2010's rule, a stop past the right indent or the margin honoured where it is and its line run on, holds in each mode
/// below 15, as word_2010_honours_stops_past_the_right_indent checks for 14.
#[test]
fn modes_11_and_12_and_no_mode_honour_stops_past_the_right_indent_as_word_2010_does() {
    use super::fixes_layout::after_tab;
    use ew_doc::props::TabAlign;
    for mode in [11, 12, ew_doc::LEGACY_COMPAT_MODE] {
        let (_, end, one, _) = after_tab(mode, (487.0, TabAlign::Right), 0.0, "ENDB", 4);
        assert!((end - 487.0).abs() < 0.5 && one, "mode {mode}: a right stop past the margin ends its text there: {end}");
        let (_, end, one, _) = after_tab(mode, (487.0, TabAlign::Right), 144.0, "ENDW", 4);
        assert!((end - 487.0).abs() < 0.5 && one, "mode {mode}: past the right indent too: {end}");
        let words: String = (0..10).map(|i| format!(" w{i}")).collect();
        let (start, _, one, _) = after_tab(mode, (440.0, TabAlign::Left), 144.0, &format!("afterG{words}"), 6);
        assert!((start - 440.0).abs() < 0.5 && one, "mode {mode}: a left stop past the indent keeps its text on its line: {start}");
    }
}
