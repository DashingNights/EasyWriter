//! Tiles for the viewport (docs/plans/engine/viewport-design.md sections 4.1 and 4.3, P6): the surfaces a session shows and
//! each 512 px tile of one, painted from a display list the worker keeps for every session, surface and layout version.
//! The pixels stay in one buffer in wasm memory that the worker reads through a view and copies once into an
//! ImageBitmap; the next paint reuses it. A tile on screen keeps its own (engine-paint-damage), so its next paint after an
//! edit starts from them.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;
use wasm_bindgen::prelude::*;
use ew_doc_edit::layout::display::page_list;
use ew_doc_edit::render::{Before, DisplayList, ListCache, ListKey, Media, PaintOptions, TILE, Tile, kurbo, repaint_tile};

use crate::Engine;

/// The display lists' budget for the whole worker (section 8).
const LIST_BYTES: usize = 64 * 1024 * 1024;

/// Glyph runs under this many device pixels are drawn as grey bars (section 4.3).
const GREEK_BELOW_PX: f32 = 3.0;

/// The pixels kept of the tiles on screen, for the whole worker (engine-paint-damage): 64 full tiles, more than a
/// 2,560 x 1,440 view shows at dpr 1.5 (54).
const KEPT_BYTES: usize = 64 * 1024 * 1024;

/// The worker's lists, its one tile buffer (1 MiB once a full tile is painted) and a band's raster.
struct Scene {
    lists: ListCache,
    buf: Vec<u8>,
    scratch: Vec<u8>,
}

/// A tile's key: owner (a session), surface, scale's bits, column and row.
type TileKey = (u64, u64, u32, u32, u32);

/// The tiles on screen as last painted, so a repaint after a change starts from their pixels (scene's `repaint_tile`): least
/// recently painted first, and dropped first past [`KEPT_BYTES`]. A few dozen at most, so a plain list.
struct Kept {
    tiles: Vec<KeptTile>,
    bytes: usize,
}

/// The page keys of a layout (board design section 6): the stable id of the block the page starts in, then how many earlier
/// pages start inside that same block (so a hard break that shifts text keeps each paragraph's page key). A page whose body
/// draws nothing (only a page's own decoration: a fill or a rule) is `empty#<k>`, k counting the earlier empty pages; a page
/// holding a picture alone, or starting with a table, is that block's page.
pub(crate) fn page_keys(l: &ew_doc_edit::layout::DocLayout) -> Vec<String> {
    use ew_doc_edit::layout::Placed;
    let mut starts: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    let mut empty = 0;
    l.pages.iter().map(|p| {
        if p.items.iter().any(|it| !matches!(it, Placed::Fill { .. } | Placed::Rule { .. })) {
            let n = starts.entry(p.first_block).or_insert(0);
            let key = format!("{}#{}", p.first_block, n);
            *n += 1;
            key
        } else {
            let key = format!("empty#{empty}");
            empty += 1;
            key
        }
    }).collect()
}

/// A kept tile: the layout version its pixels show, and the change a layout event worked out for its surface since then,
/// when one reached it.
struct KeptTile {
    key: TileKey,
    version: u64,
    px: Vec<u8>,
    change: Option<Rc<Change>>,
}

/// A surface's change from layout version `since` (the list `old`) to `to`: where the lists differ (`rects`) and what only
/// moved (`moves`, worked out at the first repaint that needs them, for each scale), shared by the surface's tiles it reached.
struct Change {
    since: u64,
    to: u64,
    old: Arc<DisplayList>,
    rects: Vec<kurbo::Rect>,
    moves: RefCell<Vec<(u32, Rc<Vec<(f64, f64, f64)>>)>>,
}

impl Kept {
    fn take(&mut self, key: &TileKey) -> Option<KeptTile> {
        let t = self.tiles.remove(self.tiles.iter().position(|t| t.key == *key)?);
        self.bytes -= t.px.len();
        Some(t)
    }

    fn keep(&mut self, key: TileKey, version: u64, px: Vec<u8>) {
        self.bytes += px.len();
        self.tiles.push(KeptTile { key, version, px, change: None });
        while self.bytes > KEPT_BYTES {
            let t = self.tiles.remove(0);
            self.bytes -= t.px.len();
        }
    }

    /// Drops the tiles of the surfaces `gone` picks by owner and surface. Not inlined: each caller would carry its own copy.
    #[inline(never)]
    fn prune(&mut self, gone: &dyn Fn(u64, u64) -> bool) {
        self.tiles.retain(|t| !gone(t.key.0, t.key.1));
        self.bytes = self.tiles.iter().map(|t| t.px.len()).sum();
    }
}

thread_local! {
    static SCENE: RefCell<Scene> = RefCell::new(Scene { lists: ListCache::new(LIST_BYTES), buf: Vec::new(), scratch: Vec::new() });
    static KEPT: RefCell<Kept> = const { RefCell::new(Kept { tiles: Vec::new(), bytes: 0 }) };
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// A new session's key in the worker's list cache.
pub(crate) fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

/// A painted tile: `width` × `height` RGBA pixels (straight alpha; opaque on a page) at byte `ptr` of the module's
/// memory, valid until the next paint or until the memory grows. The worker views them as
/// `new Uint8ClampedArray(memory.buffer, ptr, width * height * 4)`.
/// `painted`: how many of them were painted; the rest are the tile's kept pixels, as they were or moved.
#[wasm_bindgen]
pub struct TileView {
    pub ptr: usize,
    pub width: u32,
    pub height: u32,
    #[wasm_bindgen(readonly)]
    pub painted: u32,
}

/// Drops a closed session's lists and kept tiles, or those of a session whose paint changed (they no longer show it).
pub(crate) fn forget(id: u64) {
    SCENE.with(|s| s.borrow_mut().lists.forget(id));
    KEPT.with(|k| k.borrow_mut().prune(&|owner, _| owner == id));
}

/// Drops the kept tiles of one surface of a session (a board item that was removed).
pub(crate) fn forget_surface(id: u64, surface: u64) {
    KEPT.with(|k| k.borrow_mut().prune(&|owner, s| owner == id && s == surface));
}

impl Engine {
    /// How the tiles paint: greeking, forced colours, a post's theme (`view.postTheme`, the dark palette remapped to the
    /// light one), and the page colour Read Mode or Immersive Reader shows (screen only, `view.readPageColor`): white paper
    /// in Read Mode, sepia paper, or Switch Modes' dark page for Inverse.
    pub(crate) fn paint_options(&self) -> PaintOptions {
        use ew_doc_edit::cmd::view::ReadPageColor;
        let v = &self.s.view;
        let color = if v.read_mode || v.immersive { v.read_page_color } else { ReadPageColor::None };
        let read_paper = match color {
            ReadPageColor::Sepia => Some(ew_doc_edit::render::SEPIA_PAPER),
            _ if v.read_mode || color == ReadPageColor::Inverse => Some(ew_doc_edit::doc::Rgb::WHITE),
            _ => None,
        };
        let remap: &'static [(ew_doc_edit::doc::Rgb, ew_doc_edit::doc::Rgb)] =
            if v.post_theme { &ew_doc_edit::doc::post::LIGHT } else { &[] };
        PaintOptions { greek_below_px: GREEK_BELOW_PX, forced: self.forced, read_paper, dark: color == ReadPageColor::Inverse, remap, ..Default::default() }
    }

    /// What of [`Engine::paint_options`] the session's view decides, to notice a change that repaints every tile.
    pub(crate) fn paint_key(&self) -> (Option<ew_doc_edit::doc::Rgb>, bool, bool) {
        let o = self.paint_options();
        (o.read_paper, o.dark, self.s.view.post_theme)
    }

    /// `paintTile`'s pixels copied out, `(width, height, rgba)`: for the native tests, which cannot read wasm memory.
    #[doc(hidden)]
    pub fn tile_pixels(&mut self, surface: usize, scale: f32, col: u32, row: u32) -> Option<(u32, u32, Vec<u8>)> {
        let v = self.paint_tile(surface, scale, col, row, None)?;
        SCENE.with(|s| Some((v.width, v.height, s.borrow().buf[..v.width as usize * v.height as usize * 4].to_vec())))
    }
}

/// The most surfaces one layout event works out damage for. A change that moved more pages (text that ripples to the end)
/// repaints the rest whole.
const DAMAGE_SURFACES: usize = 8;

#[wasm_bindgen]
impl Engine {
    /// The surfaces `from..to` the views show on screen now (the worker's visible tile wishes), or all of them when either is
    /// left out: a layout event's damage is worked out for those only. Damage needs each surface's display list, about 0.13 ms
    /// a page natively: after an Enter on page 300 of the Word fixture the event named 4 pages, 3 of them off screen, whose
    /// lists were built before the caret went out and again at the next key (engine-keys-final). A tile of a surface left out
    /// repaints when it is wished, as one the damage meets does.
    #[wasm_bindgen(js_name = setView)]
    pub fn set_view(&mut self, from: Option<usize>, to: Option<usize>) {
        self.view = from.zip(to).map(|(f, t)| f..t);
        // engine-layout-key: an edit lays out as far as these before its layout event, and the pages ahead in the next slice.
        self.s.set_layout_screen(self.view.as_ref().map(|v| v.end));
        // The kept pixels of the pages that went off screen go: a page shown again is painted whole first.
        if let Some(v) = self.view.clone() {
            let id = self.id;
            KEPT.with(|k| k.borrow_mut().prune(&|owner, surface| owner == id && !v.contains(&(surface as usize))));
        }
    }
}

impl Engine {
    /// The layout event's `damage` for the surfaces `pages` laid out again: `[{surface, since, rects}]`, one entry for each of
    /// them whose tiles were painted from a kept display list, `rects` (points, `{x, y, w, h}`) being where the new list
    /// differs from that list of layout version `since` (scene's `DisplayList::damage`). A tile painted at `since` that no
    /// rect meets (with a device pixel's margin for antialiasing) looks as it did; any other tile of a surface named in
    /// `pages` repaints. Building the new list here costs nothing extra: the repaint that follows takes it from the cache.
    pub(crate) fn damage(&mut self, pages: std::ops::Range<usize>) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        let view = self.view.clone().unwrap_or(0..usize::MAX);
        for surface in pages.filter(|p| view.contains(p)).take(DAMAGE_SURFACES) {
            let Some((since, old)) = SCENE.with(|s| s.borrow().lists.latest(self.id, surface as u64)) else { continue };
            if since >= u64::from(self.version) {
                continue;
            }
            let Some(new) = self.surface_list(surface) else { continue };
            let damage = new.damage(&old);
            let rects: Vec<_> = damage.iter().map(|r| json!({"x": r.x0, "y": r.y0, "w": r.width(), "h": r.height()})).collect();
            out.push(json!({"surface": surface, "since": since, "rects": rects}));
            let (owner, to) = ((self.id, surface as u64), u64::from(self.version));
            let change = Rc::new(Change { since, to, old, rects: damage, moves: RefCell::default() });
            KEPT.with(|k| {
                // A kept tile no rect meets shows the new version as it is, by the rule of tiles.mjs `untouched` (the view keeps
                // its tile then and wishes no repaint): no rect within a device pixel of its square. The others repaint over
                // their pixels with this change.
                for t in k.borrow_mut().tiles.iter_mut().filter(|t| (t.key.0, t.key.1) == owner && t.version == since) {
                    let (s, k) = (f64::from(f32::from_bits(t.key.2)), t.key);
                    let (x, y, side) = (f64::from(k.3 * TILE) - 1.0, f64::from(k.4 * TILE) - 1.0, f64::from(TILE) + 2.0);
                    if change.rects.iter().any(|d| d.x0 * s < x + side && d.x1 * s > x && d.y0 * s < y + side && d.y1 * s > y) {
                        t.change = Some(change.clone());
                    } else {
                        t.version = to;
                    }
                }
            });
        }
        out
    }
}

#[wasm_bindgen]
impl Engine {
    /// `{version, list: [{w, h, kind, label, paper, first}], settled}` in points: one surface a page, labelled with its number
    /// and with the page colour (`#rrggbb`, forced colours' paper while they are set) a slot shows where no tile is painted;
    /// `first` is the page's key (see [`page_keys`]); the pages laid out so far while not `settled`.
    pub fn surfaces(&mut self) -> String {
        self.sync();
        let l = self.s.layout();
        let o = self.paint_options();
        let own = o.read_paper.or(self.s.doc.settings.page_color).unwrap_or(ew_doc_edit::doc::Rgb::WHITE);
        let paper = self.forced.map_or_else(|| o.ink(own), |f| f.1);
        let paper = format!("#{:02x}{:02x}{:02x}", paper.0, paper.1, paper.2);
        // ponytail: the label is the page's number in Arabic digits; a section's number format (i, A) comes with the
        // view that shows it.
        let keys = page_keys(&l);
        let list: Vec<_> = l.pages.iter().zip(&keys).map(|(p, first)| json!({"w": p.w, "h": p.h, "kind": "page", "label": p.number.to_string(), "paper": paper, "first": first})).collect();
        json!({"version": self.version, "list": list, "settled": l.settled()}).to_string()
    }

    /// Tile (`col`, `row`) of surface `surface` at `scale` device pixels a point, or undefined when the surface has no such
    /// tile or nothing is drawn on it (the slot's paper shows there). A tile on screen (`shown`) is kept: its next paint after
    /// a change starts from these pixels and paints only the rows the change reached and could not move (engine-paint-damage).
    /// Any other is painted whole.
    #[wasm_bindgen(js_name = paintTile)]
    pub fn paint_tile(&mut self, surface: usize, scale: f32, col: u32, row: u32, shown: Option<bool>) -> Option<TileView> {
        let list = self.surface_list(surface)?;
        let opts = self.paint_options();
        // A board's stamps draw the pictures its Board keeps, not the (blank) document of the session.
        let media: &dyn Media = match &self.board {
            Some(b) => b.media(),
            None => &self.s.doc.media,
        };
        let (version, key) = (u64::from(self.version), (self.id, surface as u64, scale.to_bits(), col, row));
        let shown = shown == Some(true);
        SCENE.with(|s| KEPT.with(|k| {
            let (Scene { buf, scratch, .. }, kept) = (&mut *s.borrow_mut(), &mut *k.borrow_mut());
            let had = kept.take(&key).filter(|_| shown);
            // What changed since the kept pixels were painted: nothing, or the change a layout event worked out from them to now.
            let moves = had.as_ref().and_then(|t| t.change.as_ref().filter(|c| t.version != version && (c.since, c.to) == (t.version, version))).map(|c| {
                let mut cache = c.moves.borrow_mut();
                match cache.iter().find(|m| m.0 == scale.to_bits()) {
                    Some(m) => m.1.clone(),
                    None => {
                        let m = Rc::new(list.moves(&c.old, scale));
                        cache.push((scale.to_bits(), m.clone()));
                        m
                    }
                }
            });
            let before = had.as_ref().and_then(|t| match &t.change {
                _ if t.version == version => Some(Before { pixels: &t.px, damage: &[], moves: &[] }),
                Some(c) if (c.since, c.to) == (t.version, version) => {
                    Some(Before { pixels: &t.px, damage: &c.rects, moves: moves.as_deref().map_or(&[][..], |m| &m[..]) })
                }
                _ => None,
            });
            let (width, height, painted) = repaint_tile(&list, media, Tile { scale, col, row }, &opts, before, buf, scratch)?;
            let mut ptr = buf.as_ptr() as usize;
            if shown {
                // The new pixels are kept, and the old ones' memory is the next paint's buffer: no copy.
                let mut px = had.map(|h| h.px).unwrap_or_default();
                std::mem::swap(&mut px, buf);
                ptr = px.as_ptr() as usize;
                kept.keep(key, version, px);
            }
            Some(TileView { ptr, width, height, painted })
        }))
    }

    /// Forced colours (viewport-design.md section 7): the tiles paint text in `text` and paper in `paper` (`#rrggbb`, the
    /// system's CanvasText and Canvas) until a call with an empty or unreadable colour ends them. A change re-keys every
    /// surface: the version goes up and the next layout event names them all, so the views repaint their tiles.
    #[wasm_bindgen(js_name = setColors)]
    pub fn set_colors(&mut self, text: &str, paper: &str) {
        let next = ew_doc_edit::doc::Rgb::parse(text).zip(ew_doc_edit::doc::Rgb::parse(paper));
        if next == self.forced {
            return;
        }
        self.forced = next;
        self.version += 1;
        self.pending = Some(0..usize::MAX);
        // The lists do not change with the colours, so no damage could be worked out against them: every tile repaints.
        forget(self.id);
    }

    /// The layout version: it goes up with every change to the layout, and a tile painted now shows this version.
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> u32 {
        self.version
    }

    /// `{bytes, lists, keptBytes}`: what the worker's display-list cache holds, and the bytes of the pixels it keeps of the
    /// tiles on screen.
    #[wasm_bindgen(js_name = sceneStats)]
    pub fn scene_stats(&self) -> String {
        SCENE.with(|s| {
            let s = s.borrow();
            let kept = KEPT.with(|k| k.borrow().bytes);
            json!({"bytes": s.lists.bytes(), "lists": s.lists.len(), "keptBytes": kept}).to_string()
        })
    }

    /// The display list of page `surface` at the current layout, from the cache or built now.
    pub(crate) fn surface_list(&mut self, surface: usize) -> Option<Arc<DisplayList>> {
        if let Some(b) = &self.board {
            return b.list(surface as u32);
        }
        self.sync();
        let l = self.s.layout();
        let page = l.pages.get(surface)?;
        let key = ListKey { owner: self.id, surface: surface as u64, version: u64::from(self.version) };
        let doc = &self.s.doc;
        let opts = ew_doc_edit::cmd::view::display_options(&self.s);
        let item = self.item;
        Some(SCENE.with(|s| s.borrow_mut().lists.get_or_build(key, || {
            let mut list = page_list(doc, page, &opts);
            // An item's text shows over the board with no paper of its own.
            if item {
                list.paper = None;
            }
            list
        })))
    }
}

#[cfg(test)]
#[path = "tiles_tests.rs"]
mod tests;
