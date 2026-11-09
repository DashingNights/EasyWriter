//! EasyWriter engine-gaps-rest: content controls bound to document properties on the canvas engine (the XML Mapping pane's
//! Insert Content Control; [`ew_doc::binding`]). A bound control shows its property and gives it its text when edited:
//! `developer.syncBindings` brings them into step, and setting a property (`file.properties`) rewrites its controls.

use serde_json::{Value, json};
use ew_doc::binding::BOUND_PROPERTIES;
use ew_doc::control::ControlKind;

use super::{content_base, insert, placeholder_props, set_content};
use crate::{CmdError, CmdResult, CommandSpec, Session, p};

/// The name Word gives a property's control (its title) and placeholder.
fn label(name: &str) -> &'static str {
    match name {
        "title" => "Title",
        "subject" => "Subject",
        "creator" => "Author",
        "keywords" => "Keywords",
        "description" => "Comments",
        "category" => "Category",
        _ => "Property",
    }
}

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("developer.insertBound", "Insert Content Control", "Developer › Mapping › XML Mapping Pane", insert_bound)
            .params(r#"{"property": "title|subject|creator|keywords|description|category", "kind"?: "text|date"}"#),
        CommandSpec::new("developer.syncBindings", "Update Bound Content Controls", "Developer › Mapping › XML Mapping Pane", |s, _| {
            Ok(json!({"changed": sync(s, true)?}))
        }),
    ]
}

/// A control of `kind` bound to core property `property` at the selection, showing the property (or its placeholder).
fn insert_bound(s: &mut Session, v: &Value) -> CmdResult {
    let name = p::str(v, "property").and_then(|n| BOUND_PROPERTIES.iter().map(|(el, _)| *el).find(|el| *el == n));
    let name = name.ok_or_else(|| CmdError::Params("property: one of title, subject, creator, keywords, description, category".into()))?;
    let kind = match p::str(v, "kind").unwrap_or("text") {
        "text" => ControlKind::Text { multi_line: false },
        "date" => ControlKind::Date { full_date: String::new(), format: "M/d/yyyy".into(), lid: String::new(), calendar: String::new(), store_as: String::new() },
        _ => return Err(CmdError::Params("kind: text|date".into())),
    };
    let title = label(name);
    insert(s, &json!({"title": title}), kind)?;
    let r = s.doc.control_at(&s.sel.focus).ok_or_else(|| CmdError::Failed("the control was not inserted".into()))?;
    if let Some(c) = s.doc.control_mut(&r.start) {
        c.bind_property(name);
        c.placeholder_text = format!("[{title}]");
    }
    let value = s.doc.core_value(name).unwrap_or("").to_string();
    let r = s.doc.control_at(&s.sel.focus).ok_or_else(|| CmdError::Failed("the control was not inserted".into()))?;
    fill(s, &r, &value)?;
    crate::cmd::sel_result(s)
}

/// Shows `value` in bound control `r`, or its placeholder when `value` is empty.
fn fill(s: &mut Session, r: &ew_doc::control::ControlRange, value: &str) -> Result<(), CmdError> {
    let base = content_base(s, r);
    let (text, props) = if value.is_empty() { (r.control.placeholder_shown().to_string(), placeholder_props(s, &base)) } else { (value.to_string(), base) };
    set_content(s, r, &text, &props)?;
    if let Some(c) = s.doc.control_mut(&r.start) {
        c.showing_placeholder = value.is_empty();
    }
    Ok(())
}

/// Brings the bound controls and their properties into step (`edited`: a control edited since gives its property its text;
/// else the properties win) → how many controls were rewritten.
pub(crate) fn sync(s: &mut Session, edited: bool) -> Result<usize, CmdError> {
    let stale = if edited {
        s.doc.sync_bindings()
    } else {
        let mut v: Vec<_> = s
            .doc
            .bound_controls()
            .into_iter()
            .filter_map(|(r, name, text)| s.doc.core_value(name).filter(|v| *v != text).map(|v| (r, v.to_string())))
            .collect();
        v.sort_by(|a, b| (b.0.start.story, &b.0.start.path, b.0.start.off).cmp(&(a.0.start.story, &a.0.start.path, a.0.start.off)));
        v
    };
    let n = stale.len();
    // Last first, so the earlier controls' positions hold.
    for (r, value) in stale {
        fill(s, &r, &value)?;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use crate::{Selection, Session};
    use serde_json::json;
    use ew_doc::{Document, Pos};

    /// A control bound to Title shows it, an edit in the control gives Title its text and the other bound control follows,
    /// setting Title rewrites them, and the binding is read back from .docx.
    #[test]
    fn bound_controls_follow_their_property() {
        let mut s = Session::new(Document::from_text("a b"));
        s.run("file.properties", &json!({"title": "Report"})).unwrap();
        s.sel = Selection::caret(Pos::body(0, 1));
        s.run("developer.insertBound", &json!({"property": "title"})).unwrap();
        let shown = |s: &Session| s.doc.bound_controls().into_iter().map(|(_, n, t)| (n, t)).collect::<Vec<_>>();
        assert_eq!(shown(&s), [("title", "Report".to_string())]);
        s.sel = Selection::caret(s.doc.end_of(ew_doc::StoryRef::Body));
        s.run("developer.insertBound", &json!({"property": "title"})).unwrap();
        // Typing in the first control: the property takes its text, the second control follows.
        let r = s.doc.bound_controls()[0].0.clone();
        s.sel = Selection::caret(r.end.clone());
        s.run("text.insert", &json!({"text": " 2"})).unwrap();
        assert_eq!(s.doc.effective_core().title, "Report 2", "Info shows the edit before a sync");
        s.run("developer.syncBindings", &json!({})).unwrap();
        assert_eq!(s.doc.core.title, "Report 2");
        assert_eq!(shown(&s).iter().filter(|(_, t)| t == "Report 2").count(), 2);
        s.run("file.properties", &json!({"title": "Final"})).unwrap();
        assert_eq!(shown(&s).iter().filter(|(_, t)| t == "Final").count(), 2);
        let back = ew_docx::read(&ew_docx::write(&s.doc).unwrap()).unwrap();
        assert_eq!(back.bound_controls().into_iter().map(|(_, n, t)| (n, t)).collect::<Vec<_>>(), shown(&s));
        assert_eq!(back.core.title, "Final");
        // An empty property shows the placeholder.
        s.run("file.properties", &json!({"title": ""})).unwrap();
        assert!(s.doc.bound_controls().iter().all(|(r, _, t)| r.control.showing_placeholder && t.is_empty()));
    }
}
