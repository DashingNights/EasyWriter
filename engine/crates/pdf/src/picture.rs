use super::exporter::Exporter;
use super::paint::{append_path, norm};
use super::{
    Arc, Fill, FillRule, Image, LineCap, LineJoin, NormalizedF32, Path, PathBuilder, Picture, PlacedItem, Rect, Size, Stroke, Surface, Transform, rgb,
};

/// Largest picture side we embed (pixels).
const MAX_IMAGE_SIDE: u32 = 30_000;

/// A metafile picture, parsed once. The geometry comes placed by the metafile crate; the bitmaps are
/// embedded images, one per picture item (None for paths and undecodable bitmaps).
pub(crate) struct Vector {
    pic: Picture,
    images: Vec<Option<Image>>,
}

/// Parses a metafile or an SVG and embeds its bitmaps. None when the picture has no usable size.
pub(crate) fn build_vector(bytes: &[u8]) -> Option<Vector> {
    let mut pic = ew_scene::vector_picture(bytes)?;
    if !pic.has_size() {
        return None;
    }
    let images = pic.items.iter_mut().map(|it| it.take_pixels().map(|(w, h, px)| Image::from_rgba8(px, w, h))).collect();
    Some(Vector { pic, images })
}

/// A straight RGBA colour as a krilla colour and opacity.
pub(crate) fn paint_of(c: [u8; 4]) -> (rgb::Color, NormalizedF32) {
    (rgb::Color::new(c[0], c[1], c[2]), norm(f32::from(c[3]) / 255.0))
}

/// Narrowest metafile stroke in points. Cosmetic (width 0) pens get it rather than PDF's 0-width
/// "thinnest line": krilla bounds a 0-width stroke by the bare path, which is empty for a horizontal
/// line, so a faded (grouped) picture would clip it away.
const HAIRLINE: f64 = 0.25;

/// Draws a metafile picture into the clip (the picture frame): paths are filled and stroked in page
/// space (strokes keep their width under non-uniform scaling), bitmaps stretched, all faded by `alpha`.
/// Every path sets its fill and stroke, so none carries over; strokes have round caps and joins. Text
/// runs are drawn as text.
pub(crate) fn vector_picture(ex: &mut Exporter, s: &mut Surface, v: &Vector, r: &Rect, crop: &[f32; 4], clip: &Path, alpha: f32) {
    let target = kurbo::Rect::new(f64::from(r.x), f64::from(r.y), f64::from(r.x + r.w), f64::from(r.y + r.h));
    let fade = alpha < 0.999;
    if fade {
        s.push_opacity(norm(alpha));
    }
    s.push_clip_path(clip, &FillRule::NonZero);
    for it in v.pic.place(target, *crop) {
        match it {
            PlacedItem::Path { path, fill, stroke, even_odd, .. } => {
                let Some(p) = path_from(&path) else { continue };
                let fill = fill.map(|c| {
                    let (paint, opacity) = paint_of(c);
                    let rule = if even_odd { FillRule::EvenOdd } else { FillRule::NonZero };
                    Fill { paint: paint.into(), opacity, rule }
                });
                let stroke = stroke.map(|(c, w)| {
                    let (paint, opacity) = paint_of(c);
                    Stroke {
                        paint: paint.into(),
                        width: w.max(HAIRLINE) as f32,
                        opacity,
                        line_cap: LineCap::Round,
                        line_join: LineJoin::Round,
                        ..Default::default()
                    }
                });
                s.set_fill(fill);
                s.set_stroke(stroke);
                s.draw_path(&p);
            }
            PlacedItem::Bitmap { index, rect, .. } => {
                let Some(Some(img)) = v.images.get(index) else { continue };
                let Some(size) = Size::from_wh(rect.width() as f32, rect.height() as f32) else { continue };
                s.push_transform(&Transform::from_translate(rect.x0 as f32, rect.y0 as f32));
                s.draw_image(img.clone(), size);
                s.pop();
            }
            PlacedItem::Text { index, tf, .. } => {
                if let Some(ew_metafile::Item::Text(t)) = v.pic.items.get(index) {
                    ex.vector_text(s, t, tf);
                }
            }
        }
    }
    s.set_fill(None);
    s.set_stroke(None);
    s.pop();
    if fade {
        s.pop();
    }
}

/// A kurbo path as a krilla path (None when empty).
fn path_from(b: &kurbo::BezPath) -> Option<Path> {
    let mut pb = PathBuilder::new();
    append_path(&mut pb, b);
    pb.finish()
}

/// Decode a picture for embedding (validated with the `image` crate first, so a broken file
/// can't fail the whole export).
pub(crate) fn load_image(data: &Arc<Vec<u8>>) -> Option<Image> {
    // The shared probe also charges what the decoder holds beside its output (#3644).
    if !ew_geom::picture::probe(data).is_ok_and(|p| p.fits(ew_geom::MAX_DECODED_BYTES)) {
        return None;
    }
    load_image_within(data, ew_geom::MAX_DECODED_BYTES)
}

/// EasyWriter engine-pictures-2: [`load_image`] with a picture's colour settings `live` on its pixels, at its own size.
pub(crate) fn load_adjusted(data: &Arc<Vec<u8>>, live: &ew_doc::adjust::Live) -> Option<Image> {
    if !ew_geom::picture::probe(data).is_ok_and(|p| p.fits(ew_geom::MAX_DECODED_BYTES)) {
        return None;
    }
    load(data, ew_geom::MAX_DECODED_BYTES, Some(live))
}

/// [`load_image`] with an explicit RGBA byte budget (a small one in tests).
pub(crate) fn load_image_within(data: &Arc<Vec<u8>>, budget: u64) -> Option<Image> {
    load(data, budget, None)
}

fn load(data: &Arc<Vec<u8>>, budget: u64, live: Option<&ew_doc::adjust::Live>) -> Option<Image> {
    use image::ImageDecoder;
    let fmt = image::guess_format(data).ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    // Header-only size check before anything is allocated (the decoder's buffer at its own pixel
    // size, 8 bytes for 16-bit RGBA, plus the RGBA conversion are charged); the side limits and
    // the default 512 MB allocation cap apply to the header read and the decode alike.
    let (hw, hh, native) = {
        let d = ew_geom::picture::decoder(data, None, limits.clone()).ok()?;
        let (w, h) = d.dimensions();
        (w, h, u64::from(d.color_type().bytes_per_pixel()))
    };
    if !ew_geom::decode_peak_fits(hw, hh, native, budget) {
        return None;
    }
    let dec = ew_geom::picture::read(data, None, limits).ok()?;
    let (w, h) = (dec.width(), dec.height());
    if w == 0 || h == 0 || w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE {
        return None;
    }
    let Some(live) = live else {
        if fmt == image::ImageFormat::Jpeg && matches!(dec.color(), image::ColorType::L8 | image::ColorType::Rgb8) {
            return Image::from_jpeg(data.clone().into(), true).ok();
        }
        return Some(Image::from_rgba8(dec.into_rgba8().into_raw(), w, h));
    };
    let mut rgba = dec.into_rgba8();
    for px in rgba.pixels_mut() {
        px.0 = live.apply(px.0);
    }
    Some(Image::from_rgba8(rgba.into_raw(), w, h))
}
