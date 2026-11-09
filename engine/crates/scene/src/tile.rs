//! Tiles: a surface painted in squares of [`TILE`] device pixels (docs/plans/engine/measure.md set 512), into one buffer
//! the caller reuses. A tile no item reaches is not painted: the surface's own background (a page slot's CSS colour)
//! shows there.

use vello_cpu::kurbo::{self, Affine};
use vello_cpu::{RenderContext, Resources};

use crate::{DisplayList, Media, PaintOptions, context_pool, paint_list};

/// A tile's side in device pixels.
pub const TILE: u32 = 512;

/// One tile of a surface: column `col` and row `row` of its [`TILE`]-pixel grid at `scale` device pixels a point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tile {
    pub scale: f32,
    pub col: u32,
    pub row: u32,
}

/// What a tile looked like before a change, for [`repaint_tile`]: its pixels (as [`paint_tile`] left them), where the list
/// changed since they were painted ([`DisplayList::damage`], surface points) and the bands that only moved
/// ([`DisplayList::moves`], worked out at this tile's scale).
pub struct Before<'a> {
    pub pixels: &'a [u8],
    pub damage: &'a [kurbo::Rect],
    pub moves: &'a [(f64, f64, f64)],
}

/// Paints `tile` of `list` into `buf` (resized to fit, row-major RGBA) and returns its size in pixels: [`TILE`] a side, less
/// at the surface's right and bottom edges, so the tiles together are the surface's [`DisplayList::pixels`]. The pixels
/// are premultiplied, which is straight alpha on an opaque surface (alpha is 255 everywhere); a transparent surface's are
/// made straight here. `None`, with `buf` untouched, for a tile outside the surface or one no item reaches (but under forced
/// colours, which paint the paper too).
pub fn paint_tile(list: &DisplayList, media: &dyn Media, tile: Tile, opts: &PaintOptions, buf: &mut Vec<u8>) -> Option<(u32, u32)> {
    repaint_tile(list, media, tile, opts, None, buf, &mut Vec::new()).map(|(w, h, _)| (w, h))
}

/// [`paint_tile`], starting from the tile's pixels `before` a change when given (engine-paint-damage): rows no damage meets
/// keep their pixels, rows that only moved content covers are copied from where they were in the tile, and the other rows
/// are painted in bands, each with the whole tile's transform and the items that reach it. Painted and kept rows are a whole
/// paint's bytes; a copied row is within 1 of them. `scratch` takes a band's raster. → the size and the pixels painted.
pub fn repaint_tile(list: &DisplayList, media: &dyn Media, tile: Tile, opts: &PaintOptions, before: Option<Before>, buf: &mut Vec<u8>, scratch: &mut Vec<u8>) -> Option<(u32, u32, u32)> {
    let scale = if tile.scale.is_finite() && tile.scale > 0.0 { tile.scale } else { return None };
    let (sw, sh) = list.pixels(scale);
    let (x0, y0) = (tile.col.checked_mul(TILE)?, tile.row.checked_mul(TILE)?);
    if x0 >= sw || y0 >= sh {
        return None;
    }
    let (w, h) = ((sw - x0).min(TILE), (sh - y0).min(TILE));
    // Whole device pixels from the surface's origin, so the tiles meet without a seam.
    let view = Affine::translate((-f64::from(x0), -f64::from(y0))) * Affine::scale(f64::from(scale));
    let area = view.inverse().transform_rect_bbox(kurbo::Rect::new(0.0, 0.0, f64::from(w), f64::from(h)));
    // Under forced colours the paper is the system's, which the slot's own colour may not be: every tile is painted.
    if opts.forced.is_none() && !list.meets(area, opts.read_paper.is_some()) {
        return None;
    }
    let (row_bytes, s) = (w as usize * 4, f64::from(scale));
    let mut paint = vec![true; h as usize];
    match before {
        Some(b) if b.pixels.len() == row_bytes * h as usize => {
            buf.clear();
            buf.extend_from_slice(b.pixels);
            paint.fill(false);
            // Rows a damage rect meets, with a device pixel's margin for antialiasing (tiles.mjs `untouched` spares the rest).
            let m = 1.0 / s;
            for r in b.damage.iter().filter(|r| r.x0 - m < area.x1 && r.x1 + m > area.x0) {
                let (top, end) = (((r.y0 - m) * s).floor() - f64::from(y0), ((r.y1 + m) * s).ceil() - f64::from(y0));
                paint[top.clamp(0.0, f64::from(h)) as usize..end.clamp(0.0, f64::from(h)) as usize].fill(true);
            }
            // A damaged row whose content only moved a whole number of rows, from a row of this tile wholly inside the band: a
            // copied pixel is within 1 of a fresh paint's (vello_cpu's f32 device coordinates round a few edge pixels of a
            // moved glyph the other way in any case).
            for &(a, z, rows) in b.moves {
                let (k, lo, hi) = (rows as i64, a as i64 - i64::from(y0), z as i64 - i64::from(y0));
                for t in 0..h as usize {
                    let src = t as i64 - k;
                    if paint[t] && src >= lo.max(0) && src < hi.min(i64::from(h)) {
                        let src = src as usize * row_bytes;
                        buf[t * row_bytes..(t + 1) * row_bytes].copy_from_slice(&b.pixels[src..src + row_bytes]);
                        paint[t] = false;
                    }
                }
            }
        }
        _ => {
            buf.clear();
            buf.resize(row_bytes * h as usize, 0);
        }
    }
    let mut painted = 0;
    for (p0, p1) in bands(&paint) {
        painted += w * (p1 - p0);
        let rows = p1 - p0;
        // The band renders in a raster of its own height, with the scene moved up by the band's top row: a whole device
        // pixel, so its edges keep the fraction of a pixel the whole paint gives them, and its cost follows its height.
        let band_view = Affine::translate((0.0, -f64::from(p0))) * view;
        let mut ctx: RenderContext = context_pool::CONTEXTS.take(w as u16, rows as u16);
        paint_list(&mut ctx, list, media, band_view, opts, kurbo::Rect::new(0.0, 0.0, f64::from(w), f64::from(rows)));
        ctx.flush();
        let whole = p0 == 0 && p1 == h;
        let out = if whole { &mut *buf } else { &mut *scratch };
        out.resize(row_bytes * rows as usize, 0);
        if let Some(pm) = vello_cpu::PixmapMut::new(w as u16, rows as u16, out) {
            ctx.render(pm, &mut Resources::new());
        }
        context_pool::CONTEXTS.give_back(ctx);
        let dst = p0 as usize * row_bytes..p1 as usize * row_bytes;
        if !whole {
            buf[dst.clone()].copy_from_slice(&scratch[..row_bytes * rows as usize]);
        }
        if list.paper.is_none() {
            unpremultiply(&mut buf[dst]);
        }
    }
    Some((w, h, painted))
}

/// The runs of `true` in `rows` as `(first, end)`, two runs fewer than [`BAND_GAP`] rows apart taken as one: each band is a
/// render of the raster down to its end.
fn bands(rows: &[bool]) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = Vec::new();
    for (i, _) in rows.iter().enumerate().filter(|(_, p)| **p) {
        let i = i as u32;
        match out.last_mut() {
            Some(b) if i < b.1 + BAND_GAP => b.1 = i + 1,
            _ => out.push((i, i + 1)),
        }
    }
    out
}

/// Rows between two bands painted rather than rendered apart (a band's render clears and packs every row above it).
const BAND_GAP: u32 = 64;

/// Premultiplied RGBA made straight, in place.
fn unpremultiply(px: &mut [u8]) {
    for p in px.as_chunks_mut::<4>().0 {
        let a = u32::from(p[3]);
        if a != 0 && a != 255 {
            for c in p.iter_mut().take(3) {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}
