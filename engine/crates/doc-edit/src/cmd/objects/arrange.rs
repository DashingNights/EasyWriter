use super::select::{edit_float, min_size, movable_story, obj_size, select_object, selected, with_float, with_obj};
use super::{CmdError, CmdResult, Float, InlineObject, Pos, Selection, Session, StoryRef, Value, Wrap, json, p};

/// Largest object offset or move, points.
pub(super) const MAX_OFFSET: f32 = 4000.0;

/// Resize and/or move the selected object (dragging its frame or handles).
pub(super) fn bounds(s: &mut Session, v: &Value) -> CmdResult {
    let (pos, obj) = selected(s).ok_or_else(|| CmdError::Disabled("no picture or shape selected".into()))?;
    let to = match (p::f32(v, "x"), p::f32(v, "y")) {
        (Some(x), Some(y)) => Some((x, y)),
        (None, None) => None,
        _ => return Err(CmdError::Params("`x` and `y` go together".into())),
    };
    let in_text = text_target(v, &obj)?;
    if in_text.is_some() && to.is_some() {
        return Err(CmdError::Params("`to` or `x`/`y`, not both".into()));
    }
    let (w0, h0) = obj_size(&obj);
    let min = min_size(&obj);
    let w = p::f32(v, "width").unwrap_or(w0).clamp(min, MAX_OFFSET);
    let h = p::f32(v, "height").unwrap_or(h0).clamp(min, MAX_OFFSET);
    if (w, h) != (w0, h0) {
        let theme = s.doc.settings.theme_colors.clone();
        with_obj(s, |o| {
            o.set_size(w, h);
            crate::cmd::chart::redraw(o, &theme);
            crate::cmd::smart_art::redraw(o, &theme);
        })?;
    }
    let pos = match (to, in_text) {
        (Some((x, y)), _) => move_object(s, pos, p::u64(v, "page"), x, y, (w, h))?,
        (None, Some(at)) => move_in_text(s, pos, &at)?,
        (None, None) => pos,
    };
    select_object(s, &pos);
    let o = s.doc.para_at(&pos).and_then(|p| p.object_at(pos.off)).cloned();
    Ok(json!({"object": serde_json::to_value(o).unwrap_or(Value::Null), "pos": crate::cmd::pos_json(&pos)}))
}

/// The text position in `v`'s `to`, for an In Line with Text `obj` (a floating one is placed by
/// `x`/`y`); None without one.
fn text_target(v: &Value, obj: &InlineObject) -> Result<Option<Pos>, CmdError> {
    let Some(to) = v.get("to").filter(|t| !t.is_null()) else { return Ok(None) };
    if obj.is_floating() {
        return Err(CmdError::Params("`to` places an In Line with Text object; move a floating one by `x` and `y`".into()));
    }
    crate::cmd::parse_pos(to).map(Some).ok_or_else(|| CmdError::Params("bad `to`".into()))
}

/// The text position `to` an In Line with Text object at `pos` can land at: in the object's own
/// story (a table cell there too), not inside a field's code or such (it's clamped to a
/// character).
fn landing(s: &Session, pos: &Pos, to: &Pos) -> Result<Pos, CmdError> {
    if pos.path.depth() > 0 || !movable_story(s, pos.story) {
        return Err(CmdError::Disabled("only objects in the body text, headers and footers can be moved".into()));
    }
    if to.story != pos.story || s.doc.para_at(to).is_none() {
        return Err(CmdError::Params("`to` must be a position in the object's own text".into()));
    }
    Ok(s.doc.clamp(to))
}

/// Move the In Line with Text object at `pos` to the text position `to`, where it stays In Line
/// with Text, keeping its character formatting: Word's drag of an inline picture, which lands
/// where its dashed insertion cursor was (#2233, #2234). Dropped on itself, nothing changes.
/// Returns the object's position afterwards.
fn move_in_text(s: &mut Session, pos: Pos, to: &Pos) -> Result<Pos, CmdError> {
    let to = landing(s, &pos, to)?;
    let len = ew_doc::para::OBJ.len_utf8();
    let same_para = to.path == pos.path;
    if same_para && (to.off == pos.off || to.off == pos.off + len) {
        return Ok(pos);
    }
    let para = s.doc.para_at(&pos).ok_or_else(|| CmdError::Failed("object vanished".into()))?;
    let obj = para.object_at(pos.off).cloned().ok_or_else(|| CmdError::Failed("object vanished".into()))?;
    let props = para.props_of_char(pos.off).clone();
    s.doc.delete_range(&pos, &Pos { off: pos.off + len, ..pos.clone() })?;
    let mut at = to;
    if same_para && at.off > pos.off {
        at.off = at.off.saturating_sub(len);
    }
    let at = s.doc.clamp(&at);
    s.doc.insert_object(&at, obj, &props)?;
    Ok(at)
}

/// Ctrl+drag: copy the selected object (a text box gets its own story) and move the copy to
/// (x, y), or for an In Line with Text object put it at the text position `to`, leaving the
/// original in place and the clipboard alone. The copy is selected.
pub(super) fn copy_to(s: &mut Session, v: &Value) -> CmdResult {
    let (pos, obj) = selected(s).ok_or_else(|| CmdError::Disabled("no picture or shape selected".into()))?;
    let len = ew_doc::para::OBJ.len_utf8();
    let end = Pos { off: pos.off + len, ..pos.clone() };
    if let Some(to) = text_target(v, &obj)? {
        if p::f32(v, "x").is_some() || p::f32(v, "y").is_some() {
            return Err(CmdError::Params("`to` or `x`/`y`, not both".into()));
        }
        let at = landing(s, &pos, &to)?;
        let frag = s.doc.copy_range(&pos, &end);
        s.sel = Selection::caret(at.clone());
        crate::cmd::paste::insert(s, frag)?;
        // The copy starts where it was pasted.
        let copy = s.doc.clamp(&at);
        select_object(s, &copy);
        let o = s.doc.para_at(&copy).and_then(|p| p.object_at(copy.off)).cloned();
        return Ok(json!({"object": serde_json::to_value(o).unwrap_or(Value::Null), "pos": crate::cmd::pos_json(&copy)}));
    }
    if p::f32(v, "x").is_none() || p::f32(v, "y").is_none() {
        return Err(CmdError::Params("`x` and `y` are required".into()));
    }
    let frag = s.doc.copy_range(&pos, &end);
    s.sel = Selection::caret(end.clone());
    crate::cmd::paste::insert(s, frag)?;
    s.touch(); // lay out the copy before moving it
    // The copy sits right after the original; select it and move it like a drag would.
    s.sel = Selection { anchor: end.clone(), focus: Pos { off: end.off + len, ..end } };
    bounds(s, v)
}

/// Put the object at `pos` with its top-left at (x, y) on `page` (default: where it is), as a
/// drag does in Word: it floats (an inline object gets Square wrapping) and anchors to the
/// paragraph under its top edge, positioned relative to that paragraph's column and top. So the
/// text it lands on flows around it, and it moves with that text. On a page where no paragraph
/// starts, it anchors to the nearest line and is positioned on the page. Returns the object's
/// position afterwards.
///
/// A drop across pages can be thrown back: while the object sits on its old page it wraps text
/// away from the paragraph it is anchored to, so once it has moved, that paragraph can move back
/// onto the old page itself — and the object goes with it. Dropping near the top of the next
/// page does it every time (the anchor is that page's first paragraph, which fits on the old page
/// again once the object's wrap is gone). So a cross-page drop is anchored again until the object
/// really stays on the page asked for: the later passes see the pagination as it now is. A
/// same-page move (a resize, a nudge) places once, and a drop that still won't stay keeps its
/// last place rather than failing.
pub(super) fn move_object(s: &mut Session, pos: Pos, page: Option<u64>, x: f32, y: f32, (w, h): (f32, f32)) -> Result<Pos, CmdError> {
    let cur = s.layout().object(&pos, s.page_hint).ok_or_else(|| CmdError::Failed("the object isn't laid out".into()))?.page;
    let target = page.map_or(cur, |n| usize::try_from(n).unwrap_or(usize::MAX));
    let tries = if target == cur { 1 } else { 3 };
    let mut at = pos;
    for _ in 0..tries {
        at = move_object_once(s, &at, target, x, y, (w, h))?;
        s.touch();
        if s.layout().object(&at, target).is_some_and(|hit| hit.page == target) {
            break;
        }
    }
    Ok(at)
}

/// [`move_object`]'s one placement: move the object's character to the anchor under (x, y) on
/// `page` and offset it from there.
fn move_object_once(s: &mut Session, pos: &Pos, page: usize, x: f32, y: f32, (w, h): (f32, f32)) -> Result<Pos, CmdError> {
    use ew_doc::para::Anchor;
    if pos.path.depth() > 0 || !movable_story(s, pos.story) {
        return Err(CmdError::Disabled("only objects in the body text, headers and footers can be moved".into()));
    }
    let story = pos.story;
    let layout = s.layout();
    let pg = layout.pages.get(page).ok_or_else(|| CmdError::Params(format!("no page {page}")))?;
    // Keep a corner of it on the page.
    let x = x.max(12.0 - w).min(pg.w - 12.0);
    let y = y.max(12.0 - h).min(pg.h.min(MAX_OFFSET) - 12.0);
    // The paragraph under the middle of its top edge: in the column it mostly lands in.
    let (anchor, on_page) = match anchor_paragraph(&s.doc, &layout, page, (x + w / 2.0, y), story) {
        Some(path) => (Pos { story, path, off: 0 }, false),
        None => (nearest_line(&layout, page, y, story).ok_or_else(|| CmdError::Params("no text on that page to anchor to".into()))?, true),
    };
    // Move its character to the anchor (unless it's already in that paragraph).
    let at = if anchor.story == pos.story && anchor.path == pos.path && !on_page {
        pos.clone()
    } else {
        let obj = s.doc.para_at(pos).and_then(|p| p.object_at(pos.off)).cloned().ok_or_else(|| CmdError::Failed("object vanished".into()))?;
        let len = ew_doc::para::OBJ.len_utf8();
        s.doc.delete_range(pos, &Pos { off: pos.off + len, ..pos.clone() })?;
        let mut at = anchor;
        if at.story == pos.story && at.path == pos.path && at.off > pos.off {
            at.off = at.off.saturating_sub(len);
        }
        let at = s.doc.clamp(&at);
        s.doc.insert_object(&at, obj, &ew_doc::CharProps::default())?;
        at
    };
    // First on the page where it was dropped, so the text wraps around it as it will in the end.
    edit_float(s, &at, |f| {
        if f.wrap == Wrap::Inline {
            f.wrap = Wrap::Square;
        }
        f.h_rel = Anchor::Page;
        f.v_rel = Anchor::Page;
        f.h_align = None;
        f.v_align = None;
        f.x = x.clamp(-MAX_OFFSET, MAX_OFFSET);
        f.y = y.clamp(-MAX_OFFSET, MAX_OFFSET);
    })?;
    if on_page {
        return Ok(at);
    }
    // Then offsets from its paragraph, as laid out with the object there.
    s.touch();
    let hit = s.layout().object(&at, page).ok_or_else(|| CmdError::Failed("the object isn't laid out".into()))?;
    // EasyWriter engine-fidelity-3: Word 2013's layout starts a paragraph on the next page when a wrapped object placed from
    // it runs past the bottom margin, taking the object along (`float_past_bottom` in the layout's flow.rs). A drop that would
    // make its paragraph jump that way stays where it was dropped, placed on the page (#3169); any other drop moves with its
    // text (engine-fidelity-4: a laid-out place that differs from the drop is no reason to fix it on the page).
    if jumps_to_next_page(s, &hit, page) {
        return Ok(at);
    }
    let origin = hit.origin;
    edit_float(s, &at, |f| {
        f.h_rel = Anchor::Column;
        f.v_rel = Anchor::Paragraph;
        f.x = (x - origin.x).clamp(-MAX_OFFSET, MAX_OFFSET);
        f.y = (y - origin.y).clamp(-MAX_OFFSET, MAX_OFFSET);
    })?;
    Ok(at)
}

/// Whether the object `hit`, placed from its paragraph, would make that paragraph start the next page: the layout's
/// `float_past_bottom` condition (compatibility mode 15, text wrapping round it, its foot past the bottom of the page's text,
/// and text above its paragraph on the page).
fn jumps_to_next_page(s: &mut Session, hit: &ew_doc_layout::hit::ObjectHit, page: usize) -> bool {
    if s.doc.settings.compat_mode < 15 || matches!(hit.wrap, Wrap::BehindText | Wrap::InFrontOfText | Wrap::Inline) {
        return false;
    }
    let layout = s.layout();
    let Some(pg) = layout.pages.get(page) else { return false };
    // As the page's items name it (by id).
    let block = hit.path.0.first().and_then(|b| pg.ids.id(*b as usize));
    // The page's first body text: the anchor paragraph starting there has nothing above it.
    let first = pg.items.iter().find_map(|it| match it {
        ew_doc_layout::Placed::Lines { story: StoryRef::Body, path, l0, .. } => Some((path.0.first().copied(), *l0 == 0 && path.depth() == 0)),
        _ => None,
    });
    let starts_page = first.is_some_and(|(b, whole)| b == block && whole);
    hit.rect.y + hit.rect.h > pg.body.y + pg.body.h + 0.01 && !starts_page
}

/// Turn the selected floating object's alignment (left, centred, …) into an offset from its
/// column / paragraph that keeps it where it is, so it can be moved by an offset.
pub(super) fn unalign(s: &mut Session) -> Result<(), CmdError> {
    use ew_doc::para::Anchor;
    let (pos, obj) = selected(s).ok_or_else(|| CmdError::Disabled("no picture or shape selected".into()))?;
    let Some((_, _, float)) = obj.frame() else { return Ok(()) };
    if float.h_align.is_none() && float.v_align.is_none() {
        return Ok(());
    }
    let hit = s.layout().object(&pos, s.page_hint).ok_or_else(|| CmdError::Failed("the object isn't laid out".into()))?;
    let (ox, oy) = (hit.rect.x - hit.origin.x, hit.rect.y - hit.origin.y);
    edit_float(s, &pos, |f| {
        if f.h_align.is_some() {
            f.h_align = None;
            f.h_rel = Anchor::Column;
            f.x = ox.clamp(-MAX_OFFSET, MAX_OFFSET);
        }
        if f.v_align.is_some() {
            f.v_align = None;
            f.v_rel = Anchor::Paragraph;
            f.y = oy.clamp(-MAX_OFFSET, MAX_OFFSET);
        }
    })?;
    Ok(())
}

/// Whether a floating object moves with its text (Word's "Move with Text"): its vertical position
/// follows its paragraph (as layout places any anchor but the page and its margins), rather than
/// being fixed on the page ("Fix Position on Page").
pub fn moves_with_text(f: &Float) -> bool {
    use ew_doc::para::Anchor;
    !matches!(f.v_rel, Anchor::Page | Anchor::Margin | Anchor::TopMargin | Anchor::BottomMargin | Anchor::InsideMargin | Anchor::OutsideMargin)
}

/// Arrange › Wrap Text › Move with Text / Fix Position on Page: anchor the selected floating
/// object's vertical position to its paragraph or to the page, keeping it where it is now.
pub(super) fn move_with_text(s: &mut Session, with_text: bool) -> CmdResult {
    use ew_doc::para::Anchor;
    let (pos, obj) = selected(s).ok_or_else(|| CmdError::Disabled("no picture or shape selected".into()))?;
    let Some((_, _, float)) = obj.frame() else { return Err(CmdError::Disabled("select a floating picture or shape first".into())) };
    if moves_with_text(float) == with_text {
        return Ok(json!({"object": serde_json::to_value(&obj).unwrap_or(Value::Null)}));
    }
    let hit = s.layout().object(&pos, s.page_hint).ok_or_else(|| CmdError::Failed("the object isn't laid out".into()))?;
    // Paragraph offsets start at the paragraph's top (the hit's origin), page offsets at the page's.
    let y = if with_text { hit.rect.y - hit.origin.y } else { hit.rect.y };
    let o = edit_float(s, &pos, |f| {
        f.v_rel = if with_text { Anchor::Paragraph } else { Anchor::Page };
        f.v_align = None;
        f.y = y.clamp(-MAX_OFFSET, MAX_OFFSET);
    })?;
    Ok(json!({"object": serde_json::to_value(o).unwrap_or(Value::Null)}))
}

/// The top-level paragraph of `story` under `(x, y)` on `page`: in the column under `x` (from
/// the section's column geometry), the last one starting at or above `y` (else the first
/// starting in that column; else, with no paragraph starting in that column, the last starting
/// at or above `y` anywhere on the page, else the first). Body paragraphs come from the page's
/// items; header/footer ones from its header and footer. The column matters (#884): layout
/// places a floating object when it lays out its anchor, so text laid out before that (an
/// earlier column) can't wrap around it. (Nor do lines continuing a paragraph from the column
/// before: layout breaks them once, in the column the paragraph starts in.)
pub(crate) fn anchor_paragraph(
    doc: &ew_doc::Document,
    layout: &ew_doc_layout::DocLayout,
    page: usize,
    (x, y): (f32, f32),
    story: StoryRef,
) -> Option<ew_doc::Path> {
    let pg = layout.pages.get(page)?;
    let items: Box<dyn Iterator<Item = &ew_doc_layout::Placed> + '_> = match story {
        StoryRef::Body => Box::new(pg.items.iter()),
        StoryRef::Part(_) => Box::new(pg.header.iter().chain(pg.footer.iter())),
    };
    // Top-level text on the page: (path, left, top, starts the paragraph).
    let pieces: Vec<(&ew_doc::Path, f32, f32, bool)> = items
        .filter_map(|it| match it {
            ew_doc_layout::Placed::Lines { story: s, path, l0, x, y: top, .. } if *s == story && path.depth() == 0 => {
                Some((path, *x, *top, *l0 == 0))
            }
            _ => None,
        })
        .collect();
    let starts: Vec<(&ew_doc::Path, f32)> = pieces.iter().filter(|p| p.3).map(|p| (p.0, p.2)).collect();
    // The page's columns (left, right), from its section's column geometry (headers and footers
    // span the text area); the column under `x` is the rightmost one starting at or left of it.
    let boxes = match story {
        StoryRef::Body => doc.sections().get(pg.section).map(|(_, sp)| sp.column_boxes()).unwrap_or_default(),
        StoryRef::Part(_) => Vec::new(),
    };
    let mut cols: Vec<(f32, f32)> =
        boxes.iter().map(|(cx, w)| (pg.body.x + cx, pg.body.x + cx + w)).filter(|c| c.0.is_finite() && c.1.is_finite()).collect();
    cols.sort_by(|a, b| a.0.total_cmp(&b.0));
    let col_of = |px: f32| cols.iter().rposition(|c| c.0 <= px + 0.5).unwrap_or(0);
    let col = col_of(x);
    let in_col: Vec<(&ew_doc::Path, f32)> = pieces.iter().filter(|p| p.3 && col_of(p.1) == col).map(|p| (p.0, p.2)).collect();
    let pick = |v: &[(&ew_doc::Path, f32)]| v.iter().rev().find(|(_, top)| *top <= y + 0.5).or(v.first()).map(|(p, _)| (*p).clone());
    pick(&in_col).or_else(|| pick(&starts)).and_then(|p| pg.ids.doc_path(story, &p))
}

/// The start of the top-level line of `story` on `page` nearest to `y`.
pub(crate) fn nearest_line(layout: &ew_doc_layout::DocLayout, page: usize, y: f32, story: StoryRef) -> Option<Pos> {
    let pg = layout.pages.get(page)?;
    let lines = ew_doc_layout::hit::page_lines(pg, story);
    let best = lines.iter().filter(|l| l.path.depth() == 0).min_by(|a, b| {
        let d = |l: &ew_doc_layout::hit::LineHit| if y < l.top { l.top - y } else { (y - l.bottom).max(0.0) };
        d(a).total_cmp(&d(b))
    })?;
    let off = best.para.lines.get(best.li)?.start;
    Some(Pos { story, path: pg.ids.doc_path(story, best.path)?, off })
}

/// The selected object's placement (a copy: the state readers only read it).
fn float_of(s: &Session) -> Option<Float> {
    selected(s).and_then(|(_, o)| o.frame().map(|(_, _, f)| f.clone()))
}

const PRESETS: [&str; 9] = ["topLeft", "topCenter", "topRight", "middleLeft", "middleCenter", "middleRight", "bottomLeft", "bottomCenter", "bottomRight"];

/// The Position gallery's preset `f` shows (aligned to the margins on both axes with Square wrapping), if any.
fn preset_of(f: &Float) -> Option<&'static str> {
    use ew_doc::para::{Anchor, FloatAlign};
    if f.wrap != Wrap::Square || f.h_rel != Anchor::Margin || f.v_rel != Anchor::Margin {
        return None;
    }
    let i = |a: Option<FloatAlign>| match a? {
        FloatAlign::Start => Some(0),
        FloatAlign::Center => Some(1),
        FloatAlign::End => Some(2),
        _ => None,
    };
    Some(PRESETS[i(f.v_align)? * 3 + i(f.h_align)?])
}

/// Layout › Position: a preset aligns the selected object to the margins on both axes with Square wrapping (Word stores the
/// alignment, so it stays at its corner when the margins change); `x`/`y` place it by offsets from the margins instead.
fn position(s: &mut Session, v: &Value) -> CmdResult {
    use ew_doc::para::{Anchor, FloatAlign};
    let (x, y) = (p::f32(v, "x"), p::f32(v, "y"));
    let preset = p::str(v, "preset").unwrap_or("middleCenter");
    let i = PRESETS.iter().position(|p| *p == preset).ok_or_else(|| CmdError::Params(format!("unknown preset `{preset}`")))?;
    let al = [FloatAlign::Start, FloatAlign::Center, FloatAlign::End];
    with_float(s, |f| {
        // The gallery's items are "... with Square Text Wrapping": a preset sets Square whatever the wrap was.
        if x.is_none() && y.is_none() || f.wrap == Wrap::Inline {
            f.wrap = Wrap::Square;
        }
        (f.h_rel, f.v_rel) = (Anchor::Margin, Anchor::Margin);
        f.h_align = if x.is_some() { None } else { Some(al[i % 3]) };
        f.v_align = if y.is_some() { None } else { Some(al[i / 3]) };
        f.x = x.unwrap_or(0.0).clamp(-MAX_OFFSET, MAX_OFFSET);
        f.y = y.unwrap_or(0.0).clamp(-MAX_OFFSET, MAX_OFFSET);
    })
}

/// Layout › Align: Word's relative alignment of the selected floating object to the margins or the page, which replaces its
/// offset on that axis. A vertical one is relative to the margin or page, so the object no longer moves with its text, as in
/// Word.
fn align(s: &mut Session, v: &Value) -> CmdResult {
    use ew_doc::para::{Anchor, FloatAlign};
    let to = match p::str(v, "to").unwrap_or("margin") {
        // ponytail: Align Selected Objects with one object aligns to the margin, as the DOM editor does; lining several selected
        // objects up with each other waits for a multi-object align.
        "margin" | "selected" => Anchor::Margin,
        "page" => Anchor::Page,
        other => return Err(CmdError::Params(format!("unknown `to` `{other}`"))),
    };
    let (horizontal, a) = match p::str(v, "value").unwrap_or("center") {
        "left" => (true, FloatAlign::Start),
        "center" => (true, FloatAlign::Center),
        "right" => (true, FloatAlign::End),
        "top" => (false, FloatAlign::Start),
        "middle" => (false, FloatAlign::Center),
        "bottom" => (false, FloatAlign::End),
        other => return Err(CmdError::Params(format!("unknown alignment `{other}`"))),
    };
    with_float(s, |f| {
        if horizontal {
            (f.h_rel, f.h_align) = (to, Some(a));
        } else {
            (f.v_rel, f.v_align) = (to, Some(a));
        }
    })
}

/// The new stacking orders after `op` moves object `k` among objects whose orders are `zs` (document order) → (index, z) for
/// each that changes. Equal orders, and the unset order 0 (drawn in document order), are first spread to 1..n in document
/// order so a step swaps two distinct layers. The orders stay 1 or more (DOCX `relativeHeight` is unsigned, 0 is unset).
pub(super) fn z_ops(zs: &[u32], k: usize, op: &str) -> Vec<(usize, u32)> {
    let mut z = zs.to_vec();
    let mut sorted = z.clone();
    sorted.sort_unstable();
    if sorted.first() == Some(&0) || sorted.windows(2).any(|w| w[0] == w[1]) {
        for (n, v) in z.iter_mut().enumerate() {
            *v = n as u32 + 1;
        }
    }
    let mut order: Vec<usize> = (0..z.len()).collect();
    order.sort_by_key(|&i| (z[i], i));
    let Some(at) = order.iter().position(|&i| i == k) else { return Vec::new() };
    let last = order.len() - 1;
    match op {
        "forward" if at < last => z.swap(k, order[at + 1]),
        "backward" if at > 0 => z.swap(k, order[at - 1]),
        "front" if at < last => z[k] = z[order[last]].saturating_add(1),
        "back" if at > 0 => {
            if z[order[0]] > 1 {
                z[k] = z[order[0]] - 1;
            } else {
                // At the floor: this one becomes 1 and the others follow in their order.
                for (n, i) in std::iter::once(k).chain(order.iter().copied().filter(|&i| i != k)).enumerate() {
                    z[i] = n as u32 + 1;
                }
            }
        }
        _ => {}
    }
    z.iter().enumerate().filter(|(i, v)| zs[*i] != **v).map(|(i, v)| (i, *v)).collect()
}

/// Bring Forward, Send Backward, Bring to Front and Send to Back: the selected floating object's stacking order (`Float::z`,
/// DOCX `relativeHeight`) among the floating objects of its story, one undo step; the wrap stays.
fn order(s: &mut Session, v: &Value) -> CmdResult {
    let op = p::str(v, "op").unwrap_or("front");
    if !matches!(op, "forward" | "backward" | "front" | "back") {
        return Err(CmdError::Params(format!("unknown op `{op}`")));
    }
    let (pos, _) = selected(s).ok_or_else(|| CmdError::Disabled("no picture or shape selected".into()))?;
    let mut peers = Vec::new();
    for path in s.doc.para_paths(pos.story) {
        let Some(p) = s.doc.para(pos.story, &path) else { continue };
        for off in p.object_offsets() {
            if let Some((_, _, f)) = p.object_at(off).filter(|o| o.is_drawing() && o.is_floating()).and_then(InlineObject::frame) {
                peers.push((Pos { story: pos.story, path: path.clone(), off }, f.z));
            }
        }
    }
    let k = peers.iter().position(|(p, _)| *p == pos).ok_or_else(|| CmdError::Disabled("select a floating picture or shape first".into()))?;
    let zs: Vec<u32> = peers.iter().map(|p| p.1).collect();
    for (i, z) in z_ops(&zs, k, op) {
        edit_float(s, &peers[i].0, |f| f.z = z)?;
    }
    select_object(s, &pos);
    let z = s.doc.para_at(&pos).and_then(|p| p.object_at(pos.off)).and_then(|o| o.frame().map(|(_, _, f)| f.z)).unwrap_or(0);
    Ok(json!({"z": z}))
}

/// The commands of this file (docs/plans/engine/stage2.md, the Stage 2.0 scaffold: one owner per file).
pub(super) fn specs() -> Vec<super::CommandSpec> {
    use super::group::{group, ungroup};
    use super::select::{can_group, has_floating, has_group, has_movable, objects_list};
    use super::{CmdError, CommandSpec, Spin, Value, Wrap, WrapText, json, p};
    vec![
        CommandSpec::new("arrange.rotate", "Rotate", "Layout › Arrange", |s, v| {
            // Turns and flips are the object's angle and mirroring (DrawingML `a:xfrm`): the
            // picture's pixels are never rewritten. A flip mirrors what is on the page, so a
            // rotated object's angle reverses too.
            let by = match p::str(v, "direction").unwrap_or("right") {
                "left" => Spin::new(270.0, false, false),
                "flipHorizontal" | "flipH" => Spin::new(0.0, true, false),
                "flipVertical" | "flipV" => Spin::new(0.0, false, true),
                "right" => Spin::new(90.0, false, false),
                other => return Err(CmdError::Params(format!("unknown direction `{other}`"))),
            };
            with_float(s, |f| f.set_spin(f.spin().within(by)))
        })
        .params(r#"{"direction": "right|left|flipVertical|flipHorizontal"}  (turns 90° or mirrors the selected picture, shape or text box; its pixels are kept)"#)
        .when(has_movable),
        CommandSpec::new("arrange.rotation", "Rotation", "Layout › Arrange", |s, v| {
            let deg = p::req_f32(v, "degrees")?;
            let (fh, fv) = (p::bool(v, "flipH"), p::bool(v, "flipV"));
            with_float(s, |f| {
                let cur = f.spin();
                f.set_spin(Spin::new(deg, fh.unwrap_or(cur.flip_h), fv.unwrap_or(cur.flip_v)));
            })
        })
        .params(r#"{"degrees": number, "flipH"?: bool, "flipV"?: bool}  (the exact angle, clockwise, of the selected picture, shape or text box; normalised to 0–360)"#)
        .when(has_movable)
        .state(|s| (Value::Null, float_of(s).map(|f| json!(f.rot)).unwrap_or(Value::Null))),
        CommandSpec::new("arrange.wrap", "Wrap Text", "Layout › Arrange", |s, v| {
            let wrap: Wrap = serde_json::from_value(v.get("wrap").cloned().unwrap_or(json!("square"))).map_err(|e| CmdError::Params(e.to_string()))?;
            with_float(s, |f| f.wrap = wrap)
        })
        .params(r#"{"wrap": "inline|square|tight|through|topAndBottom|behindText|inFrontOfText"}"#)
        .when(has_movable)
        .state(|s| (Value::Null, float_of(s).map(|f| json!(f.wrap)).unwrap_or(Value::Null))),
        CommandSpec::new("arrange.wrapText", "Wrap Text Sides", "Layout › Arrange", |s, v| {
            let side = p::str(v, "side").unwrap_or("bothSides");
            let side = WrapText::from_ooxml(side).ok_or_else(|| CmdError::Params(format!("unknown side {side:?}")))?;
            with_float(s, |f| f.wrap_text = side)
        })
        .params(r#"{"side": "bothSides|left|right|largest"}  (the sides of the selected Square, Tight or Through object text flows on; largest: the wider side, line by line)"#)
        .when(has_movable)
        .state(|s| (Value::Null, float_of(s).map(|f| json!(f.wrap_text.ooxml())).unwrap_or(Value::Null))),
        CommandSpec::new("arrange.moveWithText", "Move with Text", "Layout › Arrange › Wrap Text", |s, v| move_with_text(s, p::bool(v, "value").unwrap_or(true)))
            .params(r#"{"value": bool}  (true: Move with Text, the floating object's vertical position follows its paragraph; false: Fix Position on Page. It stays where it is)"#)
            .when(has_floating)
            .state(|s| (json!(float_of(s).is_some_and(|f| f.wrap != Wrap::Inline && moves_with_text(&f))), Value::Null)),
        CommandSpec::new("arrange.position", "Position", "Layout › Arrange", position)
            .params(r#"{"preset"?: "topLeft|topCenter|topRight|middleLeft|middleCenter|middleRight|bottomLeft|bottomCenter|bottomRight", "x"?: pt, "y"?: pt}  (a preset aligns it to the margins with Square wrapping, as Word's Position gallery does; x/y: offsets from the margins)"#)
            .when(has_movable)
            .state(|s| (Value::Null, float_of(s).and_then(|f| preset_of(&f)).map(Value::from).unwrap_or(Value::Null))),
        CommandSpec::new("arrange.bringForward", "Bring Forward", "Layout › Arrange", |s, _| with_float(s, |f| f.wrap = Wrap::InFrontOfText)).when(has_movable),
        CommandSpec::new("arrange.sendBackward", "Send Backward", "Layout › Arrange", |s, _| with_float(s, |f| f.wrap = Wrap::BehindText)).when(has_movable),
        CommandSpec::new("arrange.order", "Order", "Layout › Arrange", order)
            .params(r#"{"op": "forward|backward|front|back"}  (Bring Forward, Send Backward, Bring to Front, Send to Back: the selected floating object's stacking order among its story's floating objects; the wrap stays)"#)
            .when(has_floating),
        CommandSpec::new("arrange.align", "Align", "Layout › Arrange", align)
            .params(r#"{"value": "left|center|right|top|middle|bottom", "to"?: "margin|page"}  (Word's relative alignment of the selected floating object, which replaces its offset on that axis; default to the margins)"#)
            .when(has_floating),
        CommandSpec::new("arrange.selectionPane", "Selection Pane", "Layout › Arrange", objects_list).pure(),
        CommandSpec::new("arrange.bounds", "Move or Resize", "Layout › Arrange", bounds)
            .params(r#"{"width"?: pt, "height"?: pt, "x"?: pt, "y"?: pt, "page"?: n, "to"?: Pos}  (x/y: the top-left on page `page` (0-based, default its page); moving an inline object by x/y floats it. to: an In Line with Text object moves to that text position and stays inline, as a drag does)"#)
            .when(has_movable)
            .state(|s| (Value::Null, selected(s).map(|(_, o)| json!({"w": obj_size(&o).0, "h": obj_size(&o).1})).unwrap_or(Value::Null))),
        CommandSpec::new("arrange.copyTo", "Copy to", "Layout › Arrange", copy_to)
            .params(r#"{"x": pt, "y": pt, "page"?: n} | {"to": Pos}  (Ctrl+drag: a copy of the selected object lands with its top-left there, or an In Line with Text one at the text position `to`, and is selected; the original and the clipboard stay as they were)"#)
            .when(has_movable),
        CommandSpec::new("arrange.nudge", "Nudge", "Layout › Arrange", |s, v| {
            let d = |k| p::f32(v, k).unwrap_or(0.0).clamp(-MAX_OFFSET, MAX_OFFSET);
            let (dx, dy) = (d("dx"), d("dy"));
            unalign(s)?;
            with_float(s, |f| {
                f.x = (f.x + dx).clamp(-MAX_OFFSET, MAX_OFFSET);
                f.y = (f.y + dy).clamp(-MAX_OFFSET, MAX_OFFSET);
            })
        })
        .params(r#"{"dx"?: pt, "dy"?: pt}"#)
        .when(has_floating),
        CommandSpec::new("arrange.group", "Group", "Layout › Arrange", group)
            .params(r#"{}  (groups the selected pictures, shapes and text boxes: the selected one plus those added with select.addObject)"#)
            .when(can_group),
        CommandSpec::new("arrange.ungroup", "Ungroup", "Layout › Arrange", ungroup).when(has_group),
    ]
}
