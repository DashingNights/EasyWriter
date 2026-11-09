//! Times typed letters natively: opens a .docx, lays it out, types 200 letters at pages 1, 300 and 900 and lays it out
//! again after each, then reports the edit and layout times (median and 95th percentile) and the pages laid out again.
//!   cargo run --release -p ew-wasm --example keystroke -- <file.docx> [keys]
use serde_json::json;
use ew_doc_edit::Session;
use ew_doc_edit::doc::Pos;
use ew_doc_edit::layout::Placed;

fn main() {
    let path = std::env::args().nth(1).expect("a .docx");
    let keys: usize = std::env::args().nth(2).and_then(|k| k.parse().ok()).unwrap_or(200);
    let bytes = std::fs::read(&path).expect("read");
    let doc = ew_doc_edit::io::open_bytes("document.docx", &bytes).expect("open");
    let mut s = Session::new(doc);
    s.view.proofing = false;
    let t = std::time::Instant::now();
    let pages = s.layout().pages.len();
    println!("layout {pages} pages {:.0} ms", t.elapsed().as_secs_f64() * 1e3);
    for page in [0usize, 299, 899] {
        let l = s.layout();
        let Some(p) = l.pages.get(page) else { continue };
        let Some((story, path)) = p.items.iter().find_map(|it| match it {
            // A body item's path names its block by id: the caret needs the block's number.
            Placed::Lines { story, path, .. } => Some((*story, p.ids.doc_path(*story, path)?)),
            _ => None,
        }) else {
            continue;
        };
        drop(l);
        s.sel = ew_doc_edit::Selection::caret(Pos::new(story, path, 0));
        s.take_layout_change();
        let (mut edit, mut lay, mut pages) = (Vec::new(), Vec::new(), Vec::new());
        for _ in 0..keys {
            let t = std::time::Instant::now();
            s.run("text.insert", &json!({"text": "x"})).expect("insert");
            edit.push(t.elapsed().as_secs_f64() * 1e3);
            let t = std::time::Instant::now();
            s.layout();
            lay.push(t.elapsed().as_secs_f64() * 1e3);
            pages.push(s.take_layout_change().map_or(0, |r| r.len()));
        }
        let q = |v: &mut Vec<f64>, f: f64| {
            v.sort_by(f64::total_cmp);
            v[((v.len() - 1) as f64 * f).round() as usize]
        };
        pages.sort_unstable();
        println!(
            "page {}: edit median {:.2} ms p95 {:.2} ms; layout median {:.2} ms p95 {:.2} ms; pages laid out again median {} max {}",
            page + 1,
            q(&mut edit, 0.5),
            q(&mut edit, 0.95),
            q(&mut lay, 0.5),
            q(&mut lay, 0.95),
            pages[pages.len() / 2],
            pages[pages.len() - 1]
        );
    }
}
