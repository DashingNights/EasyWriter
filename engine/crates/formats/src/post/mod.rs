//! Reading a forum post's stored JSON (docs/plans/engine/stage3-forum.md section 2) into the engine model: the post kit's
//! nodes as paragraphs, headings, quotes, code blocks, boxes, lists, tables and object boxes, its marks as run formatting, and
//! its waiting suggestions as tracked revisions. The post's saved form is the ProseMirror document the DOM editor stored, which
//! is also the engine model's saved draft form.
//!
//! [`read::read`] builds a whole post, style sheet and numbering included. [`read::read_blocks`] reads a block list on its own
//! into a fragment; the numbering instances its lists refer to, and the revisions its suggestions refer to, are the passed
//! document's, which [`read::read`] puts there first. [`write::write`] writes a post back, with every change accepted and the
//! revisions still waiting counted.

mod read;
#[cfg(test)]
mod tests;
mod write;

pub use read::{read, read_blocks};
pub use write::write;
