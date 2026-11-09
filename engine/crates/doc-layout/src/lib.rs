//! EasyWriter layout: turns a [`Document`] into pages.
//!
//! - [`para`]: one paragraph → lines (shaping, first-fit line breaking, tabs, list labels,
//!   alignment). Results are memoised per paragraph revision in a [`LayoutCache`].
//! - [`layout`]: sections → pages and columns; tables; keep/widow rules; page breaks; headers
//!   and footers; page-number fields.
//! - [`display`]: a page → draw items (glyph runs, rules, fills, images) for the renderers.
//! - [`hit`]: point ↔ position, caret geometry, line navigation, selection rectangles.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

pub mod balloons;
mod contour;
pub mod display;
pub mod fields;
pub mod hit;
mod ids;
pub mod kinsoku;
pub mod math;
pub mod outline;
pub mod para;
pub mod run_in;
pub mod styleref;
mod table;
mod textbox;
mod vertical;
pub mod wordart;
mod work;

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use ew_doc::numbering::{Counters, Level};
use ew_doc::para::{Anchor, Float, FloatAlign, InlineObject, Wrap, WrapText};
use ew_doc::props::{Border, CharProps, HeightRule, Rgb, TableFloat, TextDirection};
use ew_doc::section::{HeaderSet, SectionProps, SectionStart};
use ew_doc::{Block, Blocks, Document, Paragraph, Path, StoryRef};
use ew_geom::{Point, Rect, Spin};

pub use fields::FieldCtx;
pub use hit::VisualStep;
pub use ids::BlockIds;
pub use para::{LineEnd, ParaLayout};
pub use table::{autofit_widths, cell_margins, measure_table_columns};

mod boxes;
mod cache;
mod ctx;
mod floats;
mod flow;
mod headers;
mod notes;
mod page;
mod pass;
mod placed;
mod table_flow;

#[cfg(test)]
use boxes::{BOX_INSET_X, BOX_INSET_Y};
use boxes::{BoxInput, BoxLayout, Edges, fit_box, layout_box, push_para};
pub use cache::LayoutCache;
#[cfg(test)]
use cache::Totals;
#[cfg(test)]
use ctx::picture_outline;
use ctx::Ctx;
#[cfg(test)]
use floats::EarlyFloats;
pub use floats::{is_floating, shape_figure_alt, stacked};
#[cfg(test)]
use floats::{left_out_objects, wrap_area};
#[cfg(test)]
use headers::MAX_HEADER_ITEMS;
pub use notes::DECOR_STORY;
pub(crate) use notes::NOTE_SEP_W;
#[cfg(test)]
use notes::{NOTE_SEP, note_numbers};
use page::item_bottom;
#[cfg(test)]
use pass::{Pass, layout_pass};
use pass::{Begin, Next, Passes, walk_pass};
pub use pass::{LineIndex, now_ms, relayout};
pub use placed::{HfSlot, Layer, Placed, turn_point, turn_rect, unturn_point};

/// How the document is viewed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewMode {
    #[default]
    Print,
    /// One page as wide as the window, no page breaks.
    Web,
    /// Draft: like web, page breaks shown as rules.
    Draft,
    /// Reading: reflow into viewport-height narrow pages, navigated horizontally.
    Read,
    /// Outline: like draft, the body as an outline of its headings ([`outline`]).
    Outline,
}

/// How digits look on screen (Word › File › Options › Advanced › Numeral).
///
/// Display only: the document text keeps the typed codepoints, so find, spelling, copying and
/// the saved file all see the original digits. Only ASCII digits are substituted: Arabic-Indic
/// (U+0660–U+0669) and Extended Arabic-Indic digits (U+06F0–U+06F9, Persian/Urdu ۰۱۲۳…) always
/// show as typed, so fonts that ligate them (e.g. the end-of-ayah mark U+06DD) keep working.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NumeralMode {
    /// Western digits everywhere (`0123456789`); the default, today's behaviour.
    #[default]
    Arabic,
    /// Eastern Arabic-Indic digits everywhere (`٠١٢٣٤٥٦٧٨٩`).
    Hindi,
    /// Hindi digits in and around right-to-left text, Western digits elsewhere (numbers take
    /// an even bidi level, so the surrounding text decides).
    Context,
    /// Hindi digits when the system locale is an Arabic-script language, else Western digits.
    /// Call [`NumeralMode::resolve`] before laying out.
    System,
}

impl NumeralMode {
    /// Short UI label (Word's option names).
    pub fn label(self) -> &'static str {
        match self {
            NumeralMode::Arabic => "Arabic",
            NumeralMode::Hindi => "Hindi",
            NumeralMode::Context => "Context",
            NumeralMode::System => "System",
        }
    }

    /// Parse a command value (`"arabic" | "hindi" | "context" | "system"`, any case).
    pub fn parse(s: &str) -> Option<NumeralMode> {
        match s.to_lowercase().as_str() {
            "arabic" => Some(NumeralMode::Arabic),
            "hindi" => Some(NumeralMode::Hindi),
            "context" => Some(NumeralMode::Context),
            "system" => Some(NumeralMode::System),
            _ => None,
        }
    }

    /// Resolve `System` against the system locale (a BCP 47 or POSIX tag such as `ar-EG` or
    /// `fa_IR.UTF-8`, found by the shell: layout never reads the environment). Hindi digits for
    /// Arabic-script languages, else Western; unknown locale = Western. Other modes pass through.
    pub fn resolve(self, system_locale: Option<&str>) -> NumeralMode {
        if self != NumeralMode::System {
            return self;
        }
        if system_locale.is_some_and(hindi_locale) { NumeralMode::Hindi } else { NumeralMode::Arabic }
    }

    /// The displayed form of `c` in a run shaped with direction `rtl`.
    ///
    /// One character maps to exactly one character, so shaped text stays codepoint-aligned
    /// with the document text (only byte offsets shift). A `System` mode that was not
    /// resolved falls back to Western digits.
    pub fn map(self, c: char, rtl: bool) -> char {
        let hindi = match self {
            NumeralMode::Arabic => false,
            NumeralMode::Hindi => true,
            NumeralMode::Context => rtl,
            NumeralMode::System => false,
        };
        if hindi { if c.is_ascii_digit() { char::from_u32(0x660 + (c as u32 - '0' as u32)).unwrap_or(c) } else { c } } else { c }
    }
}

/// Does locale `tag` use Hindi digits (Arabic, Persian, Urdu, Pashto, Sindhi, Kurdish)?
fn hindi_locale(tag: &str) -> bool {
    let lang = tag.split(['_', '-', '.', '@']).next().unwrap_or_default().to_ascii_lowercase();
    matches!(lang.as_str(), "ar" | "fa" | "ur" | "ps" | "sd" | "ku" | "ckb")
}

#[derive(Clone, Debug)]
pub struct LayoutOptions {
    pub view: ViewMode,
    /// Width of the window in Web/Draft views, points.
    pub web_width: f32,
    /// Room the continuous views leave round the text, points (`view.window`'s margin): the reflow page's margins and half
    /// of the web page's bottom padding.
    pub web_margin: f32,
    /// Page height in Reading Mode (document points).
    pub read_height: f32,
    /// Transient read-only line-spacing override; ignored by print/export views.
    pub read_line_spacing: Option<f32>,
    pub show_hidden: bool,
    /// Final text ("No Markup"): tracked deletions take no space and draw nothing.
    pub hide_deleted: bool,
    /// Tracked deletions that take no space and draw nothing although markup is shown: those
    /// Track Changes Options mark Hidden (deletions, or moved-away text). `hide_deleted` and
    /// `deletions_in_balloons` leave every deletion out whatever this says.
    pub hide_marked: HideDeleted,
    /// Show revisions in balloons: tracked deletions in the body take no space and draw nothing
    /// (the editor shows them in balloons beside the page). Headers, footers, notes and text
    /// boxes get no balloons, so their deletions stay inline.
    pub deletions_in_balloons: bool,
    /// Check spelling as you type (squiggles).
    pub proofing: bool,
    /// How digits look on screen (display only; the text is untouched). Callers resolve
    /// `System` ([`NumeralMode::resolve`]); an unresolved `System` shows Western digits.
    pub numeral: NumeralMode,
    /// Print Markup (PDF, print, page images): widen each page by [`balloons::MARKUP_AREA`]
    /// and show the comments there in balloons joined to their anchors, as Word prints them.
    /// The editor draws its own interactive balloons and leaves this off.
    pub comment_balloons: bool,
    /// Show field codes (`{ PAGE }`, shaded) instead of field results (View › Field Codes, Alt+F9).
    /// A field whose own `code` flag is set shows the other one.
    pub field_codes: bool,
    /// Outline view: what's collapsed and shown (used when `view` is [`ViewMode::Outline`]).
    pub outline: Option<outline::OutlineView>,
    /// EasyWriter: headings collapsed by default (`ParaProps::collapsed`) fold away what is under them, as Word shows them on
    /// opening and leaves them out of its PDF, except the ones in this set (body block indices) the reader has expanded.
    /// `None` folds nothing: a view without a way to expand a heading shows everything.
    pub expanded: Option<std::collections::BTreeSet<usize>>,
    /// What the spelling check skips, and whether grammar is marked too (File › Options › Proofing).
    pub proof: ProofOptions,
    /// The word being typed, which gets no spelling squiggle until the caret leaves it (#1552).
    pub typing_word: Option<TypingWord>,
    /// Document file name for FILENAME fields ([`FieldCtx::filename`]).
    pub filename: Option<Arc<str>>,
    /// Document full path for FILENAME \p fields ([`FieldCtx::filepath`]).
    pub filepath: Option<Arc<str>>,
    /// EasyWriter engine-gaps-views: Immersive Reader's text options in a continuous view (`None` outside the Reader).
    pub reader: Option<ReaderText>,
}

/// The room the continuous views leave round the text when the caller names none: Word's Web Layout margin.
pub const WEB_MARGIN: f32 = 18.0;

impl Default for LayoutOptions {
    fn default() -> Self {
        LayoutOptions {
            view: ViewMode::default(),
            web_width: 0.0,
            web_margin: WEB_MARGIN,
            read_height: 0.0,
            read_line_spacing: None,
            show_hidden: false,
            hide_deleted: false,
            hide_marked: HideDeleted::default(),
            deletions_in_balloons: false,
            proofing: false,
            numeral: NumeralMode::default(),
            comment_balloons: false,
            field_codes: false,
            outline: None,
            expanded: None,
            proof: ProofOptions::default(),
            typing_word: None,
            filename: None,
            filepath: None,
            reader: None,
        }
    }
}

/// Immersive Reader's Text Spacing and Syllables (View › Immersive Reader), on screen only.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ReaderText {
    /// Wider spaces between letters, words and lines (the DOM editor's 0.12 em, 0.3 em and line height 2).
    pub spacing: bool,
    /// A dot between the syllables of every word, at the hyphenation points.
    pub syllables: bool,
}

/// Text Spacing's extra room after each letter and after each space, in ems of the text's size.
pub const READER_LETTER_EM: f32 = 0.12;
pub const READER_WORD_EM: f32 = 0.3;
/// The room a syllable dot takes, in ems.
pub const READER_DOT_EM: f32 = 0.4;

/// The word being typed ([`LayoutOptions::typing_word`]): the paragraph by its revision
/// ([`Paragraph::rev`]) and the word's byte range in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TypingWord {
    pub rev: u64,
    pub start: usize,
    pub end: usize,
}

/// File › Options › Proofing choices that change the squiggles.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ProofOptions {
    /// Mark grammar errors as you type.
    pub grammar: bool,
    pub spelling: ew_proof::Options,
}

impl Default for ProofOptions {
    fn default() -> Self {
        ProofOptions { grammar: true, spelling: ew_proof::Options::default() }
    }
}

impl LayoutOptions {
    /// The line spacing every paragraph takes in place of its own: Read Mode's, or double for the Reader's Text Spacing.
    pub fn line_spacing_override(&self) -> Option<f32> {
        if self.reader.is_some_and(|r| r.spacing) {
            return Some(2.0);
        }
        if self.view == ViewMode::Read { self.read_line_spacing } else { None }
    }

    /// Which tracked deletions in `story` take no space and draw nothing.
    pub fn hides_deleted(&self, story: StoryRef) -> HideDeleted {
        if self.hide_deleted || (self.deletions_in_balloons && story == StoryRef::Body) { HideDeleted::ALL } else { self.hide_marked.clone() }
    }
}

/// Which tracked deletions are left out of the layout: ordinary ones, the text a tracked move took away (the source of a
/// move, `w:moveFrom`), and (EasyWriter, stage2.md G25) every deletion by a reviewer Show Markup's Specific People hides.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct HideDeleted {
    pub plain: bool,
    pub moved_from: bool,
    /// The reviewers whose changes show (`None`: everyone's); the others' deletions are left out, as if accepted.
    pub people: Option<Arc<[String]>>,
    /// Display for Review › Original (EasyWriter, stage2.md G43): the text before the changes, so every insertion is left out
    /// and no deletion is.
    pub inserted: bool,
}

impl HideDeleted {
    pub const ALL: HideDeleted = HideDeleted { plain: true, moved_from: true, people: None, inserted: false };
    /// Original's: every insertion left out.
    pub const ORIGINAL: HideDeleted = HideDeleted { plain: false, moved_from: false, people: None, inserted: true };
    /// Whether any text is left out.
    pub fn any(&self) -> bool {
        self.plain || self.moved_from || self.people.is_some() || self.inserted
    }
    /// Whether text inserted by revision `ins` and deleted by `del` (`None`: neither) is left out.
    pub fn hides_change(&self, doc: &Document, ins: Option<u32>, del: Option<u32>) -> bool {
        if self.inserted { ins.is_some() } else { self.hides(doc, del) }
    }
    /// Whether text deleted by revision `del` (`None`: not deleted) is left out.
    pub fn hides(&self, doc: &Document, del: Option<u32>) -> bool {
        let Some(r) = del else { return false };
        (if doc.move_name(del).is_some() { self.moved_from } else { self.plain }) || !shows_author(self.people.as_deref(), doc, r)
    }
}

/// Whether revision `rev`'s changes show under Show Markup's Specific People (`people`, the reviewers shown; `None`: all).
pub fn shows_author(people: Option<&[String]>, doc: &Document, rev: u32) -> bool {
    people.is_none_or(|p| {
        let author = doc.revisions.get(rev as usize).map_or("", |r| r.author.as_str());
        p.iter().any(|n| n == author)
    })
}

/// One laid-out page.
#[derive(Clone, Debug, Default)]
pub struct Page {
    pub w: f32,
    pub h: f32,
    /// Index into `Document::sections()`.
    pub section: usize,
    /// Page number as displayed (after section restarts).
    pub number: u32,
    pub items: Vec<Placed>,
    /// Header / footer items (drawn dimmed while editing the body).
    pub header: Vec<Placed>,
    pub footer: Vec<Placed>,
    /// The body text area (margins).
    pub body: Rect,
    pub header_story: Option<u32>,
    pub footer_story: Option<u32>,
    /// Which of its section's headers/footers this page shows (first page, even page or the
    /// default), whether or not the section has one: double-clicking an empty header area
    /// creates that one (#960).
    pub hf_slot: HfSlot,
    /// The id of the top-level body block at the start of the page ([`Page::ids`] gives its number).
    pub first_block: u32,
    /// Width of the markup area on the right of `w` that holds comment balloons (Print Markup,
    /// [`LayoutOptions::comment_balloons`]); 0 without one. The document page is `w - markup` wide.
    pub markup: f32,
    /// The top-level body tables placed on this page as floating tables (`w:tblpPr`): a click
    /// outside one doesn't land in its cells ([`DocLayout::hit`]).
    pub float_tables: Vec<Path>,
    /// The layout's names for the body's blocks: the first index of a body item's path (and of `float_tables`' paths) is a
    /// block's id, which this resolves to its number ([`BlockIds::doc_path`]). Shared by the layout's pages.
    pub ids: BlockIds,
}

/// The whole layout.
#[derive(Clone, Debug, Default)]
pub struct DocLayout {
    pub pages: Vec<Page>,
    /// Index: (story, paragraph path as the layout names it: [`BlockIds::layout_path`]) → (page, item index) of each placed
    /// piece, in order.
    pub index: LineIndex,
    /// The names of the body's blocks the pages' items use (engine-layout-ids), shared with the pages.
    pub ids: BlockIds,
    /// Layout time, milliseconds.
    pub ms: f64,
    /// Text box stories laid out (each time a box's text was).
    pub text_boxes: usize,
    /// What laying the document out again after an edit starts from ([`relayout`]).
    pub(crate) resume: Option<Arc<cache::Resume>>,
    /// The pass under way while the layout is still being made ([`advance`]): `pages` are then the pages done so far.
    pub(crate) progress: Option<Arc<pass::progress::Progress>>,
    /// What laying the document out again after an edit left to do once the view's pages were done (engine-repaginate-2):
    /// until it is done, some pages after the view's may show a moved page's number or side, or old page totals.
    pub(crate) later: Option<Arc<pass::Later>>,
}

impl DocLayout {
    /// Whether the whole document is laid out. A layout made with [`LayoutCache::set_ahead`] holds only the pages done so
    /// far until [`advance`] has laid out the rest: page counts, the last page and anything else that needs the whole
    /// layout are not known yet.
    pub fn settled(&self) -> bool {
        self.progress.is_none() && self.later.is_none()
    }

    /// engine-keys-final: whether going on with this layout ([`advance`]) next ends a pass or begins one. A pass laid out in
    /// slices pauses before the document's last block; the slice after lays that block out, and it and the slices after it
    /// dress the pages' headers and footers a few pages a slice, then end the pass (in one slice, 25 to 31 ms on the Word
    /// fixture natively: 3,141 paragraph layouts for the headers alone). One that begins a pass from the start sets the cache
    /// up first, about 4 ms. An edit meanwhile takes the pass back to its last mark, so a host that lays the rest out between
    /// keys leaves such slices for a pause in the typing.
    pub fn ends_pass_next(&self) -> bool {
        self.progress.as_ref().is_some_and(|p| p.ends_next())
    }

    /// engine-keys-final: whether the pass under way has reached the document's end and [`advance`] is dressing its pages'
    /// headers and footers, a few pages a slice.
    pub fn dressing(&self) -> bool {
        self.progress.as_ref().is_some_and(|p| p.dressing())
    }
}

/// Lay out the whole document, or, with [`LayoutCache::set_ahead`] in the print view, its first pages: the rest follows in
/// slices from [`advance`] (engine-open), and the layout comes out as a whole one once settled.
pub fn layout(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions) -> DocLayout {
    match cache.ahead {
        Some(pages) => pass::progress::start(doc, cache, opts, pages),
        None => whole(doc, cache, opts),
    }
}

/// [`layout`] at once, its passes run to the end.
pub(crate) fn whole(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions) -> DocLayout {
    let t0 = now_ms();
    let mut passes = Passes::new(doc, opts);
    let mut l = loop {
        let walked = walk_pass(doc, cache, opts, &passes.inp, Begin::Start, None);
        match walked.map(|w| passes.next(doc, w)) {
            Some(Next::Done(l)) => break l,
            Some(Next::Again { .. }) => {}
            // A pass from the start with no stop always ends.
            None => break DocLayout::default(),
        }
    };
    l.ms = now_ms() - t0;
    l
}

/// Goes on with a layout still being made (one not [`DocLayout::settled`]) for about `ms` milliseconds, from where its pass
/// paused, taking in any edit to `doc` since as [`relayout`] does. The layout and the pages that draw differently: those
/// laid out, and once it settles those the finished passes changed (page totals in headers, say). A settled layout comes
/// back as it is.
pub fn advance(doc: &Document, cache: &mut LayoutCache, opts: &LayoutOptions, prev: DocLayout, ms: f64) -> (DocLayout, std::ops::Range<usize>) {
    pass::progress::go_on(doc, cache, opts, prev, Some(ms))
}

#[cfg(test)]
thread_local! {
    /// How many wrap relays (#1374) the layouts on this thread made: tests check none happen
    /// without something new to wrap around.
    static WRAP_RELAYS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod font_tests;
#[cfg(test)]
mod tests;
