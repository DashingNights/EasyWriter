//! engine-paint-damage: a tile on screen repainted over its kept pixels after a key is the tile painted whole: the same bytes
//! but in the rows whose lines were copied down or up, which may differ by 1 in a few bytes (scene_tests.rs
//! `a_tile_repainted_over_its_old_pixels_is_the_whole_paint` says why, and that painted and kept rows are exact). Page 300 of
//! the Word fixture at the harness's 100 % (4/3 px a point) and at dpr 1.5's 2 px, the caret a third of the way down as
//! engine-keys puts it and on the line across a tile row's edge; a letter, Enter, Backspace (a join) and Delete at each. Every
//! tile of pages 300 and 301 is compared after every key, those the damage spared too, and the pixels painted are counted
//! against the tiles' own.
//!   cargo test -p ew-wasm --lib tiles::tests -- --nocapture
use super::*;
use serde_json::Value;

/// Tile (`col`, `row`) of `surface` painted whole, with no kept pixels: what a full repaint shows.
fn whole(e: &mut Engine, surface: usize, scale: f32, col: u32, row: u32) -> Option<Vec<u8>> {
    let list = e.surface_list(surface)?;
    let mut buf = Vec::new();
    let (w, h) = ew_doc_edit::render::paint_tile(&list, &e.s.doc.media, Tile { scale, col, row }, &e.paint_options(), &mut buf)?;
    Some(buf[..w as usize * h as usize * 4].to_vec())
}

/// Tile (`col`, `row`) of `surface` as the worker paints a tile on screen → its pixels and the pixels painted for it.
fn shown(e: &mut Engine, surface: usize, scale: f32, col: u32, row: u32) -> Option<(Vec<u8>, u32)> {
    let v = e.paint_tile(surface, scale, col, row, Some(true))?;
    let key = (e.id, surface as u64, scale.to_bits(), col, row);
    // The view points at the kept pixels.
    let (ptr, px) = KEPT.with(|k| k.borrow().tiles.iter().find(|t| t.key == key).map(|t| (t.px.as_ptr() as usize, t.px.clone())))?;
    assert_eq!((v.ptr, px.len()), (ptr, v.width as usize * v.height as usize * 4));
    Some((px, v.painted))
}

/// Surface `surface`'s tile columns and rows at `scale`, and its width in pixels.
fn grid(e: &mut Engine, surface: usize, scale: f32) -> (u32, u32, u32) {
    let list = e.surface_list(surface).unwrap();
    let (w, h) = list.pixels(scale);
    (w.div_ceil(TILE), h.div_ceil(TILE), w)
}

/// The tiles of pages 300 and 301 after `key`, those the layout event's damage met painted as the worker paints them and the
/// rest taken as they are, each against a whole paint → (pixels painted, pixels of the tiles repainted, bytes 1 off).
fn check(e: &mut Engine, scale: f32, key: &str) -> (u64, u64, usize) {
    // A key that changed nothing (Delete at the end of a cell) has no layout event and nothing to repaint.
    let Some(ev) = e.take_layout() else { return (0, 0, 0) };
    let ev: Value = serde_json::from_str(&ev).unwrap();
    let (mut painted, mut area, mut rounded) = (0, 0, 0);
    for surface in [299, 300] {
        let (cols, rows, pw) = grid(e, surface, scale);
        let side = TILE as f32 / scale;
        let m = 1.0 / scale;
        let met = |col: u32, row: u32| {
            ev["damage"].as_array().unwrap().iter().filter(|d| d["surface"] == surface).any(|d| {
                d["rects"].as_array().unwrap().iter().any(|r| {
                    let [x, y, w, h] = ["x", "y", "w", "h"].map(|k| r[k].as_f64().unwrap() as f32);
                    let (tx, ty) = (col as f32 * side, row as f32 * side);
                    x - m < tx + side && x + w + m > tx && y - m < ty + side && y + h + m > ty
                })
            })
        };
        for row in 0..rows {
            for col in 0..cols {
                let want = whole(e, surface, scale, col, row);
                let got = shown(e, surface, scale, col, row);
                if met(col, row) && let Some((_, p)) = &got {
                    painted += u64::from(*p);
                    area += want.as_ref().map_or(0, |w| w.len() as u64 / 4);
                }
                let got = got.map(|g| g.0);
                let close = got.as_ref().zip(want.as_ref()).is_some_and(|(g, w)| g.len() == w.len() && g.iter().zip(w).all(|(a, b)| a.abs_diff(*b) <= 1));
                if close {
                    rounded += got.iter().zip(want.iter()).map(|(g, w)| g.iter().zip(w).filter(|(a, b)| a != b).count()).sum::<usize>();
                } else if got != want {
                    let tw = (pw - col * TILE).min(TILE) as usize;
                    let diff = got.as_ref().zip(want.as_ref()).map(|(g, w)| {
                        let at = g.iter().zip(w).position(|(a, b)| a != b).unwrap_or(0) / 4;
                        let most = g.iter().zip(w).map(|(a, b)| a.abs_diff(*b)).max();
                        (g.iter().zip(w).filter(|(a, b)| a != b).count(), most, at % tw, at / tw)
                    });
                    panic!("{key} at scale {scale}: tile {col},{row} of page {} differs from a whole paint (bytes off, most, first x, y): {diff:?}", surface + 1);
                }
            }
        }
    }
    (painted, area, rounded)
}

fn keys_at(e: &mut Engine, scale: f32, y: f32, label: &str) -> Vec<(String, u64, u64, usize)> {
    let p: Value = serde_json::from_str(&e.pages()).unwrap();
    let w = p["pages"][299]["w"].as_f64().unwrap() as f32;
    let hit: Value = serde_json::from_str(&e.hit(299, w / 2.0, y)).unwrap();
    let pos = hit["pos"].to_string();
    e.select(&pos, &pos).ok();
    e.set_view(Some(299), Some(301));
    let _ = e.take_layout();
    // Every tile on screen painted and kept, as the views show them.
    for surface in [299, 300] {
        let (cols, rows, _) = grid(e, surface, scale);
        for row in 0..rows {
            for col in 0..cols {
                let _ = shown(e, surface, scale, col, row);
            }
        }
    }
    let mut out = Vec::new();
    for key in ["letter", "Enter", "Backspace", "Delete", "letter", "Enter", "letter", "Backspace"] {
        match key {
            "Enter" => drop(e.exec("text.newParagraph", "{}")),
            "Backspace" => drop(e.delete_backward("character")),
            "Delete" => drop(e.delete_forward("character")),
            _ => drop(e.insert_text("w")),
        }
        let (painted, area, rounded) = check(e, scale, &format!("{label} {key}"));
        out.push((key.to_string(), painted, area, rounded));
    }
    out
}

#[test]
fn surfaces_first_keys_name_the_block_each_page_starts_in() {
    let mut doc = ew_doc_edit::doc::Document::from_text(&"word ".repeat(6000));
    if let Some(block) = doc.body.first_mut()
        && let ew_doc_edit::doc::Block::Para(p) = std::sync::Arc::make_mut(block)
    {
        p.id = ew_doc_edit::doc::Id(7);
    }
    let bytes = ew_doc_edit::io::save_bytes("document.json", &doc).expect("save the engine form");
    let mut e = Engine::new();
    // The engine's hook reports a panic to the browser's console, which a native test has not: a failure would abort.
    drop(std::panic::take_hook());
    e.open(&bytes, "engine").expect("open the long paragraph");
    let v: Value = serde_json::from_str(&e.surfaces()).unwrap();
    let list = v["list"].as_array().unwrap();
    assert!(list.len() >= 2, "the paragraph runs over two pages: {}", list.len());
    assert_eq!(list[0]["first"], "7#0");
    assert_eq!(list[1]["first"], "7#1");
}

#[test]
fn surfaces_page_keys_name_a_picture_page_and_a_table_page_by_their_block() {
    use ew_doc_edit::layout::{DocLayout, Page, Placed};
    let picture = Placed::Clip { rect: Default::default(), spin: Default::default(), items: Vec::new() };
    let cell = Placed::Cell { rect: Default::default(), covered: false, table: Default::default(), row: 0, cell: 0,
        story: Default::default(), clip: false };
    let mut l = DocLayout::default();
    l.pages.push(Page { first_block: 7, items: vec![picture], ..Default::default() });
    l.pages.push(Page { first_block: 9, items: vec![cell], ..Default::default() });
    assert_eq!(page_keys(&l), ["7#0", "9#0"]);
}

#[test]
fn a_tile_repainted_over_its_kept_pixels_is_the_whole_paint() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.smoke-data/word/fixture/all-features.docx");
    let Ok(bytes) = std::fs::read(&path) else {
        println!("no Word fixture at {}", path.display());
        return;
    };
    let mut e = Engine::new();
    // The engine's hook reports a panic to the browser's console, which a native test has not: a failure would abort.
    drop(std::panic::take_hook());
    e.open(&bytes, "docx").expect("open the fixture");
    let _ = e.take_layout();
    let mut moved = 0;
    for scale in [1.333_333_f32, 2.0] {
        let h: Value = serde_json::from_str(&e.pages()).unwrap();
        let h = h["pages"][299]["h"].as_f64().unwrap() as f32;
        // A third of the way down (engine-keys' caret), and on the line across the first tile row's edge.
        for (y, label) in [(h / 3.0, "a third down"), (TILE as f32 / scale, "the tile edge")] {
            let counts = keys_at(&mut e, scale, y, &format!("page 300, {label}, scale {scale}"));
            println!("page 300, {label}, scale {scale}: {}", counts.iter().map(|(k, p, a, r)| format!("{k} {p} of {a} px ({r} bytes 1 off)")).collect::<Vec<_>>().join(", "));
            // An Enter or a join moves the lines below the caret: their rows are copied, so far fewer pixels are painted than
            // the damaged tiles hold.
            for (k, p, a, _) in &counts {
                if (k == "Enter" || k == "Backspace") && *a > 0 && *p * 2 < *a {
                    moved += 1;
                }
            }
        }
    }
    assert!(moved >= 4, "Enter and Backspace painted under half their tiles' pixels {moved} times");
}

