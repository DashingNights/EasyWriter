//! EasyWriter engine-style-separator: paragraphs joined by style separators. A paragraph whose mark is a style separator
//! (hidden and `w:specVanish`, [`ew_doc::Paragraph::is_style_separator`]), or hidden while hidden text does not show
//! ([`opens`]), leaves its last line open, and the next paragraph's first
//! line runs on in it: a run-in heading keeps its own style, list number and contents level, and the text after it its own.
//!
//! Word lays the joined paragraphs out as one (probes sep-15, sep-pages-15 and sep-more-15, made by
//! .smoke-data/word/fixture/walk/sep_probes_docx.py, in Word 2013's layout): the first paragraph's indents, alignment,
//! justification, tab stops, list number, space before, widow control, keep with next and keep lines together hold for
//! all of them; each line takes the line spacing of the paragraph whose text ends it, and the space after is the last
//! paragraph's. The separator's own space after, the next paragraph's space before, list number (still counted) and
//! the rest of its paragraph properties are left out. A next paragraph with Page Break Before starts its page instead.
//!
//! Each paragraph is still laid out on its own ([`crate::para::layout_para`] with [`RunIn`] and `runs_on` in its
//! environment): the separator's last line is laid out flush left and not placed with its paragraph but waits ([`Seg`]),
//! and the paragraph after it starts its first line where that line ends, places the waiting lines beside its own
//! ([`place_row`]) and aligns the whole line.

use std::sync::Arc;

use ew_doc::resolve::ResolvedPara;
use ew_doc::props::CharProps;
use ew_doc::{Block, Document, Paragraph, StoryRef};

use crate::para::{ClKind, ParaLayout};
use crate::placed::Placed;

/// Where a paragraph that runs on after a style separator starts: the line the paragraphs before it left open.
#[derive(Clone, Debug, PartialEq)]
pub struct RunIn {
    /// Where its first line starts, from the column's left edge: after the text before it on the line.
    pub x: f32,
    /// That text's ascent and descent, which the line holds as well as its own.
    pub asc: f32,
    pub desc: f32,
    /// That text's spaces, which a justified line stretches with its own.
    pub spaces: usize,
    /// The first paragraph's properties, which the paragraphs after it take ([`merged`]).
    pub head: Arc<ResolvedPara>,
}

impl RunIn {
    /// For the cache key: what the layout depends on.
    pub(crate) fn key(&self) -> u64 {
        crate::cache::hash_of(&format!("{:?}|{:?}|{:?}|{}|{:?}", self.x.to_bits(), self.asc.to_bits(), self.desc.to_bits(), self.spaces, self.head))
    }
}

/// What decides whether a paragraph takes no room ([`crate::para::gone`]): hidden text shown, the tracked changes the
/// layout leaves out, and the character formatting of the table cell the paragraphs are in.
#[derive(Clone, Copy)]
pub(crate) struct Shown<'a> {
    pub(crate) hidden: bool,
    pub(crate) deleted: &'a crate::HideDeleted,
    pub(crate) table: Option<&'a CharProps>,
}

/// Whether block `b` is a paragraph a run passes over: one that takes no room, is no separator and ends no section. Word
/// joins through its mark (hidden, or a deletion the final text leaves out) to the next paragraph that shows.
fn passed(doc: &Document, b: &Block, v: Shown) -> bool {
    matches!(b, Block::Para(p) if p.section.is_none() && !p.mark_hidden(&doc.styles, v.table).1 && crate::para::gone(p, doc, v.table, v.hidden, v.deleted))
}

/// Whether paragraph `p` leaves its last line open for the next one: its mark is a style separator, or hidden while hidden
/// text does not show and its text shows. Word's probe sep-vanish-15 (in Word 2013's layout, hidden text not shown) joins on
/// a mark with `w:vanish` alone (M6) as on a separator, and on one whose `w:vanish` and `w:specVanish` come from its
/// character style (M2, M3); never on `w:specVanish` without `w:vanish` (M1, M5). Where hidden text shows, a separator's mark
/// stays hidden (ECMA-376 §17.3.2.36) and a plain hidden one ends its paragraph.
fn opens(doc: &Document, p: &Paragraph, v: Shown) -> bool {
    match p.mark_hidden(&doc.styles, v.table) {
        (_, true) => true,
        (hidden, _) => hidden && !v.hidden && !crate::para::gone(p, doc, v.table, v.hidden, v.deleted),
    }
}

/// The paragraph that runs on after paragraph `i` of `blocks`, if `i` leaves its line open ([`opens`]), ends no section and is
/// not a frame: the next block a run does not pass over ([`passed`]), if it is a paragraph that is not a frame and has no page
/// break before it. An empty one joins too, taking no room (sep-15 case M), so the caret has a place in it.
pub(crate) fn joined(doc: &Document, blocks: &[Arc<Block>], i: usize, v: Shown) -> Option<usize> {
    let framed = |p: &Paragraph| doc.styles.resolve_para(&p.props).frame.is_some();
    let Some(Block::Para(p)) = blocks.get(i).map(|b| &**b) else { return None };
    if p.section.is_some() || !opens(doc, p, v) || framed(p) {
        return None;
    }
    let j = (i + 1..blocks.len()).find(|&j| !passed(doc, &blocks[j], v))?;
    let Block::Para(next) = &*blocks[j] else { return None };
    (!framed(next) && !doc.styles.resolve_para(&next.props).page_break_before).then_some(j)
}

/// The paragraph that paragraph `j` of `blocks` runs on after, if any: the block before it a run does not pass over, when
/// it joins `j`.
pub(crate) fn joined_from(doc: &Document, blocks: &[Arc<Block>], j: usize, v: Shown) -> Option<usize> {
    let k = (0..j).rev().find(|&k| !passed(doc, &blocks[k], v))?;
    (joined(doc, blocks, k, v) == Some(j)).then_some(k)
}

/// The properties a paragraph running on after a separator is laid out with: `head`'s (the first paragraph's), with its own
/// line spacing, space after, style and list, and no space before, drop cap or page break before.
pub(crate) fn merged(own: ResolvedPara, head: &ResolvedPara) -> ResolvedPara {
    ResolvedPara {
        style: own.style,
        space_before: 0.0,
        before_auto: false,
        space_after: own.space_after,
        after_auto: own.after_auto,
        contextual_spacing: own.contextual_spacing,
        line_spacing: own.line_spacing,
        outline_level: own.outline_level,
        numbering: own.numbering,
        page_break_before: false,
        drop_cap: 0,
        drop_cap_margin: false,
        drop_cap_distance: 0.0,
        drop_cap_font: None,
        frame: None,
        ..head.clone()
    }
}

/// A paragraph that ends in a separator: no space after it, and the paragraph after it keeps the run with the next.
pub(crate) fn run_on(rp: &mut ResolvedPara) {
    rp.space_after = 0.0;
    rp.after_auto = false;
    rp.keep_next = false;
}

/// What the paragraph being laid out is to a run joined by separators: whether it runs on after one ([`RunIn`]) and whether
/// it ends in one. `rev` is the paragraph's ([`ew_doc::Paragraph::rev`]), so the paragraphs laid out while it is (in its text
/// boxes, its notes) are not taken for it.
#[derive(Clone, Debug, Default)]
pub(crate) struct Join {
    pub(crate) rev: u64,
    pub(crate) run_in: Option<RunIn>,
    pub(crate) runs_on: bool,
}

impl Join {
    /// `p`'s place in a run (`runs_on`: it ends in a separator), starting where the waiting lines `segs` end.
    pub(crate) fn of(p: &Paragraph, segs: &[Seg], runs_on: bool, mark_room: f32) -> Join {
        Join { rev: p.rev, run_in: start(segs, mark_room), runs_on }
    }
    pub(crate) fn applies(&self, p: &Paragraph) -> bool {
        self.rev == p.rev && (self.run_in.is_some() || self.runs_on)
    }
}

/// A paragraph's last line, waiting for the paragraph that runs on in it to place it.
#[derive(Clone, Debug)]
pub(crate) struct Seg {
    pub(crate) story: StoryRef,
    pub(crate) path: Vec<u32>,
    pub(crate) pl: Arc<ParaLayout>,
}

impl PartialEq for Seg {
    fn eq(&self, o: &Self) -> bool {
        self.story == o.story && self.path == o.path && Arc::ptr_eq(&self.pl, &o.pl)
    }
}

/// Room for the separator's mark where hidden text shows (with the formatting marks): Word draws it, dotted, before the
/// next paragraph's text.
pub(crate) fn mark_room(show_hidden: bool) -> f32 {
    if show_hidden { crate::para::PARA_MARK_WIDTH + 2.0 } else { 0.0 }
}

/// The start of the next paragraph after the waiting lines `segs` (all on one line, the last the paragraph just laid out).
fn start(segs: &[Seg], mark_room: f32) -> Option<RunIn> {
    let last = segs.last()?.pl.lines.last()?;
    let head = segs.first()?.pl.run_head.clone()?;
    let (mut asc, mut desc, mut spaces) = (0.0f32, 0.0f32, 0);
    for s in segs {
        let Some(l) = s.pl.lines.last() else { continue };
        asc = asc.max(l.text_asc);
        desc = desc.max(l.text_desc);
        spaces += spaces_of(&s.pl, l.c0, l.c1).len();
    }
    Some(RunIn { x: last.xs.last().copied().unwrap_or(last.left) + mark_room, asc, desc, spaces, head })
}

/// The spaces among clusters `c0..c1` of `pl`, as cluster indices.
fn spaces_of(pl: &ParaLayout, c0: usize, c1: usize) -> Vec<usize> {
    (c0..c1).filter(|&c| pl.clusters.get(c).is_some_and(|c| c.kind == ClKind::Space)).collect()
}

/// Place the waiting lines `segs` on the line `pl` starts, its first line's top at `y` in a column at `x`: each with the
/// line's height and baseline, moved as the line's alignment moved `pl`'s text (`ParaLayout::row_fix`), and ending where
/// the next one starts, so a click on the line finds the paragraph whose text it is on.
pub(crate) fn place_row(items: &mut Vec<Placed>, segs: Vec<Seg>, pl: &ParaLayout, (x, y): (f32, f32)) {
    let Some(row) = pl.lines.first() else { return };
    let (dx, per) = pl.row_fix;
    let mut lead = 0usize;
    let mut patched = Vec::with_capacity(segs.len());
    for s in segs {
        let mut sp = (*s.pl).clone();
        let k = sp.lines.len().saturating_sub(1);
        let label_line = sp.label_line();
        let spaces = sp.lines.get(k).map_or(Vec::new(), |l| spaces_of(&sp, l.c0, l.c1));
        let Some(l) = sp.lines.get_mut(k) else { continue };
        l.height = row.height;
        l.baseline = l.top + (row.baseline - row.top);
        let mut add = dx + per * lead as f32;
        if l.vis.is_empty() {
            let mut si = 0;
            for (q, v) in l.xs.iter_mut().enumerate() {
                *v += add;
                if spaces.get(si) == Some(&(l.c0 + q)) {
                    add += per;
                    si += 1;
                }
            }
        } else {
            // A bidirectional line is drawn and hit from `vis`, its clusters in visual order: the stretch adds up from left to
            // right there, each space widening, and `xs` follows (`para::bidi::reorder_line`).
            let mut order: Vec<usize> = (0..l.vis.len()).collect();
            order.sort_by(|&a, &b| l.vis[a].x.total_cmp(&l.vis[b].x));
            for i in order {
                let v = &mut l.vis[i];
                v.x += add;
                if spaces.binary_search(&(l.c0 + i)).is_ok() {
                    v.w += per;
                    add += per;
                }
            }
            let end = l.end_x();
            l.xs = l.vis.iter().map(|v| v.x).chain(std::iter::once(end)).collect();
        }
        lead += spaces.len();
        if k == label_line
            && let Some(lab) = sp.label.as_mut()
        {
            lab.x += dx;
        }
        patched.push((s.story, s.path, sp, k));
    }
    // Each waiting line reaches to where the next text on the line starts: its leftmost cluster, which on a bidirectional
    // line need not be the first (`xs` is in logical order there).
    let left_of = |l: &crate::para::Line| if l.vis.is_empty() { l.xs.first().copied() } else { l.vis.iter().map(|v| v.x).reduce(f32::min) };
    let first_x = left_of(row).unwrap_or(row.left);
    for i in 0..patched.len() {
        let right = match patched.get(i + 1) {
            Some((_, _, next, k)) => next.lines.get(*k).and_then(left_of).unwrap_or(first_x),
            None => first_x,
        };
        if let Some((_, _, sp, k)) = patched.get_mut(i)
            && let Some(l) = sp.lines.get_mut(*k)
        {
            l.right = right.max(l.left);
        }
    }
    for (story, path, sp, k) in patched {
        items.push(Placed::Lines {
            story,
            path: ew_doc::Path(path),
            para: Arc::new(sp),
            l0: k,
            l1: k + 1,
            x,
            y,
            turn: ew_doc::props::TextDirection::Horizontal,
        });
    }
}
