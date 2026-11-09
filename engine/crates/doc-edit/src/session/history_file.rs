//! A canvas draft's undo history saved beside its record (EasyWriter, docs/plans/engine/stage2b.md decision 3 and
//! stage2b/history-files.md (a)): `<id>.history.json`, `form: "easywriter.history"`.
//!
//! The record already holds the current document, so the file holds only differences, measured outward from it: the top undo
//! step against the current document, the next one against that step, and so on; the redo steps the same way. A step's body
//! names the runs of blocks it shares with its neighbour as ranges of the neighbour's blocks and writes the others out, so the
//! blocks an edit left alone are written once and stay shared when the history is read back. Of the other fields a step keeps
//! only those that differ from its neighbour's (for parts, pictures and kept parts, the entries that differ).
//!
//! A history that does not match the document it is read for (another form or version, a schema version this build cannot read
//! as it is, the record's save stamp, the document's block ids) is dropped and the session keeps an empty one, as SPEC.md section 7e rules for the DOM editor's.
//! Not kept: the column block (the selection comes back plain), the step ids (new ones are taken), the count of evicted steps,
//! an open typing group and the join promises, the automatic capital, a composition's step, versions and edit marks.
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Weak};

use serde::{Deserialize, Serialize};
use ew_doc::props::CharProps;
use ew_doc::{Block, Document, READS_AS_IS_SINCE, SCHEMA_VERSION};

use super::Session;
use super::doc_state::{MAX_UNDO, Selection, Undo, next_step_id};

/// The file's form and the version of it this build writes and reads.
const FORM: &str = "easywriter.history";
const FORM_VERSION: u32 = 1;

// The writing functions are #[inline] so the crate that calls them (the wasm host) compiles them, and the serializers they call
// for blocks and documents are the ones its record save (save.rs) has already: compiled here, a second copy of them cost the
// .wasm 228 KB.

/// Writes the history file, one save at a time: `snap` notes the stacks as they are when the record is saved and writes their top
/// steps against the document then, and `export` writes the rest. A step's difference from its neighbour is kept between saves
/// (by the two steps' addresses), so a save encodes the steps that changed since the last one, usually just the top one.
#[derive(Default)]
pub struct HistoryWriter {
    snap: Option<serde_json::Result<Snap>>,
    /// (step, neighbour step) by address → the step's JSON and its size without pictures. The weak pointers keep the addresses
    /// from being reused while the entry lives, without holding the steps (undo still moves a step out of its `Arc`).
    cache: HashMap<(usize, usize), Cached>,
}

type Cached = (Weak<Undo>, Weak<Undo>, Encoded);
/// A step's JSON and its size without pictures.
type Encoded = (Arc<[u8]>, usize);

/// The stacks as a record save found them, their top steps written against the document it saved, and its block ids' hash.
struct Snap {
    undo: Vec<Arc<Undo>>,
    redo: Vec<Arc<Undo>>,
    tops: [Option<Encoded>; 2],
    ids: String,
}

impl HistoryWriter {
    /// Notes the session's stacks as they are now (the engine save's begin) and writes their top steps against the document,
    /// so the file written from them matches the record that save writes even when edits come before `export`.
    #[inline]
    pub fn snap(&mut self, s: &Session) {
        let top = |stack: &[Arc<Undo>]| stack.last().map(|u| encode(u, &s.doc)).transpose();
        self.snap = Some(top(&s.history).and_then(|u| Ok([u, top(&s.redo)?])).map(|tops| Snap {
            undo: s.history.clone(),
            redo: s.redo.clone(),
            tops,
            ids: ids_hash(&s.doc),
        }));
    }

    /// The snapped history as the file's JSON for a record saved with `stamp`: at most `limit` undo steps (and MAX_UNDO), the
    /// oldest dropped while the steps take more than `cap` bytes without their pictures, and every redo step. `None` when it
    /// keeps no step (a limit of 0, an empty history); an error when nothing was snapped since the last export, so a caller never
    /// writes a history that belongs to another save.
    #[inline]
    pub fn export(&mut self, stamp: &str, limit: usize, cap: usize) -> Result<Option<Vec<u8>>, String> {
        let snap = self.snap.take().ok_or("no save of the document to write the undo history of")?.map_err(|e| e.to_string())?;
        self.write(snap, stamp, limit, cap).map_err(|e| e.to_string())
    }

    #[inline]
    fn write(&mut self, snap: Snap, stamp: &str, limit: usize, cap: usize) -> serde_json::Result<Option<Vec<u8>>> {
        let limit = limit.min(MAX_UNDO);
        if limit == 0 || (snap.undo.is_empty() && snap.redo.is_empty()) {
            self.cache.clear();
            return Ok(None);
        }
        let [top_undo, top_redo] = snap.tops;
        let mut cache = HashMap::new();
        let redo = self.chain(top_redo, &snap.redo, usize::MAX, &mut cache)?;
        let mut undo = self.chain(top_undo, &snap.undo, limit, &mut cache)?;
        let mut room = cap.saturating_sub(redo.iter().map(|(_, n)| n).sum());
        let keep = undo.iter().take_while(|(_, n)| {
            let fits = *n <= room;
            room = room.saturating_sub(*n);
            fits
        });
        let kept = keep.count();
        undo.truncate(kept);
        self.cache = cache;
        let mut out = Vec::with_capacity(undo.iter().chain(&redo).map(|(j, _)| j.len() + 1).sum::<usize>() + 256);
        out.extend_from_slice(br#"{"form":"#);
        serde_json::to_writer(&mut out, FORM)?;
        out.extend_from_slice(format!(r#","formVersion":{FORM_VERSION},"schema":{SCHEMA_VERSION},"stamp":"#).as_bytes());
        serde_json::to_writer(&mut out, stamp)?;
        out.extend_from_slice(br#","ids":"#);
        serde_json::to_writer(&mut out, &snap.ids)?;
        for (key, list) in [("undo", &undo), ("redo", &redo)] {
            out.extend_from_slice(format!(r#","{key}":["#).as_bytes());
            for (i, (json, _)) in list.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                out.extend_from_slice(json);
            }
            out.push(b']');
        }
        out.push(b'}');
        Ok(Some(out))
    }

    /// The steps of one stack (oldest first) written outward, the newest first (`top`, written already), at most `limit`. Each
    /// step after the top one is taken from the cache when it and its neighbour are the ones written before; `cache` gets them all.
    #[inline]
    fn chain(
        &self,
        top: Option<Encoded>,
        stack: &[Arc<Undo>],
        limit: usize,
        cache: &mut HashMap<(usize, usize), Cached>,
    ) -> serde_json::Result<Vec<Encoded>> {
        let mut out: Vec<Encoded> = top.into_iter().take(limit).collect();
        for pair in stack.windows(2).rev().take(limit.saturating_sub(1)) {
            let [step, n] = pair else { continue };
            let key = (Arc::as_ptr(step) as usize, Arc::as_ptr(n) as usize);
            let e = match self.cache.get(&key) {
                Some((_, _, e)) => e.clone(),
                None => encode(step, &n.doc)?,
            };
            cache.insert(key, (Arc::downgrade(step), Arc::downgrade(n), e.clone()));
            out.push(e);
        }
        Ok(out)
    }
}

impl Session {
    /// This session's history as the file's JSON, for a record saved with `stamp` (`HistoryWriter::export`).
    pub fn export_history(&self, stamp: &str, limit: usize, cap: usize) -> Result<Option<Vec<u8>>, String> {
        let mut w = HistoryWriter::default();
        w.snap(self);
        w.export(stamp, limit, cap)
    }

    /// Takes the undo history `bytes` (`export`'s JSON) for the document this session holds, which was opened from the record
    /// saved with `stamp` → whether it was taken. One that does not match the document leaves the history as it was. Its steps
    /// get new ids; the selection of a step that was a column block comes back plain.
    pub fn import_history(&mut self, bytes: &[u8], stamp: &str) -> bool {
        let Some((undo, redo, top)) = read(bytes, stamp, &self.doc) else {
            return false;
        };
        self.reset_history();
        // A block added from now on must not take an id a step brings back.
        self.ids.reserve(top);
        self.history = undo;
        self.redo = redo;
        self.undo_evicted = 0;
        true
    }
}

/// The entries of the keyed fields (parts, pictures, kept parts) that a step's neighbour has and the step has not.
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Gone {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    parts: Vec<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "current_keys")]
    media: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "current_keys")]
    passthrough: Vec<String>,
}

/// Keys under their current names, as the document's own maps read them (`ew_doc::current_key`), so a step written before a
/// key was renamed still drops the renamed key.
fn current_keys<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(Vec::<String>::deserialize(d)?.into_iter().map(ew_doc::current_key).collect())
}

impl Gone {
    fn is_empty(&self) -> bool {
        self.parts.is_empty() && self.media.is_empty() && self.passthrough.is_empty()
    }
}

/// Calls `$m!(field, "name")` for each top-level field of a document besides its body, parts, pictures and kept parts: a step
/// keeps the ones that differ from its neighbour's. `every_document_field_is_written` fails when Document gains a field.
macro_rules! shell_fields {
    ($m:ident) => {
        $m!(last_section, "lastSection");
        $m!(styles, "styles");
        $m!(numbering, "numbering");
        $m!(comments, "comments");
        $m!(revisions, "revisions");
        $m!(settings, "settings");
        $m!(core, "core");
        $m!(sources, "sources");
        $m!(custom_props, "customProps");
        $m!(footnote_separators, "footnoteSeparators");
        $m!(endnote_separators, "endnoteSeparators");
        $m!(glossary, "glossary");
    };
}

/// Step `step` written against `next`, the document of its neighbour on the way out from the current one → (JSON, size without
/// pictures): `{label, sel, pending?, body, shell?, same?, gone?}`, `body` a list of `{kept: [from, to]}` (a run of `next`'s
/// blocks) and `{block}`. `shell` is a document with no body that holds the step's fields when any differ from `next`'s, `same`
/// the names of those that do not (left at their defaults in the shell), and the parts, pictures and kept parts that differ.
/// It is written and read with the record's own serializers, so the .wasm grows little (an encoder of its own for those fields
/// cost about 200 KB).
#[inline]
fn encode(step: &Undo, next: &Document) -> serde_json::Result<Encoded> {
    let mut out = Vec::new();
    out.extend_from_slice(br#"{"label":"#);
    serde_json::to_writer(&mut out, &step.label)?;
    out.extend_from_slice(br#","sel":"#);
    serde_json::to_writer(&mut out, &step.sel)?;
    if let Some(p) = &step.pending {
        out.extend_from_slice(br#","pending":"#);
        serde_json::to_writer(&mut out, p)?;
    }
    out.extend_from_slice(br#","body":"#);
    body(&step.doc.body, &next.body, &mut out)?;
    let (shell, same, gone) = shell(&step.doc, next);
    let mut pictures = 0;
    if let Some(sh) = shell {
        // Pictures go out as base64, a third larger than their bytes.
        pictures = sh.media.values().chain(sh.passthrough.values()).map(|b| b.len() / 3 * 4 + 40).sum();
        out.extend_from_slice(br#","shell":"#);
        sh.write_json(&mut out)?;
        out.extend_from_slice(br#","same":"#);
        serde_json::to_writer(&mut out, &same)?;
    }
    if !gone.is_empty() {
        out.extend_from_slice(br#","gone":"#);
        serde_json::to_writer(&mut out, &gone)?;
    }
    out.push(b'}');
    let size = out.len().saturating_sub(pictures);
    Ok((out.into(), size))
}

/// Writes body `blocks` against `next`'s: the runs of `next`'s blocks it holds as `[from, to]`, the other blocks whole. An edit
/// leaves most of a body as it was, so the blocks shared at the start and at the end are found by address before any lookup.
#[inline]
fn body(blocks: &[Arc<Block>], next: &[Arc<Block>], out: &mut Vec<u8>) -> serde_json::Result<()> {
    let ptr = |b: &Arc<Block>| Arc::as_ptr(b) as usize;
    let head = blocks.iter().zip(next).take_while(|(a, b)| Arc::ptr_eq(a, b)).count();
    let tail = blocks[head..].iter().rev().zip(next[head..].iter().rev()).take_while(|(a, b)| Arc::ptr_eq(a, b)).count();
    let middle: HashMap<usize, usize> = next[head..next.len() - tail].iter().enumerate().map(|(i, b)| (ptr(b), head + i)).collect();
    let mut run: Option<(usize, usize)> = None;
    let mut first = true;
    let mut sep = |out: &mut Vec<u8>| {
        if !std::mem::take(&mut first) {
            out.push(b',');
        }
    };
    out.push(b'[');
    for (i, b) in blocks.iter().enumerate() {
        let at = if i < head {
            Some(i)
        } else if i >= blocks.len() - tail {
            Some(next.len() - (blocks.len() - i))
        } else {
            middle.get(&ptr(b)).copied()
        };
        match (at, run) {
            (Some(j), Some((from, to))) if to == j => run = Some((from, j + 1)),
            _ => {
                if let Some((from, to)) = run.take() {
                    sep(out);
                    out.extend_from_slice(format!(r#"{{"kept":[{from},{to}]}}"#).as_bytes());
                }
                match at {
                    Some(j) => run = Some((j, j + 1)),
                    None => {
                        sep(out);
                        out.extend_from_slice(br#"{"block":"#);
                        ew_doc::write_block(out, b)?;
                        out.push(b'}');
                    }
                }
            }
        }
    }
    if let Some((from, to)) = run {
        sep(out);
        out.extend_from_slice(format!(r#"{{"kept":[{from},{to}]}}"#).as_bytes());
    }
    out.push(b']');
    Ok(())
}

/// The entries of `a` that `b` lacks or holds differently, and the keys of `b` that `a` lacks.
fn changed<K: Ord + Clone, V: Clone + PartialEq>(a: &BTreeMap<K, V>, b: &BTreeMap<K, V>) -> (BTreeMap<K, V>, Vec<K>) {
    let differ = a.iter().filter(|(k, v)| b.get(k) != Some(v)).map(|(k, v)| (k.clone(), v.clone())).collect();
    (differ, b.keys().filter(|k| !a.contains_key(k)).cloned().collect())
}

/// `step`'s fields as a step keeps them against `next`'s → (a document with no body holding the fields that differ, its parts,
/// pictures and kept parts the entries that differ, or None when nothing differs; the names of the fields that do not differ,
/// which the shell leaves at a small default; the entries `step` lacks).
fn shell(step: &Document, next: &Document) -> (Option<Document>, Vec<&'static str>, Gone) {
    let (parts, gone_parts) = changed(&step.parts, &next.parts);
    let (media, gone_media) = changed(&step.media, &next.media);
    let (kept, gone_kept) = changed(&step.passthrough, &next.passthrough);
    let gone = Gone { parts: gone_parts, media: gone_media, passthrough: gone_kept };
    let same = same_fields(step, next);
    if same.len() == SHELL_FIELDS && parts.is_empty() && media.is_empty() && kept.is_empty() {
        return (None, Vec::new(), gone);
    }
    let mut sh = Document::new();
    sh.body.clear();
    sh.styles_mut().styles.clear(); // the built-in styles a blank document starts with: not written for nothing
    macro_rules! take {
        ($f:ident, $k:literal) => {
            if !same.contains(&$k) {
                sh.$f = step.$f.clone();
            }
        };
    }
    shell_fields!(take);
    (sh.parts, sh.media, sh.passthrough) = (parts, media, kept);
    (Some(sh), same, gone)
}

/// The names of the fields of `step` that are the same as `next`'s.
fn same_fields(step: &Document, next: &Document) -> Vec<&'static str> {
    let mut same = Vec::new();
    macro_rules! differs {
        ($f:ident, $k:literal) => {
            if step.$f == next.$f {
                same.push($k);
            }
        };
    }
    shell_fields!(differs);
    same
}

/// The number of fields shell_fields names.
const SHELL_FIELDS: usize = 12;

/// A hash of `doc`'s block ids in order, the body's and each part's (with its key): a history is read only for the document it
/// was written for, since its ranges name blocks by their place.
fn ids_hash(doc: &Document) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |x: u32| {
        for byte in x.to_le_bytes() {
            h = (h ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
        }
    };
    let id = |b: &Arc<Block>| match &**b {
        Block::Para(p) => p.id.0,
        Block::Table(t) => t.id.0,
        Block::Container(c) => c.id.0,
    };
    for b in &doc.body {
        eat(id(b));
    }
    for (k, p) in &doc.parts {
        eat(u32::MAX);
        eat(*k);
        for b in &p.blocks {
            eat(id(b));
        }
    }
    format!("{h:016x}")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    form: String,
    form_version: u32,
    schema: u32,
    stamp: String,
    ids: String,
    undo: Vec<Step>,
    redo: Vec<Step>,
}

#[derive(Deserialize)]
struct Step {
    label: String,
    sel: Selection,
    #[serde(default)]
    pending: Option<CharProps>,
    body: Vec<Piece>,
    #[serde(default)]
    shell: Option<Document>,
    #[serde(default)]
    same: Vec<String>,
    #[serde(default)]
    gone: Gone,
}

/// A run of the neighbour's blocks, or a block of the step's own. Tagged rather than told apart by their form (untagged), so the
/// block is read with the reader the record's open already has.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Piece {
    Kept(usize, usize),
    Block(Box<Block>),
}

/// The stacks (oldest first) of history file `bytes` for `doc`, saved with `stamp`, and the highest block id their steps hold,
/// or `None` when it does not match.
fn read(bytes: &[u8], stamp: &str, doc: &Document) -> Option<(Vec<Arc<Undo>>, Vec<Arc<Undo>>, u32)> {
    let f: File = serde_json::from_slice(bytes).ok()?;
    // The stamp ties the file to the record its build saved, so its schema is the record's: one the record's open upgraded is
    // read here too while no upgrade step rewrites what the structs read (schema.rs READS_AS_IS_SINCE), and a newer one never.
    let schema = READS_AS_IS_SINCE..=SCHEMA_VERSION;
    if f.form != FORM || f.form_version != FORM_VERSION || !schema.contains(&f.schema) || f.stamp != stamp || f.ids != ids_hash(doc) {
        return None;
    }
    let mut top = 0;
    Some((states(f.undo, doc, &mut top)?, states(f.redo, doc, &mut top)?, top))
}

/// Steps written outward from `doc` (the newest first) → the stack, oldest first. `top` rises to the highest block id the
/// steps hold of their own (their other blocks are the document's or a neighbour's).
fn states(steps: Vec<Step>, doc: &Document, top: &mut u32) -> Option<Vec<Arc<Undo>>> {
    let mut out: Vec<Undo> = Vec::with_capacity(steps.len());
    for s in steps {
        let own = s.body.iter().filter_map(|p| match p {
            Piece::Block(b) => Some(&**b),
            Piece::Kept(..) => None,
        });
        let parts = s.shell.iter().flat_map(|sh| sh.parts.values()).flat_map(|p| p.blocks.iter().map(|b| &**b));
        *top = own.chain(parts).map(ew_doc::max_id).fold(*top, u32::max);
        let next = out.last().map_or(doc, |u| &u.doc);
        let d = rebuild(s.body, s.shell.map(|sh| (sh, s.same)), &s.gone, next)?;
        out.push(Undo { id: next_step_id(), label: s.label, doc: d, sel: s.sel, pending: s.pending, column: None, multi: None });
    }
    Some(out.into_iter().rev().map(Arc::new).collect())
}

/// The document a step holds, from its neighbour's `next` and its `shell` with the names of the fields it takes from `next`:
/// kept blocks are `next`'s own (shared, not copied).
fn rebuild(body: Vec<Piece>, shell: Option<(Document, Vec<String>)>, gone: &Gone, next: &Document) -> Option<Document> {
    let mut d = match shell {
        None => next.clone(),
        Some((mut d, same)) => {
            macro_rules! keep {
                ($f:ident, $k:literal) => {
                    if same.iter().any(|n| n == $k) {
                        d.$f = next.$f.clone();
                    }
                };
            }
            shell_fields!(keep);
            // Parts, pictures and kept parts hold the entries that differ: the others are the neighbour's.
            d.parts = next.parts.clone().into_iter().chain(std::mem::take(&mut d.parts)).collect();
            d.media = next.media.clone().into_iter().chain(std::mem::take(&mut d.media)).collect();
            d.passthrough = next.passthrough.clone().into_iter().chain(std::mem::take(&mut d.passthrough)).collect();
            d
        }
    };
    d.parts.retain(|k, _| !gone.parts.contains(k));
    d.media.retain(|k, _| !gone.media.contains(k));
    d.passthrough.retain(|k, _| !gone.passthrough.contains(k));
    let mut blocks = Vec::with_capacity(body.len());
    for p in body {
        match p {
            Piece::Kept(from, to) => blocks.extend_from_slice(next.body.get(from..to)?),
            Piece::Block(b) => blocks.push(Arc::new(*b)),
        }
    }
    d.body = blocks;
    Some(d)
}

// The allow goes first: file_access.rs's check finds the test module by `#[cfg(test)]` followed by `mod`.
#[allow(clippy::unwrap_used, clippy::panic)]
#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn run(s: &mut Session, id: &str, v: Value) {
        s.run(id, &v).unwrap_or_else(|e| panic!("{id}: {e}"));
    }

    /// A session with steps of every kind: typing, new paragraphs, a format over everything, a header (a part), a picture,
    /// a page setup change (a field), and two steps undone (redo steps).
    fn edited() -> Session {
        let mut s = Session::new(Document::from_text("First paragraph.\nSecond paragraph.\nThird one."));
        s.reset_ids();
        run(&mut s, "text.insert", json!({"text": "Typed. "}));
        s.close_typing();
        run(&mut s, "text.newParagraph", json!({}));
        run(&mut s, "text.insert", json!({"text": "More."}));
        run(&mut s, "select.all", json!({}));
        run(&mut s, "format.bold", json!({}));
        run(&mut s, "insert.header", json!({"text": "A header"}));
        let png = crate::cmd::insert::base64_encode(&tiny_png());
        run(&mut s, "edit.pasteSpecial", json!({"as": "picture", "picture": png}));
        run(&mut s, "layout.orientation", json!({"value": "landscape"}));
        run(&mut s, "text.insert", json!({"text": "Last."}));
        assert!(s.undo() && s.undo());
        s.layout();
        s
    }

    fn tiny_png() -> Vec<u8> {
        let mut png = Vec::new();
        image::RgbaImage::from_pixel(2, 2, image::Rgba([200, 30, 30, 255]))
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        png
    }

    /// `s`'s document as the record stores it, opened again as the wasm host opens it.
    fn reopened(s: &Session) -> Session {
        let mut doc = crate::io::open_bytes("document.json", &serde_json::to_vec(&s.doc).unwrap()).unwrap();
        doc.upgrade().unwrap();
        let mut t = Session::new(Document::new());
        t.set_document(doc);
        t.reset_ids();
        t
    }

    fn states(s: &Session) -> (Vec<(Document, Selection, String)>, Vec<(Document, Selection, String)>) {
        let of = |v: &[Arc<Undo>]| v.iter().map(|u| (u.doc.clone(), u.sel.clone(), u.label.clone())).collect();
        (of(&s.history), of(&s.redo))
    }

    #[test]
    fn a_saved_history_reads_back_to_the_same_steps() {
        let mut s = edited();
        assert!(s.history.len() >= 6 && s.redo.len() == 2, "{} undo, {} redo", s.history.len(), s.redo.len());
        let bytes = s.export_history("stamp-1", 50, 8 << 20).unwrap().unwrap();
        let mut t = reopened(&s);
        assert!(t.import_history(&bytes, "stamp-1"));
        assert_eq!(states(&t), states(&s), "the same documents, selections and labels");
        // Undo and redo walk the same documents, the header part and the picture included.
        while s.undo() {
            assert!(t.undo());
            assert_eq!((&t.doc, &t.sel), (&s.doc, &s.sel));
        }
        assert!(!t.can_undo());
        while s.redo() {
            assert!(t.redo());
            assert_eq!(t.doc, s.doc);
        }
        assert!(!t.can_redo());
    }

    #[test]
    fn kept_blocks_are_shared_with_the_opened_document() {
        let mut s = Session::new(Document::from_text("one\ntwo\nthree\nfour"));
        s.reset_ids();
        run(&mut s, "text.insert", json!({"text": "x"}));
        s.layout();
        let bytes = s.export_history("st", 50, 8 << 20).unwrap().unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(text.contains("[1,4]"), "the three untouched blocks are a range: {text}");
        let mut t = reopened(&s);
        assert!(t.import_history(&bytes, "st"));
        let before = &t.history[0].doc.body;
        assert!((1..4).all(|i| Arc::ptr_eq(&before[i], &t.doc.body[i])), "kept blocks are the opened document's own");
        assert!(!Arc::ptr_eq(&before[0], &t.doc.body[0]));
    }

    #[test]
    fn a_block_added_after_the_import_takes_no_id_a_step_holds() {
        // A paragraph added and joined away again: its id is in the history only.
        let mut s = Session::new(Document::from_text("one
two
three"));
        s.reset_ids();
        s.sel = Selection::caret(ew_doc::Pos::new(ew_doc::StoryRef::Body, ew_doc::Path::top(0), 3));
        run(&mut s, "text.newParagraph", json!({}));
        s.note_ids();
        run(&mut s, "text.backspace", json!({}));
        s.note_ids();
        let bytes = s.export_history("st", 50, 8 << 20).unwrap().unwrap();
        let mut t = reopened(&s);
        assert!(t.import_history(&bytes, "st"));
        let held: Vec<u32> = t.history.iter().chain(&t.redo).flat_map(|u| u.doc.body.iter().map(|b| ew_doc::max_id(b))).collect();
        assert!(held.iter().any(|id| *id > 3), "the joined paragraph's id is in the history: {held:?}");
        t.sel = Selection::caret(ew_doc::Pos::new(ew_doc::StoryRef::Body, ew_doc::Path::top(2), 5));
        run(&mut t, "text.newParagraph", json!({}));
        t.note_ids();
        let added = t.doc.body[3].as_para().unwrap().id.0;
        assert!(!held.contains(&added), "the new paragraph took id {added}, which a step holds: {held:?}");
        // Undo brings the step's blocks back under their own ids.
        assert!(t.undo() && t.undo());
        t.note_ids();
        let back: Vec<u32> = t.doc.body.iter().map(|b| ew_doc::max_id(b)).collect();
        assert_eq!(back, s.history[1].doc.body.iter().map(|b| ew_doc::max_id(b)).collect::<Vec<_>>());
    }

    #[test]
    fn a_history_written_before_the_rename_drops_the_renamed_key_on_undo() {
        // A kept part the current document has and the step before it lacks: the step's gone list names it.
        let mut s = Session::new(Document::from_text("one"));
        s.reset_ids();
        run(&mut s, "text.insert", json!({"text": "x"}));
        s.close_typing();
        s.doc.passthrough.insert("easywriter:app.kept".into(), Arc::new(b"Company\tAcme".to_vec()));
        s.layout();
        let bytes = s.export_history("st", 50, 8 << 20).unwrap().unwrap();
        // The record and history as schema 7 wrote them, with the key's old name.
        let old = |text: String| text.replace("easywriter:", "wordcraft:");
        let history = old(String::from_utf8(bytes).unwrap());
        assert!(history.contains(r#""wordcraft:app.kept""#), "the step names the key: {history}");
        let history = history.replacen(&format!(r#""schema":{SCHEMA_VERSION}"#), r#""schema":7"#, 1);
        let record = old(serde_json::to_string(&s.doc).unwrap()).replacen(&format!(r#""version":{SCHEMA_VERSION}"#), r#""version":7"#, 1);
        let mut doc = crate::io::open_bytes("document.json", record.as_bytes()).unwrap();
        doc.upgrade().unwrap();
        let mut t = Session::new(Document::new());
        t.set_document(doc);
        t.reset_ids();
        assert!(t.doc.passthrough.contains_key("easywriter:app.kept"));
        assert!(t.import_history(history.as_bytes(), "st"));
        assert!(t.undo());
        assert_eq!(t.doc.passthrough.keys().collect::<Vec<_>>(), Vec::<&String>::new(), "undo leaves no kept part the step lacked");
    }

    #[test]
    fn a_history_that_does_not_match_is_dropped() {
        let s = edited();
        let bytes = s.export_history("stamp-1", 50, 8 << 20).unwrap().unwrap();
        let mut t = reopened(&s);
        assert!(!t.import_history(&bytes, "stamp-2"), "another save stamp");
        assert!(!t.can_undo() && !t.can_redo());
        let text = String::from_utf8(bytes.clone()).unwrap();
        let schema = |v: u32| text.replacen(&format!(r#""schema":{SCHEMA_VERSION}"#), &format!(r#""schema":{v}"#), 1);
        assert!(!t.import_history(schema(SCHEMA_VERSION + 1).as_bytes(), "stamp-1"), "a newer schema");
        let newer = text.replacen(r#""formVersion":1"#, r#""formVersion":2"#, 1);
        assert!(!t.import_history(newer.as_bytes(), "stamp-1"), "a newer form");
        assert!(!t.import_history(b"{\"version\":1}", "stamp-1"), "the DOM editor's history");
        // Block ids that are not the document's: a block more than the record holds.
        t.doc.body.insert(0, t.doc.body[0].clone());
        t.reset_ids();
        assert!(!t.import_history(&bytes, "stamp-1"), "other block ids");
        assert!(!t.can_undo());
    }

    #[test]
    fn a_history_saved_at_an_older_schema_opens_with_its_record() {
        // A build before a schema bump saved the record and its history; this build upgrades the record at open and reads the
        // history the same way, as long as the structs read that version as it is.
        let s = edited();
        let text = String::from_utf8(s.export_history("st", 50, 8 << 20).unwrap().unwrap()).unwrap();
        let older = text.replacen(&format!(r#""schema":{SCHEMA_VERSION}"#), &format!(r#""schema":{}"#, SCHEMA_VERSION - 1), 1);
        assert_ne!(older, text);
        let mut t = reopened(&s);
        assert!(t.import_history(older.as_bytes(), "st"));
        assert_eq!(t.history.len(), s.history.len());
    }

    #[test]
    fn limits_keep_the_newest_steps() {
        let s = edited();
        let n = s.history.len();
        let mut t = reopened(&s);
        assert!(t.import_history(&s.export_history("st", 2, 8 << 20).unwrap().unwrap(), "st"));
        assert_eq!((t.history.len(), t.redo.len()), (2, 2));
        assert_eq!(t.history[1].doc, s.history[n - 1].doc);
        assert!(s.export_history("st", 0, 8 << 20).unwrap().is_none(), "a limit of 0 writes nothing");
        // A cap of a few bytes keeps no undo step, and every redo step.
        let mut t = reopened(&s);
        assert!(t.import_history(&s.export_history("st", 50, 10).unwrap().unwrap(), "st"));
        assert_eq!((t.history.len(), t.redo.len()), (0, 2));
    }

    #[test]
    fn the_writer_encodes_from_the_snap_and_reuses_unchanged_steps() {
        let mut s = edited();
        let mut w = HistoryWriter::default();
        w.snap(&s);
        let saved = s.doc.clone();
        run(&mut s, "text.insert", json!({"text": "After the save."}));
        let one = w.export("a", 50, 8 << 20).unwrap().unwrap();
        // The file matches the document as snapped, not the edit after it.
        let mut t = Session::new(Document::new());
        t.set_document(serde_json::from_slice(&serde_json::to_vec(&saved).unwrap()).unwrap());
        t.reset_ids();
        assert!(t.import_history(&one, "a"));
        assert!(w.cache.len() >= 5, "the steps under the top one are kept: {}", w.cache.len());
        w.snap(&s);
        let two = w.export("b", 50, 8 << 20).unwrap().unwrap();
        assert_eq!(two, s.export_history("b", 50, 8 << 20).unwrap().unwrap(), "the cached steps are the ones encoded afresh");
        assert!(w.export("c", 50, 8 << 20).is_err(), "nothing snapped: no history to write");
    }

    #[test]
    fn every_document_field_is_written() {
        let Value::Object(m) = serde_json::to_value(Document::new()).unwrap() else { panic!() };
        let mut known = vec!["schema", "version", "body", "parts"];
        macro_rules! name {
            ($f:ident, $k:literal) => {
                known.push($k);
            };
        }
        shell_fields!(name);
        let missing: Vec<&String> = m.keys().filter(|k| !known.contains(&k.as_str())).collect();
        assert!(missing.is_empty(), "add these Document fields to shell_fields: {missing:?}");
    }

    /// The file's size and the time to write it for the Word fixture after a Select All and a format change, then 50 typed
    /// steps (the byte cap's measurement): `cargo test -p ew-doc-edit --lib history_file_on_the_fixture -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn history_file_on_the_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.smoke-data/word/fixture/all-features.docx");
        let Ok(bytes) = std::fs::read(&path) else {
            return;
        };
        let mut s = Session::new(crate::io::open_bytes("document.docx", &bytes).unwrap());
        s.reset_ids();
        run(&mut s, "select.all", json!({}));
        run(&mut s, "format.bold", json!({}));
        run(&mut s, "caret.docStart", json!({}));
        for i in 0..50 {
            run(&mut s, "text.insert", json!({"text": format!("Typed {i}. ")}));
            s.close_typing();
        }
        s.layout();
        let mut w = HistoryWriter::default();
        let t = std::time::Instant::now();
        w.snap(&s);
        let first = w.export("x", 50, usize::MAX).unwrap().unwrap();
        let cold = t.elapsed();
        run(&mut s, "text.insert", json!({"text": "One more."}));
        s.layout();
        let t = std::time::Instant::now();
        w.snap(&s);
        let again = w.export("y", 50, usize::MAX).unwrap().unwrap();
        let warm = t.elapsed();
        let mut t2 = reopened(&s);
        let t = std::time::Instant::now();
        assert!(t2.import_history(&again, "y"));
        let read = t.elapsed();
        // The default limit (50) drops the format change: with 51 the file holds it, a whole body's copy.
        w.snap(&s);
        let t = std::time::Instant::now();
        let whole = w.export("z", 52, usize::MAX).unwrap().unwrap();
        let with_format = t.elapsed();
        let mut t3 = reopened(&s);
        let t = std::time::Instant::now();
        assert!(t3.import_history(&whole, "z"));
        let read_whole = t.elapsed();
        let model = serde_json::to_vec(&s.doc).unwrap().len();
        println!(
            "history {} bytes (model {model}), first write {cold:?}, next write {warm:?} ({} bytes), read {read:?}",
            first.len(),
            again.len()
        );
        println!("with the format change: {} bytes, write {with_format:?}, read {read_whole:?}", whole.len());
    }
}
