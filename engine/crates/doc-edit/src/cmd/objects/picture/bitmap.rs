//! EasyWriter engine-pictures-3: the one way to change a picture's bitmap.
//!
//! A picture is drawn from its source, the bitmap pixel edits apply to, and its settings ([`PictureAdjust`]). With Word
//! 2010's corrections (the settings in the pixels) the picture shows a copy of the source with them drawn in, and the source
//! is kept beside it (its layer, Word's `a14:imgLayer`); when Word's original is HD Photo, which the engine can't decode, the
//! source is the picture Word showed (its Word copy). Those are private to ew-doc (engine-picture-writer), whose
//! `InlineObject::set_bitmap` is the one way to change them: an edit says what the source and the settings become, and
//! [`put`] draws the picture from them, so no edit can change the shown picture and leave its source behind.

use ew_doc::Pos;
use ew_doc::adjust::{PictureAdjust, WordCopy};
use ew_doc::para::{PictureFloat, Source};

use super::super::select::{edit_obj, selected};
use super::super::{CmdError, CmdResult, InlineObject, Session, Value, json};

#[cfg(test)]
mod tests;

/// The source of picture `media` placed by `float`: its original under Word 2010's corrections when the engine can read
/// it, the picture Word showed over an HD Photo original, else the picture itself.
fn bitmap(s: &Session, media: &str, float: &PictureFloat) -> Source {
    let fallback = float.fallback().map(str::to_string);
    match float.layer() {
        Some(l) if readable(s, l) => Source { key: l.to_string(), hd: None, fallback },
        Some(l) => {
            let w = word_copy(s, media, float);
            Source { key: w.media, hd: Some((l.to_string(), w.adjust)), fallback }
        }
        None => Source { key: media.to_string(), hd: None, fallback },
    }
}

/// The media key of the bitmap pixel edits apply to for picture `media` placed by `float` (see [`bitmap`]).
pub(in crate::cmd::objects) fn source(s: &Session, media: &str, float: &PictureFloat) -> String {
    bitmap(s, media, float).key
}

/// A picture's bitmap edit: the picture at `pos` drawn from `src` with settings `adjust`, and cropped by `crop` when given
/// (`InlineObject::set_bitmap`). The settings in the pixels are drawn into a copy of the source, drawn again only when the
/// source or those settings change.
fn put(s: &mut Session, pos: &Pos, src: Source, adjust: PictureAdjust, crop: Option<[f32; 4]>) -> Result<InlineObject, CmdError> {
    let mut o = object_at(s, pos)?;
    let InlineObject::Image { media, float, .. } = &o else { return Err(not_a_picture()) };
    // The copy the picture shows now, when it is drawn from the same source.
    let now = (bitmap(s, media, float) == src).then(|| (media.to_string(), float.adjust().clone()));
    o.set_bitmap(src, adjust, crop, |key, adjust| match now {
        Some((now, was)) if adjust.same_pixels(&was) => Ok(now),
        _ => bake(s, key, adjust),
    })?;
    edit_obj(s, pos, |x| x.clone_from(&o))
}

/// The object at `pos`.
fn object_at(s: &Session, pos: &Pos) -> Result<InlineObject, CmdError> {
    s.doc.para(pos.story, &pos.path).and_then(|p| p.object_at(pos.off)).cloned().ok_or_else(|| CmdError::Failed("object vanished".into()))
}

fn not_a_picture() -> CmdError {
    CmdError::Disabled("not a picture".into())
}

/// The selected picture.
fn picked(s: &Session) -> Result<(Pos, InlineObject), CmdError> {
    let (pos, o) = selected(s).ok_or_else(|| CmdError::Disabled("no picture".into()))?;
    if !matches!(o, InlineObject::Image { .. }) {
        return Err(not_a_picture());
    }
    Ok((pos, o))
}

fn object_json(o: &InlineObject) -> Value {
    json!({"object": serde_json::to_value(o).unwrap_or(Value::Null)})
}

/// The selected picture's colour and corrections changed by `change`, kept as settings. The ones in the pixels (Word 2010's)
/// are drawn again from the source whenever they change, so changes never stack, and the source is never written over.
pub(in crate::cmd::objects) fn set_adjust(s: &mut Session, change: impl FnOnce(&mut PictureAdjust)) -> CmdResult {
    let (pos, o) = picked(s)?;
    let InlineObject::Image { media, float, .. } = &o else { return Err(not_a_picture()) };
    let mut adj = float.adjust().clone();
    change(&mut adj);
    let b = bitmap(s, media, float);
    put(s, &pos, b, adj, None).map(|o| object_json(&o))
}

/// What a pixel edit draws: the new source's bytes and file extension, and the crop over it.
pub(in crate::cmd::objects) type Drawn = (Vec<u8>, &'static str, [f32; 4]);

/// What a pixel edit changes, which decides what stays of the picture's past.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::cmd::objects) enum Change {
    /// Only the resolution (Compress Pictures by ppi or to a pixel count): Word's HD Photo original still stands for it, and
    /// Reset Picture and Original Size still count from the picture the edits started from.
    Resample,
    /// The pixels (a look, Remove Background): Reset Picture still goes back to the picture the edits started from.
    Pixels,
    /// Delete cropped areas: the cropped part is gone, as in Word, so the part kept is the picture's original for Reset
    /// Picture and Original Size (engine-fixes-2-edit: they counted from the uncropped picture, and Original Size stretched
    /// the kept part to its shape).
    Cut,
}

/// A pixel edit on the picture at `pos`: `f` gets the source's bytes, its pixels and the crop, or those of bitmap `from`
/// instead (a look drawn again from the bitmap under it), and gives back what it drew, or None to leave the picture as it
/// is. What it drew becomes the source, and the settings are drawn on it again.
///
/// Over an HD Photo original, which the edit can't reach, the original stays only for a [`Change::Resample`] (the original
/// still stands for it). Otherwise it goes: Word would draw its corrections again from it and lose the edit (or squeeze a
/// deleted crop back into the frame), so the picture keeps what it shows, and Word's settings, already in the source, stop
/// being settings. Returns the new source's key.
pub(in crate::cmd::objects) fn edit_pixels(
    s: &mut Session,
    pos: &Pos,
    from: Option<&str>,
    change: Change,
    f: impl FnOnce(&[u8], image::DynamicImage, [f32; 4]) -> Result<Option<Drawn>, CmdError>,
) -> Result<Option<String>, CmdError> {
    let InlineObject::Image { media, float, crop, .. } = object_at(s, pos)? else { return Err(not_a_picture()) };
    let b = bitmap(s, &media, &float);
    let base = from.map_or_else(|| b.key.clone(), str::to_string);
    let bytes = s.doc.media.get(&base).cloned().ok_or_else(|| CmdError::Failed("picture data missing".into()))?;
    let Some((out, ext, crop)) = f(&bytes, decode(&bytes)?, crop)? else { return Ok(None) };
    let key = s.doc.add_media(out, ext);
    // Reset Picture and Original Size find the picture the edits started from: a picture with no entry is its own.
    if change == Change::Cut {
        s.originals.remove(&key);
    } else {
        let orig = s.originals.get(&base).cloned().unwrap_or(base);
        s.originals.entry(key.clone()).or_insert(orig);
    }
    let mut adjust = float.adjust().clone();
    let hd = match b.hd {
        Some(hd) if change == Change::Resample => Some(hd),
        Some((_, w)) => {
            if adjust.same_pixels(&w) {
                adjust = adjust.with_pixels_of(&PictureAdjust::default());
            }
            None
        }
        None => None,
    };
    put(s, pos, Source { key: key.clone(), hd, fallback: b.fallback }, adjust, Some(crop))?;
    Ok(Some(key))
}

/// The picture at `pos` drawn from bitmap `key` again (its looks taken off: the bitmap under them), its settings kept.
pub(in crate::cmd::objects) fn restore(s: &mut Session, pos: &Pos, key: &str) -> CmdResult {
    let InlineObject::Image { media, float, .. } = object_at(s, pos)? else { return Err(not_a_picture()) };
    let b = bitmap(s, &media, &float);
    put(s, pos, Source { key: key.to_string(), ..b }, float.adjust().clone(), None).map(|o| object_json(&o))
}

/// Reset Picture: the picture the edits started from, with no settings and no crop. Over an HD Photo original, which the
/// engine can't draw: the picture Word showed with Word's settings, and the HD Photo kept so Word can still reset it.
pub(in crate::cmd::objects) fn reset(s: &mut Session, _: &Value) -> CmdResult {
    let (pos, o) = picked(s)?;
    let InlineObject::Image { media, float, .. } = &o else { return Err(not_a_picture()) };
    let mut b = bitmap(s, media, float);
    if b.hd.is_none() {
        // Session memory: it may name a picture an undo or a reload took away.
        b.key = s.originals.get(&b.key).filter(|k| s.doc.media.contains_key(*k)).cloned().unwrap_or(b.key);
    }
    put(s, &pos, b, PictureAdjust::default(), Some([0.0; 4]))?;
    edit_obj(s, &pos, |o| {
        if let Some(float) = o.float_mut() {
            // EasyWriter engine-gaps-pictures: Reset Picture also takes off the outline, the effects and Crop to Shape, as
            // Word's does.
            float.outline = None;
            float.fx = Default::default();
            float.crop_shape = None;
            float.effect = [0.0; 4];
        }
    })
    .map(|o| object_json(&o))
}

/// Change Picture: the selected picture shows media `key` (an SVG's PNG copy `fallback`). The corrections in the old picture's
/// pixels go with it; the settings drawn over the picture stay.
pub(in crate::cmd::objects) fn replace(s: &mut Session, key: String, fallback: Option<String>) -> CmdResult {
    let (pos, o) = picked(s)?;
    let InlineObject::Image { float, .. } = &o else { return Err(not_a_picture()) };
    let adjust = float.adjust().with_pixels_of(&PictureAdjust::default());
    put(s, &pos, Source { key, hd: None, fallback }, adjust, None).map(|o| object_json(&o))
}

/// The picture Word showed for picture `media` placed by `float` over its HD Photo original: the one kept from an earlier
/// change, else the picture as it is now with its settings.
fn word_copy(s: &Session, media: &str, float: &PictureFloat) -> WordCopy {
    float.word_copy().cloned().unwrap_or_else(|| WordCopy {
        media: s.originals.get(media).filter(|o| s.doc.media.contains_key(*o)).cloned().unwrap_or_else(|| media.to_string()),
        adjust: float.adjust().clone(),
    })
}

/// Whether media `key` is a bitmap the engine can decode (Word's HD Photo originals are not).
pub(in crate::cmd::objects) fn readable(s: &Session, key: &str) -> bool {
    s.doc.media.get(key).is_some_and(|b| ew_geom::picture::probe(b).is_ok())
}

/// `bytes` decoded within the budget pictures are drawn within, checked from the header first (#3644, #3647).
fn decode(bytes: &[u8]) -> Result<image::DynamicImage, CmdError> {
    ew_geom::picture::decode(bytes, ew_geom::MAX_DECODED_BYTES).map_err(|e| match e {
        ew_geom::picture::Refusal::TooLarge { .. } => super::too_large(),
        e => CmdError::Failed(format!("can't decode the picture: {e}")),
    })
}

/// The picture `base` with Word 2010's adjustments `a` in its pixels, stored as a new PNG: its media key.
fn bake(s: &mut Session, base: &str, a: &PictureAdjust) -> Result<String, CmdError> {
    let bytes = s.doc.media.get(base).cloned().ok_or_else(|| CmdError::Failed("picture data missing".into()))?;
    let png = ew_geom::picture::png(&super::in_pixels(decode(&bytes)?, a)).map_err(|e| CmdError::Failed(e.to_string()))?;
    let key = s.doc.add_media(png, "png");
    // Reset Picture and Original Size find what it was drawn from.
    let orig = s.originals.get(base).cloned().unwrap_or_else(|| base.to_string());
    s.originals.entry(key.clone()).or_insert(orig);
    Ok(key)
}
