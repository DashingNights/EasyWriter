use super::{Arc, Block, CharProps, CmdError, CmdResult, Document, RevisionKind, Selection, Session, StoryRef, Value, json, p, para_block};

pub(super) mod embedded;
mod runs;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod keep_tests;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod keep3_tests;

/// Compare and Combine take the same settings.
pub(super) const COMPARE_PARAMS: &str = r#"{"path"?: string (revised document), "text"?: string (revised text), "revisedData"?: string (the revised document's bytes in base64), "revisedKind"?: "docx|engine" (default docx; engine: the engine's own JSON), "original"?: string (original document; default: this one), "originalData"?: string, "originalKind"?: "docx|engine" (the original from bytes, as the revised),"author"?: string (label changes with), "caseChanges"?: bool, "whiteSpace"?: bool, "formatting"?: bool (default true: differences count), "level"?: "word|character", "showIn"?: "original|revised|new" (revised/new: an untitled document), "moves"|"comments"|"tables"|"headersFooters"|"footnotes"|"textBoxes"|"fields"?: bool (each on unless false: moved paragraphs as moves, the revised comments, headers and footers, footnotes and endnotes, text box text, field codes; tables are always compared)}"#;

/// What Compare / Combine compares (the More >> settings of Word's dialog).
struct CompareOptions {
    /// Differences only in letter case count as changes.
    case: bool,
    /// Differences only in white space count as changes.
    white_space: bool,
    /// Formatting differences become tracked formatting changes.
    formatting: bool,
    /// Changed paragraphs are compared character by character (else word by word).
    characters: bool,
}

impl CompareOptions {
    /// The text a comparison sees: case folded and white space collapsed as the options say.
    fn key(&self, t: &str) -> String {
        let t = if self.white_space { t.to_string() } else { t.split_whitespace().collect::<Vec<_>>().join(" ") };
        if self.case { t } else { t.to_lowercase() }
    }
}

/// EasyWriter engine-gaps-rest: compares block lists (the body, then each pair of headers, footers and notes) with one set
/// of settings and revisions, counting the changes.
struct Differ<'a> {
    opts: &'a CompareOptions,
    honour: &'a super::compare_parts::Honour,
    ins: u32,
    del: u32,
    author: &'a str,
    date: &'a str,
    budget: u64,
    changes: usize,
    /// Text boxes compared so far: the part the result's box shows and its blocks, written once every story is compared.
    boxes: Vec<(u32, Vec<Arc<Block>>)>,
    /// How many text boxes deep the comparison is (a box can hold a box, or itself in a hostile file).
    box_depth: usize,
}

/// Most text boxes inside text boxes compared; deeper ones keep the revised text.
const MAX_BOX_DEPTH: usize = 16;

impl Differ<'_> {
    /// What block `b` of `doc` compares as: a paragraph's key (runs.rs), or a table's, which matches as a whole by its
    /// paragraphs' keys, however deep its tables nest.
    fn key(&self, doc: &Document, b: &Block) -> String {
        flat(b, "\u{0}table\u{0}", &mut |p| self.para_key(doc, p))
    }

    /// A paragraph both documents hold (their keys matched): the revised one with its formatting changes tracked (when
    /// compared, also where the texts differ in what the key leaves out), the original's comments kept (when compared) and its
    /// text boxes compared; or a changed pair when an object in it changed.
    fn matched_para(&mut self, revisions: &mut Vec<ew_doc::Revision>, doc: &Document, pa: &ew_doc::Paragraph, pb: &ew_doc::Paragraph) -> ew_doc::Paragraph {
        if self.objects_changed(doc, pa, pb) {
            self.changes += 1;
            return self.changed_para(revisions, doc, pa, pb);
        }
        self.text_boxes(revisions, doc, pa, pb);
        let mut p = pb.clone();
        if self.opts.formatting {
            let before = revisions.len();
            // Texts that differ only in what the key leaves out (a bookmark, a comment, case or spacing as set) compare their
            // formatting character by character, lined up as the key lines them up.
            let lined_up = (pa.text != pb.text).then(|| self.lined_up(pa, pb));
            crate::cmd::fmt_revisions::compare_formatting(lined_up.as_ref().unwrap_or(pa), &mut p, revisions, self.author, self.date);
            if revisions.len() > before || p != *pb {
                self.changes += 1;
            }
        }
        if self.honour.comments {
            super::compare_parts::keep_para_comments(pa, &mut p);
        }
        p
    }

    /// The text boxes of matched paragraphs `a` and `b` (their objects pair in order, as their keys matched), each box's story
    /// compared as the body is, into the revised box the result shows.
    fn text_boxes(&mut self, revisions: &mut Vec<ew_doc::Revision>, doc: &Document, a: &ew_doc::Paragraph, b: &ew_doc::Paragraph) {
        let objects = |p: &ew_doc::Paragraph| p.objects.iter().filter(|o| !super::compare_parts::anchor(o)).cloned().collect::<Vec<_>>();
        for (x, y) in objects(a).iter().zip(&objects(b)) {
            self.box_stories(revisions, doc, x, y, y);
        }
    }

    /// Each text box of object `a` compared with the one in its place in `b` (when text boxes are compared), into the part
    /// `result`, the object the result shows, has there.
    fn box_stories(&mut self, revisions: &mut Vec<ew_doc::Revision>, doc: &Document, a: &ew_doc::para::InlineObject, b: &ew_doc::para::InlineObject, result: &ew_doc::para::InlineObject) {
        if !self.honour.text_boxes || self.box_depth >= MAX_BOX_DEPTH {
            return;
        }
        let story = |id: u32| doc.parts.get(&id).map(|p| p.blocks.clone()).unwrap_or_default();
        for ((x, y), into) in a.text_boxes().into_iter().zip(b.text_boxes()).zip(result.text_boxes()) {
            self.box_depth += 1;
            let blocks = self.blocks(revisions, doc, &story(x), &story(y));
            self.box_depth -= 1;
            self.boxes.push((into, blocks));
        }
    }

    /// `old` compared with `new`, both referring to `doc` (compare_parts::prepare): the result, its differences tracked in
    /// `revisions`.
    fn blocks(&mut self, revisions: &mut Vec<ew_doc::Revision>, doc: &Document, old: &[Arc<Block>], new: &[Arc<Block>]) -> Vec<Arc<Block>> {
        let (ins, del) = (self.ins, self.del);
        let keys = |blocks: &[Arc<Block>]| blocks.iter().map(|b| self.key(doc, b)).collect::<Vec<_>>();
        let (ka, kb) = (keys(old), keys(new));
        let ops = lcs_ops(&ka, &kb, &mut self.budget);
        let mut out: Vec<Arc<Block>> = Vec::new();
        let (mut i, mut j) = (0usize, 0usize);
        let mut k = 0;
        while k < ops.len() {
            match ops.get(k) {
                Some(Op::Same) => {
                    let (a, b) = (old.get(i), new.get(j));
                    match (a.map(|x| &**x), b.map(|x| &**x)) {
                        (Some(Block::Para(pa)), Some(Block::Para(pb))) => out.push(para_block(self.matched_para(revisions, doc, pa, pb))),
                        // A table matched whole: the revised one, each paragraph matched with the original's in its place.
                        (Some(a), Some(b)) => {
                            let mut x = b.clone();
                            super::compare_parts::pair_paras(a, &mut x, &mut |pa, p| *p = self.matched_para(revisions, doc, pa, p));
                            out.push(Arc::new(x));
                        }
                        _ => out.extend(b.or(a).cloned()),
                    }
                    i += 1;
                    j += 1;
                    k += 1;
                }
                Some(_) => {
                    // A run of deletions and insertions: changed paragraphs pair up and are diffed
                    // word by word (or by character, runs.rs); the rest are deleted or inserted whole.
                    let run = ops.get(k..).unwrap_or_default().iter().take_while(|o| **o != Op::Same).count();
                    let dels = ops.get(k..k + run).unwrap_or_default().iter().filter(|o| **o == Op::Del).count();
                    let inss = run - dels;
                    for x in 0..dels.max(inss) {
                        let (a, b) = (if x < dels { old.get(i + x) } else { None }, if x < inss { new.get(j + x) } else { None });
                        match (a.map(|x| &**x), b.map(|x| &**x)) {
                            (Some(Block::Para(pa)), Some(Block::Para(pb))) => out.push(para_block(self.changed_para(revisions, doc, pa, pb))),
                            _ => {
                                if let Some(x) = a {
                                    out.push(Arc::new(mark_block(x, &|c| c.del = Some(del))));
                                }
                                if let Some(x) = b {
                                    out.push(Arc::new(mark_block(x, &|c| c.ins = Some(ins))));
                                }
                            }
                        }
                        self.changes += 1;
                    }
                    i += dels;
                    j += inss;
                    k += run.max(1);
                }
                None => break,
            }
        }
        out
    }
}

/// Changed paragraphs longer than this (in characters) are compared word by word even at
/// character level, so the comparison table stays small.
const MAX_CHAR_DIFF: usize = 2000;

/// Compare the current document (original, or `original` from a file) with a revised one: the
/// result shows the differences as tracked insertions, deletions and formatting changes, labelled
/// with `author`. EasyWriter engine-gaps-rest: Word's More >> settings (moves, comments, headers and footers, footnotes,
/// text boxes, fields) are honoured (compare_parts.rs); `notHonoured` stays empty for callers that read it.
pub(super) fn compare(s: &mut Session, v: &Value) -> CmdResult {
    let revised = if let Some(t) = p::str(v, "text") {
        Document::from_text(t)
    } else if let Some(doc) = doc_of_bytes(v, "revisedData", "revisedKind", "docx")? {
        doc
    } else if let Some(path) = p::str(v, "path") {
        crate::io::open_path(std::path::Path::new(path)).map_err(CmdError::Failed)?
    } else {
        return Err(CmdError::Params("`path`, `text` or `revisedData` of the revised document is required".into()));
    };
    let show_in = p::str(v, "showIn").unwrap_or("original");
    if !matches!(show_in, "original" | "revised" | "new") {
        return Err(CmdError::Params("`showIn` is \"original\", \"revised\" or \"new\"".into()));
    }
    let original = match doc_of_bytes(v, "originalData", "originalKind", "docx")? {
        Some(doc) => Some(doc),
        None => p::str(v, "original").map(|path| crate::io::open_path(std::path::Path::new(path)).map_err(CmdError::Failed)).transpose()?,
    };
    if let Some(doc) = original {
        s.doc = doc;
        s.doc.ensure_nonempty();
        s.note_body_replaced();
        s.math = None;
    }
    let level = p::str(v, "level").unwrap_or("word");
    let opts = CompareOptions {
        case: p::bool(v, "caseChanges").unwrap_or(true),
        white_space: p::bool(v, "whiteSpace").unwrap_or(true),
        formatting: p::bool(v, "formatting").unwrap_or(true),
        characters: matches!(level, "character" | "char"),
    };
    // EasyWriter engine-gaps-rest: the More >> settings (compare_parts.rs), every one honoured.
    let honour = super::compare_parts::Honour::of(v);
    let not_honoured: Vec<&str> = Vec::new();
    let mut revised = revised;
    let pairs = super::compare_parts::prepare(&mut s.doc, &mut revised, &honour);
    let author = p::str(v, "author").map(str::trim).filter(|a| !a.is_empty()).map(str::to_string).unwrap_or_else(|| s.author.clone());
    let date = crate::cmd::now_iso();
    s.doc.revisions.push(ew_doc::Revision { kind: RevisionKind::Insert, author: author.clone(), date: date.clone(), move_name: None, tag: None });
    let ins = (s.doc.revisions.len() - 1) as u32;
    s.doc.revisions.push(ew_doc::Revision { kind: RevisionKind::Delete, author: author.clone(), date: date.clone(), move_name: None, tag: None });
    let del = (s.doc.revisions.len() - 1) as u32;
    let mut d = Differ { opts: &opts, honour: &honour, ins, del, author: &author, date: &date, budget: MAX_COMPARE_CELLS, changes: 0, boxes: Vec::new(), box_depth: 0 };
    let mut revisions = std::mem::take(&mut s.doc.revisions);
    // Every revised story's pictures, notes, comments and text boxes are the original document's now (prepare).
    let mut out = d.blocks(&mut revisions, &s.doc, &s.doc.body, &revised.body);
    // Headers, footers and notes compared as the body is; text boxes as the paragraphs showing them were.
    for (id, new) in pairs {
        let old = s.doc.parts.get(&id).map(|p| p.blocks.clone()).unwrap_or_default();
        let blocks = d.blocks(&mut revisions, &s.doc, &old, &new);
        if let Some(p) = s.doc.parts.get_mut(&id) {
            p.blocks = blocks;
        }
    }
    for (id, blocks) in std::mem::take(&mut d.boxes) {
        if let Some(p) = s.doc.parts.get_mut(&id) {
            p.blocks = blocks;
        }
    }
    if honour.moves {
        super::compare_parts::mark_moves(&mut out, &mut revisions, (ins, del));
    }
    s.doc.revisions = revisions;
    let changes = d.changes;
    s.doc.body = out;
    // The text boxes no story shows any more: the original's own where the revised paragraph was taken, and the revised ones
    // whose comparison went into the original's box.
    s.doc.prune_text_boxes();
    s.doc.ensure_nonempty();
    s.note_body_replaced();
    s.math = None;
    if show_in != "original" || p::str(v, "original").is_some() || p::str(v, "originalData").is_some() {
        // The result is a new, untitled document: saving it never overwrites either file.
        s.path = None;
        s.file_name = None;
        // Version snapshots belong to the document they were taken from, including when
        // Compare creates an untitled result from the current document.
        s.clear_versions();
    }
    s.sel = Selection::caret(s.doc.start_of(StoryRef::Body));
    Ok(json!({"changes": changes, "author": author, "notHonoured": not_honoured}))
}

/// EasyWriter engine-canvas-read (G37): the document in `v[data]`, base64 bytes of kind `v[kind]` (else `default`): 'docx', or
/// 'engine' for the engine's own JSON, brought to the current schema. None when `data` is absent. Another draft reaches a command this way.
fn doc_of_bytes(v: &Value, data: &str, kind: &str, default: &str) -> Result<Option<Document>, CmdError> {
    let Some(b64) = p::str(v, data) else { return Ok(None) };
    let bytes = crate::cmd::insert::base64_decode(b64).ok_or_else(|| CmdError::Params(format!("{data}: base64")))?;
    let engine = match p::str(v, kind).unwrap_or(default) {
        "docx" => false,
        "engine" => true,
        other => return Err(CmdError::Params(format!("{kind}: docx or engine, not {other}"))),
    };
    let mut doc = crate::io::open_bytes(if engine { "document.json" } else { "document.docx" }, &bytes).map_err(CmdError::Failed)?;
    if engine {
        doc.upgrade().map_err(CmdError::Failed)?;
    }
    Ok(Some(doc))
}

pub(super) const RESTORE_PARAMS: &str = r#"{"data": string (the version's bytes in base64), "kind"?: "docx|engine" (default engine)}"#;

/// EasyWriter engine-canvas-read (G37): File > Info > Version History's Restore of a version the app keeps (a draft's backup),
/// given as bytes: the whole document becomes that version in one undo step, its protection staying the live document's, as
/// `file.versions` restores a snapshot.
pub(super) fn restore_version(s: &mut Session, v: &Value) -> CmdResult {
    let d = doc_of_bytes(v, "data", "kind", "engine")?.ok_or_else(|| CmdError::Params("data: the version's bytes".into()))?;
    crate::cmd::protect::check_version_restore(s)?;
    let settings = &s.doc.settings;
    let (protection, hash, formatting) = (settings.protection.clone(), settings.protect_hash.clone(), settings.protect_formatting);
    s.doc = d;
    s.doc.ensure_nonempty();
    s.doc.settings.protection = protection;
    s.doc.settings.protect_hash = hash;
    s.doc.settings.protect_formatting = formatting;
    s.note_body_replaced();
    s.math = None;
    s.touch();
    s.clamp_selection();
    Ok(json!({}))
}

/// A block's text (a table's cells in order), for matching blocks.
pub(crate) fn block_text(b: &Block) -> String {
    flat(b, "", &mut |p| p.plain_text())
}

/// Block `b` as one string: a paragraph as `para` gives it; a table as `table`, then each block of its cells in order,
/// separated by tabs, however deep its tables nest (no stack frame per level).
fn flat(b: &Block, table: &str, para: &mut dyn FnMut(&ew_doc::Paragraph) -> String) -> String {
    enum Next<'a> {
        Block(&'a Block),
        Tab,
    }
    let mut out = String::new();
    let mut todo = vec![Next::Block(b)];
    while let Some(n) = todo.pop() {
        match n {
            Next::Tab => out.push('\t'),
            Next::Block(Block::Para(p)) => out.push_str(&para(p)),
            Next::Block(b) => {
                out.push_str(table);
                let lists = b.lists();
                let inner: Vec<&Block> = lists.iter().flat_map(|(_, _, l)| l.iter().map(|x| &**x)).collect();
                // Last first, so they come off the stack in order.
                for (k, x) in inner.into_iter().enumerate().rev() {
                    todo.push(Next::Block(x));
                    if k > 0 {
                        todo.push(Next::Tab);
                    }
                }
            }
        }
    }
    out
}

/// A copy of the block with every run (in tables, every cell's at any depth) changed by `f`.
fn mark_block(b: &Block, f: &dyn Fn(&mut CharProps)) -> Block {
    let mut b = b.clone();
    crate::cmd::paste::each_para(&mut b, 0, &mut |p| {
        let len = p.len();
        let _ = p.format(0, len, f);
    });
    b
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Op {
    Same,
    Del,
    Ins,
}

/// Longest sequence the comparison table is built for; the rest of a longer sequence is
/// compared as deleted and inserted, never dropped.
const MAX_LCS: usize = 4000;

/// Comparison table cells one compare may fill over all its tables (blocks and every changed
/// paragraph pair); once spent, the remaining middles are compared as deleted and inserted.
const MAX_COMPARE_CELLS: u64 = 50_000_000;

/// LCS edit script between two sequences: the common start and end are matched first, then the
/// middle (bounded size). The middle's table is charged to `budget`; when it doesn't fit, the
/// middle is deleted and inserted whole.
pub(super) fn lcs_ops<T: PartialEq>(a: &[T], b: &[T], budget: &mut u64) -> Vec<Op> {
    let pre = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let (ra, rb) = (a.get(pre..).unwrap_or_default(), b.get(pre..).unwrap_or_default());
    let suf = ra.iter().rev().zip(rb.iter().rev()).take_while(|(x, y)| x == y).count();
    let (a, b) = (ra.get(..ra.len() - suf).unwrap_or_default(), rb.get(..rb.len() - suf).unwrap_or_default());
    let mut ops = vec![Op::Same; pre];
    let (mut n, mut m) = (a.len().min(MAX_LCS), b.len().min(MAX_LCS));
    let cells = (n as u64).saturating_mul(m as u64);
    if cells > *budget {
        (n, m) = (0, 0);
    } else {
        *budget -= cells;
    }
    let mut t = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            let v = if a.get(i) == b.get(j) {
                t.get(i + 1).and_then(|r| r.get(j + 1)).copied().unwrap_or(0) + 1
            } else {
                t.get(i + 1).and_then(|r| r.get(j)).copied().unwrap_or(0).max(t.get(i).and_then(|r| r.get(j + 1)).copied().unwrap_or(0))
            };
            if let Some(c) = t.get_mut(i).and_then(|r| r.get_mut(j)) {
                *c = v;
            }
        }
    }
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a.get(i) == b.get(j) {
            ops.push(Op::Same);
            i += 1;
            j += 1;
        } else if t.get(i + 1).and_then(|r| r.get(j)) >= t.get(i).and_then(|r| r.get(j + 1)) {
            ops.push(Op::Del);
            i += 1;
        } else {
            ops.push(Op::Ins);
            j += 1;
        }
    }
    ops.extend(std::iter::repeat_n(Op::Del, a.len() - i));
    ops.extend(std::iter::repeat_n(Op::Ins, b.len() - j));
    ops.extend(std::iter::repeat_n(Op::Same, suf));
    ops
}

/// How short an interior match can be, inside a run of edits, before it's folded into the
/// surrounding delete/insert instead of staying its own little island of "same" text. Two short
/// strings that happen to share a character in a different order (common with digits in dates,
/// IDs, phone numbers) otherwise come out of `lcs_ops` as a true shortest edit script, but render
/// as a "ransom note" of alternating single-character deletions and insertions where a reader
/// (and Word) would expect one clean replacement.
const NOISE_MATCH_LEN: usize = 1;

/// Folds single-token matches that sit strictly inside a run of edits into the surrounding
/// delete/insert, so a character-level diff doesn't fragment a replaced run. A matched run that
/// opens or closes the whole sequence is the genuine common prefix/suffix `lcs_ops` already
/// stripped before running its table, so it's left untouched regardless of length; only a short
/// match produced by the table's own backtracking, which can only ever be interior, is a
/// candidate.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Keep,
    Fold,
}

pub(super) fn collapse_noise_matches(ops: &[Op]) -> Vec<Op> {
    let mut runs: Vec<(Op, usize, Kind)> = Vec::new();
    let mut k = 0;
    while k < ops.len() {
        let op = ops[k];
        let len = ops[k..].iter().take_while(|o| **o == op).count();
        let kind = if op == Op::Same && k != 0 && k + len != ops.len() && len <= NOISE_MATCH_LEN { Kind::Fold } else { Kind::Keep };
        runs.push((op, len, kind));
        k += len;
    }
    if !runs.iter().any(|(_, _, kind)| *kind == Kind::Fold) {
        return ops.to_vec();
    }
    let mut out = Vec::with_capacity(ops.len());
    let mut i = 0;
    while i < runs.len() {
        if runs[i].0 == Op::Same && runs[i].2 == Kind::Keep {
            out.extend(std::iter::repeat_n(Op::Same, runs[i].1));
            i += 1;
            continue;
        }
        let start = i;
        while i < runs.len() && !(runs[i].0 == Op::Same && runs[i].2 == Kind::Keep) {
            i += 1;
        }
        let region = &runs[start..i];
        if region.iter().any(|(_, _, kind)| *kind == Kind::Fold) {
            flatten_region(&mut out, region);
        } else {
            for (op, len, _) in region {
                out.extend(std::iter::repeat_n(*op, *len));
            }
        }
    }
    out
}

/// Flattens a region with a folded run: every original character first (in its own order), then
/// every revised character (in its own order) — one clean delete, one clean insert.
fn flatten_region(out: &mut Vec<Op>, region: &[(Op, usize, Kind)]) {
    let dels: usize = region.iter().map(|(op, len, kind)| if *kind == Kind::Fold || *op == Op::Del { *len } else { 0 }).sum();
    let inss: usize = region.iter().map(|(op, len, kind)| if *kind == Kind::Fold || *op == Op::Ins { *len } else { 0 }).sum();
    out.extend(std::iter::repeat_n(Op::Del, dels));
    out.extend(std::iter::repeat_n(Op::Ins, inss));
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod bytes_tests {
    use super::*;
    use crate::cmd::insert::base64_encode;

    fn docx(text: &str) -> String {
        base64_encode(&crate::io::save_bytes("document.docx", &Document::from_text(text)).unwrap())
    }
    fn engine(text: &str) -> String {
        base64_encode(&serde_json::to_vec(&Document::from_text(text)).unwrap())
    }

    #[test]
    fn compare_and_combine_take_the_other_document_as_bytes() {
        let mut s = Session::new(Document::from_text("The cat sat.\nKeep this."));
        let r = s.run("review.compare", &json!({"revisedData": docx("The dog sat.\nKeep this."), "author": "Rev"})).unwrap();
        assert!(r["changes"].as_u64().unwrap() >= 1);
        s.run("review.acceptAll", &json!({})).unwrap();
        assert_eq!(s.doc.plain_text(StoryRef::Body), "The dog sat.\nKeep this.");
        // Both sides from bytes, the engine's own form included: the session shows original + changes to the revised.
        let mut s = Session::new(Document::from_text("unrelated"));
        let v = json!({"originalData": engine("One.\nTwo."), "originalKind": "engine", "revisedData": engine("One.\nThree."), "revisedKind": "engine"});
        s.run("review.combine", &v).unwrap();
        s.run("review.rejectAll", &json!({})).unwrap();
        assert_eq!(s.doc.plain_text(StoryRef::Body), "One.\nTwo.");
        assert!(s.run("review.compare", &json!({"revisedData": "@@", "revisedKind": "docx"})).is_err(), "not base64");
        assert!(s.run("review.compare", &json!({"revisedData": engine("x"), "revisedKind": "pdf"})).is_err(), "an unknown kind");
    }

    #[test]
    fn restore_version_replaces_the_document_in_one_undo_step() {
        let mut s = Session::new(Document::from_text("Now."));
        s.run("file.restoreVersion", &json!({"data": engine("Then.\nAnd then.")})).unwrap();
        assert_eq!(s.doc.plain_text(StoryRef::Body), "Then.\nAnd then.");
        s.run("edit.undo", &json!({})).unwrap();
        assert_eq!(s.doc.plain_text(StoryRef::Body), "Now.");
        s.run("file.restoreVersion", &json!({"data": docx("From Word."), "kind": "docx"})).unwrap();
        assert_eq!(s.doc.plain_text(StoryRef::Body), "From Word.");
        assert!(s.run("file.restoreVersion", &json!({})).is_err());
    }
}
