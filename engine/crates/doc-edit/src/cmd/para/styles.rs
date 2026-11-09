use super::format::fmt;
use super::lists::touch_all;
use super::{CharProps, CmdError, CmdResult, ParaProps, Pos, Session, Style, StyleKind, Value, json, p, sel_result};

pub(super) fn style_id(s: &Session, name: &str) -> Result<String, CmdError> {
    s.doc.styles.find(name).map(|x| x.id.clone()).ok_or_else(|| CmdError::Params(format!("no style `{name}`")))
}

/// Apply Styles. Pure itself: with a `style` it runs `para.style` as its own command (so undo,
/// protection, macro recording and Repeat see a real edit); without one it only shows the
/// styles pane, which is view state and never an edit.
pub(super) fn apply_styles(s: &mut Session, v: &Value) -> CmdResult {
    match v.get("style") {
        None => {
            s.view.styles_pane = true;
            Ok(json!({"pane": true}))
        }
        Some(Value::String(name)) if !name.trim().is_empty() => s.run("para.style", &json!({"style": name})),
        Some(Value::String(_)) => Err(CmdError::Params("`style` must not be empty".into())),
        Some(_) => Err(CmdError::Params("`style` must be a string (name or id)".into())),
    }
}

pub(super) fn apply_style(s: &mut Session, v: &Value) -> CmdResult {
    let name = p::req_str(v, "style")?;
    // A latent built-in style (List Bullet, Heading 4) joins the document first, as in Word.
    let id = super::style_get::ensure_style(s, name)?;
    let kind = s.doc.styles.get(&id).map(|x| x.kind).unwrap_or_default();
    if kind == StyleKind::Character {
        return crate::cmd::format::apply(s, &|c| c.style = Some(id.clone()));
    }
    // Every range of a multiple selection, each read as one selection.
    let ranges = s.multi_ranges().unwrap_or_else(|| vec![s.sel.ordered()]);
    // A style linked to a list level (a heading in a numbered-headings list) brings its number.
    let numbered = s.doc.styles.resolve_para(&ParaProps { style: Some(id.clone()), ..Default::default() }).numbering.is_some();
    fmt(s, &|p| {
        p.style = Some(id.clone());
        // Applying a heading or Normal removes direct list numbering (except list styles); a
        // numbered style's own number replaces any direct numbering, even numbering switched off.
        if numbered || ((id.starts_with("Heading") || id == "Title" || id == "Normal") && p.numbering.is_some_and(|n| n.num != 0)) {
            p.numbering = None;
        }
    })?;
    // A paragraph style resets direct character formatting that matches nothing (Word keeps
    // direct formatting unless it covers most of the paragraph; we clear font/size/colour).
    for (a, b) in ranges.into_iter().filter(|(a, b)| a.path == b.path) {
        for path in s.doc.paths_between(&a, &b) {
            let para = s.doc.para_mut(a.story, &path)?;
            let len = para.len();
            para.format(0, len, &|c| {
                c.font = None;
                c.font_cs = None;
                c.font_ea = None;
                c.size = None;
                c.size_cs = None;
                c.color = None;
            })?;
            para.mark.font = None;
            para.mark.font_cs = None;
            para.mark.font_ea = None;
            para.mark.size = None;
            para.mark.size_cs = None;
            para.mark.color = None;
        }
    }
    s.pending = None;
    sel_result(s)
}

pub(super) fn create_style(s: &mut Session, v: &Value) -> CmdResult {
    let name = p::req_str(v, "name")?.trim().to_string();
    if name.is_empty() {
        return Err(CmdError::Params("name is empty".into()));
    }
    if s.doc.styles.find(&name).is_some() {
        return Err(CmdError::Failed(format!("a style named `{name}` already exists")));
    }
    let id = s.doc.styles.new_id(&name);
    let based = p::str(v, "basedOn").and_then(|b| s.doc.styles.find(b).map(|x| x.id.clone())).or(Some("Normal".into()));
    let mut st = Style {
        id: id.clone(),
        name,
        kind: StyleKind::Paragraph,
        based_on: based,
        next: Some(id.clone()),
        quick: true,
        priority: Some(50),
        ..Default::default()
    };
    if p::bool(v, "fromSelection").unwrap_or(true)
        && let Some(para) = s.doc.para_at(&s.sel.focus)
    {
        st.para = para.props.clone();
        st.para.style = None;
        st.para.numbering = None;
        // A symbol's own font is the symbol's, not the style's.
        st.chr = para.props_at(s.sel.focus.off).clone().without_symbol();
        st.chr.style = None;
        st.chr.link = None;
        st.chr.ins = None;
        st.chr.del = None;
        st.chr.fmt_change = None;
        st.para = st.para.formatting();
    }
    s.doc.styles_mut().upsert(st);
    apply_style(s, &json!({"style": id}))?;
    Ok(json!({"id": id}))
}

pub(super) fn modify_style(s: &mut Session, v: &Value) -> CmdResult {
    let id = style_id(s, p::req_str(v, "style")?)?;
    let chr: Option<CharProps> = v.get("chr").map(|c| serde_json::from_value(c.clone())).transpose().map_err(|e| CmdError::Params(e.to_string()))?;
    let para: Option<ParaProps> =
        v.get("para").map(|c| serde_json::from_value(c.clone())).transpose().map_err(|e| CmdError::Params(e.to_string()))?;
    let next = p::str(v, "next").map(str::to_string);
    let name = p::str(v, "name").map(str::to_string);
    let st = s.doc.styles_mut().get_mut(&id).ok_or_else(|| CmdError::Params("no such style".into()))?;
    if let Some(c) = chr {
        st.chr.overlay(&c);
    }
    if let Some(pp) = para {
        st.para.overlay(&pp);
    }
    if let Some(n) = next {
        st.next = Some(n);
    }
    if let Some(n) = name.filter(|n| !n.trim().is_empty()) {
        st.name = n;
    }
    // Every paragraph's layout depends on styles: bump all revisions.
    touch_all(s);
    sel_result(s)
}

/// Update Style to Match Selection: the style takes on how the selection looks — its paragraph
/// style, character style and direct formatting, read at the start of the selection — so every
/// paragraph using the style changes. A paragraph style is then applied to the selected
/// paragraphs, whose direct formatting the style now carries is dropped (other direct formatting,
/// a bold word say, stays). The style keeps its outline level and list numbering.
pub(super) fn update_to_match(s: &mut Session, v: &Value) -> CmdResult {
    let (a, b) = s.sel.ordered();
    let Some(para) = s.doc.para_at(&a).cloned() else { return sel_result(s) };
    let id = match p::str(v, "style") {
        Some(n) => style_id(s, n)?,
        None => para.props.style.clone().unwrap_or_else(|| "Normal".into()),
    };
    let sheet = &s.doc.styles;
    let Some(target) = sheet.get(&id).cloned() else { return Err(CmdError::Params(format!("no style `{id}`"))) };
    if !matches!(target.kind, StyleKind::Paragraph | StyleKind::Character) {
        return Err(CmdError::Failed(format!("`{}` can't be updated to match the selection", target.name)));
    }
    // A symbol's own font is the symbol's, not the style's.
    let direct = if s.sel.is_collapsed() { para.props_at(a.off) } else { para.props_of_char(a.off) }.clone().without_symbol();
    let para_style = para.props.style.clone().unwrap_or_else(|| "Normal".into());
    // How the selection looks: document defaults, its paragraph style chain, its character
    // style chain, direct formatting (the resolve order, before defaults are filled in).
    let (mut want_p, mut want_c) = sheet.para_style_props(&para_style);
    let char_chain = |c: &mut CharProps, style: Option<&str>| {
        for st in style.map(|cs| sheet.chain(cs)).unwrap_or_default() {
            if matches!(st.kind, StyleKind::Character | StyleKind::Paragraph) {
                c.overlay(&st.chr);
            }
        }
    };
    char_chain(&mut want_c, direct.style.as_deref());
    want_c.overlay(&CharProps { style: None, ..direct.formatting() });
    want_p.overlay(&ParaProps { style: None, numbering: None, ..para.props.formatting() });
    // How the style looks now, in the same terms.
    let (have_p, have_c) = match target.kind {
        StyleKind::Character => {
            let (pp, mut cc) = sheet.para_style_props(&para_style);
            char_chain(&mut cc, Some(&id));
            (pp, cc)
        }
        _ => sheet.para_style_props(&id),
    };
    let chr = retarget(&target.chr, &have_c, &want_c, CHAR_KEEP)?;
    let pp = if target.kind == StyleKind::Paragraph { retarget(&target.para, &have_p, &want_p, PARA_KEEP)? } else { target.para.clone() };
    if let Some(st) = s.doc.styles_mut().get_mut(&id) {
        st.chr = chr;
        st.para = pp;
    }
    if target.kind == StyleKind::Paragraph {
        // The selected paragraphs take the style; what it now gives them needn't stay direct.
        let paths = s.doc.paths_between(&a, &b);
        for path in paths {
            let p = s.doc.para_mut(a.story, &path)?;
            p.props.style = Some(id.clone());
            p.props = strip_matching(&p.props, &want_p, PARA_KEEP);
            let len = p.len();
            p.format(0, len, &|c| *c = strip_matching(c, &want_c, CHAR_KEEP))?;
            p.mark = strip_matching(&p.mark, &want_c, CHAR_KEEP);
        }
    }
    s.pending = None;
    touch_all(s);
    sel_result(s)
}

/// Character properties Update to Match leaves alone: the character style, links and revisions.
const CHAR_KEEP: &[&str] = &["style", "link", "ins", "del", "fmtChange"];

/// Paragraph properties Update to Match leaves alone: the style, its outline level (a heading
/// stays a heading), list numbering and revisions.
const PARA_KEEP: &[&str] = &["style", "outlineLevel", "numbering", "numChange", "fmtChange"];

fn props_map<T: serde::Serialize>(t: &T) -> serde_json::Map<String, Value> {
    match serde_json::to_value(t) {
        Ok(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    }
}

/// A style's own properties `own`, changed so that its chain gives `want` where it gave `have`:
/// a property that differs is set to the wanted value, or dropped (inherited again) when the
/// selection doesn't set it at all.
fn retarget<T: serde::Serialize + serde::de::DeserializeOwned>(own: &T, have: &T, want: &T, keep: &[&str]) -> Result<T, CmdError> {
    let (mut out, have, want) = (props_map(own), props_map(have), props_map(want));
    let keys: std::collections::BTreeSet<&String> = have.keys().chain(want.keys()).collect();
    for k in keys {
        if keep.contains(&k.as_str()) || have.get(k) == want.get(k) {
            continue;
        }
        match want.get(k) {
            Some(v) => out.insert(k.clone(), v.clone()),
            None => out.remove(k),
        };
    }
    serde_json::from_value(Value::Object(out)).map_err(|e| CmdError::Failed(e.to_string()))
}

/// `direct` without the properties that have the same value in `inherited` (outside `keep`).
fn strip_matching<T: serde::Serialize + serde::de::DeserializeOwned + Clone>(direct: &T, inherited: &T, keep: &[&str]) -> T {
    let (mut out, inherited) = (props_map(direct), props_map(inherited));
    out.retain(|k, v| keep.contains(&k.as_str()) || inherited.get(k) != Some(v));
    serde_json::from_value(Value::Object(out)).unwrap_or_else(|_| direct.clone())
}

/// Delete a custom style. Text that uses it falls back to the style it was based on (or the
/// default style), styles based on it are rebased, and a custom character style linked to it
/// goes with it. Built-in styles are refused.
pub(super) fn delete_style(s: &mut Session, v: &Value) -> CmdResult {
    let id = style_id(s, p::req_str(v, "style")?)?;
    let Some(st) = s.doc.styles.get(&id).cloned() else { return Err(CmdError::Params(format!("no style `{id}`"))) };
    // Table styles: their tables take Table Grid and styles based on them keep their look.
    if st.kind == StyleKind::Table {
        let mut out = crate::cmd::table_style::delete(s, &id)?;
        if let Some(o) = out.as_object_mut() {
            let tables = o.get("tables").cloned().unwrap_or(json!(0));
            o.insert("deleted".into(), json!([id]));
            o.insert("restyled".into(), tables);
        }
        return Ok(out);
    }
    if st.builtin {
        return Err(CmdError::Failed(format!("`{}` is a built-in style and can't be deleted", st.name)));
    }
    let mut gone = vec![st.clone()];
    if let Some(partner) = st.linked.as_deref().and_then(|l| s.doc.styles.get(l))
        && !partner.builtin
        && partner.linked.as_deref() == Some(id.as_str())
    {
        gone.push(partner.clone());
    }
    let mut changed = 0;
    for g in &gone {
        s.doc.styles_mut().remove(&g.id);
        // Fall back to the base only while it is a style of the same kind that still exists.
        let base = g.based_on.clone().filter(|b| s.doc.styles.get(b).is_some_and(|x| x.kind == g.kind));
        changed += s.doc.restyle(&g.id, base);
    }
    touch_all(s);
    Ok(json!({"deleted": gone.iter().map(|g| g.id.clone()).collect::<Vec<_>>(), "restyled": changed}))
}

/// Styles gallery and style list visibility (`w:qFormat` / `w:semiHidden`).
pub(super) fn set_visibility(s: &mut Session, v: &Value) -> CmdResult {
    let id = style_id(s, p::req_str(v, "style")?)?;
    let (gallery, hidden) = (p::bool(v, "gallery"), p::bool(v, "hidden"));
    if gallery.is_none() && hidden.is_none() {
        return Err(CmdError::Params("give `gallery` and/or `hidden`".into()));
    }
    let st = s.doc.styles_mut().get_mut(&id).ok_or_else(|| CmdError::Params(format!("no style `{id}`")))?;
    if let Some(h) = hidden {
        st.hidden = h;
    }
    if let Some(g) = gallery {
        st.quick = g;
        // Showing a style in the gallery unhides it.
        if g {
            st.hidden = false;
        }
    }
    let out = json!({"style": st.id, "inGallery": st.quick && !st.hidden && st.kind != StyleKind::Table, "hidden": st.hidden});
    touch_all(s);
    Ok(out)
}

/// Insert Style Separator (Ctrl+Alt+Enter, Word's InsertStyleSeparator): a paragraph's mark becomes a style separator (hidden,
/// `w:vanish` and `w:specVanish`), so the next paragraph runs on in its line in its own style (ew-doc-layout's `run_in`). With
/// the caret at the end of a paragraph, or a selection, that paragraph's mark becomes one and the next paragraph comes up;
/// where neither text has a space at the join one goes between them: the Word fixture's styles.styleSeparator case
/// (.smoke-data/word/fixture/parts/2-styles.ps1) runs Word's InsertStyleSeparator on two paragraphs it wrote with no space,
/// and Word saved the second one starting with a space. With the caret inside a paragraph, the paragraph splits there and the
/// first part's mark becomes the separator. The caret goes to the start of the text after it.
///
/// With Track Changes on, Word's way of tracking each part (no Word probe could run InsertStyleSeparator, so this follows
/// ECMA-376): the space is a tracked insertion, as typed text is; an existing mark made hidden is a formatting change on the
/// mark (`w:rPrChange` in its `w:rPr`, §17.13.5.31), recorded after the command like any formatting
/// (`fmt_revisions::record`); a mark made by a split is a tracked insertion (`w:ins` in its `w:rPr`, §17.13.5.16), as
/// Enter's is, and formatting the author's own insertion is no change of its own.
pub(super) fn style_separator(s: &mut Session, _: &Value) -> CmdResult {
    let (at, _) = s.sel.ordered();
    let Some(para) = s.doc.para_at(&at) else { return Err(CmdError::Failed("no paragraph at the caret".into())) };
    let at_end = !s.sel.is_collapsed() || at.off >= para.len();
    let next = if at_end {
        let (story, path) = (at.story, at.path.clone());
        let next = Pos { story, path: path.with_last(path.last() + 1), off: 0 };
        let spaced = para.text.ends_with(char::is_whitespace);
        let joined = s.doc.para_at(&next).filter(|p| !spaced && !p.text.is_empty() && !p.text.starts_with(char::is_whitespace));
        if let Some(mut props) = joined.map(|p| p.props_at(0).clone()) {
            // New text, so with Track Changes on it is a tracked insertion, as typed text is (`insert_text`).
            props.ins = s.doc.settings.track_changes.then(|| crate::cmd::new_revision(s, ew_doc::RevisionKind::Insert));
            (props.del, props.fmt_change) = (None, None);
            s.doc.para_mut(story, &next.path)?.insert_text(0, " ", &props)?;
        }
        let p = s.doc.para_mut(story, &path)?;
        (p.mark.hidden, p.mark.spec_vanish) = (Some(true), Some(true));
        p.touch();
        if s.doc.para_at(&next).is_some() { next } else { Pos { off: p_len(s, &at), ..at } }
    } else {
        // As Enter splits, so with Track Changes on the new mark is a tracked insertion.
        let next = crate::cmd::split_para(s, &at)?;
        let p = s.doc.para_mut(at.story, &at.path)?;
        (p.mark.hidden, p.mark.spec_vanish) = (Some(true), Some(true));
        p.touch();
        next
    };
    s.sel = crate::Selection::caret(next);
    sel_result(s)
}

fn p_len(s: &Session, at: &Pos) -> usize {
    s.doc.para_at(at).map_or(0, |p| p.len())
}


#[cfg(test)]
mod separator_tests {
    use ew_doc::{Path, Pos, StoryRef};
    use serde_json::json;

    use crate::{Selection, Session};

    fn at(block: usize, off: usize) -> Pos {
        Pos::new(StoryRef::Body, Path::top(block), off)
    }

    fn texts(s: &Session) -> Vec<(String, bool)> {
        s.doc.body.iter().filter_map(|b| b.as_para()).map(|p| (p.text.clone(), p.is_style_separator(&s.doc.styles))).collect()
    }

    /// At the end of a paragraph its mark becomes the separator and the next paragraph comes up, a space between them (the
    /// Word fixture's styles.styleSeparator case); undo puts it back.
    #[test]
    fn at_a_paragraphs_end_its_mark_becomes_the_separator() {
        let mut s = Session::new(ew_doc::Document::from_text("Run-in heading.\nBody text."));
        s.sel = Selection::caret(at(0, "Run-in heading.".len()));
        s.run("para.styleSeparator", &json!({})).unwrap();
        assert_eq!(texts(&s), vec![("Run-in heading.".into(), true), (" Body text.".into(), false)]);
        assert_eq!(s.sel, Selection::caret(at(1, 0)));
        s.run("edit.undo", &json!({})).unwrap();
        assert_eq!(texts(&s), vec![("Run-in heading.".into(), false), ("Body text.".into(), false)]);
    }

    /// A run-in heading keeps its own contents level: the table of contents lists the heading's text alone, at its level,
    /// and the text after the separator not at all (the brief's TOC levels; Word's reason for the separator).
    #[test]
    fn a_run_in_heading_keeps_its_contents_level() {
        let mut s = Session::new(ew_doc::Document::from_text("Intro
Run-in heading.
Body text after it.
Part"));
        for (text, style) in [("Intro", "Heading 1"), ("Run-in heading.", "Heading 2"), ("Part", "Heading 1")] {
            s.run("select.text", &json!({"text": text})).unwrap();
            s.run("styles.apply", &json!({"style": style})).unwrap();
        }
        s.sel = Selection::caret(at(1, "Run-in heading.".len()));
        s.run("para.styleSeparator", &json!({})).unwrap();
        s.run("caret.docStart", &json!({})).unwrap();
        s.run("references.toc", &json!({"pageNumbers": false, "hyperlinks": false})).unwrap();
        let entries: Vec<(String, String)> = s
            .doc
            .body
            .iter()
            .filter_map(|b| b.as_para())
            .filter(|p| p.props.style.as_deref().is_some_and(|st| st.starts_with("TOC") && st != "TOCHeading"))
            .map(|p| (p.props.style.clone().unwrap(), p.plain_text()))
            .collect();
        assert_eq!(entries, [("TOC1", "Intro"), ("TOC2", "Run-in heading."), ("TOC1", "Part")].map(|(a, b)| (a.to_string(), b.to_string())));
    }

    /// Enter at the end of a run-in heading whose style has a next style (every built-in heading's) keeps the separator: it is
    /// the mark at the paragraph's end, so it goes with the new paragraph in the next style, and the body still runs on.
    #[test]
    fn enter_at_a_run_in_headings_end_keeps_the_separator() {
        let mut s = Session::new(ew_doc::Document::from_text("Run-in heading.
Body text."));
        s.run("select.text", &json!({"text": "Run-in heading."})).unwrap();
        s.run("styles.apply", &json!({"style": "Heading 2"})).unwrap();
        s.sel = Selection::caret(at(0, "Run-in heading.".len()));
        s.run("para.styleSeparator", &json!({})).unwrap();
        s.sel = Selection::caret(at(0, "Run-in heading.".len()));
        s.run("text.newParagraph", &json!({})).unwrap();
        assert_eq!(texts(&s), vec![("Run-in heading.".into(), false), ("".into(), true), (" Body text.".into(), false)]);
        let new = s.doc.body[1].as_para().unwrap();
        assert_ne!(new.props.style.as_deref(), Some("Heading2"), "the new paragraph takes the next style");
    }

    /// With Track Changes on, the space at the join is a tracked insertion, as typed text is.
    #[test]
    fn the_space_at_the_join_is_tracked() {
        let mut s = Session::new(ew_doc::Document::from_text("Run-in heading.
Body text."));
        s.doc.settings.track_changes = true;
        s.sel = Selection::caret(at(0, "Run-in heading.".len()));
        s.run("para.styleSeparator", &json!({})).unwrap();
        let body = s.doc.body[1].as_para().unwrap();
        assert_eq!(body.text, " Body text.");
        assert!(body.props_at(0).ins.is_some() && body.props_at(3).ins.is_none(), "{:?}", body.runs);
    }

    /// With Track Changes on, the mark turning into a separator is tracked too, as Word records formatting on a paragraph
    /// mark (`w:rPrChange` in the mark's `w:rPr`, ECMA-376 §17.13.5.31): Reject All puts back two paragraphs as they were.
    #[test]
    fn the_separator_is_tracked() {
        let mut s = Session::new(ew_doc::Document::from_text("Run-in heading.
Body text."));
        s.doc.settings.track_changes = true;
        s.sel = Selection::caret(at(0, "Run-in heading.".len()));
        s.run("para.styleSeparator", &json!({})).unwrap();
        let mark = &s.doc.body[0].as_para().unwrap().mark;
        let old = mark.fmt_change.as_ref().map(|c| (c.old.hidden, c.old.spec_vanish));
        assert_eq!(old, Some((None, None)), "the mark's formatting before it is kept: {mark:?}");
        s.run("review.rejectAll", &json!({})).unwrap();
        assert_eq!(texts(&s), vec![("Run-in heading.".into(), false), ("Body text.".into(), false)]);
    }

    /// Inside a paragraph with Track Changes on, the new mark is a tracked insertion, as Enter's is: Reject All joins the
    /// paragraph back.
    #[test]
    fn a_split_for_the_separator_is_tracked() {
        let mut s = Session::new(ew_doc::Document::from_text("Heading. Body"));
        s.doc.settings.track_changes = true;
        s.sel = Selection::caret(at(0, "Heading.".len()));
        s.run("para.styleSeparator", &json!({})).unwrap();
        assert!(s.doc.body[0].as_para().unwrap().mark.ins.is_some(), "the new mark is inserted");
        s.run("review.rejectAll", &json!({})).unwrap();
        assert_eq!(texts(&s), vec![("Heading. Body".into(), false)]);
    }

    /// "Hello secret world" with "secret" hidden and a plain mark.
    fn hidden_middle(mark: &ew_doc::CharProps, middle: &ew_doc::CharProps) -> Session {
        let mut s = Session::new(ew_doc::Document::from_text("Hello secret world"));
        let p = s.doc.para_mut(StoryRef::Body, &Path::top(0)).unwrap();
        p.format("Hello ".len(), "Hello secret".len(), &|c| *c = middle.clone()).unwrap();
        p.mark = mark.clone();
        s
    }

    /// Enter right after hidden text inserts the new mark there, formatted as that text (hidden), so the first part runs on
    /// into the second while hidden text does not show; the paragraph's own plain mark stays with " world" (Word keeps a
    /// paragraph's mark at its end).
    #[test]
    fn enter_after_hidden_text_keeps_the_plain_mark_at_the_end() {
        let hidden = ew_doc::CharProps { hidden: Some(true), ..Default::default() };
        let mut s = hidden_middle(&ew_doc::CharProps::default(), &hidden);
        s.sel = Selection::caret(at(0, "Hello secret".len()));
        s.run("text.newParagraph", &json!({})).unwrap();
        let (head, tail) = (s.doc.body[0].as_para().unwrap(), s.doc.body[1].as_para().unwrap());
        assert_eq!((head.text.as_str(), tail.text.as_str()), ("Hello secret", " world"));
        assert_eq!(tail.mark, ew_doc::CharProps::default(), "the tail keeps the paragraph's mark");
        assert_eq!(head.mark_hidden(&s.doc.styles, None), (true, false), "the head's new mark is hidden: {:?}", head.mark);
    }

    /// Enter then Backspace gives back the paragraph's mark whatever it is (plain, hidden, a style separator, a character
    /// style, direct formatting) and wherever the caret is, in hidden, character-styled or directly formatted text.
    #[test]
    fn enter_then_backspace_gives_back_the_mark() {
        use ew_doc::CharProps;
        let hidden = CharProps { hidden: Some(true), ..Default::default() };
        let strong = CharProps { style: Some("Strong".into()), ..Default::default() };
        let marks = [
            CharProps::default(),
            hidden.clone(),
            CharProps { hidden: Some(true), spec_vanish: Some(true), ..Default::default() },
            strong.clone(),
            CharProps { bold: Some(true), size: Some(20.0), ..Default::default() },
        ];
        let middles = [hidden, strong, CharProps { italic: Some(true), size: Some(8.0), ..Default::default() }];
        let len = "Hello secret world".len();
        for mark in &marks {
            for middle in &middles {
                for off in 0..=len {
                    let mut s = hidden_middle(mark, middle);
                    let before = s.doc.body[0].as_para().unwrap().clone();
                    s.sel = Selection::caret(at(0, off));
                    s.run("text.newParagraph", &json!({})).unwrap();
                    s.run("text.backspace", &json!({})).unwrap();
                    let p = s.doc.body[0].as_para().unwrap();
                    assert_eq!(s.doc.body.len(), 1, "joined again: mark {mark:?}, text {middle:?}, at {off}");
                    assert_eq!((&p.text, &p.runs, &p.mark), (&before.text, &before.runs, &before.mark), "mark {mark:?}, text {middle:?}, at {off}");
                }
            }
        }
    }

    /// Inside a paragraph it splits there, the first part ending in the separator.
    #[test]
    fn inside_a_paragraph_it_splits_there() {
        let mut s = Session::new(ew_doc::Document::from_text("Heading. Body"));
        s.sel = Selection::caret(at(0, "Heading.".len()));
        s.run("para.styleSeparator", &json!({})).unwrap();
        assert_eq!(texts(&s), vec![("Heading.".into(), true), (" Body".into(), false)]);
        assert_eq!(s.sel, Selection::caret(at(1, 0)));
    }
}
