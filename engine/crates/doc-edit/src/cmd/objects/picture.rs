use ew_doc::adjust::{Artistic, PictureAdjust, Recolor, WASHOUT, sepia};

use super::select::{obj_size, selected, with_obj};
use super::{CmdError, CmdResult, InlineObject, Rgb, Session, Value, Wrap, json, p};

// EasyWriter engine-pictures-3: the one way to change a picture's bitmap.
mod bitmap;
mod artistic;
use bitmap::{reset, restore, set_adjust};
#[cfg(test)]
use bitmap::readable;
pub(super) use bitmap::{Change, Drawn, edit_pixels, source};

/// `picture.crop`: the crop, and optionally the new display size, as one edit. With a size, a
/// floating picture positioned by offsets moves by what the crop on its left/top side on the page
/// trims (or restores) — for a flipped picture that's the source's right/bottom — so what stays
/// visible keeps its place on the page: a crop handle drop is one command.
pub(super) fn crop(s: &mut Session, v: &Value) -> CmdResult {
    let mut c = [p::f32(v, "left"), p::f32(v, "top"), p::f32(v, "right"), p::f32(v, "bottom")].map(|x| x.unwrap_or(0.0).clamp(0.0, 0.95));
    // The two sides of an axis keep at least 5% of the source between them, as the renderer
    // draws it: the second side stops where the first one already left less than that.
    c[2] = c[2].min(0.95 - c[0]);
    c[3] = c[3].min(0.95 - c[1]);
    let size = |k: &str| p::f32(v, k).map(|x| x.clamp(1.0, 4000.0));
    let (nw, nh) = (size("width"), size("height"));
    with_obj(s, |o| {
        if let InlineObject::Image { crop, w, h, float, .. } = o {
            // The source's full size at the new display size (the visible part is 1-lo-hi of it).
            let full = |len: f32, lo: f32, hi: f32| len / (1.0 - lo - hi).max(0.05);
            // Flipped, the source's right (bottom) edge is the one on the page's left (top).
            let (left, top) = (if float.flip_h { 2 } else { 0 }, if float.flip_v { 3 } else { 1 });
            if let Some(nw) = nw {
                if float.wrap != Wrap::Inline && float.h_align.is_none() {
                    float.x += (c[left] - crop[left]) * full(nw, c[0], c[2]);
                }
                *w = nw;
            }
            if let Some(nh) = nh {
                if float.wrap != Wrap::Inline && float.v_align.is_none() {
                    float.y += (c[top] - crop[top]) * full(nh, c[1], c[3]);
                }
                *h = nh;
            }
            *crop = c;
        }
    })
}

/// A picture's original size: its image's pixels at 96 ppi (the size Insert › Pictures gives it)
/// or a metafile's own frame, before any crop.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OriginalSize {
    /// Points.
    pub w: f32,
    pub h: f32,
    /// A bitmap's pixels (None for a metafile).
    pub pixels: Option<(u32, u32)>,
}

/// The original size of the picture showing `media`, read from the image its Picture Format
/// adjustments started from (Compress Pictures may have resampled the current one); None when the
/// image can't be read.
pub fn original_size(s: &Session, media: &str) -> Option<OriginalSize> {
    let key = s.originals.get(media).map_or(media, String::as_str);
    let bytes = s.doc.media.get(key).or_else(|| s.doc.media.get(media))?;
    if let Some((pw, ph)) = ew_scene::image_size(bytes) {
        return Some(OriginalSize { w: pw as f32 * 0.75, h: ph as f32 * 0.75, pixels: Some((pw, ph)) });
    }
    let (w, h, _) = ew_scene::metafile_size(bytes)?;
    Some(OriginalSize { w, h, pixels: None })
}

/// What a picture's crop leaves of its original size: the size Reset gives back and what a scale
/// of the original counts from. None for anything but a picture whose image can be read.
pub fn cropped_original_size(s: &Session, o: &InlineObject) -> Option<(f32, f32)> {
    let InlineObject::Image { media, crop, .. } = o else { return None };
    let orig = original_size(s, media)?;
    let part = |lo: f32, hi: f32| (1.0 - lo - hi).max(0.05);
    Some((orig.w * part(crop[0], crop[2]), orig.h * part(crop[1], crop[3])))
}

/// Size: `scale` is a percentage of the current size, or with `original` of what the crop leaves
/// of the original size (`original` alone gives that back: the Size dialog's Reset); then `width`
/// and `height`, where one alone keeps the proportions unless `lockAspect` is false.
pub(super) fn size(s: &mut Session, v: &Value) -> CmdResult {
    let (_, o) = selected(s).ok_or_else(|| CmdError::Disabled("no object".into()))?;
    let lock = p::bool(v, "lockAspect").unwrap_or(true);
    let (mut w, mut h) = obj_size(&o);
    let scale = p::f32(v, "scale");
    if p::bool(v, "original").unwrap_or(false) {
        let (ow, oh) =
            cropped_original_size(s, &o).ok_or_else(|| CmdError::Disabled("only a picture whose image can be read has an original size".into()))?;
        let k = scale.unwrap_or(100.0) / 100.0;
        (w, h) = (ow * k, oh * k);
    } else if let Some(sc) = scale {
        w *= sc / 100.0;
        h *= sc / 100.0;
    }
    let (nw, nh) = (p::f32(v, "width"), p::f32(v, "height"));
    match (nw, nh) {
        (Some(nw), Some(nh)) => {
            w = nw;
            h = nh;
        }
        (Some(nw), None) => {
            if lock && w > 0.0 {
                h *= nw / w;
            }
            w = nw;
        }
        (None, Some(nh)) => {
            if lock && h > 0.0 {
                w *= nh / h;
            }
            h = nh;
        }
        _ => {}
    }
    // A size that keeps the proportions shrinks on both sides to fit, rather than flattening.
    let keep = match (nw, nh) {
        (Some(_), Some(_)) => false,
        (None, None) => true,
        _ => lock,
    };
    let (w, h) = fit_size(w, h, keep);
    // Any drawing: a group's members scale with its frame (its child space is kept); a chart or
    // SmartArt graphic lays itself out again at the new size.
    let theme = s.doc.settings.theme_colors.clone();
    with_obj(s, |o| {
        o.set_size(w, h);
        crate::cmd::chart::redraw(o, &theme);
        crate::cmd::smart_art::redraw(o, &theme);
    })
}

/// An object size within 1–4000 pt. With `keep`, both sides scale by one factor, the one nearest
/// 1 that brings them within the limits, so the proportions hold; a shape too long and thin for any
/// such factor is clamped side by side.
pub fn fit_size(w: f32, h: f32, keep: bool) -> (f32, f32) {
    let side = |x: f32| if x.is_nan() { 1.0 } else { x.clamp(1.0, 4000.0) };
    if keep && w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 {
        let (lo, hi) = ((1.0 / w).max(1.0 / h), (4000.0 / w).min(4000.0 / h));
        if lo <= hi {
            let k = if lo > 1.0 {
                lo
            } else if hi < 1.0 {
                hi
            } else {
                1.0
            };
            return (side(w * k), side(h * k));
        }
    }
    (side(w), side(h))
}

/// Apply an image operation to the selected picture's source, the bitmap under Word 2010's corrections (stored as a new PNG);
/// the corrections are drawn on it again. `change`: what the operation changes ([`edit_pixels`]).
pub(super) fn adjust(s: &mut Session, change: Change, f: impl FnOnce(image::DynamicImage) -> Result<image::DynamicImage, CmdError>) -> CmdResult {
    let (pos, o) = selected(s).ok_or_else(|| CmdError::Disabled("no picture".into()))?;
    if !matches!(o, InlineObject::Image { .. }) {
        return Err(CmdError::Disabled("not a picture".into()));
    }
    edit_pixels(&mut *s, &pos, None, change, |_, img, crop| Ok(Some((png(&f(img)?)?, "png", crop))))?;
    let (_, o) = selected(s).ok_or_else(|| CmdError::Failed("object vanished".into()))?;
    Ok(json!({"object": serde_json::to_value(o).unwrap_or(Value::Null)}))
}

/// `img` as a PNG.
pub(super) fn png(img: &image::DynamicImage) -> Result<Vec<u8>, CmdError> {
    ew_geom::picture::png(img).map_err(|e| CmdError::Failed(e.to_string()))
}

fn too_large() -> CmdError {
    CmdError::Failed("picture is too large to edit".into())
}

/// A `w` × `h` bitmap of `fill` for an edit to draw on, refused when the picture it makes would be
/// too large to draw (two RGBA buffers within the decode budget), before it is allocated (#3611).
fn canvas(w: u32, h: u32, fill: [u8; 4]) -> Result<image::RgbaImage, CmdError> {
    if !ew_geom::decode_fits(w, h, ew_geom::MAX_DECODED_BYTES) {
        return Err(too_large());
    }
    Ok(image::RgbaImage::from_pixel(w, h, image::Rgba(fill)))
}

/// `w` and `h` grown by `pad` on every side, None past `u32`.
pub(super) fn grown(w: u32, h: u32, pad: u32) -> Option<(u32, u32)> {
    let twice = pad.checked_mul(2)?;
    Some((w.checked_add(twice)?, h.checked_add(twice)?))
}

/// What Artistic Effects, Picture Styles and Picture Border drew on a picture's bitmap: the
/// bitmap they started from and the effect, style and border on it, so the next one draws again
/// from that bitmap instead of over the last result. Picking a second style replaces the first,
/// as in Word, instead of framing the frame (#2052). Kept in [`Session::picture_looks`] under the
/// media key of the drawn bitmap.
#[derive(Clone, Debug, Default)]
pub struct PictureLook {
    /// The media key of the bitmap before any of them.
    pub base: String,
    pub effect: Option<String>,
    pub style: Option<String>,
    pub border: Option<(Rgb, u32)>,
    /// The drawn bitmap: a media key that names other bytes later (undo then a new picture
    /// reusing the key) is not this look's.
    pub drawn: std::sync::Arc<Vec<u8>>,
}

/// Change the selected picture's effect, style or border and draw it again from the bitmap
/// under them (effect, then style, then border).
pub(super) fn relook(s: &mut Session, change: impl FnOnce(&mut PictureLook)) -> CmdResult {
    let (pos, o) = selected(s).ok_or_else(|| CmdError::Disabled("no picture".into()))?;
    let InlineObject::Image { media, float, .. } = o else { return Err(CmdError::Disabled("not a picture".into())) };
    // Kept under the bitmap below Word 2010's corrections, so a correction leaves the look in place.
    let media = source(s, &media, &float);
    let cur = s.doc.media.get(&media).cloned();
    let mut look = s
        .picture_looks
        .get(&media)
        .filter(|l| cur.as_ref().is_some_and(|c| std::sync::Arc::ptr_eq(c, &l.drawn)) && s.doc.media.contains_key(&l.base))
        .cloned()
        .unwrap_or_else(|| PictureLook { base: media.clone(), ..Default::default() });
    change(&mut look);
    if look.effect.is_none() && look.style.is_none() && look.border.is_none() {
        // Nothing left on it: the bitmap as it was.
        return restore(s, &pos, &look.base);
    }
    let l = look.clone();
    let key = edit_pixels(&mut *s, &pos, Some(&look.base), Change::Pixels, move |_, img, crop| {
        let mut img = match l.effect.as_deref().and_then(artistic_of) {
            Some(e) => artistic_effect(img, &e),
            None => img,
        };
        if let Some(st) = &l.style {
            img = picture_style(img, st)?;
        }
        if let Some((c, w)) = l.border {
            img = frame(img, w, [c.0, c.1, c.2, 255])?;
        }
        Ok(Some((png(&img)?, "png", crop)))
    })?;
    if let Some(key) = key
        && let Some(drawn) = s.doc.media.get(&key).cloned()
    {
        s.picture_looks.insert(key, PictureLook { drawn, ..look });
    }
    let (_, o) = selected(s).ok_or_else(|| CmdError::Failed("object vanished".into()))?;
    Ok(json!({"object": serde_json::to_value(o).unwrap_or(Value::Null)}))
}

/// An artistic effect drawn into a picture: Blur, the pencil and chalk sketches and Line Drawing (the picture's grey
/// edges on white), Photocopy (black and white along the tones), EasyWriter's own Invert, Posterize and Pixelate, and the
/// other looks in artistic.rs.
fn artistic_effect(img: image::DynamicImage, e: &Artistic) -> image::DynamicImage {
    let side = img.width().max(img.height()) as f32;
    let attr = |k: &str| e.attrs.iter().find(|(n, _)| n == k).map(|(_, v)| *v as f32);
    match e.effect.as_str() {
        "Blur" => {
            let sigma = attr("radius").unwrap_or(10.0).clamp(0.0, 100.0) * side / 1000.0;
            if sigma.is_normal() { img.blur(sigma) } else { img }
        }
        "PencilGrayscale" | "PencilSketch" | "LineDrawing" | "ChalkSketch" | "Photocopy" => sketch(img, side, e.effect == "Photocopy"),
        "Invert" => {
            let mut i = img;
            i.invert();
            i
        }
        "Posterize" => {
            let mut rgba = img.to_rgba8();
            for px in rgba.pixels_mut() {
                for c in px.0.iter_mut().take(3) {
                    *c = (*c / 64) * 85;
                }
            }
            image::DynamicImage::ImageRgba8(rgba)
        }
        "Pixelate" => {
            let (w, h) = (img.width().max(1), img.height().max(1));
            img.resize_exact((w / 12).max(1), (h / 12).max(1), image::imageops::FilterType::Nearest).resize_exact(w, h, image::imageops::FilterType::Nearest)
        }
        name => artistic::stylise(img, name),
    }
}

/// The picture as a grey sketch: a colour dodge of it by its blur, so flat areas go white and edges stay dark; for a
/// photocopy, black where the picture is darker than its surroundings.
fn sketch(img: image::DynamicImage, side: f32, photocopy: bool) -> image::DynamicImage {
    let grey = img.to_luma8();
    let soft = image::DynamicImage::ImageLuma8(grey.clone()).blur((side / 200.0).max(1.0)).to_luma8();
    let mut rgba = img.to_rgba8();
    for (x, y, px) in rgba.enumerate_pixels_mut() {
        let (g, s) = (f32::from(grey.get_pixel(x, y).0[0]), f32::from(soft.get_pixel(x, y).0[0]));
        let v = if photocopy {
            if g + 12.0 < s { 0.0 } else { 255.0 }
        } else {
            (g * 255.0 / s.max(1.0)).min(255.0)
        };
        px.0 = [v as u8, v as u8, v as u8, px.0[3]];
    }
    image::DynamicImage::ImageRgba8(rgba)
}

/// Word 2010's adjustments drawn into a picture, in the order Word lists them: the artistic effect, sharpen or soften,
/// tone, saturation, then brightness and contrast.
pub(super) fn in_pixels(img: image::DynamicImage, a: &PictureAdjust) -> image::DynamicImage {
    let mut img = match &a.artistic {
        Some(e) => artistic_effect(img, e),
        None => img,
    };
    if a.sharpen > 0.0 {
        img = img.unsharpen(1.0 + a.sharpen / 50.0, 2);
    } else if a.sharpen < 0.0 && (-a.sharpen / 25.0).is_normal() {
        // `blur` asserts on a subnormal width.
        img = img.blur(-a.sharpen / 25.0);
    }
    let gains = tone_gains(a.temperature.unwrap_or(6500.0));
    let sat = a.saturation.unwrap_or(100.0) / 100.0;
    let (b, c) = (a.brightness, a.contrast);
    let mut rgba = img.to_rgba8();
    for px in rgba.pixels_mut() {
        let [r, g, bl, al] = px.0;
        let toned = [f32::from(r) * gains[0], f32::from(g) * gains[1], f32::from(bl) * gains[2]];
        let l = 0.299 * toned[0] + 0.587 * toned[1] + 0.114 * toned[2];
        let out = toned.map(|v| ew_doc::adjust::lum(l + (v - l) * sat, b, c).round().clamp(0.0, 255.0) as u8);
        px.0 = [out[0], out[1], out[2], al];
    }
    image::DynamicImage::ImageRgba8(rgba)
}

/// RGB of a black body at `k` kelvin (Tanner Helland's fit), 0..255 per channel, as picture-format/pictures.mjs has it.
fn kelvin_rgb(k: f32) -> [f32; 3] {
    let t = k / 100.0;
    let r = if t <= 66.0 { 255.0 } else { 329.698_73 * (t - 60.0).powf(-0.133_204_76) };
    let g = if t <= 66.0 { 99.470_8 * t.ln() - 161.119_57 } else { 288.122_16 * (t - 60.0).powf(-0.075_514_85) };
    let b = if t >= 66.0 {
        255.0
    } else if t <= 19.0 {
        0.0
    } else {
        138.517_73 * (t - 10.0).ln() - 305.044_8
    };
    [r, g, b].map(|v| v.clamp(0.0, 255.0))
}

/// Per-channel gains of Color Tone `k` kelvin, 6500 K neutral, the brightest channel kept at 1.
fn tone_gains(k: f32) -> [f32; 3] {
    let (base, at) = (kelvin_rgb(6500.0), kelvin_rgb(k));
    let g = [0, 1, 2].map(|i| if base[i] > 0.0 { at[i] / base[i] } else { 1.0 });
    let top = g.iter().copied().fold(0.0f32, f32::max).max(1e-6);
    g.map(|v| v / top)
}

/// `picture.color`'s mode as the change it makes: Recolor, Washout, saturation or tone, each kept apart from the others.
fn color_change(a: &mut PictureAdjust, mode: &str, v: &Value) {
    let color = p::str(v, "color").and_then(Rgb::parse).unwrap_or(Rgb(0x15, 0x60, 0x82));
    match mode {
        "saturation" => a.saturation = Some(p::f32(v, "saturation").unwrap_or(100.0)),
        "tone" => a.temperature = Some(p::f32(v, "temperature").unwrap_or(6500.0)),
        "washout" => {
            a.recolor = None;
            a.lum = Some(WASHOUT);
        }
        _ => {
            // A recolour takes Washout's place.
            if a.lum == Some(WASHOUT) {
                a.lum = None;
            }
            a.recolor = match mode {
                "grayscale" => Some(Recolor::Grayscale),
                "sepia" => Some(Recolor::Duotone(Rgb::BLACK, sepia())),
                "blackAndWhite" => Some(Recolor::BlackWhite(p::f32(v, "threshold").unwrap_or(50.0))),
                "dark" => Some(Recolor::Duotone(Rgb::BLACK, color)),
                "light" => Some(Recolor::Duotone(color, Rgb::WHITE)),
                "tint" => Some(Recolor::Duotone(Rgb::BLACK, Rgb(0x3B, 0x5B, 0xDB))),
                _ => None,
            };
        }
    }
}

/// The selected picture's colour and corrections in the Format Picture pane's terms (percent, kelvin, the Recolor
/// gallery's name), as object.get reports them.
pub(super) fn adjust_json(a: &PictureAdjust) -> Value {
    let recolor_color = match a.recolor {
        Some(Recolor::Duotone(from, to)) => Some(if from == Rgb::BLACK { to } else { from }.hex()),
        _ => None,
    };
    let lum = a.lum.filter(|l| *l != WASHOUT);
    json!({
        "brightness": if a.brightness != 0.0 { a.brightness } else { lum.map_or(0.0, |l| l[0]) },
        "contrast": if a.contrast != 0.0 { a.contrast } else { lum.map_or(0.0, |l| l[1]) },
        "sharpness": a.sharpen,
        "saturation": a.saturation.unwrap_or(100.0),
        "temperature": a.temperature.unwrap_or(6500.0),
        "recolor": a.recolor_name(),
        "recolorColor": recolor_color,
        "threshold": match a.recolor { Some(Recolor::BlackWhite(t)) => Some(t), _ => None },
        "transparency": a.transparency,
        "transparentColor": a.clear.map(Rgb::hex),
        "artistic": a.artistic.as_ref().map(|e| e.effect.clone()),
    })
}

/// An artistic effect by Word's gallery name (`a14:artistic*` without its prefix, any case at the start), or EasyWriter's
/// older names; `none` is none.
fn artistic_of(name: &str) -> Option<Artistic> {
    let mut cs = name.chars();
    let effect: String = cs.next().map(|c| c.to_ascii_uppercase()).into_iter().chain(cs).filter(char::is_ascii_alphanumeric).collect();
    if effect.is_empty() || effect == "None" {
        return None;
    }
    let attrs = if effect == "Blur" { vec![("radius".to_string(), 10)] } else { Vec::new() };
    Some(Artistic { effect, attrs })
}

/// Flood the border-connected region close to the corner colour with transparency.
pub(super) fn remove_background(img: image::DynamicImage, tol: f32) -> image::DynamicImage {
    let mut rgba = img.to_rgba8();
    clear_background(&mut rgba, tol);
    image::DynamicImage::ImageRgba8(rgba)
}

/// [`remove_background`] on `rgba`, a row span at a time: besides the border's seeds, the stack
/// holds one for each run of matching pixels beside a filled span, instead of four for every
/// pixel filled (#3647). Returns the most seeds it held.
pub(super) fn clear_background(rgba: &mut image::RgbaImage, tol: f32) -> usize {
    let (w, h) = rgba.dimensions();
    let Some(bg) = rgba.get_pixel_checked(0, 0).map(|p| p.0) else { return 0 };
    let close = |p: [u8; 4]| (0..3).map(|i| (p[i] as f32 - bg[i] as f32).abs()).fold(0.0f32, f32::max) <= tol;
    let at = |x: u32, y: u32| y as usize * w as usize + x as usize;
    // Not cleared yet, and close to the corner colour.
    let open = |rgba: &image::RgbaImage, seen: &[bool], x: u32, y: u32| {
        !seen.get(at(x, y)).copied().unwrap_or(true) && rgba.get_pixel_checked(x, y).is_some_and(|p| close(p.0))
    };
    let mut seen = vec![false; (w as usize) * (h as usize)];
    let mut stack = border_pixels(w, h);
    let mut most = stack.len();
    while let Some((x, y)) = stack.pop() {
        if !open(rgba, &seen, x, y) {
            continue;
        }
        let (x0, x1) = run_span(x, y, w, |xi, yi| open(rgba, &seen, xi, yi));
        for xi in x0..=x1 {
            if let Some(s) = seen.get_mut(at(xi, y)) {
                *s = true;
            }
            if let Some(p) = rgba.get_pixel_mut_checked(xi, y) {
                p.0[3] = 0;
            }
        }
        for ny in [y.checked_sub(1), y.checked_add(1).filter(|&n| n < h)].into_iter().flatten() {
            push_open_runs(&mut stack, x0, x1, ny, |xi, yi| open(rgba, &seen, xi, yi));
        }
        most = most.max(stack.len());
    }
    most
}

/// Every pixel on the image's edge, the flood-fill seeds.
fn border_pixels(w: u32, h: u32) -> Vec<(u32, u32)> {
    let mut stack = Vec::new();
    for x in 0..w {
        stack.push((x, 0));
        stack.push((x, h - 1));
    }
    for y in 0..h {
        stack.push((0, y));
        stack.push((w - 1, y));
    }
    stack
}

/// The horizontal run of open pixels around `(x, y)`, both ends included.
fn run_span(x: u32, y: u32, w: u32, open: impl Fn(u32, u32) -> bool) -> (u32, u32) {
    let (mut x0, mut x1) = (x, x);
    while x0 > 0 && open(x0 - 1, y) {
        x0 -= 1;
    }
    while x1 + 1 < w && open(x1 + 1, y) {
        x1 += 1;
    }
    (x0, x1)
}

/// Queues the first pixel of each open run in row `ny` between `x0` and `x1`.
fn push_open_runs(stack: &mut Vec<(u32, u32)>, x0: u32, x1: u32, ny: u32, open: impl Fn(u32, u32) -> bool) {
    let mut xi = x0;
    while xi <= x1 {
        if open(xi, ny) {
            stack.push((xi, ny));
            while xi <= x1 && open(xi, ny) {
                xi += 1;
            }
        } else {
            xi += 1;
        }
    }
}

fn frame(img: image::DynamicImage, border: u32, color: [u8; 4]) -> Result<image::DynamicImage, CmdError> {
    let (w, h) = grown(img.width(), img.height(), border).ok_or_else(too_large)?;
    let mut out = canvas(w, h, color)?;
    image::imageops::overlay(&mut out, &img.to_rgba8(), border as i64, border as i64);
    Ok(image::DynamicImage::ImageRgba8(out))
}

pub(super) fn picture_style(img: image::DynamicImage, style: &str) -> Result<image::DynamicImage, CmdError> {
    let m = (img.width().max(img.height()) / 40).max(4);
    Ok(match style {
        "thickFrame" => frame(frame(img, m * 2, [255, 255, 255, 255])?, m / 2, [40, 40, 40, 255])?,
        "rounded" | "softEdge" => {
            let mut rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            let r = (w.min(h) as f32) * if style == "rounded" { 0.12 } else { 0.0 };
            let feather = if style == "softEdge" { (w.min(h) as f32 * 0.08).max(2.0) } else { 1.5 };
            for y in 0..h {
                for x in 0..w {
                    let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
                    let dx = (r - fx).max(fx - (w as f32 - r)).max(0.0);
                    let dy = (r - fy).max(fy - (h as f32 - r)).max(0.0);
                    let edge = (fx.min(w as f32 - fx)).min(fy.min(h as f32 - fy));
                    let inside = if r > 0.0 && dx > 0.0 && dy > 0.0 { r - (dx * dx + dy * dy).sqrt() } else { edge };
                    let k = (inside / feather).clamp(0.0, 1.0);
                    let p = rgba.get_pixel_mut(x, y);
                    p.0[3] = (p.0[3] as f32 * k) as u8;
                }
            }
            image::DynamicImage::ImageRgba8(rgba)
        }
        "shadow" => {
            let (w, h) = (img.width(), img.height());
            let off = m;
            let (pw, ph) = grown(w, h, off).ok_or_else(too_large)?;
            let mut out = canvas(pw, ph, [0, 0, 0, 0])?;
            // A rectangle of alpha 90 the picture's size, one and a half margins in, blurred. Its
            // blur is the product of its sides' blurs along each axis, so it is drawn from two
            // profiles, not by blurring every pixel with a kernel that grows with the picture (#3647).
            let (sigma, start) = (off as f32 / 2.0, off + off / 2);
            let (xs, ys) = (blurred_span(pw, start, w, sigma), blurred_span(ph, start, h, sigma));
            for (x, y, p) in out.enumerate_pixels_mut() {
                let k = xs.get(x as usize).copied().unwrap_or(0.0) * ys.get(y as usize).copied().unwrap_or(0.0);
                p.0[3] = (90.0 * k).round() as u8;
            }
            image::imageops::overlay(&mut out, &img.to_rgba8(), 0, 0);
            image::DynamicImage::ImageRgba8(out)
        }
        _ => frame(img, m, [255, 255, 255, 255])?,
    })
}

/// How much of a span `len` long from `start` covers each of `n` positions once blurred with the
/// Gaussian `image::imageops::blur` uses for `sigma` (outside the `n` positions counts as clear):
/// 0 to 1. Each position is one difference of the kernel's running sums.
fn blurred_span(n: u32, start: u32, len: u32, sigma: f32) -> Vec<f32> {
    let kernel = gaussian_kernel(sigma);
    let mut sums = vec![0.0f32];
    for k in &kernel {
        sums.push(sums.last().copied().unwrap_or(0.0) + k);
    }
    let (size, r) = (kernel.len() as i64, (kernel.len() / 2) as i64);
    let sum_to = |k: i64| sums.get(k.clamp(0, size) as usize).copied().unwrap_or(0.0);
    let (start, end) = (i64::from(start), i64::from(start) + i64::from(len));
    // Position i takes weight k from i + k - r, inside the span for k in [start - i + r, end - i + r).
    (0..i64::from(n)).map(|i| sum_to(end - i + r) - sum_to(start - i + r)).collect()
}

/// The normalized kernel `image::imageops::blur` (0.25) uses for `sigma`: odd, about 6.7 σ wide.
fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let size = ((((sigma - 0.8) / 0.3 + 1.0) * 2.0 + 1.0).max(3.0) as usize) | 1;
    let mean = (size / 2) as f32;
    let weights: Vec<f32> = (0..size).map(|x| (-0.5 * ((x as f32 - mean) / sigma).powi(2)).exp()).collect();
    let total: f32 = weights.iter().sum();
    weights.into_iter().map(|v| v / total).collect()
}

/// EasyWriter engine-pictures-2: the picture `bytes` with the colour settings of `a` drawn on it, as a PNG; None when it has
/// none or cannot be decoded (the stored picture then stands for it).
fn shown(bytes: &[u8], a: &PictureAdjust) -> Option<Vec<u8>> {
    let live = a.live();
    if live.is_empty() {
        return None;
    }
    let mut rgba = ew_geom::picture::decode(bytes, ew_geom::MAX_DECODED_BYTES).ok()?.to_rgba8();
    for px in rgba.pixels_mut() {
        px.0 = live.apply(px.0);
    }
    ew_geom::picture::png(&image::DynamicImage::ImageRgba8(rgba)).ok()
}

/// EasyWriter engine-pictures-2: the PNG copy of SVG picture `svg` that Word keeps beside it, added to `doc`'s media: its
/// key. None when the SVG cannot be drawn.
pub fn svg_fallback(doc: &mut ew_doc::Document, svg: &[u8]) -> Option<String> {
    let png = ew_scene::svg_png(svg, 2048)?;
    Some(doc.add_media(png, "png"))
}

/// The next media key `<stem>N.png` free in `doc`, N past `n` (the last one this pass took, so two never share a key).
fn free_key(doc: &ew_doc::Document, n: &mut usize, stem: &str) -> String {
    loop {
        *n += 1;
        let k = format!("{stem}{n}.png");
        if !doc.media.contains_key(&k) {
            return k;
        }
    }
}

/// Pixels a point a drawing is pictured at for an export: 2, sharp on a high-density screen.
const PICTURED_PX: f32 = 2.0;

/// EasyWriter engine-pictures-2: `doc` with each drawing that is not a picture (a shape, a group, a chart, a Drawing Canvas,
/// a box whose fallback is one of these) as a picture of itself, drawn as its page draws it, for an export to a format that
/// has pictures but no drawings (HTML). Its size, placement and alt text stay. None when there is none.
// ponytail: a text box's text is left out of its picture (object_display needs the box's laid-out page); lay the document
// out first when an export needs it.
pub fn drawings_as_pictures(doc: &ew_doc::Document) -> Option<ew_doc::Document> {
    let drawing = |o: &InlineObject| matches!(o, InlineObject::Shape { .. } | InlineObject::Group { .. } | InlineObject::Graphic { .. });
    let mut out = doc.clone();
    let mut media: Vec<(String, Vec<u8>)> = Vec::new();
    let opts = ew_doc_layout::display::RenderOptions::default();
    let mut taken = 0;
    out.objects_mut(&drawing, &mut |o| {
        let Some((w, h, float)) = o.frame() else { return };
        let rect = ew_geom::Rect::new(0.0, 0.0, w.max(1.0), h.max(1.0));
        let page = ew_doc_layout::Page::default();
        let draws = ew_doc_layout::display::object_display(doc, &page, o, rect, None, &opts.display);
        let png = ew_doc_layout::display::render_items(doc, &draws, rect, PICTURED_PX, &opts).to_png();
        if png.is_empty() {
            return;
        }
        let key = free_key(doc, &mut taken, "pictured");
        let float = ew_doc::para::Float { fx: Default::default(), outline: None, crop_shape: None, ..float.clone() };
        *o = ew_doc::para::Picture { media: key.clone(), w, h, alt: o.alt_text().to_string(), float, ..Default::default() }.build();
        media.push((key, png));
    });
    if media.is_empty() {
        return None;
    }
    for (key, png) in media {
        out.media.insert(key, std::sync::Arc::new(png));
    }
    Some(out)
}

/// EasyWriter engine-pictures-2: `doc` with each picture that has colour settings (Recolor, Washout, brightness and contrast,
/// transparency, a transparent colour) as the picture it shows, for an export to a format without them (HTML, ODT, RTF), as
/// Word's Save as Web Page writes it. None when there is none.
pub fn shown_pictures(doc: &ew_doc::Document) -> Option<ew_doc::Document> {
    let live = |o: &InlineObject| matches!(o, InlineObject::Image { float, .. } if !float.adjust().live().is_empty());
    let mut out = doc.clone();
    let mut media: Vec<(String, Vec<u8>)> = Vec::new();
    let mut taken = 0;
    out.objects_mut(&live, &mut |o| {
        let InlineObject::Image { media: m, float, .. } = o else { return };
        let Some(png) = doc.media.get(m.as_str()).and_then(|b| shown(b, float.adjust())) else { return };
        let key = free_key(doc, &mut taken, "shown");
        o.draw_live_in(key.clone());
        media.push((key, png));
    });
    if media.is_empty() {
        return None;
    }
    for (key, png) in media {
        out.media.insert(key, std::sync::Arc::new(png));
    }
    Some(out)
}

/// The commands of this file (docs/plans/engine/stage2.md, the Stage 2.0 scaffold: one owner per file).
pub(super) fn specs() -> Vec<super::CommandSpec> {
    use super::select::{alt_text, has_picture, has_sizable, selected};
    use super::{CmdError, CommandSpec, InlineObject, Rgb, Value, json, p};
    vec![
        CommandSpec::new("picture.size", "Size", "Picture Format › Size", size)
            .params(
                r#"{"width"?: pt, "height"?: pt, "lockAspect"?: bool, "scale"?: percent, "original"?: bool} (scale: of the current size, or with original of the picture's original size, its pixels at 96 ppi less what is cropped; original alone restores that size; one side alone keeps the proportions unless lockAspect is false; 1–4000 pt: when the proportions are kept, a side past 4000 pt shrinks the other with it)"#,
            )
            .when(has_sizable),
        CommandSpec::new("picture.crop", "Crop", "Picture Format › Size", crop)
            .params(
                r#"{"left"?, "top"?, "right"?, "bottom"? (fractions of the source 0–0.95; the two sides of an axis keep at least 5% between them; a side left out is uncropped), "width"?: pt, "height"?: pt (the new display size, in the same undo step; a floating picture also moves by what a left/top crop trims, so the visible part stays put)}"#,
            )
            .when(has_picture),
        // Kept for scripts written before every object had alt text: `object.altText` on a picture.
        CommandSpec::new("picture.altText", "Alt Text", "Picture Format › Accessibility", |s, v| {
            p::req_str(v, "text")?;
            alt_text(s, v)
        })
        .params(r#"{"text": string, "title"?: string, "decorative"?: bool}"#)
        .when(has_picture),
        // EasyWriter engine-pictures-2: corrections, colour and transparency are settings on the picture (Float::adjust), each
        // absolute: setting one again replaces it, and the neutral value takes it off.
        CommandSpec::new("picture.corrections", "Corrections", "Picture Format › Adjust", |s, v| {
            // Each one given replaces its own; one left out stays (a Sharpen item keeps the brightness), as in Word's gallery.
            set_adjust(s, |a| {
                a.brightness = p::f32(v, "brightness").unwrap_or(a.brightness);
                a.contrast = p::f32(v, "contrast").unwrap_or(a.contrast);
                a.sharpen = p::f32(v, "sharpen").unwrap_or(a.sharpen);
                // Word's corrections take the place of a file's own brightness and contrast (a:lum), not of Washout.
                a.lum = a.lum.filter(|l| *l == WASHOUT);
            })
        })
        .params(r#"{"brightness"?: -100..100, "contrast"?: -100..100, "sharpen"?: -100..100} (each given replaces its own, one left out stays; 0 is none)"#)
        .when(has_picture),
        CommandSpec::new("picture.color", "Color", "Picture Format › Adjust", |s, v| {
            let mode = p::str(v, "mode").unwrap_or("grayscale");
            set_adjust(s, |a| color_change(a, mode, v))
        })
        .params(
            r#"{"mode": "grayscale|sepia|washout|blackAndWhite|dark|light|tint|none (Recolor) | saturation | tone", "saturation"?: 0..400, "color"?: "RRGGBB" (dark and light: the variation's colour), "threshold"?: 0..100 (blackAndWhite, percent), "temperature"?: 1500..11500 (tone, kelvin; 6500 neutral)} (Recolor, saturation and tone each replace their own setting; none: No Recolor)"#,
        )
        .when(has_picture),
        // EasyWriter engine-gaps-pictures: the command Set Transparent Color's click on the picture runs (engine-page-tools
        // builds the click), from the original picture, so a second pick replaces the first as in Word.
        CommandSpec::new("picture.transparentColor", "Set Transparent Color", "Picture Format › Adjust › Color", |s, v| {
            let c = p::str(v, "color").and_then(Rgb::parse);
            if c.is_none() && !v.get("color").is_some_and(Value::is_null) {
                return Err(CmdError::Params("`color` (RRGGBB, or null for none) is required".into()));
            }
            set_adjust(s, |a| a.clear = c)
        })
        .params(r#"{"color": "RRGGBB" | null} (replaces the picture's transparent colour; Word's a:clrChange)"#)
        .when(has_picture),
        CommandSpec::new("picture.iconColor", "Icon Color", "Picture Format › Adjust", |s, v| {
            let c = p::str(v, "color").and_then(Rgb::parse).ok_or_else(|| CmdError::Params("`color` (RRGGBB) is required".into()))?;
            // One colour everywhere, transparency kept: recolours an inserted icon or other
            // one-colour line art without redrawing it.
            adjust(s, Change::Pixels, move |img| {
                let mut rgba = img.to_rgba8();
                for px in rgba.pixels_mut() {
                    px.0 = [c.0, c.1, c.2, px.0[3]];
                }
                Ok(image::DynamicImage::ImageRgba8(rgba))
            })
        })
        .params(r#"{"color": "RRGGBB"}"#)
        .when(has_picture),
        CommandSpec::new("picture.effects", "Artistic Effects", "Picture Format › Adjust", |s, v| {
            // One effect at a time, as in Word: a second one replaces the first (#2052).
            let e = p::str(v, "effect").unwrap_or("blur");
            set_adjust(s, |a| a.artistic = artistic_of(e))
        })
        .params(r#"{"effect": Word's artistic effect (blur, pencilSketch, pencilGrayscale, lineDrawing, chalkSketch, photocopy, marker, paintStrokes, ...; EasyWriter's invert, posterize, pixelate) | "none"} (replaces the picture's effect)"#)
        .when(has_picture),
        CommandSpec::new("picture.transparency", "Transparency", "Picture Format › Adjust", |s, v| {
            let t = p::f32(v, "percent").unwrap_or(50.0);
            set_adjust(s, |a| a.transparency = t)
        })
        .params(r#"{"percent": 0..100}"#)
        .when(has_picture),
        CommandSpec::new("picture.removeBackground", "Remove Background", "Picture Format › Adjust", |s, v| {
            let tol = p::f32(v, "tolerance").unwrap_or(30.0).clamp(0.0, 255.0);
            adjust(s, Change::Pixels, move |img| Ok(remove_background(img, tol)))
        })
        .params(r#"{"tolerance"?: 0..255}"#)
        .when(has_picture),
        CommandSpec::new("picture.compress", "Compress Pictures", "Picture Format › Adjust", super::compress::compress)
            .params(
                r#"{"maxPixels"?: n} | {"ppi": n (pixels per inch of the drawn size; none keeps the pixels), "deleteCropped"?: bool, "all"?: bool (every picture in the body, not only the selected one)} → {compressed: n}"#,
            )
            .when(has_picture),
        CommandSpec::new("picture.reset", "Reset Picture", "Picture Format › Adjust", reset).when(has_picture),
        // The front end's panes and Save as Picture read the picture itself (docs/plans/engine/stage2/review.md gap 31).
        CommandSpec::new("picture.data", "Picture Data", "Picture Format", |s, v| {
            let (_, o) = selected(s).ok_or_else(|| CmdError::Disabled("no picture".into()))?;
            let InlineObject::Image { media, float, .. } = o else { return Err(CmdError::Disabled("not a picture".into())) };
            let bytes = s.doc.media.get(media.as_str()).ok_or_else(|| CmdError::Failed("the picture's data is missing".into()))?;
            // EasyWriter engine-pictures-2: the picture as it is shown, its colour settings drawn on it, unless `stored`.
            if !p::bool(v, "stored").unwrap_or(false)
                && let Some(png) = shown(bytes, float.adjust())
            {
                return Ok(json!({"mime": "image/png", "base64": crate::cmd::insert::base64_encode(&png)}));
            }
            let ext = media.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
            Ok(json!({"mime": ew_formats::model::mime_of(&ext), "base64": crate::cmd::insert::base64_encode(bytes)}))
        })
        .params(r#"{"stored"?: bool} → {"mime": string, "base64": string} (the selected picture as it is shown, its colour settings on it; stored: as it is stored)"#)
        .pure()
        .when(has_picture),
        CommandSpec::new("picture.change", "Change Picture", "Picture Format › Adjust", |s, v| {
            let bytes = if let Some(d) = p::str(v, "data") {
                crate::cmd::insert::base64_decode(d).ok_or_else(|| CmdError::Params("bad base64".into()))?
            } else if let Some(path) = p::str(v, "path") {
                crate::io::read_file(path).map_err(CmdError::Failed)?
            } else {
                return Err(CmdError::Params("`path` or `data` required".into()));
            };
            // EasyWriter engine-pictures-2: an SVG picture stays vector, with a PNG copy for readers without SVG.
            let svg = ew_scene::is_svg(&bytes);
            if svg {
                ew_scene::svg_size(&bytes).ok_or_else(|| CmdError::Failed("the SVG has no size".into()))?;
            } else {
                ew_geom::picture::probe(&bytes).map_err(|e| match e {
                    ew_geom::picture::Refusal::Unsupported(why) => CmdError::Failed(why.into()),
                    _ => CmdError::Failed("not a supported image".into()),
                })?;
            }
            let fallback = if svg { svg_fallback(&mut s.doc, &bytes) } else { None };
            let ext = if svg { "svg" } else { crate::cmd::insert::image_ext(&bytes) };
            let key = s.doc.add_media(bytes, ext);
            bitmap::replace(s, key, fallback)
        })
        .params(r#"{"path"?: string, "data"?: base64} (PNG, JPEG, GIF, WebP, BMP, TIFF or SVG; an SVG stays vector)"#)
        .when(has_picture),
        CommandSpec::new("picture.style", "Picture Styles", "Picture Format › Picture Styles", |s, v| {
            // A style replaces the picture's style and border, as Word's gallery does (#2052).
            let style = p::str(v, "style").unwrap_or("simpleFrame").to_string();
            relook(s, move |l| {
                l.style = Some(style);
                l.border = None;
            })
        })
        .params(r#"{"style": "simpleFrame|thickFrame|rounded|softEdge|shadow"} (replaces the picture's style and border)"#)
        .when(has_picture),
        CommandSpec::new("picture.border", "Picture Border", "Picture Format › Picture Styles", |s, v| {
            let none = v.get("color").is_some_and(Value::is_null);
            let c = p::str(v, "color").and_then(Rgb::parse).unwrap_or(Rgb::BLACK);
            let w = p::u64(v, "width").unwrap_or(4).clamp(1, 200) as u32;
            // Replaces the picture's border, keeping its style (#2052); a null colour is No Outline.
            relook(s, move |l| l.border = (!none).then_some((c, w)))
        })
        .params(r#"{"color"?: "RRGGBB" | null, "width"?: px} (replaces the picture's border; color null: No Outline)"#)
        .when(has_picture),
    ]
}

/// EasyWriter engine-pictures-2: SVG pictures stay vector, picture adjustments are settings, and exports keep pictures.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod engine_pictures_2 {
    use super::*;
    use crate::cmd::insert::{base64_decode, base64_encode};

    const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 320 200"><rect width="160" height="100" fill="#FF0000"/><circle cx="240" cy="150" r="40" fill="#0000FF" stroke="#000000" stroke-width="4"/></svg>"##;

    fn png() -> Vec<u8> {
        let img = image::RgbaImage::from_fn(20, 10, |x, _| if x < 10 { image::Rgba([200, 30, 30, 255]) } else { image::Rgba([90, 160, 220, 255]) });
        let mut b = Vec::new();
        image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut b), image::ImageFormat::Png).unwrap();
        b
    }

    fn with_picture(bytes: &[u8]) -> Session {
        let mut s = Session::new(ew_doc::Document::from_text("A picture: "));
        s.sel = crate::Selection::caret(s.doc.end_of(ew_doc::StoryRef::Body));
        s.run("insert.picture", &json!({"data": base64_encode(bytes)})).unwrap();
        s
    }

    fn picture(d: &ew_doc::Document) -> InlineObject {
        let p = d.body.iter().find_map(|b| b.as_para().filter(|p| !p.objects.is_empty())).unwrap();
        p.objects.iter().find(|o| matches!(o, InlineObject::Image { .. })).unwrap().clone()
    }

    fn parts(o: &InlineObject) -> (String, ew_doc::para::PictureFloat) {
        let InlineObject::Image { media, float, .. } = o else { panic!("a picture") };
        (media.to_string(), float.clone())
    }

    /// The picture at `pos` as a Word file holds it, `change`d: a picture no edit makes, built as a file reader builds one.
    pub(super) fn as_in_file(s: &mut Session, pos: &ew_doc::Pos, change: impl Fn(&mut ew_doc::para::Picture)) {
        super::super::select::edit_obj(s, pos, |o| {
            let InlineObject::Image { media, w, h, alt, float, crop, ole } = o.clone() else { panic!("a picture") };
            let mut p = ew_doc::para::Picture {
                media: media.into(),
                w,
                h,
                alt,
                crop,
                ole,
                adjust: float.adjust().clone(),
                layer: float.layer().map(str::to_string),
                word_copy: float.word_copy().cloned(),
                fallback: float.fallback().map(str::to_string),
                float: float.place,
            };
            change(&mut p);
            *o = p.build();
        })
        .unwrap();
    }

    /// The first page's draws, groups and their items flattened.
    fn draws(s: &mut Session) -> Vec<ew_doc_layout::display::Draw> {
        use ew_doc_layout::display::{DisplayOptions, Draw, page_display};
        fn flat(d: Vec<Draw>, out: &mut Vec<Draw>) {
            for x in d {
                match x {
                    Draw::Rotated { items, .. } | Draw::Clip { items, .. } => flat(items, out),
                    Draw::Figure { draws, .. } => flat(draws, out),
                    Draw::Group(g) => {
                        out.push(Draw::Group(g.clone()));
                        flat(g.items, out);
                    }
                    x => out.push(x),
                }
            }
        }
        let l = s.layout();
        let mut out = Vec::new();
        flat(page_display(&s.doc, &l.pages[0], &DisplayOptions::default()), &mut out);
        out
    }

    fn document_xml(docx: &[u8]) -> String {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(docx)).unwrap();
        std::io::read_to_string(z.by_name("word/document.xml").unwrap()).unwrap()
    }

    #[test]
    fn an_svg_picture_stays_vector_with_its_png_copy_through_a_word_file() {
        let mut s = with_picture(SVG.as_bytes());
        let o = s.run("object.get", &json!({})).unwrap();
        assert_eq!(o["picture"]["svg"], true, "{o}");
        // Its CSS pixels at 96 ppi: 160 × 100 px is 120 × 75 pt.
        assert_eq!((o["w"].as_f64(), o["h"].as_f64()), (Some(120.0), Some(75.0)));
        let (media, float) = parts(&picture(&s.doc));
        assert!(media.ends_with(".svg") && s.doc.media[&media].starts_with(b"<svg"));
        let copy = &s.doc.media[float.fallback().unwrap()];
        assert!(copy.starts_with(b"\x89PNG"), "a PNG copy for readers without SVG");
        // Drawn as vector paths, not decoded to pixels.
        assert!(ew_scene::vector_picture(&s.doc.media[&media]).is_some_and(|p| p.items.len() == 2));

        let docx = crate::io::save_bytes("p.docx", &s.doc).unwrap();
        let xml = document_xml(&docx);
        assert!(xml.contains("asvg:svgBlip") && xml.contains(ew_docx_svg_uri()), "{xml}");
        let back = ew_docx::read(&docx).unwrap();
        let (m2, f2) = parts(&picture(&back));
        assert_eq!(back.media[&m2].as_slice(), SVG.as_bytes(), "the SVG itself comes back");
        assert!(back.media[f2.fallback().unwrap()].starts_with(b"\x89PNG"));

        // Without its PNG copy (the SVG could not be drawn), the blip holds no picture rather than the SVG itself, and the
        // SVG still comes back.
        let mut bare = s.doc.clone();
        bare.objects_mut(&|o: &InlineObject| matches!(o, InlineObject::Image { .. }), &mut |o| {
            let (key, float) = parts(o);
            let src = ew_doc::para::Source { key, hd: None, fallback: None };
            o.set_bitmap(src, float.adjust().clone(), None, |_, _| Err("nothing to draw")).unwrap();
        });
        let docx = crate::io::save_bytes("p.docx", &bare).unwrap();
        let xml = document_xml(&docx);
        let blip = xml.split("<a:blip").nth(1).and_then(|b| b.split('>').next()).unwrap_or_default();
        assert!(!blip.contains("r:embed") && xml.contains("asvg:svgBlip"), "{xml}");
        let back = ew_docx::read(&docx).unwrap();
        let (m2, f2) = parts(&picture(&back));
        assert!(back.media[&m2].as_slice() == SVG.as_bytes() && f2.fallback().is_none());

        // Change Picture to another SVG draws a new copy; to a PNG drops it.
        s.run("picture.change", &json!({"data": base64_encode(SVG.replace("FF0000", "00FF00").as_bytes())})).unwrap();
        let (_, f3) = parts(&picture(&s.doc));
        assert!(f3.fallback().is_some() && f3.fallback() != float.fallback());
        s.run("picture.change", &json!({"data": base64_encode(&png())})).unwrap();
        assert!(parts(&picture(&s.doc)).1.fallback().is_none());
    }

    fn ew_docx_svg_uri() -> &'static str {
        "{96DAC541-7B7A-43D3-8B79-37D633B846F1}"
    }

    #[test]
    fn corrections_and_colour_are_settings_kept_through_a_reload() {
        let original = png();
        let mut s = with_picture(&original);
        s.run("picture.corrections", &json!({"brightness": 20, "contrast": -10, "sharpen": 25})).unwrap();
        s.run("picture.color", &json!({"mode": "saturation", "saturation": 150})).unwrap();
        s.run("picture.color", &json!({"mode": "grayscale"})).unwrap();
        s.run("picture.transparency", &json!({"percent": 30})).unwrap();
        s.run("picture.transparentColor", &json!({"color": "5AA0DC"})).unwrap();
        // A second change replaces the first, drawn again from the original, so nothing stacks.
        s.run("picture.corrections", &json!({"brightness": 40, "contrast": -10, "sharpen": 25})).unwrap();
        let want = json!({"brightness": 40.0, "contrast": -10.0, "sharpness": 25.0, "saturation": 150.0, "temperature": 6500.0, "recolor": "grayscale",
            "recolorColor": null, "threshold": null, "transparency": 30.0, "transparentColor": "5AA0DC", "artistic": null});
        assert_eq!(s.run("object.get", &json!({})).unwrap()["picture"]["adjust"], want);
        let (media, float) = parts(&picture(&s.doc));
        let layer = float.layer().unwrap().to_string();
        assert_eq!(s.doc.media[&layer].as_slice(), original.as_slice(), "the original's pixels are kept as they were");
        assert_ne!(media, layer, "the picture shows a copy with Word 2010's corrections in it");

        // Through a Word file, as Word writes them.
        let docx = crate::io::save_bytes("p.docx", &s.doc).unwrap();
        let xml = document_xml(&docx);
        for part in [r#"<a14:brightnessContrast bright="40000" contrast="-10000"/>"#, r#"<a14:sharpenSoften amount="25000"/>"#, r#"<a14:saturation sat="150000"/>"#,
            "<a:grayscl/>", r#"<a:alphaModFix amt="70000"/>"#, "<a:clrChange>", "a14:imgLayer r:embed="] {
            assert!(xml.contains(part), "{part} in {xml}");
        }
        let back = ew_docx::read(&docx).unwrap();
        let (m2, f2) = parts(&picture(&back));
        assert_eq!(f2.adjust(), float.adjust());
        assert_eq!(back.media[f2.layer().unwrap()].as_slice(), original.as_slice());
        assert_eq!(back.media[&m2], s.doc.media[&media]);
        // And through the engine's own form.
        let json = serde_json::to_string(&s.doc).unwrap();
        let again: ew_doc::Document = serde_json::from_str(&json).unwrap();
        assert_eq!(parts(&picture(&again)).1, float);

        // The painter draws the live ones over the picture: one group with the Adjust effect.
        let d = draws(&mut s);
        assert!(d.iter().any(|x| matches!(x, ew_doc_layout::display::Draw::Group(g) if matches!(g.effects.as_slice(), [ew_scene::Effect::Adjust(_)]))));

        // Reset Picture: the original, no settings.
        s.run("picture.reset", &json!({})).unwrap();
        let (m3, f3) = parts(&picture(&s.doc));
        assert_eq!(s.doc.media[&m3].as_slice(), original.as_slice());
        assert!(f3.adjust().is_empty() && f3.layer().is_none());
    }

    #[test]
    fn word_s_own_corrections_read_and_its_original_stays() {
        // A picture Word corrected: its blip the corrected copy, the original beside it as HD Photo (here any bytes), and
        // Word 2007's Washout and a transparency over it.
        let mut s = with_picture(&png());
        s.run("picture.color", &json!({"mode": "washout"})).unwrap();
        s.run("picture.color", &json!({"mode": "tone", "temperature": 4700})).unwrap();
        s.run("picture.effects", &json!({"effect": "pencilSketch"})).unwrap();
        let docx = crate::io::save_bytes("p.docx", &s.doc).unwrap();
        let xml = document_xml(&docx);
        assert!(xml.contains(r#"<a:lum bright="70000" contrast="-70000"/>"#) && xml.contains(r#"<a14:colorTemperature colorTemp="4700"/>"#)
            && xml.contains("<a14:artisticPencilSketch/>"), "{xml}");
        let back = ew_docx::read(&docx).unwrap();
        let a = parts(&picture(&back)).1.adjust().clone();
        let o = adjust_json(&a);
        assert_eq!((o["recolor"].as_str(), o["temperature"].as_f64(), o["artistic"].as_str()), (Some("washout"), Some(4700.0), Some("PencilSketch")));
    }

    #[test]
    fn convert_to_shape_makes_the_graphic_s_shapes() {
        let mut s = with_picture(SVG.as_bytes());
        let r = s.run("graphic.convertToShape", &json!({})).unwrap();
        assert_eq!(r["shapes"], 2);
        let p = s.doc.body.iter().find_map(|b| b.as_para().filter(|p| !p.objects.is_empty())).unwrap();
        let InlineObject::Group { w, h, children, .. } = &p.objects[0] else { panic!("a group: {:?}", p.objects[0]) };
        assert_eq!((*w, *h), (120.0, 75.0));
        let InlineObject::Shape { fill: Some(ew_doc::fill::Fill::Solid { color, .. }), w: rw, .. } = &children[0].obj else { panic!("the rectangle") };
        // The rectangle is half the graphic's width, red.
        assert_eq!((*color, (*rw - 60.0).abs() < 0.5), (Rgb(255, 0, 0), true));
        let InlineObject::Shape { stroke, stroke_width, .. } = &children[1].obj else { panic!("the circle") };
        assert!(stroke.is_some() && (*stroke_width - 1.5).abs() < 0.01, "a 4 px stroke at 0.375 pt a pixel: {stroke_width}");
        s.run("edit.undo", &json!({})).unwrap();
        assert!(matches!(picture(&s.doc), InlineObject::Image { .. }), "one undo step");
        let mut png_pic = with_picture(&png());
        assert!(png_pic.run("graphic.convertToShape", &json!({})).is_err(), "a bitmap has no shapes");
    }

    #[test]
    fn the_html_export_has_the_pictures() {
        let mut s = with_picture(&png());
        s.run("select.collapse", &json!({"end": true})).unwrap();
        s.run("insert.picture", &json!({"data": base64_encode(SVG.as_bytes())})).unwrap();
        let html = String::from_utf8(crate::io::save_bytes("p.html", &s.doc).unwrap()).unwrap();
        assert!(html.contains("<img src=\"data:image/png;base64,") && html.contains("<img src=\"data:image/svg+xml;base64,"), "{html}");
        let _ = base64_decode;
        // A box (a smart canvas) and a group of shapes, floating.
        let mut b = Session::new(ew_doc::Document::from_text("Boxes"));
        b.sel = crate::Selection::caret(b.doc.end_of(ew_doc::StoryRef::Body));
        b.run("box.insert", &json!({"kind": "canvas", "data": "{}", "fallback": base64_encode(&png())})).unwrap();
        b.run("arrange.wrap", &json!({"wrap": "square"})).unwrap();
        b.run("select.collapse", &json!({"end": true})).unwrap();
        b.run("insert.shape", &json!({"kind": "rectangle"})).unwrap();
        let html = String::from_utf8(crate::io::save_bytes("p.html", &b.doc).unwrap()).unwrap();
        assert_eq!(html.matches("<img src=\"data:image/png;base64,").count(), 2, "the box and the shape: {html}");
        let xhtml = String::from_utf8(crate::io::save_bytes("p.xhtml", &b.doc).unwrap()).unwrap();
        assert_eq!(xhtml.matches("<img src=\"data:image/png;base64,").count(), 2, "XHTML as HTML: {xhtml}");
    }

    #[test]
    fn exports_without_colour_settings_have_the_picture_as_shown() {
        let original = png();
        let mut s = with_picture(&original);
        s.run("picture.color", &json!({"mode": "grayscale"})).unwrap();
        s.run("picture.transparency", &json!({"percent": 60})).unwrap();
        let stored = base64_encode(&original);
        let html = String::from_utf8(crate::io::save_bytes("p.html", &s.doc).unwrap()).unwrap();
        assert!(html.contains("<img src=\"data:image/png;base64,") && !html.contains(&stored), "{html}");
        let shown = s.run("picture.data", &json!({})).unwrap()["base64"].as_str().unwrap().to_string();
        assert!(html.contains(&shown), "the picture as picture.data shows it");
        for ext in ["odt", "rtf"] {
            let bytes = crate::io::save_bytes(&format!("p.{ext}"), &s.doc).unwrap();
            let back = crate::io::open_bytes(&format!("p.{ext}"), &bytes).unwrap();
            let (m, _) = parts(&picture(&back));
            assert_ne!(back.media[&m].as_slice(), original.as_slice(), "{ext} has the picture as shown");
        }
    }

    #[test]
    fn a_picture_word_corrected_over_an_hd_photo_original_resets_and_corrects() {
        // Word keeps a corrected picture's original as HD Photo (media/hdphoto1.wdp), which the engine can't decode.
        let word_copy = png();
        let mut s = with_picture(&word_copy);
        let wdp = s.doc.add_media(b"II\xBC\x01 an HD Photo".to_vec(), "wdp");
        let (pos, _) = selected(&s).unwrap();
        as_in_file(&mut s, &pos, |p| {
            p.layer = Some(wdp.clone());
            p.adjust.sharpen = -100.0;
        });
        let docx = crate::io::save_bytes("p.docx", &s.doc).unwrap();
        s.doc = ew_docx::read(&docx).unwrap();
        let (shown, f) = parts(&picture(&s.doc));
        let layer = f.layer().unwrap().to_string();
        assert!(!readable(&s, &layer) && s.doc.media[&shown].as_slice() == word_copy.as_slice(), "{f:?}");

        // A correction draws from the picture Word showed, and the HD Photo is kept to write back.
        s.run("picture.corrections", &json!({"brightness": 10})).unwrap();
        s.run("picture.corrections", &json!({"brightness": 20})).unwrap();
        let (m, f) = parts(&picture(&s.doc));
        assert_eq!((f.layer(), s.originals.get(&m)), (Some(layer.as_str()), Some(&shown)), "drawn from Word's copy, not stacked");
        assert_eq!(s.run("picture.data", &json!({"stored": true})).unwrap()["mime"], "image/png");
        let xml = document_xml(&crate::io::save_bytes("p.docx", &s.doc).unwrap());
        assert!(xml.contains("a14:imgLayer r:embed="), "{xml}");
        let bright20 = s.doc.media[&m].clone();

        // A reopened draft (the engine's own form, no session memory) still draws from Word's copy: the same settings give
        // the same pixels instead of a second layer of corrections.
        let json = serde_json::to_string(&s.doc).unwrap();
        s.doc = serde_json::from_str(&json).unwrap();
        s.originals.clear();
        s.run("picture.corrections", &json!({"brightness": 30})).unwrap();
        s.run("picture.corrections", &json!({"brightness": 20})).unwrap();
        let (m, _) = parts(&picture(&s.doc));
        assert!(s.doc.media[&m] == bright20, "corrections do not stack over a reload");

        // Sharpness back to none: the engine can't draw the HD Photo, so the least it shows is Word's picture, and the pane
        // says so (Word's sharpness -100); the HD Photo stays for Word.
        s.run("picture.corrections", &json!({"brightness": 0, "sharpen": 0})).unwrap();
        let (m, f) = parts(&picture(&s.doc));
        assert!(m == shown && f.layer() == Some(layer.as_str()) && f.adjust().sharpen == -100.0 && f.adjust().brightness == 0.0, "{m} {f:?}");

        // Reset Picture: the picture Word showed with Word's settings, and the HD Photo kept, so the file Word opens is
        // the one Word wrote.
        s.doc = ew_docx::read(&docx).unwrap();
        s.originals.clear();
        s.run("picture.corrections", &json!({"contrast": 30})).unwrap();
        s.run("picture.color", &json!({"mode": "grayscale"})).unwrap();
        s.run("picture.reset", &json!({})).unwrap();
        let (m, f) = parts(&picture(&s.doc));
        assert!(s.doc.media[&m].as_slice() == word_copy.as_slice() && f.layer() == Some(layer.as_str()), "{m} {f:?}");
        assert_eq!(adjust_json(f.adjust())["sharpness"], -100.0);
        assert!(f.adjust().live().is_empty() && f.adjust().contrast == 0.0, "the user's settings are gone: {f:?}");
        let xml = document_xml(&crate::io::save_bytes("p.docx", &s.doc).unwrap());
        assert!(xml.contains(r#"<a14:sharpenSoften amount="-100000"/>"#) && xml.contains("a14:imgLayer r:embed="), "{xml}");
        assert_eq!(s.run("picture.data", &json!({})).unwrap()["mime"], "image/png");
    }

    #[test]
    fn a_pixel_edit_between_corrections_stays_through_the_next_one_and_a_word_file() {
        // A white picture with a coloured middle: Remove Background clears the white.
        let img = image::RgbaImage::from_fn(20, 20, |x, y| if (5..15).contains(&x) && (5..15).contains(&y) { image::Rgba([200, 30, 30, 255]) } else { image::Rgba([255, 255, 255, 255]) });
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
        let mut s = with_picture(&bytes);
        let corner = |d: &ew_doc::Document, key: &str| ew_geom::picture::decode(&d.media[key], ew_geom::MAX_DECODED_BYTES).unwrap().to_rgba8().get_pixel(0, 0).0[3];
        s.run("picture.corrections", &json!({"brightness": 20})).unwrap();
        s.run("picture.removeBackground", &json!({})).unwrap();
        s.run("picture.corrections", &json!({"brightness": 20, "contrast": -10})).unwrap();
        let (media, float) = parts(&picture(&s.doc));
        assert_eq!((float.adjust().brightness, float.adjust().contrast), (20.0, -10.0));
        assert_eq!(corner(&s.doc, &media), 0, "the removed background stays removed after the next correction");
        // Word draws the corrections again from the layer, so the layer has the edit too.
        let back = ew_docx::read(&crate::io::save_bytes("p.docx", &s.doc).unwrap()).unwrap();
        let (m2, f2) = parts(&picture(&back));
        assert_eq!((corner(&back, &m2), corner(&back, f2.layer().unwrap())), (0, 0));

        // A picture style over the corrections stays through the next one, and a second style replaces the first.
        s.run("picture.style", &json!({"style": "thickFrame"})).unwrap();
        s.run("picture.corrections", &json!({"brightness": 0, "contrast": -10})).unwrap();
        s.run("picture.style", &json!({"style": "thickFrame"})).unwrap();
        let (m3, _) = parts(&picture(&s.doc));
        let side = |d: &ew_doc::Document, k: &str| ew_geom::picture::decode(&d.media[k], ew_geom::MAX_DECODED_BYTES).unwrap().width();
        let mut plain = with_picture(&bytes);
        plain.run("picture.style", &json!({"style": "thickFrame"})).unwrap();
        assert_eq!(side(&s.doc, &m3), side(&plain.doc, &parts(&picture(&plain.doc)).0), "one frame, not two");
        assert_eq!(s.run("object.get", &json!({})).unwrap()["picture"]["style"], "thickFrame");
    }

    #[test]
    fn exports_give_each_shown_picture_its_own_key() {
        // The document already has a picture named shown2.png: three pictures with colour settings still get three keys.
        let mut s = with_picture(&png());
        s.run("picture.color", &json!({"mode": "grayscale"})).unwrap();
        s.doc.media.insert("shown2.png".into(), std::sync::Arc::new(png()));
        for _ in 0..2 {
            s.run("select.collapse", &json!({"end": true})).unwrap();
            s.run("insert.picture", &json!({"data": base64_encode(&png())})).unwrap();
            s.run("picture.transparency", &json!({"percent": 50})).unwrap();
        }
        let out = shown_pictures(&s.doc).unwrap();
        let keys: Vec<String> = out.body.iter().filter_map(|b| b.as_para()).flat_map(|p| p.objects.iter()).filter_map(|o| match o {
            InlineObject::Image { media, .. } => Some(media.to_string()),
            _ => None,
        }).collect();
        let distinct: std::collections::HashSet<_> = keys.iter().collect();
        assert!(keys.len() == 3 && distinct.len() == 3 && !keys.iter().any(|k| k == "shown2.png"), "{keys:?}");
    }
}
