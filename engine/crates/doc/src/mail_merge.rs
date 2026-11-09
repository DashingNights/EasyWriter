//! EasyWriter: a mail merge kept with the document (Mailings; docs/plans/engine/stage2.md G7). Word keeps a main document's
//! merge in its settings (`w:mailMerge`, ECMA-376 §17.14): the kind of document, the data source, the query that filters and
//! sorts it, the field mapping (`w:odso/w:fieldMapData`), the records left out (`w:recipientData`), whether the merged data shows
//! (`w:viewMergedData`) and the record shown (`w:activeRecord`). Word links the list's file; a draft has no file to link, so
//! the list's fields and records are kept here too, and the canvas draft's record saves them with the rest of the model.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// A Filter Recipients comparison.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    Equal,
    NotEqual,
    Less,
    Greater,
    LessOrEqual,
    GreaterOrEqual,
    Blank,
    NotBlank,
    Contains,
    NotContains,
}

impl FilterOp {
    /// Every comparison, in the order the dialog lists them.
    pub const ALL: [FilterOp; 10] = [
        FilterOp::Equal,
        FilterOp::NotEqual,
        FilterOp::Less,
        FilterOp::Greater,
        FilterOp::LessOrEqual,
        FilterOp::GreaterOrEqual,
        FilterOp::Blank,
        FilterOp::NotBlank,
        FilterOp::Contains,
        FilterOp::NotContains,
    ];

    /// The id used in command params.
    pub fn id(self) -> &'static str {
        match self {
            FilterOp::Equal => "equal",
            FilterOp::NotEqual => "notEqual",
            FilterOp::Less => "less",
            FilterOp::Greater => "greater",
            FilterOp::LessOrEqual => "lessOrEqual",
            FilterOp::GreaterOrEqual => "greaterOrEqual",
            FilterOp::Blank => "blank",
            FilterOp::NotBlank => "notBlank",
            FilterOp::Contains => "contains",
            FilterOp::NotContains => "notContains",
        }
    }

    /// The dialog's label (English source text).
    pub fn label(self) -> &'static str {
        match self {
            FilterOp::Equal => "Equal to",
            FilterOp::NotEqual => "Not equal to",
            FilterOp::Less => "Less than",
            FilterOp::Greater => "Greater than",
            FilterOp::LessOrEqual => "Less than or equal",
            FilterOp::GreaterOrEqual => "Greater than or equal",
            FilterOp::Blank => "Is blank",
            FilterOp::NotBlank => "Is not blank",
            FilterOp::Contains => "Contains",
            FilterOp::NotContains => "Does not contain",
        }
    }

    /// An id, a symbol (`=`, `<>`, `<`, `>`, `<=`, `>=`) or a spelled-out alias, any case. The app's Filter and Sort dialog
    /// names them `eq`, `ne`, `lt`, `gt`, `le`, `ge`, `blank`, `nonblank`, `contains` and `notContains`.
    pub fn parse(t: &str) -> Option<FilterOp> {
        let k: String = t.trim().chars().filter(|c| !matches!(c, ' ' | '_' | '-')).collect::<String>().to_ascii_lowercase();
        Some(match k.as_str() {
            "equal" | "equals" | "equalto" | "=" | "==" | "eq" => FilterOp::Equal,
            "notequal" | "notequalto" | "<>" | "!=" | "ne" => FilterOp::NotEqual,
            "less" | "lessthan" | "<" | "lt" => FilterOp::Less,
            "greater" | "greaterthan" | ">" | "gt" => FilterOp::Greater,
            "lessorequal" | "lessthanorequal" | "<=" | "le" => FilterOp::LessOrEqual,
            "greaterorequal" | "greaterthanorequal" | ">=" | "ge" => FilterOp::GreaterOrEqual,
            "blank" | "isblank" | "empty" => FilterOp::Blank,
            "notblank" | "nonblank" | "isnotblank" | "notempty" => FilterOp::NotBlank,
            "contains" => FilterOp::Contains,
            "notcontains" | "doesnotcontain" => FilterOp::NotContains,
            _ => return None,
        })
    }

    /// Whether the comparison takes a value (Is blank / Is not blank don't).
    pub fn has_value(self) -> bool {
        !matches!(self, FilterOp::Blank | FilterOp::NotBlank)
    }
}

/// One Filter Recipients row: `field op value`, joined to the row before by And (`or` false) or
/// Or. And binds tighter than Or: `a And b Or c` keeps records matching both a and b, or c.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterRule {
    pub field: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub or: bool,
}

/// One Sort Recipients key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub field: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub descending: bool,
}

/// The merge a main document holds. Its default is no merge: a normal document without a list.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MailMerge {
    /// Start Mail Merge's kind: `letters`, `emails`, `envelopes`, `labels` or `directory` (Word's `formLetters`, `email`,
    /// `envelopes`, `mailingLabels` and `catalog`); empty or `normal` for an ordinary document.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// The list's name: the file it came from, or what Type a New List calls it.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub source: String,
    /// The list's fields (its columns) and every record, in the list's order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub records: Vec<Vec<String>>,
    /// The records unticked in Mail Merge Recipients, by index in `records`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub excluded: Vec<u32>,
    /// Filter Recipients and Sort Recipients.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub filter: Vec<FilterRule>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sort: Vec<SortKey>,
    /// Match Fields: Word's address field (the app's key, such as `first` or `address1`) → the list's column. An address field
    /// without an entry matches a column by name.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub map: BTreeMap<String, String>,
    /// The records the merge goes through, in order: indices into `records`, ticked, filtered and sorted ([`Self::reselect`]).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub active: Vec<u32>,
    /// Preview Results is on, and the record it shows: a position in `active` (0 = the first).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub preview: bool,
    pub record: u32,
    /// The Envelope Options and Label Options last picked, as the dialogs give them (they open with these again).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub envelope: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<Value>,
}

impl MailMerge {
    /// Whether this is a merge at all: a kind other than a normal document, or a list.
    pub fn is_empty(&self) -> bool {
        (self.kind.is_empty() || self.kind == "normal") && self.fields.is_empty() && self.records.is_empty()
    }

    /// Whether a list is attached (fields, even with no records yet).
    pub fn has_list(&self) -> bool {
        !(self.fields.is_empty() && self.records.is_empty())
    }

    /// The column of `field` (any case).
    pub fn column(&self, field: &str) -> Option<usize> {
        let f = field.trim();
        self.fields.iter().position(|h| h == f).or_else(|| self.fields.iter().position(|h| h.eq_ignore_ascii_case(f)))
    }

    /// The record at position `at` of the merge (`active`), when there is one.
    pub fn row(&self, at: usize) -> Option<&Vec<String>> {
        self.active.get(at).and_then(|i| self.records.get(*i as usize))
    }

    /// Field `field` of the record at position `at` of the merge; empty when either is missing.
    pub fn value(&self, at: usize, field: &str) -> String {
        match (self.row(at), self.column(field)) {
            (Some(r), Some(c)) => r.get(c).cloned().unwrap_or_default(),
            _ => String::new(),
        }
    }

    /// Recomputes `active` from the records, the ticks, the filter and the sort (rules and keys on a field the list lacks
    /// go), and keeps the record shown inside it.
    pub fn reselect(&mut self) {
        let fields = &self.fields;
        self.filter.retain(|r| fields.iter().any(|h| h.eq_ignore_ascii_case(r.field.trim())));
        self.sort.retain(|k| fields.iter().any(|h| h.eq_ignore_ascii_case(k.field.trim())));
        let n = self.records.len();
        self.excluded.retain(|i| (*i as usize) < n);
        self.excluded.sort_unstable();
        self.excluded.dedup();
        let left_out = &self.excluded;
        self.active = select_records(&self.fields, &self.records, &self.filter, &self.sort)
            .into_iter()
            .filter(|i| left_out.binary_search(&(*i as u32)).is_err())
            .map(|i| i as u32)
            .collect();
        if self.active.is_empty() {
            self.preview = false;
            self.record = 0;
        } else {
            self.record = self.record.min(self.active.len() as u32 - 1);
        }
    }
}

/// Two cell values compared: numbers (compared numerically) before text (compared case-insensitively). A total order, so
/// sorting stays consistent (and can't panic) on columns that mix numbers and text, such as `9`, `10`, `1A`.
pub fn compare_cells(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering::{Greater, Less};
    let number = |s: &str| s.parse::<f64>().ok().filter(|x| x.is_finite());
    let (a, b) = (a.trim(), b.trim());
    match (number(a), number(b)) {
        (Some(x), Some(y)) => x.total_cmp(&y),
        (Some(_), None) => Less,
        (None, Some(_)) => Greater,
        (None, None) => a.to_lowercase().cmp(&b.to_lowercase()),
    }
}

fn rule_holds(r: &FilterRule, cell: &str) -> bool {
    use std::cmp::Ordering::{Equal, Greater, Less};
    let ord = || compare_cells(cell, &r.value);
    let lower = || (cell.to_lowercase(), r.value.trim().to_lowercase());
    match r.op {
        FilterOp::Equal => ord() == Equal,
        FilterOp::NotEqual => ord() != Equal,
        FilterOp::Less => ord() == Less,
        FilterOp::Greater => ord() == Greater,
        FilterOp::LessOrEqual => ord() != Greater,
        FilterOp::GreaterOrEqual => ord() != Less,
        FilterOp::Blank => cell.trim().is_empty(),
        FilterOp::NotBlank => !cell.trim().is_empty(),
        FilterOp::Contains => {
            let (c, v) = lower();
            c.contains(&v)
        }
        FilterOp::NotContains => {
            let (c, v) = lower();
            !c.contains(&v)
        }
    }
}

/// The records (indices into `rows`) that `filter` keeps, in `sort` order (stable: ties keep the
/// list's order). Rules and keys naming a field that isn't in `headers` are ignored.
pub fn select_records(headers: &[String], rows: &[Vec<String>], filter: &[FilterRule], sort: &[SortKey]) -> Vec<usize> {
    let col = |f: &str| headers.iter().position(|h| h.eq_ignore_ascii_case(f.trim()));
    let rules: Vec<(Option<usize>, &FilterRule)> = filter.iter().map(|r| (col(&r.field), r)).filter(|(c, _)| c.is_some()).collect();
    let keep = |row: &Vec<String>| {
        if rules.is_empty() {
            return true;
        }
        // Or-groups of And-ed rules.
        let mut any = false;
        let mut all = true;
        for (k, (c, r)) in rules.iter().enumerate() {
            if k > 0 && r.or {
                any |= all;
                all = true;
            }
            let cell = c.and_then(|c| row.get(c)).map(String::as_str).unwrap_or("");
            all = all && rule_holds(r, cell);
        }
        any || all
    };
    let mut out: Vec<usize> = rows.iter().enumerate().filter(|(_, r)| keep(r)).map(|(i, _)| i).collect();
    let keys: Vec<(usize, bool)> = sort.iter().filter_map(|k| col(&k.field).map(|c| (c, k.descending))).collect();
    if !keys.is_empty() {
        out.sort_by(|a, b| {
            for (c, desc) in &keys {
                let get = |i: &usize| rows.get(*i).and_then(|r| r.get(*c)).map(String::as_str).unwrap_or("");
                let o = compare_cells(get(a), get(b));
                let o = if *desc { o.reverse() } else { o };
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
            }
            std::cmp::Ordering::Equal
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn people() -> MailMerge {
        MailMerge {
            kind: "letters".into(),
            fields: vec!["Name".into(), "City".into()],
            records: vec![vec!["Ana".into(), "Rome".into()], vec!["Ben".into(), "Oslo".into()], vec!["Cy".into(), "Rome".into()]],
            ..Default::default()
        }
    }

    #[test]
    fn reselect_ticks_filters_and_sorts() {
        let mut m = people();
        m.reselect();
        assert_eq!(m.active, [0, 1, 2]);
        m.excluded = vec![2, 2, 9];
        m.filter = vec![FilterRule { field: "city".into(), op: FilterOp::Equal, value: "rome".into(), or: false }];
        m.reselect();
        assert_eq!((m.active.as_slice(), m.excluded.as_slice()), ([0u32].as_slice(), [2u32].as_slice()), "a tick out and a filter; 9 is no record");
        m.excluded.clear();
        m.sort = vec![SortKey { field: "Name".into(), descending: true }];
        m.record = 5;
        m.reselect();
        assert_eq!((m.active.clone(), m.record), (vec![2, 0], 1), "Cy before Ana; the record shown stays in the list");
        assert_eq!(m.value(0, "city"), "Rome");
    }

    #[test]
    fn a_merge_round_trips_through_json() {
        let mut m = people();
        m.map.insert("first".into(), "Name".into());
        m.filter = vec![FilterRule { field: "City".into(), op: FilterOp::NotBlank, value: String::new(), or: true }];
        m.reselect();
        let text = serde_json::to_string(&m).unwrap_or_default();
        assert!(text.contains("\"notBlank\"") && !text.contains("\"preview\""), "{text}");
        assert_eq!(serde_json::from_str::<MailMerge>(&text).ok(), Some(m));
        assert!(MailMerge::default().is_empty() && !people().is_empty());
    }
}
