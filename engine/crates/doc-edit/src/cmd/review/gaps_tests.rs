//! engine-gaps-review (docs/plans/engine/stage2b.md): collapsible headings in the page views (G19), Specific People (G25),
//! revision balloons (G43), Viewing mode and Mark as Final (G34, G32), each exception's editor, formatted comments (G55)
//! and the inspector's collapsed headings.

use serde_json::{Value, json};
use ew_doc::{Document, Pos, StoryRef};
use ew_doc_layout::display::{DisplayOptions, Draw, page_display};

use crate::{Selection, Session};

fn run(s: &mut Session, id: &str, v: Value) -> Value {
    s.run(id, &v).unwrap_or_else(|e| panic!("{id}: {e:?}"))
}

/// The body blocks the first page lays out.
fn laid_out(s: &mut Session) -> Vec<u32> {
    let l = s.layout();
    let mut v: Vec<u32> = l.pages[0]
        .items
        .iter()
        .filter_map(|it| match it {
            ew_doc_layout::Placed::Lines { story: StoryRef::Body, path, .. } => l.ids.block(*path.0.first()?).map(|b| b as u32),
            _ => None,
        })
        .collect();
    v.dedup();
    v
}

/// "One / a / Two / b": Heading 1 at blocks 0 and 2.
fn headings() -> Session {
    let mut s = Session::new(Document::new());
    s.view.proofing = false;
    run(&mut s, "document.setText", json!({"text": "One\na\nTwo\nb"}));
    for i in [0, 2] {
        s.sel = Selection::caret(Pos::body(i, 0));
        run(&mut s, "para.style", json!({"style": "Heading1"}));
    }
    s
}

#[test]
fn headings_fold_in_the_page_view_and_open_again() {
    let mut s = headings();
    assert_eq!(laid_out(&mut s), vec![0, 1, 2, 3]);
    let rev = s.rev();
    s.sel = Selection::caret(Pos::body(1, 0));
    let r = run(&mut s, "heading.collapse", json!({"op": "collapse"}));
    assert_eq!(r["folded"].as_array().map(Vec::len), Some(1));
    assert_eq!(laid_out(&mut s), vec![0, 2, 3], "what is under the first heading is hidden");
    assert_eq!(s.sel.focus, Pos::body(0, 3), "a caret the fold hides goes to the heading's end");
    let list = run(&mut s, "nav.headings", json!({}));
    assert_eq!(list.as_array().map(Vec::len), Some(2));
    let only = run(&mut s, "nav.headings", json!({"folded": true}));
    assert_eq!(only.as_array().map(Vec::len), Some(1));
    assert_eq!(only[0]["id"], list[0]["id"]);
    assert_eq!((list[0]["folded"].as_bool(), list[1]["folded"].as_bool()), (Some(true), Some(false)));
    assert_eq!(list[0]["text"], "One");
    // Toggle by stable id opens it; Collapse All folds both, Expand All opens both.
    let id = list[0]["id"].as_u64().unwrap();
    run(&mut s, "heading.collapse", json!({"id": id}));
    assert_eq!(laid_out(&mut s), vec![0, 1, 2, 3]);
    run(&mut s, "heading.collapse", json!({"op": "collapseAll"}));
    assert_eq!(laid_out(&mut s), vec![0, 2]);
    // Find into folded text opens the heading over it.
    s.sel = Selection::caret(Pos::body(0, 0));
    run(&mut s, "edit.find", json!({"text": "b"}));
    assert_eq!(laid_out(&mut s), vec![0, 2, 3]);
    run(&mut s, "heading.collapse", json!({"op": "expandAll"}));
    assert_eq!(laid_out(&mut s), vec![0, 1, 2, 3]);
    assert!(s.view.outline.folds.is_empty(), "headings back as their default leave nothing recorded");
    // The folds are view state: the document is unchanged.
    assert_eq!(s.rev(), rev);
}

#[test]
fn a_heading_collapsed_by_default_folds_until_the_reader_opens_it() {
    let mut s = headings();
    s.sel = Selection::caret(Pos::body(2, 0));
    run(&mut s, "outline.collapsedByDefault", json!({"value": true}));
    assert_eq!(laid_out(&mut s), vec![0, 1, 2]);
    let list = run(&mut s, "nav.headings", json!({}));
    assert_eq!((list[1]["folded"].as_bool(), list[1]["byDefault"].as_bool()), (Some(true), Some(true)));
    run(&mut s, "heading.collapse", json!({"op": "expand"}));
    assert_eq!(laid_out(&mut s), vec![0, 1, 2, 3]);
    // Typing elsewhere keeps the heading open: the fold follows its stable id.
    s.sel = Selection::caret(Pos::body(0, 0));
    run(&mut s, "text.insert", json!({"text": "x"}));
    assert_eq!(laid_out(&mut s), vec![0, 1, 2, 3]);
    assert!(s.run("heading.collapse", &json!({"op": "nonsense"})).is_err());
}

/// engine-session-release: an assistant's quiet session moves its caret between edits (select.at), and the check for a caret in
/// folded text laid the whole document out each time, so the open draft's keys waited behind it in the one engine worker.
#[test]
fn a_caret_move_lays_nothing_out_and_still_opens_the_heading_over_it() {
    let mut s = headings();
    s.sel = Selection::caret(Pos::body(2, 0));
    run(&mut s, "outline.collapsedByDefault", json!({"value": true}));
    s.sel = Selection::caret(Pos::body(0, 0));
    run(&mut s, "text.insert", json!({"text": "x"}));
    s.take_layout_change();
    run(&mut s, "caret.docStart", json!({}));
    assert_eq!(s.take_layout_change(), None, "a caret move outside the fold lays nothing out");
    run(&mut s, "caret.docEnd", json!({}));
    assert_eq!(s.take_layout_change(), None, "nor does one into it");
    assert_eq!(laid_out(&mut s), vec![0, 1, 2, 3], "the caret moved into folded text opens the heading over it");
}

fn glyph_text(s: &mut Session) -> String {
    let l = s.layout();
    let opts = DisplayOptions { revisions: s.prefs.markup.clone(), ..Default::default() };
    page_display(&s.doc, &l.pages[0], &opts).iter().filter_map(|x| if let Draw::Glyphs { text, .. } = x { Some(text.clone()) } else { None }).collect()
}

/// "keep anna bob": Ana deletes "anna", Bob deletes "bob".
fn two_reviewers() -> Session {
    let mut s = Session::new(Document::new());
    s.view.proofing = false;
    run(&mut s, "document.setText", json!({"text": "keep anna bob"}));
    run(&mut s, "review.trackChanges", json!({"value": true}));
    for (author, a, b) in [("Ana", 5, 9), ("Bob", 10, 13)] {
        s.author = author.into();
        run(&mut s, "select.range", json!({"anchor": {"block": 0, "off": a}, "focus": {"block": 0, "off": b}}));
        run(&mut s, "text.delete", json!({}));
    }
    s
}

#[test]
fn specific_people_hides_a_reviewers_changes_and_all_shown_leaves_them() {
    let mut s = two_reviewers();
    assert!(glyph_text(&mut s).contains("bob"));
    let opts = run(&mut s, "review.trackingOptions", json!({"people": ["Ana"]}));
    assert_eq!(opts["people"], json!(["Ana"]));
    let t = glyph_text(&mut s);
    assert!(t.contains("anna") && !t.contains("bob"), "Bob's deletion leaves the text: {t:?}");
    run(&mut s, "review.acceptAll", json!({"shown": true}));
    assert_eq!(s.doc.plain_text(StoryRef::Body).trim_end(), "keep  bob", "only Ana's change was accepted");
    run(&mut s, "review.trackingOptions", json!({"people": null}));
    assert!(glyph_text(&mut s).contains("bob"));
}

/// The paragraph marks of the body's top-level paragraphs that carry a tracked deletion.
fn deleted_marks(s: &Session) -> usize {
    s.doc.body.iter().filter(|b| matches!(&***b, ew_doc::Block::Para(p) if p.mark.del.is_some())).count()
}

/// The row formatting changes in the body's tables.
fn row_changes(s: &Session) -> usize {
    s.doc
        .body
        .iter()
        .filter_map(|b| if let ew_doc::Block::Table(t) = &**b { Some(t.rows.iter().filter(|r| r.props.fmt_change.is_some()).count()) } else { None })
        .sum()
}

#[test]
fn all_shown_resolves_every_kind_by_the_shown_reviewers_only() {
    // Ana changes a table row's height; Bob deletes the paragraph mark between "keep" and "merge".
    let setup = || {
        let mut s = Session::new(Document::new());
        s.view.proofing = false;
        run(&mut s, "insert.table", json!({"rows": 2, "cols": 2}));
        run(&mut s, "caret.docEnd", json!({}));
        run(&mut s, "text.insert", json!({"text": "keep"}));
        run(&mut s, "text.newParagraph", json!({}));
        run(&mut s, "text.insert", json!({"text": "merge"}));
        run(&mut s, "review.trackChanges", json!({"value": true}));
        s.author = "Ana".into();
        run(&mut s, "caret.docStart", json!({}));
        run(&mut s, "table.properties", json!({"rowHeight": 40}));
        s.author = "Bob".into();
        let keep = s.doc.body.iter().position(|b| matches!(&**b, ew_doc::Block::Para(p) if p.text.starts_with("Keep"))).unwrap();
        run(&mut s, "select.range", json!({"anchor": {"block": keep, "off": 4}, "focus": {"block": keep + 1, "off": 0}}));
        run(&mut s, "text.delete", json!({}));
        assert_eq!((row_changes(&s), deleted_marks(&s)), (1, 1), "the setup tracks both changes");
        s
    };
    let mut s = setup();
    run(&mut s, "review.trackingOptions", json!({"people": ["Ana"]}));
    run(&mut s, "review.acceptAll", json!({"shown": true}));
    assert_eq!(row_changes(&s), 0, "Ana's row change is accepted");
    assert_eq!(deleted_marks(&s), 1, "Bob's hidden paragraph-mark deletion stays, so the paragraphs stay apart");
    // A list that names every reviewer hides nobody: everything goes, and the revision list with it.
    let mut s = setup();
    run(&mut s, "review.trackingOptions", json!({"people": ["Ana", "Bob"]}));
    run(&mut s, "review.rejectAll", json!({"shown": true}));
    assert_eq!((row_changes(&s), deleted_marks(&s), s.doc.revisions.len()), (0, 0, 0));
}

#[test]
fn display_for_review_draws_simple_markup_and_the_original_apart() {
    let mut s = Session::new(Document::new());
    s.view.proofing = false;
    run(&mut s, "document.setText", json!({"text": "keep old"}));
    run(&mut s, "review.trackChanges", json!({"value": true}));
    run(&mut s, "select.range", json!({"anchor": {"block": 0, "off": 5}, "focus": {"block": 0, "off": 8}}));
    run(&mut s, "text.insert", json!({"text": "new"}));
    // What the canvas draws: the page's glyphs and whether a red change bar shows.
    let page = |s: &mut Session| {
        let l = s.layout();
        let d = page_display(&s.doc, &l.pages[0], &crate::cmd::view::display_options(s));
        let text: String = d.iter().filter_map(|x| if let Draw::Glyphs { text, .. } = x { Some(text.clone()) } else { None }).collect();
        let bar = d.iter().any(|x| matches!(x, Draw::Line { color, .. } if *color == ew_doc_layout::display::SIMPLE_BAR));
        (text, bar)
    };
    for (value, has, lacks, bar) in
        [("allMarkup", "newold", "", false), ("simpleMarkup", "new", "old", true), ("noMarkup", "new", "old", false), ("original", "old", "new", false)]
    {
        run(&mut s, "review.markup", json!({"value": value}));
        let (text, drawn) = page(&mut s);
        assert!(text.contains(has) && (lacks.is_empty() || !text.contains(lacks)), "{value}: {text:?}");
        assert_eq!(drawn, bar, "{value}: the red bar");
        assert_eq!(run(&mut s, "view.state", json!({}))["displayForReview"], value);
    }
    assert!(s.run("review.markup", &json!({"value": "nonsense"})).is_err());
}

#[test]
fn original_draws_a_run_in_its_formatting_before_the_change() {
    let mut s = Session::new(Document::new());
    s.view.proofing = false;
    run(&mut s, "document.setText", json!({"text": "plain"}));
    run(&mut s, "review.trackChanges", json!({"value": true}));
    run(&mut s, "select.range", json!({"anchor": {"block": 0, "off": 0}, "focus": {"block": 0, "off": 5}}));
    run(&mut s, "format.bold", json!({"value": true}));
    let bold = |s: &mut Session| {
        let l = s.layout();
        l.pages[0].items.iter().any(|it| matches!(it, ew_doc_layout::Placed::Lines { para, .. } if para.styles.iter().any(|st| st.rc.bold)))
    };
    run(&mut s, "review.markup", json!({"value": "allMarkup"}));
    assert!(bold(&mut s), "the change shows in All Markup");
    run(&mut s, "review.markup", json!({"value": "original"}));
    assert!(!bold(&mut s), "Original draws the run as it was");
}

#[test]
fn simple_markup_bars_a_line_whose_only_change_is_a_deletion() {
    let mut s = Session::new(Document::new());
    s.view.proofing = false;
    run(&mut s, "document.setText", json!({"text": "keep old"}));
    run(&mut s, "review.trackChanges", json!({"value": true}));
    run(&mut s, "select.range", json!({"anchor": {"block": 0, "off": 4}, "focus": {"block": 0, "off": 8}}));
    run(&mut s, "text.delete", json!({}));
    run(&mut s, "review.markup", json!({"value": "simpleMarkup"}));
    let l = s.layout();
    let d = page_display(&s.doc, &l.pages[0], &crate::cmd::view::display_options(&s));
    let text: String = d.iter().filter_map(|x| if let Draw::Glyphs { text, .. } = x { Some(text.clone()) } else { None }).collect();
    assert!(!text.contains("old"), "the deletion is left out: {text:?}");
    assert!(d.iter().any(|x| matches!(x, Draw::Line { color, .. } if *color == ew_doc_layout::display::SIMPLE_BAR)), "the red bar");
}

#[test]
fn balloons_list_deletions_in_revisions_mode_by_the_people_shown() {
    let mut s = two_reviewers();
    assert_eq!(run(&mut s, "review.balloons", json!({})), json!([]), "inline by default for deletions");
    run(&mut s, "review.trackingOptions", json!({"balloons": "revisions"}));
    let b = run(&mut s, "review.balloons", json!({}));
    let who: Vec<&str> = b.as_array().unwrap().iter().filter_map(|x| x["author"].as_str()).collect();
    assert_eq!(who, vec!["Ana", "Bob"]);
    assert_eq!((b[0]["kind"].as_str(), b[0]["text"].as_str()), (Some("delete"), Some("anna")));
    run(&mut s, "review.trackingOptions", json!({"people": ["Bob"]}));
    let b = run(&mut s, "review.balloons", json!({}));
    assert_eq!(b.as_array().map(Vec::len), Some(1));
    assert_eq!(b[0]["author"], "Bob");
}

#[test]
fn viewing_mode_and_mark_as_final_refuse_edits() {
    let mut s = Session::new(Document::new());
    run(&mut s, "document.setText", json!({"text": "hello"}));
    run(&mut s, "view.readOnly", json!({"value": true}));
    assert!(s.run("text.insert", &json!({"text": "x"})).is_err());
    assert!(s.why_disabled("text.insert").is_some(), "the ribbon greys edits out");
    assert!(s.run("caret.docEnd", &json!({})).is_ok(), "moving around still works");
    run(&mut s, "view.readOnly", json!({"value": false}));
    run(&mut s, "text.insert", json!({"text": "x"}));

    run(&mut s, "file.markAsFinal", json!({}));
    let info = run(&mut s, "file.info", json!({}));
    assert_eq!(info["final"], true);
    assert!(s.run("text.insert", &json!({"text": "y"})).is_err());
    assert_eq!(s.doc.custom_prop("_MarkAsFinal"), Some("true"));
    run(&mut s, "file.markAsFinal", json!({"value": false}));
    run(&mut s, "text.insert", json!({"text": "y"}));
    assert_eq!(run(&mut s, "file.info", json!({}))["final"], false);

    run(&mut s, "review.restrict", json!({"mode": "trackedChanges", "password": "pw"}));
    let info = run(&mut s, "file.info", json!({}));
    assert_eq!((info["trackingLocked"].as_bool(), info["lockPassword"].as_bool()), (Some(true), Some(true)));
}

#[test]
fn restrict_editing_reports_each_exceptions_editor() {
    let mut s = Session::new(Document::new());
    run(&mut s, "document.setText", json!({"text": "open text"}));
    run(&mut s, "select.range", json!({"anchor": {"block": 0, "off": 0}, "focus": {"block": 0, "off": 4}}));
    let st = run(&mut s, "review.restrict", json!({"exception": "add"}));
    assert_eq!(st["ranges"].as_array().map(Vec::len), Some(1));
    assert_eq!((st["ranges"][0]["editor"].as_str(), st["ranges"][0]["mine"].as_bool()), (Some("everyone"), Some(true)));
}

#[test]
fn comments_keep_their_formatting() {
    let mut s = Session::new(Document::new());
    run(&mut s, "document.setText", json!({"text": "word"}));
    let paras = json!([[{"text": "bold", "b": true}, {"text": " and "}, {"text": "it", "i": true, "u": true}], [{"text": "two"}]]);
    let id = run(&mut s, "review.newComment", json!({"paras": paras}))["id"].as_u64().unwrap();
    let list = run(&mut s, "review.comments", json!({}));
    assert_eq!(list[0]["paras"], paras);
    assert_eq!(list[0]["text"].as_str().map(|t| t.replace('\r', "")), Some("bold and it\ntwo".into()));
    run(&mut s, "review.editComment", json!({"id": id, "paras": [[{"text": "now ", "s": true}, {"text": "plain"}]]}));
    assert_eq!(run(&mut s, "review.comments", json!({}))[0]["paras"], json!([[{"text": "now ", "s": true}, {"text": "plain"}]]));
    run(&mut s, "review.reply", json!({"id": id, "paras": [[{"text": "yes", "b": true}]]}));
    assert_eq!(run(&mut s, "review.comments", json!({}))[1]["paras"], json!([[{"text": "yes", "b": true}]]));
    // Plain text still works.
    run(&mut s, "review.editComment", json!({"id": id, "text": "plain"}));
    assert_eq!(run(&mut s, "review.comments", json!({}))[0]["paras"], json!([[{"text": "plain"}]]));
}

#[test]
fn the_inspector_finds_and_clears_collapsed_headings() {
    let mut s = headings();
    s.sel = Selection::caret(Pos::body(0, 0));
    run(&mut s, "outline.collapsedByDefault", json!({"value": true}));
    assert_eq!(run(&mut s, "file.inspect", json!({}))["found"]["collapsed"], 1);
    run(&mut s, "file.inspect", json!({"remove": ["collapsed"]}));
    assert_eq!(run(&mut s, "file.inspect", json!({}))["found"]["collapsed"], 0);
}

#[test]
fn find_gives_each_match_in_its_words_for_the_results_tab() {
    let mut s = Session::new(Document::new());
    run(&mut s, "document.setText", json!({"text": "The quick brown fox jumps over the lazy dog"}));
    let r = run(&mut s, "edit.find", json!({"text": "fox", "snippets": true}));
    assert_eq!(r["matches"][0]["snippet"], json!({"before": "The quick brown ", "term": "fox", "after": " jumps over the lazy dog"}));
    let r = run(&mut s, "edit.find", json!({"text": "fox"}));
    assert!(r["matches"][0].get("snippet").is_none(), "only when asked");
}

/// stage2b.md rule 6, measured on the Word fixture (ignored: it prints timings): what the package adds to a keystroke's state
/// call (the read-only check on every edit id, Mark as Final's state) and to its layout (the folds), and the reads after typing
/// pauses (the triangles' folded headings, the balloons).
///   cargo test -p ew-doc-edit --release fixture_costs -- --ignored --nocapture
#[test]
#[ignore]
fn fixture_costs() {
    use std::time::Instant;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.smoke-data/word/fixture/all-features.docx");
    let Ok(bytes) = crate::io::read_file(&path.to_string_lossy()) else { return };
    let mut s = Session::new(crate::io::open_bytes("document.docx", &bytes).unwrap());
    s.view.proofing = false;
    let _ = s.layout();
    let ids: Vec<&str> = s.registry.all().iter().filter(|c| c.mutates).map(|c| c.id).take(200).collect();
    let time = |s: &mut Session, f: &dyn Fn(&mut Session)| {
        let t = Instant::now();
        for _ in 0..20 {
            f(s);
        }
        t.elapsed().as_secs_f64() * 1000.0 / 20.0
    };
    let why = time(&mut s, &|s| {
        for id in &ids {
            let _ = s.why_disabled(id);
        }
    });
    let fin = time(&mut s, &|s| {
        let st = s.registry.get("file.markAsFinal").and_then(|c| c.state).unwrap();
        let _ = st(s);
    });
    s.sel = Selection::caret(Pos::body(5, 0));
    let key = time(&mut s, &|s| {
        s.run("text.insert", &json!({"text": "x"})).unwrap();
        let _ = s.layout();
    });
    let id = run(&mut s, "nav.headings", json!({}))[0]["id"].clone();
    run(&mut s, "heading.collapse", json!({"id": id, "op": "collapse"}));
    let _ = s.layout();
    let key_folded = time(&mut s, &|s| {
        s.run("text.insert", &json!({"text": "x"})).unwrap();
        let _ = s.layout();
    });
    let folds = time(&mut s, &|s| {
        let _ = s.run("nav.headings", &json!({"folded": true}));
    });
    let balloons = time(&mut s, &|s| {
        let _ = s.run("review.balloons", &json!({}));
    });
    println!(
        "fixture: why_disabled for {} edit ids {why:.3} ms; file.markAsFinal state {fin:.4} ms; a keystroke with its layout {key:.2} ms, with a folded heading {key_folded:.2} ms; nav.headings folded {folds:.2} ms; review.balloons {balloons:.2} ms",
        ids.len()
    );
}
