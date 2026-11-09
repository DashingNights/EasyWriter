//! The viewport design's measurements natively (docs/plans/engine/measure.md): opens a .docx, lays it out, paints pages 1 to
//! 50 whole and as tiles, then types `keys` letters at pages 1, 300 and 900 in the parts `Session::run` does them in. Prints
//! one JSON object. Native rendering uses vello_cpu's threads, so its paint times are not the worker's (one thread).
//!   cargo run --release -p ew-wasm --features measure --example measure -- <file.docx> [keys]
use serde_json::json;
use ew_doc_edit::Session;

fn main() -> Result<(), String> {
    let path = std::env::args().nth(1).ok_or("usage: measure <file.docx> [keys]")?;
    let keys: usize = std::env::args().nth(2).and_then(|k| k.parse().ok()).unwrap_or(200);
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let t = ew::measure::now();
    let doc = ew_doc_edit::io::open_bytes("document.docx", &bytes)?;
    let parse = ew::measure::now() - t;
    let mut s = Session::new(doc);
    s.view.proofing = false;
    let t = ew::measure::now();
    let pages = s.layout().pages.len();
    let layout = ew::measure::now() - t;
    let tiles = ew::measure::tiles(&mut s, 0, 49, &[1.33, 2.0, 4.0], &[512, 1024, 2048]);
    let typing = ew::measure::typing(&mut s, &[0, 299, 899], keys);
    println!("{}", json!({"pages": pages, "parse": parse.round(), "layout": layout.round(), "tiles": tiles, "typing": typing}));
    Ok(())
}
