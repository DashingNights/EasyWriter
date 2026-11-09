//! The scene crate's general primitives in a PDF: vector paths with fill rules and pens, groups (transform, clip, blend
//! mode, opacity), picture and pattern fills, and whole display lists. A PDF has no blur, so a group with effects (a picture's
//! shadow, glow, reflection, soft edges, inner shadow or bevel) goes in as its picture, as the screen paints it.

use ew_scene::{Blend, Cap, DisplayList, Draw, Effect, FillRule as Rule, Group, Join, Paint, VectorPath};

use super::{Exporter, Fill, FillRule, LineCap, LineJoin, PathBuilder, Rect, Size, Stroke, StrokeDash, Surface, Transform, append_path, fill, krilla, norm, paint_fill};

/// Pixels a point a group with effects is embedded at: 216 pixels an inch, about as Word embeds a picture with effects.
const EFFECTS_PX: f32 = 3.0;

/// Most copies of a picture or pattern cell one fill draws.
const MAX_COPIES: f64 = 4096.0;

fn rule(r: Rule) -> FillRule {
    match r {
        Rule::NonZero => FillRule::NonZero,
        Rule::EvenOdd => FillRule::EvenOdd,
    }
}

fn blend(b: Blend) -> krilla::blend::BlendMode {
    use krilla::blend::BlendMode as B;
    match b {
        Blend::Normal => B::Normal,
        Blend::Multiply => B::Multiply,
        Blend::Screen => B::Screen,
        Blend::Overlay => B::Overlay,
        Blend::Darken => B::Darken,
        Blend::Lighten => B::Lighten,
        Blend::ColorDodge => B::ColorDodge,
        Blend::ColorBurn => B::ColorBurn,
        Blend::HardLight => B::HardLight,
        Blend::SoftLight => B::SoftLight,
        Blend::Difference => B::Difference,
        Blend::Exclusion => B::Exclusion,
        Blend::Hue => B::Hue,
        Blend::Saturation => B::Saturation,
        Blend::Color => B::Color,
        Blend::Luminosity => B::Luminosity,
    }
}

impl Exporter<'_> {
    pub(super) fn vector_path(&mut self, s: &mut Surface, v: &VectorPath) {
        let mut pb = PathBuilder::new();
        append_path(&mut pb, &v.path);
        let Some(p) = pb.finish() else { return };
        s.set_stroke(None);
        match &v.fill {
            Some(f @ (Paint::Image { .. } | Paint::Pattern { .. })) => {
                s.push_clip_path(&p, &rule(v.rule));
                self.picture_fill(s, f, kurbo::Shape::bounding_box(&v.path));
                s.pop();
            }
            Some(f) => {
                s.set_fill(Some(Fill { rule: rule(v.rule), ..paint_fill(f) }));
                s.draw_path(&p);
            }
            None => {}
        }
        s.set_fill(None);
        if let Some(pen) = &v.pen {
            let Fill { paint, opacity, .. } = paint_fill(&pen.paint);
            s.set_stroke(Some(Stroke {
                paint,
                width: if pen.width.is_finite() && pen.width > 0.0 { pen.width.min(2000.0) } else { 0.75 },
                miter_limit: if pen.miter.is_finite() { pen.miter.clamp(1.0, 100.0) } else { 4.0 },
                line_cap: match pen.cap {
                    Cap::Butt => LineCap::Butt,
                    Cap::Round => LineCap::Round,
                    Cap::Square => LineCap::Square,
                },
                line_join: match pen.join {
                    Join::Miter => LineJoin::Miter,
                    Join::Round => LineJoin::Round,
                    Join::Bevel => LineJoin::Bevel,
                },
                opacity,
                dash: (!pen.dash.is_empty() && pen.dash.iter().all(|d| d.is_finite() && *d >= 0.0) && pen.dash.iter().sum::<f32>() > 0.0)
                    .then(|| StrokeDash { array: pen.dash.clone(), offset: pen.dash_offset }),
            }));
            s.draw_path(&p);
            s.set_stroke(None);
        }
    }

    /// Copies of a picture or pattern cell over `area` (the clip is already set): one stretched picture, or a grid
    /// aligned to the picture's or cell's own place.
    fn picture_fill(&mut self, s: &mut Surface, p: &Paint, area: kurbo::Rect) {
        let ([x, y, w, h], repeat) = match p {
            Paint::Image { rect, repeat, .. } => (*rect, *repeat),
            Paint::Pattern { cell, .. } => (*cell, true),
            _ => return,
        };
        if !([x, y, w, h].iter().all(|v| v.is_finite()) && w > 0.0 && h > 0.0) {
            return;
        }
        let (cols, rows) = if repeat {
            let span = |lo: f64, hi: f64, at: f32, step: f32| (((lo - f64::from(at)) / f64::from(step)).floor(), ((hi - f64::from(at)) / f64::from(step)).ceil());
            (span(area.x0, area.x1, x, w), span(area.y0, area.y1, y, h))
        } else {
            ((0.0, 1.0), (0.0, 1.0))
        };
        let copies = (cols.1 - cols.0) * (rows.1 - rows.0);
        if copies.is_nan() || copies > MAX_COPIES {
            return;
        }
        let mut r = rows.0;
        while r < rows.1 {
            let mut c = cols.0;
            while c < cols.1 {
                let (cx, cy) = (x + w * c as f32, y + h * r as f32);
                match p {
                    Paint::Image { media, .. } => self.picture(s, &Rect::new(cx, cy, w, h), media, &[0.0; 4], 1.0),
                    Paint::Pattern { items, .. } => {
                        let Some(cell) = super::rect_path(&Rect::new(cx, cy, w, h)) else { return };
                        s.push_clip_path(&cell, &FillRule::NonZero);
                        s.push_transform(&Transform::from_translate(cx - x, cy - y));
                        for it in items {
                            self.draw(s, it);
                        }
                        s.pop();
                        s.pop();
                    }
                    _ => {}
                }
                c += 1.0;
            }
            r += 1.0;
        }
    }

    pub(super) fn group(&mut self, s: &mut Surface, g: &Group) {
        let c = g.transform.as_coeffs().map(|v| v as f32);
        if !c.iter().all(|v| v.is_finite()) || g.opacity.is_nan() || g.opacity <= 0.0 {
            return;
        }
        // EasyWriter engine-pictures-2: a picture's colour settings alone go on its own pixels, at its own resolution, so a
        // greyscale or transparency setting never downsamples a photo. Any other effect needs the group as one picture.
        let live = match g.effects.as_slice() {
            [] => None,
            [Effect::Adjust(live)] if self.raster_only(&g.items) => Some(*live),
            _ => {
                self.group_picture(s, g);
                return;
            }
        };
        s.push_transform(&Transform::from_row(c[0], c[1], c[2], c[3], c[4], c[5]));
        let mut pushed = 1;
        if let Some((clip, r)) = &g.clip {
            let mut pb = PathBuilder::new();
            append_path(&mut pb, clip);
            let Some(p) = pb.finish() else {
                s.pop();
                return;
            };
            s.push_clip_path(&p, &rule(*r));
            pushed += 1;
        }
        if g.blend != Blend::Normal {
            s.push_blend_mode(blend(g.blend));
            pushed += 1;
        }
        if g.opacity < 1.0 {
            s.push_opacity(norm(g.opacity));
            pushed += 1;
        }
        let outer = self.adjust;
        self.adjust = live.or(outer);
        for it in &g.items {
            self.draw(s, it);
        }
        self.adjust = outer;
        for _ in 0..pushed {
            s.pop();
        }
    }

    /// Whether `items` are bitmap pictures only (clipped, turned or described), which [`Exporter::adjust`] can draw.
    fn raster_only(&mut self, items: &[Draw]) -> bool {
        items.iter().all(|d| match d {
            Draw::Image { media, .. } => self.vector(media).is_none(),
            Draw::Clip { items, .. } | Draw::Rotated { items, .. } | Draw::Figure { draws: items, .. } => self.raster_only(items),
            Draw::Group(g) => g.effects.is_empty() && self.raster_only(&g.items),
            _ => false,
        })
    }

    /// EasyWriter engine-gaps-pictures: group `g` with its effects as the screen paints it, embedded as a picture at
    /// [`EFFECTS_PX`] pixels a point.
    fn group_picture(&mut self, s: &mut Surface, g: &Group) {
        let Some((img, area)) = ew_scene::render_group(g, self.media, EFFECTS_PX, &Default::default()) else { return };
        let Some(size) = Size::from_wh(area.w, area.h) else { return };
        let image = krilla::image::Image::from_rgba8(img.to_straight(), img.width, img.height);
        s.push_transform(&Transform::from_translate(area.x, area.y));
        s.draw_image(image, size);
        s.pop();
    }

    /// A whole display list: its paper, then each layer, a faded or blended one as one group.
    pub(crate) fn list(&mut self, s: &mut Surface, list: &DisplayList) {
        if let Some(paper) = list.paper
            && let Some(p) = super::rect_path(&Rect::new(0.0, 0.0, list.w, list.h))
        {
            s.set_stroke(None);
            s.set_fill(Some(fill(paper, 1.0)));
            s.draw_path(&p);
            s.set_fill(None);
        }
        for layer in list.layers() {
            let mut pushed = 0;
            if layer.blend != Blend::Normal {
                s.push_blend_mode(blend(layer.blend));
                pushed += 1;
            }
            if layer.opacity < 1.0 {
                s.push_opacity(norm(layer.opacity));
                pushed += 1;
            }
            for it in &layer.items {
                self.draw(s, it);
            }
            for _ in 0..pushed {
                s.pop();
            }
        }
    }
}
