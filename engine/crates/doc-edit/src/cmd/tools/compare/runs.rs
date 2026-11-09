//! EasyWriter engine-compare-keep: Compare's changed paragraphs, diffed over their stored text rather than their plain text, so
//! the result keeps what the paragraph holds, as Word's does. A token is a word with the spaces after it (or one character at
//! character level) or one inline object. Words both documents hold keep the revised runs and objects both hold stay, but an
//! object that changed in what its key leaves out (a picture's size, a control's lock) is deleted and inserted, so Accept All
//! gives the revised document and Reject All the original; deleted and inserted words keep their own formatting; a word whose
//! formatting alone changed is a formatting revision when Formatting is compared; and both documents' comment marks stay on their
//! words.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::ops::Range;

use ew_doc::para::{InlineObject, OBJ, Run};
use ew_doc::props::{CharProps, ParaProps};
use ew_doc::{Document, Paragraph, Revision, StoryRef};

use super::super::compare_parts::{Honour, anchor, object_text};
use super::{Differ, MAX_CHAR_DIFF, Op, collapse_noise_matches, lcs_ops};

/// A byte range of its side's text; an object's token is its one U+FFFC (`object`: the object's index).
struct Token {
    at: Range<usize>,
    object: Option<usize>,
}

/// One paragraph of the pair with its comment marks taken out: they anchor comments rather than being content, so they neither
/// match nor differ, and go back in after the diff (`marks`: each at its offset in `p.text`, with its formatting).
struct Side {
    p: Paragraph,
    runs: Vec<(Range<usize>, CharProps)>,
    tokens: Vec<Token>,
    marks: Vec<(usize, InlineObject, CharProps)>,
}

impl Side {
    fn new(p: &Paragraph, characters: bool) -> Side {
        let comment = |o: &InlineObject| matches!(o, InlineObject::CommentStart { .. } | InlineObject::CommentEnd { .. });
        let found: Vec<(usize, InlineObject, CharProps)> =
            p.objects_with_offsets().filter(|(_, o)| comment(o)).map(|(off, o)| (off, o.clone(), p.props_of_char(off).clone())).collect();
        let mut p = p.clone();
        for (off, _, _) in found.iter().rev() {
            let _ = p.delete(*off, off + OBJ.len_utf8());
        }
        // Each mark's offset once the marks before it are out.
        let marks = found.into_iter().enumerate().map(|(n, (off, o, c))| (off - n * OBJ.len_utf8(), o, c)).collect();
        let runs = p.run_ranges().map(|(r, c)| (r, c.clone())).collect();
        let tokens = tokens(&p.text, characters);
        Side { p, runs, tokens, marks }
    }

    /// Pushes the runs over `at` to `out`, cut to it, their formatting through `f`.
    fn push_runs(&self, at: &Range<usize>, f: &dyn Fn(&CharProps) -> CharProps, out: &mut Vec<Run>) {
        let from = self.runs.partition_point(|(r, _)| r.end <= at.start);
        for (r, c) in self.runs.get(from..).unwrap_or_default().iter().take_while(|(r, _)| r.start < at.end) {
            out.push(Run { len: r.end.min(at.end) - r.start.max(at.start), props: f(c) });
        }
    }

    fn text(&self, t: &Token) -> &str {
        self.p.text.get(t.at.clone()).unwrap_or_default()
    }

    fn object(&self, t: &Token) -> Option<&InlineObject> {
        t.object.and_then(|k| self.p.objects.get(k))
    }
}

/// `text`'s tokens in order, covering it.
fn tokens(text: &str, characters: bool) -> Vec<Token> {
    let mut out = Vec::new();
    let (mut start, mut k) = (0, 0);
    for (i, c) in text.char_indices() {
        let end = i + c.len_utf8();
        if c == OBJ {
            if start < i {
                out.push(Token { at: start..i, object: None });
            }
            out.push(Token { at: i..end, object: Some(k) });
            k += 1;
            start = end;
        } else if characters || c == ' ' {
            out.push(Token { at: start..end, object: None });
            start = end;
        }
    }
    if start < text.len() {
        out.push(Token { at: start..text.len(), object: None });
    }
    out
}

/// A hash of the bytes `doc` holds under media key `key`: the same bytes under two keys hash the same. A key `doc` holds no
/// bytes for is itself, so it matches only the same key.
fn bytes_hash(doc: &Document, key: &str) -> String {
    let Some(bytes) = doc.media.get(key) else { return format!("missing\u{1}{key}") };
    let mut hash = DefaultHasher::new();
    bytes.hash(&mut hash);
    format!("{:x}", hash.finish())
}

/// What an inline object compares as: its kind, what names it, and its text (compare_parts::object_text: a field's result and
/// code when fields are compared, a text box's text when text boxes are). A picture is named by its bytes, so the same picture
/// matches whatever each document calls it.
fn object_key(doc: &Document, o: &InlineObject, h: &Honour) -> String {
    let name = match o {
        InlineObject::Image { media, .. } => bytes_hash(doc, media),
        InlineObject::NoteRef { kind, id, custom } => format!("{kind:?} {id} {custom}"),
        InlineObject::ControlStart { control } => format!("{}\u{1}{}", control.tag, control.title),
        InlineObject::BookmarkStart { name } | InlineObject::BookmarkEnd { name } => name.clone(),
        InlineObject::PermStart { id, .. } | InlineObject::PermEnd { id } => id.to_string(),
        _ => String::new(),
    };
    let mut text = String::new();
    object_text(o, h, &|id| doc.plain_text(StoryRef::Part(id)), &mut text);
    format!("{OBJ}{:?}\u{1}{name}\u{1}{text}", std::mem::discriminant(o))
}

/// Whether objects `a` and `b` of `doc`, whose keys matched, are the same object once what names them is set aside: every
/// picture it holds (its own, its layer, its PNG and Word copies, a fill's, a group member's) compares by its bytes, and the
/// key holds a text box's text already (when compared). A field is the same whatever it holds when fields are not compared.
fn same_object(doc: &Document, a: &InlineObject, b: &InlineObject, h: &Honour) -> bool {
    let plain = |o: &InlineObject| {
        let mut o = o.clone();
        for slot in o.text_box_slots() {
            *slot = None;
        }
        o.rename_media(&mut |key| bytes_hash(doc, key));
        match &mut o {
            InlineObject::ControlStart { control } => control.id = None,
            InlineObject::Field { .. } if !h.fields => return None,
            _ => {}
        }
        Some(o)
    };
    plain(a) == plain(b)
}

/// The revised document's formatting without its tracked changes: their revisions are that document's, and the comparison's
/// own take their place.
fn revised(c: &CharProps) -> CharProps {
    CharProps { ins: None, del: None, fmt_change: None, ..c.clone() }
}

/// The result as it is built, and `before`: runs over the same text with the formatting the original gave it (where the
/// original has no such text, the result's own), which the formatting comparison reads.
#[derive(Default)]
struct Built {
    text: String,
    runs: Vec<Run>,
    before: Vec<Run>,
    objects: Vec<InlineObject>,
}

impl Built {
    /// Token `t` of `side` copied whole, its runs' formatting through `f`.
    fn take(&mut self, side: &Side, t: &Token, f: &dyn Fn(&CharProps) -> CharProps) {
        self.text.push_str(side.text(t));
        self.objects.extend(side.object(t).cloned());
        let from = self.runs.len();
        side.push_runs(&t.at, f, &mut self.runs);
        self.before.extend(self.runs.get(from..).unwrap_or_default().iter().cloned());
    }

    /// Token `ta` of the original matched with token `tb` of the revised, both objects or both words. An object is the
    /// original's (the two are the same object, [`same_object`]); words are the revised ones. Either takes the revised
    /// formatting.
    fn same(&mut self, (sa, ta): (&Side, &Token), (sb, tb): (&Side, &Token)) {
        if let Some(o) = sa.object(ta) {
            self.text.push(OBJ);
            self.objects.push(o.clone());
            self.runs.push(Run { len: OBJ.len_utf8(), props: revised(sb.p.props_of_char(tb.at.start)) });
            self.before.push(Run { len: OBJ.len_utf8(), props: sa.p.props_of_char(ta.at.start).clone() });
            return;
        }
        let text = sb.text(tb);
        self.text.push_str(text);
        sb.push_runs(&tb.at, &revised, &mut self.runs);
        // The original's runs where its words are byte for byte the revised ones; matched up to case or spacing, the
        // formatting it starts with.
        if sa.text(ta) == text {
            sa.push_runs(&ta.at, &CharProps::clone, &mut self.before);
        } else {
            self.before.push(Run { len: text.len(), props: sa.p.props_of_char(ta.at.start).clone() });
        }
    }
}

/// `p`'s characters: each one's offset, the character, and whether it is an anchor's (compare_parts::anchor).
fn content(p: &Paragraph) -> Vec<(usize, char, bool)> {
    let mut objects = p.objects.iter();
    p.text.char_indices().map(|(i, c)| (i, c, c == OBJ && objects.next().is_some_and(anchor))).collect()
}

/// Where offset `x` of a side's text lands in the result, from that side's (token, result) ranges in order: as far into its
/// token's copy as it was into the token, or after the side's last token.
fn place(segs: &[(Range<usize>, Range<usize>)], x: usize) -> usize {
    let k = segs.partition_point(|(s, _)| s.end <= x);
    match segs.get(k) {
        Some((s, o)) => o.start + x.saturating_sub(s.start).min(o.len()),
        None => segs.last().map_or(0, |(_, o)| o.end),
    }
}

impl Differ<'_> {
    /// What paragraph `p` of `doc` compares as: its text with each object as its key ([`object_key`]: its kind and, for a
    /// picture, its bytes), so an object added or taken out anywhere in it is a change. Anchors are left out
    /// (compare_parts::anchor).
    pub(super) fn para_key(&self, doc: &Document, p: &Paragraph) -> String {
        let mut out = String::with_capacity(p.text.len());
        let mut objects = p.objects.iter();
        for c in p.text.chars() {
            if c != OBJ {
                out.push(c);
            } else if let Some(o) = objects.next().filter(|o| !anchor(o)) {
                out.push_str(&object_key(doc, o, self.honour));
            }
        }
        self.opts.key(&out)
    }

    /// What token `t` compares as. An object's key starts with U+FFFC, which no word holds, so a match pairs objects with
    /// objects and words with words ([`Built::same`] relies on it). A text box's text is left out: a box matched with a box
    /// has its story compared as a paragraph's text is (Differ::box_stories).
    fn token_key(&self, doc: &Document, side: &Side, t: &Token) -> String {
        match side.object(t) {
            Some(o) => self.opts.key(&object_key(doc, o, &Honour { text_boxes: false, ..*self.honour })),
            None => self.opts.key(side.text(t)),
        }
    }

    /// `ops` over `sa` and `sb` with each matched pair of objects that are not the same object ([`same_object`]) deleted and
    /// inserted.
    fn split_changed_objects(&self, doc: &Document, ops: &[Op], sa: &Side, sb: &Side) -> Vec<Op> {
        let mut out = Vec::with_capacity(ops.len());
        let (mut i, mut j) = (0, 0);
        for &op in ops {
            let pair = (sa.tokens.get(i).and_then(|t| sa.object(t)), sb.tokens.get(j).and_then(|t| sb.object(t)));
            match (op, pair) {
                (Op::Same, (Some(a), Some(b))) if !same_object(doc, a, b, self.honour) => out.extend([Op::Del, Op::Ins]),
                _ => out.push(op),
            }
            i += usize::from(op != Op::Ins);
            j += usize::from(op != Op::Del);
        }
        out
    }

    /// Whether paragraphs `a` and `b` of `doc`, whose keys matched, hold an object that changed in what the key leaves out
    /// ([`same_object`]): then they are a changed pair, so the change is tracked. Anchors are left out, as the key leaves them out.
    pub(super) fn objects_changed(&self, doc: &Document, a: &Paragraph, b: &Paragraph) -> bool {
        let objects = |p: &Paragraph| -> Vec<InlineObject> { p.objects.iter().filter(|o| !anchor(o)).cloned().collect() };
        let (oa, ob) = (objects(a), objects(b));
        oa.len() == ob.len() && oa.iter().zip(&ob).any(|(x, y)| !same_object(doc, x, y, self.honour))
    }

    /// `b`'s text with the formatting `a` gives each character, for paragraphs whose keys matched ([`Self::para_key`]: their
    /// texts differ only in anchors, and in case or spacing when those are not compared), so the formatting comparison reads
    /// both over the same text. An anchor of `b` keeps its own formatting; spacing the key collapses takes the original's.
    pub(super) fn lined_up(&self, a: &Paragraph, b: &Paragraph) -> Paragraph {
        let space = |c: char| !self.opts.white_space && c.is_whitespace();
        let from: Vec<(usize, char)> = content(a).into_iter().filter(|(_, _, x)| !x).map(|(i, c, _)| (i, c)).collect();
        let props = |k: usize| from.get(k.min(from.len().saturating_sub(1))).map_or_else(|| a.mark.clone(), |(i, _)| a.props_of_char(*i).clone());
        let mut k = 0;
        let mut runs = Vec::new();
        for (i, c, anchored) in content(b) {
            let props = if anchored {
                b.props_of_char(i).clone()
            } else if space(c) {
                // A space for a space while the original has one; past its spaces, the formatting of the last.
                let at = if from.get(k).is_some_and(|(_, x)| space(*x)) { k } else { k.saturating_sub(1) };
                k = at + 1;
                props(at)
            } else {
                while from.get(k).is_some_and(|(_, x)| space(*x)) {
                    k += 1;
                }
                k += 1;
                props(k - 1)
            };
            runs.push(Run { len: c.len_utf8(), props });
        }
        let mut p = Paragraph::new();
        (p.text, p.runs, p.props, p.mark) = (b.text.clone(), runs, a.props.clone(), a.mark.clone());
        p.normalize();
        p
    }

    /// The changed pair `a` and `b`, both referring to `doc` (compare_parts::prepare) → the result paragraph, deletions and
    /// insertions tracked as `self.del` and `self.ins`, formatting changes (when compared) added to `revisions`.
    pub(super) fn changed_para(&mut self, revisions: &mut Vec<Revision>, doc: &Document, a: &Paragraph, b: &Paragraph) -> Paragraph {
        let chars = self.opts.characters && a.text.chars().count().max(b.text.chars().count()) <= MAX_CHAR_DIFF;
        let (sa, sb) = (Side::new(a, chars), Side::new(b, chars));
        let ka: Vec<String> = sa.tokens.iter().map(|t| self.token_key(doc, &sa, t)).collect();
        let kb: Vec<String> = sb.tokens.iter().map(|t| self.token_key(doc, &sb, t)).collect();
        let ops = lcs_ops(&ka, &kb, &mut self.budget);
        // Only at character level: a matched whole word almost never happens by coincidence, but a matched single character
        // very often does (digits, punctuation), so only there does a short interior match need folding into its edit.
        let ops = if chars { collapse_noise_matches(&ops) } else { ops };
        let ops = self.split_changed_objects(doc, &ops, &sa, &sb);
        let (ins, del) = (self.ins, self.del);
        let mut out = Built::default();
        // Each side's (token, result) ranges, to put the comment marks back.
        let (mut segs_a, mut segs_b) = (Vec::new(), Vec::new());
        let (mut i, mut j) = (0, 0);
        for op in ops {
            let (ta, tb) = (sa.tokens.get(i), sb.tokens.get(j));
            let start = out.text.len();
            match (op, ta, tb) {
                (Op::Same, Some(ta), Some(tb)) => {
                    // The result shows the original's object, its text boxes holding the comparison of both.
                    if let (Some(x), Some(y)) = (sa.object(ta), sb.object(tb)) {
                        self.box_stories(revisions, doc, x, y, x);
                    }
                    out.same((&sa, ta), (&sb, tb))
                }
                (Op::Del, Some(ta), _) => out.take(&sa, ta, &|c| CharProps { del: Some(del), ..c.clone() }),
                (Op::Ins, _, Some(tb)) => out.take(&sb, tb, &|c| CharProps { ins: Some(ins), ..revised(c) }),
                _ => break,
            }
            let at = start..out.text.len();
            if op != Op::Ins
                && let Some(ta) = ta
            {
                segs_a.push((ta.at.clone(), at.clone()));
                i += 1;
            }
            if op != Op::Del
                && let Some(tb) = tb
            {
                segs_b.push((tb.at.clone(), at));
                j += 1;
            }
        }
        let Built { text, runs, before, objects } = out;
        let mut p = Paragraph::new();
        (p.text, p.runs, p.objects) = (text, runs, objects);
        p.props = ParaProps { fmt_change: None, ..b.props.clone() };
        p.mark = revised(&b.mark);
        // The original's section break: its headers and footers are this document's.
        p.section = a.section.clone();
        p.normalize();
        if self.opts.formatting {
            let mut old = Paragraph::new();
            (old.text, old.runs, old.props, old.mark) = (p.text.clone(), before, a.props.clone(), a.mark.clone());
            old.normalize();
            crate::cmd::fmt_revisions::compare_formatting(&old, &mut p, revisions, self.author, self.date);
        }
        // Both documents' comment marks back on their text (the original's only when comments are compared, as for a paragraph
        // both hold; the revised document's are gone already when they are not), the original's first where they meet.
        let mut marks: Vec<(usize, InlineObject, CharProps)> = Vec::new();
        if self.honour.comments {
            marks.extend(sa.marks.into_iter().map(|(x, o, c)| (place(&segs_a, x), o, c)));
        }
        marks.extend(sb.marks.into_iter().map(|(x, o, c)| (place(&segs_b, x), o, revised(&c))));
        marks.sort_by_key(|m| m.0);
        // Last first, so the places still to fill keep their offsets.
        for (at, o, c) in marks.into_iter().rev() {
            let at = p.clamp(at);
            let _ = p.insert_object(at, o, &c);
        }
        p
    }
}
