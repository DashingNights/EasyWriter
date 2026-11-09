//! A quote, code block or box around a paragraph (`Block::Container`, container.rs): the wrap, unwrap and set commands,
//! and the Enter and Backspace rules that leave one. The look comes in by style id from the caller
//! (docs/plans/word/briefs/engine-container.md, Package 2).

use std::sync::Arc;

use serde_json::Value;
use ew_doc::props::CharProps;
use ew_doc::{Block, Blocks, Container, ContainerRole, Paragraph, Path, Pos, StoryRef};

use super::{delete_selection, sel_result, split_para};
use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("container.wrap", "Quote, Code Block or Box", "Home › Paragraph", wrap).params(
            r#"{"role": "quote"|"code"|"box", "style"?: string, "language"?: string, "title"?: string, "titleStyle"?: string, "lineStyle"?: string, "spaceAfter"?: number}"#,
        ),
        CommandSpec::new("container.unwrap", "Lift out of a Quote, Code Block or Box", "Home › Paragraph", unwrap)
            .params("{}")
            .when(|s| not_in_container(s)),
        CommandSpec::new("container.set", "Change a Quote, Code Block or Box", "Home › Paragraph", set)
            .params(r#"{"language"?: string|null, "style"?: string}"#)
            .when(|s| not_in_container(s)),
    ]
}

/// Why the caret is not in a container.
fn not_in_container(s: &Session) -> Option<&'static str> {
    let story = s.sel.focus.story;
    s.doc.container_of(story, &s.sel.focus.path).is_none().then_some("the cursor isn't in a quote, code block or box")
}

/// Whether the caret is in a code block's lines (never its title: no command gives a code block one).
pub(crate) fn in_code(s: &Session) -> bool {
    s.doc.container_of(s.sel.focus.story, &s.sel.focus.path).is_some_and(|(_, r, c)| c.role == ContainerRole::Code && !c.is_title(r))
}

/// The container's body region: 0, or 1 when it has a title.
fn body_region(c: &Container) -> usize {
    usize::from(!c.title.is_empty())
}

pub(crate) fn wrap(s: &mut Session, v: &Value) -> CmdResult {
    let role = p::str(v, "role").and_then(ContainerRole::from_name).ok_or_else(|| CmdError::Params("`role` must be \"quote\", \"code\" or \"box\"".into()))?;
    let (a, b) = s.sel.ordered();
    if a.story != b.story {
        return Err(CmdError::Failed("the selection spans stories".into()));
    }
    // The lowest block level both ends share: a selection in two cells of one table takes the table.
    let common = a.path.0.iter().zip(&b.path.0).take_while(|(x, y)| x == y).count();
    let level = common - common % 3;
    let (Some(&first), Some(&last)) = (a.path.0.get(level), b.path.0.get(level)) else { return Err(CmdError::Failed("nothing to wrap".into())) };
    let at = Path(a.path.0[..=level].to_vec());

    let mut c = Container::new(role, Blocks::new());
    c.style = p::str(v, "style").map(str::to_string);
    c.language = p::str(v, "language").map(str::to_string);
    c.space_after = p::f32(v, "spaceAfter").unwrap_or(0.0);
    if let Some(title) = p::str(v, "title") {
        let mut t = Paragraph::with_text(title, CharProps::default());
        t.props.style = p::str(v, "titleStyle").map(str::to_string);
        c.title = vec![Arc::new(Block::Para(t))];
    }
    let region = body_region(&c);
    let cp = s.doc.wrap_blocks(a.story, &at, last as usize, c)?;
    // Code lines take `lineStyle`.
    if let Some(style) = p::str(v, "lineStyle").filter(|_| role == ContainerRole::Code) {
        let mut cell = cp.0.clone();
        cell.extend([region as u32, 0, 0]);
        let bl = s.doc.container_mut(a.story, &Path(cell))?;
        for b in bl.iter_mut() {
            if let Block::Para(p) = Arc::make_mut(b) {
                p.props.style = Some(style.to_string());
                p.touch();
            }
        }
    }
    // Both ends move with their blocks, into the container's body.
    let moved = |path: &Path| -> Path {
        let mut v = cp.0.clone();
        v.extend([region as u32, 0, path.0[level] - first]);
        v.extend_from_slice(&path.0[level + 1..]);
        Path(v)
    };
    s.sel = Selection { anchor: Pos { story: a.story, path: moved(&a.path), off: a.off }, focus: Pos { story: b.story, path: moved(&b.path), off: b.off } };
    sel_result(s)
}

pub(crate) fn unwrap(s: &mut Session, _: &Value) -> CmdResult {
    let story = s.sel.focus.story;
    let Some((cp, _, _)) = s.doc.container_of(story, &s.sel.focus.path) else {
        return Err(CmdError::Disabled("the cursor isn't in a quote, code block or box".into()));
    };
    let first = s.doc.unwrap_container(story, &cp)?;
    s.sel = Selection::caret(s.doc.clamp(&Pos { story, path: first, off: 0 }));
    sel_result(s)
}

fn set(s: &mut Session, v: &Value) -> CmdResult {
    let story = s.sel.focus.story;
    let Some((cp, _, _)) = s.doc.container_of(story, &s.sel.focus.path) else {
        return Err(CmdError::Disabled("the cursor isn't in a quote, code block or box".into()));
    };
    let Some(block) = s.doc.block(story, &cp) else { return Err(CmdError::Failed("the container is no longer there".into())) };
    let mut c = block.as_container().cloned().ok_or_else(|| CmdError::Failed("the container is no longer there".into()))?;
    if let Some(language) = v.get("language") {
        c.language = language.as_str().map(str::to_string);
    }
    if let Some(style) = p::str(v, "style") {
        c.style = Some(style.to_string());
    }
    let i = cp.last();
    let bl = s.doc.container_mut(story, &cp)?;
    if i >= bl.len() {
        return Err(CmdError::Failed("the container is no longer there".into()));
    }
    bl[i] = Arc::new(Block::Container(c));
    sel_result(s)
}

/// Enter in a container: the brief's structural rules. `false` lets the plain Enter run.
pub(crate) fn enter(s: &mut Session) -> Result<bool, CmdError> {
    // A tracked edit does what it does in a table cell: never a paragraph out of its container untracked.
    if s.doc.settings.track_changes {
        return Ok(false);
    }
    let f = s.sel.focus.clone();
    let story = f.story;
    let index = f.path.last();
    let Some(frame) = s.doc.container_of(story, &f.path).map(|(cp, r, c)| {
        let region = c.region(r);
        let para = region.and_then(|bl| bl.get(index)).and_then(|b| b.as_para());
        let above_empty = index > 0 && region.and_then(|bl| bl.get(index - 1)).and_then(|b| b.as_para()).is_some_and(Paragraph::is_empty);
        (
            cp,
            r,
            c.role,
            !c.title.is_empty(),
            c.is_title(r),
            region.map_or(0, Vec::len),
            para.is_some_and(Paragraph::is_empty),
            para.is_none_or(|p| s.doc.styles.resolve_para(&p.props).numbering.is_none_or(|n| n.num == 0)),
            above_empty,
        )
    }) else {
        return Ok(false);
    };
    let (cp, _region, role, titled, is_title, len, empty, unnumbered, above_empty) = frame;

    if is_title {
        // Never split the title: clear the selection and go to the start of the body.
        delete_selection(s)?;
        let mut body = cp.0.clone();
        body.extend([1, 0, 0]);
        let at = s.doc.clamp(&Pos { story, path: Path(body), off: 0 });
        s.sel = Selection::caret(at);
        return Ok(true);
    }
    if role == ContainerRole::Code {
        // The third Enter: two empty lines at the end go, and the caret leaves the block.
        if index + 1 == len && empty && above_empty {
            let bl = s.doc.container_mut(story, &f.path)?;
            bl.truncate(index - 1);
            if bl.is_empty() {
                bl.push(Arc::new(Block::Para(Paragraph::new())));
            }
            let at = para_after(s, story, &cp)?;
            s.sel = Selection::caret(at);
            return Ok(true);
        }
        let at = delete_selection(s)?;
        let at = split_para(s, &at)?;
        s.sel = Selection::caret(at);
        return Ok(true);
    }
    // A quote's or box's body.
    if index + 1 == len && empty && unnumbered {
        if len > 1 {
            s.doc.remove_block(story, &f.path)?;
            let at = para_after(s, story, &cp)?;
            s.sel = Selection::caret(at);
            return Ok(true);
        }
        if titled {
            let at = para_after(s, story, &cp)?;
            s.sel = Selection::caret(at);
            return Ok(true);
        }
        let first = s.doc.unwrap_container(story, &cp)?;
        s.sel = Selection::caret(s.doc.clamp(&Pos { story, path: first, off: 0 }));
        return Ok(true);
    }
    Ok(false)
}

/// An empty paragraph after the container at `cp`: where Enter leaves it.
fn para_after(s: &mut Session, story: StoryRef, cp: &Path) -> Result<Pos, CmdError> {
    let path = cp.with_last(cp.last() + 1);
    s.doc.insert_block(story, &path, Block::Para(Paragraph::new()))?;
    Ok(Pos { story, path, off: 0 })
}

/// Backspace at the first block of a container region. `false` lets the plain Backspace run.
pub(crate) fn backspace(s: &mut Session, f: &Pos) -> Result<bool, CmdError> {
    if s.doc.settings.track_changes || f.path.last() != 0 {
        return Ok(false);
    }
    let story = f.story;
    let Some((cp, role, titled, is_title, region_len)) =
        s.doc.container_of(story, &f.path).map(|(cp, r, c)| (cp, c.role, !c.title.is_empty(), c.is_title(r), c.region(r).map_or(0, Vec::len)))
    else {
        return Ok(false);
    };
    // The title, or a code block's first line: the container is lifted out.
    if is_title || role == ContainerRole::Code {
        let first = s.doc.unwrap_container(story, &cp)?;
        s.sel = Selection::caret(s.doc.clamp(&Pos { story, path: first, off: 0 }));
        return Ok(true);
    }
    // The body of a box with a title: the caret goes to the end of the title.
    if titled {
        let mut t = cp.0.clone();
        t.extend([0, 0, 0]);
        let title = Path(t);
        let end = s.doc.para(story, &title).map_or(0, Paragraph::len);
        s.sel = Selection::caret(Pos { story, path: title, off: end });
        return Ok(true);
    }
    // The body with no title: its first block moves out before the container.
    let block = {
        let bl = s.doc.container_mut(story, &f.path)?;
        if bl.is_empty() {
            return Ok(false);
        }
        bl.remove(0)
    };
    let i = cp.last();
    let outer = s.doc.container_mut(story, &cp)?;
    if region_len == 1 {
        // The container held nothing else: it goes, and the block takes its place.
        outer.remove(i);
    }
    outer.insert(i, block);
    if outer.last().is_some_and(|b| b.as_para().is_none()) {
        outer.push(Arc::new(Block::Para(Paragraph::new())));
    }
    s.sel = Selection::caret(Pos { story, path: cp, off: 0 });
    Ok(true)
}

/// Paste in a container: plain text into one title line or into code lines; unchanged anywhere else.
pub(crate) fn plain_paste(s: &Session, frag: ew_doc::edit::Fragment) -> ew_doc::edit::Fragment {
    let f = s.sel.focus.clone();
    let Some((_, region, c)) = s.doc.container_of(f.story, &f.path) else { return frag };
    let at = s.doc.para_at(&f);
    if c.is_title(region) {
        let text = frag.plain_text().replace(['\r', '\n'], " ");
        let mut p = Paragraph::with_text(text.trim_end(), CharProps::default());
        p.props = at.map(|p| p.props.clone()).unwrap_or_default();
        return ew_doc::edit::Fragment { blocks: vec![Block::Para(p)], ..Default::default() };
    }
    if c.role == ContainerRole::Code {
        let mut out = ew_doc::edit::Fragment::from_text(&frag.plain_text());
        let props = at.map(|p| p.props.clone()).unwrap_or_default();
        for b in &mut out.blocks {
            if let Block::Para(p) = b {
                p.props = props.clone();
            }
        }
        out.parts = frag.parts;
        return out;
    }
    frag
}

/// Drop the container a review just emptied: every paragraph in it, the title included, is empty.
pub(crate) fn drop_if_empty(s: &mut Session, story: StoryRef, path: &Path) -> Result<(), CmdError> {
    let mut at = path.clone();
    while let Some((cp, _, c)) = s.doc.container_of(story, &at) {
        if c.regions().iter().any(|(_, bl)| !all_empty(bl)) {
            return Ok(());
        }
        at = cp.clone();
        s.doc.remove_block(story, &cp)?;
    }
    Ok(())
}

/// Whether every paragraph in `bl`, however deep, is empty.
fn all_empty(bl: &Blocks) -> bool {
    bl.iter().all(|b| match &**b {
        Block::Para(p) => p.is_empty(),
        other => other.lists().iter().all(|(_, _, list)| all_empty(list)),
    })
}
