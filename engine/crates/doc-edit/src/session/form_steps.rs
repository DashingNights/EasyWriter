//! engine-open-parse: the stored form read in steps, so an open in the engine worker leaves room for the other drafts' calls.
//! Read in one piece, the Word fixture's 7.3 MB form held the worker about 90 ms; here the body's blocks are read from its
//! start a slice at a time, then the rest of the document (its other fields together are about a quarter of the form and read
//! in a few milliseconds). Each block is read by serde from the same bytes as the one-piece read (io.rs) reads it. This lives
//! in the crate that holds that read, so the .wasm holds one copy of the model's reader (a generic compiles into every crate
//! that calls it: in ew-doc this was a second copy, 1.4 MB).
//! ponytail: a block is read as Block's derive reads it, the whole block buffered first. Read tag first (straight into its
//! Paragraph or Table) the fixture's form read 14% faster natively, but that reader added 74 KB to the .wasm, over its budget.

use std::sync::Arc;

use ew_doc::{Block, Blocks, Document};
use serde::de::IgnoredAny;

/// How many bytes of blocks are read between looks at the clock (`more` in [`FormSteps::step`]): about a tenth of a
/// millisecond of reading, so a step overruns its time by about that, or by one large block (a table is one).
const LOOK_EVERY: usize = 16 * 1024;

/// The stored form, read in steps into the [`Document`] that `serde_json::from_slice` and [`Document::normalize_runs`] make
/// of it in one piece. A form whose body this does not find (no `body`, or JSON it cannot follow) is read in one piece at the
/// first step, and so is the error of a form that does not read: it is the one-piece read's.
pub struct FormSteps {
    bytes: Vec<u8>,
    state: State,
}

enum State {
    /// The body's array starts at `open` (its `[`); `at` is where the next block or the array's end is.
    Body { open: usize, at: usize, blocks: Blocks },
    /// The body is read; it ends before `end`.
    Rest { open: usize, end: usize, blocks: Blocks },
    /// Read to the end, or failed.
    Done(Result<Document, String>),
    Taken,
}

impl FormSteps {
    /// The form in `bytes`, nothing read yet but where its body starts.
    pub fn new(bytes: Vec<u8>) -> Self {
        let state = match body_start(&bytes) {
            Some(open) => State::Body { open, at: skip_ws(&bytes, open + 1), blocks: Vec::new() },
            None => State::Done(whole(&bytes)),
        };
        FormSteps { bytes, state }
    }

    /// The form's bytes.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Reads on while `more()` says so (asked between blocks) → whether all is read. The step that finds the body's end reads
    /// the rest of the document.
    pub fn step(&mut self, more: &mut dyn FnMut() -> bool) -> bool {
        let bytes = &self.bytes;
        if let State::Body { open, at, blocks } = &mut self.state {
            let mut since = *at;
            loop {
                match bytes.get(*at) {
                    Some(b']') => {
                        let (open, end, blocks) = (*open, *at + 1, std::mem::take(blocks));
                        self.state = State::Rest { open, end, blocks };
                        break;
                    }
                    Some(_) => match next_block(bytes, *at) {
                        Some((mut block, next)) => {
                            Document::normalize_block(&mut block);
                            blocks.push(block);
                            *at = next;
                        }
                        None => {
                            self.state = State::Done(whole(bytes));
                            return true;
                        }
                    },
                    None => {
                        self.state = State::Done(whole(bytes));
                        return true;
                    }
                }
                if *at - since >= LOOK_EVERY {
                    since = *at;
                    if !more() {
                        return false;
                    }
                }
            }
        }
        if let State::Rest { open, end, blocks } = &mut self.state {
            // The rest: the form with an empty body read in one piece, the body's blocks put in.
            let mut rest = Vec::with_capacity(bytes.len() - (*end - *open) + 2);
            rest.extend_from_slice(&bytes[..*open]);
            rest.extend_from_slice(b"[]");
            rest.extend_from_slice(&bytes[*end..]);
            let blocks = std::mem::take(blocks);
            let read = serde_json::from_slice::<Document>(&rest).map(|mut doc| {
                doc.body = blocks;
                for part in doc.parts.values_mut() {
                    part.blocks.iter_mut().for_each(Document::normalize_block);
                }
                doc
            });
            self.state = State::Done(read.or_else(|_| whole(bytes)));
        }
        true
    }

    /// The document read, or the one-piece read's error. Reads what is left first.
    pub fn finish(&mut self) -> Result<Document, String> {
        while !self.step(&mut || true) {}
        match std::mem::replace(&mut self.state, State::Taken) {
            State::Done(read) => read,
            _ => Err("the form was taken already".into()),
        }
    }
}

/// The form read in one piece, as an open without steps reads it.
fn whole(bytes: &[u8]) -> Result<Document, String> {
    crate::io::read_form(bytes).map_err(|e| e.to_string())
}

fn skip_ws(bytes: &[u8], mut at: usize) -> usize {
    while matches!(bytes.get(at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
        at += 1;
    }
    at
}

/// One JSON value of type `T` at `at` → it and where it ends, or None when none reads there.
fn value_at<'a, T: serde::Deserialize<'a>>(bytes: &'a [u8], at: usize) -> Option<(T, usize)> {
    let mut values = serde_json::Deserializer::from_slice(bytes.get(at..)?).into_iter::<T>();
    let v = values.next()?.ok()?;
    Some((v, at + values.byte_offset()))
}

/// Where the root object's `body` array starts (its `[`), past the fields before it; None for a root without one, or one
/// this does not follow.
fn body_start(bytes: &[u8]) -> Option<usize> {
    let mut at = skip_ws(bytes, 0);
    if bytes.get(at) != Some(&b'{') {
        return None;
    }
    at = skip_ws(bytes, at + 1);
    while bytes.get(at) == Some(&b'"') {
        let (key, end) = value_at::<String>(bytes, at)?;
        at = skip_ws(bytes, end);
        if bytes.get(at) != Some(&b':') {
            return None;
        }
        at = skip_ws(bytes, at + 1);
        if key == "body" {
            return (bytes.get(at) == Some(&b'[')).then_some(at);
        }
        let (IgnoredAny, end) = value_at::<IgnoredAny>(bytes, at)?;
        at = skip_ws(bytes, end);
        match bytes.get(at) {
            Some(b',') => at = skip_ws(bytes, at + 1),
            _ => return None,
        }
    }
    None
}

/// The block at `at` in the body's array → it and where the next one (or the array's end) is.
fn next_block(bytes: &[u8], at: usize) -> Option<(Arc<Block>, usize)> {
    let (block, end) = value_at::<Block>(bytes, at)?;
    let at = skip_ws(bytes, end);
    let next = match bytes.get(at)? {
        b',' => skip_ws(bytes, at + 1),
        b']' => at,
        _ => return None,
    };
    // A comma before the array's end is not JSON: the one-piece read gives its error.
    if bytes.get(next) == Some(&b']') && next != at {
        return None;
    }
    Some((Arc::new(block), next))
}

// The form read in steps against the one-piece read an open makes.
#[cfg(test)]
mod tests {
    use super::*;
    use ew_doc::{Cell, CharProps, Paragraph, Row, Table};
    use serde::Serialize;

    /// Every sample model, at every version: (file name, bytes).
    fn samples() -> Vec<(String, Vec<u8>)> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures/engine-models");
        let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(&dir)
            .expect("the samples")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap()))
            .collect();
        out.sort();
        out
    }

    fn json<T: Serialize>(v: &T) -> String {
        serde_json::to_string(v).unwrap()
    }

    /// The one-piece read (EasyWriter's .json reader, io.rs).
    fn read(bytes: &[u8]) -> Document {
        let mut doc: Document = serde_json::from_slice(bytes).unwrap();
        doc.normalize_runs();
        doc
    }

    /// `bytes` read in steps, each ending at the first look at the clock → the document and the number of steps.
    fn in_steps(bytes: &[u8]) -> (std::result::Result<Document, String>, usize) {
        let mut steps = FormSteps::new(bytes.to_vec());
        let mut n = 1;
        while !steps.step(&mut || false) {
            n += 1;
        }
        (steps.finish(), n)
    }

    #[test]
    fn a_form_read_in_steps_is_the_one_piece_read() {
        let all = samples();
        assert!(all.len() > 100, "{} samples", all.len());
        for (name, bytes) in &all {
            let one = read(bytes);
            let (doc, _) = in_steps(bytes);
            let doc = doc.unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(doc, one, "{name}");
            // The same bytes saved, ids and all (equality leaves a paragraph's id out), and the form round-trips byte for byte
            // from its first save on (a sample from an older version saves fields it lacked).
            let saved = doc.to_json().unwrap();
            assert_eq!(saved, one.to_json().unwrap(), "{name}");
            assert_eq!(in_steps(&saved).0.unwrap().to_json().unwrap(), saved, "{name}");
        }
        // A long body, many steps: the same document.
        let mut doc = read(&all.iter().find(|(n, _)| n.starts_with("fidelity-")).unwrap().1);
        let one = doc.body.clone();
        for _ in 0..200 {
            doc.body.extend(one.iter().cloned());
        }
        let bytes = doc.to_json().unwrap();
        let (read_in_steps, n) = in_steps(&bytes);
        assert!(n > 10, "{n} steps for {} bytes", bytes.len());
        let read_in_steps = read_in_steps.unwrap();
        assert_eq!(read_in_steps, read(&bytes));
        assert_eq!(read_in_steps.to_json().unwrap(), bytes);
    }

    #[test]
    fn a_block_whose_tag_is_not_first_reads_as_one_whose_tag_is() {
        let para = Arc::new(Block::Para(Paragraph::with_text("a", CharProps::default())));
        let cell = Cell { blocks: vec![para.clone()], ..Default::default() };
        let table = Block::Table(Table { rows: vec![Row { cells: vec![cell], ..Default::default() }], ..Default::default() });
        let first = format!(r#"{{"body":[{},{}]}}"#, json(&*para), json(&table));
        let doc = in_steps(first.as_bytes()).0.unwrap();
        assert_eq!(doc.body.iter().map(|b| (**b).clone()).collect::<Vec<_>>(), vec![(*para).clone(), table.clone()]);
        // Each tag moved to its object's end, the table's and its paragraph's.
        let tag_last = |text: &str, kind: &str| {
            let rest = text.strip_prefix(&format!("{{\"kind\":\"{kind}\",")).unwrap();
            format!("{{{},\"kind\":\"{kind}\"}}", &rest[..rest.len() - 1])
        };
        let p = json(&*para);
        let later = format!(r#"{{"body":[{},{}]}}"#, tag_last(&p, "para"), tag_last(&json(&table).replace(&p, &tag_last(&p, "para")), "table"));
        assert_eq!(later.matches(r#""kind""#).count(), 3, "{later}");
        assert_eq!(in_steps(later.as_bytes()).0.unwrap(), doc, "{later}");
        assert_eq!(read(later.as_bytes()), doc);
    }

    #[test]
    fn runs_are_repaired_in_the_body_and_the_parts_as_the_one_piece_read_repairs_them() {
        let form = br#"{"body":[{"kind":"para","text":"abc","runs":[{"len":7}]}],"parts":{"1":{"kind":"header","blocks":[{"kind":"para","text":"de","runs":[]}]}}}"#;
        let doc = in_steps(form).0.unwrap();
        assert_eq!(doc, read(form));
        let lens = |b: &Block| b.as_para().map(|p| p.runs.iter().map(|r| r.len).collect::<Vec<_>>());
        assert_eq!(lens(&doc.body[0]), Some(vec![3]));
        assert_eq!(lens(&doc.parts[&1].blocks[0]), Some(vec![2]));
    }

    #[test]
    fn a_form_that_does_not_read_fails_with_the_one_piece_reads_error() {
        let ok = r#"{"schema":"easywriter.document","version":1,"body":[{"kind":"para","text":"a","runs":[{"len":1}]}],"parts":{}}"#;
        assert_eq!(in_steps(ok.as_bytes()).0.unwrap(), read(ok.as_bytes()));
        for bad in [
            r#"{"body":[{"kind":"para","text":"a","runs":[{"len":1}]},]}"#,
            r#"{"body":[{"kind":"para","text":1}]}"#,
            r#"{"body":[{"kind":"list","text":"a"}]}"#,
            r#"{"body":[{"text":"a"}]}"#,
            r#"{"body":[{}]}"#,
            r#"{"body":[[]]}"#,
            r#"{"body":[{"kind":"para","text":"a","runs":[]}],"parts":7}"#,
            r#"{"body":[{"kind":"para","text":"a","runs":[]}]"#,
            r#"[1]"#,
            r#""#,
        ] {
            let one = serde_json::from_slice::<Document>(bad.as_bytes()).map(|_| ()).map_err(|e| e.to_string());
            assert!(one.is_err(), "{bad}");
            assert_eq!(in_steps(bad.as_bytes()).0.map(|_| ()), one, "{bad}");
        }
        // No body: read in one piece.
        assert_eq!(in_steps(br#"{"parts":{}}"#).0.unwrap(), read(br#"{"parts":{}}"#));
    }

    /// The time to build the Document of a stored form natively, in one piece and in steps (EW_FORM names the file, such as the
    /// Word fixture's form): `cargo test --release -p ew-doc-edit --lib open_form_bench -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn open_form_bench() {
        let Ok(path) = std::env::var("EW_FORM") else { return };
        let bytes = std::fs::read(path).unwrap();
        let (doc, n) = in_steps(&bytes);
        assert_eq!(doc.unwrap(), read(&bytes), "read in {n} steps");
        let ms = |t: std::time::Instant| t.elapsed().as_secs_f64() * 1000.0;
        let (mut one, mut steps) = (vec![], vec![]);
        for _ in 0..15 {
            let t = std::time::Instant::now();
            drop(read(&bytes));
            one.push(ms(t));
            let t = std::time::Instant::now();
            drop(FormSteps::new(bytes.clone()).finish().unwrap());
            steps.push(ms(t));
        }
        let med = |v: &mut Vec<f64>| {
            v.sort_by(f64::total_cmp);
            format!("median {:.1} ms, min {:.1}", v[v.len() / 2], v[0])
        };
        println!("{} bytes, read and normalize_runs: in one piece {}; in steps {}", bytes.len(), med(&mut one), med(&mut steps));
    }
}
