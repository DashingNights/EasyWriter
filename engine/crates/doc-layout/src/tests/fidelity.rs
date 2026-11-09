//! EasyWriter: Word's rules measured in the DOM editor's page walk and on the Word fixture, as the layout and its
//! drawing carry them (docs/plans/engine/fidelity.md, engine/ORIGIN.md). Assertions are relations to
//! the font's own metrics, never fixed font values.
use crate::display::{DisplayOptions, Draw, page_display};
use crate::*;
use ew_doc::props::{Border, BorderStyle, Borders, Highlight, Rgb};
use ew_doc::para::ShapeKind;

fn lay(doc: &Document) -> DocLayout {
    layout(doc, &mut LayoutCache::new(), &LayoutOptions::default())
}

/// The page each paragraph whose text starts with `prefix` lands on.
fn page_of(d: &Document, l: &DocLayout, prefix: &str) -> Option<usize> {
    l.pages.iter().position(|p| {
        p.items.iter().any(|it| matches!(it, Placed::Lines { story: StoryRef::Body, path, .. } if d.para(StoryRef::Body, path).is_some_and(|q| q.text.starts_with(prefix))))
    })
}

#[test]
fn a_paragraph_border_takes_the_room_its_style_draws() {
    // Word probes at w:sz 1 to 100 (page-walk-findings.md, border-widths): double 3w, triple 5w, a wave 3 pt
    // (3.75 from 1.5 pt up), the single styles w.
    let b = |style, width| crate::boxes::line_room(&Border { style, width, color: None, space: 0.0 });
    assert_eq!(b(BorderStyle::Single, 1.5), 1.5);
    assert_eq!(b(BorderStyle::Double, 1.5), 4.5);
    assert_eq!(b(BorderStyle::Triple, 0.5), 2.5);
    assert_eq!((b(BorderStyle::Wave, 0.75), b(BorderStyle::Wave, 1.5)), (3.0, 3.75));
    assert_eq!((b(BorderStyle::ThickThinSmallGap, 1.5), b(BorderStyle::ThinThickMediumGap, 1.5)), (3.0, 3.0));
    assert_eq!((b(BorderStyle::ThinThickThinLargeGap, 1.0), b(BorderStyle::DoubleWave, 0.75)), (5.0, 5.25));
    assert_eq!((b(BorderStyle::ThreeDEmboss, 1.5), b(BorderStyle::ThreeDEngrave, 3.0)), (3.0, 6.0));
    // dashDotStroked takes 3 pt at any width.
    assert_eq!((b(BorderStyle::DashDotStroked, 0.5), b(BorderStyle::DashDotStroked, 6.0)), (3.0, 3.0));
    // Word's style names come back as read, so they are saved too.
    for name in ["thinThickSmallGap", "thickThinLargeGap", "thinThickThinMediumGap", "threeDEmboss", "doubleWave", "dashSmallGap", "dotDotDash", "dashDotStroked", "inset", "outset"] {
        assert_eq!(BorderStyle::from_ooxml(name).ooxml(), name);
    }
}

#[test]
fn a_cell_border_takes_the_room_its_style_draws() {
    // The text starts below the top border's room and the cell margin, as for a paragraph border.
    let top = |style| {
        let mut d = Document::from_text("");
        let line = Some(Border { style, width: 1.0, color: None, space: 0.0 });
        let mut t = ew_doc::Table::new(1, 1, 200.0);
        t.props.borders = Some(Borders { top: line, ..Default::default() });
        t.props.cell_margins = Some([0.0, 5.4, 0.0, 5.4]);
        t.rows[0].cells[0].blocks = vec![ew_doc::para_block(ew_doc::Paragraph::with_text("one", Default::default()))];
        d.body = vec![std::sync::Arc::new(Block::Table(t))];
        let l = lay(&d);
        l.pages[0].items.iter().find_map(|i| if let Placed::Lines { y, story: StoryRef::Body, .. } = i { Some(*y) } else { None }).unwrap()
    };
    assert!((top(BorderStyle::ThinThickThinLargeGap) - top(BorderStyle::Single) - 4.0).abs() < 0.01);
}

#[test]
fn keep_with_next_counts_the_space_after_the_kept_paragraph() {
    // Lines exactly 14 pt with 8 pt after: fill the page until 28 to 36 pt is left, where a kept paragraph and the
    // next one's first line fit without the space between them but not with it. Word moves the kept one over.
    let mut d = super::pagination_fixture_document("x");
    let s = &d.last_section;
    let body = s.page_h - s.margin_top - s.margin_bottom;
    let fillers = ((body - 30.0) / 22.0).floor() as usize;
    let left = body - 22.0 * fillers as f32;
    assert!((28.0..36.0).contains(&left), "{left}");
    let mut text: Vec<String> = (0..fillers).map(|i| format!("Filler {i}")).collect();
    text.extend(["KEEP with next".to_string(), "NEXT one".to_string()]);
    d = super::pagination_fixture_document(&text.join("\n"));
    if let Some(Block::Para(p)) = d.body.get_mut(fillers).map(std::sync::Arc::make_mut) {
        p.props.keep_next = Some(true);
    }
    let l = lay(&d);
    assert_eq!((page_of(&d, &l, "KEEP"), page_of(&d, &l, "NEXT")), (Some(1), Some(1)));
}

fn rules(l: &DocLayout, page: usize) -> Vec<(f32, f32, f32, f32)> {
    l.pages[page].items.iter().filter_map(|i| if let Placed::Rule { x0, y0, x1, y1, .. } = i { Some((*x0, *y0, *x1, *y1)) } else { None }).collect()
}

#[test]
fn page_borders_measure_from_the_page_edge_or_the_text() {
    let mut d = Document::from_text("Body");
    let line = Border { space: 4.0, ..Border::single(1.5) };
    d.last_section.page_borders = Some(Borders { top: Some(line), left: Some(line), bottom: Some(line), right: Some(line), ..Default::default() });
    // From the page edge (Word's PDF of the fixture): the line's outer edge lies its distance in.
    let r = rules(&lay(&d), 0);
    let top = r.iter().find(|(_, y0, _, y1)| y0 == y1).copied().unwrap();
    assert!((top.1 - 4.75).abs() < 0.01, "{top:?}");
    // From the text: its inner edge lies its distance outside the text's left side and above the header's distance.
    d.last_section.page_border_place.from_text = true;
    let s = d.last_section.clone();
    let r = rules(&lay(&d), 0);
    let top = r.iter().find(|(_, y0, _, y1)| y0 == y1).copied().unwrap();
    assert!((top.1 - (s.margin_top.min(s.header) - 4.75)).abs() < 0.01, "{top:?}");
    let left = r.iter().find(|(x0, _, x1, _)| x0 == x1).copied().unwrap();
    assert!((left.0 - (s.margin_left + s.gutter - 4.75)).abs() < 0.01, "{left:?}");
    // `w:display="firstPage"`: only the section's first page.
    let mut d = Document::from_text(&"Several words to fill pages. ".repeat(600));
    d.last_section.page_borders = Some(Borders { top: Some(line), ..Default::default() });
    d.last_section.page_border_place.first_page = Some(true);
    let l = lay(&d);
    assert!(l.pages.len() > 1);
    assert_eq!((rules(&l, 0).len(), rules(&l, 1).len()), (1, 0));
}

#[test]
fn a_picture_cropped_to_a_shape_is_clipped_to_its_outline() {
    let mut d = Document::from_text("x");
    let mut float = ew_doc::para::Float::default();
    let outline = ew_doc::freeform::Freeform {
        w: 10.0,
        h: 10.0,
        paths: vec![ew_doc::freeform::FreePath { pts: vec![[5.0, 0.0], [10.0, 10.0], [0.0, 10.0]], closed: true }],
        ..Default::default()
    };
    float.crop_shape = Some(std::sync::Arc::new(ew_doc::para::CropShape { preset: "triangle".into(), adj: Vec::new(), outline }));
    let pic = ew_doc::para::Picture { media: "m".into(), w: 40.0, h: 20.0, alt: String::new(), float, crop: [0.0; 4], ole: None, ..Default::default() }.build();
    if let Some(Block::Para(p)) = d.body.get_mut(0).map(std::sync::Arc::make_mut) {
        p.insert_object(1, pic, &Default::default()).unwrap();
    }
    let l = lay(&d);
    let draws = page_display(&d, &l.pages[0], &DisplayOptions::default());
    let clip = draws.iter().find_map(|d| if let Draw::Clip { rect, items, path } = d { Some((*rect, items, path)) } else { None }).expect("a clip");
    assert!(matches!(clip.1.as_slice(), [Draw::Image { .. }]));
    // The triangle stretched over the 40 x 20 frame: its apex at the top middle.
    let Some(ew_doc::graphic::PathSeg::Move(x, y)) = clip.2.first().copied() else { panic!("{:?}", clip.2) };
    assert!((x - clip.0.x - 20.0).abs() < 0.01 && (y - clip.0.y).abs() < 0.01, "{:?}", clip.2);
}

#[test]
fn emphasis_marks_draw_one_mark_per_character() {
    let mut d = Document::from_text("ab c");
    d.styles_mut().default_chr.em = Some(ew_doc::props::EmphasisMark::Dot);
    let l = lay(&d);
    let draws = page_display(&d, &l.pages[0], &DisplayOptions::default());
    let marks = draws.iter().filter(|d| matches!(d, Draw::Shape { kind: ShapeKind::Ellipse, .. })).count();
    assert_eq!(marks, 3, "three letters, no mark on the space");
}

#[test]
fn automatic_text_on_a_black_highlight_stays_black() {
    // Word hides it ("Black (the black text does not show)" in the fixture); shading still turns it white.
    let mut d = Document::from_text("hidden");
    d.styles_mut().default_chr.highlight = Some(Highlight::Black);
    let l = lay(&d);
    let draws = page_display(&d, &l.pages[0], &DisplayOptions::default());
    let colors: Vec<Rgb> = draws.iter().filter_map(|d| if let Draw::Glyphs { color, .. } = d { Some(*color) } else { None }).collect();
    assert!(!colors.is_empty() && colors.iter().all(|c| *c == Rgb::BLACK), "{colors:?}");
}

#[test]
fn an_eq_field_lays_out_as_an_equation() {
    // A fraction stands taller than the text around it, where EasyWriter drew nothing for it.
    let mut d = Document::from_text("x ");
    let plain = lay(&d).pages[0].items.iter().find_map(|i| if let Placed::Lines { para, .. } = i { Some(para.lines[0].height) } else { None });
    if let Some(Block::Para(p)) = d.body.get_mut(0).map(std::sync::Arc::make_mut) {
        let field = ew_doc::para::InlineObject::Field {
            instr: r"EQ \f(1,2)".into(),
            result: String::new(),
            locked: false,
            dirty: false,
            code: false,
            form: String::new(),
        };
        p.insert_object(2, field, &Default::default()).unwrap();
    }
    let l = lay(&d);
    let Some(Placed::Lines { para, .. }) = l.pages[0].items.iter().find(|i| matches!(i, Placed::Lines { .. })) else { panic!() };
    assert_eq!(para.eq_fields.len(), 1);
    assert!(para.lines[0].height > plain.unwrap_or(0.0) + 1.0, "{} against {plain:?}", para.lines[0].height);
}

#[test]
fn page_borders_from_the_text_move_with_it_on_mirrored_pages() {
    let mut d = Document::from_text(&"Several words to fill pages. ".repeat(600));
    d.settings.mirror_margins = true;
    d.last_section.margin_left = 108.0;
    d.last_section.margin_right = 54.0;
    let line = Border { space: 4.0, ..Border::single(1.5) };
    d.last_section.page_borders = Some(Borders { left: Some(line), ..Default::default() });
    d.last_section.page_border_place.from_text = true;
    let l = lay(&d);
    assert!(l.pages.len() > 1);
    for page in [0, 1] {
        let x = rules(&l, page)[0].0;
        assert!((x - (l.pages[page].body.x - 4.75)).abs() < 0.01, "page {page}: {x} against {}", l.pages[page].body.x);
    }
}

#[test]
fn a_kept_paragraph_counts_the_next_ones_last_line_to_its_text_under_multiple_spacing() {
    // A kept paragraph, then a Multiple-spaced keep-lines one at the bottom of the page. Word keeps both on the page
    // when the next one's last line fits to its text's bottom, though not to its line's (fixture, index pages 952-956).
    let build = |fillers: usize, pad: f32| {
        let mut text: Vec<String> = (0..fillers).map(|i| format!("Filler {i}")).collect();
        text.extend(["KEEP with next".to_string(), "NEXT ".repeat(40)]);
        let mut d = super::pagination_fixture_document(&text.join("\n"));
        for (i, b) in d.body.iter_mut().enumerate() {
            let Block::Para(p) = std::sync::Arc::make_mut(b) else { continue };
            if i == 0 {
                p.props.space_before = Some(pad);
            }
            if i == fillers {
                p.props.keep_next = Some(true);
            }
            if i == fillers + 1 {
                p.props.keep_lines = Some(true);
                p.props.line_spacing = Some(ew_doc::props::LineSpacing::Multiple(2.0));
            }
        }
        d
    };
    // The next paragraph's height to its last line's text and to its last line's bottom.
    let d = build(1, 0.0);
    let l = lay(&d);
    let next = l.pages[0].items.iter().rev().find_map(|i| if let Placed::Lines { para, .. } = i { Some(para.clone()) } else { None }).unwrap();
    let (first, last) = (next.lines.first().unwrap(), next.lines.last().unwrap());
    assert!(next.lines.len() >= 2);
    let (text, full) = (last.baseline + last.text_desc - first.top, last.top + last.height - first.top);
    assert!(full - text > 2.0, "{text} against {full}");
    let s = &d.last_section;
    let body = s.page_h - s.margin_top - s.margin_bottom;
    let left = 22.0 + (text + full) / 2.0;
    let fillers = ((body - left) / 22.0).floor() as usize;
    let d = build(fillers, body - left - 22.0 * fillers as f32);
    let l = lay(&d);
    assert_eq!((page_of(&d, &l, "KEEP"), page_of(&d, &l, "NEXT")), (Some(0), Some(0)));
}

#[test]
fn a_displaybarcode_field_lays_out_as_a_picture_of_its_symbol() {
    // An 84 pt Code 128 symbol stands on the baseline: the line grows to hold it and draws its bars, where EasyWriter drew
    // nothing for the field.
    let mut d = Document::from_text("x ");
    if let Some(Block::Para(p)) = d.body.get_mut(0).map(std::sync::Arc::make_mut) {
        let field = ew_doc::para::InlineObject::Field {
            instr: r#"DISPLAYBARCODE "ABC" CODE128"#.into(),
            result: String::new(),
            locked: false,
            dirty: false,
            code: false,
            form: String::new(),
        };
        p.insert_object(2, field, &Default::default()).unwrap();
    }
    let l = lay(&d);
    let Some(Placed::Lines { para, .. }) = l.pages[0].items.iter().find(|i| matches!(i, Placed::Lines { .. })) else { panic!() };
    assert!(para.lines[0].height > 84.0, "{}", para.lines[0].height);
    let draws = page_display(&d, &l.pages[0], &DisplayOptions::default());
    let bars = draws.iter().filter(|d| matches!(d, Draw::Fill { color: Rgb::BLACK, .. })).count();
    assert_eq!(bars, 3 * 5 + 4, "start, 3 characters and check of 3 bars each, a stop of 4");
}

/// engine-fidelity-2: Word's lines across each compound and 3-D style's room (Word's PDF of the fixture, pages 67 and 68,
/// at 1.5 pt): the lines and gaps fill the room, the thick line of a thin-thick style lies outside, and an emboss is light
/// outside on its top and left edges and dark outside on the others.
#[test]
fn compound_border_styles_draw_words_lines() {
    let edge = |style, width| Border { style, width, color: None, space: 0.0 };
    for style in [
        BorderStyle::Triple,
        BorderStyle::ThinThickSmallGap,
        BorderStyle::ThickThinMediumGap,
        BorderStyle::ThinThickLargeGap,
        BorderStyle::ThinThickThinSmallGap,
        BorderStyle::ThinThickThinMediumGap,
        BorderStyle::ThinThickThinLargeGap,
        BorderStyle::ThreeDEmboss,
        BorderStyle::ThreeDEngrave,
    ] {
        for w in [0.75, 1.5, 4.5] {
            let lines = crate::boxes::border_lines(&edge(style, w), true).unwrap();
            let (at, width, _) = *lines.last().unwrap();
            assert!((at + width - crate::boxes::line_room(&edge(style, w))).abs() < 1e-4, "{style:?} at {w}: {lines:?}");
        }
    }
    let widths = |style| crate::boxes::border_lines(&edge(style, 1.5), true).unwrap().iter().map(|l| l.1).collect::<Vec<_>>();
    assert_eq!(widths(BorderStyle::ThinThickSmallGap), [1.5, 0.75]);
    assert_eq!(widths(BorderStyle::ThickThinLargeGap), [0.75, 1.5]);
    assert_eq!(widths(BorderStyle::Triple), [1.5, 1.5, 1.5]);
    assert!(crate::boxes::border_lines(&edge(BorderStyle::Single, 1.5), true).is_none());
    let colours = |lit| crate::boxes::border_lines(&edge(BorderStyle::ThreeDEmboss, 1.5), lit).unwrap().iter().map(|l| l.2).collect::<Vec<_>>();
    let (light, mid) = (Some(Rgb(0xC0, 0xC0, 0xC0)), Some(Rgb(0x60, 0x60, 0x60)));
    assert_eq!(colours(true), [light, mid, Some(Rgb::BLACK)]);
    assert_eq!(colours(false), [Some(Rgb::BLACK), mid, light]);
    // engine-fidelity-4: Word's shades of coloured 3-D lines (probe borders3d-15), within a step of rounding.
    let near = |a: Rgb, b: u32| [(a.0, b >> 16), (a.1, (b >> 8) & 255), (a.2, b & 255)].iter().all(|(x, y)| (i32::from(*x) - *y as i32).abs() <= 2);
    for (c, want) in [
        (0xFF0000, [0xFF0000, 0x6B0000, 0x550000]),
        (0x7030A0, [0x9B58CD, 0x4F226F, 0x431D5F]),
        (0x808080, [0x7F7F7F, 0x353535, 0x2A2A2A]),
        (0xC00000, [0xFF1515, 0x800000, 0x6A0000]),
        (0x0070C0, [0x159CFF, 0x004A80, 0x003E6A]),
        (0x00B050, [0x06FF76, 0x007133, 0x005B29]),
        (0x404040, [0x6A6A6A, 0x202020, 0x151515]),
    ] {
        let (l, m, d) = crate::boxes::three_d_shades(Rgb((c >> 16) as u8, (c >> 8) as u8, c as u8));
        assert!(near(l, want[0]) && near(m, want[1]) && near(d, want[2]), "{c:06x}: {l:?} {m:?} {d:?}");
    }
    // A boxed paragraph draws each edge as its lines in page order, as Word's PDF p67: the thick line above the thin one
    // on the top and bottom edges (outside at the top, inside at the bottom) and left of it on the left and right edges.
    let mut d = Document::from_text("Boxed");
    let tt = Some(edge(BorderStyle::ThinThickSmallGap, 1.5));
    d.format_paragraphs(&ew_doc::Pos::body(0, 0), &ew_doc::Pos::body(0, 0), &|p| {
        p.borders = Some(Borders { top: tt, bottom: tt, left: tt, right: tt, ..Default::default() })
    })
    .unwrap();
    let l = lay(&d);
    let rules = |horizontal: bool| {
        let mut v: Vec<(f32, f32)> = l.pages[0]
            .items
            .iter()
            .filter_map(|i| match i {
                Placed::Rule { x0, y0, y1, border, .. } if (y0 == y1) == horizontal => Some((if horizontal { *y0 } else { *x0 }, border.width)),
                _ => None,
            })
            .collect();
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        v
    };
    let (rows, cols) = (rules(true), rules(false));
    assert_eq!(rows.iter().map(|t| t.1).collect::<Vec<_>>(), [1.5, 0.75, 1.5, 0.75], "top then bottom: {rows:?}");
    assert_eq!(cols.iter().map(|t| t.1).collect::<Vec<_>>(), [1.5, 0.75, 1.5, 0.75], "left then right: {cols:?}");
    assert!((rows[1].0 - rows[0].0 - (0.75 + 0.75 / 2.0 + 0.75)).abs() < 1e-3, "a 0.75 pt gap between them: {rows:?}");
    assert!((rows[3].0 - rows[2].0 - (0.75 + 0.75 / 2.0 + 0.75)).abs() < 1e-3, "and at the bottom: {rows:?}");
    // thickThin mirrors it: the thin line first in page order on every edge.
    let widths_at = |lit| crate::boxes::border_lines(&edge(BorderStyle::ThickThinSmallGap, 1.5), lit).unwrap().iter().map(|l| l.1).collect::<Vec<_>>();
    assert_eq!(widths_at(true), [0.75, 1.5]);
    assert_eq!(widths_at(false), [1.5, 0.75]);
}

/// engine-fidelity-2: dashSmallGap and dotDotDash draw Word's dashes (4 on and 1 off; 3, 1, 1, 1, 1, 1, in widths), and a
/// page art border stands in as squares of its width.
#[test]
fn word_dashes_and_art_borders_draw() {
    let mut d = Document::from_text("Dashed");
    let line = |style, width| Border { style, width, color: None, space: 4.0 };
    d.format_paragraphs(&ew_doc::Pos::body(0, 0), &ew_doc::Pos::body(0, 0), &|p| p.borders = Some(Borders { top: Some(line(BorderStyle::DashSmallGap, 1.0)), ..Default::default() }))
        .unwrap();
    let art = BorderStyle::from_ooxml("apples");
    assert_eq!(art.ooxml(), "apples");
    d.last_section.page_borders = Some(Borders { left: Some(line(art, 16.0)), ..Default::default() });
    let l = lay(&d);
    let draws = page_display(&d, &l.pages[0], &DisplayOptions::default());
    let dashes: Vec<f32> =
        draws.iter().filter_map(|x| if let Draw::Line { x0, y0, x1, y1, .. } = x { (y0 == y1).then_some(x1 - x0) } else { None }).collect();
    assert!(dashes.len() > 10 && dashes.iter().take(5).all(|w| (w - 4.0).abs() < 1e-3), "{dashes:?}");
    let art_line = draws.iter().find_map(|x| if let Draw::Line { x0, x1, width, stroke, .. } = x { (x0 == x1).then_some((*width, *stroke)) } else { None });
    assert_eq!(art_line, Some((16.0, crate::display::Stroke::BorderDotted)));
}

/// engine-fidelity-2: a SYMBOL field draws its character in its font at its size; `\h` leaves the line as tall as its text.
#[test]
fn a_symbol_field_draws_its_character_at_its_size() {
    let line_h = |instr: &str| {
        let mut d = Document::from_text("x y");
        if let Some(Block::Para(p)) = d.body.get_mut(0).map(std::sync::Arc::make_mut) {
            let field = ew_doc::para::InlineObject::Field {
                instr: instr.into(),
                result: String::new(),
                locked: false,
                dirty: false,
                code: false,
                form: String::new(),
            };
            p.insert_object(2, field, &Default::default()).unwrap();
        }
        let l = lay(&d);
        let Some(Placed::Lines { para, .. }) = l.pages[0].items.iter().find(|i| matches!(i, Placed::Lines { .. })) else { panic!() };
        (para.lines[0].height, para.shown.iter().map(|s| s.1.clone()).collect::<String>())
    };
    let (plain, _) = line_h("PAGE");
    let (big, shown) = line_h(r#"SYMBOL 169 \s 40"#);
    assert_eq!(shown, "©");
    assert!(big > plain + 20.0, "{big} vs {plain}");
    let (flat, _) = line_h(r#"SYMBOL 169 \s 40 \h"#);
    assert!((flat - plain).abs() < 0.5, "{flat} vs {plain}");
}

/// engine-fidelity-2: DISPLAYBARCODE's `\t` draws the data under the bars in Arial, a fifth of the symbol's height (Word's
/// PDF of the fixture, page 88: 16.8 pt under an 84 pt Code 128).
#[test]
fn a_displaybarcode_field_draws_its_text_under_the_bars() {
    let draws = |instr: &str| {
        let mut d = Document::from_text("x ");
        if let Some(Block::Para(p)) = d.body.get_mut(0).map(std::sync::Arc::make_mut) {
            let field = ew_doc::para::InlineObject::Field {
                instr: instr.into(),
                result: String::new(),
                locked: false,
                dirty: false,
                code: false,
                form: String::new(),
            };
            p.insert_object(2, field, &Default::default()).unwrap();
        }
        let l = lay(&d);
        page_display(&d, &l.pages[0], &DisplayOptions::default())
    };
    let caption = |instr: &str| draws(instr).into_iter().find_map(|d| if let Draw::Glyphs { text, size, .. } = d { (text == "ABC").then_some(size) } else { None });
    assert_eq!(caption(r#"DISPLAYBARCODE "ABC" CODE128 \t"#), Some(16.8));
    assert_eq!(caption(r#"DISPLAYBARCODE "ABC" CODE128"#), None);
}
