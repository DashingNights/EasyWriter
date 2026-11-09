//! What the selection is in, and the document's settings (docs/plans/engine/stage2.md, the Stage 2.0 scaffold, gaps G1 and
//! G11): `document.context` fills the contextual tabs, the right-click menus and the tools' story on a canvas draft
//! (src/document/word/base.js contextOf, src/tooling/surface.js), and `document.settings` gives the ribbon and the panes the
//! document's settings. Both are pure, and the ribbon reads them through the host's `state` (their spec's `state`), so a
//! selection change costs no second call. That reading runs on every typed key, so it stays in the caret's paragraph (see
//! [`Scope`]); the command itself (a right-click menu's `exec` or `query`) looks through the whole story.

use serde_json::{Value, json};
use ew_doc::PartKind;
use ew_doc::graphic::GraphicKind;
use ew_doc::para::InlineObject;
use ew_doc::section::NumFormat;
use ew_doc::{Pos, StoryRef};

use super::{parse_pos, pos_json};
use crate::{CmdError, CommandSpec, Selection, Session};

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("document.context", "Selection Context", "Document", |s, v| {
            let Some(at) = v.get("pos") else { return Ok(context(s, true, Scope::Story)) };
            let at = parse_pos(at).ok_or_else(|| CmdError::Params("bad `pos`".into()))?;
            let at = Selection::caret(s.doc.clamp(&at));
            let sel = std::mem::replace(&mut s.sel, at);
            let out = context(s, false, Scope::Story);
            s.sel = sel;
            Ok(out)
        })
        .params(
            r#"{"pos"?: Pos} → {story: {kind: "body|header|footer|footnote|endnote|comment|textbox", id: n|null}, table: {path, row, cell}|null, container: {path, role, language, title}|null, object: {kind: "picture|graphic|shape|textbox|box|chart|smartArt|group|drawingCanvas|ink", pos}|null, equation, field: {type, instr, pos}|null, control: {id, tag, kind}|null, comments: [id], revision: "insert|delete|format|paragraph"|null, link: {url}|{bookmark}|null, heading: 1..9|null, note: id|null, list: {num, level, numbered}|null, paraStart, compatMode: n}  (at the selection, or at a caret at `pos`)"#,
        )
        .pure()
        .state(|s| (Value::Null, context(s, true, Scope::Paragraph))),
        CommandSpec::new("document.settings", "Document Settings", "Document", |s, _| Ok(settings(s)))
            .params(r#"{} → the document's settings (page colour and picture, watermark, theme name, fonts and colours, mirror margins, even and odd headers, default tab, hyphenation, grid, protection mode, …); never a password hash"#)
            .pure()
            .state(|s| (Value::Null, settings(s))),
    ]
}

/// The document's Settings as they are saved, without the protection password's hash.
fn settings(s: &Session) -> Value {
    let mut v = serde_json::to_value(&s.doc.settings).unwrap_or(Value::Null);
    if let Some(m) = v.as_object_mut() {
        m.remove("protectHash");
    }
    v
}

/// How far `context` looks for the fields and content controls around the caret.
#[derive(Clone, Copy, PartialEq)]
enum Scope {
    /// The caret's paragraph: a field or control that starts in an earlier paragraph (a table of contents, a block control)
    /// is missed. The ribbon's state reading, on every typed key.
    // ponytail: the whole story's fields and controls took 5 to 6 ms a call on the 900-page fixture; keep a per-revision index
    // of field and control ranges in the session if a contextual command needs the block ones from the snapshot.
    Paragraph,
    /// The whole story, as Word finds them.
    Story,
}

/// What the selection's focus is in. `math`: the session's equation editing counts (not for another position).
fn context(s: &Session, math: bool, scope: Scope) -> Value {
    let doc = &s.doc;
    let f = &s.sel.focus;
    let (story, id) = match f.story {
        StoryRef::Body => ("body", None),
        StoryRef::Part(id) => (
            match doc.parts.get(&id).map(|p| p.kind) {
                Some(PartKind::Header) => "header",
                Some(PartKind::Footer) => "footer",
                Some(PartKind::Footnote) => "footnote",
                Some(PartKind::Endnote) => "endnote",
                Some(PartKind::Comment) => "comment",
                Some(PartKind::TextBox) => "textbox",
                None => "body",
            },
            Some(id),
        ),
    };
    let table = doc.cell_of(f.story, &f.path).map(|(t, row, cell)| json!({"path": t.0, "row": row, "cell": cell}));
    let container = doc
        .container_of(f.story, &f.path)
        .map(|(p, _, c)| json!({"path": p.0, "role": c.role.as_str(), "language": c.language, "title": !c.title.is_empty()}));
    let object = crate::cmd::objects::object_selection(s).map(|(pos, o)| json!({"kind": object_kind(doc, o), "pos": pos_json(&pos)}));
    // Editing inside an equation, or the equation itself selected.
    let (a, b) = s.sel.ordered();
    let one = a.path == b.path && b.off == a.off + ew_doc::para::OBJ.len_utf8();
    let equation = (math && s.math.is_some()) || (one && matches!(doc.para_at(&a).and_then(|p| p.object_at(a.off)), Some(InlineObject::Equation { .. })));
    let para = doc.para_at(f);
    let run = para.map(|p| p.props_at(f.off));
    let link = run.and_then(|c| c.link.as_deref()).map(|l| match l.strip_prefix('#') {
        Some(b) => json!({"bookmark": b}),
        None => json!({"url": l}),
    });
    let revision = run
        .and_then(|c| {
            if c.ins.is_some() {
                Some("insert")
            } else if c.del.is_some() {
                Some("delete")
            } else {
                c.fmt_change.as_ref().map(|_| "format")
            }
        })
        .or_else(|| para.and_then(|p| p.props.fmt_change.as_ref()).map(|_| "paragraph"));
    let field = match scope {
        Scope::Story => crate::cmd::fields::selected(s).into_iter().next().map(|x| (x.instr, x.at)),
        Scope::Paragraph => para.and_then(|p| field_in(p, &a)),
    }
    .map(|(instr, at)| json!({"type": instr.split_whitespace().next().unwrap_or("").to_ascii_uppercase(), "instr": instr, "pos": pos_json(&at)}));
    let marked = para.is_some_and(|p| p.objects.iter().any(|o| matches!(o, InlineObject::ControlStart { .. } | InlineObject::ControlEnd)));
    let control = (scope == Scope::Story || marked)
        .then(|| doc.control_at(f))
        .flatten()
        .map(|r| json!({"id": r.control.id, "tag": r.control.tag, "kind": r.control.kind}));
    let resolved = para.map(|p| doc.styles.resolve_para(&p.props));
    let heading = resolved.as_ref().and_then(|r| r.outline_level).filter(|l| *l < 9).map(|l| l + 1);
    let list = resolved.as_ref().and_then(|r| r.numbering).filter(|n| n.num != 0).map(|n| {
        let numbered = doc.numbering.level(n.num, n.level).is_some_and(|l| !matches!(l.format, NumFormat::Bullet | NumFormat::None));
        json!({"num": n.num, "level": n.level, "numbered": numbered})
    });
    let note = matches!(story, "footnote" | "endnote").then_some(id).flatten();
    json!({
        "story": {"kind": story, "id": id},
        "table": table,
        "container": container,
        "object": object,
        "equation": equation,
        "field": field,
        "control": control,
        "comments": comments_at(s, f),
        "revision": revision,
        "link": link,
        "heading": heading,
        "note": note,
        "list": list,
        "paraStart": s.sel.anchor == *f && f.off == 0,
        "compatMode": s.doc.settings.compat_mode,
    })
}

/// The kind of drawing `o` is, by what Word's contextual tabs tell apart.
fn object_kind(doc: &ew_doc::Document, o: &InlineObject) -> &'static str {
    if o.frame().is_some_and(|(_, _, f)| f.r#box.is_some()) {
        return "box"; // EasyWriter's own object (a smart canvas, a plan chart) over its fallback picture
    }
    match o {
        InlineObject::Image { media, .. } if media.to_ascii_lowercase().ends_with(".svg") || doc.media.get(media.as_str()).is_some_and(|b| b.starts_with(b"<svg")) => {
            "graphic"
        }
        InlineObject::Image { .. } => "picture",
        InlineObject::Graphic { graphic, .. } if graphic.smart_art.is_some() || graphic.kind == GraphicKind::Diagram => "smartArt",
        InlineObject::Graphic { graphic, .. } if graphic.kind == GraphicKind::Ink => "ink",
        InlineObject::Graphic { .. } => "chart",
        InlineObject::Shape { story: Some(_), .. } => "textbox",
        InlineObject::Shape { .. } => "shape",
        InlineObject::Group { .. } if o.is_canvas() => "drawingCanvas",
        _ => "group",
    }
}

/// The field at `at` in its paragraph `p`: a simple field just after or before it, else the innermost range field opened
/// before it there (as fields::selected finds them, in one paragraph).
fn field_in(p: &ew_doc::Paragraph, at: &Pos) -> Option<(String, Pos)> {
    let simple = |off: usize| match p.object_at(off) {
        Some(InlineObject::Field { instr, .. }) => Some((instr.clone(), Pos { off, ..at.clone() })),
        _ => None,
    };
    if let Some(f) = simple(at.off).or_else(|| at.off.checked_sub(ew_doc::para::OBJ.len_utf8()).and_then(simple)) {
        return Some(f);
    }
    let mut open = Vec::new();
    for off in p.object_offsets() {
        if off >= at.off {
            break;
        }
        match p.object_at(off) {
            Some(InlineObject::FieldStart { instr, .. }) => open.push((instr.clone(), Pos { off, ..at.clone() })),
            Some(InlineObject::FieldEnd) => {
                open.pop();
            }
            _ => {}
        }
    }
    open.pop()
}

/// The comments whose range holds `at`, outermost first (their anchors in its paragraph).
fn comments_at(s: &Session, at: &Pos) -> Vec<u32> {
    let Some(p) = s.doc.para_at(at) else { return Vec::new() };
    let mut open = Vec::new();
    for off in p.object_offsets() {
        if off > at.off {
            break;
        }
        match p.object_at(off) {
            Some(InlineObject::CommentStart { id }) => open.push(*id),
            Some(InlineObject::CommentEnd { id }) => open.retain(|x| x != id),
            _ => {}
        }
    }
    open
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::Session;

    fn ctx(s: &mut Session) -> Value {
        s.run("document.context", &json!({})).unwrap()
    }

    /// The body, a table cell and a header part: the story, the cell and an object; and caret.set and select.range take a
    /// Pos in a part story (insert.md finding 7, the story moves of G17).
    #[test]
    fn context_follows_the_story_the_cell_and_the_object() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("text.insert", &json!({"text": "Body"})).unwrap();
        let c = ctx(&mut s);
        assert_eq!(c["story"], json!({"kind": "body", "id": null}));
        assert_eq!(c["table"], Value::Null);
        assert_eq!(c["object"], Value::Null);

        s.run("insert.table", &json!({"rows": 2, "cols": 2})).unwrap();
        let c = ctx(&mut s);
        assert!(c["table"].is_object(), "the caret lands in the new table: {c}");

        s.run("caret.docEnd", &json!({})).unwrap();
        s.run("insert.shape", &json!({"kind": "rectangle"})).unwrap();
        s.run("select.objects", &json!({"index": 0})).unwrap();
        let c = ctx(&mut s);
        assert_eq!(c["object"]["kind"], "shape", "{c}");

        s.run("insert.header", &json!({"text": "Head"})).unwrap();
        let head = s.sel.focus.clone();
        let c = ctx(&mut s);
        assert_eq!(c["story"]["kind"], "header", "{c}");
        let id = c["story"]["id"].as_u64().unwrap();

        // Back to the body, then into the header by a JSON Pos, as a story move sends it.
        s.run("caret.set", &json!({"pos": {"story": "body", "path": [0], "off": 0}})).unwrap();
        assert_eq!(ctx(&mut s)["story"]["kind"], "body");
        let pos = json!({"story": {"part": id}, "path": [0], "off": 1});
        s.run("caret.set", &json!({"pos": pos})).unwrap();
        assert_eq!(s.sel.focus.story, head.story);
        assert_eq!(s.sel.focus.off, 1);
        s.run("select.range", &json!({"anchor": {"story": {"part": id}, "path": [0], "off": 0}, "focus": pos})).unwrap();
        assert_eq!((s.sel.anchor.story, s.sel.anchor.off, s.sel.focus.off), (head.story, 0, 1));
        // A `pos` asks about another place without moving the selection.
        let body = s.run("document.context", &json!({"pos": {"story": "body", "path": [0], "off": 0}})).unwrap();
        assert_eq!(body["story"]["kind"], "body");
        assert_eq!(s.sel.focus.story, head.story);
    }

    #[test]
    fn context_reads_lists_headings_and_links() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("text.insert", &json!({"text": "Title"})).unwrap();
        s.run("para.heading2", &json!({})).unwrap();
        assert_eq!(ctx(&mut s)["heading"], 2);
        s.run("text.newParagraph", &json!({})).unwrap();
        s.run("para.normal", &json!({})).unwrap();
        s.run("para.numbering", &json!({})).unwrap();
        let c = ctx(&mut s);
        assert_eq!(c["heading"], Value::Null);
        assert_eq!(c["list"]["numbered"], true, "{c}");
        assert_eq!(c["paraStart"], true);
    }

    /// The ribbon's reading (the spec's state, in the caret's paragraph) and the command (the whole story) agree on a field
    /// beside the caret.
    #[test]
    fn the_state_reading_finds_the_field_the_command_finds() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("text.insert", &json!({"text": "Page "})).unwrap();
        s.run("insert.field", &json!({"instr": "PAGE"})).unwrap();
        let full = ctx(&mut s);
        let read = (s.registry.get("document.context").unwrap().state.unwrap())(&s).1;
        assert_eq!(full["field"]["type"], "PAGE", "{full}");
        assert_eq!(read["field"], full["field"]);
    }

    /// The document's compatibility mode reaches the ribbon: Word's legacy tabs serve modes 11 and 12.
    #[test]
    fn context_reports_the_compatibility_mode() {
        let mut s = Session::new(ew_doc::Document::new());
        assert_eq!(ctx(&mut s)["compatMode"], 15);
        s.doc.settings.compat_mode = 12;
        assert_eq!(ctx(&mut s)["compatMode"], 12);
    }

    #[test]
    fn settings_leave_out_the_password_hash() {
        let mut s = Session::new(ew_doc::Document::new());
        s.doc.settings.protect_hash = vec![("sha512".into(), "secret".into())];
        let v = s.run("document.settings", &json!({})).unwrap();
        assert!(v.get("protectHash").is_none());
        assert!(v.get("themeColors").is_some_and(Value::is_array));
        let spec = s.registry.get("document.settings").unwrap();
        assert_eq!((spec.state.unwrap())(&s).1, v, "the ribbon's state read gives the same");
    }

    /// Several commands as one undo step; a failing step takes the steps before it back.
    #[test]
    fn run_many_is_one_undo_step() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("text.insert", &json!({"text": "One"})).unwrap();
        let depth = s.undo_depth();
        let steps = vec![("text.newParagraph".to_string(), json!({})), ("text.insert".to_string(), json!({"text": "Two"})), ("para.heading1".to_string(), json!({}))];
        s.run_many(&steps).unwrap();
        assert_eq!(s.undo_depth(), depth + 1);
        assert_eq!(s.doc.plain_text(ew_doc::StoryRef::Body), "One\nTwo");
        s.run("edit.undo", &json!({})).unwrap();
        assert_eq!(s.doc.plain_text(ew_doc::StoryRef::Body), "One");

        let bad = vec![("text.insert".to_string(), json!({"text": " more"})), ("no.such".to_string(), json!({}))];
        let (i, _) = s.run_many(&bad).unwrap_err();
        assert_eq!(i, 1);
        assert_eq!(s.doc.plain_text(ew_doc::StoryRef::Body), "One");
        assert_eq!(s.undo_depth(), depth);
    }
}
