//! References tab: table of contents, footnotes/endnotes, captions; field updates.

use serde_json::{Value, json};
use ew_doc::numbering::{Counters, LevelSuffix};
use ew_doc::para::{InlineObject, NoteKind, OBJ};
use ew_doc::props::{CharProps, TabAlign, TabLeader, TabStop};
use ew_doc::section::NumFormat;
use ew_doc::{Block, Paragraph, PartKind, Path, Pos, StoryRef, para_block};

use super::{delete_selection, sel_result};
use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

mod fields;
mod manual;
mod notes;
mod properties;
mod summary;
mod toc;

use fields::caption;
pub use fields::{CHAPTER_SEPARATORS, refresh_date_fields, seq_format, update_fields, update_fields_in, update_seq};
pub(super) use notes::note_options;
use notes::{note, note_refs};
pub use properties::{bookmark_text, date_picture};
#[cfg(test)]
use toc::cached_toc_tabs;
pub use toc::{caret_in_toc, leader, level_range, toc_instr, update_toc};
pub use manual::toc_blocks_at;
pub(crate) use toc::{headings, toc_bookmark};
use toc::{insert_toc, remove_toc, toc_range};

/// Why Insert Footnote and Insert Endnote are off: as in Word, a note goes in the main text, never in a note, a header or a
/// text box.
fn body_only(s: &Session) -> Option<&'static str> {
    (s.sel.focus.story != StoryRef::Body).then_some("notes go in the main text")
}

/// Why the table of contents commands are off: the document has none. Read from the body's summary, which only reads the
/// blocks changed since the last call (summary.rs).
fn no_toc(s: &Session) -> Option<&'static str> {
    (!summary::body(s).toc).then_some("the document has no table of contents")
}

/// Why Remove Table of Contents is off: the document has neither a field table nor a manual one.
fn no_toc_to_remove(s: &Session) -> Option<&'static str> {
    let x = summary::body(s);
    (!x.toc && !x.manual_toc).then_some("the document has no table of contents")
}

/// Why the note commands are off: the document has no notes (of `kind`), from the body's summary.
fn no_notes(s: &Session, kind: Option<NoteKind>) -> Option<&'static str> {
    let x = summary::body(s);
    let n = match kind {
        Some(NoteKind::Footnote) => x.footnotes,
        Some(NoteKind::Endnote) => x.endnotes,
        None => x.footnotes + x.endnotes,
    };
    if n > 0 {
        return None;
    }
    Some(match kind {
        Some(NoteKind::Footnote) => "the document has no footnotes",
        Some(NoteKind::Endnote) => "the document has no endnotes",
        None => "the document has no notes yet",
    })
}

/// The note id of the reference at `p`, if a note reference sits there.
fn note_id_at(s: &Session, p: &Pos) -> Option<u32> {
    match s.doc.para(p.story, &p.path)?.object_at(p.off) {
        Some(InlineObject::NoteRef { id, .. }) => Some(*id),
        _ => None,
    }
}

/// The note part the caret is in, if it is in a footnote or an endnote.
fn caret_note(s: &Session) -> Option<u32> {
    match s.sel.focus.story {
        StoryRef::Part(id) if s.doc.parts.get(&id).is_some_and(|p| matches!(p.kind, PartKind::Footnote | PartKind::Endnote)) => Some(id),
        _ => None,
    }
}

/// Next and previous footnote or endnote (Word's Next Footnote menu): the caret goes before that reference. From inside a
/// note the walk starts at its reference.
fn next_note(s: &mut Session, v: &Value) -> CmdResult {
    let kind = match p::str(v, "kind") {
        None | Some("footnote") => NoteKind::Footnote,
        Some("endnote") => NoteKind::Endnote,
        Some(k) => return Err(CmdError::Params(format!("unknown `kind` {k:?}; use footnote or endnote"))),
    };
    let back = p::bool(v, "back").unwrap_or(false);
    let inside = caret_note(s);
    let caret = inside.and_then(|id| note_refs(s, None).into_iter().find(|p| note_id_at(s, p) == Some(id))).unwrap_or_else(|| s.sel.focus.clone());
    let refs = note_refs(s, Some(kind));
    let hit = if back { refs.iter().rev().find(|p| **p < caret).or(refs.last()) } else { refs.iter().find(|p| **p > caret).or(refs.first()) };
    if let Some(p) = hit {
        s.sel = Selection::caret(p.clone());
    }
    sel_result(s)
}

/// Show Notes: from a note back to its reference; elsewhere into the note of the reference at the caret (beside it), else of
/// the next reference, wrapping round. `id`: into that note (another view's reveal: the navigation pane, find).
fn show_note(s: &mut Session, v: &Value) -> CmdResult {
    if let Some(id) = p::u64(v, "id") {
        let id = u32::try_from(id).map_err(|_| CmdError::Params("bad note `id`".into()))?;
        if !s.doc.parts.get(&id).is_some_and(|p| matches!(p.kind, PartKind::Footnote | PartKind::Endnote)) {
            return Err(CmdError::Params(format!("no note {id}")));
        }
        s.sel = Selection::caret(s.doc.end_of(StoryRef::Part(id)));
        return sel_result(s);
    }
    let refs = note_refs(s, None);
    if let Some(id) = caret_note(s) {
        let p = refs.iter().find(|p| note_id_at(s, p) == Some(id)).ok_or_else(|| CmdError::Failed("the note has no reference".into()))?;
        s.sel = Selection::caret(Pos { off: p.off + OBJ.len_utf8(), ..p.clone() });
        return sel_result(s);
    }
    let c = s.sel.focus.clone();
    let beside = |p: &&Pos| p.story == c.story && p.path == c.path && (p.off == c.off || p.off + OBJ.len_utf8() == c.off);
    let at = refs.iter().find(beside).or_else(|| refs.iter().find(|p| **p >= c)).or(refs.first());
    let id = at.and_then(|p| note_id_at(s, p)).ok_or_else(|| CmdError::Disabled("the document has no notes".into()))?;
    s.sel = Selection::caret(s.doc.end_of(StoryRef::Part(id)));
    sel_result(s)
}

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("references.toc", "Table of Contents", "References › Table of Contents", insert_toc).params(
            r#"{"levels"?: 1-9, "title"?: string, "pageNumbers"?: bool, "rightAlign"?: bool, "tabLeader"?: "dot|hyphen|underscore|none", "hyperlinks"?: bool, "headingStyles"?: bool, "outlineLevels"?: bool, "tcFields"?: bool, "styleLevels"?: {style name: 1-9}} (replaces an existing table; {} updates it)"#,
        ),
        CommandSpec::new("references.updateToc", "Update Table", "References › Table of Contents", |s, _| {
            update_toc(s)?;
            sel_result(s)
        })
        .when(no_toc),
        CommandSpec::new("references.removeToc", "Remove Table of Contents", "References › Table of Contents", |s, _| {
            if let Some((start, end)) = toc_range(s) {
                remove_toc(s, start, end)?;
                s.clamp_selection();
            } else if let Some(r) = manual::manual_range(s, true) {
                manual::remove_manual(s, r)?;
            }
            sel_result(s)
        })
        .when(no_toc_to_remove),
        CommandSpec::new("references.manualToc", "Manual Table", "References › Table of Contents", manual::manual_toc)
            .params(r#"{"title"?: string (Table of Contents), "tabLeader"?: "dot|hyphen|underscore|none"} (Word's typed entries, no field, in a Table of Contents control)"#)
            .when(body_only),
        CommandSpec::new("references.addText", "Add Text", "References › Table of Contents", |s, v| {
            let level = p::u64(v, "level").unwrap_or(0).min(9) as u8;
            super::para::fmt(s, &|pp| pp.outline_level = if level == 0 { Some(9) } else { Some(level - 1) })
        })
        .params(r#"{"level": 0 (do not show) | 1-9}"#),
        CommandSpec::new("references.footnote", "Insert Footnote", "References › Footnotes", |s, v| note(s, v, NoteKind::Footnote))
            .when(body_only)
            .key("Mod+Alt+F")
            .params(r#"{"text"?: string, "mark"?: string (a custom mark instead of the number)}"#),
        CommandSpec::new("references.endnote", "Insert Endnote", "References › Footnotes", |s, v| note(s, v, NoteKind::Endnote))
            .when(body_only)
            // macOS takes ⌘⌥D to show and hide the Dock; Word for Mac uses ⌘⌥E.
            .key(super::mac_or("Mod+Alt+E", "Mod+Alt+D"))
            .params(r#"{"text"?: string, "mark"?: string (a custom mark instead of the number)}"#),
        CommandSpec::new("references.convertNotes", "Convert Notes", "References › Footnotes", |s, v| {
            let (foot, end) = match p::req_str(v, "to")? {
                "endnote" | "endnotes" => (true, false),
                "footnote" | "footnotes" => (false, true),
                "swap" => (true, true),
                t => return Err(CmdError::Params(format!("unknown `to` {t:?}; use endnote, footnote or swap"))),
            };
            let n = s.doc.convert_notes(foot, end);
            Ok(json!({"converted": n}))
        })
        .params(r#"{"to": "endnote" (footnotes become endnotes) | "footnote" (endnotes become footnotes) | "swap"}"#)
        .when(|s| no_notes(s, None)),
        CommandSpec::new("references.nextFootnote", "Next Footnote", "References › Footnotes", next_note)
            .key(super::non_mac("Alt+Shift+> / Alt+Shift+."))
            .params(r#"{"back"?: bool (the previous one)} — wraps round"#)
            .when(|s| no_notes(s, Some(NoteKind::Footnote)))
            .pure(),
        CommandSpec::new("references.nextEndnote", "Next Endnote", "References › Footnotes", |s, v| {
            next_note(s, &json!({"kind": "endnote", "back": p::bool(v, "back").unwrap_or(false)}))
        })
        .params(r#"{"back"?: bool (the previous one)} — wraps round"#)
        .when(|s| no_notes(s, Some(NoteKind::Endnote)))
        .pure(),
        CommandSpec::new("references.showNote", "Show Notes", "References › Footnotes", show_note)
            .params(r#"{"id"?: note id (into that note)} — else between the note and its reference"#)
            .when(|s| no_notes(s, None))
            .pure(),
        CommandSpec::new("references.notes", "Show Notes", "References › Footnotes", |s, _| {
            let mut out = Vec::new();
            for (id, part) in &s.doc.parts {
                if matches!(part.kind, PartKind::Footnote | PartKind::Endnote) {
                    out.push(json!({"id": id, "kind": part.kind, "text": s.doc.plain_text(StoryRef::Part(*id))}));
                }
            }
            Ok(Value::Array(out))
        })
        .pure(),
        CommandSpec::new("references.caption", "Insert Caption", "References › Captions", caption)
            .params(r#"{"label"?: "Figure|Table|Equation|any label", "text"?: string, "position"?: "below|above", "excludeLabel"?: bool, "format"?: "ARABIC|alphabetic|ALPHABETIC|roman|ROMAN", "chapter"?: heading level 1-9, "separator"?: "-|.|:|—|–"}"#),
        // F9: update fields; the selected ones that showed their code show their result again.
        CommandSpec::new("references.updateFields", "Update Field", "References", |s, v| {
            update_fields_in(s, v.get("all").and_then(Value::as_bool).unwrap_or(false))?;
            super::fields::show_results(s)?;
            sel_result(s)
        })
        .params(r#"{"all"?: bool (the body and every header, footer, note and text box, wherever the caret is; default: the story the caret is in)}"#)
        .key("F9"),
    ]
}

/// A field instruction split into its name, positional arguments and switches (ECMA-376
/// §17.16.1): `TOC \o "1-3" \h` → name `TOC`, switches `o` = `1-3` and `h`. Quoted text stays
/// whole (without the quotes; `\"` and `\\` inside it are a quote and a backslash). A switch
/// takes the word after it as its argument unless that word is another switch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FieldCode {
    pub name: String,
    pub args: Vec<String>,
    /// Switch letter (lower-cased; `*`, `@`, `#` for the general switches) and argument.
    pub switches: Vec<(char, Option<String>)>,
}

impl FieldCode {
    pub fn parse(instr: &str) -> FieldCode {
        let mut words: Vec<(String, bool)> = Vec::new();
        let mut chars = instr.chars().peekable();
        while let Some(&c) = chars.peek() {
            if c.is_whitespace() {
                chars.next();
            } else if c == '"' {
                chars.next();
                let mut w = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' if matches!(chars.peek(), Some('"' | '\\')) => w.extend(chars.next()),
                        c => w.push(c),
                    }
                }
                words.push((w, true));
            } else {
                let mut w = String::new();
                while let Some(&c) = chars.peek() {
                    if c.is_whitespace() || (c == '"' && !w.is_empty()) {
                        break;
                    }
                    w.push(c);
                    chars.next();
                }
                words.push((w, false));
            }
        }
        let mut words = words.into_iter().peekable();
        let mut f =
            FieldCode { name: words.next().map(|(w, _)| w.trim_start_matches('=').to_ascii_uppercase()).unwrap_or_default(), ..Default::default() };
        while let Some((w, quoted)) = words.next() {
            let sw = if quoted { None } else { w.strip_prefix('\\').and_then(|r| r.chars().next()) };
            match sw {
                Some(c) => {
                    let arg = match words.peek() {
                        Some((n, q)) if *q || !n.starts_with('\\') => words.next().map(|(n, _)| n),
                        _ => None,
                    };
                    f.switches.push((c.to_ascii_lowercase(), arg));
                }
                None => f.args.push(w),
            }
        }
        f
    }

    pub fn has(&self, c: char) -> bool {
        self.switches.iter().any(|(k, _)| *k == c)
    }

    /// A table of figures (`TOC \c` or `TOC \a`, ECMA-376 §17.16.5.68), not a table of contents.
    pub fn is_table_of_figures(&self) -> bool {
        self.name == "TOC" && (self.has('c') || self.has('a'))
    }

    /// The argument of switch `c`, if the switch is there with one.
    pub fn arg(&self, c: char) -> Option<&str> {
        self.switches.iter().find(|(k, _)| *k == c).and_then(|(_, a)| a.as_deref())
    }
}

#[cfg(test)]
mod tests;
