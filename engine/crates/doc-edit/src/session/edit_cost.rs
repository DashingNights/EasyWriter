//! engine-edit-cost (docs/plans/word/briefs/engine-edit-cost.md): a key in a table cell takes the table's other rows over from
//! its last layout and still lays out as a whole layout does, and an undo step shares the styles and numbering. Also prints
//! what a key in a cell and an undo step's first key cost on the Word fixture.
//!   cargo test --release -p ew-doc-edit edit_cost -- --nocapture
use std::sync::Arc;

use serde_json::json;
use ew_doc::numbering::ListKind;
use ew_doc::props::{NumRef, VMerge};
use ew_doc::{Block, Cell, Document, Path, Pos, StoryRef, Table};
use ew_doc_layout::{DocLayout, Page, Placed};

use super::layout_ids::{caret_on, fixture};
use crate::{Selection, Session};

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

/// xorshift64: random edits, the same on every run.
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n.max(1) as u64) as usize
    }
}

const WORDS: &[&str] = &["row", "cell", "the", "a", "table", "keystroke", "of", "layout", "Word", "column", "text"];

fn words(rng: &mut Rng, n: usize) -> String {
    (0..n).map(|_| WORDS[rng.below(WORDS.len())]).collect::<Vec<_>>().join(" ")
}

fn table(rng: &mut Rng, rows: usize, cols: usize) -> Table {
    let mut t = Table::new(rows, cols, 468.0);
    for row in &mut t.rows {
        for c in &mut row.cells {
            let width = c.props.width;
            let n = 1 + rng.below(12);
            *c = Cell::with_text(&words(rng, n));
            c.props.width = width;
        }
    }
    t
}

/// Paragraphs and four tables: a plain one over two pages, one with a cell merged down three rows, one with a numbered
/// list in its first column and a repeated header row, and one with fixed columns.
fn tables_doc(rng: &mut Rng) -> Document {
    let mut d = Document::from_text(&(0..12).map(|_| words(rng, 40)).collect::<Vec<_>>().join("\n"));
    let list = d.numbering_mut().add_list(ListKind::Numbered);
    let plain = table(rng, 60, 3);
    let mut merged = table(rng, 10, 3);
    merged.rows[2].cells[1].props.vmerge = VMerge::Restart;
    merged.rows[3].cells[1].props.vmerge = VMerge::Continue;
    merged.rows[4].cells[1].props.vmerge = VMerge::Continue;
    let mut listed = table(rng, 12, 2);
    listed.rows[0].props.header = true;
    for row in &mut listed.rows[1..] {
        if let Some(Block::Para(p)) = row.cells[0].blocks.first_mut().map(Arc::make_mut) {
            p.props.numbering = Some(NumRef { num: list, level: 0 });
        }
    }
    let mut fixed = table(rng, 8, 4);
    fixed.props.fixed = true;
    for (at, t) in [(10, fixed), (8, listed), (5, merged), (2, plain)] {
        d.body.insert(at, Arc::new(Block::Table(t)));
    }
    d
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
    format!("{} {} {} {:?}\n{}\nheader\n{}\nfooter\n{}", p.number, p.first_block, p.section, p.float_tables, items(&p.items), items(&p.header), items(&p.footer))
}

/// `s`'s document laid out whole by a new session with its view and every table row laid out.
fn whole(s: &Session) -> Arc<DocLayout> {
    let mut f = Session::new(s.doc.clone());
    f.view = s.view.clone();
    f.prefs = s.prefs.clone();
    f.cache.set_row_memo(false);
    f.layout()
}

/// A random edit in a random cell of a random table: typing, deleting, Enter, a join, or a row added or taken away.
fn edit_in_a_cell(s: &mut Session, rng: &mut Rng) -> String {
    let tables: Vec<usize> = s.doc.body.iter().enumerate().filter(|(_, b)| matches!(***b, Block::Table(_))).map(|(i, _)| i).collect();
    let b = tables[rng.below(tables.len())];
    let Block::Table(t) = &*s.doc.body[b] else { return "no table".into() };
    let r = rng.below(t.rows.len());
    let c = rng.below(t.rows[r].cells.len());
    let cell = &t.rows[r].cells[c];
    let k = rng.below(cell.blocks.len());
    let text = cell.blocks[k].as_para().map(|p| p.text.clone()).unwrap_or_default();
    let mut off = rng.below(text.len() + 1);
    while !text.is_char_boundary(off) {
        off -= 1;
    }
    s.sel = Selection::caret(Pos::new(StoryRef::Body, Path(vec![b as u32, r as u32, c as u32, k as u32]), off));
    let (cmd, args) = match rng.below(14) {
        0..=4 => ("text.insert", json!({"text": "x", "raw": true})),
        5 => ("text.insert", json!({"text": words(rng, 8), "raw": true})),
        6 => ("text.backspace", json!({})),
        7 => ("text.delete", json!({})),
        8 => ("text.newParagraph", json!({})),
        9 => {
            s.sel = Selection::caret(Pos::new(StoryRef::Body, Path(vec![b as u32, r as u32, c as u32, k as u32]), 0));
            ("text.backspace", json!({}))
        }
        10 => ("text.insert", json!({"text": words(rng, 60), "raw": true})),
        11 => ("table.insertRowBelow", json!({})),
        12 => ("table.deleteRow", json!({})),
        _ => ("caret.right", json!({})),
    };
    let ok = s.run(cmd, &args).is_ok();
    format!("{cmd} {args} in table {b} row {r} cell {c} block {k} offset {off}: {}", if ok { "ok" } else { "failed" })
}

#[test]
fn keys_in_table_cells_lay_out_as_a_whole_layout() {
    for seed in 1..=3u64 {
        let mut rng = Rng(0x2545_F491_4F6C_DD1D ^ seed);
        let mut s = Session::new(tables_doc(&mut rng));
        s.view.proofing = false;
        s.layout();
        let (kept, mut laid) = (s.cache.rows_kept, 0u64);
        for k in 0..150 {
            let what = edit_in_a_cell(&mut s, &mut rng);
            let hits = s.cache.hits;
            let l = s.layout();
            laid += s.cache.hits + s.cache.misses - hits;
            let w = whole(&s);
            assert_eq!(l.pages.len(), w.pages.len(), "seed {seed} edit {k} ({what}): the page count");
            for (i, (a, b)) in l.pages.iter().zip(&w.pages).enumerate() {
                let (a, b) = (page_sig(a), page_sig(b));
                if a != b {
                    let line = a.lines().zip(b.lines()).position(|(x, y)| x != y).unwrap_or(0);
                    panic!(
                        "seed {seed} edit {k} ({what}): page {i} differs from a whole layout at item line {line}:\n  {}\n  {}",
                        a.lines().nth(line).unwrap_or(""),
                        b.lines().nth(line).unwrap_or("")
                    );
                }
            }
        }
        let kept = s.cache.rows_kept - kept;
        println!("seed {seed}: {} pages; {kept} table rows taken over and {laid} paragraph layouts looked up in 150 edits", s.layout().pages.len());
        assert!(kept > 1000, "seed {seed}: only {kept} rows taken over");
    }
}

#[test]
fn an_undo_step_shares_the_styles_and_numbering_until_a_command_changes_them() {
    let mut s = Session::new(Document::from_text("one\ntwo"));
    s.run("text.insert", &json!({"text": "x"})).expect("type");
    s.close_typing();
    s.run("text.insert", &json!({"text": "y"})).expect("type");
    let step = &s.history.last().expect("a step").doc;
    assert!(Arc::ptr_eq(&step.styles, &s.doc.styles) && Arc::ptr_eq(&step.numbering, &s.doc.numbering), "a letter's step shares them");
    let quick = s.doc.styles.get("Heading1").map(|st| st.quick);
    s.run("styles.addToGallery", &json!({"style": "Heading 1", "value": quick != Some(true)})).expect("gallery");
    let step = &s.history.last().expect("a step").doc;
    assert!(!Arc::ptr_eq(&step.styles, &s.doc.styles), "a style change copies the styles");
    assert_eq!(step.styles.get("Heading1").map(|st| st.quick), quick, "and the step keeps them as they were");
    assert!(Arc::ptr_eq(&step.numbering, &s.doc.numbering), "the numbering is still shared");
    assert!(s.undo());
    assert_eq!(s.doc.styles.get("Heading1").map(|st| st.quick), quick);
}

/// A 50-row, 3-column table with a few words in every cell, put in on page 300 → its block number.
fn table_on_page_300(s: &mut Session) -> usize {
    caret_on(s, 299);
    s.run("text.newParagraph", &json!({})).expect("Enter");
    s.run("insert.table", &json!({"rows": 50, "cols": 3})).expect("a table");
    let b = s.sel.focus.path.0[0] as usize;
    for r in 0..50u32 {
        for c in 0..3u32 {
            s.sel = Selection::caret(Pos::new(StoryRef::Body, Path(vec![b as u32, r, c, 0]), 0));
            s.run("text.insert", &json!({"text": format!("cell {r} {c}")})).expect("cell text");
        }
    }
    s.layout();
    b
}

#[test]
fn a_key_in_a_table_cell_and_an_undo_steps_copy_on_the_fixture() {
    let Some(mut s) = fixture() else { return };
    let b = table_on_page_300(&mut s);
    let keys: usize = std::env::var("EW_KEYS").ok().and_then(|n| n.parse().ok()).unwrap_or(40);
    // Words, as a typist's: one long word would widen its column (autofit) and move every page after the table.
    let typed: Vec<String> = "table keys row ".chars().map(String::from).collect();
    let run = |s: &mut Session, memo: bool, row: u32| {
        s.cache.set_row_memo(memo);
        s.sel = Selection::caret(Pos::new(StoryRef::Body, Path(vec![b as u32, row, 1, 0]), 4));
        s.run("text.insert", &json!({"text": " "})).expect("a space");
        s.layout();
        s.take_layout_change();
        let (mut edit, mut layout, mut pages) = (Vec::new(), Vec::new(), Vec::new());
        let (kept, looked) = (s.cache.rows_kept, s.cache.hits + s.cache.misses);
        for k in 0..keys {
            let t = std::time::Instant::now();
            s.run("text.insert", &json!({"text": typed[k % typed.len()]})).expect("a letter");
            edit.push(t.elapsed().as_secs_f64() * 1e3);
            let t = std::time::Instant::now();
            s.layout();
            layout.push(t.elapsed().as_secs_f64() * 1e3);
            pages.push(s.take_layout_change().map_or(0.0, |r| r.len() as f64));
        }
        let per = |n: u64| n as f64 / keys as f64;
        println!(
            "row {}: rows taken over a key {:.1}, paragraph layouts looked up a key {:.1}, pages drawn again (median) {}",
            row + 1,
            per(s.cache.rows_kept - kept),
            per(s.cache.hits + s.cache.misses - looked),
            median(&mut pages)
        );
        (median(&mut edit), median(&mut layout))
    };
    let (off_edit, off_layout) = run(&mut s, false, 20);
    let (on_edit, on_layout) = run(&mut s, true, 25);
    println!(
        "a key in a row of a 50-row table on page 300 (median of {keys}, ms): every row laid out: edit {off_edit:.3}, layout {off_layout:.3}; rows taken over: edit {on_edit:.3}, layout {on_layout:.3}"
    );
    let mut first = Vec::new();
    for _ in 0..keys {
        s.close_typing();
        let t = std::time::Instant::now();
        s.run("text.insert", &json!({"text": "y"})).expect("a letter");
        first.push(t.elapsed().as_secs_f64() * 1e3);
        s.layout();
    }
    let d = &s.doc;
    let mut copy: Vec<f64> = (0..21)
        .map(|_| {
            let t = std::time::Instant::now();
            drop(std::hint::black_box(d.clone()));
            t.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    println!(
        "the first letter of an undo step in that cell (median of {keys}, ms): edit {:.3}; the document's copy (median of 21): {:.3}",
        median(&mut first),
        median(&mut copy)
    );
}
