//! EasyWriter: the calls an assistant needs on a canvas draft (docs/plans/engine/stage2b.md decision 4, stage2b/assistant.md
//! package B). Reads that move neither the selection nor the user's Find state and lay nothing out, addressed by paragraph id
//! (a body paragraph's stable id, as the accessibility copy's `locate` gives it) and UTF-16 offsets into its stored text, in
//! which every object (a picture, a field, a note mark) is one U+FFFC. `select.at` takes the same address, so a step of an
//! assistant's call (`Session::run_as`) finds its paragraph however the steps before it moved the paths. [`Kept`] is the
//! selection such a call puts back.
use serde_json::{Value, json};
use ew_doc::props::CharProps;
use ew_doc::{Paragraph, Path, Pos, StoryRef};

use super::sel_result;
use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

/// At most this many matches come back from `document.find`.
const MAX_MATCHES: usize = 500;

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("document.outline", "Document Outline", "Agents", outline)
            .params(r#"{} → {rev, paragraphs: [{para (id), path, style (its name), level? (1-9, an outline level), list? {num, level}, text (objects as U+FFFC), revs? (revision ids in it), tags? (their suggestion groups)}]}: the body's paragraphs in order, table cells' included, without a layout"#)
            .pure(),
        CommandSpec::new("document.find", "Find in Document", "Agents", find)
            .params(r#"{"text": string, "matchCase"?: bool, "wholeWord"?: bool, "regex"?: bool, "wildcards"?: bool} → {rev, count, matches: [{para, from, to, toPara?, text}]} (UTF-16 offsets, at most 500): the body's matches; the selection and Find and Replace stay as they were"#)
            .pure(),
        CommandSpec::new("document.html", "Range HTML", "Agents", html)
            .params(r#"{"para": id, "from"?: n, "to"?: n, "toPara"?: id} → {html}: the range as the clipboard's HTML (the whole paragraph by default), with nothing copied"#)
            .pure(),
        CommandSpec::new("select.at", "Select by Paragraph", "Agents", select_at)
            .params(r#"{"para": id, "from"?: n (0), "to"?: n (from; the end of toPara with toPara), "toPara"?: id}: selects by paragraph id and UTF-16 offsets; a paragraph no longer there is refused as stale"#)
            .pure(),
    ]
}

/// A paragraph id from `v[key]`: a number or its string (`locate` gives strings).
fn para_id(v: &Value, key: &str) -> Option<u32> {
    match v.get(key)? {
        Value::Number(n) => n.as_u64().and_then(|n| u32::try_from(n).ok()),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// The path of body paragraph `id`, or refused as stale: the caller read the document before that paragraph went.
fn para_path(s: &Session, id: u32) -> Result<Path, CmdError> {
    (id != 0).then(|| s.doc.para_path_by_id(id)).flatten().ok_or_else(|| CmdError::Params(format!("stale: no paragraph {id} in the body")))
}

/// The UTF-16 offset of byte `byte` of `text`.
fn u16_at(text: &str, byte: usize) -> usize {
    text.char_indices().take_while(|(i, _)| *i < byte).map(|(_, c)| c.len_utf16()).sum()
}

/// The byte offset of UTF-16 offset `u` in `text` (a character's start; its end past the text).
fn byte_at(text: &str, u: u64) -> usize {
    let mut n = 0u64;
    for (i, c) in text.char_indices() {
        if n >= u {
            return i;
        }
        n += c.len_utf16() as u64;
    }
    text.len()
}

/// The body range `{para, from?, to?, toPara?}` names (UTF-16 offsets). `from` is 0 when left out; `to` is the end of
/// `toPara` (or of `para`) when `whole` or `toPara` is given, else `from` (a caret).
pub(crate) fn range(s: &mut Session, v: &Value, whole: bool) -> Result<(Pos, Pos), CmdError> {
    s.note_ids();
    let id = para_id(v, "para").ok_or_else(|| CmdError::Params("`para`: a paragraph id (document.outline)".into()))?;
    let pa = para_path(s, id)?;
    let to_para = para_id(v, "toPara");
    let pb = match to_para {
        Some(t) => para_path(s, t)?,
        None => pa.clone(),
    };
    let text = |path: &Path| s.doc.para(StoryRef::Body, path).map_or("", |p| p.text.as_str());
    let a = Pos::new(StoryRef::Body, pa.clone(), byte_at(text(&pa), p::u64(v, "from").unwrap_or(0)));
    let off = match p::u64(v, "to") {
        Some(u) => byte_at(text(&pb), u),
        None if whole || to_para.is_some() => text(&pb).len(),
        None => a.off,
    };
    Ok((a, Pos::new(StoryRef::Body, pb, off)))
}

/// The revisions paragraph `p` holds: its text's, its mark's and its formatting's.
pub(crate) fn revisions_of(p: &Paragraph) -> std::collections::BTreeSet<u32> {
    let mut out = std::collections::BTreeSet::new();
    let mut char_props = |c: &CharProps| out.extend([c.ins, c.del, c.fmt_change.as_ref().map(|f| f.rev)].into_iter().flatten());
    for r in &p.runs {
        char_props(&r.props);
    }
    char_props(&p.mark);
    out.extend(p.props.fmt_change.as_ref().map(|c| c.rev));
    out.extend(p.props.num_change.as_ref().map(|c| c.rev));
    out.extend(p.section.as_ref().and_then(|x| x.fmt_change.as_ref()).map(|c| c.rev));
    out
}

fn outline(s: &mut Session, _: &Value) -> CmdResult {
    s.note_ids();
    let doc = &s.doc;
    let mut out = Vec::new();
    for path in doc.para_paths(StoryRef::Body) {
        let Some(p) = doc.para(StoryRef::Body, &path) else { continue };
        let id = p.props.style.as_deref().unwrap_or("Normal");
        let style = doc.styles.get(id).map_or(id, |st| st.name.as_str());
        let mut o = json!({"para": p.id.0.to_string(), "path": path.0, "style": style, "text": p.text});
        if let Some(l) = doc.styles.resolve_para(&p.props).outline_level.filter(|l| *l < 9) {
            o["level"] = json!(l + 1);
        }
        if let Some(n) = p.props.numbering.filter(|n| n.num != 0) {
            o["list"] = json!({"num": n.num, "level": n.level});
        }
        let revs = revisions_of(p);
        if !revs.is_empty() {
            let tags: std::collections::BTreeSet<&str> = revs.iter().filter_map(|r| doc.revisions.get(*r as usize)?.tag.as_deref()).collect();
            if !tags.is_empty() {
                o["tags"] = json!(tags);
            }
            o["revs"] = json!(revs);
        }
        out.push(o);
    }
    Ok(json!({"rev": s.rev(), "paragraphs": out}))
}

fn find(s: &mut Session, v: &Value) -> CmdResult {
    let query = p::req_str(v, "text")?.to_string();
    s.note_ids();
    // The search reads its options from the session's Find state: a state of its own for this search, the user's back after.
    let opt = |k| p::bool(v, k).unwrap_or(false);
    let mine = crate::session::FindState {
        query,
        match_case: opt("matchCase"),
        whole_word: opt("wholeWord"),
        regex: opt("regex"),
        wildcards: opt("wildcards"),
        literal: true,
        ..Default::default()
    };
    let user = std::mem::replace(&mut s.find, mine);
    let found = super::edit::search(s, StoryRef::Body);
    s.find = user;
    let found = found?;
    let doc = &s.doc;
    let end = |pos: &Pos| doc.para(StoryRef::Body, &pos.path).map(|p| (p.id.0.to_string(), u16_at(&p.text, pos.off)));
    let matches: Vec<Value> = found
        .iter()
        .take(MAX_MATCHES)
        .filter_map(|(a, b)| {
            let ((pa, from), (pb, to)) = (end(a)?, end(b)?);
            let mut m = json!({"para": pa, "from": from, "to": to, "text": doc.copy_range(a, b).plain_text()});
            if pb != pa {
                m["toPara"] = json!(pb);
            }
            Some(m)
        })
        .collect();
    Ok(json!({"rev": s.rev(), "count": found.len(), "matches": matches}))
}

fn html(s: &mut Session, v: &Value) -> CmdResult {
    let (a, b) = range(s, v, true)?;
    let (a, b) = if a <= b { (a, b) } else { (b, a) };
    let frag = s.doc.copy_range(&a, &b);
    Ok(json!({"html": ew_formats::html::export_fragment(&frag.to_document())}))
}

fn select_at(s: &mut Session, v: &Value) -> CmdResult {
    let (anchor, focus) = range(s, v, false)?;
    s.sel = Selection { anchor, focus };
    sel_result(s)
}

/// The byte offset in `new` of byte `off` of `old`, a paragraph's text before and after edits. Text
/// before the first difference keeps its offset, text after the last keeps its distance from the end, and an offset inside
/// the changed part goes to its end.
fn map_offset(old: &str, new: &str, off: usize) -> usize {
    let mut pre = old.bytes().zip(new.bytes()).take_while(|(x, y)| x == y).count();
    while !old.is_char_boundary(pre) {
        pre -= 1;
    }
    let room = old.len().min(new.len()) - pre;
    let suf = old.bytes().rev().zip(new.bytes().rev()).take(room).take_while(|(x, y)| x == y).count();
    let mut at = if off <= pre {
        off
    } else if old.len() - off.min(old.len()) <= suf {
        new.len() - (old.len() - off.min(old.len()))
    } else {
        new.len() - suf
    };
    while !new.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// One end of a kept selection: where it was, and its body paragraph's id and text then.
struct End {
    pos: Pos,
    id: u32,
    text: String,
}

impl End {
    fn of(s: &Session, pos: &Pos) -> End {
        let p = (pos.story == StoryRef::Body).then(|| s.doc.para(StoryRef::Body, &pos.path)).flatten();
        End { pos: pos.clone(), id: p.map_or(0, |p| p.id.0), text: p.map(|p| p.text.clone()).unwrap_or_default() }
    }

    /// Where it is now: in its paragraph wherever that went, at the same place in the text.
    fn now(&self, s: &Session) -> Pos {
        let at = |path: &Path| s.doc.para(StoryRef::Body, path).filter(|p| p.id.0 == self.id);
        let path = match at(&self.pos.path) {
            Some(_) => Some(self.pos.path.clone()),
            None if self.id != 0 => s.doc.para_path_by_id(self.id),
            None => None,
        };
        match path.and_then(|path| Some((at(&path)?.text.as_str(), path))) {
            Some((text, path)) => Pos::new(StoryRef::Body, path, map_offset(&self.text, text, self.pos.off)),
            None => s.doc.clamp(&self.pos),
        }
    }
}

/// The user's selection and the formatting waiting at the caret, kept by paragraph id across edits that move the paths
/// under them (an assistant's call, Accept or Reject by revision id), so they go back where they were.
pub(crate) struct Kept {
    anchor: End,
    focus: End,
    pending: Option<CharProps>,
}

impl Kept {
    pub(crate) fn of(s: &mut Session) -> Kept {
        s.note_ids();
        Kept { anchor: End::of(s, &s.sel.anchor), focus: End::of(s, &s.sel.focus), pending: s.pending.clone() }
    }

    pub(crate) fn restore(self, s: &mut Session) {
        s.note_ids();
        s.sel = Selection { anchor: self.anchor.now(s), focus: self.focus.now(s) };
        s.pending = self.pending;
        s.clamp_selection();
    }
}

#[cfg(test)]
mod tests;
