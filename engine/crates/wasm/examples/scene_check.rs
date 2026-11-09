//! engine-scene's no-change check (docs/plans/engine/viewport-design.md section 12): the fixture's layout hash (page
//! count; per page the first block and the item count), pages 1 to 50 painted whole at 1.33, 2 and 4 px a point, and the
//! PDF with a fixed date, each hashed; the same pages painted as 512 px tiles and stitched, against the whole page (a
//! difference of 1 in a channel counted apart, and seams looked for on the tile edges). With a baseline file (this
//! program's output from before a change) it says whether the hashes match it. Natively, so paint times are not the
//! worker's.
//!   cargo run --release -p ew-wasm --example scene_check -- <file.docx> [baseline.json [baseline.pdf]]   (SCENE_NO_TILES=1 skips the
//!   tiles; SCENE_DUMP=<dir> writes pages 26 and 29 and the PDF there)
use serde_json::{Value, json};
use ew_doc_edit::Session;
use ew_doc_edit::layout::display::{DisplayOptions, page_display, page_list, render_page};
use ew_doc_edit::render::{PaintOptions, TILE, Tile, paint_tile};

fn fnv(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn quantile(v: &mut [f64], q: f64) -> f64 {
    v.sort_by(f64::total_cmp);
    v.get(((v.len().saturating_sub(1)) as f64 * q).round() as usize).map_or(0.0, |x| (x * 1000.0).round() / 1000.0)
}

/// What each page of a PDF draws: its size, its text, and how many paths, images and clips; the bytes themselves differ
/// from run to run.
fn pdf_pages(bytes: &[u8]) -> Vec<String> {
    use hayro_interpret::font::Glyph;
    use hayro_interpret::{
        BlendMode, ClipPath, Context, Device, GlyphDrawMode, Image, InterpreterCache, InterpreterSettings, Paint, PathDrawMode, SoftMask, interpret_page,
    };
    #[derive(Default)]
    struct Ex(String, usize, usize, usize);
    impl Device<'_> for Ex {
        fn set_soft_mask(&mut self, _: Option<SoftMask<'_>>) {}
        fn set_blend_mode(&mut self, _: BlendMode) {}
        fn draw_path(&mut self, _: &kurbo::BezPath, _: kurbo::Affine, _: &Paint<'_>, _: &PathDrawMode) {
            self.1 += 1;
        }
        fn push_clip_path(&mut self, _: &ClipPath) {
            self.3 += 1;
        }
        fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'_>>, _: BlendMode) {}
        fn draw_glyph(&mut self, g: &Glyph<'_>, _: kurbo::Affine, _: kurbo::Affine, _: &Paint<'_>, _: &GlyphDrawMode) {
            match g.as_unicode() {
                Some(hayro_cmap::BfString::Char(c)) => self.0.push(c),
                Some(hayro_cmap::BfString::String(s)) => self.0.push_str(&s),
                None => self.0.push('?'),
            }
        }
        fn draw_image(&mut self, _: Image<'_, '_>, _: kurbo::Affine) {
            self.2 += 1;
        }
        fn pop_clip_path(&mut self) {}
        fn pop_transparency_group(&mut self) {}
    }
    let Ok(pdf) = hayro_syntax::Pdf::new(bytes.to_vec()) else { return vec!["unreadable".into()] };
    let cache = InterpreterCache::new();
    pdf.pages()
        .iter()
        .map(|page| {
            let mut ctx = Context::new(kurbo::Affine::IDENTITY, kurbo::Rect::new(0.0, 0.0, 1.0, 1.0), &cache, pdf.xref(), InterpreterSettings::default());
            let mut ex = Ex::default();
            interpret_page(page, &mut ctx, &mut ex);
            let b = page.media_box();
            format!("{}x{} paths {} images {} clips {} text {}", b.width(), b.height(), ex.1, ex.2, ex.3, ex.0)
        })
        .collect()
}

fn main() -> Result<(), String> {
    let path = std::env::args().nth(1).ok_or("usage: scene_check <file.docx> [baseline.json [baseline.pdf]]")?;
    let base: Option<Value> = std::env::args().nth(2).map(|p| std::fs::read_to_string(p).map_err(|e| e.to_string())).transpose()?.map(|t| serde_json::from_str(&t)).transpose().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mut doc = ew_doc_edit::io::open_bytes("document.docx", &bytes)?;
    doc.core.created = "2026-01-01T00:00:00Z".into();
    let mut s = Session::new(doc);
    s.view.proofing = false;
    let l = s.layout();
    let dopts = DisplayOptions::default();
    let layout: Vec<String> = l.pages.iter().map(|p| format!("{} {}", p.ids.block(p.first_block).map_or(-1, |b| b as i64), page_display(&s.doc, p, &dopts).len())).collect();
    let mut paint = Vec::new();
    let (mut ones, mut more, mut seams, mut blank, mut tiles) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut where_more: Vec<Value> = Vec::new();
    let mut times: Vec<(f32, Vec<f64>)> = Vec::new();
    let mut buf = Vec::new();
    for (pi, p) in l.pages.iter().take(50).enumerate() {
        let list = page_list(&s.doc, p, &dopts);
        let paper = list.paper.map_or([0; 4], |c| [c.0, c.1, c.2, 255]);
        for scale in [1.33f32, 2.0, 4.0] {
            let img = render_page(&s.doc, p, scale, &Default::default());
            paint.push(json!({"w": img.width, "h": img.height, "hash": fnv(&img.pixels)}));
            if std::env::var_os("SCENE_NO_TILES").is_some() {
                continue;
            }
            let opts = PaintOptions::default();
            let mut stitched = vec![0u8; img.pixels.len()];
            let (cols, rows) = (img.width.div_ceil(TILE), img.height.div_ceil(TILE));
            let mut t = Vec::new();
            for row in 0..rows {
                for col in 0..cols {
                    tiles += 1;
                    let t0 = std::time::Instant::now();
                    let got = paint_tile(&list, &s.doc.media, Tile { scale, col, row }, &opts, &mut buf);
                    t.push(t0.elapsed().as_secs_f64() * 1000.0);
                    let (x0, y0) = ((col * TILE) as usize, (row * TILE) as usize);
                    let (w, h) = got.unwrap_or(((img.width - col * TILE).min(TILE), (img.height - row * TILE).min(TILE)));
                    if got.is_none() {
                        blank += 1;
                    }
                    for y in 0..h as usize {
                        let dst = ((y0 + y) * img.width as usize + x0) * 4;
                        let row_px = &mut stitched[dst..dst + w as usize * 4];
                        match got {
                            Some(_) => row_px.copy_from_slice(&buf[y * w as usize * 4..(y + 1) * w as usize * 4]),
                            None => row_px.as_chunks_mut::<4>().0.iter_mut().for_each(|px| *px = paper),
                        }
                    }
                }
            }
            for (i, (a, b)) in stitched.iter().zip(&img.pixels).enumerate() {
                match a.abs_diff(*b) {
                    0 => {}
                    1 => ones += 1,
                    d => {
                        more += 1;
                        let (x, y) = ((i / 4) as u32 % img.width, (i / 4) as u32 / img.width);
                        if where_more.len() < 40 {
                            where_more.push(json!([pi + 1, scale, x, y, d]));
                        }
                        if x % TILE == 0 || x % TILE == TILE - 1 || y % TILE == 0 || y % TILE == TILE - 1 {
                            seams += 1;
                        }
                    }
                }
            }
            match times.iter_mut().find(|(s, _)| *s == scale) {
                Some((_, v)) => v.extend(t),
                None => times.push((scale, t)),
            }
        }
    }
    let (pdf, _) = s.print_pdf(&json!({})).map_err(|e| e.to_string())?;
    // A PDF from before the change (its bytes differ from run to run): the pages that draw differently.
    let pdf_pages_off = match std::env::args().nth(3) {
        Some(old) => {
            let old = pdf_pages(&std::fs::read(old).map_err(|e| e.to_string())?);
            let new = pdf_pages(&pdf);
            let off: Vec<usize> = old.iter().zip(&new).enumerate().filter(|(_, (a, b))| a != b).map(|(i, _)| i + 1).collect();
            json!({"pages": [old.len(), new.len()], "drawDifferently": off})
        }
        None => Value::Null,
    };
    if let Some(dir) = std::env::var_os("SCENE_DUMP") {
        let dir = std::path::PathBuf::from(dir);
        for n in [26usize, 29] {
            let p = &l.pages[n - 1];
            let img = render_page(&s.doc, p, 1.33, &Default::default());
            std::fs::write(dir.join(format!("new-{n}.png")), img.to_png()).map_err(|e| e.to_string())?;
            std::fs::write(dir.join(format!("new-{n}.txt")), format!("{:#?}", page_display(&s.doc, p, &dopts))).map_err(|e| e.to_string())?;
        }
        std::fs::write(dir.join("new.pdf"), &pdf).map_err(|e| e.to_string())?;
    }
    let out = json!({
        "pages": l.pages.len(),
        "layout": fnv(layout.join("\n").as_bytes()),
        "paint": paint,
        "pdf": fnv(&pdf),
        "pdfBytes": pdf.len(),
        "tiles": {"count": tiles, "blank": blank, "channelsOffByOne": ones, "channelsOffByMore": more, "offByMoreOnTileEdges": seams, "offByMoreAt": where_more,
            "paintMs": times.iter_mut().map(|(s, v)| json!({"scale": s, "p50": quantile(v, 0.5), "p95": quantile(v, 0.95)})).collect::<Vec<_>>()},
    });
    if let Some(b) = base {
        let same = |k: &str| out[k] == b[k];
        let pages_same = out["paint"].as_array().zip(b["paint"].as_array()).map(|(x, y)| x.iter().zip(y).filter(|(p, q)| p != q).count());
        let paint_off: Vec<Value> = out["paint"].as_array().zip(b["paint"].as_array()).map_or(Vec::new(), |(x, y)| {
            x.iter().zip(y).enumerate().filter(|(_, (p, q))| p != q).map(|(i, _)| { let scale = [1.33, 2.0, 4.0][i % 3]; json!([i / 3 + 1, scale]) }).collect()
        });
        println!(
            "{}",
            json!({"layoutSame": same("layout") && same("pages"), "pagesDiffering": pages_same, "paintDiffers": paint_off, "pdf": pdf_pages_off, "tiles": out["tiles"]})
        );
    } else {
        println!("{out}");
    }
    Ok(())
}
