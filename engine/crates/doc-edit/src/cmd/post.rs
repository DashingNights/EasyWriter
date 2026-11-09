//! The forum post's commands (docs/plans/engine/stage3-forum.md section 3, B1): the paragraph, list, quote, code block, box
//! and mark actions src/document/canvas/rows/post.mjs sends (`post.block`, `post.list`, `post.toggle`, `post.rule`,
//! `post.mark`, `post.clear`, `post.insert`), the caret's state the post's rows read (`post.context`), the box fill the import
//! uses (`box.fill`), and the profile's allow list, which [`refuse`] runs for every command on a post.
//!
//! The model is [`ew_doc::post`]'s: paragraphs are Normal, headings are `Heading1` to `Heading6`, a quote, code block and box
//! are containers in the post's table styles, a rule is an empty paragraph in `PostRule`, a list is a numbering instance of the
//! post's bulleted or numbered definition, and a mark is direct run formatting (a size in points, a palette colour, a shading
//! for a highlight, and `PostCode` for inline code).

use std::sync::Arc;

use serde_json::{Value, json};
use ew_doc::numbering::{Num, Numbering};
use ew_doc::post;
use ew_doc::props::{CharProps, NumRef, Rgb, TextColor, Underline, VertAlign};
use ew_doc::resolve::ResolvedChar;
use ew_doc::section::NumFormat;
use ew_doc::{Block, ContainerRole, Document, Paragraph, Pos, StoryRef};

use super::{container, format, paste};
use crate::{CmdError, CmdResult, CommandSpec, Session, p};

pub(crate) mod autoformat;

/// The ids a post runs: the prefixes of the whole text profile's grants, and the individual commands the post's toolbar uses.
const PREFIXES: [&str; 10] = ["caret.", "select.", "text.", "edit.", "view.", "review.", "post.", "box.", "container.", "table."];
const ALLOWED: [&str; 12] = [
    "format.bold",
    "format.italic",
    "format.underline",
    "format.strikethrough",
    "format.subscript",
    "format.superscript",
    "format.clear",
    "insert.link",
    "insert.removeLink",
    "insert.table",
    "link.targets",
    "document.selection",
];
/// The formatting commands a code block refuses: its text takes no marks (src/extensions.js `forumExtensions`).
const MARKS: [&str; 7] = ["format.bold", "format.italic", "format.underline", "format.strikethrough", "format.subscript", "format.superscript", "format.clear"];

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("post.context", "Post Context", "Post", |s, _| Ok(context(s)))
            .params(
                r#"{} → {block: "p|h1"…"h6", align, marks: [name], size (percent), color (key or "root"), highlight (key|null), font (name or ""), link (address|null), list: "bullet|ordered"|null, quote, code, box, language, inTable, canFormat}"#,
            )
            .pure()
            .state(|s| (Value::Null, context(s))),
        CommandSpec::new("post.block", "Paragraph or Heading", "Post", block).params(r#"{"kind": "p|h1"…"h6"}"#),
        CommandSpec::new("post.toggle", "Quote, Code Block or Box", "Post", toggle).params(r#"{"kind": "quote|code|box"}"#),
        CommandSpec::new("post.rule", "Horizontal Rule", "Post", rule).params("{}"),
        CommandSpec::new("post.list", "Bullet or Numbered List", "Post", list).params(r#"{"kind": "bullet|ordered"}"#),
        CommandSpec::new("post.mark", "Text Formatting", "Post", mark).params(
            r#"{"mark": "bold|italic|underline|strike|subscript|superscript|code", "on"?: bool} or {"size"?: percent|null, "color"?: key|null, "highlight"?: key|null, "font"?: name|null}"#,
        ),
        CommandSpec::new("post.clear", "Clear Formatting", "Post", clear).params("{}"),
        CommandSpec::new("post.insert", "Insert Post Content", "Post", insert)
            .params(r#"{"json": the post kit's node or array of nodes}, read into the engine model and inserted at the selection"#),
        CommandSpec::new("box.fill", "Fill Object", "Object", fill)
            .params(r#"{"id": number, "kind"?: string, "data"?: string (JSON), "file"?: string (a data URL or https address), "w"?: number, "h"?: number} (points)"#)
            .pure(),
    ]
}

/// Whether the post runs `id`: its allow list (stage3-forum.md section 3, B1).
pub(crate) fn allowed(id: &str) -> bool {
    PREFIXES.iter().any(|x| id.starts_with(x)) || id.starts_with("para.align") || ALLOWED.contains(&id)
}

/// Refuses a command a post does not run, and a mark in a code block. A document with no post profile runs everything.
pub(crate) fn refuse(s: &Session, id: &str) -> Result<(), CmdError> {
    if s.doc.settings.profile.as_deref() != Some(post::PROFILE) {
        return Ok(());
    }
    if !allowed(id) {
        return Err(CmdError::Disabled("This is not in a forum post".into()));
    }
    if MARKS.contains(&id) && container::in_code(s) {
        return Err(CmdError::Disabled("A code block takes no formatting".into()));
    }
    Ok(())
}

/// The size a style's text has, points: the post's base size scaled, or the heading's own (post/read.rs's `style_size`).
fn base_size(doc: &Document, style: Option<&str>) -> f32 {
    style.and_then(|s| doc.styles.get(s)).and_then(|s| s.chr.size).or(doc.styles.default_chr.size).unwrap_or(12.0)
}

/// `v` to the nearest of the post's sizes (percent).
fn snap_size(v: f32) -> u16 {
    post::FONT_SIZES.iter().copied().min_by(|a, b| (f32::from(*a) - v).abs().total_cmp(&(f32::from(*b) - v).abs())).unwrap_or(100)
}

/// A palette colour's key: the exact one, else the nearest hue (`root` for the default text colour).
fn colour_key(c: TextColor) -> &'static str {
    let TextColor::Rgb(rgb) = c else { return "root" };
    let d = |x: Rgb| {
        let (r, g, b) = (i32::from(x.0) - i32::from(rgb.0), i32::from(x.1) - i32::from(rgb.1), i32::from(x.2) - i32::from(rgb.2));
        r * r + g * g + b * b
    };
    if d(post::TEXT) == 0 {
        return "root";
    }
    post::COLORS.iter().map(|(k, dark, _)| (*k, d(*dark))).min_by_key(|(_, n)| *n).map_or("root", |(k, _)| k)
}

/// A highlight's key from the shading its blend leaves on the page.
fn highlight_key(shading: Rgb) -> &'static str {
    post::HIGHLIGHT_HUES
        .iter()
        .map(|(k, hue)| (*k, post::blend(*hue, post::PAPER)))
        .min_by_key(|(_, c)| (i32::from(c.0) - i32::from(shading.0)).pow(2) + (i32::from(c.1) - i32::from(shading.1)).pow(2) + (i32::from(c.2) - i32::from(shading.2)).pow(2))
        .map_or("red", |(k, _)| k)
}

/// Whether the caret's text is inline code.
fn is_code(s: &Session) -> bool {
    let a = s.sel.ordered().0;
    s.doc.para_at(&a).is_some_and(|p| p.props_at(a.off).style.as_deref() == Some(post::CODE))
}

/// The caret's state (`post.context`), which the post's rows read for their toggles, boxes and values.
fn context(s: &Session) -> Value {
    let at = &s.sel.focus;
    let para = s.doc.para_at(at);
    let style = para.and_then(|x| x.props.style.as_deref());
    let block = match style.and_then(|x| x.strip_prefix("Heading")) {
        Some(n) if (1..=6).contains(&n.parse::<u8>().unwrap_or(0)) => format!("h{n}"),
        _ => "p".into(),
    };
    let align = match para.map(|x| s.doc.styles.resolve_para(&x.props).align) {
        Some(ew_doc::Align::Center) => "center",
        Some(ew_doc::Align::Right) => "right",
        Some(ew_doc::Align::Justify) => "justify",
        Some(ew_doc::Align::Distribute) => "distribute",
        _ => "left",
    };
    let runs = format::resolved(s);
    let all = |f: fn(&ResolvedChar) -> bool| !runs.is_empty() && runs.iter().all(f);
    let same = |f: &dyn Fn(&ResolvedChar) -> Value| runs.first().map(f).filter(|v| runs.iter().all(|r| f(r) == *v));
    let tests: [(&str, fn(&ResolvedChar) -> bool); 6] = [
        ("bold", |r| r.bold),
        ("italic", |r| r.italic),
        ("underline", |r| r.underline != Underline::None),
        ("strike", |r| r.strike),
        ("subscript", |r| r.vert_align == VertAlign::Subscript),
        ("superscript", |r| r.vert_align == VertAlign::Superscript),
    ];
    let mut marks: Vec<&str> = tests.into_iter().filter(|(_, f)| all(*f)).map(|(n, _)| n).collect();
    if is_code(s) {
        marks.push("code");
    }
    let base = base_size(&s.doc, style);
    let size = same(&|r| json!(snap_size(r.size / base * 100.0))).unwrap_or(json!(100));
    let color = same(&|r| json!(colour_key(r.color))).unwrap_or(json!("root"));
    let highlight = same(&|r| r.shading.map_or(Value::Null, |c| json!(highlight_key(c)))).unwrap_or(Value::Null);
    // The font is the run's own, never the base font: an unmarked run shows no font.
    let font = para.map(|x| x.props_at(at.off).font.clone().unwrap_or_default()).unwrap_or_default();
    // The address the caret's text links to, for the link dialog to start from.
    let link = para.and_then(|x| x.props_at(at.off).link.clone());
    let numbering = para.and_then(|x| s.doc.styles.resolve_para(&x.props).numbering).filter(|n| n.num != 0);
    let list = numbering.and_then(|n| s.doc.numbering.level(n.num, n.level)).map(|l| {
        if l.format == NumFormat::Bullet { "bullet" } else { "ordered" }
    });
    let (quote, code, boxed, language) = match s.doc.container_of(at.story, &at.path) {
        Some((_, _, c)) => (c.role == ContainerRole::Quote, c.role == ContainerRole::Code, c.role == ContainerRole::Box, c.language.clone()),
        None => (false, false, false, None),
    };
    json!({
        "block": block,
        "align": align,
        "marks": marks,
        "size": size,
        "color": color,
        "highlight": highlight,
        "font": font,
        "link": link,
        "list": list,
        "quote": quote,
        "code": code,
        "box": boxed,
        "language": language,
        "inTable": s.doc.cell_of(at.story, &at.path).is_some(),
        "canFormat": !code,
    })
}

/// The styles a block change may replace: body text (no style, or Normal) and a heading. A cell's header style, a box's
/// title, a rule and a list item's later blocks are the structure around the text and keep their own.
fn body_style(style: Option<&str>) -> bool {
    match style {
        None | Some("Normal") => true,
        Some(s) => matches!(s.strip_prefix("Heading").and_then(|n| n.parse::<u8>().ok()), Some(1..=6)),
    }
}

/// The style a block kind names: `p` is Normal (no style, as the reader writes it), `h1` to `h6` a heading style.
fn style_of(kind: &str) -> Result<Option<String>, CmdError> {
    if kind == "p" {
        return Ok(None);
    }
    match kind.strip_prefix('h').and_then(|n| n.parse::<u8>().ok()).filter(|n| (1..=6).contains(n)) {
        Some(n) => Ok(Some(format!("Heading{n}"))),
        None => Err(CmdError::Params("kind: \"p\" or \"h1\" to \"h6\"".into())),
    }
}

/// `post.block`: a paragraph or a heading. Run sizes that are explicit are scaled so each keeps its percent of the block's
/// text, as the saved form's size mark means a percent of it.
pub(super) fn block(s: &mut Session, v: &Value) -> CmdResult {
    let style = style_of(p::req_str(v, "kind")?)?;
    no_code(s)?;
    let story = s.sel.focus.story;
    let new = base_size(&s.doc, style.as_deref());
    for path in crate::cmd::selected_paths(s) {
        let Some(para) = s.doc.para(story, &path).filter(|p| body_style(p.props.style.as_deref())) else { continue };
        let old = base_size(&s.doc, para.props.style.as_deref());
        let scale = if old > 0.0 { new / old } else { 1.0 };
        let para = s.doc.para_mut(story, &path)?;
        para.props.style = style.clone();
        if (scale - 1.0).abs() > 0.0005 {
            for r in &mut para.runs {
                r.props.size = r.props.size.map(|x| round3(x * scale));
                r.props.size_cs = r.props.size_cs.map(|x| round3(x * scale));
            }
        }
        para.touch();
    }
    super::sel_result(s)
}

/// A code block holds lines of text only: it refuses the commands that would put something else in it.
fn no_code(s: &Session) -> Result<(), CmdError> {
    if container::in_code(s) { Err(CmdError::Disabled("A code block takes text only".into())) } else { Ok(()) }
}

/// `post.toggle`: wrap the selection in a quote, code block or box of the post's styles, or lift it out of one of the same
/// kind. A box is titled "Title" with a 12 pt gap below.
fn toggle(s: &mut Session, v: &Value) -> CmdResult {
    let role = p::str(v, "kind").and_then(ContainerRole::from_name).ok_or_else(|| CmdError::Params("kind: \"quote\", \"code\" or \"box\"".into()))?;
    if s.doc.container_of(s.sel.focus.story, &s.sel.focus.path).is_some_and(|(_, _, c)| c.role == role) {
        return container::unwrap(s, &json!({}));
    }
    no_code(s)?;
    container::wrap(s, &wrap_args(role))
}

/// The arguments [container::wrap] takes for a post's role: its table style, a code block's line style, and a box's title and gap.
pub(super) fn wrap_args(role: ContainerRole) -> Value {
    match role {
        ContainerRole::Quote => json!({"role": "quote", "style": post::QUOTE}),
        ContainerRole::Code => json!({"role": "code", "style": post::CODE_BLOCK, "lineStyle": post::CODE_TEXT}),
        ContainerRole::Box => json!({"role": "box", "style": post::BOX, "title": "Title", "titleStyle": post::BOX_TITLE, "spaceAfter": 12.0}),
    }
}

/// `post.rule`: an empty paragraph in the rule style where the caret is, with the caret in the paragraph after it.
pub(super) fn rule(s: &mut Session, _: &Value) -> CmdResult {
    no_code(s)?;
    crate::cmd::delete_selection(s)?;
    let at = s.sel.focus.clone();
    let story = at.story;
    let mut para = Paragraph::new();
    para.props.style = Some(post::RULE.to_string());
    if s.doc.para_at(&at).is_some_and(|p| p.is_empty()) {
        // The empty paragraph becomes the rule; an empty one after it takes what is typed next.
        s.doc.para_mut(story, &at.path)?.props.style = Some(post::RULE.to_string());
        let next = at.path.with_last(at.path.last() + 1);
        s.doc.insert_block(story, &next, Block::Para(Paragraph::new()))?;
        s.sel = crate::Selection::caret(s.doc.clamp(&Pos { story, path: next, off: 0 }));
    } else if at.off == 0 {
        let i = at.path.last();
        s.doc.insert_block(story, &at.path, Block::Para(para))?;
        let moved = at.path.with_last(i + 1);
        s.sel = crate::Selection::caret(s.doc.clamp(&Pos { story, path: moved, off: 0 }));
    } else {
        let next = s.doc.split_paragraph(&at)?;
        s.doc.insert_block(story, &next.path, Block::Para(para))?;
        // The rule took the second paragraph's index; that paragraph is one block down.
        s.sel = crate::Selection::caret(Pos { story, path: next.path.with_last(next.path.last() + 1), off: 0 });
    }
    super::sel_result(s)
}

/// The next numbering id the post's lists may take (0 means no list).
fn next_num(s: &Session) -> Result<u32, CmdError> {
    let max = s.doc.numbering.nums.iter().map(|n| n.id).max().unwrap_or(0);
    max.checked_add(1).ok_or_else(|| CmdError::Failed("no free list id".into()))
}

/// A numbered list's instance against the post's bulleted or numbered definition, a list's own as each list node gets.
pub(super) fn new_list(s: &mut Session, bullet: bool) -> Result<u32, CmdError> {
    let id = next_num(s)?;
    s.doc.numbering_mut().nums.push(Num { id, abstract_id: if bullet { post::BULLET_ABSTRACT } else { post::NUMBER_ABSTRACT }, ..Num::default() });
    Ok(id)
}

/// Gives the document the post's two list definitions when it lacks them (a post read from its saved form has them).
pub(super) fn ensure_lists(s: &mut Session) {
    let numbering = s.doc.numbering_mut();
    for a in post::numbering().abstracts {
        if !numbering.abstracts.iter().any(|x| x.id == a.id) {
            numbering.abstracts.push(a);
        }
    }
}

/// `post.list`: the selection as a bullet or ordered list of the post's own definition, one instance for it; pressing the same
/// kind again takes the list off. Paragraphs that were in a list keep their level.
fn list(s: &mut Session, v: &Value) -> CmdResult {
    let bullet = match p::req_str(v, "kind")? {
        "bullet" => true,
        "ordered" => false,
        k => return Err(CmdError::Params(format!("kind: \"bullet\" or \"ordered\", not `{k}`"))),
    };
    no_code(s)?;
    let story = s.sel.focus.story;
    let paths = crate::cmd::selected_paths(s);
    let current: Vec<Option<NumRef>> = paths
        .iter()
        .map(|p| s.doc.para(story, p).and_then(|x| s.doc.styles.resolve_para(&x.props).numbering).filter(|n| n.num != 0))
        .collect();
    let matches = |n: &NumRef| s.doc.numbering.level(n.num, n.level).is_some_and(|l| (l.format == NumFormat::Bullet) == bullet);
    if !current.is_empty() && current.iter().all(|n| n.as_ref().is_some_and(matches)) {
        for path in paths {
            let para = s.doc.para_mut(story, &path)?;
            para.props.numbering = None;
            para.touch();
        }
        return super::sel_result(s);
    }
    ensure_lists(s);
    let num = new_list(s, bullet)?;
    for (path, was) in paths.iter().zip(current) {
        let para = s.doc.para_mut(story, path)?;
        para.props.numbering = Some(NumRef { num, level: was.map_or(0, |n| n.level) });
        para.touch();
    }
    super::sel_result(s)
}

/// `post.mark`: a named mark toggled (or set), or the size, colour, highlight or font, a value of `null` taking the mark off.
fn mark(s: &mut Session, v: &Value) -> CmdResult {
    if container::in_code(s) {
        return Err(CmdError::Disabled("A code block takes no formatting".into()));
    }
    if let Some(name) = p::str(v, "mark") {
        return named(s, name, p::bool(v, "on"));
    }
    if v.get("size").is_some() {
        return set_size(s, v.get("size"));
    }
    if v.get("color").is_some() {
        let key = p::str(v, "color");
        let colour = match key {
            None | Some("") | Some("root") => None,
            Some(k) => Some(TextColor::Rgb(post::COLORS.iter().find(|(x, _, _)| *x == k).map(|(_, c, _)| *c).ok_or_else(|| CmdError::Params(format!("color: `{k}` is not a post colour")))?)),
        };
        return format::apply(s, &|c| c.color = colour);
    }
    if v.get("highlight").is_some() {
        let key = p::str(v, "highlight");
        let fill = match key {
            None | Some("") => None,
            Some(k) => {
                let hue = post::HIGHLIGHT_HUES.iter().find(|(x, _)| *x == k).map(|(_, c)| *c).ok_or_else(|| CmdError::Params(format!("highlight: `{k}` is not a post highlight")))?;
                Some(post::blend(hue, post::PAPER))
            }
        };
        return format::apply(s, &|c| c.shading = fill);
    }
    if v.get("font").is_some() {
        let font = p::str(v, "font").filter(|f| !f.is_empty());
        if let Some(f) = font.filter(|f| !post::FONTS.contains(f)) {
            return Err(CmdError::Params(format!("font: `{f}` is not a post font")));
        }
        return format::apply(s, &|c| c.font = font.map(str::to_string));
    }
    Err(CmdError::Params("mark, size, color, highlight or font is required".into()))
}

/// A named mark at the selection, toggled when `on` is not given.
pub(super) fn named(s: &mut Session, name: &str, on: Option<bool>) -> CmdResult {
    let runs = format::resolved(s);
    let all = |f: fn(&ResolvedChar) -> bool| !runs.is_empty() && runs.iter().all(f);
    match name {
        "bold" => {
            let on = on.unwrap_or_else(|| !all(|r| r.bold));
            format::apply(s, &|c| {
                c.bold = Some(on);
                c.bold_cs = Some(on);
            })
        }
        "italic" => {
            let on = on.unwrap_or_else(|| !all(|r| r.italic));
            format::apply(s, &|c| {
                c.italic = Some(on);
                c.italic_cs = Some(on);
            })
        }
        "underline" => {
            let on = on.unwrap_or_else(|| !all(|r| r.underline != Underline::None));
            format::apply(s, &|c| c.underline = Some(if on { Underline::Single } else { Underline::None }))
        }
        "strike" => {
            let on = on.unwrap_or_else(|| !all(|r| r.strike));
            format::apply(s, &|c| c.strike = Some(on))
        }
        "subscript" => {
            let on = on.unwrap_or_else(|| !all(|r| r.vert_align == VertAlign::Subscript));
            format::apply(s, &|c| c.vert_align = Some(if on { VertAlign::Subscript } else { VertAlign::Baseline }))
        }
        "superscript" => {
            let on = on.unwrap_or_else(|| !all(|r| r.vert_align == VertAlign::Superscript));
            format::apply(s, &|c| c.vert_align = Some(if on { VertAlign::Superscript } else { VertAlign::Baseline }))
        }
        // Inline code drops every other mark, as the kit's code mark does.
        "code" => {
            let on = on.unwrap_or(!is_code(s));
            if on {
                format::apply(s, &|c| *c = CharProps { style: Some(post::CODE.to_string()), ..c.cleared() })
            } else {
                format::apply(s, &|c| c.style = None)
            }
        }
        _ => Err(CmdError::Params(format!("unknown mark `{name}`"))),
    }
}

/// A size in percent: a mark of `null` (or 100) drops it, so the text takes the block's own size. Sizes are the block's text
/// scaled, which is what the saved form's mark means.
fn set_size(s: &mut Session, v: Option<&Value>) -> CmdResult {
    let pct = match v {
        None | Some(Value::Null) => None,
        Some(x) => {
            let n = x.as_f64().map(|f| f as f32).filter(|f| f.is_finite()).ok_or_else(|| CmdError::Params("size: a percent".into()))?;
            let snapped = snap_size(n);
            if (f32::from(snapped) - n).abs() > 0.5 {
                return Err(CmdError::Params("size: 80, 90, 100, 125, 150, 175 or 200 %".into()));
            }
            (snapped != 100).then_some(f32::from(snapped))
        }
    };
    let story = s.sel.focus.story;
    let (a, b) = s.sel.ordered();
    if a == b {
        let base = s.doc.para_at(&a).map(|x| base_size(&s.doc, x.props.style.as_deref())).unwrap_or(12.0);
        let mut c = s.typing_props();
        let size = pct.map(|x| round3(base * x / 100.0));
        c.size = size;
        c.size_cs = size;
        s.pending = Some(c);
        if s.doc.para_at(&a).is_some_and(|x| x.is_empty()) {
            let para = s.doc.para_mut(story, &a.path)?;
            para.mark.size = size;
            para.mark.size_cs = size;
            para.touch();
        }
        return super::sel_result(s);
    }
    for path in crate::cmd::selected_paths(s) {
        let Some(para) = s.doc.para(story, &path) else { continue };
        let base = base_size(&s.doc, para.props.style.as_deref());
        let size = pct.map(|x| round3(base * x / 100.0));
        let from = if path == a.path { a.off } else { 0 };
        let to = if path == b.path { b.off } else { para.len() };
        s.doc.format_range(&Pos { story, path: path.clone(), off: from }, &Pos { story, path, off: to }, &|c| {
            c.size = size;
            c.size_cs = size;
        })?;
    }
    super::sel_result(s)
}

/// `post.clear`: the selection back to plain text, dropping every mark and character style (a link and its notes stay).
fn clear(s: &mut Session, _: &Value) -> CmdResult {
    if container::in_code(s) {
        return Err(CmdError::Disabled("A code block takes no formatting".into()));
    }
    format::apply(s, &|c| *c = c.cleared())
}

/// `post.insert`: the post kit's JSON read into the engine model and inserted at the selection, as one undo step of the
/// session's (and a tracked insertion in a tracked call).
fn insert(s: &mut Session, v: &Value) -> CmdResult {
    let nodes = match v.get("json") {
        Some(Value::String(t)) => serde_json::from_str::<Value>(t).map_err(|e| CmdError::Params(e.to_string()))?,
        Some(x) => x.clone(),
        None => return Err(CmdError::Params("json: the post's nodes".into())),
    };
    let width = text_width(s);
    let frag = read_blocks(s, width, &nodes)?;
    paste::insert(s, frag)?;
    super::sel_result(s)
}

/// The text width where the caret is, points: the caret section's, as `box.list` gives it.
fn text_width(s: &Session) -> f32 {
    let top = if s.sel.focus.story == StoryRef::Body { s.sel.focus.path.0.first().map_or(usize::MAX, |i| *i as usize) } else { usize::MAX };
    let sections = s.doc.sections();
    sections.iter().find(|(end, _)| *end >= top).or(sections.last()).map_or(468.0, |(_, sp)| sp.text_width())
}

/// [`ew_formats::post::read_blocks`] over the post's own list definitions: the reader takes the document's numbering instances
/// by their order, so it reads against a scratch one holding the fragment's lists alone, and the fragment's lists then take
/// fresh instances of the post's definitions, which stay with the document.
fn read_blocks(s: &mut Session, width: f32, nodes: &Value) -> Result<ew_doc::edit::Fragment, CmdError> {
    let mut kinds = Vec::new();
    list_kinds(content_of(nodes), &mut kinds);
    let mut scratch = Document::new();
    scratch.styles = s.doc.styles.clone();
    scratch.numbering = Arc::new(Numbering {
        abstracts: Vec::new(),
        nums: (1..=u32::try_from(kinds.len()).unwrap_or(0)).map(|id| Num { id, ..Num::default() }).collect(),
    });
    let mut frag = ew_formats::post::read_blocks(&scratch, width, nodes).map_err(CmdError::Failed)?;
    if kinds.is_empty() {
        return Ok(frag);
    }
    ensure_lists(s);
    let mut map = Vec::with_capacity(kinds.len());
    for bullet in kinds {
        map.push(new_list(s, bullet)?);
    }
    for b in &mut frag.blocks {
        paste::each_para(b, 0, &mut |p| {
            if let Some(n) = p.props.numbering
                && let Some(id) = n.num.checked_sub(1).and_then(|i| map.get(i as usize))
            {
                p.props.numbering = Some(NumRef { num: *id, level: n.level });
                p.touch();
            }
        });
    }
    Ok(frag)
}

/// A node's or a node array's block list.
fn content_of(nodes: &Value) -> &[Value] {
    match nodes {
        Value::Array(a) => a,
        Value::Object(_) => nodes.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]),
        _ => &[],
    }
}

/// The lists a fragment's nodes hold, in the order the reader takes their instances (post/read.rs `prescan`): a list, then its
/// items' content, then the blocks a suggestion on the same node removed. `true` is a bulleted list.
fn list_kinds(nodes: &[Value], out: &mut Vec<bool>) {
    for node in nodes {
        let Some(ty) = node.get("type").and_then(Value::as_str) else { continue };
        let list = matches!(ty, "bulletList" | "orderedList");
        if list {
            out.push(ty == "bulletList");
        }
        list_kinds(content_of(node), out);
        if !post::BLOCKS.contains(&ty) {
            continue;
        }
        let Some(suggest) = node.get("attrs").and_then(|a| a.get("suggest")) else { continue };
        let ins = suggest.get("ins").filter(|v| v.is_object());
        if let Some(old) = ins.and_then(|i| i.get("old")).and_then(Value::as_array).filter(|a| !a.is_empty()) {
            list_kinds(old, out);
        }
        for d in suggest.get("del").and_then(Value::as_array).into_iter().flatten() {
            list_kinds(d.get("old").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]), out);
        }
    }
}

/// `box.fill`: an object's kind, data, file and size, filled in once (an import's canvas record, a downloaded file). No undo
/// step: what it fills replaces a placeholder, and taking the placeholder back would download it again.
fn fill(s: &mut Session, v: &Value) -> CmdResult {
    let id = super::boxes::id_of(v)?;
    let (old, boxed) = super::boxes::find(s, id)?;
    let mut boxed = (*boxed).clone();
    if let Some(kind) = p::str(v, "kind") {
        if kind.is_empty() {
            return Err(CmdError::Params("kind: a name".into()));
        }
        boxed.kind = kind.to_string();
    }
    if let Some(data) = p::str(v, "data") {
        if data.len() > super::boxes::MAX_DATA || serde_json::from_str::<Value>(data).is_err() {
            return Err(CmdError::Params("data: JSON of at most 256 MB".into()));
        }
        boxed.data = data.to_string();
    }
    if let Some(file) = p::str(v, "file") {
        if file.len() > super::boxes::MAX_DATA {
            return Err(CmdError::Params("file: a data URL of at most 256 MB".into()));
        }
        boxed.file = file.to_string();
    }
    let (w0, h0) = old.frame().map(|(w, h, _)| (w, h)).unwrap_or_default();
    let (w, h) = (p::f32(v, "w").filter(|x| *x > 0.0).unwrap_or(w0), p::f32(v, "h").filter(|x| *x > 0.0).unwrap_or(h0));
    s.doc.objects_mut(&|o| o.frame().is_some_and(|(_, _, f)| f.id.0 == id), &mut |o| {
        if let Some(f) = o.float_mut() {
            f.r#box = Some(Arc::new(boxed.clone()));
        }
        o.set_size(w, h);
    });
    s.touch();
    Ok(json!({"id": id}))
}

/// A value rounded as the saved form writes it (thousandths).
fn round3(v: f32) -> f32 {
    (v * 1000.0).round() / 1000.0
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;
    use ew_doc::para::ObjectBox;
    use ew_doc::post;
    use ew_doc::props::TextColor;
    use ew_doc::{Block, Container, ContainerRole, Document, Paragraph, Path, Pos, StoryRef};

    use crate::{Selection, Session};

    fn session(nodes: serde_json::Value) -> Session {
        Session::new(ew_formats::post::read(&json!({"doc": nodes}).to_string()).unwrap())
    }

    fn one_para(text: &str) -> Session {
        session(json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}))
    }

    fn caret(s: &mut Session, path: &[u32], off: usize) {
        s.sel = Selection::caret(Pos { story: StoryRef::Body, path: Path(path.to_vec()), off });
    }

    fn blocks(s: &Session) -> &[std::sync::Arc<Block>] {
        &s.doc.body
    }

    fn container(block: &Block) -> &Container {
        block.as_container().unwrap()
    }

    fn para<'a>(s: &'a Session, path: &[u32]) -> &'a Paragraph {
        s.doc.para(StoryRef::Body, &Path(path.to_vec())).unwrap()
    }

    #[test]
    fn context_reports_the_block_marks_and_values_at_the_caret() {
        let mut s = session(json!({"type": "doc", "content": [
            {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Title"}]},
            {"type": "paragraph", "attrs": {"textAlign": "center"}, "content": [{"type": "text", "text": "red", "marks": [
                {"type": "bold"}, {"type": "fontSize", "attrs": {"size": 150}},
                {"type": "textColor", "attrs": {"color": "red"}}, {"type": "highlight", "attrs": {"color": "yellow"}},
                {"type": "fontFamily", "attrs": {"font": "Georgia"}}]}]},
            {"type": "codeBlock", "attrs": {"language": "rust"}, "content": [{"type": "text", "text": "let x = 1;\n"}]}
        ]}));
        caret(&mut s, &[0], 1);
        let head = s.run("post.context", &json!({})).unwrap();
        assert_eq!((head["block"].as_str(), head["size"].as_u64(), head["canFormat"].as_bool()), (Some("h2"), Some(100), Some(true)));
        caret(&mut s, &[1], 1);
        let ctx = s.run("post.context", &json!({})).unwrap();
        let marks: Vec<&str> = ctx["marks"].as_array().unwrap().iter().filter_map(serde_json::Value::as_str).collect();
        assert_eq!((ctx["block"].as_str(), ctx["align"].as_str()), (Some("p"), Some("center")));
        assert!(marks.contains(&"bold"), "{marks:?}");
        assert_eq!((ctx["size"].as_u64(), ctx["color"].as_str(), ctx["highlight"].as_str()), (Some(150), Some("red"), Some("yellow")));
        assert_eq!(ctx["font"].as_str(), Some("Georgia"));
        assert_eq!((ctx["quote"].as_bool(), ctx["inTable"].as_bool()), (Some(false), Some(false)));
        // A code block: its language, no formatting, and its text has no marks list entry.
        caret(&mut s, &[2, 0, 0, 0], 2);
        let code = s.run("post.context", &json!({})).unwrap();
        assert_eq!((code["code"].as_bool(), code["language"].as_str(), code["canFormat"].as_bool()), (Some(true), Some("rust"), Some(false)));
        assert_eq!(code["marks"], json!([]));
    }

    #[test]
    fn block_switches_style_and_rescales_the_run_sizes_with_it() {
        let mut s = session(json!({"type": "doc", "content": [
            {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Big", "marks": [{"type": "fontSize", "attrs": {"size": 150}}]}]}
        ]}));
        assert_eq!(para(&s, &[0]).runs[0].props.size, Some(54.0));
        s.run("select.all", &json!({})).unwrap();
        s.run("post.block", &json!({"kind": "p"})).unwrap();
        assert_eq!((para(&s, &[0]).props.style.as_deref(), para(&s, &[0]).runs[0].props.size), (None, Some(18.0)));
        s.run("post.block", &json!({"kind": "h1"})).unwrap();
        assert_eq!((para(&s, &[0]).props.style.as_deref(), para(&s, &[0]).runs[0].props.size), (Some("Heading1"), Some(54.0)));
        assert!(s.run("post.block", &json!({"kind": "h7"})).is_err());
    }

    #[test]
    fn toggle_wraps_a_quote_a_code_block_and_a_titled_box_and_unwraps_each() {
        let mut s = one_para("Hi");
        for (kind, role, style) in [("quote", ContainerRole::Quote, post::QUOTE), ("code", ContainerRole::Code, post::CODE_BLOCK), ("box", ContainerRole::Box, post::BOX)] {
            caret(&mut s, &[0], 1);
            s.run("post.toggle", &json!({"kind": kind})).unwrap();
            let c = container(blocks(&s)[0].as_ref()).clone();
            assert_eq!((c.role, c.style.as_deref()), (role, Some(style)));
            match role {
                ContainerRole::Code => assert_eq!(c.blocks[0].as_para().unwrap().props.style.as_deref(), Some(post::CODE_TEXT)),
                ContainerRole::Box => {
                    assert_eq!(c.space_after, 12.0);
                    assert_eq!(c.title[0].as_para().unwrap().text, "Title");
                    assert_eq!(c.title[0].as_para().unwrap().props.style.as_deref(), Some(post::BOX_TITLE));
                    assert_eq!(c.blocks[0].as_para().unwrap().text, "Hi");
                }
                ContainerRole::Quote => assert_eq!(c.blocks[0].as_para().unwrap().text, "Hi"),
            }
            s.run("post.toggle", &json!({"kind": kind})).unwrap();
            assert!(blocks(&s)[0].as_para().is_some(), "{kind} is lifted out again");
        }
    }

    #[test]
    fn rule_splits_the_paragraph_and_leaves_the_caret_in_the_one_after_it() {
        let mut s = one_para("one two");
        caret(&mut s, &[0], 3);
        s.run("post.rule", &json!({})).unwrap();
        assert_eq!(blocks(&s).len(), 3);
        assert_eq!(para(&s, &[0]).text, "one");
        assert_eq!(para(&s, &[1]).props.style.as_deref(), Some(post::RULE));
        assert!(para(&s, &[1]).is_empty());
        assert_eq!(para(&s, &[2]).text, " two");
        assert_eq!((s.sel.focus.path.0.clone(), s.sel.focus.off), (vec![2], 0));
    }

    #[test]
    fn list_gives_the_selection_one_instance_of_the_posts_definition_and_takes_it_off_again() {
        let mut s = session(json!({"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "one"}]},
            {"type": "paragraph", "content": [{"type": "text", "text": "two"}]}
        ]}));
        s.run("select.all", &json!({})).unwrap();
        s.run("post.list", &json!({"kind": "bullet"})).unwrap();
        let first = para(&s, &[0]).props.numbering.unwrap();
        let second = para(&s, &[1]).props.numbering.unwrap();
        assert_eq!((first.num, first.level), (second.num, 0));
        assert_eq!(s.doc.numbering.num(first.num).unwrap().abstract_id, post::BULLET_ABSTRACT);
        assert_eq!(s.run("post.context", &json!({})).unwrap()["list"].as_str(), Some("bullet"));
        s.run("post.list", &json!({"kind": "bullet"})).unwrap();
        assert_eq!((para(&s, &[0]).props.numbering, para(&s, &[1]).props.numbering), (None, None));
        // The other kind takes the numbered definition.
        s.run("post.list", &json!({"kind": "ordered"})).unwrap();
        let n = para(&s, &[0]).props.numbering.unwrap();
        assert_eq!(s.doc.numbering.num(n.num).unwrap().abstract_id, post::NUMBER_ABSTRACT);
    }

    #[test]
    fn mark_toggles_names_and_sets_the_size_colour_highlight_and_font() {
        let mut s = one_para("text");
        s.run("select.all", &json!({})).unwrap();
        s.run("post.mark", &json!({"mark": "bold"})).unwrap();
        assert_eq!(para(&s, &[0]).runs[0].props.bold, Some(true));
        s.run("post.mark", &json!({"mark": "bold"})).unwrap();
        assert_eq!(para(&s, &[0]).runs[0].props.bold, Some(false));
        s.run("post.mark", &json!({"mark": "italic", "on": true})).unwrap();
        assert_eq!(para(&s, &[0]).runs[0].props.italic, Some(true));
        s.run("post.mark", &json!({"size": 125})).unwrap();
        assert_eq!(para(&s, &[0]).runs[0].props.size, Some(15.0));
        s.run("post.mark", &json!({"color": "red"})).unwrap();
        assert_eq!(para(&s, &[0]).runs[0].props.color, Some(TextColor::Rgb(post::RED)));
        s.run("post.mark", &json!({"highlight": "yellow"})).unwrap();
        assert_eq!(para(&s, &[0]).runs[0].props.shading, Some(post::blend(post::YELLOW, post::PAPER)));
        s.run("post.mark", &json!({"font": "Georgia"})).unwrap();
        assert_eq!(para(&s, &[0]).runs[0].props.font.as_deref(), Some("Georgia"));
        // Inline code drops the marks it held.
        s.run("post.mark", &json!({"mark": "code"})).unwrap();
        let code = &para(&s, &[0]).runs[0].props;
        assert_eq!((code.style.as_deref(), code.bold, code.size, code.font.as_deref()), (Some(post::CODE), None, None, None));
        s.run("post.mark", &json!({"mark": "code"})).unwrap();
        assert_eq!(para(&s, &[0]).runs[0].props.style, None);
        // A value of null takes the value off.
        s.run("post.mark", &json!({"size": 200})).unwrap();
        s.run("post.mark", &json!({"size": null})).unwrap();
        assert_eq!(para(&s, &[0]).runs[0].props.size, None);
        assert!(s.run("post.mark", &json!({"size": 42})).is_err());
        assert!(s.run("post.mark", &json!({"color": "teal"})).is_err());
    }

    #[test]
    fn clear_drops_every_mark() {
        let mut s = session(json!({"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "bold", "marks": [{"type": "bold"}, {"type": "fontSize", "attrs": {"size": 150}}]}]}
        ]}));
        s.run("select.all", &json!({})).unwrap();
        s.run("post.clear", &json!({})).unwrap();
        let run = &para(&s, &[0]).runs[0].props;
        assert_eq!((run.bold, run.size), (None, None));
    }

    #[test]
    fn insert_reads_the_kits_nodes_and_gives_their_lists_instances_of_the_posts_own() {
        let mut s = one_para("x");
        s.run("select.all", &json!({})).unwrap();
        s.run(
            "post.insert",
            &json!({"json": [
                {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Hi"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "There"}]},
                {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "an item"}]}]}]}
            ]}),
        )
        .unwrap();
        let mut found = Vec::new();
        let mut items = Vec::new();
        for b in blocks(&s) {
            if let Some(p) = b.as_para() {
                found.push((p.text.clone(), p.props.style.clone()));
                if let Some(n) = p.props.numbering {
                    items.push((p.text.clone(), s.doc.numbering.num(n.num).unwrap().abstract_id));
                }
            }
        }
        assert!(found.contains(&("Hi".into(), Some("Heading2".into()))), "{found:?}");
        assert!(found.iter().any(|(t, _)| t == "There"));
        assert_eq!(items, vec![("an item".into(), post::BULLET_ABSTRACT)]);
    }

    #[test]
    fn box_fill_sets_the_box_without_an_undo_step() {
        let mut s = Session::new(Document::from_text("x"));
        s.run("insert.picture", &json!({"data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="})).unwrap();
        s.doc.objects_mut(&|o| o.frame().is_some(), &mut |o| {
            let f = o.float_mut().unwrap();
            f.id = ew_doc::Id(7);
            f.r#box = Some(std::sync::Arc::new(ObjectBox { kind: "media".into(), data: "{}".into(), ..Default::default() }));
        });
        s.run("box.fill", &json!({"id": 7, "data": "{\"nw\":10}", "file": "https://example.com/a.mp4", "w": 40, "h": 20})).unwrap();
        let at = s.doc.object_by_id(7).unwrap();
        let boxed = s.doc.para_at(&at).unwrap().object_at(at.off).unwrap().frame().unwrap().2.r#box.clone().unwrap();
        assert_eq!((boxed.kind.as_str(), boxed.data.as_str(), boxed.file.as_str()), ("media", "{\"nw\":10}", "https://example.com/a.mp4"));
        let got = s.run("box.get", &json!({"id": 7})).unwrap();
        assert_eq!((got["w"].as_f64(), got["h"].as_f64()), (Some(40.0), Some(20.0)));
        // The fill added no undo step: the one undo takes back the picture, not the fill.
        s.run("edit.undo", &json!({})).unwrap();
        assert!(s.doc.object_by_id(7).is_none(), "the picture's insert is the only step");
    }

    #[test]
    fn block_leaves_the_structural_styles_alone() {
        for style in [post::TABLE_HEAD, post::BOX_TITLE, post::RULE, post::LIST_MORE] {
            let mut s = one_para("x");
            s.doc.para_mut(StoryRef::Body, &Path(vec![0])).unwrap().props.style = Some(style.to_string());
            s.run("select.all", &json!({})).unwrap();
            s.run("post.block", &json!({"kind": "p"})).unwrap();
            assert_eq!(para(&s, &[0]).props.style.as_deref(), Some(style), "{style} is not a block to change");
            s.run("post.block", &json!({"kind": "h1"})).unwrap();
            assert_eq!(para(&s, &[0]).props.style.as_deref(), Some(style), "{style} is not a block to change");
        }
    }

    #[test]
    fn toggle_unwraps_a_box_from_its_title() {
        let mut s = one_para("Hi");
        caret(&mut s, &[0], 0);
        s.run("post.toggle", &json!({"kind": "box"})).unwrap();
        caret(&mut s, &[0, 0, 0, 0], 1);
        s.run("post.toggle", &json!({"kind": "box"})).unwrap();
        assert!(blocks(&s)[0].as_para().is_some());
        assert_eq!((para(&s, &[0]).text.as_str(), para(&s, &[1]).text.as_str()), ("Title", "Hi"));
    }

    #[test]
    fn typing_and_undoing_run_on_a_post() {
        let mut s = one_para("x");
        caret(&mut s, &[0], 1);
        s.run("text.insert", &json!({"text": "y"})).unwrap();
        assert_eq!(para(&s, &[0]).text, "xy");
        s.run("edit.undo", &json!({})).unwrap();
        assert_eq!(para(&s, &[0]).text, "x");
    }

    #[test]
    fn the_link_dialogs_commands_run_on_a_post() {
        let mut s = one_para("link");
        s.run("select.all", &json!({})).unwrap();
        let sel = s.run("document.selection", &json!({})).unwrap();
        assert_eq!(sel["text"].as_str(), Some("link"));
        assert!(s.run("link.targets", &json!({})).is_ok());
        s.run("insert.link", &json!({"url": "https://example.com"})).unwrap();
        assert_eq!(para(&s, &[0]).runs[0].props.link.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn a_post_counts_matches_without_moving_the_caret() {
        let mut s = one_para("cat cat cat");
        caret(&mut s, &[0], 3); // the first space: the next match is the second "cat"
        let before = s.sel.clone();
        let c = s.run("edit.findCount", &json!({"text": "cat", "special": false})).unwrap();
        assert_eq!((c["count"].as_u64(), c["index"].as_u64()), (Some(3), Some(1)));
        assert_eq!(s.sel, before);
    }

    #[test]
    fn a_post_reports_the_link_at_the_caret_and_takes_it_off() {
        let mut s = one_para("link");
        s.run("select.all", &json!({})).unwrap();
        s.run("insert.link", &json!({"url": "https://example.com"})).unwrap();
        caret(&mut s, &[0], 2);
        assert_eq!(s.run("post.context", &json!({})).unwrap()["link"].as_str(), Some("https://example.com"));
        s.run("insert.removeLink", &json!({})).unwrap();
        assert!(s.run("post.context", &json!({})).unwrap()["link"].is_null());
        assert!(para(&s, &[0]).runs.iter().all(|r| r.props.link.is_none()));
    }

    #[test]
    fn box_fill_fills_an_object_of_a_post() {
        let mut s = session(json!({"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "A canvas:"}]},
            {"type": "canvas", "attrs": {"w": 400, "h": 140, "dw": 400, "frame": null, "bg": "post", "items": [], "flow": null, "source": null}}
        ]}));
        s.doc.objects_mut(&|o| o.frame().is_some(), &mut |o| o.float_mut().unwrap().id = ew_doc::Id(7));
        s.run("box.fill", &json!({"id": 7, "file": "https://example.com/a.gif", "w": 50})).unwrap();
        let at = s.doc.object_by_id(7).unwrap();
        let frame = s.doc.para_at(&at).unwrap().object_at(at.off).unwrap().frame().unwrap();
        assert_eq!((frame.0, frame.2.r#box.as_ref().unwrap().file.as_str()), (50.0, "https://example.com/a.gif"));
    }

    #[test]
    fn the_post_runs_only_the_kits_commands_and_a_code_block_takes_no_marks() {
        let mut s = one_para("x");
        let e = s.run("list.define", &json!({})).unwrap_err();
        assert!(e.to_string().contains("This is not in a forum post"), "{e}");
        assert!(s.run("insert.table", &json!({"rows": 2, "cols": 2})).is_ok());
        let mut c = session(json!({"type": "doc", "content": [{"type": "codeBlock", "content": [{"type": "text", "text": "let x = 1;\n"}]}]}));
        caret(&mut c, &[0, 0, 0, 0], 2);
        let e = c.run("format.bold", &json!({})).unwrap_err();
        assert!(e.to_string().contains("A code block takes no formatting"), "{e}");
        assert!(c.run("post.mark", &json!({"mark": "bold"})).is_err());
        // A document with no post profile runs everything.
        let mut d = Session::new(Document::from_text("plain"));
        assert!(d.run("insert.picture", &json!({"data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="})).is_ok());
    }
}
