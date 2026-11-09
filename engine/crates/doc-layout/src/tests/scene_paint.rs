//! The page painter's tests from the scene crate (P6): each lays a document out, so they live with the layout, which
//! builds the page's display list; the scene crate paints it.

use std::sync::Arc;

use ew_doc::Document;
use ew_doc::para::ShapeKind;
use ew_doc::props::Rgb;
use ew_scene::{DARK_PAPER, PaintOptions, Rendered, SEPIA_PAPER, invert_lightness};

use crate::display::{DisplayOptions, Draw, RenderOptions, Stroke, background_at, page_display, render_area, render_items, render_page};
use crate::{LayoutCache, LayoutOptions, layout};

mod color_glyphs;

/// #299: the caret's background is the page colour, a highlight, or the dark page.
#[test]
fn background_at_caret_follows_page_colour_highlight_and_dark_mode() {
    use ew_doc::Pos;
    use ew_doc::props::Highlight;
    let mut d = Document::from_text("Hello EasyWriter");
    let mid = |d: &Document, off: usize| {
        let l = layout(d, &mut LayoutCache::new(), &LayoutOptions::default());
        let c = l.caret_on(&Pos::body(0, off), 0).unwrap();
        let page = l.pages[c.page].clone();
        (page, c.x, c.top + c.height / 2.0)
    };
    let light = RenderOptions::default();
    let dark = RenderOptions { paint: PaintOptions { dark: true, ..Default::default() }, ..Default::default() };
    let (page, x, y) = mid(&d, 2);
    assert_eq!(background_at(&d, &page, &light, x, y), Rgb::WHITE);
    assert_eq!(background_at(&d, &page, &dark, x, y), Rgb(DARK_PAPER, DARK_PAPER, DARK_PAPER));
    assert_eq!(background_at(&d, &page, &light, f32::NAN, f32::INFINITY), Rgb::WHITE, "junk points fall back to the paper");
    d.settings.page_color = Some(Rgb(0x10, 0x10, 0x40));
    assert_eq!(background_at(&d, &page, &light, x, y), Rgb(0x10, 0x10, 0x40));
    d.settings.page_color = None;
    d.format_range(&Pos::body(0, 0), &Pos::body(0, 5), &|c| c.highlight = Some(Highlight::Black)).unwrap();
    let (page, x, y) = mid(&d, 2);
    assert_eq!(background_at(&d, &page, &light, x, y), Rgb::BLACK, "inside the highlight");
    let (page, x, y) = mid(&d, 9);
    assert_eq!(background_at(&d, &page, &light, x, y), Rgb::WHITE, "past the highlight");
}

#[test]
fn renders_text_dark_pixels() {
    let d = Document::from_text("Hello EasyWriter");
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let img = render_page(&d, &l.pages[0], 1.0, &RenderOptions::default());
    assert_eq!((img.width, img.height), (612, 792));
    // Somewhere in the first text line there are dark pixels; the margins are white.
    let dark = (72..300).flat_map(|x| (72..100).map(move |y| (x, y))).filter(|(x, y)| img.pixel(*x, *y)[0] < 128).count();
    assert!(dark > 30, "dark {dark}");
    assert_eq!(img.pixel(5, 5), [255, 255, 255, 255]);
    assert!(!img.to_png().is_empty());
}

/// Table Layout › Text Direction (#226): a turned cell's text is painted running down the
/// cell, not across it.
#[test]
fn turned_cell_text_is_painted_turned() {
    use ew_doc::props::TextDirection;
    let ink = |dir: TextDirection| {
        let mut d = Document::from_text("before\nafter");
        let mut t = ew_doc::Table::new(1, 2, 400.0);
        t.rows[0].cells[0].blocks = vec![ew_doc::para_block(ew_doc::Paragraph::with_text("WWWWWWWWWWWW", Default::default()))];
        t.rows[0].cells[0].props.text_direction = dir;
        d.insert_block(ew_doc::StoryRef::Body, &ew_doc::Path::top(1), ew_doc::Block::Table(t)).unwrap();
        let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
        let img = render_page(&d, &l.pages[0], 1.0, &RenderOptions::default());
        // Dark pixels inside the first cell (x 72..272, clear of its borders), well below
        // the first text line.
        (80..264).flat_map(|x| (140..190).map(move |y| (x, y))).filter(|(x, y)| img.pixel(*x, *y)[0] < 128).count()
    };
    assert_eq!(ink(TextDirection::Horizontal), 0, "horizontal text stays in its line");
    assert!(ink(TextDirection::Down) > 30, "down");
    assert!(ink(TextDirection::Up) > 30, "up");
}

/// Shape Effects (#275): an outer shadow paints dark pixels beside the shape on the side it is
/// cast to, and none on the other; a glow surrounds it.
#[test]
fn shape_shadow_is_cast_offset_from_the_shape() {
    use ew_doc::effects::{Glow, Shadow, ShapeEffects};
    use ew_doc::para::InlineObject;
    let draw = |effects: ShapeEffects| {
        let mut d = Document::from_text("");
        let shape = InlineObject::Shape {
            kind: ShapeKind::Rectangle,
            w: 100.0,
            h: 60.0,
            fill: Some(ew_doc::fill::Fill::solid(Rgb(0, 0, 255))),
            stroke: None,
            stroke_width: 0.0,
            float: Default::default(),
            story: None,
            freeform: None,
            effects,
            extra: Default::default(),
        };
        let at = ew_doc::Pos { story: ew_doc::StoryRef::Body, path: ew_doc::Path::top(0), off: 0 };
        d.insert_object(&at, shape, &Default::default()).unwrap();
        let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
        render_page(&d, &l.pages[0], 1.0, &RenderOptions::default())
    };
    let plain = draw(ShapeEffects::default());
    let blue = |img: &Rendered| {
        let px: Vec<(u32, u32)> = (0..612)
            .flat_map(|x| (0..400).map(move |y| (x, y)))
            .filter(|(x, y)| matches!(img.pixel(*x, *y), [r, _, b, _] if r < 40 && b > 200))
            .collect();
        let (x0, x1) = (px.iter().map(|p| p.0).min().unwrap(), px.iter().map(|p| p.0).max().unwrap());
        let (y0, y1) = (px.iter().map(|p| p.1).min().unwrap(), px.iter().map(|p| p.1).max().unwrap());
        (x0, y0, x1, y1)
    };
    let (x0, y0, x1, y1) = blue(&plain);
    assert!(x1 - x0 > 90 && y1 - y0 > 50, "{:?}", (x0, y0, x1, y1));
    // Grey (not white, not blue) pixels in a strip just outside an edge.
    let grey = |img: &Rendered, xs: std::ops::Range<u32>, ys: std::ops::Range<u32>| {
        xs.flat_map(|x| ys.clone().map(move |y| (x, y)))
            .filter(|(x, y)| matches!(img.pixel(*x, *y), [r, g, b, _] if r < 200 && r == g && g == b))
            .count()
    };
    let right = |img: &Rendered| grey(img, x1 + 2..x1 + 6, y0 + 10..y1);
    let left = |img: &Rendered| grey(img, x0.saturating_sub(6)..x0.saturating_sub(2), y0 + 10..y1);
    assert_eq!((right(&plain), left(&plain)), (0, 0));
    let shadow = Shadow { color: Rgb::BLACK, transparency: 30.0, blur: 2.0, distance: 8.0, angle: 0.0, rot_with_shape: false };
    let img = draw(ShapeEffects { shadow: Some(shadow), ..Default::default() });
    assert_eq!(blue(&img), (x0, y0, x1, y1), "the shape itself is unchanged");
    assert!(right(&img) > 100, "shadow to the right: {}", right(&img));
    assert_eq!(left(&img), 0, "nothing on the left");
    let img = draw(ShapeEffects { glow: Some(Glow { color: Rgb(255, 0, 0), size: 6.0, transparency: 0.0 }), ..Default::default() });
    let reddish = |x: u32, y: u32| matches!(img.pixel(x, y), [r, g, _, _] if r > 200 && g < 200);
    assert!(reddish(x1 + 2, (y0 + y1) / 2) && reddish(x0 - 2, (y0 + y1) / 2), "glow on both sides");
}

/// #1500: gradient fills shade across the shape, circular ones from the centre out, and a
/// transparent fill lets what is behind show through.
#[test]
fn shape_gradients_and_transparency_are_drawn() {
    use std::sync::Arc;
    use ew_doc::fill::{Fill, Gradient, GradientFlip, GradientKind, PathShape};
    use ew_doc::para::{Float, InlineObject, Wrap};
    use ew_doc::wordart::GradStop;
    let shape = |fill: Fill, x: f32| InlineObject::Shape {
        kind: ShapeKind::Rectangle,
        w: 100.0,
        h: 100.0,
        fill: Some(fill),
        stroke: None,
        stroke_width: 0.0,
        float: Float { wrap: Wrap::InFrontOfText, x, y: 0.0, ..Default::default() },
        story: None,
        freeform: None,
        effects: Default::default(),
        extra: Default::default(),
    };
    let stops = vec![GradStop { pos: 0.0, color: Rgb::BLACK, transparency: 0.0 }, GradStop { pos: 100.0, color: Rgb::WHITE, transparency: 0.0 }];
    let grad = |kind| Fill::Gradient(Arc::new(Gradient { stops: stops.clone(), kind, tile: None, rot_with_shape: true, flip: GradientFlip::None }));
    let mut d = Document::from_text("");
    let at = ew_doc::Pos { story: ew_doc::StoryRef::Body, path: ew_doc::Path::top(0), off: 0 };
    // Left to right: top-to-bottom linear, circular, navy under 30%-opaque white.
    let objs = [
        shape(grad(GradientKind::Linear { angle: 90.0, scaled: false }), 0.0),
        shape(grad(GradientKind::Path { shape: PathShape::Circle, focus: [50.0; 4] }), 150.0),
        shape(Fill::solid(Rgb(0, 0, 0x80)), 300.0),
        shape(Fill::Solid { color: Rgb::WHITE, transparency: 70.0 }, 300.0),
    ];
    for o in objs.into_iter().rev() {
        d.insert_object(&at, o, &Default::default()).unwrap();
    }
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let img = render_page(&d, &l.pages[0], 1.0, &RenderOptions::default());
    // Each shape's frame (the dark corner of the linear one is its top-left pixel).
    let dark = |x0: u32, x1: u32| -> Vec<(u32, u32)> {
        (x0..x1).flat_map(|x| (0..400).map(move |y| (x, y))).filter(|(x, y)| img.pixel(*x, *y)[0] < 40).collect()
    };
    let lin = dark(60, 200);
    let (lx, ly) = (lin.iter().map(|p| p.0).min().unwrap(), lin.iter().map(|p| p.1).min().unwrap());
    let luma = |x: u32, y: u32| img.pixel(x, y)[0];
    assert!(
        luma(lx + 50, ly + 5) < luma(lx + 50, ly + 50) && luma(lx + 50, ly + 50) < luma(lx + 50, ly + 95),
        "dark at the top, light at the bottom"
    );
    let (cx, cy) = (lx + 150 + 50, ly + 50);
    assert!(luma(cx, cy) < 30 && luma(cx - 48, cy - 48) > 200, "black at the centre, white at the corners");
    let [r, _, b, _] = img.pixel(lx + 300 + 50, cy);
    assert!((150..230).contains(&b) && (60..120).contains(&r), "white over navy blends: {r} {b}");
}

/// Ink in a raster: the sum of how far each pixel is from white.
fn ink(img: &Rendered) -> u64 {
    img.pixels.as_chunks::<4>().0.iter().map(|p| 255 - p[0] as u64).sum()
}

#[test]
fn text_darkening_adds_ink_on_screen_only() {
    let d = Document::from_text("Marketing analytics lead with twelve years of measurement work.");
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let plain = render_page(&d, &l.pages[0], 2.0, &RenderOptions::default());
    let dark = render_page(&d, &l.pages[0], 2.0, &RenderOptions { paint: PaintOptions { text_darkening: true, ..Default::default() }, ..Default::default() });
    let (a, b) = (ink(&plain), ink(&dark));
    // About 0.3 px more on every edge of an 11 pt line at 2x: clearly more ink, not bold.
    assert!(b as f64 > a as f64 * 1.08 && (b as f64) < a as f64 * 1.6, "plain {a}, darkened {b}");
    // Off by default: exports and thumbnails are untouched.
    assert!(!RenderOptions::default().paint.text_darkening);
}

#[test]
fn page_picture_is_painted_behind_the_text() {
    let mut png = Vec::new();
    image::RgbaImage::from_pixel(8, 8, image::Rgba([10, 200, 30, 255]))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let mut d = Document::new();
    d.media.insert("bg.png".into(), Arc::new(png));
    for kind in ["tile", "frame"] {
        d.settings.page_picture = Some(ew_doc::PagePicture { media: "bg.png".into(), fill_type: kind.into(), title: String::new() });
        let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
        let img = render_page(&d, &l.pages[0], 1.0, &RenderOptions::default());
        let i = ((300 * img.width + 300) * 4) as usize;
        assert_eq!(&img.pixels[i..i + 3], &[10, 200, 30], "{kind}");
    }
    // An undecodable picture leaves the paper alone.
    d.media.insert("bg.png".into(), Arc::new(b"junk".to_vec()));
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let img = render_page(&d, &l.pages[0], 1.0, &RenderOptions::default());
    assert_eq!(&img.pixels[0..3], &[255, 255, 255]);
}

/// Read Mode's Page Color: the reading paper replaces the document's page color and page
/// picture on screen, in the raster and under the caret; the text keeps its color on Sepia.
#[test]
fn read_paper_replaces_the_page_background() {
    let mut png = Vec::new();
    image::RgbaImage::from_pixel(8, 8, image::Rgba([10, 200, 30, 255]))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let mut d = Document::from_text("Hello EasyWriter");
    d.media.insert("bg.png".into(), Arc::new(png));
    d.settings.page_color = Some(Rgb(0x10, 0x10, 0x40));
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let page = &l.pages[0];
    let at = |img: &Rendered, x: u32, y: u32| {
        let i = ((y * img.width + x) * 4) as usize;
        [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]]
    };
    let sepia = RenderOptions { paint: PaintOptions { read_paper: Some(SEPIA_PAPER), ..Default::default() }, ..Default::default() };
    let white = RenderOptions { paint: PaintOptions { read_paper: Some(Rgb::WHITE), ..Default::default() }, ..Default::default() };
    assert_eq!(at(&render_page(&d, page, 1.0, &RenderOptions::default()), 5, 5), [0x10, 0x10, 0x40], "the page color");
    assert_eq!(at(&render_page(&d, page, 1.0, &sepia), 5, 5), [0xE2, 0xD9, 0xD0]);
    assert_eq!(at(&render_page(&d, page, 1.0, &white), 5, 5), [255, 255, 255]);
    assert_eq!(background_at(&d, page, &sepia, 5.0, 5.0), SEPIA_PAPER);
    assert_eq!(background_at(&d, page, &white, 5.0, 5.0), Rgb::WHITE);
    let inverse = RenderOptions { paint: PaintOptions { read_paper: Some(Rgb::WHITE), dark: true, ..Default::default() }, ..Default::default() };
    assert_eq!(background_at(&d, page, &inverse, 5.0, 5.0), Rgb(DARK_PAPER, DARK_PAPER, DARK_PAPER));
    d.settings.page_picture = Some(ew_doc::PagePicture { media: "bg.png".into(), fill_type: "tile".into(), title: String::new() });
    assert_eq!(at(&render_page(&d, page, 1.0, &RenderOptions::default()), 300, 300), [10, 200, 30], "the page picture");
    assert_eq!(at(&render_page(&d, page, 1.0, &sepia), 300, 300), [0xE2, 0xD9, 0xD0]);
    // The text is drawn in its own color on sepia paper: its darkest pixel is within 8 levels of its value on white.
    d.settings.page_picture = None;
    d.settings.page_color = None;
    let darkest = |img: &Rendered| img.pixels.chunks(4).map(|p| p[0].min(p[1]).min(p[2])).min().unwrap_or(255);
    let plain = render_page(&d, page, 2.0, &RenderOptions::default());
    let on_sepia = render_page(&d, page, 2.0, &sepia);
    assert!(darkest(&plain) < 0x40 && darkest(&on_sepia) <= darkest(&plain) + 8, "{} {}", darkest(&plain), darkest(&on_sepia));
}

#[test]
fn dimmed_header_image_renders() {
    let mut d = Document::from_text("body");
    let mut png = Vec::new();
    image::RgbaImage::from_pixel(4, 4, image::Rgba([200, 0, 0, 255])).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    let media = d.add_media(png, "png");
    let mut hp = ew_doc::Paragraph::new();
    let obj = ew_doc::para::Picture {
        media,
        w: 40.0,
        h: 40.0,
        alt: String::new(),
        float: Default::default(),
        crop: [0.0; 4],
        ole: None,
        ..Default::default()
    }.build();
    hp.insert_object(0, obj, &Default::default()).unwrap();
    let id = d.add_part(ew_doc::PartKind::Header, vec![ew_doc::para_block(hp)]);
    d.last_section.headers.default = Some(id);
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let opts = RenderOptions::default();
    assert!(opts.display.dim_header);
    let img = render_page(&d, &l.pages[0], 1.0, &opts);
    assert!(!img.to_png().is_empty());
}

/// #2892: a rule is stroked with flat ends, as the PDF export and Word draw them. Round caps
/// used to stick half the width out past every end — a blob over the neighbouring border at
/// each corner of a table with thick borders, while the exported PDF had square corners.
#[test]
fn a_thick_rule_ends_flat_not_round() {
    let d = Document::new();
    let rule = |stroke| Draw::Line { x0: 10.0, y0: 10.0, x1: 30.0, y1: 10.0, width: 8.0, color: Rgb::BLACK, stroke, alpha: 1.0, text_bg: None };
    let shot = |stroke| render_items(&d, &[rule(stroke)], ew_geom::Rect::new(0.0, 0.0, 40.0, 20.0), 1.0, &RenderOptions::default());
    let ink = |img: &Rendered, x: u32, y: u32| img.pixel(x, y)[3] > 128;
    // An 8 pt rule from x=10 to x=30 covers y 6..14, and nothing beyond either end.
    let img = shot(Stroke::Solid);
    assert!(ink(&img, 15, 10), "the rule itself is drawn");
    assert!(!ink(&img, 6, 10) && !ink(&img, 33, 10), "no round cap past x=10 or x=30");
    // The double style's two strands end flat as well: its upper strand is centred on y=2.8
    // with a 4.8 pt width, so x=31 lies in the half-disc a round cap would add.
    let img = shot(Stroke::Double);
    assert!(ink(&img, 15, 3), "the double rule's upper strand is drawn");
    assert!(!ink(&img, 31, 3), "the upper strand ends at x=30");
}

/// A dimmed header is its full-strength picture faded once, as Word dims it: where a header
/// table's borders meet they are the tone of the borders, not darker.
#[test]
fn dimmed_header_borders_dont_darken_where_they_meet() {
    let mut d = Document::from_text("");
    let t = ew_doc::Table::new(2, 2, 200.0);
    let blocks = vec![std::sync::Arc::new(ew_doc::Block::Table(t)), ew_doc::para_block(ew_doc::Paragraph::new())];
    let id = d.add_part(ew_doc::PartKind::Header, blocks);
    d.last_section.headers.default = Some(id);
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let render = |dim_header: bool| {
        let mut opts = RenderOptions::default();
        opts.display.dim_header = dim_header;
        render_page(&d, &l.pages[0], 3.0, &opts)
    };
    let (full, dim) = (render(false), render(true));
    let mut ink = 0;
    for y in 0..full.height {
        for x in 0..full.width {
            let (f, g) = (full.pixel(x, y)[0] as f32, dim.pixel(x, y)[0] as f32);
            ink += usize::from(f < 128.0);
            let want = 255.0 - 0.45 * (255.0 - f);
            assert!((g - want).abs() <= 2.0, "({x}, {y}): {g} dimmed, {want} wanted ({f} at full strength)");
        }
    }
    assert!(ink > 100, "the borders are drawn: {ink}");
}

/// #2946: a dimmed header's items are faded as one group, so two of its lines that cross come
/// out the same tone as the lines themselves, and so does a border two cells share. Faded item
/// by item, the crossing kept 0.55² of the background instead of 0.55, and a shared border read
/// darker than the outer ones.
#[test]
fn dimmed_header_borders_keep_one_tone_where_they_meet() {
    let mut d = Document::from_text("Body");
    // Two rows and two columns: the middle border is drawn by both cells beside it, and a cell's
    // top and left rules cross at its top-left corner.
    let header = vec![std::sync::Arc::new(ew_doc::Block::Table(ew_doc::Table::new(2, 2, 300.0)))];
    let id = d.add_part(ew_doc::PartKind::Header, header);
    d.last_section.headers.default = Some(id);
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let page = &l.pages[0];
    let rules: Vec<(f32, f32, f32, f32)> = page
        .header
        .iter()
        .filter_map(|it| if let crate::Placed::Rule { x0, y0, x1, y1, .. } = it { Some((*x0, *y0, *x1, *y1)) } else { None })
        .collect();
    let (vx, vy0, _, vy1) = *rules.iter().filter(|(x0, _, x1, _)| x0 == x1).min_by(|a, b| a.0.total_cmp(&b.0)).expect("a vertical rule");
    let (hx0, hy, hx1, _) = *rules.iter().find(|(_, y0, _, y1)| y0 == y1 && (y0 - vy0).abs() < 0.01).expect("the horizontal rule at the cell's top");
    assert!(hx0 <= vx && vx <= hx1 && vy0 <= hy && hy <= vy1, "the rules cross: ({hx0}, {hy}, {hx1}) across ({vx}, {vy0}, {vy1})");
    let bottom = rules.iter().filter(|(_, y0, _, y1)| y0 == y1).map(|(_, y, _, _)| *y).fold(f32::NEG_INFINITY, f32::max);
    let row = hy + (bottom - hy) * 0.25; // inside the first row, clear of any rule across it
    // The darkest pixel in a small box: the tone of a line, however it is antialiased.
    let scale = 8.0;
    let darkest = |img: &Rendered, cx: f32, cy: f32| {
        let (px, py) = ((cx * scale) as i64, (cy * scale) as i64);
        (px - 2..=px + 2)
            .flat_map(|x| (py - 2..=py + 2).map(move |y| (x, y)))
            .filter(|(x, y)| *x >= 0 && *y >= 0)
            .map(|(x, y)| img.pixel(x as u32, y as u32)[0])
            .min()
            .expect("a pixel")
    };
    let dimmed = render_page(&d, page, scale, &RenderOptions::default());
    let undimmed = RenderOptions { display: DisplayOptions { dim_header: false, ..Default::default() }, ..Default::default() };
    let undimmed = render_page(&d, page, scale, &undimmed);
    // One border, well clear of any crossing or shared edge: the tone the others must keep.
    let line = darkest(&dimmed, vx + 30.0, hy);
    assert!(line > 0, "the dimmed border is drawn, faded: {line}");
    assert_eq!(darkest(&dimmed, vx, hy), line, "the crossing is darker than the line");
    assert_eq!(darkest(&dimmed, hx0 + 150.0, row), line, "a shared border is darker than the outer ones");
    assert_eq!(darkest(&undimmed, vx, hy), darkest(&undimmed, vx + 30.0, hy), "undimmed too");
    assert!(darkest(&undimmed, vx + 30.0, hy) < line, "the header is faded");
}

#[test]
fn dark_page_inverts_lightness() {
    assert_eq!(invert_lightness(Rgb::WHITE), Rgb::BLACK);
    assert_eq!(invert_lightness(Rgb::BLACK), Rgb::WHITE);
    // Pure hues keep their colour; dark blue turns light blue.
    assert_eq!(invert_lightness(Rgb(255, 0, 0)), Rgb(255, 0, 0));
    assert_eq!(invert_lightness(Rgb(0, 0, 0x80)), Rgb(0x7F, 0x7F, 0xFF));
    let d = Document::from_text("Hello EasyWriter");
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let opts = RenderOptions { paint: PaintOptions { dark: true, ..Default::default() }, ..Default::default() };
    assert_eq!(opts.paint.ink(Rgb::WHITE), Rgb(DARK_PAPER, DARK_PAPER, DARK_PAPER));
    assert_eq!(opts.paint.ink(Rgb::BLACK), Rgb::WHITE);
    let img = render_page(&d, &l.pages[0], 1.0, &opts);
    assert_eq!(img.pixel(5, 5), [DARK_PAPER, DARK_PAPER, DARK_PAPER, 255]);
    let light = (72..300).flat_map(|x| (72..100).map(move |y| (x, y))).filter(|(x, y)| img.pixel(*x, *y)[0] > 128).count();
    assert!(light > 30, "light {light}");
}

/// #2534: legacy font effects are drawn: outlined letters are hollow; shadowed and embossed
/// ones have a grey copy down-right, imprinted ones up-left.
#[test]
fn legacy_font_effects_are_drawn() {
    use ew_doc::CharProps;
    use ew_doc::wordart::{TextEffects, TextFill};
    const SIZE: f32 = 40.0;
    const SCALE: f32 = 2.0;
    const MIN_DIRECTION_PIXELS: usize = 100;
    let shot = |c: CharProps, offset: f32| {
        let mut d = Document::from_text("x");
        let cp = CharProps { size: Some(SIZE), bold: Some(true), ..c };
        d.body = vec![ew_doc::para_block(ew_doc::Paragraph::with_text("HHHH", cp))];
        let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
        render_area(&d, &l.pages[0], ew_geom::Rect::new(-offset, -offset, 400.0, 150.0), SCALE, &RenderOptions::default())
    };
    let counts = |img: &Rendered| {
        let (mut dark, mut grey) = (0usize, 0usize);
        for (x, y) in (100..800).flat_map(|x| (100..300).map(move |y| (x, y))) {
            let v = img.pixel(x, y)[0];
            dark += usize::from(v < 60);
            grey += usize::from((120..=136).contains(&v));
        }
        (dark, grey)
    };
    let (plain_dark, plain_grey) = counts(&shot(CharProps::default(), 0.0));
    assert!(plain_dark > 2000, "plain {plain_dark}");
    let (dark, _) = counts(&shot(CharProps { outline: Some(true), ..Default::default() }, 0.0));
    assert!(dark < plain_dark / 3, "outline is hollow: {dark} vs {plain_dark}");
    // An explicit fill keeps the reference on the same Art path as legacy effects.
    let reference = || CharProps {
        text_effects: Some(Box::new(TextEffects { fill: Some(TextFill::Solid { color: Rgb::BLACK, transparency: 0.0 }), ..Default::default() })),
        ..Default::default()
    };
    let base = shot(reference(), 0.0);
    for (c, sign) in [
        (CharProps { shadow: Some(true), ..Default::default() }, 1.0),
        (CharProps { emboss: Some(true), ..Default::default() }, 1.0),
        (CharProps { engrave: Some(true), ..Default::default() }, -1.0),
    ] {
        let img = shot(c, 0.0);
        let (_, grey) = counts(&img);
        assert!(grey > plain_grey * 2, "a grey copy: {grey} vs {plain_grey}");
        // A 2pt diagonal displacement at 40pt has sqrt(2)pt on each axis.
        // Check the visible copy against its translated mask, accounting for occlusion.
        let offset = sign * std::f32::consts::SQRT_2;
        let expected = shot(reference(), offset);
        let opposite = shot(reference(), -offset);
        let (mut visible, mut directional) = (0usize, 0usize);
        for (x, y) in (100..800).flat_map(|x| (100..300).map(move |y| (x, y))) {
            let v = img.pixel(x, y)[0];
            if !(120..=136).contains(&v) || base.pixel(x, y)[0] != 255 {
                continue;
            }
            visible += 1;
            assert!(expected.pixel(x, y)[0] < 255, "grey outside translated Art mask: sign {sign}, pixel {x},{y}");
            directional += usize::from(expected.pixel(x, y)[0] < 60 && opposite.pixel(x, y)[0] == 255);
        }
        assert!(directional > MIN_DIRECTION_PIXELS, "directional grey: sign {sign}, {directional} of {visible}");
        eprintln!("spatial shadow sign={sign} grey={grey} visible={visible} directional={directional}");
    }
}

/// A document whose only text is a yellow-highlighted run.
fn yellow_highlight_doc() -> (Document, crate::DocLayout) {
    let cp = ew_doc::CharProps { highlight: Some(ew_doc::props::Highlight::Yellow), size: Some(24.0), ..Default::default() };
    let mut d = Document::from_text("x");
    d.body = vec![ew_doc::para_block(ew_doc::Paragraph::with_text("HHHH HHHH", cp))];
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    (d, l)
}

/// #1252: on a dark page a highlight is drawn dimmed (keeping its hue) so the white text on it
/// reads; a light page is unchanged.
#[test]
fn dark_page_dims_a_highlight_raster() {
    let (d, l) = yellow_highlight_doc();
    let items = page_display(&d, &l.pages[0], &DisplayOptions::default());
    let r = items
        .iter()
        .find_map(|i| match i {
            Draw::Fill { rect, color, .. } if *color == Rgb(255, 255, 0) => Some(*rect),
            _ => None,
        })
        .unwrap();
    // Just inside the top-left corner of the highlight: above the capitals, so pure background.
    let (px, py) = ((r.x + 1.5) as u32, (r.y + 1.5) as u32);
    let light = render_page(&d, &l.pages[0], 1.0, &RenderOptions::default());
    assert_eq!(light.pixel(px, py), [255, 255, 0, 255], "light page keeps bright yellow");
    let dark = render_page(&d, &l.pages[0], 1.0, &RenderOptions { paint: PaintOptions { dark: true, ..Default::default() }, ..Default::default() });
    let [r8, g8, b8, _] = dark.pixel(px, py);
    assert!(r8 < 0x60 && g8 < 0x60, "dark page highlight is dim, got {:?}", (r8, g8, b8));
    assert!(r8.abs_diff(g8) <= 4 && g8 > b8.saturating_add(0x20), "dark page highlight stays yellow in hue, got {:?}", (r8, g8, b8));
}

/// #1252 review: an Automatic underline on a dark highlight (black) draws light on a dark page,
/// like the text it underlines, not the dark grey plain inversion gives white.
#[test]
fn dark_page_underline_on_a_dark_highlight_reads() {
    use ew_doc::props::{Highlight, Underline};
    let cp =
        ew_doc::CharProps { highlight: Some(Highlight::Black), underline: Some(Underline::Thick), size: Some(24.0), ..Default::default() };
    let mut d = Document::from_text("x");
    d.body = vec![ew_doc::para_block(ew_doc::Paragraph::with_text("HHHH HHHH", cp))];
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let items = page_display(&d, &l.pages[0], &DisplayOptions::default());
    let (x0, x1, y, w) = items
        .iter()
        .find_map(|i| match i {
            Draw::Line { x0, x1, y0, width, .. } => Some((*x0, *x1, *y0, *width)),
            _ => None,
        })
        .unwrap();
    assert!(w >= 1.5, "thick underline {w}");
    let (px, py) = (((x0 + x1) / 2.0) as u32, y.round() as u32);
    let dark = render_page(&d, &l.pages[0], 4.0, &RenderOptions { paint: PaintOptions { dark: true, ..Default::default() }, ..Default::default() });
    let [r8, g8, b8, _] = dark.pixel(px * 4, py * 4);
    assert!(r8 > 0xC0 && g8 > 0xC0 && b8 > 0xC0, "underline draws light, got {:?}", (r8, g8, b8));
}

/// #2534 review: Automatic text with a legacy shadow (drawn from its outlines) on a black
/// highlight draws light on a dark page, like plain text does, not dark grey on near-black.
#[test]
fn dark_page_shadowed_text_on_a_dark_highlight_reads() {
    use ew_doc::props::Highlight;
    let cp = ew_doc::CharProps { highlight: Some(Highlight::Black), shadow: Some(true), size: Some(24.0), ..Default::default() };
    let mut d = Document::from_text("x");
    d.body = vec![ew_doc::para_block(ew_doc::Paragraph::with_text("HHHH HHHH", cp))];
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let items = page_display(&d, &l.pages[0], &DisplayOptions::default());
    let b = items
        .iter()
        .find_map(|i| match i {
            Draw::Art { path, text_bg, .. } => {
                assert!(text_bg.is_some(), "the run's highlight is the letters' background");
                crate::wordart::path_box(path)
            }
            _ => None,
        })
        .unwrap();
    let dark = render_page(&d, &l.pages[0], 2.0, &RenderOptions { paint: PaintOptions { dark: true, ..Default::default() }, ..Default::default() });
    let light = (b.x0 as u32 * 2..b.x1 as u32 * 2)
        .flat_map(|x| (b.y0 as u32 * 2..b.y1 as u32 * 2).map(move |y| (x, y)))
        .filter(|&(x, y)| dark.pixel(x, y)[..3].iter().all(|&v| v > 0xE0))
        .count();
    assert!(light > 200, "letters draw light, {light} light pixels");
}

/// One EMF record: type, size, payload (a multiple of 4 bytes).
fn emf_rec(typ: u32, payload: &[u8]) -> Vec<u8> {
    let mut v = typ.to_le_bytes().to_vec();
    v.extend(((8 + payload.len()) as u32).to_le_bytes());
    v.extend(payload);
    v
}

fn le32(vals: &[i32]) -> Vec<u8> {
    vals.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// A 25 mm square EMF (device units 0.04 per 0.01 mm, so 100 device units) with a red rectangle over
/// its right half.
fn red_right_half_emf() -> Vec<u8> {
    let mut h = vec![0u8; 88];
    h[0..4].copy_from_slice(&1u32.to_le_bytes());
    h[4..8].copy_from_slice(&88u32.to_le_bytes());
    h[8..24].copy_from_slice(&le32(&[0, 0, 100, 100]));
    h[24..40].copy_from_slice(&le32(&[0, 0, 2500, 2500]));
    h[40..44].copy_from_slice(&0x464D_4520u32.to_le_bytes());
    h[72..88].copy_from_slice(&le32(&[1000, 1000, 250, 250]));
    let brush = emf_rec(39, &le32(&[1, 0, 0x0000_00FF, 0]));
    let select = emf_rec(37, &le32(&[1]));
    let rect = emf_rec(43, &le32(&[50, 0, 100, 100]));
    let eof = emf_rec(14, &[0; 12]);
    [h, brush, select, rect, eof].concat()
}

#[test]
fn metafile_picture_is_drawn_as_vectors() {
    let mut d = Document::new();
    let media = d.add_media(red_right_half_emf(), "emf");
    let mut p = ew_doc::Paragraph::new();
    let obj = ew_doc::para::Picture {
        media,
        w: 70.0,
        h: 70.0,
        alt: String::new(),
        float: Default::default(),
        crop: [0.0; 4],
        ole: None,
        ..Default::default()
    }.build();
    p.insert_object(0, obj, &Default::default()).unwrap();
    d.body = vec![ew_doc::para_block(p)];
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let opts = RenderOptions::default();
    let rect = page_display(&d, &l.pages[0], &opts.display)
        .iter()
        .find_map(|i| match i {
            Draw::Image { rect, .. } => Some(*rect),
            _ => None,
        })
        .expect("a picture on the page");
    let img = render_page(&d, &l.pages[0], 1.0, &opts);
    let y = (rect.y + rect.h / 2.0) as u32;
    let right = img.pixel((rect.x + rect.w * 0.75) as u32, y);
    let left = img.pixel((rect.x + rect.w * 0.25) as u32, y);
    assert!(right[0] > 200 && right[1] < 60 && right[2] < 60, "right half should be red: {right:?}");
    assert!(left[..3].iter().all(|c| *c > 200), "left half should be paper, not the grey box: {left:?}");
}

/// #1899: a crop that keeps a sliver of the picture (3% here; a header's bar can be 2.7% of a
/// page-sized metafile) stretches that sliver over the frame, as the file says, for vector and
/// bitmap pictures alike. Both pictures are paper on the left half and red on the right.
#[test]
fn a_crop_keeping_a_sliver_fills_the_frame_with_it() {
    let mut png = Vec::new();
    image::RgbaImage::from_fn(100, 100, |x, _| image::Rgba(if x >= 50 { [255, 0, 0, 255] } else { [255; 4] }))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    for (bytes, ext) in [(red_right_half_emf(), "emf"), (png, "png")] {
        // (crop, where in the frame, red?): 47–50% of the source is all paper; 50–53% all red.
        for (crop, at, red) in [([0.47, 0.47, 0.5, 0.5], 0.7, false), ([0.5, 0.47, 0.47, 0.5], 0.3, true)] {
            let mut d = Document::new();
            let media = d.add_media(bytes.clone(), ext);
            let mut p = ew_doc::Paragraph::new();
            let obj =
                ew_doc::para::Picture { media, w: 70.0, h: 70.0, alt: String::new(), float: Default::default(), crop, ole: None, ..Default::default() }.build();
            p.insert_object(0, obj, &Default::default()).unwrap();
            d.body = vec![ew_doc::para_block(p)];
            let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
            let opts = RenderOptions::default();
            let rect = page_display(&d, &l.pages[0], &opts.display)
                .iter()
                .find_map(|i| match i {
                    Draw::Image { rect, .. } => Some(*rect),
                    _ => None,
                })
                .expect("a picture on the page");
            let img = render_page(&d, &l.pages[0], 1.0, &opts);
            let px = img.pixel((rect.x + rect.w * at) as u32, (rect.y + rect.h * at) as u32);
            let is_red = px[0] > 200 && px[1] < 60 && px[2] < 60;
            let is_paper = px[..3].iter().all(|c| *c > 200);
            assert!(if red { is_red } else { is_paper }, "{ext} crop {crop:?} at {at}: {px:?}");
        }
    }
}

#[test]
fn cosmetic_metafile_pen_is_one_device_pixel_wide() {
    // MOVETO (0, 50), LINETO (100, 50) with the default cosmetic black pen: a hairline across the middle.
    let mut emf = red_right_half_emf()[..88].to_vec();
    emf.extend([emf_rec(27, &le32(&[0, 50])), emf_rec(54, &le32(&[100, 50])), emf_rec(14, &[0; 12])].concat());
    let mut d = Document::new();
    let media = d.add_media(emf, "emf");
    let mut p = ew_doc::Paragraph::new();
    let obj = ew_doc::para::Picture {
        media,
        w: 70.0,
        h: 70.0,
        alt: String::new(),
        float: Default::default(),
        crop: [0.0; 4],
        ole: None,
        ..Default::default()
    }.build();
    p.insert_object(0, obj, &Default::default()).unwrap();
    d.body = vec![ew_doc::para_block(p)];
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let opts = RenderOptions::default();
    let rect = page_display(&d, &l.pages[0], &opts.display)
        .iter()
        .find_map(|i| match i {
            Draw::Image { rect, .. } => Some(*rect),
            _ => None,
        })
        .expect("a picture on the page");
    let scale = 2.0;
    let img = render_page(&d, &l.pages[0], scale, &opts);
    let (x, y) = (((rect.x + rect.w / 2.0) * scale) as u32, ((rect.y + rect.h / 2.0) * scale) as u32);
    let darkest = (y - 3..=y + 3).map(|y| img.pixel(x, y)[0]).min().unwrap_or(255);
    // A 0.1 pt line would cover a fifth of a pixel (about 204); one device pixel covers at least half of one.
    assert!(darkest < 140, "the hairline should be clearly visible: {darkest}");
}

/// #1764: an EMF picture's text (EXTCREATEFONTINDIRECTW, SELECTOBJECT, SETTEXTCOLOR, EXTTEXTOUTW)
/// is painted, not dropped.
#[test]
fn metafile_text_records_are_painted() {
    let mut font = emf_rec(82, &le32(&[1, -20, 0, 0, 0, 700, 0, 0]));
    let mut name: Vec<u8> = "Arial".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    name.resize(64, 0);
    font.extend(name);
    font[4..8].copy_from_slice(&104u32.to_le_bytes());
    // "WWWW" at (5, 40), top-aligned, no dx array.
    let mut text = emf_rec(84, &le32(&[0, 0, 100, 100, 1, 0, 0, 5, 40, 4, 76, 0, 0, 0, 0, 0, 0]));
    text.extend("WWWW".encode_utf16().flat_map(|u| u.to_le_bytes()));
    text[4..8].copy_from_slice(&84u32.to_le_bytes());
    let mut emf = red_right_half_emf()[..88].to_vec();
    emf.extend([font, emf_rec(37, &le32(&[1])), emf_rec(24, &le32(&[0])), text, emf_rec(14, &[0; 12])].concat());
    let mut d = Document::new();
    let media = d.add_media(emf, "emf");
    let mut p = ew_doc::Paragraph::new();
    let obj = ew_doc::para::Picture {
        media,
        w: 70.0,
        h: 70.0,
        alt: String::new(),
        float: Default::default(),
        crop: [0.0; 4],
        ole: None,
        ..Default::default()
    }.build();
    p.insert_object(0, obj, &Default::default()).unwrap();
    d.body = vec![ew_doc::para_block(p)];
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let opts = RenderOptions::default();
    let rect = page_display(&d, &l.pages[0], &opts.display)
        .iter()
        .find_map(|i| match i {
            Draw::Image { rect, .. } => Some(*rect),
            _ => None,
        })
        .expect("a picture on the page");
    let scale = 2.0;
    let img = render_page(&d, &l.pages[0], scale, &opts);
    let (x0, y0) = ((rect.x * scale) as u32, (rect.y * scale) as u32);
    let (x1, y1) = (((rect.x + rect.w) * scale) as u32, ((rect.y + rect.h) * scale) as u32);
    let dark = (y0..y1).flat_map(|y| (x0..x1).map(move |x| (x, y))).filter(|&(x, y)| img.pixel(x, y)[0] < 100).count();
    assert!(dark > 50, "the text is painted inside the picture: {dark} dark pixels");
}

#[test]
fn unreadable_metafile_keeps_the_grey_box() {
    let mut d = Document::new();
    // The header alone has no records, so the metafile does not parse.
    let media = d.add_media(red_right_half_emf()[..88].to_vec(), "emf");
    let mut p = ew_doc::Paragraph::new();
    let obj = ew_doc::para::Picture {
        media,
        w: 70.0,
        h: 70.0,
        alt: String::new(),
        float: Default::default(),
        crop: [0.0; 4],
        ole: None,
        ..Default::default()
    }.build();
    p.insert_object(0, obj, &Default::default()).unwrap();
    d.body = vec![ew_doc::para_block(p)];
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let opts = RenderOptions::default();
    let rect = page_display(&d, &l.pages[0], &opts.display)
        .iter()
        .find_map(|i| match i {
            Draw::Image { rect, .. } => Some(*rect),
            _ => None,
        })
        .expect("a picture on the page");
    let img = render_page(&d, &l.pages[0], 1.0, &opts);
    assert_eq!(img.pixel((rect.x + rect.w / 2.0) as u32, (rect.y + rect.h / 2.0) as u32), [0xD0, 0xD0, 0xD0, 255]);
}

#[test]
fn dashed_outline_has_gaps() {
    use ew_doc::{
        connector::ShapeExtra,
        line_dash::LineDash,
        para::{Anchor, Float, InlineObject, Wrap},
    };
    let image = |dash| {
        let shape = InlineObject::Shape {
            kind: ShapeKind::Rectangle,
            w: 70.0,
            h: 28.0,
            fill: None,
            stroke: Some(Rgb(192, 0, 0)),
            stroke_width: 1.0,
            float: Float { wrap: Wrap::InFrontOfText, h_rel: Anchor::Page, v_rel: Anchor::Page, x: 100.0, y: 100.0, ..Default::default() },
            story: None,
            freeform: None,
            effects: Default::default(),
            extra: ShapeExtra { dash, ..Default::default() },
        };
        let mut p = ew_doc::Paragraph::new();
        p.insert_object(0, shape, &Default::default()).unwrap();
        let mut d = Document::new();
        d.body = vec![ew_doc::para_block(p)];
        let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
        render_page(&d, &l.pages[0], 4.0, &RenderOptions::default())
    };
    let solid = image(LineDash::Solid);
    let dashed = image(LineDash::Dash);
    assert!(solid.pixel(422, 400)[1] < 80);
    assert_eq!(dashed.pixel(422, 400), [255, 255, 255, 255]);
    assert!(dashed.pixel(406, 400)[1] < 80);
}

/// Distinguish flat, square and round endpoints for both preset lines and connector paths.
#[test]
fn shape_line_caps_reach_the_screen() {
    use ew_doc::{
        connector::{LineCap, ShapeExtra},
        para::{Anchor, Float, InlineObject, Wrap},
    };
    // A preset line uses Draw::Shape; a straight connector uses Draw::Path.
    for kind in [ShapeKind::Line, ShapeKind::StraightConnector] {
        for cap in [LineCap::Flat, LineCap::Square, LineCap::Round] {
            let shape = InlineObject::Shape {
                kind,
                w: 40.0,
                h: 0.0,
                fill: None,
                stroke: Some(Rgb::BLACK),
                stroke_width: 10.0,
                float: Float { wrap: Wrap::InFrontOfText, h_rel: Anchor::Page, v_rel: Anchor::Page, x: 100.0, y: 100.0, ..Default::default() },
                story: None,
                freeform: None,
                effects: Default::default(),
                extra: ShapeExtra { cap, ..Default::default() },
            };
            let mut p = ew_doc::Paragraph::new();
            p.insert_object(0, shape, &Default::default()).unwrap();
            let mut d = Document::new();
            d.body = vec![ew_doc::para_block(p)];
            let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
            let image = render_page(&d, &l.pages[0], 4.0, &RenderOptions::default());
            let painted = |x, y| image.pixel(x, y)[0] < 80;
            assert!(painted(404, 400), "line interior: {kind:?} {cap:?}");
            assert_eq!(painted(388, 400), cap != LineCap::Flat, "past the endpoint: {kind:?} {cap:?}");
            assert_eq!(painted(384, 384), cap == LineCap::Square, "square corner: {kind:?} {cap:?}");
        }
    }
}

#[test]
fn zero_width_connector_dashes() {
    use ew_doc::{
        connector::ShapeExtra,
        line_dash::LineDash,
        para::{Anchor, Float, InlineObject, Wrap},
    };
    let shape = InlineObject::Shape {
        kind: ShapeKind::ElbowConnector,
        w: 70.0,
        h: 28.0,
        fill: None,
        stroke: Some(Rgb(192, 0, 0)),
        stroke_width: 0.0,
        float: Float { wrap: Wrap::InFrontOfText, h_rel: Anchor::Page, v_rel: Anchor::Page, x: 100.0, y: 100.0, ..Default::default() },
        story: None,
        freeform: None,
        effects: Default::default(),
        extra: ShapeExtra { dash: LineDash::Dash, ..Default::default() },
    };
    let mut p = ew_doc::Paragraph::new();
    p.insert_object(0, shape, &Default::default()).unwrap();
    let mut d = Document::new();
    d.body = vec![ew_doc::para_block(p)];
    let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
    let image = render_page(&d, &l.pages[0], 8.0, &RenderOptions::default());
    // A 0.75 pt stroke has a 3 pt dash followed by a 2.25 pt gap.
    assert!(image.pixel(812, 800)[1] < 80, "inside the first dash");
    assert_eq!(image.pixel(832, 800), [255, 255, 255, 255], "inside the first gap");
}

/// A rounded rectangle laid out and rendered: its corner pixel is painted when the corner is
/// square, left white with the default corner; turned a quarter, the same.
#[test]
fn rendered_rounded_rectangles_follow_their_corner() {
    use ew_doc::para::{Anchor, Float, ShapeKind, Wrap};
    let rendered = |corner: Option<u32>, rot: f32| {
        let float = Float { wrap: Wrap::InFrontOfText, h_rel: Anchor::Page, v_rel: Anchor::Page, x: 100.0, y: 100.0, rot, ..Default::default() };
        let shape = ew_doc::para::InlineObject::Shape {
            kind: ShapeKind::RoundedRectangle,
            w: 200.0,
            h: 200.0,
            fill: Some(ew_doc::fill::Fill::solid(ew_doc::props::Rgb(0, 0, 0))),
            stroke: None,
            stroke_width: 0.0,
            float,
            story: None,
            freeform: None,
            effects: Default::default(),
            extra: ew_doc::connector::ShapeExtra { corner, ..Default::default() },
        };
        let mut p = ew_doc::Paragraph::new();
        p.insert_object(0, shape, &Default::default()).unwrap();
        let mut d = Document::new();
        d.body = vec![ew_doc::para_block(p)];
        let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions::default());
        render_page(&d, &l.pages[0], 1.0, &RenderOptions::default())
    };
    for rot in [0.0, 90.0] {
        // 3 pt in from the frame's top-left corner, and its middle.
        let (corner, middle) = ((103, 103), (200, 200));
        let square = rendered(Some(0), rot);
        assert_eq!(square.pixel(corner.0, corner.1)[0], 0, "square corner, turned {rot}");
        let rounded = rendered(None, rot);
        assert_eq!(rounded.pixel(corner.0, corner.1)[0], 255, "default corner, turned {rot}");
        assert_eq!(rounded.pixel(middle.0, middle.1)[0], 0, "filled, turned {rot}");
    }
}
