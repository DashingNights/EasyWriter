//! EasyWriter engine-fixes-layout: wave D's layout loose ends (docs/plans/word/briefs/engine-fixes-layout.md).
use crate::*;
use ew_doc::props::{Border, Borders, HeightRule, TabAlign, TabLeader, TabStop};
use ew_doc::{Paragraph, Pos, Table, para_block};

fn lay(d: &Document) -> DocLayout {
    layout(d, &mut LayoutCache::new(), &LayoutOptions::default())
}

/// "label x\t" and `after`, with one stop and a right indent, in compatibility mode `mode`, on a Letter page (a 468 pt column
/// from x 72) → where the first `word` characters after the tab start and end, from the column's left edge, whether the
/// paragraph's end is on the tab's line, and how far right that line's text runs.
pub(super) fn after_tab(mode: u32, (pos, align): (f32, TabAlign), indent_right: f32, after: &str, word: usize) -> (f32, f32, bool, f32) {
    let text = format!("label x\t{after}");
    let mut d = Document::from_text(&text);
    d.settings.compat_mode = mode;
    d.format_paragraphs(&Pos::body(0, 0), &Pos::body(0, 0), &|p| {
        p.tabs = Some(vec![TabStop { pos, align, leader: TabLeader::None }]);
        p.indent_right = Some(indent_right);
    })
    .unwrap();
    let l = lay(&d);
    let at = |off: usize| l.caret(&Pos::body(0, off)).unwrap();
    let (tab, start, end) = (at(7), at(8), at(8 + word));
    let right = (8..=text.len()).map(at).filter(|c| (c.top - tab.top).abs() < 0.5).map(|c| c.x).fold(0.0, f32::max);
    (start.x - 72.0, end.x - 72.0, (at(text.len()).top - tab.top).abs() < 0.5, right - 72.0)
}

/// Probe efl_tabs_docx.py (Word 2013's layout, compatibility mode 15): a right, centre or decimal stop past the right indent
/// but short of the column's edge is kept, and its line runs into the margin up to that edge (Word's R, S, T and L, a 400 pt
/// stop under a 144 pt right indent); one at or past the edge right-aligns on the right indent (W: a 487 pt stop under the
/// same indent ends its text on the indent, 307.2 of 307.3 pt). The engine put the first ones on the indent too.
#[test]
fn word_2013_keeps_a_stop_between_the_right_indent_and_the_column_edge() {
    let (_, end, one, _) = after_tab(15, (400.0, TabAlign::Right), 144.0, "ENDR", 4);
    assert!((end - 400.0).abs() < 0.5 && one, "a right stop at 400 pt ends its text there: {end}");
    let (start, end, ..) = after_tab(15, (400.0, TabAlign::Center), 144.0, "MIDS", 4);
    assert!(((start + end) / 2.0 - 400.0).abs() < 0.5, "a centre stop centres on 400 pt: {start} to {end}");
    let (_, point, ..) = after_tab(15, (400.0, TabAlign::Decimal), 144.0, "7.25", 1);
    assert!((point - 400.0).abs() < 0.5, "a decimal stop puts the point on 400 pt: {point}");
    let (_, end, one, _) = after_tab(15, (487.0, TabAlign::Right), 144.0, "ENDW", 4);
    assert!((end - 324.0).abs() < 0.5 && one, "a stop past the column's edge right-aligns on the indent: {end}");
    // Word's L: the words after the stop run on to the column's edge (m9 ends 438.9 of 451.3 pt), not the indent.
    let words: String = (0..30).map(|i| format!(" m{i}")).collect();
    let (.., one, right) = after_tab(15, (400.0, TabAlign::Right), 144.0, &format!("ENDL{words}"), 4);
    assert!(!one && right > 400.0 && right <= 468.0, "the line runs past the indent to the column's edge: {right}");
}

/// Probe efl_tabs_docx.py (Word 2010's layout, compatibility mode 14): every stop of the paragraph's own is honoured where it
/// is, past the right indent or margin (B: a right stop at 487 pt on a 451.3 pt column ends its text at 486.7; C, D: a centre
/// and a decimal stop past the margin; W: a right stop at 487 pt under a 144 pt right indent; G: a left stop at 440 pt under
/// the same indent), and the line then runs on unbroken (G, K and L: the words after the tab run off the page on one line).
/// The engine took Word 2013's rule (a right stop on the indent) or wrapped the left stop.
#[test]
fn word_2010_honours_stops_past_the_right_indent() {
    let (_, end, one, _) = after_tab(14, (487.0, TabAlign::Right), 0.0, "ENDB", 4);
    assert!((end - 487.0).abs() < 0.5 && one, "a right stop past the margin ends its text there: {end}");
    let (start, end, ..) = after_tab(14, (470.0, TabAlign::Center), 0.0, "MIDC", 4);
    assert!(((start + end) / 2.0 - 470.0).abs() < 0.5, "a centre stop centres on 470 pt: {start} to {end}");
    let (_, point, ..) = after_tab(14, (480.0, TabAlign::Decimal), 0.0, "12.50", 2);
    assert!((point - 480.0).abs() < 0.5, "a decimal stop puts the point on 480 pt: {point}");
    let (_, end, one, _) = after_tab(14, (487.0, TabAlign::Right), 144.0, "ENDW", 4);
    assert!((end - 487.0).abs() < 0.5 && one, "past the right indent too: {end}");
    let words: String = (0..10).map(|i| format!(" w{i}")).collect();
    let (start, _, one, _) = after_tab(14, (440.0, TabAlign::Left), 144.0, &format!("afterG{words}"), 6);
    assert!((start - 440.0).abs() < 0.5 && one, "a left stop past the indent keeps its text on its line: {start}");
    let words: String = (0..30).map(|i| format!(" k{i}")).collect();
    let (.., one, right) = after_tab(14, (487.0, TabAlign::Right), 0.0, &format!("ENDK{words}"), 4);
    assert!(one, "the words after a right stop past the margin stay on its line, running to {right}");
}

/// A table at the top of the document whose first row (at least `height` tall, two lines of text in its cell) has a 6 pt
/// border under it, and a second row.
fn bordered_rows(height: f32) -> DocLayout {
    let mut d = Document::from_text("after");
    let mut t = Table::new(2, 1, 468.0);
    t.rows[0].props.height = Some(height);
    t.rows[0].props.height_rule = HeightRule::AtLeast;
    let cell = &mut t.rows[0].cells[0];
    cell.blocks = vec![para_block(Paragraph::with_text("one", Default::default())), para_block(Paragraph::with_text("two", Default::default()))];
    cell.props.borders = Some(Borders { bottom: Some(Border::single(6.0)), ..Default::default() });
    d.insert_block(StoryRef::Body, &Path::top(0), Block::Table(t)).unwrap();
    lay(&d)
}

/// A row that fits on an empty page and only its bottom border does not is placed whole, as Word places it: the split that
/// keeps the first lines of a row nothing of which fits (Word 320 to 322) took its first line alone.
#[test]
fn a_row_that_fits_but_for_its_bottom_border_is_placed_whole() {
    // The body is 648 pt tall: a row 645 pt tall fits, with its 6 pt border under it it does not.
    let l = bordered_rows(645.0);
    let page = |cell: u32, block: u32| l.caret(&Pos { story: StoryRef::Body, path: Path(vec![0, 0, cell, block]), off: 0 }).unwrap().page;
    assert_eq!((page(0, 0), page(0, 1)), (0, 0), "both lines of the row on the first page");
    let next = l.caret(&Pos { story: StoryRef::Body, path: Path(vec![0, 1, 0, 0]), off: 0 }).unwrap();
    assert_eq!(next.page, 1, "the next row starts the second page");
}

/// Keep with next before a table measures its first row as the table lays it out: a table style's run formatting (40 pt
/// text) makes the first line too tall for the room under the label, so the label goes over with the table. The engine
/// measured the row's first paragraph alone, in its own style at a width of the table's divided by its cells.
#[test]
fn keep_with_next_before_a_table_measures_the_row_as_laid_out() {
    use ew_doc::props::CharProps;
    use ew_doc::styles::{Style, StyleKind};
    let lines: Vec<String> = (0..24).map(|i| format!("filler {i}")).chain(["label".into(), "after".into()]).collect();
    let mut d = Document::from_text(&lines.join("\n"));
    d.format_paragraphs(&Pos::body(24, 0), &Pos::body(24, 0), &|p| p.keep_next = Some(true)).unwrap();
    d.styles_mut().upsert(Style {
        id: "Big".into(),
        name: "Big".into(),
        kind: StyleKind::Table,
        chr: CharProps { size: Some(40.0), ..Default::default() },
        ..Default::default()
    });
    let mut t = Table::new(1, 3, 468.0);
    t.props.style = Some("Big".into());
    d.insert_block(StoryRef::Body, &Path::top(25), Block::Table(t)).unwrap();
    let l = lay(&d);
    let label = l.caret(&Pos::body(24, 0)).unwrap();
    let row = l.caret(&Pos { story: StoryRef::Body, path: Path(vec![25, 0, 0, 0]), off: 0 }).unwrap();
    assert_eq!(label.page, row.page, "the label goes with the table's first row: label {label:?}, row {row:?}");
}

/// A deleted table's row memo goes with it (engine-edit-cost kept it until the styles or options changed), so pasting and
/// deleting tables in a typing session does not grow the cache.
#[test]
fn a_deleted_table_takes_its_row_memo_with_it() {
    let mut d = Document::from_text("before\nafter");
    d.insert_block(StoryRef::Body, &Path::top(1), Block::Table(Table::new(4, 3, 468.0))).unwrap();
    ew_doc::Ids::fill(&mut d);
    let (opts, mut cache) = (LayoutOptions::default(), LayoutCache::new());
    let l = layout(&d, &mut cache, &opts);
    assert_eq!(cache.tables.len(), 1, "the table's rows are kept");
    d.remove_block(StoryRef::Body, &Path::top(1)).unwrap();
    let (l, _) = relayout(&d, &mut cache, &opts, l);
    assert_eq!(cache.tables.len(), 0, "the deleted table's rows went with it");
    // A whole layout of the document without it lets go of them too.
    d.insert_block(StoryRef::Body, &Path::top(1), Block::Table(Table::new(2, 2, 468.0))).unwrap();
    let _ = relayout(&d, &mut cache, &opts, l);
    d.remove_block(StoryRef::Body, &Path::top(1)).unwrap();
    let _ = layout(&d, &mut cache, &opts);
    assert_eq!(cache.tables.len(), 0, "and when the document is laid out whole");
}

/// The table laid out ahead for a kept paragraph leaves the walk as it found it: a numbered list running through the table's
/// cells and on after it numbers the same whether the paragraph before the table is kept with it or not.
#[test]
fn measuring_a_table_ahead_leaves_the_list_numbers_alone() {
    use ew_doc::props::NumRef;
    let labels = |kept: bool| {
        let mut d = Document::from_text("label\nafter one\nafter two");
        let id = d.numbering_mut().add_list(ew_doc::ListKind::Numbered);
        let num = Some(NumRef { num: id, level: 0 });
        d.format_paragraphs(&Pos::body(0, 0), &Pos::body(0, 0), &|p| p.keep_next = Some(kept)).unwrap();
        d.format_paragraphs(&Pos::body(1, 0), &Pos::body(2, 1), &|p| p.numbering = num).unwrap();
        let mut t = Table::new(2, 2, 468.0);
        for row in &mut t.rows {
            for cell in &mut row.cells {
                let mut p = Paragraph::with_text("in a cell", Default::default());
                p.props.numbering = num;
                cell.blocks = vec![para_block(p)];
            }
        }
        d.insert_block(StoryRef::Body, &Path::top(1), Block::Table(t)).unwrap();
        let l = lay(&d);
        let labelled = l.pages.iter().flat_map(|p| &p.items).filter_map(|it| match it {
            Placed::Lines { para, path, .. } => para.label.as_ref().map(|x| (path.0.clone(), x.text.clone())),
            _ => None,
        });
        labelled.collect::<Vec<_>>()
    };
    let plain = labels(false);
    assert_eq!(plain.len(), 6, "four cells and two paragraphs after the table: {plain:?}");
    assert_eq!(labels(true), plain);
}

/// The memo of a table that stays is kept when another table is deleted: an edit in it takes its other rows over.
#[test]
fn deleting_a_table_keeps_the_other_tables_row_memo() {
    let mut d = Document::from_text("before\nbetween\nafter");
    d.insert_block(StoryRef::Body, &Path::top(1), Block::Table(Table::new(4, 3, 468.0))).unwrap();
    d.insert_block(StoryRef::Body, &Path::top(3), Block::Table(Table::new(4, 3, 468.0))).unwrap();
    ew_doc::Ids::fill(&mut d);
    let (opts, mut cache) = (LayoutOptions::default(), LayoutCache::new());
    let l = layout(&d, &mut cache, &opts);
    assert_eq!(cache.tables.len(), 2);
    d.remove_block(StoryRef::Body, &Path::top(1)).unwrap();
    let (l, _) = relayout(&d, &mut cache, &opts, l);
    assert_eq!(cache.tables.len(), 1, "the other table's rows stay");
    let kept = cache.rows_kept;
    d.insert_text(&Pos { story: StoryRef::Body, path: Path(vec![2, 0, 0, 0]), off: 0 }, "x", &Default::default()).unwrap();
    let _ = relayout(&d, &mut cache, &opts, l);
    assert!(cache.rows_kept >= kept + 3, "an edit in its first row takes the other three over: {}", cache.rows_kept - kept);
}
