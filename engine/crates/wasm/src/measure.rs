//! The measurements the viewport design's defaults depend on (docs/plans/engine/viewport-design.md section 16, P1; results in
//! docs/plans/engine/measure.md): a typed letter's edit cost in its parts, tiles against whole pages, memory with several
//! sessions in one worker, and an open in its parts. Only in the `measure` feature, so the app's .wasm carries none of it.
//! .smoke-data/word/cases/_engine-measure.js runs it in Electron's worker; examples/measure.rs runs the same functions natively.
use std::collections::BTreeMap;

use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use ew_doc_edit::Session;
use ew_doc_edit::doc::Pos;
use ew_doc_edit::layout::display::page_layers;
use ew_doc_edit::layout::Placed;
use ew_doc_edit::layout::display::{RenderOptions, render_area, render_page};

use crate::Engine;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

/// Milliseconds on a monotonic clock: performance.now() on the web (layout's `now_ms` reads Date.now(), whole milliseconds,
/// too coarse for a tile), Instant natively.
pub fn now() -> f64 {
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    {
        performance_now()
    }
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    {
        static T0: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        T0.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
    }
}

fn timed<T>(f: impl FnOnce() -> T) -> (T, f64) {
    let t = now();
    let r = f();
    (r, now() - t)
}

fn round(ms: f64) -> f64 {
    (ms * 100.0).round() / 100.0
}

/// The value at quantile `q` of `v` (sorted in place), nearest rank.
fn quantile(v: &mut [f64], q: f64) -> f64 {
    v.sort_by(f64::total_cmp);
    v.get(((v.len().saturating_sub(1)) as f64 * q).round() as usize).copied().unwrap_or(f64::NAN)
}

/// `{n, p50, p95, max}` of `v`, in ms to 0.01.
pub fn spread(v: &mut [f64]) -> Value {
    if v.is_empty() {
        return json!({"n": 0});
    }
    json!({"n": v.len(), "p50": round(quantile(v, 0.5)), "p95": round(quantile(v, 0.95)), "max": round(quantile(v, 1.0))})
}

/// The start of the first line of body text on `page`, where engine-incremental's keystroke bench types.
fn line_start(s: &mut Session, page: usize) -> Option<Pos> {
    let l = s.layout();
    l.pages.get(page)?.items.iter().find_map(|it| match it {
        Placed::Lines { story, path, .. } => Some(Pos::new(*story, l.ids.doc_path(*story, path)?, 0)),
        _ => None,
    })
}

/// A typed letter at the start of each page in `pages` (0-based), `keys` times, laid out after each as the worker does.
/// Even keys run `Session::run` whole (`whole`; the first at a page pays one-off costs and is kept apart as `first`). Odd
/// keys run the same letter in the parts `run` does it in, each timed. The undo checkpoint: the document snapshot every
/// mutating command takes (for undo, and to roll a failed command back), the push onto the undo stack (`checkpoint`, a no-op
/// while a typing step is open) and dropping the snapshot. The command: the handler alone. The revision work: telling an edit
/// from a no-op (`compare`), `ensure_nonempty`, `prune_text_boxes`, and the revision bump with the selection clamp
/// (`touch`). What the whole run does beyond these parts (the protection check, recording, the input method's state, Go
/// Back, the outline, AutoCorrect's word) is `rest`, the median whole minus the parts' medians. The layout after each key
/// and the pages it laid out again (`diff`, the session's `take_layout_change`, which replaced ew's comparison of the old and
/// new layout) are timed on their own.
pub fn typing(s: &mut Session, pages: &[usize], keys: usize) -> Value {
    const PARTS: [&str; 8] = ["snapshot", "checkpoint", "command", "compare", "ensure", "prune", "touch", "drop"];
    let Some(insert) = s.registry.get("text.insert").map(|c| c.run) else { return json!({"error": "no text.insert"}) };
    let x = json!({"text": "x"});
    let mut out = Vec::new();
    for &page in pages {
        let Some(start) = line_start(s, page) else { continue };
        s.sel = ew_doc_edit::Selection::caret(start);
        s.layout();
        s.take_layout_change();
        let mut t: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
        let mut first = None;
        for k in 0..keys {
            let mut lap = |name: &'static str, ms: f64| t.entry(name).or_default().push(ms);
            if k % 2 == 0 {
                let ms = timed(|| s.run("text.insert", &x)).1;
                if k == 0 {
                    first = Some(round(ms));
                } else {
                    lap("whole", ms);
                }
            } else {
                let (before, ms) = timed(|| s.doc.clone());
                lap("snapshot", ms);
                lap("checkpoint", timed(|| s.checkpoint("Typing")).1);
                lap("command", timed(|| insert(s, &x)).1);
                lap("compare", timed(|| s.doc.same_content(&before)).1);
                lap("ensure", timed(|| s.doc.ensure_nonempty()).1);
                lap("prune", timed(|| s.doc.prune_text_boxes()).1);
                lap(
                    "touch",
                    timed(|| {
                        s.touch();
                        s.clamp_selection();
                    })
                    .1,
                );
                lap("drop", timed(|| drop(before)).1);
            }
            let (fresh, ms) = timed(|| s.layout());
            lap("layout", ms);
            drop(fresh);
            lap("diff", timed(|| s.take_layout_change()).1);
        }
        let mut parts = 0.0;
        for p in PARTS {
            parts += t.get_mut(p).map_or(0.0, |v| quantile(v, 0.5));
        }
        let rest = t.get_mut("whole").map(|v| round(quantile(v, 0.5) - parts));
        let mut row = serde_json::Map::new();
        row.insert("page".into(), json!(page + 1));
        row.insert("first".into(), json!(first));
        row.insert("rest".into(), json!(rest));
        for (name, v) in &mut t {
            row.insert((*name).into(), spread(v));
        }
        out.push(Value::Object(row));
    }
    Value::Array(out)
}

/// Pages `first..=last` (0-based) painted whole with `render_page` and as square tiles of each side in `sides` (device px)
/// with `render_area`, at each scale in `scales` (px a point). A tile is clipped to its page. Also timed: building the page's
/// display list (`page_layers`, which `render_area` repeats for every tile today and P6's cache will build once), and the
/// un-premultiplying copy (`to_straight`) of the whole page. `blank`: tiles all paper, which the design does not paint.
pub fn tiles(s: &mut Session, first: usize, last: usize, scales: &[f32], sides: &[u32]) -> Value {
    let l = s.layout();
    let opts = RenderOptions::default();
    let paper = opts.paper_of(&s.doc);
    let paper = [paper.0, paper.1, paper.2, 255];
    let pages = l.pages.get(first..=last.min(l.pages.len().saturating_sub(1))).unwrap_or_default();
    let mut out = Vec::new();
    for &scale in scales {
        let (mut whole, mut list, mut copy) = (vec![], vec![], vec![]);
        let mut by_side: Vec<(Vec<f64>, Vec<f64>, usize)> = sides.iter().map(|_| (vec![], vec![], 0)).collect();
        for p in pages {
            let (img, ms) = timed(|| render_page(&s.doc, p, scale, &opts));
            whole.push(ms);
            copy.push(timed(|| img.to_straight()).1);
            list.push(timed(|| page_layers(&s.doc, p, &opts.display)).1);
            for (&side, (tile, per_page, blank)) in sides.iter().zip(by_side.iter_mut()) {
                let step = side as f32 / scale;
                let mut sum = 0.0;
                let mut y = 0.0;
                while y < p.h {
                    let mut x = 0.0;
                    while x < p.w {
                        // A Rect built from one the page has: ew names no geometry crate of its own.
                        let mut area = p.body;
                        (area.x, area.y, area.w, area.h) = (x, y, step.min(p.w - x), step.min(p.h - y));
                        let (img, ms) = timed(|| render_area(&s.doc, p, area, scale, &opts));
                        sum += ms;
                        tile.push(ms);
                        if img.pixels.as_chunks::<4>().0.iter().all(|px| *px == paper) {
                            *blank += 1;
                        }
                        x += step;
                    }
                    y += step;
                }
                per_page.push(sum);
            }
        }
        let list_p50 = quantile(&mut list, 0.5);
        let sides: Vec<Value> = sides
            .iter()
            .zip(by_side.iter_mut())
            .map(|(side, (tile, per_page, blank))| {
                let tile_p50 = quantile(tile, 0.5);
                json!({
                    "side": side,
                    "tiles": tile.len(),
                    "blank": blank,
                    "tile": spread(tile),
                    "perPage": spread(per_page),
                    // The share of a tile's paint spent building the page's display list again.
                    "listShare": round(list_p50 / tile_p50 * 100.0) / 100.0,
                })
            })
            .collect();
        out.push(json!({
            "scale": scale,
            "pages": pages.len(),
            "page": spread(&mut whole),
            "list": spread(&mut list),
            "copy": spread(&mut copy),
            "sides": sides,
        }));
    }
    Value::Array(out)
}

/// `{wasm, heap, fonts}` now, in bytes (wasm and heap null natively).
fn usage() -> Value {
    let m = crate::memory();
    json!({"wasm": m.map(|m| m.0), "heap": m.map(|m| m.1), "fonts": ew_fonts::FontDb::global().loaded_font_bytes()})
}

fn session(bytes: &[u8], name: &str) -> Result<Session, String> {
    let mut s = Session::new(ew_doc_edit::io::open_bytes(name, bytes)?);
    s.view.proofing = false;
    s.layout();
    Ok(s)
}

/// Memory with one, two and four sessions of `bytes` open and laid out in this worker, then after closing them, then over
/// three opens and closes of one: `[{step, wasm, heap, fonts}]`.
pub fn memory(bytes: &[u8], name: &str) -> Result<Value, String> {
    let mark = |step: &str| {
        let mut u = usage();
        u["step"] = json!(step);
        u
    };
    let mut out = vec![mark("start")];
    let mut held = Vec::new();
    for n in 1..=4 {
        held.push(session(bytes, name)?);
        if n != 3 {
            out.push(mark(&format!("{n} open")));
        }
    }
    drop(held);
    out.push(mark("all closed"));
    for cycle in 1..=3 {
        let s = session(bytes, name)?;
        out.push(mark(&format!("cycle {cycle} open")));
        drop(s);
        out.push(mark(&format!("cycle {cycle} closed")));
    }
    Ok(Value::Array(out))
}

#[wasm_bindgen]
impl Engine {
    /// [`typing`] on this session: `pages` a JSON array of 0-based pages.
    #[wasm_bindgen(js_name = measureTyping)]
    pub fn measure_typing(&mut self, pages: &str, keys: usize) -> Result<String, JsError> {
        let pages: Vec<usize> = serde_json::from_str(pages).map_err(crate::err)?;
        Ok(typing(&mut self.s, &pages, keys).to_string())
    }

    /// [`tiles`] on this session: `scales` and `sides` JSON arrays.
    #[wasm_bindgen(js_name = measureTiles)]
    pub fn measure_tiles(&mut self, first: usize, last: usize, scales: &str, sides: &str) -> Result<String, JsError> {
        let scales: Vec<f32> = serde_json::from_str(scales).map_err(crate::err)?;
        let sides: Vec<u32> = serde_json::from_str(sides).map_err(crate::err)?;
        Ok(tiles(&mut self.s, first, last, &scales, &sides).to_string())
    }

    /// `open` in its parts → `{parse, set, layout, pages}`: reading the bytes into a document, handing it to the session
    /// (with a new undo history), and the first layout, in ms.
    #[wasm_bindgen(js_name = measureOpen)]
    pub fn measure_open(&mut self, bytes: &[u8], kind: &str) -> Result<String, JsError> {
        let name = crate::file_name(kind)?;
        let (doc, parse) = timed(|| ew_doc_edit::io::open_bytes(name, bytes));
        let doc = doc.map_err(crate::err)?;
        let ((), set) = timed(|| {
            self.s.set_document(doc);
            self.s.reset_history();
        });
        self.comp = None;
        let (l, layout) = timed(|| self.s.layout());
        Ok(json!({"parse": round(parse), "set": round(set), "layout": round(layout), "pages": l.pages.len()}).to_string())
    }
}

/// [`memory`] for `bytes` of `kind` in this worker.
#[wasm_bindgen(js_name = measureMemory)]
pub fn measure_memory(bytes: &[u8], kind: &str) -> Result<String, JsError> {
    memory(bytes, crate::file_name(kind)?).map(|v| v.to_string()).map_err(crate::err)
}

#[cfg(test)]
mod tests {
    use super::{quantile, spread};

    #[test]
    fn quantiles() {
        let mut v: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(quantile(&mut v, 0.5), 51.0);
        assert_eq!(quantile(&mut v, 0.95), 95.0);
        assert_eq!(spread(&mut []), serde_json::json!({"n": 0}));
    }
}
