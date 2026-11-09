//! Geometry over display items: conservative bounds (for blank tiles, culling and damage), hit testing on the items'
//! outlines (fill and stroke, topmost first) and the outline of a hit item, so a design tool selects a curve where it is
//! drawn. Lengths are surface points.

use vello_cpu::kurbo::{self, Affine, BezPath, ParamCurveNearest, Point, Shape};

use crate::draw::{Draw, FillRule, Group, Paint};
use crate::{DisplayList, ink_path, seg_path, shape_path};

/// Which part of an item a point hit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Fill,
    Stroke,
}

/// The topmost item under a point: its layer, its index path down through containers (figures, clips, turns, groups),
/// and the part hit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub layer: usize,
    pub path: Vec<usize>,
    pub part: Part,
}

fn rect(r: &ew_geom::Rect) -> kurbo::Rect {
    kurbo::Rect::new(f64::from(r.x), f64::from(r.y), f64::from(r.right()), f64::from(r.bottom()))
}

fn finite(r: kurbo::Rect) -> Option<kurbo::Rect> {
    (r.x0.is_finite() && r.y0.is_finite() && r.x1.is_finite() && r.y1.is_finite()).then_some(r)
}

fn union(items: &[Draw]) -> Option<kurbo::Rect> {
    items.iter().filter_map(bounds).reduce(|a, b| a.union(b))
}

fn points_box(pts: impl Iterator<Item = (f32, f32)>) -> Option<kurbo::Rect> {
    pts.filter(|(x, y)| x.is_finite() && y.is_finite())
        .map(|(x, y)| kurbo::Rect::from_points((f64::from(x), f64::from(y)), (f64::from(x), f64::from(y))))
        .reduce(|a, b| a.union(b))
}

fn len(v: f32) -> f64 {
    if v.is_finite() { f64::from(v).abs().min(1e4) } else { 0.0 }
}

/// A box in the item's own frame that holds everything it paints (generous: glyphs by their size, not their outlines).
/// `None` for an item that paints nothing.
pub fn bounds(d: &Draw) -> Option<kurbo::Rect> {
    let b = match d {
        Draw::Glyphs { size, glyphs, x_scale, .. } => {
            let s = len(*size);
            let b = points_box(glyphs.iter().map(|g| (g.1, g.2)))?;
            kurbo::Rect::new(b.x0 - 2.0 * s, b.y0 - 3.0 * s, b.x1 + 3.0 * s * len(*x_scale).max(1.0), b.y1 + 2.0 * s)
        }
        Draw::Fill { rect: r, .. } | Draw::Image { rect: r, .. } => rect(r),
        Draw::Line { x0, y0, x1, y1, width, .. } => {
            let w = 3.0 * len(*width) + 2.0;
            points_box([(*x0, *y0), (*x1, *y1)].into_iter())?.inflate(w, w)
        }
        Draw::Shape { rect: r, stroke_width, effects, .. } => {
            let fx = effects.sanitized();
            let sh = fx.shadow.map_or(0.0, |s| {
                let (dx, dy) = s.offset();
                len(dx).max(len(dy)) + len(s.blur)
            });
            let g = len(stroke_width.min(200.0)) + sh + fx.glow.map_or(0.0, |g| len(g.size)) + 1.0;
            rect(r).inflate(g, g)
        }
        Draw::Ink { pts, width, .. } => points_box(pts.iter().copied())?.inflate(len(*width), len(*width)),
        Draw::Path { segs, stroke_width, .. } => {
            let w = 2.0 * len(stroke_width.min(200.0)) + 1.0;
            finite(seg_path(segs).control_box())?.inflate(w, w)
        }
        Draw::Figure { draws, .. } => union(draws)?,
        Draw::Mark { x, baseline, size, .. } => {
            let s = len(*size);
            points_box(std::iter::once((*x, *baseline)))?.inflate(2.0 * s, 2.0 * s)
        }
        Draw::MarkText { x, baseline, size, text } => {
            let s = len(*size);
            let b = points_box(std::iter::once((*x, *baseline)))?;
            kurbo::Rect::new(b.x0 - s, b.y0 - 2.0 * s, b.x1 + s * (2.0 + 1.2 * text.chars().count() as f64), b.y1 + s)
        }
        Draw::Turned { x, y, turn, items } => Affine::new(Draw::turn_matrix(*turn, *x, *y).map(f64::from)).transform_rect_bbox(union(items)?),
        Draw::Rotated { cx, cy, spin, items } => Affine::new(spin.matrix(*cx, *cy).map(f64::from)).transform_rect_bbox(union(items)?),
        Draw::Clip { rect: r, items, .. } => rect(r).intersect(union(items)?),
        // Shadows, glows and reflections reach past the letters (as the painter's culling allows).
        Draw::Art { path, .. } => {
            let b = crate::art::path_box(path)?;
            b.inflate(200.0 + b.height(), 200.0 + b.height())
        }
        Draw::Vector(v) => {
            let w = v.pen.as_ref().map_or(0.0, |p| len(p.width) * f64::from(p.miter.clamp(1.0, 100.0)).max(1.5));
            finite(v.path.control_box())?.inflate(w, w)
        }
        Draw::Group(g) => group_bounds(g)?,
    };
    finite(b).filter(|b| b.width() >= 0.0 && b.height() >= 0.0)
}

/// A group's content in its parent's frame: its items' bounds through its transform, cut to its clip.
pub(crate) fn content_bounds(g: &Group) -> Option<kurbo::Rect> {
    let mut b = union(&g.items)?;
    if let Some((clip, _)) = &g.clip {
        b = b.intersect(clip.bounding_box());
    }
    finite(g.transform.transform_rect_bbox(b))
}

/// A group's bounds with its effects' reach.
pub(crate) fn group_bounds(g: &Group) -> Option<kurbo::Rect> {
    let b = content_bounds(g)?;
    let r = crate::effects::reach(&g.effects, b.height());
    Some(b.inflate(r, r))
}

impl DisplayList {
    /// The topmost item at surface point (`x`, `y`) within `tol` points: strokes by their outline's distance, fills by
    /// their fill rule. Formatting marks and invisible text are not hit; backdrop layers are.
    pub fn hit(&self, x: f32, y: f32, tol: f32) -> Option<Hit> {
        let p = Point::new(f64::from(x), f64::from(y));
        let tol = len(tol);
        for (li, layer) in self.layers().iter().enumerate().rev() {
            if let Some((mut path, part)) = hit_items(&layer.items, p, tol, 0) {
                path.reverse();
                return Some(Hit { layer: li, path, part });
            }
        }
        None
    }

    /// The item a hit names.
    pub fn item(&self, layer: usize, path: &[usize]) -> Option<&Draw> {
        let (first, rest) = path.split_first()?;
        let mut d = self.layers().get(layer)?.items.get(*first)?;
        for i in rest {
            d = children(d)?.get(*i)?;
        }
        Some(d)
    }

    /// The outline of the item a hit names, in surface points (through its containers' transforms): what a selection
    /// draws round. Text gives its glyphs' outlines.
    pub fn outline(&self, layer: usize, path: &[usize]) -> Option<BezPath> {
        let (first, rest) = path.split_first()?;
        let mut d = self.layers().get(layer)?.items.get(*first)?;
        let mut m = Affine::IDENTITY;
        for i in rest {
            m *= frame(d);
            d = children(d)?.get(*i)?;
        }
        let o = item_outline(d)?;
        Some(m * o)
    }
}

fn children(d: &Draw) -> Option<&[Draw]> {
    match d {
        Draw::Figure { draws, .. } => Some(draws),
        Draw::Turned { items, .. } | Draw::Rotated { items, .. } | Draw::Clip { items, .. } => Some(items),
        Draw::Group(g) => Some(&g.items),
        _ => None,
    }
}

/// The map from a container's children's frame to its own.
fn frame(d: &Draw) -> Affine {
    match d {
        Draw::Turned { x, y, turn, .. } => Affine::new(Draw::turn_matrix(*turn, *x, *y).map(f64::from)),
        Draw::Rotated { cx, cy, spin, .. } => Affine::new(spin.matrix(*cx, *cy).map(f64::from)),
        Draw::Group(g) => g.transform,
        _ => Affine::IDENTITY,
    }
}

/// The hit among `items` (topmost first), its index path reversed (innermost first).
fn hit_items(items: &[Draw], p: Point, tol: f64, depth: u32) -> Option<(Vec<usize>, Part)> {
    if depth > 32 {
        return None;
    }
    for (i, d) in items.iter().enumerate().rev() {
        if let Some((mut path, part)) = hit_item(d, p, tol, depth) {
            path.push(i);
            return Some((path, part));
        }
    }
    None
}

fn hit_item(d: &Draw, p: Point, tol: f64, depth: u32) -> Option<(Vec<usize>, Part)> {
    if !bounds(d).is_some_and(|b| b.inflate(tol, tol).contains(p)) {
        return None;
    }
    let leaf = |part| Some((Vec::new(), part));
    match d {
        Draw::Figure { draws, .. } => hit_items(draws, p, tol, depth + 1),
        Draw::Turned { items, .. } | Draw::Rotated { items, .. } => hit_items(items, frame(d).inverse() * p, tol, depth + 1),
        Draw::Clip { rect: r, items, path } => {
            let inside = rect(r).contains(p) && (path.is_empty() || seg_path(path).winding(p) != 0);
            if inside { hit_items(items, p, tol, depth + 1) } else { None }
        }
        Draw::Group(g) => {
            let q = g.transform.inverse() * p;
            if let Some((clip, rule)) = &g.clip
                && !fills(clip, *rule, q)
            {
                return None;
            }
            hit_items(&g.items, q, tol, depth + 1)
        }
        Draw::Glyphs { alpha, .. } if *alpha <= 0.0 => None,
        Draw::Glyphs { size, glyphs, x_scale, .. } => {
            let s = len(*size);
            let adv = s * 0.6 * len(*x_scale).max(0.1);
            glyphs
                .iter()
                .any(|g| {
                    let (x, y) = (f64::from(g.1), f64::from(g.2));
                    kurbo::Rect::new(x, y - 0.8 * s, x + adv, y + 0.25 * s).inflate(tol, tol).contains(p)
                })
                .then_some((Vec::new(), Part::Fill))
        }
        Draw::Fill { rect: r, .. } | Draw::Image { rect: r, .. } => rect(r).inflate(tol, tol).contains(p).then_some((Vec::new(), Part::Fill)),
        Draw::Line { x0, y0, x1, y1, width, .. } => {
            let seg = kurbo::Line::new((f64::from(*x0), f64::from(*y0)), (f64::from(*x1), f64::from(*y1)));
            (seg.nearest(p, 1e-6).distance_sq.sqrt() <= len(*width) / 2.0 + tol).then_some((Vec::new(), Part::Stroke))
        }
        Draw::Shape { rect: r, kind, fill, stroke, stroke_width, corner, .. } => {
            let path = shape_path(*kind, rect(r), *corner);
            if stroke.is_some() && near(&path, p, len(*stroke_width) / 2.0 + tol) {
                return leaf(Part::Stroke);
            }
            (fill.is_some() && fills(&path, FillRule::NonZero, p)).then_some((Vec::new(), Part::Fill))
        }
        Draw::Path { segs, fill, stroke, stroke_width, .. } => {
            let path = seg_path(segs);
            if stroke.is_some() && near(&path, p, len(*stroke_width).max(0.75) / 2.0 + tol) {
                return leaf(Part::Stroke);
            }
            (fill.is_some() && fills(&path, FillRule::NonZero, p)).then_some((Vec::new(), Part::Fill))
        }
        Draw::Ink { pts, width, .. } => {
            let path = ink_path(pts)?;
            near(&path, p, len(*width) / 2.0 + tol).then_some((Vec::new(), Part::Stroke))
        }
        Draw::Art { path, .. } => fills(path, FillRule::NonZero, p).then_some((Vec::new(), Part::Fill)),
        Draw::Vector(v) => {
            if let Some(pen) = &v.pen
                && near(&v.path, p, len(pen.width) / 2.0 + tol)
            {
                return leaf(Part::Stroke);
            }
            let painted = v.fill.as_ref().is_some_and(|f| !matches!(f, Paint::Solid(_, a) if *a <= 0.0));
            (painted && fills(&v.path, v.rule, p)).then_some((Vec::new(), Part::Fill))
        }
        Draw::Mark { .. } | Draw::MarkText { .. } => None,
    }
}

fn fills(path: &BezPath, rule: FillRule, p: Point) -> bool {
    let w = path.winding(p);
    match rule {
        FillRule::NonZero => w != 0,
        FillRule::EvenOdd => w % 2 != 0,
    }
}

/// Whether `p` lies within `dist` of `path`'s outline.
fn near(path: &BezPath, p: Point, dist: f64) -> bool {
    path.segments().any(|s| s.nearest(p, 1e-6).distance_sq <= dist * dist)
}

/// An item's outline in its own frame.
fn item_outline(d: &Draw) -> Option<BezPath> {
    let o = match d {
        Draw::Fill { rect: r, .. } | Draw::Image { rect: r, .. } => rect(r).to_path(0.1),
        Draw::Shape { rect: r, kind, corner, .. } => shape_path(*kind, rect(r), *corner),
        Draw::Path { segs, .. } => seg_path(segs),
        Draw::Vector(v) => v.path.clone(),
        Draw::Art { path, .. } => path.clone(),
        Draw::Ink { pts, .. } => ink_path(pts)?,
        Draw::Line { x0, y0, x1, y1, .. } => {
            let mut p = BezPath::new();
            p.move_to((f64::from(*x0), f64::from(*y0)));
            p.line_to((f64::from(*x1), f64::from(*y1)));
            p
        }
        Draw::Glyphs { face, size, glyphs, synth_italic, .. } => crate::art::glyph_path(face, *size, glyphs, *synth_italic),
        Draw::Figure { .. } | Draw::Turned { .. } | Draw::Rotated { .. } | Draw::Clip { .. } | Draw::Group(_) => {
            let mut out = BezPath::new();
            for c in children(d)? {
                if let Some(o) = item_outline(c) {
                    out.extend(frame(d) * o);
                }
            }
            out
        }
        Draw::Mark { .. } | Draw::MarkText { .. } => return None,
    };
    Some(o)
}
