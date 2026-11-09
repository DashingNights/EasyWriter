//! References: citations and bibliography (APA, MLA, Chicago, IEEE, Harvard, ISO 690, Turabian,
//! GB/T 7714, GOST, SIST02), source manager, index, table of figures, cross-references, table
//! of authorities, footnote options.

use serde_json::{Value, json};
use ew_doc::collate::{SortKey, heading_letter, sort_key};
use ew_doc::para::InlineObject;
use ew_doc::props::{CharProps, TabAlign, TabLeader, TabStop};
use ew_doc::{Block, Document, Paragraph, Path, Pos, Source, StoryRef};

use super::references::FieldCode;
use super::{delete_selection, sel_result};
use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

mod cross_refs;
mod next;
mod generated;
mod render;
mod sources;
mod styles;

use cross_refs::cross_ref;
use next::next_citation;
pub use cross_refs::{caption_labels, ref_targets};
#[cfg(test)]
use generated::ENTRY_STYLE;
pub(crate) use generated::generated_list;
use generated::table_of_figures;
pub use generated::{figures_instr, update_generated};
pub use render::{cite, entry};
pub use sources::update_citations;
use sources::{citation, cited_tags, sources};
pub use styles::{Cite, CiteStyle, Name, Names, Order, STYLES, find_style, style};

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("references.sources", "Manage Sources", "References › Citations & Bibliography", sources)
            .params(r#"{"add"?: Source, "remove"?: tag, "import"?: path (a Word bibliography file, `b:Sources` / `Sources.xml`)} → list"#),
        // Pure, for Insert Citation's gallery and Source Manager (stage 2 gap G46): what references.sources lists, without
        // the power to change it, plus the tags cited in the body and the style in use.
        CommandSpec::new("references.citations", "Citations", "References › Citations & Bibliography", |s, _| {
            Ok(json!({"style": s.bib_style, "sources": s.doc.sources, "cited": cited_tags(&s.doc)}))
        })
        .params(r#"{} → {style, sources: [Source], cited: [tag] (in the body's order)}"#)
        .pure(),
        CommandSpec::new("references.citation", "Insert Citation", "References › Citations & Bibliography", citation).params(r#"{"tag"?: string, "source"?: Source (added if new), "pages"?: string}"#),
        CommandSpec::new("references.citationStyle", "Style", "References › Citations & Bibliography", |s, v| {
            let st = p::str(v, "style").unwrap_or("APA");
            let st = find_style(st).ok_or_else(|| {
                CmdError::Params(format!("style must be one of {:?}", STYLES.iter().map(|x| x.name).collect::<Vec<_>>()))
            })?;
            s.bib_style = st.name.to_string();
            // Recorded in the document too, so a save keeps it.
            s.doc.settings.bib_style = Some(st.name.to_string());
            update_citations(s)?;
            Ok(json!({"style": s.bib_style}))
        })
        // The Style box shows the style in use.
        .state(|s| (Value::Null, json!(s.bib_style)))
        .params(
            r#"{"style": "APA|Chicago|GB/T 7714|GOST (name sort)|GOST (title sort)|Harvard (Anglia)|IEEE|ISO 690 (author-date)|ISO 690 (numerical)|MLA|SIST02|Turabian" (Word's style names work too)}"#,
        ),
        CommandSpec::new("references.bibliography", "Bibliography", "References › Citations & Bibliography", |s, v| {
            let title = p::str(v, "title").unwrap_or(style(&s.bib_style).bib_title).to_string();
            generated_list(s, "BIBLIOGRAPHY", &title)?;
            sel_result(s)
        })
        .params(r#"{"title"?: string}"#),
        // Word's Update Citations and Bibliography: the other fields and lists stay as they are.
        CommandSpec::new("references.updateCitations", "Update Citations and Bibliography", "References › Citations & Bibliography", |s, _| {
            sources::update_bibliography(s)?;
            sel_result(s)
        }),
        CommandSpec::new("references.tableOfFigures", "Insert Table of Figures", "References › Captions", table_of_figures).params(
            r#"{"label"?: "Figure|Table|Equation" or a caption label of your own, "includeLabel"?: bool, "pageNumbers"?: bool, "rightAlign"?: bool, "tabLeader"?: "dot|hyphen|underscore|none"}"#,
        ),
        CommandSpec::new("references.updateFigures", "Update Table", "References › Captions", |s, _| {
            update_generated(s)?;
            sel_result(s)
        })
        .when(|s| (!generated::has_figures(s)).then_some("the document has no table of figures")),
        CommandSpec::new("references.markCitation", "Mark Citation", "References › Table of Authorities", mark_citation)
            .params(r#"{"entry"?: string (the long citation; default: the selection), "short"?: string (default: the long one), "category"?: 1-16 (default 1, Cases), "all"?: bool (Mark All: every later place the short citation appears in the main text gets a short TA too), "shortOnly"?: bool (a short citation marked already: this place gets a short TA)} → {"entry", "short", "category", "marked"}"#)
            .key(super::non_mac("Alt+Shift+I")),
        // EasyWriter engine-gaps-rest: Mark Citation's Next Citation on the canvas engine.
        CommandSpec::new("references.nextCitation", "Next Citation", "References › Table of Authorities", next_citation)
            .params(r#"{} (selects the next text after the selection that looks like a legal authority: " v. ", In re, Id., §, Supra)"#)
            .pure(),
        CommandSpec::new("references.tableOfAuthorities", "Insert Table of Authorities", "References › Table of Authorities", table_of_authorities)
            .params(r#"{"category"?: 1-16 | "all" (all: one list for each category marked, under its name), "passim"?: bool (five or more pages read "passim"), "tabLeader"?: "dot|hyphen|underscore|none", "names"?: {"8".."16": name} (the categories renamed)} (none of them: one list of every citation)"#),
        CommandSpec::new("references.updateAuthorities", "Update Table", "References › Table of Authorities", |s, _| {
            update_generated(s)?;
            sel_result(s)
        }),
        CommandSpec::new("insert.crossReference", "Cross-reference", "Insert › Links", cross_ref)
            .params(r#"{"to": "heading|bookmark|figure|table|equation|label:<Name> (a caption label of your own)", "target": string (text / name / number), "show"?: "text|page|number|aboveBelow"} or {} to list targets"#),
        CommandSpec::new("references.noteOptions", "Footnote and Endnote", "References › Footnotes", super::references::note_options).params(
            r#"{"kind"?: "footnote|endnote", "pos"?: "pageBottom|beneathText" (footnotes) | "sectEnd|docEnd" (endnotes), "numFmt"?: "decimal|lowerRoman|upperRoman|lowerLetter|upperLetter|…", "numStart"?: 1-32767, "numRestart"?: "continuous|eachSect|eachPage" (each page: footnotes only), "scope"?: "document|section", "footnoteFormat"?: …, "endnoteFormat"?: …} — no settings: the options in effect at the caret"#,
        ),
        CommandSpec::new("references.researcher", "Researcher", "References › Research", |s, _| {
            s.status = "Researcher needs an online service; EasyWriter keeps your documents offline.".into();
            Ok(json!({"available": false}))
        })
        .pure(),
    ]
}

/// Word's Table of Authorities categories 1 to 7; 8 to 16 are named by their number until renamed.
pub const TOA_CATEGORIES: [&str; 7] = ["Cases", "Statutes", "Other Authorities", "Rules", "Treatises", "Regulations", "Constitutional Provisions"];

/// A TA field's long citation, short citation and category (`\l`, `\s`, `\c`).
pub(crate) fn ta_parts(instr: &str) -> (Option<String>, Option<String>, Option<u32>) {
    let f = FieldCode::parse(instr);
    let arg = |c| f.arg(c).map(str::trim).filter(|x| !x.is_empty()).map(str::to_string);
    (arg('l'), arg('s'), arg('c').and_then(|c| c.parse().ok()))
}

/// Mark Citation (gap G47): a hidden TA field after the selection with the long and short citations and the category; Mark All
/// also marks every later place the short citation appears in the main text with a short TA, as Word's does.
fn mark_citation(s: &mut Session, v: &Value) -> CmdResult {
    let entry = p::str(v, "entry").map(str::to_string).unwrap_or_else(|| s.selected_text().trim().to_string());
    let entry = entry.trim().to_string();
    if entry.is_empty() {
        return Err(CmdError::Params("select a citation or give `entry`".into()));
    }
    let short = p::str(v, "short").map(str::trim).filter(|x| !x.is_empty()).unwrap_or(&entry).to_string();
    let category = p::u64(v, "category").unwrap_or(1).clamp(1, 16);
    let q = |x: &str| x.replace('"', "");
    let ta = |instr: String| InlineObject::Field { instr, result: String::new(), locked: false, dirty: false, code: false, form: String::new() };
    let hidden = CharProps { hidden: Some(true), ..Default::default() };
    let (_, b) = s.sel.ordered();
    let mut marked = 1;
    if p::bool(v, "all").unwrap_or(false) {
        // Later places first, so the earlier ones keep their offsets.
        for at in later_places(s, &b, &short).into_iter().rev() {
            s.doc.insert_object(&at, ta(format!("TA \\s \"{}\"", q(&short))), &hidden)?;
            marked += 1;
        }
    }
    // A short citation picked from those marked already marks this place with it alone, as Word's dialog does.
    let instr = if p::bool(v, "shortOnly").unwrap_or(false) {
        format!("TA \\s \"{}\"", q(&short))
    } else {
        format!("TA \\l \"{}\" \\s \"{}\" \\c {category}", q(&entry), q(&short))
    };
    s.doc.insert_object(&b, ta(instr), &hidden)?;
    Ok(json!({"entry": entry, "short": short, "category": category, "marked": marked}))
}

/// The ends of the places `text` appears in the main text after `from`, in order; a generated list's entries (a table of
/// authorities or contents) are no places to mark.
fn later_places(s: &Session, from: &Pos, text: &str) -> Vec<Pos> {
    let mut out = Vec::new();
    if text.is_empty() {
        return out;
    }
    let generated = |p: &Paragraph| p.props.style.as_deref().is_some_and(|st| st == generated::ENTRY_STYLE || st.starts_with("TOC"));
    for path in s.doc.para_paths(StoryRef::Body) {
        let Some(p) = s.doc.para(StoryRef::Body, &path).filter(|p| !generated(p)) else { continue };
        for (i, _) in p.text.match_indices(text) {
            let start = Pos { story: StoryRef::Body, path: path.clone(), off: i };
            if start >= *from {
                out.push(Pos { off: i + text.len(), ..start });
            }
        }
    }
    out
}

/// Insert Table of Authorities (gap G47): with no settings one list of every citation, as before; with a category one list
/// under its name, or ("all") one for each category the TA fields use; passim and the tab leader as the dialog gives them.
fn table_of_authorities(s: &mut Session, v: &Value) -> CmdResult {
    let set = ["category", "passim", "tabLeader"].iter().any(|k| v.get(*k).is_some());
    if !set {
        generated_list(s, "TOA", "Table of Authorities")?;
        return sel_result(s);
    }
    let name = |c: u32| -> String {
        let renamed = v.get("names").and_then(|n| n.get(c.to_string())).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty());
        renamed.map(str::to_string).unwrap_or_else(|| TOA_CATEGORIES.get(c as usize - 1).map_or_else(|| c.to_string(), |x| (*x).to_string()))
    };
    let cats: Vec<u32> = match v.get("category") {
        Some(c) if c.as_str() == Some("all") || c.is_null() => used_categories(s),
        Some(c) => vec![c.as_u64().or_else(|| c.as_str().and_then(|x| x.parse().ok())).unwrap_or(1).clamp(1, 16) as u32],
        None => used_categories(s),
    };
    if cats.is_empty() {
        return Err(CmdError::Failed("No table of authorities entries found. Mark citations first.".into()));
    }
    let passim = if p::bool(v, "passim").unwrap_or(false) { " \\p" } else { "" };
    let leader = Some(crate::cmd::references::leader(p::str(v, "tabLeader").unwrap_or("dot")));
    // Each list goes in at the caret, so the last category first leaves them in order.
    for c in cats.into_iter().rev() {
        generated::generated_list_with(s, &format!("TOA \\h \\c \"{c}\"{passim}"), &name(c), leader)?;
    }
    sel_result(s)
}

/// The categories the main text's TA fields use, in order (a short TA takes its long one's).
fn used_categories(s: &Session) -> Vec<u32> {
    let mut longs: Vec<(Option<String>, Option<String>, Option<u32>)> = Vec::new();
    for path in s.doc.para_paths(StoryRef::Body) {
        let Some(p) = s.doc.para(StoryRef::Body, &path) else { continue };
        for o in &p.objects {
            if let InlineObject::Field { instr, .. } = o
                && FieldCode::parse(instr).name == "TA"
            {
                longs.push(ta_parts(instr));
            }
        }
    }
    let mut cats: Vec<u32> = longs.iter().filter(|x| x.0.is_some()).map(|x| x.2.unwrap_or(1)).collect();
    cats.sort_unstable();
    cats.dedup();
    cats
}

/// The top-level blocks of the bibliography the caret is in: its field paragraph and its entries (Save Selection to
/// Bibliography Gallery saves them whole).
pub fn bibliography_at(s: &Session) -> Option<(usize, usize)> {
    let at = &s.sel.focus;
    if at.story != StoryRef::Body {
        return None;
    }
    let here = at.path.0.first().copied()? as usize;
    generated::list_ranges(s, "BIBLIOGRAPHY").into_iter().find(|(a, b)| (*a..=*b).contains(&here))
}

#[cfg(test)]
mod tests;
