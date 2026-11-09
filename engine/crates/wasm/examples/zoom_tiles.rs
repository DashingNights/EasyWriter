//! engine-zoom-tiles: paints every 512 px tile of pages `first..=last` at `scale` device px a point, as the worker does
//! (`Engine::tile_pixels`), and prints each page's tile count, painted tiles, total and slowest tile in ms, and the most heap
//! the page's paints held above what was held before them (the wasm memory grows to the peak and never shrinks). Natively,
//! so the times are not the worker's, but a page that costs far more than its neighbours does so in both.
//!   cargo run --release -p ew-wasm --example zoom_tiles -- <file.docx> <first> <last> <scale>
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

use ew::Engine;

static NOW: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let n = NOW.fetch_add(l.size(), Relaxed) + l.size();
        PEAK.fetch_max(n, Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        NOW.fetch_sub(l.size(), Relaxed);
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static A: Counting = Counting;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&a[1]).expect("read");
    let (first, last): (usize, usize) = (a[2].parse().unwrap(), a[3].parse().unwrap());
    let scale: f32 = a[4].parse().unwrap();
    let mut e = Engine::new();
    e.open(&bytes, "docx").expect("open");
    let surfaces: serde_json::Value = serde_json::from_str(&e.surfaces()).unwrap();
    let mb = |b: usize| b as f64 / 1048576.0;
    for page in first..=last {
        let Some(p) = surfaces["list"].get(page) else { break };
        let (w, h) = (p["w"].as_f64().unwrap() as f32, p["h"].as_f64().unwrap() as f32);
        let (cols, rows) = (((w * scale) / 512.0).ceil() as u32, ((h * scale) / 512.0).ceil() as u32);
        let (mut sum, mut worst, mut painted) = (0.0f64, 0.0f64, 0);
        let before = NOW.load(Relaxed);
        PEAK.store(before, Relaxed);
        for row in 0..rows {
            for col in 0..cols {
                let t = std::time::Instant::now();
                let px = e.tile_pixels(page, scale, col, row);
                let ms = t.elapsed().as_secs_f64() * 1e3;
                sum += ms;
                worst = worst.max(ms);
                painted += usize::from(px.is_some());
            }
        }
        let (peak, after) = (PEAK.load(Relaxed), NOW.load(Relaxed));
        println!(
            "page {page}: {} tiles, {painted} painted, {sum:.0} ms, slowest {worst:.1} ms, peak +{:.1} MB, kept +{:.1} MB",
            cols * rows,
            mb(peak - before),
            (after as f64 - before as f64) / 1048576.0
        );
    }
}
