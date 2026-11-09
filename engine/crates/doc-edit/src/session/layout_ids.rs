//! engine-layout-ids (docs/plans/word/briefs/engine-layout-ids.md): the layout names body blocks by their stable id, so a
//! paragraph added or joined on page 1 of the Word fixture leaves every page after the point where the layout converges as
//! it was: the same items in the same list, not laid out again, moved or copied. Also prints what Enter and a join cost in
//! the layout at pages 1, 300 and 900.
//!   cargo test --release -p ew-doc-edit layout_ids -- --nocapture
use std::sync::Arc;

use serde_json::json;
use ew_doc::StoryRef;
use ew_doc_layout::{DocLayout, Placed};

use crate::{Selection, Session};

/// The Word fixture is gitignored, so a checkout without it skips these tests; EW_FIXTURE_REQUIRED=1 makes a missing or
/// unreadable fixture fail them instead, so a run that must cover them cannot pass without running them.
pub(crate) fn fixture() -> Option<Session> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.smoke-data/word/fixture/all-features.docx");
    let skip = |why: String| {
        assert!(std::env::var("EW_FIXTURE_REQUIRED").as_deref() != Ok("1"), "{why} (EW_FIXTURE_REQUIRED=1)");
        println!("{why}");
    };
    let Ok(bytes) = crate::io::read_file(&path.to_string_lossy()) else {
        skip(format!("no Word fixture at {}", path.display()));
        return None;
    };
    let doc = match crate::io::open_bytes("document.docx", &bytes) {
        Ok(doc) => doc,
        Err(e) => {
            skip(format!("the Word fixture at {} does not open: {e}", path.display()));
            return None;
        }
    };
    let mut s = Session::new(doc);
    s.view.proofing = false;
    Some(s)
}

/// What a page holds, cheaply: per item its kind, story, path and place, a line's layout by address.
fn page_sig(p: &ew_doc_layout::Page) -> (usize, String) {
    let sig = |it: &Placed| match it {
        Placed::Lines { story, path, para, l0, l1, x, y, .. } => format!("L{story:?}{path:?}{l0}-{l1}@{x},{y}#{:p}", Arc::as_ptr(para)),
        Placed::Object { story, path, off, rect, .. } => format!("O{story:?}{path:?}{off}@{rect:?}"),
        Placed::Image { story, path, off, rect, .. } => format!("I{story:?}{path:?}{off}@{rect:?}"),
        Placed::Graphic { story, path, off, rect, .. } => format!("G{story:?}{path:?}{off}@{rect:?}"),
        Placed::Cell { story, table, row, cell, rect, .. } => format!("C{story:?}{table:?}{row},{cell}@{rect:?}"),
        Placed::Shape { rect, object, .. } => format!("S{rect:?}{object:?}"),
        Placed::Clip { rect, items, .. } => format!("K{rect:?}{}", items.len()),
        Placed::Fill { rect, .. } => format!("F{rect:?}"),
        Placed::Rule { x0, y0, x1, y1, .. } => format!("R{x0},{y0},{x1},{y1}"),
    };
    let items: Vec<String> = p.items.iter().map(sig).collect();
    (p.items.as_ptr() as usize, format!("{} {:?} {}\n{}", p.first_block, p.float_tables, p.number, items.join("\n")))
}

fn sigs(l: &DocLayout) -> Vec<(usize, String)> {
    l.pages.iter().map(page_sig).collect()
}

/// A caret a third of the way down page `page`, with one letter typed there (the first command after opening tidies the
/// document on the whole-document path).
pub(super) fn caret_on(s: &mut Session, page: usize) {
    let l = s.layout();
    let p = &l.pages[page];
    let pos = l.hit(page, p.w / 2.0, p.h / 3.0, StoryRef::Body).expect("text on the page");
    drop(l);
    s.sel = Selection::caret(pos);
    s.run("text.insert", &json!({"text": "w"})).expect("type");
    s.layout();
    s.take_layout_change();
}

/// After `key` on page 1, the pages past those it changed hold the same items as before, and from the page where the layout
/// converged on (at most two pages on: the page after a change is laid out again and usually comes out the same) the very
/// same lists, neither laid out again nor moved.
fn later_pages_untouched(s: &mut Session, key: &str) {
    let before = sigs(&s.layout());
    s.run(key, &json!({})).expect("the key");
    let l = s.layout();
    let changed = s.take_layout_change().expect("a layout change");
    assert_eq!(l.pages.len(), before.len(), "{key}: the page count");
    let after = sigs(&l);
    let first = changed.end.min(after.len());
    assert!(first < 10, "{key}: the pages drawn differently end at page {first}");
    for i in first..after.len() {
        assert!(after[i].1 == before[i].1, "{key}: page {i}'s items changed after the pages drawn differently ({changed:?})");
    }
    let kept = (first..after.len()).find(|&i| after[i].0 == before[i].0).expect("pages kept as they were");
    assert!(kept <= first + 2, "{key}: the layout converged at page {kept}, the change ended at {first}");
    for i in kept..after.len() {
        assert_eq!(after[i].0, before[i].0, "{key}: page {i}'s items were copied or laid out again after the layout converged at page {kept}");
    }
    println!("{key}: pages {changed:?} drawn differently, the old pages kept from page {kept} of {}", after.len());
}

#[test]
fn enter_and_a_join_on_page_one_leave_the_later_pages_untouched() {
    let Some(mut s) = fixture() else { return };
    caret_on(&mut s, 0);
    later_pages_untouched(&mut s, "text.newParagraph");
    // Backspace at the new paragraph's start joins it to the one before.
    later_pages_untouched(&mut s, "text.backspace");
}

#[test]
fn enter_and_join_layout_times_on_the_fixture() {
    let Some(mut s) = fixture() else { return };
    let keys: usize = std::env::var("EW_KEYS").ok().and_then(|n| n.parse().ok()).unwrap_or(20);
    let median = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    };
    for page in [0usize, 299, 899] {
        caret_on(&mut s, page);
        let (mut enter, mut join, mut letter) = (Vec::new(), Vec::new(), Vec::new());
        for _ in 0..keys {
            for (key, args, out) in [
                ("text.insert", json!({"text": "x"}), &mut letter),
                ("text.newParagraph", json!({}), &mut enter),
                ("text.backspace", json!({}), &mut join),
            ] {
                s.run(key, &args).expect("key");
                let t = std::time::Instant::now();
                s.layout();
                out.push(t.elapsed().as_secs_f64() * 1e3);
            }
        }
        println!(
            "page {}: layout after a letter {:.2} ms, Enter {:.2} ms, a join {:.2} ms (medians of {keys})",
            page + 1,
            median(&mut letter),
            median(&mut enter),
            median(&mut join)
        );
    }
}

#[test]
fn an_undo_steps_copy_of_the_fixture_by_field() {
    let Some(s) = fixture() else { return };
    let d = &s.doc;
    let time = |f: &dyn Fn()| {
        let mut v: Vec<f64> = (0..21)
            .map(|_| {
                let t = std::time::Instant::now();
                f();
                t.elapsed().as_secs_f64() * 1e3
            })
            .collect();
        v.sort_by(f64::total_cmp);
        v[10]
    };
    println!(
        "copy of the fixture (median of 21, ms): whole {:.3}, body {:.3}, parts {:.3}, styles {:.3}, numbering {:.3}, media {:.3}, comments {:.3}, glossary {:.3}, passthrough {:.3}, settings {:.3}, revisions {:.3}",
        time(&|| drop(std::hint::black_box(d.clone()))),
        time(&|| drop(std::hint::black_box(d.body.clone()))),
        time(&|| drop(std::hint::black_box(d.parts.clone()))),
        time(&|| drop(std::hint::black_box(d.styles.clone()))),
        time(&|| drop(std::hint::black_box(d.numbering.clone()))),
        time(&|| drop(std::hint::black_box(d.media.clone()))),
        time(&|| drop(std::hint::black_box(d.comments.clone()))),
        time(&|| drop(std::hint::black_box(d.glossary.clone()))),
        time(&|| drop(std::hint::black_box(d.passthrough.clone()))),
        time(&|| drop(std::hint::black_box(d.settings.clone()))),
        time(&|| drop(std::hint::black_box(d.revisions.clone()))),
    );
    println!("{} body blocks, {} parts, {} styles, {} media", d.body.len(), d.parts.len(), d.styles.styles.len(), d.media.len());
}

/// Every body block named once and back, and every body item on every page naming a block of the document.
fn names_hold(s: &mut Session, when: &str) {
    let l = s.layout();
    for b in 0..s.doc.body.len() {
        let id = l.ids.id(b).unwrap_or_else(|| panic!("{when}: block {b} of {} has no name", s.doc.body.len()));
        assert_eq!(l.ids.block(id), Some(b), "{when}: block {b} is named {id}, which names another");
    }
    assert_eq!(l.ids.id(s.doc.body.len()), None, "{when}: a name past the last block");
    for (pi, p) in l.pages.iter().enumerate() {
        for it in &p.items {
            if let Placed::Lines { story: StoryRef::Body, path, .. } = it {
                let doc_path = p.ids.doc_path(StoryRef::Body, path).unwrap_or_else(|| panic!("{when}: page {pi}'s {path:?} names no block"));
                assert!(s.doc.para(StoryRef::Body, &doc_path).is_some(), "{when}: page {pi}'s {path:?} is {doc_path:?}, no paragraph");
            }
        }
    }
}

/// The harness case's keys (engine-layout-ids.js): paragraphs added on page 1, then a letter, Enter, a join and a deletion
/// nine times; the names stay whole after every key.
#[test]
fn the_names_hold_through_the_harness_keys() {
    let Some(mut s) = fixture() else { return };
    caret_on(&mut s, 0);
    for i in 0..3 {
        s.run("text.newParagraph", &json!({})).expect("Enter");
        names_hold(&mut s, &format!("Enter {i}"));
    }
    caret_on(&mut s, 0);
    for i in 0..9 {
        for (key, args) in [("text.insert", json!({"text": "x"})), ("text.newParagraph", json!({})), ("text.backspace", json!({})), ("text.backspace", json!({}))] {
            s.run(key, &args).expect("key");
            names_hold(&mut s, &format!("{key} {i}"));
        }
    }
}
