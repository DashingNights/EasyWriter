//! EasyWriter engine-gaps-views: Immersive Reader's Text Spacing and Syllables (`LayoutOptions::reader`) in Web Layout's flow.
//! Assertions compare the same text with and without the options, never font metrics.

use crate::*;

const TEXT: &str = "Understanding complicated vocabulary becomes considerably easier.";

fn lay(reader: Option<ReaderText>) -> DocLayout {
    let d = Document::from_text(TEXT);
    let opts = LayoutOptions { view: ViewMode::Web, web_width: 2000.0, reader, ..Default::default() };
    layout(&d, &mut LayoutCache::new(), &opts)
}

fn para(l: &DocLayout) -> Arc<ParaLayout> {
    l.pages[0].items.iter().find_map(|it| if let Placed::Lines { para, .. } = it { Some(para.clone()) } else { None }).expect("a paragraph")
}

/// The paragraph's laid-out width (its clusters' advances), its line height and its text size.
fn measure(l: &DocLayout) -> (f32, f32, f32) {
    let pl = para(l);
    (pl.clusters.iter().map(|c| c.adv).sum(), pl.lines[0].height, pl.styles[0].size)
}

#[test]
fn text_spacing_widens_letters_words_and_lines() {
    let (w0, h0, size) = measure(&lay(None));
    let (w1, h1, _) = measure(&lay(Some(ReaderText { spacing: true, syllables: false })));
    let letters = TEXT.chars().filter(|c| !c.is_whitespace()).count() as f32;
    let spaces = TEXT.matches(' ').count() as f32;
    let want = (letters * READER_LETTER_EM + spaces * (READER_LETTER_EM + READER_WORD_EM)) * size;
    assert!((w1 - w0 - want).abs() < 0.5, "{w0} {w1} {want}");
    assert!(h1 > h0 * 1.5, "double line spacing: {h0} {h1}");
}

#[test]
fn syllables_take_room_and_draw_a_dot_each() {
    let plain = lay(None);
    let split = lay(Some(ReaderText { spacing: false, syllables: true }));
    let pl = para(&split);
    assert!(pl.syllables.len() >= 8, "{:?}", pl.syllables);
    let (w0, _, size) = measure(&plain);
    let (w1, _, _) = measure(&split);
    assert!((w1 - w0 - pl.syllables.len() as f32 * READER_DOT_EM * size).abs() < 0.5, "{w0} {w1}");
    let d = Document::from_text(TEXT);
    let dots = |l: &DocLayout| {
        display::page_display(&d, &l.pages[0], &display::DisplayOptions::default())
            .iter()
            .filter(|i| matches!(i, display::Draw::Mark { ch: '·', .. }))
            .count()
    };
    assert_eq!(dots(&split), pl.syllables.len());
    assert_eq!(dots(&plain), 0);
}
