//! `edit.findObjects`: the body's graphics, tables, equations, notes and comments in document
//! order, each with its position, for the Navigation pane's Find kinds and Go To by object
//! (docs/plans/engine/stage2.md G36).

use serde_json::{Value, json};
use ew_doc::para::InlineObject;
use ew_doc::{Pos, StoryRef};

use super::pos_json;
use crate::{CmdError, CmdResult, Session, p};

const KINDS: [&str; 5] = ["graphic", "table", "equation", "note", "comment"];

/// `{kind?}` → [{kind, pos, …}]: `graphic` adds `object` (picture, shape, graphic or group),
/// `note` adds `note` (footnote or endnote) and `id`, `comment` adds `id`, `table` adds `block`
/// (its index in the body). A table is listed at its first cell's start.
// ponytail: top-level tables only, and the body story only (Word's Find kinds look there too);
// list nested tables and objects in headers if the Navigation pane ever needs them.
pub(super) fn find_objects(s: &mut Session, v: &Value) -> CmdResult {
    let only = p::str(v, "kind");
    if let Some(k) = only.filter(|k| !KINDS.contains(k)) {
        return Err(CmdError::Params(format!("unknown `kind` `{k}` (graphic|table|equation|note|comment)")));
    }
    let want = |k: &str| only.is_none_or(|o| o == k);
    let mut out = Vec::new();
    let mut table = None;
    for path in s.doc.para_paths(StoryRef::Body) {
        let Some(para) = s.doc.para(StoryRef::Body, &path) else { continue };
        let pos = |off| Pos { story: StoryRef::Body, path: path.clone(), off };
        if path.0.len() > 1 && table != path.0.first().copied() {
            table = path.0.first().copied();
            if want("table") {
                out.push(json!({"kind": "table", "block": table, "pos": pos_json(&pos(0))}));
            }
        } else if path.0.len() == 1 {
            table = None;
        }
        for (off, o) in para.objects_with_offsets() {
            let item = match o {
                InlineObject::Image { .. } => json!({"kind": "graphic", "object": "picture"}),
                InlineObject::Shape { .. } => json!({"kind": "graphic", "object": "shape"}),
                InlineObject::Graphic { .. } => json!({"kind": "graphic", "object": "graphic"}),
                InlineObject::Group { .. } => json!({"kind": "graphic", "object": "group"}),
                InlineObject::Equation { .. } => json!({"kind": "equation"}),
                InlineObject::NoteRef { kind, id, .. } => json!({"kind": "note", "note": kind, "id": id}),
                InlineObject::CommentStart { id } => json!({"kind": "comment", "id": id}),
                _ => continue,
            };
            if want(item["kind"].as_str().unwrap_or_default()) {
                let mut item = item;
                item["pos"] = pos_json(&pos(off));
                out.push(item);
            }
        }
    }
    Ok(Value::Array(out))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::Session;

    fn kinds(s: &mut Session, params: serde_json::Value) -> Vec<String> {
        let r = s.run("edit.findObjects", &params).unwrap();
        r.as_array().unwrap().iter().map(|o| o["kind"].as_str().unwrap().to_string()).collect()
    }

    /// Every kind in document order, each with a body position; a kind filter keeps only its own.
    #[test]
    fn lists_objects_in_document_order() {
        let mut s = Session::new(ew_doc::Document::from_text("One\nTwo\nThree\nFour"));
        s.run("insert.shape", &json!({"kind": "rectangle"})).unwrap();
        s.run("caret.docStart", &json!({})).unwrap();
        s.run("caret.down", &json!({})).unwrap();
        s.run("insert.equation", &json!({"linear": "x^2", "edit": false})).unwrap();
        s.run("caret.docStart", &json!({})).unwrap();
        s.run("caret.down", &json!({})).unwrap();
        s.run("caret.down", &json!({})).unwrap();
        s.run("caret.end", &json!({})).unwrap();
        s.run("review.newComment", &json!({"text": "a remark"})).unwrap();
        s.run("caret.docEnd", &json!({})).unwrap();
        s.run("insert.table", &json!({"rows": 2, "cols": 2})).unwrap();
        let all = s.run("edit.findObjects", &json!({})).unwrap();
        let list = all.as_array().unwrap();
        let ks: Vec<&str> = list.iter().map(|o| o["kind"].as_str().unwrap()).collect();
        assert!(ks.contains(&"graphic") && ks.contains(&"equation") && ks.contains(&"comment") && ks.contains(&"table"), "{all}");
        for o in list {
            assert_eq!(o["pos"]["story"], json!("body"), "{o}");
        }
        // Document order: each position at or after the one before it.
        let key = |o: &serde_json::Value| {
            let p: Vec<u64> = o["pos"]["path"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect();
            (p, o["pos"]["off"].as_u64().unwrap())
        };
        assert!(list.windows(2).all(|w| key(&w[0]) <= key(&w[1])), "{all}");
        assert_eq!(kinds(&mut s, json!({"kind": "table"})), vec!["table"]);
        assert_eq!(kinds(&mut s, json!({"kind": "graphic"})), vec!["graphic"]);
        assert!(s.run("edit.findObjects", &json!({"kind": "ink"})).is_err());
    }

    /// Notes are listed by their reference mark in the body, with their kind and part id.
    #[test]
    fn lists_note_marks() {
        let mut s = Session::new(ew_doc::Document::from_text("Text with a note"));
        s.run("caret.docEnd", &json!({})).unwrap();
        s.run("references.footnote", &json!({"text": "the note"})).unwrap();
        let r = s.run("edit.findObjects", &json!({"kind": "note"})).unwrap();
        let list = r.as_array().unwrap();
        assert_eq!(list.len(), 1, "{r}");
        assert_eq!(list[0]["note"], json!("footnote"));
        assert!(list[0]["id"].is_u64());
    }

    /// A query: the host's `query` (ctx.read) runs it, which refuses commands that change the document.
    #[test]
    fn is_pure() {
        let s = Session::new(ew_doc::Document::from_text("Plain"));
        assert!(s.registry.get("edit.findObjects").is_some_and(|c| !c.mutates));
    }
}
