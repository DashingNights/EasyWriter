//! The general primitives: a vector path with a fill rule and a pen, a group with a transform, clip, opacity, blend mode
//! and effects, and picture and pattern paints. Documents make none of these yet; Slides and a designer will.

use std::sync::Arc;

use vello_cpu::kurbo::{self, Affine, Shape};
use vello_cpu::{Pixmap, RenderContext, Resources, peniko};

use crate::{Blend, Cap, Draw, FillRule, Frame, Group, Join, Paint, Pen, VectorPath, color, draw, path_len_bound, pixmap_for, safe_dashes, set_paint};

/// Largest side, in pixels, of a pattern cell's picture.
const MAX_CELL_PX: f64 = 1024.0;

pub(crate) fn fill_rule(r: FillRule) -> peniko::Fill {
    match r {
        FillRule::NonZero => peniko::Fill::NonZero,
        FillRule::EvenOdd => peniko::Fill::EvenOdd,
    }
}

pub(crate) fn blend_mode(b: Blend) -> peniko::BlendMode {
    use peniko::Mix;
    let mix = match b {
        Blend::Normal => Mix::Normal,
        Blend::Multiply => Mix::Multiply,
        Blend::Screen => Mix::Screen,
        Blend::Overlay => Mix::Overlay,
        Blend::Darken => Mix::Darken,
        Blend::Lighten => Mix::Lighten,
        Blend::ColorDodge => Mix::ColorDodge,
        Blend::ColorBurn => Mix::ColorBurn,
        Blend::HardLight => Mix::HardLight,
        Blend::SoftLight => Mix::SoftLight,
        Blend::Difference => Mix::Difference,
        Blend::Exclusion => Mix::Exclusion,
        Blend::Hue => Mix::Hue,
        Blend::Saturation => Mix::Saturation,
        Blend::Color => Mix::Color,
        Blend::Luminosity => Mix::Luminosity,
    };
    peniko::BlendMode::new(mix, peniko::Compose::SrcOver)
}

/// The pen as kurbo's stroke: width clamped to what the painter draws, a sane miter, and dashes that can be drawn.
pub(crate) fn kurbo_stroke(pen: &Pen, path: &kurbo::BezPath) -> kurbo::Stroke {
    let w = if pen.width.is_finite() && pen.width > 0.0 { f64::from(pen.width.min(2000.0)) } else { 0.75 };
    let join = match pen.join {
        Join::Miter => kurbo::Join::Miter,
        Join::Round => kurbo::Join::Round,
        Join::Bevel => kurbo::Join::Bevel,
    };
    let cap = match pen.cap {
        Cap::Butt => kurbo::Cap::Butt,
        Cap::Round => kurbo::Cap::Round,
        Cap::Square => kurbo::Cap::Square,
    };
    let miter = if pen.miter.is_finite() { f64::from(pen.miter.clamp(1.0, 100.0)) } else { 4.0 };
    let offset = if pen.dash_offset.is_finite() { f64::from(pen.dash_offset) } else { 0.0 };
    kurbo::Stroke::new(w)
        .with_join(join)
        .with_caps(cap)
        .with_miter_limit(miter)
        .with_dashes(offset, safe_dashes(pen.dash.iter().map(|v| f64::from(*v)), path_len_bound(path)))
}

/// `path` as an axis-aligned rectangle, when it is exactly one (a rectangle fills through vello's rectangle path).
fn as_rect(path: &kurbo::BezPath) -> Option<kurbo::Rect> {
    use kurbo::PathEl::{ClosePath, LineTo, MoveTo};
    let [MoveTo(a), LineTo(b), LineTo(c), LineTo(d), ClosePath] = path.elements() else { return None };
    let r = kurbo::Rect::from_points(*a, *c);
    let corners = [(a.x == d.x && b.x == c.x && a.y == b.y && c.y == d.y), (a.y == d.y && b.y == c.y && a.x == b.x && c.x == d.x)];
    corners.iter().any(|ok| *ok).then_some(r)
}

pub(crate) fn draw_vector_path(ctx: &mut RenderContext, fr: &Frame, v: &VectorPath) {
    let path = &v.path;
    if path.elements().is_empty() {
        return;
    }
    let fin = |v: f32, lo: f32, hi: f32| if v.is_finite() { f64::from(v.clamp(lo, hi)) } else { f64::from(lo) };
    let reach = v.pen.as_ref().map_or(0.0, |p| fin(p.width, 0.75, 2000.0) * fin(p.miter, 4.0, 100.0));
    if !path.bounding_box().inflate(reach, reach).overlaps(*fr.visible) {
        return;
    }
    if let Some(f) = &v.fill {
        ctx.set_transform(fr.view);
        ctx.set_fill_rule(fill_rule(v.rule));
        with_paint(ctx, fr, f, |ctx| match as_rect(path) {
            Some(r) => ctx.fill_rect(&r),
            None => ctx.fill_path(path),
        });
        ctx.set_fill_rule(peniko::Fill::NonZero);
    }
    if let Some(pen) = &v.pen {
        ctx.set_transform(fr.view);
        ctx.set_stroke(kurbo_stroke(pen, path));
        with_paint(ctx, fr, &pen.paint, |ctx| ctx.stroke_path(path));
    }
}

/// Runs `f` with `p` as the paint, leaving no picture transform behind.
fn with_paint(ctx: &mut RenderContext, fr: &Frame, p: &Paint, f: impl FnOnce(&mut RenderContext)) {
    set_paint(ctx, p, fr);
    f(ctx);
    if matches!(p, Paint::Image { .. } | Paint::Pattern { .. }) {
        ctx.reset_paint_transform();
    }
}

/// A picture or pattern as the context's paint, its transform set from surface points (under the view). A picture
/// that cannot be decoded, or an empty cell, paints nothing.
pub(crate) fn set_picture_paint(ctx: &mut RenderContext, p: &Paint, fr: &Frame) {
    let clear = |ctx: &mut RenderContext| ctx.set_paint(color(ew_doc::props::Rgb::WHITE, 0.0));
    let (pm, [x, y, w, h], extend) = match p {
        Paint::Image { media, rect, repeat } => {
            let Some(pm) = pixmap_for(fr.media, media) else { return clear(ctx) };
            (pm, *rect, if *repeat { peniko::Extend::Repeat } else { peniko::Extend::Pad })
        }
        Paint::Pattern { cell, items } => {
            let Some(pm) = pattern_cell(fr, *cell, items) else { return clear(ctx) };
            (pm, *cell, peniko::Extend::Repeat)
        }
        _ => return,
    };
    let (pw, ph) = (pm.width().max(1) as f64, pm.height().max(1) as f64);
    let (x, y, w, h) = (f64::from(x), f64::from(y), f64::from(w), f64::from(h));
    if !(x.is_finite() && y.is_finite() && w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0) {
        return clear(ctx);
    }
    ctx.set_paint(vello_cpu::Image {
        image: vello_cpu::ImageSource::Pixmap(pm),
        sampler: peniko::ImageSampler::default().with_quality(peniko::ImageQuality::Medium).with_extend(extend),
    });
    ctx.set_paint_transform(Affine::new([w / pw, 0.0, 0.0, h / ph, x, y]));
}

/// A pattern's cell drawn at the view's scale (at most [`MAX_CELL_PX`] a side), to be repeated as a picture.
fn pattern_cell(fr: &Frame, [x, y, w, h]: [f32; 4], items: &[Draw]) -> Option<Arc<Pixmap>> {
    let (x, y, w, h) = (f64::from(x), f64::from(y), f64::from(w), f64::from(h));
    if !(x.is_finite() && y.is_finite() && w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0) || items.is_empty() {
        return None;
    }
    let px = crate::effects::px_per_pt(fr.view);
    let (cw, ch) = ((w * px).ceil().clamp(1.0, MAX_CELL_PX), (h * px).ceil().clamp(1.0, MAX_CELL_PX));
    let view = Affine::scale_non_uniform(cw / w, ch / h) * Affine::translate((-x, -y));
    let (w16, h16) = (cw as u16, ch as u16);
    let mut ctx = RenderContext::new_with(w16, h16, vello_cpu::RenderSettings { num_threads: 0, ..Default::default() });
    let visible = kurbo::Rect::new(x, y, x + w, y + h).inflate(1.0, 1.0);
    for it in items {
        draw(&mut ctx, fr.media, it, view, &visible, fr.opts);
    }
    Some(Arc::new(render_pixmap(&mut ctx)))
}

/// What `ctx` drew, as a premultiplied pixmap.
pub(crate) fn render_pixmap(ctx: &mut RenderContext) -> Pixmap {
    ctx.flush();
    let mut pm = Pixmap::new(ctx.width(), ctx.height());
    ctx.render(&mut pm, &mut Resources::new());
    pm
}

/// A group: its items in its frame, clipped, composited at its opacity and blend mode. One with effects is drawn
/// offscreen first ([`crate::effects`]).
pub(crate) fn draw_group(ctx: &mut RenderContext, fr: &Frame, g: &Group) {
    if g.items.is_empty() || g.opacity.is_nan() || g.opacity <= 0.0 || !g.transform.is_finite() || g.transform.determinant().abs() < 1e-12 {
        return;
    }
    if !g.effects.is_empty() {
        crate::effects::draw_group_offscreen(ctx, fr, g);
        return;
    }
    draw_clipped(ctx, fr, g, true);
}

/// Group `g`'s items in its frame and clip; with `layer`, inside the clip, composited at its opacity and blend mode.
pub(crate) fn draw_clipped(ctx: &mut RenderContext, fr: &Frame, g: &Group, layer: bool) {
    let Some(b) = crate::hit::group_bounds(g) else { return };
    if !b.overlaps(*fr.visible) {
        return;
    }
    let view = fr.view * g.transform;
    let mut local = g.transform.inverse().transform_rect_bbox(*fr.visible);
    if let Some((clip, rule)) = &g.clip {
        ctx.set_transform(view);
        ctx.set_fill_rule(fill_rule(*rule));
        ctx.push_clip_layer(clip);
        ctx.set_fill_rule(peniko::Fill::NonZero);
        local = local.intersect(clip.bounding_box());
    }
    let composite = layer && (g.opacity < 1.0 || g.blend != Blend::Normal);
    if composite {
        ctx.push_layer(None, Some(blend_mode(g.blend)), Some(g.opacity.min(1.0)), None, None);
    }
    for it in &g.items {
        draw(ctx, fr.media, it, view, &local, fr.opts);
    }
    if composite {
        ctx.pop_layer();
    }
    if g.clip.is_some() {
        ctx.pop_layer();
    }
}
