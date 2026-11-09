//! EasyWriter engine-picture-writer: a picture's bitmap has one owner, this module, so the compiler holds engine-pictures-3's
//! rule. What a picture shows ([`Media`], `InlineObject::Image`'s `media`) and what that is drawn from (its settings, layer,
//! Word copy and PNG copy, in [`PictureFloat`]) are private here: an edit changes them together through
//! [`InlineObject::set_bitmap`], which draws the picture from its source and settings, so no edit can change the shown
//! picture and leave its source behind. A new picture, or one a file holds, is built whole by [`Picture::build`], which keeps
//! the same rule, and Compare and paste rename keys through [`InlineObject::rename_media`]. The stored form keeps its shape:
//! `media` beside the frame, the rest in `float`.

use std::ops::{Deref, DerefMut};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::{Float, InlineObject};
use crate::adjust::{PictureAdjust, WordCopy};
use crate::fill::Fill;
use crate::graphic::GraphicItem;

/// The media key (in `Document::media`) of the picture a picture shows. Read it as a `str`; only this module sets it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Media(String);

impl Media {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Deref for Media {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

impl PartialEq<str> for Media {
    fn eq(&self, other: &str) -> bool {
        self.0 == other
    }
}

impl PartialEq<&str> for Media {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}

impl PartialEq<String> for Media {
    fn eq(&self, other: &String) -> bool {
        self.0 == *other
    }
}

impl From<Media> for String {
    fn from(m: Media) -> String {
        m.0
    }
}

impl std::fmt::Display for Media {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A picture's frame: its placement (`place`, which it derefs to) and what its bitmap is drawn from, which only this module
/// changes. Its settings and sources are a picture's own: copying a placement between objects (Group, Ungroup) leaves them be.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PictureFloat {
    #[serde(flatten)]
    pub place: Float,
    /// EasyWriter engine-pictures-2: the picture's colour and corrections (Picture Format › Adjust, its `a:blip` effects).
    #[serde(default, skip_serializing_if = "PictureAdjust::is_empty")]
    adjust: PictureAdjust,
    /// EasyWriter engine-pictures-2: the picture Word 2010's corrections were drawn from (`a14:imgLayer`): the picture shows a
    /// copy of it with them in its pixels. Reset Picture goes back to it. `None` when the picture shows its own pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    layer: Option<String>,
    /// EasyWriter engine-pictures-2: the picture Word showed when `layer` is HD Photo, kept from the first change on
    /// ([`WordCopy`]). Not saved to Word files: a .docx reload draws the next change from the copy it shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    word_copy: Option<WordCopy>,
    /// EasyWriter engine-pictures-2: an SVG picture's PNG copy (the `a:blip` Word writes beside `asvg:svgBlip`), for readers
    /// without SVG. The picture itself stays vector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fallback: Option<String>,
}

/// A picture's frame when the stored form has none.
pub(super) fn no_float() -> PictureFloat {
    PictureFloat { place: Float::default(), adjust: PictureAdjust::default(), layer: None, word_copy: None, fallback: None }
}

impl Deref for PictureFloat {
    type Target = Float;
    fn deref(&self) -> &Float {
        &self.place
    }
}

impl DerefMut for PictureFloat {
    fn deref_mut(&mut self) -> &mut Float {
        &mut self.place
    }
}

impl PictureFloat {
    /// Its colour and corrections.
    pub fn adjust(&self) -> &PictureAdjust {
        &self.adjust
    }
    /// The picture Word 2010's corrections were drawn from.
    pub fn layer(&self) -> Option<&str> {
        self.layer.as_deref()
    }
    /// The picture Word showed over an HD Photo `layer`.
    pub fn word_copy(&self) -> Option<&WordCopy> {
        self.word_copy.as_ref()
    }
    /// An SVG picture's PNG copy.
    pub fn fallback(&self) -> Option<&str> {
        self.fallback.as_deref()
    }
    /// Whether its sources keep the rule every edit keeps ([`in_step`]).
    pub fn in_step(&self) -> bool {
        in_step(&self.adjust, self.layer.as_deref(), self.word_copy.as_ref())
    }
}

/// engine-pictures-3's rule for what a picture is drawn from: a layer only under settings in the pixels (it is what they were
/// drawn from), and Word's copy only beside a layer (an HD Photo original). [`InlineObject::set_bitmap`] keeps it by
/// construction, and [`Picture::build`] drops what a file gives against it.
fn in_step(adjust: &PictureAdjust, layer: Option<&str>, word_copy: Option<&WordCopy>) -> bool {
    (layer.is_none() || adjust.in_pixels()) && (word_copy.is_none() || layer.is_some())
}

/// What a picture is drawn from, as an edit gives it to [`InlineObject::set_bitmap`].
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    /// The media key of the bitmap pixel edits apply to and Word 2010's corrections are drawn on.
    pub key: String,
    /// Word's HD Photo original and the settings Word drew from it into `key`. The engine can't take those out, so they are
    /// the least the picture has.
    pub hd: Option<(String, PictureAdjust)>,
    /// An SVG source's PNG copy.
    pub fallback: Option<String>,
}

/// A new picture, or one a file holds, before it is an [`InlineObject::Image`]: what Insert › Pictures, the file readers and
/// an export's copies build one from. [`Picture::build`] keeps its sources to the rule an edit keeps.
#[derive(Clone, Debug, Default)]
pub struct Picture {
    /// Key in `Document::media`: what it shows.
    pub media: String,
    /// Display size, points.
    pub w: f32,
    pub h: f32,
    pub alt: String,
    pub float: Float,
    /// Crop (left, top, right, bottom) fractions 0..1.
    pub crop: [f32; 4],
    pub ole: Option<Arc<crate::graphic::Embedded>>,
    /// Its colour and corrections.
    pub adjust: PictureAdjust,
    /// The picture the settings in its pixels were drawn from (`a14:imgLayer`).
    pub layer: Option<String>,
    /// The picture Word showed over an HD Photo `layer`.
    pub word_copy: Option<WordCopy>,
    /// An SVG picture's PNG copy.
    pub fallback: Option<String>,
}

impl Picture {
    /// The picture as an object. A layer under no settings in the pixels, or a Word copy beside no layer, is dropped: it
    /// would break the rule ([`in_step`]) an edit then counts on.
    pub fn build(self) -> InlineObject {
        let Picture { media, w, h, alt, float, crop, ole, adjust, layer, word_copy, fallback } = self;
        let layer = layer.filter(|_| adjust.in_pixels());
        let word_copy = word_copy.filter(|_| layer.is_some());
        InlineObject::Image { media: Media(media), w, h, alt, float: PictureFloat { place: float, adjust, layer, word_copy, fallback }, crop, ole }
    }
}

impl InlineObject {
    /// The one edit of a picture's bitmap (engine-pictures-3): the picture drawn from `src` with settings `adjust`, and cropped
    /// by `crop` when given. The settings in the pixels (Word 2010's) are drawn into a copy of the source by `draw` (the
    /// source's key and the settings, to the copy's key), and the source is kept as the layer; without them the picture shows
    /// its source. Over an HD Photo original, Word's settings stand for the ones the source has in it already: the original
    /// stays as the layer, and the source as Word's copy. Anything but a picture is left as it is.
    pub fn set_bitmap<E>(
        &mut self,
        src: Source,
        adjust: PictureAdjust,
        crop: Option<[f32; 4]>,
        draw: impl FnOnce(&str, &PictureAdjust) -> Result<String, E>,
    ) -> Result<(), E> {
        let InlineObject::Image { media, float, crop: c, .. } = self else { return Ok(()) };
        let mut adjust = adjust.sanitized();
        if let Some((_, w)) = &src.hd
            && (!adjust.in_pixels() || adjust.same_pixels(w))
        {
            adjust = adjust.with_pixels_of(w);
        }
        let drawn = match &src.hd {
            Some((_, w)) => !adjust.same_pixels(w),
            None => adjust.in_pixels(),
        };
        media.0 = if drawn { draw(&src.key, &adjust)? } else { src.key.clone() };
        let Source { key, hd, fallback } = src;
        (float.layer, float.word_copy) = match hd {
            Some((hd, w)) => (Some(hd), Some(WordCopy { media: key, adjust: w })),
            None => (drawn.then_some(key), None),
        };
        float.adjust = adjust;
        float.fallback = fallback;
        if let Some(crop) = crop {
            *c = crop;
        }
        Ok(())
    }

    /// An export's copy of a picture showing `shown`, which is the picture with the settings drawn over it (Word 2007's:
    /// colour, transparency, a transparent colour) drawn in, so those settings go. For a format without them (HTML, ODT, RTF).
    pub fn draw_live_in(&mut self, shown: String) {
        if let InlineObject::Image { media, float, .. } = self {
            media.0 = shown;
            float.adjust = PictureAdjust { lum: None, recolor: None, transparency: 0.0, clear: None, ..float.adjust.clone() };
        }
    }

    /// Each media key this object holds renamed by `f`, to a key for the same bytes (another document's, or a hash to compare
    /// by): a picture's own, the picture its corrections were drawn from, its PNG copy and Word's copy, a picture fill's, a
    /// chart's pictures and its group members'.
    pub fn rename_media(&mut self, f: &mut dyn FnMut(&str) -> String) {
        fn set(k: &mut String, f: &mut dyn FnMut(&str) -> String) {
            *k = f(k);
        }
        match self {
            InlineObject::Image { media, float, .. } => {
                set(&mut media.0, f);
                let PictureFloat { layer, word_copy, fallback, .. } = float;
                for k in layer.iter_mut().chain(fallback.iter_mut()).chain(word_copy.iter_mut().map(|c| &mut c.media)) {
                    set(k, f);
                }
            }
            InlineObject::Shape { fill: Some(Fill::Picture(p)), .. } => set(&mut Arc::make_mut(p).media, f),
            // Copied only when it holds a picture: a chart is shared with the document it came from.
            InlineObject::Graphic { graphic, .. } if graphic.items.iter().any(|i| matches!(i, GraphicItem::Image { .. })) => {
                for i in &mut Arc::make_mut(graphic).items {
                    if let GraphicItem::Image { media, .. } = i {
                        set(media, f);
                    }
                }
            }
            InlineObject::Group { children, .. } => children.iter_mut().for_each(|c| c.obj.rename_media(f)),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_pixels() -> PictureAdjust {
        PictureAdjust { brightness: 40.0, ..Default::default() }
    }

    fn parts(o: &InlineObject) -> (&str, &PictureFloat) {
        let InlineObject::Image { media, float, .. } = o else { panic!("a picture") };
        (media.as_str(), float)
    }

    /// The stored form is the one before the bitmap had an owner: `media` beside the frame, the settings and sources in
    /// `float` after its placement.
    #[test]
    fn the_stored_form_keeps_its_shape() {
        let word = WordCopy { media: "w.png".into(), adjust: in_pixels() };
        let o = Picture {
            media: "a.png".into(),
            w: 10.0,
            h: 5.0,
            float: Float { x: 2.0, ..Default::default() },
            adjust: in_pixels(),
            layer: Some("o.wdp".into()),
            word_copy: Some(word),
            fallback: Some("f.png".into()),
            ..Default::default()
        }
        .build();
        let json = serde_json::to_string(&o).unwrap();
        let place = serde_json::to_string(&Float { x: 2.0, ..Default::default() }).unwrap();
        let place = place.strip_suffix('}').unwrap();
        let want = format!(
            r#"{{"type":"image","media":"a.png","w":10.0,"h":5.0,"alt":"","float":{place},"adjust":{{"brightness":40.0}},"layer":"o.wdp","wordCopy":{{"media":"w.png","adjust":{{"brightness":40.0}}}},"fallback":"f.png"}},"crop":[0.0,0.0,0.0,0.0]}}"#
        );
        assert_eq!(json, want);
        assert_eq!(serde_json::from_str::<InlineObject>(&want).unwrap(), o);
        // A frame with none of them, and a picture with no frame.
        let bare: InlineObject = serde_json::from_str(r#"{"type":"image","media":"a.png","w":1.0,"h":1.0}"#).unwrap();
        assert_eq!(parts(&bare).1, &no_float());
    }

    #[test]
    fn a_file_s_sources_against_the_rule_are_dropped() {
        let layered = |adjust: PictureAdjust, layer: Option<&str>| {
            let word = WordCopy { media: "w.png".into(), adjust: in_pixels() };
            Picture { media: "a.png".into(), adjust, layer: layer.map(String::from), word_copy: Some(word), ..Default::default() }.build()
        };
        let kept = layered(in_pixels(), Some("o.png"));
        assert!(parts(&kept).1.in_step() && parts(&kept).1.layer() == Some("o.png") && parts(&kept).1.word_copy().is_some());
        // Live settings only: nothing was drawn from a layer.
        let live = layered(PictureAdjust { transparency: 50.0, ..Default::default() }, Some("o.png"));
        assert!(parts(&live).1.layer().is_none() && parts(&live).1.word_copy().is_none());
        // Word's copy stands only beside an HD Photo layer.
        let alone = layered(in_pixels(), None);
        assert!(parts(&alone).1.word_copy().is_none() && parts(&alone).1.in_step());
    }

    /// The edit draws the shown picture from the source, keeps the source as the layer, and calls `draw` only when the
    /// settings in the pixels need drawing.
    #[test]
    fn an_edit_draws_the_picture_from_its_source() {
        let mut o = Picture { media: "a.png".into(), ..Default::default() }.build();
        let src = |key: &str| Source { key: key.into(), hd: None, fallback: None };
        let drew = std::cell::RefCell::new(Vec::new());
        let draw = |k: &str, _: &PictureAdjust| -> Result<String, ()> {
            drew.borrow_mut().push(k.to_string());
            Ok("drawn.png".into())
        };
        o.set_bitmap(src("a.png"), in_pixels(), Some([0.1, 0.0, 0.0, 0.0]), draw).unwrap();
        let InlineObject::Image { crop, .. } = &o else { panic!("a picture") };
        assert_eq!((parts(&o).0, parts(&o).1.layer(), *crop), ("drawn.png", Some("a.png"), [0.1, 0.0, 0.0, 0.0]));
        // Settings drawn over the picture only: it shows its source, with no layer.
        o.set_bitmap(src("a.png"), PictureAdjust { transparency: 20.0, ..Default::default() }, None, draw).unwrap();
        assert_eq!((parts(&o).0, parts(&o).1.layer()), ("a.png", None));
        assert_eq!(drew.borrow().len(), 1);
        // Over an HD Photo original: Word's settings need no drawing, and the original and Word's copy stay.
        let hd = Source { key: "word.png".into(), hd: Some(("o.wdp".into(), in_pixels())), fallback: None };
        o.set_bitmap(hd.clone(), PictureAdjust::default(), None, draw).unwrap();
        let (m, f) = parts(&o);
        assert_eq!((m, f.layer(), f.word_copy().map(|w| w.media.as_str()), f.adjust()), ("word.png", Some("o.wdp"), Some("word.png"), &in_pixels()));
        assert!(f.in_step() && drew.borrow().len() == 1);
        o.set_bitmap(hd, PictureAdjust { brightness: -20.0, ..Default::default() }, None, draw).unwrap();
        assert_eq!((parts(&o).0, drew.borrow()[1].as_str()), ("drawn.png", "word.png"));
    }

    #[test]
    fn renaming_reaches_every_key_a_picture_holds() {
        let mut o = Picture {
            media: "a".into(),
            adjust: in_pixels(),
            layer: Some("b".into()),
            word_copy: Some(WordCopy { media: "c".into(), adjust: in_pixels() }),
            fallback: Some("d".into()),
            ..Default::default()
        }
        .build();
        o.rename_media(&mut |k| format!("{k}2"));
        let (m, f) = parts(&o);
        assert_eq!((m, f.layer(), f.word_copy().map(|w| w.media.as_str()), f.fallback()), ("a2", Some("b2"), Some("c2"), Some("d2")));
    }
}
