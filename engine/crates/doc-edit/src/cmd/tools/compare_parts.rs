//! EasyWriter engine-gaps-rest: what Compare and Combine compare besides the body text, as the More >> settings of Word's
//! dialog say (Moves, Comments, Headers and footers, Footnotes and endnotes, Textboxes, Fields; each on unless switched off).
//!
//! Before anything is compared, the revised document's references are made the original's, in every story the result holds
//! (the body, the headers, footers and notes compared, and the comments and text boxes those refer to): its footnotes and
//! endnotes pair with the original's by kind and order and take their ids, its pictures' bytes come over as media and its
//! charts' and OLE objects' parts as passthrough parts (compare/embedded.rs), its text boxes, notes the original lacks and
//! (when compared) comments with their replies come over as parts of their own, and (when not) its comment marks go. So every
//! revised story the comparison reads refers only to the original document, and nothing else comes over. After the body, the paired headers, footers and
//! notes are compared as the body is, and whole paragraphs deleted in one place and inserted in another become a move.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::Value;
use ew_doc::para::{InlineObject, NoteKind, OBJ};
use ew_doc::section::HeaderSet;
use ew_doc::{Block, Document, Paragraph, RevisionKind, StoryRef};

use crate::p;

/// The More >> settings.
#[derive(Clone, Copy)]
pub(super) struct Honour {
    pub moves: bool,
    pub comments: bool,
    pub headers_footers: bool,
    pub footnotes: bool,
    pub text_boxes: bool,
    pub fields: bool,
}

impl Honour {
    pub fn of(v: &Value) -> Honour {
        let on = |k: &str| p::bool(v, k).unwrap_or(true);
        Honour {
            moves: on("moves"),
            comments: on("comments"),
            headers_footers: on("headersFooters"),
            footnotes: on("footnotes"),
            text_boxes: on("textBoxes"),
            fields: on("fields"),
        }
    }
}

/// An inline object's text as the comparison sees it, pushed to `out`: a field's result and code when fields are compared, else
/// nothing; text boxes' text (`boxes`, from the paragraph's document) when they are compared.
pub(super) fn object_text(o: &InlineObject, h: &Honour, boxes: &dyn Fn(u32) -> String, out: &mut String) {
    match o {
        InlineObject::Field { instr, result, .. } if h.fields => {
            out.push_str(result);
            out.push('\u{1}');
            out.push_str(instr.trim());
            out.push('\u{1}');
        }
        InlineObject::Field { .. } => {}
        o => {
            out.push_str(o.plain_text());
            if h.text_boxes {
                for id in o.text_boxes() {
                    out.push('\u{2}');
                    out.push_str(&boxes(id));
                }
            }
        }
    }
}

/// A mark that anchors something rather than being content (a comment's, a bookmark's or an editing permission's): a
/// paragraph's key leaves it out, as Word does not track it.
pub(super) fn anchor(o: &InlineObject) -> bool {
    matches!(
        o,
        InlineObject::CommentStart { .. }
            | InlineObject::CommentEnd { .. }
            | InlineObject::BookmarkStart { .. }
            | InlineObject::BookmarkEnd { .. }
            | InlineObject::PermStart { .. }
            | InlineObject::PermEnd { .. }
    )
}

/// The note references of `doc`'s body by kind, in order.
fn notes_of(doc: &Document, kind: NoteKind) -> Vec<u32> {
    let mut out = Vec::new();
    for b in &doc.body {
        crate::cmd::paste::each_para(&mut (**b).clone(), 0, &mut |p| {
            out.extend(p.objects.iter().filter_map(|o| match o {
                InlineObject::NoteRef { kind: k, id, .. } if *k == kind => Some(*id),
                _ => None,
            }))
        });
    }
    out
}

/// A part id `doc` does not use yet.
fn free_part(doc: &Document) -> u32 {
    doc.parts.keys().next_back().map_or(1, |k| k.saturating_add(1))
}

/// Makes `rev`'s references the original's (see the module docs) through one walk over the revised stories the result holds:
/// the body, the headers, footers and notes compared, and every story those refer to (a text box, a note only the revised
/// document has, a comment's text and its replies). Only what that walk meets comes over, so a story left out (a header when
/// headers and footers are not compared) adds nothing to the original. → the parts to compare after the body: headers and
/// footers slot by slot, then the paired notes (the original's part id, the revised part's blocks).
pub(super) fn prepare(orig: &mut Document, rev: &mut Document, h: &Honour) -> Vec<(u32, Vec<Arc<Block>>)> {
    if !h.comments {
        for blocks in std::iter::once(&mut rev.body).chain(rev.parts.values_mut().map(|p| &mut p.blocks)) {
            for b in blocks.iter_mut() {
                crate::cmd::paste::each_para(Arc::make_mut(b), 0, &mut drop_comment_marks);
            }
        }
    }
    // Each revised part id and the original's for it: a paired note takes the original note's id; any other part referred to
    // a new one, and comes over whole below.
    let mut parts: BTreeMap<u32, u32> = BTreeMap::new();
    let mut notes = Vec::new();
    for kind in [NoteKind::Footnote, NoteKind::Endnote] {
        for (rid, oid) in notes_of(rev, kind).into_iter().zip(notes_of(orig, kind)) {
            parts.insert(rid, oid);
            notes.push((oid, rid));
        }
    }
    let mut pairs: Vec<(u32, u32)> = Vec::new();
    if h.headers_footers {
        pairs.extend(header_slots(orig).into_iter().zip(header_slots(rev)).filter_map(|(a, b)| a.zip(b)));
    }
    if h.footnotes {
        pairs.extend(notes);
    }
    pairs.retain(|(a, b)| orig.parts.contains_key(a) && rev.parts.contains_key(b));
    let mut w = Walk {
        parts,
        next: free_part(orig),
        fresh: Vec::new(),
        keys: BTreeMap::new(),
        media: std::mem::take(&mut rev.media),
        comments: BTreeMap::new(),
        next_comment: orig.comments.keys().next_back().map_or(0, |k| k.saturating_add(1)),
        rev_comments: std::mem::take(&mut rev.comments),
        embedded: super::compare::embedded::Parts::new(orig, std::mem::take(&mut rev.passthrough)),
    };
    let mut todo: Vec<StoryRef> = std::iter::once(StoryRef::Body).chain(pairs.iter().map(|(_, b)| StoryRef::Part(*b))).collect();
    // Each story once: a second walk would take keys and ids it made the original's for the revised document's own.
    let mut seen: BTreeSet<StoryRef> = BTreeSet::new();
    let mut queued = 0;
    while let Some(story) = todo.pop() {
        if !seen.insert(story) {
            continue;
        }
        if let Ok(blocks) = rev.story_mut(story) {
            for b in blocks.iter_mut() {
                crate::cmd::paste::each_para(Arc::make_mut(b), 0, &mut |p| {
                    if !p.objects.is_empty() {
                        p.objects.iter_mut().for_each(|o| w.object(orig, o));
                        p.touch();
                    }
                });
            }
        }
        // The parts this story referred to first, walked in turn.
        todo.extend(w.fresh.get(queued..).unwrap_or_default().iter().map(|(old, _)| StoryRef::Part(*old)));
        queued = w.fresh.len();
    }
    w.embedded.finish(orig);
    // The parts named come over as the walk left them, a linked text box's next box by the same ids.
    for (old, id) in w.fresh {
        if let Some(mut p) = rev.parts.get(&old).cloned() {
            p.body.next = p.body.next.and_then(|n| w.parts.get(&n).copied());
            orig.parts.insert(id, p);
        }
    }
    pairs.into_iter().filter_map(|(a, b)| rev.parts.get(&b).map(|p| (a, p.blocks.clone()))).collect()
}

/// [`prepare`]'s walk: what it has made the original's so far.
struct Walk {
    /// Each revised part id met → the original's id for it.
    parts: BTreeMap<u32, u32>,
    next: u32,
    /// The parts that come over whole: (revised id, the original's new id).
    fresh: Vec<(u32, u32)>,
    /// Each revised media key met → the original's key for those bytes.
    keys: BTreeMap<String, String>,
    media: BTreeMap<String, Arc<Vec<u8>>>,
    /// Each revised comment met → the original's id for it.
    comments: BTreeMap<u32, u32>,
    next_comment: u32,
    rev_comments: BTreeMap<u32, ew_doc::Comment>,
    embedded: super::compare::embedded::Parts,
}

impl Walk {
    fn part(&mut self, old: u32) -> u32 {
        *self.parts.entry(old).or_insert_with(|| {
            let id = self.next;
            self.next = self.next.saturating_add(1);
            self.fresh.push((old, id));
            id
        })
    }

    /// Revised object `o` made to refer to the original document.
    fn object(&mut self, orig: &mut Document, o: &mut InlineObject) {
        // Pictures' bytes under the original's key for them: the same key when it holds them already.
        let (keys, media) = (&mut self.keys, &self.media);
        o.rename_media(&mut |key| {
            keys.entry(key.to_string())
                .or_insert_with(|| match media.get(key) {
                    Some(bytes) => orig.add_media(bytes.to_vec(), key.rsplit_once('.').map_or("png", |(_, e)| e)),
                    None => key.to_string(),
                })
                .clone()
        });
        // A chart's or OLE object's parts, under the original's names for them.
        for e in super::compare::embedded::slots(o) {
            self.embedded.repoint(orig, e);
        }
        for slot in o.text_box_slots() {
            *slot = slot.map(|id| self.part(id));
        }
        match o {
            InlineObject::NoteRef { id, .. } => *id = self.part(*id),
            InlineObject::CommentStart { id } | InlineObject::CommentEnd { id } => *id = self.comment(orig, *id),
            _ => {}
        }
    }

    /// The original's id for revised comment `old`, which comes over with the whole of its thread: the comment it answers and
    /// every reply, though replies have no marks of their own.
    fn comment(&mut self, orig: &mut Document, old: u32) -> u32 {
        if let Some(id) = self.comments.get(&old) {
            return *id;
        }
        let mut root = old;
        for _ in 0..self.rev_comments.len() {
            match self.rev_comments.get(&root).and_then(|c| c.parent).filter(|p| self.rev_comments.contains_key(p)) {
                Some(p) => root = p,
                None => break,
            }
        }
        // Each comment before its replies, so a reply's parent has its new id.
        let mut todo = vec![root];
        while let Some(c) = todo.pop() {
            if self.comments.contains_key(&c) {
                continue;
            }
            let id = self.next_comment;
            self.next_comment = self.next_comment.saturating_add(1);
            self.comments.insert(c, id);
            if let Some(x) = self.rev_comments.get(&c).cloned() {
                let parent = x.parent.and_then(|p| self.comments.get(&p).copied());
                let part = self.part(x.part);
                orig.comments.insert(id, ew_doc::Comment { part, parent, ..x });
            }
            // ponytail: every comment scanned per comment; an index by parent if threads ever run to thousands.
            todo.extend(self.rev_comments.iter().filter(|(_, r)| r.parent == Some(c)).map(|(k, _)| *k));
        }
        self.comments.get(&old).copied().unwrap_or(old)
    }
}

/// `f` on each paragraph of `revised` with the paragraph of `original` in its place, two blocks the comparison matched as the
/// same: a table's paragraphs pair in order, and one whose paragraphs do not pair one to one is left as it is.
pub(super) fn pair_paras(original: &Block, revised: &mut Block, f: &mut dyn FnMut(&Paragraph, &mut Paragraph)) {
    let mut olds = Vec::new();
    crate::cmd::paste::each_para(&mut original.clone(), 0, &mut |p| olds.push(p.clone()));
    let mut n = 0;
    crate::cmd::paste::each_para(revised, 0, &mut |_| n += 1);
    if n != olds.len() {
        return;
    }
    let mut olds = olds.into_iter();
    crate::cmd::paste::each_para(revised, 0, &mut |p| {
        if let Some(o) = olds.next() {
            f(&o, p);
        }
    });
}

/// The original's comment marks put into `p`, the revised paragraph the comparison matched with `o` as the same (Word keeps
/// both documents' comments). Each mark goes after as many characters of the revised text as came before it in the original,
/// so a comment stays on its words.
pub(super) fn keep_para_comments(o: &Paragraph, p: &mut Paragraph) {
    let mut marks = Vec::new();
    let mut chars = 0;
    let mut k = 0;
    for c in o.text.chars() {
        if c != OBJ {
            chars += 1;
            continue;
        }
        if let Some(m @ (InlineObject::CommentStart { .. } | InlineObject::CommentEnd { .. })) = o.objects.get(k) {
            marks.push((chars, m.clone()));
        }
        k += 1;
    }
    // Last first, each right after its character: marks at one place keep the original's order.
    for (n, m) in marks.into_iter().rev() {
        let at = if n == 0 { 0 } else { p.text.char_indices().filter(|(_, c)| *c != OBJ).nth(n - 1).map_or(p.text.len(), |(i, c)| i + c.len_utf8()) };
        let props = p.props_at(at).clone();
        let _ = p.insert_object(at, m, &props);
    }
}

/// Takes the comment marks out of `p` (their characters and objects).
fn drop_comment_marks(p: &mut Paragraph) {
    let marks: Vec<usize> = p
        .objects_with_offsets()
        .filter(|(_, o)| matches!(o, InlineObject::CommentStart { .. } | InlineObject::CommentEnd { .. }))
        .map(|(off, _)| off)
        .collect();
    for off in marks.into_iter().rev() {
        let _ = p.delete(off, off + OBJ.len_utf8());
    }
}

/// The header and footer slots of `doc`'s sections, in order.
fn header_slots(doc: &Document) -> Vec<Option<u32>> {
    let set = |h: &HeaderSet| [h.default, h.first, h.even];
    doc.sections().into_iter().flat_map(|(_, s)| set(&s.headers).into_iter().chain(set(&s.footers))).collect()
}

/// Whole paragraphs deleted in one place and inserted with the same text in another become a move (Word's Moves): each pair
/// gets a move name and revisions of its own, made like `ins` and `del`. → how many moves.
pub(super) fn mark_moves(out: &mut [Arc<Block>], revisions: &mut Vec<ew_doc::Revision>, (ins, del): (u32, u32)) -> usize {
    let whole = |b: &Block, r: u32, del: bool| match b {
        Block::Para(p) if !p.text.trim().is_empty() => p.runs.iter().all(|x| if del { x.props.del == Some(r) } else { x.props.ins == Some(r) }),
        _ => false,
    };
    let text = |b: &Block| if let Block::Para(p) = b { p.plain_text() } else { String::new() };
    let mut used = vec![false; out.len()];
    let mut moves = 0;
    for i in 0..out.len() {
        if used[i] || !whole(&out[i], del, true) {
            continue;
        }
        let t = text(&out[i]);
        let Some(j) = (0..out.len()).find(|&j| !used[j] && j != i && whole(&out[j], ins, false) && text(&out[j]) == t) else { continue };
        let Some(base) = revisions.get(del as usize).cloned() else { continue };
        moves += 1;
        let name = format!("move{moves}");
        revisions.push(ew_doc::Revision { kind: RevisionKind::Delete, move_name: Some(name.clone()), ..base.clone() });
        let from = (revisions.len() - 1) as u32;
        revisions.push(ew_doc::Revision { kind: RevisionKind::Insert, move_name: Some(name), ..base });
        let to = (revisions.len() - 1) as u32;
        for (k, r) in [(i, from), (j, to)] {
            if let Block::Para(p) = Arc::make_mut(&mut out[k]) {
                for x in &mut p.runs {
                    if k == i { x.props.del = Some(r) } else { x.props.ins = Some(r) }
                }
            }
        }
        used[i] = true;
        used[j] = true;
    }
    moves
}

#[cfg(test)]
mod tests {
    use crate::Session;
    use serde_json::{Value, json};
    use ew_doc::{Document, StoryRef};

    fn engine(doc: &Document) -> String {
        crate::cmd::insert::base64_encode(&serde_json::to_vec(doc).unwrap())
    }
    /// A session on `text` with `f` run on it.
    fn made(text: &str, f: &dyn Fn(&mut Session)) -> Session {
        let mut s = Session::new(Document::from_text(text));
        f(&mut s);
        s
    }
    /// The original compared with the revised under `opts` → the session holding the result.
    fn compared(original: &Session, revised: &Session, opts: Value) -> Session {
        let mut s = Session::new(original.doc.clone());
        let mut v = json!({"revisedData": engine(&revised.doc), "revisedKind": "engine", "author": "Rev"});
        v.as_object_mut().unwrap().extend(opts.as_object().unwrap().clone());
        s.run("review.compare", &v).unwrap();
        s
    }
    fn tracked(doc: &Document, story: StoryRef) -> usize {
        let mut n = 0;
        let blocks = doc.story(story).cloned().unwrap_or_default();
        for b in &blocks {
            crate::cmd::paste::each_para(&mut (**b).clone(), 0, &mut |p| n += p.runs.iter().filter(|r| r.props.ins.is_some() || r.props.del.is_some()).count());
        }
        n
    }

    /// Each More >> setting: switched off, its differences are not marked; on, they are.
    #[test]
    fn compare_honours_its_settings() {
        // Moves: a paragraph moved down is a move pair, or a deletion and an insertion.
        let (a, b) = (made("Alpha one.\nBeta two.\nGamma three.", &|_| {}), made("Beta two.\nGamma three.\nAlpha one.", &|_| {}));
        let moved = |on: bool| compared(&a, &b, json!({"moves": on})).doc.revisions.iter().filter(|r| r.move_name.is_some()).count();
        assert_eq!((moved(true), moved(false)), (2, 0));
        // Fields: a field whose code alone changed.
        let field = |instr: &str| made("Date ", &|s| {
            s.run("caret.docEnd", &json!({})).unwrap();
            s.run("insert.field", &json!({"instr": instr, "result": "1/1/2026"})).unwrap();
        });
        let (a, b) = (field(r#"DATE \@ "M/d/yyyy""#), field(r#"DATE \@ "d/M/yyyy""#));
        let n = |on: bool| tracked(&compared(&a, &b, json!({"fields": on})).doc, StoryRef::Body);
        assert!(n(true) > 0 && n(false) == 0, "fields {} {}", n(true), n(false));
        // Headers and footers.
        let (a, b) = (made("Body.", &|s| { s.run("insert.header", &json!({"text": "Old head"})).unwrap(); }), made("Body.", &|s| { s.run("insert.header", &json!({"text": "New head"})).unwrap(); }));
        let head = |on: bool| {
            let r = compared(&a, &b, json!({"headersFooters": on}));
            let id = r.doc.last_section.headers.default.unwrap();
            tracked(&r.doc, StoryRef::Part(id))
        };
        assert!(head(true) > 0 && head(false) == 0, "headers {} {}", head(true), head(false));
        // Footnotes.
        let note = |t: &str| made("Text.", &|s| {
            s.run("caret.docEnd", &json!({})).unwrap();
            s.run("references.footnote", &json!({"text": t})).unwrap();
        });
        let (a, b) = (note("Old note"), note("New note"));
        let notes = |on: bool| {
            let r = compared(&a, &b, json!({"footnotes": on}));
            r.doc.parts.iter().filter(|(_, p)| p.kind == ew_doc::PartKind::Footnote).map(|(id, _)| tracked(&r.doc, StoryRef::Part(*id))).sum::<usize>()
        };
        assert!(notes(true) > 0 && notes(false) == 0, "notes {} {}", notes(true), notes(false));
        // Comments: the revised document's comment comes over, or not.
        let (a, b) = (made("Same text.", &|_| {}), made("Same text.", &|s| {
            s.run("select.all", &json!({})).unwrap();
            s.run("review.newComment", &json!({"text": "A note"})).unwrap();
        }));
        let comments = |on: bool| compared(&a, &b, json!({"comments": on})).doc.comments.len();
        assert_eq!((comments(true), comments(false)), (1, 0));
        // Textboxes: a text box whose text alone changed, marked in the box (engine-compare-keep-3) or not at all.
        let boxed = |t: &str| made("Text.", &|s| {
            s.run("caret.docEnd", &json!({})).unwrap();
            s.run("insert.textBox", &json!({"text": t})).unwrap();
        });
        let (a, b) = (boxed("Old words"), boxed("New words"));
        let n = |on: bool| {
            let d = compared(&a, &b, json!({"textBoxes": on})).doc;
            let boxes = d.parts.iter().filter(|(_, p)| p.kind == ew_doc::PartKind::TextBox).map(|(id, _)| tracked(&d, StoryRef::Part(*id)));
            tracked(&d, StoryRef::Body) + boxes.sum::<usize>()
        };
        assert!(n(true) > 0 && n(false) == 0, "text boxes {} {}", n(true), n(false));
    }

    /// engine-compare-keep-2: what Compare's body and part comparisons rely on. The walk over the revised document's stories
    /// leaves every part, picture and comment the original holds as it was, adding only under ids and keys it did not use, and
    /// leaves no revised story referring to a part, comment or picture the original lacks.
    #[test]
    fn prepare_adds_to_the_original_only_what_it_lacked() {
        use ew_doc::para::InlineObject;
        let png = crate::cmd::insert::base64_encode(&{
            let img = image::RgbaImage::from_fn(4, 4, |x, y| image::Rgba([(x * 60) as u8, (y * 60) as u8, 9, 255]));
            let mut b = Vec::new();
            image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut b), image::ImageFormat::Png).unwrap();
            b
        });
        let full = |extra: bool| {
            made("Some text here.", &|s| {
                let body_end = |s: &mut Session| s.sel = crate::Selection::caret(s.doc.end_of(StoryRef::Body));
                s.run("insert.header", &json!({"text": "Head"})).unwrap();
                body_end(s);
                s.run("references.footnote", &json!({"text": "A note"})).unwrap();
                body_end(s);
                s.run("insert.picture", &json!({"data": png})).unwrap();
                if extra {
                    body_end(s);
                    s.run("references.footnote", &json!({"text": "Second note"})).unwrap();
                    body_end(s);
                    s.run("insert.textBox", &json!({"text": "Boxed"})).unwrap();
                    s.sel = crate::Selection { anchor: s.doc.start_of(StoryRef::Body), focus: ew_doc::Pos::body(0, 4) };
                    s.run("review.newComment", &json!({"text": "A comment"})).unwrap();
                }
            })
        };
        let (before, mut rev) = (full(false).doc, full(true).doc);
        let mut orig = before.clone();
        super::prepare(&mut orig, &mut rev, &super::Honour::of(&json!({})));
        for (id, p) in &before.parts {
            assert_eq!(orig.parts.get(id), Some(p), "part {id} as it was");
        }
        assert!(before.media.iter().all(|(k, b)| orig.media.get(k) == Some(b)) && before.comments.iter().all(|(k, c)| orig.comments.get(k) == Some(c)));
        // Every reference in every revised story is to the original now.
        let mut dangling = Vec::new();
        let mut stories: Vec<&ew_doc::Blocks> = vec![&rev.body];
        stories.extend(rev.parts.values().map(|p| &p.blocks));
        for blocks in stories {
            for b in blocks {
                crate::cmd::paste::each_para(&mut (**b).clone(), 0, &mut |p| {
                    for o in &p.objects {
                        let ok = match o {
                            InlineObject::Image { media, .. } => orig.media.contains_key(media.as_str()),
                            InlineObject::NoteRef { id, .. } => orig.parts.contains_key(id),
                            InlineObject::CommentStart { id } => orig.comments.contains_key(id),
                            o => o.text_boxes().iter().all(|id| orig.parts.contains_key(id)),
                        };
                        if !ok {
                            dangling.push(format!("{o:?}"));
                        }
                    }
                });
            }
        }
        assert!(dangling.is_empty(), "{dangling:?}");
        assert_eq!((orig.parts.len() - before.parts.len(), orig.comments.len()), (3, 1), "a text box, a note and a comment came over");
    }

    /// engine-fixes-edit: with Comments on, a paragraph both documents hold unchanged keeps the original's comment as well as
    /// the revised one's, each on its own text (Word keeps both documents' comments).
    #[test]
    fn compare_keeps_the_originals_comments_in_unchanged_paragraphs() {
        use ew_doc::para::InlineObject;
        let commented = |text: &str, at: (usize, usize), note: &str| {
            made(text, &|s| {
                s.sel = crate::Selection { anchor: ew_doc::Pos::body(0, at.0), focus: ew_doc::Pos::body(0, at.1) };
                s.run("review.newComment", &json!({"text": note})).unwrap();
            })
        };
        let (a, b) = (commented("Same text here.\nOther.", (0, 4), "Original note"), commented("Same text here.\nOther.", (10, 14), "Revised note"));
        let r = compared(&a, &b, json!({"comments": true}));
        let p = r.doc.body[0].as_para().unwrap();
        // Each comment's anchored text: what lies between its start and end marks.
        let anchored: Vec<(String, String)> = p
            .objects_with_offsets()
            .filter_map(|(off, o)| match o {
                InlineObject::CommentStart { id } => {
                    let end = p.objects_with_offsets().find(|(_, e)| matches!(e, InlineObject::CommentEnd { id: x } if x == id))?.0;
                    let text = p.text.get(off..end)?.chars().filter(|c| *c != ew_doc::para::OBJ).collect();
                    Some((r.doc.plain_text(StoryRef::Part(r.doc.comments.get(id)?.part)), text))
                }
                _ => None,
            })
            .collect();
        let mut anchored = anchored;
        anchored.sort();
        assert_eq!(anchored, vec![("Original note".into(), "Same".into()), ("Revised note".into(), "here".into())]);
        assert_eq!(p.plain_text(), "Same text here.");
        // A table both hold unchanged keeps the original's comment in its cell.
        let table = |note: Option<&str>| {
            made("Text.", &|s| {
                s.run("caret.docEnd", &json!({})).unwrap();
                s.run("insert.table", &json!({"rows": 1, "cols": 1})).unwrap();
                s.run("text.insert", &json!({"text": "Cell"})).unwrap();
                if let Some(note) = note {
                    s.sel.anchor.off = 0;
                    s.run("review.newComment", &json!({"text": note})).unwrap();
                }
            })
        };
        let r = compared(&table(Some("Cell note")), &table(None), json!({"comments": true}));
        let mut marks = 0;
        for b in &r.doc.body {
            crate::cmd::paste::each_para(&mut (**b).clone(), 0, &mut |p| {
                marks += p.objects.iter().filter(|o| matches!(o, InlineObject::CommentStart { .. })).count();
            });
        }
        assert_eq!(marks, 1, "the cell's comment stays");
    }
}
