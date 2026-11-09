use super::grid::{Exclusion, Grid};
use super::{Arc, CharProps, Document, FaceRef, FieldCtx, Level, NumFormat, NumeralMode, ParaProps, ResolvedChar, TabLeader};

/// How a run set in one of Word's symbol fonts (Symbol, Wingdings, Wingdings 2/3, Webdings)
/// shows its characters. Those fonts are proprietary and usually missing: a substitute has other
/// glyphs, or none, at their codes, so each character is drawn as its Unicode equivalent
/// ([`ew_doc::symbol_fonts`]) from a face that has it. The text itself is unchanged.
#[derive(Clone, Copy)]
pub(super) struct SymbolRun<'a> {
    family: &'a str,
    /// The symbol font itself is installed (`face` is it).
    installed: bool,
    face: FaceRef,
}

impl<'a> SymbolRun<'a> {
    pub(super) fn of(family: &'a str, r: &ew_fonts::word::Resolved) -> Option<Self> {
        ew_doc::symbol_fonts::is_symbol_font(family).then_some(SymbolRun { family, installed: !r.substituted, face: r.face })
    }

    /// The character drawn for `c`.
    pub(super) fn show(&self, c: char) -> char {
        if self.installed {
            if self.face.covers(c) {
                return c;
            }
            // A plain 8-bit code in the installed font: its glyph sits at the private-use code.
            if let Some(p) = (0x20..=0xFF).contains(&u32::from(c)).then(|| char::from_u32(0xF000 + u32::from(c))).flatten()
                && self.face.covers(p)
            {
                return p;
            }
        }
        let Some(u) = ew_doc::symbol_fonts::symbol_char(self.family, c) else { return c };
        // A few list bullets have common look-alikes in far more fonts: use one when no face
        // has the exact character.
        let alt = match u {
            '\u{26AB}' => Some('\u{25CF}'),
            '\u{25FC}' => Some('\u{25A0}'),
            '\u{2B9A}' => Some('\u{27A2}'),
            _ => None,
        };
        let has = |ch: char| self.face.covers(ch) || ew_fonts::FontDb::global().fallback_for(ch, self.face.id()).is_some();
        match alt {
            Some(a) if !has(u) && has(a) => a,
            _ => u,
        }
    }
}

/// Whether a bullet level's `text` has a private-use character that no installed font draws:
/// its font isn't installed (or lacks it) and it isn't a symbol-font code with a Unicode
/// equivalent. Private-use codes mean something different in every font, so another face's
/// glyph there is an unrelated icon, not a bullet.
pub(super) fn undrawable_bullet(text: &str, lvl: &Level, rc: &ResolvedChar) -> bool {
    let private = |c: char| matches!(u32::from(c), 0xE000..=0xF8FF | 0xF0000..=0x10FFFF);
    lvl.format == NumFormat::Bullet
        && text.chars().any(|c| {
            private(c) && ew_doc::symbol_fonts::symbol_char(&rc.font, c).is_none() && {
                let r = ew_fonts::word::resolve(&rc.font, rc.bold, rc.italic);
                r.substituted || !r.face.covers(c)
            }
        })
}

/// A face at a size with the formatting needed to draw it.
#[derive(Clone, Debug)]
pub struct StyleRun {
    pub face: FaceRef,
    pub size: f32,
    pub synth_bold: bool,
    pub synth_italic: bool,
    pub rc: Arc<ResolvedChar>,
    /// Line ascent/descent at this size, points.
    pub ascent: f32,
    pub descent: f32,
    /// Baseline shift (superscript etc.), points, positive up.
    pub shift: f32,
}

impl StyleRun {
    /// How far the run reaches above and below the line's baseline. Word sizes a superscript
    /// or subscript's line at the full font size and leaves out its raise or drop; only a
    /// `w:position` raise or lowering counts (Word for Mac: an 11pt subscript beside 11pt text
    /// keeps the 12.675pt line, and a line of 24pt subscript is as tall as plain 24pt text).
    pub fn line_extent(&self) -> (f32, f32) {
        let draw = self.rc.draw_size();
        let k = if draw > 0.0 { self.rc.size / draw } else { 1.0 };
        let raise = self.rc.position;
        let (a, d) = (self.ascent * k, self.descent * k);
        let (above, below) = self.rc.text_effects.as_deref().map_or((0.0, 0.0), |fx| effect_room(fx, self.rc.size, a, d));
        // EasyWriter: an emphasis mark adds 0.292 of the size under the line, wherever the mark is drawn (the Word fixture's
        // four marks at 12 pt and 1.16 lines: each line 3.9 to 4.2 pt taller below; Word page 33). ponytail: one size probed.
        let em = if self.rc.em.is_some() { EM_ROOM * self.rc.size } else { 0.0 };
        (a + raise.max(0.0) + above, d + (-raise).max(0.0) + below + em)
    }
}

/// EasyWriter: the room an emphasis mark adds under its line, as a share of the run's size.
pub(crate) const EM_ROOM: f32 = 0.292;

/// EasyWriter: the room a run's shadow, glow and reflection add above and below its text, as Word gives it
/// (docs/plans/word/measurements/text-effects-line-room.md, Word probes from 6 to 144 pt). `size` is the run's size and `a`,
/// `d` its font's ascent and descent at that size. The room belongs to the run, so the line spacing rule then applies to the
/// grown box (a multiple scales it, At least is never less, Exactly ignores it). The 0.7 power and 0.2646 are Word's
/// behaviour as measured, not a published rule.
pub(crate) fn effect_room(fx: &ew_doc::wordart::TextEffects, size: f32, a: f32, d: f32) -> (f32, f32) {
    let k = (size.max(0.0) / 72.0).powf(0.7);
    let glow = fx.glow.map_or(0.0, |g| 0.75 * k * g.size.max(0.0));
    let (shadow_above, shadow_below) = fx.shadow.map_or((0.0, 0.0), |s| {
        let dy = s.distance * s.angle.to_radians().sin();
        (k * (s.blur - dy).max(0.0), k * (s.blur + dy).max(0.0))
    });
    let reflection = fx.reflection.map_or(0.0, |r| (a - d).max(0.0) + 0.2646 * d * r.distance.max(0.0));
    (glow + shadow_above, glow + shadow_below.max(reflection))
}

/// A positioned glyph inside its cluster.
#[derive(Clone, Copy, Debug)]
pub struct Glyph {
    pub gid: u32,
    /// Offset from the cluster's x, points.
    pub dx: f32,
    pub dy: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClKind {
    Text,
    Space,
    Tab,
    LineBreak,
    PageBreak,
    ColumnBreak,
    /// Inline object with its index in `Paragraph::objects`.
    Object(usize),
    /// Zero-width marker (bookmark, comment anchor) or hidden text.
    Marker,
}

/// One drawing segment of a grapheme cluster (or object, tab, break).
/// Font/style changes may split its drawing; paragraph edit/wrap boundaries keep it atomic.
#[derive(Clone, Debug)]
pub struct Cluster {
    pub start: usize,
    pub end: usize,
    pub adv: f32,
    pub kind: ClKind,
    /// Index into `ParaLayout::styles`.
    pub style: u32,
    /// Glyph range in `ParaLayout::glyphs`.
    pub g0: u32,
    pub g1: u32,
    /// A line may break after this cluster.
    pub break_after: bool,
    /// Height above the baseline for objects (images), points.
    pub obj_h: f32,
    /// Depth below the baseline for objects (equations), points.
    pub obj_d: f32,
    /// What a decimal tab sees in the cluster (it aligns on the first point, else after a run of digits).
    pub dec: Dec,
}

/// A cluster's part in a number, for decimal tabs ([`Cluster::dec`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Dec {
    #[default]
    Other,
    /// The decimal point.
    Point,
    /// A digit 0 to 9.
    Digit,
    /// A thousands separator (',' or ''').
    Group,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineEnd {
    /// Wrapped (or last line).
    Wrap,
    LineBreak,
    PageBreak,
    ColumnBreak,
    /// End of paragraph.
    Para,
}

/// A laid-out line. Coordinates are relative to the paragraph's content box: x from the
/// column's left edge, y from the top of the first line.
#[derive(Clone, Debug)]
pub struct Line {
    pub top: f32,
    pub height: f32,
    pub baseline: f32,
    /// The text's own ascent and descent on this line, without line-spacing leading (the caret's extent).
    pub text_asc: f32,
    pub text_desc: f32,
    /// Cluster index range.
    pub c0: usize,
    pub c1: usize,
    /// x of each cluster in the line, plus the end x (len = c1 - c0 + 1).
    pub xs: Vec<f32>,
    /// For tab clusters: the leader to draw across them.
    pub leaders: Vec<(usize, TabLeader)>,
    pub end: LineEnd,
    /// Byte range of the paragraph covered by the line.
    pub start: usize,
    pub stop: usize,
    /// Left and right edges available to the line.
    pub left: f32,
    pub right: f32,
    /// The line ends at a hyphenation point: (style, glyph, advance) of the hyphen drawn there.
    pub hyphen: Option<(u32, u32, f32)>,
    /// The text continues the previous line's row on the far side of a floating object (same top
    /// and height): one row, two lines. Row counts (line numbers, keeping rows on one page) skip it.
    pub beside: bool,
    /// Bidirectional lines (right-to-left text, or any line of a right-to-left paragraph): each
    /// cluster's visual box, in cluster order (len = c1 - c0), after the Unicode Bidirectional
    /// Algorithm reordered the line. Empty for plain left-to-right lines, whose clusters sit at
    /// `xs`. Read cluster geometry through [`Line::cl_left`] and friends, which handle both.
    pub vis: Vec<VisCl>,
    /// The paragraph reads right to left (its start edge is on the right).
    pub rtl: bool,
}

/// Where a cluster of a bidirectional line is drawn.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VisCl {
    /// Left edge and width, points (paragraph coordinates, like `Line::xs`).
    pub x: f32,
    pub w: f32,
    /// Embedding level after rule L1 of UAX #9 (odd = right to left).
    pub level: u8,
}

impl VisCl {
    pub fn is_rtl(&self) -> bool {
        self.level % 2 == 1
    }
    /// The edge a caret before this cluster sits at (right edge of right-to-left text).
    pub fn leading(&self) -> f32 {
        if self.is_rtl() { self.x + self.w } else { self.x }
    }
    /// The edge a caret after this cluster sits at.
    pub fn trailing(&self) -> f32 {
        if self.is_rtl() { self.x } else { self.x + self.w }
    }
}

/// Width of a paragraph mark's box, points: what a selection running past the paragraph's end
/// highlights, and how much room the mark takes for assistive technology.
pub const PARA_MARK_WIDTH: f32 = 5.0;

impl Line {
    /// Left edge of cluster `k` (a paragraph cluster index on this line).
    pub fn cl_left(&self, k: usize) -> Option<f32> {
        let i = k.checked_sub(self.c0)?;
        if self.vis.is_empty() { self.xs.get(i).copied() } else { self.vis.get(i).map(|v| v.x) }
    }
    /// Right edge of cluster `k`.
    pub fn cl_right(&self, k: usize) -> Option<f32> {
        let i = k.checked_sub(self.c0)?;
        if self.vis.is_empty() { self.xs.get(i + 1).copied() } else { self.vis.get(i).map(|v| v.x + v.w) }
    }
    /// Is cluster `k` right-to-left text?
    pub fn cl_rtl(&self, k: usize) -> bool {
        k.checked_sub(self.c0).and_then(|i| self.vis.get(i)).is_some_and(VisCl::is_rtl)
    }
    /// Caret x after the line's last cluster (its logical end), hyphen included.
    pub fn end_x(&self) -> f32 {
        let h = self.hyphen.map_or(0.0, |h| h.2);
        match self.vis.last() {
            Some(v) if v.is_rtl() => v.x - h,
            Some(v) => v.x + v.w + h,
            None => self.xs.last().copied().unwrap_or(self.left),
        }
    }
    /// x of the line's visual end for the paragraph's direction, where its paragraph mark goes:
    /// the right edge of the rightmost cluster in a left-to-right paragraph, the left edge of the
    /// leftmost in a right-to-left one. Differs from [`Line::end_x`] when the logically last text
    /// runs the other way (Hebrew ending a left-to-right paragraph, Latin ending a right-to-left one).
    pub fn visual_end_x(&self) -> f32 {
        let end = self.end_x();
        if self.rtl { self.vis.iter().map(|v| v.x).fold(end, f32::min) } else { self.vis.iter().map(|v| v.x + v.w).fold(end, f32::max) }
    }
    /// The box of the mark ending the line (its paragraph mark or line break) as its left edge and
    /// width: [`PARA_MARK_WIDTH`] at the line's visual end, past the text in a left-to-right
    /// paragraph and before it in a right-to-left one.
    pub fn mark_box(&self) -> (f32, f32) {
        let x = self.visual_end_x();
        (if self.rtl { x - PARA_MARK_WIDTH } else { x }, PARA_MARK_WIDTH)
    }
    /// x where the hyphen of a hyphenated line (advance `adv`) is drawn.
    pub fn hyphen_x(&self, adv: f32) -> f32 {
        match self.vis.last() {
            Some(v) if v.is_rtl() => v.x - adv,
            Some(v) => v.x + v.w,
            None => self.xs.last().copied().unwrap_or(0.0) - adv,
        }
    }
    /// Visual extents, left to right, of clusters `k0..k1`: one span on a left-to-right line,
    /// possibly several where bidirectional text splits a logical range.
    pub fn spans(&self, k0: usize, k1: usize) -> Vec<(f32, f32)> {
        let (k0, k1) = (k0.max(self.c0), k1.min(self.c1));
        if k0 >= k1 {
            return Vec::new();
        }
        if self.vis.is_empty() {
            return match (self.cl_left(k0), self.cl_left(k1).or_else(|| self.xs.last().copied())) {
                (Some(a), Some(b)) => vec![(a, b)],
                _ => Vec::new(),
            };
        }
        let mut boxes: Vec<(f32, f32)> =
            self.vis.get(k0 - self.c0..k1 - self.c0).unwrap_or(&[]).iter().filter(|v| v.w > 0.0).map(|v| (v.x, v.x + v.w)).collect();
        boxes.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut out: Vec<(f32, f32)> = Vec::new();
        for (a, b) in boxes {
            match out.last_mut() {
                Some(last) if a <= last.1 + 0.01 => last.1 = last.1.max(b),
                _ => out.push((a, b)),
            }
        }
        out
    }
}

/// The list label drawn on the first text line (after an opening page break, if any).
#[derive(Clone, Debug)]
pub struct Label {
    pub text: String,
    /// Maximum line ascent of every shaped font in the label, including its leading.
    pub ascent: f32,
    /// Style of the label's last run (the suffix space and the bidi tests measure with it).
    pub style: u32,
    pub glyphs: Vec<Glyph>,
    /// Font runs over `glyphs`, in drawing order: font fallback can split a label ("1、" takes
    /// the digit from the Latin face and the comma from a CJK one), and each glyph id only means
    /// something in the face it was shaped with.
    pub runs: Vec<LabelRun>,
    pub x: f32,
    pub width: f32,
}

/// Ruby text laid out over its base text's cluster.
#[derive(Clone, Debug)]
pub struct RubyLayout {
    /// The base text's cluster (the one cluster standing for an [`InlineObject::Ruby`]).
    pub cluster: usize,
    /// Glyphs with their style (index into `ParaLayout::styles`); `dx` is from the cluster's left
    /// edge.
    pub glyphs: Vec<(u32, Glyph)>,
    /// The ruby text and each glyph's byte range in it.
    pub text: String,
    pub ranges: Vec<std::ops::Range<usize>>,
    /// The ruby's baseline above the base text's, points.
    pub raise: f32,
}

/// EasyWriter engine-gaps-rest: a run Word lays out as one unit in East Asian typography (`para::east_asian`): its glyphs,
/// drawn over its cluster as ruby text is.
#[derive(Clone, Debug)]
pub struct EaRun {
    /// The run's cluster.
    pub cluster: usize,
    /// Glyphs with their style (index into `ParaLayout::styles`): `dx` from the cluster's left edge, `dy` up from its baseline,
    /// both along the turned text when `turn` is set.
    pub glyphs: Vec<(u32, Glyph)>,
    /// The text drawn and each glyph's byte range in it.
    pub text: String,
    pub ranges: Vec<std::ops::Range<usize>>,
    /// Horizontal in Vertical: the text turned 90 degrees counterclockwise, its baseline `x` right of the cluster's left edge
    /// and its first letter `y` below the line's baseline, squeezed to `scale` along the text.
    pub turn: Option<(f32, f32, f32)>,
}

/// One font run of a list label.
#[derive(Clone, Debug)]
pub struct LabelRun {
    /// Index into `ParaLayout::styles`.
    pub style: u32,
    /// Glyph range in `Label::glyphs`.
    pub glyphs: std::ops::Range<usize>,
    /// The run's characters (for the PDF text layer).
    pub text: String,
}

/// A shape drawn over a cluster (an enclosed character's circle, square, triangle or diamond),
/// relative to the cluster's left edge and baseline, in the cluster's text colour.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Enclosed {
    pub kind: ew_doc::para::ShapeKind,
    /// Left edge from the cluster's x; top above the baseline (up is positive), points.
    pub x: f32,
    pub top: f32,
    pub w: f32,
    pub h: f32,
    pub stroke: f32,
}

/// What a table style gives the text of a cell: its paragraph and run formatting, with the
/// cell's conditional formatting (header row, first column…) applied. It sits between document
/// defaults and the paragraph's style (`StyleSheet::resolve_para_in`, `resolve_char_in`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CellText {
    pub para: ParaProps,
    pub chr: CharProps,
}

/// Inputs that change a paragraph's layout beyond its own content.
pub struct ParaEnv<'a> {
    pub doc: &'a Document,
    /// Column width, points.
    pub width: f32,
    pub label: Option<(String, Level)>,
    pub fields: &'a FieldCtx,
    pub show_hidden: bool,
    /// Show field codes instead of results ([`crate::LayoutOptions::field_codes`]).
    pub field_codes: bool,
    /// Which tracked deletions to leave out, like hidden text (all of them in the final, "No
    /// Markup" text).
    pub hide_deleted: crate::HideDeleted,
    /// The table style's formatting for text in this paragraph's cell (`None` outside tables).
    pub table: Option<&'a CellText>,
    /// Check spelling (and grammar, as the options say) for squiggles; `None` = no squiggles.
    pub proofing: Option<crate::ProofOptions>,
    /// The byte range of the word being typed in this paragraph: it gets no spelling squiggle
    /// until the caret leaves it ([`crate::LayoutOptions::typing_word`]).
    pub typing_word: Option<(usize, usize)>,
    /// How digits look on screen (an unresolved `System` shows Western digits).
    pub numeral: NumeralMode,
    /// Areas text must flow around (floating objects), relative to the paragraph: x from the
    /// column's left edge, y from the top of the first line.
    pub exclusions: &'a [Exclusion],
    /// Automatic equation numbers used before this paragraph.
    pub eq_number: u32,
    pub read_line_spacing: Option<f32>,
    /// Immersive Reader's Text Spacing and Syllables ([`crate::LayoutOptions::reader`]).
    pub reader: Option<crate::ReaderText>,
    /// The section's document grid (`Grid::default()`: none).
    pub grid: Grid,
    /// Shrink inline drawings wider than the line to fit it: in text boxes, which don't clip what
    /// runs past their sides. Elsewhere such a drawing keeps its size and the page edge clips it.
    pub fit_objects: bool,
    /// Heights of the paragraph's inline text boxes that resize to fit their text, by object
    /// index: they take these instead of their saved heights.
    pub fitted: &'a [(usize, f32)],
    /// EasyWriter engine-style-separator: the paragraph runs on after a style separator, its first line in the line the
    /// paragraphs before it left open ([`crate::run_in`]).
    pub run_in: Option<&'a crate::run_in::RunIn>,
    /// EasyWriter engine-style-separator: the paragraph ends in a style separator; its last line is laid out flush left for
    /// the next paragraph to run on in.
    pub runs_on: bool,
}

#[cfg(test)]
mod effect_room_tests {
    use ew_doc::effects::{Glow, Shadow};
    use ew_doc::wordart::{Reflection, TextEffects};

    /// Word's measured line room (docs/plans/word/measurements/text-effects-line-room.md): a 20 pt glow at 72 pt
    /// adds 15.0 pt above and below, a 20 pt shadow straight down 20.04 pt below, and the room follows (size / 72)^0.7.
    #[test]
    fn text_effects_grow_the_line_as_word_measures() {
        let glow = TextEffects { glow: Some(Glow { size: 20.0, ..Default::default() }), ..Default::default() };
        let (a, b) = super::effect_room(&glow, 72.0, 60.0, 15.0);
        assert!((a - 15.0).abs() < 0.1 && (b - 15.0).abs() < 0.1, "{a} {b}");
        let (a6, _) = super::effect_room(&glow, 6.0, 5.0, 1.25);
        assert!((a6 - 2.63).abs() < 0.15, "{a6}");
        let down = TextEffects { shadow: Some(Shadow { blur: 0.0, distance: 20.0, angle: 90.0, ..Default::default() }), ..Default::default() };
        let (a, b) = super::effect_room(&down, 72.0, 60.0, 15.0);
        assert!(a.abs() < 0.01 && (b - 20.0).abs() < 0.1, "{a} {b}");
        // A reflection reaches the text's height below it, plus a share of the descent per point of distance.
        let refl = TextEffects { reflection: Some(Reflection { distance: 0.0, ..Default::default() }), ..Default::default() };
        let (a, b) = super::effect_room(&refl, 22.0, 18.0, 6.0);
        assert!(a.abs() < 0.01 && (b - 12.0).abs() < 0.01, "{a} {b}");
    }
}
