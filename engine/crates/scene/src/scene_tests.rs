//! The renderer's contract (docs/plans/engine/viewport-design.md section 3) on hand-made lists: paths with fill rules,
//! pens, gradient, picture and pattern fills, groups (transform, clip, opacity, blend, effects), layers composited as a
//! unit, tiles, blank tiles, greeking, damage, the list cache and hit testing.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use super::*;

const RED: Rgb = Rgb(255, 0, 0);
const BLUE: Rgb = Rgb(0, 0, 255);

fn square(x: f64, y: f64, s: f64) -> BezPath {
    kurbo::Rect::new(x, y, x + s, y + s).to_path(0.1)
}

fn filled(path: BezPath, rule: FillRule, c: Rgb) -> Draw {
    Draw::Vector(Box::new(VectorPath { path, rule, fill: Some(Paint::solid(c)), pen: None }))
}

/// `items` on a transparent 100 × 100 point surface.
fn clear(items: Vec<Draw>) -> DisplayList {
    DisplayList::new(100.0, 100.0, None, vec![Layer::of(items)])
}

fn paint(list: &DisplayList) -> Rendered {
    render_list(list, &NoMedia, 1.0, &PaintOptions::default())
}

/// A 2 × 1 PNG: red then blue.
fn red_blue_png() -> Vec<u8> {
    let img = image::RgbaImage::from_raw(2, 1, vec![255, 0, 0, 255, 0, 0, 255, 255]).unwrap();
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
    out
}

#[test]
fn fill_rules_decide_the_hole() {
    let mut ring = square(10.0, 10.0, 80.0);
    ring.extend(square(30.0, 30.0, 40.0));
    let nonzero = paint(&clear(vec![filled(ring.clone(), FillRule::NonZero, RED)]));
    let evenodd = paint(&clear(vec![filled(ring, FillRule::EvenOdd, RED)]));
    assert_eq!(nonzero.pixel(50, 50), [255, 0, 0, 255], "both squares wind the same way: non-zero fills the middle");
    assert_eq!(evenodd.pixel(50, 50)[3], 0, "even-odd leaves it empty");
    assert_eq!(evenodd.pixel(20, 20), [255, 0, 0, 255]);
}

#[test]
fn pens_have_caps_joins_and_dashes() {
    let mut line = BezPath::new();
    line.move_to((20.0, 50.0));
    line.line_to((80.0, 50.0));
    let stroked = |cap: Cap, dash: Vec<f32>| {
        let pen = Pen { cap, dash, ..Pen::solid(BLUE, 10.0) };
        paint(&clear(vec![Draw::Vector(Box::new(VectorPath { path: line.clone(), rule: FillRule::NonZero, fill: None, pen: Some(pen) }))]))
    };
    let butt = stroked(Cap::Butt, Vec::new());
    let square_cap = stroked(Cap::Square, Vec::new());
    assert_eq!(butt.pixel(17, 50)[3], 0, "a butt end stops at the end point");
    assert_eq!(square_cap.pixel(17, 50)[3], 255, "a square end reaches half the width past it");
    let dashed = stroked(Cap::Butt, vec![10.0, 10.0]);
    assert_eq!(dashed.pixel(25, 50)[3], 255, "a dash");
    assert_eq!(dashed.pixel(35, 50)[3], 0, "a gap");
    // A sharp corner: mitred it reaches past the bevel's corner.
    let mut corner = BezPath::new();
    corner.move_to((20.0, 80.0));
    corner.line_to((50.0, 20.0));
    corner.line_to((80.0, 80.0));
    let joined = |join| {
        let pen = Pen { join, miter: 10.0, ..Pen::solid(BLUE, 8.0) };
        paint(&clear(vec![Draw::Vector(Box::new(VectorPath { path: corner.clone(), rule: FillRule::NonZero, fill: None, pen: Some(pen) }))]))
    };
    assert!(joined(Join::Miter).pixel(50, 12)[3] > 128 && joined(Join::Bevel).pixel(50, 12)[3] == 0);
}

#[test]
fn gradients_pictures_and_patterns_fill_paths() {
    let grad = Paint::Linear { p0: (0.0, 0.0), p1: (100.0, 0.0), stops: vec![(0.0, Rgb::BLACK, 1.0), (1.0, Rgb::WHITE, 1.0)] };
    let g = paint(&clear(vec![Draw::Vector(Box::new(VectorPath { path: square(0.0, 0.0, 100.0), rule: FillRule::NonZero, fill: Some(grad), pen: None }))]));
    assert!(g.pixel(10, 50)[0] < 50 && g.pixel(90, 50)[0] > 200, "dark on the left, light on the right");

    let media: BTreeMap<String, Arc<Vec<u8>>> = BTreeMap::from([("rb".to_string(), Arc::new(red_blue_png()))]);
    let pic = |repeat: bool, w: f32| {
        let fill = Some(Paint::Image { media: "rb".into(), rect: [0.0, 0.0, w, 10.0], repeat });
        let list = clear(vec![Draw::Vector(Box::new(VectorPath { path: square(0.0, 0.0, 100.0), rule: FillRule::NonZero, fill, pen: None }))]);
        render_list(&list, &media, 1.0, &PaintOptions::default())
    };
    let stretched = pic(false, 100.0);
    assert!(stretched.pixel(10, 5)[0] > 200 && stretched.pixel(90, 5)[2] > 200, "red on the left half, blue on the right");
    let tiled = pic(true, 20.0);
    assert!(tiled.pixel(25, 5)[0] > 200 && tiled.pixel(35, 5)[2] > 200, "the second copy starts red again");
    assert!(tiled.pixel(25, 45)[0] > 200, "and repeats down");
    // A picture the media lookup lacks paints nothing.
    assert_eq!(render_list(&clear(vec![]), &NoMedia, 1.0, &PaintOptions::default()).pixel(5, 5)[3], 0);

    let dot = filled(square(0.0, 0.0, 5.0), FillRule::NonZero, RED);
    let fill = Some(Paint::Pattern { cell: [0.0, 0.0, 10.0, 10.0], items: vec![dot] });
    let p = paint(&clear(vec![Draw::Vector(Box::new(VectorPath { path: square(0.0, 0.0, 100.0), rule: FillRule::NonZero, fill, pen: None }))]));
    assert_eq!(p.pixel(42, 72), [255, 0, 0, 255], "each cell's corner square");
    assert_eq!(p.pixel(47, 77)[3], 0, "and the rest of the cell empty");
}

#[test]
fn groups_transform_clip_fade_and_blend() {
    let red = filled(square(0.0, 0.0, 20.0), FillRule::NonZero, RED);
    let moved = Group { transform: Affine::translate((50.0, 50.0)), ..Group::of(vec![red.clone()]) };
    let img = paint(&clear(vec![Draw::Group(Box::new(moved))]));
    assert_eq!(img.pixel(55, 55), [255, 0, 0, 255]);
    assert_eq!(img.pixel(5, 5)[3], 0);

    let clipped = Group { clip: Some((kurbo::Circle::new((10.0, 10.0), 5.0).to_path(0.1), FillRule::NonZero)), ..Group::of(vec![red.clone()]) };
    let img = paint(&clear(vec![Draw::Group(Box::new(clipped))]));
    assert_eq!(img.pixel(10, 10)[3], 255);
    assert_eq!(img.pixel(2, 2)[3], 0, "outside the clip");

    // Two overlapping squares faded as one group: where they overlap is no darker.
    let a = filled(square(0.0, 0.0, 40.0), FillRule::NonZero, BLUE);
    let b = filled(square(20.0, 0.0, 40.0), FillRule::NonZero, BLUE);
    let faded = Group { opacity: 0.5, ..Group::of(vec![a.clone(), b.clone()]) };
    let img = paint(&clear(vec![Draw::Group(Box::new(faded))]));
    assert!(img.pixel(10, 10)[3].abs_diff(img.pixel(30, 10)[3]) <= 1 && img.pixel(30, 10)[3].abs_diff(128) <= 2);

    // Yellow multiplied over cyan is green.
    let cyan = filled(square(0.0, 0.0, 50.0), FillRule::NonZero, Rgb(0, 255, 255));
    let yellow = Group { blend: Blend::Multiply, ..Group::of(vec![filled(square(0.0, 0.0, 50.0), FillRule::NonZero, Rgb(255, 255, 0))]) };
    let list = DisplayList::new(100.0, 100.0, Some(Rgb::WHITE), vec![Layer::of(vec![cyan, Draw::Group(Box::new(yellow))])]);
    assert_eq!(&paint(&list).pixel(25, 25)[..3], &[0, 255, 0]);
}

#[test]
fn layers_composite_as_a_unit() {
    let a = filled(square(0.0, 0.0, 40.0), FillRule::NonZero, Rgb::BLACK);
    let b = filled(square(20.0, 0.0, 40.0), FillRule::NonZero, Rgb::BLACK);
    let list = DisplayList::new(100.0, 100.0, Some(Rgb::WHITE), vec![Layer { opacity: 0.5, ..Layer::of(vec![a, b]) }]);
    let img = paint(&list);
    assert_eq!(img.pixel(10, 10), img.pixel(30, 10), "the overlap is not darker");
    assert!(img.pixel(10, 10)[0].abs_diff(128) <= 2);
}

#[test]
fn effects_draw_round_a_group() {
    let red = || filled(square(30.0, 30.0, 20.0), FillRule::NonZero, RED);
    let with = |e: Effect| {
        let g = Group { effects: vec![e], ..Group::of(vec![red()]) };
        paint(&clear(vec![Draw::Group(Box::new(g))]))
    };
    let plain = paint(&clear(vec![red()]));
    let shadow = with(Effect::Shadow { dx: 10.0, dy: 10.0, blur: 2.0, color: Rgb::BLACK, alpha: 1.0 });
    assert_eq!(shadow.pixel(40, 40), plain.pixel(40, 40), "the picture itself is unchanged");
    assert!(shadow.pixel(56, 56)[3] > 128 && shadow.pixel(56, 56)[0] < 60, "a dark shadow down and right");
    assert_eq!(shadow.pixel(26, 26)[3], 0, "none up and left");
    let glow = with(Effect::Glow { radius: 6.0, color: BLUE, alpha: 1.0 });
    assert!(glow.pixel(27, 40)[3] > 64 && glow.pixel(27, 40)[2] > 200, "a blue glow round it");
    let blur = with(Effect::Blur { radius: 4.0 });
    assert!(blur.pixel(28, 40)[3] > 0 && blur.pixel(31, 40)[3] < 255, "the edge spreads both ways");
    let soft = with(Effect::SoftEdge { radius: 8.0 });
    assert!(soft.pixel(31, 40)[3] < 128 && soft.pixel(40, 40)[3] > 200, "the edge fades, the middle stays");
    let reflected = with(Effect::Reflection { gap: 2.0, size: 1.0, alpha: 0.5, blur: 0.0 });
    assert!(reflected.pixel(40, 54)[3] > 64 && reflected.pixel(40, 54)[3] < 200, "a fainter copy below");
    assert_eq!(reflected.pixel(40, 80)[3], 0, "fading out within its height");
    // engine-fidelity-5: a blurred reflection's side edges spread both ways, where the sharp one stops at the picture's edge.
    let soft = with(Effect::Reflection { gap: 2.0, size: 1.0, alpha: 0.5, blur: 6.0 });
    assert_eq!(reflected.pixel(28, 60)[3], 0, "the sharp reflection ends at the picture's side");
    assert!(soft.pixel(28, 60)[3] > 0 && soft.pixel(32, 60)[3] < reflected.pixel(32, 60)[3], "the blurred one spreads past it");
    // EasyWriter engine-gaps-pictures: an inner shadow down and right darkens the bottom-right edges inside, as Word draws it,
    // and leaves the far side and the outside alone.
    let inner = with(Effect::InnerShadow { dx: 4.0, dy: 4.0, blur: 1.0, color: Rgb::BLACK, alpha: 1.0 });
    assert!(inner.pixel(48, 40)[0] < 100 && inner.pixel(48, 40)[3] == 255, "dark inside the right edge");
    assert_eq!(inner.pixel(31, 40), plain.pixel(31, 40), "the left edge is not in its shadow");
    assert_eq!(inner.pixel(26, 40)[3], 0, "nothing outside");
    // For an output with no filters (the PDF): the group with its shadow as one picture, over the area the shadow reaches.
    let g = Group { effects: vec![Effect::Shadow { dx: 10.0, dy: 10.0, blur: 2.0, color: Rgb::BLACK, alpha: 1.0 }], ..Group::of(vec![red()]) };
    let (img, area) = render_group(&g, &NoMedia, 2.0, &PaintOptions::default()).expect("a picture");
    assert!(area.x <= 30.0 && area.right() >= 60.0 && img.width as f32 >= area.w * 2.0 - 1.0, "{area:?}");
    let at = |x: f32, y: f32| img.pixel(((x - area.x) * 2.0) as u32, ((y - area.y) * 2.0) as u32);
    assert_eq!(at(40.0, 40.0), [255, 0, 0, 255], "the square");
    assert!(at(56.0, 56.0)[3] > 128, "its shadow");
}

/// engine-zoom-tiles: at 500 % a group under a 100 pt shadow blur has its shadow worked out on a coarser picture (a full
/// one covered the blur's whole reach, a 4,096 px square for every tile); the group itself stays as sharp as without the
/// effect, and its shadow still shows round it.
#[test]
fn a_wide_blur_at_a_high_zoom_keeps_the_group_sharp() {
    let red = || filled(square(100.0, 100.0, 72.0), FillRule::NonZero, RED);
    let shadowed = Group { effects: vec![Effect::Shadow { dx: 2.0, dy: 2.0, blur: 100.0, color: Rgb::BLACK, alpha: 1.0 }], ..Group::of(vec![red()]) };
    let list = |it: Draw| DisplayList::new(612.0, 792.0, Some(Rgb::WHITE), vec![Layer::of(vec![it])]);
    let (with, plain) = (list(Draw::Group(Box::new(shadowed))), list(red()));
    let opts = PaintOptions::default();
    // Tile (1, 1) at 6.67 px a point holds the square's top-left edge (device px 667) at its own pixel 155.
    let tile = Tile { scale: 20.0 / 3.0, col: 1, row: 1 };
    let (mut a, mut b) = (Vec::new(), Vec::new());
    paint_tile(&with, &NoMedia, tile, &opts, &mut a).expect("painted");
    paint_tile(&plain, &NoMedia, tile, &opts, &mut b).expect("painted");
    let px = |buf: &[u8], x: usize, y: usize| buf[(y * 512 + x) * 4..][..4].to_vec();
    for (x, y) in [(156, 300), (300, 156), (157, 157), (400, 400)] {
        assert_eq!(px(&a, x, y), px(&b, x, y), "the square's own pixels at ({x}, {y})");
    }
    assert!(px(&a, 140, 300)[0] < 250, "its shadow shows outside the edge: {:?}", px(&a, 140, 300));
}

/// Tiles of a page-sized list, stitched, give the whole surface's pixels; a tile nothing reaches is not painted.
#[test]
fn tiles_stitch_into_the_whole_surface() {
    let items = vec![
        filled(square(20.0, 20.0, 300.0), FillRule::NonZero, RED),
        Draw::Line { x0: 10.0, y0: 500.0, x1: 600.0, y1: 520.0, width: 3.0, color: BLUE, stroke: Stroke::Dashed, alpha: 1.0, text_bg: None },
    ];
    let list = DisplayList::new(612.0, 792.0, Some(Rgb::WHITE), vec![Layer::of(items)]);
    let opts = PaintOptions::default();
    let (mut painted, mut blank) = (0, 0);
    for scale in [1.0f32, 1.5, 2.75] {
        let whole = render_list(&list, &NoMedia, scale, &opts);
        let (cols, rows) = (whole.width.div_ceil(TILE), whole.height.div_ceil(TILE));
        let mut buf = Vec::new();
        for row in 0..rows {
            for col in 0..cols {
                let Some((w, h)) = paint_tile(&list, &NoMedia, Tile { scale, col, row }, &opts, &mut buf) else {
                    blank += 1;
                    // Nothing reaches it: the whole surface is paper there.
                    let (x0, y0) = (col * TILE, row * TILE);
                    for y in (y0..(y0 + TILE).min(whole.height)).step_by(7) {
                        for x in (x0..(x0 + TILE).min(whole.width)).step_by(7) {
                            assert_eq!(whole.pixel(x, y), [255; 4], "blank tile {col},{row} at {x},{y}");
                        }
                    }
                    continue;
                };
                painted += 1;
                assert_eq!((w, h), (TILE.min(whole.width - col * TILE), TILE.min(whole.height - row * TILE)));
                for y in 0..h {
                    let at = (((row * TILE + y) * whole.width + col * TILE) * 4) as usize;
                    let tile_row = &buf[(y * w * 4) as usize..((y + 1) * w * 4) as usize];
                    let off = tile_row.iter().zip(&whole.pixels[at..at + tile_row.len()]).filter(|(a, b)| a.abs_diff(**b) > 1).count();
                    assert_eq!(off, 0, "scale {scale} tile {col},{row} row {y}");
                }
            }
        }
    }
    assert!(painted > 0 && blank > 0, "{painted} painted, {blank} blank");
    assert_eq!(paint_tile(&list, &NoMedia, Tile { scale: 1.0, col: 9, row: 0 }, &opts, &mut Vec::new()), None, "past the surface");
}

#[test]
fn a_transparent_surface_tile_is_straight_alpha() {
    let faded = Draw::Fill { rect: ew_geom::Rect::new(0.0, 0.0, 50.0, 50.0), color: RED, alpha: 0.5, text_bg: false };
    let mut buf = Vec::new();
    let (w, _) = paint_tile(&clear(vec![faded]), &NoMedia, Tile { scale: 1.0, col: 0, row: 0 }, &PaintOptions::default(), &mut buf).unwrap();
    let px = &buf[((10 * w + 10) * 4) as usize..][..4];
    assert!(px[0] == 255 && px[3].abs_diff(128) <= 1, "{px:?}");
}

#[test]
fn small_text_is_greeked_into_bars() {
    let face = ew_fonts::word::resolve("Source Sans 3", false, false).face;
    let gid = face.glyph_for('H');
    let glyphs = (0..10).map(|i| (gid, 10.0 + i as f32 * 6.0, 50.0)).collect();
    let run = Draw::Glyphs {
        face,
        size: 10.0,
        glyphs,
        color: Rgb::BLACK,
        alpha: 1.0,
        synth_bold: false,
        synth_italic: false,
        text: "HHHHHHHHHH".into(),
        link: None,
        ranges: Vec::new(),
        text_bg: None,
        x_scale: 1.0,
    };
    let list = DisplayList::new(100.0, 100.0, Some(Rgb::WHITE), vec![Layer::of(vec![run])]);
    let at = |greek: f32| render_list(&list, &NoMedia, 0.25, &PaintOptions { greek_below_px: greek, ..Default::default() });
    let (bars, glyphs) = (at(3.0), at(0.0));
    assert_ne!(bars.pixels, glyphs.pixels, "2.5 px text is a bar under a 3 px threshold");
    // The bar sits on the line, over the x-height, and is grey.
    let p = bars.pixel(5, 12);
    assert!(p[0] > 100 && p[0] < 230, "{p:?}");
    assert_eq!(at(2.0).pixels, glyphs.pixels, "above the threshold the glyphs are drawn");
}

#[test]
fn damage_is_the_changed_items() {
    let item = |x: f64| filled(square(x, 10.0, 10.0), FillRule::NonZero, RED);
    let list = |xs: &[f64]| DisplayList::new(200.0, 100.0, Some(Rgb::WHITE), vec![Layer::of(xs.iter().map(|x| item(*x)).collect())]);
    let old = list(&[0.0, 50.0, 100.0]);
    assert!(list(&[0.0, 50.0, 100.0]).damage(&old).is_empty());
    let moved = list(&[0.0, 60.0, 100.0]).damage(&old);
    assert_eq!(moved.len(), 1);
    assert!(moved[0].x0 <= 50.0 && moved[0].x1 >= 70.0 && moved[0].x1 < 100.0, "{moved:?}");
    let added = list(&[0.0, 50.0, 100.0, 150.0]).damage(&old);
    assert_eq!(added, vec![kurbo::Rect::new(150.0, 10.0, 160.0, 20.0)], "the new item alone");
    let resized = DisplayList::new(300.0, 100.0, Some(Rgb::WHITE), old.layers().to_vec()).damage(&old);
    assert_eq!(resized, vec![kurbo::Rect::new(0.0, 0.0, 300.0, 100.0)], "a new size is the whole surface");
}

/// A page of text lines `lines` (baselines `step` apart from 60 pt) with a rule under the third, as layout draws a body.
fn text_page(lines: &[&str], step: f32) -> DisplayList {
    let face = ew_fonts::word::resolve("Source Sans 3", false, false).face;
    let mut items = Vec::new();
    for (i, t) in lines.iter().enumerate() {
        let y = 60.0 + i as f32 * step;
        let glyphs = t.chars().enumerate().map(|(k, c)| (face.glyph_for(c), 72.0 + k as f32 * 6.1, y)).collect();
        items.push(Draw::Glyphs { face: face.clone(), size: 11.0, glyphs, color: Rgb::BLACK, alpha: 1.0, synth_bold: false, synth_italic: false,
            text: (*t).into(), link: None, ranges: Vec::new(), text_bg: None, x_scale: 1.0 });
        if i == 2 {
            items.push(Draw::Line { x0: 72.0, y0: y + 2.0, x1: 300.0, y1: y + 2.0, width: 0.75, color: BLUE, stroke: Stroke::Solid, alpha: 1.0, text_bg: None });
        }
    }
    DisplayList::new(612.0, 792.0, Some(Rgb::WHITE), vec![Layer::of(items)])
}

/// engine-paint-damage: after an Enter (a line put in, the lines below moved down a line) and a join (the reverse), every
/// tile repainted over its old pixels is the whole paint. Painted and kept rows are the same bytes. The moved lines are
/// copied, not painted, whatever fraction of a pixel the step is (a baseline lands on a whole row). A band renders at its own
/// origin and a copied line sits at another absolute device row, where vello_cpu turns a glyph's outline into f32 device
/// coordinates and rounds its edge pixels the other way: 1 in a byte, never more, in either.
#[test]
fn a_tile_repainted_over_its_old_pixels_is_the_whole_paint() {
    let text: Vec<String> = (0..40).map(|i| format!("Line {i} of the body, moved down when a line goes in above it")).collect();
    let lines: Vec<&str> = text.iter().map(String::as_str).collect();
    let opts = PaintOptions::default();
    let mut rounded = 0;
    for (step, scale) in [(15.0, 2.0), (15.0, 4.0 / 3.0), (13.8, 2.0), (15.912, 4.0 / 3.0), (15.912, 1.0)] {
        let mut entered = lines.clone();
        entered.insert(5, "A new line");
        for (old, new) in [(text_page(&lines, step), text_page(&entered, step)), (text_page(&entered, step), text_page(&lines, step))] {
            let (damage, moves) = (new.damage(&old), new.moves(&old, scale));
            let line = f64::from(step) * f64::from(scale);
            assert!(moves.iter().any(|m| (m.2.abs() - line).abs() < 1.0), "a run moved by a line ({line} rows): {moves:?}");
            let (mut painted, mut area) = (0, 0);
            let (w, h) = new.pixels(scale);
            for row in 0..h.div_ceil(TILE) {
                for col in 0..w.div_ceil(TILE) {
                    let tile = Tile { scale, col, row };
                    let (mut was, mut want) = (Vec::new(), Vec::new());
                    if paint_tile(&old, &NoMedia, tile, &opts, &mut was).is_none() {
                        continue;
                    }
                    let (tw, th) = paint_tile(&new, &NoMedia, tile, &opts, &mut want).expect("the same tiles draw");
                    let over = |moves: &[(f64, f64, f64)]| {
                        let mut got = Vec::new();
                        let before = Before { pixels: &was, damage: &damage, moves };
                        let (_, _, p) = repaint_tile(&new, &NoMedia, tile, &opts, Some(before), &mut got, &mut Vec::new()).expect("painted");
                        (got, p)
                    };
                    let plain = over(&[]).0;
                    assert!(plain.len() == want.len() && plain.iter().zip(&want).all(|(a, b)| a.abs_diff(*b) <= 1), "step {step} at scale {scale}: tile {col},{row} painted over its old pixels is the whole paint to within 1 in a byte");
                    let (got, p) = over(&moves);
                    let off: Vec<u8> = got.iter().zip(&want).map(|(a, b)| a.abs_diff(*b)).filter(|d| *d > 0).collect();
                    assert!(off.iter().all(|d| *d <= 1), "step {step} at scale {scale}: tile {col},{row} with its moved rows copied: {off:?}");
                    rounded += off.len();
                    painted += p;
                    area += tw * th;
                }
            }
            // Only the rows round the new line, and those whose lines came from another tile, are painted (about a twentieth).
            assert!(painted * 10 < area, "step {step} at scale {scale}: painted {painted} of {area} px");
        }
    }
    println!("bytes 1 off in copied rows: {rounded}");
}

#[test]
fn the_list_cache_keeps_the_newest_version_within_its_budget() {
    let mut cache = ListCache::new(10_000);
    let key = |surface, version| ListKey { owner: 1, surface, version };
    let mut builds = 0;
    let mut get = |cache: &mut ListCache, k| {
        cache.get_or_build(k, || {
            builds += 1;
            clear(vec![filled(square(0.0, 0.0, 10.0), FillRule::NonZero, RED)])
        })
    };
    let a = get(&mut cache, key(0, 1));
    let b = get(&mut cache, key(0, 1));
    assert!(Arc::ptr_eq(&a, &b), "kept");
    get(&mut cache, key(0, 2));
    assert_eq!(cache.len(), 1, "a newer version replaces the older");
    for s in 1..100 {
        get(&mut cache, key(s, 2));
    }
    assert!(cache.bytes() <= 10_000 && cache.len() < 100, "{} bytes, {} lists", cache.bytes(), cache.len());
    cache.forget(1);
    assert!(cache.is_empty() && cache.bytes() == 0);
    assert_eq!(builds, 101);
}

#[test]
fn hits_follow_outlines_and_fill_rules() {
    let mut ring = square(10.0, 10.0, 80.0);
    ring.extend(square(30.0, 30.0, 40.0));
    let pen = Some(Pen::solid(BLUE, 4.0));
    let ring = Draw::Vector(Box::new(VectorPath { path: ring, rule: FillRule::EvenOdd, fill: Some(Paint::solid(RED)), pen }));
    let dot = Draw::Group(Box::new(Group { transform: Affine::translate((150.0, 0.0)), ..Group::of(vec![filled(square(0.0, 0.0, 10.0), FillRule::NonZero, RED)]) }));
    let list = DisplayList::new(200.0, 100.0, None, vec![Layer::of(vec![ring, dot])]);
    assert_eq!(list.hit(20.0, 20.0, 0.0), Some(Hit { layer: 0, path: vec![0], part: Part::Fill }));
    assert_eq!(list.hit(50.0, 50.0, 0.0), None, "the even-odd hole");
    assert_eq!(list.hit(10.5, 50.0, 0.0).map(|h| h.part), Some(Part::Stroke), "on the outline");
    assert_eq!(list.hit(7.5, 50.0, 1.0).map(|h| h.part), Some(Part::Stroke), "within the tolerance outside it");
    let h = list.hit(155.0, 5.0, 0.0).unwrap();
    assert_eq!(h.path, vec![1, 0], "through the group's transform");
    let o = list.outline(h.layer, &h.path).unwrap();
    assert_eq!(o.bounding_box(), kurbo::Rect::new(150.0, 0.0, 160.0, 10.0), "the outline in surface points");
    assert!(matches!(list.item(0, &[1, 0]), Some(Draw::Vector(_))));
    assert_eq!(list.hit(195.0, 95.0, 0.0), None);
}

#[test]
fn media_maps_are_media() {
    let bytes = Arc::new(red_blue_png());
    let tree: BTreeMap<String, Arc<Vec<u8>>> = BTreeMap::from([("a".to_string(), bytes.clone())]);
    let hash: HashMap<String, Arc<Vec<u8>>> = HashMap::from([("a".to_string(), bytes)]);
    for m in [&tree as &dyn Media, &hash] {
        assert!(m.bytes("a").is_some() && m.bytes("b").is_none());
    }
}

/// engine-paint-damage: a band's paint cost follows the band's height, not the tile's. A damage rect low in a tile paints
/// its rows and renders a raster no taller than them: the scratch it renders into is the band's, so after a repaint it holds
/// the last band's height, not the tile's.
#[test]
fn a_band_renders_at_its_own_origin() {
    let opts = PaintOptions::default();
    let item = |y: f64| filled(square(10.0, y, 10.0), FillRule::NonZero, RED);
    let list = |y: f64| DisplayList::new(600.0, 1200.0, Some(Rgb::WHITE), vec![Layer::of(vec![item(100.0), item(y)])]);
    let (old, new) = (list(1100.0), list(1110.0));
    let tile = Tile { scale: 1.0, col: 0, row: 2 };
    let mut was = Vec::new();
    paint_tile(&old, &NoMedia, tile, &opts, &mut was).expect("painted");
    let damage = new.damage(&old);
    // The changed items' boxes, with a device pixel's margin: rows 75 to 97 of the tile.
    assert_eq!(damage, vec![kurbo::Rect::new(10.0, 1100.0, 20.0, 1120.0)], "the changed item");
    let before = Before { pixels: &was, damage: &damage, moves: &[] };
    let mut scratch = Vec::new();
    let (w, _, painted) = repaint_tile(&new, &NoMedia, tile, &opts, Some(before), &mut Vec::new(), &mut scratch).expect("painted");
    assert_eq!(painted, w * 22, "the damage's rows are painted");
    assert_eq!(scratch.len(), w as usize * 4 * 22, "the band's raster is the band's height");
}

// A forum post's model is saved in the dark palette; the light theme is these swaps at paint time (post-view).
const POST_PAPER: Rgb = Rgb(0x30, 0x30, 0x39);
const POST_TEXT: Rgb = Rgb(0xC5, 0xC6, 0xD0);
const LIGHT_TEXT: Rgb = Rgb(0x33, 0x33, 0x40);

#[test]
fn a_remap_swaps_exact_fills_strokes_and_text() {
    let remap: &[(Rgb, Rgb)] = &[(RED, BLUE), (POST_PAPER, Rgb::WHITE), (POST_TEXT, LIGHT_TEXT)];
    let opts = PaintOptions { remap, ..PaintOptions::default() };
    let pen = Pen { cap: Cap::Butt, dash: Vec::new(), ..Pen::solid(RED, 10.0) };
    let mut line = BezPath::new();
    line.move_to((20.0, 50.0));
    line.line_to((80.0, 50.0));
    let stroke = Draw::Vector(Box::new(VectorPath { path: line, rule: FillRule::NonZero, fill: None, pen: Some(pen) }));
    let r = render_list(&clear(vec![filled(square(0.0, 0.0, 40.0), FillRule::NonZero, RED), stroke]), &NoMedia, 1.0, &opts);
    assert_eq!(r.pixel(10, 10), [0, 0, 255, 255], "the fill");
    assert_eq!(r.pixel(50, 50), [0, 0, 255, 255], "the stroke");
    assert_eq!(opts.ink(POST_TEXT), LIGHT_TEXT, "text");
    assert_eq!(opts.ink_bg(POST_PAPER), Rgb::WHITE, "a text background");
    assert_eq!(opts.ink(Rgb(1, 2, 3)), Rgb(1, 2, 3), "a colour the table does not name paints as itself");
}

#[test]
fn a_remapped_surface_paints_its_paper_in_the_new_colour() {
    let list = DisplayList::new(10.0, 10.0, Some(POST_PAPER), vec![Layer::of(Vec::new())]);
    let dark = render_list(&list, &NoMedia, 1.0, &PaintOptions::default());
    assert_eq!(dark.pixel(5, 5), [0x30, 0x30, 0x39, 255], "the document's own paper");
    let remap: &[(Rgb, Rgb)] = &[(POST_PAPER, Rgb::WHITE)];
    let light = render_list(&list, &NoMedia, 1.0, &PaintOptions { remap, ..PaintOptions::default() });
    assert_eq!(light.pixel(5, 5), [255, 255, 255, 255], "the surface's paper follows the remap");
}
