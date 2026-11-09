//! engine-main-thread: an edit that changes the page count of a document whose body shows it (a NUMPAGES field) lays out
//! the edit and the blocks that show the total again, not the whole document, and comes out as a whole layout does.
//!   cargo test -p ew-doc-edit totals_relayout
use std::sync::Arc;

use serde_json::json;
use ew_doc::para::InlineObject;
use ew_doc::{Document, Path, StoryRef};
use ew_doc_layout::{DocLayout, Page, Placed};

use crate::{Selection, Session};

/// A page as layout drew it: its number and every item, the field results each line shows among them.
pub(super) fn page_sig(p: &Page) -> String {
    let items = |v: &[Placed]| {
        v.iter()
            .map(|it| match it {
                Placed::Lines { path, para, l0, l1, x, y, .. } => format!("{path:?} {l0}..{l1} at {x},{y} {:?}", para.shown),
                it => format!("{it:?}"),
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!("{} {}\n{}\nfooter\n{}", p.number, p.section, items(&p.items), items(&p.footer))
}

/// `s`'s document laid out whole by a new session.
pub(super) fn whole(s: &Session) -> Arc<DocLayout> {
    let mut f = Session::new(s.doc.clone());
    f.view = s.view.clone();
    f.prefs = s.prefs.clone();
    f.layout()
}

/// The body's NUMPAGES results as the pages show them.
fn totals_shown(l: &DocLayout) -> Vec<String> {
    l.pages
        .iter()
        .flat_map(|p| &p.items)
        .flat_map(|it| if let Placed::Lines { para, .. } = it { para.shown.iter().map(|s| s.1.clone()).collect() } else { vec![] })
        .collect()
}

/// The Word fixture (its body shows NUMPAGES): Enter on page 300, with the view there, until the page count changes. A key
/// lays out as far as the view's pages and the rest follows in slices (engine-repaginate): before, the pagination after the
/// edit never came back to the old one (a mark matches only at the same page count), so a page count change laid every page
/// out again (about 82,000 paragraph layouts looked up, 610 ms in a release build). Settled, it comes out as a whole layout.
#[test]
fn a_page_count_change_on_the_fixture() {
    let Some(mut s) = super::layout_ids::fixture() else { return };
    super::layout_ids::caret_on(&mut s, 299);
    let before = s.layout().pages.len();
    // The view shows page 300: the worker lays out ahead to the last page its views wish for and two more (lookAhead).
    s.set_layout_ahead(Some(302));
    let paras = s.doc.para_paths(StoryRef::Body).len() as u64;
    for k in 0..80 {
        let looked = s.cache.hits + s.cache.misses;
        let t = std::time::Instant::now();
        s.run("text.newParagraph", &json!({})).expect("Enter");
        let mut l = s.layout();
        let ms = t.elapsed().as_secs_f64() * 1e3;
        let looked = s.cache.hits + s.cache.misses - looked;
        assert!(looked < paras / 2, "Enter {k}: {looked} paragraph layouts looked up for {paras} paragraphs");
        let (paused, shown) = (!l.settled(), l.pages.len());
        for slice in 0.. {
            if l.settled() {
                break;
            }
            assert!(slice < 1000, "Enter {k}: the layout did not settle");
            // Held here, the layout could not be gone on with: the session would lay it out from the start again.
            drop(l);
            l = s.advance_layout(50.0);
        }
        if l.pages.len() != before {
            println!(
                "Enter {k} on page 300 took the fixture from {before} to {} pages: {looked} paragraph layouts looked up ({paras} paragraphs), {ms:.1} ms, paused {paused} with {shown} pages shown",
                l.pages.len()
            );
            let w = whole(&s);
            assert_eq!(l.pages.len(), w.pages.len(), "the page count");
            for (i, (a, b)) in l.pages.iter().zip(&w.pages).enumerate() {
                assert_eq!(page_sig(a), page_sig(b), "page {i} differs from a whole layout");
            }
            return;
        }
    }
    panic!("80 Enters did not change the page count");
}

/// Keys typed while the slices go on (engine-keys sends them 60 ms apart) lay out about the edit's pages, not the document,
/// and the layout still settles as a whole one. Once the paused pass ends, the floats placed above their anchors after the
/// edit have moved, so the pass is done again: from the start, a key meanwhile laid out from the start to the view (6,205
/// paragraph layouts looked up, 66 ms, at key 10); now from the last mark before the first page whose floats moved, as the
/// pass's own (pass::rewrap_from).
#[test]
fn keys_while_the_rest_is_laid_out_in_slices() {
    let Some(mut s) = super::layout_ids::fixture() else { return };
    super::layout_ids::caret_on(&mut s, 299);
    drop(s.layout());
    s.set_layout_ahead(Some(302));
    let paras = s.doc.para_paths(StoryRef::Body).len() as u64;
    let mut paused = false;
    for k in 0..120 {
        let cmd = if !paused || k % 2 == 0 { "text.newParagraph" } else { "text.backspace" };
        let looked = s.cache.hits + s.cache.misses;
        let t = std::time::Instant::now();
        s.run(cmd, &json!({})).expect("the key");
        let l = s.layout();
        let looked = s.cache.hits + s.cache.misses - looked;
        println!("key {k} {cmd}: {looked} paragraph layouts looked up, {:.1} ms, settled {}", t.elapsed().as_secs_f64() * 1e3, l.settled());
        assert!(looked < paras / 20, "key {k} ({cmd}): {looked} paragraph layouts looked up for {paras} paragraphs");
        paused |= !l.settled();
        drop(l);
        // One slice between keys, as the worker's turns give it.
        if paused {
            drop(s.advance_layout(8.0));
        }
        if paused && k > 40 {
            break;
        }
    }
    assert!(paused, "no key paused the layout");
    let mut l = s.layout();
    for slice in 0.. {
        if l.settled() {
            break;
        }
        // A bound on the slices, not their speed: in a debug build with the other tests running, 1,000 slices of 8 ms ran
        // out before the rest of the fixture was laid out.
        assert!(slice < 20_000, "the layout did not settle");
        drop(l);
        // Slices as short as the worker's: every pause is a place the pass goes on from (with 50 ms ones, a pass done again
        // for floats that settled them a pass early still came out as a whole layout).
        l = s.advance_layout(8.0);
    }
    let w = whole(&s);
    assert_eq!(l.pages.len(), w.pages.len(), "the page count");
    for (i, (a, b)) in l.pages.iter().zip(&w.pages).enumerate() {
        assert_eq!(page_sig(a), page_sig(b), "page {i} differs from a whole layout");
    }
}

#[test]
fn a_page_count_change_lays_out_the_edit_and_the_total_fields_again() {
    let field = || InlineObject::Field { instr: "NUMPAGES".into(), result: "9".into(), locked: false, dirty: false, code: false, form: String::new() };
    let line = "The page total of this report is shown in its first paragraph and in its footer.";
    let mut d = Document::from_text(&vec![line; 160].join("\n"));
    let p = d.para_mut(StoryRef::Body, &Path::top(0)).expect("the first paragraph");
    p.insert_object(0, field(), &Default::default()).expect("the field");
    let mut s = Session::new(d);
    s.view.proofing = false;
    let start = s.layout().pages.len();
    assert!(start >= 4, "a few pages: {start}");
    // Enter at the end of the last paragraph until a page is added, then Backspace until it goes again.
    let last = s.doc.body.len() - 1;
    let end = s.doc.para(StoryRef::Body, &Path::top(last)).expect("the last paragraph").len();
    s.sel = Selection::caret(ew_doc::Pos::new(StoryRef::Body, Path::top(last), end));
    let blocks = s.doc.body.len() as u64;
    let mut changes = 0;
    for (cmd, k) in [("text.newParagraph", 0), ("text.backspace", 1)] {
        let before = s.layout().pages.len();
        for _ in 0..80 {
            let looked = s.cache.hits + s.cache.misses;
            s.run(cmd, &json!({})).expect("the key");
            let l = s.layout();
            let looked = s.cache.hits + s.cache.misses - looked;
            if l.pages.len() == before {
                continue;
            }
            changes += 1;
            let w = whole(&s);
            assert_eq!(l.pages.len(), w.pages.len(), "{cmd}: the page count");
            for (i, (a, b)) in l.pages.iter().zip(&w.pages).enumerate() {
                assert_eq!(page_sig(a), page_sig(b), "{cmd}: page {i} differs from a whole layout");
            }
            let n = l.pages.len().to_string();
            assert_eq!(totals_shown(&l), [n.as_str()], "{cmd}: the body shows the new total");
            // A whole layout looks every paragraph up at least once; the edit lays out its page and the field its page and the next.
            assert!(looked < blocks / 2, "{cmd}: {looked} paragraph layouts looked up for {blocks} paragraphs");
            break;
        }
        assert_eq!(changes, k + 1, "{cmd} changed the page count");
    }
}

/// A page total outside the body's own paragraphs (a body text box, a footnote) is laid out with the body too, but no body
/// block holds it: the key that changes the page count still comes out as a whole layout does (the review of engine-main-thread
/// found both kept the old total).
fn a_page_count_change_with_the_total_in(story: &str) {
    let field = || InlineObject::Field { instr: "NUMPAGES".into(), result: "9".into(), locked: false, dirty: false, code: false, form: String::new() };
    let line = "The page total of this report is shown in a text box or a footnote on its first page.";
    let mut s = Session::new(Document::from_text(&vec![line; 160].join("\n")));
    s.sel = Selection::caret(ew_doc::Pos::new(StoryRef::Body, Path::top(0), 0));
    let part = if story == "text box" {
        StoryRef::Part(s.run("insert.textBox", &json!({"text": "Total "})).expect("the text box")["story"].as_u64().expect("its story") as u32)
    } else {
        s.run("references.footnote", &json!({"text": "Total "})).expect("the footnote");
        s.sel.focus.story
    };
    let mut d = s.doc.clone();
    let p = d.para_mut(part, &Path::top(0)).expect("the story's paragraph");
    let at = p.len();
    p.insert_object(at, field(), &Default::default()).expect("the field");
    let mut s = Session::new(d);
    s.view.proofing = false;
    let last = s.doc.body.len() - 1;
    let end = s.doc.para(StoryRef::Body, &Path::top(last)).expect("the last paragraph").len();
    s.sel = Selection::caret(ew_doc::Pos::new(StoryRef::Body, Path::top(last), end));
    let before = s.layout().pages.len();
    for _ in 0..80 {
        s.run("text.newParagraph", &json!({})).expect("Enter");
        let l = s.layout();
        if l.pages.len() == before {
            continue;
        }
        let w = whole(&s);
        assert_eq!(l.pages.len(), w.pages.len(), "{story}: the page count");
        for (i, (a, b)) in l.pages.iter().zip(&w.pages).enumerate() {
            assert_eq!(page_sig(a), page_sig(b), "{story}: page {i} differs from a whole layout");
        }
        return;
    }
    panic!("{story}: 80 Enters did not change the page count");
}

#[test]
fn a_page_count_change_with_the_total_in_a_text_box() {
    a_page_count_change_with_the_total_in("text box");
}

#[test]
fn a_page_count_change_with_the_total_in_a_footnote() {
    a_page_count_change_with_the_total_in("footnote");
}
