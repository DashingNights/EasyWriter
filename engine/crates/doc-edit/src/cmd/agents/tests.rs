//! An assistant's calls (docs/plans/word/briefs/engine-agent-api.md): `Session::run_as`, revision tags, `review.resolve` and
//! the pure reads.
use std::sync::Arc;

use serde_json::{Value, json};
use ew_doc::{Document, InlineObject, RevisionKind, StoryRef};

use super::map_offset;
use crate::{CommandSpec, Registry, Session};

fn session(text: &str) -> Session {
    let mut s = Session::new(Document::from_text(text));
    s.author = "Kelvin".into();
    s.view.proofing = false;
    s
}

fn steps(v: Value) -> Vec<(String, Value)> {
    v.as_array().unwrap().iter().map(|x| (x[0].as_str().unwrap().to_string(), x.get(1).cloned().unwrap_or(json!({})))).collect()
}

fn outline(s: &mut Session) -> Value {
    s.run("document.outline", &json!({})).unwrap()
}

/// Paragraph `i`'s id as document.outline gives it.
fn para(s: &mut Session, i: usize) -> String {
    outline(s)["paragraphs"][i]["para"].as_str().unwrap().to_string()
}

fn changes(s: &mut Session) -> Vec<Value> {
    s.run("review.changes", &json!({})).unwrap().as_array().unwrap().clone()
}

fn text(s: &Session) -> String {
    s.doc.plain_text(StoryRef::Body)
}

/// What a call must leave as it was: the user's author, Track Changes, Track Formatting, overtype and typing over a selection.
fn user(s: &Session) -> (String, bool, bool, bool, bool) {
    (s.author.clone(), s.doc.settings.track_changes, s.prefs.markup.track_formatting, s.prefs.overtype, s.prefs.typing_replaces_selection)
}

#[test]
fn a_call_is_tracked_as_the_assistant_and_the_user_keeps_their_own_settings() {
    let mut s = session("Hello world");
    s.run("caret.docStart", &json!({})).unwrap();
    s.run("text.insert", &json!({"text": "A"})).unwrap();
    s.prefs.markup.track_formatting = false;
    s.prefs.overtype = true;
    s.prefs.typing_replaces_selection = false;
    let was = user(&s);
    let id = para(&mut s, 0);
    let (values, made) =
        s.run_as("Assistant", Some("g1"), &steps(json!([["select.at", {"para": id, "from": 7}], ["text.insert", {"text": "big "}]])), None).unwrap();
    assert_eq!(values.len(), 2);
    assert_eq!(text(&s), "AHello big world", "inserted, not typed over: overtype is off for the call");
    assert_eq!(made.len(), 1);
    let r = &s.doc.revisions[made[0] as usize];
    assert_eq!((r.author.as_str(), r.tag.as_deref(), r.kind), ("Assistant", Some("g1"), RevisionKind::Insert));
    assert_eq!(user(&s), was);
    assert!(s.assistant().is_none());
    // The caret is back after the user's "A", and the user's next key is theirs, untracked.
    assert!(s.sel.is_collapsed() && s.sel.focus.off == 1, "{:?}", s.sel);
    s.prefs.overtype = false;
    s.run("text.insert", &json!({"text": "B"})).unwrap();
    assert_eq!(text(&s), "ABHello big world");
    let ch = changes(&mut s);
    assert_eq!(ch.len(), 1, "{ch:?}");
    assert_eq!((ch[0]["author"].as_str(), ch[0]["tag"].as_str(), ch[0]["text"].as_str()), (Some("Assistant"), Some("g1"), Some("big ")));
    assert_eq!(ch[0]["rev"], json!(made[0]));
}

#[test]
fn a_failed_or_panicking_call_puts_everything_back() {
    let mut specs = crate::cmd::registry().all().to_vec();
    specs.push(CommandSpec::new("test.panic", "Panic", "Test", |s, _| {
        crate::cmd::type_text(s, "half")?;
        panic!("boom")
    }));
    let mut s = Session::with_registry(Document::from_text("Hello"), Arc::new(Registry::new(specs)));
    s.author = "Kelvin".into();
    let was = user(&s);
    for bad in [json!([["text.insert", {"text": "x"}], ["test.panic"]]), json!([["text.insert", {"text": "x"}], ["no.such"]])] {
        let e = s.run_as("Assistant", Some("g"), &steps(bad), None).unwrap_err();
        assert_eq!(e.0, Some(1), "{e:?}");
        assert_eq!(text(&s), "Hello");
        assert!(s.doc.revisions.is_empty());
        assert_eq!(user(&s), was);
        assert!(s.assistant().is_none());
        assert!(!s.can_undo(), "the call left no undo step");
    }
    // The user's own command afterwards is untracked, under their name.
    s.run("text.insert", &json!({"text": "Hi "})).unwrap();
    assert!(changes(&mut s).is_empty());
}

#[test]
fn undo_after_a_call_takes_it_back_whole_and_leaves_tracking_off() {
    let mut s = session("Hello");
    let id = para(&mut s, 0);
    let call = steps(json!([["select.at", {"para": id, "from": 5}], ["text.insert", {"text": " there"}], ["text.insert", {"text": "!"}]]));
    s.run_as("Assistant", None, &call, None).unwrap();
    assert!(!s.doc.settings.track_changes);
    // The user's key after it is an undo step of its own, though the call ended with typing.
    s.run("text.insert", &json!({"text": "?"})).unwrap();
    s.run("edit.undo", &json!({})).unwrap();
    assert_eq!(text(&s), "Hello there!");
    s.run("edit.undo", &json!({})).unwrap();
    assert_eq!(text(&s), "Hello");
    assert!(!s.doc.settings.track_changes, "the undo step holds the user's setting");
    assert!(!s.can_undo(), "one undo step for the call");
    s.run("edit.redo", &json!({})).unwrap();
    assert_eq!(text(&s), "Hello there!");
    assert!(!s.doc.settings.track_changes);
    // With the user's own tracking on, it stays on.
    s.run("review.trackChanges", &json!({"value": true})).unwrap();
    s.run_as("Assistant", None, &steps(json!([["text.insert", {"text": "x"}]])), None).unwrap();
    s.run("edit.undo", &json!({})).unwrap();
    assert!(s.doc.settings.track_changes);
}

#[test]
fn a_protected_document_refuses_the_assistant_as_it_refuses_the_user() {
    let mut s = session("Locked intro.\nFill in here.\nLocked end.");
    s.run("select.text", &json!({"text": "Fill in here."})).unwrap();
    s.run("review.restrict", &json!({"exception": "add"})).unwrap();
    // The exception is the user's own, not everyone's.
    for path in s.doc.para_paths(StoryRef::Body) {
        for o in &mut s.doc.para_mut(StoryRef::Body, &path).unwrap().objects {
            if let InlineObject::PermStart { group, editor, .. } = o {
                *group = String::new();
                *editor = "Kelvin".into();
            }
        }
    }
    s.run("review.restrict", &json!({"mode": "readOnly"})).unwrap();
    let intro = para(&mut s, 0);
    let before = text(&s);
    let outside = steps(json!([["select.at", {"para": intro, "from": 2}], ["text.insert", {"text": "x"}]]));
    assert!(s.run_as("Assistant", None, &outside, None).is_err());
    assert_eq!(text(&s), before);
    // Inside the user's exception the call goes in, tracked: the exceptions are read with the user's author.
    let inside = steps(json!([["select.text", {"text": "here"}], ["text.insert", {"text": "there"}]]));
    let r = s.run_as("Assistant", None, &inside, None);
    assert!(r.is_ok(), "{r:?}");
    assert!(s.doc.final_text(StoryRef::Body).contains("Fill in there."), "{}", s.doc.final_text(StoryRef::Body));
    assert!(changes(&mut s).iter().all(|c| c["author"] == "Assistant"));
    // Someone else at the keyboard has no exception there.
    s.author = "Someone".into();
    assert!(s.run_as("Assistant", None, &steps(json!([["select.text", {"text": "Fill"}], ["text.insert", {"text": "y"}]])), None).is_err());
}

#[test]
fn a_stale_call_and_an_untracked_step_are_refused() {
    let mut s = session("Hello");
    let rev = outline(&mut s)["rev"].as_u64().unwrap();
    s.run("text.insert", &json!({"text": "x"})).unwrap();
    let e = s.run_as("Assistant", None, &steps(json!([["text.insert", {"text": "y"}]])), Some(rev)).unwrap_err();
    assert!(e.1.to_string().contains("stale"), "{e:?}");
    assert_eq!(text(&s), "xHello");
    let rev = outline(&mut s)["rev"].as_u64().unwrap();
    assert!(s.run_as("Assistant", None, &steps(json!([["text.insert", {"text": "y"}]])), Some(rev)).is_ok());
    // An edit tracking cannot record (the whole text replaced) takes the call back.
    let before = (text(&s), s.doc.revisions.len());
    let e = s.run_as("Assistant", None, &steps(json!([["text.insert", {"text": "ok "}], ["document.setText", {"text": "gone"}]])), None).unwrap_err();
    assert_eq!(e.0, Some(1), "{e:?}");
    assert_eq!((text(&s), s.doc.revisions.len()), before);
    // A call stays in its document.
    let home = s.document_id();
    let e = s.run_as("Assistant", None, &steps(json!([["text.insert", {"text": "ok "}], ["file.new"]])), None).unwrap_err();
    assert_eq!((e.0, s.document_id(), text(&s)), (Some(1), home, before.0), "{e:?}");
}

#[test]
fn calls_never_join_each_others_revisions_and_resolve_by_id_takes_one() {
    let mut s = session("one two");
    let id = para(&mut s, 0);
    let (_, a) = s.run_as("Assistant", Some("g"), &steps(json!([["select.at", {"para": &id, "from": 3}], ["text.insert", {"text": " A"}]])), None).unwrap();
    let (_, b) = s.run_as("Assistant", Some("g"), &steps(json!([["select.at", {"para": &id}], ["text.insert", {"text": "B "}]])), None).unwrap();
    assert_eq!(text(&s), "B one A two");
    assert!(a.len() == 1 && b.len() == 1 && a != b, "two calls in the same second, same tag: two revisions ({a:?}, {b:?})");
    s.run("select.at", &json!({"para": &id, "from": 11})).unwrap();
    s.run("review.resolve", &json!({"accept": true, "revs": a})).unwrap();
    let ch = changes(&mut s);
    assert_eq!(ch.len(), 1, "{ch:?}");
    assert_eq!(ch[0]["rev"], json!(b[0]));
    assert_eq!(s.sel.focus.off, 11, "the caret stays");
    // Rejecting by range takes the other out, and the caret moves with the text after it.
    s.run("review.resolve", &json!({"accept": false, "start": ch[0]["start"], "end": ch[0]["end"]})).unwrap();
    assert_eq!(text(&s), "one A two");
    assert!(changes(&mut s).is_empty());
    assert_eq!(s.sel.focus.off, 9);
}

#[test]
fn keep_leaves_the_change_tracked_without_its_group_and_undo_brings_the_group_back() {
    let mut s = session("one two");
    let id = para(&mut s, 0);
    let (_, a) = s.run_as("Assistant", Some("g"), &steps(json!([["select.at", {"para": &id, "from": 3}], ["text.insert", {"text": " A"}]])), None).unwrap();
    s.run("select.at", &json!({"para": &id, "from": 1})).unwrap();
    s.run("review.resolve", &json!({"accept": true, "keep": true, "revs": a})).unwrap();
    let ch = changes(&mut s);
    assert_eq!(ch.len(), 1, "{ch:?}");
    assert_eq!((ch[0]["author"].as_str(), ch[0].get("tag"), ch[0]["rev"].clone()), (Some("Assistant"), None, json!(a[0])));
    assert_eq!((text(&s), s.sel.focus.off), ("one A two".to_string(), 1), "the text and the caret stay");
    s.run("edit.undo", &json!({})).unwrap();
    assert_eq!(changes(&mut s)[0]["tag"], "g");
}

#[test]
fn formatting_is_tracked_for_the_call_whatever_the_users_track_formatting() {
    let mut s = session("Hello world");
    s.prefs.markup.track_formatting = false;
    let id = para(&mut s, 0);
    let (_, made) = s.run_as("Assistant", Some("f"), &steps(json!([["select.at", {"para": id, "from": 0, "to": 5}], ["format.bold", {"value": true}]])), None).unwrap();
    assert_eq!(made.len(), 1);
    let r = &s.doc.revisions[made[0] as usize];
    assert_eq!((r.kind, r.author.as_str(), r.tag.as_deref()), (RevisionKind::Format, "Assistant", Some("f")));
    assert!(!s.prefs.markup.track_formatting);
    let ch = changes(&mut s);
    assert_eq!((ch.len(), ch[0]["kind"].as_str()), (1, Some("format")));
    s.run("review.resolve", &json!({"accept": false, "revs": made})).unwrap();
    assert!(changes(&mut s).is_empty());
    let p = s.doc.para(StoryRef::Body, &ew_doc::Path::top(0)).unwrap();
    assert!(p.runs.iter().all(|r| r.props.bold != Some(true)), "rejected: not bold");
}

#[test]
fn tags_round_trip_in_the_engine_form_and_stay_out_of_docx() {
    let mut s = session("Hello");
    s.run_as("Assistant", Some("group-7"), &steps(json!([["text.insert", {"text": "Hi "}]])), None).unwrap();
    let saved = serde_json::to_string(&s.doc).unwrap();
    assert!(saved.contains(r#""tag":"group-7""#));
    let back: Document = serde_json::from_str(&saved).unwrap();
    assert_eq!(back.revisions[0].tag.as_deref(), Some("group-7"));
    // A version 2 model, written before tags, reads with none.
    let old = saved.replace(r#","tag":"group-7""#, "").replace(&format!(r#""version":{}"#, ew_doc::SCHEMA_VERSION), r#""version":2"#);
    let mut d: Document = serde_json::from_str(&old).unwrap();
    d.upgrade().unwrap();
    assert_eq!((d.revisions[0].tag.as_deref(), d.schema_version), (None, ew_doc::SCHEMA_VERSION));
    // Word has no such attribute: the .docx keeps the revision and leaves the tag out.
    let bytes = crate::io::save_bytes("t.docx", &s.doc).unwrap();
    let d = crate::io::open_bytes("t.docx", &bytes).unwrap();
    assert_eq!((d.revisions.len(), d.revisions[0].author.as_str(), d.revisions[0].tag.as_deref()), (1, "Assistant", None));
}

#[test]
fn the_reads_move_neither_the_selection_nor_find_and_count_utf16() {
    let mut s = session("Find me \u{1F600} here\nand me again");
    s.run("edit.find", &json!({"text": "again"})).unwrap();
    let (sel, query, results) = (s.sel.clone(), s.find.query.clone(), s.find.results.clone());
    let f = s.run("document.find", &json!({"text": "me"})).unwrap();
    assert_eq!(f["count"], 2);
    let h = s.run("document.find", &json!({"text": "here"})).unwrap();
    let m = &h["matches"][0];
    assert_eq!((m["from"].as_u64(), m["to"].as_u64(), m["text"].as_str()), (Some(11), Some(15), Some("here")), "an emoji is two UTF-16 units");
    let o = outline(&mut s);
    assert_eq!(o["paragraphs"].as_array().unwrap().len(), 2);
    assert_eq!(o["paragraphs"][1]["text"], "and me again");
    let html = s.run("document.html", &json!({"para": m["para"]})).unwrap();
    assert!(html["html"].as_str().unwrap().contains("Find me"), "{html}");
    assert_eq!((s.sel.clone(), s.find.query.clone(), s.find.results.clone()), (sel, query, results));
    assert!(s.clipboard.is_none(), "nothing copied");
    // The match's address selects it.
    s.run("select.at", &json!({"para": m["para"], "from": 11, "to": 15})).unwrap();
    assert_eq!(s.selected_text(), "here");
    // A paragraph that went is stale.
    let e = s.run("select.at", &json!({"para": "99999"})).unwrap_err();
    assert!(e.to_string().contains("stale"));
}

#[test]
fn the_outline_gives_levels_and_suggestion_groups() {
    let mut s = session("Title\nBody text");
    s.run("caret.docStart", &json!({})).unwrap();
    s.run("para.style", &json!({"style": "Heading1"})).unwrap();
    let id = para(&mut s, 1);
    s.run_as("Assistant", Some("s1"), &steps(json!([["select.at", {"para": id, "from": 4}], ["text.insert", {"text": "!"}]])), None).unwrap();
    let o = outline(&mut s);
    let ps = o["paragraphs"].as_array().unwrap();
    assert_eq!(ps[0]["level"], 1, "{o}");
    assert!(ps[1].get("level").is_none());
    assert_eq!(ps[1]["tags"], json!(["s1"]));
    assert_eq!(ps[1]["revs"].as_array().unwrap().len(), 1);
}

#[test]
fn offsets_follow_the_text_around_an_edit() {
    // Inserted before: the caret keeps its distance from the end.
    assert_eq!(map_offset("abc def", "abc new def", 5), 9);
    // Inserted after: it stays.
    assert_eq!(map_offset("abc def", "abc def new", 2), 2);
    // Inside a replaced word: the end of the replacement.
    assert_eq!(map_offset("abc def ghi", "abc XYZW ghi", 5), 8);
    // Multi-byte characters stay whole.
    assert_eq!(map_offset("é x", "éé x", 3), 5);
}

/// Each page's items as the incremental tests compare them: a paragraph's lines by their breaks and place.
fn page_sigs(l: &ew_doc_layout::DocLayout) -> Vec<String> {
    use ew_doc_layout::Placed;
    let item = |it: &Placed| match it {
        Placed::Lines { story, path, para, l0, l1, x, y, .. } => format!("{story:?} {path:?} {l0}..{l1} at {x},{y} {:?}", para.lines.get(*l0..*l1)),
        it => format!("{it:?}"),
    };
    l.pages.iter().map(|p| p.items.iter().map(item).collect::<Vec<_>>().join("\n")).collect()
}

/// engine-agent-latency: every assistant's edit adds a revision record, which the layout read as a change outside the body
/// and so laid the whole document out again. Now the edit is laid out from its own pages, as a whole layout lays it out,
/// and the pages it leaves keep their tiles: drawn with the new records (each author's colour by first appearance), they
/// look as they did with the old. Two assistants insert, replace and delete, after the user's own tracked changes.
#[test]
fn assistant_edits_lay_out_as_a_whole_layout_and_leave_the_other_pages_as_drawn() {
    use ew_doc_layout::display::{DisplayOptions, page_display};
    let words = "with words enough to wrap the line ".repeat(5);
    let mut s = session(&(0..120).map(|i| format!("Paragraph {i} {words}")).collect::<Vec<_>>().join("\n"));
    s.run("review.trackChanges", &json!({"value": true})).unwrap();
    for i in [5, 40, 90] {
        let id = para(&mut s, i);
        s.run("select.at", &json!({"para": id, "from": 0})).unwrap();
        s.run("text.insert", &json!({"text": "mine "})).unwrap();
    }
    s.run("review.trackChanges", &json!({"value": false})).unwrap();
    let whole = |s: &Session| {
        let mut f = Session::new(s.doc.clone());
        f.view = s.view.clone();
        f.prefs = s.prefs.clone();
        f.layout()
    };
    // Each page's drawing with All Markup. A layout held here would be copied rather than laid out again, so none is.
    let shown = DisplayOptions { markup: true, ..Default::default() };
    let drawn = |doc: &Document, l: &ew_doc_layout::DocLayout| l.pages.iter().map(|p| format!("{:?}", page_display(doc, p, &shown))).collect::<Vec<_>>();
    // Adding a word to the custom dictionaries (a global other tests change) lays every document out again: the page count is
    // checked only when no generation went by from just before the last layout to just after this one, and most steps must be.
    let generation = ew_proof::dictionary_generation;
    let mut g0 = generation();
    let first = s.layout();
    let mut was = drawn(&s.doc, &first);
    drop(first);
    s.take_layout_change();
    assert!(was.len() >= 6, "{} pages", was.len());
    let mut checked = 0;
    let mut check = |s: &mut Session, what: &str| {
        let g = generation();
        let now = s.layout();
        let changed = s.take_layout_change().unwrap_or(0..0);
        if g0 == generation() {
            checked += 1;
            assert!(changed.len() <= 3, "{what} laid out pages {changed:?} of {}", now.pages.len());
        }
        g0 = g;
        assert_eq!(page_sigs(&now), page_sigs(&whole(s)), "{what} as a whole layout");
        let draws = drawn(&s.doc, &now);
        for p in (0..draws.len().min(was.len())).filter(|p| !changed.contains(p)) {
            assert_eq!(was[p], draws[p], "{what}: page {p}, not laid out again, draws differently");
        }
        was = draws;
    };
    let mut rng = 0x2545_F491_4F6C_DD1D_u64;
    for k in 0..30 {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let id = para(&mut s, (rng % 120) as usize);
        let from = rng % 40;
        let call = match k % 3 {
            0 => json!([["select.at", {"para": id, "from": from}], ["text.insert", {"text": "new words "}]]),
            1 => json!([["select.at", {"para": id, "from": from, "to": from + 6}], ["text.insert", {"text": "other"}]]),
            _ => json!([["select.at", {"para": id, "from": from, "to": from + 9}], ["text.delete"]]),
        };
        let records = s.doc.revisions.len();
        s.run_as(["Assistant", "Second assistant"][k % 2], Some("g"), &steps(call.clone()), None).unwrap();
        assert!(s.doc.revisions.len() > records, "edit {k} ({call}) added a record");
        check(&mut s, &format!("edit {k} ({call})"));
    }
    // Undo takes an edit's record away with its text.
    for k in 0..6 {
        let records = s.doc.revisions.len();
        assert!(s.undo(), "undo {k}");
        assert!(s.doc.revisions.len() < records, "undo {k} took a record away");
        check(&mut s, &format!("undo {k}"));
    }
    assert!(checked >= 18, "the page count was checked after {checked} of 36 steps");
}
