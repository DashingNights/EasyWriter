//! Developer › Controls on the canvas engine (stage 2b gaps, docs/plans/engine/stage2/gaps.md content-controls, G21): Group and
//! Ungroup, Form Field Shading and Reset Form Fields under Legacy Tools, and the content controls' ranges that their tags (Ctrl+
//! Shift+X) are drawn from over the page.

use serde_json::{Value, json};
use ew_doc::control::{ControlKind, ControlLock};
use ew_doc::legacy_form::LegacyForm;
use ew_doc::para::InlineObject;

use crate::cmd::{pos_json, sel_result};
use crate::{CmdError, CmdResult, CommandSpec, Session, p};

const LOC: &str = "Developer › Controls";
/// Word's group control (`w:group` in `w:sdtPr`), kept in the control's verbatim children.
const GROUP: &str = "<w:group/>";
/// What an empty text form field shows (insert/forms.rs).
const EMPTY_TEXT: &str = "\u{2002}\u{2002}\u{2002}\u{2002}\u{2002}";

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("developer.group", "Group", LOC, group).params(r#"{"ungroup"?: bool}"#),
        CommandSpec::new("developer.formShading", "Form Field Shading", "Developer › Controls › Legacy Tools", |s, v| {
            // No relayout: the pages never draw the grey; the app's overlay does (content-controls/marks.jsx), from this setting.
            s.doc.settings.no_form_shading = !p::bool(v, "value").unwrap_or(s.doc.settings.no_form_shading);
            Ok(json!({"value": !s.doc.settings.no_form_shading}))
        })
        .params(r#"{"value"?: bool}"#)
        .state(|s| (json!(!s.doc.settings.no_form_shading), Value::Null)),
        CommandSpec::new("developer.resetFormFields", "Reset Form Fields", "Developer › Controls › Legacy Tools", reset_forms),
        CommandSpec::new("developer.ranges", "Content Control Ranges", LOC, ranges)
            .params(r#"{} → [{start, end, tag, title, kind}] (the caret's story)"#)
            .pure(),
    ]
}

fn is_group(c: &ew_doc::control::ContentControl) -> bool {
    c.extra.iter().any(|x| x.trim_start().starts_with("<w:group"))
}

/// Group: the selection becomes one group control, whose text can't be edited outside the controls in it (Word's protection
/// of a form's fixed text). Ungroup (`ungroup`) takes away the group round the selection.
fn group(s: &mut Session, v: &Value) -> CmdResult {
    let story = s.sel.focus.story;
    if p::bool(v, "ungroup").unwrap_or(false) {
        let (a, _) = s.sel.ordered();
        let r = s
            .doc
            .control_ranges(story)
            .into_iter()
            .filter(|r| is_group(&r.control) && r.start <= a && a <= r.end)
            .max_by_key(|r| r.depth)
            .ok_or_else(|| CmdError::Disabled("developer.group: the selection is in no group".into()))?;
        // The group's own lock does not stop Ungroup: its markers go (the end first, so the start keeps its offset) and the
        // content stays, as remove_control takes a control with real content away.
        let w = ew_doc::para::OBJ.len_utf8();
        s.doc.para_mut(r.end.story, &r.end.path)?.delete(r.end.off, r.end.off + w)?;
        s.doc.para_mut(r.start.story, &r.start.path)?.delete(r.start.off, r.start.off + w)?;
        s.sel = crate::Selection::caret(s.doc.clamp(&r.start));
        return sel_result(s);
    }
    if s.sel.is_collapsed() {
        return Err(CmdError::Disabled("developer.group: select the text and controls to group first".into()));
    }
    let before: Vec<Option<i64>> = s.doc.control_ranges(story).iter().map(|r| r.control.id).collect();
    super::insert(s, &json!({}), ControlKind::RichText)?;
    let made = s.doc.control_ranges(story).into_iter().find(|r| !before.contains(&r.control.id)).map(|r| r.start);
    let start = made.ok_or_else(|| CmdError::Failed("developer.group: the group was not made".into()))?;
    if let Some(c) = s.doc.control_mut(&start) {
        c.extra.push(GROUP.into());
        c.lock = ControlLock::ContentLocked;
        c.showing_placeholder = false;
    }
    sel_result(s)
}

/// Removes every `<name …/>` (or `<name …>…</name>`) element from `xml`.
fn without(xml: &str, name: &str) -> String {
    let mut out = xml.to_string();
    while let Some(i) = out.find(&format!("<{name}")).filter(|&i| out[i + name.len() + 1..].starts_with([' ', '/', '>'])) {
        let rest = &out[i..];
        let len = match (rest.find("/>"), rest.find('>')) {
            (Some(e), Some(g)) if e + 1 == g => e + 2,
            (_, Some(_)) => rest.find(&format!("</{name}>")).map_or(rest.len(), |c| c + name.len() + 3),
            _ => rest.len(),
        };
        out.replace_range(i..i + len, "");
    }
    out
}

/// A `w:val` attribute's value inside element `name` of `xml`.
fn val_in(xml: &str, name: &str) -> Option<String> {
    let i = xml.find(&format!("<{name}"))?;
    let tag = &xml[i..i + xml[i..].find('>')?];
    let v = tag.find("w:val=\"")? + 7;
    Some(tag[v..v + tag[v..].find('"')?].to_string())
}

/// Reset Form Fields: every legacy form field of the document's main text back to its default (a check box's default state, a
/// drop-down's default entry, a text field's default text), as Word's Legacy Tools button does.
fn reset_forms(s: &mut Session, _: &Value) -> CmdResult {
    let story = ew_doc::StoryRef::Body;
    let mut n = 0;
    for path in s.doc.para_paths(story) {
        let Ok(para) = s.doc.para_mut(story, &path) else { continue };
        let offs = para.object_offsets();
        let mut changed = false;
        for off in offs {
            let Some(InlineObject::Field { form, result, .. }) = para.object_at_mut(off) else { continue };
            if form.is_empty() {
                continue;
            }
            match LegacyForm::parse(form) {
                Some(LegacyForm::CheckBox { .. }) => *form = without(form, "w:checked"),
                Some(LegacyForm::DropDown { .. }) => {
                    *form = without(form, "w:result");
                    *result = LegacyForm::parse(form).and_then(|f| f.shown_text().map(str::to_string)).unwrap_or_else(|| EMPTY_TEXT.into());
                }
                Some(LegacyForm::Text { .. }) => *result = val_in(form, "w:default").filter(|t| !t.is_empty()).unwrap_or_else(|| EMPTY_TEXT.into()),
                None => continue,
            }
            changed = true;
            n += 1;
        }
        if changed {
            para.touch();
        }
    }
    let mut r = sel_result(s)?;
    r["reset"] = json!(n);
    Ok(r)
}

fn ranges(s: &mut Session, _: &Value) -> CmdResult {
    let story = s.sel.focus.story;
    Ok(Value::Array(
        s.doc
            .control_ranges(story)
            .iter()
            .map(|r| {
                json!({"start": pos_json(&r.start), "end": pos_json(&r.end), "tag": r.control.tag, "title": r.control.title,
                    "kind": if is_group(&r.control) { "group" } else { r.control.kind.name() }, "block": r.control.block})
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use ew_doc::StoryRef;

    use super::without;
    use crate::Session;

    #[test]
    fn without_takes_out_empty_and_full_elements() {
        assert_eq!(without(r#"<w:checkBox><w:default w:val="0"/><w:checked/></w:checkBox>"#, "w:checked"), r#"<w:checkBox><w:default w:val="0"/></w:checkBox>"#);
        assert_eq!(without(r#"<w:ddList><w:result w:val="2"/><w:listEntry w:val="a"/></w:ddList>"#, "w:result"), r#"<w:ddList><w:listEntry w:val="a"/></w:ddList>"#);
        assert_eq!(without("<w:checkedX/>", "w:checked"), "<w:checkedX/>");
    }

    #[test]
    fn group_locks_fixed_text_and_ungroup_frees_it() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("document.setText", &json!({"text": "Name: here"})).unwrap();
        s.run("select.range", &json!({"anchor": {"block": 0, "off": 6}, "focus": {"block": 0, "off": 10}})).unwrap();
        s.run("developer.plainText", &json!({})).unwrap();
        s.run("select.all", &json!({})).unwrap();
        s.run("developer.group", &json!({})).unwrap();
        let kinds: Vec<String> = s.run("developer.ranges", &json!({})).unwrap().as_array().unwrap().iter().map(|r| r["kind"].as_str().unwrap().to_string()).collect();
        assert!(kinds.contains(&"group".to_string()), "{kinds:?}");
        // Typing in the fixed text is refused; the plain text control inside stays editable.
        s.run("caret.docStart", &json!({})).unwrap();
        s.run("caret.right", &json!({})).unwrap();
        s.run("caret.right", &json!({})).unwrap();
        let before = s.doc.plain_text(StoryRef::Body);
        let _ = s.run("text.insert", &json!({"text": "X"}));
        assert_eq!(s.doc.plain_text(StoryRef::Body), before);
        s.run("developer.group", &json!({"ungroup": true})).unwrap();
        let kinds = s.run("developer.ranges", &json!({})).unwrap();
        assert!(!kinds.to_string().contains("\"group\""), "{kinds}");
    }

    #[test]
    fn form_shading_toggles_the_setting_and_reset_puts_back_defaults() {
        let mut s = Session::new(ew_doc::Document::new());
        s.run("document.setText", &json!({"text": "Box "})).unwrap();
        s.run("caret.docEnd", &json!({})).unwrap();
        s.run("developer.formField", &json!({"kind": "checkBox"})).unwrap();
        s.run("developer.formShading", &json!({})).unwrap();
        assert!(s.doc.settings.no_form_shading);
        s.run("developer.formShading", &json!({})).unwrap();
        assert!(!s.doc.settings.no_form_shading);
        // Check the box (its w:checked), then reset it.
        let story = StoryRef::Body;
        let path = s.doc.para_paths(story)[0].clone();
        let para = s.doc.para_mut(story, &path).unwrap();
        let off = para.object_offsets().into_iter().find(|&o| matches!(para.object_at(o), Some(ew_doc::para::InlineObject::Field { .. }))).unwrap();
        if let Some(ew_doc::para::InlineObject::Field { form, .. }) = para.object_at_mut(off) {
            *form = form.replace("</w:checkBox>", "<w:checked/></w:checkBox>");
        }
        let r = s.run("developer.resetFormFields", &json!({})).unwrap();
        assert_eq!(r["reset"], 1);
        let para = s.doc.para(story, &path).unwrap();
        let checked = matches!(para.object_at(off).and_then(|o| o.legacy_form()), Some(ew_doc::legacy_form::LegacyForm::CheckBox { checked: false, .. }));
        assert!(checked);
    }
}
