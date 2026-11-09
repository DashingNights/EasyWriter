use super::char_props::{NumChange, PropChange};
use super::color::Rgb;
use super::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
    Justify,
    Distribute,
}

impl Align {
    /// Alignment is logical (`Left` is the start edge, ISO 29500 `start`): the alignment as seen
    /// on the page, or the logical one for a visual choice, in a paragraph that reads right to
    /// left when `rtl` (Left and Right swap; the swap is its own inverse).
    pub fn visual(self, rtl: bool) -> Align {
        match self {
            Align::Left if rtl => Align::Right,
            Align::Right if rtl => Align::Left,
            a => a,
        }
    }
}

/// Line spacing rule.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "rule", content = "value")]
pub enum LineSpacing {
    /// Multiple of single spacing (1.0 = single, 1.15, 1.5, 2.0 = double).
    Multiple(f32),
    /// At least this many points.
    AtLeast(f32),
    /// Exactly this many points.
    Exactly(f32),
}

impl Default for LineSpacing {
    fn default() -> Self {
        LineSpacing::Multiple(1.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TabAlign {
    #[default]
    Left,
    Center,
    Right,
    Decimal,
    Bar,
    /// Clears an inherited stop at this position.
    Clear,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TabLeader {
    #[default]
    None,
    Dot,
    Hyphen,
    Underscore,
    MiddleDot,
}

impl TabLeader {
    pub fn char(self) -> Option<char> {
        match self {
            TabLeader::None => None,
            TabLeader::Dot => Some('.'),
            TabLeader::Hyphen => Some('-'),
            TabLeader::Underscore => Some('_'),
            TabLeader::MiddleDot => Some('·'),
        }
    }
}

/// Two tab positions closer than this (points) are the same stop: `para.tabs` replaces at this
/// tolerance, and the Tabs dialog and the ruler merge and detect no-ops with it.
pub const TAB_POS_EPS: f32 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TabStop {
    /// Points from the paragraph's left indent origin (the text column's left edge).
    pub pos: f32,
    #[serde(default)]
    pub align: TabAlign,
    #[serde(default)]
    pub leader: TabLeader,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum BorderStyle {
    #[default]
    None,
    Single,
    Double,
    Dotted,
    Dashed,
    Thick,
    Triple,
    DotDash,
    Wave,
    /// EasyWriter: Word's compound, 3-D and double-wave styles, kept apart because each takes its own room across
    /// (`line_room` in the layout crate) and is saved under its own name. They draw as the nearest plain style.
    ThinThickSmallGap,
    ThickThinSmallGap,
    ThinThickMediumGap,
    ThickThinMediumGap,
    ThinThickLargeGap,
    ThickThinLargeGap,
    ThinThickThinSmallGap,
    ThinThickThinMediumGap,
    ThinThickThinLargeGap,
    ThreeDEmboss,
    ThreeDEngrave,
    DoubleWave,
    /// EasyWriter: Word's other line styles, saved under their own names; they draw as the nearest plain style.
    DashSmallGap,
    DotDotDash,
    DashDotStroked,
    Inset,
    Outset,
    /// EasyWriter: a page art border (`apples`, `balloons3Colors`...), its width in points (Word's `w:sz` for art is in
    /// points, 1 to 31). Saved under its name; drawn as a stand-in of its width, since Word's pictures are Microsoft's.
    Art(BorderArt),
}

/// EasyWriter: one of Word's page art borders (ST_Border's art values), by its index in [`ART_BORDERS`]; it reads and
/// writes as its name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct BorderArt(u8);

/// ST_Border's art border names (ECMA-376 Part 1 §17.18.2), in alphabetical order.
pub const ART_BORDERS: [&str; 166] = [
    "apples", "archedScallops", "babyPacifier", "babyRattle", "balloons3Colors", "balloonsHotAir", "basicBlackDashes",
    "basicBlackDots", "basicBlackSquares", "basicThinLines", "basicWhiteDashes", "basicWhiteDots", "basicWhiteSquares",
    "basicWideInline", "basicWideMidline", "basicWideOutline", "bats", "birds", "birdsFlight", "cabins", "cakeSlice",
    "candyCorn", "celticKnotwork", "certificateBanner", "chainLink", "champagneBottle", "checkedBarBlack", "checkedBarColor",
    "checkered", "christmasTree", "circlesLines", "circlesRectangles", "classicalWave", "clocks", "compass", "confetti",
    "confettiGrays", "confettiOutline", "confettiStreamers", "confettiWhite", "cornerTriangles", "couponCutoutDashes",
    "couponCutoutDots", "crazyMaze", "creaturesButterfly", "creaturesFish", "creaturesInsects", "creaturesLadyBug",
    "crossStitch", "cup", "custom", "decoArch", "decoArchColor", "decoBlocks", "diamondsGray", "doubleD", "doubleDiamonds",
    "earth1", "earth2", "earth3", "eclipsingSquares1", "eclipsingSquares2", "eggsBlack", "fans", "film", "firecrackers",
    "flowersBlockPrint", "flowersDaisies", "flowersModern1", "flowersModern2", "flowersPansy", "flowersRedRose", "flowersRoses",
    "flowersTeacup", "flowersTiny", "gems", "gingerbreadMan", "gradient", "handmade1", "handmade2", "heartBalloon", "heartGray",
    "hearts", "heebieJeebies", "holly", "houseFunky", "hypnotic", "iceCreamCones", "lightBulb", "lightning1", "lightning2",
    "mapPins", "mapleLeaf", "mapleMuffins", "marquee", "marqueeToothed", "moons", "mosaic", "musicNotes", "northwest", "ovals",
    "packages", "palmsBlack", "palmsColor", "paperClips", "papyrus", "partyFavor", "partyGlass", "pencils", "people",
    "peopleHats", "peopleWaving", "poinsettias", "postageStamp", "pumpkin1", "pushPinNote1", "pushPinNote2", "pyramids",
    "pyramidsAbove", "quadrants", "rings", "safari", "sawtooth", "sawtoothGray", "scaredCat", "seattle", "shadowedSquares",
    "shapes1", "shapes2", "sharksTeeth", "shorebirdTracks", "skyrocket", "snowflakeFancy", "snowflakes", "sombrero",
    "southwest", "stars", "stars3d", "starsBlack", "starsShadowed", "starsTop", "sun", "swirligig", "tornPaper",
    "tornPaperBlack", "trees", "triangle1", "triangle2", "triangleCircle1", "triangleCircle2", "triangleParty", "triangles",
    "twistedLines1", "twistedLines2", "vine", "waveline", "weavingAngles", "weavingBraid", "weavingRibbon", "weavingStrips",
    "whiteFlowers", "woodwork", "xIllusions", "zanyTriangles", "zigZag", "zigZagStitch",
];

impl BorderArt {
    pub fn from_name(name: &str) -> Option<BorderArt> {
        ART_BORDERS.iter().position(|n| *n == name).and_then(|i| u8::try_from(i).ok()).map(BorderArt)
    }
    pub fn name(self) -> &'static str {
        ART_BORDERS.get(usize::from(self.0)).copied().unwrap_or("apples")
    }
}

impl Serialize for BorderArt {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.name())
    }
}

impl<'de> Deserialize<'de> for BorderArt {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let name = String::deserialize(d)?;
        BorderArt::from_name(&name).ok_or_else(|| serde::de::Error::custom(format!("unknown art border {name}")))
    }
}

/// EasyWriter: the styles above with their OOXML names, both ways.
const WORD_STYLES: [(BorderStyle, &str); 17] = [
    (BorderStyle::ThinThickSmallGap, "thinThickSmallGap"),
    (BorderStyle::ThickThinSmallGap, "thickThinSmallGap"),
    (BorderStyle::ThinThickMediumGap, "thinThickMediumGap"),
    (BorderStyle::ThickThinMediumGap, "thickThinMediumGap"),
    (BorderStyle::ThinThickLargeGap, "thinThickLargeGap"),
    (BorderStyle::ThickThinLargeGap, "thickThinLargeGap"),
    (BorderStyle::ThinThickThinSmallGap, "thinThickThinSmallGap"),
    (BorderStyle::ThinThickThinMediumGap, "thinThickThinMediumGap"),
    (BorderStyle::ThinThickThinLargeGap, "thinThickThinLargeGap"),
    (BorderStyle::ThreeDEmboss, "threeDEmboss"),
    (BorderStyle::ThreeDEngrave, "threeDEngrave"),
    (BorderStyle::DoubleWave, "doubleWave"),
    (BorderStyle::DashSmallGap, "dashSmallGap"),
    (BorderStyle::DotDotDash, "dotDotDash"),
    (BorderStyle::DashDotStroked, "dashDotStroked"),
    (BorderStyle::Inset, "inset"),
    (BorderStyle::Outset, "outset"),
];

impl BorderStyle {
    pub fn ooxml(self) -> &'static str {
        match self {
            BorderStyle::None => "nil",
            BorderStyle::Single => "single",
            BorderStyle::Double => "double",
            BorderStyle::Dotted => "dotted",
            BorderStyle::Dashed => "dashed",
            BorderStyle::Thick => "thick",
            BorderStyle::Triple => "triple",
            BorderStyle::DotDash => "dotDash",
            BorderStyle::Wave => "wave",
            BorderStyle::Art(a) => a.name(),
            other => WORD_STYLES.iter().find(|(b, _)| *b == other).map_or("single", |(_, n)| n),
        }
    }
    pub fn from_ooxml(s: &str) -> BorderStyle {
        match s {
            "nil" | "none" => BorderStyle::None,
            "double" => BorderStyle::Double,
            "dotted" => BorderStyle::Dotted,
            "dashed" => BorderStyle::Dashed,
            "thick" => BorderStyle::Thick,
            "triple" => BorderStyle::Triple,
            "dotDash" => BorderStyle::DotDash,
            "wave" => BorderStyle::Wave,
            _ => WORD_STYLES
                .iter()
                .find(|(_, n)| *n == s)
                .map(|(b, _)| *b)
                .or_else(|| BorderArt::from_name(s).map(BorderStyle::Art))
                .unwrap_or(BorderStyle::Single),
        }
    }
    /// EasyWriter: whether this is a page art border, whose width is in points rather than eighths in OOXML.
    pub fn is_art(self) -> bool {
        matches!(self, BorderStyle::Art(_))
    }
}

/// One border line.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Border {
    pub style: BorderStyle,
    /// Line width, points.
    pub width: f32,
    pub color: Option<Rgb>,
    /// Distance from the text, points.
    pub space: f32,
}

impl Border {
    pub fn single(width: f32) -> Border {
        Border { style: BorderStyle::Single, width, color: None, space: 0.0 }
    }
    pub fn is_visible(&self) -> bool {
        self.style != BorderStyle::None && self.width > 0.0
    }
}

/// Borders on the four sides (plus inner borders for tables and runs of bordered paragraphs).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Borders {
    pub top: Option<Border>,
    pub left: Option<Border>,
    pub bottom: Option<Border>,
    pub right: Option<Border>,
    /// Between paragraphs / inside horizontal (tables).
    pub between: Option<Border>,
    /// Inside vertical (tables).
    pub inside_v: Option<Border>,
}

impl Borders {
    pub fn all(b: Border) -> Borders {
        Borders { top: Some(b), left: Some(b), bottom: Some(b), right: Some(b), between: Some(b), inside_v: Some(b) }
    }
    pub fn box_(b: Border) -> Borders {
        Borders { top: Some(b), left: Some(b), bottom: Some(b), right: Some(b), between: None, inside_v: None }
    }
    pub fn any_visible(&self) -> bool {
        [self.top, self.left, self.bottom, self.right, self.between, self.inside_v].iter().flatten().any(Border::is_visible)
    }
    /// Apply every `Some` side of `patch` on top of `self`.
    pub fn overlay(&mut self, patch: &Borders) {
        if patch.top.is_some() {
            self.top = patch.top;
        }
        if patch.left.is_some() {
            self.left = patch.left;
        }
        if patch.bottom.is_some() {
            self.bottom = patch.bottom;
        }
        if patch.right.is_some() {
            self.right = patch.right;
        }
        if patch.between.is_some() {
            self.between = patch.between;
        }
        if patch.inside_v.is_some() {
            self.inside_v = patch.inside_v;
        }
    }
}

/// A reference to a numbering definition and level.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NumRef {
    /// `Numbering::nums` id; 0 removes numbering inherited from a style.
    pub num: u32,
    pub level: u8,
}

/// A text frame's placement (`w:framePr`, ECMA-376 §17.3.1.11), in points. Offsets apply when
/// the matching alignment is unset; anchors and the wrap keep OOXML's names.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TextFrame {
    /// Width; `None` fits the text.
    pub w: Option<f32>,
    /// Height, with `h_exact` exact rather than at least; `None` fits the text.
    pub h: Option<f32>,
    pub h_exact: bool,
    pub x: f32,
    pub y: f32,
    /// `left`, `center`, `right`, `inside`, `outside`.
    pub x_align: Option<String>,
    /// `top`, `center`, `bottom`, `inside`, `outside` (`inline` is no alignment).
    pub y_align: Option<String>,
    /// `text` (the column), `margin` or `page`.
    pub h_anchor: String,
    /// `text` (the paragraph), `margin` or `page`.
    pub v_anchor: String,
    /// `around`, `auto`, `notBeside`, `none`, `tight` or `through`.
    pub wrap: String,
    /// Distance from the text left and right, and above and below.
    pub h_space: f32,
    pub v_space: f32,
}

/// Paragraph formatting. `None` = inherit.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ParaProps {
    /// Paragraph style id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<Align>,
    /// Left indent, points.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_left: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_right: Option<f32>,
    /// First-line indent, points; negative = hanging.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_first: Option<f32>,
    /// Left (start) indent in characters (`w:leftChars` / `w:startChars`, stored by Word in
    /// hundredths). A non-zero value wins over `indent_left`; one character is the size of the
    /// paragraph mark's font. `Some(0.0)` cancels an inherited value. Common in East Asian documents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_left_chars: Option<f32>,
    /// Right (end) indent in characters (`w:rightChars` / `w:endChars`), like `indent_left_chars`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_right_chars: Option<f32>,
    /// First-line indent in characters (`w:firstLineChars`; negative = `w:hangingChars`), like
    /// `indent_left_chars`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_first_chars: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after: Option<f32>,
    /// HTML-style automatic space before (`w:beforeAutospacing`): 14 pt, none at the top of the
    /// document or of a table cell, and collapsing with the space after the paragraph above.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before_auto: Option<bool>,
    /// HTML-style automatic space after (`w:afterAutospacing`): 14 pt, none at the end of a cell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_spacing: Option<LineSpacing>,
    /// Ignore space before/after between paragraphs of the same style.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contextual_spacing: Option<bool>,
    /// `w:mirrorIndents` (ECMA-376 §17.3.1.18): the left and right indents are the inside and
    /// outside ones, so they swap sides on even (left-hand) pages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mirror_indents: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_next: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_lines: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_break_before: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widow_control: Option<bool>,
    /// 0..=8 = Level 1..9; 9 = body text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outline_level: Option<u8>,
    /// EasyWriter: Collapsed by default (`w15:collapsed`): Word opens the heading collapsed and its PDF leaves out what is
    /// under it (`LayoutOptions::expanded` in the layout).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collapsed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub numbering: Option<NumRef>,
    /// Tab stops (replaces the inherited list; `TabAlign::Clear` stops remove inherited ones).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tabs: Option<Vec<TabStop>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shading: Option<Rgb>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub borders: Option<Borders>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppress_hyphens: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppress_line_numbers: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bidi: Option<bool>,
    /// Drop cap: lines to drop (0 = none) — applies to the first character(s).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drop_cap: Option<u8>,
    /// Drop cap "In margin" (`w:dropCap="margin"`): the letter hangs in the left margin and the
    /// text keeps its indent. Unset = dropped into the text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drop_cap_margin: Option<bool>,
    /// The drop cap's distance from the text, in points (`w:hSpace`). Unset = 0.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drop_cap_distance: Option<f32>,
    /// The drop cap letter's font family (the cap run's `w:rFonts`). Unset = the text's font.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drop_cap_font: Option<String>,
    /// A text frame (`w:framePr` other than a drop cap): the paragraph is placed apart from the
    /// text, which may wrap around it — a footer's page number in a frame, for instance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame: Option<TextFrame>,
    /// Asian typography (`w:kinsoku`): East Asian line-breaking rules — no line starts with
    /// closing punctuation such as 、。」 or ends with opening punctuation such as 「（.
    /// Unset = on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinsoku: Option<bool>,
    /// `w:wordWrap`: Latin words wrap whole; `false` lets them break at any character (Word's
    /// "Allow Latin text to wrap in the middle of a word"). Unset = on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_wrap: Option<bool>,
    /// `w:overflowPunct`: punctuation may hang past the line end. Unset = on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overflow_punct: Option<bool>,
    /// `w:topLinePunct`: compress punctuation at the start of a line. Unset = off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_line_punct: Option<bool>,
    /// `w:autoSpaceDE`: automatic space between Asian and Latin text. Unset = on.
    #[serde(rename = "autoSpaceDE", skip_serializing_if = "Option::is_none")]
    pub auto_space_de: Option<bool>,
    /// `w:autoSpaceDN`: automatic space between Asian text and numbers. Unset = on.
    #[serde(rename = "autoSpaceDN", skip_serializing_if = "Option::is_none")]
    pub auto_space_dn: Option<bool>,
    /// Tracked change of the list numbering (`w:numberingChange`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_change: Option<Box<NumChange>>,
    /// Tracked formatting change (`w:pPrChange`): the paragraph properties before it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fmt_change: Option<Box<PropChange<ParaProps>>>,
    /// `w:snapToGrid`: lines snap to the section's document grid. Unset = on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snap_to_grid: Option<bool>,
}

impl ParaProps {
    pub fn overlay(&mut self, patch: &ParaProps) {
        self.overlay_layout(patch);
        self.overlay_pagination(patch);
        self.overlay_script_layout(patch);
    }

    fn overlay_layout(&mut self, patch: &ParaProps) {
        overlay_fields!(self, patch; style, align, indent_left, indent_right, indent_first, indent_left_chars, indent_right_chars, indent_first_chars,
            space_before, space_after, space_before_auto, space_after_auto, line_spacing, contextual_spacing, mirror_indents, tabs, shading, borders);
    }

    fn overlay_pagination(&mut self, patch: &ParaProps) {
        overlay_fields!(self, patch; keep_next, keep_lines, page_break_before, widow_control, outline_level, collapsed, numbering, suppress_hyphens, suppress_line_numbers,
            drop_cap, drop_cap_margin, drop_cap_distance, drop_cap_font, frame, snap_to_grid);
    }

    fn overlay_script_layout(&mut self, patch: &ParaProps) {
        overlay_fields!(self, patch; bidi, kinsoku, word_wrap, overflow_punct, top_line_punct, auto_space_de, auto_space_dn);
    }
    pub fn overlaid(mut self, patch: &ParaProps) -> ParaProps {
        self.overlay(patch);
        self
    }
    pub fn is_empty(&self) -> bool {
        *self == ParaProps::default()
    }
    /// After setting indents in points: keep the indents in characters (left, right, first line)
    /// an inherited style may set from winning over them, as Word does (`w:firstLineChars="0"`).
    pub fn cancel_char_indents(&mut self, left: bool, right: bool, first: bool) {
        for (on, chars) in [(left, &mut self.indent_left_chars), (right, &mut self.indent_right_chars), (first, &mut self.indent_first_chars)] {
            if on {
                *chars = Some(0.0);
            }
        }
    }
    /// Just the formatting: without the tracked changes.
    pub fn formatting(&self) -> ParaProps {
        ParaProps { num_change: None, fmt_change: None, ..self.clone() }
    }
}
