//! Web Layout's room round the text (`LayoutOptions::web_margin`, `view.window`'s margin), which a forum post's host sets.
//! Assertions compare the same text at two margins, never font metrics.

use crate::*;

fn lay(margin: f32) -> DocLayout {
    let d = Document::from_text("Text.");
    let opts = LayoutOptions { view: ViewMode::Web, web_width: 2000.0, web_margin: margin, ..Default::default() };
    layout(&d, &mut LayoutCache::new(), &opts)
}

/// The first line's column's left edge and top, and its height.
fn first(l: &DocLayout) -> (f32, f32, f32) {
    l.pages[0]
        .items
        .iter()
        .find_map(|it| if let Placed::Lines { x, y, para, l0, .. } = it { Some((*x, *y, para.lines[*l0].height)) } else { None })
        .expect("a line")
}

#[test]
fn the_web_view_leaves_the_margin_the_view_asks_for() {
    assert_eq!((LayoutOptions::default().web_margin, WEB_MARGIN), (18.0, 18.0), "Word's Web Layout margin");
    let (x, y, _) = first(&lay(WEB_MARGIN));
    assert_eq!((x, y), (18.0, 18.0), "the text starts a margin in, from the top too");
    let wide = lay(40.0);
    let (x, y, h) = first(&wide);
    assert_eq!((x, y), (40.0, 40.0), "a wider margin moves the text in");
    assert_eq!(wide.pages[0].w, 2000.0, "the page keeps the window's width");
    // The page is as high as the text plus a margin below it, as above.
    assert_eq!(wide.pages[0].h, y + h + 2.0 * 40.0);
}
