//! Developer › Legacy Tools (docs/plans/engine/stage2.md gap G21): a text, check box or drop-down form field at the selection,
//! as Word inserts one: a FORMTEXT, FORMCHECKBOX or FORMDROPDOWN field whose `w:ffData` names it Text1, Check1 or Dropdown1
//! (the next free number), inside a bookmark of that name. Layout draws them from the `form` XML (ew_doc::legacy_form).

use super::{CharProps, CmdError, CmdResult, InlineObject, Selection, Session, Value, delete_selection, json, p, sel_result};

/// Five en spaces: what an empty text form field shows, as in Word.
const EMPTY_TEXT: &str = "\u{2002}\u{2002}\u{2002}\u{2002}\u{2002}";

pub(in crate::cmd) fn form_field(s: &mut Session, v: &Value) -> CmdResult {
    let kind = p::str(v, "kind").unwrap_or("text");
    let (instr, stem, body, result) = match kind {
        "text" => ("FORMTEXT", "Text", "<w:textInput/>", EMPTY_TEXT),
        "checkBox" => ("FORMCHECKBOX", "Check", r#"<w:checkBox><w:sizeAuto/><w:default w:val="0"/></w:checkBox>"#, ""),
        "dropDown" => ("FORMDROPDOWN", "Dropdown", "<w:ddList/>", EMPTY_TEXT),
        k => return Err(CmdError::Params(format!("unknown `kind` {k:?}; use text, checkBox or dropDown"))),
    };
    let taken: Vec<String> = s.doc.bookmarks().into_iter().map(|(n, _)| n).collect();
    let name = (1..).map(|n| format!("{stem}{n}")).find(|n| !taken.contains(n)).unwrap_or_default();
    let form = format!(r#"<w:ffData><w:name w:val="{name}"/><w:enabled/><w:calcOnExit w:val="0"/>{body}</w:ffData>"#);
    let props = s.typing_props();
    let at = delete_selection(s)?;
    let field = InlineObject::Field { instr: instr.into(), result: result.into(), locked: false, dirty: false, code: false, form };
    let end = s.doc.insert_object(&at, field, &props)?;
    // The bookmark goes round the field, as Word's: its end first, so the start's offset stays where the field begins.
    let end = s.doc.insert_object(&end, InlineObject::BookmarkEnd { name: name.clone() }, &CharProps::default())?;
    s.doc.insert_object(&at, InlineObject::BookmarkStart { name: name.clone() }, &CharProps::default())?;
    s.sel = Selection::caret(ew_doc::Pos { off: end.off + 1, ..end });
    s.clamp_selection();
    let mut out = sel_result(s)?;
    out["name"] = json!(name);
    Ok(out)
}
