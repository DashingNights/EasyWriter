//! EasyWriter engine-fixes-2-layout (docs/plans/word/briefs/engine-fixes-2-layout.md): wave E's loose ends in editing.
use serde_json::json;
use ew_doc::{CharProps, Document, InlineObject, Pos};

use crate::{Selection, Session};

/// "one Cover" with a bookmark around "Cover" (its start before the C, its end at the paragraph's end, as the Word fixture's
/// _Toc bookmarks are), then "next"; laid out once and tidied by a first key, so later keys may take the bounded path.
fn bookmarked() -> Session {
    let mut d = Document::from_text("one Cover\nnext");
    d.insert_object(&Pos::body(0, 9), InlineObject::BookmarkEnd { name: "_Toc1".into() }, &CharProps::default()).unwrap();
    d.insert_object(&Pos::body(0, 4), InlineObject::BookmarkStart { name: "_Toc1".into() }, &CharProps::default()).unwrap();
    let mut s = Session::new(d);
    s.sel = Selection::caret(Pos::body(1, 4));
    s.run("text.insert", &json!({"text": "!", "raw": true})).unwrap();
    s
}

fn marks(s: &Session, block: usize) -> Vec<&InlineObject> {
    s.doc.para(ew_doc::StoryRef::Body, &ew_doc::Path::top(block)).map(|p| p.objects.iter().collect()).unwrap_or_default()
}

/// engine-keys' Delete keys 1 and 30 on the fixture's page 1: Delete before a bookmark's start takes the next character, and
/// Delete before its end at the paragraph's end joins the next paragraph, as Word does; the bookmark stays whole. Backspace
/// after a bookmark's end takes the character before it. Each key is a plain deletion, so it takes the bounded edit path.
/// The engine took the invisible mark for a character: the key did nothing visible, broke the bookmark and, holding an
/// object, took the whole-document path.
#[test]
fn delete_and_backspace_step_over_bookmark_marks() {
    let mut s = bookmarked();
    let text = |s: &Session, i: usize| s.doc.body.get(i).and_then(|b| b.as_para()).map(|p| p.plain_text()).unwrap_or_default();
    let both = [InlineObject::BookmarkStart { name: "_Toc1".into() }, InlineObject::BookmarkEnd { name: "_Toc1".into() }];

    s.sel = Selection::caret(Pos::body(0, 4));
    let light = s.light_edits();
    s.run("text.delete", &json!({})).unwrap();
    assert_eq!((text(&s, 0), marks(&s, 0)), ("one over".to_string(), both.iter().collect()), "Delete took the C, not the mark");
    assert_eq!(s.light_edits(), light + 1, "a bounded edit");

    // The caret before the bookmark's end, at the end of the paragraph's text.
    let end = s.doc.para_at(&Pos::body(0, 0)).unwrap().len() - ew_doc::para::OBJ.len_utf8();
    s.sel = Selection::caret(Pos::body(0, end));
    s.run("text.delete", &json!({})).unwrap();
    assert_eq!((text(&s, 0), marks(&s, 0)), ("one overnext!".to_string(), both.iter().collect()), "Delete joined the next paragraph");
    assert_eq!(s.light_edits(), light + 2, "a bounded edit");

    // Backspace right after the bookmark's end.
    let after = s.doc.para_at(&Pos::body(0, 0)).unwrap().text.find("next").unwrap();
    s.sel = Selection::caret(Pos::body(0, after));
    s.run("text.backspace", &json!({})).unwrap();
    assert_eq!((text(&s, 0), marks(&s, 0)), ("one ovenext!".to_string(), both.iter().collect()), "Backspace took the r, not the mark");
    assert_eq!(s.light_edits(), light + 3, "a bounded edit");
}

/// Whether `b` refers to a revision record anywhere inside it: a run, mark, paragraph, section, table, row or cell change.
fn holds_revision(b: &ew_doc::Block) -> bool {
    match b {
        ew_doc::Block::Para(p) => !crate::cmd::agents::revisions_of(p).is_empty(),
        ew_doc::Block::Table(t) => {
            t.props.fmt_change.is_some()
                || t.rows.iter().any(|r| {
                    r.props.fmt_change.is_some() || r.cells.iter().any(|c| c.props.fmt_change.is_some() || c.blocks.iter().any(|b| holds_revision(b)))
                })
        }
        ew_doc::Block::Container(c) => c.regions().into_iter().any(|(_, list)| list.iter().any(|b| holds_revision(b))),
    }
}

/// A page as the incremental tests compare it: its frame, and each item with a paragraph's lines by their breaks and place.
fn page_sig(p: &ew_doc_layout::Page) -> String {
    let item = |it: &ew_doc_layout::Placed| match it {
        ew_doc_layout::Placed::Lines { story, path, para, l0, l1, x, y, turn } => {
            format!("lines {story:?} {path:?} {l0}..{l1} at {x},{y} {turn:?} h {} {:?}", para.height, para.lines.get(*l0..*l1))
        }
        it => format!("{it:?}"),
    };
    let items = |v: &[ew_doc_layout::Placed]| v.iter().map(item).collect::<Vec<_>>().join("\n");
    format!("{} x {} section {} number {}\n{}\nheader\n{}\nfooter\n{}", p.w, p.h, p.section, p.number, items(&p.items), items(&p.header), items(&p.footer))
}

/// engine-agent-latency's prefix rule lays Accept All and Reject All out from the first page they change, though they empty
/// the revision records. That rests on `resolve_every` rewriting every block that holds a mark: a block left holding one
/// would keep its old layout and refer to a record that is gone. On the Word fixture's tracked changes, after either
/// command no block of the body or of any part refers to a revision, and the layout laid out again is the whole layout.
#[test]
fn accept_and_reject_all_on_the_fixture_lay_out_as_a_whole_layout() {
    use ew_doc_layout::display::{DisplayOptions, page_display};
    let Some(s0) = crate::session::layout_ids::fixture() else { return };
    let stories = |d: &ew_doc::Document| -> Vec<std::sync::Arc<ew_doc::Block>> {
        d.body.iter().chain(d.parts.values().flat_map(|p| p.blocks.iter())).cloned().collect()
    };
    let marked = stories(&s0.doc).iter().filter(|b| holds_revision(b)).count();
    assert!(marked > 10 && !s0.doc.revisions.is_empty(), "the fixture's tracked changes: {marked} blocks");
    for id in ["review.acceptAll", "review.rejectAll"] {
        let mut s = Session::new(s0.doc.clone());
        s.view.proofing = false;
        let pages = s.layout().pages.len();
        s.take_layout_change();
        s.run(id, &json!({})).unwrap();
        assert!(s.doc.revisions.is_empty(), "{id} empties the records");
        let left: Vec<String> = stories(&s.doc).iter().filter(|b| holds_revision(b)).map(|b| format!("{b:?}").chars().take(200).collect()).take(3).collect();
        assert!(left.is_empty(), "{id} left blocks holding a revision: {left:?}");

        let l = s.layout();
        let changed = s.take_layout_change().expect("a layout");
        println!("{id}: pages {changed:?} of {} laid out again (from {pages})", l.pages.len());
        assert!(changed.start > 0, "{id} was laid out from the first page it changes, not whole: {changed:?}");
        let mut w = Session::new(s.doc.clone());
        w.view = s.view.clone();
        w.prefs = s.prefs.clone();
        let w = w.layout();
        assert_eq!(l.pages.len(), w.pages.len(), "{id}: pages, laid out whole");
        for (i, (a, b)) in l.pages.iter().zip(&w.pages).enumerate() {
            let (x, y) = (page_sig(a), page_sig(b));
            let line = x.lines().zip(y.lines()).position(|(m, n)| m != n);
            assert!(x == y, "{id}: page {i} differs at line {line:?}: {:?} / whole {:?}", line.and_then(|k| x.lines().nth(k)), line.and_then(|k| y.lines().nth(k)));
        }
        let opts = DisplayOptions::default();
        for i in changed.start.saturating_sub(1)..(changed.end + 1).min(l.pages.len()) {
            assert!(
                format!("{:?}", page_display(&s.doc, &l.pages[i], &opts)) == format!("{:?}", page_display(&s.doc, &w.pages[i], &opts)),
                "{id}: the display list of page {i} differs from the whole layout's"
            );
        }
    }
}
