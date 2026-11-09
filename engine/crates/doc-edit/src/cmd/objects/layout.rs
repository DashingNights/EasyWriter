//! EasyWriter engine-gaps-shapes (docs/plans/engine/stage2b.md, stage2/gaps.md): what the Layout dialog sets beyond the
//! ribbon's commands (`arrange.float`), Regroup, the text wrapping break, frames (Insert Frame, Convert to Frame) and
//! Add Text into a shape.

use ew_doc::para::{Anchor, FloatAlign, OBJ, TEXT_WRAP_BREAK, WrapText};
use ew_doc::props::{Align, TextFrame, VAlign};
use ew_doc::{Block, PartKind, Path, StoryRef, para_block};

use super::group::group;
use super::select::{all_objects, edit_float, edit_obj, movable_story, object_selection, selected};
use super::shape::text_box_target;
use super::{CmdError, CmdResult, CommandSpec, InlineObject, Pos, Selection, Session, Value, Wrap, json, p, sel_result};

pub(super) fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("arrange.float", "Layout", "Layout › Arrange › Position › More Layout Options", float)
            .params(r#"{"wrapText"?: "bothSides|left|right|largest", "dist"?: {"top"?, "bottom"?, "left"?, "right"?: pt}, "h"?: {"rel": "column|margin|page|character|leftMargin|rightMargin|insideMargin|outsideMargin", "align"?: "left|center|right|inside|outside", "offset"?: pt}, "v"?: {"rel": "margin|page|paragraph|line|topMargin|bottomMargin|insideMargin|outsideMargin", "align"?: "top|center|bottom|inside|outside", "offset"?: pt}, "relWidth"?: {"rel", "pct"} | null, "relHeight"?: {"rel", "pct"} | null, "layoutInCell"?: bool}  (the Layout dialog's settings for the selected floating object that the ribbon's commands leave out; an alignment wins over an offset; one undo step)"#)
            .when(super::select::has_floating),
        CommandSpec::new("arrange.regroup", "Regroup", "Layout › Arrange › Group", regroup)
            .params(r#"{}  (groups again the objects the last Ungroup split, those of them still in the document)"#),
        CommandSpec::new("layout.textWrappingBreak", "Text Wrapping Break", "Layout › Page Setup › Breaks", text_wrapping_break)
            .params(r#"{}  (a line break whose next line starts below the floating objects beside its line: w:br textWrapping, clear all)"#),
        CommandSpec::new("insert.frame", "Insert Frame", "Developer › Controls › Legacy Tools", insert_frame)
            .params(r#"{"width"?: pt, "height"?: pt, "page"?: n, "x"?: pt, "y"?: pt}  (puts the selected paragraphs, or the caret's, in a text frame where they are, text wrapping around it; with page, x and y a new empty frame of that size there, placed from the page's corner)"#),
        CommandSpec::new("shape.toFrame", "Convert to Frame", "Shape Format › Text Box", to_frame)
            .params(r#"{}  (the selected text box's paragraphs become framed paragraphs at its place on the page; the box goes)"#)
            .when(super::shape::has_text_box),
        CommandSpec::new("shape.addText", "Add Text", "Shape Format › Insert Shapes", add_text)
            .params(r#"{}  (puts the caret in the selected shape's text, giving the shape text of its own, centred, when it has none)"#)
            .when(|s| match selected(s) {
                Some((_, InlineObject::Shape { kind, .. })) if !kind.is_open() => None,
                _ => Some("select a shape first"),
            }),
        CommandSpec::new("shape.textBox", "Text Box", "Format Shape › Layout & Properties", |s, v| {
            let auto_fit = p::bool(v, "autoFit");
            let insets = v.get("insets").map(|i| {
                let emu = |k: &str| p::f32(i, k).filter(|x| x.is_finite()).map(|x| (x.clamp(0.0, MAX_LEN) * 12_700.0).round() as u32);
                (emu("left"), emu("top"), emu("right"), emu("bottom"))
            });
            super::set_text_body(s, |b| {
                if let Some(a) = auto_fit {
                    b.auto_fit = a;
                }
                if let Some((l, t, r, bt)) = insets {
                    let [l0, t0, r0, b0] = b.inset.unwrap_or(ew_doc::TEXT_BOX_INSET);
                    b.inset = Some([l.unwrap_or(l0), t.unwrap_or(t0), r.unwrap_or(r0), bt.unwrap_or(b0)]);
                }
            })
        })
        .params(r#"{"autoFit"?: bool, "insets"?: {"left"?, "top"?, "right"?, "bottom"?: pt}}  (Format Shape's Text Box options for the selected text box or shape with text: Resize shape to fit text, and its margins)"#)
        .when(super::shape::has_text_box),
    ]
}

/// A float anchor by its OOXML name (`relativeFrom`).
fn anchor(v: &Value) -> Result<Anchor, CmdError> {
    serde_json::from_value(v.clone()).map_err(|_| CmdError::Params(format!("unknown position anchor {v}")))
}

/// Points kept for a distance or an offset (a page's width either way).
const MAX_LEN: f32 = 1584.0;

/// `arrange.float`: the Layout dialog's float settings on the selected object.
fn float(s: &mut Session, v: &Value) -> CmdResult {
    let (pos, obj) = selected(s).ok_or_else(|| CmdError::Disabled("no picture or shape selected".into()))?;
    let Some((_, _, now)) = obj.frame() else { return Err(CmdError::Disabled("select a picture or shape first".into())) };
    let mut f = now.clone();
    if f.wrap == Wrap::Inline {
        return Err(CmdError::Disabled("pick a wrapping style other than In Line with Text first".into()));
    }
    if let Some(w) = p::str(v, "wrapText") {
        f.wrap_text = WrapText::from_ooxml(w).ok_or_else(|| CmdError::Params(format!("unknown wrapText `{w}`")))?;
    }
    let len = |o: &Value, k: &str| p::f32(o, k).filter(|x| x.is_finite()).map(|x| x.clamp(0.0, MAX_LEN));
    if let Some(d) = v.get("dist") {
        f.dist_top = len(d, "top").unwrap_or(f.dist_top);
        f.dist_bottom = len(d, "bottom").unwrap_or(f.dist_bottom);
        // ponytail: the model keeps one distance for both sides; the side the dialog changed wins. Keep left and right
        // apart when a document needs them to differ.
        let (l, r) = (len(d, "left"), len(d, "right"));
        f.dist = match (l, r) {
            (Some(l), Some(r)) if (r - now.dist).abs() > 0.01 && (l - now.dist).abs() <= 0.01 => r,
            (Some(l), _) => l,
            (None, Some(r)) => r,
            (None, None) => f.dist,
        };
    }
    for (key, horizontal) in [("h", true), ("v", false)] {
        let Some(o) = v.get(key) else { continue };
        let rel = anchor(o.get("rel").unwrap_or(&Value::Null))?;
        let align = match p::str(o, "align") {
            Some(a) => Some(FloatAlign::from_ooxml(a).ok_or_else(|| CmdError::Params(format!("unknown alignment `{a}`")))?),
            None => None,
        };
        let offset = p::f32(o, "offset").filter(|x| x.is_finite()).map(|x| x.clamp(-MAX_LEN, MAX_LEN));
        if horizontal {
            f.h_rel = rel;
            f.h_align = align;
            f.x = offset.unwrap_or(if align.is_some() { f.x } else { 0.0 });
        } else {
            f.v_rel = rel;
            f.v_align = align;
            f.y = offset.unwrap_or(if align.is_some() { f.y } else { 0.0 });
        }
    }
    let rel_size = |key: &str, slot: &mut Option<(Anchor, f32)>| -> Result<(), CmdError> {
        match v.get(key) {
            None => {}
            Some(Value::Null) => *slot = None,
            Some(o) => {
                let pct = p::f32(o, "pct").filter(|x| x.is_finite() && *x > 0.0).ok_or_else(|| CmdError::Params(format!("`{key}.pct`: a percentage")))?;
                *slot = Some((anchor(o.get("rel").unwrap_or(&Value::Null))?, (pct / 100.0).min(10.0)));
            }
        }
        Ok(())
    };
    rel_size("relWidth", &mut f.rel_w)?;
    rel_size("relHeight", &mut f.rel_h)?;
    if let Some(b) = p::bool(v, "layoutInCell") {
        f.outside_cell = !b;
    }
    let o = edit_float(s, &pos, |x| *x = f.clone())?;
    Ok(json!({"object": serde_json::to_value(o).unwrap_or(Value::Null)}))
}

/// The tag Ungroup gives the objects it splits: one more than any in the document.
pub(super) fn next_regroup_tag(s: &Session) -> u32 {
    all_objects(s).iter().filter_map(|(_, o)| o.frame().map(|(_, _, f)| f.regroup)).max().unwrap_or(0).saturating_add(1)
}

/// `arrange.regroup`: the objects of the last Ungroup still in the document, grouped again.
fn regroup(s: &mut Session, v: &Value) -> CmdResult {
    let objects = all_objects(s);
    let tag = objects.iter().filter_map(|(_, o)| o.frame().map(|(_, _, f)| f.regroup)).max().unwrap_or(0);
    let members: Vec<Pos> = objects.into_iter().filter(|(_, o)| tag > 0 && o.frame().is_some_and(|(_, _, f)| f.regroup == tag)).map(|(p, _)| p).collect();
    let [first, rest @ ..] = members.as_slice() else { return Err(CmdError::Disabled("there is nothing to regroup".into())) };
    if rest.is_empty() {
        return Err(CmdError::Disabled("there is nothing to regroup".into()));
    }
    s.sel = Selection { anchor: first.clone(), focus: Pos { off: first.off + OBJ.len_utf8(), ..first.clone() } };
    s.also_selected = rest.to_vec();
    let out = group(s, v)?;
    // The new group is no longer an ungrouped one.
    if let Some((pos, _)) = object_selection(s).map(|(p, o)| (p, o.clone())) {
        edit_float(s, &pos, |f| f.regroup = 0)?;
    }
    Ok(out)
}

/// `layout.textWrappingBreak`: Word's Text Wrapping break at the selection. Typed as a line break (tracked as one when
/// Track Changes is on), then made a clearing one.
pub(crate) fn text_wrapping_break(s: &mut Session, _: &Value) -> CmdResult {
    crate::cmd::type_text(s, "\n")?;
    let at = s.sel.focus.clone();
    let off = at.off.checked_sub(1).ok_or_else(|| CmdError::Failed("the break was not typed".into()))?;
    let para = s.doc.para_mut(at.story, &at.path)?;
    if para.text.get(off..at.off) != Some("\n") {
        return Err(CmdError::Failed("the break was not typed".into()));
    }
    para.text.replace_range(off..at.off, TEXT_WRAP_BREAK.encode_utf8(&mut [0; 4]));
    para.touch();
    sel_result(s)
}

/// Word's horizontal distance between a frame and the text around it: 0.13", 180 twips.
const FRAME_SPACE: f32 = 9.0;

/// `insert.frame`: the selected paragraphs of the body (or the caret's) framed where they are, as Word frames a selection;
/// with `page`, `x` and `y` (the crosshair's box, engine-tools-2) a new empty frame there instead.
// ponytail: Word probes of a framed selection's size are still to come.
fn insert_frame(s: &mut Session, v: &Value) -> CmdResult {
    if v.get("page").is_some() {
        return draw_frame(s, v);
    }
    let (a, b) = s.sel.ordered();
    if a.story != StoryRef::Body || b.story != StoryRef::Body {
        return Err(CmdError::Disabled("frames go in the main text".into()));
    }
    let paths: Vec<Path> = s.doc.para_paths_in(&a, &b).into_iter().filter(|p| p.depth() == 0).collect();
    if paths.is_empty() {
        return Err(CmdError::Disabled("put the caret in a paragraph of the main text first".into()));
    }
    let size = |k: &str| p::f32(v, k).filter(|x| x.is_finite() && *x > 0.0).map(|x| x.clamp(4.0, MAX_LEN));
    let frame = TextFrame {
        w: size("width"),
        h: size("height"),
        h_anchor: "text".into(),
        v_anchor: "text".into(),
        wrap: "around".into(),
        h_space: FRAME_SPACE,
        ..TextFrame::default()
    };
    for path in &paths {
        let para = s.doc.para_mut(StoryRef::Body, path)?;
        para.props.frame = Some(frame.clone());
        para.touch();
    }
    sel_result(s)
}

/// A frame drawn with the crosshair: an empty framed paragraph of the drawn size at page point (`x`, `y`) of `page`, placed
/// from the page's corner, before the top-level block of the body under that point. The caret goes into it.
// ponytail: placed from the page as Convert to Frame does; Word's drawn frame may measure from the column and the paragraph
// (unprobed), which only the Frame dialog shows.
fn draw_frame(s: &mut Session, v: &Value) -> CmdResult {
    let page = p::u64(v, "page").and_then(|n| usize::try_from(n).ok()).ok_or_else(|| CmdError::Params("`page` (0-based) is required".into()))?;
    let (x, y) = (p::req_f32(v, "x")?, p::req_f32(v, "y")?);
    if !x.is_finite() || !y.is_finite() {
        return Err(CmdError::Params("`x` and `y` must be numbers".into()));
    }
    let l = s.layout();
    let pg = l.pages.get(page).ok_or_else(|| CmdError::Params(format!("no page {page}")))?;
    let (x, y) = (x.clamp(0.0, pg.w), y.clamp(0.0, pg.h));
    let at = l.hit(page, x, y, StoryRef::Body).ok_or_else(|| CmdError::Disabled("there is no text on that page to anchor a frame to".into()))?;
    let size = |k: &str| p::f32(v, k).filter(|x| x.is_finite() && *x > 0.0).map(|x| x.clamp(4.0, MAX_LEN));
    let mut para = ew_doc::Paragraph::new();
    para.props.frame = Some(TextFrame {
        w: size("width"),
        h: size("height"),
        x,
        y,
        h_anchor: "page".into(),
        v_anchor: "page".into(),
        wrap: "around".into(),
        h_space: FRAME_SPACE,
        ..TextFrame::default()
    });
    let path = Path::top(at.path.0.first().copied().unwrap_or(0) as usize);
    s.doc.insert_block(StoryRef::Body, &path, Block::Para(para))?;
    s.sel = Selection::caret(Pos { story: StoryRef::Body, path, off: 0 });
    s.touch();
    sel_result(s)
}

/// `shape.toFrame`: Convert to Frame. The text box's paragraphs go before the paragraph that anchors it, framed at the
/// box's place on its page (anchored to the page, as Word converts a box), with its size and distances; tables and other
/// blocks go with them unframed. The box and its story go.
fn to_frame(s: &mut Session, _: &Value) -> CmdResult {
    let (pos, id) = text_box_target(s).ok_or_else(|| CmdError::Disabled("select a text box first".into()))?;
    if pos.story != StoryRef::Body || pos.path.depth() > 0 {
        return Err(CmdError::Disabled("only a text box in the main text, outside tables, converts to a frame".into()));
    }
    if s.doc.parts.get(&id).is_some_and(|p| p.body.next.is_some()) || s.doc.text_box_chains().iter().any(|c| c.iter().skip(1).any(|x| *x == id)) {
        return Err(CmdError::Disabled("a linked text box can't be converted: break the link first".into()));
    }
    let obj = s.doc.para_at(&pos).and_then(|q| q.object_at(pos.off)).cloned().ok_or_else(|| CmdError::Failed("the text box vanished".into()))?;
    let Some((w, h, float)) = obj.frame().map(|(w, h, f)| (w, h, f.clone())) else { return Err(CmdError::Failed("the text box vanished".into())) };
    let hit = s.layout().object(&pos, s.page_hint);
    let (x, y) = hit.map_or((float.x, float.y), |o| (o.rect.x, o.rect.y));
    let auto_fit = s.doc.parts.get(&id).is_some_and(|p| p.body.auto_fit);
    let frame = TextFrame {
        w: Some(w),
        h: Some(h),
        h_exact: !auto_fit,
        x,
        y,
        h_anchor: "page".into(),
        v_anchor: "page".into(),
        wrap: if float.wrap == Wrap::TopAndBottom { "notBeside" } else { "around" }.into(),
        h_space: float.dist,
        v_space: float.dist_top,
        ..TextFrame::default()
    };
    let blocks: Vec<Block> = s.doc.parts.get(&id).map(|p| p.blocks.iter().map(|b| (**b).clone()).collect()).unwrap_or_default();
    // The box first (its paragraph keeps its place), then its blocks before that paragraph.
    s.doc.delete_range(&pos, &Pos { off: pos.off + OBJ.len_utf8(), ..pos.clone() })?;
    s.doc.parts.remove(&id);
    let at = pos.path.last();
    for (i, b) in blocks.into_iter().enumerate() {
        let b = match b {
            Block::Para(mut q) => {
                q.props.frame = Some(frame.clone());
                q.touch();
                Block::Para(q)
            }
            other => other,
        };
        s.doc.insert_block(StoryRef::Body, &pos.path.with_last(at + i), b)?;
    }
    s.sel = Selection::caret(Pos { story: StoryRef::Body, path: pos.path.with_last(at), off: 0 });
    s.touch();
    sel_result(s)
}

/// `shape.addText`: the caret into the selected shape's text. A shape with none gets a story of its own, its text centred
/// in the shape as Word's default shapes have it, in white (Word's default shape style gives its text the theme's light 1).
fn add_text(s: &mut Session, _: &Value) -> CmdResult {
    let (pos, obj) = selected(s).ok_or_else(|| CmdError::Disabled("select a shape first".into()))?;
    let InlineObject::Shape { story, kind, .. } = &obj else { return Err(CmdError::Disabled("select a shape first".into())) };
    if kind.is_open() {
        return Err(CmdError::Disabled("lines and connectors take no text".into()));
    }
    if !movable_story(s, pos.story) && pos.story != StoryRef::Body {
        return Err(CmdError::Disabled("this shape's text can't be edited here".into()));
    }
    let id = match story.filter(|id| s.doc.parts.contains_key(id)) {
        Some(id) => id,
        None => {
            let mut para = ew_doc::Paragraph::new();
            para.props.align = Some(Align::Center);
            let id = s.doc.try_add_part(PartKind::TextBox, vec![para_block(para)])?;
            if let Some(part) = s.doc.parts.get_mut(&id) {
                part.body.anchor = VAlign::Center;
                part.body.auto_color = Some(ew_doc::props::Rgb::WHITE);
            }
            edit_obj(s, &pos, |o| {
                if let InlineObject::Shape { story, .. } = o {
                    *story = Some(id);
                }
            })?;
            id
        }
    };
    s.also_selected.clear();
    s.sel = Selection::caret(s.doc.end_of(StoryRef::Part(id)));
    Ok(json!({"story": id}))
}
