use std::collections::VecDeque;
use std::ops::Range;

use ew_doc::para::NoteKind;

use super::cache::{
    LayoutCache, MAX_GROWTH, MAX_TOTAL_PASSES, Mark, PbState, Resume, Shift, Totals, Walk, env_hash, has_page_fields, has_page_number_fields,
    has_total_fields, hash_of,
};
use super::ctx::{Ctx, with_pct_base};
use super::floats::{EarlyFloats, MAX_REWRAP_PASSES, WrapArea, early_covered, left_out_objects, merge_early};
use super::flow::{OutlinePass, place_outline_para, place_para};
use super::headers::{
    HfLinks, bookmark_pages, headers_footers, headers_footers_refer_to_pages, headers_footers_where, marks_key, mirror_even_pages, section_side,
};
use super::notes::{MAX_NOTE_PAGES, MAX_NOTE_PASSES, NoteSeps, footnote_pages, note_info, place_endnotes};
use super::page::{PageBuilder, body_top_for, foot_top_for, item_bottom};
use super::placed::Placed;
use super::table_flow::{place_container, place_table};

pub(crate) mod progress;

use super::{
    Arc, Block, BlockIds, Counters, DocLayout, Document, FieldCtx, HashMap, HideDeleted, InlineObject, LayoutOptions, Page, Paragraph, Path, SectionProps,
    SectionStart, StoryRef, TextDirection, ViewMode, balloons, fields, para, styleref, vertical,
};

/// How the view lays the document out: `web` for the continuous views, `reflow` for those and
/// the reading view, which both ignore the sections' page geometry.
#[derive(Clone, Copy)]
struct Mode {
    web: bool,
    reflow: bool,
}

impl Mode {
    fn of(view: ViewMode) -> Self {
        let web = matches!(view, ViewMode::Web | ViewMode::Draft | ViewMode::Outline);
        Mode { web, reflow: web || view == ViewMode::Read }
    }
}

/// Where a section's pages start and end: the body below the headers (on the first page, and on
/// the others) and the foot above the footers.
struct Tops {
    body: f32,
    first: f32,
    foot: f32,
    first_foot: f32,
}

/// A section being laid out: its index, its properties as laid out (turned for vertical text),
/// how it starts and its [`Tops`].
struct Sec<'p> {
    si: usize,
    sect: &'p SectionProps,
    start: SectionStart,
    tops: Tops,
}

/// Forget cached layouts made for another environment, and what the last pass used.
fn reset_cache(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions) {
    let env = env_hash(doc, opts);
    if env != cache.env {
        cache.paras.clear();
        cache.measures.clear();
        cache.fonts.clear();
        cache.tables.clear();
        cache.env = env;
    }
    cache.used.clear();
}

/// The numbers of the notes the body refers to ([`note_info`]) and their hash.
pub(crate) fn note_numbers(doc: &Document, opts: &LayoutOptions, note_pages: &HashMap<u32, usize>) -> (Arc<HashMap<u32, fields::NoteNum>>, u64) {
    let notes = note_info(doc, &opts.hides_deleted(StoryRef::Body), note_pages);
    let hash = hash_of(&{
        let mut v: Vec<_> = notes.iter().map(|(a, b)| (*a, b.n, b.fmt)).collect();
        v.sort_by_key(|(a, ..)| *a);
        v
    });
    (Arc::new(notes), hash)
}

/// The walk state at the start of a pass, with the note references the body shows.
/// `known`: the note numbers and their hash, when a pass before found them for the same references.
fn new_ctx<'a>(
    doc: &'a Document,
    cache: &'a mut LayoutCache,
    opts: &'a LayoutOptions,
    (note_pages, totals): (&HashMap<u32, usize>, &Totals),
    (known, ids): (Option<(Arc<HashMap<u32, fields::NoteNum>>, u64)>, BlockIds),
) -> Ctx<'a> {
    let (notes, notes_hash) = known.unwrap_or_else(|| note_numbers(doc, opts, note_pages));
    // EasyWriter engine-fixes-layout: a table's row memo goes with the table. It is kept by the table's id, which names no
    // table once the table is deleted, so pasting and deleting tables in a session does not grow the cache.
    cache.tables.retain(|path, _| path.first().and_then(|id| ids.block(*id)).and_then(|b| doc.body.get(b)).is_some_and(|b| b.as_para().is_none()));
    Ctx {
        doc,
        cache,
        opts,
        hide_deleted: opts.hides_deleted(StoryRef::Body),
        counters: Counters::default(),
        fields: FieldCtx {
            page: 1,
            pages: totals.pages,
            section_pages: totals.section(0),
            section: 1,
            notes,
            title: doc.core.title.as_str().into(),
            author: doc.core.creator.as_str().into(),
            filename: opts.filename.clone().unwrap_or_else(|| "".into()),
            filepath: opts.filepath.clone().unwrap_or_else(|| "".into()),
            ..Default::default()
        },
        notes_hash,
        numbers: HashMap::new(),
        eq_count: 0,
        boxes: ew_doc::BoxBudget::default(),
        chains: Default::default(),
        grid: para::Grid::default(),
        uses_totals: false,
        track_totals: true,
        pct_base: None,
        quiet_marks: Vec::new(),
        stacked_marks: Vec::new(),
        mirror: false,
        table_keys: Vec::new(),
        fitted: HashMap::new(),
        header_tables: HashMap::new(),
        footer_wraps: HashMap::new(),
        pin: None,
        floats_above: HashMap::new(),
        hf: Arc::new(HfLinks::new(doc.sections())),
        alphas: Default::default(),
        folded: Vec::new(),
        ids,
        join: Default::default(),
    }
}

/// The blocks whose paragraph mark takes no room: the empty paragraph ending a section that a
/// continuous break follows, and empty paragraphs with hidden marks while hidden text is not shown.
fn section_marks(doc: &Document, opts: &LayoutOptions, sections: &[(usize, &SectionProps)]) -> (Vec<usize>, Vec<usize>) {
    let (stacked, mut quiet): (Vec<_>, Vec<_>) = sections
        .windows(2)
        .filter(|w| w[1].1.start == SectionStart::Continuous)
        .map(|w| w[0].0)
        .filter(|end| doc.body.get(*end).and_then(|b| b.as_para()).is_some_and(|p| p.text.is_empty()))
        .partition(|end| {
            // Only a leading run mark is quiet; later marks stack at the page bottom (Word, #3907).
            end.checked_sub(1).and_then(|i| doc.body.get(i)).and_then(|b| b.as_para()).is_some_and(|p| p.section.is_some() && p.text.is_empty())
        });
    if !opts.show_hidden {
        let deleted = opts.hides_deleted(StoryRef::Body);
        quiet.extend(
            doc.body
                .iter()
                .enumerate()
                .filter_map(|(i, b)| b.as_para().filter(|p| p.mark.hidden == Some(true) && p.plain_text().is_empty()).map(|_| i))
                // An empty style separator takes its room in the next paragraph's line instead (`run_in`).
                .filter(|&i| crate::run_in::joined(doc, &doc.body, i, crate::run_in::Shown { hidden: false, deleted: &deleted, table: None }).is_none()),
        );
    }
    quiet.sort_unstable();
    quiet.dedup();
    (stacked, quiet)
}

/// The room the continuous views leave round the text, never negative, [`crate::WEB_MARGIN`] when it is not a number.
fn web_margin(opts: &LayoutOptions) -> f32 {
    if opts.web_margin.is_finite() { opts.web_margin.max(0.0) } else { crate::WEB_MARGIN }
}

/// The page the continuous views lay out on: the first section's, as wide as the window (and as
/// high in the reading view), with small margins and one column.
fn reflow_sect(first: &SectionProps, opts: &LayoutOptions) -> SectionProps {
    let mut s = first.clone();
    let margin = web_margin(opts);
    s.page_w = if opts.web_width.is_finite() { opts.web_width.clamp(144.0, 20_000.0) } else { 300.0 };
    if opts.view == ViewMode::Read {
        s.page_h = if opts.read_height.is_finite() { opts.read_height.clamp(144.0, 20_000.0) } else { 500.0 };
        s.margin_bottom = margin;
        s.page_borders = None;
        s.line_numbers = None;
    }
    s.margin_left = margin;
    s.margin_right = margin;
    s.margin_top = margin;
    s.gutter = 0.0;
    s.columns = Default::default();
    s.valign = ew_doc::section::PageVAlign::Top;
    s
}

fn new_page_builder<'p>(sect: &'p SectionProps, early: &'p EarlyFloats, (web, settle): (bool, bool), ids: BlockIds) -> PageBuilder<'p> {
    PageBuilder {
        pages: Vec::new(),
        sect,
        sect_idx: 0,
        col: 0,
        cols: Vec::new(),
        y: 0.0,
        top: 0.0,
        page_top: 0.0,
        bottom: 0.0,
        number: 0,
        web,
        notes: Vec::new(),
        carry: Vec::new(),
        orig_bottom: 0.0,
        prev: None,
        after_break_mark: false,
        next_starts_page: false,
        restart_at: None,
        excl: Vec::new(),
        frame: None,
        float_tables: Vec::new(),
        line_no: 0,
        page_items_start: 0,
        block_marks: Vec::new(),
        page_valign: ew_doc::section::PageVAlign::Top,
        seps: NoteSeps::default(),
        para_end: None,
        behind: Vec::new(),
        max_y: 0.0,
        content_bottom: 0.0,
        balance: None,
        col_break_page: None,
        sect_beneath: false,
        beneath: false,
        foot_top: f32::MAX,
        early,
        seeded: 0,
        settle,
        row: Vec::new(),
        ids,
    }
}

/// Endnotes in document order, with the section of their reference; placed at the end of a
/// section that keeps them there, else at the end of the document.
fn endnote_queue(ctx: &Ctx) -> VecDeque<(u32, usize)> {
    let mut ids: Vec<(u32, u32, usize)> = ctx
        .fields
        .notes
        .iter()
        .filter(|(id, _)| ctx.doc.parts.get(id).is_some_and(|p| p.kind == ew_doc::PartKind::Endnote))
        .map(|(id, n)| (n.order, *id, n.section))
        .collect();
    ids.sort();
    ids.into_iter().map(|(_, id, sect)| (id, sect)).collect()
}

/// Vertical sections are laid out on their pages turned on their side (see `vertical`).
fn turned_sections(ctx: &mut Ctx, sections: &[(usize, &SectionProps)], web: bool) -> Vec<Option<SectionProps>> {
    sections
        .iter()
        .map(|(_, s)| {
            (!web && s.text_direction.is_turned()).then(|| {
                let top = body_top_for(ctx, s, s.headers.default);
                vertical::unturned_sect(s, top)
            })
        })
        .collect()
}

/// Where section `si`'s pages start and end. Headers and footers left out are linked to the
/// previous section's, and take its room. `fixed`: the margins are the room (continuous views and
/// turned sections).
fn section_tops(ctx: &mut Ctx, hf: &HfLinks, (si, sect): (usize, &SectionProps), fixed: bool) -> Tops {
    let (heads, feet) = (hf.heads.set(si), hf.feet.set(si));
    let hb = |i: Option<u32>| hf.defining_width(false, si, i);
    let fb = |i: Option<u32>| hf.defining_width(true, si, i);
    let body = if fixed { sect.margin_top } else { with_pct_base(ctx, hb(heads.default), |c| body_top_for(c, sect, heads.default)) };
    let first = if fixed || !sect.title_page { body } else { with_pct_base(ctx, hb(heads.first), |c| body_top_for(c, sect, heads.first)) };
    let foot = if fixed { f32::MAX } else { with_pct_base(ctx, fb(feet.default), |c| foot_top_for(c, sect, feet.default)) };
    let first_foot = if fixed || !sect.title_page { foot } else { with_pct_base(ctx, fb(feet.first), |c| foot_top_for(c, sect, feet.first)) };
    Tops { body, first, foot, first_foot }
}

/// Set up the walk state for a section: its grid, field values and footnote separators.
fn begin_section_state<'p>(ctx: &mut Ctx, pb: &mut PageBuilder<'p>, sec: &Sec<'p>, totals: &Totals, web: bool) {
    let (doc, sect, si) = (ctx.doc, sec.sect, sec.si);
    pb.sect = sect;
    pb.sect_idx = si;
    pb.sect_beneath = doc.note_options(sect, false).pos == ew_doc::section::NotePos::BeneathText;
    if !web && !doc.footnote_separators.is_empty() {
        pb.seps = NoteSeps::new(ctx, &doc.footnote_separators, sect.text_width());
    }
    ctx.fields.section = u32::try_from(si).unwrap_or(u32::MAX).saturating_add(1);
    ctx.fields.section_pages = totals.section(si);
    ctx.grid = para::Grid::of(doc, sect);
    if sect.line_numbers.as_ref().is_some_and(|l| l.restart == ew_doc::section::LineNumberRestart::Section) {
        pb.line_no = 0;
    }
}

/// The blank page that puts a section on the right side ends the previous section.
fn end_previous_section<'p>(ctx: &mut Ctx, pb: &mut PageBuilder<'p>, hf: &HfLinks<'p>, si: usize, block: usize) {
    let Some((_, prev)) = si.checked_sub(1).and_then(|k| hf.sections.get(k)) else { return };
    pb.sect = prev;
    pb.sect_idx = si - 1;
    let (ph, pf) = (hf.heads.set(si - 1), hf.feet.set(si - 1));
    let top = body_top_for(ctx, prev, ph.default);
    pb.foot_top = foot_top_for(ctx, prev, pf.default);
    pb.new_page(block, top);
}

/// Start the section on a new page, after the blank one that puts it on the right side if any.
fn start_section_page<'p>(ctx: &mut Ctx, pb: &mut PageBuilder<'p>, hf: &HfLinks<'p>, sec: &Sec<'p>, (mode, block): (Mode, usize)) {
    // A page holds text running one way: a section turning the other way starts a page.
    if !mode.web {
        pb.take_back_break_page();
    }
    let s = &ctx.doc.settings;
    let (filler, restart) = section_side(sec.start, sec.sect.page_num_start, pb.number, pb.pages.len(), s.even_odd_headers, s.mirror_margins);
    if filler && !mode.web {
        end_previous_section(ctx, pb, hf, sec.si, block);
        pb.sect = sec.sect;
        pb.sect_idx = sec.si;
    }
    if restart.is_some() {
        pb.restart_at = restart;
    }
    pb.foot_top = sec.tops.first_foot;
    pb.new_page(block, sec.tops.first);
}

/// Continuous: new column layout below the current text (its tallest column).
fn continue_page(pb: &mut PageBuilder, sect: &SectionProps) {
    pb.cols = sect.column_boxes();
    pb.col = 0;
    pb.top = pb.text_bottom();
    pb.y = pb.top;
    pb.max_y = pb.top;
}

/// Whether the section's last page balances its columns (see [`balance_columns`]), and set what
/// the builder needs to know about the sections after it. Newspaper columns are balanced when the
/// next section starts on the same page (a continuous break), as in Word. That page is laid out
/// again from the start of the block that reaches it, with shorter columns.
fn prepare_section_end(pb: &mut PageBuilder, sections: &[(usize, &SectionProps)], (si, web): (usize, bool)) -> bool {
    let next = sections.get(si + 1).map(|(_, s)| s.start);
    let balance = !web && pb.cols.len() > 1 && pb.sect.valign == ew_doc::section::PageVAlign::Top && next == Some(SectionStart::Continuous);
    pb.col_break_page = None;
    pb.next_starts_page = !web && next.is_some_and(|s| s != SectionStart::Continuous);
    balance
}

fn place_block(ctx: &mut Ctx, pb: &mut PageBuilder, outline: &Option<OutlinePass>, block: usize, body_top: f32) {
    let Some(b) = ctx.doc.body.get(block) else { return };
    if ctx.folded.get(block).copied().unwrap_or(false) {
        // Under a collapsed heading: list numbers still count it.
        if let Block::Para(p) = &**b {
            ctx.next_label(p);
        }
        return;
    }
    match (&**b, outline) {
        (Block::Para(p), Some(o)) => place_outline_para(ctx, pb, p, block, o),
        (Block::Table(_) | Block::Container(_), Some(o)) if o.hidden.get(block).copied().unwrap_or(false) => {}
        (Block::Para(p), None) => place_para(ctx, pb, p, block, body_top),
        (Block::Table(t), _) => place_table(ctx, pb, t, block, body_top),
        (Block::Container(c), _) => place_container(ctx, pb, c, block, body_top),
    }
}

/// Place the blocks from `block` to `last` of section `si`, balancing the columns of the last page if asked. Returns the
/// block after them and the text boxes laid out in the balancing attempts thrown away, or `None` when `track` says the
/// old pages take over from here.
fn place_section_blocks<'p>(
    ctx: &mut Ctx,
    pb: &mut PageBuilder<'p>,
    outline: &Option<OutlinePass>,
    (mut block, last): (usize, usize),
    (balance, body_top): (bool, f32),
    (track, si): (&mut Track, usize),
) -> Option<(usize, usize)> {
    let mut from = balance.then(|| (block, Snap::take(pb, ctx)));
    while block <= last && ctx.doc.body.get(block).is_some() {
        if track.boundary(ctx, pb, (block, si, false), balance) {
            return None;
        }
        let before = balance.then(|| (pb.pages.len(), Snap::take(pb, ctx)));
        pb.mark_block();
        place_block(ctx, pb, outline, block, body_top);
        if let Some((pages, snap)) = before
            && pb.pages.len() != pages
        {
            from = Some((block, snap));
        }
        block += 1;
    }
    let discarded = from.map_or(0, |(first, snap)| balance_columns(ctx, pb, (first, block), &snap, body_top));
    Some((block, discarded))
}

/// Endnotes at the end of the section: those referenced so far.
fn section_endnotes(ctx: &mut Ctx, pb: &mut PageBuilder, endnotes: &mut VecDeque<(u32, usize)>, (sect, si, block): (&SectionProps, usize, usize)) {
    if ctx.doc.note_options(sect, true).pos != ew_doc::section::NotePos::SectEnd || pb.pages.is_empty() {
        return;
    }
    let mut here = Vec::new();
    while let Some((id, _)) = endnotes.front().filter(|(_, s)| *s <= si).copied() {
        endnotes.pop_front();
        here.push(id);
    }
    place_endnotes(ctx, pb, here, block.saturating_sub(1));
}

/// Finish the pages: vertical alignment, the footnotes still continuing after the last page
/// (each page takes at least a line of the first note, so this ends; the cap is a backstop), and
/// the turned pages of vertical sections from page `from` on (those before it were laid out earlier).
/// Also how many items each page put behind its text.
fn finish_pages(pb: PageBuilder, doc: &Document, sections: &[(usize, &SectionProps)], web: bool, from: usize) -> (Vec<Page>, Vec<usize>) {
    let mut pb = pb;
    pb.apply_valign();
    pb.flush_notes();
    let last_block = doc.body.len().saturating_sub(1);
    for _ in 0..MAX_NOTE_PAGES {
        if pb.carry.is_empty() {
            break;
        }
        let top = pb.top;
        pb.new_page(last_block, top);
        pb.flush_notes();
    }
    pb.carry.clear();
    let mut pages = pb.pages;
    if !web {
        turn_pages(pages.get_mut(from..).unwrap_or_default(), sections);
    }
    (pages, pb.behind)
}

/// The turned pages of vertical sections among `pages`.
fn turn_pages(pages: &mut [Page], sections: &[(usize, &SectionProps)]) {
    for p in pages {
        if let Some((_, s)) = sections.get(p.section) {
            vertical::turn_page(p, s.text_direction, s);
        }
    }
}

/// The web page is one long page as high as its text, with `margin` of room below it.
fn fit_web_page(pages: &mut [Page], margin: f32) {
    let Some(p) = pages.first_mut() else { return };
    let bottom = p
        .items
        .iter()
        .filter_map(|it| if let Placed::Lines { y, para, l0, l1, .. } = it { item_bottom(*y, para, *l0, *l1) } else { None })
        .fold(0.0f32, f32::max);
    p.h = bottom + 2.0 * margin;
}

/// The floats found above their anchors (`floats`, [`Ctx::floats_above`]), if they aren't all in the `early` floats' wrap
/// areas.
fn uncovered_floats(floats: &HashMap<(usize, usize), Option<(usize, WrapArea)>>, early: &EarlyFloats) -> Option<EarlyFloats> {
    let mut found = EarlyFloats::new();
    for ((block, oi), page, area) in found_floats(floats.iter().map(|(k, v)| (*k, v))) {
        found.entry(page).or_default().push((block, oi, area));
    }
    (!early_covered(&found, early)).then_some(found)
}

/// engine-repaginate: the pass done again for the floats `found` above their anchors, as a pass paused at the last of
/// `marks` before the first page whose wrap areas they change, or the pass's first page laid out with other areas
/// ([`PassInputs::stale_from`]). The pages before it start with the same areas, so they lay out as this pass laid them out: after an edit that moved every later page's floats (a page added on page 300 of the Word
/// fixture), the pass done again from the start laid out the 300 pages before for nothing, and a key typed meanwhile did too.
/// `None` when no mark comes before that page.
fn rewrap_from(
    ctx: &Ctx,
    (found, inp): (&EarlyFloats, &PassInputs),
    mut marks: Vec<Mark>,
    (pages, behind): (&[Page], &[usize]),
    (boxes, notes): (usize, (Arc<HashMap<u32, fields::NoteNum>>, u64)),
) -> Option<Paused> {
    let moved = found.iter().filter(|(p, v)| !early_covered(&HashMap::from([(**p, (*v).clone())]), &inp.early)).map(|(p, _)| *p);
    let first = moved.min().unwrap_or(usize::MAX).min(inp.stale_from);
    // The page being filled at the mark is one before `first`, so it began with the same areas.
    let mut k = marks.partition_point(|m| m.pages <= first).checked_sub(1)?;
    while marks[k].balance && !marks[k].start {
        k = k.checked_sub(1)?;
    }
    marks.truncate(k + 1);
    let m = &marks[k];
    let from = m.pages.saturating_sub(1);
    let mut kept = pages.get(..from)?.to_vec();
    kept.extend(m.page.clone());
    let mut kept_behind = behind.get(..from)?.to_vec();
    kept_behind.extend(m.page.as_ref().map(|_| m.behind));
    let block = ctx.ids.block(m.id)?;
    let floats = ctx.floats_above.iter().filter(|((b, _), _)| *b < block).map(|(k, v)| (*k, v.clone())).collect();
    Some(Paused { env: ctx.cache.env, pages: kept, behind: kept_behind, marks, floats, boxes, notes })
}

/// The page a pass begun from `p` ([`rewrap_from`]) lays out again from: those before it are the last pass's.
pub(crate) fn rewrap_page(p: &Paused) -> usize {
    p.marks.last().map_or(0, |m| m.pages.saturating_sub(1))
}

/// The floats placed above their anchors, in order: (block, object index), page and wrap area.
fn found_floats<'f>(floats: impl IntoIterator<Item = ((usize, usize), &'f Option<(usize, WrapArea)>)>) -> Vec<((usize, usize), usize, WrapArea)> {
    let mut above: Vec<_> = floats.into_iter().filter_map(|(k, v)| v.as_ref().map(|(page, area)| (k, *page, area.clone()))).collect();
    above.sort_by_key(|(k, ..)| *k);
    above
}

/// Fill in what depends on the finished pagination: page totals and page references in headers
/// and footers (they don't make the body lay out again), mirrored margins. The totals found, as an
/// error if the body must be laid out again for them. Without `dress`, only the totals and the page references, the pages
/// being dressed in slices ([`Ending`]).
fn fill_headers_footers(
    ctx: &mut Ctx,
    pages: &mut [Page],
    sections: &[(usize, &SectionProps)],
    (totals, may_repeat): (&Totals, bool),
    dress: bool,
) -> Result<Totals, Totals> {
    let found = Totals::of(pages, sections);
    if ctx.uses_totals && may_repeat && found != *totals {
        return Err(found);
    }
    ctx.track_totals = false;
    if headers_footers_refer_to_pages(ctx.doc) {
        let marks = bookmark_pages(ctx.doc, pages, sections);
        ctx.fields.bookmarks_key = marks_key(&marks);
        ctx.fields.bookmark_pages = Arc::new(marks);
    }
    if !dress {
        return Ok(found);
    }
    headers_footers(ctx, pages, 0..pages.len(), sections, &found);
    if ctx.doc.settings.mirror_margins {
        mirror_even_pages(pages, sections);
    }
    Ok(found)
}

/// Evict paragraph layouts that weren't used this pass if the cache grew large.
fn evict_unused(cache: &mut LayoutCache) {
    if cache.paras.len() + cache.measures.len() > 4 * cache.used.len().max(1024) {
        let used = std::mem::take(&mut cache.used);
        cache.paras.retain(|k, _| used.contains(k));
        cache.measures.retain(|k, _| used.contains(k));
        cache.fonts.retain(|k, _| used.contains(k));
        cache.used = used;
    }
}

/// [`DocLayout::index`]. engine-keys-final: hashed with FxHash rather than SipHash. An edit whose walk passes the view's pages
/// splits the index at the edited page ([`split_index`]), and a pass's end indexes every page: on the Word fixture, 13,155
/// paragraphs.
pub type LineIndex = ew_proof::patterns::FxMap<(StoryRef, Path), Vec<(usize, usize)>>;

fn index_lines(pages: &[Page]) -> LineIndex {
    let mut index = LineIndex::default();
    index_pages(&mut index, pages, 0);
    index
}

/// Adds the lines of `pages`, the document's pages from `first` on, to `index`.
fn index_pages(index: &mut LineIndex, pages: &[Page], first: usize) {
    for (pi, p) in pages.iter().enumerate() {
        for (ii, it) in p.items.iter().enumerate() {
            if let Placed::Lines { story, path, .. } = it {
                let at = index.entry((*story, path.clone())).or_default();
                let k = at.partition_point(|x| *x < (first + pi, ii));
                at.insert(k, (first + pi, ii));
            }
        }
    }
}

/// engine-layout-key: the lines of the pages from `from` on taken out of `index`, in place.
fn cut_index(index: &mut LineIndex, from: usize) {
    index.retain(|_, at| {
        at.truncate(at.partition_point(|(pi, _)| *pi < from));
        !at.is_empty()
    });
}

/// engine-repaginate-2: the lines of `tail`, all on pages after those of `index`, put back in `index`.
fn join_index(index: &mut LineIndex, tail: LineIndex) {
    for (key, at) in tail {
        index.entry(key).or_default().extend(at);
    }
}

/// engine-repaginate-2: the lines on the pages from `from` on moved by `by` pages, as those pages moved.
fn shift_index(index: &mut LineIndex, from: usize, by: isize) {
    if by == 0 {
        return;
    }
    for at in index.values_mut() {
        for (pi, _) in at.iter_mut().filter(|(pi, _)| *pi >= from) {
            *pi = pi.saturating_add_signed(by);
        }
    }
}

/// The smallest range holding `a` and `b`.
pub(crate) fn union(a: Range<usize>, b: Range<usize>) -> Range<usize> {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b,
        (_, true) => a,
        _ => a.start.min(b.start)..a.end.max(b.end),
    }
}

/// Takes the lines of `pages`, the document's pages from `first` on, out of `index`.
fn unindex_pages(index: &mut LineIndex, pages: &[Page], first: usize) {
    let end = first + pages.len();
    for p in pages {
        for it in &p.items {
            if let Placed::Lines { story, path, .. } = it
                && let Some(at) = index.get_mut(&(*story, path.clone()))
            {
                at.retain(|(pi, _)| *pi < first || *pi >= end);
                if at.is_empty() {
                    index.remove(&(*story, path.clone()));
                }
            }
        }
    }
}

/// What a pass lays the sections out with besides the context and the page builder.
struct Env<'p, 'a> {
    hf: &'p HfLinks<'a>,
    turned: &'p [Option<SectionProps>],
    sect_ref: &'p SectionProps,
    mode: Mode,
    outline: &'p Option<OutlinePass>,
    totals: &'p Totals,
}

/// Lay the sections out from section `si` on, starting at the top of it, or before its block `block` with `mid` (the
/// pagination state as `mid` says, the walk state as `track`'s). Returns the block after the last one placed, or `None`
/// when `track` found where the old pages take over.
fn walk_sections<'p>(
    ctx: &mut Ctx,
    pb: &mut PageBuilder<'p>,
    env: &Env<'p, '_>,
    endnotes: &mut VecDeque<(u32, usize)>,
    (si0, mut block, mid): (usize, usize, Option<&Mark>),
    track: &mut Track,
) -> Option<usize> {
    let doc = ctx.doc;
    let sections = &env.hf.sections;
    for (si, (end, sect)) in sections.iter().enumerate().skip(si0) {
        let resumed = mid.filter(|_| si == si0);
        if resumed.is_none() && track.boundary(ctx, pb, (block, si, true), false) {
            return None;
        }
        let turn = if env.mode.reflow { TextDirection::Horizontal } else { sect.text_direction };
        let sect: &SectionProps = match env.turned.get(si) {
            Some(Some(t)) => t,
            _ if env.mode.reflow => env.sect_ref,
            _ => sect,
        };
        let tops = section_tops(ctx, env.hf, (si, sect), env.mode.reflow || turn.is_turned());
        let start = if si == 0 { SectionStart::NextPage } else { sect.start };
        let sec = Sec { si, sect, start, tops };
        let balance = match resumed {
            // Back inside the section as a mark left it: the page builder came back as it was; the context's section
            // state is set again and the rest of it put back (laying the headers out for `tops` may have used it).
            Some(m) => {
                pb.sect = sect;
                ctx.fields.section = u32::try_from(si).unwrap_or(u32::MAX).saturating_add(1);
                ctx.fields.section_pages = env.totals.section(si);
                ctx.grid = para::Grid::of(doc, sect);
                restore_ctx(ctx, m);
                false
            }
            None => {
                begin_section_state(ctx, pb, &sec, env.totals, env.mode.web);
                if env.mode.web && si > 0 {
                    // one long page
                } else if pb.pages.is_empty() || start != SectionStart::Continuous || turn != track.walk.turn {
                    start_section_page(ctx, pb, env.hf, &sec, (env.mode, block));
                } else {
                    continue_page(pb, sect);
                }
                track.walk.turn = turn;
                pb.foot_top = sec.tops.foot;
                prepare_section_end(pb, sections, (si, env.mode.web))
            }
        };
        let last = (*end).min(doc.body.len().saturating_sub(1));
        let (next, discarded) = place_section_blocks(ctx, pb, env.outline, (block, last), (balance, sec.tops.body), (track, si))?;
        block = next;
        track.walk.discarded += discarded;
        let queued = endnotes.len();
        section_endnotes(ctx, pb, endnotes, (sect, si, block));
        track.walk.endnotes += queued - endnotes.len();
    }
    Some(block)
}

/// Puts back what the context had at mark `m`.
fn restore_ctx(ctx: &mut Ctx, m: &Mark) {
    ctx.counters = m.counters.clone();
    ctx.eq_count = m.eq_count;
    ctx.fields.page = m.page_field;
    ctx.uses_totals = m.uses_totals;
}

/// A layout pass: finished, or to be done again with the page totals it found, or with the floats placed above their
/// anchors it found ([`EarlyFloats`]): the tests' view of [`Walked`], which also pauses.
#[cfg(test)]
#[allow(dead_code)]
pub(crate) enum Pass {
    Done(DocLayout),
    Again(Totals),
    Rewrap(EarlyFloats),
}

/// One layout pass, numbering footnotes restarted on each page by `note_pages` ([`note_info`]),
/// with `totals` assumed for the page totals in the body. With `may_repeat`, a pass whose body
/// shows totals that turn out different asks to be done again. Pages start with the wrap areas
/// of the `early` floats; with `may_rewrap`, a pass that finds others asks to be done again.
/// A finished pass in the print view leaves a [`Resume`] for laying the document out again after an edit ([`relayout`]).
#[cfg(test)]
pub(crate) fn layout_pass(
    doc: &Document,
    cache: &mut LayoutCache,
    opts: &LayoutOptions,
    note_pages: &HashMap<u32, usize>,
    totals: &Totals,
    may_repeat: bool,
    (early, may_rewrap): (&EarlyFloats, bool),
) -> Pass {
    let ids = BlockIds::of(&doc.body);
    let pagerefs = headers_footers_refer_to_pages(doc);
    let inp = PassInputs { note_pages: note_pages.clone(), totals: totals.clone(), may_repeat, early: early.clone(), may_rewrap, ids, stale_from: usize::MAX, pagerefs };
    match walk_pass(doc, cache, opts, &inp, Begin::Start, None) {
        Some(Walked::Again(t, _)) => Pass::Again(t),
        Some(Walked::Rewrap(found, ..)) => Pass::Rewrap(found),
        Some(Walked::Done(l)) => Pass::Done(l),
        // A pass from the start with no stop neither pauses nor fails.
        Some(Walked::Paused(..) | Walked::Caught(..) | Walked::Ending(..)) | None => Pass::Done(DocLayout::default()),
    }
}

/// What a layout pass is made with, as [`crate::layout`]'s loop sets it ([`Passes`]): the pages footnotes numbered on each
/// page are on, the page totals assumed in the body, whether a pass whose body shows other totals is done again, the floats
/// placed above their anchors that pages start with, whether a pass that finds others is done again, and the names of the
/// body's blocks, which every pass of the layout and its pages share.
#[derive(Clone)]
pub(crate) struct PassInputs {
    pub(crate) note_pages: HashMap<u32, usize>,
    pub(crate) totals: Totals,
    pub(crate) may_repeat: bool,
    pub(crate) early: EarlyFloats,
    pub(crate) may_rewrap: bool,
    pub(crate) ids: BlockIds,
    /// The first page of the pass laid out with wrap areas other than `early`'s: an edit's walk laid out its pages from there
    /// with the areas found for the pagination before the edit ([`redo_edit`], [`progress`]'s edit). A pass laid out in slices
    /// is done again from there at its end ([`rewrap_from`]); `usize::MAX` when there is none.
    pub(crate) stale_from: usize,
    /// engine-layout-key: the headers, footers or text boxes show a page by its bookmark ([`headers_footers_refer_to_pages`]),
    /// found once rather than for each slice's pages: looking cost 0.1 ms each time on the Word fixture natively.
    pub(crate) pagerefs: bool,
}

/// [`crate::layout`]'s passes: the next one's inputs and how many passes of each kind were done again.
#[derive(Clone)]
pub(crate) struct Passes {
    pub(crate) inp: PassInputs,
    totals_passes: usize,
    rewraps: usize,
    note_passes: usize,
    /// Footnotes are numbered again on each page somewhere, so they settle over passes.
    per_page: bool,
}

/// What a finished pass leaves: the layout, or its pages with the next pass set up. The pages are finished, and `dressed`
/// too (headers, footers and mirrored margins) unless the pass is done again for its totals or floats. `again`: the next
/// pass as a paused one at the last mark before what it changes, when it need not begin at the start ([`rewrap_from`]).
pub(crate) enum Next {
    Done(DocLayout),
    Again { pages: Vec<Page>, dressed: bool, again: Option<Paused> },
}

impl Passes {
    pub(crate) fn new(doc: &Document, opts: &LayoutOptions) -> Self {
        let per_page = opts.view == ViewMode::Print
            && doc.sections().iter().any(|(_, s)| doc.note_options(s, false).num_restart == ew_doc::section::NoteRestart::EachPage);
        let inp = PassInputs {
            note_pages: HashMap::new(),
            totals: Totals::first_guess(doc.sections().len()),
            may_repeat: 0 < MAX_TOTAL_PASSES,
            early: EarlyFloats::new(),
            may_rewrap: 0 < MAX_REWRAP_PASSES,
            ids: BlockIds::of(&doc.body),
            stale_from: usize::MAX,
            pagerefs: headers_footers_refer_to_pages(doc),
        };
        Passes { inp, totals_passes: 0, rewraps: 0, note_passes: 1, per_page }
    }

    /// Takes in how a pass ended. Page totals shown in the body (`NUMPAGES`, `SECTIONPAGES`) are known only after paginating:
    /// a pass is done again with the totals found until they hold (bounded), and so it is with floats found above their
    /// anchors and with footnotes numbered again on each page, until they stay where the pass before put them.
    pub(crate) fn next(&mut self, doc: &Document, walked: Walked) -> Next {
        match walked {
            Walked::Again(t, pages) => {
                self.inp.totals = t;
                self.totals_passes += 1;
                self.inp.may_repeat = self.totals_passes < MAX_TOTAL_PASSES;
                Next::Again { pages, dressed: false, again: None }
            }
            Walked::Rewrap(found, pages, again) => {
                merge_early(&mut self.inp.early, found);
                // The pass done again lays out every page from where it begins with these areas.
                self.inp.stale_from = usize::MAX;
                self.rewraps += 1;
                self.inp.may_rewrap = self.rewraps < MAX_REWRAP_PASSES;
                Next::Again { pages, dressed: false, again }
            }
            Walked::Done(l) => {
                if self.per_page && self.note_passes < MAX_NOTE_PASSES {
                    let placed = footnote_pages(doc, &l.pages);
                    if placed != self.inp.note_pages {
                        self.inp.note_pages = placed;
                        self.note_passes += 1;
                        return Next::Again { pages: l.pages, dressed: true, again: None };
                    }
                }
                Next::Done(l)
            }
            // Callers go on with a paused pass rather than ask; were one asked about, it would end the layout, not loop.
            Walked::Paused(..) | Walked::Caught(..) | Walked::Ending(..) => Next::Done(DocLayout::default()),
        }
    }
}

/// Where a pass may stop before its end (engine-open): at the first mark it could go on from once it has more than `pages`
/// pages (the last one being filled) and the clock ([`now_ms`]) reads `until` or later, or, with a finite `until`, before its
/// last block ([`Track::boundary`]).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Stop {
    pub(crate) pages: usize,
    pub(crate) until: f64,
}

impl Stop {
    /// A slice of the clock (a layout going on between other work), which also pauses between the blocks of a page; a stop at
    /// a page count (`until` 0) pauses where a page starts.
    fn by_clock(self) -> bool {
        self.until > 0.0
    }
}

/// A pass stopped before its end ([`walk_pass`]): its pages so far (the last one being filled) and how many items each put
/// behind its text, its marks (the last one where it stopped), the floats it found above their anchors, the text boxes it
/// laid out, and the notes' numbers it lays the body out with.
#[derive(Clone, Default)]
pub(crate) struct Paused {
    /// The environment its paragraph layouts were made for ([`env_hash`]).
    pub(crate) env: u64,
    pub(crate) pages: Vec<Page>,
    pub(crate) behind: Vec<usize>,
    pub(crate) marks: Vec<Mark>,
    pub(crate) floats: HashMap<(usize, usize), Option<(usize, WrapArea)>>,
    pub(crate) boxes: usize,
    pub(crate) notes: (Arc<HashMap<u32, fields::NoteNum>>, u64),
}

/// Where [`walk_pass`] begins: at the document's start, where a paused pass stopped, or, for an edit made while it was
/// paused, at its mark `k` (the last one before what the edit can reach), taking its pages over again where the pagination
/// comes back to a state it had, as [`relayout`] does.
pub(crate) enum Begin<'e> {
    Start,
    Paused(Paused),
    Edit(Paused, usize, &'e Edit),
    /// engine-repaginate-2: where a pass made from an edit's walk paused, taking the layout before the edit over where it
    /// comes back to its pagination ([`Walked::Caught`]).
    Redo(Paused, &'e Redo),
}

/// How [`walk_pass`] ended: paused (with the end of the pages this walk laid out: those after it are the paused pass's, an
/// edit's walk having come back to them), asking to be done again as [`Pass`] says (with its pages, and for floats, in a
/// walk with a stop, where the pass done again can begin: [`rewrap_from`]), or done.
pub(crate) enum Walked {
    Paused(Paused, usize),
    Again(Totals, Vec<Page>),
    Rewrap(EarlyFloats, Vec<Page>, Option<Paused>),
    Done(DocLayout),
    Caught(Caught),
    /// A walk in slices that reached the pass's end: its pages are dressed in the slices after ([`Ending`]).
    Ending(Box<Ending>),
}

/// engine-keys-final: a pass laid out in slices whose walk reached the document's end, its pages finished. Their headers and
/// footers are dressed and their lines indexed a few pages a slice (progress.rs `dress_ending`), with the list counters and
/// equation numbers the walk ended with carried from slice to slice, and the layout is made once every page is
/// ([`finish_ending`]). Dressed in one piece, the slice that ended a pass of the Word fixture (976 pages) took 25 to 31 ms
/// natively.
pub(crate) struct Ending {
    pages: Vec<Page>,
    behind: Vec<usize>,
    /// The pages dressed so far, `pages[..dressed]`, and their lines' index.
    dressed: usize,
    index: LineIndex,
    found: Totals,
    /// The list counters and equation numbers the headers go on from.
    counters: (Counters, u32),
    uses_totals: bool,
    bookmarks: (Arc<fields::BookmarkPages>, u64),
    env: u64,
    marks: Vec<Mark>,
    floats: HashMap<(usize, usize), Option<(usize, WrapArea)>>,
    notes: (Arc<HashMap<u32, fields::NoteNum>>, u64),
    settle: bool,
    /// The text boxes laid out by the walks (but those thrown away in balancing passes) and the dressing so far.
    boxes: usize,
    began: Began,
}

/// Where the walk that reached a pass's end began ([`Ending`]): the paused pass's last mark (its place among the walk's
/// marks, which records it again; none for a walk from the start), with the text boxes laid out before it and the block it
/// is before. An edit while the pass ends goes back there ([`Ending::into_paused`]).
#[derive(Default)]
struct Began {
    mark: Option<usize>,
    boxes: usize,
    block: usize,
}

impl Ending {
    /// The pass as it was paused where its last walk began, for an edit to go on from: the pages before that mark's page as
    /// they are (their headers and footers are dressed again when shown), the page it was filling as the mark keeps it, and
    /// the floats of the blocks before it, as an edit's walk takes them ([`Begin::Edit`]).
    pub(crate) fn into_paused(self) -> Paused {
        let Began { mark, boxes, block } = self.began;
        let mut marks = self.marks;
        marks.truncate(mark.map_or(0, |k| k + 1));
        let Some(m) = marks.last() else { return Paused::default() };
        let from = m.pages.saturating_sub(1);
        let (mut pages, mut behind) = (self.pages, self.behind);
        pages.truncate(from);
        behind.truncate(from);
        if let Some(p) = &m.page {
            pages.push(p.clone());
            behind.push(m.behind);
        }
        Paused { env: self.env, pages, behind, marks, floats: floats_before(&self.floats, block), boxes, notes: self.notes }
    }
}

/// The floats placed above their anchors that belong to the blocks before `block`.
#[inline(never)]
fn floats_before(floats: &Floats, block: usize) -> Floats {
    floats.iter().filter(|((b, _), _)| *b < block).map(|(k, v)| (*k, v.clone())).collect()
}

type Floats = HashMap<(usize, usize), Option<(usize, WrapArea)>>;

/// The layout a dressed [`Ending`] ends in, as [`walk_pass`] makes it when it dresses the pages itself.
pub(crate) fn finish_ending(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, inp: &PassInputs, e: Ending) -> DocLayout {
    evict_unused(cache);
    let text_boxes = e.boxes;
    let resume = Resume {
        doc: doc.clone(),
        opts: opts.clone(),
        env: e.env,
        dictionary: ew_proof::dictionary_generation(),
        totals: inp.totals.clone(),
        found: e.found,
        early: inp.early.clone(),
        note_pages: inp.note_pages.clone(),
        settle: e.settle,
        notes: e.notes,
        marks: e.marks,
        behind: e.behind,
        floats: e.floats,
        uses_totals: e.uses_totals,
        bookmarks: e.bookmarks,
        styleref: styleref::headers_use_styleref(doc),
        pagerefs: inp.pagerefs,
        paras: cache.paras.len(),
        text_boxes,
        edits: inp.ids.edits(),
    };
    DocLayout { pages: e.pages, index: e.index, ids: inp.ids.clone(), ms: 0.0, text_boxes, resume: Some(Arc::new(resume)), progress: None, later: None }
}

/// engine-repaginate-2: a walk begun as [`Begin::Redo`] that came back to the pagination before the edit: its pages and how
/// many items each put behind its text, its marks, the floats placed above their anchors, whether the body shows page
/// totals, and where the old pages take over ([`finish_redo`] takes it from here).
pub(crate) struct Caught {
    pub(crate) pages: Vec<Page>,
    pub(crate) behind: Vec<usize>,
    pub(crate) marks: Vec<Mark>,
    pub(crate) floats: HashMap<(usize, usize), Option<(usize, WrapArea)>>,
    pub(crate) uses_totals: bool,
    pub(crate) splice: (usize, bool, Shift),
}

/// [`reset_cache`] for a pass that goes on in environment `env` (the document and options are the same, so it is still
/// theirs): what it used so far stays noted, and the paragraph layouts another view made since are forgotten.
fn keep_env(cache: &mut LayoutCache, env: u64) {
    if env != cache.env {
        cache.paras.clear();
        cache.measures.clear();
        cache.fonts.clear();
        cache.tables.clear();
        cache.env = env;
    }
}

/// What an edit's walk takes over from the paused pass where it comes back to a state that pass had: the pass's marks from
/// the one the walk goes again from, its pages from that mark's page on, how many items each of its pages put behind its
/// text, and its floats.
struct Before<'e> {
    marks: Vec<Mark>,
    tail: Vec<Page>,
    behind: Vec<usize>,
    floats: HashMap<(usize, usize), Option<(usize, WrapArea)>>,
    from: usize,
    edit: &'e Edit,
}

/// A layout pass that begins as `begin` says and, with `stop`, pauses at the first mark it can go on from once the stop
/// allows. `None` when an edit's walk cannot take the paused pages over (the caller lays out from the start).
pub(crate) fn walk_pass(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, inp: &PassInputs, begin: Begin, stop: Option<Stop>) -> Option<Walked> {
    let known = match &begin {
        Begin::Start => {
            reset_cache(doc, cache, opts);
            None
        }
        Begin::Paused(p) | Begin::Edit(p, ..) | Begin::Redo(p, _) => {
            keep_env(cache, p.env);
            Some(p.notes.clone())
        }
    };
    let mut ctx = new_ctx(doc, cache, opts, (&inp.note_pages, &inp.totals), (known, inp.ids.clone()));
    let hf = Arc::clone(&ctx.hf);
    let sections = &hf.sections;
    let mode = Mode::of(opts.view);
    ctx.mirror = doc.settings.mirror_margins && !mode.reflow;
    (ctx.stacked_marks, ctx.quiet_marks) = section_marks(doc, opts, sections);
    ctx.folded = crate::outline::folded(doc, opts);
    let outline = (opts.view == ViewMode::Outline).then(|| OutlinePass::new(doc, opts.outline.clone().unwrap_or_default()));
    let default_sect = SectionProps::default();
    let first_sect = sections.first().map_or(&default_sect, |(_, s)| *s);
    let web_sect = mode.reflow.then(|| reflow_sect(first_sect, opts));
    let sect_ref = web_sect.as_ref().unwrap_or(first_sect);
    let settle = !inp.may_rewrap && !mode.reflow;
    let mut pb = new_page_builder(sect_ref, &inp.early, (mode.web, settle), inp.ids.clone());
    let mut endnotes = endnote_queue(&ctx);
    let turned = turned_sections(&mut ctx, sections, mode.web);
    let env = Env { hf: &hf, turned: &turned, sect_ref, mode, outline: &outline, totals: &inp.totals };
    // Marks are kept for the print view, the one an edit lays out again from them and the only one a pass pauses in.
    let on = opts.view == ViewMode::Print && !opts.comment_balloons;
    let mut marks = Vec::new();
    // Text boxes laid out before this walk: the context counts its own.
    let mut boxes = 0;
    let mut before = None;
    let redo = if let Begin::Redo(_, r) = &begin { Some(*r) } else { None };
    // A walk in slices that reaches the pass's end leaves the dressing to the slices after ([`Ending`]).
    let mut began = (on && stop.is_some_and(Stop::by_clock)).then(Began::default);
    let at = match begin {
        Begin::Start => None,
        Begin::Paused(p) | Begin::Redo(p, _) => {
            // The pass as it was at its last mark, which the walk records again.
            marks = p.marks;
            let m = marks.pop()?;
            if let Some(b) = &mut began {
                (b.mark, b.boxes) = (Some(marks.len()), p.boxes);
            }
            (pb.pages, pb.behind, ctx.floats_above, boxes) = (p.pages, p.behind, p.floats, p.boxes);
            Some(m)
        }
        Begin::Edit(p, k, edit) => {
            began = None;
            marks = p.marks;
            let after = marks.split_off(k.min(marks.len()));
            let m = after.first()?.clone();
            let from = m.pages.saturating_sub(1);
            // The pages before the mark's stay; the one it was filling comes back as it was then.
            let mut pages = p.pages;
            let tail = pages.split_off(from.min(pages.len()));
            pb.pages = pages;
            pb.pages.extend(m.page.clone());
            pb.behind = p.behind.get(..from).unwrap_or_default().to_vec();
            pb.behind.extend(m.page.as_ref().map(|_| m.behind));
            // The floats of the blocks before the mark's: the walk finds those of the blocks it lays out again.
            let block = edit.was(&ctx.ids, m.id)?;
            ctx.floats_above = floats_before(&p.floats, block);
            boxes = p.boxes;
            before = Some(Before { marks: after, tail, behind: p.behind, floats: p.floats, from, edit });
            Some(m)
        }
    };
    let mut track = Track::new(on);
    track.stop = stop;
    track.marks = marks;
    if let Some(m) = &at {
        m.pb.load(&mut pb);
        // A pass done again for floats goes on from the last pass's mark ([`rewrap_from`]), which may not have settled them.
        pb.settle = settle;
        restore_ctx(&mut ctx, m);
        endnotes.drain(..m.walk.endnotes.min(endnotes.len()));
        track.walk = m.walk;
    }
    // The block the walk goes on before (what the names give it now: an edit's walk goes on before the edit).
    let first = match &at {
        Some(m) => ctx.ids.block(m.id)?,
        None => 0,
    };
    if let Some(b) = &mut began {
        b.block = first;
    }
    if let Some(m) = &at {
        track.skip = Some((first, m.si, m.start));
    }
    if let Some(b) = &before {
        track.old = Some(Old { marks: &b.marks, edit: b.edit, behind: &b.behind, shifts: None, strict: false });
    }
    track.old = track.old.or(redo.map(|r| r.old(true)));
    let si = at.as_ref().map_or(0, |m| m.si);
    let n0 = pb.pages.len();
    let block = walk_sections(&mut ctx, &mut pb, &env, &mut endnotes, (si, first, at.as_ref().filter(|m| !m.start)), &mut track);
    ctx.cache.pages_laid += pb.pages.len().saturating_sub(n0.saturating_sub(1)) as u64;
    let Track { marks, walk, splice, stopped, .. } = track;
    let notes = (ctx.fields.notes.clone(), ctx.notes_hash);
    if let (Some(splice), Some(_)) = (splice, redo) {
        let floats = std::mem::take(&mut ctx.floats_above);
        return Some(Walked::Caught(Caught { pages: pb.pages, behind: pb.behind, marks, floats, uses_totals: ctx.uses_totals, splice }));
    }
    if let (Some((i, inside, _)), Some(b)) = (splice, before) {
        // The edit's walk came back to a state the paused pass had: its pages from there on are taken over, and its marks
        // after that one and its floats after the blocks laid out again (moved by the blocks the edit added).
        let relaid_to = b.marks.get(i).and_then(|m| b.edit.was(&ctx.ids, m.id)).unwrap_or(usize::MAX);
        let laid = take_old_pages((pb.pages, pb.behind), b.tail, (b.from, inside), &b.behind, Shift::default())?;
        let mut marks = marks;
        marks.extend(b.marks.into_iter().skip(i + 1));
        let mut floats = std::mem::take(&mut ctx.floats_above);
        floats.extend(b.floats.into_iter().filter(|((blk, _), _)| *blk >= relaid_to).map(|((blk, oi), v)| ((b.edit.moved(blk), oi), v)));
        let p = Paused { env: ctx.cache.env, pages: laid.pages, behind: laid.behind, marks, floats, boxes: boxes + ctx.boxes.total(), notes };
        return Some(Walked::Paused(p, laid.to));
    }
    if stopped {
        let to = pb.pages.len();
        let floats = std::mem::take(&mut ctx.floats_above);
        let p = Paused { env: ctx.cache.env, pages: pb.pages, behind: pb.behind, marks, floats, boxes: boxes + ctx.boxes.total(), notes };
        return Some(Walked::Paused(p, to));
    }
    let block = block.unwrap_or_default();
    if pb.pages.is_empty() {
        pb.new_page(0, sect_ref.margin_top);
    }
    // The rest of the endnotes after the last paragraph.
    let rest: Vec<u32> = endnotes.into_iter().map(|(id, _)| id).collect();
    place_endnotes(&mut ctx, &mut pb, rest, block);
    let (mut pages, behind) = finish_pages(pb, doc, sections, mode.web, 0);
    if mode.web {
        fit_web_page(&mut pages, web_margin(opts));
    }
    ctx.grid = para::Grid::default();
    let found = (!mode.reflow && inp.may_rewrap).then(|| uncovered_floats(&ctx.floats_above, &inp.early)).flatten();
    if found.is_some() || (inp.may_rewrap && inp.stale_from < usize::MAX) {
        let found = found.unwrap_or_default();
        // Only a pass laid out in slices goes on from a mark ([`crate::whole`] begins again); turned pages are turned whole.
        let again = (stop.is_some() && turned.iter().all(Option::is_none))
            .then(|| rewrap_from(&ctx, (&found, inp), marks, (&pages, &behind), (boxes + ctx.boxes.total(), notes)))
            .flatten();
        return Some(Walked::Rewrap(found, pages, again));
    }
    // A walk in slices leaves the pages' headers and footers to the slices after ([`Ending`]), but for turned pages and
    // mirrored margins, which are dressed whole (each page's turn and side follow the pages before it).
    let sliced = began.is_some() && !ctx.mirror && turned.iter().all(Option::is_none);
    let found = if mode.reflow {
        Totals::first_guess(sections.len())
    } else {
        match fill_headers_footers(&mut ctx, &mut pages, sections, (&inp.totals, inp.may_repeat), !sliced) {
            Ok(found) => found,
            Err(again) => return Some(Walked::Again(again, pages)),
        }
    };
    if on {
        debug_assert!(began.as_ref().and_then(|b| b.mark).is_none_or(|k| marks.get(k).map(|m| m.id) == at.as_ref().map(|m| m.id)), "the walk records its first mark again");
        let e = Ending {
            dressed: if sliced { 0 } else { pages.len() },
            index: if sliced { LineIndex::default() } else { index_lines(&pages) },
            pages,
            behind,
            found,
            counters: (std::mem::take(&mut ctx.counters), ctx.eq_count),
            uses_totals: ctx.uses_totals,
            bookmarks: (ctx.fields.bookmark_pages.clone(), ctx.fields.bookmarks_key),
            env: ctx.cache.env,
            marks,
            floats: std::mem::take(&mut ctx.floats_above),
            notes,
            settle,
            boxes: (boxes + ctx.boxes.total()).saturating_sub(walk.discarded),
            began: began.unwrap_or_default(),
        };
        return Some(if sliced { Walked::Ending(Box::new(e)) } else { Walked::Done(finish_ending(doc, ctx.cache, opts, inp, e)) });
    }
    evict_unused(ctx.cache);
    let mut lay = DocLayout { index: index_lines(&pages), pages, ids: ctx.ids.clone(), ms: 0.0, text_boxes: 0, resume: None, progress: None, later: None };
    if opts.comment_balloons && !mode.web {
        balloons::add(&mut ctx, &mut lay);
    }
    lay.text_boxes = (boxes + ctx.boxes.total()).saturating_sub(walk.discarded);
    Some(Walked::Done(lay))
}

/// Pagination state saved before a block, to lay the blocks from there out again (balancing
/// columns): the builder without its pages, how far its last page had got, and the walk state.
struct Snap<'a> {
    pb: PageBuilder<'a>,
    pages: usize,
    items: usize,
    behind: usize,
    counters: Counters,
    eq_count: u32,
    page_field: u32,
    boxes: usize,
}

impl<'a> Snap<'a> {
    fn take(pb: &mut PageBuilder<'a>, ctx: &Ctx) -> Self {
        // The pages stay out of the copy: it would cost the whole document per block.
        let (pages, behind) = (std::mem::take(&mut pb.pages), std::mem::take(&mut pb.behind));
        let copy = pb.clone();
        (pb.pages, pb.behind) = (pages, behind);
        Snap {
            pb: copy,
            pages: pb.pages.len(),
            items: pb.pages.last().map_or(0, |p| p.items.len()),
            behind: pb.behind.last().copied().unwrap_or(0),
            counters: ctx.counters.clone(),
            eq_count: ctx.eq_count,
            page_field: ctx.fields.page,
            boxes: ctx.boxes.total(),
        }
    }

    /// Go back to this state: drop the pages added since and what was added to the last one
    /// (appended, or inserted at the front behind the text).
    fn restore(&self, pb: &mut PageBuilder<'a>, ctx: &mut Ctx) {
        let (mut pages, mut behind) = (std::mem::take(&mut pb.pages), std::mem::take(&mut pb.behind));
        pages.truncate(self.pages);
        behind.truncate(self.pages);
        if let Some(pg) = pages.last_mut() {
            let k = behind.last().copied().unwrap_or(0).saturating_sub(self.behind).min(pg.items.len());
            pg.items.drain(..k);
            pg.items.truncate(self.items);
        }
        if let Some(b) = behind.last_mut() {
            *b = self.behind;
        }
        *pb = self.pb.clone();
        (pb.pages, pb.behind) = (pages, behind);
        ctx.counters = self.counters.clone();
        ctx.eq_count = self.eq_count;
        ctx.fields.page = self.page_field;
    }
}

/// One balancing pass: blocks `first..end` laid out again from `snap` with the columns on `page`
/// ending `h` below `top`; true if the page's text fits them.
fn balance_pass<'a>(
    ctx: &mut Ctx,
    pb: &mut PageBuilder<'a>,
    snap: &Snap<'a>,
    (first, end): (usize, usize),
    (page, top, h): (usize, f32, f32),
    body_top: f32,
) -> bool {
    snap.restore(pb, ctx);
    pb.balance = Some((page, h));
    pb.cap_columns();
    for block in first..end {
        match ctx.doc.body.get(block).map(|b| &**b) {
            Some(Block::Para(p)) => place_para(ctx, pb, p, block, body_top),
            Some(Block::Table(t)) => place_table(ctx, pb, t, block, body_top),
            Some(Block::Container(c)) => place_container(ctx, pb, c, block, body_top),
            None => break,
        }
        // Spilled onto another page: too short (and no need to lay out the rest).
        if pb.pages.len() > page + 1 {
            break;
        }
    }
    pb.balance = None;
    pb.cap_columns();
    pb.pages.len() == page + 1 && pb.content_bottom <= top + h + 0.5
}

/// Balancing lays out at most this many pages again per pass (a block reaching the last page
/// from further back is left unbalanced), so its cost stays a small multiple of one page.
const BALANCE_MAX_PAGES: usize = 16;

/// Passes of the binary search on the column height (enough for well under a point).
const BALANCE_PASSES: usize = 12;

/// Balance the columns on the last page of a section followed by a continuous break, as Word
/// does: lay blocks `first..end` out again from `snap` (taken before `first`) with the shortest
/// columns that still hold that page's text — a binary search on the column height, where a
/// height fits when nothing moves to another page and nothing (an unsplittable row, a line
/// taller than the column) runs past it. Keep-together, keep-with-next and widow/orphan control
/// apply as usual, so the columns may come out a little uneven. Not balanced: a page with an
/// explicit column break, which says where the columns end. Returns the text boxes laid out in the
/// passes thrown away.
fn balance_columns<'a>(ctx: &mut Ctx, pb: &mut PageBuilder<'a>, blocks: (usize, usize), snap: &Snap<'a>, body_top: f32) -> usize {
    let page = pb.pages.len().saturating_sub(1);
    let ncols = pb.cols.len().max(1) as f32;
    let top = pb.top;
    let full = pb.uncapped_bottom() - top;
    let used = pb.content_bottom.min(pb.uncapped_bottom()) - top;
    if pb.col_break_page == Some(page)
        || snap.pages == 0
        || (page + 1).saturating_sub(snap.pages) > BALANCE_MAX_PAGES
        || used <= 1.0
        || full <= 1.0
        || pb.cols.len() < 2
    {
        return 0;
    }
    let pass = |ctx: &mut Ctx, pb: &mut PageBuilder<'a>, h: f32| balance_pass(ctx, pb, snap, blocks, (page, top, h), body_top);
    // The text on the page fills `ncols` columns at least `used / ncols` high; the original layout
    // (`full`) fits, and so, nearly always, do columns as high as its tallest one.
    let mut lo = (used / ncols - 1.0).max(0.0);
    let mut hi = full;
    let mut last = None;
    let discard = |ctx: &Ctx| ctx.boxes.total().saturating_sub(snap.boxes);
    let mut thrown = discard(ctx);
    if used < full - 0.5 {
        let ok = pass(ctx, pb, used);
        if ok {
            hi = used;
        }
        last = Some((used, ok));
    }
    for _ in 0..BALANCE_PASSES {
        if hi - lo <= 1.0 {
            break;
        }
        let mid = (lo + hi) / 2.0;
        thrown = discard(ctx);
        let ok = pass(ctx, pb, mid);
        if ok {
            hi = mid;
        } else {
            lo = mid;
        }
        last = Some((mid, ok));
    }
    // End on the best height (the full column, as laid out first, when none was shorter).
    if last != Some((hi, true)) {
        thrown = discard(ctx);
        if !pass(ctx, pb, hi) && hi < full {
            thrown = discard(ctx);
            pass(ctx, pb, full);
        }
    }
    thrown
}

/// Milliseconds since an arbitrary epoch (monotonic on native; the browser's clock on the web).
pub fn now_ms() -> f64 {
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    {
        static T0: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        T0.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
    }
    // `Instant::now()` panics on wasm32-unknown-unknown, so ask the browser's clock: performance.now(), as a slice of a
    // fraction of a millisecond needs (Date.now() counts whole milliseconds), else Date.now().
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    {
        thread_local! {
            static PERF: Option<(js_sys::wasm_bindgen::JsValue, js_sys::Function)> = {
                let perf = js_sys::Reflect::get(&js_sys::global(), &"performance".into()).ok().filter(|p| p.is_object());
                perf.and_then(|p| {
                    let now = js_sys::Reflect::get(&p, &"now".into()).ok().filter(|f| f.is_function())?;
                    Some((p, js_sys::Function::from(now)))
                })
            };
        }
        let ms = PERF.with(|p| p.as_ref().and_then(|(perf, now)| now.call0(perf).ok()?.as_f64())).unwrap_or_else(js_sys::Date::now);
        if ms.is_finite() { ms } else { 0.0 }
    }
}

/// What a walk laying the document out again after an edit compares with ([`Track::old`]): the old pass's marks, the edit,
/// how many items each old page put behind its text ([`Resume::behind`]), and, where its pages may be taken over moved by
/// whole pages ([`Shift`]), the old blocks (numbered before the edit) with floats placed above their anchors, sorted, and the
/// first block laid out again.
#[derive(Clone, Copy)]
struct Old<'r> {
    marks: &'r [Mark],
    edit: &'r Edit,
    behind: &'r [usize],
    shifts: Option<(&'r [usize], usize)>,
    /// Every match, moved or not, keeps to [`Old::may_shift`]'s floats: the walk laid the pages out without the wrap areas the
    /// old pass gave them ([`Begin::Redo`]).
    strict: bool,
}

/// Records [`Mark`]s through a pass: at the top of each section and where each page's first block starts. In a pass laying
/// the document out again after an edit, it also finds where the pagination is back in the state the old pass had.
struct Track<'r> {
    on: bool,
    marks: Vec<Mark>,
    walk: Walk,
    /// Pages at the last mark.
    last_pages: Option<usize>,
    old: Option<Old<'r>>,
    /// Pages at the first of the old marks matched in a row, and how far the pages had moved there.
    matched: Option<(usize, Shift)>,
    /// The old mark where the old pages take over, whether they take over inside the page being filled, and how far the old
    /// pages move.
    splice: Option<(usize, bool, Shift)>,
    /// Where the pass may pause before its end ([`Stop`]), and the place it went on from, where it does not pause again.
    stop: Option<Stop>,
    skip: Option<(usize, usize, bool)>,
    /// It paused at its last mark.
    stopped: bool,
}

impl<'r> Track<'r> {
    fn new(on: bool) -> Self {
        Track {
            on,
            marks: Vec::new(),
            walk: Walk { endnotes: 0, discarded: 0, turn: TextDirection::Horizontal },
            last_pages: None,
            old: None,
            matched: None,
            splice: None,
            stop: None,
            skip: None,
            stopped: false,
        }
    }

    /// The mark the pagination is in now, before `block` of section `si` (`start`: at its top).
    fn mark(&self, ctx: &Ctx, pb: &PageBuilder, (block, si, start): (usize, usize, bool), balance: bool) -> Mark {
        Mark {
            id: ctx.key(block),
            si,
            start,
            balance,
            pages: pb.pages.len(),
            page: pb.pages.last().cloned(),
            behind: pb.behind.last().copied().unwrap_or(0),
            floor: pb.body_floor(),
            pb: PbState::save(pb),
            counters: ctx.counters.clone(),
            eq_count: ctx.eq_count,
            page_field: ctx.fields.page,
            uses_totals: ctx.uses_totals,
            walk: self.walk,
        }
    }

    /// Whether the pass pauses here, with `pages` pages: past its stop's pages and its time, and not where it went on from.
    fn due(&self, pages: usize, at: (usize, usize, bool), last: bool) -> bool {
        self.stop.is_some_and(|s| pages > s.pages && (last || now_ms() >= s.until)) && self.skip != Some(at)
    }

    /// Before `block` of section `si` (`start`: at the top of the section, `balance`: whether it balances its last page):
    /// records a mark there if it is the section's top or the first block boundary on a page. True when the old pages take
    /// over from here, the pagination being where an old mark was (or in that state moved by whole pages: [`Shift`]): all
    /// that follows is laid out as before. The page being filled is finished from the old one when that one holds just what
    /// came after this point (its text at the top, as laid out, nothing put behind its text later); else from the next match
    /// on, after which the page started. True too when the pass pauses here.
    fn boundary(&mut self, ctx: &Ctx, pb: &PageBuilder, (block, si, start): (usize, usize, bool), balance: bool) -> bool {
        let pages = pb.pages.len();
        // A pass laid out in slices of a few milliseconds (a finite `until`) also has a mark before its last block, and pauses
        // there: the end of a pass (headers and footers, the line index, the next pass) is about 25 ms on the Word fixture's 959
        // pages, so it gets a slice of its own rather than come after a slice's worth of pages (engine-main-thread-2).
        let last = block + 1 == ctx.doc.body.len() && self.stop.is_some_and(|s| s.until.is_finite());
        if !self.on {
            return false;
        }
        if !start && !last && self.last_pages == Some(pages) {
            // engine-repaginate-2: a slice of the clock also pauses between the blocks of a page once its time is up, so a key
            // that comes meanwhile waits behind one block's layout, not the rest of the page. Not inside a section balancing
            // its last page, nor after a framed paragraph the next one may join (its frame is not part of the mark).
            let joins = pb.frame.as_ref().is_some_and(|f| f.0 + 1 == block);
            self.stopped = self.stop.is_some_and(|s| s.by_clock()) && !balance && !joins && self.due(pages, (block, si, start), false);
            if self.stopped {
                self.marks.push(self.mark(ctx, pb, (block, si, start), balance));
            }
            return self.stopped;
        }
        self.last_pages = Some(pages);
        let mut splice = None;
        if let Some(old) = self.old
            && block >= old.edit.new_end
        {
            // The old marks in order of the blocks they were before then (the names give the numbers now).
            let was = |m: &Mark| old.edit.was(&ctx.ids, m.id).unwrap_or(usize::MAX);
            let ob = block.checked_add_signed(-old.edit.delta);
            let i = ob.and_then(|ob| old.marks.binary_search_by(|m| (was(m), !m.start).cmp(&(ob, !start))).ok());
            let hit = i
                .and_then(|i| old.marks[i].matches(ctx, pb, (block, si, start), &self.walk).map(|s| (i, s)))
                .filter(|(_, s)| (s.is_none() && !old.strict) || ob.is_some_and(|ob| old.may_shift(ctx, ob, (block, si, start), *s)));
            match hit {
                Some((i, s)) if self.matched.is_some_and(|(p, was)| p < pages && was == s) => splice = Some((i, false, s)),
                Some((i, s)) => {
                    let m = &old.marks[i];
                    let turned = ctx.hf.sections.get(pb.sect_idx).is_some_and(|(_, s)| s.text_direction.is_turned());
                    // The old page this one is.
                    let was_page = pages.checked_sub(1).and_then(|p| p.checked_add_signed(-s.pages));
                    let inside = !m.balance
                        && !ctx.mirror
                        && !turned
                        && pb.page_valign == ew_doc::section::PageVAlign::Top
                        && was_page.and_then(|p| old.behind.get(p)) == Some(&m.behind);
                    if inside {
                        splice = Some((i, true, s));
                    }
                    if self.matched.is_none_or(|(_, was)| was != s) {
                        self.matched = Some((pages, s));
                    }
                }
                None => self.matched = None,
            }
        }
        self.marks.push(self.mark(ctx, pb, (block, si, start), balance));
        self.splice = splice;
        if splice.is_some() {
            return true;
        }
        // Paused here, the pass goes on from this mark as an edit's walk would: not inside a section balancing its last page,
        // which lays its blocks out again from before that page.
        self.stopped = self.due(pages, (block, si, start), last) && (start || !balance);
        self.stopped
    }
}

impl Old<'_> {
    /// Whether the old pages from old block `ob` on may be taken over moved by whole pages: no float placed above its anchor
    /// in the blocks laid out again, now or in the old pass. Their pages and wrap areas would move with the pagination in ways
    /// a shift does not say; the others move with their pages ([`same_findings`]).
    /// Nor where the move shows at once: with odd and even pages that differ (their headers, mirrored margins) by an odd
    /// number of pages, nor, with the numbers moved, at the top of a section that numbers its pages again or (by an odd
    /// number) starts on an odd or even page, or before a block showing its page's number. Those are laid out again
    /// ([`shift_reaches`]), and a walk that took the pages over there would take them over again at the same place.
    fn may_shift(&self, ctx: &Ctx, ob: usize, (block, si, start): (usize, usize, bool), s: Shift) -> bool {
        let Some((floats, first)) = self.shifts else { return false };
        let doc = ctx.doc;
        if (doc.settings.even_odd_headers || doc.settings.mirror_margins) && (s.pages % 2 != 0 || s.number % 2 != 0) {
            return false;
        }
        if s.number != 0 {
            let odd = s.number % 2 != 0;
            let top = start
                && ctx.hf.sections.get(si).is_some_and(|(_, sect)| {
                    sect.page_num_start.is_some() || (odd && matches!(sect.start, SectionStart::OddPage | SectionStart::EvenPage))
                });
            let here = doc.body.get(block).is_some_and(|b| any_para(b, &mut |p| shows_page_number(doc, p)) || (odd && sides_matter(doc, b)));
            if top || here {
                return false;
            }
        }
        let now = ctx.floats_above.iter().any(|((b, _), v)| *b >= first && v.is_some());
        let before = floats.partition_point(|b| *b < first) < floats.partition_point(|b| *b < ob);
        !now && !before
    }
}

// How far back from an edited block the blocks before it can depend on it: a chain of paragraphs kept with the next
/// measures up to 8 paragraphs ahead ([`super::flow`]).
const KEEP_REACH: usize = 12;

/// The body blocks an edit changed: `start..old_end` of the old body became `start..new_end` of the new one.
#[derive(Clone)]
pub(crate) struct Edit {
    start: usize,
    old_end: usize,
    new_end: usize,
    delta: isize,
    /// The ids blocks `start..old_end` had, once the layout's names took the edit in ([`Edit::rename`]).
    held: Vec<u32>,
    /// engine-keys-final: a section break went or came, and this is the first block of the section the edit is in now: the
    /// blocks from there lay out with that section's properties ([`Edit::of`]).
    pub(crate) section: Option<usize>,
}

impl Edit {
    /// What changed from the body `was` was laid out from (with `was_opts`) to `doc`'s: blocks are shared until edited, so
    /// unchanged ones are the same pointers. A paragraph whose word being typed changed is laid out again too. `None` when
    /// the change reaches further than the blocks laid out again: a note reference (the notes are numbered again) or a
    /// section break.
    pub(crate) fn of((was, was_opts): (&Document, &LayoutOptions), doc: &Document, opts: &LayoutOptions, parts: &[u32]) -> Option<Edit> {
        let (a, b) = (&was.body, &doc.body);
        let pre = a.iter().zip(b).take_while(|(x, y)| Arc::ptr_eq(x, y)).count();
        let room = a.len().min(b.len()) - pre;
        let suf = a.iter().rev().zip(b.iter().rev()).take(room).take_while(|(x, y)| Arc::ptr_eq(x, y)).count();
        let delta = b.len() as isize - a.len() as isize;
        let mut e = Edit { start: pre, old_end: a.len() - suf, new_end: b.len() - suf, delta, held: Vec::new(), section: None };
        // (Only spelling marks depend on it: without them, its paragraph lays out the same.)
        if opts.proofing && was_opts.typing_word != opts.typing_word {
            for rev in [was_opts.typing_word, opts.typing_word].into_iter().flatten().map(|t| t.rev) {
                if let Some(i) = b.iter().position(|blk| any_para(blk, &mut |p| p.rev == rev)) {
                    e.widen(i);
                }
            }
        }
        // A note or text box whose text changed: the body paragraph showing it lays out again (one shown elsewhere, in a
        // text box, lays the whole document out again). A linked text box's text runs on into the next boxes of its chain,
        // so the paragraphs showing every box of the chain do.
        let chains = if parts.is_empty() { Vec::new() } else { doc.text_box_chains() };
        for id in parts {
            let ids = chains.iter().find(|c| c.contains(id)).map_or(std::slice::from_ref(id), Vec::as_slice);
            for id in ids {
                let shows = |p: &Paragraph| {
                    p.objects.iter().any(|o| matches!(o, InlineObject::NoteRef { id: n, .. } if n == id) || o.text_boxes().contains(id))
                };
                e.widen(b.iter().position(|blk| any_para(blk, &mut |p| shows(p)))?);
            }
        }
        if e.is_empty() {
            return Some(e);
        }
        let hide = opts.hides_deleted(StoryRef::Body);
        let (before, now) = (a.get(e.start..e.old_end).unwrap_or_default(), b.get(e.start..e.new_end).unwrap_or_default());
        let (had, has) = (refs(was, before, &hide), refs(doc, now, &hide));
        if had == has {
            return Some(e);
        }
        // engine-keys-final: a section break taken out (Delete or Backspace at it) or put back (its Undo), the note references
        // as they were. The section it ended takes the next one's properties, or the reverse, so the blocks lay out again from
        // that section's first, where the edit reaches back to ([`resume_mark`]); the sections after are numbered one less or
        // more, so no old mark after the edit matches and no old page is taken over; and the notes may be numbered again by
        // their sections, which [`redo_edit`] checks. Laid out from the start instead, the Delete on page 900 of the Word
        // fixture looked 15,745 paragraph layouts up, and the passes after it for the page totals began again with the keys
        // that came during them.
        let notes = |r: &[(u8, u32, Option<&SectionProps>)]| r.iter().filter(|x| x.0 != 0).map(|x| (x.0, x.1)).collect::<Vec<_>>();
        let breaks = |r: &[(u8, u32, Option<&SectionProps>)]| r.iter().filter(|x| x.0 == 0).count();
        if notes(&had) != notes(&has) || breaks(&had) == breaks(&has) {
            return None;
        }
        e.section = Some(b[..e.start].iter().rposition(|blk| matches!(&**blk, Block::Para(p) if p.section.is_some())).map_or(0, |i| i + 1));
        Some(e)
    }

    /// Block `b` laid out again with the body as it is: its text is the same but lays out differently.
    fn block(b: usize) -> Edit {
        Edit::blocks(b..b + 1)
    }

    /// Blocks `r` laid out again with the body as it is.
    fn blocks(r: Range<usize>) -> Edit {
        Edit { start: r.start, old_end: r.end, new_end: r.end, delta: 0, held: Vec::new(), section: None }
    }

    /// Takes in block `i` of the new body, unchanged.
    fn widen(&mut self, i: usize) {
        if self.is_empty() {
            (self.start, self.old_end, self.new_end) = (i, (i + 1).saturating_add_signed(-self.delta), i + 1);
            return;
        }
        self.start = self.start.min(i);
        if i >= self.new_end {
            self.new_end = i + 1;
            self.old_end = (i + 1).saturating_add_signed(-self.delta);
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.start == self.new_end && self.start == self.old_end
    }

    /// Block `b` of the old body in the new one (blocks after the edit move by `delta`).
    pub(crate) fn moved(&self, b: usize) -> usize {
        if b >= self.old_end { b.saturating_add_signed(self.delta) } else { b }
    }

    /// Takes the edit into the layout's names for the blocks of `body`, the new body: the blocks after it keep their ids,
    /// which now give their new numbers.
    pub(crate) fn rename(&mut self, ids: &BlockIds, body: &[Arc<Block>]) {
        if !self.is_empty() {
            self.held = ids.edit(body, self.start, self.old_end, self.new_end);
        }
    }

    /// The number the block named `id` had in the old body (`ids` having taken the edit in), for the old pass's marks and
    /// pages: `None` for a block the edit added.
    pub(crate) fn was(&self, ids: &BlockIds, id: u32) -> Option<usize> {
        if let Some(k) = self.held.iter().position(|h| *h == id) {
            return Some(self.start + k);
        }
        let b = ids.block(id)?;
        if b < self.start {
            Some(b)
        } else if b >= self.new_end {
            b.checked_add_signed(-self.delta)
        } else {
            None
        }
    }
}

/// What of `blocks` the notes' numbers and the sections depend on, in order: the note references counted (as
/// [`note_info`] counts them: not those left out), the text boxes (whose references count where they are) and the section
/// breaks. Equal before and after an edit, the notes keep their numbers and the sections their properties.
fn refs<'d>(doc: &'d Document, blocks: &'d [Arc<Block>], hide: &HideDeleted) -> Vec<(u8, u32, Option<&'d SectionProps>)> {
    let mut out = Vec::new();
    for blk in blocks {
        if let Block::Para(p) = &**blk
            && let Some(s) = &p.section
        {
            out.push((0, 0, Some(&**s)));
        }
        any_para(blk, &mut |p| {
            let gone = left_out_objects(doc, p, None, true, hide);
            for (k, o) in p.objects.iter().enumerate() {
                match o {
                    InlineObject::NoteRef { kind, id, .. } if !gone(k) => out.push((1 + u8::from(*kind == NoteKind::Endnote), *id, None)),
                    o => out.extend(o.text_boxes().into_iter().map(|id| (3, id, None))),
                }
            }
            false
        });
    }
    out
}

/// Whether any paragraph of `b` (however deep its tables nest) passes `f`.
fn any_para(b: &Block, f: &mut dyn FnMut(&Paragraph) -> bool) -> bool {
    match b {
        Block::Para(p) => f(p),
        _ => b.lists().iter().any(|(_, _, list)| list.iter().any(|cb| any_para(cb, f))),
    }
}

/// The options lay the document out the same way (the word being typed aside: [`Edit::of`] lays its paragraph out again).
fn same_opts(a: &LayoutOptions, b: &LayoutOptions) -> bool {
    // Every field named, so a new option can't be missed here.
    let LayoutOptions {
        view,
        web_width,
        web_margin,
        read_height,
        read_line_spacing,
        show_hidden,
        hide_deleted,
        hide_marked,
        deletions_in_balloons,
        proofing,
        numeral,
        comment_balloons,
        field_codes,
        outline,
        expanded,
        proof,
        typing_word: _,
        filename,
        filepath,
        reader,
    } = a;
    *view == b.view
        && web_width.to_bits() == b.web_width.to_bits()
        && web_margin.to_bits() == b.web_margin.to_bits()
        && read_height.to_bits() == b.read_height.to_bits()
        && read_line_spacing.map(f32::to_bits) == b.read_line_spacing.map(f32::to_bits)
        && *show_hidden == b.show_hidden
        && *hide_deleted == b.hide_deleted
        && *hide_marked == b.hide_marked
        && *deletions_in_balloons == b.deletions_in_balloons
        && *proofing == b.proofing
        && *numeral == b.numeral
        && *comment_balloons == b.comment_balloons
        && *field_codes == b.field_codes
        && *outline == b.outline
        && *expanded == b.expanded
        && *proof == b.proof
        && *filename == b.filename
        && *filepath == b.filepath
        && *reader == b.reader
}

/// What changed outside the body from `a` to `b`, as far as layout reads it: the footnotes and text boxes whose text changed
/// (their blocks compared by pointer, as the body's), or `None` when anything else did (headers, styles, settings...),
/// which lays the whole document out again.
fn changed_parts(a: &Document, b: &Document) -> Option<Vec<u32>> {
    use ew_doc::PartKind;
    if a.parts.len() != b.parts.len() {
        return None;
    }
    let mut changed = Vec::new();
    for ((i, p), (j, q)) in a.parts.iter().zip(&b.parts) {
        if i != j || p.kind != q.kind || p.body != q.body {
            return None;
        }
        if p.blocks.len() != q.blocks.len() || !p.blocks.iter().zip(&q.blocks).all(|(x, y)| Arc::ptr_eq(x, y)) {
            // An endnote is drawn at the end of its section or of the document, not by the paragraph that refers to it,
            // so laying that paragraph out again would splice the old end pages back. ponytail: an endnote edit lays the
            // whole document out; re-lay from the mark where endnote_queue places it if endnote typing gets slow.
            if !matches!(p.kind, PartKind::Footnote | PartKind::TextBox) {
                return None;
            }
            changed.push(*i);
        }
    }
    let media = a.media.len() == b.media.len() && a.media.iter().zip(&b.media).all(|((k, v), (l, w))| k == l && Arc::ptr_eq(v, w));
    // The passthrough parts and the glossary aren't laid out.
    let same = media
        && a.last_section == b.last_section
        // Shared until a command changes them (engine-edit-cost): the same pointer is the same styles, without comparing them.
        && (Arc::ptr_eq(&a.styles, &b.styles) || a.styles == b.styles)
        && (Arc::ptr_eq(&a.numbering, &b.numbering) || a.numbering == b.numbering)
        && a.settings == b.settings
        && a.core == b.core
        && a.comments == b.comments
        // Records added after `a`'s (a tracked change of a new kind or in a new second, every assistant's edit) are read only by
        // the text that refers to them, which is new text in changed blocks: layout reads a record through the index a run
        // or mark holds (its author, move name, and colour by the author's first appearance). Records taken off the end
        // (Undo of such an edit, Accept or Reject All) went with the text that referred to them, so the same holds. A
        // record that changed may change any page.
        && revisions_prefix(&a.revisions, &b.revisions)
        && a.sources == b.sources
        && a.custom_props == b.custom_props
        && a.footnote_separators == b.footnote_separators
        && a.endnote_separators == b.endnote_separators;
    same.then_some(changed)
}

/// One list of revision records begins the other.
fn revisions_prefix(a: &[ew_doc::Revision], b: &[ew_doc::Revision]) -> bool {
    let n = a.len().min(b.len());
    a[..n] == b[..n]
}

/// Lays `doc` out again after an edit from `prev`, its layout before the edit, whose pages are taken over: only from the
/// first page the change can reach to the first point where the pagination is back in the state it had before, past which
/// the old pages stay. Typing in a paragraph that keeps its line count moves no page break. The result is the layout
/// [`crate::layout`] makes, and the pages that draw differently (all of them when the document was laid out whole: a
/// change outside the body, in the view, or in the page totals, notes or floats the body shows).
pub fn relayout(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, prev: DocLayout) -> (DocLayout, Range<usize>) {
    if prev.progress.is_some() {
        return progress::go_on(doc, cache, opts, prev, None);
    }
    let t0 = now_ms();
    // What the last edit left for later goes first, laid out for the document it was laid out from: its blocks are numbered
    // for that one, and the layout's names have not taken this edit in yet.
    let n = prev.pages.len();
    let was = prev.later.as_ref().and(prev.resume.as_ref()).map(|r| r.doc.clone());
    let Some((prev, done)) = (match &was {
        Some(was) => finish_later(was, cache, opts, prev, 0..0),
        None => Some((prev, 0..0)),
    }) else {
        let l = super::layout(doc, cache, opts);
        let n = n.max(l.pages.len());
        return (l, 0..n);
    };
    let view = cache.ahead;
    let n = n.max(prev.pages.len());
    if let Some((mut l, changed)) = redo(doc, cache, opts, prev, view) {
        l.ms = now_ms() - t0;
        return (l, union(done, changed));
    }
    let l = super::layout(doc, cache, opts);
    let n = n.max(l.pages.len());
    (l, 0..n)
}

/// [`relayout`] from the marks of `prev`: `None` when it has to be laid out whole. With `view` (the pages the view shows,
/// [`LayoutCache::set_ahead`]), an edit whose walk passes them without coming back to the old pagination pauses there and
/// the layout comes back unsettled ([`redo_edit`]).
fn redo(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, prev: DocLayout, view: Option<usize>) -> Option<(DocLayout, Range<usize>)> {
    let (l, changed, stale, taken) = redo_edit(doc, cache, opts, prev, None, view)?;
    if l.progress.is_some() {
        return Some((l, changed));
    }
    // engine-repaginate-2: with a view, what the edit's walk leaves (the blocks pages taken over moved show wrongly, the page
    // totals) is laid out in slices after it, a walk at a time: done here, it held an Enter that added a page on page 300
    // of the Word fixture for 11 ms.
    let l = leave(l, Later::of(taken, stale));
    if view.is_some() {
        return Some((l, changed));
    }
    finish_later(doc, cache, opts, l, changed)
}

/// Where an edit's walk from page `from` pauses when it has not come back to the old pagination, with `ahead` the pages a
/// layout from the start lays out ([`LayoutCache::set_ahead`]): past the pages on screen when they are known
/// ([`LayoutCache::set_screen`]), else past those ahead, and at least past the edited page and the next, where the walk
/// usually comes back. The rest follows in the next slice ([`progress`]). engine-keys-final: four pages further
/// (engine-repaginate-2's EDIT_PAGES), an Enter on page 300 of the Word fixture looked 144 paragraph layouts up rather than
/// 38, about 0.9 ms more natively, with nothing gained. engine-layout-key: the pages ahead reach two pages past the last a
/// view wishes for (the worker's lookAhead), a screen further than the one on screen after a scroll down. Stopping there,
/// page 300's Enter laid out 6 pages before it returned (45 paragraph layouts), its walk coming back to the old pages only
/// on the sixth; stopping past the screen, 4 (24), the rest in the next slice. Without the edited page's next, keys on
/// page 900 that come back a page later paused rather than took the old pages over, and cost more.
pub(crate) fn edit_stop(cache: &LayoutCache, ahead: usize, from: usize) -> Stop {
    Stop { pages: cache.screen.unwrap_or(ahead).max(from + 2), until: 0.0 }
}

/// Where a walk laying a document out again took the old pages over (before which block, at the top of its section or
/// not), and how far they moved: `None` when it laid out to the end.
pub(crate) type Taken = Option<((usize, bool), Shift)>;

/// engine-repaginate-2: what laying a document out again after an edit leaves for later, once the pages the view shows
/// are done ([`DocLayout::settled`] is false until it is): the blocks that old pages taken over moved show wrongly
/// ([`shift_reaches`]), from where those pages were last taken over and how far they have moved since they were laid out;
/// and the page totals found that the body's total fields do not show yet, with the rounds of laying those blocks out
/// again begun ([`MAX_TOTAL_PASSES`]) and the blocks still to lay out in this one. Each step is one walk ([`later_step`]).
#[derive(Clone, Debug, Default)]
pub(crate) struct Later {
    moved: Taken,
    stale: Option<Totals>,
    rounds: usize,
    blocks: Vec<usize>,
}

impl Later {
    pub(crate) fn of(taken: Taken, stale: Option<Totals>) -> Later {
        Later { moved: taken.filter(|(_, s)| !s.is_none()), stale, ..Later::default() }
    }
}

/// `l` with `later` still to do; settled when there is nothing.
pub(crate) fn leave(mut l: DocLayout, later: Later) -> DocLayout {
    let done = later.moved.is_none() && later.stale.is_none() && later.blocks.is_empty();
    l.later = (!done).then(|| Arc::new(later));
    l
}

/// One walk of what `l` left for later: the next block the moved pages show wrongly, laid out again, which takes the pages
/// after it over again (those moved as it found them, which adds to how far they have moved since they were laid out); or,
/// once those are done, the next block showing a page total, laid out again with the totals found, as many rounds as a
/// whole layout would do its passes again (engine-main-thread: an Enter that added a page on page 300 of the Word fixture,
/// whose body shows NUMPAGES, laid all 976 pages out again where the edit alone took 3 ms). The layout and the pages that
/// draw differently; `None` when it has to be laid out whole.
pub(crate) fn later_step(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, mut l: DocLayout) -> Option<(DocLayout, Range<usize>)> {
    let Some(later) = l.later.take() else { return Some((l, 0..0)) };
    let mut later = Arc::unwrap_or_clone(later);
    if let Some((at, moved)) = later.moved.take()
        && let Some(b) = shift_reaches(doc, at, moved)
    {
        let (next, c, stale, taken) = redo_edit(doc, cache, opts, l, Some(Edit::blocks(b)), None)?;
        later.moved = taken.map(|(at, s)| (at, moved.then(s)));
        later.stale = stale;
        return Some((leave(next, later), c));
    }
    if later.blocks.is_empty() {
        let Some(found) = later.stale.take() else { return Some((leave(l, later), 0..0)) };
        if later.rounds == MAX_TOTAL_PASSES || totals_outside_body(doc) {
            return None;
        }
        later.rounds += 1;
        let mut rec = Arc::try_unwrap(l.resume.take()?).ok()?;
        rec.totals = found;
        l.resume = Some(Arc::new(rec));
        later.blocks = (0..doc.body.len()).rev().filter(|&b| any_para(&doc.body[b], &mut |p| has_total_fields(p))).collect();
    }
    let Some(b) = later.blocks.pop() else { return Some((leave(l, later), 0..0)) };
    let (next, c, stale, taken) = redo_edit(doc, cache, opts, l, Some(Edit::block(b)), None)?;
    later.stale = stale;
    later.moved = Later::of(taken, None).moved;
    Some((leave(next, later), c))
}

/// Whether `l` was laid out from `doc` as it is (its body's blocks the same, and the parts layout reads).
pub(crate) fn laid_out_from(l: &DocLayout, doc: &Document) -> bool {
    l.resume.as_ref().is_some_and(|r| {
        r.doc.body.len() == doc.body.len()
            && r.doc.body.iter().zip(&doc.body).all(|(a, b)| Arc::ptr_eq(a, b))
            && changed_parts(&r.doc, doc).is_some_and(|p| p.is_empty())
    })
}

/// What `l` left for later, done at once ([`later_step`]), with `changed` the pages that drew differently already.
pub(crate) fn finish_later(
    doc: &Document,
    cache: &mut LayoutCache,
    opts: &LayoutOptions,
    mut l: DocLayout,
    mut changed: Range<usize>,
) -> Option<(DocLayout, Range<usize>)> {
    while l.later.is_some() {
        let (next, c) = later_step(doc, cache, opts, l)?;
        (l, changed) = (next, union(changed, c));
    }
    Some((l, changed))
}

/// The body shows page totals (NUMPAGES, SECTIONPAGES) and the edit changed them (`stale`, the totals found): the blocks that
/// show them are laid out again with the totals found, each as an edit of its own, rather than the whole document
/// ([`later_step`]). `None` when it has to be laid out whole.
pub(crate) fn redo_totals(
    doc: &Document,
    cache: &mut LayoutCache,
    opts: &LayoutOptions,
    (l, changed): (DocLayout, Range<usize>),
    stale: Option<Totals>,
) -> Option<(DocLayout, Range<usize>)> {
    finish_later(doc, cache, opts, leave(l, Later::of(None, stale)), changed)
}

/// A page total in a story laid out with the body (a text box, a footnote or an endnote) belongs to no body block
/// [`redo_totals`] could lay out again. Headers and footers fill theirs in after pagination (`track_totals`).
fn totals_outside_body(doc: &Document) -> bool {
    let outside = doc.parts.values().filter(|p| !matches!(p.kind, ew_doc::PartKind::Header | ew_doc::PartKind::Footer));
    outside.flat_map(|p| p.blocks.iter()).any(|b| any_para(b, &mut |p| has_total_fields(p)))
}

/// engine-repaginate-2: the first blocks from `block` on that old pages taken over from there (`start`: at the top of its
/// section), moved by `shift`, would show wrongly, to be laid out again ([`redo_reached`]): when their numbers moved, a block
/// showing its page's number (a PAGE field, in its text, a text box or a note), or the start of a section that numbers its
/// pages again; when they moved by an odd number, the start of a section that starts on an odd or even page (where the old
/// pass put a blank page or not). A section's start is laid out again from the block before it to its first block, so that
/// the walk comes back to the pages taken over only after the section began: their marks were moved, not laid out, and
/// match its state before it begins.
fn shift_reaches(doc: &Document, (block, start): (usize, bool), shift: Shift) -> Option<Range<usize>> {
    if shift.number == 0 {
        return None;
    }
    let mut reach = None;
    let mut begin = 0;
    for (end, s) in doc.sections() {
        let first = std::mem::replace(&mut begin, end + 1);
        let parity = shift.number % 2 != 0 && matches!(s.start, SectionStart::OddPage | SectionStart::EvenPage);
        if first > 0 && (parity || s.page_num_start.is_some()) && (first > block || (first == block && start)) {
            reach = Some(first - 1..first + 1);
            break;
        }
    }
    let to = reach.as_ref().map_or(doc.body.len(), |r| r.start + 1).min(doc.body.len());
    let odd = shift.number % 2 != 0;
    let shows = |b: usize| any_para(&doc.body[b], &mut |p| shows_page_number(doc, p)) || (odd && sides_matter(doc, &doc.body[b]));
    let page = (block..to).find(|&b| shows(b));
    page.map(|b| b..b + 1).or(reach)
}

/// engine-repaginate-2: whether block `b` lays out differently on an odd page than on an even one, with odd and even headers
/// and mirrored margins off: a picture or shape placed by the inside or outside margin or aligned inside or outside, a
/// text frame or floating table aligned so, or a paragraph with mirrored indents ([`PageFrame::even`], flow's mirrored
/// indents). Old pages holding one, taken over moved by an odd number, are laid out again there ([`shift_reaches`]).
fn sides_matter(doc: &Document, b: &Block) -> bool {
    use ew_doc::para::{Anchor, FloatAlign};
    let side = |a: Option<FloatAlign>| matches!(a, Some(FloatAlign::Inside | FloatAlign::Outside));
    match b {
        Block::Para(p) => {
            let rp = doc.styles.resolve_para(&p.props);
            rp.mirror_indents
                || rp.frame.as_ref().is_some_and(|f| matches!(f.x_align.as_deref(), Some("inside" | "outside")))
                || p.objects.iter().filter_map(|o| o.frame()).any(|(_, _, f)| matches!(f.h_rel, Anchor::InsideMargin | Anchor::OutsideMargin) || side(f.h_align))
        }
        Block::Table(t) => {
            t.props.float.is_some_and(|f| matches!(f.h_rel, Anchor::InsideMargin | Anchor::OutsideMargin) || side(f.h_align))
                || b.lists().iter().any(|(_, _, list)| list.iter().any(|cb| sides_matter(doc, cb)))
        }
        Block::Container(_) => b.lists().iter().any(|(_, _, list)| list.iter().any(|cb| sides_matter(doc, cb))),
    }
}

/// Whether paragraph `p` shows the number of the page it is on: a PAGE field in its text, or in a text box or note it shows.
fn shows_page_number(doc: &Document, p: &Paragraph) -> bool {
    let part = |id: &u32| doc.parts.get(id).is_some_and(|part| part.blocks.iter().any(|b| any_para(b, &mut |q| has_page_number_fields(q))));
    has_page_number_fields(p)
        || p.objects.iter().any(|o| match o {
            InlineObject::NoteRef { id, .. } => part(id),
            o => o.text_boxes().iter().any(part),
        })
}

/// What [`redo_edit`]'s walk lays the document out again against: the layout before the edit (its pass, the pages from the
/// mark it went again from, and its line index), the edit and the parts it changed, the mark `k` (on page `from` + 1) and
/// the first block the walk lays out, how many pages there were, and the floats pages start with, the blocks numbered after
/// the edit. Kept with a walk that paused at the view's pages ([`progress::after_edit`]), so that the rest, laid out in
/// slices, can take the old pages over once it comes back to them.
#[derive(Clone)]
pub(crate) struct Redo {
    /// The old pass; a walk compares with its marks from `base` on: the one it went again from (`k`), or the first of the
    /// list once a pass made from the walk holds those before ([`progress::after_edit`]).
    pub(crate) rec: Resume,
    pub(crate) base: usize,
    pub(crate) tail: Vec<Page>,
    /// The old line index; kept with a paused walk, it goes with the layout shown meanwhile ([`progress::Overlay`]).
    pub(crate) index: LineIndex,
    pub(crate) edit: Edit,
    pub(crate) parts: Vec<u32>,
    pub(crate) k: usize,
    pub(crate) from: usize,
    pub(crate) first: usize,
    pub(crate) old_len: usize,
    pub(crate) early: EarlyFloats,
    /// The old blocks with floats placed above their anchors, sorted ([`Old::may_shift`]).
    pub(crate) floats: Vec<usize>,
}

impl Redo {
    /// What a walk compares with to take the old pages over.
    fn old(&self, strict: bool) -> Old<'_> {
        let marks = self.rec.marks.get(self.base..).unwrap_or_default();
        Old { marks, edit: &self.edit, behind: &self.rec.behind, shifts: Some((&self.floats, self.first)), strict }
    }

    /// The first page laid out again.
    pub(crate) fn from(&self) -> usize {
        self.from
    }

    /// The marks of a pass made from the edit's walk ([`progress::after_edit`]): the old ones before those it recorded since
    /// that walk began, and those.
    pub(crate) fn split_marks(&self, mut marks: Vec<Mark>) -> (Option<Vec<Mark>>, Vec<Mark>) {
        let new = marks.split_off(self.k.min(marks.len()));
        (Some(marks), new)
    }

    /// The floats placed above their anchors found in the blocks laid out again, of those a walk carried.
    pub(crate) fn relaid_floats(&self, floats: HashMap<(usize, usize), Option<(usize, WrapArea)>>) -> HashMap<(usize, usize), Option<(usize, WrapArea)>> {
        floats.into_iter().filter(|((b, _), _)| *b >= self.first).collect()
    }
}

/// [`redo`]'s one edit, from the marks of `prev`: the one `doc` made (by comparing the bodies), or `block`, a block whose text
/// is the same but lays out differently (it shows page totals that changed) → the layout, the pages that draw differently,
/// the totals found when the body shows totals other than those it was laid out with, and the first block to lay out again
/// for old pages taken over moved ([`shift_reaches`]). `None` when it has to be laid out whole. With `view`, a walk that
/// passes the view's pages (and the edit's page and the next) without coming back to the old pagination pauses there: the
/// layout comes back unsettled, the rest to follow in slices ([`progress::after_edit`]).
fn redo_edit(
    doc: &Document,
    cache: &mut LayoutCache,
    opts: &LayoutOptions,
    mut prev: DocLayout,
    block: Option<Edit>,
    view: Option<usize>,
) -> Option<(DocLayout, Range<usize>, Option<Totals>, Taken)> {
    let mut rec = Arc::try_unwrap(prev.resume.take()?).ok()?;
    if Mode::of(opts.view).reflow
        || opts.comment_balloons
        || !same_opts(&rec.opts, opts)
        || cache.env != rec.env
        || rec.dictionary != ew_proof::dictionary_generation()
        || cache.paras.len() > rec.paras + MAX_GROWTH
        || rec.edits != prev.ids.edits()
    {
        return None;
    }
    let parts = changed_parts(&rec.doc, doc)?;
    let mut edit = match block {
        Some(e) if parts.is_empty() => e,
        Some(_) => return None,
        None => Edit::of((&rec.doc, &rec.opts), doc, opts, &parts)?,
    };
    if edit.is_empty() {
        rec.opts = opts.clone();
        prev.resume = Some(Arc::new(rec));
        return Some((prev, 0..0, None, None));
    }
    // From here the pages' names are the new body's: a layout that cannot go on is laid out whole, with names of its own.
    let ids = prev.ids.clone();
    edit.rename(&ids, &doc.body);
    let k = resume_mark(&rec.marks, &ids, (&rec.doc, doc), &edit)?;
    let (from, old_len) = (rec.marks[k].pages.saturating_sub(1), prev.pages.len());
    let first = edit.was(&ids, rec.marks[k].id)?;
    if rec.marks[k].pages > old_len {
        return None;
    }
    // The old blocks with floats placed above their anchors (or that pages start with), for taking the old pages over moved.
    let mut floats: Vec<usize> = rec.floats.iter().filter(|(_, v)| v.is_some()).map(|((b, _), _)| *b).collect();
    floats.extend(rec.early.values().flatten().map(|(b, ..)| *b));
    floats.sort_unstable();
    floats.dedup();
    let early: EarlyFloats =
        rec.early.iter().map(|(page, v)| (*page, v.iter().map(|(b, oi, a)| (edit.moved(*b), *oi, a.clone())).collect())).collect();
    // The pages before the mark's stay; the one it was filling comes back as it was then.
    let mut pages = std::mem::take(&mut prev.pages);
    let tail = pages.split_off(from);
    let index = std::mem::take(&mut prev.index);
    let mut redo = Redo { rec, base: k, tail, index, edit, parts, k, from, first, old_len, early, floats };
    // A section break that went or came may number the notes again, by sections that restart them: laid out whole then. The
    // numbers found, equal, are taken as the layout's (their sections are numbered as now).
    if redo.edit.section.is_some() {
        let notes = note_numbers(doc, opts, &redo.rec.note_pages);
        if notes.1 != redo.rec.notes.1 {
            return None;
        }
        redo.rec.notes = notes;
    }
    let (rec, m) = (&redo.rec, &redo.rec.marks[k]);

    let mut ctx = new_ctx(doc, cache, opts, (&rec.note_pages, &rec.totals), (Some(rec.notes.clone()), ids.clone()));
    let hf = Arc::clone(&ctx.hf);
    let sections = &hf.sections;
    ctx.mirror = doc.settings.mirror_margins;
    (ctx.stacked_marks, ctx.quiet_marks) = section_marks(doc, opts, sections);
    ctx.folded = crate::outline::folded(doc, opts);
    let default_sect = SectionProps::default();
    let sect_ref = sections.first().map_or(&default_sect, |(_, s)| *s);
    let mut pb = new_page_builder(sect_ref, &redo.early, (false, rec.settle), ids.clone());
    let mut endnotes = endnote_queue(&ctx);
    endnotes.drain(..m.walk.endnotes.min(endnotes.len()));
    let turned = turned_sections(&mut ctx, sections, false);
    let env = Env { hf: &hf, turned: &turned, sect_ref, mode: Mode::of(opts.view), outline: &None, totals: &rec.totals };
    pb.pages = pages;
    pb.pages.extend(m.page.clone());
    pb.behind = vec![0; pb.pages.len()];
    if let Some(b) = pb.behind.last_mut() {
        *b = m.behind;
    }
    m.pb.load(&mut pb);
    restore_ctx(&mut ctx, m);
    let mut track = Track::new(true);
    track.walk = m.walk;
    track.old = Some(redo.old(false));
    // engine-repaginate: a page added or taken away moves every later page, and a walk comes back to the old pagination only
    // at the same page count, so without a stop it lays out the rest of the document (all of the Word fixture after page 300).
    // A paused pass is made from this layout instead: its pages before the edit are dressed already, which only turning
    // (vertical sections) and mirrored margins would do twice, so those documents are laid out whole as before; and the page
    // totals it ends with are laid out again as here ([`redo_totals`]), which totals outside the body cannot be.
    // engine-repaginate-2: old pages moved by whole pages are taken over too ([`Shift`]), so the walk usually comes back to
    // them a page or two after the edit, and the rest in slices does when it reaches them.
    let pausable = !doc.settings.mirror_margins && !sections.iter().any(|(_, s)| s.text_direction.is_turned()) && !totals_outside_body(doc);
    // A count of pages rather than a time, so a busy machine pauses where a quiet one does ([`edit_stop`]).
    track.stop = view.filter(|_| pausable).map(|v| edit_stop(ctx.cache, v, from));
    let n0 = pb.pages.len();
    let block = walk_sections(&mut ctx, &mut pb, &env, &mut endnotes, (m.si, first, (!m.start).then_some(m)), &mut track);
    ctx.cache.pages_laid += pb.pages.len().saturating_sub(n0.saturating_sub(1)) as u64;
    let Track { marks: new_marks, splice, stopped, .. } = track;
    if stopped && splice.is_none() {
        // The pass's pages before the edit are this layout's (redo_edit's walk counts nothing behind their text).
        let mut behind = redo.rec.behind.get(..from).unwrap_or_default().to_vec();
        behind.extend(pb.behind.get(from..).unwrap_or_default());
        let mut pages = std::mem::take(&mut pb.pages);
        // The pass made from the walk holds the old marks before the walk's and those it recorded; the old ones after stay
        // with the old pages for the rest's walk to compare with.
        let after = redo.rec.marks.split_off(k);
        let mut marks = std::mem::replace(&mut redo.rec.marks, after);
        redo.base = 0;
        marks.extend(new_marks);
        let rec = &redo.rec;
        let mut floats: HashMap<_, _> = rec.floats.iter().filter(|((b, _), _)| *b < first).map(|(k, v)| (*k, v.clone())).collect();
        floats.extend(std::mem::take(&mut ctx.floats_above));
        let notes = (ctx.fields.notes.clone(), ctx.notes_hash);
        let (env, boxes) = (ctx.cache.env, ctx.boxes.total());
        // The pages before the edit are lent to those shown rather than copied ([`progress::Progress`]'s `lent`).
        let shown: Vec<Page> = pages[..from].iter_mut().map(std::mem::take).collect();
        let paused = Paused { env, pages, behind, marks, floats, boxes, notes };
        // The floats placed above their anchors on the pages after the edit were placed for the old pagination: the pass
        // finds them again where they are now, and is done again with them if they moved, from the last mark before the
        // first page they changed ([`rewrap_from`]).
        let early = redo.early.iter().filter(|(page, _)| **page < from).map(|(p, v)| (*p, v.clone())).collect();
        let per_page = sections.iter().any(|(_, s)| doc.note_options(s, false).num_restart == ew_doc::section::NoteRestart::EachPage);
        // The parts the edit changed may be text boxes, which the old pass's look did not see.
        let pagerefs = if redo.parts.is_empty() { rec.pagerefs } else { headers_footers_refer_to_pages(doc) };
        let inp = PassInputs { note_pages: rec.note_pages.clone(), totals: rec.totals.clone(), may_repeat: false, early, may_rewrap: !rec.settle, ids, stale_from: from, pagerefs };
        let passes = Passes { inp, totals_passes: MAX_TOTAL_PASSES, rewraps: 0, note_passes: 1, per_page };
        // engine-layout-key: the index goes as it is, its old pages' lines with it: the layout shows only its lines before
        // the edit's page, and those of the pages laid out since come in their own index ([`progress::Overlay`]). Splitting the
        // old pages' lines out took 0.45 ms of an Enter on page 300 of the Word fixture natively, 1.9 ms on page 1.
        let index = std::mem::take(&mut redo.index);
        let changed = from..redo.tail.len() + from;
        let l = progress::after_edit(doc, cache, opts, (passes, paused, view.unwrap_or_default()), (shown, index), Arc::new(redo));
        return Some((l, changed, None, None));
    }
    let laid = match (splice, block) {
        (Some((_, inside, shift)), _) => take_old_pages((pb.pages, pb.behind), std::mem::take(&mut redo.tail), (from, inside), &redo.rec.behind, shift)?,
        (None, Some(block)) => {
            if pb.pages.is_empty() {
                pb.new_page(0, sect_ref.margin_top);
            }
            let rest: Vec<u32> = endnotes.into_iter().map(|(id, _)| id).collect();
            place_endnotes(&mut ctx, &mut pb, rest, block);
            let (pages, behind) = finish_pages(pb, doc, sections, false, from);
            Laid { to: pages.len(), replaced: std::mem::take(&mut redo.tail), pages, behind }
        }
        (None, None) => return None,
    };
    finish_redo(doc, opts, &mut ctx, redo, laid, (None, new_marks, splice))
}

/// [`redo_edit`]'s end, from a walk (`new_marks`, after the old marks it went again from, which `head` holds when the old
/// pass's do not, and where it took the old pages over) that laid `laid` out: the same findings, the headers and footers, the line index, the marks and the layout's
/// record. Also for the rest of a walk that paused at the view's pages and came back to the old pages in a slice later
/// ([`progress`]).
pub(crate) fn finish_redo(
    doc: &Document,
    opts: &LayoutOptions,
    ctx: &mut Ctx,
    redo: Redo,
    mut laid: Laid,
    (head, new_marks, splice): (Option<Vec<Mark>>, Vec<Mark>, Option<(usize, bool, Shift)>),
) -> Option<(DocLayout, Range<usize>, Option<Totals>, Taken)> {
    let Redo { mut rec, base, mut index, edit, parts, k, from, first, old_len, early, .. } = redo;
    // The old mark where the old pages take over, in the old pass's list.
    let splice = splice.map(|(i, inside, shift)| (base + i, inside, shift));
    let hf = Arc::clone(&ctx.hf);
    let sections = &hf.sections;
    let ids = ctx.ids.clone();
    let shift = splice.map_or(Shift::default(), |s| s.2);
    if splice.is_some() {
        turn_pages(&mut laid.pages[from..laid.to], sections);
    }
    ctx.grid = para::Grid::default();

    // The blocks laid out again: from the mark's to the splice's (old numbers), or to the end.
    let relaid = first..splice.and_then(|(i, ..)| edit.was(&ids, rec.marks[i].id)).unwrap_or(usize::MAX);
    let (floats, found, uses_totals, stale) = same_findings(ctx, &rec, &laid, (from, old_len), (&relaid, &edit, shift))?;
    let (hf_range, bookmarks) = redo_headers(ctx, &rec, &mut laid, (from, &found), (&relaid, &edit, splice.is_some(), shift));

    let changed = drawn_again(&laid, (from, old_len), hf_range, shift);

    // The pages after the splice keep their lines' entries (they name their blocks by id), at pages moved as they moved.
    let kept = from + laid.replaced.len();
    unindex_pages(&mut index, &laid.replaced, from);
    shift_index(&mut index, kept, shift.pages);
    index_pages(&mut index, &laid.pages[from..laid.to], from);

    // Where the old pages take over: the blocks from there on that their move shows wrongly are laid out again after.
    let taken = splice.and_then(|(i, ..)| {
        let m = &rec.marks[i];
        Some(((ids.block(m.id)?, m.start), shift))
    });
    // The marks: the old ones before the edit, the new ones (ending with the one where the old pages took over, whose page
    // is the new one), and the old ones after it, moved as their pages moved.
    let after = splice.map(|(i, ..)| rec.marks.split_off(i + 1)).unwrap_or_default();
    let mut marks = head.unwrap_or_else(|| {
        let mut m = std::mem::take(&mut rec.marks);
        m.truncate(k);
        m
    });
    marks.extend(new_marks);
    if shift.is_none() {
        marks.extend(after);
    } else {
        marks.extend(after.into_iter().map(|m| m.shifted(shift)));
    }
    // The floats pages start with: those of the old pages taken over are on their pages moved.
    let early = early.into_iter().map(|(p, v)| (if p >= kept { shift.page(p) } else { p }, v)).collect();
    // The document as laid out: the old one's other fields are equal to the new one's, or (the revision records) one list
    // begins the other.
    let mut kept_doc = rec.doc;
    kept_doc.body = doc.body.clone();
    if kept_doc.revisions.len() != doc.revisions.len() {
        kept_doc.revisions = doc.revisions.clone();
    }
    for id in parts {
        if let Some(part) = doc.parts.get(&id) {
            kept_doc.parts.insert(id, part.clone());
        }
    }
    let behind = laid.behind;
    let edits = ids.edits();
    let resume = Resume { doc: kept_doc, opts: opts.clone(), early, floats, marks, behind, found, uses_totals, bookmarks, edits, ..rec };
    let text_boxes = resume.text_boxes;
    let lay = DocLayout { pages: laid.pages, index, ids, ms: 0.0, text_boxes, resume: Some(Arc::new(resume)), progress: None, later: None };
    Some((lay, changed, stale, taken))
}

// The pages that draw differently from the old ones: those laid out again (`from..laid.to`) and those whose headers
/// were (`headers`), less the pages at either end that came out as they were (the page after a paragraph is laid out
/// again until the old pages take over, and usually comes out the same).
fn drawn_again(laid: &Laid, (from, old_len): (usize, usize), headers: Range<usize>, shift: Shift) -> Range<usize> {
    // Moved, every later page holds what another page held.
    if !shift.is_none() {
        return union(headers, from..laid.pages.len().max(old_len));
    }
    let mut r = from..laid.to;
    if laid.replaced.len() == r.len() {
        let same = |i: usize| laid.replaced.get(i - from).is_some_and(|old| same_page(&laid.pages[i], old));
        while !r.is_empty() && same(r.end - 1) {
            r.end -= 1;
        }
        while !r.is_empty() && same(r.start) {
            r.start += 1;
        }
    }
    match (r.is_empty(), headers.start < from || headers.end > laid.to) {
        (_, true) => headers.start.min(from)..headers.end.max(laid.to),
        (true, false) => from..from,
        (false, false) => r,
    }
}

/// Whether page `a` draws as `b` does: the same lines of the same paragraph layouts in the same places, and the same
/// other items.
fn same_page(a: &Page, b: &Page) -> bool {
    a.w == b.w
        && a.h == b.h
        && a.number == b.number
        && a.section == b.section
        && a.body == b.body
        && same_items(&a.items, &b.items)
        && same_items(&a.header, &b.header)
        && same_items(&a.footer, &b.footer)
}

pub(crate) fn same_items(a: &[Placed], b: &[Placed]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| match (x, y) {
            (
                Placed::Lines { story, path, para, l0, l1, x, y, turn },
                Placed::Lines { story: s2, path: p2, para: q, l0: m0, l1: m1, x: x2, y: y2, turn: t2 },
            ) => Arc::ptr_eq(para, q) && (story, path, l0, l1, x, y, turn) == (s2, p2, m0, m1, x2, y2, t2),
            (Placed::Clip { rect, spin, items }, Placed::Clip { rect: r2, spin: s2, items: i2 }) => (rect, spin) == (r2, s2) && same_items(items, i2),
            // Charts and freeforms by pointer: they come from the document's own Arc, which an unchanged object keeps.
            (
                Placed::Graphic { rect, graphic, story, path, off, spin },
                Placed::Graphic { rect: r2, graphic: g2, story: s2, path: p2, off: o2, spin: n2 },
            ) => Arc::ptr_eq(graphic, g2) && (rect, story, path, off, spin) == (r2, s2, p2, o2, n2),
            (
                Placed::Shape { rect, kind, fill, stroke, stroke_width, freeform, effects, spin, extra, object, alt },
                Placed::Shape { rect: r2, kind: k2, fill: f2, stroke: s2, stroke_width: w2, freeform: ff2, effects: e2, spin: n2, extra: x2, object: o2, alt: a2 },
            ) => {
                freeform.as_ref().map(Arc::as_ptr) == ff2.as_ref().map(Arc::as_ptr)
                    && (rect, kind, fill, stroke, stroke_width, effects, spin, extra, object, alt) == (r2, k2, f2, s2, w2, e2, n2, x2, o2, a2)
            }
            (Placed::Fill { rect, color }, Placed::Fill { rect: r2, color: c2 }) => (rect, color) == (r2, c2),
            (Placed::Rule { x0, y0, x1, y1, border }, Placed::Rule { x0: a0, y0: b0, x1: a1, y1: b1, border: d2 }) => {
                (x0, y0, x1, y1, border) == (a0, b0, a1, b1, d2)
            }
            (
                Placed::Image { rect, media, crop, story, path, off, spin, shape },
                Placed::Image { rect: r2, media: m2, crop: c2, story: s2, path: p2, off: o2, spin: n2, shape: h2 },
            ) => {
                // The crop shape by pointer, as freeforms: it comes from the document's own Arc.
                shape.as_ref().map(Arc::as_ptr) == h2.as_ref().map(Arc::as_ptr)
                    && (rect, media, crop, story, path, off, spin) == (r2, m2, c2, s2, p2, o2, n2)
            }
            (
                Placed::Cell { rect, covered, table, row, cell, story, clip },
                Placed::Cell { rect: r2, covered: v2, table: t2, row: w2, cell: c2, story: s2, clip: k2 },
            ) => (rect, covered, table, row, cell, story, clip) == (r2, v2, t2, w2, c2, s2, k2),
            (
                Placed::Object { rect, spin, story, path, off, text_box, wrap, origin, layer },
                Placed::Object { rect: r2, spin: n2, story: s2, path: p2, off: o2, text_box: t2, wrap: w2, origin: g2, layer: l2 },
            ) => (rect, spin, story, path, off, text_box, wrap, origin, layer) == (r2, n2, s2, p2, o2, t2, w2, g2, l2),
            // Different kinds of item (a new kind without an arm here counts as drawn again, which is safe).
            _ => false,
        })
}

/// The mark a layout after `edit` starts from: the last one before what the edit can reach, outside a section balancing
/// its last page. The paragraph before the first changed block reads its properties (spacing, borders, list label); one
/// kept with the next measures its lines too, and so do those before it in a chain kept together.
pub(crate) fn resume_mark(marks: &[Mark], ids: &BlockIds, (was, doc): (&Document, &Document), edit: &Edit) -> Option<usize> {
    let same_props = match (was.body.get(edit.start).map(|b| &**b), doc.body.get(edit.start).map(|b| &**b)) {
        (Some(Block::Para(p)), Some(Block::Para(q))) => p.props == q.props,
        _ => false,
    };
    let mut reach = if same_props { edit.start } else { edit.start.saturating_sub(1) };
    for _ in 0..KEEP_REACH {
        match reach.checked_sub(1).and_then(|i| doc.body.get(i)).map(|b| &**b) {
            Some(Block::Para(p)) if doc.styles.resolve_para(&p.props).keep_next => reach -= 1,
            Some(Block::Table(_) | Block::Container(_)) => reach -= 1,
            _ => break,
        }
    }
    let mut k = marks.partition_point(|m| edit.was(ids, m.id).is_some_and(|b| b <= reach)).checked_sub(1)?;
    // A section break that went or came: from the top of the section the edit is in, or before (a mark at its first block
    // inside it holds the page as the section's old properties made it).
    if let Some(first) = edit.section {
        k = k.min(marks.partition_point(|m| edit.was(ids, m.id).is_some_and(|b| b < first || (b == first && m.start))).checked_sub(1)?);
    }
    while marks[k].balance && !marks[k].start {
        k = k.checked_sub(1)?;
    }
    Some(k)
}

/// The pages after laying out again: all of them, those laid out again (`from..to`), the old ones they replaced, and how
/// many items each page put behind its text.
pub(crate) struct Laid {
    pages: Vec<Page>,
    to: usize,
    replaced: Vec<Page>,
    behind: Vec<usize>,
}

/// The pages when the old ones take over from the page being filled (`old`: the old pages from `from` on), the new ones
/// before it turned for vertical sections; the old pages taken over moved by `shift` (engine-repaginate-2), and numbered
/// as they moved. Inside it (`inside`), the old page's items after this point are (the mark's page
/// held as many); else from the next page on. The old pages and items are taken as they are: they name their blocks by id.
pub(crate) fn take_old_pages(
    (mut pages, mut now_behind): (Vec<Page>, Vec<usize>),
    mut old: Vec<Page>,
    (from, inside): (usize, bool),
    behind: &[usize],
    shift: Shift,
) -> Option<Laid> {
    let cur = pages.len().checked_sub(1)?;
    // The old page the one being filled is.
    let was = cur.checked_add_signed(-shift.pages)?;
    let keep_from = was.checked_sub(from)? + usize::from(inside);
    if keep_from > old.len() {
        return None;
    }
    let mut kept = old.split_off(keep_from);
    for p in &mut kept {
        p.number = shift.renumber(p.number);
    }
    let to = if inside {
        let (Some(page), Some(was)) = (pages.last_mut(), old.last()) else { return None };
        let (k, t) = (page.items.len(), page.float_tables.len());
        page.items.extend(was.items.get(k..).unwrap_or_default().iter().cloned());
        page.float_tables.extend(was.float_tables.get(t..).unwrap_or_default().iter().cloned());
        cur + 1
    } else {
        pages.truncate(cur);
        cur
    };
    now_behind.truncate(to);
    now_behind.extend(behind.get(to.checked_add_signed(-shift.pages)?..).unwrap_or_default());
    pages.extend(kept);
    Some(Laid { pages, to, replaced: old, behind: now_behind })
}

/// The floats of a whole layout, its page totals, whether the body shows them, and the totals found when they differ from
/// those the body was laid out with (the body's total fields show old totals: [`redo`] lays them out again).
type Findings = (HashMap<(usize, usize), Option<(usize, WrapArea)>>, Totals, bool, Option<Totals>);

/// What the old pass found that a layout pass would be done again for, found the same in the blocks laid out again
/// (`relaid`, old numbers): the floats placed above their anchors (or the passes before it would have gone otherwise) and
/// the pages footnotes numbered on each page are on. `None` when something differs. The page totals the body shows may
/// differ: the findings say so.
fn same_findings(
    ctx: &mut Ctx,
    rec: &Resume,
    laid: &Laid,
    (from, old_len): (usize, usize),
    (relaid, edit, shift): (&Range<usize>, &Edit, Shift),
) -> Option<Findings> {
    let (doc, hf) = (ctx.doc, Arc::clone(&ctx.hf));
    let sections = &hf.sections;
    let was = rec.floats.iter().filter(|((b, _), _)| relaid.contains(b)).map(|(&(b, oi), v)| ((edit.moved(b), oi), v));
    if found_floats(ctx.floats_above.iter().map(|(k, v)| (*k, v))) != found_floats(was) {
        return None;
    }
    let mut floats = std::mem::take(&mut ctx.floats_above);
    // Those of the old pages taken over are on their pages moved.
    let moved = |b: usize, v: &Option<(usize, WrapArea)>| v.clone().map(|(p, a)| (if b >= relaid.end { shift.page(p) } else { p }, a));
    floats.extend(rec.floats.iter().filter(|((b, _), _)| !relaid.contains(b)).map(|(&(b, oi), v)| ((edit.moved(b), oi), moved(b, v))));
    let new = &laid.pages[from..laid.to];
    let per_page = sections.iter().any(|(_, s)| doc.note_options(s, false).num_restart == ew_doc::section::NoteRestart::EachPage);
    if per_page && footnote_pages(doc, new) != footnote_pages(&rec.doc, &laid.replaced) {
        return None;
    }
    // The totals are the same when the pages laid out again hold each section's text as the old ones did.
    let (now, was) = (|id| ctx.ids.block(id), |id| edit.was(&ctx.ids, id));
    let (counted, replaced) = (Totals::count(new, sections, &now), Totals::count(&laid.replaced, &rec.doc.sections(), &was));
    let found = if laid.pages.len() == old_len && counted == replaced {
        rec.found.clone()
    } else {
        // The pages taken over hold each section's text as they did (engine-repaginate-2: counting every page again held a
        // page count change on the Word fixture for 3 ms).
        rec.found.moved((&replaced, &counted), laid.pages.len()).unwrap_or_else(|| Totals::of(&laid.pages, sections))
    };
    let uses_totals = rec.uses_totals || ctx.uses_totals;
    let stale = (uses_totals && found != rec.totals).then(|| found.clone());
    Some((floats, found, uses_totals, stale))
}

/// Lays the headers and footers out on the pages laid out again, and on all of them when what they show of the others
/// changed (page totals, a bookmark's page for PAGEREF; for STYLEREF, the pages after). The pages whose headers were laid
/// out, and the bookmarks' pages.
fn redo_headers(
    ctx: &mut Ctx,
    rec: &Resume,
    laid: &mut Laid,
    (from, found): (usize, &Totals),
    (relaid, edit, spliced, shift): (&Range<usize>, &Edit, bool, Shift),
) -> (Range<usize>, (Arc<fields::BookmarkPages>, u64)) {
    let (doc, hf) = (ctx.doc, Arc::clone(&ctx.hf));
    let (sections, all) = (&hf.sections, laid.pages.len());
    ctx.track_totals = false;
    let mut range = from..laid.to;
    if *found != rec.found {
        range = 0..all;
    }
    // Old pages taken over renumbered show their new numbers.
    if rec.styleref || shift.number != 0 {
        range.end = all;
    }
    let mut bookmarks = rec.bookmarks.clone();
    if rec.pagerefs {
        // Bookmarks move only with the pages laid out again, and only those starting in the blocks laid out again.
        let marked = |blocks: Option<&[Arc<Block>]>| {
            let starts = |p: &Paragraph| p.objects.iter().any(|o| matches!(o, InlineObject::BookmarkStart { .. }));
            blocks.unwrap_or_default().iter().any(|b| any_para(b, &mut |p| starts(p)))
        };
        let (old, new) = (&rec.doc.body, &doc.body);
        let moved = marked(old.get(relaid.start..relaid.end.min(old.len()))) || marked(new.get(relaid.start..edit.moved(relaid.end).min(new.len())));
        if !spliced || moved || !shift.is_none() {
            let marks = Arc::new(bookmark_pages(doc, &laid.pages, sections));
            bookmarks = (marks.clone(), marks_key(&marks));
            if bookmarks.1 != rec.bookmarks.1 {
                range = 0..all;
            }
        }
        (ctx.fields.bookmark_pages, ctx.fields.bookmarks_key) = bookmarks.clone();
    }
    // engine-repaginate-2: outside the pages laid out again, only headers and footers that show something of the other pages
    // (page fields) or of their own page's side can change; STYLEREF shows the body's text, so with it every page in the
    // range is laid out again. Laying out every page's headers for a page count change held an Enter on page 300 of the Word
    // fixture for milliseconds.
    let mut shows = HashMap::new();
    let mut paged = |id: Option<u32>| {
        id.is_some_and(|id| {
            *shows.entry(id).or_insert_with(|| {
                let part = |id: &u32| doc.parts.get(id).is_some_and(|p| p.blocks.iter().any(|b| any_para(b, &mut |q| has_page_fields(q))));
                // A picture aligned to the inside or outside margin moves with an odd number of pages too.
                part(&id)
                    || doc.parts.get(&id).is_some_and(|p| {
                        p.blocks.iter().any(|b| any_para(b, &mut |q| q.objects.iter().any(|o| o.text_boxes().iter().any(part))))
                            || (shift.number % 2 != 0 && p.blocks.iter().any(|b| sides_matter(doc, b)))
                    })
            })
        })
    };
    let mut redo: Vec<bool> = laid.pages[range.clone()].iter().map(|p| rec.styleref || paged(p.header_story) || paged(p.footer_story)).collect();
    for i in from.max(range.start)..laid.to.min(range.end) {
        redo[i - range.start] = true;
    }
    headers_footers_where(ctx, &mut laid.pages, range.clone(), sections, found, &|i| redo[i - range.start]);
    if ctx.mirror {
        mirror_even_pages(&mut laid.pages[from..laid.to], sections);
        for i in (range.start..from).chain(laid.to..range.end).filter(|&i| redo[i - range.start]) {
            mirror_header_footer(&mut laid.pages[i], sections);
        }
    }
    (range, bookmarks)
}

/// Mirrored margins: the header and footer of an even page whose text is mirrored already ([`mirror_even_pages`]).
fn mirror_header_footer(page: &mut Page, sections: &[(usize, &SectionProps)]) {
    let Some((_, s)) = sections.get(page.section).filter(|_| page.number.is_multiple_of(2)) else { return };
    let dx = s.margin_right - s.margin_left - s.gutter;
    if dx.abs() < 0.001 || !dx.is_finite() {
        return;
    }
    for it in page.header.iter_mut().chain(page.footer.iter_mut()) {
        it.translate(dx, 0.0);
    }
}
