//! A layout made in slices (engine-open, docs/plans/engine/viewport-design.md section 8): a layout from the start lays the
//! document out until the view's pages are done and pauses at a mark; [`crate::advance`] goes on from there for a few milliseconds
//! at a time, between other work, until the pass ends. Pausing and going on from a mark is what laying out again after an
//! edit does already ([`super::relayout`]), so the finished layout is the one [`crate::layout`] makes, pass for pass. Meanwhile
//! the layout holds the pages finished so far, dressed as a finished pass dresses them (headers and footers, with the page
//! totals the pass assumes, and mirrored margins), and says it is not settled. An edit meanwhile lays out again from the
//! paused pass's last mark before it and takes the paused pages over where the pagination comes back to a state it had.
//! Only the print view pauses: the other views keep no marks and are laid out whole.

use std::ops::Range;
use std::sync::Arc;

use super::{
    Begin, Caught, Edit, Ending, LineIndex, Mode, Next, PassInputs, Passes, Paused, Redo, Stop, Walked, changed_parts, cut_index, finish_ending, finish_redo, index_lines,
    index_pages, join_index, keep_env, new_ctx, note_numbers, resume_mark, rewrap_page, same_opts, same_page, take_old_pages, turn_pages, union, unindex_pages,
    walk_pass,
};
use crate::cache::{LayoutCache, Totals};
use crate::cache::MAX_TOTAL_PASSES;
use crate::floats::MAX_REWRAP_PASSES;
use crate::headers::{bookmark_pages, headers_footers_refer_to_pages, headers_footers_where, marks_key, mirror_even_pages_after};
use crate::{Counters, DocLayout, Document, LayoutOptions, Page, now_ms};

/// A layout still being made: the pass under way and what it is made from.
pub(crate) struct Progress {
    /// What it is laid out from and with. Blocks are shared until edited, so an edit is found by comparing the body's blocks
    /// by pointer, as [`super::relayout`] does.
    doc: Document,
    opts: LayoutOptions,
    dictionary: u64,
    passes: Passes,
    paused: Paused,
    /// The pages shown are this pass's, as far as it has finished them: the first one's, or one done again for floats from a
    /// mark of the pass before ([`super::rewrap_from`]). Else the last pass's, all of them, until this one ends.
    own: bool,
    /// The pages a layout from the start lays out before it returns ([`LayoutCache::set_ahead`]).
    ahead: usize,
    /// How many edits the names of the body's blocks (`passes.inp.ids`) took in when it was last laid out.
    edits: u64,
    /// Made from a settled layout after an edit ([`after_edit`]): its passes keep the page totals they began with, and its end
    /// lays the blocks that show them out again, as [`super::relayout`] does.
    relaid: bool,
    /// engine-repaginate-2: that layout and the edit, while the first pass goes on from the edit's walk and no other edit came:
    /// once the pass comes back to the old pagination (or to it moved by whole pages), the old pages are taken over and the
    /// layout settles there ([`caught`]) rather than laying the rest of the document out.
    redo: Option<Arc<Redo>>,
    /// engine-repaginate-2: `paused.pages[..lent]`, the pages before an edit, are empty stand-ins: the pages shown hold them
    /// ([`after_edit`]) and lend them to each walk ([`swap_lent`]), which leaves pages before its mark as they are. Copied,
    /// they held an Enter on page 300 of the Word fixture for about 7 ms (298 pages), and dropping the copies a slice 3 ms.
    lent: usize,
    /// engine-keys-final: the pass's end, dressed a few pages a slice; `paused` is empty meanwhile.
    ending: Option<Box<Ending>>,
    /// engine-layout-key: the lines of the pages laid out since an edit, while the layout's own index is the one before it.
    overlay: Option<Overlay>,
}

/// engine-layout-key: the line index of a layout an edit's walk paused in ([`after_edit`]). The layout's `index` is the one
/// before the edit, whose lines on pages from `from` on are the old pages' and do not count, and `lines` holds those of the
/// pages laid out since from there on. Taking the old pages' lines out at once cost a key 0.45 ms on page 300 of the Word
/// fixture natively and 1.9 ms on page 1; kept, they are the index again when the walk comes back to the old pages
/// ([`caught`]). Anything else that changes the index makes it whole first ([`own_index`]).
#[derive(Debug)]
pub(crate) struct Overlay {
    pub(crate) from: usize,
    pub(crate) lines: LineIndex,
}

/// The layout's index made whole again from `overlay`: the old pages' lines out, those laid out since in.
fn own_index(index: &mut LineIndex, overlay: Option<Overlay>) {
    if let Some(o) = overlay {
        cut_index(index, o.from);
        join_index(index, o.lines);
    }
}

impl Progress {
    /// The next slice ends the pass or begins one: its walk ends the pass, having paused before the document's last block (a
    /// walk in slices does: the walk's `boundary`), or the pass's end is being dressed ([`Ending`]), or it begins a pass from
    /// the start (a pass with no mark has not begun: [`end_pass`]). An edit takes such work back to the pass's last mark, so
    /// done between keys it is done again after each.
    pub(crate) fn ends_next(&self) -> bool {
        let Some(m) = self.paused.marks.last() else { return true };
        self.passes.inp.ids.block(m.id).is_none_or(|b| b + 1 >= self.doc.body.len())
    }

    /// The pass's end is being dressed ([`Ending`]).
    pub(crate) fn dressing(&self) -> bool {
        self.ending.is_some()
    }

    /// The lines of the pages laid out since an edit ([`Overlay`]), when the layout's own index is the one before it.
    pub(crate) fn overlay(&self) -> Option<&Overlay> {
        self.overlay.as_ref()
    }
}

impl std::fmt::Debug for Progress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Progress {{ {} pages laid out }}", self.paused.pages.len())
    }
}

/// Lays `doc` out from the start until more than `ahead` pages are done, pausing at the next mark; the rest is left to
/// [`crate::advance`]. A document that ends sooner is laid out whole, and so is any view but print.
pub(crate) fn start(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, ahead: usize) -> DocLayout {
    start_with(doc, cache, opts, ahead, (Passes::new(doc, opts), false))
}

/// [`start`] with `passes` set up, `relaid` as [`Progress::relaid`] says.
fn start_with(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, ahead: usize, (mut passes, relaid): (Passes, bool)) -> DocLayout {
    let t0 = now_ms();
    let ahead = ahead.max(1);
    // An earlier pass's pages, shown while a pass done again is under way.
    let mut earlier: Option<Vec<Page>> = None;
    loop {
        let stop = Stop { pages: ahead, until: 0.0 };
        match walk_pass(doc, cache, opts, &passes.inp, Begin::Start, Some(stop)) {
            Some(Walked::Paused(paused, _)) => {
                let own = earlier.is_none();
                let edits = passes.inp.ids.edits();
                let dictionary = ew_proof::dictionary_generation();
                let prog =
                    Progress { doc: doc.clone(), opts: opts.clone(), dictionary, passes, paused, own, ahead, edits, relaid, redo: None, lent: 0, ending: None, overlay: None };
                let mut shown = earlier.unwrap_or_default();
                if own {
                    show(doc, cache, opts, &prog, &mut shown);
                }
                let index = index_lines(&shown);
                return unsettled(shown, index, prog, t0);
            }
            Some(w) => match passes.next(doc, w) {
                Next::Done(l) => {
                    // Passes that kept their page totals leave the blocks showing them for later, as an edit's do.
                    let stale = l.resume.as_ref().filter(|r| relaid && r.uses_totals && r.found != r.totals).map(|r| r.found.clone());
                    let mut l = super::leave(l, super::Later::of(None, stale));
                    l.ms = now_ms() - t0;
                    return l;
                }
                Next::Again { pages, dressed, .. } => earlier = Some(dressed_pages(doc, cache, opts, &passes.inp, pages, dressed)),
            },
            // A pass from the start always ends or pauses.
            None => return crate::whole(doc, cache, opts),
        }
    }
}

/// engine-repaginate: the layout after an edit to a settled layout whose walk passed the view's pages without coming back to
/// the old pagination ([`super::relayout`]). `paused` is that walk's pass, its pages before the edit the settled layout's;
/// `shown` holds those (`paused` holds stand-ins for them: [`Progress::lent`]), and the pages laid out since join them
/// dressed. `index` is the settled layout's ([`Overlay`]). The rest follows in slices from [`crate::advance`], as after an
/// open.
pub(crate) fn after_edit(
    doc: &Document,
    cache: &mut LayoutCache,
    opts: &LayoutOptions,
    (passes, paused, ahead): (Passes, Paused, usize),
    (mut shown, index): (Vec<Page>, LineIndex),
    redo: Arc<Redo>,
) -> DocLayout {
    let t0 = now_ms();
    let edits = passes.inp.ids.edits();
    let dictionary = ew_proof::dictionary_generation();
    let lent = shown.len();
    let overlay = Some(Overlay { from: lent, lines: LineIndex::default() });
    let mut prog =
        Progress { doc: doc.clone(), opts: opts.clone(), dictionary, passes, paused, own: true, ahead, edits, relaid: true, redo: Some(redo), lent, ending: None, overlay };
    show(doc, cache, opts, &prog, &mut shown);
    if let Some(o) = &mut prog.overlay {
        index_pages(&mut o.lines, &shown[lent..], lent);
    }
    unsettled(shown, index, prog, t0)
}

/// Goes on with the layout `prev` is still making: first an edit to `doc` since (from the paused pass's last mark before it,
/// or from the start when that cannot be), then, with `slice`, the rest for about that many milliseconds. The pages that
/// draw differently: those laid out again or added, and those past the end that went.
pub(crate) fn go_on(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, mut prev: DocLayout, slice: Option<f64>) -> (DocLayout, Range<usize>) {
    let t0 = now_ms();
    let Some(prog) = prev.progress.take() else {
        // What an edit left for later goes on a walk at a time, at least one (engine-repaginate-2); after an edit since, that
        // edit is laid out as one is ([`super::relayout`] does what is left for later first).
        let Some(ms) = slice.filter(|_| prev.later.is_some()) else { return (prev, 0..0) };
        if !super::laid_out_from(&prev, doc) {
            return super::relayout(doc, cache, opts, prev);
        }
        let (mut l, mut changed) = (prev, 0..0);
        while l.later.is_some() {
            let n = l.pages.len();
            let Some((next, c)) = super::later_step(doc, cache, opts, l) else {
                let l = crate::layout(doc, cache, opts);
                let n = n.max(l.pages.len());
                return (l, 0..n);
            };
            (l, changed) = (next, union(changed, c));
            if now_ms() - t0 >= ms {
                break;
            }
        }
        return (l, changed);
    };
    // The session goes on only with a layout held nowhere else; a copy of one (`DocLayout` is Clone) would share the pass
    // under way, and begins again rather than copy it.
    let mut prog = match Arc::try_unwrap(prog) {
        Ok(prog) => prog,
        Err(prog) => {
            let l = start(doc, cache, opts, prog.ahead);
            let n = prev.pages.len().max(l.pages.len());
            return (l, 0..n);
        }
    };
    let mut shown = std::mem::take(&mut prev.pages);
    let mut index = std::mem::take(&mut prev.index);
    let mut changed = 0..0;
    match edit(doc, cache, opts, &mut prog, &mut shown, &mut index) {
        Edited::Same => {}
        Edited::Pages(r) => changed = r,
        Edited::Ended(walked, gone) => return end_pass(doc, cache, opts, prog, (shown, index), walked, (gone, slice, t0)),
        Edited::Restart(passes) => {
            let n = shown.len();
            let l = start_with(doc, cache, opts, prog.ahead, (passes, true));
            let n = n.max(l.pages.len());
            return (l, 0..n);
        }
        Edited::Again => {
            let n = shown.len();
            let l = start(doc, cache, opts, prog.ahead);
            let n = n.max(l.pages.len());
            return (l, 0..n);
        }
    }
    let Some(ms) = slice else { return (unsettled(shown, index, prog, t0), changed) };
    let until = t0 + ms;
    // A pass's end under way goes on dressing its pages, the pages lent to it among them.
    let walked = if let Some(mut e) = prog.ending.take() {
        swap_lent(prog.lent, &mut e.pages, &mut shown);
        Some(Walked::Ending(e))
    } else {
        swap_lent(prog.lent, &mut prog.paused.pages, &mut shown);
        let paused = std::mem::take(&mut prog.paused);
        // A pass that stopped at a mark goes on from it; one with none has not begun (end_pass). One going on from an edit's
        // walk takes the layout before the edit over where it comes back to it.
        let redo = prog.redo.clone();
        let begin = match &redo {
            _ if paused.marks.is_empty() => Begin::Start,
            Some(r) => Begin::Redo(paused, r),
            None => Begin::Paused(paused),
        };
        walk_pass(doc, cache, opts, &prog.passes.inp, begin, Some(Stop { pages: 0, until }))
    };
    end_pass(doc, cache, opts, prog, (shown, index), walked, (changed, slice, t0))
}

/// engine-repaginate-2: the passes to begin again with after `edit`, made while a pass done again was under way: the page
/// totals and the floats placed above their anchors found so far (those before the edited page, from the pages shown, the
/// last pass's), and the totals kept as an edit's passes keep them, the blocks showing them laid out again at the end
/// ([`Progress::relaid`]). Begun again from nothing, the passes found those again and were done again, and an edit during
/// any pass done again began them again: on page 900 of the Word fixture, after Delete took a section break out, each of
/// 8 keys laid out from the start (15745 paragraph layouts, 118 ms).
fn restart(doc: &Document, opts: &LayoutOptions, prog: &Progress, shown: &[Page], edit: &Edit) -> Passes {
    let ids = &prog.passes.inp.ids;
    // The page the edit begins on (the pages shown name the new body's blocks).
    let at = shown.iter().rposition(|p| ids.block(p.first_block).is_some_and(|b| b <= edit.start)).unwrap_or(0);
    let mut passes = Passes::new(doc, opts);
    let inp = &prog.passes.inp;
    passes.inp.totals = inp.totals.clone();
    passes.inp.note_pages = inp.note_pages.clone();
    passes.inp.early =
        inp.early.iter().filter(|(page, _)| **page < at).map(|(page, v)| (*page, v.iter().map(|(b, oi, a)| (edit.moved(*b), *oi, a.clone())).collect())).collect();
    passes.inp.stale_from = at;
    passes.totals_passes = MAX_TOTAL_PASSES;
    passes.inp.may_repeat = false;
    passes
}

/// Swaps the first `lent` pages of `a` and `b`: the pages before an edit go from the pages shown to the paused pass for a
/// walk, and back after it ([`Progress::lent`]), at the cost of moving them rather than copying them.
fn swap_lent(lent: usize, a: &mut [Page], b: &mut [Page]) {
    a[..lent].swap_with_slice(&mut b[..lent]);
}

/// What an edit since the layout paused did to it: nothing, the pages it laid out again, or it ended the pass (the pages shown
/// from the edited one on went), or the layout has to begin again.
enum Edited {
    Same,
    Pages(Range<usize>),
    Ended(Option<Walked>, Range<usize>),
    Again,
    /// Begin again from the start with these passes ([`restart`]).
    Restart(Passes),
}

/// Takes in the edit made to `doc` since `prog` was laid out, as [`super::relayout`] does: when the options, the parts outside
/// the body that layout reads and the notes' numbers stay as they were, the paused pass is laid out again from its last mark
/// before what the edit can reach, as far as the view's pages, and its pages after are taken over where the pagination comes
/// back to a state it had. The pages shown are dressed again where they changed.
fn edit(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, prog: &mut Progress, shown: &mut Vec<Page>, index: &mut LineIndex) -> Edited {
    let ids = prog.passes.inp.ids.clone();
    if !same_opts(&prog.opts, opts) || prog.dictionary != ew_proof::dictionary_generation() || prog.edits != ids.edits() {
        return Edited::Again;
    }
    let Some(parts) = changed_parts(&prog.doc, doc) else { return Edited::Again };
    if !parts.is_empty() {
        prog.passes.inp.pagerefs = headers_footers_refer_to_pages(doc);
    }
    let Some(mut edit) = Edit::of((&prog.doc, &prog.opts), doc, opts, &parts) else { return Edited::Again };
    // An edit while the pass ends goes on from where the walk that reached the end began.
    if !edit.is_empty()
        && let Some(e) = prog.ending.take()
    {
        prog.paused = e.into_paused();
    }
    // A section break that went or came (engine-keys-final): the walk goes on from the top of the section the edit is in, with
    // the notes numbered again as [`super::relayout`] checks them.
    if edit.section.is_some() {
        let notes = note_numbers(doc, opts, &prog.passes.inp.note_pages);
        if notes.1 != prog.paused.notes.1 {
            return Edited::Again;
        }
        prog.paused.notes = notes;
    }
    // The pages shown and the paused pass name the new body's blocks from here.
    edit.rename(&ids, &doc.body);
    prog.edits = ids.edits();
    let mut out = Edited::Same;
    if !edit.is_empty() {
        // The layout before the first edit no longer is this document's: a second edit's walk compares with the pass itself.
        // ponytail: after a second edit the rest is laid out whole; comparing with the layout before both edits would need
        // both edits' names for the blocks.
        prog.redo = None;
        // ponytail: an edit while a pass done again is under way (the body shows page totals, or floats sit above their
        // anchors) lays out from the start ([`restart`]); going on from the paused pass needs that pass's pages shown
        // instead of the last.
        if !prog.own {
            return Edited::Restart(restart(doc, opts, prog, shown, &edit));
        }
        let Some(k) = resume_mark(&prog.paused.marks, &ids, (&prog.doc, doc), &edit) else { return Edited::Again };
        // From the paused pass's last mark the edit cannot reach the pages laid out.
        if k + 1 < prog.paused.marks.len() {
            let from = prog.paused.marks[k].pages.saturating_sub(1);
            // The pages on screen, and at least the edited page and the next, where the pagination usually comes back to the
            // paused pass's.
            let stop = super::edit_stop(cache, prog.ahead, from);
            // engine-layout-key: a layout still showing the lines of the index before an earlier edit keeps them: the pages from
            // the edited one on, the earlier edit's pages among them, come to the overlay's lines (an edit above the earlier
            // one lowers where the overlay begins).
            let mut overlay = prog.overlay.take();
            if let Some(o) = overlay.as_mut().filter(|o| from < o.from) {
                index_pages(&mut o.lines, &shown[from..o.from.min(shown.len())], from);
                o.from = from;
            }
            // The wrap areas found from the edited page on were found for the pagination before the edit, which it may move
            // by a page: they go, the pass is done again from there at its end with those it finds now, and the passes done
            // again for them count from none, as a whole layout of the edited document counts them. Kept, the areas pushed
            // the text of pages they no longer belonged to, and the count, carried on, settled the floats a pass or two
            // before a whole layout does (page 380 of the Word fixture after Enter and Backspace on page 300).
            if prog.passes.inp.may_rewrap || prog.passes.rewraps > 0 {
                prog.passes.inp.early.retain(|page, _| *page < from);
                prog.passes.inp.stale_from = prog.passes.inp.stale_from.min(from);
                prog.passes.rewraps = 0;
                prog.passes.inp.may_rewrap = 0 < MAX_REWRAP_PASSES;
            }
            // The walk lays the pages before its mark's out again only when that is before the pages lent: those pages it
            // lays out again are copied back first.
            if from < prog.lent {
                for i in from..prog.lent {
                    prog.paused.pages[i] = shown[i].clone();
                }
                prog.lent = from;
            }
            swap_lent(prog.lent, &mut prog.paused.pages, shown);
            let paused = std::mem::take(&mut prog.paused);
            match walk_pass(doc, cache, opts, &prog.passes.inp, Begin::Edit(paused, k, &edit), Some(stop)) {
                Some(Walked::Paused(p, to)) => {
                    prog.paused = p;
                    swap_lent(prog.lent, &mut prog.paused.pages, shown);
                    let at = overlay.as_ref().map_or(0, |o| o.from);
                    out = Edited::Pages(reshow(doc, cache, opts, prog, (shown, overlay.as_mut().map_or(&mut *index, |o| &mut o.lines), at), (from, to)));
                    prog.overlay = overlay;
                }
                None => return Edited::Again,
                walked => {
                    // Laid out to the end: the pass's end shows its pages from the edited one on, and the index is whole.
                    own_index(index, overlay);
                    let old = shown.len();
                    let gone = shown.split_off(from.min(old));
                    unindex_pages(index, &gone, from.min(old));
                    out = Edited::Ended(walked, from.min(old)..old);
                }
            }
        }
    }
    // The document as laid out from now on: its other fields are the same as the new one's.
    prog.doc.body = doc.body.clone();
    for id in parts {
        if let Some(part) = doc.parts.get(&id) {
            prog.doc.parts.insert(id, part.clone());
        }
    }
    prog.opts = opts.clone();
    out
}

/// The pages shown after an edit's walk laid the paused pages `from..to` out again: those are dressed again, and the shown
/// pages after them (the paused pass's, taken over where the walk came back to its pagination, so as many) stay as they are.
/// A walk that paused short of them leaves none. The pages that draw differently.
fn reshow(
    doc: &Document,
    cache: &mut LayoutCache,
    opts: &LayoutOptions,
    prog: &Progress,
    (shown, index, at): (&mut Vec<Page>, &mut LineIndex, usize),
    (from, to): (usize, usize),
) -> Range<usize> {
    let old = shown.len();
    let first = from.min(old);
    let end = to.min(finished(&prog.paused)).max(first);
    let kept = if to <= old { shown.split_off(to) } else { Vec::new() };
    let replaced = shown.split_off(first);
    unindex_pages(index, &replaced, first);
    shown.extend(prog.paused.pages[first..end].iter().cloned());
    dress(doc, cache, opts, (&prog.passes.inp, Some(&prog.paused.notes)), (shown, first..end, true), (None, None), &|_| true);
    // The pages after keep their items and their lines' entries: they name their blocks by id.
    if shown.len() == to {
        shown.extend(kept);
    }
    if shown.len() == old {
        index_pages(index, &shown[first..end], first);
    } else {
        // The lines of the pages from `at` on: all of them, or the overlay's ([`Overlay`]).
        *index = LineIndex::default();
        index_pages(index, &shown[at.min(shown.len())..], at.min(shown.len()));
    }
    let last = if shown.len() == old { end } else { old.max(shown.len()) };
    first..last
}

/// After a walk of the pass under way: paused, the pages it finished are shown; ended, the next pass begins (and goes on
/// while `slice` lasts) or the layout is done. `changed` holds the pages an edit laid out again before.
fn end_pass(
    doc: &Document,
    cache: &mut LayoutCache,
    opts: &LayoutOptions,
    mut prog: Progress,
    (mut shown, mut index): (Vec<Page>, LineIndex),
    mut walked: Option<Walked>,
    (mut changed, slice, t0): (Range<usize>, Option<f64>, f64),
) -> (DocLayout, Range<usize>) {
    loop {
        match walked {
            Some(Walked::Caught(c)) => match caught(doc, cache, opts, &mut prog, index, c) {
                Some((from, l, c)) => {
                    let n = l.pages.len().max(shown.len());
                    let mut l = l;
                    l.ms = now_ms() - t0;
                    return (l, union(changed, union(c, from..n)));
                }
                None => {
                    let n = shown.len();
                    let l = crate::layout(doc, cache, opts);
                    let n = n.max(l.pages.len());
                    return (l, 0..n);
                }
            },
            Some(Walked::Paused(p, _)) => {
                prog.paused = p;
                swap_lent(prog.lent, &mut prog.paused.pages, &mut shown);
                if prog.own {
                    let n = shown.len();
                    show(doc, cache, opts, &prog, &mut shown);
                    index_pages(prog.overlay.as_mut().map_or(&mut index, |o| &mut o.lines), &shown[n..], n);
                    changed = union(changed, n..shown.len());
                }
                return (unsettled(shown, index, prog, t0), changed);
            }
            Some(Walked::Ending(mut e)) => {
                // The pages lent to the pass are among the ending's here, and go back to those shown while it goes on.
                if !dress_ending(doc, cache, opts, &prog.passes.inp, &mut e, t0 + slice.unwrap_or_default()) {
                    swap_lent(prog.lent, &mut e.pages, &mut shown);
                    prog.ending = Some(e);
                    return (unsettled(shown, index, prog, t0), changed);
                }
                walked = Some(Walked::Done(finish_ending(doc, cache, opts, &prog.passes.inp, *e)));
            }
            None => {
                // A walk from where the pass paused always ends or pauses: begin again if it did not.
                let n = shown.len();
                let l = start(doc, cache, opts, prog.ahead);
                let n = n.max(l.pages.len());
                return (l, 0..n);
            }
            Some(w) => match prog.passes.next(doc, w) {
                Next::Done(l) => {
                    // The pages lent to the pass are its own now: those shown before them are stand-ins, drawn again as
                    // the pass's end may have dressed them differently.
                    let lent = prog.lent.min(shown.len()).min(l.pages.len());
                    let rest = differing(&shown[lent..], &l.pages[lent..]);
                    let differ = if lent == 0 { rest } else { union(0..lent, rest.start + lent..rest.end + lent) };
                    // A pass made after an edit kept the page totals it began with: the blocks that show them are laid out
                    // again with those found.
                    let stale = l.resume.as_ref().filter(|r| prog.relaid && r.uses_totals && r.found != r.totals).map(|r| r.found.clone());
                    let (mut l, totals) = match stale {
                        None => (l, 0..0),
                        // In slices, a walk at a time in the next ones (engine-repaginate-2).
                        Some(found) if slice.is_some() => (super::leave(l, super::Later::of(None, Some(found))), 0..0),
                        Some(found) => match super::redo_totals(doc, cache, opts, (l, 0..0), Some(found)) {
                            Some(done) => done,
                            None => {
                                let l = crate::whole(doc, cache, opts);
                                let n = l.pages.len().max(shown.len());
                                (l, 0..n)
                            }
                        },
                    };
                    l.ms = now_ms() - t0;
                    return (l, union(changed, union(differ, totals)));
                }
                Next::Again { mut pages, dressed, again } => {
                    prog.redo = None;
                    own_index(&mut index, prog.overlay.take());
                    // The pages lent to the pass go back to those shown: no pass lends any after this one.
                    swap_lent(std::mem::take(&mut prog.lent), &mut pages, &mut shown);
                    // The first pass's pages shown so far stay, and the last ones, which its end finished, join them. The
                    // passes done again are not shown: the first's pages stay until the last ends, so no pass's pages are
                    // dressed twice (dressing all of them held a slice 60 to 70 ms). A pass done again from a mark
                    // (`again`) is shown as it goes: the pages before the mark's are the same, and those after it go.
                    let mut again = again.filter(|_| prog.own);
                    // engine-repaginate-2: in slices, a pass done again from a mark more than SLICE_PAGES before the view's
                    // pages goes on as one from the start does, the last pass's pages shown until it ends, rather than laying
                    // out as far as the view's pages in this slice: after Delete took a section break out on page 900 of the
                    // Word fixture, that slice looked 8720 paragraph layouts up (58 ms). Nearer, it lays them out here: an
                    // edit during a pass done again begins the layout again ([`restart`]), which costs every page to the
                    // view's, so the pass done again stays one an edit can go on from (engine-keys' table cell on page 301:
                    // with every such pass done again, a few keys took 48 ms).
                    let behind_view = slice.is_some() && again.as_ref().is_some_and(|p| rewrap_page(p) + SLICE_PAGES < prog.ahead.min(shown.len()));
                    if prog.own {
                        let n = shown.len().min(pages.len());
                        let to = again.as_ref().filter(|_| !behind_view).map_or(pages.len(), rewrap_page);
                        if to < n {
                            let gone = shown.split_off(to);
                            unindex_pages(&mut index, &gone, to);
                            changed = union(changed, to..n);
                        } else {
                            shown.extend(pages.drain(n..to));
                            if !dressed {
                                dress(doc, cache, opts, (&prog.passes.inp, None), (&mut shown, n..to, false), (None, None), &|_| true);
                            }
                            index_pages(&mut index, &shown[n..], n);
                            changed = union(changed, n..to);
                        }
                    }
                    let until = slice.map_or(0.0, |ms| t0 + ms);
                    if let Some(p) = again.take_if(|_| behind_view) {
                        prog.own = false;
                        prog.paused = p;
                        return (unsettled(shown, index, prog, t0), changed);
                    }
                    if let Some(p) = again {
                        // As far as the view's pages at least, as when the layout began.
                        walked = walk_pass(doc, cache, opts, &prog.passes.inp, Begin::Paused(p), Some(Stop { pages: prog.ahead, until }));
                        continue;
                    }
                    prog.own = false;
                    // In slices, the next pass begins in the next one ([`go_on`]: a paused pass with no marks has not begun),
                    // since this one ended a pass (engine-main-thread-2). Else it begins here: its first page at least, so
                    // that it has a mark to go on from.
                    if slice.is_some() {
                        prog.paused = Paused::default();
                        return (unsettled(shown, index, prog, t0), changed);
                    }
                    walked = walk_pass(doc, cache, opts, &prog.passes.inp, Begin::Start, Some(Stop { pages: 0, until }));
                }
            },
        }
    }
}

/// engine-repaginate-2: the pass made from an edit's walk came back to the layout before the edit (`c`): its old pages are
/// taken over from there, moved as the pass found them moved, and the layout is settled as an edit's walk that came back
/// to them at once would have settled it ([`finish_redo`]), with the blocks the move shows wrongly and the page totals laid
/// out again after. The settled layout and the pages that draw differently from the layout before the edit; `None` when
/// it has to be laid out whole.
fn caught(
    doc: &Document,
    cache: &mut LayoutCache,
    opts: &LayoutOptions,
    prog: &mut Progress,
    index: LineIndex,
    c: Caught,
) -> Option<(usize, DocLayout, Range<usize>)> {
    let mut redo = Arc::unwrap_or_clone(prog.redo.take()?);
    let from = redo.from();
    // The layout's index is the one before the edit still ([`Overlay`]): the lines of the pages laid out since go with them.
    prog.overlay.take()?;
    let (head, new_marks) = redo.split_marks(c.marks);
    let (_, inside, shift) = c.splice;
    let tail = std::mem::take(&mut redo.tail);
    let laid = take_old_pages((c.pages, c.behind), tail, (from, inside), &redo.rec.behind, shift)?;
    let inp = &prog.passes.inp;
    let mut ctx = new_ctx(doc, cache, opts, (&inp.note_pages, &inp.totals), (Some(redo.rec.notes.clone()), inp.ids.clone()));
    ctx.mirror = doc.settings.mirror_margins;
    ctx.floats_above = redo.relaid_floats(c.floats);
    ctx.uses_totals = c.uses_totals;
    let redo = Redo { index, ..redo };
    let (l, changed, stale, taken) = finish_redo(doc, opts, &mut ctx, redo, laid, (head, new_marks, Some(c.splice)))?;
    // The rest goes on in the next slices, a walk at a time.
    Some((from, super::leave(l, super::Later::of(taken, stale)), changed))
}

/// engine-repaginate-2: the most pages a slice lays out to bring a pass done again from a mark up to the view's pages (about
/// 3.5 ms of the Word fixture's, 0.07 ms a page); further, the pass goes on a slice at a time ([`end_pass`]).
const SLICE_PAGES: usize = 50;

/// The pages of a paused pass that are finished: all but the one it was filling.
fn finished(p: &Paused) -> usize {
    p.pages.len().saturating_sub(1)
}

/// Shows the paused pass's pages finished since those in `shown`, dressed.
fn show(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, prog: &Progress, shown: &mut Vec<Page>) {
    let (from, to) = (shown.len(), finished(&prog.paused));
    if from >= to {
        return;
    }
    shown.extend(prog.paused.pages[from..to].iter().cloned());
    dress(doc, cache, opts, (&prog.passes.inp, Some(&prog.paused.notes)), (shown, from..to, true), (None, None), &|_| true);
}

/// A finished pass's pages for showing while the next pass is under way, dressed unless they are.
fn dressed_pages(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, inp: &PassInputs, mut pages: Vec<Page>, dressed: bool) -> Vec<Page> {
    if !dressed {
        let n = pages.len();
        dress(doc, cache, opts, (inp, None), (&mut pages, 0..n, false), (None, None), &|_| true);
    }
    pages
}

/// Finishes `pages[range]` for showing as the end of a pass finishes its pages: turned for vertical sections (with `turn`),
/// with their headers and footers, and with mirrored margins. The headers show the page totals the pass assumes and the
/// pages' count so far; a pass's end ([`Ending`]) gives those it found instead (`totals`), and the list counters and
/// equation numbers it carries from slice to slice (`counters`), and dresses only the pages `only` takes. The text boxes
/// laid out.
// ponytail: other than at a pass's end, headers show the list counters a pass starts with rather than the body's at its end;
// only shown pages, which the finished pass dresses again, are wrong, and only for a header holding a list item.
fn dress(
    doc: &Document,
    cache: &mut LayoutCache,
    opts: &LayoutOptions,
    (inp, notes): (&PassInputs, Option<&Notes>),
    (pages, range, turn): (&mut [Page], Range<usize>, bool),
    (totals, mut counters): (Option<&Totals>, Option<&mut (Counters, u32)>),
    only: &dyn Fn(usize) -> bool,
) -> usize {
    let mut ctx = new_ctx(doc, cache, opts, (&inp.note_pages, &inp.totals), (notes.cloned(), inp.ids.clone()));
    let hf = Arc::clone(&ctx.hf);
    let sections = &hf.sections;
    // Only the print view pauses, so the pages are not reflowed.
    let mode = Mode::of(opts.view);
    ctx.mirror = doc.settings.mirror_margins && !mode.reflow;
    if turn && !mode.web {
        turn_pages(&mut pages[range.clone()], sections);
    }
    if mode.reflow {
        return 0;
    }
    ctx.track_totals = false;
    if inp.pagerefs {
        let marks = bookmark_pages(doc, pages, sections);
        ctx.fields.bookmarks_key = marks_key(&marks);
        ctx.fields.bookmark_pages = Arc::new(marks);
    }
    if let Some(c) = counters.as_deref_mut() {
        (ctx.counters, ctx.eq_count) = std::mem::take(c);
    }
    headers_footers_where(&mut ctx, pages, range.clone(), sections, totals.unwrap_or(&inp.totals), only);
    if let Some(c) = counters {
        *c = (std::mem::take(&mut ctx.counters), ctx.eq_count);
    }
    if doc.settings.mirror_margins {
        let prev = range.start.checked_sub(1).and_then(|i| pages.get(i)).map(|p| p.section);
        mirror_even_pages_after(&mut pages[range], sections, prev);
    }
    ctx.boxes.total()
}

type Notes = (Arc<std::collections::HashMap<u32, crate::fields::NoteNum>>, u64);

/// Dresses [`Ending`] `e`'s pages from where it stopped until the clock reads `until` (one page at least) and indexes their
/// lines, as the walk's own end does all at once. True once every page is.
fn dress_ending(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, inp: &PassInputs, e: &mut Ending, until: f64) -> bool {
    keep_env(cache, e.env);
    let (from, n) = (e.dressed, e.pages.len());
    let to = std::cell::Cell::new(n);
    let more = |i: usize| {
        if i > from && i < to.get() && now_ms() >= until {
            to.set(i);
        }
        i < to.get()
    };
    e.boxes += dress(doc, cache, opts, (inp, Some(&e.notes)), (&mut e.pages, from..n, false), (Some(&e.found), Some(&mut e.counters)), &more);
    let to = to.get();
    index_pages(&mut e.index, &e.pages[from..to], from);
    e.dressed = to;
    to == n
}

/// The layout so far: the pages shown and the pass under way.
fn unsettled(pages: Vec<Page>, index: LineIndex, prog: Progress, t0: f64) -> DocLayout {
    let ids = prog.passes.inp.ids.clone();
    DocLayout { pages, index, ids, ms: now_ms() - t0, text_boxes: 0, resume: None, progress: Some(Arc::new(prog)), later: None }
}

/// The pages from the first to the last where `a` and `b` draw differently, those only one has included.
fn differing(a: &[Page], b: &[Page]) -> Range<usize> {
    let n = a.len().max(b.len());
    let same = |i: usize| matches!((a.get(i), b.get(i)), (Some(x), Some(y)) if same_page(x, y));
    let Some(first) = (0..n).find(|&i| !same(i)) else { return 0..0 };
    let last = (first..n).rev().find(|&i| !same(i)).unwrap_or(first);
    first..last + 1
}
