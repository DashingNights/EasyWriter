//! EasyWriter engine-fidelity-5: the Word fixture's pages and the tab rules this package measured (docs/plans/engine/fidelity.md).
use crate::*;
use ew_doc::props::{HeightRule, TabAlign, TabLeader, TabStop, TextDirection};
use ew_doc::{Paragraph, Pos, Table, para_block};

fn lay(d: &Document) -> DocLayout {
    layout(d, &mut LayoutCache::new(), &LayoutOptions::default())
}

/// One paragraph of `text` with `stops` and a right indent, laid out on a Letter page (a 468 pt column from x 72).
fn tabbed(text: &str, stops: &[(f32, TabAlign)], indent_right: f32) -> DocLayout {
    let mut d = Document::from_text(text);
    let tabs: Vec<TabStop> = stops.iter().map(|&(pos, align)| TabStop { pos, align, leader: TabLeader::None }).collect();
    d.format_paragraphs(&Pos::body(0, 0), &Pos::body(0, 0), &|p| {
        p.tabs = Some(tabs.clone());
        p.indent_right = Some(indent_right);
    })
    .unwrap();
    lay(&d)
}

/// Word 2013 and later (probe tabs_docx.py, the tabs-pages case): a right stop past the margin right-aligns its text on the
/// margin on the same line, where the engine ran it to the stop.
#[test]
fn a_right_stop_past_the_margin_right_aligns_on_the_margin() {
    let text = "Left text\tinto the margin";
    let l = tabbed(text, &[(487.0, TabAlign::Right)], 0.0);
    let (start, end) = (l.caret(&Pos::body(0, 0)).unwrap(), l.caret(&Pos::body(0, text.len())).unwrap());
    assert!((end.x - 540.0).abs() < 0.5, "the text ends on the margin: {}", end.x);
    assert!((end.top - start.top).abs() < 0.5, "on the tab's line");
}

/// A left stop past the right indent and short of the column's edge is honoured on its line, which runs into the margin;
/// one at or past the edge still wraps (`left_tab_past_the_right_indent_does_not_add_a_line`).
#[test]
fn a_left_stop_past_the_right_indent_short_of_the_edge_stays_on_its_line() {
    let text = "indentpast\tafterind";
    let l = tabbed(text, &[(360.0, TabAlign::Left)], 144.0);
    let (start, after) = (l.caret(&Pos::body(0, 0)).unwrap(), l.caret(&Pos::body(0, 11)).unwrap());
    assert!((after.x - 432.0).abs() < 0.5, "the text after the tab starts on the stop: {}", after.x);
    assert!((after.top - start.top).abs() < 0.5, "on the first line");
}

/// A decimal stop aligns on the first point, or after the number when there is none (Word: "12345 (no point)" ends its
/// number on the stop, "0.125 and 7.5" puts its first point there), where the engine aligned the text's end.
#[test]
fn a_decimal_stop_aligns_on_the_first_point_or_after_the_number() {
    let at = |text: &str, sub: &str| {
        let l = tabbed(text, &[(216.0, TabAlign::Decimal)], 0.0);
        l.caret(&Pos::body(0, text.find(sub).unwrap())).unwrap().x - 72.0
    };
    assert!((at("\t12345 (no point)", " (no") - 216.0).abs() < 0.5, "the number ends on the stop: {}", at("\t12345 (no point)", " (no"));
    assert!((at("\t0.125 and 7.5", ".125") - 216.0).abs() < 0.5, "the first point is on the stop: {}", at("\t0.125 and 7.5", ".125"));
    assert!((at("\t1,234.5", ".5") - 216.0).abs() < 0.5, "a thousands separator is part of the number: {}", at("\t1,234.5", ".5"));
    let l = tabbed("	text only", &[(216.0, TabAlign::Decimal)], 0.0);
    let end = l.caret(&Pos::body(0, "	text only".len())).unwrap().x - 72.0;
    assert!((end - 216.0).abs() < 0.5, "text without a number ends on the stop: {end}");
}

/// A table of `rows` one-cell-text rows after a "before" paragraph, its cells holding `text`.
fn table_doc(rows: usize, text: &str) -> (Document, Table) {
    let d = Document::from_text("before\nafter");
    let mut t = Table::new(rows, 3, 468.0);
    for (r, row) in t.rows.iter_mut().enumerate() {
        for (c, cell) in row.cells.iter_mut().enumerate() {
            let s = if r == 0 && c == 0 { text.to_string() } else { format!("{}{}", ["A", "B", "C"][c], r + 1) };
            cell.blocks = vec![para_block(Paragraph::with_text(&s, Default::default()))];
        }
    }
    (d, t)
}

fn cell_top(l: &DocLayout, row: u32) -> f32 {
    l.caret(&Pos { story: StoryRef::Body, path: Path(vec![1, row, 0, 0]), off: 0 }).unwrap().top
}

/// Word 285: a row exactly 1 pt tall puts the next row 1 pt under it, where a 4 pt floor held.
#[test]
fn an_exact_row_height_has_no_floor() {
    let (mut d, mut t) = table_doc(3, "A1");
    t.rows[1].props.height = Some(1.0);
    t.rows[1].props.height_rule = HeightRule::Exact;
    d.insert_block(StoryRef::Body, &Path::top(1), Block::Table(t)).unwrap();
    let l = lay(&d);
    let gap = cell_top(&l, 2) - cell_top(&l, 1);
    assert!((gap - 1.0).abs() < 0.6, "row 2 is 1 pt tall: {gap}");
}

/// Word 296: in a row at least 3 in tall, turned cell text wraps at 3 in where the row grew to its unwrapped length.
#[test]
fn turned_text_wraps_at_an_at_least_row_height() {
    let (mut d, mut t) = table_doc(1, "plain");
    t.rows[0].cells[1].blocks = vec![para_block(Paragraph::with_text(&"turned cell text ".repeat(8), Default::default()))];
    t.rows[0].cells[1].props.text_direction = TextDirection::Down;
    t.rows[0].props.height = Some(216.0);
    t.rows[0].props.height_rule = HeightRule::AtLeast;
    d.insert_block(StoryRef::Body, &Path::top(1), Block::Table(t)).unwrap();
    let l = lay(&d);
    let turned = l.pages[0].items.iter().find(|it| matches!(it, Placed::Lines { path, .. } if path.0 == [1, 0, 1, 0])).unwrap();
    let b = turned.turned_bounds().unwrap();
    assert!(b.h <= 216.5, "the lines are no longer than the row's set height: {b:?}");
    let after = l.caret(&Pos::body(2, 0)).unwrap();
    assert!(after.top < cell_top(&l, 0) + 240.0, "the row keeps its 3 in: the next paragraph at {}", after.top);
}

/// Word 320 to 322: under a 22 in bottom cell margin nothing of a row fits on a page, so each page holds the next line of
/// each cell, whatever widow control asks; the row ran off one page whole.
#[test]
fn a_row_nothing_of_which_fits_on_a_page_goes_on_a_line_a_page() {
    let (mut d, mut t) = table_doc(2, &"A cell with enough words to wrap onto a second line ".repeat(3));
    t.props.cell_margins = Some([0.0, 5.4, 1584.0, 5.4]);
    d.insert_block(StoryRef::Body, &Path::top(1), Block::Table(t)).unwrap();
    let l = lay(&d);
    let lines_on = |page: &Page| {
        page.items.iter().filter_map(|it| if let Placed::Lines { path, l0, l1, .. } = it { (path.0.len() > 1).then_some((path.0.clone(), *l0, *l1)) } else { None }).collect::<Vec<_>>()
    };
    let first = l.pages.iter().map(lines_on).find(|v| !v.is_empty()).unwrap();
    assert!(first.iter().all(|(_, l0, l1)| l1 - l0 == 1), "one line of each cell on the row's first page: {first:?}");
    let a = l.pages.iter().filter(|p| lines_on(p).iter().any(|(path, ..)| path == &vec![1, 0, 0, 0])).count();
    assert!(a >= 3, "the long cell's lines go on over pages of their own: {a}");
}

/// Word 284: keep with next keeps a paragraph with the first line of the table after it (its first row), where 24 pt of
/// room was asked for, so a label near the foot of the page stays there with the row under it.
#[test]
fn keep_with_next_before_a_table_needs_its_first_row() {
    let row_top = |filler: usize, before: f32| {
        let lines: Vec<String> = (0..filler).map(|i| format!("filler {i}")).chain(["label".into(), "after".into()]).collect();
        let mut d = Document::from_text(&lines.join("
"));
        d.format_paragraphs(&Pos::body(filler, 0), &Pos::body(filler, 0), &|p| {
            p.keep_next = Some(true);
            p.space_before = Some(before);
        })
        .unwrap();
        let (_, t) = table_doc(3, "A1");
        d.insert_block(StoryRef::Body, &Path::top(filler + 1), Block::Table(t)).unwrap();
        let l = lay(&d);
        let (label, row) = (l.caret(&Pos::body(filler, 0)).unwrap(), first_cell(&l, filler + 1));
        (label.page == 0 && row.page == 0).then_some(row.top)
    };
    // 24 filler lines put the label 52 pt above the foot of the first page; its space before (past the 8 pt after the
    // line above) moves it down half a point at a time.
    let lowest = (16..80).filter_map(|b| row_top(24, b as f32 / 2.0)).fold(0.0, f32::max);
    // The page's text ends at 720 pt; a row 24 pt tall would have to start by 696.
    assert!(lowest > 697.0, "the table's first row starts as low as its own height allows: {lowest}");
}

fn first_cell(l: &DocLayout, block: usize) -> crate::hit::Caret {
    l.caret(&Pos { story: StoryRef::Body, path: Path(vec![block as u32, 0, 0, 0]), off: 0 }).unwrap()
}

/// Word 604: a section's header keeps no document grid when its tops are measured, as it is drawn with none. The previous
/// section's one-line-a-page grid (a 698 pt pitch) sized the next section's header and put one body line on each page.
#[test]
fn a_header_takes_no_grid_from_the_section_before() {
    use ew_doc::section::{DocGrid, DocGridType, SectionProps};
    let mut d = Document::from_text("one line a page\nnext section\nits second line\nits third line");
    let id = d.add_part(ew_doc::PartKind::Header, vec![para_block(Paragraph::with_text("Header", Default::default()))]);
    let mut first = SectionProps::default();
    first.headers.default = Some(id);
    first.doc_grid = Some(DocGrid { kind: DocGridType::Lines, line_pitch: 698.0, char_space: 0 });
    d.para_mut(StoryRef::Body, &Path::top(0)).unwrap().section = Some(Box::new(first));
    d.last_section.headers.default = Some(id);
    d.last_section.doc_grid = Some(DocGrid { kind: DocGridType::Lines, line_pitch: 16.6, char_space: 0 });
    let l = lay(&d);
    let pages: Vec<usize> = (1..4).map(|k| l.caret(&Pos::body(k, 0)).unwrap().page).collect();
    assert!(pages.iter().all(|p| *p == pages[0]), "the second section's lines share a page: {pages:?}");
    let top = l.caret(&Pos::body(1, 0)).unwrap().top;
    assert!(top < 120.0, "its first line starts below the header, near the top margin: {top}");
}

/// A non-breaking hyphen draws as the run font's hyphen, so its line is as tall as one with an ordinary hyphen (the nbhyphen
/// variant: a fallback face for U+2011 made Word's 17.0 pt line 17.7 in Aptos), and it still never breaks.
#[test]
fn a_non_breaking_hyphen_line_is_as_tall_as_a_hyphen_line() {
    let heights = |text: &str| {
        let l = lay(&Document::from_text(text));
        let para = l.pages[0].items.iter().find_map(|i| if let Placed::Lines { para, .. } = i { Some(para.clone()) } else { None }).unwrap();
        (para.lines[0].height, para.lines[0].baseline, para.glyphs.len())
    };
    let (plain, nb) = (heights("state-of-the-art"), heights("state\u{2011}of\u{2011}the\u{2011}art"));
    assert!((plain.0 - nb.0).abs() < 0.01 && (plain.1 - nb.1).abs() < 0.01, "{plain:?} vs {nb:?}");
}

/// Probe autofit-15 (Word 491): a box that resizes to fit its text takes its last paragraph's space after too, and keeps its
/// text inside its outline, half the line's width in from each margin.
#[test]
fn a_box_that_fits_its_text_counts_space_after_and_keeps_inside_its_outline() {
    use ew_doc::{PartKind, TextBody};
    let laid = |after: f32, stroke: bool| {
        let mut d = Document::from_text("x");
        let mut p = Paragraph::with_text("short", Default::default());
        p.props.space_after = Some(after);
        let id = d.add_part(PartKind::TextBox, vec![para_block(p)]);
        d.parts.get_mut(&id).unwrap().body = TextBody { auto_fit: true, ..Default::default() };
        let shape = ew_doc::para::InlineObject::Shape {
            kind: ew_doc::para::ShapeKind::TextBox,
            w: 144.0,
            h: 24.0,
            fill: None,
            stroke: stroke.then_some(ew_doc::Rgb(0, 0, 0)),
            stroke_width: 1.0,
            float: Default::default(),
            story: Some(id),
            effects: Default::default(),
            freeform: None,
            extra: Default::default(),
        };
        d.insert_object(&Pos::body(0, 1), shape, &Default::default()).unwrap();
        let l = lay(&d);
        let frame = l.find_object(0, |o| o.text_box == Some(id)).unwrap().rect;
        let x = l.pages[0].items.iter().find_map(|it| match it {
            Placed::Lines { story: StoryRef::Part(s), x, .. } if *s == id => Some(*x),
            _ => None,
        });
        (frame, x.unwrap())
    };
    let (none, _) = laid(0.0, false);
    let (eight, _) = laid(8.0, false);
    assert!((eight.h - none.h - 8.0).abs() < 0.01, "8 pt after makes the box 8 pt taller: {} vs {}", eight.h, none.h);
    let (outlined, x) = laid(0.0, true);
    let (plain, x0) = laid(0.0, false);
    assert!((x - x0 - 0.5).abs() < 0.01 && (outlined.h - plain.h - 1.0).abs() < 0.01, "text {x} vs {x0}, box {} vs {}", outlined.h, plain.h);
}

/// Word 493: a label kept with the next paragraph goes over with it when that paragraph's first line is taller than any page
/// (the fixture's shape with a 1,584 pt outline), and the line stays under the label, running past the margin.
#[test]
fn a_kept_label_goes_over_with_a_line_taller_than_the_page() {
    let mut d = Document::from_text(&format!("{}\nlabel\n\nafter", vec!["filler"; 20].join("\n")));
    d.format_paragraphs(&Pos::body(20, 0), &Pos::body(20, 0), &|p| p.keep_next = Some(true)).unwrap();
    let shape = ew_doc::para::InlineObject::Shape {
        kind: ew_doc::para::ShapeKind::Rectangle,
        w: 100.0,
        h: 900.0,
        fill: None,
        stroke: None,
        stroke_width: 0.0,
        float: Default::default(),
        story: None,
        effects: Default::default(),
        freeform: None,
        extra: Default::default(),
    };
    d.insert_object(&Pos::body(21, 0), shape, &Default::default()).unwrap();
    let l = lay(&d);
    let (label, tall) = (l.caret(&Pos::body(20, 0)).unwrap(), l.caret(&Pos::body(21, 0)).unwrap());
    assert_eq!(label.page, 1, "the label starts the next page");
    assert_eq!(tall.page, label.page, "the tall line stays under it");
}
