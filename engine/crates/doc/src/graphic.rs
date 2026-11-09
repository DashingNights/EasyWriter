//! Charts, SmartArt diagrams and native ink: drawings kept as neutral items ready to draw. Charts and SmartArt
//! EasyWriter can edit also keep their model ([`crate::chart::ChartSpec`],
//! [`crate::smart_art::SmartArtSpec`]); the rest are shown, not edited.

use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::fmt;

use crate::para::ShapeKind;
use crate::props::Rgb;
use crate::tagged::{reread, variant};

/// A chart, SmartArt diagram or native ink preview, as items ready to draw (and, for an editable chart or SmartArt
/// graphic, its model).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Graphic {
    pub kind: GraphicKind,
    /// What to draw, in points from the object's top-left corner.
    #[serde(default)]
    pub items: Vec<GraphicItem>,
    /// The size (points) the items were built for. Drawn scaled to the object's rectangle when
    /// that differs (layout shrinks oversized inline objects); 0 means the rectangle's own size.
    #[serde(default)]
    pub w: f32,
    #[serde(default)]
    pub h: f32,
    /// Where the graphic was read from, so saving writes the original drawing itself back (not
    /// only these items). `None` for graphics made some other way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<std::sync::Arc<Embedded>>,
    /// A SmartArt graphic EasyWriter can edit (one it made, or one read back exactly as it wrote
    /// it): saving writes the diagram parts from it, and the items are drawn from it. See
    /// [`crate::smart_art`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smart_art: Option<std::sync::Arc<crate::smart_art::SmartArtSpec>>,
    /// A chart EasyWriter can edit (one it made, or one read back that holds nothing more): saving
    /// writes the chart part from it, and the items are drawn from it. See [`crate::chart`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<std::sync::Arc<crate::chart::ChartSpec>>,
}

/// What an object read from a file needs to be written back as it was: its own markup in the
/// source format and the package parts that markup refers to. Never edited; EasyWriter only moves
/// and resizes the object around it. The parts themselves (bytes, content type and their own
/// relationships) are kept in [`crate::Document::passthrough`] under their part names.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Embedded {
    /// The object's markup as a standalone XML element with its namespace declarations (DOCX:
    /// the `a:graphic` of a chart, SmartArt diagram or native ink, an ink `mc:AlternateContent`,
    /// the `w:object` of an OLE object, or the `w:pict` of a signature line).
    pub xml: String,
    /// The relationships it uses, by the ids in `xml` (or in its parts, for a SmartArt drawing).
    pub refs: Vec<EmbeddedRef>,
}

/// One relationship an [`Embedded`] object uses.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EmbeddedRef {
    /// The relationship id the markup uses.
    pub id: String,
    /// Relationship type (a URI).
    pub kind: String,
    /// The part name (a `Document::passthrough` key), or the URL of an external target.
    pub target: String,
    pub external: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphicKind {
    #[default]
    Chart,
    Diagram,
    /// Word's native InkML, kept opaque; displayed as its fallback picture when available.
    Ink,
}

impl GraphicKind {
    /// What the graphic is, in words: the alt text of one that has none of its own.
    pub fn noun(self) -> &'static str {
        match self {
            GraphicKind::Chart => "chart",
            GraphicKind::Diagram => "diagram",
            GraphicKind::Ink => "ink",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GraphicItem {
    /// A preset shape filling `rect` ([x, y, w, h]).
    Shape {
        rect: [f32; 4],
        kind: ShapeKind,
        fill: Option<Rgb>,
        stroke: Option<Rgb>,
        #[serde(default)]
        stroke_width: f32,
    },
    /// A path: polygons, pie slices, line series.
    Path {
        segs: Vec<PathSeg>,
        fill: Option<Rgb>,
        stroke: Option<Rgb>,
        #[serde(default)]
        stroke_width: f32,
    },
    /// One line of text in `rect`, aligned horizontally by `align`, centred vertically.
    Text {
        rect: [f32; 4],
        text: String,
        size: f32,
        color: Rgb,
        #[serde(default)]
        bold: bool,
        #[serde(default)]
        align: TextAlign,
        #[serde(default)]
        font: Option<String>,
    },
    /// A picture (`Document::media` key) stretched into `rect`.
    Image { rect: [f32; 4], media: String },
}

/// The variants' `type` values, in the order an unknown one is reported.
const TYPES: &[&str] = &["shape", "path", "text", "image"];

/// Read like [`Block`](crate::Block) (engine-size-3): `type` first, then the variant's fields straight from the rest of the map.
impl<'de> Deserialize<'de> for GraphicItem {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        crate::tagged::read(d, ItemVisitor)
    }
}

struct ItemVisitor;

impl<'de> Visitor<'de> for ItemVisitor {
    type Value = GraphicItem;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a graphic item")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<GraphicItem, M::Error> {
        let first = map.next_key::<String>()?.ok_or_else(|| de::Error::missing_field("type"))?;
        if first != "type" {
            return reread(first, map, "type");
        }
        let ty = map.next_value::<String>()?;
        match ty.as_str() {
            "shape" => Ok(variant!(map, GraphicItem::Shape {
                "rect": rect,
                "kind": kind,
                "fill": fill,
                "stroke": stroke,
                "stroke_width": stroke_width = 0.0,
            })),
            "path" => Ok(variant!(map, GraphicItem::Path {
                "segs": segs,
                "fill": fill,
                "stroke": stroke,
                "stroke_width": stroke_width = 0.0,
            })),
            "text" => Ok(variant!(map, GraphicItem::Text {
                "rect": rect,
                "text": text,
                "size": size,
                "color": color,
                "bold": bold = false,
                "align": align = TextAlign::default(),
                "font": font,
            })),
            "image" => Ok(variant!(map, GraphicItem::Image {
                "rect": rect,
                "media": media,
            })),
            other => Err(de::Error::unknown_variant(other, TYPES)),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    Left,
    #[default]
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathSeg {
    Move(f32, f32),
    Line(f32, f32),
    Cubic(f32, f32, f32, f32, f32, f32),
    Close,
}
