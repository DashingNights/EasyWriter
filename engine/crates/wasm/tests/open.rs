//! engine-open (docs/plans/word/briefs/engine-open.md): a layout made in slices comes out as a whole layout. A session with
//! `set_layout_ahead` lays out the first pages, then goes on a page or so at a time (`advance_layout`); once settled, its
//! layout is compared with a whole layout of the same document, and while it is being made, the pages done so far with the
//! whole layout's first pages. Random edits made while it is being made (typing, deleting, splitting and joining paragraphs,
//! styles) are laid out from the paused pass, as engine-incremental's edits are from a whole layout, and checked the same way.
//! On small documents with notes, a table and linked text boxes, and on the Word fixture when it is here.
//!   cargo test --release -p ew-wasm --test open
use std::sync::Arc;

use serde_json::json;
use ew_doc_edit::doc::{Block, Document, Path, Pos, StoryRef};
use ew_doc_edit::layout::display::{DisplayOptions, page_display};
use ew_doc_edit::layout::{DocLayout, Page, Placed};
use ew_doc_edit::{Selection, Session};

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

const WORDS: &[&str] = &["open", "page", "the", "a", "slice", "paragraph", "of", "settled", "Word", "engine", "text", "view"];

fn words(rng: &mut Rng, n: usize) -> String {
    (0..n).map(|_| WORDS[rng.below(WORDS.len())]).collect::<Vec<_>>().join(" ")
}

/// The document laid out whole, as a new session with this one's view would.
fn whole(s: &Session) -> Arc<DocLayout> {
    let mut f = Session::new(s.doc.clone());
    f.view = s.view.clone();
    f.prefs = s.prefs.clone();
    f.layout()
}

fn item_sig(it: &Placed) -> String {
    match it {
        Placed::Lines { story, path, para, l0, l1, x, y, turn } => {
            format!("lines {story:?} {path:?} {l0}..{l1} at {x},{y} {turn:?} h {} {:?}", para.height, para.lines.get(*l0..*l1))
        }
        it => format!("{it:?}"),
    }
}

/// Page `p` as text: its size, numbers and items, and with `dressed` its headers and footers.
fn page_sig(p: &Page, dressed: bool) -> String {
    let items = |v: &[Placed]| v.iter().map(item_sig).collect::<Vec<_>>().join("\n");
    let mut s = format!(
        "{} x {} section {} number {} first block {} body {:?} tables {:?}\n{}",
        p.w,
        p.h,
        p.section,
        p.number,
        p.first_block,
        p.body,
        p.float_tables,
        items(&p.items)
    );
    if dressed {
        s += &format!("\nslot {:?} stories {:?} {:?}\nheader\n{}\nfooter\n{}", p.hf_slot, p.header_story, p.footer_story, items(&p.header), items(&p.footer));
    }
    s
}

/// Whether `a`'s pages are `b`'s: all of them (`all`), else as many as `a` has (a layout still being made). Headers and
/// footers are compared with `dressed` (a page shown before the layout settles shows the page totals assumed so far).
fn same(doc: &Document, a: &DocLayout, b: &DocLayout, all: bool, dressed: bool) -> Result<(), String> {
    if all && a.pages.len() != b.pages.len() {
        return Err(format!("{} pages, laid out whole {}", a.pages.len(), b.pages.len()));
    }
    if a.pages.len() > b.pages.len() {
        return Err(format!("{} pages so far, laid out whole {}", a.pages.len(), b.pages.len()));
    }
    for (i, (p, q)) in a.pages.iter().zip(&b.pages).enumerate() {
        let (x, y) = (page_sig(p, dressed), page_sig(q, dressed));
        if x != y {
            let line = x.lines().zip(y.lines()).position(|(l, m)| l != m).unwrap_or(0);
            return Err(format!(
                "page {i} differs at line {line}:\n  sliced: {}\n  whole:  {}",
                x.lines().nth(line).unwrap_or(""),
                y.lines().nth(line).unwrap_or("")
            ));
        }
    }
    if all {
        if a.index != b.index {
            return Err("the line index differs".into());
        }
        let opts = DisplayOptions::default();
        for i in [0, a.pages.len() / 2, a.pages.len().saturating_sub(1)] {
            if format!("{:?}", page_display(doc, &a.pages[i], &opts)) != format!("{:?}", page_display(doc, &b.pages[i], &opts)) {
                return Err(format!("the display list of page {i} differs"));
            }
        }
    }
    Ok(())
}

/// Top-level body paragraphs with text.
fn paragraphs(doc: &Document) -> Vec<(usize, usize)> {
    doc.body
        .iter()
        .enumerate()
        .filter_map(|(i, b)| match &**b {
            Block::Para(p) if !p.text.is_empty() && p.section.is_none() => Some((i, p.text.len())),
            _ => None,
        })
        .collect()
}

/// A random edit at a random body paragraph: what it was, for the failure message.
fn edit(s: &mut Session, rng: &mut Rng) -> String {
    let paras = paragraphs(&s.doc);
    let Some(&(block, len)) = paras.get(rng.below(paras.len())) else { return "nothing".into() };
    let text = match &*s.doc.body[block] {
        Block::Para(p) => p.text.clone(),
        _ => String::new(),
    };
    let mut off = rng.below(len + 1);
    while !text.is_char_boundary(off) {
        off -= 1;
    }
    s.sel = Selection::caret(Pos::new(StoryRef::Body, Path(vec![block as u32]), off));
    let (id, args) = match rng.below(10) {
        0..=3 => ("text.insert", json!({"text": "x", "raw": true})),
        4 => ("text.insert", json!({"text": words(rng, 40), "raw": true})),
        5 => ("text.backspace", json!({})),
        6 => ("text.delete", json!({})),
        7 => ("text.newParagraph", json!({})),
        8 => {
            s.sel = Selection::caret(Pos::new(StoryRef::Body, Path(vec![block as u32]), 0));
            ("text.backspace", json!({}))
        }
        _ => {
            let style = ["Heading 1", "Normal", "Heading 2", "Title"][rng.below(4)];
            ("para.style", json!({ "style": style }))
        }
    };
    let r = s.run(id, &args);
    format!("{id} {args} at block {block} offset {off}: {}", if r.is_ok() { "ok" } else { "failed" })
}

/// Inserts a note (`references.footnote` or `references.endnote`) at the caret holding `n` words, then goes back to the end.
fn note(s: &mut Session, rng: &mut Rng, cmd: &str, n: usize) {
    let at = s.sel.clone();
    s.run(cmd, &json!({})).expect("note");
    s.run("text.insert", &json!({"text": words(rng, n), "raw": true})).expect("note text");
    s.sel = at;
    s.run("caret.docEnd", &json!({})).expect("end");
}

/// Inserts a text box holding `text` at the caret, then goes back to the end.
fn text_box(s: &mut Session, text: String) {
    let at = s.sel.clone();
    s.run("insert.textBox", &json!({ "text": text })).expect("text box");
    s.sel = at;
    s.run("caret.docEnd", &json!({})).expect("end");
}

/// A document of some 15 pages: headings kept with the next paragraph, body text, a page break, a table, footnotes (one
/// long enough to continue onto the next page), an endnote, a text box and two linked text boxes on different pages.
fn small(rng: &mut Rng) -> Session {
    let mut s = Session::new(ew_doc_edit::blank_document(&Default::default()));
    s.view.proofing = false;
    for i in 0..90 {
        let n = 3 + rng.below(90);
        s.run("text.insert", &json!({"text": words(rng, n), "raw": true})).expect("type");
        if i % 9 == 0 {
            s.run("para.style", &json!({"style": "Heading 1"})).expect("style");
        }
        if i == 20 {
            s.run("text.pageBreak", &json!({})).expect("page break");
        }
        match i {
            10 => note(&mut s, rng, "references.endnote", 20),
            15 => note(&mut s, rng, "references.footnote", 900),
            30 => note(&mut s, rng, "references.footnote", 30),
            2 => text_box(&mut s, words(rng, 150)),
            50 => text_box(&mut s, words(rng, 12)),
            55 => {
                text_box(&mut s, String::new());
                s.run("select.objects", &json!({"index": 0})).expect("select the first box");
                s.run("shape.link", &json!({"target": 2})).expect("link");
                s.run("caret.docEnd", &json!({})).expect("end");
            }
            _ => {}
        }
        s.run("text.newParagraph", &json!({})).expect("enter");
        if i == 40 {
            s.run("insert.table", &json!({"rows": 3, "cols": 2})).expect("table");
            s.run("caret.docEnd", &json!({})).expect("end");
        }
    }
    s
}

/// Settles `s`'s layout a slice at a time (the shortest: each lays out about a page), checking the pages done so far
/// against `w` after every slice; the slices it took.
fn settle(s: &mut Session, w: &DocLayout, dressed: bool) -> usize {
    let mut slices = 0;
    while !s.layout().settled() {
        let l = s.advance_layout(0.0);
        slices += 1;
        assert!(slices < 10_000, "the layout does not settle");
        if !l.settled() {
            same(&s.doc, &l, w, false, dressed).unwrap_or_else(|e| panic!("after {slices} slices: {e}"));
        }
    }
    slices
}

#[test]
fn a_layout_made_in_slices_is_a_whole_layout() {
    for seed in 1..=4u64 {
        let mut rng = Rng(0x5EED_0000 ^ seed);
        let mut s = small(&mut rng);
        let w = whole(&s);
        assert!(w.pages.len() >= 8, "{} pages", w.pages.len());
        s.set_layout_ahead(Some(2));
        s.fonts_changed();
        let first = s.layout();
        assert!(!first.settled(), "the first layout lays out the view's pages only");
        assert!((2..=4).contains(&first.pages.len()), "{} pages first", first.pages.len());
        let slices = settle(&mut s, &w, true);
        let l = s.layout();
        same(&s.doc, &l, &w, true, true).unwrap_or_else(|e| panic!("seed {seed}, settled: {e}"));
        println!("seed {seed}: {} pages in {slices} slices", l.pages.len());
    }
}

#[test]
fn edits_while_a_layout_is_made_lay_out_as_a_whole_layout() {
    for seed in 1..=4u64 {
        let mut rng = Rng(0xED17_0000 ^ seed);
        let mut s = small(&mut rng);
        s.set_layout_ahead(Some(2));
        s.fonts_changed();
        s.layout();
        for k in 0..60 {
            let what = edit(&mut s, &mut rng);
            let l = s.layout();
            let w = whole(&s);
            if l.settled() {
                same(&s.doc, &l, &w, true, true).unwrap_or_else(|e| panic!("seed {seed} edit {k} ({what}), settled: {e}"));
            } else {
                same(&s.doc, &l, &w, false, false).unwrap_or_else(|e| panic!("seed {seed} edit {k} ({what}), {} pages so far: {e}", l.pages.len()));
            }
            // A slice or two between edits, and now and then a fresh start (new fonts lay out from the start).
            match rng.below(8) {
                0 => {
                    s.fonts_changed();
                }
                1..=4 => {
                    s.advance_layout(0.0);
                }
                _ => {}
            }
        }
        let w = whole(&s);
        settle(&mut s, &w, false);
        let l = s.layout();
        same(&s.doc, &l, &w, true, true).unwrap_or_else(|e| panic!("seed {seed}, settled after the edits: {e}"));
    }
}

/// engine-main-thread-2: the end of a pass (headers and footers for every page, the line index, footnotes numbered again) comes
/// in a slice of its own, and so does the start of a pass done again: after a slice's worth of pages they held the Word fixture's
/// worker 57 to 119 ms at a time. However long a slice may be, the pass pauses before its last block and ends in the next.
#[test]
fn a_pass_ends_and_the_next_begins_in_slices_of_their_own() {
    for totals in [false, true] {
        let mut rng = Rng(0x5EED_0001);
        let mut s = small(&mut rng);
        if totals {
            // The page count in the body: the first pass assumes one, so the pass is done again with the count it found.
            s.run("caret.docStart", &json!({})).expect("start");
            s.run("insert.field", &json!({"instr": "NUMPAGES"})).expect("NUMPAGES");
        }
        let w = whole(&s);
        s.set_layout_ahead(Some(2));
        s.fonts_changed();
        assert!(!s.layout().settled());
        let mut slices = 0;
        while !s.layout().settled() {
            s.advance_layout(1e9);
            slices += 1;
            assert!(slices < 20, "the layout does not settle");
        }
        // Each pass: up to its last block in one slice, its end in the next.
        if totals {
            assert!(slices >= 4 && slices % 2 == 0, "{slices} slices with the page count in the body");
        } else {
            assert_eq!(slices, 2, "one pass");
        }
        let l = s.layout();
        same(&s.doc, &l, &w, true, true).unwrap_or_else(|e| panic!("totals {totals}, settled: {e}"));
    }
}

#[test]
fn the_word_fixture_made_in_slices_is_a_whole_layout() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.smoke-data/word/fixture/all-features.docx");
    let Ok(bytes) = std::fs::read(&path) else {
        println!("no Word fixture at {}", path.display());
        return;
    };
    let doc = ew_doc_edit::io::open_bytes("document.docx", &bytes).expect("open the fixture");
    // The fonts a layout falls back to load as it first needs them: one whole layout first, so both start from the same.
    Session::new(doc.clone()).layout();
    let mut s = Session::new(doc);
    s.view.proofing = false;
    let w = whole(&s);
    s.set_layout_ahead(Some(3));
    let t = std::time::Instant::now();
    let first = s.layout();
    let first_ms = t.elapsed().as_secs_f64() * 1e3;
    assert!(!first.settled());
    same(&s.doc, &first, &w, false, false).unwrap_or_else(|e| panic!("the first pages: {e}"));
    drop(first);
    let t = std::time::Instant::now();
    let mut slices = 0;
    while !s.layout().settled() {
        s.advance_layout(8.0);
        slices += 1;
    }
    let rest_ms = t.elapsed().as_secs_f64() * 1e3;
    let l = s.layout();
    same(&s.doc, &l, &w, true, true).unwrap_or_else(|e| panic!("settled: {e}"));
    drop(l);
    println!("fixture: first pages {first_ms:.0} ms, the rest {rest_ms:.0} ms in {slices} slices of 8 ms, {} pages", w.pages.len());

    // Typing near the start while the rest is laid out, checked against whole layouts.
    s.fonts_changed();
    s.layout();
    let mut rng = Rng(0x0BE7);
    for k in 0..6 {
        let paras = paragraphs(&s.doc);
        let (block, len) = paras[rng.below(12.min(paras.len()))];
        s.sel = Selection::caret(Pos::new(StoryRef::Body, Path(vec![block as u32]), len / 2));
        let r = s.run(if k % 3 == 2 { "text.newParagraph" } else { "text.insert" }, &json!({"text": "x", "raw": true}));
        assert!(r.is_ok());
        let l = s.layout();
        let w = whole(&s);
        same(&s.doc, &l, &w, l.settled(), l.settled()).unwrap_or_else(|e| panic!("edit {k} at block {block}: {e}"));
        s.advance_layout(8.0);
    }
    let w = whole(&s);
    while !s.layout().settled() {
        s.advance_layout(50.0);
    }
    let l = s.layout();
    same(&s.doc, &l, &w, true, true).unwrap_or_else(|e| panic!("settled after the edits: {e}"));
}
