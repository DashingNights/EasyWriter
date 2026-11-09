//! WordArt's painting: text effects as plain fills and strokes (reflection, shadow, glow, fill, outline, in that order) for
//! the raster and PDF back ends. Moved from doc-layout's wordart.rs (P6), which keeps the producer side (glyph outlines,
//! warps, a run's effects) and re-exports these. Blurs are approximated with [`ew_doc::effects::bands`], as for shapes.

use kurbo::{Affine, BezPath, Shape};
use ew_doc::props::Rgb;
use ew_doc::wordart::{TextEffects, TextFill};

use ew_fonts::FaceRef;

use crate::Paint;

/// One fill (`stroke: None`) or stroke (its width, points) of a path.
#[derive(Clone, Debug)]
pub struct ArtLayer {
    pub path: BezPath,
    pub paint: Paint,
    pub stroke: Option<f32>,
    /// The letters themselves (fill, outline), not a shadow, glow or reflection of them: a dark
    /// page inks these against the text's background.
    pub letters: bool,
}

/// The outlines of `glyphs` (glyph id, pen x, baseline y in page points) of `face` at `size`, as
/// one path in page coordinates (slanted for synthetic italics).
pub fn glyph_path(face: &FaceRef, size: f32, glyphs: &[(u32, f32, f32)], synth_italic: bool) -> BezPath {
    let db = ew_fonts::FontDb::global();
    let k = f64::from(size) / face.upem.max(1.0);
    let skew = if synth_italic { Affine::new([1.0, 0.0, -0.21, 1.0, 0.0, 0.0]) } else { Affine::IDENTITY };
    let mut out = BezPath::new();
    for &(gid, x, y) in glyphs {
        if !(x.is_finite() && y.is_finite()) {
            continue;
        }
        let m = Affine::translate((f64::from(x), f64::from(y))) * skew * Affine::scale(k);
        for el in db.outline(face, gid).elements() {
            out.push(m * *el);
        }
    }
    out
}

fn bbox(path: &BezPath) -> Option<kurbo::Rect> {
    if path.elements().is_empty() {
        return None;
    }
    let b = path.bounding_box();
    (b.x0.is_finite() && b.y0.is_finite() && b.x1.is_finite() && b.y1.is_finite()).then_some(b)
}

/// The layers that draw `path` (text outlines, page coordinates) with effects `fx` (sanitized
/// here); `color` is the run's own colour (the fill when `fx` sets none), `alpha` an overall
/// opacity.
pub fn art_layers(path: &BezPath, fx: &TextEffects, color: Rgb, alpha: f32) -> Vec<ArtLayer> {
    let fx = fx.sanitized();
    let alpha = if alpha.is_finite() { alpha.clamp(0.0, 1.0) } else { 1.0 };
    let Some(b) = bbox(path) else { return Vec::new() };
    let mut out = Vec::new();
    let fill = fx.fill.clone().unwrap_or(TextFill::Solid { color, transparency: 0.0 });
    let fill_paint = |path: &BezPath| -> Option<Paint> {
        match &fill {
            TextFill::None => None,
            TextFill::Solid { color, transparency } => Some(Paint::Solid(*color, alpha * (1.0 - transparency / 100.0))),
            TextFill::Gradient { stops, angle } => {
                let b = bbox(path)?;
                let (s, c) = (f64::from(*angle).to_radians().sin(), f64::from(*angle).to_radians().cos());
                let d = (b.width() * c.abs() + b.height() * s.abs()) / 2.0;
                let ctr = b.center();
                let p0 = ((ctr.x - d * c) as f32, (ctr.y - d * s) as f32);
                let p1 = ((ctr.x + d * c) as f32, (ctr.y + d * s) as f32);
                Some(Paint::Linear {
                    p0,
                    p1,
                    stops: stops.iter().map(|g| (g.pos / 100.0, g.color, alpha * (1.0 - g.transparency / 100.0))).collect(),
                })
            }
        }
    };
    let outline = fx.outline.and_then(|o| o.color.map(|c| (c, o.width.max(0.25), alpha * (1.0 - o.transparency / 100.0))));
    // A colour standing for the letters (shadows and reflections of hollow text use the outline's).
    let ink = fill.main_color().or(outline.map(|o| o.0)).unwrap_or(color);
    if let Some(r) = fx.reflection {
        // Mirrored about the letters' bottom edge, `distance` below it, fading out downwards.
        let gap = f64::from(r.distance);
        let m = Affine::new([1.0, 0.0, 0.0, -1.0, 0.0, 2.0 * b.y1 + gap]);
        let mirror = m * path.clone();
        let top = (b.y1 + gap) as f32;
        let bottom = top + (b.height() as f32) * (r.size / 100.0).max(0.01);
        let x = b.x0 as f32;
        let a = alpha * (1.0 - r.transparency / 100.0);
        out.push(ArtLayer {
            path: mirror,
            paint: Paint::Linear { p0: (x, top), p1: (x, bottom), stops: vec![(0.0, ink, a), (1.0, ink, 0.0)] },
            stroke: None,
            letters: false,
        });
    }
    if let Some(sh) = fx.shadow {
        let (dx, dy) = sh.offset();
        let moved = Affine::translate((f64::from(dx), f64::from(dy))) * path.clone();
        for (g, a) in ew_doc::effects::bands(0.0, sh.blur / 2.0, sh.opacity() * alpha) {
            let paint = Paint::Solid(sh.color, a);
            out.push(ArtLayer { path: moved.clone(), paint: paint.clone(), stroke: None, letters: false });
            if g > 0.05 {
                out.push(ArtLayer { path: moved.clone(), paint, stroke: Some(2.0 * g), letters: false });
            }
        }
    }
    if let Some(gl) = fx.glow {
        for (g, a) in ew_doc::effects::bands(0.0, gl.size, gl.opacity() * alpha) {
            if g > 0.05 {
                out.push(ArtLayer { path: path.clone(), paint: Paint::Solid(gl.color, a), stroke: Some(2.0 * g), letters: false });
            }
        }
    }
    if let Some(p) = fill_paint(path) {
        out.push(ArtLayer { path: path.clone(), paint: p, stroke: None, letters: true });
    }
    if let Some((c, w, a)) = outline {
        out.push(ArtLayer { path: path.clone(), paint: Paint::Solid(c, a), stroke: Some(w), letters: true });
    }
    out
}

/// The box of `path`, if it has one.
pub fn path_box(path: &BezPath) -> Option<kurbo::Rect> {
    bbox(path)
}
