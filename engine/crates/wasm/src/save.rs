//! The engine form's save, kept by block (docs/plans/engine/viewport-design.md P12): an autosave serialises only the body
//! blocks that changed since the last one and copies the others' bytes. Blocks are `Arc`-shared and copy-on-write, so a block
//! whose `Arc` is the one serialised last time holds the same content; the cache holds that `Arc`, so its address cannot be
//! freed and reused by another block while it is compared. The bytes are exactly `serde_json::to_vec(&doc)`'s.
//!
//! A save runs in steps (`begin`, `step`, `finish`), so the worker can take a key between them: the body is taken as it is at
//! `begin` (its `Arc`s), and an edit made while the steps run goes to the next save.
use std::collections::HashMap;
use std::sync::Arc;

use ew_doc_edit::doc::Block;
use ew_doc_edit::doc::Document;

/// A block's stored form, `serde_json::to_vec`'s bytes, through the doc crate's one serialiser (`write_block`).
fn block_json(b: &Block) -> serde_json::Result<Vec<u8>> {
    let mut v = Vec::with_capacity(128);
    ew_doc_edit::doc::write_block(&mut v, b).map(|()| v)
}

/// The JSON a document's body starts with when it is empty: the place the blocks go.
const EMPTY_BODY: &[u8] = br#""body":[]"#;

type Blocks = HashMap<usize, (Arc<Block>, Vec<u8>)>;

/// A save in progress: the body as it was at `begin`, everything else already serialised (`shell`, the body going at `at`).
struct Job {
    body: Vec<Arc<Block>>,
    shell: Vec<u8>,
    at: usize,
    out: Vec<u8>,
    old: Blocks,
    next: Blocks,
    i: usize,
}

/// Each body block's bytes as last saved, by the address of the `Arc` they came from, and the save in progress.
#[derive(Default)]
pub(crate) struct SaveCache {
    blocks: Blocks,
    job: Option<Job>,
    /// The last save's size, to allocate the next one's at once.
    size: usize,
}

impl SaveCache {
    /// `doc` as the engine form (compact JSON), in one go.
    pub(crate) fn save(&mut self, doc: &mut Document) -> serde_json::Result<Vec<u8>> {
        self.begin(doc)?;
        self.finish()
    }

    /// Begins a save of `doc`: everything but the body is serialised now (it is not kept); the body's blocks come in the
    /// steps. A save still in progress is completed first and its bytes dropped.
    pub(crate) fn begin(&mut self, doc: &mut Document) -> serde_json::Result<()> {
        if self.job.is_some() {
            self.finish()?;
        }
        let body = std::mem::take(&mut doc.body);
        let shell = doc.to_json();
        doc.body = body;
        let shell = shell?;
        // The body comes third, after the schema's name and version, so the first empty body is it. Were it missing, the
        // whole document is serialised here and there are no steps.
        let (shell, at, body) = match shell.windows(EMPTY_BODY.len()).position(|w| w == EMPTY_BODY) {
            Some(i) => (shell, i + EMPTY_BODY.len() - 1, doc.body.clone()),
            None => {
                let whole = doc.to_json()?;
                let n = whole.len();
                (whole, n, Vec::new())
            }
        };
        let mut out = Vec::with_capacity(self.size.max(shell.len()));
        out.extend_from_slice(&shell[..at]);
        let next = HashMap::with_capacity(body.len());
        self.job = Some(Job { body, shell, at, out, old: std::mem::take(&mut self.blocks), next, i: 0 });
        Ok(())
    }

    /// Adds the next body blocks to the save in progress, about `budget` bytes of them → whether all are in.
    pub(crate) fn step(&mut self, budget: usize) -> serde_json::Result<bool> {
        let Some(j) = self.job.as_mut() else { return Ok(true) };
        let start = j.out.len();
        while j.i < j.body.len() {
            if j.out.len() - start >= budget {
                return Ok(false);
            }
            let b = &j.body[j.i];
            let key = Arc::as_ptr(b) as usize;
            let bytes = match j.old.remove(&key) {
                Some((held, bytes)) if Arc::ptr_eq(&held, b) => bytes,
                _ => match block_json(b) {
                    Ok(v) => v,
                    Err(e) => {
                        self.job = None;
                        return Err(e);
                    }
                },
            };
            if j.i > 0 {
                j.out.push(b',');
            }
            j.out.extend_from_slice(&bytes);
            j.next.insert(key, (b.clone(), bytes));
            j.i += 1;
        }
        Ok(true)
    }

    /// The bytes of the save in progress, its remaining steps run now; the cache then holds its blocks.
    pub(crate) fn finish(&mut self) -> serde_json::Result<Vec<u8>> {
        while !self.step(usize::MAX)? {}
        let Some(mut j) = self.job.take() else { return Ok(Vec::new()) };
        j.out.extend_from_slice(&j.shell[j.at..]);
        self.blocks = j.next;
        self.size = j.out.len();
        Ok(j.out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_bytes_as_serde_after_edits() {
        let mut s = ew_doc_edit::Session::new(ew_doc_edit::blank_document(&Default::default()));
        let mut cache = SaveCache::default();
        for i in 0..6 {
            s.run("text.insert", &serde_json::json!({"text": format!("Line {i} of the text.")})).unwrap();
            if i % 2 == 0 {
                s.run("text.newParagraph", &serde_json::json!({})).unwrap();
            }
            let want = serde_json::to_vec(&s.doc).unwrap();
            if i % 3 == 0 {
                assert_eq!(cache.save(&mut s.doc).unwrap(), want, "save {i}");
            } else {
                // In steps of a few bytes, with an edit between them that goes to the next save.
                cache.begin(&mut s.doc).unwrap();
                assert!(!cache.step(1).unwrap() || s.doc.body.len() < 2);
                s.run("text.insert", &serde_json::json!({"text": "later"})).unwrap();
                while !cache.step(8).unwrap() {}
                assert_eq!(cache.finish().unwrap(), want, "save {i} in steps");
            }
        }
        assert_eq!(cache.save(&mut s.doc).unwrap(), serde_json::to_vec(&s.doc).unwrap());
        assert_eq!(cache.blocks.len(), s.doc.body.len());
    }
}

#[cfg(test)]
mod timing {
    use super::*;

    /// Where an autosave of the Word fixture spends its time, natively: `cargo test --release -p ew-wasm --lib save_split -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn save_split() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.smoke-data/word/fixture/all-features.docx");
        let Ok(bytes) = std::fs::read(&path) else { return };
        let mut doc = ew_doc_edit::io::open_bytes("document.docx", &bytes).unwrap();
        let t = std::time::Instant::now();
        let full = serde_json::to_vec(&doc).unwrap();
        let whole = t.elapsed();
        let body = std::mem::take(&mut doc.body);
        let t = std::time::Instant::now();
        let shell = serde_json::to_vec(&doc).unwrap();
        let shell_t = t.elapsed();
        let media: usize = doc.media.values().map(|m| m.len()).sum();
        doc.body = body;
        let mut cache = SaveCache::default();
        cache.save(&mut doc).unwrap();
        let t = std::time::Instant::now();
        let again = cache.save(&mut doc).unwrap();
        let cached = t.elapsed();
        assert_eq!(again, full);
        println!("whole {whole:?} ({} bytes), shell {shell_t:?} ({} bytes, media {media} bytes), cached save {cached:?}", full.len(), shell.len());
    }
}
