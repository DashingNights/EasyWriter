//! Shape fills: what paints a shape's, text box's or canvas's interior, and a shape outline's
//! gradient (DrawingML `a:solidFill` / `a:gradFill`, ECMA-376 §20.1.8.54 and §20.1.8.33; VML
//! `v:fill`). EasyWriter engine-gaps-shapes: also a picture or texture (`a:blipFill`, §20.1.8.14) and a
//! two-colour preset pattern (`a:pattFill`, §20.1.8.47), Shape Fill's Picture, Texture and Pattern.
//!
//! A gradient is kept as the file states it (stops, linear angle or path focus, tile rectangle,
//! `rotWithShape`, flip) so saving writes it back; drawing approximates rectangular and
//! shape-following paths as circular. Transparencies are percent (0 = opaque); rectangles are
//! percent insets (left, top, right, bottom) from the shape's edges.

use serde::de::value::MapAccessDeserializer;
use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::{Deserialize, Serialize, Serializer};
use std::fmt;
use std::sync::Arc;

use crate::props::Rgb;
use crate::tagged::{reread, variant};
#[cfg(test)]
use crate::wordart::MAX_STOPS;
use crate::wordart::{GradStop, clamp, sanitized_stops};

/// A shape's fill. In `.json` documents an opaque solid fill is written `[r, g, b]` as before
/// fills had transparency or gradients; the rest are tagged (`{"type": "gradient", ...}`).
#[derive(Clone, Debug, PartialEq)]
pub enum Fill {
    Solid { color: Rgb, transparency: f32 },
    Gradient(Arc<Gradient>),
    /// EasyWriter engine-gaps-shapes: a picture stretched over the shape, or tiled across it (a texture).
    Picture(Arc<PictureFill>),
    /// EasyWriter engine-gaps-shapes: one of DrawingML's preset patterns in two colours.
    Pattern(PatternFill),
}

/// A picture or texture fill (`a:blipFill` in a shape's properties).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PictureFill {
    /// Key into the document's media.
    pub media: String,
    /// Repeated at its own size from the shape's top left (`a:tile`, a texture), rather than stretched over the shape
    /// (`a:stretch`).
    pub tile: bool,
    /// Percent, 0 = opaque (`a:alphaModFix`).
    pub transparency: f32,
    /// Turns with the shape (`rotWithShape`).
    pub rot_with_shape: bool,
    /// The picture's own size in points at 96 dpi, which a texture repeats at; `[0, 0]` when not known (it is stretched).
    #[serde(skip_serializing_if = "is_unsized")]
    pub size: [f32; 2],
}

fn is_unsized(s: &[f32; 2]) -> bool {
    *s == [0.0, 0.0]
}

impl Default for PictureFill {
    fn default() -> Self {
        PictureFill { media: String::new(), tile: false, transparency: 0.0, rot_with_shape: true, size: [0.0, 0.0] }
    }
}

/// Largest side kept for a picture's own size, in pixels (hostile headers).
const MAX_PICTURE_PX: u32 = 1 << 16;

/// The pixel size a PNG, GIF, BMP or JPEG header states, or `None` for another format or a broken header: enough for a
/// texture's tile without decoding the picture (ew_geom's `picture::probe` needs the image crate, which this crate
/// and the docx reader do without).
pub fn picture_px(b: &[u8]) -> Option<(u32, u32)> {
    let be16 = |i: usize| Some(u32::from(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?])));
    let le16 = |i: usize| Some(u32::from(u16::from_le_bytes([*b.get(i)?, *b.get(i + 1)?])));
    let be32 = |i: usize| Some(u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?));
    let le32 = |i: usize| Some(i32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?).unsigned_abs());
    let size = if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        (be32(16)?, be32(20)?)
    } else if b.starts_with(b"GIF8") {
        (le16(6)?, le16(8)?)
    } else if b.starts_with(b"BM") {
        (le32(18)?, le32(22)?)
    } else if b.starts_with(&[0xFF, 0xD8]) {
        // The first start-of-frame marker's height and width.
        let mut i = 2;
        loop {
            while b.get(i) == Some(&0xFF) && b.get(i + 1) == Some(&0xFF) {
                i += 1;
            }
            let (m, len) = (*b.get(i + 1)?, be16(i + 2)? as usize);
            if b.get(i) != Some(&0xFF) || len < 2 {
                return None;
            }
            if (0xC0..=0xCF).contains(&m) && !matches!(m, 0xC4 | 0xC8 | 0xCC) {
                break (be16(i + 7)?, be16(i + 5)?);
            }
            i += 2 + len;
        }
    } else {
        return None;
    };
    (size.0 > 0 && size.1 > 0 && size.0 <= MAX_PICTURE_PX && size.1 <= MAX_PICTURE_PX).then_some(size)
}

impl PictureFill {
    /// A fill of picture `media` whose bytes are `bytes`, tiled (a texture) or stretched. Its own size is read from the
    /// picture's header (unknown for a format [`picture_px`] does not read: it is stretched).
    pub fn of(media: String, bytes: &[u8], tile: bool) -> PictureFill {
        let size = picture_px(bytes).map_or([0.0, 0.0], |(w, h)| [w as f32 * 0.75, h as f32 * 0.75]);
        PictureFill { media, tile, size, ..PictureFill::default() }
    }
}

/// A preset pattern fill (`a:pattFill`): its preset's 8 by 8 cell, set bits in `fg`, the rest in `bg`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternFill {
    /// One of [`PATTERNS`]' names (`ST_PresetPatternVal`).
    pub preset: String,
    pub fg: Rgb,
    pub bg: Rgb,
}

/// DrawingML's 48 preset patterns in Word's Fill Effects order: name, Word's label, and the 8 rows of the cell (bit `x`
/// of a row is column `x`). EasyWriter's own drawings of them (src/document/wp/page-background/model.mjs PATTERNS),
/// shared by the page and shape fills.
pub const PATTERNS: [(&str, &str, [u8; 8]); 48] = [
    ("pct5", "5%", [0x11, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00]),
    ("pct10", "10%", [0x11, 0x00, 0x44, 0x00, 0x11, 0x00, 0x40, 0x00]),
    ("pct20", "20%", [0x55, 0x00, 0x45, 0x00, 0x55, 0x00, 0x44, 0x00]),
    ("pct25", "25%", [0x55, 0x00, 0x55, 0x00, 0x55, 0x00, 0x55, 0x00]),
    ("pct30", "30%", [0x55, 0x22, 0x55, 0x00, 0x55, 0x22, 0x55, 0x00]),
    ("pct40", "40%", [0x55, 0x2a, 0x55, 0x88, 0x55, 0xa2, 0x55, 0x88]),
    ("pct50", "50%", [0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa]),
    ("pct60", "60%", [0x77, 0xaa, 0xdd, 0xaa, 0x77, 0xaa, 0xd5, 0xaa]),
    ("pct70", "70%", [0xff, 0xaa, 0xdf, 0xaa, 0xff, 0xaa, 0xdd, 0xaa]),
    ("pct75", "75%", [0xff, 0xaa, 0xff, 0xaa, 0xff, 0xaa, 0xff, 0xaa]),
    ("pct80", "80%", [0xff, 0xbb, 0xff, 0xaa, 0xff, 0xbb, 0xff, 0xaa]),
    ("pct90", "90%", [0xff, 0xbf, 0xff, 0xee, 0xff, 0xfb, 0xff, 0xee]),
    ("ltDnDiag", "Light downward diagonal", [0x11, 0x22, 0x44, 0x88, 0x11, 0x22, 0x44, 0x88]),
    ("ltUpDiag", "Light upward diagonal", [0x11, 0x88, 0x44, 0x22, 0x11, 0x88, 0x44, 0x22]),
    ("dkDnDiag", "Dark downward diagonal", [0x33, 0x66, 0xcc, 0x99, 0x33, 0x66, 0xcc, 0x99]),
    ("dkUpDiag", "Dark upward diagonal", [0x33, 0x99, 0xcc, 0x66, 0x33, 0x99, 0xcc, 0x66]),
    ("wdDnDiag", "Wide downward diagonal", [0x07, 0x0e, 0x1c, 0x38, 0x70, 0xe0, 0xc1, 0x83]),
    ("wdUpDiag", "Wide upward diagonal", [0x07, 0x83, 0xc1, 0xe0, 0x70, 0x38, 0x1c, 0x0e]),
    ("ltVert", "Light vertical", [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11]),
    ("ltHorz", "Light horizontal", [0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00]),
    ("narVert", "Narrow vertical", [0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55]),
    ("narHorz", "Narrow horizontal", [0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00]),
    ("dkVert", "Dark vertical", [0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33]),
    ("dkHorz", "Dark horizontal", [0xff, 0xff, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00]),
    ("dashDnDiag", "Dashed downward diagonal", [0x11, 0x22, 0x44, 0x88, 0x00, 0x00, 0x00, 0x00]),
    ("dashUpDiag", "Dashed upward diagonal", [0x11, 0x88, 0x44, 0x22, 0x00, 0x00, 0x00, 0x00]),
    ("dashHorz", "Dashed horizontal", [0x0f, 0x00, 0x00, 0x00, 0xf0, 0x00, 0x00, 0x00]),
    ("dashVert", "Dashed vertical", [0x01, 0x01, 0x01, 0x01, 0x10, 0x10, 0x10, 0x10]),
    ("smConfetti", "Small confetti", [0x01, 0x10, 0x00, 0x84, 0x00, 0x20, 0x02, 0x48]),
    ("lgConfetti", "Large confetti", [0x03, 0x63, 0x60, 0x00, 0x0c, 0xcc, 0xc0, 0x00]),
    ("zigZag", "Zigzag", [0x11, 0xaa, 0x44, 0x00, 0x11, 0xaa, 0x44, 0x00]),
    ("wave", "Wave", [0x83, 0x44, 0x38, 0x00, 0x83, 0x44, 0x38, 0x00]),
    ("diagBrick", "Diagonal brick", [0x01, 0x82, 0x40, 0x20, 0x10, 0x28, 0x04, 0x02]),
    ("horzBrick", "Horizontal brick", [0xff, 0x01, 0x01, 0x01, 0xff, 0x10, 0x10, 0x10]),
    ("weave", "Weave", [0x11, 0x28, 0x44, 0x82, 0x11, 0x82, 0x44, 0x28]),
    ("plaid", "Plaid", [0x57, 0x57, 0x03, 0x00, 0x03, 0x00, 0x03, 0x00]),
    ("divot", "Divot", [0x00, 0x0a, 0x04, 0x00, 0x00, 0xa0, 0x40, 0x00]),
    ("dotGrid", "Dotted grid", [0x55, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00]),
    ("dotDmnd", "Dotted diamond", [0x01, 0x00, 0x44, 0x00, 0x10, 0x00, 0x44, 0x00]),
    ("shingle", "Shingle", [0x3f, 0x40, 0x00, 0x00, 0x3f, 0x40, 0x00, 0x00]),
    ("trellis", "Trellis", [0x11, 0xaa, 0x44, 0xaa, 0x11, 0xaa, 0x44, 0xaa]),
    ("sphere", "Sphere", [0x18, 0x7e, 0x42, 0xc3, 0xc3, 0x42, 0x7e, 0x18]),
    ("smGrid", "Small grid", [0xff, 0x11, 0x11, 0x11, 0xff, 0x11, 0x11, 0x11]),
    ("lgGrid", "Large grid", [0xff, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01]),
    ("smCheck", "Small checker board", [0x33, 0x33, 0xcc, 0xcc, 0x33, 0x33, 0xcc, 0xcc]),
    ("lgCheck", "Large checker board", [0x0f, 0x0f, 0x0f, 0x0f, 0xf0, 0xf0, 0xf0, 0xf0]),
    ("openDmnd", "Outlined diamond", [0x01, 0x82, 0x44, 0x28, 0x10, 0x28, 0x44, 0x82]),
    ("solidDmnd", "Solid diamond", [0x00, 0x18, 0x3c, 0x7e, 0x7e, 0x3c, 0x18, 0x00]),
];

/// The cell of preset pattern `name`, or `None` for a name DrawingML lacks.
pub fn pattern_bits(name: &str) -> Option<[u8; 8]> {
    PATTERNS.iter().find(|(n, ..)| *n == name).map(|p| p.2)
}

/// The preset named `label` (Word's label, as VML's `o:title` gives it) or by its own name.
pub fn pattern_named(label: &str) -> Option<&'static str> {
    let l = label.trim();
    PATTERNS.iter().find(|(n, w, _)| n.eq_ignore_ascii_case(l) || w.eq_ignore_ascii_case(l)).map(|p| p.0)
}

/// A gradient fill.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gradient {
    pub stops: Vec<GradStop>,
    pub kind: GradientKind,
    /// `a:tileRect`: where the gradient's area sits relative to the shape (percent insets).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<[f32; 4]>,
    /// Turns with the shape (`rotWithShape`).
    #[serde(default)]
    pub rot_with_shape: bool,
    #[serde(default, skip_serializing_if = "GradientFlip::is_none")]
    pub flip: GradientFlip,
}

/// How a gradient runs.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GradientKind {
    /// Along a line at `angle` degrees (0 = left to right, 90 = top to bottom). `scaled`: the
    /// angle is scaled with the shape's aspect ratio.
    Linear {
        angle: f32,
        #[serde(default)]
        scaled: bool,
    },
    /// Outwards from `focus` (percent insets from the shape's edges, `a:fillToRect`).
    Path { shape: PathShape, focus: [f32; 4] },
}

/// The variants' `type` values, in the order an unknown one is reported.
const KINDS: &[&str] = &["linear", "path"];

/// Read like [`Block`](crate::Block) (engine-size-3): `type` first, then the variant's fields straight from the rest of the map.
impl<'de> Deserialize<'de> for GradientKind {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        crate::tagged::read(d, KindVisitor)
    }
}

struct KindVisitor;

impl<'de> Visitor<'de> for KindVisitor {
    type Value = GradientKind;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a gradient's kind")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<GradientKind, M::Error> {
        let first = map.next_key::<String>()?.ok_or_else(|| de::Error::missing_field("type"))?;
        if first != "type" {
            return reread(first, map, "type");
        }
        let ty = map.next_value::<String>()?;
        match ty.as_str() {
            "linear" => Ok(variant!(map, GradientKind::Linear {
                "angle": angle,
                "scaled": scaled = false,
            })),
            "path" => Ok(variant!(map, GradientKind::Path {
                "shape": shape,
                "focus": focus,
            })),
            other => Err(de::Error::unknown_variant(other, KINDS)),
        }
    }
}

/// A path gradient's outline (`a:path/@path`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathShape {
    Circle,
    Rect,
    Shape,
}

/// How the gradient's tile is mirrored when tiled (`a:gradFill/@flip`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GradientFlip {
    #[default]
    None,
    X,
    Y,
    Xy,
}

impl GradientFlip {
    pub fn is_none(&self) -> bool {
        *self == GradientFlip::None
    }
}

/// Largest rectangle inset kept, percent (hostile files).
const MAX_INSET: f32 = 1000.0;

fn rect(r: [f32; 4]) -> [f32; 4] {
    r.map(|v| clamp(v, -MAX_INSET, MAX_INSET, 0.0))
}

impl Fill {
    /// An opaque solid fill.
    pub fn solid(color: Rgb) -> Fill {
        Fill::Solid { color, transparency: 0.0 }
    }
    /// The one colour standing for the fill where only one fits: the solid colour, or a
    /// gradient's middle stop.
    pub fn main_color(&self) -> Rgb {
        match self {
            Fill::Solid { color, .. } => *color,
            Fill::Gradient(g) => g.stops.get(g.stops.len() / 2).map_or(Rgb::BLACK, |s| s.color),
            Fill::Picture(_) => Rgb::WHITE,
            Fill::Pattern(p) => p.fg,
        }
    }
    /// Finite, in range: at most [`MAX_STOPS`] stops, in order, positions and transparencies
    /// 0–100%, angles 0–360°. A gradient with one stop is that stop's solid colour; with none,
    /// no fill (`None`).
    pub fn sanitized(&self) -> Option<Fill> {
        Some(match self {
            Fill::Solid { color, transparency } => Fill::Solid { color: *color, transparency: clamp(*transparency, 0.0, 100.0, 0.0) },
            Fill::Gradient(g) => {
                let stops = sanitized_stops(&g.stops);
                match stops[..] {
                    [] => return None,
                    [s] => return Some(Fill::Solid { color: s.color, transparency: s.transparency }),
                    _ => {}
                }
                let kind = match g.kind {
                    GradientKind::Linear { angle, scaled } => {
                        GradientKind::Linear { angle: clamp(angle, -1e6, 1e6, 0.0).rem_euclid(360.0) % 360.0, scaled }
                    }
                    GradientKind::Path { shape, focus } => GradientKind::Path { shape, focus: rect(focus) },
                };
                Fill::Gradient(Arc::new(Gradient { stops, kind, tile: g.tile.map(rect), rot_with_shape: g.rot_with_shape, flip: g.flip }))
            }
            Fill::Picture(p) if p.media.is_empty() => return None,
            Fill::Picture(p) => {
                let transparency = clamp(p.transparency, 0.0, 100.0, 0.0);
                if transparency == p.transparency {
                    Fill::Picture(p.clone())
                } else {
                    Fill::Picture(Arc::new(PictureFill { transparency, ..PictureFill::clone(p) }))
                }
            }
            Fill::Pattern(p) => match pattern_bits(&p.preset) {
                Some(_) => Fill::Pattern(p.clone()),
                None => Fill::Pattern(PatternFill { preset: "pct50".into(), ..p.clone() }),
            },
        })
    }
}

/// The tagged `.json` form of fills other than opaque solid ones.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Tagged {
    Solid {
        color: Rgb,
        #[serde(default)]
        transparency: f32,
    },
    Gradient(Gradient),
    Picture(PictureFill),
    Pattern(PatternFill),
}

/// The variants' `type` values, in the order an unknown one is reported.
const FILL_TYPES: &[&str] = &["solid", "gradient", "picture", "pattern"];

/// Read like [`Block`](crate::Block) (engine-size-3): `type` first, then the variant straight from the rest of the map.
impl<'de> Deserialize<'de> for Tagged {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        crate::tagged::read(d, TaggedVisitor)
    }
}

struct TaggedVisitor;

impl<'de> Visitor<'de> for TaggedVisitor {
    type Value = Tagged;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a fill")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Tagged, M::Error> {
        let first = map.next_key::<String>()?.ok_or_else(|| de::Error::missing_field("type"))?;
        if first != "type" {
            return reread(first, map, "type");
        }
        let ty = map.next_value::<String>()?;
        match ty.as_str() {
            "solid" => Ok(variant!(map, Tagged::Solid {
                "color": color,
                "transparency": transparency = 0.0,
            })),
            "gradient" => Gradient::deserialize(MapAccessDeserializer::new(map)).map(Tagged::Gradient),
            "picture" => PictureFill::deserialize(MapAccessDeserializer::new(map)).map(Tagged::Picture),
            "pattern" => PatternFill::deserialize(MapAccessDeserializer::new(map)).map(Tagged::Pattern),
            other => Err(de::Error::unknown_variant(other, FILL_TYPES)),
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum AnyForm {
    Plain(Rgb),
    Tagged(Tagged),
}

impl Serialize for Fill {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Fill::Solid { color, transparency: 0.0 } => color.serialize(s),
            Fill::Solid { color, transparency } => Tagged::Solid { color: *color, transparency: *transparency }.serialize(s),
            Fill::Gradient(g) => Tagged::Gradient(Gradient::clone(g)).serialize(s),
            Fill::Picture(p) => Tagged::Picture(PictureFill::clone(p)).serialize(s),
            Fill::Pattern(p) => Tagged::Pattern(p.clone()).serialize(s),
        }
    }
}

impl<'de> Deserialize<'de> for Fill {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Fill, D::Error> {
        Ok(match AnyForm::deserialize(d)? {
            AnyForm::Plain(color) => Fill::solid(color),
            AnyForm::Tagged(Tagged::Solid { color, transparency }) => Fill::Solid { color, transparency },
            AnyForm::Tagged(Tagged::Gradient(g)) => Fill::Gradient(Arc::new(g)),
            AnyForm::Tagged(Tagged::Picture(p)) => Fill::Picture(Arc::new(p)),
            AnyForm::Tagged(Tagged::Pattern(p)) => Fill::Pattern(p),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stop(pos: f32, color: Rgb, transparency: f32) -> GradStop {
        GradStop { pos, color, transparency }
    }

    fn grad(stops: Vec<GradStop>, kind: GradientKind) -> Fill {
        Fill::Gradient(Arc::new(Gradient { stops, kind, tile: None, rot_with_shape: true, flip: GradientFlip::None }))
    }

    #[test]
    fn opaque_solid_fills_are_written_as_before_and_old_documents_load() {
        let f = Fill::solid(Rgb(1, 2, 3));
        assert_eq!(serde_json::to_string(&f).ok().as_deref(), Some("[1,2,3]"));
        assert_eq!(serde_json::from_str::<Fill>("[1,2,3]").ok(), Some(f));
    }

    #[test]
    fn transparent_and_gradient_fills_round_trip_tagged() {
        let fills = [
            Fill::Solid { color: Rgb::WHITE, transparency: 70.0 },
            grad(vec![stop(0.0, Rgb(9, 9, 9), 0.0), stop(100.0, Rgb::WHITE, 50.0)], GradientKind::Linear { angle: 90.0, scaled: true }),
            Fill::Gradient(Arc::new(Gradient {
                stops: vec![stop(0.0, Rgb::BLACK, 0.0), stop(100.0, Rgb::WHITE, 0.0)],
                kind: GradientKind::Path { shape: PathShape::Rect, focus: [50.0, 50.0, 50.0, 50.0] },
                tile: Some([-10.0, 0.0, 0.0, 0.0]),
                rot_with_shape: false,
                flip: GradientFlip::Xy,
            })),
        ];
        for f in fills {
            let json = serde_json::to_string(&f).unwrap_or_default();
            assert!(json.contains("\"type\""), "{json}");
            assert_eq!(serde_json::from_str::<Fill>(&json).ok(), Some(f), "{json}");
        }
    }

    #[test]
    fn hostile_fills_are_sanitized() {
        let many: Vec<GradStop> = (0..30).map(|i| stop(100.0 - i as f32, Rgb::BLACK, f32::NAN)).collect();
        let Some(Fill::Gradient(g)) = grad(many, GradientKind::Linear { angle: -450.0, scaled: false }).sanitized() else { panic!() };
        assert_eq!(g.stops.len(), MAX_STOPS);
        assert!(g.stops.windows(2).all(|w| w[0].pos <= w[1].pos) && g.stops.iter().all(|s| s.transparency == 0.0));
        assert_eq!(g.kind, GradientKind::Linear { angle: 270.0, scaled: false });
        let path = grad(
            vec![stop(150.0, Rgb::BLACK, 200.0), stop(-5.0, Rgb::WHITE, 0.0)],
            GradientKind::Path { shape: PathShape::Circle, focus: [f32::NAN, 1e9, -1e9, 5.0] },
        );
        let Some(Fill::Gradient(g)) = path.sanitized() else { panic!() };
        assert_eq!((g.stops[0].pos, g.stops[1].pos, g.stops[1].transparency), (0.0, 100.0, 100.0));
        assert_eq!(g.kind, GradientKind::Path { shape: PathShape::Circle, focus: [0.0, MAX_INSET, -MAX_INSET, 5.0] });
        assert_eq!(
            grad(vec![stop(0.0, Rgb::WHITE, 30.0)], GradientKind::Linear { angle: 0.0, scaled: false }).sanitized(),
            Some(Fill::Solid { color: Rgb::WHITE, transparency: 30.0 })
        );
        assert_eq!(grad(vec![], GradientKind::Linear { angle: 0.0, scaled: false }).sanitized(), None);
        assert_eq!(Fill::Solid { color: Rgb::BLACK, transparency: f32::NAN }.sanitized(), Some(Fill::solid(Rgb::BLACK)));
    }

    #[test]
    fn picture_and_pattern_fills_round_trip_and_sanitize() {
        let pic = Fill::Picture(Arc::new(PictureFill { media: "m1".into(), tile: true, transparency: 30.0, rot_with_shape: true, size: [72.0, 72.0] }));
        let pat = Fill::Pattern(PatternFill { preset: "dkDnDiag".into(), fg: Rgb(1, 2, 3), bg: Rgb::WHITE });
        for f in [pic.clone(), pat.clone()] {
            let json = serde_json::to_string(&f).unwrap_or_default();
            assert_eq!(serde_json::from_str::<Fill>(&json).ok(), Some(f), "{json}");
        }
        assert_eq!(pat.main_color(), Rgb(1, 2, 3));
        let bad = Fill::Pattern(PatternFill { preset: "nope".into(), fg: Rgb::BLACK, bg: Rgb::WHITE }).sanitized();
        assert!(matches!(bad, Some(Fill::Pattern(p)) if p.preset == "pct50"));
        assert_eq!(Fill::Picture(Arc::new(PictureFill::default())).sanitized(), None);
        assert_eq!(PATTERNS.len(), 48);
        assert_eq!(pattern_bits("pct50"), Some([0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa]));
        assert_eq!(pattern_named("Light downward diagonal"), Some("ltDnDiag"));
    }

    #[test]
    fn a_texture_tiles_at_its_pictures_own_size() {
        // A 4 by 2 PNG (the harness's sample picture).
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 2, 8, 2, 0, 0, 0, 0xF0,
            0xCA, 0xEA, 0x34, 0, 0, 0, 0x10, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x38, 0x60, 0x60, 0, 0x47, 0x0C, 0xC8, 0x1C, 0, 0x79,
            0x9A, 0x09, 0x01, 0x1A, 0xD8, 0x9F, 0xC6, 0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        assert_eq!(PictureFill::of("m".into(), png, true).size, [3.0, 1.5]);
        assert_eq!(PictureFill::of("m".into(), b"nope", true).size, [0.0, 0.0]);
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 11, 8, 0, 20, 0, 30, 1, 0, 0, 0];
        assert_eq!(picture_px(&jpeg), Some((30, 20)));
        assert_eq!(picture_px(b"GIF89a\x10\x00\x20\x00"), Some((16, 32)));
    }

    #[test]
    fn main_colour_is_the_middle_stop() {
        let g = grad(
            vec![stop(0.0, Rgb(1, 0, 0), 0.0), stop(50.0, Rgb(2, 0, 0), 0.0), stop(100.0, Rgb(3, 0, 0), 0.0)],
            GradientKind::Linear { angle: 0.0, scaled: false },
        );
        assert_eq!(g.main_color(), Rgb(2, 0, 0));
        assert_eq!(Fill::solid(Rgb::WHITE).main_color(), Rgb::WHITE);
    }
}
