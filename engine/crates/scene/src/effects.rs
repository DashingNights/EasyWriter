//! A group's effects: the group is drawn alone into a picture of its own (device pixels, single-threaded), the effects are
//! worked out on that picture's pixels, and the result is composited where the group stands. vello_cpu's own filters are
//! experimental and panic in its multi-threaded contexts, which native rendering uses, so the effects are done here, the
//! same in the worker and natively. Blurs are three box blurs (close to a Gaussian).

use vello_cpu::kurbo::{self, Affine};
use vello_cpu::color::PremulRgba8;
use vello_cpu::{Pixmap, RenderContext, peniko};

use crate::vector::{blend_mode, fill_rule, render_pixmap};
use crate::{Effect, Frame, Group, draw};

/// Largest side of a group's offscreen picture; a larger one is cut to it (its effects at the cut edge are wrong).
// ponytail: a cut, not a scale-down; a designer's huge blurred frame at a high zoom wants the picture drawn smaller.
const MAX_SIDE_PX: f64 = 4096.0;

/// One device pixel's size in points under `view`, inverted: device pixels a point (the mean axis scale).
pub(crate) fn px_per_pt(view: Affine) -> f64 {
    let c = view.as_coeffs();
    let s = (c[0].hypot(c[1]) + c[2].hypot(c[3])) / 2.0;
    if s.is_finite() && s > 1e-9 { s } else { 1.0 }
}

/// How far the effects reach past the group's content, in points, for content `h` points tall.
pub(crate) fn reach(effects: &[Effect], h: f64) -> f64 {
    let fin = |v: f32| if v.is_finite() { f64::from(v).abs().min(1e4) } else { 0.0 };
    effects
        .iter()
        .map(|e| match *e {
            Effect::Shadow { dx, dy, blur, .. } => fin(dx).max(fin(dy)) + 3.0 * fin(blur),
            Effect::Glow { radius, .. } => 3.0 * fin(radius),
            Effect::SoftEdge { .. } => 0.0,
            Effect::Blur { radius } => 3.0 * fin(radius),
            Effect::Reflection { gap, size, blur, .. } => fin(gap) + h * fin(size).min(1.0) + 3.0 * fin(blur),
            // Nothing outside, but the silhouette's surroundings are what it casts in from.
            Effect::InnerShadow { dx, dy, blur, .. } => fin(dx).max(fin(dy)) + 3.0 * fin(blur),
            Effect::Adjust(_) => 0.0,
        })
        .fold(0.0, f64::max)
}

/// The resolution of a group's offscreen picture, in its pixels a device pixel, at `px` device pixels a point with the
/// effects reaching `far` device pixels round a raster `side` pixels a side (a tile's). Below 1 only when every effect lies
/// under the group (shadow, glow, reflection), which is then drawn over them at full resolution: when the effects are
/// blurred wider than 8 pixels (a coarser picture loses nothing a blur keeps) or reach so far that the picture would hold
/// more than four rasters' worth of pixels. Without it a tile's picture grew with the zoom squared: at 500 % a 100 pt
/// blur made every tile of its page render a 4,096 px square, about 3.7 s and 400 MB of wasm memory each (engine-zoom-tiles).
/// On the 1/512 grid, so the pictures of neighbouring tiles (512 device pixels apart) sample at the same phase.
fn resolution(effects: &[Effect], px: f64, far: f64, side: f64) -> f64 {
    let mut sigma = f64::INFINITY;
    for e in effects {
        let v = match *e {
            Effect::Shadow { blur, .. } | Effect::Reflection { blur, .. } => blur,
            Effect::Glow { radius, .. } => radius,
            _ => return 1.0,
        };
        sigma = sigma.min(if v.is_finite() { (f64::from(v).abs() * px).min(1000.0) / 2.0 } else { 0.0 });
    }
    let k = (2.0 * side / (side + 2.0 * far)).min(8.0 / sigma).min(1.0);
    (k * 512.0).floor().max(1.0) / 512.0
}

pub(crate) fn draw_group_offscreen(ctx: &mut RenderContext, fr: &Frame, g: &Group) {
    let Some(content) = crate::hit::content_bounds(g) else { return };
    let px = px_per_pt(fr.view);
    let far = reach(&g.effects, content.height()) * px;
    let device = fr.view.transform_rect_bbox(content).inflate(far, far);
    // What this raster can show, plus what can cast an effect into it.
    let (cw, ch) = (f64::from(ctx.width()), f64::from(ctx.height()));
    let shown = kurbo::Rect::new(0.0, 0.0, cw, ch).inflate(far, far);
    let full = device.intersect(shown);
    if !(full.width() >= 1.0 && full.height() >= 1.0) {
        return;
    }
    let k = resolution(&g.effects, px, far, cw.max(ch).max(f64::from(crate::TILE)));
    let area = kurbo::Rect::new(full.x0 * k, full.y0 * k, full.x1 * k, full.y1 * k).expand();
    let area = kurbo::Rect::new(area.x0, area.y0, area.x0 + area.width().min(MAX_SIDE_PX), area.y0 + area.height().min(MAX_SIDE_PX));
    let (w, h) = (area.width() as u16, area.height() as u16);
    let mut sub = RenderContext::new_with(w, h, vello_cpu::RenderSettings { num_threads: 0, ..Default::default() });
    let view = Affine::translate((-area.x0, -area.y0)) * Affine::scale(k) * fr.view * g.transform;
    let visible = view.inverse().transform_rect_bbox(kurbo::Rect::new(0.0, 0.0, f64::from(w), f64::from(h))).inflate(40.0, 40.0);
    if let Some((clip, rule)) = &g.clip {
        sub.set_transform(view);
        sub.set_fill_rule(fill_rule(*rule));
        sub.push_clip_layer(clip);
        sub.set_fill_rule(peniko::Fill::NonZero);
    }
    for it in &g.items {
        draw(&mut sub, fr.media, it, view, &visible, fr.opts);
    }
    if g.clip.is_some() {
        sub.pop_layer();
    }
    // A coarser picture holds only the effects; the group goes over them at the tile's resolution.
    let sharp = k < 1.0;
    let mut pic = Picture::of(&render_pixmap(&mut sub));
    pic.apply(&g.effects, px * k, |c| fr.opts.ink(c), !sharp);
    ctx.set_transform(Affine::scale(1.0 / k));
    let composite = g.opacity < 1.0 || g.blend != crate::Blend::Normal;
    if composite {
        ctx.push_layer(None, Some(blend_mode(g.blend)), Some(g.opacity.min(1.0)), None, None);
    }
    let quality = if sharp { peniko::ImageQuality::Medium } else { peniko::ImageQuality::Low };
    ctx.set_paint(vello_cpu::Image {
        image: vello_cpu::ImageSource::Pixmap(std::sync::Arc::new(pic.pixmap())),
        sampler: peniko::ImageSampler::default().with_quality(quality),
    });
    ctx.set_paint_transform(Affine::translate((area.x0, area.y0)));
    ctx.fill_rect(&area);
    ctx.reset_paint_transform();
    if sharp {
        crate::vector::draw_clipped(ctx, fr, g, false);
    }
    if composite {
        ctx.pop_layer();
    }
}

/// A premultiplied RGBA picture, row by row.
pub(crate) struct Picture {
    pub(crate) w: usize,
    pub(crate) h: usize,
    pub(crate) px: Vec<[u8; 4]>,
}

impl Picture {
    fn of(pm: &Pixmap) -> Picture {
        let px = pm.data().iter().map(|p| [p.r, p.g, p.b, p.a]).collect();
        Picture { w: usize::from(pm.width()), h: usize::from(pm.height()), px }
    }

    fn pixmap(&self) -> Pixmap {
        let data = self.px.iter().map(|&[r, g, b, a]| PremulRgba8 { r, g, b, a }).collect();
        Pixmap::from_parts(data, self.w as u16, self.h as u16)
    }

    fn alpha(&self) -> Vec<u8> {
        self.px.iter().map(|p| p[3]).collect()
    }

    /// The effects at `px` device pixels a point. Behind the picture, back to front: reflection, shadow, glow. The
    /// picture itself first loses its edges (soft edge) and is blurred. `ink` maps an effect's colour to the screen's.
    /// Without `content`, the picture keeps only what lies under it (the group is drawn over that apart).
    pub(crate) fn apply(&mut self, effects: &[Effect], px: f64, ink: impl Fn(ew_doc::props::Rgb) -> ew_doc::props::Rgb, content: bool) {
        let size = |v: f32| if v.is_finite() { (f64::from(v).abs() * px).min(1000.0) } else { 0.0 };
        // A picture's colour settings first: the effects below take the picture as it is shown.
        for e in effects {
            if let Effect::Adjust(live) = e {
                for p in &mut self.px {
                    *p = adjusted(live, *p);
                }
            }
        }
        for e in effects {
            match *e {
                Effect::SoftEdge { radius } => {
                    let b = blur_channel(&self.alpha(), self.w, self.h, size(radius) / 2.0);
                    for (p, m) in self.px.iter_mut().zip(b) {
                        let keep = u32::from(m).saturating_mul(2).saturating_sub(255).min(255);
                        *p = p.map(|c| (u32::from(c) * keep / 255) as u8);
                    }
                }
                Effect::Blur { radius } => {
                    let px = std::mem::take(&mut self.px);
                    self.px = self.blurred(px, size(radius));
                }
                _ => {}
            }
        }
        // Inner shadows and a bevel's light and shade, inside the picture's silhouette, in the order given.
        for e in effects {
            if let Effect::InnerShadow { dx, dy, blur, color, alpha } = *e {
                let a = self.alpha();
                let outside: Vec<u8> = a.iter().map(|v| 255 - v).collect();
                // Word's probe (engine-gaps-pictures): the shadow lies along the edges its direction points to, so what lies
                // outside is moved the other way, over those edges.
                let cast = blur_channel(&self.moved_with(&outside, -shift(dx, px), -shift(dy, px), 255), self.w, self.h, size(blur) / 2.0);
                let layer = self.tinted(&cast, ink(color), alpha);
                for (p, l) in self.px.iter_mut().zip(layer) {
                    *p = atop(l, *p);
                }
            }
        }
        let mut under = vec![[0u8; 4]; self.px.len()];
        for e in effects {
            let layer: Option<Vec<[u8; 4]>> = match *e {
                Effect::Reflection { gap, size: frac, alpha, blur } => Some(self.blurred(self.reflection(size(gap), frac, alpha), size(blur) / 2.0)),
                Effect::Shadow { dx, dy, blur, color, alpha } => {
                    let a = blur_channel(&self.alpha(), self.w, self.h, size(blur) / 2.0);
                    let (dx, dy) = (shift(dx, px), shift(dy, px));
                    Some(self.tinted(&self.moved(&a, dx, dy), ink(color), alpha))
                }
                Effect::Glow { radius, color, alpha } => {
                    // The silhouette grown by about the radius: blurred, then doubled.
                    let a: Vec<u8> = blur_channel(&self.alpha(), self.w, self.h, size(radius) / 2.0).iter().map(|v| (u32::from(*v) * 2).min(255) as u8).collect();
                    Some(self.tinted(&a, ink(color), alpha))
                }
                Effect::SoftEdge { .. } | Effect::Blur { .. } | Effect::InnerShadow { .. } | Effect::Adjust(_) => None,
            };
            if let Some(l) = layer {
                for (u, l) in under.iter_mut().zip(l) {
                    *u = over(l, *u);
                }
            }
        }
        for (p, u) in self.px.iter_mut().zip(under) {
            *p = if content { over(*p, u) } else { u };
        }
    }

    /// The picture mirrored about its bottom edge onto the rows `gap` pixels below it, fading from `alpha` to nothing over
    /// `frac` of its height.
    fn reflection(&self, gap: f64, frac: f32, alpha: f32) -> Vec<[u8; 4]> {
        let mut out = vec![[0u8; 4]; self.px.len()];
        let top = self.px.chunks(self.w).position(|r| r.iter().any(|p| p[3] > 0)).unwrap_or(self.h) as f64;
        let height = (bottom_of(self) - top).max(1.0);
        let fade_rows = (height * f64::from(frac.clamp(0.0, 1.0))).max(1.0);
        let a = f64::from(alpha.clamp(0.0, 1.0));
        let src_bottom = bottom_of(self);
        let at = src_bottom + gap;
        for y in 0..self.h {
            let d = y as f64 - at;
            if d < 0.0 || d >= fade_rows {
                continue;
            }
            let sy = src_bottom - 1.0 - d;
            if sy < 0.0 {
                continue;
            }
            let k = a * (1.0 - d / fade_rows);
            let (row, src) = (y * self.w, sy as usize * self.w);
            for x in 0..self.w {
                out[row + x] = self.px[src + x].map(|c| (f64::from(c) * k) as u8);
            }
        }
        out
    }

    /// A premultiplied layer blurred by `sigma` pixels, each channel alike (the picture for `Effect::Blur`, a reflection).
    fn blurred(&self, layer: Vec<[u8; 4]>, sigma: f64) -> Vec<[u8; 4]> {
        let chans: Vec<Vec<u8>> = (0..4).map(|k| blur_channel(&layer.iter().map(|p| p[k]).collect::<Vec<_>>(), self.w, self.h, sigma)).collect();
        (0..layer.len()).map(|i| [chans[0][i], chans[1][i], chans[2][i], chans[3][i]]).collect()
    }

    /// `a` moved by (`dx`, `dy`) whole pixels.
    fn moved(&self, a: &[u8], dx: i64, dy: i64) -> Vec<u8> {
        self.moved_with(a, dx, dy, 0)
    }

    /// `a` moved by (`dx`, `dy`) whole pixels, `edge` where it moves in from past the picture's sides.
    fn moved_with(&self, a: &[u8], dx: i64, dy: i64, edge: u8) -> Vec<u8> {
        let (w, h) = (self.w as i64, self.h as i64);
        let mut out = vec![edge; a.len()];
        for y in 0..h {
            let sy = y - dy;
            if sy < 0 || sy >= h {
                continue;
            }
            for x in 0..w {
                let sx = x - dx;
                if sx >= 0 && sx < w {
                    out[(y * w + x) as usize] = a[(sy * w + sx) as usize];
                }
            }
        }
        out
    }

    /// Coverage `a` in colour `c` at opacity `alpha`, premultiplied.
    fn tinted(&self, a: &[u8], c: ew_doc::props::Rgb, alpha: f32) -> Vec<[u8; 4]> {
        let k = if alpha.is_finite() { alpha.clamp(0.0, 1.0) } else { 1.0 };
        a.iter()
            .map(|v| {
                let a = f32::from(*v) * k;
                let ch = |c: u8| (f32::from(c) * a / 255.0).round() as u8;
                [ch(c.0), ch(c.1), ch(c.2), a.round() as u8]
            })
            .collect()
    }
}

/// Premultiplied pixel `p` with `live` drawn on it.
fn adjusted(live: &ew_doc::adjust::Live, p: [u8; 4]) -> [u8; 4] {
    let a = u32::from(p[3]);
    if a == 0 {
        return p;
    }
    let straight = [0, 1, 2].map(|i| ((u32::from(p[i]) * 255 + a / 2) / a).min(255) as u8);
    let [r, g, b, na] = live.apply([straight[0], straight[1], straight[2], p[3]]);
    let k = u32::from(na);
    let m = |c: u8| ((u32::from(c) * k + 127) / 255) as u8;
    [m(r), m(g), m(b), na]
}

/// The row under the picture's last row with ink.
fn bottom_of(p: &Picture) -> f64 {
    p.px.chunks(p.w.max(1)).rposition(|r| r.iter().any(|q| q[3] > 0)).map_or(0.0, |y| y as f64 + 1.0)
}

fn shift(v: f32, px: f64) -> i64 {
    if v.is_finite() { (f64::from(v) * px).round().clamp(-1e5, 1e5) as i64 } else { 0 }
}

/// `a` over `b` where `b` is, `b`'s coverage kept, premultiplied (source-atop).
fn atop(a: [u8; 4], b: [u8; 4]) -> [u8; 4] {
    let (ka, kb) = (u32::from(b[3]), 255 - u32::from(a[3]));
    let c = |i: usize| ((u32::from(a[i]) * ka + u32::from(b[i]) * kb + 127) / 255).min(255) as u8;
    [c(0), c(1), c(2), b[3]]
}

/// `a` over `b`, premultiplied.
fn over(a: [u8; 4], b: [u8; 4]) -> [u8; 4] {
    let k = 255 - u32::from(a[3]);
    [0, 1, 2, 3].map(|i| (u32::from(a[i]) + (u32::from(b[i]) * k + 127) / 255).min(255) as u8)
}

/// One channel blurred with standard deviation `sigma` pixels: three box blurs each way, of radius about `sigma`.
pub(crate) fn blur_channel(v: &[u8], w: usize, h: usize, sigma: f64) -> Vec<u8> {
    let r = sigma.round().clamp(0.0, 500.0) as usize;
    if r == 0 || w == 0 || h == 0 {
        return v.to_vec();
    }
    let mut a: Vec<u32> = v.iter().map(|x| u32::from(*x)).collect();
    let mut tmp = vec![0u32; a.len()];
    for _ in 0..3 {
        box_pass(&a, &mut tmp, w, h, r, true);
        box_pass(&tmp, &mut a, w, h, r, false);
    }
    a.iter().map(|x| (*x).min(255) as u8).collect()
}

/// A box blur of radius `r` along rows (`across`) or columns; past the edges counts as empty.
fn box_pass(src: &[u32], dst: &mut [u32], w: usize, h: usize, r: usize, across: bool) {
    let (lines, len) = if across { (h, w) } else { (w, h) };
    let at = |line: usize, i: usize| if across { line * w + i } else { i * w + line };
    let n = (2 * r + 1) as u32;
    for line in 0..lines {
        let mut sum: u32 = (0..=r.min(len - 1)).map(|i| src[at(line, i)]).sum();
        for i in 0..len {
            dst[at(line, i)] = (sum + n / 2) / n;
            if i + r + 1 < len {
                sum += src[at(line, i + r + 1)];
            }
            if i >= r {
                sum -= src[at(line, i - r)];
            }
        }
    }
}
