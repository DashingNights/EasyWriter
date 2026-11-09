//! EasyWriter engine-gaps-pictures (docs/plans/engine/stage2b.md): a picture's outline, effects and the shape it is cropped
//! to, kept in the document as Word keeps them (`pic:spPr`) and drawn by the renderer: Picture Border with its dashes and
//! sketched looks (G20), Picture Effects (G14) and Crop to Shape. The Format Picture pane writes the same command.

use serde::de::DeserializeOwned;
use ew_doc::effects::ShapeEffects;
use ew_doc::line_dash::{LineDash, Outline, Sketch};
use ew_doc::para::CropShape;

use super::select::{edit_obj, has_picture, selected};
use super::{CmdError, CmdResult, CommandSpec, Float, InlineObject, Rgb, Session, Value, json, p};

/// A change named `key` in `v`: absent (leave it), null (remove it) or a value read as `T`.
fn change<T: DeserializeOwned>(v: &Value, key: &str) -> Result<Option<Option<T>>, CmdError> {
    match v.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(x) => serde_json::from_value(x.clone()).map(|t| Some(Some(t))).map_err(|e| CmdError::Params(format!("`{key}`: {e}"))),
    }
}

/// The outline `v` asks for over `now`: each field it gives replaces that one, so a colour keeps the width and a dash keeps
/// the colour (a weight, dash or sketch on a picture with no outline gets Word's black).
fn outline_of(v: &Value, now: Option<&Outline>) -> Result<Outline, CmdError> {
    let mut o = now.cloned().unwrap_or_default();
    if let Some(c) = p::str(v, "color") {
        o.color = Rgb::parse(c).ok_or_else(|| CmdError::Params("`outline.color`: RRGGBB".into()))?;
    }
    if let Some(w) = p::f32(v, "width") {
        o.width = w;
    }
    if let Some(d) = p::str(v, "dash") {
        o.dash = LineDash::from_ooxml(d);
    }
    if let Some(k) = p::str(v, "sketch") {
        o.sketch = match k {
            "none" => Sketch::None,
            "curved" => Sketch::Curved,
            "freehand" => Sketch::Freehand,
            "scribble" => Sketch::Scribble,
            _ => return Err(CmdError::Params(format!("`outline.sketch`: none, curved, freehand or scribble, not `{k}`"))),
        };
    }
    o.width = o.width();
    Ok(o)
}

/// Room the outline and effects take round a `w` × `h` picture (`wp:effectExtent`): half the outline outside the frame,
/// and the effects' reach.
pub(super) fn look_extent(f: &Float, h: f32) -> [f32; 4] {
    let half = f.outline.as_ref().map_or(0.0, |o| o.width() / 2.0);
    f.fx.extent_for(h).map(|v| v.max(half))
}

/// `picture.format`: the selected picture's outline and effects, each one given replaced, in one undo step.
fn format(s: &mut Session, v: &Value) -> CmdResult {
    let (pos, o) = selected(s).ok_or_else(|| CmdError::Disabled("no picture selected".into()))?;
    let InlineObject::Image { float, h, .. } = &o else { return Err(CmdError::Disabled("not a picture".into())) };
    let outline = match v.get("outline") {
        None => float.outline.clone(),
        Some(Value::Null) => None,
        Some(x @ Value::Object(_)) => Some(outline_of(x, float.outline.as_ref())?),
        Some(_) => return Err(CmdError::Params("`outline`: an object or null".into())),
    };
    let mut fx = if p::bool(v, "clear").unwrap_or(false) { ShapeEffects::default() } else { float.fx };
    if let Some(x) = change(v, "shadow")? {
        fx.shadow = x;
    }
    if let Some(x) = change(v, "innerShadow")? {
        fx.inner_shadow = x;
    }
    // One shadow at a time, as Word's gallery has it: an outer shadow replaces an inner one and the other way round.
    if v.get("shadow").is_some_and(|x| !x.is_null()) && v.get("innerShadow").is_none() {
        fx.inner_shadow = None;
    }
    if v.get("innerShadow").is_some_and(|x| !x.is_null()) && v.get("shadow").is_none() {
        fx.shadow = None;
    }
    if let Some(x) = change(v, "reflection")? {
        fx.reflection = x;
    }
    if let Some(x) = change(v, "glow")? {
        fx.glow = x;
    }
    if let Some(x) = change::<f32>(v, "softEdge")? {
        fx.soft_edge = x;
    }
    if let Some(x) = change(v, "bevel")? {
        fx.bevel = x;
    }
    if let Some(x) = change(v, "rotation")? {
        fx.rotation = x;
    }
    let fx = fx.sanitized();
    let h = *h;
    let o = edit_obj(s, &pos, |o| {
        if let Some(f) = o.float_mut() {
            f.outline = outline.clone();
            f.fx = fx;
            f.effect = look_extent(f, h);
        }
    })?;
    Ok(json!({"picture": look_json(&o)}))
}

/// The selected picture's outline, effects and the shape it is cropped to, as `object.get` reports them.
pub(super) fn look_json(o: &InlineObject) -> Value {
    let Some((_, _, f)) = o.frame() else { return Value::Null };
    json!({
        "outline": f.outline.as_ref().map(|l| json!({"color": l.color.hex(), "width": l.width(), "dash": l.dash.ooxml().unwrap_or("solid"),
            "sketch": serde_json::to_value(l.sketch).unwrap_or(Value::Null)})),
        "fx": serde_json::to_value(f.fx).unwrap_or(Value::Null),
        "cropShape": f.crop_shape.as_ref().map(|c| c.preset.clone()),
    })
}

/// Longest preset name Crop to Shape takes.
const MAX_PRESET: usize = 64;

/// `picture.cropToShape`: the selected picture cropped to DrawingML preset `preset` (`rect` for none), its outline
/// following the shape.
fn crop_to_shape(s: &mut Session, v: &Value) -> CmdResult {
    let preset = p::req_str(v, "preset")?;
    let (pos, o) = selected(s).ok_or_else(|| CmdError::Disabled("no picture selected".into()))?;
    let InlineObject::Image { w, h, .. } = o else { return Err(CmdError::Disabled("not a picture".into())) };
    let shape = match preset {
        "rect" | "" => None,
        p if p.len() <= MAX_PRESET => {
            let outline = ew_docx::preset_outline(p, w, h).ok_or_else(|| CmdError::Params(format!("no shape `{p}`")))?;
            Some(std::sync::Arc::new(CropShape { preset: p.to_string(), adj: Vec::new(), outline }))
        }
        _ => return Err(CmdError::Params("`preset`: a DrawingML preset name".into())),
    };
    let o = edit_obj(s, &pos, |o| {
        if let Some(f) = o.float_mut() {
            f.crop_shape = shape.clone();
        }
    })?;
    Ok(json!({"picture": look_json(&o)}))
}

/// EasyWriter engine-pictures-2, G23 Convert to Shape: the selected SVG graphic as the shapes it draws, freeforms with its
/// fills and outlines grouped in its place and wrap, as Word converts one. Its text is left out (Word makes text boxes).
fn convert_to_shape(s: &mut Session, _: &Value) -> CmdResult {
    use ew_doc::fill::Fill;
    use ew_doc::freeform::{FreePath, Freeform};
    use ew_doc::para::{GroupChild, MAX_GROUP_CHILDREN, ShapeKind};
    let (pos, o) = selected(s).ok_or_else(|| CmdError::Disabled("no picture selected".into()))?;
    let InlineObject::Image { media, w, h, float, .. } = &o else { return Err(CmdError::Disabled("not a picture".into())) };
    let not_svg = || CmdError::Disabled("only an SVG graphic converts to shapes".into());
    let bytes = s.doc.media.get(media.as_str()).cloned().ok_or_else(not_svg)?;
    let (pw, ph, shapes) = ew_scene::svg_shapes(&bytes).ok_or_else(not_svg)?;
    if shapes.is_empty() {
        return Err(CmdError::Failed("the graphic draws no shapes".into()));
    }
    // The graphic's pixels to the frame's points.
    let (kx, ky) = (*w / pw.max(1e-3), *h / ph.max(1e-3));
    let rgb = |c: [u8; 4]| Rgb(c[0], c[1], c[2]);
    let mut children = Vec::new();
    for sh in shapes.iter().take(MAX_GROUP_CHILDREN) {
        let pts = sh.polys.iter().flat_map(|(p, _)| p.iter());
        let (x0, y0, x1, y1) = pts.fold((f32::MAX, f32::MAX, f32::MIN, f32::MIN), |(a, b, c, d), [x, y]| (a.min(*x), b.min(*y), c.max(*x), d.max(*y)));
        let (fw, fh) = (((x1 - x0) * kx).max(0.1), ((y1 - y0) * ky).max(0.1));
        let paths = sh.polys.iter().map(|(p, closed)| FreePath { pts: p.iter().map(|[x, y]| [(x - x0) * kx, (y - y0) * ky]).collect(), closed: *closed }).collect();
        let freeform = Freeform { w: fw, h: fh, paths, ..Default::default() }.sanitized();
        let shape = InlineObject::Shape {
            kind: ShapeKind::Freeform,
            w: fw,
            h: fh,
            fill: sh.fill.map(|c| Fill::Solid { color: rgb(c), transparency: (1.0 - f32::from(c[3]) / 255.0) * 100.0 }),
            stroke: sh.stroke.map(|(c, _)| rgb(c)),
            stroke_width: sh.stroke.map_or(0.0, |(_, sw)| sw * (kx + ky) / 2.0),
            float: Float::default(),
            story: None,
            freeform: Some(std::sync::Arc::new(freeform)),
            effects: Default::default(),
            extra: Default::default(),
        };
        children.push(GroupChild { x: x0 * kx, y: y0 * ky, obj: shape });
    }
    // The group keeps the picture's place, wrap, turn and id; what belongs to a picture alone goes with it.
    let group_float = Float {
        crop_shape: None,
        outline: None,
        fx: Default::default(),
        link: None,
        r#box: None,
        ..float.place.clone()
    };
    let group = InlineObject::Group { w: *w, h: *h, float: group_float, ch_w: *w, ch_h: *h, children, canvas: None };
    edit_obj(s, &pos, |o| *o = group.clone())?;
    Ok(json!({"shapes": shapes.len().min(MAX_GROUP_CHILDREN)}))
}

/// The commands of this file.
pub(super) fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("graphic.convertToShape", "Convert to Shape", "Graphics Format › Change", convert_to_shape)
            .params(r#"{} → {shapes: n} (the selected SVG graphic becomes a group of freeform shapes in its place, one undo step)"#)
            .when(has_picture),
        CommandSpec::new("picture.format", "Format Picture", "Picture Format › Picture Styles", format)
            .params(
                r#"{"outline"?: {"color"?: "RRGGBB", "width"?: pt, "dash"?: "solid|sysDot|sysDash|dash|dashDot|lgDash|lgDashDot|lgDashDotDot", "sketch"?: "none|curved|freehand|scribble"} | null, "shadow"?: {color, transparency %, blur pt, distance pt, angle °} | null, "innerShadow"?: same | null, "reflection"?: {size %, distance pt, transparency %, blur pt} | null, "glow"?: {color, size pt, transparency %} | null, "softEdge"?: pt | null, "bevel"?: {kind, width pt, height pt} | null, "rotation"?: {x, y, z °, fov ° (0 parallel)} | null, "clear"?: bool (every effect off first: a preset)} → {picture: {outline, fx, cropShape}} (the outline's fields given replace its own; each effect given replaces that effect; null removes it; an outer and an inner shadow replace each other)"#,
            )
            .when(has_picture),
        CommandSpec::new("picture.cropToShape", "Crop to Shape", "Picture Format › Size › Crop", crop_to_shape)
            .params(r#"{"preset": DrawingML preset name ("rect" for none)} → {picture: {outline, fx, cropShape}}"#)
            .when(has_picture),
    ]
}
