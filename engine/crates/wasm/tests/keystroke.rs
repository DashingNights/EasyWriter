//! engine-keystroke (docs/plans/engine/viewport-design.md P12): the layout event's damage. After random edits (inserting,
//! deleting, splitting and joining paragraphs, styles), every tile of a changed page that the damage does not meet is painted
//! again and compared with the tile kept from before: they must be the same pixels, so repainting only the damaged tiles
//! shows what a full repaint shows. The rule is the one src/engine/view/tiles.mjs `untouched` applies: a tile painted at the
//! damage's `since` version, meeting no rect grown by one device pixel.
//!   cargo test --release -p ew-wasm --test keystroke
use std::collections::HashMap;

use ew::Engine;
use serde_json::{Value, json};

/// xorshift64: the edits are random but the same on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

const WORDS: &[&str] = &["damage", "tile", "the", "a", "keystroke", "paragraph", "of", "repaint", "Word", "engine", "text", "line"];
const SCALES: &[f32] = &[4.0 / 3.0, 2.0];
const TILE: f32 = 512.0;

type Key = (usize, u32, u32, u32); // surface, scale's index, col, row
type Kept = HashMap<Key, (u32, Option<(u32, u32, Vec<u8>)>)>; // the version it was painted at, and its pixels

fn pos(para: usize, off: usize) -> String {
    json!({"story": "body", "path": [para], "off": off}).to_string()
}

/// Pages as `(w, h)` in points.
fn pages(e: &mut Engine) -> Vec<(f32, f32)> {
    let v: Value = serde_json::from_str(&e.pages()).unwrap();
    v["pages"].as_array().unwrap().iter().map(|p| (p["w"].as_f64().unwrap() as f32, p["h"].as_f64().unwrap() as f32)).collect()
}

fn grid(w: f32, h: f32, scale: f32) -> (u32, u32) {
    (((w * scale) / TILE).ceil() as u32, ((h * scale) / TILE).ceil() as u32)
}

/// Paints every tile of `surface` at every scale into `kept`.
fn paint(e: &mut Engine, kept: &mut Kept, surface: usize, (w, h): (f32, f32)) {
    for (si, &scale) in SCALES.iter().enumerate() {
        let (cols, rows) = grid(w, h, scale);
        for col in 0..cols {
            for row in 0..rows {
                let px = e.tile_pixels(surface, scale, col, row);
                kept.insert((surface, si as u32, col, row), (e.version(), px));
            }
        }
    }
}

/// A place in paragraph `para`: its start, moved on by a few words.
fn place(e: &mut Engine, rng: &mut Rng, para: usize) -> String {
    let mut p = pos(para, 0);
    for _ in 0..rng.below(6) {
        let Ok(r) = e.move_by(&p, "word", 1, None) else { break };
        let v: Value = serde_json::from_str(&r).unwrap();
        if v["pos"]["path"][0].as_u64() != Some(para as u64) {
            break;
        }
        p = v["pos"].to_string();
    }
    p
}

#[test]
fn undamaged_tiles_keep_their_pixels() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut e = Engine::new();
    let mut paras = 1;
    for i in 0..40 {
        if i > 0 {
            e.exec("text.newParagraph", "{}");
            paras += 1;
        }
        let n = 8 + rng.below(30);
        e.insert_text(&(0..n).map(|_| WORDS[rng.below(WORDS.len())]).collect::<Vec<_>>().join(" "));
    }
    let _ = e.take_layout();
    let mut kept = Kept::new();
    let sizes = pages(&mut e);
    for (i, &size) in sizes.iter().enumerate() {
        paint(&mut e, &mut kept, i, size);
    }
    assert!(sizes.len() >= 2, "the text fills {} pages", sizes.len());

    let (mut spared, mut compared, mut events) = (0, 0, 0);
    for step in 0..80 {
        let para = rng.below(paras);
        let at = place(&mut e, &mut rng, para);
        let _ = e.select(&at, &at);
        let what = match rng.below(5) {
            0 => {
                e.insert_text(WORDS[rng.below(WORDS.len())]);
                "insert"
            }
            1 => {
                for _ in 0..1 + rng.below(4) {
                    e.delete_backward("character");
                }
                "delete"
            }
            2 => {
                e.exec("text.newParagraph", "{}");
                paras += 1;
                "split"
            }
            3 if para > 0 => {
                let _ = e.select(&pos(para, 0), &pos(para, 0));
                e.delete_backward("character");
                paras -= 1;
                "join"
            }
            _ => {
                let head = e.move_by(&at, "word", 1, None).map(|r| serde_json::from_str::<Value>(&r).unwrap()["pos"].to_string());
                let _ = e.select(&at, &head.unwrap_or(at.clone()));
                e.exec(["format.bold", "format.italic", "format.underline"][rng.below(3)], "{}");
                "style"
            }
        };
        let Some(ev) = e.take_layout() else { continue };
        events += 1;
        let ev: Value = serde_json::from_str(&ev).unwrap();
        let (from, to) = (ev["from"].as_u64().unwrap() as usize, ev["to"].as_u64().unwrap() as usize);
        let now = pages(&mut e);
        for d in ev["damage"].as_array().unwrap() {
            let surface = d["surface"].as_u64().unwrap() as usize;
            let since = d["since"].as_u64().unwrap() as u32;
            let rects: Vec<[f32; 4]> = d["rects"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| ["x", "y", "w", "h"].map(|k| r[k].as_f64().unwrap() as f32))
                .collect();
            for (si, &scale) in SCALES.iter().enumerate() {
                let side = TILE / scale;
                let m = 1.0 / scale;
                let (cols, rows) = grid(now[surface].0, now[surface].1, scale);
                for col in 0..cols {
                    for row in 0..rows {
                        let Some((v, old)) = kept.get(&(surface, si as u32, col, row)) else { continue };
                        if *v != since {
                            continue;
                        }
                        let (x, y) = (col as f32 * side, row as f32 * side);
                        let meets = rects.iter().any(|r| r[0] - m < x + side && r[0] + r[2] + m > x && r[1] - m < y + side && r[1] + r[3] + m > y);
                        if meets {
                            continue;
                        }
                        spared += 1;
                        let px = e.tile_pixels(surface, scale, col, row);
                        compared += 1;
                        assert!(
                            px == *old,
                            "step {step} ({what}): tile {col},{row} of page {} at scale {scale} changed though no damage met it ({rects:?})",
                            surface + 1
                        );
                    }
                }
            }
        }
        // The views repaint what the event names (and pages that came or went), as the worker does.
        kept.retain(|k, _| k.0 < now.len());
        for (i, &size) in now.iter().enumerate() {
            if (from..to).contains(&i) || !kept.contains_key(&(i, 0, 0, 0)) {
                paint(&mut e, &mut kept, i, size);
            }
        }
    }
    assert!(events >= 60, "{events} layout events");
    assert!(spared >= 50 && compared == spared, "{spared} tiles spared a repaint");
}

/// A composition that is cancelled (Esc: the input method's empty text) leaves no undo step and the text as it was.
#[test]
fn cancelled_composition_leaves_no_step() {
    let mut e = Engine::new();
    e.insert_text("Hello");
    e.exec("text.newParagraph", "{}");
    let before = e.steps();
    let text = |e: &mut Engine| e.text(&pos(0, 0), &pos(1, 0)).ok().unwrap();
    let was = text(&mut e);
    for c in ["n", "ne", "nei"] {
        e.compose(c, c.len() as u32, c.len() as u32).ok().unwrap();
    }
    e.compose("", 0, 0).ok().unwrap();
    assert_eq!(e.steps(), before, "no undo step");
    assert_eq!(text(&mut e), was);
    // A composition that is committed stays one step.
    for c in ["n", "ne", "nei"] {
        e.compose(c, c.len() as u32, c.len() as u32).ok().unwrap();
    }
    e.commit();
    let v: Value = serde_json::from_str(&e.undo()).unwrap();
    assert_eq!(v["changed"], json!(true));
    assert_eq!(text(&mut e), was);
}

/// engine-keys: a composition that began over a selection and is cancelled leaves neither the selection's deletion nor
/// an undo step, as in Word.
#[test]
fn a_cancelled_composition_over_a_selection_leaves_no_trace() {
    let mut e = Engine::new();
    e.insert_text("Hello world");
    let s = |e: &Engine| serde_json::from_str::<serde_json::Value>(&e.selection()).expect("selection");
    let head = s(&e)["head"].clone();
    let at = |off: usize| serde_json::json!({"story": head["story"], "path": head["path"], "off": off}).to_string();
    e.select(&at(6), &at(11)).expect("select");
    let steps = e.steps();
    e.compose("w", 1, 1).expect("compose");
    e.compose("wo", 2, 2).expect("compose");
    e.compose("", 0, 0).expect("cancel");
    e.commit();
    assert_eq!(e.text(&at(0), &at(11)).expect("text"), "Hello world", "the selection's text is back");
    assert_eq!(s(&e)["anchor"]["off"], 6);
    assert_eq!(s(&e)["head"]["off"], 11);
    assert_eq!(e.steps(), steps, "no undo step is left");
}
