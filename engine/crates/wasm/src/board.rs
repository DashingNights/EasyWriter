//! The whiteboard's stamps (docs/plans/board/design.md sections 2 and 3). A board session paints items, not pages: each surface
//! is an item's handle and its display list is the stamp `ew_board::Board` made from the item's engine model, so `paintTile`,
//! the tile cache and blank tile skipping run unchanged. The item session is the one a board's text items are edited in.

use std::sync::Arc;

use serde_json::json;
use wasm_bindgen::prelude::*;
use ew_board::{Board, Look};
use ew_doc_edit::layout::ViewMode;

use crate::Engine;

#[wasm_bindgen]
impl Engine {
    /// Makes this session a board's: its surfaces are item stamps (`boardSet`) from now on, and its own document is not painted.
    #[wasm_bindgen(js_name = boardInit)]
    pub fn board_init(&mut self) {
        self.enter();
        self.board = Some(Board::new(crate::REGISTRY.with(Arc::clone)));
    }

    /// Stamps item `handle` from `model` (an engine form, src/board/model.mjs) turned `rot` degrees clockwise and flipped, at
    /// `opacity`; `text_width` below 0 is not text, else the width its text lays out at (`width_fit`: it fits that width to its
    /// words) → `{ok: true, ox, oy, w, h, textW, textH}` in points, or `{ok: false, error}` with the old stamp kept. The
    /// surface's tiles repaint once the worker posts the version that this raises.
    #[wasm_bindgen(js_name = boardSet)]
    #[allow(clippy::too_many_arguments)]
    pub fn board_set(&mut self, handle: u32, model: &[u8], rot: f32, flip_x: bool, flip_y: bool, opacity: f32, text_width: f32,
        width_fit: bool) -> String {
        self.enter();
        let Some(board) = &mut self.board else { return json!({"ok": false, "error": "this session is not a board"}).to_string() };
        let look = Look { rot, flip_x, flip_y, opacity, text: (text_width >= 0.0).then_some(text_width), width_fit };
        match board.set(handle, model, &look) {
            Ok(s) => {
                self.version += 1;
                json!({"ok": true, "ox": s.ox, "oy": s.oy, "w": s.w, "h": s.h, "textW": s.text_w, "textH": s.text_h}).to_string()
            }
            Err(error) => json!({"ok": false, "error": error}).to_string(),
        }
    }

    /// Drops item `handle`'s stamp and the pixels kept of its tiles. The version goes up, so a tile still wished for it is painted
    /// again, as nothing, and the view clears it. Handles are never reused.
    #[wasm_bindgen(js_name = boardDrop)]
    pub fn board_drop(&mut self, handle: u32) {
        if let Some(b) = &mut self.board {
            b.remove(handle);
            self.version += 1;
            crate::tiles::forget_surface(self.id, u64::from(handle));
        }
    }

    /// Whether (`x`, `y`), in item `handle`'s stamp, is on what it draws: a stroke within `tol` points, a fill inside.
    #[wasm_bindgen(js_name = boardHit)]
    pub fn board_hit(&self, handle: u32, x: f32, y: f32, tol: f32) -> bool {
        self.board.as_ref().is_some_and(|b| b.hit(handle, x, y, tol))
    }

    /// This is the item session: `width` points wide with no margin, and tiles with no paper. Under the continuous views' 144 pt
    /// floor (a narrow text item) it is the model's own page instead, so the wrap is the item's width. Every tile repaints.
    #[wasm_bindgen(js_name = itemView)]
    pub fn item_view(&mut self, width: f32) {
        self.enter();
        let v = &mut self.s.view;
        (v.read_mode, v.immersive, v.web_margin) = (false, false, 0.0);
        if width >= ew_board::MIN_WEB {
            (v.mode, v.web_width) = (ViewMode::Web, width);
        } else {
            v.mode = ViewMode::Print;
        }
        self.s.relayout();
        self.item = true;
        // The lists were made with paper: as `setColors` does, every surface is named again and its tiles are painted afresh.
        self.version += 1;
        self.pending = Some(0..usize::MAX);
        crate::tiles::forget(self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    /// A floating red rectangle 100 x 50 pt on a Letter page: what the item session saves after `insert.shape`.
    const MODEL: &str = include_str!("../../../../test/fixtures/board/shape-model.json");

    /// A red 8 x 8 PNG.
    const RED_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

    fn board() -> Engine {
        let mut e = Engine::new();
        // Engine::new reports panics to the browser's console, which a native test has none of: a failed check prints as usual.
        drop(std::panic::take_hook());
        e.board_init();
        e
    }

    fn set(e: &mut Engine, handle: u32, model: &[u8]) {
        let r: Value = serde_json::from_str(&e.board_set(handle, model, 0.0, false, false, 1.0, -1.0, false)).unwrap();
        assert_eq!(r["ok"], true, "{r}");
    }

    fn kept(e: &Engine) -> u64 {
        serde_json::from_str::<Value>(&e.scene_stats()).unwrap()["keptBytes"].as_u64().unwrap()
    }

    #[test]
    fn a_dropped_item_is_painted_as_nothing_and_loses_the_pixels_kept_of_its_tiles() {
        let mut e = board();
        set(&mut e, 1, MODEL.as_bytes());
        set(&mut e, 2, MODEL.as_bytes());
        let shown = e.version();
        assert!(e.paint_tile(1, 1.0, 0, 0, Some(true)).is_some());
        assert!(e.paint_tile(2, 1.0, 0, 0, Some(true)).is_some());
        let both = kept(&e);
        assert!(both > 0);
        e.board_drop(1);
        assert!(e.version() > shown, "a tile still wished for the item is out of date, so the worker paints it again");
        assert!(e.paint_tile(1, 1.0, 0, 0, Some(true)).is_none(), "and it has nothing to show");
        assert_eq!(kept(&e), both / 2, "only the other item's pixels stay");
    }

    #[test]
    fn a_picture_item_is_painted_from_the_boards_pictures() {
        let mut m: Value = serde_json::from_str(MODEL).unwrap();
        m["lastSection"].as_object_mut().unwrap().extend([("pageW", 40.0), ("pageH", 40.0)].map(|(k, v)| (k.to_string(), json!(v))));
        let mut float = m["body"][0]["objects"][0]["float"].take();
        float["wrap"] = json!("inFrontOfText");
        m["body"][0]["objects"] = json!([{"type": "image", "media": "red.png", "w": 40, "h": 40, "alt": "", "float": float, "crop": [0, 0, 0, 0]}]);
        m["media"] = json!({"red.png": RED_PNG});
        let mut e = board();
        set(&mut e, 1, &serde_json::to_vec(&m).unwrap());
        let (w, _, px) = e.tile_pixels(1, 1.0, 0, 0).unwrap();
        let at = ((20 * w + 20) * 4) as usize;
        assert_eq!(px[at..at + 4], [255, 0, 0, 255], "the grey box of a missing picture is 208, 208, 208");
    }
}
