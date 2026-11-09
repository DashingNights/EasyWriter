//! Times an open natively, as the worker makes it (engine-open): a whole layout, then the parse and the first pages with
//! `setAhead`, the rest in slices, and select all and copy (the exec of edit.copy, the RTF the worker adds and the selection
//! event the worker sends after select all, for every page and for a view's three). The digests are compared with the whole
//! layout's; the fixture's DATE and TIME fields show the time of each open, so their pages differ between any two opens.
//!   cargo run --release -p ew-wasm --example open -- <file.docx> [ahead pages] [slice ms]
use ew::Engine;

fn ms(t: std::time::Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

fn main() {
    let path = std::env::args().nth(1).expect("a .docx");
    let ahead: usize = std::env::args().nth(2).and_then(|k| k.parse().ok()).unwrap_or(4);
    let slice: f64 = std::env::args().nth(3).and_then(|k| k.parse().ok()).unwrap_or(8.0);
    let bytes = std::fs::read(&path).expect("read");

    // The fonts layout falls back to load when first needed: a whole layout first, so the timed ones start alike.
    Engine::new().open(&bytes, "docx").expect("open");
    let t = std::time::Instant::now();
    let mut whole = Engine::new();
    whole.open(&bytes, "docx").expect("open");
    println!("open and whole layout {:.0} ms", ms(t));

    let mut e = Engine::new();
    e.set_ahead(Some(ahead));
    let t = std::time::Instant::now();
    let first = e.open(&bytes, "docx").expect("open");
    println!("open and first pages {:.0} ms: {first}", ms(t));
    let t = std::time::Instant::now();
    let (mut slices, mut longest) = (0, 0.0f64);
    loop {
        let s = std::time::Instant::now();
        let done = e.settle(slice);
        longest = longest.max(ms(s));
        slices += 1;
        if done {
            break;
        }
    }
    println!("the rest {:.0} ms in {slices} slices, the longest {longest:.0} ms", ms(t));
    let digest = |e: &mut Engine| serde_json::from_str::<Vec<serde_json::Value>>(&e.layout_digest()).unwrap_or_default();
    let (x, y) = (digest(&mut e), digest(&mut whole));
    let differ: Vec<usize> = (0..x.len().max(y.len())).filter(|&i| x.get(i) != y.get(i)).collect();
    println!("{} pages against {} laid out whole; pages that differ {differ:?}", x.len(), y.len());

    let t = std::time::Instant::now();
    e.exec("select.all", "{}");
    let select = ms(t);
    let t = std::time::Instant::now();
    let all = e.selection_event(None, None);
    let event = ms(t);
    let t = std::time::Instant::now();
    let view = e.selection_event(Some(0), Some(3));
    let view_ms = ms(t);
    let t = std::time::Instant::now();
    let copy = e.exec("edit.copy", "{}");
    let copy_ms = ms(t);
    let t = std::time::Instant::now();
    let rtf = e.clipboard_rtf();
    let rtf_ms = ms(t);
    println!(
        "select all {select:.0} ms; its selection event {event:.0} ms ({} bytes), on pages 1 to 3 {view_ms:.1} ms ({} bytes); copy {copy_ms:.0} ms ({} bytes); RTF {rtf_ms:.0} ms ({} bytes)",
        all.len(),
        view.len(),
        copy.len(),
        rtf.len()
    );
}
