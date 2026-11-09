//! engine-incremental (docs/plans/word/briefs/engine-incremental.md): an edit lays out only what it changes, and comes out
//! as a whole layout does. Random edits (typing, deleting, splitting and joining paragraphs, changing a style) on small
//! documents and on the Word fixture, each checked against a whole layout of the document as it then is: page starts, line
//! breaks, the line index and the display list of the pages around the edit.
//!   cargo test --release -p ew-wasm --test incremental
use std::ops::Range;
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

const WORDS: &[&str] = &["layout", "page", "the", "a", "keystroke", "paragraph", "of", "incremental", "Word", "engine", "text", "line"];

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

fn page_sig(p: &Page) -> String {
    let items = |v: &[Placed]| v.iter().map(item_sig).collect::<Vec<_>>().join("\n");
    format!(
        "{} x {} section {} number {} first block {} body {:?} slot {:?} stories {:?} {:?} tables {:?}\n{}\nheader\n{}\nfooter\n{}",
        p.w,
        p.h,
        p.section,
        p.number,
        p.first_block,
        p.body,
        p.hf_slot,
        p.header_story,
        p.footer_story,
        p.float_tables,
        items(&p.items),
        items(&p.header),
        items(&p.footer)
    )
}

/// Whether `a` (laid out again after edits) is `b` (laid out whole); the display lists of pages `drawn` are compared too.
fn same(doc: &Document, a: &DocLayout, b: &DocLayout, drawn: Range<usize>) -> Result<(), String> {
    if a.pages.len() != b.pages.len() {
        return Err(format!("{} pages, laid out whole {}", a.pages.len(), b.pages.len()));
    }
    for (i, (p, q)) in a.pages.iter().zip(&b.pages).enumerate() {
        let (x, y) = (page_sig(p), page_sig(q));
        if x != y {
            let line = x.lines().zip(y.lines()).position(|(l, m)| l != m).unwrap_or(0);
            return Err(format!(
                "page {i} differs at line {line}:\n  again: {}\n  whole: {}",
                x.lines().nth(line).unwrap_or(""),
                y.lines().nth(line).unwrap_or("")
            ));
        }
    }
    if a.index != b.index {
        return Err("the line index differs".into());
    }
    let opts = DisplayOptions::default();
    for i in drawn.start.min(a.pages.len())..drawn.end.min(a.pages.len()) {
        if format!("{:?}", page_display(doc, &a.pages[i], &opts)) != format!("{:?}", page_display(doc, &b.pages[i], &opts)) {
            return Err(format!("the display list of page {i} differs"));
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

/// The footnotes, endnotes and text boxes: their ids and their last paragraph's block and length.
fn parts(doc: &Document) -> Vec<(u32, usize, usize)> {
    use ew_doc_edit::doc::PartKind;
    doc.parts
        .iter()
        .filter(|(_, p)| matches!(p.kind, PartKind::Footnote | PartKind::Endnote | PartKind::TextBox))
        .filter_map(|(id, p)| match p.blocks.iter().enumerate().next_back().map(|(i, b)| (i, &**b)) {
            Some((i, Block::Para(q))) => Some((*id, i, q.text.len())),
            _ => None,
        })
        .collect()
}

/// Typing or deleting in the last paragraph of note or text box `id` (at its end unless `off` is given).
fn edit_part(s: &mut Session, rng: &mut Rng, (id, block, len): (u32, usize, usize), off: Option<usize>) -> String {
    let text = match s.doc.parts.get(&id).and_then(|p| p.blocks.get(block)).map(|b| &**b) {
        Some(Block::Para(p)) => p.text.clone(),
        _ => String::new(),
    };
    let mut off = off.unwrap_or(len).min(len);
    while !text.is_char_boundary(off) {
        off -= 1;
    }
    s.sel = Selection::caret(Pos::new(StoryRef::Part(id), Path(vec![block as u32]), off));
    let (cmd, args) = match rng.below(4) {
        0 => ("text.backspace", json!({})),
        1 => ("text.insert", json!({"text": words(rng, 5), "raw": true})),
        _ => ("text.insert", json!({"text": "x", "raw": true})),
    };
    let r = s.run(cmd, &args);
    format!("{cmd} {args} in part {id} offset {off}: {}", if r.is_ok() { "ok" } else { "failed" })
}

/// A random edit at a random body paragraph, or in a note or text box: what it was, for the failure message.
fn edit(s: &mut Session, rng: &mut Rng, near: Option<usize>) -> String {
    let notes = parts(&s.doc);
    if !notes.is_empty() && rng.below(6) == 0 {
        let part = notes[rng.below(notes.len())];
        let off = rng.below(part.2 + 1);
        return edit_part(s, rng, part, Some(off));
    }
    let paras = paragraphs(&s.doc);
    let pick = match near {
        Some(b) => paras.iter().position(|(i, _)| *i >= b).unwrap_or(0).saturating_sub(2) + rng.below(5),
        None => rng.below(paras.len()),
    };
    let Some(&(block, len)) = paras.get(pick.min(paras.len().saturating_sub(1))) else { return "nothing".into() };
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
        4 => ("text.insert", json!({"text": words(rng, 6), "raw": true})),
        5 => ("text.backspace", json!({})),
        6 => ("text.delete", json!({})),
        7 => ("text.newParagraph", json!({})),
        8 => {
            // Join: Backspace at a paragraph's start.
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

/// Inserts a note (`references.footnote` or `references.endnote`) at the caret holding `n` words, then goes back to the
/// end of the body.
fn note(s: &mut Session, rng: &mut Rng, cmd: &str, n: usize) {
    let at = s.sel.clone();
    s.run(cmd, &json!({})).expect("note");
    s.run("text.insert", &json!({"text": words(rng, n), "raw": true})).expect("note text");
    s.sel = at;
    s.run("caret.docEnd", &json!({})).expect("end");
}

/// Inserts a text box holding `text` at the caret, then goes back to the end of the body.
fn text_box(s: &mut Session, text: String) {
    let at = s.sel.clone();
    s.run("insert.textBox", &json!({ "text": text })).expect("text box");
    s.sel = at;
    s.run("caret.docEnd", &json!({})).expect("end");
}

/// A small document: headings kept with the next paragraph, body text, a page break, a table, a footnote, a footnote long
/// enough to continue onto the next page, an endnote, a text box and two linked text boxes on different pages (the first
/// holding more text than fits).
fn small(rng: &mut Rng) -> Session {
    let mut s = Session::new(ew_doc_edit::blank_document(&Default::default()));
    s.view.proofing = false;
    for i in 0..60 {
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
                // Empty, pages after the first box and linked from it: the first box's overflow shows here.
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

/// Runs `edits` random edits on `s` (all near block `near` if given), each checked against a whole layout.
fn check(s: &mut Session, rng: &mut Rng, edits: usize, near: Option<usize>) -> (usize, usize) {
    s.layout();
    s.take_layout_change();
    let (mut again, mut whole_layouts) = (0, 0);
    for k in 0..edits {
        let what = edit(s, rng, near);
        let (changed, pages) = verify(s, k, &what);
        if changed.len() >= pages && pages > 2 {
            whole_layouts += 1;
        } else {
            again += changed.len();
        }
    }
    (again, whole_layouts)
}

/// Lays `s` out after edit `k` (`what`) and checks it against a whole layout: the pages laid out again and the page count.
fn verify(s: &mut Session, k: usize, what: &str) -> (Range<usize>, usize) {
    let l = s.layout();
    let changed = s.take_layout_change().unwrap_or(0..0);
    let w = whole(s);
    let around = changed.start.saturating_sub(1)..changed.end.saturating_add(1);
    if let Err(e) = same(&s.doc, &l, &w, around) {
        panic!("edit {k} ({what}), pages {changed:?} laid out again: {e}");
    }
    (changed, l.pages.len())
}

#[test]
fn typing_in_notes_and_text_boxes_lays_out_as_a_whole_layout() {
    let mut rng = Rng(11);
    let mut s = small(&mut rng);
    s.layout();
    s.take_layout_change();
    // The long footnote continues onto the next page, so typing at its end changes the continued part.
    let long = parts(&s.doc).into_iter().max_by_key(|p| p.2).expect("a note").0;
    let on = s.layout().pages.iter().filter(|p| p.items.iter().any(|it| matches!(it, Placed::Lines { story, .. } if *story == StoryRef::Part(long)))).count();
    assert!(on >= 2, "the long footnote is on {on} pages");
    for part in parts(&s.doc) {
        for k in 0..5 {
            let part = parts(&s.doc).into_iter().find(|p| p.0 == part.0).expect("the part");
            let what = edit_part(&mut s, &mut rng, part, None);
            verify(&mut s, k, &what);
        }
    }
}

#[test]
fn edits_on_small_documents_lay_out_as_a_whole_layout() {
    for seed in 1..=6u64 {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ seed);
        let mut s = small(&mut rng);
        let (again, whole_layouts) = check(&mut s, &mut rng, 80, None);
        println!("seed {seed}: {} pages, {again} pages laid out again in 80 edits, {whole_layouts} whole layouts", s.layout().pages.len());
    }
}

#[test]
fn typing_that_keeps_the_line_count_repaginates_nothing() {
    let mut rng = Rng(7);
    let mut s = small(&mut rng);
    let pages = s.layout().pages.len();
    assert!(pages >= 4, "{pages} pages");
    // The middle of the longest paragraph on page 3: a letter there moves no line break for a while.
    let l = s.layout();
    let (block, len) = l.pages[2]
        .items
        .iter()
        .filter_map(|it| match it {
            Placed::Lines { story: StoryRef::Body, path, para, .. } if path.0.len() == 1 => Some((l.ids.block(path.0[0])?, para.text_len)),
            _ => None,
        })
        .max_by_key(|(_, len)| *len)
        .expect("a paragraph on page 3");
    drop(l);
    s.sel = Selection::caret(Pos::new(StoryRef::Body, Path(vec![block as u32]), len / 2));
    s.layout();
    s.take_layout_change();
    // Its line count and the pages it is on.
    let laid = |s: &mut Session| {
        let l = s.layout();
        let at = l.index.get(&(StoryRef::Body, l.ids.layout_path(StoryRef::Body, &Path(vec![block as u32]))?))?;
        let lines = at.first().and_then(|&(page, item)| match &l.pages[page].items[item] {
            Placed::Lines { para, .. } => Some(para.lines.len()),
            _ => None,
        })?;
        Some((lines, at.first()?.0..at.last()?.0 + 1))
    };
    let mut kept = 0;
    for _ in 0..8 {
        let before = laid(&mut s);
        s.run("text.insert", &json!({"text": "x", "raw": true})).expect("type");
        let after = laid(&mut s);
        let changed = s.take_layout_change().expect("a layout");
        if let (Some((n, on)), Some((m, _))) = (before, after)
            && n == m
        {
            kept += 1;
            assert!(on.start <= changed.start && changed.end <= on.end, "a letter in a paragraph on pages {on:?} changed pages {changed:?}");
        }
    }
    assert!(kept > 0, "no letter kept the line count");
}

#[test]
fn edits_on_the_word_fixture_lay_out_as_a_whole_layout() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.smoke-data/word/fixture/all-features.docx");
    let Ok(bytes) = std::fs::read(&path) else {
        println!("no Word fixture at {}", path.display());
        return;
    };
    let doc = ew_doc_edit::io::open_bytes("document.docx", &bytes).expect("open the fixture");
    // The fonts a layout falls back to load as it first needs them, and a paragraph laid out before keeps its shaping
    // until it changes: one whole layout first, so the session's starts from the fonts the whole layouts below use.
    Session::new(doc.clone()).layout();
    let mut s = Session::new(doc);
    s.view.proofing = false;
    let mut rng = Rng(0xC0FFEE);
    let blocks = s.doc.body.len();
    let edits: usize = std::env::var("EW_FIXTURE_EDITS").ok().and_then(|n| n.parse().ok()).unwrap_or(8);
    for near in [0, blocks * 3 / 10, blocks * 9 / 10] {
        let (again, whole_layouts) = check(&mut s, &mut rng, edits, Some(near));
        println!("near block {near}: {again} pages laid out again in {edits} edits, {whole_layouts} whole layouts");
    }
}
