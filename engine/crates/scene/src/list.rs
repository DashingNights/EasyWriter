//! The display list of one surface (a page, a slide, a designer's frame) and the cache that keeps the lists the worker
//! paints tiles from, by owner (a session), surface and layout version, within a byte budget.

use std::collections::HashMap;
use std::sync::Arc;

use vello_cpu::kurbo::{self, Shape};
use ew_doc::props::Rgb;

use crate::draw::{Blend, Draw, Paint};
use crate::hit::bounds;
use crate::{MAX_SIDE, Rendered};

/// Items composited as a unit: drawn in order, then faded or blended as one picture, so where they overlap they don't
/// darken each other.
#[derive(Clone, Debug, PartialEq)]
pub struct Layer {
    pub items: Vec<Draw>,
    pub opacity: f32,
    pub blend: Blend,
    /// The surface's own background (a page's picture fill): left out under a reading paper.
    pub backdrop: bool,
}

impl Layer {
    /// `items` at full strength.
    pub fn of(items: Vec<Draw>) -> Layer {
        Layer { items, opacity: 1.0, blend: Blend::Normal, backdrop: false }
    }
}

/// A surface's display list: its size in points, its paper (an opaque background colour; `None` is transparent) and its
/// layers, bottom first. Each item's bounds are worked out once, for blank tiles and damage.
#[derive(Clone, Debug)]
pub struct DisplayList {
    pub w: f32,
    pub h: f32,
    pub paper: Option<Rgb>,
    layers: Vec<Layer>,
    boxes: Vec<Vec<Option<kurbo::Rect>>>,
}

impl PartialEq for DisplayList {
    fn eq(&self, o: &Self) -> bool {
        self.w == o.w && self.h == o.h && self.paper == o.paper && self.layers == o.layers
    }
}

impl DisplayList {
    pub fn new(w: f32, h: f32, paper: Option<Rgb>, layers: Vec<Layer>) -> DisplayList {
        let boxes = layers.iter().map(|l| l.items.iter().map(bounds).collect()).collect();
        DisplayList { w, h, paper, layers, boxes }
    }

    pub fn layers(&self) -> &[Layer] {
        &self.layers
    }

    /// The raster size of the whole surface at `scale` pixels a point.
    pub fn pixels(&self, scale: f32) -> (u32, u32) {
        let fin = |v: f32| if v.is_finite() { v.max(0.0) } else { 0.0 };
        (((fin(self.w) * scale).ceil() as u32).clamp(1, MAX_SIDE), ((fin(self.h).min(1e6) * scale).ceil() as u32).clamp(1, MAX_SIDE))
    }

    /// Whether any item (backdrop layers too, unless `skip_backdrop`) may paint inside `area` (surface points).
    pub fn meets(&self, area: kurbo::Rect, skip_backdrop: bool) -> bool {
        self.layers.iter().zip(&self.boxes).filter(|(l, _)| !(skip_backdrop && l.backdrop)).any(|(_, b)| b.iter().flatten().any(|b| b.overlaps(area)))
    }

    /// The areas (surface points) that differ from `old`: items that changed, came or went, by the items each list has
    /// in the same order at its start and end. A change of size, paper or layering is the whole surface.
    pub fn damage(&self, old: &DisplayList) -> Vec<kurbo::Rect> {
        let whole = vec![kurbo::Rect::new(0.0, 0.0, f64::from(self.w.max(old.w)), f64::from(self.h.max(old.h)))];
        if self.w != old.w || self.h != old.h || self.paper != old.paper || self.layers.len() != old.layers.len() {
            return whole;
        }
        let mut out = Vec::new();
        for (li, (a, b)) in self.layers.iter().zip(&old.layers).enumerate() {
            if (a.opacity, a.blend, a.backdrop) != (b.opacity, b.blend, b.backdrop) {
                return whole;
            }
            let (x, y) = (&a.items, &b.items);
            let head = x.iter().zip(y).take_while(|(p, q)| p == q).count();
            let tail = x[head..].iter().rev().zip(y[head..].iter().rev()).take_while(|(p, q)| p == q).count();
            let changed = self.boxes[li][head..x.len() - tail].iter().chain(&old.boxes[li][head..y.len() - tail]);
            if let Some(r) = changed.flatten().copied().reduce(|p, q| p.union(q)) {
                out.push(r);
            }
        }
        out
    }

    /// The bands (`(first, end, rows)`: device rows of the surface at `scale`, and the rows the content moved by) of `old`'s
    /// pixels that are this list's, moved: runs of items in the same order that are `old`'s moved straight up or down (lines
    /// below an Enter or a join) by the same rows, cut to where no other item of either list paints, and the rows no item of
    /// either list paints (`rows` 0: paper stays paper). A repaint copies those pixels instead of painting them again (tile.rs
    /// `repaint_tile`). Text lands on whole rows (lib.rs `snapped`), so lines a fraction of a row apart still move by whole
    /// rows, though not always by the same number: a run ends where that number changes. A run is looked for within
    /// [`MOVE_WINDOW`] items of where the last one ended.
    pub fn moves(&self, old: &DisplayList, scale: f32) -> Vec<(f64, f64, f64)> {
        let mut out = Vec::new();
        if self.w != old.w || self.h != old.h || self.paper != old.paper || self.layers.len() != old.layers.len() || !(scale > 0.0) {
            return out;
        }
        let s = f64::from(scale);
        let mut ink = [Ink::new(self, s), Ink::new(old, s)];
        for (li, (a, b)) in self.layers.iter().zip(&old.layers).enumerate() {
            if (a.opacity, a.blend, a.backdrop) != (b.opacity, b.blend, b.backdrop) {
                continue;
            }
            let (x, y) = (&a.items, &b.items);
            let (mut i, mut j0) = (0, 0);
            while i < x.len() {
                let near = &y[j0..y.len().min(j0 + MOVE_WINDOW)];
                let Some((j, rows)) = near.iter().enumerate().find_map(|(k, o)| moved_by(&x[i], o, s).map(|rows| (j0 + k, rows))) else {
                    i += 1;
                    continue;
                };
                let mut n = 1;
                while i + n < x.len() && j + n < y.len() && moved_by(&x[i + n], &y[j + n], s) == Some(rows) {
                    n += 1;
                }
                self.clean(old, li, (i..i + n, j..j + n), rows, &mut ink, &mut out);
                (i, j0) = (i + n, j + n);
            }
        }
        // Rows nothing paints in either list, where the old pixels are the paper's and so are the new.
        let mut spans: Vec<(f64, f64)> = Vec::new();
        for (side, list) in [self, old].into_iter().enumerate() {
            for (li, l) in list.layers.iter().enumerate() {
                spans.extend((0..l.items.len()).filter_map(|k| ink[side].get(li, k)));
            }
        }
        spans.sort_by(|p, q| p.0.total_cmp(&q.0));
        let mut from = 0.0;
        for (y0, y1) in spans {
            if y0 > from {
                out.push((from, y0, 0.0));
            }
            from = from.max(y1);
        }
        out.push((from, f64::from(old.pixels(scale).1), 0.0));
        out
    }

    /// Adds to `out` the parts of the band that `old`'s items `run.1` of layer `li` cover where no other item of `old`, and no
    /// item of this list but `run.0` (those items moved by `rows`), paints: there the old pixels moved by `rows` are the new
    /// ones.
    fn clean(&self, old: &DisplayList, li: usize, run: (std::ops::Range<usize>, std::ops::Range<usize>), rows: f64, ink: &mut [Ink; 2], out: &mut Vec<(f64, f64, f64)>) {
        let (mut b0, mut b1) = (f64::INFINITY, f64::NEG_INFINITY);
        for k in run.1.clone() {
            if let Some((y0, y1)) = ink[1].get(li, k) {
                (b0, b1) = (b0.min(y0), b1.max(y1));
            }
        }
        let mut keep = vec![(b0, b1)];
        for (side, skip, d) in [(1, &run.1, 0.0), (0, &run.0, rows)] {
            let list = if side == 1 { old } else { self };
            for (lj, l) in list.layers.iter().enumerate() {
                for k in (0..l.items.len()).filter(|k| lj != li || !skip.contains(k)) {
                    let Some((y0, y1)) = ink[side].get(lj, k) else { continue };
                    let (c0, c1) = (y0 - d, y1 - d);
                    if c1 <= b0 || c0 >= b1 {
                        continue;
                    }
                    let mut cut = Vec::with_capacity(keep.len() + 1);
                    for &(k0, k1) in &keep {
                        if k0 < c0.min(k1) {
                            cut.push((k0, c0.min(k1)));
                        }
                        if c1.max(k0) < k1 {
                            cut.push((c1.max(k0), k1));
                        }
                    }
                    keep = cut;
                }
            }
        }
        for (k0, k1) in keep {
            if k1 > k0 {
                out.push((k0, k1, rows));
            }
        }
    }

    /// About how many bytes the list holds (the cache's budget counts this).
    pub fn bytes(&self) -> usize {
        std::mem::size_of::<Self>() + self.layers.iter().map(|l| l.items.iter().map(item_bytes).sum::<usize>() + l.items.len() * 32).sum::<usize>()
    }

    /// The whole surface painted at `scale` (a thumbnail, a test).
    pub fn render(&self, media: &dyn crate::Media, scale: f32, opts: &crate::PaintOptions) -> Rendered {
        crate::render_list(self, media, scale, opts)
    }
}

/// How far past the end of the last moved run [`DisplayList::moves`] looks for the next: an edit's changed items between two
/// runs (the lines a paragraph wraps again) are seldom more.
const MOVE_WINDOW: usize = 64;

/// How far (points) a rule or a fill may be from a whole number of rows once moved: layout adds a line's height to an f32
/// position, so the lines below an Enter move by steps a few f32 units apart (about 6e-5 pt at a page's foot).
const MOVE_SLACK: f32 = 2.5e-4;

/// The whole device rows at `scale` item `a` has moved down from item `b`, when it paints as `b` moved straight up or down
/// (and all that shows equal; a glyph run's text and link do not): the text, rules and shading lines are made of. A glyph
/// run lands on whole rows (lib.rs `snapped`), each glyph by its own baseline, so its glyphs must all move by the same
/// rows; a rule or a fill is not moved to a row, so it must move by a whole number of them. Any other item moves only by 0,
/// when the two are equal.
fn moved_by(a: &Draw, b: &Draw, scale: f64) -> Option<f64> {
    let whole = |dy: f32| {
        let px = f64::from(dy) * scale;
        ((px - px.round()).abs() + f64::from(MOVE_SLACK) * scale <= 1.0 / 256.0).then_some(px.round())
    };
    match (a, b) {
        (
            Draw::Glyphs { face, size, glyphs, color, alpha, synth_bold, synth_italic, text_bg, x_scale, .. },
            Draw::Glyphs { face: f, size: s, glyphs: g, color: c, alpha: al, synth_bold: sb, synth_italic: si, text_bg: bg, x_scale: xs, .. },
        ) => {
            let row = |y: f32| (f64::from(y) * scale).round();
            let rows = row(glyphs.first()?.2) - row(g.first()?.2);
            let same = (size, glyphs.len(), face, color, alpha, synth_bold, synth_italic, text_bg, x_scale) == (s, g.len(), f, c, al, sb, si, bg, xs);
            (same && glyphs.iter().zip(g).all(|(p, q)| p.0 == q.0 && p.1 == q.1 && row(p.2) - row(q.2) == rows)).then_some(rows)
        }
        (Draw::Fill { rect, color, alpha, text_bg }, Draw::Fill { rect: r, color: c, alpha: al, text_bg: t }) => {
            if (rect.x, rect.w, rect.h, color, alpha, text_bg) == (r.x, r.w, r.h, c, al, t) { whole(rect.y - r.y) } else { None }
        }
        (
            Draw::Line { x0, y0, x1, y1, width, color, stroke, alpha, text_bg },
            Draw::Line { x0: a0, y0: b0, x1: a1, y1: b1, width: w, color: c, stroke: s, alpha: al, text_bg: t },
        ) => {
            let dy = y0 - b0;
            if (y1 - b1 - dy).abs() <= MOVE_SLACK && (x0, x1, width, color, stroke, alpha, text_bg) == (a0, a1, w, c, s, al, t) { whole(dy) } else { None }
        }
        _ => (a == b).then_some(0.0),
    }
}

thread_local! {
    /// A glyph's vertical extent in font units (y down), by face and glyph; `None` for a glyph with no outline.
    static GLYPH_SPANS: std::cell::RefCell<HashMap<(u32, u32), Option<(f64, f64)>>> = std::cell::RefCell::default();
}

/// The device rows `[first, end)` every item of a list paints in at `scale` (for a glyph run its outlines', exactly as it is
/// painted: baselines on whole rows; `bounds` gives three sizes up and two down, enough for the lines of a paragraph to
/// overlap), or `None` for an item that paints nothing. A fringe of antialiasing and stem darkening is counted. Every other
/// item has its box, a whole row more at each end.
struct Ink<'a> {
    list: &'a DisplayList,
    scale: f64,
    memo: Vec<Vec<Option<Option<(f64, f64)>>>>,
}

impl<'a> Ink<'a> {
    fn new(list: &'a DisplayList, scale: f64) -> Self {
        Ink { list, scale, memo: list.layers.iter().map(|l| vec![None; l.items.len()]).collect() }
    }

    fn get(&mut self, li: usize, k: usize) -> Option<(f64, f64)> {
        let (list, s) = (self.list, self.scale);
        *self.memo[li][k].get_or_insert_with(|| {
            let rows = match &list.layers[li].items[k] {
                Draw::Glyphs { face, size, glyphs, synth_bold, .. } if !face.has_color_glyphs() => {
                    let (db, size) = (ew_fonts::FontDb::global(), f64::from(*size));
                    let (unit, fringe) = (size / face.upem.max(1.0) * s, 0.3 + if *synth_bold { 0.015 * size * s } else { 0.0 });
                    GLYPH_SPANS.with_borrow_mut(|spans| {
                        let mut rows: Option<(f64, f64)> = None;
                        for &(gid, _, y) in glyphs {
                            let base = (f64::from(y) * s).round();
                            let span = *spans.entry((face.id(), gid)).or_insert_with(|| {
                                let o = db.outline(face, gid);
                                (!o.elements().is_empty()).then(|| o.bounding_box()).map(|b| (b.y0, b.y1))
                            });
                            // The bar a run too small to read is drawn as: from 0.45 sizes over the baseline to the baseline.
                            let (top, end) = span.map_or((base, base), |(y0, y1)| (base + y0 * unit - fringe, base + y1 * unit + fringe));
                            let (top, end) = (top.min(base - 0.45 * size * s).floor(), end.max(base).ceil());
                            rows = Some(rows.map_or((top, end), |r| (r.0.min(top), r.1.max(end))));
                        }
                        rows
                    })
                }
                _ => list.boxes[li][k].map(|r| ((r.y0 * s).floor() - 1.0, (r.y1 * s).ceil() + 1.0)),
            };
            rows.filter(|(a, b)| a.is_finite() && b.is_finite())
        })
    }
}

fn paint_bytes(p: &Paint) -> usize {
    match p {
        Paint::Linear { stops, .. } | Paint::Radial { stops, .. } => stops.len() * 12,
        Paint::Image { media, .. } => media.len(),
        Paint::Pattern { items, .. } => items.iter().map(item_bytes).sum(),
        Paint::Solid(..) => 0,
    }
}

fn item_bytes(d: &Draw) -> usize {
    let own = std::mem::size_of::<Draw>();
    own + match d {
        Draw::Glyphs { glyphs, text, link, ranges, .. } => glyphs.len() * 12 + text.len() + link.as_ref().map_or(0, String::len) + ranges.len() * 16,
        Draw::Image { media, alt, .. } => media.len() + alt.len(),
        Draw::Shape { dash, fill, .. } => dash.len() * 4 + fill.as_ref().map_or(0, paint_bytes),
        Draw::Ink { pts, .. } => pts.len() * 8,
        Draw::Path { segs, dash, fill, .. } => segs.len() * 28 + dash.len() * 4 + fill.as_ref().map_or(0, paint_bytes),
        Draw::Figure { alt, draws, .. } => alt.len() + draws.iter().map(item_bytes).sum::<usize>(),
        Draw::Turned { items, .. } | Draw::Rotated { items, .. } => items.iter().map(item_bytes).sum(),
        Draw::Clip { items, path, .. } => path.len() * 28 + items.iter().map(item_bytes).sum::<usize>(),
        Draw::Art { path, .. } => path.elements().len() * 56 + 256,
        Draw::MarkText { text, .. } => text.len(),
        Draw::Vector(v) => {
            v.path.elements().len() * 56 + v.fill.as_ref().map_or(0, paint_bytes) + v.pen.as_ref().map_or(0, |p| paint_bytes(&p.paint) + p.dash.len() * 4)
        }
        Draw::Group(g) => {
            g.clip.as_ref().map_or(0, |c| c.0.elements().len() * 56) + g.effects.len() * 32 + g.items.iter().map(item_bytes).sum::<usize>()
        }
        Draw::Fill { .. } | Draw::Line { .. } | Draw::Mark { .. } => 0,
    }
}

/// A cached list's key: its owner (a session), its surface (a page index, an object id) and the layout version it was
/// built from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ListKey {
    pub owner: u64,
    pub surface: u64,
    pub version: u64,
}

/// Display lists by [`ListKey`], least recently used dropped first past `cap` bytes. A list for a newer version of a
/// surface replaces the older ones, which nothing paints again.
pub struct ListCache {
    cap: usize,
    bytes: usize,
    tick: u64,
    map: HashMap<ListKey, (Arc<DisplayList>, usize, u64)>,
}

impl ListCache {
    pub fn new(cap: usize) -> ListCache {
        ListCache { cap, bytes: 0, tick: 0, map: HashMap::new() }
    }

    /// The list for `key`, built with `build` when it is not kept.
    pub fn get_or_build(&mut self, key: ListKey, build: impl FnOnce() -> DisplayList) -> Arc<DisplayList> {
        self.tick += 1;
        let tick = self.tick;
        if let Some(e) = self.map.get_mut(&key) {
            e.2 = tick;
            return e.0.clone();
        }
        let stale: Vec<ListKey> = self.map.keys().filter(|k| k.owner == key.owner && k.surface == key.surface).copied().collect();
        for k in stale {
            self.remove(k);
        }
        let list = Arc::new(build());
        let size = list.bytes();
        while self.bytes + size > self.cap && !self.map.is_empty() {
            let Some(oldest) = self.map.iter().min_by_key(|(_, e)| e.2).map(|(k, _)| *k) else { break };
            self.remove(oldest);
        }
        self.bytes += size;
        self.map.insert(key, (list.clone(), size, tick));
        list
    }

    /// The list kept for `owner`'s `surface`, whatever its version, with that version: what a surface's tiles were last
    /// painted from, to work out the damage of a new layout against it.
    pub fn latest(&self, owner: u64, surface: u64) -> Option<(u64, Arc<DisplayList>)> {
        self.map.iter().find(|(k, _)| k.owner == owner && k.surface == surface).map(|(k, e)| (k.version, e.0.clone()))
    }

    /// Drops every list of `owner` (a closed session).
    pub fn forget(&mut self, owner: u64) {
        let gone: Vec<ListKey> = self.map.keys().filter(|k| k.owner == owner).copied().collect();
        for k in gone {
            self.remove(k);
        }
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    fn remove(&mut self, k: ListKey) {
        if let Some((_, size, _)) = self.map.remove(&k) {
            self.bytes -= size;
        }
    }
}
