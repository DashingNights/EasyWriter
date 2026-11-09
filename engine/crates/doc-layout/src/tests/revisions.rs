//! engine-agent-latency (docs/plans/word/briefs/engine-agent-latency.md): a tracked change that adds a revision record (each
//! assistant's edit does, and so does the user's tracked key in a new second) is laid out again from its own page, as an
//! untracked one is, and comes out as a whole layout does. A record the text already refers to that changes (a deletion
//! turned into a move) can change every page that shows it, so that lays the whole document out again.
use super::*;
use ew_doc::props::CharProps;
use ew_doc::{Pos, Revision, RevisionKind};

/// 150 paragraphs of two or three lines, the 10th with an insertion tracked as record 0.
fn tracked() -> Document {
    let words = "with words enough to wrap the line ".repeat(8);
    let mut d = Document::from_text(&(0..150).map(|i| format!("Paragraph {i} {words}")).collect::<Vec<_>>().join("\n"));
    d.revisions.push(Revision::new(RevisionKind::Insert, "Kelvin", ""));
    d.insert_text(&Pos::body(10, 0), "typed ", &CharProps { ins: Some(0), ..Default::default() }).unwrap();
    d
}

/// Each page's items as the incremental tests compare them: a paragraph's lines by their breaks and place.
fn pages(l: &DocLayout) -> Vec<String> {
    l.pages
        .iter()
        .map(|p| {
            p.items
                .iter()
                .map(|it| match it {
                    Placed::Lines { story, path, para, l0, l1, x, y, .. } => {
                        format!("{story:?} {path:?} {l0}..{l1} at {x},{y} {:?}", para.lines.get(*l0..*l1))
                    }
                    it => format!("{it:?}"),
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect()
}

/// Lays `after` out again from `before`'s layout: that layout and the pages laid out again. Adding a word to the custom
/// dictionaries (a global other tests in this binary change) lays every document out again, so a try that a generation went
/// by in is made again, and the caller's page count is checked every time.
fn relaid(before: &Document, after: &Document, opts: &LayoutOptions) -> (DocLayout, std::ops::Range<usize>, LayoutCache) {
    for _ in 0..50 {
        let g = ew_proof::dictionary_generation();
        let mut cache = LayoutCache::new();
        let prev = layout(before, &mut cache, opts);
        let (l, changed) = relayout(after, &mut cache, opts, prev);
        if g == ew_proof::dictionary_generation() {
            return (l, changed, cache);
        }
    }
    panic!("the custom dictionaries changed during each of 50 layouts");
}

/// An assistant's edit at paragraph 100: a record of its own, which only that paragraph's new text refers to.
fn assistant_edit(d: &Document) -> Document {
    let mut d = d.clone();
    d.revisions.push(Revision::new(RevisionKind::Insert, "Assistant", ""));
    d.insert_text(&Pos::body(100, 0), "q", &CharProps { ins: Some(1), ..Default::default() }).unwrap();
    d
}

#[test]
fn a_new_revision_record_lays_out_only_the_pages_its_change_is_on() {
    let d0 = tracked();
    let mut d = assistant_edit(&d0);
    let opts = LayoutOptions::default();
    let (l, changed, mut cache) = relaid(&d0, &d, &opts);
    let n = l.pages.len();
    assert!(n >= 8, "{n} pages");
    assert!(changed.start > 0 && changed.len() <= 2, "pages {changed:?} of {n} laid out again");
    assert_eq!(pages(&l), pages(&layout(&d, &mut LayoutCache::new(), &opts)), "as a whole layout");

    // Record 0, which paragraph 10's text refers to, becomes one end of a move: that text may draw differently wherever it is.
    d.revisions[0].move_name = Some("move1".into());
    let (l, changed) = relayout(&d, &mut cache, &opts, l);
    assert_eq!(changed, 0..l.pages.len(), "a changed record lays everything out again");
}

/// Undo of an assistant's edit takes its record away with the text that referred to it (the document before the edit comes
/// back), so it is laid out from that page too.
#[test]
fn records_taken_away_with_their_text_lay_out_only_that_page() {
    let d0 = tracked();
    let d1 = assistant_edit(&d0);
    let opts = LayoutOptions::default();
    let (l, changed, _) = relaid(&d1, &d0, &opts);
    let n = l.pages.len();
    assert!(changed.start > 0 && changed.len() <= 2, "pages {changed:?} of {n} laid out again");
    assert_eq!(pages(&l), pages(&layout(&d0, &mut LayoutCache::new(), &opts)), "as a whole layout");
}
