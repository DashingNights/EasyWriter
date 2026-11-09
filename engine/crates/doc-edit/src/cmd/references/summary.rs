//! What the note and table of contents states read from the body (gaps.md's open item: their states scanned the whole document
//! on each state call, about 10 ms of a 14 ms call on the Word fixture), kept per top-level block and read again only for the
//! blocks a change replaced.
//!
//! The cache holds a `Weak` to each block it summed up. While a `Weak` is held the block's allocation stays, so no other block
//! can take its address, and a change to the block (`Arc::make_mut`) moves it to a new allocation: an address the cache knows
//! whose block is still alive is that block, unchanged.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Weak};

use ew_doc::para::{InlineObject, NoteKind};
use ew_doc::{Block, ControlKind, Paragraph};

use super::FieldCode;
use crate::Session;

/// What one block holds: note references by kind, a table of contents field, a manual table of contents.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Summary {
    pub footnotes: u32,
    pub endnotes: u32,
    pub toc: bool,
    pub manual_toc: bool,
}

impl Summary {
    fn add(&mut self, o: Summary) {
        self.footnotes += o.footnotes;
        self.endnotes += o.endnotes;
        self.toc |= o.toc;
        self.manual_toc |= o.manual_toc;
    }
}

/// The body's blocks as last summed, in order: each one's address, a `Weak` to it and its summary.
type Cache = Vec<(usize, Weak<Block>, Summary)>;

thread_local! {
    // One worker thread runs every session; another session's blocks are summed again when it is read next.
    static CACHE: RefCell<Cache> = const { RefCell::new(Vec::new()) };
}

/// Block `b`'s cached summary when `e` is that block, unchanged.
fn kept(e: &(usize, Weak<Block>, Summary), b: &Arc<Block>) -> Option<Summary> {
    (e.0 == Arc::as_ptr(b) as usize && e.1.strong_count() > 0).then_some(e.2)
}

/// The body's summary, from the cache for the blocks no change replaced. A keystroke keeps the block count, so the blocks are
/// compared in place; a change of count (a paragraph split or joined) finds the unchanged blocks by address.
pub(super) fn body(s: &Session) -> Summary {
    CACHE.with(|c| {
        let mut cache = c.borrow_mut();
        let body = &s.doc.body;
        if cache.len() == body.len() {
            for (e, b) in cache.iter_mut().zip(body) {
                if kept(e, b).is_none() {
                    *e = (Arc::as_ptr(b) as usize, Arc::downgrade(b), of_block(b, true));
                }
            }
        } else {
            let old: HashMap<usize, (Weak<Block>, Summary)> = cache.drain(..).map(|(k, w, x)| (k, (w, x))).collect();
            cache.extend(body.iter().map(|b| {
                let key = Arc::as_ptr(b) as usize;
                let one = old.get(&key).filter(|(w, _)| w.strong_count() > 0).map_or_else(|| of_block(b, true), |(_, x)| *x);
                (key, Arc::downgrade(b), one)
            }));
        }
        let mut sum = Summary::default();
        for e in cache.iter() {
            sum.add(e.2);
        }
        sum
    })
}

fn of_block(b: &Block, top: bool) -> Summary {
    let mut sum = Summary::default();
    match b {
        Block::Para(p) => sum.add(of_para(p, top)),
        _ => {
            for (_, _, list) in b.lists() {
                for b in list {
                    sum.add(of_block(b, false));
                }
            }
        }
    }
    sum
}

/// A TOC field that is no table of figures.
fn is_toc(instr: &str) -> bool {
    let f = FieldCode::parse(instr);
    f.name == "TOC" && !f.is_table_of_figures()
}

fn of_para(p: &Paragraph, top: bool) -> Summary {
    let mut sum = Summary::default();
    for o in &p.objects {
        match o {
            InlineObject::NoteRef { kind: NoteKind::Footnote, .. } => sum.footnotes += 1,
            InlineObject::NoteRef { kind: NoteKind::Endnote, .. } => sum.endnotes += 1,
            // The engine's own table is a simple field in a top-level paragraph; one from a file is a range field anywhere.
            InlineObject::Field { instr, .. } if top && is_toc(instr) => sum.toc = true,
            InlineObject::FieldStart { instr, .. } if is_toc(instr) => sum.toc = true,
            InlineObject::ControlStart { control }
                if matches!(&control.kind, ControlKind::Gallery { gallery, .. } if gallery == super::manual::TOC_GALLERY) =>
            {
                sum.manual_toc = true
            }
            _ => {}
        }
    }
    sum
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// A footnote typed in counts; an edit elsewhere reuses the other blocks' sums and still sees it; deleting it drops it.
    #[test]
    fn follows_edits() {
        let mut s = Session::new(ew_doc::Document::from_text("one\ntwo\nthree"));
        assert_eq!(body(&s), Summary::default());
        s.run("references.footnote", &json!({"text": "note"})).unwrap();
        s.sel = crate::Selection::caret(s.doc.end_of(ew_doc::StoryRef::Body));
        assert_eq!(body(&s).footnotes, 1);
        s.run("text.insert", &json!({"text": " more"})).unwrap();
        assert_eq!(body(&s).footnotes, 1, "an edit in another paragraph keeps the count");
        s.run("references.toc", &json!({})).unwrap();
        assert!(body(&s).toc);
        s.run("edit.undo", &json!({})).unwrap();
        assert!(!body(&s).toc, "undo takes the table away again");
        assert_eq!(body(&s), {
            let mut x = Summary::default();
            for b in &s.doc.body {
                x.add(of_block(b, true));
            }
            x
        });
    }
}
