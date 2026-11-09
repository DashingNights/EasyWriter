use super::float::{Float, Wrap, cap_alt};
use super::inline_kinds::{NoteKind, PTabAlign, PTabBase, RubyAlign, ShapeKind};
use super::{CharProps, Deserialize, Serialize};
use crate::tagged::{reread, variant};
use serde::de::{self, Deserializer, MapAccess, Visitor};
use std::fmt;

/// An inline object anchored at a U+FFFC in the paragraph text.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InlineObject {
    /// A picture: build one with [`super::Picture`]; its bitmap changes only through [`InlineObject::set_bitmap`].
    Image {
        /// Key in `Document::media`: what it shows.
        media: super::Media,
        /// Display size, points.
        w: f32,
        h: f32,
        #[serde(default)]
        alt: String,
        /// Its placement, and what its bitmap is drawn from.
        #[serde(default = "super::picture::no_float")]
        float: super::PictureFloat,
        /// Crop (left, top, right, bottom) fractions 0..1.
        #[serde(default)]
        crop: [f32; 4],
        /// The OLE object (embedded or linked file) or Word signature line this picture shows, as
        /// read from a file: saving writes the object back, not only its picture. See
        /// [`crate::graphic::Embedded`].
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ole: Option<std::sync::Arc<crate::graphic::Embedded>>,
    },
    /// A chart or SmartArt diagram (see [`crate::graphic`]).
    Graphic {
        w: f32,
        h: f32,
        #[serde(default)]
        alt: String,
        #[serde(default)]
        float: Float,
        graphic: std::sync::Arc<crate::graphic::Graphic>,
    },
    Shape {
        kind: ShapeKind,
        w: f32,
        h: f32,
        fill: Option<crate::fill::Fill>,
        stroke: Option<crate::props::Rgb>,
        #[serde(default)]
        stroke_width: f32,
        #[serde(default)]
        float: Float,
        /// Text box content: `Document::parts` id.
        #[serde(default)]
        story: Option<u32>,
        /// A freeform's geometry (`ShapeKind::Freeform`): its paths, or an ink stroke.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        freeform: Option<std::sync::Arc<crate::freeform::Freeform>>,
        /// Shadow, glow and soft edges.
        #[serde(default, skip_serializing_if = "crate::effects::ShapeEffects::is_empty")]
        effects: crate::effects::ShapeEffects,
        /// Drawing id, text warp, connector ends and arrowheads.
        #[serde(default, skip_serializing_if = "crate::connector::ShapeExtra::is_empty")]
        extra: crate::connector::ShapeExtra,
    },
    /// Pictures, shapes and text boxes grouped into one object (Layout › Arrange › Group): it
    /// moves, wraps and resizes as one. Its members are laid out in the group's own coordinate
    /// space, `ch_w` × `ch_h`, which is stretched over the group's `w` × `h` (DrawingML's
    /// `a:chExt` and `a:ext`), so resizing the group scales them.
    Group {
        w: f32,
        h: f32,
        #[serde(default)]
        float: Float,
        /// Size of the members' coordinate space (their offsets and sizes are in it).
        ch_w: f32,
        ch_h: f32,
        children: Vec<GroupChild>,
        /// A Drawing Canvas (Insert › Shapes › New Drawing Canvas, DrawingML's `wpc:wpc`) rather
        /// than a group: it has its own background and outline, and its frame is independent of
        /// its members: resizing it doesn't scale them (`ch_w` × `ch_h` follow `w` × `h`), and
        /// what lies outside the frame is clipped.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        canvas: Option<CanvasStyle>,
    },
    /// A field: `instr` is the field code (`PAGE`, `NUMPAGES`, `DATE \@ "M/d/yyyy"`, `TOC \o "1-3"`…);
    /// `result` the cached display text. A `locked` field keeps its result when fields update.
    Field {
        instr: String,
        #[serde(default)]
        result: String,
        #[serde(default)]
        locked: bool,
        /// `w:dirty` (ECMA-376 §17.16.5.35): the cached result is stale — another program that
        /// couldn't compute it set the flag so Word refreshes the field on open. Kept through
        /// saves; cleared when EasyWriter computes a result, like Word's F9.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        dirty: bool,
        /// Shows its code (`{ PAGE }`) instead of its result, the other way round from the
        /// document-wide View › Field Codes setting (`fields.toggleCode`, Shift+F9). A view
        /// toggle: never written to files.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        code: bool,
        /// A legacy form field's definition (`FORMCHECKBOX`, `FORMTEXT`, `FORMDROPDOWN`): the
        /// source's `w:ffData`, raw OOXML kept for round trip. Empty for other fields.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        form: String,
    },
    /// The start of a field whose result is ordinary content — formatted, possibly spanning
    /// paragraphs — up to the matching [`InlineObject::FieldEnd`]. Imported TOCs and citation
    /// managers' `ADDIN` fields are kept this way; `instr` is the field code. See
    /// [`crate::fields`].
    FieldStart {
        instr: String,
        #[serde(default)]
        locked: bool,
        /// `w:dirty` on the begin marker, as [`InlineObject::Field::dirty`].
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        dirty: bool,
    },
    /// The end of the innermost open [`InlineObject::FieldStart`].
    FieldEnd,
    /// The start of a content control whose content is what follows, up to the matching
    /// [`InlineObject::ControlEnd`]. See [`crate::control`].
    ControlStart {
        control: Box<crate::control::ContentControl>,
    },
    /// The end of the innermost open [`InlineObject::ControlStart`].
    ControlEnd,
    NoteRef {
        kind: NoteKind,
        /// `Document::parts` id of the note's story.
        id: u32,
        /// Custom mark (empty = automatic number).
        #[serde(default)]
        custom: String,
    },
    BookmarkStart {
        name: String,
    },
    BookmarkEnd {
        name: String,
    },
    CommentStart {
        id: u32,
    },
    CommentEnd {
        id: u32,
    },
    /// The start of a range that stays editable while the document is protected (Restrict
    /// Editing exceptions, `w:permStart`): for everyone (`group` = `everyone`), another editing
    /// group, or one editor (`editor`, a user name or address).
    PermStart {
        id: u32,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        group: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        editor: String,
    },
    /// The end of the editable range [`InlineObject::PermStart`] with the same `id` opened.
    PermEnd {
        id: u32,
    },
    /// An equation: its linear format (`x=(-b±√(b^2-4ac))/2a`, for plain text) and structure.
    /// A display equation sits on a line of its own.
    Equation {
        linear: String,
        #[serde(default)]
        display: bool,
        /// The structure; empty = parse `linear`.
        #[serde(default, skip_serializing_if = "crate::math::Math::is_empty")]
        math: crate::math::Math,
    },
    /// Ruby (Phonetic Guide): small `ruby` text (furigana, pinyin…) set over `base` text. The base
    /// text takes the formatting of the object's run; it reads as the paragraph's text.
    Ruby {
        base: String,
        ruby: String,
        #[serde(default)]
        align: RubyAlign,
        /// Ruby text size, points (`w:hps`).
        size: f32,
        /// From the base text's baseline up to the ruby text's baseline, points (`w:hpsRaise`).
        raise: f32,
        /// The base text size the ruby was set for, points (`w:hpsBaseText`).
        #[serde(default)]
        base_size: f32,
        /// Language of the ruby (`w:lid`, e.g. `ja-JP`); empty = unspecified.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        lang: String,
        /// Formatting of the ruby text over the run's (font, colour…); its size is `size`.
        #[serde(default, skip_serializing_if = "CharProps::is_empty")]
        props: Box<CharProps>,
    },
    /// A positional tab (Word's alignment tab, `w:ptab`): it goes to the left edge, centre or
    /// right edge of the margins or of the indents, whatever the paragraph's tab stops, and the
    /// text after it lines up there. Text already past that place sends it to the next line.
    PositionalTab {
        #[serde(default)]
        align: PTabAlign,
        #[serde(default)]
        relative_to: PTabBase,
        #[serde(default)]
        leader: crate::props::TabLeader,
    },
    /// Something we don't model, kept for round-trip (raw XML of the source format).
    Opaque {
        format: String,
        xml: String,
        #[serde(default)]
        text: String,
    },
}

/// The variants' `type` values, in the order an unknown one is reported.
const TYPES: &[&str] = &[
    "image",
    "graphic",
    "shape",
    "group",
    "field",
    "fieldStart",
    "fieldEnd",
    "controlStart",
    "controlEnd",
    "noteRef",
    "bookmarkStart",
    "bookmarkEnd",
    "commentStart",
    "commentEnd",
    "permStart",
    "permEnd",
    "equation",
    "ruby",
    "positionalTab",
    "opaque",
];

/// Read like [`Block`](crate::Block): `type` first, then the variant's fields straight from the rest of the map (engine-size-3),
/// and the other key order through [`reread`].
impl<'de> Deserialize<'de> for InlineObject {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        crate::tagged::read(d, ObjVisitor)
    }
}

struct ObjVisitor;

impl<'de> Visitor<'de> for ObjVisitor {
    type Value = InlineObject;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an inline object")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<InlineObject, M::Error> {
        let first = map.next_key::<String>()?.ok_or_else(|| de::Error::missing_field("type"))?;
        if first != "type" {
            return reread(first, map, "type");
        }
        let ty = map.next_value::<String>()?;
        match ty.as_str() {
            "image" => Ok(variant!(map, InlineObject::Image {
                "media": media,
                "w": w,
                "h": h,
                "alt": alt = String::new(),
                "float": float = super::picture::no_float(),
                "crop": crop = [0.0; 4],
                "ole": ole = None,
            })),
            "graphic" => Ok(variant!(map, InlineObject::Graphic {
                "w": w,
                "h": h,
                "alt": alt = String::new(),
                "float": float = Float::default(),
                "graphic": graphic,
            })),
            "shape" => Ok(variant!(map, InlineObject::Shape {
                "kind": kind,
                "w": w,
                "h": h,
                "fill": fill,
                "stroke": stroke,
                "stroke_width": stroke_width = 0.0,
                "float": float = Float::default(),
                "story": story = None,
                "freeform": freeform = None,
                "effects": effects = Default::default(),
                "extra": extra = Default::default(),
            })),
            "group" => Ok(variant!(map, InlineObject::Group {
                "w": w,
                "h": h,
                "float": float = Float::default(),
                "ch_w": ch_w,
                "ch_h": ch_h,
                "children": children,
                "canvas": canvas = None,
            })),
            "field" => Ok(variant!(map, InlineObject::Field {
                "instr": instr,
                "result": result = String::new(),
                "locked": locked = false,
                "dirty": dirty = false,
                "code": code = false,
                "form": form = String::new(),
            })),
            "fieldStart" => Ok(variant!(map, InlineObject::FieldStart {
                "instr": instr,
                "locked": locked = false,
                "dirty": dirty = false,
            })),
            "fieldEnd" => Ok(variant!(map, InlineObject::FieldEnd)),
            "controlStart" => Ok(variant!(map, InlineObject::ControlStart {
                "control": control,
            })),
            "controlEnd" => Ok(variant!(map, InlineObject::ControlEnd)),
            "noteRef" => Ok(variant!(map, InlineObject::NoteRef {
                "kind": kind,
                "id": id,
                "custom": custom = String::new(),
            })),
            "bookmarkStart" => Ok(variant!(map, InlineObject::BookmarkStart {
                "name": name,
            })),
            "bookmarkEnd" => Ok(variant!(map, InlineObject::BookmarkEnd {
                "name": name,
            })),
            "commentStart" => Ok(variant!(map, InlineObject::CommentStart {
                "id": id,
            })),
            "commentEnd" => Ok(variant!(map, InlineObject::CommentEnd {
                "id": id,
            })),
            "permStart" => Ok(variant!(map, InlineObject::PermStart {
                "id": id,
                "group": group = String::new(),
                "editor": editor = String::new(),
            })),
            "permEnd" => Ok(variant!(map, InlineObject::PermEnd {
                "id": id,
            })),
            "equation" => Ok(variant!(map, InlineObject::Equation {
                "linear": linear,
                "display": display = false,
                "math": math = Default::default(),
            })),
            "ruby" => Ok(variant!(map, InlineObject::Ruby {
                "base": base,
                "ruby": ruby,
                "align": align = Default::default(),
                "size": size,
                "raise": raise,
                "base_size": base_size = 0.0,
                "lang": lang = String::new(),
                "props": props = Box::default(),
            })),
            "positionalTab" => Ok(variant!(map, InlineObject::PositionalTab {
                "align": align = Default::default(),
                "relative_to": relative_to = Default::default(),
                "leader": leader = Default::default(),
            })),
            "opaque" => Ok(variant!(map, InlineObject::Opaque {
                "format": format,
                "xml": xml,
                "text": text = String::new(),
            })),
            other => Err(de::Error::unknown_variant(other, TYPES)),
        }
    }
}

/// One member of an [`InlineObject::Group`]: a picture or shape (its own `w`, `h` and story), at
/// `x`, `y` in the group's coordinate space. Its `float` is unused.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupChild {
    pub x: f32,
    pub y: f32,
    pub obj: InlineObject,
}

/// Most members a group keeps (hostile files).
pub const MAX_GROUP_CHILDREN: usize = 1000;

/// The background fill and outline of a Drawing Canvas (an [`InlineObject::Group`] with `canvas`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CanvasStyle {
    pub fill: Option<crate::fill::Fill>,
    pub stroke: Option<crate::props::Rgb>,
    /// Outline width, points.
    pub stroke_width: f32,
}

impl InlineObject {
    /// A picture, chart or diagram, shape, text box or group: something drawn with a frame, sized and wrapped.
    pub fn is_drawing(&self) -> bool {
        matches!(self, InlineObject::Image { .. } | InlineObject::Graphic { .. } | InlineObject::Shape { .. } | InlineObject::Group { .. })
    }
    /// A drawing's size and placement.
    pub fn frame(&self) -> Option<(f32, f32, &Float)> {
        match self {
            InlineObject::Image { w, h, float, .. } => Some((*w, *h, &float.place)),
            InlineObject::Graphic { w, h, float, .. }
            | InlineObject::Shape { w, h, float, .. }
            | InlineObject::Group { w, h, float, .. } => Some((*w, *h, float)),
            _ => None,
        }
    }
    /// A drawing's placement, to change.
    pub fn float_mut(&mut self) -> Option<&mut Float> {
        match self {
            InlineObject::Image { float, .. } => Some(&mut float.place),
            InlineObject::Graphic { float, .. }
            | InlineObject::Shape { float, .. }
            | InlineObject::Group { float, .. } => Some(float),
            _ => None,
        }
    }
    /// A drawing's size and placement, to change.
    fn frame_mut(&mut self) -> Option<(&mut f32, &mut f32, &mut Float)> {
        match self {
            InlineObject::Image { w, h, float, .. } => Some((w, h, &mut float.place)),
            InlineObject::Graphic { w, h, float, .. }
            | InlineObject::Shape { w, h, float, .. }
            | InlineObject::Group { w, h, float, .. } => Some((w, h, float)),
            _ => None,
        }
    }
    /// Resize a drawing (a group's members scale with it; a canvas's keep their size and place).
    /// EasyWriter engine-fidelity-4: the size is absolute from then on, as when Word's user resizes a
    /// picture sized relative to the page (`Float::rel_w`, `rel_h`).
    pub fn set_size(&mut self, nw: f32, nh: f32) {
        if let Some((w, h, float)) = self.frame_mut() {
            *w = nw;
            *h = nh;
            (float.rel_w, float.rel_h) = (None, None);
        }
        if let InlineObject::Group { ch_w, ch_h, canvas: Some(_), .. } = self {
            *ch_w = nw;
            *ch_h = nh;
        }
    }
    /// A Drawing Canvas's background and outline (`None` for anything else).
    pub fn canvas_style(&self) -> Option<&CanvasStyle> {
        match self {
            InlineObject::Group { canvas, .. } => canvas.as_ref(),
            _ => None,
        }
    }
    /// Whether this is a Drawing Canvas.
    pub fn is_canvas(&self) -> bool {
        self.canvas_style().is_some()
    }
    /// The text box story this object shows, if it is a text box.
    pub fn text_box(&self) -> Option<u32> {
        match self {
            InlineObject::Shape { story, .. } => *story,
            _ => None,
        }
    }
    /// The text box stories this object shows: a text box's, or its group members'.
    pub fn text_boxes(&self) -> Vec<u32> {
        match self {
            InlineObject::Shape { story: Some(id), .. } => vec![*id],
            InlineObject::Group { children, .. } => children.iter().filter_map(|c| c.obj.text_box()).collect(),
            _ => Vec::new(),
        }
    }
    /// The text box story slots of this object and its group members, to repoint.
    pub fn text_box_slots(&mut self) -> Vec<&mut Option<u32>> {
        match self {
            InlineObject::Shape { story, .. } => vec![story],
            InlineObject::Group { children, .. } => children
                .iter_mut()
                .filter_map(|c| match &mut c.obj {
                    InlineObject::Shape { story, .. } => Some(story),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }
    /// A group's members placed in a `w` × `h` box at (`x`, `y`): each member's rectangle
    /// (x, y, w, h) and the member. Empty for anything else.
    pub fn group_rects(&self, x: f32, y: f32, w: f32, h: f32) -> Vec<([f32; 4], &InlineObject)> {
        let InlineObject::Group { ch_w, ch_h, children, .. } = self else { return Vec::new() };
        let fin = |v: f32| if v.is_finite() { v } else { 0.0 };
        let sx = if fin(*ch_w) > 0.0 { fin(w) / ch_w } else { 1.0 };
        let sy = if fin(*ch_h) > 0.0 { fin(h) / ch_h } else { 1.0 };
        children
            .iter()
            .take(MAX_GROUP_CHILDREN)
            .filter_map(|c| {
                let (cw, chh, _) = c.obj.frame()?;
                let r = [x + fin(c.x) * sx, y + fin(c.y) * sy, (fin(cw) * sx).clamp(0.0, 4000.0), (fin(chh) * sy).clamp(0.0, 4000.0)];
                (!matches!(c.obj, InlineObject::Group { .. })).then_some((r, &c.obj))
            })
            .collect()
    }
    /// A legacy form field's definition (`FORMCHECKBOX`, `FORMTEXT`, `FORMDROPDOWN`), read from
    /// the `w:ffData` it keeps; `None` for anything else.
    pub fn legacy_form(&self) -> Option<crate::legacy_form::LegacyForm> {
        match self {
            InlineObject::Field { form, .. } if !form.is_empty() => crate::legacy_form::LegacyForm::parse(form),
            _ => None,
        }
    }
    /// Zero-width markers don't take part in layout.
    pub fn is_marker(&self) -> bool {
        matches!(
            self,
            InlineObject::BookmarkStart { .. }
                | InlineObject::BookmarkEnd { .. }
                | InlineObject::CommentStart { .. }
                | InlineObject::CommentEnd { .. }
                | InlineObject::PermStart { .. }
                | InlineObject::PermEnd { .. }
                | InlineObject::FieldStart { .. }
                | InlineObject::FieldEnd
                | InlineObject::ControlStart { .. }
                | InlineObject::ControlEnd
        )
    }
    /// A drawing's description (alternative text), wherever it is kept.
    pub fn alt_text(&self) -> &str {
        match self {
            InlineObject::Image { alt, .. } | InlineObject::Graphic { alt, .. } => alt,
            InlineObject::Shape { float, .. } | InlineObject::Group { float, .. } => &float.alt.text,
            _ => "",
        }
    }
    /// Set a drawing's description (capped at [`MAX_ALT_TEXT`] characters); `false` if this is no drawing.
    pub fn set_alt_text(&mut self, text: &str) -> bool {
        let text = cap_alt(text);
        match self {
            InlineObject::Image { alt, .. } | InlineObject::Graphic { alt, .. } => *alt = text,
            InlineObject::Shape { float, .. } | InlineObject::Group { float, .. } => float.alt.text = text,
            _ => return false,
        }
        true
    }
    /// A drawing marked decorative.
    pub fn is_decorative(&self) -> bool {
        self.frame().is_some_and(|(_, _, f)| f.alt.decorative)
    }
    pub fn is_floating(&self) -> bool {
        self.frame().is_some_and(|(_, _, float)| float.wrap != Wrap::Inline)
    }
    /// The geometry of an ink stroke (a freeform shape drawn with a pen), if this is one.
    pub fn ink(&self) -> Option<&crate::freeform::Freeform> {
        match self {
            InlineObject::Shape { freeform: Some(f), .. } if f.is_ink() => Some(f),
            _ => None,
        }
    }
    /// The line a footnote or endnote separator draws (ECMA-376 §17.11: the `w:separator` and
    /// `w:continuationSeparator` run elements): a short line, or with `continuation` one across
    /// the column. Kept as the run element itself.
    pub fn note_separator(continuation: bool) -> InlineObject {
        let el = if continuation { "w:continuationSeparator" } else { "w:separator" };
        InlineObject::Opaque { format: "docx".into(), xml: format!("<w:r><{el}/></w:r>"), text: String::new() }
    }
    /// For a [`InlineObject::note_separator`]: whether it is the continuation separator.
    pub fn as_note_separator(&self) -> Option<bool> {
        match self {
            InlineObject::Opaque { format, xml, .. } if format == "docx" => match xml.as_str() {
                "<w:r><w:separator/></w:r>" => Some(false),
                "<w:r><w:continuationSeparator/></w:r>" => Some(true),
                _ => None,
            },
            _ => None,
        }
    }
    /// The text this object contributes to plain-text extraction.
    pub fn plain_text(&self) -> &str {
        match self {
            InlineObject::Field { result, .. } => result,
            InlineObject::Equation { linear, .. } => linear,
            InlineObject::Ruby { base, .. } => base,
            InlineObject::PositionalTab { .. } => "\t",
            InlineObject::Opaque { text, .. } => text,
            _ => "",
        }
    }
}
