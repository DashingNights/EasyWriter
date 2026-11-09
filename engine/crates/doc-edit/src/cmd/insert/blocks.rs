//! The document's building blocks by gallery (docs/plans/engine/stage2.md gap G5): Create New Building Block and every Save
//! Selection to … Gallery item on a canvas draft save the selection into the document's own building blocks (its glossary
//! part, kept in its file), in any of Word's galleries with a category, a description and an insert rule; the galleries and the
//! Organizer list them, insert them and delete them. The user's own blocks stay in the app's settings (the stage-2 decision);
//! `insert.quickParts` and `insert.autoText` keep this session's blocks by name.

use std::sync::Arc;

use super::{CmdError, CmdResult, Selection, Session, Value, delete_selection, json, p, sel_result};

/// Word's insert rules (`w:behavior`): the content only, in its own paragraph, on its own page.
const BEHAVIORS: [&str; 3] = ["content", "p", "pg"];

/// The document's building blocks: `[{name, gallery, category, description, behavior}]`, `gallery` as the file writes it
/// (`docParts`, `autoTxt`, `hdrs`, `coverPg`…), in the glossary's order.
pub(in crate::cmd) fn list(s: &mut Session, _: &Value) -> CmdResult {
    Ok(Value::Array(
        s.doc
            .glossary
            .iter()
            .filter(|e| !e.types.iter().any(|t| t == "bbPlcHdr"))
            .map(|e| {
                json!({"name": e.name, "gallery": e.gallery, "category": e.category, "description": e.description,
                    "behavior": e.behaviors.first().map(String::as_str).unwrap_or("content")})
            })
            .collect(),
    ))
}

/// Saves the selection as building block `name` of `gallery`, replacing one of that name there.
pub(in crate::cmd) fn save(s: &mut Session, v: &Value) -> CmdResult {
    let name = p::req_str(v, "name")?.trim().to_string();
    let gallery = p::req_str(v, "gallery")?.to_string();
    if name.is_empty() || gallery.is_empty() {
        return Err(CmdError::Params("a building block needs a name and a gallery".into()));
    }
    let behavior = p::str(v, "behavior").unwrap_or("content");
    if !BEHAVIORS.contains(&behavior) {
        return Err(CmdError::Params(format!("unknown `behavior` {behavior:?}; use content, p or pg")));
    }
    let blocks: ew_doc::Blocks = match whole_target(s, &gallery) {
        Some(blocks) => blocks,
        None => {
            let (a, b) = s.sel.ordered();
            if a == b {
                return Err(CmdError::Disabled("select what to save first".into()));
            }
            s.doc.copy_range(&a, &b).blocks.into_iter().map(Arc::new).collect()
        }
    };
    let entry = ew_doc::BuildingBlock {
        name: name.clone(),
        gallery: gallery.clone(),
        category: p::str(v, "category").filter(|c| !c.trim().is_empty()).unwrap_or("General").to_string(),
        description: p::str(v, "description").unwrap_or("").to_string(),
        behaviors: vec![behavior.to_string()],
        blocks,
        ..Default::default()
    };
    match s.doc.glossary.iter_mut().find(|e| e.name == name && e.gallery == gallery) {
        Some(e) => *e = ew_doc::BuildingBlock { guid: std::mem::take(&mut e.guid), ..entry },
        None => s.doc.glossary.push(entry),
    }
    s.touch();
    Ok(json!({"name": name, "gallery": gallery}))
}

/// What Save Selection to `gallery` takes without a selection, as Word's does (gap G5): the table of contents or the
/// bibliography the caret is in, whole; the document's watermark, as a paragraph of its text in its font and colour.
fn whole_target(s: &Session, gallery: &str) -> Option<ew_doc::Blocks> {
    let blocks = |(a, b): (usize, usize)| s.doc.body.get(a..=b).map(<[_]>::to_vec);
    match gallery {
        "tblOfContents" if s.sel.is_collapsed() => crate::cmd::references::toc_blocks_at(s).and_then(blocks),
        "bib" if s.sel.is_collapsed() => crate::cmd::citations::bibliography_at(s).and_then(blocks),
        "watermarks" => s.doc.settings.watermark.as_ref().map(|w| {
            let props = ew_doc::CharProps {
                font: Some(w.font.clone()),
                color: Some(ew_doc::props::TextColor::Rgb(w.color)),
                ..Default::default()
            };
            vec![ew_doc::para_block(ew_doc::Paragraph::with_text(&w.text, props))]
        }),
        _ => None,
    }
}

/// What the galleries that save without a selection can save at the caret: {toc, bibliography, watermark} (their rows' state).
pub(in crate::cmd) fn save_targets(s: &Session) -> Value {
    json!({
        "toc": whole_target(s, "tblOfContents").is_some(),
        "bibliography": whole_target(s, "bib").is_some(),
        "watermark": s.doc.settings.watermark.is_some(),
    })
}

/// A watermark building block's first paragraph as the document's watermark: its text, font and colour, laid diagonally and
/// semitransparent (the gallery keeps no layout).
fn watermark_from(s: &mut Session, e: &ew_doc::BuildingBlock) -> Result<(), CmdError> {
    let p = e.blocks.iter().find_map(|b| b.as_para()).ok_or_else(|| CmdError::Failed("the watermark building block is empty".into()))?;
    let props = p.props_of_char(0).clone();
    let mut wm = ew_doc::Watermark { text: p.plain_text().trim().chars().take(200).collect(), ..Default::default() };
    if wm.text.is_empty() {
        return Err(CmdError::Failed("the watermark building block has no text".into()));
    }
    if let Some(f) = props.font {
        wm.font = f;
    }
    if let Some(ew_doc::props::TextColor::Rgb(c)) = props.color {
        wm.color = c;
    }
    s.doc.settings.watermark = Some(wm);
    Ok(())
}

/// F3 (Word's Insert AutoText): the document's building block named by the text before the caret replaces that text. A name
/// the text ends with, from a word start, wins (the longest); else the last word as the start of one name only. AutoText comes
/// before the other galleries, case is ignored (the DOM editor's building-blocks/blocks.mjs matchAutoText).
pub(in crate::cmd) fn auto_text(s: &mut Session, _: &Value) -> CmdResult {
    if !s.sel.is_collapsed() {
        return Err(CmdError::Disabled("put the caret after the building block's name first".into()));
    }
    let at = s.sel.focus.clone();
    let before = s.doc.para_at(&at).and_then(|p| p.text.get(..at.off)).unwrap_or("").to_string();
    let (i, start) = match_auto_text(&s.doc.glossary, &before)?;
    let e = &s.doc.glossary[i];
    let v = json!({"name": e.name, "gallery": e.gallery});
    s.sel = Selection { anchor: ew_doc::Pos { off: start, ..at.clone() }, focus: at };
    insert(s, &v)
}

/// The glossary entry [`auto_text`] picks for the text `before` the caret and where its name starts there (a byte offset).
fn match_auto_text(glossary: &[ew_doc::BuildingBlock], before: &str) -> Result<(usize, usize), CmdError> {
    let low = |x: &str| x.to_lowercase();
    let mut order: Vec<usize> = (0..glossary.len()).filter(|i| !glossary[*i].types.iter().any(|t| t == "bbPlcHdr")).collect();
    order.sort_by_key(|i| glossary[*i].gallery != ew_doc::AUTO_TEXT_GALLERY);
    // The byte offset where `before` ends with `name`, case ignored, at a word start.
    let ends = |name: &str| -> Option<usize> {
        let n = name.chars().count();
        let start = before.char_indices().rev().nth(n.checked_sub(1)?)?.0;
        let word_start = before[..start].chars().next_back().is_none_or(char::is_whitespace);
        (word_start && low(&before[start..]) == low(name)).then_some(start)
    };
    let mut best: Option<(usize, usize)> = None;
    for &i in &order {
        let name = &glossary[i].name;
        if let Some(start) = ends(name)
            && best.is_none_or(|(b, _)| name.chars().count() > glossary[b].name.chars().count())
        {
            best = Some((i, start));
        }
    }
    if let Some(hit) = best {
        return Ok(hit);
    }
    let word_at = before.rfind(char::is_whitespace).map_or(0, |i| i + before[i..].chars().next().map_or(1, char::len_utf8));
    let word = low(&before[word_at..]);
    let none = || CmdError::Failed("No building block has that name.".into());
    if word.is_empty() {
        return Err(none());
    }
    let hits: Vec<usize> = order.into_iter().filter(|i| low(&glossary[*i].name).starts_with(&word)).collect();
    let names: std::collections::BTreeSet<String> = hits.iter().map(|i| low(&glossary[*i].name)).collect();
    match (hits.first(), names.len()) {
        (None, _) => Err(none()),
        (Some(&i), 1) => Ok((i, word_at)),
        _ => Err(CmdError::Failed("More than one building block starts with that text. Type more of the name.".into())),
    }
}

/// The index of the document's building block `name` in `gallery` (any gallery when none is given).
fn find(s: &Session, v: &Value) -> Result<usize, CmdError> {
    let name = p::req_str(v, "name")?;
    let gallery = p::str(v, "gallery");
    s.doc
        .glossary
        .iter()
        .position(|e| e.name == name && gallery.is_none_or(|g| e.gallery == g))
        .ok_or_else(|| CmdError::Params(format!("no building block `{name}`")))
}

/// Inserts the document's building block at the selection by its rule: in its own paragraph (`p`) or on its own page (`pg`)
/// it starts a new paragraph after the caret's, and a page breaks before and after it.
// ponytail: inserts at the caret for every gallery; Word's gallery rules (a header block fills the section's header, a
// watermark sets it, a table of contents replaces the one there) need the Page package's header and watermark setters.
pub(in crate::cmd) fn insert(s: &mut Session, v: &Value) -> CmdResult {
    let i = find(s, v)?;
    let e = &s.doc.glossary[i];
    // A watermark sets the document's watermark, as Word's Watermark gallery does.
    if e.gallery == "watermarks" {
        let e = e.clone();
        watermark_from(s, &e)?;
        return sel_result(s);
    }
    let behavior = e.behaviors.first().cloned().unwrap_or_default();
    let mut frag = ew_doc::edit::Fragment { blocks: e.blocks.iter().map(|b| (**b).clone()).collect(), parts: Default::default() };
    let at = delete_selection(s)?;
    let at = if behavior == "p" || behavior == "pg" {
        let at = super::split_para(s, &at)?;
        if behavior == "pg" {
            // Word's "Insert content in its own page": a page break before the content and one after it.
            let brk = || ew_doc::Block::Para(ew_doc::Paragraph::with_text("\u{000C}", Default::default()));
            frag.blocks.insert(0, brk());
            frag.blocks.push(brk());
        }
        at
    } else {
        at
    };
    let end = s.doc.insert_fragment(&at, &frag)?;
    s.sel = Selection::caret(end);
    sel_result(s)
}

/// Deletes the document's building block `name` (of `gallery`).
pub(in crate::cmd) fn delete(s: &mut Session, v: &Value) -> CmdResult {
    let i = find(s, v)?;
    let e = s.doc.glossary.remove(i);
    s.touch();
    Ok(json!({"name": e.name, "gallery": e.gallery}))
}
