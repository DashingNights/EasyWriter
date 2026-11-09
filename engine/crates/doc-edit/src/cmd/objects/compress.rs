//! EasyWriter engine-gaps-pictures: Compress Pictures (probe dialogs/compress-pictures.json): the selected picture, or every
//! picture in the body, resampled to a resolution of its drawn size and with its cropped areas deleted, in one undo step.
//! A photo goes back as a JPEG, a picture with clear pixels as a PNG, and a picture that would not get smaller keeps its
//! data unless its crop was deleted. Metafiles and other pictures the engine cannot decode are left alone, as Word compresses
//! no vector picture. EasyWriter engine-pictures-3: both work on the picture's source (the bitmap under Word 2010's
//! corrections), which are drawn on it again, so the next correction keeps them.

use super::picture::{Change, Drawn, adjust, edit_pixels, png};
use super::select::{all_objects, selected};
use super::{CmdError, CmdResult, InlineObject, Session, Value, json, p};

/// Most pictures one compression rewrites.
const MAX_PICTURES: usize = 2000;
/// JPEG quality of a compressed photo, as the DOM editor's Compress Pictures gives it.
const JPEG_QUALITY: u8 = 85;

pub(super) fn compress(s: &mut Session, v: &Value) -> CmdResult {
    // The original form: the longest side capped at `maxPixels`.
    if let Some(max) = p::u64(v, "maxPixels") {
        let max = max.clamp(32, 20000) as u32;
        return adjust(s, Change::Resample, move |img| Ok(if img.width().max(img.height()) > max { img.resize(max, max, image::imageops::FilterType::Lanczos3) } else { img }));
    }
    let ppi = p::f32(v, "ppi").filter(|v| *v >= 1.0).map(|v| v.min(2400.0));
    let bake = p::bool(v, "deleteCropped").unwrap_or(false);
    let targets: Vec<_> = if p::bool(v, "all").unwrap_or(false) {
        all_objects(s).into_iter().filter(|(_, o)| matches!(o, InlineObject::Image { .. })).take(MAX_PICTURES).collect()
    } else {
        match selected(s) {
            Some(t @ (_, InlineObject::Image { .. })) => vec![t],
            _ => return Err(CmdError::Disabled("no picture".into())),
        }
    };
    let mut done = 0;
    for (pos, o) in targets {
        let InlineObject::Image { w, crop, .. } = &o else { continue };
        let w = *w;
        // Delete cropped areas: the part the crop shows, when no side is cropped outward (a negative crop).
        let cut = bake && crop.iter().all(|c| *c >= 0.0) && crop.iter().any(|c| *c > 0.0);
        // A picture that cannot be decoded is left alone.
        let change = if cut { Change::Cut } else { Change::Resample };
        if let Ok(Some(_)) = edit_pixels(&mut *s, &pos, None, change, |bytes, img, crop| Ok(compressed(bytes, img, crop, w, ppi, cut)?)) {
            done += 1;
        }
    }
    Ok(json!({"compressed": done}))
}

/// Source `img` (stored as `bytes`, cropped by `crop`, drawn `w` points wide) at `ppi` and with its cropped areas deleted
/// when `cut`; None when nothing would change or it would not get smaller.
fn compressed(bytes: &[u8], img: image::DynamicImage, crop: [f32; 4], w: f32, ppi: Option<f32>, cut: bool) -> Result<Option<Drawn>, CmdError> {
    let (iw, ih) = (img.width(), img.height());
    let (img, crop) = if cut {
        let px = |f: f32, len: u32| ((f.clamp(0.0, 1.0) * len as f32).round() as u32).min(len.saturating_sub(1));
        let (x0, y0) = (px(crop[0], iw), px(crop[1], ih));
        let (x1, y1) = ((iw - px(crop[2], iw)).max(x0 + 1), (ih - px(crop[3], ih)).max(y0 + 1));
        (img.crop_imm(x0, y0, x1 - x0, y1 - y0), [0.0; 4])
    } else {
        (img, crop)
    };
    // The drawn width shows the part the crop leaves: the pixels the whole picture needs for it at `ppi` (points are 72 to
    // the inch), never more than it has.
    let shown = (1.0 - crop[0] - crop[2]).max(0.05);
    let want = ppi.map(|ppi| ((w / shown / 72.0 * ppi).round().max(1.0) as u32).min(img.width()));
    let img = match want {
        Some(nw) if nw < img.width() => {
            let nh = ((img.height() as f32 * nw as f32 / img.width() as f32).round() as u32).max(1);
            img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3)
        }
        _ if !cut => return Ok(None),
        _ => img,
    };
    let clear = img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p.0[3] < 255);
    let out = if clear {
        png(&img)?
    } else {
        let rgb = img.to_rgb8();
        ew_geom::picture::jpeg(&rgb, rgb.width(), rgb.height(), JPEG_QUALITY).map_err(|e| CmdError::Failed(e.to_string()))?
    };
    if !cut && out.len() >= bytes.len() {
        return Ok(None);
    }
    Ok(Some((out, if clear { "png" } else { "jpeg" }, crop)))
}
