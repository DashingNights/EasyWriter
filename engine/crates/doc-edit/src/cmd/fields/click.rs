//! Running a field (Word's DoFieldClick, Alt+Shift+F9) and the fields' ranges that field shading and form field shading are
//! drawn on over the page (stage 2b gap G21, docs/plans/engine/stage2/gaps.md fields-core and content-controls).

use serde_json::{Value, json};
use ew_doc::para::{InlineObject, OBJ};
use ew_doc::{Pos, StoryRef};

use super::{FieldAt, selected, story_fields};
use crate::cmd::{pos_json, sel_result};
use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("fields.click", "Run Field", "Insert › Text › Quick Parts", click).pure(),
        CommandSpec::new("fields.ranges", "Field Ranges", "Insert › Text › Quick Parts", ranges)
            .params(r#"{"all"?: bool (every field of the caret's story; default the selected ones), "forms"?: bool (legacy form fields only)} → [{anchor, head, form}]"#)
            .pure(),
    ]
}

/// A field code's words, quoted ones kept whole without their quotes.
fn words(instr: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in instr.chars() {
        match c {
            '"' => {
                if quoted {
                    out.push(std::mem::take(&mut cur));
                } else if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                quoted = !quoted;
            }
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Whether a field code names a legacy form field.
fn is_form(instr: &str) -> bool {
    matches!(instr.split_whitespace().next(), Some("FORMTEXT" | "FORMCHECKBOX" | "FORMDROPDOWN"))
}

/// Alt+Shift+F9 on the selected field: GOTOBUTTON goes to its bookmark, a HYPERLINK to its place (`\l`) or answers its
/// address (`{url}`) for the host to open; MACROBUTTON is refused, as no macros run here. Other fields have nothing to run.
fn click(s: &mut Session, _: &Value) -> CmdResult {
    let f = selected(s).into_iter().next().ok_or_else(|| CmdError::Disabled("fields.click: there is no field at the caret".into()))?;
    let w = words(&f.instr);
    let bookmark = |s: &mut Session, name: &str| -> CmdResult {
        let (from, to) = crate::cmd::insert::bookmark_range(&s.doc, name).ok_or_else(|| CmdError::Failed(format!("there is no bookmark named {name}")))?;
        s.sel = Selection { anchor: from, focus: to };
        let mut r = sel_result(s)?;
        r["bookmark"] = json!(name);
        Ok(r)
    };
    match w.first().map(|k| k.to_ascii_uppercase()).as_deref() {
        Some("GOTOBUTTON") => {
            let name = w.get(1).ok_or_else(|| CmdError::Failed("the GOTOBUTTON field names no bookmark".into()))?.clone();
            bookmark(s, &name)
        }
        Some("HYPERLINK") => {
            let place = w.iter().position(|x| x.eq_ignore_ascii_case("\\l")).and_then(|i| w.get(i + 1)).cloned();
            if let Some(name) = place {
                return bookmark(s, &name);
            }
            let url = w.iter().skip(1).find(|x| !x.starts_with('\\')).cloned().ok_or_else(|| CmdError::Failed("the HYPERLINK field has no address".into()))?;
            Ok(json!({"url": url}))
        }
        Some("MACROBUTTON") => Err(CmdError::Failed("macros do not run in EasyWriter".into())),
        _ => Err(CmdError::Disabled("fields.click: only GOTOBUTTON, MACROBUTTON and HYPERLINK fields run".into())),
    }
}

/// A field's range: a simple field's object, or a range field from its start marker past its end marker.
fn range_of(f: &FieldAt) -> (Pos, Pos) {
    let w = OBJ.len_utf8();
    let end = f.end.clone().unwrap_or_else(|| f.at.clone());
    let head = Pos { off: end.off + w, ..end };
    (f.at.clone(), head)
}

/// Whether `story` holds a legacy form field: a look at the paragraphs' objects, without the range fields' scan.
fn has_forms(s: &Session, story: StoryRef) -> bool {
    s.doc.para_paths(story).iter().filter_map(|path| s.doc.para(story, path)).any(|p| {
        p.objects.iter().any(|o| matches!(o, InlineObject::Field { instr, .. } | InlineObject::FieldStart { instr, .. } if is_form(instr)))
    })
}

fn ranges(s: &mut Session, v: &Value) -> CmdResult {
    let story = s.sel.focus.story;
    let forms = p::bool(v, "forms").unwrap_or(false);
    // Form field shading asks after every edit: a story with no form field skips the whole story's field scan.
    if forms && !has_forms(s, story) {
        return Ok(Value::Array(Vec::new()));
    }
    let list = if p::bool(v, "all").unwrap_or(false) { story_fields(s, story) } else { selected(s) };
    let out: Vec<Value> = list
        .iter()
        .filter(|f| !forms || is_form(&f.instr))
        .map(|f| {
            let (a, b) = range_of(f);
            json!({"anchor": pos_json(&a), "head": pos_json(&b), "form": is_form(&f.instr)})
        })
        .collect();
    Ok(Value::Array(out))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::words;
    use crate::Session;

    #[test]
    fn field_words_keep_quoted_parts_whole() {
        assert_eq!(words(r#"HYPERLINK "https://example.com/a b" \o "Tip""#), ["HYPERLINK", "https://example.com/a b", "\\o", "Tip"]);
        assert_eq!(words("GOTOBUTTON Target  Click here"), ["GOTOBUTTON", "Target", "Click", "here"]);
    }

    #[test]
    fn gotobutton_goes_to_its_bookmark_and_macrobutton_is_refused() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("document.setText", &json!({"text": "Jump\nThe target"})).unwrap();
        s.run("select.range", &json!({"anchor": {"block": 1, "off": 4}, "focus": {"block": 1, "off": 10}})).unwrap();
        s.run("insert.bookmark", &json!({"name": "Target"})).unwrap();
        s.run("caret.set", &json!({"pos": {"block": 0, "off": 4}})).unwrap();
        s.run("insert.field", &json!({"instr": "GOTOBUTTON Target Go"})).unwrap();
        s.run("caret.set", &json!({"pos": {"block": 0, "off": 4}})).unwrap();
        let r = s.run("fields.click", &json!({})).unwrap();
        assert_eq!(r["bookmark"], "Target");
        assert_eq!(s.sel.ordered().0.path.0, vec![1]);
        let ranges = s.run("fields.ranges", &json!({"all": true})).unwrap();
        assert_eq!(ranges.as_array().map(Vec::len), Some(1));
        s.run("caret.docEnd", &json!({})).unwrap();
        s.run("insert.field", &json!({"instr": "MACROBUTTON NoMacro Press"})).unwrap();
        s.run("caret.left", &json!({})).unwrap();
        assert!(s.run("fields.click", &json!({})).is_err());
    }
}
