//! Header & Footer's Insert Alignment Tab, and what AutoFormat Now needs from the engine (stage 2b gaps, docs/plans/engine/stage2/
//! gaps.md tabs and autocorrect): the paragraphs' texts, and a list of edits applied as one undo step. The AutoFormat rules stay
//! the app's own (src/document/wp/autocorrect/rules.mjs autoFormatPlan), so both editors format alike.

use serde_json::{Value, json};
use ew_doc::para::{InlineObject, PTabAlign, PTabBase};
use ew_doc::props::{TabLeader, VertAlign};
use ew_doc::{Path, Pos, StoryRef};

use crate::cmd::sel_result;
use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

/// Most edits one `text.applyEdits` takes.
const MAX_EDITS: usize = 100_000;

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("text.alignmentTab", "Insert Alignment Tab", "Header & Footer › Position", alignment_tab)
            .params(r#"{"align"?: "left"|"center"|"right", "relativeTo"?: "margin"|"indent", "leader"?: "none"|"dot"|"hyphen"|"underscore"|"middleDot"}"#),
        CommandSpec::new("text.paragraphs", "Paragraph Texts", "Agents", paragraphs)
            .params(r#"{} → [{path, text, styled, list, inTable}] (the main text's paragraphs, offsets in UTF-8 bytes)"#)
            .pure(),
        CommandSpec::new("text.applyEdits", "Apply Edits", "Agents", apply_edits).params(
            r#"{"edits": [{"path": [n], "from": byte, "to": byte, "insert"?: string, "mark"?: "bold"|"italic"|"superscript"|{"link": url}}], "headings"?: [{"path": [n], "level": 1..9}]} (the main text; one undo step)"#,
        ),
    ]
}

/// Alignment Tab: a positional tab (`w:ptab`) at the caret, aligned to the margin or the indent, with a leader.
fn alignment_tab(s: &mut Session, v: &Value) -> CmdResult {
    let align = match p::str(v, "align").unwrap_or("left") {
        "center" => PTabAlign::Center,
        "right" => PTabAlign::Right,
        _ => PTabAlign::Left,
    };
    let relative_to = if p::str(v, "relativeTo") == Some("indent") { PTabBase::Indent } else { PTabBase::Margin };
    let leader = match p::str(v, "leader").unwrap_or("none") {
        "dot" => TabLeader::Dot,
        "hyphen" => TabLeader::Hyphen,
        "underscore" => TabLeader::Underscore,
        "middleDot" => TabLeader::MiddleDot,
        _ => TabLeader::None,
    };
    let props = s.typing_props();
    let at = crate::cmd::delete_selection(s)?;
    let end = s.doc.insert_object(&at, InlineObject::PositionalTab { align, relative_to, leader }, &props)?;
    s.sel = Selection::caret(end);
    sel_result(s)
}

fn paragraphs(s: &mut Session, _: &Value) -> CmdResult {
    let story = StoryRef::Body;
    let out: Vec<Value> = s
        .doc
        .para_paths(story)
        .iter()
        .filter_map(|path| {
            let para = s.doc.para(story, path)?;
            Some(json!({"path": path.0, "text": para.text, "styled": para.props.style.is_some(), "list": para.props.numbering.is_some(),
                "inTable": path.0.len() > 1}))
        })
        .collect();
    Ok(Value::Array(out))
}

/// One edit of `text.applyEdits`.
struct Edit {
    at: Pos,
    to: usize,
    insert: Option<String>,
    mark: Option<Value>,
}

fn path_of(v: &Value) -> Option<Path> {
    Some(Path(v.as_array()?.iter().map(|x| x.as_u64().and_then(|n| u32::try_from(n).ok())).collect::<Option<Vec<u32>>>()?))
}

/// AutoFormat Now's edits, each a replacement and or a mark on a range of one paragraph, applied from the end so the earlier
/// offsets stay right, then the headings: one undo step.
fn apply_edits(s: &mut Session, v: &Value) -> CmdResult {
    let story = StoryRef::Body;
    let list = v.get("edits").and_then(Value::as_array).ok_or_else(|| CmdError::Params("`edits` is required".into()))?;
    if list.len() > MAX_EDITS {
        return Err(CmdError::Params(format!("at most {MAX_EDITS} edits")));
    }
    let mut edits = Vec::with_capacity(list.len());
    for e in list {
        let path = e.get("path").and_then(path_of).ok_or_else(|| CmdError::Params("an edit's `path` is not a paragraph".into()))?;
        let para = s.doc.para(story, &path).ok_or_else(|| CmdError::Params("an edit's `path` is not a paragraph".into()))?;
        let (from, to) = (p::u64(e, "from").unwrap_or(0) as usize, p::u64(e, "to").unwrap_or(0) as usize);
        if from > to || to > para.len() || !para.text.is_char_boundary(from) || !para.text.is_char_boundary(to) {
            return Err(CmdError::Params("an edit's range is not in its paragraph".into()));
        }
        edits.push(Edit { at: Pos::new(story, path, from), to, insert: p::str(e, "insert").map(str::to_string), mark: e.get("mark").cloned() });
    }
    edits.sort_by(|a, b| b.at.cmp(&a.at));
    let mut n = 0;
    for e in &edits {
        let mut end = e.at.off + (e.to - e.at.off);
        if let Some(text) = &e.insert {
            let props = s.doc.para_at(&e.at).map(|p| p.props_of_char(e.at.off).clone()).unwrap_or_default();
            s.doc.delete_range(&e.at, &Pos { off: e.to, ..e.at.clone() })?;
            if !text.is_empty() {
                s.doc.insert_text(&e.at, text, &props)?;
            }
            end = e.at.off + text.len();
        }
        if let Some(m) = &e.mark
            && end > e.at.off
        {
            let link = m.get("link").and_then(Value::as_str).map(str::to_string);
            let kind = m.as_str().unwrap_or("").to_string();
            s.doc.format_range(&e.at, &Pos { off: end, ..e.at.clone() }, &|c| match kind.as_str() {
                "bold" => c.bold = Some(true),
                "italic" => c.italic = Some(true),
                "superscript" => c.vert_align = Some(VertAlign::Superscript),
                _ => {
                    if link.is_some() {
                        c.link = link.clone();
                    }
                }
            })?;
        }
        n += 1;
    }
    let heading = s.registry.get("para.style").map(|c| c.run);
    let sel = s.sel.clone();
    for h in v.get("headings").and_then(Value::as_array).into_iter().flatten() {
        let (Some(path), Some(level)) = (h.get("path").and_then(path_of), p::u64(h, "level").filter(|l| (1..=9).contains(l))) else { continue };
        if let (Some(run), Some(_)) = (heading, s.doc.para(story, &path)) {
            // The style command's own function, inside this one, so the whole AutoFormat stays one undo step.
            s.sel = Selection::caret(Pos::new(story, path, 0));
            run(s, &json!({"style": format!("Heading{level}")}))?;
            n += 1;
        }
    }
    s.sel = Selection { anchor: s.doc.clamp(&sel.anchor), focus: s.doc.clamp(&sel.focus) };
    let mut r = sel_result(s)?;
    r["applied"] = json!(n);
    Ok(r)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use ew_doc::StoryRef;
    use ew_doc::para::InlineObject;

    use crate::Session;

    #[test]
    fn alignment_tab_goes_in_at_the_caret() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("document.setText", &json!({"text": "Left"})).unwrap();
        s.run("caret.docEnd", &json!({})).unwrap();
        s.run("text.alignmentTab", &json!({"align": "right", "leader": "dot"})).unwrap();
        let para = s.doc.para_at(&ew_doc::Pos::body(0, 0)).unwrap();
        let tab = para.object_at(para.object_offsets()[0]).unwrap();
        assert!(matches!(tab, InlineObject::PositionalTab { align: ew_doc::para::PTabAlign::Right, leader: ew_doc::props::TabLeader::Dot, .. }), "{tab:?}");
    }

    #[test]
    fn apply_edits_replaces_marks_and_styles_in_one_undo_step() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("document.setText", &json!({"text": "Intro\nThe *big* 1st -- end"})).unwrap();
        let paras = s.run("text.paragraphs", &json!({})).unwrap();
        assert_eq!(paras[1]["text"], "The *big* 1st -- end");
        s.run("text.applyEdits", &json!({"edits": [
            {"path": [1], "from": 4, "to": 9, "insert": "big", "mark": "bold"},
            {"path": [1], "from": 11, "to": 13, "mark": "superscript"},
            {"path": [1], "from": 14, "to": 16, "insert": "\u{2013}"},
        ], "headings": [{"path": [0], "level": 1}]})).unwrap();
        assert_eq!(s.doc.plain_text(StoryRef::Body).trim_end(), "Intro\nThe big 1st \u{2013} end");
        let p1 = s.doc.para_at(&ew_doc::Pos::body(1, 0)).unwrap();
        assert_eq!(p1.props_of_char(5).bold, Some(true));
        assert_eq!(p1.props_of_char(9).vert_align, Some(ew_doc::props::VertAlign::Superscript));
        assert_eq!(s.doc.para_at(&ew_doc::Pos::body(0, 0)).unwrap().props.style.as_deref(), Some("Heading1"));
        s.run("edit.undo", &json!({})).unwrap();
        assert_eq!(s.doc.plain_text(StoryRef::Body).trim_end(), "Intro\nThe *big* 1st -- end");
    }
}
