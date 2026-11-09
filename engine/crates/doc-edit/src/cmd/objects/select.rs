use super::{CmdError, CmdResult, Float, GraphicKind, InlineObject, Pos, Selection, Session, Spin, StoryRef, Value, Wrap, json, p};

pub(super) fn has_picture(s: &Session) -> Option<&'static str> {
    match selected(s) {
        Some((_, InlineObject::Image { .. })) => None,
        _ => Some("select a picture first"),
    }
}

pub(super) fn has_object(s: &Session) -> Option<&'static str> {
    if selected(s).is_some() { None } else { Some("select a picture or shape first") }
}

pub(super) fn has_floating(s: &Session) -> Option<&'static str> {
    match selected(s) {
        Some((_, o @ InlineObject::Graphic { .. })) if !from_model(&o) => Some(FROZEN),
        Some((_, o)) if o.is_floating() => None,
        _ => Some("select a floating picture or shape first"),
    }
}

/// Stories whose objects can be moved, resized and arranged: the body and headers/footers.
/// Objects in table cells (deeper paths), notes and text boxes stay where their text is.
pub(super) fn movable_story(s: &Session, story: StoryRef) -> bool {
    match story {
        StoryRef::Body => true,
        StoryRef::Part(id) => {
            s.doc.parts.get(&id).is_some_and(|p| matches!(p.kind, ew_doc::PartKind::Header | ew_doc::PartKind::Footer))
        }
    }
}

/// Charts and diagrams from other programs are not written back on save yet, so their size,
/// position and wrapping stay as imported: they can be selected and deleted, not moved, resized
/// or arranged. One EasyWriter made from a model (a chart or a SmartArt) is written from it.
pub(super) const FROZEN: &str = "charts and diagrams from other programs can't be moved or resized yet";

/// Whether `o` is a chart or SmartArt EasyWriter made from its own model, which the writer lays
/// out again and writes back (write/story/object.rs `write_graphic`).
fn from_model(o: &InlineObject) -> bool {
    matches!(o, InlineObject::Graphic { graphic, .. } if graphic.chart.is_some() || graphic.smart_art.is_some())
}

/// `has_movable` for Size: charts and SmartArt EasyWriter can edit are laid out again at their
/// new size.
pub(super) fn has_sizable(s: &Session) -> Option<&'static str> {
    match selected(s) {
        Some((_, o)) if from_model(&o) => None,
        _ => has_movable(s),
    }
}

/// `has_object` for the geometry commands: a chart or diagram from another program is frozen.
pub(super) fn has_movable(s: &Session) -> Option<&'static str> {
    match selected(s) {
        Some((_, o @ InlineObject::Graphic { .. })) if !from_model(&o) => Some(FROZEN),
        _ => has_object(s),
    }
}

/// Word's own ink in a group is kept in the form a group member takes; it can't stand on its own
/// yet, so such a group stays whole.
pub(super) const INK_GROUP: &str = "a group holding Word ink can't be ungrouped yet";

/// Does group `o` hold a member that can't stand on its own (Word's ink)?
pub(super) fn holds_ink(o: &InlineObject) -> bool {
    matches!(o, InlineObject::Group { children, .. } if children.iter().any(|c| matches!(&c.obj, InlineObject::Graphic { graphic, .. } if graphic.kind == GraphicKind::Ink)))
}

pub(super) fn has_group(s: &Session) -> Option<&'static str> {
    match selected(s) {
        Some((_, o)) if o.is_canvas() => Some("a drawing canvas can't be ungrouped"),
        Some((_, o)) if holds_ink(&o) => Some(INK_GROUP),
        Some((_, InlineObject::Group { .. })) => None,
        _ => Some("select a group first"),
    }
}

/// Shape Fill and Shape Outline: a shape, or a Drawing Canvas's background and border.
pub(crate) fn has_shape_or_canvas(s: &Session) -> Option<&'static str> {
    match selected(s) {
        Some((_, o)) if o.is_canvas() => None,
        _ => has_shape(s),
    }
}

pub(super) fn can_group(s: &Session) -> Option<&'static str> {
    if picked_objects(s).len() >= 2 { None } else { Some("select two or more pictures or shapes first (Shift+click)") }
}

pub(super) fn has_shape(s: &Session) -> Option<&'static str> {
    match selected(s) {
        Some((_, InlineObject::Shape { .. })) => None,
        _ => Some("select a shape first"),
    }
}

/// The selection when it is exactly one picture, shape or text box (its U+FFFC), rather than
/// text: what clicking an object selects.
pub fn object_selection(s: &Session) -> Option<(Pos, &InlineObject)> {
    let (a, b) = s.sel.ordered();
    if a.story != b.story || a.path != b.path || b.off != a.off + ew_doc::para::OBJ.len_utf8() {
        return None;
    }
    let o = s.doc.para_at(&a)?.object_at(a.off)?;
    o.is_drawing().then_some((a, o))
}

/// The first picture/shape in the selection, or just before a collapsed caret.
pub fn selected(s: &Session) -> Option<(Pos, InlineObject)> {
    selected_all(s, 1).into_iter().next()
}

/// The pictures and shapes in the selection (at most `max`), or the one just before a collapsed
/// caret.
pub fn selected_all(s: &Session, max: usize) -> Vec<(Pos, InlineObject)> {
    let mut out = Vec::new();
    let (a, b) = s.sel.ordered();
    let max = if a == b { 1 } else { max };
    let story = a.story;
    let paths = if a == b { vec![a.path.clone()] } else { s.doc.paths_between(&a, &b) };
    for path in paths {
        let Some(p) = s.doc.para(story, &path) else { continue };
        for off in p.object_offsets() {
            let inside = if a == b {
                off + ew_doc::para::OBJ.len_utf8() == a.off || off == a.off
            } else {
                (path != a.path || off >= a.off) && (path != b.path || off < b.off)
            };
            if !inside {
                continue;
            }
            if let Some(o) = p.object_at(off).filter(|o| o.is_drawing()) {
                out.push((Pos { story, path: path.clone(), off }, o.clone()));
                if out.len() >= max {
                    return out;
                }
            }
        }
    }
    out
}

/// Smallest width/height an object can be resized to, points (a text box keeps room for a line).
pub fn min_size(o: &InlineObject) -> f32 {
    if matches!(o, InlineObject::Shape { story: Some(_), .. }) { 18.0 } else { 4.0 }
}

/// Select the object whose character is at `pos`.
pub(super) fn select_object(s: &mut Session, pos: &Pos) {
    s.sel = Selection { anchor: pos.clone(), focus: Pos { off: pos.off + ew_doc::para::OBJ.len_utf8(), ..pos.clone() } };
}

pub(super) fn obj_size(o: &InlineObject) -> (f32, f32) {
    o.frame().map_or((0.0, 0.0), |(w, h, _)| (w, h))
}

/// Alt Text: the selected object's description, title and decorative mark, in one undo step.
pub(super) fn alt_text(s: &mut Session, v: &Value) -> CmdResult {
    let (text, title, decorative) = (p::str(v, "text"), p::str(v, "title"), p::bool(v, "decorative"));
    if text.is_none() && title.is_none() && decorative.is_none() {
        return Err(CmdError::Params("`text`, `title` or `decorative` is required".into()));
    }
    with_obj(s, |o| {
        if let Some(t) = text {
            o.set_alt_text(t);
        }
        if let Some(f) = o.float_mut() {
            if let Some(t) = title {
                f.alt.title = ew_doc::para::cap_alt(t);
            }
            if let Some(d) = decorative {
                f.alt.decorative = d;
            }
        }
    })
}

pub(super) fn with_obj(s: &mut Session, f: impl Fn(&mut InlineObject)) -> CmdResult {
    let (pos, _) = selected(s).ok_or_else(|| CmdError::Disabled("no picture or shape selected".into()))?;
    let o = edit_obj(s, &pos, f)?;
    Ok(json!({"object": serde_json::to_value(o).unwrap_or(Value::Null)}))
}

/// Change the object at `pos`; returns it afterwards.
pub(crate) fn edit_obj(s: &mut Session, pos: &Pos, f: impl Fn(&mut InlineObject)) -> Result<InlineObject, CmdError> {
    let para = s.doc.para_mut(pos.story, &pos.path)?;
    let o = para.object_at_mut(pos.off).ok_or_else(|| CmdError::Failed("object vanished".into()))?;
    f(o);
    let o = o.clone();
    para.touch();
    Ok(o)
}

pub(super) fn edit_float(s: &mut Session, pos: &Pos, f: impl Fn(&mut Float)) -> Result<InlineObject, CmdError> {
    edit_obj(s, pos, |o| {
        if let Some(float) = o.float_mut() {
            f(float);
        }
    })
}

pub(super) fn with_float(s: &mut Session, f: impl Fn(&mut Float)) -> CmdResult {
    with_obj(s, |o| {
        if let Some(float) = o.float_mut() {
            let was_inline = float.wrap == Wrap::Inline;
            f(float);
            // Word's distance from text for a newly wrapped object: 0.125" at the sides.
            if was_inline && float.wrap != Wrap::Inline && float.dist == 0.0 {
                float.dist = 9.0;
            }
        }
    })
}

/// The selected pictures, shapes, text boxes and groups: the one the selection holds, then
/// those added to it ([`Session::also_selected`]), each once, in the body.
pub fn picked_objects(s: &Session) -> Vec<Pos> {
    let Some((first, _)) = object_selection(s) else { return Vec::new() };
    let mut out = vec![first];
    for p in &s.also_selected {
        if !out.contains(p) && s.doc.para_at(p).and_then(|q| q.object_at(p.off)).is_some_and(InlineObject::is_drawing) {
            out.push(p.clone());
        }
    }
    out
}

/// The object a `select.addObject` item names: a position, or a Selection Pane index.
pub(super) fn object_ref(s: &Session, v: &Value) -> Result<Pos, CmdError> {
    let pos = match v.as_u64() {
        Some(n) => all_objects(s).into_iter().nth(usize::try_from(n).unwrap_or(usize::MAX)).map(|(p, _)| p),
        None => crate::cmd::parse_pos(v),
    };
    pos.filter(|p| movable_story(s, p.story) && s.doc.para_at(p).and_then(|q| q.object_at(p.off)).is_some_and(InlineObject::is_drawing))
        .ok_or_else(|| CmdError::Params("no picture or shape there".into()))
}

/// A group's members as it shows them in its frame `[x, y, w, h]`: each member's unturned frame
/// and the turn it is drawn with (its own inside the group's). The group's turn, about its
/// centre, moves each member's centre. Empty for anything but a group.
pub(super) fn shown_members(group: &InlineObject, [x, y, w, h]: [f32; 4]) -> Vec<([f32; 4], Spin, &InlineObject)> {
    let outer = group.frame().map(|(_, _, f)| f.spin()).unwrap_or_default();
    let [x, y, w, h] = [x, y, w, h].map(ew_geom::finite);
    let (gx, gy) = (x + w / 2.0, y + h / 2.0);
    group
        .group_rects(x, y, w, h)
        .into_iter()
        .map(|([mx, my, mw, mh], c)| {
            let own = c.frame().map(|(_, _, f)| f.spin()).unwrap_or_default();
            let (cx, cy) = outer.apply(gx, gy, mx + mw / 2.0, my + mh / 2.0);
            ([cx - mw / 2.0, cy - mh / 2.0, mw, mh], own.within(outer), c)
        })
        .collect()
}

pub(crate) fn all_objects(s: &Session) -> Vec<(Pos, InlineObject)> {
    let mut v = Vec::new();
    for path in s.doc.para_paths(StoryRef::Body) {
        let Some(p) = s.doc.para(StoryRef::Body, &path) else { continue };
        for off in p.object_offsets() {
            if let Some(o) = p.object_at(off).filter(|o| o.is_drawing()) {
                v.push((Pos { story: StoryRef::Body, path: path.clone(), off }, o.clone()));
            }
        }
    }
    v
}

pub(super) fn objects_list(s: &mut Session, _: &Value) -> CmdResult {
    Ok(Value::Array(
        all_objects(s)
            .into_iter()
            .enumerate()
            .map(|(i, (pos, o))| {
                let (kind, name) = match &o {
                    InlineObject::Image { alt, .. } => ("picture", if alt.is_empty() { format!("Picture {}", i + 1) } else { alt.clone() }),
                    InlineObject::Shape { kind, .. } => ("shape", format!("{kind:?} {}", i + 1)),
                    InlineObject::Graphic { graphic, .. } => ("graphic", format!("{:?} {}", graphic.kind, i + 1)),
                    InlineObject::Group { .. } => ("group", format!("Group {}", i + 1)),
                    _ => ("object", format!("Object {}", i + 1)),
                };
                let (hidden, z) = o.frame().map_or((false, 0), |(_, _, f)| (f.hidden, f.z));
                json!({"index": i, "kind": kind, "name": name, "pos": crate::cmd::pos_json(&pos), "size": obj_size(&o), "hidden": hidden,
                    "floating": o.is_floating(), "z": z})
            })
            .collect(),
    ))
}

/// `object.get` (docs/plans/engine/stage2.md G4): what the selected picture, shape, text box or group is and how it sits, for
/// the ribbon's values, the Format panes and the Layout dialog. Null with no object selected.
pub fn object_info(s: &Session) -> Value {
    use ew_doc::para::FloatAlign;
    // The selected object, else the text box the caret is in (Shape Format acts on it there, as in Word).
    let picked = selected(s).or_else(|| {
        let (pos, _) = super::shape::text_box_target(s)?;
        Some((pos.clone(), s.doc.para_at(&pos)?.object_at(pos.off)?.clone()))
    });
    let Some((pos, o)) = picked else { return Value::Null };
    let Some((w, h, f)) = o.frame() else { return Value::Null };
    let floating = f.wrap != Wrap::Inline;
    let align = |a: Option<FloatAlign>, hz: bool| a.map(|a| a.ooxml(hz));
    let mut out = json!({
        "type": serde_json::to_value(&o).ok().and_then(|v| v.get("type").cloned()).unwrap_or(Value::Null),
        "pos": crate::cmd::pos_json(&pos),
        "w": w, "h": h,
        "floating": floating,
        "wrap": f.wrap,
        "wrapText": f.wrap_text.ooxml(),
        "moveWithText": floating.then(|| super::moves_with_text(f)),
        "position": {"hRel": f.h_rel, "vRel": f.v_rel, "x": f.x, "y": f.y, "hAlign": align(f.h_align, true), "vAlign": align(f.v_align, false)},
        "dist": {"left": f.dist, "right": f.dist, "top": f.dist_top, "bottom": f.dist_bottom},
        "rotation": f.rot, "flipH": f.flip_h, "flipV": f.flip_v,
        "z": f.z, "hidden": f.hidden,
        "alt": {"text": o.alt_text(), "title": f.alt.title, "decorative": f.alt.decorative},
        "relSize": f.rel_w.is_some() || f.rel_h.is_some(),
        // EasyWriter engine-gaps-shapes: the Layout dialog's relative size and Layout in table cell.
        "relWidth": f.rel_w.map(|(a, k)| json!({"rel": a, "pct": k * 100.0})),
        "relHeight": f.rel_h.map(|(a, k)| json!({"rel": a, "pct": k * 100.0})),
        "layoutInCell": !f.outside_cell,
    });
    match &o {
        InlineObject::Image { media, crop, float: f, .. } => {
            let under = super::picture::source(s, media, f);
            let look = s.picture_looks.get(&under).filter(|l| s.doc.media.get(&under).is_some_and(|c| std::sync::Arc::ptr_eq(c, &l.drawn)));
            let original = super::picture::cropped_original_size(s, &o).map(|(w, h)| json!({"w": w, "h": h}));
            out["picture"] = json!({
                "crop": crop,
                "original": original,
                "effect": look.and_then(|l| l.effect.clone()),
                "style": look.and_then(|l| l.style.clone()),
                "border": look.and_then(|l| l.border).map(|(c, w)| json!({"color": c.hex(), "width": w})),
                "edited": s.originals.contains_key(media.as_str()) || f.layer().is_some() || !f.adjust().is_empty(),
                "link": f.link,
                // EasyWriter engine-pictures-2: its colour and corrections, and whether it is a vector graphic (SVG).
                "adjust": super::picture::adjust_json(f.adjust()),
                "svg": media.to_ascii_lowercase().ends_with(".svg"),
            });
            // EasyWriter engine-gaps-pictures: its outline, effects and the shape it is cropped to.
            if let (Some(pic), Value::Object(look)) = (out["picture"].as_object_mut(), super::picture_look::look_json(&o)) {
                pic.extend(look);
            }
        }
        InlineObject::Shape { kind, fill, stroke, stroke_width, effects, extra, story, .. } => {
            use ew_doc::fill::Fill;
            let fill_json = match fill {
                Some(Fill::Solid { color, transparency }) => json!({"color": color.hex(), "transparency": transparency}),
                // EasyWriter engine-gaps-shapes: a picture, texture or pattern as shape.fill takes it.
                Some(f @ (Fill::Picture(_) | Fill::Pattern(_))) => crate::cmd::shape_fill::params(Some(f)),
                Some(g) => json!({"gradient": g, "color": g.main_color().hex()}),
                None => Value::Null,
            };
            let pattern = match &extra.outline_fill {
                Some(Fill::Pattern(p)) => json!({"preset": p.preset, "fg": p.fg.hex(), "bg": p.bg.hex()}),
                _ => Value::Null,
            };
            let body = story.and_then(|id| s.doc.parts.get(&id)).map(|p| {
                let linked_from = s.doc.parts.iter().any(|(_, q)| q.body.next == *story);
                json!({"story": story, "dir": p.body.vert, "anchor": p.body.anchor, "insets": p.body.insets_pt(),
                    "autoFit": p.body.auto_fit, "linked": p.body.next.is_some(), "linkedFrom": linked_from})
            });
            out["shape"] = json!({
                "kind": kind,
                "preset": extra.preset.as_ref().map(|p| p.0.clone()),
                "fill": fill_json,
                "outline": {"color": stroke.map(|c| c.hex()), "width": stroke_width, "dash": extra.dash.ooxml(),
                    "arrows": {"start": extra.arrow_start, "end": extra.arrow_end}, "pattern": pattern},
                "effects": effects,
                "textBox": body,
            });
        }
        InlineObject::Graphic { graphic, .. } => {
            if let Some(spec) = graphic.smart_art.as_deref() {
                let mut shapes: Vec<Value> = Vec::new();
                for (i, b) in ew_docx::smart_art_boxes(spec, w, h) {
                    let mut rect = Vec::with_capacity(4);
                    for v in b {
                        rect.push(Value::from(f64::from(v)));
                    }
                    let mut shape = serde_json::Map::new();
                    shape.insert("item".to_string(), Value::from(i as u64));
                    shape.insert("rect".to_string(), Value::Array(rect));
                    shapes.push(Value::Object(shape));
                }
                let mut spec = serde_json::to_value(spec).unwrap_or(Value::Null);
                // The stored form keeps a look as its text; the pane draws the object it holds.
                if let Some(items) = spec["items"].as_array_mut() {
                    for it in items.iter_mut() {
                        if let Some(t) = it.get("look").and_then(Value::as_str) {
                            it["look"] = ew_doc::smart_art::ItemLook::parse(t).to_json();
                        }
                    }
                }
                let mut got = serde_json::Map::new();
                got.insert("spec".to_string(), spec);
                got.insert("shapes".to_string(), Value::Array(shapes));
                out["smartArt"] = Value::Object(got);
            }
        }
        InlineObject::Group { children, .. } => out["group"] = json!({"members": children.len(), "canvas": o.is_canvas()}),
        _ => {}
    }
    out
}

/// The commands of this file (docs/plans/engine/stage2.md, the Stage 2.0 scaffold: one owner per file).
pub(super) fn specs() -> Vec<super::CommandSpec> {
    use super::group::{add_object};
    use super::{CmdError, CommandSpec, Pos, Selection, p, sel_result};
    vec![
        CommandSpec::new("object.get", "Object Properties", "Shape Format", |s, _| Ok(object_info(s)))
            .params(r#"{} → {type, pos, w, h, floating, wrap, wrapText, moveWithText, position {hRel, vRel, x, y, hAlign, vAlign}, dist, rotation, flipH, flipV, z, hidden, alt, picture? {crop, original, effect, style, border, edited, link, adjust {brightness, contrast, sharpness, saturation, temperature, recolor, recolorColor, threshold, transparency, transparentColor, artistic}, svg, outline, fx, cropShape}, shape? {kind, fill, outline {color, width, dash, arrows}, effects, textBox}, group?} | null  (the selected picture, shape, text box or group)"#)
            .pure()
            .state(|s| (Value::Null, object_info(s))),
        CommandSpec::new("object.altText", "Alt Text", "Shape Format › Accessibility", alt_text)
            .params(r#"{"text"?: string, "title"?: string, "decorative"?: bool} (the selected picture, shape, text box, group or chart)"#)
            .when(has_object),
        CommandSpec::new("object.hidden", "Show or Hide Object", "Layout › Arrange › Selection Pane", |s, v| {
            let hidden = p::bool(v, "hidden").ok_or_else(|| CmdError::Params("`hidden` is required".into()))?;
            let targets: Vec<Pos> = match v.get("index") {
                Some(i) => vec![object_ref(s, i)?],
                None => all_objects(s).into_iter().filter(|(_, o)| o.is_floating()).map(|(p, _)| p).collect(),
            };
            for pos in &targets {
                edit_float(s, pos, |f| f.hidden = hidden)?;
            }
            Ok(json!({"changed": targets.len()}))
        })
        .params(r#"{"hidden": bool, "index"?: n}  (the Selection Pane's eye on object n of its list; without index every floating object: Show All, Hide All; one undo step)"#),
        CommandSpec::new("select.addObject", "Add Object to Selection", "Home › Editing › Select", add_object)
            .params(r#"{"pos"?: Pos, "index"?: n, "objects"?: [Pos | n]}  (n: its Selection Pane index; with no object selected yet, the first one becomes the selection)"#)
            .pure(),
        CommandSpec::new("select.objects", "Select Objects", "Home › Editing › Select", |s, v| {
            let n = p::u64(v, "index").unwrap_or(0) as usize;
            let list = all_objects(s);
            let (pos, _) = list.into_iter().nth(n).ok_or_else(|| CmdError::Failed("no such object".into()))?;
            let end = Pos { off: pos.off + ew_doc::para::OBJ.len_utf8(), ..pos.clone() };
            s.sel = Selection { anchor: pos, focus: end };
            sel_result(s)
        })
        .params(r#"{"index"?: n}"#)
        .pure(),
    ]
}
