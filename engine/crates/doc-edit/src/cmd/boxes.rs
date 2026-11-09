//! EasyWriter: the commands of EasyWriter's own objects inside a document (docs/plans/engine/viewport-design.md section 5.3).
//! A box (a smart canvas, a plan chart) is a drawing whose `float.box` holds its kind and data; the drawing is its fallback.
//! Its data changes only through `box.set`, so a box edit is an undo step, saves and autosaves like any other edit, and the
//! component that edits it sends a new fallback picture with each commit, so the document never holds a fallback older
//! than its data.
use std::sync::Arc;

use serde_json::{Value, json};
use ew_doc::StoryRef;
use ew_doc::para::{InlineObject, ObjectBox};

use super::insert::base64_decode;
use crate::{CmdError, CmdResult, CommandSpec, Session, p};

/// The largest box data taken (a canvas holding pictures carries them as data URLs).
pub(crate) const MAX_DATA: usize = 256 << 20;

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("box.set", "Update Object", "Object", set).params(
            r#"{"id": number (the box's stable id, frames()), "data": string (JSON, the box kind's own), "fallback"?: string (a PNG as base64 or a data URL: the picture shown where the object is not drawn live, in PDF and print), "w"?: number, "h"?: number (points; the box's size, else kept)}"#,
        ),
        CommandSpec::new("box.get", "Object Data", "Object", get).params(r#"{"id": number} → {kind, data, file, w, h}"#).pure(),
        // engine-canvas-read (stage2b.md decision 8): every story's boxes, for code that rewrites them (a flowchart removed from
        // the library leaves plain copies), and the caret section's text width, which a new box spans.
        CommandSpec::new("box.list", "Objects", "Object", list).params(r#"{} → {boxes: [{id, kind, data, w, h}], column: number (points)}"#).pure(),
        CommandSpec::new("box.insert", "Insert Object", "Object", insert).params(
            r#"{"kind": "canvas|planChart", "data": string (JSON, the kind's own), "fallback": string (a PNG as base64 or a data URL), "w"?: number (points; default the text column, the height from the picture's aspect)} → {media, width, height}"#,
        ),
    ]
}

pub(crate) fn id_of(v: &Value) -> Result<u32, CmdError> {
    v.get("id").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).filter(|n| *n != 0).ok_or_else(|| CmdError::Params("id: a box's id".into()))
}

/// The box with stable id `id` → (its drawing, its box).
pub(crate) fn find(s: &Session, id: u32) -> Result<(InlineObject, Arc<ObjectBox>), CmdError> {
    let at = s.doc.object_by_id(id).ok_or_else(|| CmdError::Failed(format!("no object {id}")))?;
    let o = s.doc.para_at(&at).and_then(|p| p.object_at(at.off)).ok_or_else(|| CmdError::Failed(format!("no object {id}")))?;
    let b = o.frame().and_then(|(_, _, f)| f.r#box.clone()).ok_or_else(|| CmdError::Failed(format!("object {id} is not a box")))?;
    Ok((o.clone(), b))
}

fn get(s: &mut Session, v: &Value) -> CmdResult {
    let (o, b) = find(s, id_of(v)?)?;
    let (w, h, _) = o.frame().unwrap_or((0.0, 0.0, &Default::default()));
    Ok(json!({"kind": b.kind, "data": b.data, "file": b.file, "w": w, "h": h}))
}

fn list(s: &mut Session, _: &Value) -> CmdResult {
    let mut boxes = Vec::new();
    let stories: Vec<StoryRef> = std::iter::once(StoryRef::Body).chain(s.doc.parts.keys().map(|k| StoryRef::Part(*k))).collect();
    for story in stories {
        for path in s.doc.para_paths(story) {
            let Some(p) = s.doc.para(story, &path) else { continue };
            for o in &p.objects {
                if let Some((w, h, f)) = o.frame()
                    && let Some(b) = &f.r#box
                {
                    boxes.push(json!({"id": f.id.0, "kind": b.kind, "data": b.data, "w": w, "h": h}));
                }
            }
        }
    }
    // The text width of the caret's section (the body's last section when the caret is in another story).
    let top = if s.sel.focus.story == StoryRef::Body { s.sel.focus.path.0.first().map_or(usize::MAX, |i| *i as usize) } else { usize::MAX };
    let sections = s.doc.sections();
    let column = sections.iter().find(|(end, _)| *end >= top).or(sections.last()).map_or(468.0, |(_, sp)| sp.text_width());
    Ok(json!({"boxes": boxes, "column": column}))
}

/// The kinds a box can be (the docx stash's).
const KINDS: [&str; 2] = ["canvas", "planChart"];

fn insert(s: &mut Session, v: &Value) -> CmdResult {
    let kind = p::str(v, "kind").filter(|k| KINDS.contains(k)).ok_or_else(|| CmdError::Params("kind: canvas or planChart".into()))?;
    let data = p::str(v, "data").ok_or_else(|| CmdError::Params("data: the box's JSON".into()))?;
    if data.len() > MAX_DATA || serde_json::from_str::<Value>(data).is_err() {
        return Err(CmdError::Params("data: JSON of at most 256 MB".into()));
    }
    let f = p::str(v, "fallback").ok_or_else(|| CmdError::Params("fallback: a PNG".into()))?;
    let b64 = f.split_once(";base64,").map_or(f, |(_, b)| b);
    if !base64_decode(b64).is_some_and(|b| b.starts_with(b"\x89PNG")) {
        return Err(CmdError::Params("fallback: a PNG".into()));
    }
    // An inline picture at the caret as wide as the text column, or `w` when that is less (insert.picture keeps the picture's
    // aspect), which then becomes the box: its U+FFFC ends where the caret is now.
    let w = p::f32(v, "w").filter(|n| n.is_finite() && *n > 0.0).unwrap_or(1e6).min(1e6);
    let r = super::insert::picture(s, &json!({"data": b64, "width": w}))?;
    if r.get("canvasMember").is_some() {
        return Err(CmdError::Failed("a box cannot go inside a drawing canvas".into()));
    }
    let at = s.sel.focus.clone();
    let placed = || CmdError::Failed("the box was not placed".into());
    let off = at.off.checked_sub('\u{FFFC}'.len_utf8()).ok_or_else(placed)?;
    let para = s.doc.para_mut(at.story, &at.path).map_err(|_| placed())?;
    let float = para.object_at_mut(off).and_then(InlineObject::float_mut).ok_or_else(placed)?;
    float.r#box = Some(Arc::new(ObjectBox { kind: kind.into(), data: data.to_string(), ..Default::default() }));
    para.touch();
    s.touch();
    Ok(r)
}

fn set(s: &mut Session, v: &Value) -> CmdResult {
    let id = id_of(v)?;
    let data = p::str(v, "data").ok_or_else(|| CmdError::Params("data: the box's JSON".into()))?;
    if data.len() > MAX_DATA || serde_json::from_str::<Value>(data).is_err() {
        return Err(CmdError::Params("data: JSON of at most 256 MB".into()));
    }
    let (old, b) = find(s, id)?;
    let size = |k: &str, was: f32| v.get(k).and_then(Value::as_f64).map(|n| n as f32).filter(|n| n.is_finite() && *n > 0.0).map_or(was, |n| n.min(4000.0));
    let (w0, h0, float) = old.frame().map(|(w, h, f)| (w, h, f.clone())).unwrap_or_default();
    let (w, h) = (size("w", w0), size("h", h0));
    let fallback = match p::str(v, "fallback") {
        Some(f) => {
            let b64 = f.split_once(";base64,").map_or(f, |(_, b)| b);
            let bytes = base64_decode(b64).filter(|b| b.starts_with(b"\x89PNG")).ok_or_else(|| CmdError::Params("fallback: a PNG".into()))?;
            Some(s.doc.add_media(bytes, "png"))
        }
        None => None,
    };
    let mut float = float;
    // A medium's file is its source: a resize keeps it, or the box would lose its picture.
    float.r#box = Some(Arc::new(ObjectBox { kind: b.kind.clone(), data: data.to_string(), file: b.file.clone(), ..Default::default() }));
    let alt = old.alt_text().to_string();
    let new = match fallback {
        // The new picture replaces the drawing (a Word drawing read from a file, or the last picture), in its place and wrap.
        Some(media) => ew_doc::para::Picture { media, w, h, alt, float, ..Default::default() }.build(),
        None => {
            let mut o = old.clone();
            o.set_size(w, h);
            if let Some(f) = o.float_mut() {
                *f = float;
            }
            o
        }
    };
    let mut new = Some(new);
    s.doc.objects_mut(&|o| o.frame().is_some_and(|(_, _, f)| f.id.0 == id), &mut |o| {
        if let Some(n) = new.take() {
            *o = n;
        }
    });
    // A drawing with text boxes (a canvas read as Word shapes) leaves their stories unused.
    s.doc.prune_text_boxes();
    s.touch();
    Ok(json!({"id": id}))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // 1 x 1 pictures, white and black.
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
    const PNG2: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    #[test]
    fn set_replaces_the_drawing_with_its_new_picture_and_undoes_in_one_step() {
        let mut s = Session::new(ew_doc::Document::from_text("before"));
        s.run("insert.picture", &json!({"data": PNG})).unwrap();
        // Make the picture a box with id 7, as a file's stash does.
        s.doc.objects_mut(&|o| o.frame().is_some(), &mut |o| {
            let f = o.float_mut().unwrap();
            f.id = ew_doc::Id(7);
            f.r#box = Some(Arc::new(ObjectBox { kind: "canvas".into(), data: "{\"w\":1}".into(), ..Default::default() }));
        });
        let got = s.run("box.get", &json!({"id": 7})).unwrap();
        assert_eq!((got["kind"].as_str(), got["data"].as_str()), (Some("canvas"), Some("{\"w\":1}")));
        let before = s.doc.media.len();
        s.run("box.set", &json!({"id": 7, "data": "{\"w\":2}", "fallback": format!("data:image/png;base64,{PNG2}"), "w": 50})).unwrap();
        assert_eq!(s.run("box.get", &json!({"id": 7})).unwrap()["data"], "{\"w\":2}");
        assert_eq!(s.doc.media.len(), before + 1);
        assert!(s.run("box.set", &json!({"id": 7, "data": "not json"})).is_err());
        assert!(s.run("box.set", &json!({"id": 8, "data": "{}"})).is_err());
        s.run("edit.undo", &json!({})).unwrap();
        assert_eq!(s.run("box.get", &json!({"id": 7})).unwrap()["data"], "{\"w\":1}");
    }

    #[test]
    fn set_keeps_a_medium_s_file_and_its_size() {
        let mut s = Session::new(ew_doc::Document::from_text("before"));
        s.run("insert.picture", &json!({"data": PNG})).unwrap();
        s.doc.objects_mut(&|o| o.frame().is_some(), &mut |o| {
            let f = o.float_mut().unwrap();
            f.id = ew_doc::Id(9);
            f.r#box = Some(Arc::new(ObjectBox {
                kind: "media".into(),
                data: "{\"name\":\"g.gif\"}".into(),
                file: "data:image/gif;base64,R0lGOD".into(),
                ..Default::default()
            }));
        });
        // A resize sends the new data and size only: the medium's source must not be emptied, or the box loses its picture.
        s.run("box.set", &json!({"id": 9, "data": "{\"name\":\"g.gif\",\"dw\":500}", "w": 500.0, "h": 625.0})).unwrap();
        let got = s.run("box.get", &json!({"id": 9})).unwrap();
        assert_eq!(got["file"], "data:image/gif;base64,R0lGOD");
        assert_eq!(got["data"], "{\"name\":\"g.gif\",\"dw\":500}");
        assert_eq!((got["w"].as_f64(), got["h"].as_f64()), (Some(500.0), Some(625.0)));
    }

    #[test]
    fn insert_puts_a_box_at_the_caret_that_list_reports_and_one_undo_takes_back() {
        let mut s = Session::new(ew_doc::Document::from_text("before"));
        s.run("caret.docEnd", &json!({})).unwrap();
        let column = s.run("box.list", &json!({})).unwrap()["column"].as_f64().unwrap();
        assert!(column > 100.0, "the text column: {column}");
        assert!(s.run("box.insert", &json!({"kind": "note", "data": "{}", "fallback": PNG})).is_err(), "an unknown kind");
        assert!(s.run("box.insert", &json!({"kind": "canvas", "data": "{}", "fallback": "AAAA"})).is_err(), "not a PNG");
        let png = format!("data:image/png;base64,{PNG}");
        let r = s.run("box.insert", &json!({"kind": "canvas", "data": "{\"w\":800}", "fallback": png})).unwrap();
        assert!((r["width"].as_f64().unwrap() - column).abs() < 0.5, "as wide as the column: {r}");
        // `w` narrower than the column (a 1 px picture is sized from at least 1 pt, so 40 asks for 30 here: insert.picture's rule).
        let narrow = s.run("box.insert", &json!({"kind": "planChart", "data": "{\"planId\":\"p\"}", "fallback": PNG2, "w": 40})).unwrap()["width"].as_f64().unwrap();
        assert!(narrow < 41.0);
        let l = s.run("box.list", &json!({})).unwrap();
        let got: Vec<(String, f64)> =
            l["boxes"].as_array().unwrap().iter().map(|b| (b["kind"].as_str().unwrap().to_string(), b["w"].as_f64().unwrap().round())).collect();
        assert_eq!(got, [("canvas".to_string(), column.round()), ("planChart".to_string(), narrow.round())]);
        assert_eq!(l["boxes"][1]["data"], "{\"planId\":\"p\"}");
        s.run("edit.undo", &json!({})).unwrap();
        assert_eq!(s.run("box.list", &json!({})).unwrap()["boxes"].as_array().unwrap().len(), 1, "one undo takes the last insert back");
    }
}
