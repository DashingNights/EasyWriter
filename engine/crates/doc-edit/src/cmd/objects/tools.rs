//! EasyWriter engine-page-tools: what the page area's pointer tools ask of the objects (docs/plans/engine/stage2b.md, the
//! Gap packages; viewport-design.md section 3). The object under a page point (Select Objects, crop and Set Transparent
//! Color's click), Distribute (G12) across several selected objects, the drawing grid's spacing (G49), a shape's points
//! (Edit Points, G40) and an object's wrap points (Edit Wrap Points). Every command that changes the document is one undo
//! step; the queries are pure.

use super::arrange::MAX_OFFSET;
use super::select::{edit_float, edit_obj, picked_objects, select_object, selected};
use super::{CmdError, CmdResult, InlineObject, Session, Value, Wrap, json, p};
use ew_doc::freeform::{EditNode, EditPath};
use ew_doc::para::{Anchor, ShapeKind};

/// How far (points) outside an object's frame a press still takes it, as the editor's object hit.
const EDGE: f32 = 2.0;
/// Most points a path of Edit Points or a wrap polygon takes from a command.
const MAX_EDIT_POINTS: usize = 4096;

fn page_of(v: &Value) -> Result<usize, CmdError> {
    p::u64(v, "page").map(|n| usize::try_from(n).unwrap_or(usize::MAX)).ok_or_else(|| CmdError::Params("`page` (0-based) is required".into()))
}

/// `object.at`: the drawing a press at page point (x, y) takes, topmost first (a text box inside too), or null.
fn object_at(s: &mut Session, v: &Value) -> CmdResult {
    let page = page_of(v)?;
    let (x, y) = (p::req_f32(v, "x")?, p::req_f32(v, "y")?);
    let Some(h) = s.layout().drawing_at(page, x, y, EDGE) else { return Ok(Value::Null) };
    let pos = h.pos();
    let kind = s.doc.para_at(&pos).and_then(|q| q.object_at(pos.off)).map(|o| match o {
        InlineObject::Image { .. } => "picture",
        InlineObject::Shape { story: Some(_), .. } => "textbox",
        InlineObject::Shape { .. } => "shape",
        InlineObject::Group { .. } => "group",
        _ => "graphic",
    });
    Ok(json!({"pos": crate::cmd::pos_json(&pos), "kind": kind, "page": h.page, "x": h.rect.x, "y": h.rect.y, "w": h.rect.w, "h": h.rect.h,
        "rotation": h.spin.deg, "floating": h.floating()}))
}

/// `arrange.distribute`: equal gaps between the selected floating objects along one axis. To the selection, the outer two
/// stay and the others spread between them (three or more); to the page or its margins, the first and last go to its edges
/// and one alone is centred, as Word does with Align to Page or Align to Margin on.
fn distribute(s: &mut Session, v: &Value) -> CmdResult {
    let across = match p::str(v, "axis").unwrap_or("horizontal") {
        "horizontal" | "h" => true,
        "vertical" | "v" => false,
        other => return Err(CmdError::Params(format!("unknown `axis` `{other}`"))),
    };
    let to = p::str(v, "to").unwrap_or("selected");
    let picks = picked_objects(s);
    let layout = s.layout();
    let mut items = Vec::new();
    for pos in &picks {
        let hit = layout.object(pos, s.page_hint).ok_or_else(|| CmdError::Failed("an object isn't laid out".into()))?;
        if !hit.floating() {
            return Err(CmdError::Disabled("objects in line with text can't be distributed".into()));
        }
        items.push((pos.clone(), hit.page, hit.bounds()));
    }
    let Some(page) = items.first().map(|i| i.1) else { return Err(CmdError::Disabled("select the objects to distribute first".into())) };
    if items.iter().any(|i| i.1 != page) {
        return Err(CmdError::Disabled("the objects have to be on one page".into()));
    }
    let start = |r: &ew_geom::Rect| if across { r.x } else { r.y };
    let size = |r: &ew_geom::Rect| if across { r.w } else { r.h };
    let pg = layout.pages.get(page).ok_or_else(|| CmdError::Failed("the page isn't laid out".into()))?;
    let (a, b) = match to {
        "selected" => {
            if items.len() < 3 {
                return Err(CmdError::Disabled("select three or more objects to distribute".into()));
            }
            let a = items.iter().map(|i| start(&i.2)).fold(f32::INFINITY, f32::min);
            let b = items.iter().map(|i| start(&i.2) + size(&i.2)).fold(f32::NEG_INFINITY, f32::max);
            (a, b)
        }
        "page" => (0.0, if across { pg.w } else { pg.h }),
        "margin" => if across { (pg.body.x, pg.body.right()) } else { (pg.body.y, pg.body.bottom()) },
        other => return Err(CmdError::Params(format!("unknown `to` `{other}`"))),
    };
    items.sort_by(|x, y| start(&x.2).total_cmp(&start(&y.2)));
    let n = items.len();
    let total: f32 = items.iter().map(|i| size(&i.2)).sum();
    let targets: Vec<f32> = if n == 1 {
        vec![a + (b - a - total) / 2.0]
    } else {
        let gap = (b - a - total) / (n - 1) as f32;
        let mut at = a;
        items.iter().map(|i| {
            let t = at;
            at += size(&i.2) + gap;
            t
        }).collect()
    };
    // Each object moves by what its laid-out place still lacks: moving one can reflow the text another is anchored in.
    for ((pos, _, _), target) in items.iter().zip(targets) {
        let hit = s.layout().object(pos, page).ok_or_else(|| CmdError::Failed("an object isn't laid out".into()))?;
        let r = hit.bounds();
        let d = target - start(&r);
        let (ox, oy) = (hit.rect.x - hit.origin.x, hit.rect.y - hit.origin.y);
        edit_float(s, pos, |f| {
            if across {
                if f.h_align.take().is_some() {
                    f.h_rel = Anchor::Column;
                    f.x = ox;
                }
                f.x = (f.x + d).clamp(-MAX_OFFSET, MAX_OFFSET);
            } else {
                if f.v_align.take().is_some() {
                    f.v_rel = Anchor::Paragraph;
                    f.y = oy;
                }
                f.y = (f.y + d).clamp(-MAX_OFFSET, MAX_OFFSET);
            }
        })?;
        s.touch();
    }
    Ok(json!({"distributed": n}))
}

/// `layout.drawingGrid`: the drawing grid's spacing, across and down (Grid and Guides), in points, and (engine-tools-2) its
/// origin and the lines it shows. Left out stays.
fn drawing_grid(s: &mut Session, v: &Value) -> CmdResult {
    let fit = |x: f32| x.clamp(0.36, 1584.0);
    let len = |k: &str| p::f32(v, k).filter(|x| x.is_finite()).map(|x| x.clamp(0.0, 1584.0));
    let every = |k: &str| p::u64(v, k).map(|n| n.min(99) as u32);
    let st = &mut s.doc.settings;
    if let Some(h) = p::f32(v, "h").filter(|x| x.is_finite()) {
        st.grid_h = fit(h);
    }
    if let Some(g) = p::f32(v, "v").filter(|x| x.is_finite()) {
        st.grid_v = fit(g);
    }
    let mut g = st.grid_show.unwrap_or_default();
    g.use_margins = p::bool(v, "useMargins").unwrap_or(g.use_margins);
    g.x = len("x").unwrap_or(g.x);
    g.y = len("y").unwrap_or(g.y);
    g.every_h = every("everyH").unwrap_or(g.every_h);
    g.every_v = every("everyV").unwrap_or(g.every_v);
    st.grid_show = (g != ew_doc::GridShow::default()).then_some(g);
    Ok(grid_json(st))
}

fn grid_json(st: &ew_doc::Settings) -> Value {
    let g = st.grid_show.unwrap_or_default();
    json!({"h": st.grid_h, "v": st.grid_v, "useMargins": g.use_margins, "x": g.x, "y": g.y, "everyH": g.every_h, "everyV": g.every_v})
}

/// A list of [x, y] pairs from `v` (at most MAX_EDIT_POINTS, finite only).
fn points_of(v: &Value) -> Vec<[f32; 2]> {
    v.as_array()
        .map(|a| {
            a.iter()
                .take(MAX_EDIT_POINTS)
                .filter_map(|q| Some([q.get(0)?.as_f64()? as f32, q.get(1)?.as_f64()? as f32]))
                .filter(|[x, y]| x.is_finite() && y.is_finite())
                .collect()
        })
        .unwrap_or_default()
}

/// The selected shape's outline as paths of points in its frame (points across `w` × `h`): a freeform's or a preset's own
/// paths, a basic shape's outline, or its rectangle.
fn shape_paths(o: &InlineObject) -> Option<(f32, f32, Vec<(Vec<[f32; 2]>, bool)>)> {
    let InlineObject::Shape { kind, w, h, freeform, extra, .. } = o else { return None };
    if kind.is_open() && freeform.is_none() {
        return Some((*w, *h, vec![(vec![[0.0, 0.0], [*w, *h]], false)]));
    }
    if let Some(f) = freeform {
        return Some((*w, *h, f.placed(0.0, 0.0, *w, *h)));
    }
    let unit = ew_doc::wrap::shape_outline(*kind, *w, *h, extra.corner).unwrap_or_else(|| vec![(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]);
    Some((*w, *h, vec![(unit.iter().map(|(x, y)| [x * w, y * h]).collect(), true)]))
}

/// The selected shape's Edit Points paths (engine-tools-2) in points across its frame, when Edit Points left them and they
/// still draw its freeform; else None (its outline's points are its corners).
fn edit_paths(o: &InlineObject) -> Option<Vec<EditPath>> {
    let InlineObject::Shape { w, h, freeform: Some(f), extra, .. } = o else { return None };
    let same = |a: &[[f32; 2]], b: &[[f32; 2]]| a.len() == b.len() && a.iter().zip(b).all(|(p, q)| (p[0] - q[0]).abs() < 0.01 && (p[1] - q[1]).abs() < 0.01);
    let fresh = extra.edit_paths.len() == f.paths.len() && extra.edit_paths.iter().zip(&f.paths).all(|(e, q)| same(&e.flatten().pts, &q.pts));
    if !fresh || f.paths.is_empty() {
        return None;
    }
    let (sx, sy) = (if f.w > 0.0 { w / f.w } else { 1.0 }, if f.h > 0.0 { h / f.h } else { 1.0 });
    let at = |p: [f32; 2]| [p[0] * sx, p[1] * sy];
    Some(extra.edit_paths.iter().map(|e| EditPath {
        nodes: e.nodes.iter().map(|n| EditNode { at: at(n.at), c_in: n.c_in.map(at), c_out: n.c_out.map(at), kind: n.kind }).collect(),
        closed: e.closed,
    }).collect())
}

/// `shape.points`: the selected shape's points for Edit Points: each path's polyline, and its points and curve handles
/// (`nodes`) when Edit Points made it.
fn shape_points(s: &mut Session, _: &Value) -> CmdResult {
    let (_, o) = selected(s).ok_or_else(|| CmdError::Disabled("select a shape first".into()))?;
    let (w, h, paths) = shape_paths(&o).ok_or_else(|| CmdError::Disabled("select a shape first".into()))?;
    let nodes = edit_paths(&o);
    let out: Vec<Value> = paths
        .into_iter()
        .enumerate()
        .map(|(i, (pts, closed))| {
            let mut q = json!({"pts": pts, "closed": closed});
            if let Some(e) = nodes.as_ref().and_then(|n| n.get(i)) {
                q["nodes"] = Value::Array(e.nodes.iter().map(EditNode::to_json).collect());
            }
            q
        })
        .collect();
    Ok(json!({"w": w, "h": h, "paths": out}))
}

/// Edit Points' nodes of one path from a command: {at, cIn?, cOut?, kind?} with finite points, at most MAX_EDIT_POINTS.
fn nodes_of(v: &Value) -> Result<Vec<EditNode>, CmdError> {
    let bad = || CmdError::Params("`nodes` is [{at: [x, y], cIn?, cOut?, kind?}]".into());
    v.as_array().ok_or_else(bad)?.iter().take(MAX_EDIT_POINTS).map(|n| EditNode::from_json(n).ok_or_else(bad)).collect()
}

/// `shape.setPoints`: the selected shape drawn through `paths` (points in its frame), as Edit Points leaves it: a freeform
/// keeping its fill, outline, effects and place (a preset is no longer written as its preset). A path given as `nodes`
/// (engine-tools-2: points with curve handles) draws their curves, and Edit Points shows those nodes again.
// ponytail: a saved .docx carries the flattened polyline (a:lnTo), so Word shows its many points where Edit Points made a
// curve; write a:cubicBezTo from `extra.edit_paths` in the docx writer when a round trip to Word needs the curves.
fn set_points(s: &mut Session, v: &Value) -> CmdResult {
    let (pos, o) = selected(s).ok_or_else(|| CmdError::Disabled("select a shape first".into()))?;
    let InlineObject::Shape { w, h, freeform, .. } = &o else { return Err(CmdError::Disabled("select a shape first".into())) };
    let (w, h) = (*w, *h);
    let mut edits = Vec::new();
    let mut curved = false;
    for q in v.get("paths").and_then(Value::as_array).into_iter().flatten().take(ew_doc::freeform::MAX_PATHS) {
        let closed = p::bool(q, "closed").unwrap_or(true);
        let nodes = match q.get("nodes") {
            Some(n) if !n.is_null() => {
                curved = true;
                nodes_of(n)?
            }
            _ => points_of(q.get("pts").unwrap_or(&Value::Null)).into_iter().map(|at| EditNode { at, ..Default::default() }).collect(),
        };
        edits.push(EditPath { nodes, closed });
    }
    let paths: Vec<_> = edits.iter().map(EditPath::flatten).collect();
    if paths.iter().all(|q| q.pts.len() < 2) {
        return Err(CmdError::Params("`paths` needs a path of two or more points".into()));
    }
    if paths.iter().any(|q| q.pts.len() > ew_doc::freeform::MAX_POINTS) {
        return Err(CmdError::Params("too many points or curves in one path".into()));
    }
    let old = freeform.as_deref().cloned().unwrap_or_default();
    let geometry = ew_doc::freeform::Freeform { w, h, paths, alpha: if old.paths.is_empty() { 1.0 } else { old.alpha }, ink: old.ink, order: old.order }.sanitized();
    // Kept only beside the paths they drew: sanitizing drops an empty path, which would pair the rest wrongly.
    edits.retain(|e| !e.nodes.is_empty());
    let edits = if curved && edits.len() == geometry.paths.len() { edits } else { Vec::new() };
    edit_obj(s, &pos, |o| {
        if let InlineObject::Shape { kind, freeform, extra, .. } = o {
            if !kind.is_open() || freeform.is_some() {
                *kind = ShapeKind::Freeform;
            }
            *freeform = Some(std::sync::Arc::new(geometry.clone()));
            extra.preset = None;
            extra.edit_paths = edits.clone();
        }
    })?;
    select_object(s, &pos);
    Ok(json!({"paths": geometry.paths.len()}))
}

/// The selected object's wrap outline in unit coordinates: its wrap polygon, a shape's outline, or its rectangle.
fn wrap_outline(o: &InlineObject) -> (bool, Vec<(f32, f32)>) {
    let rect = || vec![(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
    let Some((w, h, float)) = o.frame() else { return (false, rect()) };
    if let Some(p) = &float.wrap_polygon {
        return (p.edited, p.unit());
    }
    let pts = match o {
        InlineObject::Shape { freeform: Some(f), .. } if !f.paths.is_empty() => {
            let (sw, sh) = (if f.w > 0.0 { f.w } else { w.max(1.0) }, if f.h > 0.0 { f.h } else { h.max(1.0) });
            f.paths.iter().max_by_key(|q| q.pts.len()).map(|q| q.pts.iter().map(|[x, y]| (x / sw, y / sh)).collect()).unwrap_or_else(rect)
        }
        InlineObject::Shape { kind, extra, .. } => ew_doc::wrap::shape_outline(*kind, w, h, extra.corner).unwrap_or_else(rect),
        _ => rect(),
    };
    (false, pts)
}

/// `arrange.wrapPoints`: the selected floating object's wrap points (unit coordinates across its frame).
fn wrap_points(s: &mut Session, _: &Value) -> CmdResult {
    let (_, o) = selected(s).ok_or_else(|| CmdError::Disabled("select a picture or shape first".into()))?;
    let (edited, pts) = wrap_outline(&o);
    let wrap = o.frame().map(|(_, _, f)| f.wrap);
    Ok(json!({"points": pts.iter().map(|(x, y)| [*x, *y]).collect::<Vec<_>>(), "edited": edited, "wrap": wrap}))
}

/// `arrange.setWrapPoints`: the selected object's wrap polygon, edited by hand; wrapping becomes Tight unless it is Tight or
/// Through already, as Edit Wrap Points does in Word.
fn set_wrap_points(s: &mut Session, v: &Value) -> CmdResult {
    let (pos, o) = selected(s).ok_or_else(|| CmdError::Disabled("select a picture or shape first".into()))?;
    if !o.is_floating() {
        return Err(CmdError::Disabled("wrap points need a floating object".into()));
    }
    let pts: Vec<(f32, f32)> = points_of(v.get("points").unwrap_or(&Value::Null)).into_iter().map(|[x, y]| (x, y)).collect();
    let poly = ew_doc::wrap::WrapPolygon::from_unit(true, &pts).ok_or_else(|| CmdError::Params("`points` needs three or more points".into()))?;
    let poly = std::sync::Arc::new(poly);
    edit_float(s, &pos, |f| {
        f.wrap_polygon = Some(poly.clone());
        if !matches!(f.wrap, Wrap::Tight | Wrap::Through) {
            f.wrap = Wrap::Tight;
        }
    })?;
    select_object(s, &pos);
    Ok(json!({"points": pts.len()}))
}

fn has_shape(s: &Session) -> Option<&'static str> {
    match selected(s) {
        Some((_, InlineObject::Shape { story: None, .. })) => None,
        _ => Some("select a shape first"),
    }
}

fn has_floating(s: &Session) -> Option<&'static str> {
    match selected(s) {
        Some((_, o)) if o.is_floating() => None,
        _ => Some("select a floating picture or shape first"),
    }
}

pub(super) fn specs() -> Vec<super::CommandSpec> {
    use super::CommandSpec;
    vec![
        CommandSpec::new("object.at", "Object at a Point", "Home › Editing › Select", object_at)
            .params(r#"{"page": n, "x": pt, "y": pt} → {pos, kind, page, x, y, w, h, rotation, floating} | null  (the drawing a press there takes, topmost first)"#)
            .pure(),
        CommandSpec::new("layout.page", "Page Area", "View › Show", |s, v| {
            let page = page_of(v)?;
            let l = s.layout();
            let Some(pg) = l.pages.get(page) else { return Ok(Value::Null) };
            Ok(json!({"w": pg.w, "h": pg.h, "body": {"x": pg.body.x, "y": pg.body.y, "w": pg.body.w, "h": pg.body.h}}))
        })
        .params(r#"{"page": n} → {w, h, body: {x, y, w, h}} | null  (the page and its text area, in points: the drawing grid and the rulers draw from it)"#)
        .pure(),
        CommandSpec::new("arrange.distribute", "Distribute", "Layout › Arrange › Align", distribute)
            .params(r#"{"axis": "horizontal|vertical", "to"?: "selected|page|margin"}  (equal gaps between the selected floating objects of one page: between the outer two, or across the page or its margins; one undo step)"#)
            .when(|s| if picked_objects(s).is_empty() { Some("select the objects to distribute first") } else { None }),
        CommandSpec::new("layout.drawingGrid", "Grid Settings", "Layout › Arrange › Align", drawing_grid)
            .params(r#"{"h"?: pt, "v"?: pt, "useMargins"?: bool, "x"?: pt, "y"?: pt, "everyH"?: n, "everyV"?: n}  (the drawing grid's spacing across and down, 0.36 to 1584 pt; its origin from the margins or at (x, y) from the page's corner; a horizontal line every everyH spacings and a vertical one every everyV, 0 for none; one undo step) → {h, v, useMargins, x, y, everyH, everyV}"#)
            .state(|s| (Value::Null, grid_json(&s.doc.settings))),
        CommandSpec::new("shape.points", "Shape Points", "Shape Format › Insert Shapes › Edit Shape", shape_points)
            .params(r#"{} → {w, h, paths: [{pts: [[x, y]], closed, nodes?: [{at, cIn?, cOut?, kind}]}]}  (the selected shape's outline in points across its frame; nodes: its points and curve handles as Edit Points left them)"#)
            .pure()
            .when(has_shape),
        CommandSpec::new("shape.setPoints", "Edit Points", "Shape Format › Insert Shapes › Edit Shape", set_points)
            .params(r#"{"paths": [{"pts": [[x, y], …] (points across the frame) | "nodes": [{"at": [x, y], "cIn"?: [x, y], "cOut"?: [x, y], "kind"?: "corner|smooth|straight|auto"}], "closed"?: bool}]}  (the shape becomes a freeform through them, a node's handles drawing a cubic curve to its neighbour; one undo step)"#)
            .when(has_shape),
        CommandSpec::new("arrange.wrapPoints", "Wrap Points", "Layout › Arrange › Wrap Text", wrap_points)
            .params(r#"{} → {points: [[x, y]] (0..1 across the frame), edited, wrap}"#)
            .pure()
            .when(has_floating),
        CommandSpec::new("arrange.setWrapPoints", "Edit Wrap Points", "Layout › Arrange › Wrap Text", set_wrap_points)
            .params(r#"{"points": [[x, y], …] (0..1 across the frame, three or more)}  (wrapping becomes Tight unless Tight or Through; one undo step)"#)
            .when(has_floating),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Session;
    use ew_doc::Pos;

    /// A session with three floating rectangles 40 pt wide on page 1 at x 100, 160 and 400, all three selected.
    fn three() -> (Session, Vec<Pos>) {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("text.insert", &json!({"text": "Some text to anchor the shapes in."})).unwrap();
        for x in [100.0, 160.0, 400.0] {
            s.run("insert.shape", &json!({"kind": "rectangle", "width": 40, "height": 30})).unwrap();
            s.run("arrange.bounds", &json!({"page": 0, "x": x, "y": 300})).unwrap();
            s.run("select.collapse", &json!({"end": true})).unwrap();
        }
        // Earlier objects' characters move as later ones land in the same paragraph: read the places from the layout.
        let l = s.layout();
        let pos: Vec<Pos> = [100.0, 160.0, 400.0].iter().map(|x| l.object_at(0, x + 20.0, 315.0, 1.0).expect("laid out").pos()).collect();
        s.run("select.addObject", &json!({"objects": pos})).unwrap();
        (s, pos)
    }

    #[test]
    fn distribute_spreads_three_objects_between_the_outer_two_in_one_step() {
        let (mut s, pos) = three();
        assert_eq!(picked_objects(&s).len(), 3);
        s.run("arrange.distribute", &json!({"axis": "horizontal"})).unwrap();
        let l = s.layout();
        let xs: Vec<f32> = pos.iter().map(|q| l.object(q, 0).unwrap().rect.x).collect();
        // Outer two stay at 100 and 400; the middle one lands half way between their gaps: 100 + 40 + (400 - 140 - 40) / 2.
        assert!((xs[0] - 100.0).abs() < 0.5 && (xs[2] - 400.0).abs() < 0.5, "{xs:?}");
        assert!((xs[1] - 250.0).abs() < 0.5, "{xs:?}");
        s.run("edit.undo", &json!({})).unwrap();
        let l = s.layout();
        assert!((l.object(&pos[1], 0).unwrap().rect.x - 160.0).abs() < 0.5, "one undo step puts it back");
    }

    #[test]
    fn distribute_to_the_page_needs_no_third_object_and_centres_one() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("text.insert", &json!({"text": "Text."})).unwrap();
        s.run("insert.shape", &json!({"kind": "rectangle", "width": 100, "height": 30})).unwrap();
        s.run("arrange.bounds", &json!({"page": 0, "x": 50, "y": 300})).unwrap();
        assert!(s.run("arrange.distribute", &json!({"axis": "horizontal"})).is_err(), "one object to the selection is refused");
        s.run("arrange.distribute", &json!({"axis": "horizontal", "to": "page"})).unwrap();
        let (pos, _) = selected(&s).unwrap();
        let l = s.layout();
        let x = l.object(&pos, 0).unwrap().rect.x;
        assert!((x - (l.pages[0].w - 100.0) / 2.0).abs() < 0.5, "{x}");
    }

    #[test]
    fn object_at_finds_the_drawing_under_a_point() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("text.insert", &json!({"text": "Text."})).unwrap();
        s.run("insert.shape", &json!({"kind": "ellipse", "width": 60, "height": 40})).unwrap();
        s.run("arrange.bounds", &json!({"page": 0, "x": 200, "y": 300})).unwrap();
        let hit = s.run("object.at", &json!({"page": 0, "x": 230, "y": 320})).unwrap();
        assert_eq!(hit["kind"], "shape");
        assert_eq!(hit["x"], 200.0);
        assert!(s.run("object.at", &json!({"page": 0, "x": 20, "y": 20})).unwrap().is_null());
        s.run("select.collapse", &json!({"end": true})).unwrap();
        s.run("insert.textBox", &json!({"width": 100, "height": 50})).unwrap();
        let (at, _) = super::super::text_box_target(&s).unwrap();
        s.run("select.range", &json!({"anchor": at, "focus": {"story": "body", "path": at.path.0, "off": at.off + 3}})).unwrap();
        s.run("arrange.bounds", &json!({"page": 0, "x": 300, "y": 500})).unwrap();
        assert_eq!(s.run("object.at", &json!({"page": 0, "x": 350, "y": 525})).unwrap()["kind"], "textbox", "a text box is taken inside too");
    }

    #[test]
    fn edit_points_turns_a_preset_into_a_freeform_through_the_new_points() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("text.insert", &json!({"text": "Text."})).unwrap();
        s.run("insert.shape", &json!({"kind": "triangle", "width": 60, "height": 40, "fill": "C00000"})).unwrap();
        let got = s.run("shape.points", &json!({})).unwrap();
        assert_eq!(got["paths"][0]["pts"].as_array().unwrap().len(), 3);
        assert_eq!(got["paths"][0]["pts"][0], json!([30.0, 0.0]));
        s.run("shape.setPoints", &json!({"paths": [{"pts": [[0, 0], [60, 10], [30, 40], [5, 30]], "closed": true}]})).unwrap();
        let (_, o) = selected(&s).unwrap();
        let InlineObject::Shape { kind, freeform, fill, .. } = o else { panic!() };
        assert_eq!(kind, ShapeKind::Freeform);
        assert_eq!(freeform.unwrap().paths[0].pts.len(), 4);
        assert!(fill.is_some(), "the fill stays");
        assert_eq!(s.run("shape.points", &json!({})).unwrap()["paths"][0]["pts"][1], json!([60.0, 10.0]));
        s.run("edit.undo", &json!({})).unwrap();
        let (_, o) = selected(&s).unwrap();
        assert!(matches!(o, InlineObject::Shape { kind: ShapeKind::Triangle, .. }));
    }

    #[test]
    fn edit_points_keeps_curve_handles_and_point_types() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("text.insert", &json!({"text": "Text."})).unwrap();
        s.run("insert.shape", &json!({"kind": "rectangle", "width": 60, "height": 40})).unwrap();
        let nodes = json!([{"at": [0, 0], "cOut": [20, -20], "kind": "smooth"}, {"at": [60, 0], "cIn": [40, -20]}, {"at": [60, 40]}, {"at": [0, 40]}]);
        s.run("shape.setPoints", &json!({"paths": [{"nodes": nodes, "closed": true}]})).unwrap();
        let (_, o) = selected(&s).unwrap();
        let InlineObject::Shape { freeform, .. } = &o else { panic!() };
        let drawn = &freeform.as_ref().unwrap().paths[0].pts;
        assert_eq!(drawn.len(), 1 + ew_doc::freeform::CURVE_STEPS + 2, "the top side is a curve: {drawn:?}");
        assert!(drawn[ew_doc::freeform::CURVE_STEPS / 2][1] < -10.0, "it bows above the frame");
        let got = s.run("shape.points", &json!({})).unwrap();
        let back = &got["paths"][0]["nodes"];
        assert_eq!(back.as_array().unwrap().len(), 4);
        assert_eq!((back[0]["cOut"].clone(), back[0]["kind"].clone(), back[1]["cIn"].clone()), (json!([20.0, -20.0]), json!("smooth"), json!([40.0, -20.0])));
        // Points alone (no nodes) draw straight, and a later read has no stale nodes.
        s.run("shape.setPoints", &json!({"paths": [{"pts": [[0, 0], [60, 0], [30, 40]], "closed": true}]})).unwrap();
        assert!(s.run("shape.points", &json!({})).unwrap()["paths"][0].get("nodes").is_none());
        assert!(s.run("shape.setPoints", &json!({"paths": [{"nodes": [{"at": "x"}]}]})).is_err());
    }

    #[test]
    fn a_frame_drawn_on_the_page_goes_there_empty_before_the_text_under_it() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("document.setText", &json!({"text": "first
second"})).unwrap();
        s.run("insert.frame", &json!({"page": 0, "x": 200, "y": 90, "width": 120, "height": 60})).unwrap();
        let p0 = s.doc.para(ew_doc::StoryRef::Body, &ew_doc::Path::top(0)).unwrap();
        let f = p0.props.frame.clone().unwrap();
        assert_eq!((p0.text.as_str(), f.x, f.y, f.w, f.h, f.h_anchor.as_str()), ("", 200.0, 90.0, Some(120.0), Some(60.0), "page"));
        assert_eq!(s.sel.focus.path, ew_doc::Path::top(0), "the caret goes in");
        s.run("edit.undo", &json!({})).unwrap();
        assert!(s.doc.para(ew_doc::StoryRef::Body, &ew_doc::Path::top(0)).unwrap().props.frame.is_none());
    }

    #[test]
    fn wrap_points_read_the_outline_and_set_a_tight_polygon() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("text.insert", &json!({"text": "Text."})).unwrap();
        s.run("insert.shape", &json!({"kind": "diamond", "width": 60, "height": 40})).unwrap();
        s.run("arrange.bounds", &json!({"page": 0, "x": 200, "y": 300})).unwrap();
        let got = s.run("arrange.wrapPoints", &json!({})).unwrap();
        assert_eq!(got["points"].as_array().unwrap().len(), 4);
        assert_eq!(got["edited"], false);
        s.run("arrange.setWrapPoints", &json!({"points": [[0, 0], [1, 0], [0.5, 1]]})).unwrap();
        let (_, o) = selected(&s).unwrap();
        let (_, _, f) = o.frame().unwrap();
        assert_eq!(f.wrap, Wrap::Tight);
        assert!(f.wrap_polygon.as_ref().unwrap().edited);
        assert_eq!(s.run("arrange.wrapPoints", &json!({})).unwrap()["points"][2], json!([0.5, 1.0]));
    }

    #[test]
    fn the_drawing_grid_spacing_is_set_and_clamped() {
        let mut s = Session::new(ew_doc::Document::new());
        let r = s.run("layout.drawingGrid", &json!({"h": 18, "v": 0.01})).unwrap();
        assert_eq!(r["h"], 18.0);
        assert!((r["v"].as_f64().unwrap() - 0.36).abs() < 1e-6, "{r}");
        assert_eq!(s.doc.settings.grid_h, 18.0);
        // The origin and the lines shown: kept in the document, Word's defaults kept as none.
        let r = s.run("layout.drawingGrid", &json!({"useMargins": false, "x": 36, "y": 50, "everyH": 2, "everyV": 0})).unwrap();
        assert_eq!((r["useMargins"].clone(), r["x"].clone(), r["everyH"].clone(), r["everyV"].clone()), (json!(false), json!(36.0), json!(2), json!(0)));
        assert_eq!(s.doc.settings.grid_show.unwrap().y, 50.0);
        s.run("layout.drawingGrid", &json!({"useMargins": true, "x": 72, "y": 72, "everyH": 1, "everyV": 1})).unwrap();
        assert!(s.doc.settings.grid_show.is_none());
    }
}
