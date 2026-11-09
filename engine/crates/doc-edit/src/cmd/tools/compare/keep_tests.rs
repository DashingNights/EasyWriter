// engine-compare-keep-2: Compare sees a paragraph's objects in its key, brings the revised document's media over for every story,
// and compares pictures by their bytes. Each case is one the premise "a paragraph is its text, and only the body's media follow"
// got wrong.

use std::sync::Arc;

use serde_json::{Value, json};
use ew_doc::para::InlineObject;
use ew_doc::props::CharProps;
use ew_doc::{Block, Document, Paragraph, Path, Pos, StoryRef};

use crate::{Selection, Session};

pub(super) fn png(blue: u8) -> Vec<u8> {
    let img = image::RgbaImage::from_fn(8, 6, |x, _| image::Rgba([(x * 30) as u8, 90, blue, 255]));
    let mut b = Vec::new();
    image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut b), image::ImageFormat::Png).unwrap();
    b
}

pub(super) fn picture(media: &str) -> InlineObject {
    ew_doc::para::Picture { media: media.into(), w: 20.0, h: 15.0, ..Default::default() }.build()
}

/// `doc` with `o` put at the end of `story`'s first paragraph.
pub(super) fn put_at_end(doc: &mut Document, story: StoryRef, o: InlineObject) {
    let blocks = doc.story_mut(story).unwrap();
    let Block::Para(p) = Arc::make_mut(&mut blocks[0]) else { panic!("a paragraph first") };
    let (at, props) = (p.len(), p.props_at(p.len()).clone());
    p.insert_object(at, o, &props).unwrap();
}

/// `original` compared with `revised` (handed over in the engine's own form, as another canvas draft is) under `opts`.
pub(super) fn compared(original: &Document, revised: &Document, opts: Value) -> Session {
    let mut s = Session::new(original.clone());
    let data = crate::cmd::insert::base64_encode(&serde_json::to_vec(revised).unwrap());
    let mut v = json!({"revisedData": data, "revisedKind": "engine", "author": "Rev"});
    v.as_object_mut().unwrap().extend(opts.as_object().unwrap().clone());
    s.run("review.compare", &v).unwrap();
    s
}

pub(super) fn first(doc: &Document, story: StoryRef) -> Paragraph {
    doc.story(story).unwrap()[0].as_para().unwrap().clone()
}

/// The kinds of `p`'s objects whose run `pick` chooses.
fn kinds(p: &Paragraph, pick: &dyn Fn(&CharProps) -> bool) -> Vec<&'static str> {
    p.objects_with_offsets()
        .filter(|(off, _)| pick(p.props_of_char(*off)))
        .map(|(_, o)| match o {
            InlineObject::Image { .. } => "picture",
            InlineObject::Field { .. } => "field",
            InlineObject::ControlStart { .. } => "control",
            InlineObject::ControlEnd => "control end",
            _ => "other",
        })
        .collect()
}

/// The bytes each picture of `p` whose run `pick` chooses shows in `doc`.
fn pictures(doc: &Document, p: &Paragraph, pick: &dyn Fn(&CharProps) -> bool) -> Vec<Vec<u8>> {
    p.objects_with_offsets()
        .filter(|(off, _)| pick(p.props_of_char(*off)))
        .filter_map(|(_, o)| if let InlineObject::Image { media, .. } = o { Some(doc.media.get(media.as_str()).map(|b| b.to_vec()).unwrap_or_default()) } else { None })
        .collect()
}

/// A paragraph's text and objects as accepting or rejecting leaves them, a picture as its bytes.
fn content(doc: &Document, p: &Paragraph) -> (String, Vec<String>) {
    let objects = p
        .objects
        .iter()
        .map(|o| match o {
            InlineObject::Image { media, .. } => format!("picture {}", doc.media.get(media.as_str()).map_or(0, |b| b.len())),
            o => format!("{:?}", std::mem::discriminant(o)),
        })
        .collect();
    (p.text.clone(), objects)
}

/// Accepting every change in `s` gives `revised`'s `story` and rejecting every change `original`'s, objects included.
fn accepting_and_rejecting_give(s: &Session, story: StoryRef, original: &Document, revised: &Document) {
    for (command, want) in [("review.acceptAll", revised), ("review.rejectAll", original)] {
        let mut t = Session::new(s.doc.clone());
        t.run(command, &json!({})).unwrap();
        assert_eq!(content(&t.doc, &first(&t.doc, story)), content(want, &first(want, story)), "{command} in {story:?}");
    }
}

const INS: &dyn Fn(&CharProps) -> bool = &|c| c.ins.is_some();
const DEL: &dyn Fn(&CharProps) -> bool = &|c| c.del.is_some();

/// A picture or content control added at a paragraph's end (or anywhere in it) is an insertion, and one taken out a deletion:
/// the paragraph's key holds its objects, so it no longer compares Same and comes over whole, untracked.
#[test]
fn an_object_added_or_removed_at_a_paragraphs_end_is_tracked() {
    let base = Session::new(Document::from_text("The cat sat.\nNext.")).doc;
    let end = Pos::body(0, first(&base, StoryRef::Body).len());
    let added = |what: &str| {
        let mut s = Session::new(base.clone());
        s.sel = Selection::caret(end.clone());
        match what {
            "picture" => {
                s.run("insert.picture", &json!({"data": crate::cmd::insert::base64_encode(&png(160))})).unwrap();
            }
            "field" => {
                s.run("insert.field", &json!({"instr": "PAGE", "result": "1"})).unwrap();
            }
            _ => {
                // Around the paragraph's last word, "sat.".
                s.sel = Selection { anchor: Pos::body(0, 8), focus: end.clone() };
                s.run("developer.plainText", &json!({"title": "Verb"})).unwrap();
            }
        }
        s.doc
    };
    for (what, want) in [("picture", vec!["picture"]), ("field", vec!["field"]), ("control", vec!["control", "control end"])] {
        let revised = added(what);
        // Added: the object is an insertion, the words around it no change.
        let s = compared(&base, &revised, json!({}));
        let p = first(&s.doc, StoryRef::Body);
        assert_eq!((kinds(&p, INS), kinds(&p, DEL)), (want.clone(), vec![]), "{what} added: {:?}", p.text);
        assert_eq!(p.run_ranges().filter(|(_, c)| c.ins.is_some() || c.del.is_some()).map(|(r, _)| r.len()).sum::<usize>(), 3 * want.len(), "{what}: only the object is marked");
        accepting_and_rejecting_give(&s, StoryRef::Body, &base, &revised);
        // Taken out: a deletion.
        let s = compared(&revised, &base, json!({}));
        let p = first(&s.doc, StoryRef::Body);
        assert_eq!((kinds(&p, INS), kinds(&p, DEL)), (vec![], want.clone()), "{what} taken out: {:?}", p.text);
        accepting_and_rejecting_give(&s, StoryRef::Body, &revised, &base);
    }
}

/// A picture replaced in a header, a footer and a footnote: the original's is deleted and the revised one inserted, each
/// showing its own bytes, though both documents call their picture `image1.png`.
#[test]
fn a_changed_picture_in_a_header_footer_and_footnote_shows_each_documents_bytes() {
    let made = |bytes: &[u8]| {
        let mut s = Session::new(Document::from_text("Body."));
        s.run("insert.header", &json!({"text": "Head"})).unwrap();
        s.run("insert.footer", &json!({"text": "Foot"})).unwrap();
        s.sel = Selection::caret(Pos::body(0, 5));
        s.run("references.footnote", &json!({"text": "A note"})).unwrap();
        let mut doc = s.doc;
        let key = doc.add_media(bytes.to_vec(), "png");
        assert_eq!(key, "image1.png", "the test's own premise: both documents use one name");
        for story in stories(&doc) {
            put_at_end(&mut doc, story, picture(&key));
        }
        doc
    };
    let (a, b) = (png(10), png(200));
    let (original, revised) = (made(&a), made(&b));
    let s = compared(&original, &revised, json!({}));
    let found = stories(&s.doc);
    assert_eq!(found.len(), 3, "a header, a footer and a footnote");
    for story in found {
        let p = first(&s.doc, story);
        assert_eq!((pictures(&s.doc, &p, DEL), pictures(&s.doc, &p, INS)), (vec![a.clone()], vec![b.clone()]), "in {story:?}");
        accepting_and_rejecting_give(&s, story, &original, &revised);
    }
}

/// The header, footer and footnote stories of `doc`.
pub(super) fn stories(doc: &Document) -> Vec<StoryRef> {
    let sec = &doc.last_section;
    let notes = doc.parts.iter().filter(|(_, p)| p.kind == ew_doc::PartKind::Footnote).map(|(id, _)| *id);
    [sec.headers.default, sec.footers.default].into_iter().flatten().chain(notes).map(StoryRef::Part).collect()
}

/// The same picture (and the picture its corrections were drawn from, and its PNG copy) under other keys in the revised
/// document is no change, also where the original holds those bytes twice; in the body and in a header.
#[test]
fn one_picture_under_two_keys_is_no_change() {
    let with = |key: &str| {
        let mut s = Session::new(Document::from_text("The cat sat."));
        s.run("insert.header", &json!({"text": "Head"})).unwrap();
        let mut doc = s.doc;
        let bytes = Arc::new(png(120));
        doc.media.insert(key.into(), bytes.clone());
        // Corrections in its pixels, drawn from a layer.
        let adjust = ew_doc::adjust::PictureAdjust { brightness: 20.0, ..Default::default() };
        let o = ew_doc::para::Picture { media: key.into(), w: 20.0, h: 15.0, adjust, layer: Some(key.into()), fallback: Some(key.into()), ..Default::default() }.build();
        for story in [StoryRef::Body, StoryRef::Part(doc.last_section.headers.default.unwrap())] {
            put_at_end(&mut doc, story, o.clone());
        }
        doc
    };
    let mut original = with("b.png");
    original.media.insert("a.png".into(), original.media["b.png"].clone());
    let revised = with("renamed.png");
    let mut s = compared(&original, &revised, json!({}));
    assert_eq!(s.run("review.changes", &json!({})).unwrap(), json!([]), "no change");
}

/// A table whose text both documents hold, with a word made bold: with Formatting compared it is a formatting revision, as in a
/// paragraph; without, the revised formatting shows, unmarked.
#[test]
fn formatting_in_a_table_is_compared_as_the_setting_says() {
    let table = |bold: bool| {
        let mut s = Session::new(Document::from_text("Text."));
        s.run("caret.docEnd", &json!({})).unwrap();
        s.run("insert.table", &json!({"rows": 1, "cols": 1})).unwrap();
        s.run("text.insert", &json!({"text": "Cell"})).unwrap();
        if bold {
            s.sel.anchor.off = 0;
            s.run("format.bold", &json!({})).unwrap();
        }
        s.doc
    };
    let (original, revised) = (table(false), table(true));
    let cell = |doc: &Document| {
        let mut out = Vec::new();
        for b in &doc.body {
            crate::cmd::paste::each_para(&mut (**b).clone(), 0, &mut |p| {
                if p.plain_text() == "Cell" {
                    out.push(p.clone());
                }
            });
        }
        out.pop().expect("the cell's paragraph")
    };
    let bold_runs = |p: &Paragraph, changed: bool| p.runs.iter().filter(|r| r.props.bold == Some(true) && r.props.fmt_change.is_some() == changed).count();
    let s = compared(&original, &revised, json!({"formatting": true}));
    assert_eq!(bold_runs(&cell(&s.doc), true), 1, "a formatting revision: {:?}", cell(&s.doc).runs);
    let s = compared(&original, &revised, json!({"formatting": false}));
    assert_eq!((bold_runs(&cell(&s.doc), false), bold_runs(&cell(&s.doc), true)), (1, 0), "bold, unmarked");
}

/// A comment on a footnote's text in the revised document: with Comments compared it comes over with its own text, on its
/// words; without, its marks go.
#[test]
fn comments_in_a_footnote_follow_the_setting() {
    let original = {
        let mut s = Session::new(Document::from_text("Text."));
        s.sel = Selection::caret(Pos::body(0, 5));
        s.run("references.footnote", &json!({"text": "A note"})).unwrap();
        s.doc
    };
    let note = stories(&original)[0];
    let revised = {
        let mut s = Session::new(original.clone());
        let p = first(&s.doc, note);
        let at = p.text.find("note").unwrap();
        s.sel = Selection { anchor: Pos::new(note, Path(vec![0]), at), focus: Pos::new(note, Path(vec![0]), at + 4) };
        s.run("review.newComment", &json!({"text": "In the note"})).unwrap();
        s.doc
    };
    let marks = |doc: &Document| -> Vec<u32> {
        let mut out = Vec::new();
        for (_, part) in doc.parts.iter().filter(|(_, p)| p.kind == ew_doc::PartKind::Footnote) {
            for b in &part.blocks {
                crate::cmd::paste::each_para(&mut (**b).clone(), 0, &mut |p| {
                    out.extend(p.objects.iter().filter_map(|o| if let InlineObject::CommentStart { id } = o { Some(*id) } else { None }));
                });
            }
        }
        out
    };
    let s = compared(&original, &revised, json!({"comments": true}));
    let ids = marks(&s.doc);
    let texts: Vec<String> = ids.iter().map(|id| s.doc.comments.get(id).map(|c| s.doc.plain_text(StoryRef::Part(c.part))).unwrap_or_default()).collect();
    assert_eq!(texts, vec!["In the note".to_string()], "the comment comes over: marks {ids:?}, comments {:?}", s.doc.comments.keys().collect::<Vec<_>>());
    let s = compared(&original, &revised, json!({"comments": false}));
    assert_eq!((marks(&s.doc), s.doc.comments.len()), (vec![], 0), "its marks go");
}
