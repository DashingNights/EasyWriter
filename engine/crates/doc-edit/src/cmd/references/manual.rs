//! References › Table of Contents › Manual Table (stage 2 gap G45): Word's table of typed entries, no field, in a Table of
//! Contents gallery control; and the table of contents blocks Save Selection to Table of Contents Gallery takes.

use serde_json::Value;
use ew_doc::props::{CharProps, TabAlign, TabStop};
use ew_doc::{Block, ContentControl, ControlKind, Paragraph, Path, Pos, StoryRef};

use super::{delete_selection, leader, sel_result, toc};
use crate::{CmdError, CmdResult, Session, p};

/// The gallery Word's tables of contents are placed from (`w:docPartGallery`).
pub(super) const TOC_GALLERY: &str = "Table of Contents";

/// Manual Table: a heading and Word's four typed entries (levels 1, 2, 3 and 1 again, page numbers 1 to 4) at the right margin
/// with a dot leader, in a Table of Contents control so Remove Table of Contents and the gallery find it.
pub(super) fn manual_toc(s: &mut Session, v: &Value) -> CmdResult {
    let title = p::str(v, "title").unwrap_or("Table of Contents").to_string();
    let lead = leader(p::str(v, "tabLeader").unwrap_or("dot"));
    let at = delete_selection(s)?;
    if at.story != StoryRef::Body || at.path.depth() > 0 {
        return Err(CmdError::Failed("a table of contents goes in the main text".into()));
    }
    let width = crate::cmd::page::sect(s).text_width();
    let entry = |level: u8, page: u8| {
        let mut p = Paragraph::with_text(&format!("Type chapter title (level {level})\t{page}"), CharProps::default()).styled(&format!("TOC{level}"));
        p.props.tabs = Some(vec![TabStop { pos: width, align: TabAlign::Right, leader: lead }]);
        Block::Para(p)
    };
    let blocks =
        [Block::Para(Paragraph::with_text(&title, CharProps::default()).styled("TOCHeading")), entry(1, 1), entry(2, 2), entry(3, 3), entry(1, 4)];
    let i = if s.doc.para_at(&at).is_some_and(|p| p.is_empty()) {
        let i = at.path.last();
        s.doc.remove_block(StoryRef::Body, &at.path)?;
        i
    } else if at.off == 0 {
        at.path.last()
    } else {
        s.doc.split_paragraph(&at)?.path.last()
    };
    let n = blocks.len();
    for (k, b) in blocks.into_iter().enumerate() {
        s.doc.insert_block(StoryRef::Body, &Path::top(i + k), b)?;
    }
    let ctl = ContentControl::new(ControlKind::Gallery { list: false, gallery: TOC_GALLERY.into(), category: String::new(), unique: true });
    let first = Pos { story: StoryRef::Body, path: Path::top(i), off: 0 };
    crate::cmd::controls::insert_block(s, ctl, &first, &Pos { path: Path::top(i + n - 1), ..first.clone() })?;
    s.sel = crate::Selection::caret(Pos { path: Path::top(i + 1), ..first });
    sel_result(s)
}

/// The top-level blocks of the manual table of contents the caret is in, or of the first one when `anywhere`.
pub(super) fn manual_range(s: &Session, anywhere: bool) -> Option<(usize, usize)> {
    let at = &s.sel.focus;
    s.doc.control_ranges(StoryRef::Body).into_iter().find_map(|r| {
        let toc = matches!(&r.control.kind, ControlKind::Gallery { gallery, .. } if gallery == TOC_GALLERY);
        let top = r.depth == 0 && r.start.path.depth() == 0 && r.end.path.depth() == 0;
        let (a, b) = (r.start.path.last(), r.end.path.last());
        let here = at.story == StoryRef::Body && (a..=b).contains(&at.path.0.first().map_or(usize::MAX, |x| *x as usize));
        (toc && top && (anywhere || here)).then_some((a, b))
    })
}

/// Removes the manual table of contents `a..=b` (Remove Table of Contents takes it as Word does).
pub(super) fn remove_manual(s: &mut Session, (a, b): (usize, usize)) -> Result<(), CmdError> {
    for i in (a..=b).rev() {
        let path = Path::top(i);
        match s.doc.para_mut(StoryRef::Body, &path) {
            Ok(p) if p.section.is_some() => *p = Paragraph { section: p.section.take(), ..Paragraph::new() },
            _ => {
                s.doc.remove_block(StoryRef::Body, &path)?;
            }
        }
    }
    if s.doc.body.is_empty() {
        s.doc.insert_block(StoryRef::Body, &Path::top(0), Block::Para(Paragraph::new()))?;
    }
    s.clamp_selection();
    Ok(())
}

/// The top-level blocks of the table of contents the caret is in, its heading included: the engine's field table, else a
/// manual one (Save Selection to Table of Contents Gallery saves them whole).
pub fn toc_blocks_at(s: &Session) -> Option<(usize, usize)> {
    if toc::caret_in_toc(s)
        && let Some((start, end)) = toc::toc_range(s)
    {
        let titled = start
            .checked_sub(1)
            .and_then(|i| s.doc.body.get(i))
            .and_then(|b| b.as_para())
            .is_some_and(|p| p.props.style.as_deref() == Some("TOCHeading") && p.section.is_none());
        return Some((if titled { start - 1 } else { start }, end));
    }
    manual_range(s, false)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Manual Table puts Word's four typed entries in a control; Remove Table of Contents takes it all away.
    #[test]
    fn manual_table_in_and_out() {
        let mut s = Session::new(ew_doc::Document::from_text("Body text"));
        s.run("caret.docStart", &json!({})).unwrap();
        s.run("references.manualToc", &json!({})).unwrap();
        let text = s.doc.plain_text(StoryRef::Body);
        assert!(text.contains("Table of Contents") && text.contains("Type chapter title (level 3)\t3"), "{text:?}");
        assert!(manual_range(&s, true).is_some());
        assert!(s.why_disabled("references.removeToc").is_none(), "Remove Table of Contents takes a manual table");
        s.run("references.removeToc", &json!({})).unwrap();
        assert!(manual_range(&s, true).is_none());
        assert_eq!(s.doc.plain_text(StoryRef::Body).trim(), "Body text");
    }
}
