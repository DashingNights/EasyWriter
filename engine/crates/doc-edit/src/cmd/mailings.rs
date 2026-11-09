//! Mailings tab: mail merge (recipients from CSV/JSON or an Excel/OpenDocument spreadsheet,
//! filtered and sorted; merge fields, preview, finish), envelopes and labels.
//!
//! EasyWriter: the list and the merge's choices live in the document (`Settings::mail_merge`, ew_doc's mail_merge.rs),
//! as Word keeps them in `w:mailMerge`, so a canvas draft saves and reopens them and undo takes their changes back
//! (docs/plans/engine/stage2.md G7). The session keeps only Highlight Merge Fields, which is view state.

use serde_json::{Value, json};
use ew_doc::mail_merge::MailMerge;
use ew_doc::para::InlineObject;
use ew_doc::props::{Align, CharProps};
use ew_doc::section::{SectionProps, SectionStart};
use ew_doc::{Block, Blocks, Document, Paragraph, Part, PartKind, StoryRef, Table, para_block};

use super::{delete_selection, sel_result};
use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

mod filter;
mod labels;
mod merge;
mod recipients;

use filter::{filter_result, parse_rules, parse_sort, rules_json, sort_json};
pub use labels::{ENVELOPE_SIZES, LABEL_PRODUCTS, LabelProduct};
use labels::{envelopes, labels, start_layout, update_labels};
use merge::{address_map, find_recipient, finish, go_to, merge_fields, merged, step};
pub use merge::{merge_range, refresh};
#[cfg(test)]
use merge::{mergefield_name, placeholder};
use recipients::recipients;
pub use recipients::{RECIPIENT_EXTENSIONS, is_spreadsheet_name, parse_csv};
pub use ew_doc::mail_merge::{FilterOp, FilterRule, SortKey, compare_cells, select_records};

/// The session's own mail merge state: what is not part of the document.
#[derive(Clone, Debug, Default)]
pub struct MergeState {
    /// Unused: Preview Results is the document's (`MailMerge::preview`). session/run.rs still puts it back after a
    /// command that replaced the document fails.
    pub preview: bool,
    /// Highlight Merge Fields (view state, as in Word).
    pub highlight: bool,
}

/// No merge: what a document without one reads as.
static NONE: MailMerge = MailMerge {
    kind: String::new(),
    source: String::new(),
    fields: Vec::new(),
    records: Vec::new(),
    excluded: Vec::new(),
    filter: Vec::new(),
    sort: Vec::new(),
    map: std::collections::BTreeMap::new(),
    active: Vec::new(),
    preview: false,
    record: 0,
    envelope: None,
    label: None,
};

/// Preview Results and the record it shows: Word takes no undo step for them, and Undo and Redo leave them as they are.
pub(crate) const PREVIEW_IDS: [&str; 7] =
    ["mailings.preview", "mailings.next", "mailings.previous", "mailings.first", "mailings.last", "mailings.goToRecord", "mailings.findRecipient"];

/// What Preview Results shows, for [`keep_preview`].
pub(crate) fn preview_of(s: &Session) -> (bool, u32) {
    (mm(s).preview, mm(s).record)
}

/// Puts back what Preview Results showed after Undo or Redo swapped the document in, so the snapshots' own preview does not
/// come back with them. A restored document with no recipients keeps none.
pub(crate) fn keep_preview(s: &mut Session, (preview, record): (bool, u32)) {
    let Some(m) = s.doc.settings.mail_merge.as_mut() else { return };
    let preview = preview && !m.active.is_empty();
    let record = record.min(m.active.len().saturating_sub(1) as u32);
    if (m.preview, m.record) != (preview, record) {
        (m.preview, m.record) = (preview, record);
        refresh(s);
    }
}

/// The document's merge (none reads as an empty one).
pub(crate) fn mm(s: &Session) -> &MailMerge {
    s.doc.settings.mail_merge.as_ref().unwrap_or(&NONE)
}

/// The document's merge, made when it has none.
fn mm_mut(s: &mut Session) -> &mut MailMerge {
    s.doc.settings.mail_merge.get_or_insert_with(Default::default)
}

/// Drops a merge that holds nothing, so a document that never merged saves as before.
fn tidy(s: &mut Session) {
    if s.doc.settings.mail_merge.as_ref().is_some_and(MailMerge::is_empty) {
        s.doc.settings.mail_merge = None;
    }
}

fn has_recipients(s: &Session) -> Option<&'static str> {
    if mm(s).active.is_empty() { Some("select recipients first") } else { None }
}

/// Edit Recipient List needs a list to edit (fields, even with no entries yet).
fn has_list(s: &Session) -> Option<&'static str> {
    if mm(s).has_list() { None } else { Some("select recipients first") }
}

/// The kind of merge Start Mail Merge set: `normal` for none.
fn kind_of(m: &MailMerge) -> &str {
    if m.kind.is_empty() { "normal" } else { &m.kind }
}

/// `mailings.state`: {kind, hasList, source, records (that merge), total (in the list), preview, record (1 = the first, null
/// without records), highlight, fields, envelope, label}.
fn merge_state(s: &Session) -> Value {
    let m = mm(s);
    json!({
        "kind": kind_of(m), "hasList": m.has_list(), "source": m.source, "records": m.active.len(), "total": m.records.len(),
        "preview": m.preview, "record": (!m.active.is_empty()).then_some(m.record + 1), "highlight": s.merge.highlight, "fields": m.fields,
        "envelope": m.envelope, "label": m.label,
    })
}

/// `mailings.list`: the list as Edit Recipient List shows it. `excluded` and `active` are record numbers (1 = the list's
/// first record); `active` in merge order.
fn list(s: &Session) -> Value {
    let m = mm(s);
    json!({
        "source": m.source, "fields": m.fields, "records": m.records, "excluded": m.excluded.iter().map(|i| i + 1).collect::<Vec<_>>(),
        "active": m.active.iter().map(|i| i + 1).collect::<Vec<_>>(), "rules": rules_json(m), "sort": sort_json(m), "map": m.map,
    })
}

/// The kinds of document Start Mail Merge makes. `normal` is an ordinary document again; only
/// `directory` changes how Finish & Merge joins the records (no page break between them).
pub const MERGE_KINDS: [&str; 6] = ["letters", "emails", "envelopes", "labels", "directory", "normal"];

/// Edited records keep the list's filter and sort (rules on removed fields drop); the ticks follow the records they were on
/// when the list keeps its length, else go.
fn edit_recipients(s: &mut Session, v: &Value) -> CmdResult {
    if v.get("rows").and_then(Value::as_array).is_some() {
        let before = mm(s).clone();
        recipients(s, &json!({"rows": v.get("rows"), "fields": v.get("fields"), "name": v.get("name")}))?;
        let m = mm_mut(s);
        if !v.get("name").is_some_and(Value::is_string) {
            m.source = before.source;
        }
        (m.filter, m.sort, m.map, m.kind) = (before.filter, before.sort, before.map, before.kind);
        if m.records.len() == before.records.len() {
            m.excluded = before.excluded;
        }
    }
    if let Some(ticks) = v.get("include").and_then(Value::as_array) {
        let n = mm(s).records.len();
        mm_mut(s).excluded = (0..n.min(ticks.len())).filter(|i| ticks[*i] == json!(false)).map(|i| i as u32).collect();
    } else if let Some(out) = v.get("exclude").and_then(Value::as_array) {
        mm_mut(s).excluded = out.iter().filter_map(Value::as_u64).filter(|n| *n >= 1).map(|n| (n - 1) as u32).collect();
    }
    let m = mm_mut(s);
    m.reselect();
    let r = json!({"fields": m.fields, "records": m.active.len(), "of": m.records.len()});
    refresh(s);
    Ok(r)
}

/// Match Fields: `map` ({address field: column, null or "" for none}) replaces the matching kept with the document.
fn match_fields(s: &mut Session, v: &Value) -> CmdResult {
    if let Some(map) = v.get("map").and_then(Value::as_object) {
        let fields = mm(s).fields.clone();
        let mut out = std::collections::BTreeMap::new();
        for (k, col) in map {
            let col = col.as_str().map(str::trim).unwrap_or("");
            if !col.is_empty() && !fields.iter().any(|f| f == col) {
                return Err(CmdError::Params(format!("no field named `{col}` in the recipient list")));
            }
            out.insert(k.clone(), col.to_string());
        }
        mm_mut(s).map = out;
        refresh(s);
    }
    let m = mm(s);
    Ok(json!({"fields": m.fields, "address": address_map(m), "map": merge::map_json(m)}))
}

/// `mailings.document`: a document the merge makes, as the engine's stored form for the app to open as a new draft
/// (stage2.md G24). The open document is left alone.
fn make_document(s: &mut Session, v: &Value) -> CmdResult {
    let (doc, mut info) = match p::str(v, "of").unwrap_or("merge") {
        "merge" => {
            let (doc, records) = merged(s, v)?;
            (doc, json!({"records": records}))
        }
        "labels" => labels::label_document(s, v)?,
        "envelope" => labels::envelope_document(s, v)?,
        "errors" => (errors_report(s), json!({})),
        other => return Err(CmdError::Params(format!("`of` must be merge, labels, envelope or errors, not `{other}`"))),
    };
    // The JSON file form's writer: a compact writer of its own here would add a second copy of the whole model's serialiser
    // to the .wasm (about 250 KB). The app's open reads either.
    let bytes = crate::io::save_bytes("document.json", &doc).map_err(CmdError::Failed)?;
    info["model"] = json!(String::from_utf8(bytes).map_err(|e| CmdError::Failed(e.to_string()))?);
    Ok(info)
}

/// The merge fields that name a column the list does not have.
fn unknown_fields(s: &Session) -> Vec<String> {
    merge_fields(&s.doc).into_iter().filter(|f| mm(s).column(f).is_none()).collect()
}

/// Check for Errors' report (Simulate the merge and report errors in a new document): a heading and one line per merge field
/// the list cannot fill.
fn errors_report(s: &Session) -> Document {
    let mut d = Document::new();
    let mut h = Paragraph::with_text("Mail merge errors", CharProps::default()).styled("Heading1");
    h.props.align = Some(Align::Left);
    d.body = std::iter::once(para_block(h))
        .chain(unknown_fields(s).into_iter().map(|f| {
            para_block(Paragraph::with_text(&format!("The merge field «{f}» names a column the recipient list does not have."), CharProps::default()))
        }))
        .collect();
    d.ensure_nonempty();
    d
}

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("mailings.start", "Start Mail Merge", "Mailings › Start Mail Merge", |s, v| {
            let kind = p::str(v, "kind").unwrap_or("letters").trim().to_ascii_lowercase();
            if !MERGE_KINDS.contains(&kind.as_str()) {
                return Err(CmdError::Params(format!("`kind` must be one of {}", MERGE_KINDS.join(", "))));
            }
            // Envelope Options or Label Options lay the page out as the envelope or one sheet of labels.
            start_layout(s, &kind, v)?;
            let m = mm_mut(s);
            m.kind = kind;
            if m.kind == "normal" {
                m.preview = false;
            }
            let kind = m.kind.clone();
            tidy(s);
            refresh(s);
            Ok(json!({"kind": kind}))
        })
        .params(r#"{"kind": "letters|emails|envelopes|labels|directory|normal", "envelope"?: {"w": pt, "h": pt, "size"?: name, "delivery"?: {"left"?: pt, "top"?: pt}, "ret"?: {"left"?: pt, "top"?: pt, "omit"?: bool}} (envelopes: lays the page out as the envelope), "return"?: string (the return address), "label"?: {"w", "h", "across", "down", "top", "side", "vPitch", "hPitch": pt or counts, "page": {"w", "h"}} (labels: one sheet with a Next Record field in every label but the first)}"#)
        .state(|s| (Value::Null, json!(kind_of(mm(s))))),
        // The merge for the ribbon, the wizard and the Record box (stage2.md G7, review.md gap 21). Its state is the same
        // value, so the ribbon's snapshot carries it.
        CommandSpec::new("mailings.state", "Mail Merge State", "Mailings", |s, _| Ok(merge_state(s))).pure().state(|s| (Value::Null, merge_state(s))),
        CommandSpec::new("mailings.list", "Recipient List", "Mailings › Start Mail Merge", |s, _| Ok(list(s))).pure(),
        CommandSpec::new("mailings.recipients", "Select Recipients", "Mailings › Start Mail Merge", recipients)
            .params(r#"{"csv"?: string, "path"?: string (.csv/.tsv/.txt, or a .xlsx/.xlsm/.xls/.ods workbook), "data"?: base64 (a file's bytes, as for path), "encoding"?: string (a text list's encoding, e.g. "gbk", "big5", "shift_jis", "utf-16le"; default: detected), "sheet"?: name | number (1 = first; a workbook with several sheets and no sheet answers {"sheets": [...], "chooseSheet": true} and loads nothing), "headers"?: bool (default true: the first non-blank row names the fields; false: fields are Column 1…N), "rows"?: [{field: value}] | [[value]], "fields"?: [string] (column order; required with array rows), "name"?: string (the list's name; default the file's)}"#),
        CommandSpec::new("mailings.editRecipients", "Edit Recipient List", "Mailings › Start Mail Merge", |s, v| {
            if v.get("rows").is_some() || v.get("include").is_some() || v.get("exclude").is_some() {
                return edit_recipients(s, v);
            }
            let m = mm(s);
            Ok(json!({
                "headers": m.fields,
                "rows": m.records,
                "records": m.active.len(),
                "rules": rules_json(m),
                "sort": sort_json(m),
            }))
        })
        .params(r#"{"rows"?: [{field: value}] | [[value]], "fields"?: [string], "include"?: [bool] (a tick per record, in the list's order), "exclude"?: [n] (record numbers left out, 1 = the first)} (no params: the list as {headers, rows (every record), records (how many merge), rules, sort})"#)
        .key(super::non_mac("Alt+Shift+E"))
        .when(has_list),
        CommandSpec::new("mailings.filterRecipients", "Filter Recipients", "Mailings › Start Mail Merge › Edit Recipient List", |s, v| {
            let fields = mm(s).fields.clone();
            let filter = parse_rules(&fields, v.get("rules"))?;
            let sort = match v.get("sort") {
                Some(x) => parse_sort(&fields, Some(x))?,
                None if v.get("rules").is_none() => Vec::new(),
                None => mm(s).sort.clone(),
            };
            let m = mm_mut(s);
            m.filter = filter;
            m.sort = sort;
            m.record = 0;
            m.reselect();
            refresh(s);
            filter_result(s)
        })
        .params(r#"{"rules"?: [{"field": string, "op": "equal|notEqual|less|greater|lessOrEqual|greaterOrEqual|blank|notBlank|contains|notContains", "value"?: string, "join"?: "and|or" (with the rule before; And binds tighter)}], "sort"?: [{"field": string, "descending"?: bool}]} (replaces the filter; `sort` too when given; {} clears both). Preview, Finish & Merge and labels use only the matching records, in sort order"#)
        .when(has_list),
        CommandSpec::new("mailings.sortRecipients", "Sort Recipients", "Mailings › Start Mail Merge › Edit Recipient List", |s, v| {
            let fields = mm(s).fields.clone();
            let sort = parse_sort(&fields, v.get("sort").or_else(|| v.get("field").map(|_| v)))?;
            let m = mm_mut(s);
            m.sort = sort;
            m.record = 0;
            m.reselect();
            refresh(s);
            filter_result(s)
        })
        .params(r#"{"sort"?: [{"field": string, "descending"?: bool}]} | {"field": string, "descending"?: bool} (no params: the list's own order)"#)
        .when(has_list),
        CommandSpec::new("mailings.insertField", "Insert Merge Field", "Mailings › Write & Insert Fields", |s, v| {
            let f = p::req_str(v, "field")?.to_string();
            insert_field(s, &format!("MERGEFIELD {}", quote(&f)), &format!("«{f}»"))
        })
        .params(r#"{"field": string}"#)
        .key(super::non_mac("Alt+Shift+F")),
        CommandSpec::new("mailings.addressBlock", "Address Block", "Mailings › Write & Insert Fields", |s, v| {
            insert_field(s, &field_code(v, "ADDRESSBLOCK")?, "«AddressBlock»")
        })
        .params(r#"{"code"?: string (the field's code with its switches, as the Insert Address Block dialog builds it; default ADDRESSBLOCK)}"#),
        CommandSpec::new("mailings.greetingLine", "Greeting Line", "Mailings › Write & Insert Fields", |s, v| {
            insert_field(s, &field_code(v, "GREETINGLINE")?, "«GreetingLine»")
        })
        .params(r#"{"code"?: string (the field's code with its switches, as the Insert Greeting Line dialog builds it; default GREETINGLINE)}"#),
        CommandSpec::new("mailings.rules", "Rules", "Mailings › Write & Insert Fields", |s, v| {
            let rule = p::str(v, "rule").unwrap_or("NEXT").to_ascii_uppercase();
            let instr = match rule.as_str() {
                "IF" => format!(
                    "IF {{ MERGEFIELD {} }} = \"{}\" \"{}\" \"{}\"",
                    quote(p::str(v, "field").unwrap_or("Field")),
                    p::str(v, "value").unwrap_or(""),
                    p::str(v, "then").unwrap_or(""),
                    p::str(v, "else").unwrap_or("")
                ),
                "SKIPIF" | "NEXTIF" => {
                    format!("{rule} {{ MERGEFIELD {} }} = \"{}\"", quote(p::str(v, "field").unwrap_or("Field")), p::str(v, "value").unwrap_or(""))
                }
                "MERGEREC" => "MERGEREC".into(),
                _ => "NEXT".into(),
            };
            insert_field(s, &instr, "")
        })
        .params(r#"{"rule": "IF|SKIPIF|NEXTIF|NEXT|MERGEREC", "field"?, "value"?, "then"?, "else"?}"#),
        CommandSpec::new("mailings.matchFields", "Match Fields", "Mailings › Write & Insert Fields", match_fields)
            .params(r#"{"map"?: {addressField: column | null}} (address fields: uniqueId, courtesyTitle, first, middle, last, suffix, nickname, jobTitle, company, address1, address2, city, state, postal, country, businessPhone, businessFax, homePhone, homeFax, email, webPage; no params: {fields, address, map})"#)
            .when(has_list),
        CommandSpec::new("mailings.updateLabels", "Update Labels", "Mailings › Write & Insert Fields", update_labels)
            .when(|s| if mm(s).kind == "labels" { None } else { Some("start a label merge first") }),
        CommandSpec::new("mailings.highlightFields", "Highlight Merge Fields", "Mailings › Write & Insert Fields", |s, v| {
            s.merge.highlight = p::bool(v, "value").unwrap_or(!s.merge.highlight);
            s.repaint();
            Ok(json!({"value": s.merge.highlight}))
        })
        .state(|s| (json!(s.merge.highlight), Value::Null))
        .pure(),
        CommandSpec::new("mailings.preview", "Preview Results", "Mailings › Preview Results", |s, v| {
            let on = p::bool(v, "value").unwrap_or(!mm(s).preview);
            let m = mm_mut(s);
            m.preview = on;
            let record = m.record + 1;
            refresh(s);
            Ok(json!({"preview": on, "record": record}))
        })
        .key(super::non_mac("Alt+Shift+K"))
        .when(has_recipients)
        .state(|s| (json!(mm(s).preview), Value::Null)),
        CommandSpec::new("mailings.next", "Next Record", "Mailings › Preview Results", |s, _| step(s, 1)).when(has_recipients),
        CommandSpec::new("mailings.previous", "Previous Record", "Mailings › Preview Results", |s, _| step(s, -1)).when(has_recipients),
        CommandSpec::new("mailings.first", "First Record", "Mailings › Preview Results", |s, _| go_to(s, 0)).when(has_recipients),
        CommandSpec::new("mailings.last", "Last Record", "Mailings › Preview Results", |s, _| go_to(s, i64::MAX)).when(has_recipients),
        CommandSpec::new("mailings.goToRecord", "Go to Record", "Mailings › Preview Results", |s, v| {
            let n = v.get("record").and_then(|r| r.as_i64().or_else(|| r.as_str().and_then(|t| t.trim().parse().ok())));
            let n = n.ok_or_else(|| CmdError::Params("`record` must be a record number (1 = the first)".into()))?;
            go_to(s, n.saturating_sub(1))
        })
        .params(r#"{"record": n (1 = the first; past either end goes to the first or last record)}"#)
        .when(has_recipients)
        .state(|s| (Value::Null, if mm(s).active.is_empty() { Value::Null } else { json!(mm(s).record + 1) })),
        CommandSpec::new("mailings.findRecipient", "Find Recipient", "Mailings › Preview Results", find_recipient)
            .params(r#"{"text": string, "field"?: string (look in this column only), "next"?: bool (start after the record shown and wrap round)}"#)
            .when(has_recipients),
        CommandSpec::new("mailings.checkErrors", "Check for Errors", "Mailings › Finish", |s, _| {
            let missing = unknown_fields(s);
            Ok(json!({"ok": missing.is_empty(), "unknownFields": missing, "records": mm(s).active.len()}))
        })
        .pure(),
        CommandSpec::new("mailings.finish", "Finish & Merge", "Mailings › Finish", finish)
            .params(r#"{"path"?: string (save the merged document), "records"?: "all|current" (current: the previewed record; default all, or from/to), "from"?: n, "to"?: n (record numbers, 1 = the first)}"#)
            .key(super::non_mac("Alt+Shift+N"))
            .when(has_recipients),
        CommandSpec::new("mailings.printDocuments", "Print Documents", "Mailings › Finish › Finish & Merge", |s, v| {
            let mut v = v.clone();
            if let Some(o) = v.as_object_mut() {
                o.remove("path");
            }
            let r = finish(s, &v)?;
            s.push_ui_request(json!({"open": "print"}));
            Ok(r)
        })
        .params(r#"{"records"?: "all|current", "from"?: n, "to"?: n} (merges into a new document, as Finish & Merge does, and opens Print for it)"#)
        .key(super::non_mac("Alt+Shift+M"))
        .when(has_recipients),
        CommandSpec::new("mailings.document", "Merged Document", "Mailings › Finish", make_document)
            .params(r#"{"of": "merge" (Finish & Merge: "records", "from", "to" as there) | "labels" (as mailings.labels) | "envelope" (as mailings.envelopes) | "errors" (Check for Errors' report)} → {model: the new document in the engine's stored form, ...} (the open document is left alone)"#)
            .pure(),
        CommandSpec::new("mailings.envelopes", "Envelopes", "Mailings › Create", envelopes).params(
            r#"{"delivery": string, "return"?: string, "size"?: "Envelope #10|#9|Monarch|DL|C4|C5|C6|B5", "width"?: pt, "height"?: pt, "add"?: bool (add to this document instead of a new one; an envelope added before is replaced)}"#,
        ),
        CommandSpec::new("mailings.labels", "Labels", "Mailings › Create", labels).params(
            r#"{"text"?: string, "product"?: "letter-3x10|letter-2x10|letter-2x7|letter-2x5|letter-4x20|a4-3x7|a4-2x7|a4-3x8|a4-2x4", "label"?: {"w", "h", "across", "down", "top", "side", "vPitch", "hPitch", "page": {"w", "h"}} (a sheet by its sizes, points), "rows"?: n, "cols"?: n, "fromRecipients"?: bool (one label per selected recipient, continuing across sheets), "single"?: {"row": n, "col": n}}"#,
        ),
    ]
}

/// `code` from the dialog, which must be a `kind` field, or the bare field.
fn field_code(v: &Value, kind: &str) -> Result<String, CmdError> {
    let Some(code) = p::str(v, "code").map(str::trim).filter(|c| !c.is_empty()) else { return Ok(kind.into()) };
    let head = code.split_whitespace().next().unwrap_or("");
    if !head.eq_ignore_ascii_case(kind) {
        return Err(CmdError::Params(format!("`code` must be a {kind} field")));
    }
    Ok(code.into())
}

fn quote(f: &str) -> String {
    if f.contains(' ') { format!("\"{f}\"") } else { f.to_string() }
}

fn insert_field(s: &mut Session, instr: &str, placeholder: &str) -> CmdResult {
    let props = s.typing_props();
    let at = delete_selection(s)?;
    let end = s.doc.insert_object(
        &at,
        InlineObject::Field {
            instr: instr.to_string(),
            result: placeholder.to_string(),
            locked: false,
            dirty: false,
            code: false,
            form: String::new(),
        },
        &props,
    )?;
    s.sel = Selection::caret(end);
    refresh(s);
    sel_result(s)
}

#[cfg(test)]
mod tests;
