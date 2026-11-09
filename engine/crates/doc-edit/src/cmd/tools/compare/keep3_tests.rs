// engine-compare-keep-3: the cases engine-compare-keep-2 left. Each test is one item of the brief, and each failed before its fix.

use std::sync::Arc;

use serde_json::json;
use ew_doc::graphic::{Embedded, EmbeddedRef, Graphic};
use ew_doc::para::InlineObject;
use ew_doc::{Document, Paragraph, Pos, StoryRef};

use super::keep_tests::{compared, first, picture, png, put_at_end};
use crate::{Selection, Session};

/// `s`'s document after Accept All, then after Reject All.
fn accepted_and_rejected(s: &Session) -> (Document, Document) {
    let run = |command: &str| {
        let mut t = Session::new(s.doc.clone());
        t.run(command, &json!({})).unwrap();
        t.doc
    };
    (run("review.acceptAll"), run("review.rejectAll"))
}

/// Every paragraph of `story`, tables' cells included, in order.
fn paras(doc: &Document, story: StoryRef) -> Vec<Paragraph> {
    let mut out = Vec::new();
    for b in doc.story(story).cloned().unwrap_or_default() {
        crate::cmd::paste::each_para(&mut (*b).clone(), 0, &mut |p| out.push(p.clone()));
    }
    out
}

fn tracked(p: &Paragraph) -> usize {
    p.runs.iter().filter(|r| r.props.ins.is_some() || r.props.del.is_some()).count()
}

/// 1. A picture in a header, compared with Headers and footers off: the result neither shows nor keeps it, so a draft does not
/// grow after every such Compare. A comment on that header's text does not come over either. With the setting on, both do.
#[test]
fn stories_left_out_of_the_comparison_bring_nothing_over() {
    let original = {
        let mut s = Session::new(Document::from_text("Body."));
        s.run("insert.header", &json!({"text": "Head"})).unwrap();
        s.doc
    };
    let revised = {
        let mut s = Session::new(original.clone());
        let head = StoryRef::Part(s.doc.last_section.headers.default.unwrap());
        let key = s.doc.add_media(png(77), "png");
        put_at_end(&mut s.doc, head, picture(&key));
        s.sel = Selection { anchor: s.doc.start_of(head), focus: Pos::new(head, ew_doc::Path(vec![0]), 4) };
        s.run("review.newComment", &json!({"text": "On the header"})).unwrap();
        s.doc
    };
    let off = compared(&original, &revised, json!({"headersFooters": false}));
    assert_eq!((off.doc.media.len(), off.doc.comments.len()), (original.media.len(), 0), "nothing came over: {:?}", off.doc.media.keys().collect::<Vec<_>>());
    let on = compared(&original, &revised, json!({"headersFooters": true}));
    assert_eq!((on.doc.media.len(), on.doc.comments.len()), (original.media.len() + 1, 1), "the picture and the comment came over");
}

/// An embedded object's markup referring to `target` (a passthrough part).
fn embedded(target: &str) -> Arc<Embedded> {
    let r = EmbeddedRef { id: "rId1".into(), kind: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart".into(), target: target.into(), external: false };
    Arc::new(Embedded { xml: "<c:chart r:id=\"rId1\"/>".into(), refs: vec![r] })
}

/// A document whose first paragraph holds a chart read from a file (its part relating to a workbook) and an OLE object, the
/// parts holding `tag`'s bytes. Both documents use the same part names.
fn with_objects(tag: &str) -> Document {
    let mut doc = Session::new(Document::from_text("Objects: \nNext.")).doc;
    let mut put = |name: &str, bytes: String| doc.passthrough.insert(name.into(), Arc::new(bytes.into_bytes()));
    put("word/charts/chart1.xml", format!("<chart>{tag}</chart>"));
    put("word/embeddings/Book1.xlsx", format!("workbook {tag}"));
    put("word/embeddings/oleObject1.bin", format!("ole {tag}"));
    let mut m = ew_docx::EmbeddedManifest::default();
    let part = |ct: &str, rels: Vec<ew_docx::Rel>| ew_docx::EmbeddedPart { content_type: ct.into(), rels };
    let book = ew_docx::Rel { id: "rId1".into(), kind: "package".into(), target: "word/embeddings/Book1.xlsx".into(), external: false };
    m.parts.insert("word/charts/chart1.xml".into(), part("application/vnd.openxmlformats-officedocument.drawingml.chart+xml", vec![book]));
    m.parts.insert("word/embeddings/Book1.xlsx".into(), part("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", vec![]));
    m.parts.insert("word/embeddings/oleObject1.bin".into(), part("application/vnd.openxmlformats-officedocument.oleObject", vec![]));
    doc.passthrough.insert(ew_docx::EMBEDDED_PARTS.into(), Arc::new(m.to_bytes()));
    let chart = Graphic { source: Some(embedded("word/charts/chart1.xml")), ..Default::default() };
    put_at_end(&mut doc, StoryRef::Body, InlineObject::Graphic { w: 100.0, h: 60.0, alt: String::new(), float: Default::default(), graphic: Arc::new(chart) });
    let key = doc.add_media(png(if tag == "A" { 10 } else { 200 }), "png");
    let mut ole = picture(&key);
    if let InlineObject::Image { ole: o, .. } = &mut ole {
        *o = Some(embedded("word/embeddings/oleObject1.bin"));
    }
    put_at_end(&mut doc, StoryRef::Body, ole);
    doc
}

/// Each embedded object of `doc`'s first paragraph → the bytes its part holds and those of the parts that part relates to.
fn embedded_bytes(doc: &Document) -> Vec<Vec<String>> {
    let m = ew_docx::EmbeddedManifest::parse(doc.passthrough.get(ew_docx::EMBEDDED_PARTS).map_or(&[][..], |b| &b[..]));
    let bytes = |name: &str| doc.passthrough.get(name).map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_else(|| format!("missing {name}"));
    let tree = |e: &Embedded| -> Vec<String> {
        let mut out = Vec::new();
        for r in &e.refs {
            out.push(bytes(&r.target));
            let rels = m.parts.get(&r.target).map(|p| p.rels.clone()).unwrap_or_default();
            out.extend(rels.iter().map(|x| bytes(&x.target)));
        }
        out
    };
    first(doc, StoryRef::Body)
        .objects
        .iter()
        .filter_map(|o| match o {
            InlineObject::Graphic { graphic, .. } => graphic.source.as_deref().map(tree),
            InlineObject::Image { ole, .. } => ole.as_deref().map(tree),
            _ => None,
        })
        .collect()
}

/// 2. A chart and an OLE object read from a file, changed in the revised document: the revised objects refer to the revised
/// parts, brought over under names of their own, so Accept All shows the revised parts and Reject All the original's.
#[test]
fn charts_and_ole_objects_bring_their_parts_over() {
    let (original, revised) = (with_objects("A"), with_objects("B"));
    let want = |t: &str| vec![vec![format!("<chart>{t}</chart>"), format!("workbook {t}")], vec![format!("ole {t}")]];
    assert_eq!(embedded_bytes(&revised), want("B"), "the test's own premise");
    let s = compared(&original, &revised, json!({}));
    let (accepted, rejected) = accepted_and_rejected(&s);
    assert_eq!((embedded_bytes(&accepted), embedded_bytes(&rejected)), (want("B"), want("A")));
    // The same objects in both documents are no change, and bring no part over.
    let s = compared(&original, &original, json!({}));
    assert_eq!(s.doc.passthrough, original.passthrough);
}

/// A body holding `text` in a table nested `depth` tables deep.
fn nested(depth: usize, text: &str) -> Document {
    let mut s = Session::new(Document::from_text("Before."));
    s.run("caret.docEnd", &json!({})).unwrap();
    for _ in 0..depth {
        s.run("insert.table", &json!({"rows": 1, "cols": 1})).unwrap();
    }
    s.run("text.insert", &json!({"text": text})).unwrap();
    s.doc
}

/// 3. Tables nested 17 deep, differing in their innermost text, and one taken out whole: tracked, so Accept All gives the revised
/// text and Reject All the original's.
#[test]
fn a_table_nested_sixteen_or_more_deep_is_compared_whole() {
    let (a, b) = (nested(17, "Deep one"), nested(17, "Deep two"));
    let deepest = |doc: &Document| paras(doc, StoryRef::Body).iter().map(Paragraph::plain_text).filter(|t| t.starts_with("Deep")).collect::<Vec<_>>();
    assert_eq!(deepest(&b), vec!["Deep two"], "the test's own premise");
    let s = compared(&a, &b, json!({}));
    assert!(paras(&s.doc, StoryRef::Body).iter().map(tracked).sum::<usize>() > 0, "tracked: {:?}", deepest(&s.doc));
    let (accepted, rejected) = accepted_and_rejected(&s);
    assert_eq!((deepest(&accepted), deepest(&rejected)), (vec!["Deep two".to_string()], vec!["Deep one".to_string()]));
    // The table taken out: every paragraph in it is deleted.
    let s = compared(&a, &Session::new(Document::from_text("Before.")).doc, json!({}));
    let (accepted, rejected) = accepted_and_rejected(&s);
    assert_eq!((deepest(&accepted), deepest(&rejected)), (vec![], vec!["Deep one".to_string()]));
}

/// 4. Two pictures whose bytes neither document holds, under different keys: a change, not the same picture.
#[test]
fn pictures_whose_media_is_missing_match_only_the_same_key() {
    let with = |key: &str| {
        let mut doc = Session::new(Document::from_text("The cat sat.")).doc;
        put_at_end(&mut doc, StoryRef::Body, picture(key));
        doc
    };
    let (a, b) = (with("gone-a.png"), with("gone-b.png"));
    let s = compared(&a, &b, json!({}));
    let (accepted, rejected) = accepted_and_rejected(&s);
    let key = |doc: &Document| first(doc, StoryRef::Body).objects.iter().find_map(|o| if let InlineObject::Image { media, .. } = o { Some(media.to_string()) } else { None });
    assert_eq!((key(&accepted), key(&rejected)), (Some("gone-b.png".into()), Some("gone-a.png".into())));
    // The same missing key is no change.
    let mut s = compared(&a, &a, json!({}));
    assert_eq!(s.run("review.changes", &json!({})).unwrap(), json!([]));
}

/// 5. A word made bold in a paragraph that also gained a bookmark: a formatting revision (the bookmark is no change), so Accept
/// All keeps the bold and Reject All takes it off.
#[test]
fn formatting_is_compared_when_the_texts_differ_only_in_marks_the_key_leaves_out() {
    let original = Session::new(Document::from_text("The cat sat.")).doc;
    let revised = {
        let mut s = Session::new(original.clone());
        s.sel = Selection { anchor: Pos::body(0, 4), focus: Pos::body(0, 7) };
        s.run("insert.bookmark", &json!({"name": "Pet"})).unwrap();
        let p = first(&s.doc, StoryRef::Body);
        let at = p.text.find("sat").unwrap();
        s.sel = Selection { anchor: Pos::body(0, at), focus: Pos::body(0, at + 3) };
        s.run("format.bold", &json!({})).unwrap();
        s.doc
    };
    let s = compared(&original, &revised, json!({}));
    let p = first(&s.doc, StoryRef::Body);
    let changed: Vec<&str> = p.run_ranges().filter(|(_, c)| c.fmt_change.is_some()).filter_map(|(r, _)| p.text.get(r)).collect();
    assert_eq!((changed, tracked(&p)), (vec!["sat"], 0), "a formatting revision on the bold word: {:?}", p.runs);
    assert!(p.objects.iter().any(|o| matches!(o, InlineObject::BookmarkStart { .. })), "the bookmark stays");
    let bold = |doc: &Document| {
        let p = first(doc, StoryRef::Body);
        p.run_ranges().filter(|(_, c)| c.bold == Some(true)).filter_map(|(r, _)| p.text.get(r).map(str::to_string)).collect::<Vec<_>>()
    };
    let (accepted, rejected) = accepted_and_rejected(&s);
    assert_eq!((bold(&accepted), bold(&rejected)), (vec!["sat".to_string()], vec![]));
}

/// The text box `doc`'s first paragraph shows: its part id.
fn text_box(doc: &Document) -> u32 {
    first(doc, StoryRef::Body).objects.iter().find_map(InlineObject::text_box).expect("a text box")
}

/// 6. A text box whose words changed: the box stays, and inside it the changed word is deleted and inserted while the rest is
/// no change, as in a paragraph; Accept All gives the revised box text and Reject All the original's.
#[test]
fn a_changed_text_box_tracks_the_words_inside_it() {
    let boxed = |t: &str| {
        let mut s = Session::new(Document::from_text("Text."));
        s.run("caret.docEnd", &json!({})).unwrap();
        s.run("insert.textBox", &json!({"text": t})).unwrap();
        s.doc
    };
    let (a, b) = (boxed("Old words here"), boxed("New words here"));
    let s = compared(&a, &b, json!({}));
    assert_eq!(tracked(&first(&s.doc, StoryRef::Body)), 0, "the box itself is no change: {:?}", first(&s.doc, StoryRef::Body).runs);
    let inside = first(&s.doc, StoryRef::Part(text_box(&s.doc)));
    let marked: Vec<&str> = inside.run_ranges().filter(|(_, c)| c.ins.is_some() || c.del.is_some()).filter_map(|(r, _)| inside.text.get(r)).collect();
    assert_eq!(marked, vec!["Old ", "New "], "{:?}", inside.text);
    let (accepted, rejected) = accepted_and_rejected(&s);
    let text = |d: &Document| d.plain_text(StoryRef::Part(text_box(d)));
    assert_eq!((text(&accepted), text(&rejected)), ("New words here".to_string(), "Old words here".to_string()));
}

/// 7. A comment with a reply (which has no marks of its own) comes over with the reply, still its reply.
#[test]
fn comment_replies_come_over_with_their_comment() {
    let original = Session::new(Document::from_text("Same text here.")).doc;
    let revised = {
        let mut s = Session::new(original.clone());
        s.sel = Selection { anchor: Pos::body(0, 0), focus: Pos::body(0, 4) };
        let id = s.run("review.newComment", &json!({"text": "A comment"})).unwrap()["id"].as_u64().unwrap();
        s.run("review.reply", &json!({"id": id, "text": "A reply"})).unwrap();
        s.doc
    };
    assert_eq!(revised.comments.len(), 2, "the test's own premise");
    let s = compared(&original, &revised, json!({}));
    let text = |id: &u32| s.doc.comments.get(id).map(|c| s.doc.plain_text(StoryRef::Part(c.part))).unwrap_or_default();
    let threads: Vec<(String, Option<String>)> = s.doc.comments.iter().map(|(id, c)| (text(id), c.parent.as_ref().map(text))).collect();
    assert_eq!(threads, vec![("A comment".into(), None), ("A reply".into(), Some("A comment".into()))]);
}
