//! The style sheet as the style panes and dialogs read and write it on a canvas draft (docs/plans/engine/stage2b.md,
//! engine-gaps-styles; stage2.md G10 and G42): the whole sheet in one read, a style created or replaced whole (Create New
//! Style; Modify Style, Manage Styles and the Organizer send only what they changed), the document defaults (Set As Default, Manage Styles' Set Defaults)
//! and how many paragraphs and runs use each style (the Styles pane's Select All n Instances).

use std::collections::BTreeMap;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use ew_doc::props::ParaProps;
use ew_doc::styles::{Style, StyleKind};
use ew_doc::{Block, Blocks, CharProps, StoryRef};

use super::touch_all;
use crate::{CmdError, CmdResult, Session, p};

/// Word's limit on a style name.
const MAX_NAME: usize = 253;

/// The type the style lists show for `st`: a paragraph style with a character half is linked.
pub(super) fn type_name(st: &Style) -> &'static str {
    match st.kind {
        StyleKind::Paragraph if st.linked.is_some() => "linked",
        StyleKind::Paragraph => "paragraph",
        StyleKind::Character => "character",
        StyleKind::Table => "table",
        StyleKind::Numbering => "numbering",
    }
}

/// `styles.get {}` with no style: the whole sheet → {defaults: {chr, para}, styles: [{id, name, type, basedOn, next, linked,
/// aliases, builtIn, hidden, unhideWhenUsed, quick, priority, locked, para, chr}]}, the document's own styles in sheet order (latent built-ins left
/// out: `styles.list` names them).
pub(super) fn sheet(s: &Session) -> Value {
    let sh = &s.doc.styles;
    let styles: Vec<Value> = sh
        .styles
        .iter()
        .map(|st| {
            json!({
                "id": st.id, "name": st.name, "aliases": st.aliases, "type": type_name(st), "basedOn": st.based_on, "next": st.next,
                "linked": st.linked, "builtIn": st.builtin, "hidden": st.hidden, "unhideWhenUsed": st.hidden && !st.hidden_always, "quick": st.quick, "priority": st.priority, "locked": st.locked,
                "para": st.para, "chr": st.chr,
            })
        })
        .collect();
    json!({"defaults": {"chr": sh.default_chr, "para": sh.default_para}, "styles": styles})
}

fn props<T: DeserializeOwned>(v: &Value, key: &str) -> Result<Option<T>, CmdError> {
    v.get(key).filter(|x| !x.is_null()).map(|x| serde_json::from_value(x.clone())).transpose().map_err(|e| CmdError::Params(format!("`{key}`: {e}")))
}

/// `base` with the properties of `v[key]` over it: a key given replaces that property and a `null` takes it off, so a dialog
/// sends only what it changed and the properties it does not know (numbering, bidi, text effects) stay.
fn merged<T: Serialize + DeserializeOwned>(base: &T, v: &Value, key: &str) -> Result<Option<T>, CmdError> {
    let Some(patch) = v.get(key).filter(|x| !x.is_null()) else { return Ok(None) };
    let Some(patch) = patch.as_object() else { return Err(CmdError::Params(format!("`{key}` must be an object"))) };
    let mut out = serde_json::to_value(base).map_err(|e| CmdError::Failed(e.to_string()))?;
    let o = out.as_object_mut().ok_or_else(|| CmdError::Failed(format!("`{key}` is not an object")))?;
    for (k, x) in patch {
        if x.is_null() {
            o.remove(k);
        } else {
            o.insert(k.clone(), x.clone());
        }
    }
    serde_json::from_value(out).map(Some).map_err(|e| CmdError::Params(format!("`{key}`: {e}")))
}

/// The id of style `name` (name or id), or an error naming it.
fn id_of(s: &Session, name: &str) -> Result<String, CmdError> {
    s.doc.styles.find(name).map(|x| x.id.clone()).ok_or_else(|| CmdError::Params(format!("no style `{name}`")))
}

/// A `null` or a style reference for `key`: Some(None) clears it, Some(Some(id)) sets it, None leaves it. `own` is the style
/// being defined, which a new style's Style for following paragraph names before the sheet holds it.
fn reference(s: &Session, v: &Value, key: &str, own: &Style) -> Result<Option<Option<String>>, CmdError> {
    match v.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(n)) if n.trim().is_empty() => Ok(Some(None)),
        Some(Value::String(n)) if *n == own.id || n.eq_ignore_ascii_case(&own.name) => Ok(Some(Some(own.id.clone()))),
        Some(Value::String(n)) => id_of(s, n).map(|id| Some(Some(id))),
        Some(_) => Err(CmdError::Params(format!("`{key}` must be a style name, id or null"))),
    }
}

/// `styles.define {style?, name?, type?, basedOn?, next?, chr?, para?, quick?, hidden?, unhideWhenUsed?, priority?, locked?}`:
/// style `style` (name or id) gets the fields given, `chr` and `para` over its own (a `null` property takes it off); without
/// `style`, or with one the sheet lacks, a new style named `name` is made (Word's new styles sit in the gallery at priority
/// 99). A built-in style keeps its name, which Word knows it by: another `name` becomes its alias, as Rename does in Word.
/// Type `linked` is a paragraph style with a character half ("<name> Char") that holds the same character formatting.
/// One undo step. → {id}.
pub(super) fn define(s: &mut Session, v: &Value) -> CmdResult {
    let want = p::str(v, "style").map(str::trim).filter(|x| !x.is_empty());
    let name = p::str(v, "name").map(str::trim).filter(|x| !x.is_empty()).map(str::to_string);
    if name.as_ref().is_some_and(|n| n.chars().count() > MAX_NAME) {
        return Err(CmdError::Params(format!("a style name has at most {MAX_NAME} characters")));
    }
    let existing = want.and_then(|w| s.doc.styles.find(w)).cloned();
    let mut st = match existing {
        Some(st) => st,
        None => {
            let name = name.clone().ok_or_else(|| CmdError::Params("a new style needs `name`".into()))?;
            let id = want.filter(|w| s.doc.styles.get(w).is_none()).map_or_else(|| s.doc.styles.new_id(&name), str::to_string);
            Style { id, name: name.clone(), kind: StyleKind::Paragraph, quick: true, priority: Some(99), ..Style::default() }
        }
    };
    if let Some(n) = &name {
        // A built-in style's Rename box shows "Heading 1,Chapter": its own name, then the aliases after the commas.
        let parts: Vec<&str> = if st.builtin { n.split(',').map(str::trim).filter(|x| !x.is_empty()).collect() } else { vec![n.as_str()] };
        if let Some(taken) = parts.iter().find(|x| s.doc.styles.find(x).is_some_and(|o| o.id != st.id)) {
            return Err(CmdError::Failed(format!("a style named `{taken}` already exists")));
        }
        if !st.builtin {
            st.name.clone_from(n);
        } else {
            let aliases: Vec<&str> = parts.into_iter().filter(|x| !x.eq_ignore_ascii_case(&st.name)).collect();
            st.aliases = (!aliases.is_empty()).then(|| aliases.join(","));
        }
    }
    let linked = match p::str(v, "type") {
        None => st.kind == StyleKind::Paragraph && st.linked.is_some(),
        Some(t) => {
            st.kind = match t {
                "paragraph" | "linked" => StyleKind::Paragraph,
                "character" => StyleKind::Character,
                "table" => StyleKind::Table,
                "numbering" => StyleKind::Numbering,
                x => return Err(CmdError::Params(format!("unknown style type `{x}`"))),
            };
            t == "linked"
        }
    };
    if let Some(base) = reference(s, v, "basedOn", &st)? {
        if base.as_deref().is_some_and(|b| b == st.id || s.doc.styles.chain(b).iter().any(|x| x.id == st.id)) {
            return Err(CmdError::Failed("a style cannot be based on itself".into()));
        }
        st.based_on = base;
    }
    if let Some(next) = reference(s, v, "next", &st)? {
        st.next = next;
    }
    if let Some(c) = merged(&st.chr, v, "chr")? {
        st.chr = CharProps { style: None, ..c };
    }
    if let Some(pp) = merged(&st.para, v, "para")? {
        st.para = ParaProps { style: None, ..pp };
    }
    if let Some(q) = p::bool(v, "quick") {
        st.quick = q;
    }
    if let Some(h) = p::bool(v, "hidden") {
        st.hidden = h;
    }
    if let Some(u) = p::bool(v, "unhideWhenUsed") {
        st.hidden_always = !u;
    }
    st.hidden_always &= st.hidden;
    if let Some(l) = p::bool(v, "locked") {
        st.locked = l;
    }
    match v.get("priority") {
        Some(Value::Null) => st.priority = None,
        Some(x) => st.priority = Some(x.as_u64().ok_or_else(|| CmdError::Params("`priority` must be 0 to 99".into()))?.min(99) as u32),
        None => {}
    }
    if st.kind == StyleKind::Character {
        st.next = None;
        st.para = ParaProps::default();
    }
    // The character half of a linked style carries its character formatting, as Word's "<name> Char" does.
    let half = if linked { Some(st.linked.clone().unwrap_or_else(|| s.doc.styles.new_id(&format!("{}Char", st.id)))) } else { None };
    if st.kind == StyleKind::Paragraph && !linked {
        st.linked = None;
    }
    st.linked = half.clone().or(st.linked.take());
    let id = st.id.clone();
    if let Some(h) = half {
        let base = s.doc.styles.get(&h).cloned();
        let mut c = base.unwrap_or(Style {
            id: h.clone(),
            name: format!("{} Char", st.name),
            kind: StyleKind::Character,
            based_on: s.doc.styles.get("DefaultParagraphFont").map(|_| "DefaultParagraphFont".to_string()),
            priority: st.priority,
            ..Style::default()
        });
        c.chr = st.chr.clone();
        c.linked = Some(id.clone());
        s.doc.styles_mut().upsert(c);
    }
    s.doc.styles_mut().upsert(st);
    touch_all(s);
    Ok(json!({"id": id}))
}

/// `styles.setDefaults {chr?, para?}`: the document defaults (`w:docDefaults`) take the properties given, over theirs (Set As
/// Default in the Font and Paragraph dialogs, Manage Styles' Set Defaults; stage2.md G42). Every style that does not set a
/// property shows the new default.
pub(super) fn set_defaults(s: &mut Session, v: &Value) -> CmdResult {
    let chr = props::<CharProps>(v, "chr")?;
    let para = props::<ParaProps>(v, "para")?;
    if chr.is_none() && para.is_none() {
        return Err(CmdError::Params("give `chr` and/or `para`".into()));
    }
    let sh = s.doc.styles_mut();
    if let Some(c) = chr {
        sh.default_chr.overlay(&CharProps { style: None, ..c });
    }
    if let Some(pp) = para {
        sh.default_para.overlay(&ParaProps { style: None, numbering: None, ..pp });
        sh.default_para_present = true;
    }
    let out = json!({"chr": sh.default_chr, "para": sh.default_para});
    touch_all(s);
    Ok(out)
}

/// `styles.usage {}`: how many paragraphs of the body use each paragraph style (no style counts as Normal) and how many
/// stretches of text each character style → {id: count}. A pane reads it while it is open, not on every keystroke.
pub(super) fn usage(s: &Session) -> Value {
    // The Styles pane reads this after each layout, so it walks the blocks in place and counts by borrowed id: building every
    // paragraph's path and an owned key per paragraph took 16 ms on the 978-page Word fixture.
    fn walk<'a>(bl: &'a Blocks, out: &mut BTreeMap<&'a str, u64>, depth: usize) {
        for b in bl.iter().filter(|_| depth <= 16) {
            match &**b {
                Block::Para(para) => {
                    *out.entry(para.props.style.as_deref().unwrap_or("Normal")).or_default() += 1;
                    let mut last: Option<&str> = None;
                    for r in &para.runs {
                        let cs = r.props.style.as_deref();
                        if let Some(id) = cs.filter(|id| Some(*id) != last) {
                            *out.entry(id).or_default() += 1;
                        }
                        last = cs;
                    }
                }
                _ => {
                    for (_, _, list) in b.lists() {
                        walk(list, out, depth + 1);
                    }
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    if let Some(bl) = s.doc.story(StoryRef::Body) {
        walk(bl, &mut out, 0);
    }
    json!(out)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::Session;

    fn session() -> Session {
        Session::new(ew_doc::Document::from_text("One\nTwo\nThree"))
    }

    /// The whole sheet reads in one call with each style's own properties and the document defaults.
    #[test]
    fn reads_the_whole_sheet() {
        let mut s = session();
        let all = s.run("styles.get", &json!({})).unwrap();
        let h1 = all["styles"].as_array().unwrap().iter().find(|x| x["id"] == json!("Heading1")).unwrap();
        assert_eq!(h1["type"], json!("linked"));
        assert_eq!(h1["chr"]["size"], json!(20.0));
        assert!(all["defaults"]["chr"].is_object(), "{all}");
        assert!(s.registry.get("styles.get").is_some_and(|c| !c.mutates));
    }

    /// A new linked style gets its character half; a define's properties go over the style's and a null takes one off; basing
    /// a style on itself is refused.
    #[test]
    fn defines_creates_and_replaces() {
        let mut s = session();
        let r = s
            .run("styles.define", &json!({"style": "Note", "name": "Note", "type": "linked", "basedOn": "Normal", "next": "Note", "chr": {"bold": true, "size": 9}}))
            .unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        let st = s.doc.styles.get(&id).unwrap().clone();
        assert_eq!(st.next.as_deref(), Some(id.as_str()), "a new style can be its own following style");
        let half = st.linked.clone().expect("a linked style has a character half");
        assert_eq!(s.doc.styles.get(&half).unwrap().chr.bold, Some(true));
        assert_eq!(st.priority, Some(99));
        s.run("styles.define", &json!({"style": "Note", "chr": {"bold": null}, "priority": 5, "quick": false})).unwrap();
        let st = s.doc.styles.get(&id).unwrap();
        assert_eq!((st.chr.bold, st.chr.size, st.priority, st.quick), (None, Some(9.0), Some(5), false));
        s.run("styles.define", &json!({"style": "Note", "basedOn": "Heading 1"})).unwrap();
        assert!(s.run("styles.define", &json!({"style": "Note", "basedOn": "Note"})).is_err());
        assert!(s.run("styles.define", &json!({"style": "Normal", "basedOn": "Note"})).is_err(), "a loop through the chain");
        assert!(s.run("styles.define", &json!({"name": "Heading 1"})).is_err(), "a taken name");
        s.run("edit.undo", &json!({})).unwrap();
        assert_eq!(s.doc.styles.get(&id).unwrap().based_on.as_deref(), Some("Normal"), "one undo step per define");
    }

    /// Modify Style OK sends only what changed, so a numbered, right-to-left heading keeps its numbering and bidi; a built-in
    /// style keeps its name and takes the new one as an alias; Hide and Hide Until Used stay apart.
    #[test]
    fn define_keeps_what_it_is_not_given() {
        let mut s = session();
        let h1 = s.doc.styles_mut().get_mut("Heading1").unwrap();
        h1.para.numbering = Some(ew_doc::props::NumRef { num: 1, level: 0 });
        h1.para.bidi = Some(true);
        s.run("styles.define", &json!({"style": "Heading1", "name": "Heading 1", "chr": {"italic": true}, "para": {"spaceAfter": 4}})).unwrap();
        let h1 = s.doc.styles.get("Heading1").unwrap();
        assert_eq!((h1.para.numbering.map(|n| n.num), h1.para.bidi, h1.chr.italic), (Some(1), Some(true), Some(true)));
        assert_eq!((h1.name.as_str(), h1.aliases.as_deref()), ("Heading 1", None));
        s.run("styles.define", &json!({"style": "Heading1", "name": "Chapter"})).unwrap();
        let h1 = s.doc.styles.get("Heading1").unwrap();
        assert_eq!((h1.name.as_str(), h1.aliases.as_deref()), ("Heading 1", Some("Chapter")), "a built-in style keeps its name");
        s.run("styles.define", &json!({"style": "Heading1", "hidden": true, "unhideWhenUsed": false})).unwrap();
        let all = s.run("styles.get", &json!({})).unwrap();
        let h1 = all["styles"].as_array().unwrap().iter().find(|x| x["id"] == json!("Heading1")).unwrap().clone();
        assert_eq!((h1["hidden"].clone(), h1["unhideWhenUsed"].clone(), h1["aliases"].clone()), (json!(true), json!(false), json!("Chapter")));
        // Both survive a .docx round trip (`w:aliases`, `w:semiHidden` without `w:unhideWhenUsed`).
        let back = crate::io::open_bytes("t.docx", &crate::io::save_bytes("t.docx", &s.doc).unwrap()).unwrap();
        let h1 = back.styles.get("Heading1").unwrap();
        assert_eq!((h1.name.as_str(), h1.aliases.as_deref(), h1.hidden, h1.hidden_always), ("Heading 1", Some("Chapter"), true, true));
        // An alias is a name in use, and Rename reads the box as "<name>,<aliases>": the built-in name alone clears them.
        assert!(s.run("styles.define", &json!({"name": "chapter"})).is_err(), "a new style cannot take an alias");
        assert_eq!(s.doc.styles.find("Chapter").map(|x| x.id.as_str()), Some("Heading1"));
        s.run("styles.define", &json!({"style": "Heading1", "name": "Heading 1,Chapter,Part"})).unwrap();
        assert_eq!(s.doc.styles.get("Heading1").unwrap().aliases.as_deref(), Some("Chapter,Part"));
        assert!(s.run("styles.define", &json!({"style": "Heading1", "name": "Heading 1,Normal"})).is_err());
        s.run("styles.define", &json!({"style": "Heading1", "name": "Heading 1"})).unwrap();
        assert_eq!(s.doc.styles.get("Heading1").unwrap().aliases, None);
    }

    /// Set As Default writes the document defaults; the usage counts paragraphs by style and runs by character style.
    #[test]
    fn sets_defaults_and_counts_usage() {
        let mut s = session();
        s.run("styles.setDefaults", &json!({"chr": {"font": "Georgia", "size": 13}, "para": {"spaceAfter": 6}})).unwrap();
        assert_eq!(s.doc.styles.default_chr.font.as_deref(), Some("Georgia"));
        assert_eq!(s.doc.styles.default_para.space_after, Some(6.0));
        s.run("para.style", &json!({"style": "Heading1"})).unwrap();
        let u = s.run("styles.usage", &json!({})).unwrap();
        assert_eq!((u["Heading1"].clone(), u["Normal"].clone()), (json!(1), json!(2)), "{u}");
    }
}
