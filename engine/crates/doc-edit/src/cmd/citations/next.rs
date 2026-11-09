//! EasyWriter engine-gaps-rest: Mark Citation's Next Citation on the canvas engine: the next text in the main text that looks
//! like a legal authority, as the DOM editor's dialog finds it (wp/index-toa/index.mjs CITATION, an unverified list): " v. ",
//! "In re", "Id.", "§" and "Supra", case ignored.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;
use ew_doc::{Pos, StoryRef};

use crate::cmd::sel_result;
use crate::{CmdError, CmdResult, Selection, Session};

fn citation() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\sv\.\s|\bIn re\b|\bId\.|§|\bSupra\b").expect("the citation pattern"))
}

/// Selects the next citation after the selection in the main text (the spaces around " v. " left out).
pub(super) fn next_citation(s: &mut Session, _: &Value) -> CmdResult {
    let (_, end) = s.sel.ordered();
    let from = if end.story == StoryRef::Body { end } else { s.doc.start_of(StoryRef::Body) };
    let last = s.doc.end_of(StoryRef::Body);
    for path in s.doc.paths_between(&from, &last) {
        let Some(p) = s.doc.para(StoryRef::Body, &path) else { continue };
        let start = if path == from.path { from.off.min(p.text.len()) } else { 0 };
        let Some(m) = p.text.get(start..).and_then(|t| citation().find(t)) else { continue };
        let found = m.as_str();
        let a = start + m.start() + (found.len() - found.trim_start().len());
        let b = start + m.start() + found.trim_end().len();
        s.sel = Selection { anchor: Pos::new(StoryRef::Body, path.clone(), a), focus: Pos::new(StoryRef::Body, path, b) };
        return sel_result(s);
    }
    Err(CmdError::Failed("there are no more citations after the selection".into()))
}

#[cfg(test)]
mod tests {
    use crate::Session;
    use serde_json::json;
    use ew_doc::{Document, Pos};

    #[test]
    fn next_citation_walks_the_citations_in_order() {
        let mut s = Session::new(Document::from_text("See Smith v. Jones here.\nNothing.\nIn re Gault and § 12."));
        let text = |s: &Session| s.selected_text();
        s.run("references.nextCitation", &json!({})).unwrap();
        assert_eq!(text(&s), "v.");
        s.run("references.nextCitation", &json!({})).unwrap();
        assert_eq!(text(&s), "In re");
        assert_eq!(s.sel.anchor.path, Pos::body(2, 0).path);
        s.run("references.nextCitation", &json!({})).unwrap();
        assert_eq!(text(&s), "§");
        assert!(s.run("references.nextCitation", &json!({})).is_err(), "none left");
    }
}
