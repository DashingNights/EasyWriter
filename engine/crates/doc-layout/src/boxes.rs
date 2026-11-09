use super::ctx::{Ctx, page_anchored};
use super::floats::{
    ObjFrame, ObjectPlacement, WrapArea, align_in, float_rect, floating, left_out_objects, place_objects, rel_exclusions, wrap_area,
};
use super::page::PageFrame;
use super::placed::Placed;
use ew_doc::props::Rgb;
use super::table_flow::below;
use super::{
    Anchor, Arc, Block, Blocks, Border, Document, Float, FloatAlign, HashMap, ParaLayout, Paragraph, Path, Rect, SectionProps, StoryRef, TableFloat,
    TextDirection, Wrap, WrapText, para, table,
};

/// Cell identity is independent of optional table-style formatting.
pub(crate) enum BoxContext<'a> {
    Other,
    Cell(Option<&'a para::CellText>),
}

pub(crate) struct BoxInput<'a> {
    pub(crate) story: StoryRef,
    pub(crate) blocks: &'a Blocks,
    pub(crate) prefix: &'a [u32],
    pub(crate) width: f32,
    pub(crate) context: BoxContext<'a>,
    pub(crate) depth: usize,
    pub(crate) frame: Option<PageFrame<'a>>,
}

impl<'a> BoxInput<'a> {
    pub(crate) fn other(story: StoryRef, blocks: &'a Blocks, width: f32, depth: usize, frame: Option<PageFrame<'a>>) -> Self {
        Self { story, blocks, prefix: &[], width, context: BoxContext::Other, depth, frame }
    }

    pub(crate) fn cell(story: StoryRef, blocks: &'a Blocks, prefix: &'a [u32], width: f32, cell: Option<&'a para::CellText>, depth: usize) -> Self {
        Self { story, blocks, prefix, width, context: BoxContext::Cell(cell), depth, frame: None }
    }
}

struct ParagraphSpacing<'a> {
    index: usize,
    listed: bool,
    style: &'a str,
    contextual: bool,
    before_auto: bool,
    space_before: f32,
    allow_same_style_space: bool,
    previous_style: Option<&'a (String, bool)>,
    previous_listed: bool,
    previous_after_auto: bool,
    previous_after: &'a mut f32,
    y: &'a mut f32,
    sum_paragraph_spacing: bool,
}

struct TableBlockContext<'ctx, 'state, 'doc> {
    ctx: &'ctx mut Ctx<'doc>,
    story: StoryRef,
    table: &'state ew_doc::Table,
    path: &'state [u32],
    width: f32,
    frame: Option<PageFrame<'state>>,
    in_cell: bool,
    depth: usize,
    y: &'state mut f32,
    items: &'state mut Vec<Placed>,
    exclusions: &'state mut Vec<WrapArea>,
    float_tables: &'state mut Vec<Rect>,
    table_areas: &'state mut Vec<Rect>,
    page_table_wraps: &'state mut Vec<WrapArea>,
    previous_after: &'state mut f32,
    previous_style: &'state mut Option<(String, bool)>,
}

fn paragraph_spacing(input: ParagraphSpacing<'_>) -> (bool, f32) {
    let ParagraphSpacing {
        index,
        listed,
        style,
        contextual,
        before_auto,
        space_before,
        allow_same_style_space,
        previous_style,
        previous_listed,
        previous_after_auto,
        previous_after,
        y,
        sum_paragraph_spacing,
    } = input;
    let contextual = contextual && !allow_same_style_space;
    let mut before = space_before;
    if let Some((previous, previous_contextual)) = previous_style
        && previous == style
        && !allow_same_style_space
    {
        if *previous_contextual {
            *y -= *previous_after;
            before = (before - *previous_after).max(0.0);
            *previous_after = 0.0;
        }
        if contextual {
            before = 0.0;
        }
    }
    if index > 0 && previous_listed && listed {
        if previous_after_auto {
            *y -= *previous_after;
            *previous_after = 0.0;
        }
        if before_auto {
            before = 0.0;
        }
    }
    if before_auto && index == 0 {
        before = 0.0;
    } else if index > 0 && before > 0.0 && *previous_after > 0.0 && !sum_paragraph_spacing {
        before = (before - *previous_after).max(0.0);
    }
    (contextual, before)
}

fn layout_table_block(input: TableBlockContext<'_, '_, '_>) -> bool {
    let TableBlockContext {
        ctx,
        story,
        table: t,
        path,
        width,
        frame,
        in_cell,
        depth,
        y,
        items,
        exclusions,
        float_tables,
        table_areas,
        page_table_wraps,
        previous_after,
        previous_style,
    } = input;
    if depth > 8 {
        return false;
    }
    // Page tables do not contribute to the footer text's intrinsic height.
    if frame.is_none()
        && !in_cell
        && matches!(story, StoryRef::Part(id) if ctx.doc.parts.get(&id).is_some_and(|p| p.kind == ew_doc::PartKind::Footer))
        && t.props.float.is_some_and(|f| f.v_rel == Anchor::Page)
    {
        return false;
    }
    let layout = table::layout_table(ctx, story, t, path, width, depth + 1);
    let (tx, ty) = match t.props.float {
        Some(float) => {
            let legacy = if ctx.doc.settings.compat_mode < 15 { table::first_cell_left_margin(ctx, t) } else { 0.0 };
            let (rect, area) = box_float_table_rect(frame, width, *y, &layout, &float, legacy, float_tables);
            exclusions.push((area, false, None, WrapText::BothSides, true));
            float_tables.push(area);
            table_areas.push(area);
            if float.v_rel == Anchor::Page {
                page_table_wraps.push((area, false, None, WrapText::BothSides, true));
            }
            (rect.x, rect.y)
        }
        None => (layout.x, below(exclusions, *y, layout.x, layout.x + layout.width)),
    };
    let mut row_y = ty;
    for row in &layout.rows {
        for item in &row.items {
            let mut item = item.clone();
            item.translate(tx, row_y);
            items.push(item);
        }
        row_y += row.height;
    }
    if t.props.float.is_none() {
        *y = row_y;
        *previous_after = 0.0;
        *previous_style = None;
    }
    true
}

/// Lay out a block list into a free-standing box of `width` (no page breaks): table cells,
/// headers, footers, notes, text boxes. Returns items relative to (0, 0) and the height. `frame`
/// says where the box sits on its page, for floating objects positioned relative to the page or
/// its margins; without it (cells, notes, text boxes) they're positioned in the box.
pub(crate) fn layout_box(ctx: &mut Ctx, input: BoxInput<'_>) -> BoxLayout {
    let BoxInput { story, blocks, prefix, width, context, depth, frame } = input;
    // Deletions in balloons leave the body's text only: a header, note or text box keeps its own
    // inline (restored for the story around this box when it's done).
    let outer_hide = std::mem::replace(&mut ctx.hide_deleted, ctx.opts.hides_deleted(story));
    let empty_cell = para::CellText::default();
    let (table, in_cell) = match context {
        BoxContext::Other => (None, false),
        BoxContext::Cell(table) => (Some(table.unwrap_or(&empty_cell)), true),
    };
    // Word 16.113.3: the override applies in modes 11/12/14, but not mode 15.
    let allow_same_style_space =
        in_cell && ctx.doc.settings.allow_space_of_same_style_in_table && matches!(ctx.doc.settings.compat_mode, 11 | 12 | 14);
    let mut items = Vec::new();
    // Pictures behind the text go first; `behind` counts them.
    let mut behind = 0;
    // Wrap areas of the box's floating objects.
    let mut excl: Vec<WrapArea> = Vec::new();
    // Areas of the box's floating tables, which other floating tables may have to avoid.
    let mut float_tables: Vec<Rect> = Vec::new();
    // Deepest a floating picture or shape that takes part in the text flow reaches, so the box
    // (a table cell especially) grows to hold it instead of letting it hang past the box's own
    // bottom edge (#3108). Behind-text and in-front-of-text objects don't: a page-anchored logo or
    // watermark behind a cell's text must not stretch its row (see `align_h` in table.rs).
    let mut float_objects_bottom = 0.0f32;
    let mut table_areas = Vec::new();
    let mut page_table_wraps = Vec::new();
    let mut y = 0.0f32;
    let mut prev_after = 0.0f32;
    let mut prev_after_auto = false;
    let mut prev_listed = false;
    let mut prev_style: Option<(String, bool)> = None;
    let mut last_top = 0.0f32;
    // Word has no frames in a text box: a framed paragraph there (its style's frame, usually)
    // runs with the box's text (#2357).
    let frames = !matches!(story, StoryRef::Part(id) if ctx.doc.parts.get(&id).is_some_and(|p| p.kind == ew_doc::PartKind::TextBox));
    // The bottom of the last paragraph's lines.
    let mut prev_end = 0.0f32;
    // EasyWriter engine-style-separator: last lines of paragraphs ending in style separators, waiting for the paragraph that
    // runs on in their line ([`crate::run_in`]); the paragraphs laid out here are told their place in such a run.
    let mut row: Vec<crate::run_in::Seg> = Vec::new();
    let outer_join = std::mem::take(&mut ctx.join);
    for (i, b) in blocks.iter().enumerate() {
        last_top = y;
        let mut path = prefix.to_vec();
        path.push(i as u32);
        match &**b {
            Block::Para(p) => {
                let v = crate::run_in::Shown { hidden: ctx.opts.show_hidden, deleted: &ctx.hide_deleted, table: table.map(|t| &t.chr) };
                let after = crate::run_in::joined_from(ctx.doc, blocks, i, v).is_some();
                let runs_on = crate::run_in::joined(ctx.doc, blocks, i, v).is_some();
                ctx.join = crate::run_in::Join::of(p, if after { &row } else { &[] }, runs_on, crate::run_in::mark_room(ctx.opts.show_hidden));
                // After a style separator the list number counts but is not drawn (Word).
                let label = ctx.next_label(p).filter(|_| ctx.join.run_in.is_none());
                let listed = label.is_some();
                let mut pl = ctx.para_labelled(p, width, table, &[], label.clone());
                // A text frame (a footer's page number in a frame, say) is placed apart, like a
                // floating object, and the text after it wraps around it; it takes no room in
                // the flow.
                if let Some(fr) = pl.rp.frame.clone().filter(|_| frames) {
                    let fw = fr.w.unwrap_or_else(|| natural_width(&pl)).clamp(1.0, 1584.0);
                    let pf = if (fw - width).abs() > 0.01 { ctx.para_labelled(p, fw, table, &[], label) } else { pl };
                    let h = match fr.h {
                        Some(h) if fr.h_exact => h,
                        Some(h) => h.max(pf.height),
                        None => pf.height,
                    };
                    let float = frame_float(&fr);
                    let r = float_rect(frame, (0.0, width), y, fw, h, &float);
                    push_para(&mut items, (story, &path), &pf, (0, pf.lines.len()), (r.x, r.y), fw, Edges::own(&pf, 0, pf.lines.len()));
                    excl.extend(wrap_area(r, &float, None));
                    float_tables.push(r);
                    continue;
                }
                let (ctxl, before) = paragraph_spacing(ParagraphSpacing {
                    index: i,
                    listed,
                    style: &pl.rp.style,
                    contextual: pl.rp.contextual_spacing,
                    before_auto: pl.rp.before_auto,
                    space_before: pl.rp.space_before,
                    allow_same_style_space,
                    previous_style: prev_style.as_ref(),
                    previous_listed: prev_listed,
                    previous_after_auto: prev_after_auto,
                    previous_after: &mut prev_after,
                    y: &mut y,
                    sum_paragraph_spacing: ctx.doc.settings.sum_paragraph_spacing,
                });
                // Paragraph-relative floats start above the effective space before, as in the
                // body path. Keep text and wrap exclusions relative to the text's actual top.
                let para_top = y;
                y += if i == 0 { before } else { before.max(0.0) };
                // Floating objects anchored here: place them, then wrap the text around them.
                // One left out of the layout (hidden, or deleted in the final text) takes no room.
                let mut floats = HashMap::new();
                // A header or footer cell's floats placed on the page: no room taken in the cell.
                let mut pinned = HashMap::new();
                let left_out = left_out_objects(ctx.doc, p, table.map(|t| &t.chr), ctx.opts.show_hidden, &ctx.hide_deleted);
                for (oi, o) in p.objects.iter().enumerate() {
                    let Some((w, h, float)) = floating(o) else { continue };
                    if left_out(oi) {
                        continue;
                    }
                    if let Some(pin) = ctx.pin.as_ref().filter(|pin| in_cell && pin.story == story && float.outside_cell && page_anchored(float)) {
                        let page = PageFrame { sect: &pin.sect, origin: (0.0, 0.0), number: pin.number, mirror: pin.mirror };
                        pinned.insert(oi, float_rect(Some(page), (0.0, width), para_top, w, h, float));
                        continue;
                    }
                    // Only paragraph-relative placement excludes space-before. Line anchors
                    // and frameless page/margin fallbacks retain the text-top origin.
                    let float_y = if float.v_rel == Anchor::Paragraph { para_top } else { y };
                    let r = float_rect(frame, (0.0, width), float_y, w, h, float);
                    let outline = ctx.wrap_outline(o);
                    excl.extend(wrap_area(r, float, outline.as_deref().map(Vec::as_slice)));
                    floats.insert(oi, r);
                }
                let rel = rel_exclusions(&excl, 0.0, y);
                if !rel.is_empty() {
                    pl = ctx.para_labelled(p, width, table, &rel, label);
                }
                // Bordered paragraphs: room for their borders, those of a group joined in one box.
                let cell = table.map(|t| &t.para);
                let (above, below) = (joined(ctx.doc, blocks, i, i.checked_sub(1), cell), joined(ctx.doc, blocks, i, Some(i + 1), cell));
                let mut edges = Edges::own(&pl, 0, pl.lines.len());
                if above || ctx.join.run_in.is_some() {
                    edges.top = 0.0;
                }
                if below || runs_on {
                    edges.bottom = 0.0;
                }
                let lead = pl.lines.first().map_or(0.0, |l| l.top.max(0.0)) + edges.top;
                if above {
                    edges.up = (y + lead - prev_end).max(0.0);
                }
                // A style separator's last line waits for the next paragraph, which places it beside its first line.
                let n = pl.lines.len();
                let shown = if runs_on { n.saturating_sub(1) } else { n };
                // A paragraph a run passes over (one that takes no room) leaves the waiting lines for the one after it.
                if after && shown > 0 && !row.is_empty() {
                    crate::run_in::place_row(&mut items, std::mem::take(&mut row), &pl, (0.0, y + lead));
                }
                prev_end = push_para(&mut items, (story, &path), &pl, (0, shown), (0.0, y + lead), width, edges);
                // Pictures, shapes and text boxes: drawn, their areas and text boxes' text.
                if !p.objects.is_empty() {
                    let at = ObjFrame { page: frame, col: (0.0, width), para_y: para_top, table_chr: table.map(|t| &t.chr), pinned: Some(&pinned) };
                    let (back, front) = place_objects(
                        ctx,
                        &ObjectPlacement {
                            story,
                            path: &path,
                            p,
                            pl: &pl,
                            lines: (0, pl.lines.len()),
                            origin: (0.0, y + lead),
                            at: &at,
                            floats: &floats,
                            depth,
                        },
                    );
                    for placed in back.iter().chain(front.iter()) {
                        if let Placed::Object { rect, spin, wrap, .. } = placed
                            && !matches!(wrap, Wrap::Inline | Wrap::BehindText | Wrap::InFrontOfText)
                        {
                            float_objects_bottom = float_objects_bottom.max(spin.bounds(*rect).bottom());
                        }
                    }
                    let at = behind.min(items.len());
                    behind += back.len();
                    items.splice(at..at, back);
                    items.extend(front);
                }
                // Automatic space after: none after the last paragraph of a cell or box.
                let after = if pl.rp.after_auto && i + 1 == blocks.len() { 0.0 } else { pl.rp.space_after };
                match pl.lines.last().filter(|_| runs_on) {
                    // The next paragraph starts at the waiting line's top.
                    Some(last) => {
                        y += lead + last.top - pl.lines.first().map_or(0.0, |f| f.top);
                        row.push(crate::run_in::Seg { story, path: path.clone(), pl: pl.clone() });
                    }
                    None => y += edges.top + pl.height + edges.bottom + after,
                }
                prev_after = after;
                prev_after_auto = pl.rp.after_auto;
                prev_listed = listed;
                prev_style = Some((pl.rp.style.clone(), ctxl));
            }
            Block::Table(t) => {
                if !layout_table_block(TableBlockContext {
                    ctx,
                    story,
                    table: t,
                    path: &path,
                    width,
                    frame,
                    in_cell,
                    depth,
                    y: &mut y,
                    items: &mut items,
                    exclusions: &mut excl,
                    float_tables: &mut float_tables,
                    table_areas: &mut table_areas,
                    page_table_wraps: &mut page_table_wraps,
                    previous_after: &mut prev_after,
                    previous_style: &mut prev_style,
                }) {
                    continue;
                }
            }
            // A quote, code block or box lays out as its throwaway one-column table.
            Block::Container(c) => {
                if !layout_table_block(TableBlockContext {
                    ctx,
                    story,
                    table: &c.frame(width),
                    path: &path,
                    width,
                    frame,
                    in_cell,
                    depth,
                    y: &mut y,
                    items: &mut items,
                    exclusions: &mut excl,
                    float_tables: &mut float_tables,
                    table_areas: &mut table_areas,
                    page_table_wraps: &mut page_table_wraps,
                    previous_after: &mut prev_after,
                    previous_style: &mut prev_style,
                }) {
                    continue;
                }
                y += c.space_after;
                prev_after = c.space_after;
            }
        }
    }
    let floats_bottom = float_tables.iter().map(|r| r.bottom()).fold(float_objects_bottom, f32::max);
    ctx.hide_deleted = outer_hide;
    ctx.join = outer_join;
    BoxLayout { items, height: y.max(0.0), floats_bottom, last_top: last_top.max(0.0), table_areas, page_table_wraps }
}

/// The width a text frame without one takes: its widest line, with the paragraph's indents.
pub(crate) fn natural_width(pl: &ParaLayout) -> f32 {
    let widest = (0..pl.lines.len())
        .filter_map(|li| {
            let l = pl.lines.get(li)?;
            Some((pl.x_of(li, l.stop)? - pl.x_of(li, l.start)?).abs())
        })
        .fold(0.0f32, f32::max);
    widest + pl.rp.indent_left.max(0.0) + pl.rp.indent_right.max(0.0)
}

/// A text frame's placement as a floating object's (`w:framePr` → anchors, alignment, wrap).
pub(crate) fn frame_float(fr: &ew_doc::props::TextFrame) -> Float {
    let anchor = |a: &str, text: Anchor| match a {
        "page" => Anchor::Page,
        "margin" => Anchor::Margin,
        _ => text,
    };
    let align = |a: Option<&str>| match a {
        Some("left" | "top") => Some(FloatAlign::Start),
        Some("center") => Some(FloatAlign::Center),
        Some("right" | "bottom") => Some(FloatAlign::End),
        Some("inside") => Some(FloatAlign::Inside),
        Some("outside") => Some(FloatAlign::Outside),
        _ => None,
    };
    Float {
        wrap: match fr.wrap.as_str() {
            "notBeside" => Wrap::TopAndBottom,
            "none" => Wrap::InFrontOfText,
            "tight" => Wrap::Tight,
            "through" => Wrap::Through,
            _ => Wrap::Square,
        },
        h_rel: anchor(&fr.h_anchor, Anchor::Column),
        v_rel: anchor(&fr.v_anchor, Anchor::Paragraph),
        x: fr.x,
        y: fr.y,
        h_align: align(fr.x_align.as_deref()),
        v_align: align(fr.y_align.as_deref()),
        dist: fr.h_space,
        dist_top: fr.v_space,
        dist_bottom: fr.v_space,
        ..Default::default()
    }
}

/// A laid-out box: items relative to its top-left, the height of its text flow, where its
/// floating tables end (a table cell grows to hold them) and where its last block starts (the
/// height without it).
pub(crate) struct BoxLayout {
    pub(crate) items: Vec<Placed>,
    pub(crate) table_areas: Vec<Rect>,
    pub(crate) page_table_wraps: Vec<WrapArea>,
    pub(crate) height: f32,
    pub(crate) floats_bottom: f32,
    pub(crate) last_top: f32,
}

/// Where floating table `tl` goes in a box `width` wide whose next paragraph starts at `y`, and
/// the area text keeps clear of. Positions relative to the page or its margins need the box's
/// `frame`; without one (a table cell) they're relative to the box.
fn box_float_table_rect(
    frame: Option<PageFrame>,
    width: f32,
    y: f32,
    tl: &table::TableLayout,
    f: &TableFloat,
    legacy: f32,
    float_tables: &[Rect],
) -> (Rect, Rect) {
    let h = tl.rows.iter().map(|r| r.height).sum::<f32>().clamp(0.0, 100_000.0);
    let w = tl.width.clamp(1.0, 100_000.0);
    // Across, as laid out before an even page is mirrored (see `float_rect`).
    let page_x = |fr: &PageFrame| {
        let (left, _, shift) = fr.sides();
        match f.h_rel {
            Anchor::Page => Some((-shift, fr.sect.page_w)),
            Anchor::Margin => Some((left - shift, fr.sect.text_width())),
            _ => None,
        }
    };
    let page_y = |s: &SectionProps| match f.v_rel {
        Anchor::Page => Some((0.0, s.page_h)),
        Anchor::Margin => Some((s.margin_top, s.text_height())),
        _ => None,
    };
    let h_area = frame.and_then(|fr| page_x(&fr).map(|(a, e)| (a - fr.origin.0, e))).unwrap_or((0.0, width));
    // In a cell an offset from the page or margin has nothing to measure from: the table stands
    // where the text is.
    let (v_area, y_off) = match frame.and_then(|fr| page_y(fr.sect).map(|(a, e)| (a - fr.origin.1, e))) {
        Some(area) => (area, f.y),
        None if matches!(f.v_rel, Anchor::Page | Anchor::Margin) => ((y, 0.0), 0.0),
        None => ((y, 0.0), f.y),
    };
    // Nor is there an area to align in: the table starts where the text is.
    let v_align = if frame.is_none() && matches!(f.v_rel, Anchor::Page | Anchor::Margin) { None } else { f.v_align };
    let x = align_in(h_area, f.x, w, PageFrame::h_align(frame.as_ref(), f.h_align)) - if f.h_align.is_none() { legacy } else { 0.0 };
    let r = clear_of_float_tables(Rect::new(x, align_in(v_area, y_off, h, v_align), w, h), f, legacy, h_area.0, float_tables);
    let [dl, dt, dr, db] = f.dist_from_text();
    (r, r.inset(-dl, -dt, -dr, -db))
}

/// Floating table `f` at `r`, moved below the floating tables in its way when it may not
/// overlap them. In Word 2013+ layout one placed by an offset keeps its distance from the text's
/// left edge (`text_left`).
pub(crate) fn clear_of_float_tables(mut r: Rect, f: &TableFloat, legacy: f32, text_left: f32, others: &[Rect]) -> Rect {
    let [dl, dt, dr, db] = f.dist_from_text();
    let keeps_text_distance = legacy == 0.0 && f.h_align.is_none() && f.x >= 0.0 && matches!(f.h_rel, Anchor::Margin | Anchor::Column);
    for _ in 0..64 {
        let area = r.inset(-dl, -dt, -dr, -db);
        let Some(below) = others.iter().filter(|o| !f.overlap && o.intersects(&area)).map(|o| o.bottom()).reduce(f32::max) else { break };
        r.y = below + dt;
        if keeps_text_distance {
            r.x = r.x.max(text_left + dl);
        }
    }
    r
}

/// A text box's default internal margins (Word's: 0.1" left/right, 0.05" top/bottom); a box's
/// own come from its [`ew_doc::TextBody`].
#[cfg(test)]
pub(crate) const BOX_INSET_X: f32 = 7.2;

#[cfg(test)]
pub(crate) const BOX_INSET_Y: f32 = 3.6;

/// Keep what fits in a box `height` tall (items relative to its top): lines that don't fit are
/// dropped (whole lines; a line that only partly fits too) and so is anything starting below.
/// The first line always stays, so even a tiny box shows the start of its text.
pub(crate) fn fit_box(items: Vec<Placed>, height: f32) -> Vec<Placed> {
    let limit = height + 0.5;
    let mut out = Vec::with_capacity(items.len());
    let mut kept_line = false;
    for it in items {
        if let Some(r) = it.turned_bounds() {
            // Turned text (in a table cell) stays whole.
            if r.y < limit {
                out.push(it);
            }
            continue;
        }
        match it {
            Placed::Lines { story, path, para, l0, l1, x, y, turn } => {
                let Some(first) = para.lines.get(l0) else { continue };
                let mut end = l0;
                for k in l0..l1 {
                    let Some(l) = para.lines.get(k) else { break };
                    if y + (l.top - first.top) + l.height > limit && kept_line {
                        break;
                    }
                    end = k + 1;
                    kept_line = true;
                }
                if end > l0 {
                    out.push(Placed::Lines { story, path, para, l0, l1: end, x, y, turn });
                }
            }
            Placed::Fill { rect, color } if rect.y < limit => {
                out.push(Placed::Fill { rect: Rect::new(rect.x, rect.y, rect.w, rect.h.min(limit - rect.y)), color });
            }
            Placed::Rule { x0, y0, x1, y1, border } if y0.min(y1) < limit => {
                out.push(Placed::Rule { x0, y0: y0.min(limit), x1, y1: y1.min(limit), border });
            }
            Placed::Image { rect, .. }
            | Placed::Shape { rect, .. }
            | Placed::Graphic { rect, .. }
            | Placed::Clip { rect, .. }
            | Placed::Cell { rect, .. }
            | Placed::Object { rect, .. }
                if rect.y < limit =>
            {
                out.push(it);
            }
            _ => {}
        }
    }
    out
}

/// Word joins neighbouring paragraphs with the same borders and indents into one box: the top
/// border goes above the first of them only, the bottom one below the last, and the shading and
/// side borders run on through the space between them (`table`: the cell's paragraph properties).
fn border_group(doc: &Document, a: &Paragraph, b: &Paragraph, table: Option<&ew_doc::props::ParaProps>) -> bool {
    let (a, b) = (doc.styles.resolve_para_in(&a.props, table), doc.styles.resolve_para_in(&b.props, table));
    a.borders.is_some() && a.borders == b.borders && a.indent_left == b.indent_left && a.indent_right == b.indent_right
}

/// Whether paragraph `i` of `blocks` and the one at `j` are of one border group.
pub(crate) fn joined(doc: &Document, blocks: &Blocks, i: usize, j: Option<usize>, table: Option<&ew_doc::props::ParaProps>) -> bool {
    match (blocks.get(i).map(|b| &**b), j.and_then(|j| blocks.get(j)).map(|b| &**b)) {
        (Some(Block::Para(a)), Some(Block::Para(b))) => border_group(doc, a, b, table),
        _ => false,
    }
}

/// The room a paragraph's top or bottom border takes in the text flow: its distance from the
/// text plus its line's room (Word).
pub(crate) fn border_room(b: Option<Border>) -> f32 {
    b.filter(Border::is_visible).map_or(0.0, |b| b.space + line_room(&b))
}

/// EasyWriter: how much room a paragraph or cell border's line takes across, by its style, as Word gives it. w is the
/// width (`w:sz` / 8). Word probes at `w:sz` 1 to 100 (wp/border-widths in docs/plans/engine/page-walk-findings.md).
pub(crate) fn line_room(b: &Border) -> f32 {
    use ew_doc::props::BorderStyle as S;
    let w = b.width;
    match b.style {
        S::Double | S::ThinThickThinMediumGap => 3.0 * w,
        S::Triple => 5.0 * w,
        S::Wave => if w >= 1.5 { 3.75 } else { 3.0 },
        S::DoubleWave => 5.25,
        S::DashDotStroked => 3.0,
        S::ThinThickMediumGap | S::ThickThinMediumGap => 2.0 * w,
        S::ThinThickSmallGap | S::ThickThinSmallGap => w + 1.5,
        S::ThinThickLargeGap | S::ThickThinLargeGap => w + 2.25,
        S::ThinThickThinSmallGap => w + 3.0,
        S::ThinThickThinLargeGap => 2.0 * w + 3.0,
        S::ThreeDEmboss | S::ThreeDEngrave => if w >= 3.0 { w + 3.0 } else { w + 1.5 },
        _ => w,
    }
}

/// EasyWriter: the lines Word draws across a border's room, from its outer side in: where each starts (points from the
/// outer side), its width and its colour; `None` for a style drawn as one stroke. `lit`: the edge faces up or left (a top
/// or left edge), a 3-D style's light side. Read off Word's PDF of the fixture at 1.5 pt (pages 67 and 68, the PDF's 0.72 pt
/// steps): the lines keep page order on every edge (top to bottom, left to right), so the thick line of a thin-thick style
/// lies outside on the top and left edges and inside on the bottom and right ones; thin lines and small gaps are 0.75 pt, medium ones half the
/// width, large gaps 1.5 pt; a triple is three lines a width apart; the 3-D styles are a 0.75 pt (1.5 pt from 3 pt up) line
/// each side of a mid-grey one, light outside on the lit side of an emboss and inside elsewhere (an engrave the other way).
/// Each sums to [`line_room`].
pub(crate) fn border_lines(b: &Border, lit: bool) -> Option<Vec<(f32, f32, Option<Rgb>)>> {
    use ew_doc::props::BorderStyle as S;
    let w = b.width;
    let (t, s) = (0.75, if w >= 3.0 { 1.5 } else { 0.75 });
    // Line, gap, line... from the outer side in, as on a top or left edge.
    let mut parts: Vec<f32> = match b.style {
        S::Triple => vec![w, w, w, w, w],
        S::ThinThickSmallGap => vec![w, t, t],
        S::ThickThinSmallGap => vec![t, t, w],
        S::ThinThickMediumGap => vec![w, w / 2.0, w / 2.0],
        S::ThickThinMediumGap => vec![w / 2.0, w / 2.0, w],
        // engine-fidelity-3: a large gap is the width, between a 1.5 pt line and a thin one (probe pageborder at 3 pt: 1.44,
        // 3.00 and 0.72 in Word's steps); at 1.5 pt the two readings agree.
        S::ThinThickLargeGap => vec![1.5, w, t],
        S::ThickThinLargeGap => vec![t, w, 1.5],
        S::ThinThickThinSmallGap => vec![t, t, w, t, t],
        S::ThinThickThinMediumGap => vec![w / 2.0, w / 2.0, w, w / 2.0, w / 2.0],
        // ponytail: gaps of (w + 1.5) / 2 give the probed room 2w + 3; drawn at 1.5 pt only, where they are 1.5 pt.
        S::ThinThickThinLargeGap => vec![t, (w + 1.5) / 2.0, w, (w + 1.5) / 2.0, t],
        S::ThreeDEmboss | S::ThreeDEngrave => vec![s, 0.0, w, 0.0, s],
        _ => return None,
    };
    // The 3-D greys of an automatic (black) line, #c0c0c0 and #606060 over black; other colours by `three_d_shades`.
    let (light, mid, base) = match b.color.filter(|c| *c != Rgb::BLACK) {
        None => (Some(Rgb(0xC0, 0xC0, 0xC0)), Some(Rgb(0x60, 0x60, 0x60)), Rgb::BLACK),
        Some(c) => {
            let (l, m, d) = three_d_shades(c);
            (Some(l), Some(m), d)
        }
    };
    let three_d = matches!(b.style, S::ThreeDEmboss | S::ThreeDEngrave);
    // Word keeps page order (p67 thinThickSmallGap: the bottom's thick line at 761.14 above its thin one at 763.30), so a
    // bottom or right edge lists the lines the other way from its outer side. The 3-D styles flip by colour instead.
    if !lit && !three_d {
        parts.reverse();
    }
    let light_outside = lit == (b.style == S::ThreeDEmboss);
    let mut out = Vec::new();
    let mut at = 0.0;
    for (i, len) in parts.iter().enumerate() {
        if i % 2 == 0 {
            let color = match (three_d, i) {
                (false, _) => b.color,
                (true, 2) => mid,
                (true, 0) => if light_outside { light } else { Some(base) },
                (true, _) => if light_outside { Some(base) } else { light },
            };
            out.push((at, *len, color));
        }
        at += len;
    }
    Some(out)
}

/// EasyWriter engine-fidelity-4: Word's light, middle and dark shades of a coloured 3-D border line (probe borders3d-15, 15
/// colours, and engine-fidelity-3's three), in HLS with lightness out of 240: a colour at least half light is its own light
/// shade, a darker one is lightened by 40 for it; the middle and dark shades are the light one darkened by 70 and 80, hue and
/// saturation kept (#7030A0: #9b58cd, #4f226f, #431d5f; #FF0000: itself, #6b0000, #550000). ponytail: two of the 18 colours
/// are off it, both light ones whose darker shades Word also desaturates (white: #a0a0a0 and #808080, this #b5b5b5 and
/// #aaaaaa; #F4B183: #c16121 and #bb5511, this #d06012 and #bc5711); probe more light colours to find that rule.
pub(crate) fn three_d_shades(c: Rgb) -> (Rgb, Rgb, Rgb) {
    let [r, g, b] = [c.0, c.1, c.2].map(|v| f32::from(v) / 255.0);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let l = (max + min) / 2.0;
    let d = max - min;
    let s = if d == 0.0 { 0.0 } else { d / (1.0 - (2.0 * l - 1.0).abs()) };
    let h = if d == 0.0 {
        0.0
    } else if max == r {
        ((g - b) / d).rem_euclid(6.0)
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    // HSL back to RGB, `h` in sixths of a turn.
    let rgb = |l: f32| {
        let l = l.clamp(0.0, 1.0);
        let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
        let x = c * (1.0 - (h.rem_euclid(2.0) - 1.0).abs());
        let (r1, g1, b1) = match h as u32 {
            0 => (c, x, 0.0),
            1 => (x, c, 0.0),
            2 => (0.0, c, x),
            3 => (0.0, x, c),
            4 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };
        let m = l - c / 2.0;
        let v = |t: f32| ((t + m) * 255.0).round().clamp(0.0, 255.0) as u8;
        Rgb(v(r1), v(g1), v(b1))
    };
    let light = if l < 0.5 { l + 40.0 / 240.0 } else { l };
    (rgb(light), rgb(light - 70.0 / 240.0), rgb(light - 80.0 / 240.0))
}

/// EasyWriter: a border edge from (`x0`, `y0`) to (`x1`, `y1`) (left to right, top to bottom) on its room's centre, as the
/// lines Word draws (`border_lines`) or as one rule. `out` is the unit vector pointing away from what it borders. At an end
/// that meets another edge (`ends`) each line reaches as far along the edge as it lies outward, so the lines of a box nest
/// at its corners; `inset` is how far inside the room's outer side the edge's ends already lie (the room's half for a side
/// edge drawn over the top and bottom rooms).
pub(crate) fn push_rules(items: &mut Vec<Placed>, (x0, y0, x1, y1): (f32, f32, f32, f32), border: Border, out: (f32, f32), (inset, ends): (f32, (bool, bool))) {
    let Some(lines) = border_lines(&border, out.0 < 0.0 || out.1 < 0.0) else {
        items.push(Placed::Rule { x0, y0, x1, y1, border });
        return;
    };
    let room = line_room(&border);
    let along = if (y1 - y0).abs() > (x1 - x0).abs() { (0.0, 1.0) } else { (1.0, 0.0) };
    for (at, width, color) in lines {
        // The line's centre, outward from the room's centre.
        let d = room / 2.0 - at - width / 2.0;
        let grow = d - inset;
        let (dx, dy) = (out.0 * d, out.1 * d);
        let (g0, g1) = (if ends.0 { grow } else { 0.0 }, if ends.1 { grow } else { 0.0 });
        let b = Border { style: ew_doc::props::BorderStyle::Single, width, color, space: border.space };
        items.push(Placed::Rule { x0: x0 + dx - along.0 * g0, y0: y0 + dy - along.1 * g0, x1: x1 + dx + along.0 * g1, y1: y1 + dy + along.1 * g1, border: b });
    }
}

/// How a piece of a paragraph meets the paragraphs around it: the room taken by its top and
/// bottom borders (0: none drawn there — the paragraph goes on from or into one of its border
/// group, or it is split there) and how far its shading and side borders reach up to join the
/// paragraph above in its group.
#[derive(Clone, Copy, Default)]
pub(crate) struct Edges {
    pub(crate) top: f32,
    pub(crate) bottom: f32,
    pub(crate) up: f32,
}

impl Edges {
    /// A paragraph on its own: its top and bottom borders at its ends.
    pub(crate) fn own(pl: &ParaLayout, l0: usize, l1: usize) -> Edges {
        let b = pl.rp.borders.unwrap_or_default();
        Edges { top: if l0 == 0 { border_room(b.top) } else { 0.0 }, bottom: if l1 >= pl.lines.len() { border_room(b.bottom) } else { 0.0 }, up: 0.0 }
    }
}

/// Paragraph lines plus their shading and borders; returns the bottom of the lines. The
/// shading fills the box out to the borders, the room they take included (Word).
pub(crate) fn push_para(
    items: &mut Vec<Placed>,
    (story, path): (StoryRef, &[u32]),
    pl: &Arc<ParaLayout>,
    (l0, l1): (usize, usize),
    (x, y): (f32, f32),
    width: f32,
    e: Edges,
) -> f32 {
    let (Some(first), Some(last)) = (pl.lines.get(l0), l1.checked_sub(1).and_then(|k| pl.lines.get(k))) else {
        return y;
    };
    let h = last.top + last.height - first.top;
    // Indents are logical: a right-to-left paragraph's start indent (and hanging indent) is on the right.
    let start = pl.rp.indent_left.min(pl.rp.indent_left + pl.rp.indent_first);
    let (li, ri) = if pl.rp.bidi { (pl.rp.indent_right, start) } else { (start, pl.rp.indent_right) };
    let left = x + li;
    let right = x + width - ri;
    let (top, bottom) = (y - e.top - e.up, y + h + e.bottom);
    if let Some(c) = pl.rp.shading {
        let pad = pl.rp.borders.as_ref().map(|b| b.left.map(|l| l.space).unwrap_or(4.0)).unwrap_or(0.0);
        items.push(Placed::Fill { rect: Rect::new(left - pad, top, right - left + pad * 2.0, bottom - top), color: c });
    }
    items.push(Placed::Lines { story, path: Path(path.to_vec()), para: pl.clone(), l0, l1, x, y, turn: TextDirection::Horizontal });
    if let Some(b) = &pl.rp.borders {
        let sp = |o: &Option<Border>| o.map(|b| b.space).unwrap_or(0.0);
        let (lx, rx) = (left - sp(&b.left), right + sp(&b.right));
        // The top and bottom lines lie beyond their distance from the text.
        let sides = (b.left.is_some_and(|t| t.is_visible()), b.right.is_some_and(|t| t.is_visible()));
        let ends = (b.top.is_some_and(|t| e.top > 0.0 && t.is_visible()), b.bottom.is_some_and(|t| e.bottom > 0.0 && t.is_visible()));
        if let Some(t) = b.top.filter(|t| e.top > 0.0 && t.is_visible()) {
            let ty = y - t.space - line_room(&t) / 2.0;
            push_rules(items, (lx, ty, rx, ty), t, (0.0, -1.0), (0.0, sides));
        }
        if let Some(t) = b.bottom.filter(|t| e.bottom > 0.0 && t.is_visible()) {
            let by = y + h + t.space + line_room(&t) / 2.0;
            push_rules(items, (lx, by, rx, by), t, (0.0, 1.0), (0.0, sides));
        }
        if let Some(t) = b.left.filter(Border::is_visible) {
            push_rules(items, (lx, top, lx, bottom), t, (-1.0, 0.0), (line_room(&t) / 2.0, ends));
        }
        if let Some(t) = b.right.filter(Border::is_visible) {
            push_rules(items, (rx, top, rx, bottom), t, (1.0, 0.0), (line_room(&t) / 2.0, ends));
        }
    }
    y + h
}
