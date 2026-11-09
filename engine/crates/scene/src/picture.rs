//! EasyWriter engine-gaps-pictures: a picture's outline and effects (Picture Format › Picture Border and Picture Effects), as
//! Word draws them. The picture and its outline become one [`Group`]: the shadow, glow, reflection and soft edges are worked
//! out on its pixels ([`crate::effects`]), an inner shadow and a bevel's light and shade are cast inside its silhouette, and a
//! 3-D rotation is the group's turn about the frame's centre. The bevel draws its edge only, not a lit 3-D surface, and a
//! perspective camera is drawn as a parallel view (both as the DOM editor draws them, picture-format/pictures.mjs).
// ponytail: a perspective rotation is drawn without foreshortening; give Group a projective transform when that matters.

use vello_cpu::kurbo::{Affine, BezPath};
use ew_doc::effects::ShapeEffects;
use ew_doc::line_dash::{Outline, Sketch};
use ew_doc::para::{CropShape, PictureFloat};
use ew_doc::props::Rgb;
use ew_geom::Rect;

use crate::{Blend, Cap, Draw, Effect, FillRule, Group, Join, Paint, Pen, VectorPath};

/// `picture`, the draw of a picture in its frame `rect` (already clipped to `shape`, the shape it is cropped to), with the
/// outline, effects and colour settings of its placement `float`. Without any, `picture` as it is.
pub fn picture_look(picture: Draw, rect: Rect, shape: Option<&CropShape>, float: &PictureFloat) -> Draw {
    // EasyWriter engine-pictures-2: its colour settings, drawn on its own pixels before the outline and effects go on.
    let live = float.adjust().live();
    let picture = if live.is_empty() {
        picture
    } else {
        let alt = described(&picture);
        let group = Draw::Group(Box::new(Group { effects: vec![Effect::Adjust(live)], ..Group::of(vec![picture]) }));
        match alt {
            Some(alt) => Draw::Figure { alt, kind: None, draws: vec![group] },
            None => group,
        }
    };
    look(picture, rect, shape, float.outline.as_ref(), &float.fx)
}

/// [`picture_look`]'s outline and effects.
fn look(picture: Draw, rect: Rect, shape: Option<&CropShape>, outline: Option<&Outline>, fx: &ShapeEffects) -> Draw {
    let fx = fx.sanitized();
    let outline = outline.filter(|o| o.width() > 0.0);
    if outline.is_none() && fx.is_empty() {
        return picture;
    }
    // A described picture (already one figure) is one figure with its outline and effects.
    let (mut items, alt) = match picture {
        Draw::Figure { alt, kind: None, draws } => (draws, Some(alt)),
        p => {
            let alt = described(&p);
            (vec![p], alt)
        }
    };
    if let Some(o) = outline {
        items.push(outline_draw(rect, shape, o));
    }
    let mut effects = Vec::new();
    if let Some(r) = fx.soft_edge {
        effects.push(Effect::SoftEdge { radius: r.min(rect.w.min(rect.h) / 2.0) });
    }
    if let Some(b) = fx.bevel {
        // Word's light from the top (its probe, engine-gaps-pictures): a thin highlight along the top edge and a shade along
        // the bottom, each reaching in half the bevel's width and leaning a little to the left and right sides.
        let d = (b.width.min(rect.w.min(rect.h) / 2.0) / 2.0).max(0.5);
        effects.push(Effect::InnerShadow { dx: -d * 0.4, dy: -d, blur: d * 0.6, color: Rgb::WHITE, alpha: 0.5 });
        effects.push(Effect::InnerShadow { dx: d * 0.4, dy: d, blur: d * 0.8, color: Rgb::BLACK, alpha: 0.5 });
    }
    if let Some(s) = fx.inner_shadow {
        let (dx, dy) = s.offset();
        effects.push(Effect::InnerShadow { dx, dy, blur: s.blur, color: s.color, alpha: s.opacity() });
    }
    if let Some(r) = fx.reflection {
        effects.push(Effect::Reflection { gap: r.distance, size: r.size / 100.0, alpha: 1.0 - r.transparency / 100.0, blur: r.blur });
    }
    if let Some(s) = fx.shadow {
        let (dx, dy) = s.offset();
        effects.push(Effect::Shadow { dx, dy, blur: s.blur, color: s.color, alpha: s.opacity() });
    }
    if let Some(g) = fx.glow {
        effects.push(Effect::Glow { radius: g.size, color: g.color, alpha: g.opacity() });
    }
    let transform = fx.rotation.map_or(Affine::IDENTITY, |r| {
        let [a, b, c, d] = r.plane().map(f64::from);
        let (cx, cy) = (f64::from(rect.x + rect.w / 2.0), f64::from(rect.y + rect.h / 2.0));
        Affine::translate((cx, cy)) * Affine::new([a, b, c, d, 0.0, 0.0]) * Affine::translate((-cx, -cy))
    });
    let group = Draw::Group(Box::new(Group { transform, clip: None, opacity: 1.0, blend: Blend::Normal, effects, items }));
    // A described picture stays one figure with its description in a tagged PDF.
    match alt {
        Some(alt) => Draw::Figure { alt, kind: None, draws: vec![group] },
        None => group,
    }
}

/// The description of the picture `d` draws (itself, or clipped to its shape), unless it has none or is decorative.
fn described(d: &Draw) -> Option<String> {
    match d {
        Draw::Image { alt, decorative: false, .. } if !alt.is_empty() => Some(alt.clone()),
        Draw::Clip { items, .. } => items.first().and_then(described),
        _ => None,
    }
}

/// The outline along the frame, or along the shape the picture is cropped to: centred on it, mitred, with its dashes and
/// sketched look.
fn outline_draw(rect: Rect, shape: Option<&CropShape>, o: &Outline) -> Draw {
    let polys: Vec<(Vec<(f64, f64)>, bool)> = match shape {
        Some(s) => s
            .outline
            .placed(rect.x, rect.y, rect.w, rect.h)
            .into_iter()
            .map(|(pts, closed)| (pts.iter().map(|[x, y]| (f64::from(*x), f64::from(*y))).collect(), closed))
            .collect(),
        None => {
            let (x0, y0, x1, y1) = (f64::from(rect.x), f64::from(rect.y), f64::from(rect.right()), f64::from(rect.bottom()));
            vec![(vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)], true)]
        }
    };
    let width = o.width();
    let path = match o.sketch {
        Sketch::None => plain(&polys),
        kind => sketched(&polys, kind, f64::from(width)),
    };
    let pen = Pen {
        paint: Paint::solid(o.color),
        width,
        join: if o.sketch.is_none() { Join::Miter } else { Join::Round },
        cap: if o.sketch.is_none() { Cap::Butt } else { Cap::Round },
        miter: 8.0,
        dash: o.dash.pattern(width),
        dash_offset: 0.0,
    };
    Draw::Vector(Box::new(VectorPath { path, rule: FillRule::NonZero, fill: None, pen: Some(pen) }))
}

fn plain(polys: &[(Vec<(f64, f64)>, bool)]) -> BezPath {
    let mut p = BezPath::new();
    for (pts, closed) in polys {
        for (i, pt) in pts.iter().enumerate() {
            if i == 0 {
                p.move_to(*pt);
            } else {
                p.line_to(*pt);
            }
        }
        if *closed {
            p.close_path();
        }
    }
    p
}

/// A small deterministic noise source: the same outline wobbles the same way at every repaint.
struct Noise(u64);

impl Noise {
    /// -1..1.
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 33) as f64 / f64::from(u32::MAX >> 1)) - 1.0
    }
}

/// Most points one sketched edge is drawn through.
const MAX_SKETCH_STEPS: usize = 400;

/// The outline drawn by hand: each edge wanders off its line by a little more than the line is wide. Curved bows smoothly
/// along the whole outline; Freehand wobbles and overshoots the corners; Scribble goes round twice.
fn sketched(polys: &[(Vec<(f64, f64)>, bool)], kind: Sketch, width: f64) -> BezPath {
    // Word's own drawing of a sketched line (its probe, engine-gaps-pictures) strays by about half a point.
    let amp = (0.4 + width * 0.2).min(3.0);
    let mut out = BezPath::new();
    let passes = if kind == Sketch::Scribble { 2 } else { 1 };
    let mut noise = Noise(0x5EED_u64 + kind as u64);
    for pass in 0..passes {
        for (pts, closed) in polys {
            if pts.len() < 2 {
                continue;
            }
            let n = pts.len();
            let edges = if *closed { n } else { n - 1 };
            // Points along the outline, every few points, each pushed sideways.
            let mut wobbly: Vec<(f64, f64)> = Vec::new();
            for e in 0..edges {
                let (a, b) = (pts[e], pts[(e + 1) % n]);
                let (dx, dy) = (b.0 - a.0, b.1 - a.1);
                let len = dx.hypot(dy);
                if !(len.is_finite() && len > 1e-6) {
                    continue;
                }
                let (nx, ny) = (-dy / len, dx / len);
                let steps = ((len / 14.0).ceil() as usize).clamp(1, MAX_SKETCH_STEPS);
                // Freehand and Scribble start each edge a little before its corner and end a little past the next.
                let over = if kind == Sketch::Curved { 0.0 } else { (amp * 0.8).min(len / 4.0) };
                // Curved bows each edge one way, by most in its middle.
                let bow = if noise.next() < 0.0 { -amp * 0.7 } else { amp * 0.7 };
                for s in 0..=steps {
                    let t = s as f64 / steps as f64;
                    let along = -over + t * (len + 2.0 * over);
                    let side = match kind {
                        Sketch::Curved => bow * (t * std::f64::consts::PI).sin() + amp * 0.15 * noise.next(),
                        _ => amp * 0.5 * noise.next() * (1.0 + pass as f64 * 0.6),
                    };
                    let p = (a.0 + dx / len * along + nx * side, a.1 + dy / len * along + ny * side);
                    if kind == Sketch::Curved {
                        wobbly.push(p);
                    } else if s == 0 {
                        out.move_to(p);
                    } else {
                        out.line_to(p);
                    }
                }
            }
            if kind == Sketch::Curved {
                smooth(&mut out, &wobbly, *closed);
            }
        }
    }
    out
}

/// A smooth curve through `pts` (each segment a quadratic through the midpoints).
fn smooth(out: &mut BezPath, pts: &[(f64, f64)], closed: bool) {
    let Some(&first) = pts.first() else { return };
    let mid = |a: (f64, f64), b: (f64, f64)| ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
    out.move_to(first);
    for w in pts.windows(2) {
        out.quad_to(w[0], mid(w[0], w[1]));
    }
    if let Some(&last) = pts.last() {
        out.line_to(last);
    }
    if closed {
        out.line_to(first);
    }
}

#[cfg(test)]
#[allow(clippy::panic)]
mod tests {
    use super::*;
    use vello_cpu::kurbo;
    use ew_doc::effects::{Rotation3d, Shadow};
    use ew_doc::para::{Float, InlineObject, Picture};

    /// The frame of a picture placed by `float` with settings `adjust`.
    fn frame(float: Float, adjust: ew_doc::adjust::PictureAdjust) -> PictureFloat {
        let InlineObject::Image { float, .. } = (Picture { float, adjust, ..Default::default() }).build() else { panic!("a picture") };
        float
    }

    #[test]
    fn a_picture_with_no_look_is_drawn_as_it_is() {
        let img = Draw::Fill { rect: Rect::new(0.0, 0.0, 10.0, 10.0), color: Rgb::BLACK, alpha: 1.0, text_bg: false };
        let same = picture_look(img.clone(), Rect::new(0.0, 0.0, 10.0, 10.0), None, &frame(Float::default(), Default::default()));
        assert_eq!(same, img);
    }

    #[test]
    fn colour_settings_draw_on_the_picture_alone() {
        use ew_doc::adjust::{PictureAdjust, Recolor};
        let rect = Rect::new(0.0, 0.0, 10.0, 10.0);
        let img = Draw::Image { rect, media: "p.png".into(), crop: [0.0; 4], alpha: 1.0, alt: "A dog".into(), decorative: false };
        let float = frame(
            Float { outline: Some(Outline::default()), ..Default::default() },
            PictureAdjust { recolor: Some(Recolor::Grayscale), ..Default::default() },
        );
        // The described picture stays one figure; the outline goes round it, not through the grey.
        let Draw::Figure { alt, draws, .. } = picture_look(img, rect, None, &float) else { panic!("a figure") };
        let Some(Draw::Group(g)) = draws.first() else { panic!("the outline's group") };
        let Some(Draw::Group(grey)) = g.items.first() else { panic!("the grey picture") };
        assert_eq!(alt, "A dog");
        assert!(matches!(grey.effects.as_slice(), [Effect::Adjust(_)]) && matches!(g.items.get(1), Some(Draw::Vector(_))));
    }

    #[test]
    fn effects_and_a_turn_go_on_one_group_with_the_outline() {
        let rect = Rect::new(10.0, 10.0, 40.0, 20.0);
        let img = Draw::Fill { rect, color: Rgb::BLACK, alpha: 1.0, text_bg: false };
        let fx = ShapeEffects { shadow: Some(Shadow::default()), rotation: Some(Rotation3d { z: 90.0, ..Default::default() }), ..Default::default() };
        let o = Outline { sketch: Sketch::Freehand, ..Outline::default() };
        let Draw::Group(g) = look(img, rect, None, Some(&o), &fx) else { panic!("a group") };
        assert_eq!(g.items.len(), 2);
        assert!(matches!(g.effects.as_slice(), [Effect::Shadow { .. }]));
        // Turned about the frame's centre (30, 20).
        let c = g.transform * kurbo::Point::new(30.0, 20.0);
        assert!((c.x - 30.0).abs() < 1e-6 && (c.y - 20.0).abs() < 1e-6);
        let Draw::Vector(v) = &g.items[1] else { panic!("the outline") };
        // A sketched line strays from the frame, but not far.
        let b = kurbo::Shape::bounding_box(&v.path);
        assert!(b.x0 < 10.0 && b.x0 > 0.0 && b.y1 > 30.0 && b.y1 < 40.0, "{b:?}");
    }
}
