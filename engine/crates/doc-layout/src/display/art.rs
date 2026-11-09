//! EasyWriter engine-gaps-rest: Word's basic page art borders (Design › Page Borders › Art), drawn as Word draws them. Word's
//! PDF of probe .smoke-data/word/fixture/out/probe/art (measure.py, Word for Microsoft 365, 2026-11-01) gives each one: square
//! tiles the art's width `s` at the corners, and between them tiles that fill the edge exactly, as many of a nominal length as
//! fit (`s`, or 2.5 `s` for the dashes). Shapes are placed across the band from its outer edge, in shares of `s`, black when
//! the colour is automatic. The pictorial kinds are Microsoft's pictures; they keep the dotted stand-in.

use ew_doc::para::ShapeKind;
use ew_doc::props::{Border, Rgb};

use super::paint::Stroke;
use super::{Draw, Paint, Rect};

/// The geometric kinds this draws.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    BlackDots,
    WhiteDots,
    BlackSquares,
    WhiteSquares,
    BlackDashes,
    WhiteDashes,
    ThinLines,
    WideInline,
    WideMidline,
    WideOutline,
}

fn kind(name: &str) -> Option<Kind> {
    Some(match name {
        "basicBlackDots" => Kind::BlackDots,
        "basicWhiteDots" => Kind::WhiteDots,
        "basicBlackSquares" => Kind::BlackSquares,
        "basicWhiteSquares" => Kind::WhiteSquares,
        "basicBlackDashes" => Kind::BlackDashes,
        "basicWhiteDashes" => Kind::WhiteDashes,
        "basicThinLines" => Kind::ThinLines,
        "basicWideInline" => Kind::WideInline,
        "basicWideMidline" => Kind::WideMidline,
        "basicWideOutline" => Kind::WideOutline,
        _ => return None,
    })
}

/// A thin line's width, in shares of `s` (0.17 pt at 12 pt, 0.34 to 0.41 at 24).
const HAIR: f32 = 0.015;

/// One edge of the band: start and end points (corner tile centres), `s` wide, its outer side on the left of its direction.
struct Edge {
    a: (f32, f32),
    u: (f32, f32),
    n: (f32, f32),
    len: f32,
    s: f32,
    color: Rgb,
    alpha: f32,
}

impl Edge {
    /// The page rectangle of the band piece from `t0` to `t1` along the edge (from its start point) and `v0` to `v1` across it
    /// (from its outer edge inwards).
    fn rect(&self, (t0, t1): (f32, f32), (v0, v1): (f32, f32)) -> Rect {
        let pt = |t: f32, v: f32| {
            let off = self.s / 2.0 - v;
            (self.a.0 + self.u.0 * t + self.n.0 * off, self.a.1 + self.u.1 * t + self.n.1 * off)
        };
        let (p, q) = (pt(t0, v0), pt(t1, v1));
        Rect::new(p.0.min(q.0), p.1.min(q.1), (p.0 - q.0).abs(), (p.1 - q.1).abs())
    }
    fn fill(&self, r: Rect, color: Rgb, out: &mut Vec<Draw>) {
        out.push(Draw::Fill { rect: r, color, alpha: self.alpha, text_bg: false });
    }
    fn shape(&self, r: Rect, kind: ShapeKind, (fill, stroke): (Option<Rgb>, Option<Rgb>), out: &mut Vec<Draw>) {
        out.push(Draw::Shape {
            rect: r,
            kind,
            fill: fill.map(|c| Paint::Solid(c, self.alpha)),
            stroke,
            stroke_width: HAIR * self.s,
            effects: Default::default(),
            corner: None,
            dash: Vec::new(),
            cap: Default::default(),
        });
    }
    /// A line across the whole edge at `v` from the outer edge, reaching the corners' outer extent less `v`.
    fn line(&self, v: f32, out: &mut Vec<Draw>) {
        let r = self.rect((-self.s / 2.0 + v, self.len + self.s / 2.0 - v), (v, v));
        let (x1, y1) = (r.x + r.w, r.y + r.h);
        out.push(Draw::Line { x0: r.x, y0: r.y, x1, y1, width: HAIR * self.s, color: self.color, stroke: Stroke::Solid, alpha: self.alpha, text_bg: None });
    }
    /// A band across the whole edge from `v0` to `v1`, meeting the other edges' at the corners.
    fn band(&self, (v0, v1): (f32, f32), out: &mut Vec<Draw>) {
        let r = self.rect((-self.s / 2.0 + v0, self.len + self.s / 2.0 - v0), (v0, v1));
        self.fill(r, self.color, out);
    }
}

/// Draws an art border edge from (`x0`, `y0`) to (`x1`, `y1`) when its art is one of the basic kinds → whether it did.
pub(super) fn art_edge((x0, y0, x1, y1): (f32, f32, f32, f32), b: &Border, alpha: f32, out: &mut Vec<Draw>) -> bool {
    let Some(k) = kind(b.style.ooxml()) else { return false };
    let len = (x1 - x0).hypot(y1 - y0);
    let s = b.width.clamp(1.0, 31.0);
    if !(len.is_finite() && len > 0.0) {
        return false;
    }
    let u = ((x1 - x0) / len, (y1 - y0) / len);
    let e = Edge { a: (x0, y0), u, n: (u.1, -u.0), len, s, color: b.color.unwrap_or(Rgb::BLACK), alpha };
    let white = Rgb::WHITE;
    match k {
        Kind::ThinLines => {
            e.line(0.0, out);
            e.line(s, out);
        }
        Kind::WideInline => {
            e.line(0.0, out);
            e.band((0.4 * s, s), out);
        }
        Kind::WideMidline => {
            e.line(0.0, out);
            e.band((0.286 * s, 0.706 * s), out);
            e.line(s, out);
        }
        Kind::WideOutline => {
            e.band((0.0, 0.588 * s), out);
            e.line(s, out);
        }
        Kind::BlackDashes | Kind::WhiteDashes => dashes(&e, k == Kind::WhiteDashes, out),
        _ => tiles(&e, k, white, out),
    }
    true
}

/// The tiled kinds (dots and squares): a shape in each corner tile and in each tile between.
fn tiles(e: &Edge, k: Kind, white: Rgb, out: &mut Vec<Draw>) {
    let s = e.s;
    let inner = e.len - s;
    let n = (inner / s).floor().max(1.0);
    let p = inner / n;
    let mut cells: Vec<(f32, f32)> = vec![(-s / 2.0, s / 2.0), (e.len - s / 2.0, e.len + s / 2.0)];
    cells.extend((0..n as usize).map(|i| (s / 2.0 + p * i as f32, s / 2.0 + p * (i as f32 + 1.0))));
    for (t0, t1) in cells {
        let mid = (t0 + t1) / 2.0;
        let part = |d: f32| e.rect((mid - d * s / 2.0, mid + d * s / 2.0), (s / 2.0 - d * s / 2.0, s / 2.0 + d * s / 2.0));
        match k {
            Kind::BlackDots => e.shape(part(0.276), ShapeKind::Ellipse, (Some(e.color), None), out),
            Kind::WhiteDots => {
                e.fill(e.rect((t0, t1), (0.0, s)), e.color, out);
                e.shape(part(0.276), ShapeKind::Ellipse, (Some(white), None), out);
            }
            Kind::BlackSquares => e.fill(part(0.324), e.color, out),
            _ => e.shape(part(0.324), ShapeKind::Rectangle, (Some(white), Some(e.color)), out),
        }
    }
}

/// The dashes: an L in each corner and a dash in each 2.5 `s` tile between, on the band's outer side (Word: 0.6 of the tile
/// long, from 0.2 of it; 0.476 `s` thick from 0.03 `s` in; the white ones outlined, 0.44 `s` thick, 0.67 long from 0.16).
fn dashes(e: &Edge, outline: bool, out: &mut Vec<Draw>) {
    let s = e.s;
    let inner = e.len - s;
    let n = (inner / (2.5 * s)).floor().max(1.0);
    let p = inner / n;
    let (v0, v1, from, long) = if outline { (0.02 * s, 0.46 * s, 0.164, 0.67) } else { (0.03 * s, 0.506 * s, 0.2, 0.6) };
    let piece = |r: Rect, out: &mut Vec<Draw>| {
        if outline { e.shape(r, ShapeKind::Rectangle, (None, Some(e.color)), out) } else { e.fill(r, e.color, out) }
    };
    // The corners: this edge's arm of the L at each end (the other edge draws the other arm).
    piece(e.rect((-s / 2.0 + v0, s / 2.0 - 0.01 * s), (v0, v1)), out);
    piece(e.rect((e.len - s / 2.0 + 0.01 * s, e.len + s / 2.0 - v0), (v0, v1)), out);
    for i in 0..n as usize {
        let t = s / 2.0 + p * i as f32;
        piece(e.rect((t + from * p, t + (from + long) * p), (v0, v1)), out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ew_doc::props::BorderStyle;

    fn art(name: &str) -> Border {
        Border { style: BorderStyle::from_ooxml(name), width: 12.0, color: None, space: 24.0 }
    }
    fn rects(d: &[Draw]) -> Vec<(f32, f32, f32, f32)> {
        d.iter()
            .filter_map(|x| match x {
                Draw::Shape { rect, .. } | Draw::Fill { rect, .. } => Some((rect.x, rect.y, rect.w, rect.h)),
                _ => None,
            })
            .collect()
    }

    /// Word's probe page (Letter, 1 in margins, 24 pt from the text, 12 pt art): the top band from 36 to 48 pt down, its corner
    /// tiles centred 42 pt in, dots 3.3 pt across in the middle of each tile; dashes 18 pt long, 5.7 pt thick from 0.36 pt in.
    #[test]
    fn basic_art_sits_where_word_draws_it() {
        let mut out = Vec::new();
        assert!(art_edge((42.0, 42.0, 570.0, 42.0), &art("basicBlackDots"), 1.0, &mut out));
        let r = rects(&out);
        let (x, y, w, h) = r[0];
        assert!((x - 40.34).abs() < 0.1 && (y - 40.34).abs() < 0.1 && (w - 3.31).abs() < 0.05 && (h - 3.31).abs() < 0.05, "{r:?}");
        assert_eq!(r.len(), 2 + 43, "a corner at each end and a dot a tile between");
        out.clear();
        art_edge((42.0, 42.0, 570.0, 42.0), &art("basicBlackDashes"), 1.0, &mut out);
        let dash = rects(&out)[2];
        assert!((dash.1 - 36.36).abs() < 0.05 && (dash.3 - 5.71).abs() < 0.05 && (dash.2 - 18.0).abs() < 0.5, "{dash:?}");
        // The left edge runs up the page (clockwise): its outer side is still the page's edge.
        out.clear();
        art_edge((42.0, 750.0, 42.0, 42.0), &art("basicWideOutline"), 1.0, &mut out);
        let band = rects(&out)[0];
        assert!((band.0 - 36.0).abs() < 0.01 && (band.2 - 7.06).abs() < 0.05, "{band:?}");
        assert!(!art_edge((42.0, 42.0, 570.0, 42.0), &art("apples"), 1.0, &mut out), "a pictorial art keeps its stand-in");
    }
}
