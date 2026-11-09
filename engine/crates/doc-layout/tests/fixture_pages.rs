//! EasyWriter: the Word fixture's pages as the engine lays them out, for docs/plans/engine/fidelity.md. Writes each page's
//! body text (the lines of the body story, tables included, list labels and field results with them) as a JSON list, which
//! .smoke-data/word/fixture/walk/geoalign.py aligns with Word's PDF. Natively the font database finds this machine's fonts;
//! Office's cloud fonts (Aptos Display, Batang, MS Mincho and others, which Word uses and the engine's font provider reads)
//! are added here. The WebAssembly build lays out the same pages with the same fonts (docs/plans/word/wordcraft-eval.md
//! section 3).
//!   cargo test --release -p ew-doc-layout --test fixture_pages -- --ignored --nocapture
//! EW_FIXTURE and EW_PAGES override the fixture and the output (.smoke-data/word/out/engine-fidelity/pages.json).
use std::path::PathBuf;

use ew_doc::StoryRef;
use ew_doc_layout::{LayoutCache, LayoutOptions, Placed, ViewMode, layout};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Office's cloud fonts, the newest file first so that the newest revision of a face is the one kept.
fn add_cloud_fonts() -> usize {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return 0 };
    let root = PathBuf::from(local).join("Microsoft\\FontCache\\4\\CloudFonts");
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for dir in std::fs::read_dir(root).into_iter().flatten().flatten() {
        for f in std::fs::read_dir(dir.path()).into_iter().flatten().flatten() {
            let t = f.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            files.push((t, f.path()));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().filter_map(|(_, p)| std::fs::read(p).ok()).map(|b| ew_fonts::FontDb::global().add_font(b)).sum()
}

/// The text a page shows in the body story, in placement order, and each line's baseline (points from the page top) with
/// its text, for comparing line pitches with Word's PDF. engine-fidelity-2: a line drawn outside the page (`w`, `h`) is
/// left out, as Word's PDF leaves out text it draws there (the fixture's 1584 pt lowered text and its lines past the right
/// edge, Word pages 37 and 50 to 53).
/// engine-fidelity-4: a body paragraph in a frame comes after the page's other text, as in Word's PDF (Word 140, 404 to 408).
fn page_text(doc: &ew_doc::Document, items: &[Placed], (w, h): (f32, f32)) -> (String, Vec<(f32, String)>) {
    let mut out = String::new();
    let mut rows = Vec::new();
    let framed = |it: &&Placed| matches!(it, Placed::Lines { path, para, .. } if path.depth() == 0 && para.rp.frame.is_some());
    let ordered: Vec<&Placed> = items.iter().filter(|it| !framed(it)).chain(items.iter().filter(framed)).collect();
    for it in ordered {
        let Placed::Lines { story: StoryRef::Body, path, para, l0, l1, x, y, .. } = it else { continue };
        let Some(p) = doc.para(StoryRef::Body, path) else { continue };
        let first_top = para.lines.get(*l0).map_or(0.0, |l| l.top);
        if std::env::var("EW_DBG").is_ok_and(|v| p.text.contains(v.as_str())) {
            for st in &para.styles { eprintln!("DBG {:?} {} {} size {} asc {} desc {}", p.text.chars().take(20).collect::<String>(), st.face.get().family, st.face.get().style, st.size, st.ascent, st.descent); }
            for l in &para.lines { eprintln!("DBG line h {} base {} top {}", l.height, l.baseline, l.top); }
            if let Some(lab) = &para.label { eprintln!("DBG label {:?} x {} width {} ascent {}", lab.text, lab.x, lab.width, lab.ascent); }
        }
        for (i, line) in para.lines.get(*l0..*l1).unwrap_or(&[]).iter().enumerate() {
            let base = y + (line.baseline - first_top);
            let left = x + para.x_of(l0 + i, line.start).unwrap_or(0.0);
            if base > h || base < 0.0 || left > w {
                continue;
            }
            let mut text = String::new();
            if i == 0
                && *l0 == 0
                && let Some(label) = &para.label
            {
                text.push_str(&label.text);
            }
            let mut at = line.start;
            for (k, shown, _) in para.shown.iter().filter(|(k, ..)| (line.c0..line.c1).contains(k)) {
                let c = &para.clusters[*k];
                text.push_str(p.text.get(at..c.start).unwrap_or(""));
                text.push_str(shown);
                at = c.end;
            }
            text.push_str(p.text.get(at..line.stop.max(at)).unwrap_or(""));
            out.push_str(&text);
            out.push('\n');
            rows.push((y + (line.baseline - first_top), text));
        }
    }
    (out, rows)
}

#[test]
#[ignore = "lays out the 966-page Word fixture with this machine's fonts: run it by name"]
fn fixture_pages() {
    let fixture = std::env::var_os("EW_FIXTURE").map_or_else(|| repo().join(".smoke-data/word/fixture/all-features.docx"), PathBuf::from);
    let out = std::env::var_os("EW_PAGES").map_or_else(|| repo().join(".smoke-data/word/out/engine-fidelity/pages.json"), PathBuf::from);
    let faces = add_cloud_fonts();
    let bytes = std::fs::read(&fixture).unwrap_or_else(|e| panic!("{}: {e}", fixture.display()));
    let mut doc = ew_docx::read(&bytes).unwrap_or_else(|e| panic!("{e}"));
    doc.ensure_nonempty();
    // engine-fidelity-3: headings collapsed by default fold as in Word's PDF (nothing expanded).
    let opts = LayoutOptions { view: ViewMode::Print, proofing: false, expanded: Some(Default::default()), ..Default::default() };
    let l = layout(&doc, &mut LayoutCache::default(), &opts);
    let (pages, lines): (Vec<String>, Vec<_>) = l.pages.iter().map(|p| page_text(&doc, &p.items, (p.w, p.h))).unzip();
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).unwrap_or_else(|e| panic!("{e}"));
    }
    std::fs::write(&out, serde_json::to_string(&pages).unwrap_or_default()).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(out.with_file_name("lines.json"), serde_json::to_string(&lines).unwrap_or_default()).unwrap_or_else(|e| panic!("{e}"));
    println!("{} pages in {:.0} ms ({faces} cloud font faces added): {}", pages.len(), l.ms, out.display());
}
