//! EasyWriter engine-gaps-rest: Two Lines in One and Horizontal in Vertical laid out and drawn as Word does
//! (`para::east_asian`; Word's PDF of the fixture, page 66, and probe g33).

use super::{flat, lay};
use crate::*;
use ew_doc::Pos;
use ew_doc::props::{CombineBrackets, EastAsianLayout, TextDirection};

fn with_layout(text: &str, from: usize, to: usize, l: EastAsianLayout) -> Document {
    let mut d = Document::from_text(text);
    d.format_range(&Pos::body(0, from), &Pos::body(0, to), &|c| c.east_asian_layout = Some(l.clone())).unwrap();
    d
}

fn glyph_runs(d: &Document) -> Vec<(String, f32, f32, f32)> {
    let l = lay(d);
    flat(display::page_display(d, &l.pages[0], &Default::default()))
        .into_iter()
        .filter_map(|x| match x {
            display::Draw::Glyphs { text, size, glyphs, .. } => glyphs.first().map(|g| (text, size, g.1, g.2)),
            _ => None,
        })
        .collect()
}

/// Two Lines in One: two half-size rows that fill the line ("two lines " over "in one"), the first raised, the second lowered,
/// both from the same x; brackets at the run's size around them; the run takes the brackets and the wider row.
#[test]
fn two_lines_in_one_sets_two_half_size_rows_in_the_line() {
    let text = "ab two lines in one cd";
    let plain = lay(&Document::from_text(text));
    let base_h = plain.pages[0].items.iter().find_map(|it| if let Placed::Lines { para, .. } = it { Some(para.lines[0].height) } else { None });
    for brackets in [None, Some(CombineBrackets::Round)] {
        let d = with_layout(text, 3, 19, EastAsianLayout { combine: Some(true), combine_brackets: brackets, ..Default::default() });
        let l = lay(&d);
        let pl = l.pages[0].items.iter().find_map(|it| if let Placed::Lines { para, .. } = it { Some(para.clone()) } else { None }).unwrap();
        assert_eq!(pl.ea_runs.len(), 1, "one unit");
        assert_eq!(Some(pl.lines[0].height), base_h, "the rows fill the line without growing it");
        let r = &pl.ea_runs[0];
        let size = |s: u32| pl.styles[s as usize].size;
        let full = pl.styles[pl.clusters[r.cluster].style as usize].size;
        let rows: Vec<(f32, f32)> = r.glyphs.iter().map(|(s, g)| (size(*s), g.dy)).collect();
        let half = rows.iter().filter(|(s, _)| (*s - full / 2.0).abs() < 0.01).count();
        assert_eq!(half, 16, "every letter at half the size: {rows:?}");
        let top: String = r.text.chars().take(if brackets.is_some() { 11 } else { 10 }).collect();
        assert!(top.ends_with("two lines "), "first row: {top:?}");
        let ups: Vec<f32> = rows.iter().filter(|(s, _)| (*s - full / 2.0).abs() < 0.01).map(|(_, dy)| *dy).collect();
        assert!(ups[0] > 3.0 && ups[15] < 0.0, "first row up, second down: {ups:?}");
        // The caret after the run sits past the wider row (and the brackets).
        let (a, b) = (l.caret(&Pos::body(0, 3)).unwrap().x, l.caret(&Pos::body(0, 19)).unwrap().x);
        let rows_w = r.glyphs.iter().filter(|(s, _)| (size(*s) - full / 2.0).abs() < 0.01).map(|(_, g)| g.dx).fold(0.0f32, f32::max);
        assert!(b - a > rows_w, "{a} {b} {rows_w}");
        if brackets.is_some() {
            assert!(r.text.starts_with('(') && r.text.ends_with(')'), "{:?}", r.text);
            assert_eq!(rows.iter().filter(|(s, dy)| (*s - full).abs() < 0.01 && *dy == 0.0).count(), 2, "brackets on the baseline at full size");
        }
        let runs = glyph_runs(&d);
        assert!(runs.iter().any(|(t, s, ..)| t.contains("two lines") && (*s - full / 2.0).abs() < 0.01), "drawn: {runs:?}");
    }
}

/// Horizontal in Vertical in horizontal text: the text turned 90 degrees counterclockwise, taking the font's line height along
/// the line; Fit in line squeezes text longer than that height to it.
#[test]
fn horizontal_in_vertical_turns_its_text() {
    let d = with_layout("plain 12 tail", 6, 8, EastAsianLayout { vert: Some(true), ..Default::default() });
    let l = lay(&d);
    let draws = flat(display::page_display(&d, &l.pages[0], &Default::default()));
    let turned = draws.iter().find_map(|x| match x {
        display::Draw::Turned { turn: TextDirection::Up, items, .. } => Some(items.clone()),
        _ => None,
    });
    let items = turned.expect("a turned frame");
    assert!(items.iter().any(|x| matches!(x, display::Draw::Glyphs { text, .. } if text == "12")));
    let pl = l.pages[0].items.iter().find_map(|it| if let Placed::Lines { para, .. } = it { Some(para.clone()) } else { None }).unwrap();
    let st = &pl.styles[pl.clusters[pl.ea_runs[0].cluster].style as usize];
    let w = l.caret(&Pos::body(0, 8)).unwrap().x - l.caret(&Pos::body(0, 6)).unwrap().x;
    assert!((w - (st.ascent + st.descent + 0.06 * st.size)).abs() < 0.01, "takes the line height along the line: {w}");
    // A long run grows the line; with Fit in line it is squeezed to the line's height instead.
    let long = |compress| {
        let d = with_layout("ab ABCDEFGHIJ cd", 3, 13, EastAsianLayout { vert: Some(true), vert_compress: Some(compress), ..Default::default() });
        let l = lay(&d);
        let pl = l.pages[0].items.iter().find_map(|it| if let Placed::Lines { para, .. } = it { Some(para.clone()) } else { None }).unwrap();
        pl.lines[0].height
    };
    let plain = lay(&Document::from_text("ab ABCDEFGHIJ cd"));
    let plain_h = plain.pages[0].items.iter().find_map(|it| if let Placed::Lines { para, .. } = it { Some(para.lines[0].height) } else { None }).unwrap();
    assert!(long(false) > plain_h + 20.0, "{} against {plain_h}", long(false));
    assert!((long(true) - plain_h).abs() < 0.5, "{} against {plain_h}", long(true));
}

/// Combine Characters (an EQ field in Word's form at 6 pt and 66 %): the first row 6 pt up, the second 2 pt down, both narrowed,
/// as Word's PDF of the fixture draws them (page 66: ABC at 6 pt raised 6.0, DEF lowered 2.04, glyphs at 0.643).
#[test]
fn combine_characters_raise_and_lower_their_rows() {
    use ew_doc::eq::Combined;
    let mut d = Document::from_text("x  y");
    let c = Combined::of("ABCDEF", 6.0);
    let props = ew_doc::props::CharProps { size: Some(6.0), scale: Some(66.0), ..Default::default() };
    let obj = ew_doc::para::InlineObject::Field { instr: c.instr(), result: "ABCDEF".into(), locked: false, dirty: false, code: false, form: String::new() };
    d.insert_object(&Pos::body(0, 2), obj, &props).unwrap();
    let l = lay(&d);
    let draws = flat(display::page_display(&d, &l.pages[0], &Default::default()));
    let row = |t: &str| draws.iter().find_map(|x| match x {
        display::Draw::Glyphs { text, glyphs, x_scale, size, .. } if text == t => Some((glyphs[0].2, *x_scale, *size)),
        _ => None,
    });
    let base = draws.iter().find_map(|x| match x { display::Draw::Glyphs { text, glyphs, .. } if text.starts_with('x') => Some(glyphs[0].2), _ => None }).unwrap();
    let texts: Vec<String> = draws.iter().filter_map(|x| if let display::Draw::Glyphs { text, .. } = x { Some(text.clone()) } else { None }).collect();
    let (top, bottom) = (row("ABC").unwrap_or_else(|| panic!("first row in {texts:?}")), row("DEF").expect("second row"));
    assert!((base - top.0 - 6.0).abs() < 0.01 && (bottom.0 - base - 2.0).abs() < 0.01, "{base} {top:?} {bottom:?}");
    assert!((top.1 - 0.66).abs() < 0.001 && (top.2 - 6.0).abs() < 0.01, "{top:?}");
}
