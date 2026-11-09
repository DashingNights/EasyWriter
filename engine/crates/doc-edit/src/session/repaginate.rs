//! engine-repaginate-2: an Enter on page 300 of the Word fixture whose lines run on into a new page moves every later page
//! by one. The walk laying the document out again takes the old pages over moved ([`ew_doc_layout`]'s `Shift`), lays out
//! again the blocks the move shows wrongly (a section starting on an odd or even page, a picture aligned to the inside
//! margin) and the page totals in slices after it, and comes out as a whole layout does.
//!   cargo test --release -p ew-doc-edit repaginate -- --nocapture
use serde_json::json;

use super::totals_relayout::{page_sig, whole};

/// 20 Enters on page 300 with the view there, each settled in the worker's 8 ms slices. Before engine-repaginate-2 a key
/// that moved the later pages left the rest of the document to the slices: 28,935 to 48,545 paragraph layouts looked up
/// in 18 to 37 slices, the longest 25 to 38 ms (release build, no LTO). Each layout that left work for the slices is
/// checked against a whole layout, and the last one too.
#[test]
fn enters_that_move_the_later_pages_take_them_over() {
    let Some(mut s) = super::layout_ids::fixture() else { return };
    super::layout_ids::caret_on(&mut s, 299);
    let before = s.layout().pages.len();
    // The view shows page 300: the worker lays out ahead to the last page its views wish for and two more (lookAhead).
    s.set_layout_ahead(Some(302));
    let mut moved = 0;
    for k in 0..20 {
        let looked = s.cache.hits + s.cache.misses;
        let t = std::time::Instant::now();
        s.run("text.newParagraph", &json!({})).expect("Enter");
        let mut l = s.layout();
        let ms = t.elapsed().as_secs_f64() * 1e3;
        let looked = s.cache.hits + s.cache.misses - looked;
        let left = !l.settled();
        let (mut slices, mut later) = (0, 0);
        while !l.settled() {
            // A bound on the slices, not their speed (the paragraph layouts below are): a pass's end goes over several 8 ms
            // slices (engine-keys-final), many more of them in a debug build.
            assert!(slices < 5_000, "Enter {k}: the layout did not settle");
            drop(l);
            let n = s.cache.hits + s.cache.misses;
            l = s.advance_layout(8.0);
            later += s.cache.hits + s.cache.misses - n;
            slices += 1;
        }
        println!("Enter {k}: {ms:.1} ms, {looked} paragraph layouts looked up; then {slices} slices, {later} looked up; {} pages", l.pages.len());
        assert!(looked + later < 2_000, "Enter {k}: {looked} and {later} paragraph layouts looked up");
        if left {
            moved += 1;
            let w = whole(&s);
            assert_eq!(l.pages.len(), w.pages.len(), "Enter {k}: the page count");
            for (i, (a, b)) in l.pages.iter().zip(&w.pages).enumerate() {
                assert_eq!(page_sig(a), page_sig(b), "Enter {k}: page {i} differs from a whole layout");
            }
        }
    }
    let l = s.layout();
    assert_ne!(l.pages.len(), before, "20 Enters on page 300 changed the page count");
    assert!(moved > 0, "no Enter left work for the slices");
    let w = whole(&s);
    assert_eq!(l.pages.len(), w.pages.len(), "the page count");
    for (i, (a, b)) in l.pages.iter().zip(&w.pages).enumerate() {
        assert_eq!(page_sig(a), page_sig(b), "page {i} differs from a whole layout");
    }
}

/// The fixture opened with the view's pages first and the rest in slices of a fraction of a millisecond: each slice pauses
/// between the blocks of a page once its time is up, the slices that end a pass dress its pages' headers and footers a few
/// pages at a time (engine-keys-final: in one slice, 3,093 paragraph layouts on the fixture's 959 pages with this machine's
/// fonts), and the settled layout is the whole one, page for page with its headers and footers.
#[test]
fn slices_that_pause_between_blocks_come_out_whole() {
    let Some(mut s) = super::layout_ids::fixture() else { return };
    s.set_layout_ahead(Some(4));
    let mut l = s.layout();
    let (mut slices, mut most) = (0, 0);
    while !l.settled() {
        assert!(slices < 100_000, "the layout did not settle");
        drop(l);
        let looked = s.paragraph_layouts();
        l = s.advance_layout(0.3);
        most = most.max(s.paragraph_layouts() - looked);
        slices += 1;
    }
    println!("{} pages in {slices} slices; the most paragraph layouts a slice looked up: {most}", l.pages.len());
    let w = whole(&s);
    assert_eq!(l.pages.len(), w.pages.len(), "the page count");
    for (i, (a, b)) in l.pages.iter().zip(&w.pages).enumerate() {
        assert_eq!(full_sig(a), full_sig(b), "page {i} differs from a whole layout");
    }
    assert!(most < 1_000, "a slice looked {most} paragraph layouts up");
}

/// engine-keys-final: a key while the slices dress a pass's pages (the fixture opened as the worker opens it) takes the pass
/// back to the mark the walk that reached its end began at, and goes on from there: typed past that mark, or well before
/// it, where the key's walk comes back to the pass's pagination and takes its pages over. Either way the layout settles as a
/// whole one, page for page with its headers and footers.
#[test]
fn a_key_while_a_pass_ends_comes_out_whole() {
    let Some(mut s) = super::layout_ids::fixture() else { return };
    s.set_layout_ahead(Some(4));
    // The document's last paragraph, which the walk that reached the end laid out, and a page 60 pages before the end.
    let last = s.doc.body.iter().rposition(|b| matches!(&**b, ew_doc::Block::Para(_))).expect("a paragraph");
    for back in [None, Some(60)] {
        // A layout from the start (as new fonts make one), laid out in slices until its end is being dressed.
        s.fonts_changed();
        let mut l = s.layout();
        let mut slices = 0;
        while !l.dressing() {
            assert!(!l.settled() && slices < 100_000, "no slice dressed the pass's end");
            drop(l);
            l = s.advance_layout(0.3);
            slices += 1;
        }
        let pos = match back {
            None => ew_doc::Pos::body(last, 0),
            Some(back) => {
                let page = l.pages.len() - back;
                let p = &l.pages[page];
                (1..10).find_map(|k| l.hit(page, p.w / 2.0, p.h * k as f32 / 10.0, ew_doc::StoryRef::Body)).expect("text on the page")
            }
        };
        drop(l);
        s.sel = crate::Selection::caret(pos.clone());
        s.run("text.insert", &json!({ "text": "x" })).expect("the key");
        let l = settle(&mut s);
        let w = whole(&s);
        assert_eq!(l.pages.len(), w.pages.len(), "a key at {pos:?}: the page count");
        for (i, (a, b)) in l.pages.iter().zip(&w.pages).enumerate() {
            assert_eq!(full_sig(a), full_sig(b), "a key at {pos:?}: page {i} differs from a whole layout");
        }
    }
}

/// [`page_sig`] with the page's header too.
fn full_sig(p: &ew_doc_layout::Page) -> String {
    let head: Vec<String> = p.header.iter().map(|it| format!("{it:?}")).collect();
    format!("{}\nheader\n{}", page_sig(p), head.join("\n"))
}

/// engine-keys' bursts on page 300 (letters, Enter, Backspace at a letter and at a paragraph's start, Delete after a join),
/// each key laid out with the view there and the rest in the worker's slices before the next: how many keys left work for the slices, and
/// the slowest keys. With this machine's fonts (2026-11-02, release without LTO): none of 240 left work, median 1.4 ms, p95
/// 2.4. With the bundled fonts alone, as engine-keys' worker lays the fixture out (run it with WINDIR and LOCALAPPDATA set
/// to a folder that does not exist): 16 left work, p95 13.5 ms, the slowest 26 ms. There a line added on page 299 moves the
/// last line of every page to page 317, where its part ends, and the walk pauses at page 308 (the view's pages and
/// EDIT_PAGES): the pass made from it copied the 298 pages before the edit for the pages shown (about 7 ms). Lent rather
/// than copied (progress.rs `lent`), 2026-11-02 with a 0.5 ms slice between keys: p95 3.1 ms, the slowest 4.1.
/// engine-keys-final, release without LTO, bundled fonts, between keys the worker's 0.5 ms slices short of a pass end (other
/// packages building alongside): the slowest keys were the Enters and joining Backspaces whose walk passes the view on a
/// settled layout, 4 to 5.7 ms with 144 to 233 paragraph layouts, p95 4.2. Splitting the line index at the edited page
/// took 1.2 to 1.8 ms of that (pass.rs `split_index`); with it moving the keys rather than copying them, hashed with
/// FxHash, and the walk pausing at the view's pages (no EDIT_PAGES): those keys 2.8 to 3.9 ms with 38 to 43, p95 2.9 to 3.7.
#[test]
#[ignore = "a measure: cargo test --release -p ew-doc-edit keys_bursts -- --ignored --nocapture"]
fn keys_bursts_on_page_300() {
    let Some(mut s) = super::layout_ids::fixture() else { return };
    super::layout_ids::caret_on(&mut s, 299);
    drop(s.layout());
    s.set_layout_ahead(Some(303));
    let burst = ["k", "e", "y", " ", "s", ".", " ", "\n", "x", "\u{8}", "\u{8}", "\u{7f}", "w", "\n", "\u{8}", "\u{7f}", "o", "r", "\u{8}", " "];
    let (mut left, mut times) = (0, Vec::new());
    for _ in 0..12 {
        for key in burst {
            // Whether a layout was under way when the key came, and the paragraph layouts the key looked up.
            let busy = !s.layout().settled();
            let looked = s.paragraph_layouts();
            let t = std::time::Instant::now();
            match key {
                "\n" => s.run("text.newParagraph", &json!({})),
                "\u{8}" => s.run("text.backspace", &json!({})),
                "\u{7f}" => s.run("text.delete", &json!({})),
                k => s.run("text.insert", &json!({ "text": k })),
            }
            .expect("the key");
            let l = s.layout();
            times.push((t.elapsed().as_secs_f64() * 1e3, key, busy, s.paragraph_layouts() - looked));
            left += usize::from(!l.settled());
            // The rest as the worker lays it out while keys come: 0.5 ms slices until the next key, 60 ms later, and no
            // slice that ends a pass or begins one.
            let mut l = l;
            for _ in 0..100 {
                if l.settled() || l.ends_pass_next() {
                    break;
                }
                drop(l);
                l = s.advance_layout(0.5);
            }
        }
        let mut l = s.layout();
        while !l.settled() {
            drop(l);
            l = s.advance_layout(8.0);
        }
    }
    times.sort_by(|a, b| a.0.total_cmp(&b.0));
    let p = |f: f64| times[((times.len() as f64 * f) as usize).min(times.len() - 1)].0;
    println!("{} keys, {left} left work for the slices; median {:.1} ms, p95 {:.1}, slowest (ms, key, a layout under way, paragraph layouts) {:?}", times.len(), p(0.5), p(0.95), &times[times.len() - 14..]);
}

/// engine-keys' bursts on page 900 as the worker gives them while keys come: each key laid out, then the rest in slices of
/// 0.5 ms until the next key (60 ms later: about 100 slices), the view there, the worker's way (engine-keys-final): the slices
/// that end a pass or begin one wait for the pause after the burst, where the rest is laid out in 8 ms slices. Its Delete
/// after a join takes a section break out. Laid out from the start, that Delete looked 15,745 paragraph layouts up, the
/// passes done again for the page totals began again from the start with 2 of the keys after it, and the slice that ended
/// each pass dressed every page (its headers and footers: 3,141 paragraph layouts, 25 to 31 ms with the line index). Now
/// the Delete lays out again from the top of the section it is in, no key begins from the start, no slice between keys ends
/// a pass, and the pause's slices dress a pass's pages a few at a time; after each burst the layout is a whole one, page
/// for page with its headers.
#[test]
fn keys_while_the_rest_is_laid_out_on_page_900() {
    let Some(mut s) = super::layout_ids::fixture() else { return };
    // As the worker opens it: the view's pages, then the rest in slices.
    s.set_layout_ahead(Some(4));
    settle(&mut s);
    s.set_layout_ahead(Some(902));
    super::layout_ids::caret_on(&mut s, 899);
    settle(&mut s);
    let burst = ["k", "e", "y", " ", "s", ".", " ", "\n", "x", "\u{8}", "\u{8}", "\u{7f}", "w", "\n", "\u{8}", "\u{7f}", "o", "r", "\u{8}", " "];
    let (mut slowest, mut most, mut held) = (0, 0, 0);
    for b in 0..2 {
        for key in burst {
            let looked = s.paragraph_layouts();
            match key {
                "\n" => s.run("text.newParagraph", &json!({})),
                "\u{8}" => s.run("text.backspace", &json!({})),
                "\u{7f}" => s.run("text.delete", &json!({})),
                k => s.run("text.insert", &json!({ "text": k })),
            }
            .expect("the key");
            let mut l = s.layout();
            most = most.max(s.paragraph_layouts() - looked);
            for _ in 0..100 {
                if l.settled() {
                    break;
                }
                if l.ends_pass_next() {
                    held += 1;
                    break;
                }
                drop(l);
                let looked = s.paragraph_layouts();
                l = s.advance_layout(0.5);
                slowest = slowest.max(s.paragraph_layouts() - looked);
            }
        }
        let l = settle(&mut s);
        let w = whole(&s);
        assert_eq!(l.pages.len(), w.pages.len(), "burst {b}: the page count");
        for (i, (a, c)) in l.pages.iter().zip(&w.pages).enumerate() {
            assert_eq!(full_sig(a), full_sig(c), "burst {b}: page {i} differs from a whole layout");
        }
    }
    println!("the most paragraph layouts a key looked up: {most}; a slice between keys: {slowest}; pass ends held for the pause: {held}");
    assert!(most < 2_000, "a key looked {most} paragraph layouts up");
    assert!(slowest < 1_000, "a slice between keys looked {slowest} paragraph layouts up");
    assert!(held > 0, "no slice that ends a pass was held for the pause");
}

/// engine-keys-final: Delete at the end of a paragraph that holds a section break takes the break out, and its Undo puts it
/// back. Each lays out again from the top of the section the edit is in rather than from the start, and the pages come out
/// as a whole layout's, page for page with their headers. The sections after it are numbered again, so no old page is taken
/// over: laid out whole, the rest of the document is laid out again; laid out ahead as the worker does, with the view at
/// the edit, the edit lays out its section as far as the view and the rest follows in slices (a whole layout of the Word
/// fixture looks about 15,700 paragraph layouts up). The same while the layout before the edit is still being made in slices.
#[test]
fn a_section_break_taken_out_lays_out_from_its_section() {
    let Some(mut s) = super::layout_ids::fixture() else { return };
    let breaks: Vec<usize> =
        s.doc.body.iter().enumerate().filter_map(|(i, b)| matches!(&**b, ew_doc::Block::Para(p) if p.section.is_some()).then_some(i)).collect();
    assert!(breaks.len() > 4, "the fixture's section breaks: {breaks:?}");
    let sig = |p: &ew_doc_layout::Page| {
        let head: Vec<String> = p.header.iter().map(|it| format!("{it:?}")).collect();
        format!("{}\nheader\n{}", page_sig(p), head.join("\n"))
    };
    let same = |s: &crate::Session, what: &str| {
        let (l, w) = (s.last_layout().expect("laid out"), whole(s));
        assert_eq!(l.pages.len(), w.pages.len(), "{what}: the page count");
        for (i, (a, b)) in l.pages.iter().zip(&w.pages).enumerate() {
            assert_eq!(sig(a), sig(b), "{what}: page {i} differs from a whole layout");
        }
    };
    for (view, unsettled) in [(false, false), (true, false), (true, true)] {
        for &b in &[breaks[1], breaks[breaks.len() / 2], breaks[breaks.len() - 2]] {
            // The view on the page the break is on, as the worker lays out ahead to its views' pages and two more.
            s.set_layout_ahead(None);
            let l = s.layout();
            let page = l.pages.iter().rposition(|p| p.ids.block(p.first_block).is_some_and(|x| x <= b)).unwrap_or(0);
            drop(l);
            s.set_layout_ahead(view.then_some(page + 2));
            settle(&mut s);
            let n = s.doc.sections().len();
            let len = match &*s.doc.body[b] {
                ew_doc::Block::Para(p) => p.len(),
                _ => unreachable!(),
            };
            s.sel = crate::Selection::caret(ew_doc::Pos::body(b, len));
            for (key, sections) in [("text.delete", n - 1), ("edit.undo", n)] {
                // A layout from the start (as new fonts make one), paused at the view's pages.
                if unsettled {
                    s.fonts_changed();
                    assert!(!s.layout().settled(), "the layout before {key} is under way");
                }
                s.run(key, &json!({})).expect("the key");
                assert_eq!(s.doc.sections().len(), sections, "{key} at block {b}: the sections");
                let looked = s.paragraph_layouts();
                drop(s.layout());
                let looked = s.paragraph_layouts() - looked;
                println!("{key} at block {b} on page {page}, view there {view}, under way {unsettled}: {looked} paragraph layouts looked up");
                if view {
                    assert!(looked < 3_000, "{key} at block {b}: {looked} paragraph layouts looked up");
                }
                settle(&mut s);
                same(&s, &format!("{key} at block {b}, view there {view}, under way {unsettled}"));
            }
        }
    }
}

/// The layout, settled in 8 ms slices.
fn settle(s: &mut super::Session) -> std::sync::Arc<ew_doc_layout::DocLayout> {
    let mut l = s.layout();
    while !l.settled() {
        drop(l);
        l = s.advance_layout(8.0);
    }
    l
}
