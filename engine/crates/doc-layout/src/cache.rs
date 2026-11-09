use ew_doc::section::PageVAlign;

use super::ctx::{Ctx, Outlines};
use super::floats::{EarlyFloats, WrapArea};
use super::notes::{NoteBox, NoteSeps};
use super::page::PageBuilder;
use super::placed::Placed;
use super::{
    Arc, Blocks, Counters, Document, Hash, HashMap, HashSet, Hasher, HideDeleted, InlineObject, LayoutOptions, Page, ParaLayout, Paragraph,
    Rect, SectionProps, StoryRef, TextDirection, ViewMode, fields, styleref,
};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Key {
    pub(crate) rev: u64,
    pub(crate) width: u32,
    pub(crate) label: Option<String>,
    pub(crate) page: Option<(u32, u32, u32, u32, u64, ew_doc::section::NumFormat)>,
    /// The pages a split paragraph's fields are on after its first (`FieldCtx::page_from`).
    pub(crate) page_from: u64,
    pub(crate) table: u64,
    pub(crate) notes: u64,
    pub(crate) excl: u64,
    pub(crate) eq: u32,
    pub(crate) read_spacing: Option<u32>,
    pub(crate) grid: (u32, u32, u32, bool),
    pub(crate) fit: bool,
    /// Heights of the paragraph's inline boxes that resize to fit their text.
    pub(crate) fitted: u64,
    pub(crate) hide_deleted: HideDeleted,
    /// STYLEREF results in headers and footers ([`FieldCtx::styleref_key`]).
    pub(crate) sref: u64,
    /// The word being typed in this paragraph, left without a spelling squiggle.
    pub(crate) typing: Option<(usize, usize)>,
    /// EasyWriter engine-style-separator: where it runs on after a style separator, and whether it ends in one.
    pub(crate) join: u64,
}

/// Memoised paragraph layouts.
#[derive(Default)]
pub struct LayoutCache {
    pub(crate) paras: HashMap<Key, Arc<ParaLayout>>,
    /// Narrowest and widest content of paragraphs measured for table autofit ([`Ctx::para_measured`]).
    pub(crate) measures: HashMap<Key, (f32, f32)>,
    /// Outlines of pictures' opaque pixels (Tight and Through wrapping), by media key, the
    /// media's bytes (address and length) and crop. Kept from one layout to the next, so each
    /// entry holds a weak reference to its bytes: their allocation isn't freed while the entry is
    /// kept, so no other picture's bytes can come to have its address ([`Outlines`]).
    pub(crate) outlines: Outlines,
    pub(crate) env: u64,
    pub(crate) used: HashSet<Key>,
    /// The STYLEREF style index of the last pass and what it was built from: the body blocks
    /// (shared, so an edited block is a different pointer) and `env` (styles and numbering). Kept
    /// while both are unchanged, so headers using STYLEREF don't rebuild it on every pass.
    pub(crate) styleref: Option<(Blocks, u64, Arc<styleref::StyleIndex>)>,
    /// The font families each cached layout asked about and the font generation it was made at
    /// (EasyWriter patch, CHANGES.md): fonts arrive after the first layout in the browser.
    pub(crate) fonts: HashMap<Key, (u64, Box<[String]>)>,
    pub hits: u64,
    pub misses: u64,
    /// Table rows taken over from their table's last layout (engine-edit-cost).
    pub rows_kept: u64,
    /// Table rows laid out (not taken over), for the tests that count a pass's work.
    pub rows_laid: u64,
    /// Pages a walk laid out (began, or went on filling from a mark), for the tests that count a key's work.
    pub pages_laid: u64,
    /// Lay a document out from the start only this many pages ahead, the rest in slices ([`crate::advance`]).
    pub(crate) ahead: Option<usize>,
    /// engine-layout-key: the pages on screen end before this one ([`LayoutCache::set_screen`]).
    pub(crate) screen: Option<usize>,
    /// Body tables' rows as their last layout made them, by the table's path, and the font generation they were made at
    /// (engine-edit-cost, table/memo.rs). Forgotten with the paragraph layouts.
    pub(crate) tables: HashMap<Vec<u32>, crate::table::TableMemo>,
    pub(crate) tables_fonts: u64,
    /// Lays every table row out each time, for tests that compare with the rows taken over.
    pub(crate) rows_off: bool,
}

impl LayoutCache {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.paras.len()
    }
    pub fn is_empty(&self) -> bool {
        self.paras.is_empty()
    }
    /// engine-open: a layout from the start ([`crate::layout`]) lays out about `pages` pages (the view's, from the
    /// document's start) and leaves the rest to [`crate::advance`]; `None`, the default, lays the whole document out at
    /// once. Kept by [`LayoutCache::clear`].
    pub fn set_ahead(&mut self, pages: Option<usize>) {
        self.ahead = pages;
    }

    /// engine-layout-key: the pages on screen end before page `end` (`None`: not known). With [`LayoutCache::set_ahead`], an
    /// edit's walk that passes them without coming back to the old pagination pauses there rather than at the pages ahead,
    /// which the next slice lays out ([`crate::relayout`]).
    pub fn set_screen(&mut self, end: Option<usize>) {
        self.screen = end;
    }

    /// Takes table rows over from the last layout (the default) or lays them all out each time, so a test can compare the
    /// two.
    #[doc(hidden)]
    pub fn set_row_memo(&mut self, on: bool) {
        self.rows_off = !on;
        self.tables.clear();
    }

    pub fn clear(&mut self) {
        self.paras.clear();
        self.measures.clear();
        self.tables.clear();
        self.outlines.clear();
        self.styleref = None;
        self.fonts.clear();
    }

    /// Drop `key`'s layouts when a font family they asked about changed since they were made, so
    /// a font that arrives lays out again only the paragraphs set in it (EasyWriter patch).
    pub(crate) fn drop_stale(&mut self, key: &Key) {
        let db = ew_fonts::FontDb::global();
        let now = db.generation();
        let Some((at, families)) = self.fonts.get_mut(key) else { return };
        if *at == now {
            return;
        }
        if families.iter().any(|f| db.family_generation(f) > *at) {
            self.fonts.remove(key);
            self.paras.remove(key);
            self.measures.remove(key);
        } else {
            *at = now;
        }
    }

    /// Remember the families `key`'s layout asked about, laid out at font generation `at`.
    pub(crate) fn stamp(&mut self, key: Key, at: u64, families: Vec<String>) {
        self.fonts.insert(key, (at, families.into_boxed_slice()));
    }

    /// The STYLEREF style index for `doc`, rebuilt only when the body or the styles changed.
    pub(crate) fn style_index(&mut self, doc: &Document) -> Arc<styleref::StyleIndex> {
        if let Some((body, env, ix)) = &self.styleref
            && *env == self.env
            && body.len() == doc.body.len()
            && body.iter().zip(doc.body.iter()).all(|(a, b)| Arc::ptr_eq(a, b))
        {
            return ix.clone();
        }
        let ix = Arc::new(styleref::StyleIndex::build(doc));
        self.styleref = Some((doc.body.to_vec(), self.env, ix.clone()));
        ix
    }
}

pub(crate) fn hash_of<T: Hash>(t: &T) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    t.hash(&mut h);
    h.finish()
}

pub(crate) fn env_hash(doc: &Document, opts: &LayoutOptions) -> u64 {
    let s = doc.format_json();
    // Outline view lays paragraphs out changed (no indents; plain without text formatting).
    let outline = (opts.view == ViewMode::Outline).then(|| opts.outline.as_ref().is_some_and(|o| o.plain));
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    opts.show_hidden.hash(&mut h);
    opts.hide_deleted.hash(&mut h);
    opts.hide_marked.hash(&mut h);
    opts.deletions_in_balloons.hash(&mut h);
    opts.proofing.hash(&mut h);
    opts.numeral.hash(&mut h);
    opts.field_codes.hash(&mut h);
    opts.proof.hash(&mut h);
    ew_proof::dictionary_generation().hash(&mut h);
    hyphenation_key(doc).hash(&mut h);
    outline.hash(&mut h);
    opts.filename.hash(&mut h);
    opts.filepath.hash(&mut h);
    opts.reader.hash(&mut h);
    h.finish()
}

/// The hyphenation settings, hashable (the zone as its bits).
fn hyphenation_key(doc: &Document) -> (bool, u32, bool, u32) {
    let s = &doc.settings;
    (s.auto_hyphenation, s.hyphenation_zone.to_bits(), s.hyphenate_caps, s.consecutive_hyphen_limit)
}

pub(crate) fn has_page_fields(p: &Paragraph) -> bool {
    p.objects.iter().any(|o| match o {
        InlineObject::Field { instr, .. } => {
            matches!(fields::field_name(instr).as_str(), "PAGE" | "NUMPAGES" | "SECTIONPAGES" | "SECTION" | "PAGEREF")
        }
        _ => false,
    })
}

/// Does `p` show a PAGE field, whose result is the number of the page it lands on?
pub(crate) fn has_page_number_fields(p: &Paragraph) -> bool {
    p.objects.iter().any(|o| matches!(o, InlineObject::Field { instr, .. } if fields::field_name(instr) == "PAGE"))
}

/// Does `p` show a page total, which depends on how many pages the document has?
pub(crate) fn has_total_fields(p: &Paragraph) -> bool {
    p.objects.iter().any(|o| match o {
        InlineObject::Field { instr, .. } => matches!(fields::field_name(instr).as_str(), "NUMPAGES" | "SECTIONPAGES"),
        _ => false,
    })
}

/// Page totals: of the document, and of each section (by index).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Totals {
    pub(crate) pages: u32,
    sections: Vec<u32>,
}

impl Totals {
    /// What a first pass assumes: one page.
    pub(crate) fn first_guess(sections: usize) -> Totals {
        Totals { pages: 1, sections: vec![1; sections] }
    }
    /// Count each section on every page containing its body, including a shared continuous
    /// start page. The page owner still selects headers and footers; empty sections count one.
    pub(crate) fn of(pages: &[Page], sections: &[(usize, &SectionProps)]) -> Totals {
        let ids = pages.first().map(|p| p.ids.clone()).unwrap_or_default();
        let mut per = Totals::count(pages, sections, &|id| ids.block(id));
        for n in &mut per {
            *n = (*n).max(1);
        }
        Totals { pages: u32::try_from(pages.len()).unwrap_or(u32::MAX).max(1), sections: per }
    }
    /// The pages each section's body is on, of `pages` alone, `block_of` giving the number of the body block an id names.
    pub(crate) fn count(pages: &[Page], sections: &[(usize, &SectionProps)], block_of: &dyn Fn(u32) -> Option<usize>) -> Vec<u32> {
        let mut per = vec![0u32; sections.len()];
        for page in pages {
            let mut present = HashSet::from([page.section]);
            for item in &page.items {
                let path = match item {
                    Placed::Lines { story: StoryRef::Body, path, .. }
                    | Placed::Image { story: StoryRef::Body, path, .. }
                    | Placed::Graphic { story: StoryRef::Body, path, .. }
                    | Placed::Object { story: StoryRef::Body, path, .. }
                    | Placed::Cell { story: StoryRef::Body, table: path, .. } => path,
                    _ => continue,
                };
                let Some(block) = path.0.first().and_then(|id| block_of(*id)) else { continue };
                present.insert(sections.partition_point(|(end, _)| *end < block));
            }
            for section in present {
                if let Some(n) = per.get_mut(section) {
                    *n = n.saturating_add(1);
                }
            }
        }
        per
    }
    pub(crate) fn section(&self, si: usize) -> u32 {
        self.sections.get(si).copied().unwrap_or(1)
    }
    /// engine-repaginate-2: these totals with pages counted as `was` ([`Totals::count`]) replaced by pages counted as `now`, and
    /// `pages` pages in all. `None` when a section whose count changed had none of the replaced pages: its total may be the
    /// one an empty section counts, which says nothing of its pages.
    pub(crate) fn moved(&self, (was, now): (&[u32], &[u32]), pages: usize) -> Option<Totals> {
        let mut sections = self.sections.clone();
        for (si, n) in sections.iter_mut().enumerate() {
            let (w, m) = (was.get(si).copied().unwrap_or(0), now.get(si).copied().unwrap_or(0));
            if w == m {
                continue;
            }
            if w == 0 {
                return None;
            }
            *n = (*n - w + m).max(1);
        }
        Some(Totals { pages: u32::try_from(pages).unwrap_or(u32::MAX).max(1), sections })
    }
}

/// The most extra layout passes for page totals in the body: a total that changes the page
/// count (its digits pushing text to another page) is tried again, this many times at most.
pub(crate) const MAX_TOTAL_PASSES: usize = 3;

/// What a finished pass leaves for laying the document out again after an edit ([`crate::relayout`]): what it was laid out
/// from (the document, whose body blocks are compared by pointer, the options and the inputs of the pass), what it found,
/// and the pagination state at [`Mark`]s through the body.
#[derive(Clone)]
pub(crate) struct Resume {
    pub(crate) doc: Document,
    pub(crate) opts: LayoutOptions,
    pub(crate) env: u64,
    pub(crate) dictionary: u64,
    /// Page totals the body was laid out with ...
    pub(crate) totals: Totals,
    /// ... and those its pages have (the headers and footers show these).
    pub(crate) found: Totals,
    pub(crate) early: EarlyFloats,
    pub(crate) note_pages: HashMap<u32, usize>,
    pub(crate) settle: bool,
    pub(crate) notes: (Arc<HashMap<u32, fields::NoteNum>>, u64),
    pub(crate) marks: Vec<Mark>,
    /// How many items each page put behind its text (inserted at the front of its items).
    pub(crate) behind: Vec<usize>,
    pub(crate) floats: HashMap<(usize, usize), Option<(usize, WrapArea)>>,
    pub(crate) uses_totals: bool,
    /// Where the body's bookmarks start and its key, for PAGEREF in headers and footers ([`fields::FieldCtx`]).
    pub(crate) bookmarks: (Arc<fields::BookmarkPages>, u64),
    /// Whether the headers and footers show STYLEREF or PAGEREF fields (they depend on more than their own page).
    pub(crate) styleref: bool,
    pub(crate) pagerefs: bool,
    /// Paragraph layouts cached after the last whole layout: laying out again only what changed evicts nothing, so a
    /// whole layout comes round once the cache has grown [`MAX_GROWTH`] more.
    pub(crate) paras: usize,
    pub(crate) text_boxes: usize,
    /// How many edits the layout's names of the body's blocks ([`crate::BlockIds`]) had taken in: a layout whose names
    /// moved on without it (a copy of it laid out again) is laid out whole.
    pub(crate) edits: u64,
}

/// How many paragraph layouts edits may add to the cache before the next layout is a whole one, which evicts those no
/// longer used.
// ponytail: a whole layout every few thousand keystrokes; evicting the replaced revisions instead would remove it.
pub(crate) const MAX_GROWTH: usize = 4096;

impl std::fmt::Debug for Resume {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Resume {{ {} marks }}", self.marks.len())
    }
}

/// The state of the pagination before a block: where each page's first block starts, and at the top of each section.
/// Laying out again starts from one and stops at one that the new layout reaches in the same state.
#[derive(Clone)]
pub(crate) struct Mark {
    /// The id of the block it is before ([`crate::BlockIds`]): blocks added or taken away before it leave it as it is.
    pub(crate) id: u32,
    pub(crate) si: usize,
    /// Taken at the top of section `si`, before it starts; else before block `block` inside it.
    pub(crate) start: bool,
    /// The section balances the columns of its last page, which lays its blocks out again from before that page: a pass
    /// doesn't start inside it.
    pub(crate) balance: bool,
    pub(crate) pages: usize,
    /// The page being filled, as it was (its text not yet aligned, its notes not yet placed).
    pub(crate) page: Option<Page>,
    pub(crate) behind: usize,
    pub(crate) floor: f32,
    pub(crate) pb: PbState,
    pub(crate) counters: Counters,
    pub(crate) eq_count: u32,
    pub(crate) page_field: u32,
    pub(crate) uses_totals: bool,
    pub(crate) walk: Walk,
}

/// What the section walk carries from block to block besides the page builder and the context: the endnotes placed, the
/// text boxes laid out in thrown-away balancing passes, and the text direction of the section before.
#[derive(Clone, Copy, PartialEq)]
pub(crate) struct Walk {
    pub(crate) endnotes: usize,
    pub(crate) discarded: usize,
    pub(crate) turn: TextDirection,
}

/// engine-repaginate-2: how far the pagination moved between a pass and the one laid out again after an edit, at a mark
/// both reach in the same state otherwise: by `pages` in the page list and by `number` in the pages' numbering. An edit that
/// adds a page moves every later page by one, and those pages are the old ones moved.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Shift {
    pub(crate) pages: isize,
    pub(crate) number: i64,
}

impl Shift {
    pub(crate) fn is_none(self) -> bool {
        self == Shift::default()
    }
    /// Page index `i` of the old pass in the new one.
    pub(crate) fn page(self, i: usize) -> usize {
        i.saturating_add_signed(self.pages)
    }
    /// This move, then `next`.
    pub(crate) fn then(self, next: Shift) -> Shift {
        Shift { pages: self.pages + next.pages, number: self.number + next.number }
    }
    pub(crate) fn renumber(self, n: u32) -> u32 {
        u32::try_from(i64::from(n) + self.number).unwrap_or(n)
    }
}

impl Mark {
    /// Whether the pagination is in this state now, before `block` of section `si` (`start`: at the section's top), as it was
    /// or moved by whole pages: how far. The page being filled may hold other text above.
    pub(crate) fn matches(&self, ctx: &Ctx, pb: &PageBuilder, (block, si, start): (usize, usize, bool), walk: &Walk) -> Option<Shift> {
        let page = pb.pages.last();
        let shift = Shift { pages: pb.pages.len() as isize - self.pages as isize, number: i64::from(pb.number) - i64::from(self.pb.number) };
        let same = self.id == ctx.key(block)
            && self.si == si
            && self.start == start
            && self.page.as_ref().map(|p| p.items.len()) == page.map(|p| p.items.len())
            && self.behind == pb.behind.last().copied().unwrap_or(0)
            && self.floor.to_bits() == pb.body_floor().to_bits()
            && self.walk == *walk
            && self.counters == ctx.counters
            && self.eq_count == ctx.eq_count
            && shift.renumber(self.page_field) == ctx.fields.page
            && self.pb.matches(pb, shift);
        same.then_some(shift)
    }

    /// This mark of an old pass in the new one, its pages moved by `shift`.
    pub(crate) fn shifted(mut self, shift: Shift) -> Mark {
        if shift.is_none() {
            return self;
        }
        self.pages = shift.page(self.pages);
        self.page_field = shift.renumber(self.page_field);
        if let Some(p) = &mut self.page {
            p.number = shift.renumber(p.number);
        }
        self.pb.shift(shift);
        self
    }
}

/// The page builder's state as plain values (it borrows its section and the early floats, which a [`Mark`] can't keep):
/// one list of its fields for saving, loading and comparing.
macro_rules! pb_state {
    ($($f:ident: $t:ty,)*; $($p:ident: $v:ty,)*; $($o:ident: $u:ty,)*) => {
        #[derive(Clone)]
        pub(crate) struct PbState {
            $($f: $t,)*
            $($p: $v,)*
            $($o: $u,)*
        }
        impl PbState {
            pub(crate) fn save(pb: &PageBuilder) -> Self {
                PbState { $($f: pb.$f.clone(),)* $($p: pb.$p.clone(),)* $($o: pb.$o.clone(),)* }
            }
            pub(crate) fn load(&self, pb: &mut PageBuilder) {
                $(pb.$f = self.$f.clone();)*
                $(pb.$p = self.$p.clone();)*
                $(pb.$o = self.$o.clone();)*
            }
            /// Equal to `pb`'s with its pages moved by `shift` (the fields that count pages), notes compared by what they hold,
            /// the separators (laid out once per section) not at all.
            fn matches(&self, pb: &PageBuilder, shift: Shift) -> bool {
                let mut moved = PbPaged { $($p: self.$p.clone(),)* };
                moved.shift(shift);
                $(self.$f == pb.$f &&)* $(moved.$p == pb.$p &&)* same_notes(&self.notes, &pb.notes) && same_notes(&self.carry, &pb.carry)
            }
            fn shift(&mut self, shift: Shift) {
                let mut moved = PbPaged { $($p: self.$p.clone(),)* };
                moved.shift(shift);
                $(self.$p = moved.$p;)*
            }
        }
        /// The page builder's fields that count pages.
        struct PbPaged {
            $($p: $v,)*
        }
    };
}

pb_state!(
    sect_idx: usize, col: usize, cols: Vec<(f32, f32)>, y: f32, top: f32, page_top: f32, bottom: f32, web: bool,
    orig_bottom: f32, prev: Option<(String, bool, f32, bool, bool)>, after_break_mark: bool, next_starts_page: bool,
    restart_at: Option<u32>, excl: Vec<WrapArea>, float_tables: Vec<Rect>, line_no: u32, page_items_start: usize,
    block_marks: Vec<usize>, page_valign: PageVAlign, max_y: f32, content_bottom: f32,
    sect_beneath: bool, beneath: bool, foot_top: f32, seeded: usize, settle: bool, row: Vec<crate::run_in::Seg>,;
    number: u32, para_end: Option<(usize, usize, f32)>, balance: Option<(usize, f32)>, col_break_page: Option<usize>,;
    notes: Vec<NoteBox>, carry: Vec<NoteBox>, seps: NoteSeps,
);

impl PbPaged {
    fn shift(&mut self, s: Shift) {
        self.number = s.renumber(self.number);
        if let Some(e) = &mut self.para_end {
            e.0 = s.page(e.0);
        }
        if let Some(b) = &mut self.balance {
            b.0 = s.page(b.0);
        }
        self.col_break_page = self.col_break_page.map(|p| s.page(p));
    }
}

/// Footnotes waiting for a page are the same when they are the same notes cut at the same place, holding the same line
/// layouts (an edit to a note that keeps its height would otherwise splice the old text back on the next page).
fn same_notes(a: &[NoteBox], b: &[NoteBox]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| x.id == y.id && x.cont == y.cont && x.h.to_bits() == y.h.to_bits() && super::pass::same_items(&x.items, &y.items))
}
