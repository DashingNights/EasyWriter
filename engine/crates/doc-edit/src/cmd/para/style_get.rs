//! `styles.get` and Word's latent built-in styles (docs/plans/engine/stage2.md G10).
//!
//! A latent style is one Word knows by name though the document does not define it yet: Manage
//! Styles and the style lists show it, and applying it adds its built-in definition to the
//! document first, as Word does.

use serde_json::{Value, json};
use ew_doc::numbering::ListKind;
use ew_doc::props::{NumRef, ParaProps};
use ew_doc::styles::{Style, StyleKind, StyleSheet};
use ew_doc::CharProps;

use crate::{CmdError, CmdResult, Session, p};

/// The latent built-in styles, by id (stage2.md G10).
const LATENT: [&str; 9] = ["Strong", "Emphasis", "Heading4", "Heading5", "Heading6", "Heading7", "Heading8", "Heading9", "ListBullet"];

/// Latent style `name_or_id`'s built-in definition, or None when it is not one of LATENT.
fn latent_def(name_or_id: &str) -> Option<Style> {
    let key: String = name_or_id.chars().filter(|c| !c.is_whitespace()).collect();
    let id = LATENT.iter().find(|id| id.eq_ignore_ascii_case(&key))?;
    if *id == "ListBullet" {
        // Word's List Bullet: Normal with a bullet list, its paragraphs held together by contextual spacing. The list itself
        // is made when the style is added (`ensure_style`).
        return Some(Style {
            id: "ListBullet".into(),
            name: "List Bullet".into(),
            kind: StyleKind::Paragraph,
            based_on: Some("Normal".into()),
            para: ParaProps { contextual_spacing: Some(true), ..ParaProps::default() },
            priority: Some(99),
            builtin: true,
            ..Style::default()
        });
    }
    StyleSheet::builtin().get(id).cloned()
}

/// The latent styles the document does not define yet, none of them in the Styles gallery until the document has it.
pub(super) fn latent_missing(sheet: &StyleSheet) -> Vec<Style> {
    LATENT
        .iter()
        .filter(|id| sheet.get(id).is_none())
        .filter_map(|id| latent_def(id))
        .filter(|st| sheet.find(&st.name).is_none())
        .map(|st| Style { quick: false, ..st })
        .collect()
}

/// The id of style `name` (its name or id), adding a latent built-in style to the document first when it lacks it.
pub(crate) fn ensure_style(s: &mut Session, name: &str) -> Result<String, CmdError> {
    if let Some(st) = s.doc.styles.find(name) {
        return Ok(st.id.clone());
    }
    let mut st = latent_def(name).ok_or_else(|| CmdError::Params(format!("no style `{name}`")))?;
    if st.id == "ListBullet" {
        let num = s.doc.numbering_mut().add_list(ListKind::Bullet);
        st.para.numbering = Some(NumRef { num, level: 0 });
    }
    let id = st.id.clone();
    s.doc.styles_mut().upsert(st);
    Ok(id)
}

/// One entry of styles.list for latent style `st`.
pub(super) fn latent_entry(st: &Style) -> Value {
    json!({"id": st.id, "name": st.name, "kind": st.kind, "quick": false, "basedOn": st.based_on, "latent": true})
}

/// `styles.get {style}`: style `style` (name, alias or id) → {id, name, aliases, type, basedOn, next, linked, builtIn, latent, hidden,
/// inGallery, priority, para, chr (its own properties, the engine's serde names), resolved {para, chr} (with its based-on chain
/// and the document defaults), table (a table style's own parts) and tableResolved (its parts with the chain merged)}.
pub(super) fn get(s: &mut Session, v: &Value) -> CmdResult {
    let name = p::req_str(v, "style")?;
    let sheet: &StyleSheet = &s.doc.styles;
    let (st, latent) = match sheet.find(name) {
        Some(st) => (st.clone(), false),
        None => (latent_def(name).ok_or_else(|| CmdError::Params(format!("no style `{name}`")))?, true),
    };
    // A latent style resolves against a copy of the sheet that holds it.
    let mut with;
    let sheet = if latent {
        with = sheet.clone();
        with.upsert(st.clone());
        &with
    } else {
        sheet
    };
    let ty = match st.kind {
        StyleKind::Paragraph if st.linked.is_some() => "linked",
        StyleKind::Paragraph => "paragraph",
        StyleKind::Character => "character",
        StyleKind::Table => "table",
        StyleKind::Numbering => "numbering",
    };
    let resolved = match st.kind {
        StyleKind::Character => json!({"chr": sheet.resolve_char(None, &CharProps { style: Some(st.id.clone()), ..CharProps::default() })}),
        StyleKind::Table => {
            let t = sheet.table_style(&st.id).unwrap_or_default();
            json!({"para": sheet.resolve_para_in(&ParaProps::default(), Some(&t.para)), "chr": sheet.resolve_char_in(None, Some(&t.chr), &CharProps::default())})
        }
        _ => json!({
            "para": sheet.resolve_para(&ParaProps { style: Some(st.id.clone()), ..ParaProps::default() }),
            "chr": sheet.resolve_char(Some(&st.id), &CharProps::default()),
        }),
    };
    let table_resolved = (st.kind == StyleKind::Table).then(|| sheet.table_style(&st.id).map(|t| t.parts)).flatten();
    Ok(json!({
        "id": st.id,
        "name": st.name,
        "aliases": st.aliases,
        "type": ty,
        "basedOn": st.based_on,
        "next": st.next,
        "linked": st.linked,
        "builtIn": st.builtin,
        "latent": latent,
        "hidden": st.hidden,
        "inGallery": !latent && st.quick && !st.hidden && st.kind != StyleKind::Table,
        "priority": st.priority,
        "para": st.para,
        "chr": st.chr,
        "resolved": resolved,
        "table": st.table,
        "tableResolved": table_resolved,
    }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use ew_doc::styles::{Style, StyleSheet};

    use crate::Session;

    /// A document as a file brings it: Normal and Table Grid only, so the latent styles are missing.
    fn bare() -> Session {
        let mut s = Session::new(ew_doc::Document::from_text("Some text"));
        let builtin = StyleSheet::builtin();
        let mut sheet = StyleSheet::empty();
        for id in ["Normal", "DefaultParagraphFont", "TableNormal", "TableGrid"] {
            sheet.upsert(builtin.get(id).cloned().unwrap());
        }
        s.doc.styles = sheet.into();
        s
    }

    /// A paragraph style's own and resolved properties; a table style's parts.
    #[test]
    fn gets_definition_resolved_and_table_parts() {
        let mut s = Session::new(ew_doc::Document::from_text("Some text"));
        let h = s.run("styles.get", &json!({"style": "Heading 1"})).unwrap();
        assert_eq!(h["id"], json!("Heading1"));
        assert_eq!(h["basedOn"], json!("Normal"));
        assert_eq!(h["chr"]["size"], json!(20.0), "its own size: {h}");
        assert_eq!(h["resolved"]["chr"]["size"], json!(20.0));
        assert_eq!(h["resolved"]["para"]["keepNext"], json!(true), "{h}");
        assert!(h["resolved"]["chr"]["font"].is_string(), "fonts resolve through the chain: {h}");
        let t = s.run("styles.get", &json!({"style": "TableGrid"})).unwrap();
        assert_eq!(t["type"], json!("table"));
        assert!(t["table"]["borders"].is_object(), "{t}");
        assert!(t["tableResolved"]["borders"].is_object(), "{t}");
        assert!(s.run("styles.get", &json!({"style": "No Such Style"})).is_err());
        assert!(s.registry.get("styles.get").is_some_and(|c| !c.mutates), "a query");
    }

    /// Strong, Emphasis, Heading 4 to 9 and List Bullet show in Manage Styles and the style list while the document lacks them;
    /// styles.get reads one, and applying one adds it to the document.
    #[test]
    fn latent_styles_list_get_and_apply() {
        let mut s = bare();
        let manage = s.run("styles.manage", &json!({})).unwrap();
        let ids: Vec<&str> = manage.as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap()).collect();
        for id in ["Strong", "Emphasis", "Heading4", "Heading9", "ListBullet"] {
            assert!(ids.contains(&id), "{id} in Manage Styles: {ids:?}");
        }
        let latent = manage.as_array().unwrap().iter().find(|x| x["id"] == json!("Strong")).unwrap();
        assert_eq!(latent["latent"], json!(true));
        assert_eq!(latent["inGallery"], json!(false), "not in the Styles gallery until the document has it");
        let list = s.run("styles.list", &json!({})).unwrap();
        assert!(list.as_array().unwrap().iter().any(|x| x["id"] == json!("ListBullet") && x["latent"] == json!(true)), "{list}");
        let g = s.run("styles.get", &json!({"style": "Heading 5"})).unwrap();
        assert_eq!(g["latent"], json!(true));
        assert!(s.doc.styles.get("Heading5").is_none(), "reading adds nothing");

        s.run("para.style", &json!({"style": "ListBullet"})).unwrap();
        let st: &Style = s.doc.styles.get("ListBullet").expect("applying adds the style");
        let num = st.para.numbering.expect("List Bullet brings a bullet list");
        assert_ne!(num.num, 0);
        s.run("select.all", &json!({})).unwrap();
        s.run("format.charStyle", &json!({"style": "Strong"})).unwrap();
        assert!(s.doc.styles.get("Strong").is_some());
        let again = s.run("styles.manage", &json!({})).unwrap();
        let strong = again.as_array().unwrap().iter().find(|x| x["id"] == json!("Strong")).unwrap();
        assert!(strong.get("latent").is_none_or(|l| l == &json!(false)), "defined now: {strong}");
    }
}
