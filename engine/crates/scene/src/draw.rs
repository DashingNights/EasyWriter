//! The display list's items: what every product engine produces and the painter, the PDF writer and hit testing take. Moved
//! from doc-layout's display.rs (P6, docs/plans/engine/viewport-design.md section 3), which re-exports them, and grown by the
//! general primitives a design tool needs: [`Draw::Vector`] (any path, a fill rule, a [`Pen`]) and [`Draw::Group`] (a
//! transform, a clip, an opacity, a blend mode and effects over its items, composited as one picture).
//!
//! The item types keep ew-doc's drawing leaf types (shape kinds, path segments, effects, line caps, WordArt effects, colours)
//! until Slides move them into a drawing crate of their own (section 2).

use kurbo::{Affine, BezPath};
use ew_doc::graphic::{GraphicKind, PathSeg};
use ew_doc::para::ShapeKind;
use ew_doc::props::{Rgb, TextDirection};
use ew_fonts::FaceRef;
use ew_geom::{Rect, Spin};

#[derive(Clone, Debug, PartialEq)]
pub enum Draw {
    Glyphs {
        face: FaceRef,
        size: f32,
        /// Glyph id, x, baseline y (page coordinates).
        glyphs: Vec<(u32, f32, f32)>,
        color: Rgb,
        alpha: f32,
        synth_bold: bool,
        synth_italic: bool,
        /// The text these glyphs show (for PDF text extraction), and the hyperlink.
        text: String,
        link: Option<String>,
        /// Byte range of `text` each glyph shows (one per glyph; a ligature's range covers all
        /// its characters). Empty when unknown: the PDF writer then guesses from the font.
        ranges: Vec<std::ops::Range<usize>>,
        /// The text background (highlight or character shading) these glyphs are drawn on, if
        /// any: a dark page dims it, so it picks the text colour against the dimmed colour.
        text_bg: Option<Rgb>,
        /// Horizontal scale of the letters (`w:w`, 1 = 100 %): each glyph is stretched across
        /// from its pen position. The positions already have the scaled advances.
        x_scale: f32,
    },
    Fill {
        rect: Rect,
        color: Rgb,
        alpha: f32,
        /// A text background (highlight or character shading), which a dark page dims instead
        /// of inverting so the text on it stays readable. Other fills (paragraph, cell, page) don't.
        text_bg: bool,
    },
    Line {
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        width: f32,
        color: Rgb,
        stroke: Stroke,
        alpha: f32,
        /// The text background this line (an underline or strikethrough) is drawn on, as for
        /// [`Draw::Glyphs`]; `None` for every other line.
        text_bg: Option<Rgb>,
    },
    Image {
        rect: Rect,
        media: String,
        crop: [f32; 4],
        alpha: f32,
        /// The picture's alt text (empty for a floating or diagram picture, which tag themselves).
        alt: String,
        /// Marked decorative (Alt Text › Mark as decorative): an artifact in tagged PDF, which
        /// screen readers skip. Always `false` for a floating or diagram picture, as `alt`.
        decorative: bool,
    },
    Shape {
        rect: Rect,
        kind: ShapeKind,
        fill: Option<Paint>,
        stroke: Option<Rgb>,
        stroke_width: f32,
        /// Alternating dash/space lengths in page points; empty means solid.
        dash: Vec<f32>,
        cap: ew_doc::connector::LineCap,
        /// Shadow, glow and soft edges (drawn with [`ew_doc::effects::bands`]).
        effects: ew_doc::effects::ShapeEffects,
        /// A rounded rectangle's corner ([`ew_doc::connector::ShapeExtra::corner`]).
        corner: Option<u32>,
    },
    /// An ink stroke: a line through `pts` (page points) with round ends and joins, `width`
    /// wide, in `color` at opacity `alpha`.
    Ink { pts: Vec<(f32, f32)>, color: Rgb, width: f32, alpha: f32 },
    /// A vector path (a chart's or diagram's polygons, slices, lines): filled, then stroked.
    Path { segs: Vec<PathSeg>, fill: Option<Paint>, stroke: Option<Rgb>, stroke_width: f32, dash: Vec<f32>, cap: ew_doc::connector::LineCap },
    /// An inline chart, diagram or described shape's draws, as one figure with its alt text (for
    /// tagged PDF). `kind` is the graphic's, `None` for a shape.
    Figure { alt: String, kind: Option<GraphicKind>, draws: Vec<Draw> },
    /// A formatting mark (¶ · → ↵) in the UI's mark colour, or in `color` (a tracked
    /// paragraph mark in its reviser's colour).
    Mark { x: f32, baseline: f32, size: f32, ch: char, color: Option<Rgb> },
    /// Turned text (a table cell's text direction): `items` are drawn in a frame turned `turn`
    /// whose origin is page point (`x`, `y`).
    Turned { x: f32, y: f32, turn: TextDirection, items: Vec<Draw> },
    /// A rotated or flipped picture, shape, chart, group or Drawing Canvas: `items` drawn
    /// turned by `spin` about page point (`cx`, `cy`) (see [`Spin::matrix`]).
    Rotated { cx: f32, cy: f32, spin: Spin, items: Vec<Draw> },
    /// `items` clipped to `rect` (a Drawing Canvas's members to its frame). Inside a
    /// [`Draw::Rotated`], `rect` is in the turned frame's (unturned) coordinates.
    /// EasyWriter: and to `path` as well when it is not empty (a picture cropped to a shape).
    Clip { rect: Rect, items: Vec<Draw>, path: Vec<PathSeg> },
    /// Text drawn from its outlines with WordArt effects (and bent, in a warped text box):
    /// `path` in page coordinates, painted as [`crate::art::art_layers`] says. `color` is the
    /// run's own colour, the fill when the effects set none. `text_bg`: as for [`Draw::Glyphs`].
    Art { path: BezPath, fx: Box<ew_doc::wordart::TextEffects>, color: Rgb, alpha: f32, text_bg: Option<Rgb> },
    /// A formatting-mark label (a section break's name) in the UI's mark colour, left edge at
    /// `x`, drawn with the same face as [`Draw::Mark`]. Screen only, like every mark.
    MarkText { x: f32, baseline: f32, size: f32, text: String },
    /// EasyWriter: any path in surface points, filled by its rule, then stroked with its pen.
    Vector(Box<VectorPath>),
    /// EasyWriter: items composited as one picture (a designer's layer, frame or component).
    Group(Box<Group>),
}

impl Draw {
    /// The affine map (a, b, c, d, e, f: x' = a·x + c·y + e, y' = b·x + d·y + f) from a frame
    /// turned `turn` with its origin at page point (`x`, `y`) to the page.
    pub fn turn_matrix(turn: TextDirection, x: f32, y: f32) -> [f32; 6] {
        match turn {
            TextDirection::Horizontal | TextDirection::Asian270 => [1.0, 0.0, 0.0, 1.0, x, y],
            TextDirection::Down | TextDirection::Rotate90 => [0.0, 1.0, -1.0, 0.0, x, y],
            TextDirection::Up => [0.0, -1.0, 1.0, 0.0, x, y],
        }
    }
}

/// How an area is painted: one colour, a gradient (page points), a picture or a pattern; opacities 0..1.
#[derive(Clone, Debug, PartialEq)]
pub enum Paint {
    Solid(Rgb, f32),
    /// A linear gradient from `p0` to `p1`; stops are (offset 0..1, colour, opacity).
    Linear {
        p0: (f32, f32),
        p1: (f32, f32),
        stops: Vec<(f32, Rgb, f32)>,
    },
    /// A circular gradient out from `c` to radius `r`; stops as [`Paint::Linear`]'s.
    Radial {
        c: (f32, f32),
        r: f32,
        stops: Vec<(f32, Rgb, f32)>,
    },
    /// EasyWriter: the picture `media` stretched over `rect` (x, y, w, h), its edge pixels padding the area past it, or
    /// repeated in every direction when `repeat` (a tiled picture fill).
    Image { media: String, rect: [f32; 4], repeat: bool },
    /// EasyWriter: `items`, drawn in the cell `cell` (x, y, w, h), repeated in every direction (a pattern fill).
    Pattern { cell: [f32; 4], items: Vec<Draw> },
}

impl Paint {
    /// Opaque `c`.
    pub fn solid(c: Rgb) -> Paint {
        Paint::Solid(c, 1.0)
    }
    /// This paint with every opacity times `a` (soft edges' bands). A picture or pattern keeps its own: the painter fades
    /// those through an opacity layer.
    pub fn faded(&self, a: f32) -> Paint {
        let fade = |s: &Vec<(f32, Rgb, f32)>| s.iter().map(|(o, c, x)| (*o, *c, x * a)).collect();
        match self {
            Paint::Solid(c, x) => Paint::Solid(*c, x * a),
            Paint::Linear { p0, p1, stops } => Paint::Linear { p0: *p0, p1: *p1, stops: fade(stops) },
            Paint::Radial { c, r, stops } => Paint::Radial { c: *c, r: *r, stops: fade(stops) },
            Paint::Image { .. } | Paint::Pattern { .. } => self.clone(),
        }
    }
    /// The colour and opacity this paint gives the point (`x`, `y`): stops blended, padded past
    /// the ends. A picture or pattern answers nothing (opacity 0): its colour is not known without decoding it.
    pub fn at(&self, x: f32, y: f32) -> (Rgb, f32) {
        let (stops, t) = match self {
            Paint::Solid(c, a) => return (*c, *a),
            Paint::Linear { p0, p1, stops } => {
                let d = (p1.0 - p0.0, p1.1 - p0.1);
                (stops, ((x - p0.0) * d.0 + (y - p0.1) * d.1) / (d.0 * d.0 + d.1 * d.1).max(1e-6))
            }
            Paint::Radial { c, r, stops } => (stops, (x - c.0).hypot(y - c.1) / r.max(1e-6)),
            Paint::Image { .. } | Paint::Pattern { .. } => return (Rgb::WHITE, 0.0),
        };
        let (Some(first), Some(last)) = (stops.first(), stops.last()) else { return (Rgb::BLACK, 0.0) };
        let t = if t.is_finite() { t } else { 0.0 };
        let Some(i) = stops.iter().position(|s| s.0 >= t) else { return (last.1, last.2) };
        let Some(a) = i.checked_sub(1).and_then(|j| stops.get(j)) else { return (first.1, first.2) };
        let b = &stops[i];
        let f = if b.0 > a.0 { (t - a.0) / (b.0 - a.0) } else { 0.0 };
        let mix = |x: u8, y: u8| (f32::from(x) + (f32::from(y) - f32::from(x)) * f).round().clamp(0.0, 255.0) as u8;
        (Rgb(mix(a.1.0, b.1.0), mix(a.1.1, b.1.1), mix(a.1.2, b.1.2)), a.2 + (b.2 - a.2) * f)
    }
}

/// A rule's look ([`Draw::Line`]): text decorations and Word's borders.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stroke {
    Solid,
    Dotted,
    Dashed,
    Double,
    /// Three thin lines side by side (a `triple` border).
    Triple,
    Wave,
    /// Word's border patterns (paragraph, cell and table borders): dots one width on, one off;
    /// dashes three on, one off; dash and dot.
    BorderDotted,
    BorderDashed,
    BorderDotDash,
}

impl Stroke {
    /// Dash and gap lengths, alternately, in line widths; `None` for the strokes that aren't
    /// dashed.
    pub fn dashes(self) -> Option<&'static [f32]> {
        match self {
            Stroke::Dotted => Some(&[1.0, 2.0]),
            Stroke::Dashed => Some(&[4.0, 2.0]),
            Stroke::BorderDotted => Some(&[1.0, 1.0]),
            Stroke::BorderDashed => Some(&[3.0, 1.0]),
            Stroke::BorderDotDash => Some(&[3.0, 1.0, 1.0, 1.0]),
            Stroke::Solid | Stroke::Double | Stroke::Triple | Stroke::Wave => None,
        }
    }
}

/// Which points a path fills: those it winds round at all, or those it winds round an odd number of times.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FillRule {
    #[default]
    NonZero,
    EvenOdd,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Join {
    #[default]
    Miter,
    Round,
    Bevel,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Cap {
    #[default]
    Butt,
    Round,
    Square,
}

/// How a path's outline is stroked: centred on the path, `width` points wide.
#[derive(Clone, Debug, PartialEq)]
pub struct Pen {
    pub paint: Paint,
    pub width: f32,
    pub join: Join,
    pub cap: Cap,
    /// The longest miter, in widths, before a miter join is bevelled.
    pub miter: f32,
    /// Alternating dash and gap lengths in points, starting `dash_offset` into the pattern; empty is solid.
    pub dash: Vec<f32>,
    pub dash_offset: f32,
}

impl Pen {
    /// A solid `width`-point line in `c`, mitred, with flat ends.
    pub fn solid(c: Rgb, width: f32) -> Pen {
        Pen { paint: Paint::solid(c), width, join: Join::Miter, cap: Cap::Butt, miter: 4.0, dash: Vec::new(), dash_offset: 0.0 }
    }
}

/// [`Draw::Vector`]: `path` filled by `rule` with `fill`, then stroked with `pen`.
#[derive(Clone, Debug, PartialEq)]
pub struct VectorPath {
    pub path: BezPath,
    pub rule: FillRule,
    pub fill: Option<Paint>,
    pub pen: Option<Pen>,
}

/// How a group's picture mixes with what lies under it (the PDF and CSS blend modes).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Blend {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
}

/// An effect on a group's picture, in the group's parent's points. The ones Word, PowerPoint and a design tool share.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Effect {
    /// The picture's silhouette in `color`, blurred by `blur`, moved by (`dx`, `dy`), behind it.
    Shadow { dx: f32, dy: f32, blur: f32, color: Rgb, alpha: f32 },
    /// The silhouette grown by about `radius`, blurred, in `color`, behind the picture.
    Glow { radius: f32, color: Rgb, alpha: f32 },
    /// The picture fades out over `radius` inside its edges.
    SoftEdge { radius: f32 },
    /// The picture blurred by `radius` (a Gaussian's standard deviation).
    Blur { radius: f32 },
    /// The picture mirrored below its bottom edge, `gap` under it, fading from `alpha` to nothing over `size` (0 to 1) of
    /// its height, blurred by `blur` (EasyWriter engine-fidelity-5: Word's `a:reflection blurRad`, as a shadow's blur).
    Reflection { gap: f32, size: f32, alpha: f32, blur: f32 },
    /// EasyWriter engine-gaps-pictures: a shadow inside the picture's silhouette along the edges (`dx`, `dy`) points to, that
    /// far in, blurred by `blur`, in `color`, over the picture (an inner shadow, and a bevel's light and shade).
    InnerShadow { dx: f32, dy: f32, blur: f32, color: Rgb, alpha: f32 },
    /// EasyWriter engine-pictures-2: a picture's colour settings drawn on each of its pixels (Recolor, brightness and
    /// contrast, Set Transparent Color and transparency: Word's `a:blip` effects).
    Adjust(ew_doc::adjust::Live),
}

/// [`Draw::Group`]: `items`, in the frame `transform` maps to the parent's, clipped to `clip`, with `effects`, composited as
/// one picture at `opacity` with `blend`.
#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub transform: Affine,
    /// A clip in the group's own frame, with its fill rule.
    pub clip: Option<(BezPath, FillRule)>,
    pub opacity: f32,
    pub blend: Blend,
    pub effects: Vec<Effect>,
    pub items: Vec<Draw>,
}

impl Group {
    /// `items` with no transform, clip or effect, at full opacity.
    pub fn of(items: Vec<Draw>) -> Group {
        Group { transform: Affine::IDENTITY, clip: None, opacity: 1.0, blend: Blend::Normal, effects: Vec::new(), items }
    }
}

/// The path of `segs` (page points).
pub fn seg_path(segs: &[PathSeg]) -> BezPath {
    let mut p = BezPath::new();
    for s in segs {
        match *s {
            PathSeg::Move(x, y) => p.move_to((x as f64, y as f64)),
            PathSeg::Line(x, y) => p.line_to((x as f64, y as f64)),
            PathSeg::Cubic(a, b, c, d, e, f) => p.curve_to((a as f64, b as f64), (c as f64, d as f64), (e as f64, f as f64)),
            PathSeg::Close => p.close_path(),
        }
    }
    p
}
