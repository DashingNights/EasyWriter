//! EasyWriter engine-fidelity-3: the Word fixture's pages and probes this package measured (docs/plans/engine/fidelity.md).
use std::sync::Arc;

use crate::*;
use ew_doc::props::CharProps;
use ew_doc::{Paragraph, Pos, para_block};


/// A drop-cap paragraph as Word's file gives it: a 64.5 pt T before 12 pt text, `distance` from the text.
fn drop_cap(distance: Option<f32>) -> Arc<ParaLayout> {
    let small = CharProps { size: Some(12.0), ..Default::default() };
    let mut p = Paragraph::with_text("This sample is long enough to wrap onto several lines of the column. ".repeat(4).as_str(), small.clone());
    p.mark = small;
    let mut big = p.runs[0].clone();
    big.props.size = Some(64.5);
    big.props.position = Some(-4.5);
    big.len = 1;
    p.runs[0].len -= 1;
    p.runs.insert(0, big);
    p.props.drop_cap = Some(3);
    p.props.drop_cap_distance = distance;
    let mut d = Document::from_text("x");
    d.body = vec![para_block(p)];
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    l.pages[0].items.iter().find_map(|i| if let Placed::Lines { para, .. } = i { Some(para.clone()) } else { None }).expect("lines")
}

/// Word keeps the size it wrote for the letter (Word pages 97 and 98), and puts the text below the letter when the distance
/// leaves under a quarter inch beside it (probe: 20.3 pt left keeps text beside, 15.5 pt puts it below; Word page 99).
#[test]
fn a_drop_cap_keeps_words_letter_size_and_moves_the_text_below_when_no_room_is_left() {
    let plain = drop_cap(None);
    let letter = plain.clusters.first().and_then(|c| plain.styles.get(c.style as usize)).map(|s| s.rc.size);
    assert_eq!(letter, Some(64.5), "the letter keeps the size Word wrote");
    let x0 = |pl: &ParaLayout, k: usize| pl.lines.get(k).and_then(|l| l.xs.first().copied()).unwrap_or(f32::NAN);
    assert!((x0(&plain, 0) - plain.drop_cap_w).abs() < 0.5, "dropped lines start after the letter: {} vs {}", x0(&plain, 0), plain.drop_cap_w);
    let far = drop_cap(Some(1584.0));
    assert!(x0(&far, 0).abs() < 0.5, "no room beside the letter: the text starts at the indent ({})", x0(&far, 0));
    let h = far.lines[0].height;
    assert!((far.lines[0].baseline - plain.lines[0].baseline - 3.0 * h).abs() < 0.5, "the text starts below the letter's three lines");
    let dy = far.glyphs.first().map(|g| g.dy).unwrap_or(f32::NAN);
    assert!((dy + h).abs() < 0.5, "the letter sits on the line above the text: dy {dy}, line {h}");
}

/// Word's PDF leaves out what is under a heading collapsed by default, up to the next heading of its level or higher; the
/// layout folds it when the view can expand headings (`expanded`), and shows everything when it cannot.
#[test]
fn a_heading_collapsed_by_default_folds_what_is_under_it() {
    let para = |text: &str, level: Option<u8>, collapsed: bool| {
        let mut p = Paragraph::with_text(text, CharProps::default());
        p.props.outline_level = level;
        p.props.collapsed = collapsed.then_some(true);
        para_block(p)
    };
    let mut d = Document::from_text("x");
    d.body = vec![
        para("H2 collapsed", Some(1), true),
        para("H3 under it", Some(2), false),
        para("body under it", None, false),
        para("H2 next", Some(1), false),
        para("body shown", None, false),
    ];
    let shown = |expanded: Option<std::collections::BTreeSet<usize>>| {
        let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions { expanded, ..Default::default() });
        let mut texts = Vec::new();
        for p in &l.pages {
            for it in &p.items {
                if let Placed::Lines { story: StoryRef::Body, path, .. } = it
                    && let Some(q) = d.para(StoryRef::Body, path)
                {
                    texts.push(q.text.clone());
                }
            }
        }
        texts
    };
    assert_eq!(shown(Some(Default::default())), ["H2 collapsed", "H2 next", "body shown"]);
    assert_eq!(shown(None).len(), 5, "a view that cannot expand headings shows everything");
    assert_eq!(shown(Some([0].into_iter().collect())).len(), 5, "an expanded heading shows what is under it");
}

/// A table style part's cell margins (`w:tcMar` in `w:tblStylePr`) apply to its cells: Word's Calendar 4 gives the even
/// row bands a 4.3 pt bottom margin (Word pages 164 to 167).
#[test]
fn a_table_style_part_gives_its_cells_margins() {
    use ew_doc::styles::{PartFormat, Style, StyleKind, TablePart};
    let mut d = Document::from_text("x");
    let mut st = Style { id: "Cal".into(), name: "Cal".into(), kind: StyleKind::Table, ..Default::default() };
    st.set_table_part(TablePart::Band2Horz, PartFormat { margins: Some([0.0, 5.75, 4.3, 5.75]), ..Default::default() });
    let mut t = st.table.take().unwrap_or_default();
    t.band_size = Some(1);
    st.table = Some(t);
    d.styles_mut().upsert(st);
    let mut table = ew_doc::Table::new(3, 1, 200.0);
    table.props.style = Some("Cal".into());
    table.props.look.header_row = false;
    table.props.look.first_column = false;
    d.body = vec![Arc::new(Block::Table(table.clone()))];
    let m = |row| crate::cell_margins(&d, &table, row, 0);
    assert_eq!(m(1), [0.0, 5.75, 4.3, 5.75], "the even band takes the part's margins");
    assert_eq!(m(0)[2], 0.0, "the odd band keeps the table's");
}

/// Word 2013's layout starts a paragraph on the next page when a picture placed from it, with text wrapping round it, runs
/// past the bottom margin (probe anchormove-15; Word 383 to 386); compatibility mode lets the picture run into the margin.
#[test]
fn a_paragraph_whose_wrapped_picture_runs_past_the_margin_starts_the_next_page() {
    use ew_doc::para::{Anchor, Float, Wrap};
    let page_of_anchor = |mode: u32, wrap: Wrap| {
        let mut d = Document::from_text("First paragraph.\nThe anchor paragraph.");
        d.settings.compat_mode = mode;
        // (A position from the paragraph starts above its space before, so the room goes after the first one.)
        if let Some(Block::Para(p)) = d.body.get_mut(0).map(Arc::make_mut) {
            p.props.space_after = Some(600.0);
        }
        let f = Float { wrap, h_rel: Anchor::Column, v_rel: Anchor::Paragraph, y: 30.0, ..Default::default() };
        d.insert_object(&Pos::body(1, 0), super::rect_shape(48.0, 48.0, f), &Default::default()).unwrap();
        let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
        l.pages.iter().position(|pg| pg.items.iter().any(|i| matches!(i, Placed::Lines { story: StoryRef::Body, path, .. } if path.0 == [1])))
    };
    assert_eq!(page_of_anchor(15, Wrap::Square), Some(1), "moved to the next page");
    assert_eq!(page_of_anchor(15, Wrap::InFrontOfText), Some(0), "in front of text: stays");
    assert_eq!(page_of_anchor(14, Wrap::Square), Some(0), "compatibility mode: stays");
}

/// A drawing sized relative to a page area takes that share of the area on its relative side and keeps its stored size on
/// the other (Word pages 398 to 400: the lines below a picture 25 % of the margin wide keep its stored height).
#[test]
fn a_relative_size_takes_its_share_of_the_area() {
    use ew_doc::para::{Anchor, Float, Wrap};
    let mut d = Document::from_text("x");
    let f = Float { wrap: Wrap::TopAndBottom, rel_w: Some((Anchor::Margin, 0.25)), ..Default::default() };
    d.insert_object(&Pos::body(0, 0), super::rect_shape(160.0, 100.0, f), &Default::default()).unwrap();
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let r = super::shapes(&l.pages[0].items)[0];
    let margin = d.sections()[0].1.text_width();
    assert!((r.w - margin * 0.25).abs() < 0.01 && (r.h - 100.0).abs() < 0.01, "{r:?} for a {margin} pt margin");
}

/// A thin-thick large gap is the border's width between a 1.5 pt line and a 0.75 pt one (probe pageborder: Word draws 1.44,
/// 3.00 and 0.72 at 3 pt, in its 0.72 pt steps).
#[test]
fn a_thin_thick_large_gap_is_the_border_width() {
    use ew_doc::props::{Border, BorderStyle};
    let b = Border { style: BorderStyle::ThinThickLargeGap, width: 3.0, color: None, space: 0.0 };
    let lines: Vec<(f32, f32)> = crate::boxes::border_lines(&b, true).unwrap().iter().map(|l| (l.0, l.1)).collect();
    assert_eq!(lines, [(0.0, 1.5), (4.5, 0.75)]);
}

/// An EAN-13's `\t` digits come one by one as Word sets them (the fixture's page 88): the first left of the guard, each other
/// under its seven modules, the second half after the centre guard.
#[test]
fn ean_digits_sit_under_their_symbol_characters() {
    let b = crate::para::barcode::barcode(r#"DISPLAYBARCODE "4901234567894" EAN13 \t"#).unwrap().unwrap();
    let (x0, m) = (b.bars[0][0], b.bars[0][2]);
    let at: Vec<(String, f32)> = b.caption.iter().map(|c| (c.0.clone(), (c.2 - x0) / m)).collect();
    assert_eq!(at.iter().map(|c| c.0.as_str()).collect::<String>(), "4901234567894");
    let near = |i: usize, v: f32| (at[i].1 - v).abs() < 0.01;
    assert!(near(0, -3.5) && near(1, 6.5) && near(6, 41.5) && near(7, 53.5) && near(12, 88.5), "{at:?}");
}

/// UPC codes set their first and last digits outside the guards (probe barcode-15).
#[test]
fn upc_digits_sit_outside_the_guards_at_the_ends() {
    let at = |instr: &str| {
        let b = crate::para::barcode::barcode(instr).unwrap().unwrap();
        let (x0, m) = (b.bars[0][0], b.bars[0][2]);
        b.caption.iter().map(|c| (c.0.clone(), ((c.2 - x0) / m * 100.0).round() / 100.0)).collect::<Vec<_>>()
    };
    let a = at(r#"DISPLAYBARCODE "12345678901" UPCA \t"#);
    assert_eq!((a.len(), a[0].1, a[1].1, a[11].1, a[11].0.as_str()), (12, -3.5, 13.5, 97.75, "2"));
    let e = at(r#"DISPLAYBARCODE "0123456" UPCE \t"#);
    assert_eq!(e.iter().map(|c| c.0.as_str()).collect::<String>(), "01234565");
    assert_eq!((e[0].1, e[1].1, e[7].1), (-3.5, 6.5, 53.75));
}

/// Collapsed by default set in a style folds the paragraphs in that style too.
#[test]
fn a_style_collapsed_by_default_folds_its_headings() {
    use ew_doc::styles::{Style, StyleKind};
    let mut d = Document::from_text("x");
    let mut st = Style { id: "Folded".into(), name: "Folded".into(), kind: StyleKind::Paragraph, ..Default::default() };
    st.para.outline_level = Some(1);
    st.para.collapsed = Some(true);
    d.styles_mut().upsert(st);
    let para = |text: &str, style: Option<&str>, level: Option<u8>| {
        let mut p = Paragraph::with_text(text, CharProps::default());
        p.props.style = style.map(Into::into);
        p.props.outline_level = level;
        para_block(p)
    };
    d.body = vec![para("Heading", Some("Folded"), None), para("body under it", None, None), para("Next", None, Some(1))];
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions { expanded: Some(Default::default()), ..Default::default() });
    let shown: usize = l.pages.iter().map(|p| p.items.iter().filter(|i| matches!(i, Placed::Lines { story: StoryRef::Body, .. })).count()).sum();
    assert_eq!(shown, 2, "the body under the style's collapsed heading folds");
}
