//! engine-layout-key: a key lays out only what the screen needs before it replies. engine-keys' bursts on pages 1, 300 and
//! 900 of the Word fixture, laid out as the worker lays them out while keys come, and what each key laid out before its
//! layout came back (the worker's reply).
//!   cargo test --release -p ew-doc-edit layout_key -- --nocapture
//! The worker lays the fixture out with the bundled fonts alone; to measure as it does, run with WINDIR and LOCALAPPDATA set
//! to a folder that does not exist, and EW_FIXTURE_REQUIRED=1 for the tests to insist on the pauses.
use serde_json::json;

use super::Session;
use super::totals_relayout::{page_sig, whole};

/// engine-keys' burst: letters, spaces and a period, Enter, Backspace at a letter and at a paragraph's start (a join), and
/// Delete of a letter after a join.
const BURST: [&str; 20] = ["k", "e", "y", " ", "s", ".", " ", "\n", "x", "\u{8}", "\u{8}", "\u{7f}", "w", "\n", "\u{8}", "\u{7f}", "o", "r", "\u{8}", " "];

fn key(s: &mut Session, k: &str) {
    match k {
        "\n" => s.run("text.newParagraph", &json!({})),
        "\u{8}" => s.run("text.backspace", &json!({})),
        "\u{7f}" => s.run("text.delete", &json!({})),
        k => s.run("text.insert", &json!({ "text": k })),
    }
    .expect("the key");
}

fn kind(k: &str) -> &'static str {
    match k {
        "\n" => "enter",
        "\u{8}" => "backspace",
        "\u{7f}" => "delete",
        " " => "space",
        "." => "period",
        _ => "letter",
    }
}

/// The view on page `page` (0-based) as the worker sets it in engine-keys: the page on screen (setView), and the layout ahead
/// to the last page its views wish for, one screen further in the direction it scrolled, and two more (lookAhead).
fn view_on(s: &mut Session, page: usize) {
    let ahead: usize = std::env::var("LK_AHEAD").ok().and_then(|b| b.parse().ok()).unwrap_or(4);
    s.set_layout_ahead(Some(page + ahead));
    s.set_layout_screen((std::env::var("LK_SCREEN").as_deref() != Ok("0")).then_some(page + 1));
}

/// What the worker lays out between two keys 60 ms apart: `slices` of 0.5 ms, and no slice that ends a pass or begins one. Few
/// of them leave the next key to come while the last one's walk is paused.
fn between(s: &mut Session, slices: usize) {
    let mut l = s.layout();
    for _ in 0..slices {
        if l.settled() || l.ends_pass_next() {
            break;
        }
        drop(l);
        l = s.advance_layout(0.5);
    }
}

/// The layout, settled in 8 ms slices, as the worker lays it out once the typing pauses.
fn settle(s: &mut Session) -> std::sync::Arc<ew_doc_layout::DocLayout> {
    let mut l = s.layout();
    let mut slices = 0;
    while !l.settled() {
        assert!(slices < 100_000, "the layout did not settle");
        drop(l);
        l = s.advance_layout(8.0);
        slices += 1;
    }
    l
}

/// Per key kind on pages 1, 300 and 900: the paragraph layouts looked up and the pages laid out before the key's layout came
/// back, how many keys left the rest to the slices, and the time natively.
#[test]
#[ignore = "a measure: cargo test --release -p ew-doc-edit keys_before_the_reply -- --ignored --nocapture"]
fn keys_before_the_reply() {
    let Some(mut s) = super::layout_ids::fixture() else { return };
    s.set_layout_ahead(Some(4));
    settle(&mut s);
    let bursts: usize = std::env::var("KEYS_BURSTS").ok().and_then(|b| b.parse().ok()).unwrap_or(6);
    for page in [0, 299, 899] {
        view_on(&mut s, page);
        super::layout_ids::caret_on(&mut s, page);
        settle(&mut s);
        // (kind, ms, paragraph layouts, pages, left for the slices)
        let mut rows: Vec<(&str, f64, u64, u64, bool)> = Vec::new();
        for _ in 0..bursts {
            for k in BURST {
                let (looked, laid) = (s.paragraph_layouts(), s.cache.pages_laid);
                let t = std::time::Instant::now();
                key(&mut s, k);
                let l = s.layout();
                let ms = t.elapsed().as_secs_f64() * 1e3;
                rows.push((kind(k), ms, s.paragraph_layouts() - looked, s.cache.pages_laid - laid, !l.settled()));
                drop(l);
                between(&mut s, std::env::var("LK_BETWEEN").ok().and_then(|b| b.parse().ok()).unwrap_or(100));
            }
            settle(&mut s);
        }
        let q = |mut v: Vec<f64>, f: f64| {
            v.sort_by(f64::total_cmp);
            v.get(((v.len() as f64 * f) as usize).min(v.len().saturating_sub(1))).copied().unwrap_or(0.0)
        };
        for kind in ["letter", "space", "period", "enter", "backspace", "delete"] {
            let r: Vec<_> = rows.iter().filter(|r| r.0 == kind).collect();
            let col = |f: &dyn Fn(&(&str, f64, u64, u64, bool)) -> f64| r.iter().map(|x| f(x)).collect::<Vec<_>>();
            println!(
                "page {}: {kind} ({}) paragraph layouts median {} p95 {} most {}; pages laid out median {} p95 {} most {}; {} left the rest to the slices; {:.2} ms, p95 {:.2}",
                page + 1,
                r.len(),
                q(col(&|x| x.2 as f64), 0.5),
                q(col(&|x| x.2 as f64), 0.95),
                q(col(&|x| x.2 as f64), 1.0),
                q(col(&|x| x.3 as f64), 0.5),
                q(col(&|x| x.3 as f64), 0.95),
                q(col(&|x| x.3 as f64), 1.0),
                r.iter().filter(|x| x.4).count(),
                q(col(&|x| x.1), 0.5),
                q(col(&|x| x.1), 0.95),
            );
        }
    }
}

/// Enters and Backspaces on page 300 with the view there, laid out as the worker lays them out while keys come (each key's
/// layout no further than the page on screen and the next, then a few 0.5 ms slices until the next key; with few, the next key
/// comes while the last one's walk is paused): once the slices settle, the pages are a whole layout's, page for page with their
/// headers. While the walk is paused the caret and a paragraph on the last page laid out are where a whole layout puts them.
#[test]
fn enters_and_backspaces_on_page_300_settle_as_a_whole_layout() {
    for slices in [100, 0] {
        let Some(mut s) = super::layout_ids::fixture() else { return };
        s.set_layout_ahead(Some(4));
        settle(&mut s);
        view_on(&mut s, 299);
        super::layout_ids::caret_on(&mut s, 299);
        settle(&mut s);
        let before = s.layout().pages.len();
        let mut left = 0;
        for k in ["\n", "\n", "x", "\n", "\u{8}", "\n", "\n", "\u{8}", "\u{8}", "\n", "\n", "\n", "\u{8}", "\n"] {
            key(&mut s, k);
            let l = s.layout();
            left += usize::from(!l.settled());
            if slices < 100 {
                let w = whole(&s);
                let at = s.sel.focus.clone();
                assert_eq!(l.caret(&at), w.caret(&at), "the caret after {k:?}, {slices} slices between");
                let n = l.pages.len();
                if !l.settled() {
                    let last = l.hit(n - 1, l.pages[n - 1].w / 2.0, l.pages[n - 1].h / 3.0, ew_doc::StoryRef::Body).expect("text on the last page laid out");
                    assert_eq!(l.caret(&last), w.caret(&last), "a paragraph on page {n} after {k:?}, {slices} slices between");
                }
            }
            drop(l);
            between(&mut s, slices);
        }
        let l = settle(&mut s);
        // With the system's fonts the pagination differs, and the Enters may move no page or come back at once: the layouts
        // are compared all the same, and these hold where EW_FIXTURE_REQUIRED=1 (the worker's bundled fonts alone).
        if std::env::var("EW_FIXTURE_REQUIRED").as_deref() == Ok("1") {
            assert!(left > 0, "no key left the rest to the slices");
            assert_ne!(l.pages.len(), before, "the Enters moved no page");
        }
        let w = whole(&s);
        assert_eq!(l.pages.len(), w.pages.len(), "the page count, {slices} slices between");
        let sig = |p: &ew_doc_layout::Page| {
            let head: Vec<String> = p.header.iter().map(|it| format!("{it:?}")).collect();
            format!("{}\nheader\n{}", page_sig(p), head.join("\n"))
        };
        for (i, (a, b)) in l.pages.iter().zip(&w.pages).enumerate() {
            assert_eq!(sig(a), sig(b), "page {i} differs from a whole layout, {slices} slices between");
        }
    }
}

/// An Enter on page 300 with the view there comes back before the rest is laid out. No old page shows meanwhile: the layout
/// holds only the pages laid out, and names every page from the edited one to the old last changed, so a view repaints
/// them (a tile of a page not laid out yet paints nothing). The caret and a paragraph on a page laid out since are where a
/// whole layout puts them, and a paragraph past those pages has no caret. Each slice after names the pages it lays out.
#[test]
fn a_key_that_pauses_shows_no_old_page() {
    let Some(mut s) = super::layout_ids::fixture() else { return };
    s.set_layout_ahead(Some(4));
    settle(&mut s);
    view_on(&mut s, 299);
    super::layout_ids::caret_on(&mut s, 299);
    let l = settle(&mut s);
    let old = l.pages.len();
    let far = l.hit(399, l.pages[399].w / 2.0, l.pages[399].h / 2.0, ew_doc::StoryRef::Body).expect("text on page 400");
    drop(l);
    s.take_layout_change();
    key(&mut s, "\n");
    let l = s.layout();
    if l.settled() {
        // With the system's fonts the Enter may come back at once (see the test above).
        assert!(std::env::var("EW_FIXTURE_REQUIRED").as_deref() != Ok("1"), "the Enter came back before the rest was laid out");
        return;
    }
    let changed = s.take_layout_change().expect("the Enter changed pages");
    assert!(changed.start <= 299 && changed.end >= old, "the pages named changed, {changed:?}, of {old}");
    let laid = l.pages.len();
    assert!((301..=305).contains(&laid), "the layout holds {laid} pages");
    let w = whole(&s);
    let at = s.sel.focus.clone();
    assert_eq!(l.caret(&at), w.caret(&at), "the caret after the Enter");
    let next = l.hit(laid - 1, l.pages[laid - 1].w / 2.0, l.pages[laid - 1].h / 3.0, ew_doc::StoryRef::Body).expect("text on the last page laid out");
    assert_eq!(l.caret(&next), w.caret(&next), "a paragraph on page {laid}");
    assert_eq!(l.caret(&far), None, "a paragraph past the pages laid out");
    let mut l = l;
    let mut slices = 0;
    while !l.settled() {
        assert!(slices < 10_000, "the layout did not settle");
        let n = l.pages.len();
        drop(l);
        l = s.advance_layout(0.5);
        let c = s.take_layout_change();
        if l.pages.len() > n {
            let c = c.expect("a slice that laid pages out names them");
            assert!(c.start <= n && c.end >= l.pages.len(), "a slice from {n} to {} pages named {c:?}", l.pages.len());
        }
        slices += 1;
    }
    assert_eq!(l.caret(&far), w.caret(&far), "the paragraph on page 400 once settled");
    assert_eq!(l.caret(&next), w.caret(&next), "the paragraph on page {laid} once settled");
}
