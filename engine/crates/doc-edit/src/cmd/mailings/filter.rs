//! Filter Recipients and Sort Recipients: their params and their JSON. The rules, the keys and the selection are the
//! document's (ew_doc's mail_merge.rs).
use super::recipients::cell;
use super::{CmdError, CmdResult, FilterOp, FilterRule, MailMerge, Session, SortKey, Value, json, mm, p};

/// Most filter rows and sort keys a list keeps.
const MAX_RULES: usize = 64;

const MAX_SORT_KEYS: usize = 8;

/// The canonical field name for `f` (any case), or a params error.
fn known_field(headers: &[String], f: &str) -> Result<String, CmdError> {
    headers
        .iter()
        .find(|h| h.eq_ignore_ascii_case(f.trim()))
        .cloned()
        .ok_or_else(|| CmdError::Params(format!("no field named `{f}` in the recipient list")))
}

pub(super) fn parse_rules(headers: &[String], v: Option<&Value>) -> Result<Vec<FilterRule>, CmdError> {
    let arr = match v {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) => a,
        Some(_) => return Err(CmdError::Params("`rules` must be an array of {field, op, value, join}".into())),
    };
    if arr.len() > MAX_RULES {
        return Err(CmdError::Params(format!("at most {MAX_RULES} filter rules")));
    }
    let mut out = Vec::new();
    for r in arr {
        let field = p::str(r, "field").ok_or_else(|| CmdError::Params("each rule needs a `field`".into()))?;
        let op = p::str(r, "op").or_else(|| p::str(r, "comparison")).unwrap_or("equal");
        let op = FilterOp::parse(op).ok_or_else(|| {
            CmdError::Params(format!("unknown `op` `{op}`; one of {}", FilterOp::ALL.iter().map(|o| o.id()).collect::<Vec<_>>().join(", ")))
        })?;
        let or = match p::str(r, "join").map(|j| j.trim().to_ascii_lowercase()) {
            None => false,
            Some(j) if j == "and" => false,
            Some(j) if j == "or" => true,
            Some(_) => return Err(CmdError::Params("`join` must be \"and\" or \"or\"".into())),
        };
        let value = r.get("value").map(cell).unwrap_or_default();
        out.push(FilterRule { field: known_field(headers, field)?, op, value, or });
    }
    Ok(out)
}

pub(super) fn parse_sort(headers: &[String], v: Option<&Value>) -> Result<Vec<SortKey>, CmdError> {
    let arr: Vec<Value> = match v {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) => a.clone(),
        Some(o @ (Value::Object(_) | Value::String(_))) => vec![o.clone()],
        Some(_) => return Err(CmdError::Params("`sort` must be an array of {field, descending}".into())),
    };
    if arr.len() > MAX_SORT_KEYS {
        return Err(CmdError::Params(format!("at most {MAX_SORT_KEYS} sort keys")));
    }
    arr.iter()
        .map(|k| {
            let (field, descending) = match k {
                Value::String(f) => (f.as_str(), false),
                _ => (
                    p::str(k, "field").ok_or_else(|| CmdError::Params("each sort key needs a `field`".into()))?,
                    // The app's Filter and Sort dialog says `desc`.
                    p::bool(k, "descending").or_else(|| p::bool(k, "desc")).unwrap_or(false),
                ),
            };
            Ok(SortKey { field: known_field(headers, field)?, descending })
        })
        .collect()
}

pub(super) fn rules_json(m: &MailMerge) -> Value {
    json!(
        m.filter
            .iter()
            .map(|r| json!({"field": r.field, "op": r.op.id(), "value": r.value, "join": if r.or { "or" } else { "and" }}))
            .collect::<Vec<_>>()
    )
}

pub(super) fn sort_json(m: &MailMerge) -> Value {
    json!(m.sort.iter().map(|k| json!({"field": k.field, "descending": k.descending})).collect::<Vec<_>>())
}

pub(super) fn filter_result(s: &Session) -> CmdResult {
    let m = mm(s);
    Ok(json!({"records": m.active.len(), "of": m.records.len(), "rules": rules_json(m), "sort": sort_json(m)}))
}
