use super::select::{all_objects, edit_obj, picked_objects, selected, selected_all, with_obj};
use super::{CmdError, CmdResult, InlineObject, Pos, Rgb, Session, StoryRef, TextBody, Value, json, p};

pub(super) const NO_TEXT_BOX: &str = "select a text box first";

pub(super) fn has_text_box(s: &Session) -> Option<&'static str> {
    if text_box_target(s).is_some() { None } else { Some(NO_TEXT_BOX) }
}

fn is_text_box(s: &Session, id: u32) -> bool {
    s.doc.parts.get(&id).is_some_and(|p| p.kind == ew_doc::PartKind::TextBox)
}

/// The text box the Shape Format › Text commands work on: the selected one, or the one whose
/// text the caret is in. Its U+FFFC's position and its story.
pub fn text_box_target(s: &Session) -> Option<(Pos, u32)> {
    if let Some((pos, InlineObject::Shape { story: Some(id), .. })) = selected(s)
        && is_text_box(s, id)
    {
        return Some((pos, id));
    }
    let StoryRef::Part(id) = s.sel.focus.story else { return None };
    if !is_text_box(s, id) {
        return None;
    }
    let after = s.doc.text_box_anchor(id)?;
    let off = after.off.checked_sub(ew_doc::para::OBJ.len_utf8())?;
    Some((Pos { off, ..after }, id))
}

/// Change the target text box's text direction, alignment or link.
pub(crate) fn set_text_body(s: &mut Session, f: impl Fn(&mut TextBody)) -> CmdResult {
    let (pos, id) = text_box_target(s).ok_or_else(|| CmdError::Disabled(NO_TEXT_BOX.into()))?;
    let part = s.doc.parts.get_mut(&id).ok_or_else(|| CmdError::Failed("text box vanished".into()))?;
    f(&mut part.body);
    let body = part.body;
    // Its paragraph is laid out again.
    edit_obj(s, &pos, |_| {})?;
    Ok(json!({"textBox": id, "body": body}))
}

pub(super) fn can_link(s: &Session) -> Option<&'static str> {
    match text_box_target(s) {
        None => Some(NO_TEXT_BOX),
        Some((_, id)) if s.doc.parts.get(&id).is_some_and(|p| p.body.next.is_some()) => Some("this text box is already linked: break the link first"),
        Some(_) => None,
    }
}

/// `shape.link`: the selected text box's text continues in the target box, which must be an
/// empty text box no other box links to, and not one of those the text already runs through.
pub(super) fn link_text_box(s: &mut Session, v: &Value) -> CmdResult {
    let (pos, from) = text_box_target(s).ok_or_else(|| CmdError::Disabled(NO_TEXT_BOX.into()))?;
    let target = v.get("target").ok_or_else(|| CmdError::Params("`target`: the text box to link to".into()))?;
    let at = match target.as_u64() {
        Some(n) => all_objects(s).into_iter().nth(usize::try_from(n).unwrap_or(usize::MAX)).map(|(p, _)| p),
        None => crate::cmd::parse_pos(target),
    }
    .ok_or_else(|| CmdError::Params("no object there".into()))?;
    let to = match s.doc.para_at(&at).and_then(|q| q.object_at(at.off)) {
        Some(InlineObject::Shape { story: Some(id), .. }) if is_text_box(s, *id) => *id,
        _ => return Err(CmdError::Params("the target isn't a text box".into())),
    };
    if s.doc.parts.get(&from).is_some_and(|p| p.body.next.is_some()) {
        return Err(CmdError::Failed("this text box is already linked: break the link first".into()));
    }
    if to == from || s.doc.text_box_chain(from).is_some_and(|c| c.contains(&to)) {
        return Err(CmdError::Failed("a text box can't link to itself or to a box its text already runs through".into()));
    }
    if s.doc.text_box_chains().iter().any(|c| c.iter().skip(1).any(|id| *id == to)) {
        return Err(CmdError::Failed("another text box already links to that one".into()));
    }
    if !s.doc.plain_text(StoryRef::Part(to)).trim().is_empty() {
        return Err(CmdError::Failed("the text box to link to must be empty".into()));
    }
    if let Some(p) = s.doc.parts.get_mut(&from) {
        p.body.next = Some(to);
    }
    edit_obj(s, &pos, |_| {})?;
    edit_obj(s, &at, |_| {})?;
    Ok(json!({"textBox": from, "next": to}))
}

/// Most shapes one `shape.effects` changes.
const MAX_EFFECT_SHAPES: usize = 10_000;

/// `shape.effects`: set or clear the shadow, glow and soft edges of the selected shapes.
pub(super) fn shape_effects(s: &mut Session, v: &Value) -> CmdResult {
    use ew_doc::effects::{Glow, Shadow, ShapeEffects};
    let color = |o: &Value| p::str(o, "color").and_then(Rgb::parse);
    // Each change is `None` (leave as it is) or `Some(new value)`.
    let shadow: Option<Option<Shadow>> = match v.get("shadow") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::Bool(b)) => Some(b.then(Shadow::default)),
        Some(Value::String(id)) if id == "none" => Some(None),
        Some(Value::String(id)) => Some(Some(Shadow::preset(id).ok_or_else(|| CmdError::Params(format!("unknown shadow preset `{id}`")))?)),
        Some(o @ Value::Object(_)) => {
            let mut sh = match p::str(o, "preset") {
                Some(id) => Shadow::preset(id).ok_or_else(|| CmdError::Params(format!("unknown shadow preset `{id}`")))?,
                None => Shadow::default(),
            };
            sh.color = color(o).unwrap_or(sh.color);
            sh.transparency = p::f32(o, "transparency").unwrap_or(sh.transparency);
            sh.blur = p::f32(o, "blur").unwrap_or(sh.blur);
            sh.distance = p::f32(o, "distance").unwrap_or(sh.distance);
            sh.angle = p::f32(o, "angle").unwrap_or(sh.angle);
            Some(Some(sh.sanitized()))
        }
        Some(_) => return Err(CmdError::Params("`shadow`: a preset name, an object or null".into())),
    };
    let glow: Option<Option<Glow>> = match v.get("glow") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(id)) if id == "none" => Some(None),
        Some(n @ Value::Number(_)) => Some(Some(Glow { size: n.as_f64().unwrap_or(0.0) as f32, ..Glow::default() }.sanitized())),
        Some(o @ Value::Object(_)) => {
            let d = Glow::default();
            Some(Some(
                Glow {
                    color: color(o).unwrap_or(d.color),
                    size: p::f32(o, "size").unwrap_or(d.size),
                    transparency: p::f32(o, "transparency").unwrap_or(d.transparency),
                }
                .sanitized(),
            ))
        }
        Some(_) => return Err(CmdError::Params("`glow`: a size in points, an object or null".into())),
    };
    let soft: Option<Option<f32>> = match v.get("softEdge") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(n @ Value::Number(_)) => Some(n.as_f64().map(|x| x as f32)),
        Some(_) => return Err(CmdError::Params("`softEdge`: a radius in points or null".into())),
    };
    // The shapes in the selection and those added to it (Shift+click).
    let mut targets: Vec<Pos> =
        selected_all(s, MAX_EFFECT_SHAPES).into_iter().filter(|(_, o)| matches!(o, InlineObject::Shape { .. })).map(|(pos, _)| pos).collect();
    for pos in picked_objects(s) {
        if !targets.contains(&pos) && matches!(s.doc.para_at(&pos).and_then(|q| q.object_at(pos.off)), Some(InlineObject::Shape { .. })) {
            targets.push(pos);
        }
    }
    if targets.is_empty() {
        return Err(CmdError::Disabled("no shape selected".into()));
    }
    let mut last = ShapeEffects::default();
    for pos in &targets {
        let o = edit_obj(s, pos, |o| {
            if let InlineObject::Shape { effects, float, .. } = o {
                let mut e = *effects;
                if let Some(x) = shadow {
                    e.shadow = x;
                }
                if let Some(x) = glow {
                    e.glow = x;
                }
                if let Some(x) = soft {
                    e.soft_edge = x;
                }
                *effects = e.sanitized();
                // Room around the shape for its shadow and glow, as Word's effect extent.
                float.effect = effects.extent();
            }
        })?;
        if let InlineObject::Shape { effects, .. } = o {
            last = effects;
        }
    }
    Ok(json!({"shapes": targets.len(), "effects": serde_json::to_value(last).unwrap_or(Value::Null)}))
}

/// The commands of this file (docs/plans/engine/stage2.md, the Stage 2.0 scaffold: one owner per file).
/// Change Shape (and Insert > Shapes after `insert.shape`): the selected shape's kind, or a DrawingML preset by name, which takes
/// its nearest kind and, when no kind draws it exactly, its outline from the preset's definition (docx `preset_shape`).
fn change_shape(s: &mut Session, v: &Value) -> CmdResult {
    use ew_doc::para::ShapeKind;
    let av = adjust_values(v);
    let (kind, preset): (ShapeKind, Option<String>) = match p::str(v, "preset") {
        Some(prst) if !prst.is_empty() && prst.len() <= 64 => (ew_docx::preset_shape_av(prst, &av, 100.0, 100.0).0, Some(prst.to_string())),
        Some(_) => return Err(CmdError::Params("bad `preset`".into())),
        None => (serde_json::from_value(v.get("kind").cloned().unwrap_or(json!("rectangle"))).map_err(|e| CmdError::Params(e.to_string()))?, None),
    };
    with_obj(s, |o| {
        if let InlineObject::Shape { kind: k, w, h, freeform, extra, .. } = o {
            *k = kind;
            // A freeform of its own (a drawn shape, ink) gives way to the preset's; a native kind drops the preset outline.
            let outline = preset.as_deref().and_then(|prst| ew_docx::preset_shape_av(prst, &av, *w, *h).1);
            extra.preset = outline.as_ref().and(preset.clone()).map(|p| (p, av.clone()));
            *freeform = outline.map(std::sync::Arc::new);
        }
    })
}

/// The adjust values a preset's command may give it (`av`): `[["adj1", 25000], ...]`, name and value as `a:avLst` holds them;
/// what does not parse is left out, and at most the 64 a preset may define.
fn adjust_values(v: &Value) -> Vec<(String, i64)> {
    let list = v.get("av").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    list.iter()
        .filter_map(|e| {
            let pair = e.as_array().filter(|a| a.len() == 2)?;
            Some((pair[0].as_str()?.to_string(), pair[1].as_i64()?))
        })
        .take(64)
        .collect()
}

/// The target text box's body (Shape Format › Text): its direction, alignment and link.
fn body_of(s: &Session) -> Option<TextBody> {
    text_box_target(s).and_then(|(_, id)| s.doc.parts.get(&id)).map(|p| p.body)
}

/// Shape Outline: the colour, weight, dash and arrowheads of the selected shapes (a selected drawing canvas: its border). A
/// key left out keeps that part as it is, so Weight or Dashes alone keep the colour; `color: null` is No Outline.
fn outline(s: &mut Session, v: &Value) -> CmdResult {
    use ew_doc::connector::LineCap;
    use ew_doc::line_dash::LineDash;
    // Only null is No Outline: a colour that doesn't parse is a mistake, not a request to remove the outline.
    let color = match v.get("color") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(c) => Some(Some(c.as_str().and_then(Rgb::parse).ok_or_else(|| CmdError::Params(format!("bad outline colour {c}")))?)),
    };
    let width = p::f32(v, "width").map(|w| w.clamp(0.0, 72.0));
    // Word's Round Dot is the system dot with round ends; Square Dot is sysDash (DrawingML's names for the two).
    let dash = p::str(v, "dash").map(|d| match d {
        "roundDot" => (LineDash::SystemDot, LineCap::Round),
        "squareDot" => (LineDash::SystemDash, LineCap::Flat),
        "longDash" => (LineDash::LongDash, LineCap::Flat),
        "longDashDot" => (LineDash::LongDashDot, LineCap::Flat),
        "longDashDotDot" => (LineDash::LongDashDotDot, LineCap::Flat),
        d => (LineDash::from_ooxml(d), LineCap::Flat),
    });
    let arrows = v.get("arrows").map(|a| (p::bool(a, "start"), p::bool(a, "end")));
    // EasyWriter engine-gaps-shapes: Shape Outline › Pattern, a patterned outline in its foreground and background colours
    // (null: a plain outline in the foreground colour).
    let pattern = match v.get("pattern") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(pat) => Some(Some(crate::cmd::shape_fill::pattern(pat)?)),
    };
    with_obj(s, |o| {
        if let InlineObject::Shape { stroke, stroke_width, extra, .. } = o {
            if let Some(c) = color {
                *stroke = c;
                // A colour chosen here replaces an outline gradient from a file.
                extra.outline_fill = None;
            }
            if let Some(pat) = &pattern {
                if let Some(f) = pat {
                    *stroke = Some(f.main_color());
                }
                extra.outline_fill = pat.clone();
            }
            if color.is_none() && pattern.is_none() && stroke.is_none() && (width.is_some() || dash.is_some()) {
                // A weight or dash on a shape without an outline gives it one in black, as Word does.
                *stroke = Some(Rgb::BLACK);
            }
            if let Some(w) = width {
                *stroke_width = w;
            }
            if let Some((d, cap)) = dash.clone() {
                (extra.dash, extra.cap) = (d, cap);
            }
            if let Some((a, b)) = arrows {
                extra.arrow_start = a.unwrap_or(extra.arrow_start);
                extra.arrow_end = b.unwrap_or(extra.arrow_end);
            }
        } else if let Some(style) = crate::cmd::canvas::style_mut(o) {
            if let Some(c) = color {
                style.stroke = c;
            }
            if let Some(w) = width {
                style.stroke_width = w;
            }
        }
    })
}

/// Shape Outline's state: the selected shape's outline `{color, width, dash}` (null without a shape).
fn outline_state(s: &Session) -> Value {
    match selected(s) {
        Some((_, InlineObject::Shape { stroke, stroke_width, extra, .. })) => {
            json!({"color": stroke.map(|c| c.hex()), "width": stroke_width, "dash": extra.dash.ooxml(), "arrows": {"start": extra.arrow_start, "end": extra.arrow_end}})
        }
        _ => Value::Null,
    }
}

pub(super) fn specs() -> Vec<super::CommandSpec> {
    use super::select::{edit_obj, has_shape, has_shape_or_canvas};
    use super::{CmdError, CommandSpec, TextVert, VAlign, json, p};
    vec![
        CommandSpec::new("shape.outline", "Shape Outline", "Shape Format › Shape Styles", outline)
            .params(r#"{"color"?: "RRGGBB" | null, "width"?: pt, "dash"?: "solid|roundDot|sysDot|sysDash|dash|dashDot|lgDash|lgDashDot|lgDashDotDot", "arrows"?: {"start"?: bool, "end"?: bool}, "pattern"?: {"preset", "fg": "RRGGBB", "bg": "RRGGBB"} | null}  (a key left out keeps that part, so Weight alone keeps the colour; color null: No Outline; pattern: a patterned outline, null a plain one; a selected drawing canvas: its border)"#)
            .when(has_shape_or_canvas)
            .state(|s| (Value::Null, outline_state(s))),
        CommandSpec::new("shape.effects", "Shape Effects", "Shape Format › Shape Styles", shape_effects)
            .params(
                r#"{"shadow"?: preset|{"preset"?, "color"?: "RRGGBB", "transparency"?: %, "blur"?: pt, "distance"?: pt, "angle"?: deg}|null, "glow"?: pt|{"color"?: "RRGGBB", "size"?: pt, "transparency"?: %}|null, "softEdge"?: pt|null}  (shadow presets: offsetBottomRight, offsetBottom, offsetBottomLeft, offsetRight, offsetCenter, offsetLeft, offsetTopRight, offsetTop, offsetTopLeft; an omitted key is left as it is; applies to every shape in the selection)"#,
            )
            .when(has_shape),
        CommandSpec::new("shape.change", "Change Shape", "Shape Format › Insert Shapes", change_shape)
            .params(r#"{"kind"?: string} | {"preset": DrawingML preset name ("hexagon", "cloud", "rightArrow"…)}  (a preset no shape kind draws is drawn from its definition and saved as that preset)"#)
            .when(has_shape),
        CommandSpec::new("shape.textDirection", "Text Direction", "Shape Format › Text", |s, v| {
            let dir = p::str(v, "dir").unwrap_or("horz");
            let vert = match dir {
                "horz" | "horizontal" => TextVert::Horz,
                "eaVert" | "vertical" => TextVert::EaVert,
                "vert" | "rotate90" => TextVert::Vert,
                "vert270" | "rotate270" => TextVert::Vert270,
                "wordArtVert" | "stacked" => TextVert::Stacked,
                other => return Err(CmdError::Params(format!("unknown text direction `{other}`"))),
            };
            set_text_body(s, |b| b.vert = vert)
        })
        .params(r#"{"dir": "horz|eaVert|vert|vert270|wordArtVert"}  (horizontal, vertical, rotate all text 90°, 270°, stacked; the selected text box or the one the caret is in)"#)
        .when(has_text_box)
        .state(|s| (Value::Null, body_of(s).map(|b| json!(match b.vert {
            TextVert::Horz => "horz",
            TextVert::EaVert => "eaVert",
            TextVert::Vert => "vert",
            TextVert::Vert270 => "vert270",
            TextVert::Stacked => "wordArtVert",
        })).unwrap_or(Value::Null))),
        CommandSpec::new("shape.alignText", "Align Text", "Shape Format › Text", |s, v| {
            let anchor = match p::str(v, "anchor").unwrap_or("t") {
                "t" | "top" => VAlign::Top,
                "ctr" | "middle" | "center" => VAlign::Center,
                "b" | "bottom" => VAlign::Bottom,
                other => return Err(CmdError::Params(format!("unknown text alignment `{other}`"))),
            };
            set_text_body(s, |b| b.anchor = anchor)
        })
        .params(r#"{"anchor": "t|ctr|b"}  (top, middle, bottom of the box: for turned text, from the side its lines start on)"#)
        .when(has_text_box)
        .state(|s| (Value::Null, body_of(s).map(|b| json!(match b.anchor {
            VAlign::Top => "t",
            VAlign::Center => "ctr",
            VAlign::Bottom => "b",
        })).unwrap_or(Value::Null))),
        CommandSpec::new("shape.link", "Create Link", "Shape Format › Text", link_text_box)
            .params(r#"{"target": Pos | n}  (the empty text box the selected box's text continues in: its position, or its Selection Pane index)"#)
            .when(can_link),
        CommandSpec::new("shape.breakLink", "Break Link", "Shape Format › Text", |s, _| {
            let (pos, id) = text_box_target(s).ok_or_else(|| CmdError::Disabled(NO_TEXT_BOX.into()))?;
            let part = s.doc.parts.get_mut(&id).ok_or_else(|| CmdError::Failed("text box vanished".into()))?;
            if part.body.next.take().is_none() {
                return Err(CmdError::Disabled("this text box isn't linked to another".into()));
            }
            edit_obj(s, &pos, |_| {})?;
            Ok(json!({"textBox": id}))
        })
        .params(r#"{}  (the text stops at the end of the selected box; the boxes after it go back to their own text)"#)
        .when(|s| match text_box_target(s) {
            Some((_, id)) if s.doc.parts.get(&id).is_some_and(|p| p.body.next.is_some()) => None,
            _ => Some("select a text box linked to another first"),
        })
        .state(|s| (json!(body_of(s).is_some_and(|b| b.next.is_some())), Value::Null)),
    ]
}
