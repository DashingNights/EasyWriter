use super::*;

/// A blank Letter page's list (612 × 792 points on white), as a document's first page.
fn letter(layers: Vec<Layer>) -> DisplayList {
    DisplayList::new(612.0, 792.0, Some(Rgb::WHITE), layers)
}

/// The first and last pixel rows with ink in a black-on-white [`render_text_line`] raster.
fn ink_rows(img: &Rendered) -> Option<(usize, usize)> {
    let w = img.width as usize * 4;
    let rows: Vec<usize> = img.pixels.chunks(w).enumerate().filter(|(_, r)| r.chunks(4).any(|p| p[0] < 128)).map(|(i, _)| i).collect();
    Some((*rows.first()?, *rows.last()?))
}

/// #2570: a font with a very tall ascent (Amiri Quran's is 1.8 em, for stacked marks) put its
/// font list entry's baseline below the row, so the name was cut in half, and every tall-ascent
/// font sat lower than its neighbours. The entry's capitals are now centred in the row,
/// whatever the ascent.
#[test]
fn a_tall_ascent_font_list_entry_sits_where_the_others_do() {
    // Source Sans 3 renamed (same length) with its ascent set to Amiri Quran's 1815/1000 em.
    let mut data = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/fonts/SourceSans3-Regular.ttf")).unwrap();
    let utf16 = |s: &str| s.encode_utf16().flat_map(u16::to_be_bytes).collect::<Vec<u8>>();
    for (from, to) in [(utf16("Source Sans 3"), utf16("Talled Sans 3")), (b"Source Sans 3".to_vec(), b"Talled Sans 3".to_vec())] {
        let mut i = 0;
        while let Some(at) = data[i..].windows(from.len()).position(|w| w == from) {
            data[i + at..i + at + to.len()].copy_from_slice(&to);
            i += at + to.len();
        }
    }
    let table = |data: &[u8], tag: &[u8; 4]| {
        let n = u16::from_be_bytes([data[4], data[5]]) as usize;
        (0..n)
            .map(|k| 12 + k * 16)
            .find(|&r| &data[r..r + 4] == tag)
            .map(|r| u32::from_be_bytes(data[r + 8..r + 12].try_into().unwrap()) as usize)
            .unwrap()
    };
    let upem = u16::from_be_bytes(data[table(&data, b"head") + 18..][..2].try_into().unwrap()) as f64;
    let tall = ((upem * 1.815) as i16).to_be_bytes();
    let (hhea, os2) = (table(&data, b"hhea"), table(&data, b"OS/2"));
    for at in [hhea + 4, os2 + 68, os2 + 74] {
        data[at..at + 2].copy_from_slice(&tall);
    }
    assert!(ew_fonts::FontDb::global().add_font(data) > 0);
    let db = ew_fonts::FontDb::global();
    let tall_face = db.face("Talled Sans 3", "Regular");
    let normal = db.face(ew_fonts::FALLBACK_FAMILY, "Regular");
    assert_eq!(tall_face.family, "Talled Sans 3");
    assert!(tall_face.ascent > normal.ascent * 1.5, "patched ascent {} vs {}", tall_face.ascent, normal.ascent);
    // The font list's entry: 13 pt text in a 244×22 pt row, 2 pt in.
    let entry = |f: &ew_fonts::FontFace| ink_rows(&render_text_line(f, "Amiri Quran", 13.0, 244.0, 22.0, 2.0, 2.0));
    let (top, bottom) = entry(&normal).unwrap();
    let (tall_top, tall_bottom) = entry(&tall_face).unwrap();
    assert_eq!((tall_top, tall_bottom), (top, bottom), "same glyphs, same place in the row");
    assert!(top > 0 && bottom < 43, "the name isn't clipped: ink rows {top}..={bottom} of 44");
    // Centred: as much room above the capitals as below the descender, within a few pixels.
    let (above, below) = (top as i32, 43 - bottom as i32);
    assert!((above - below).abs() <= 6, "rows above {above}, below {below}");
}

/// #299: a filled shape colours the caret's background only inside its outline: an
/// ellipse's corner shows what lies beneath, its centre the fill.
#[test]
fn background_follows_a_shapes_outline_not_its_box() {
    let opts = PaintOptions::default();
    let ellipse = Draw::Shape {
        rect: ew_geom::Rect::new(100.0, 100.0, 200.0, 100.0),
        kind: ShapeKind::Ellipse,
        fill: Some(Paint::solid(Rgb::BLACK)),
        stroke: None,
        stroke_width: 0.0,
        effects: Default::default(),
        corner: None,
        dash: Vec::new(),
        cap: Default::default(),
    };
    let at = |x: f32, y: f32| {
        let mut bg = [255.0; 3];
        blend_backgrounds(std::slice::from_ref(&ellipse), ew_geom::Point::new(x, y), &opts, &mut bg, 0);
        bg
    };
    assert_eq!(at(200.0, 150.0), [0.0; 3], "the centre is the fill");
    assert_eq!(at(103.0, 103.0), [255.0; 3], "the box's corner is outside the ellipse");
    assert_eq!(at(350.0, 150.0), [255.0; 3], "outside the box");
}

#[test]
fn stem_darkening_follows_the_macos_curve() {
    assert_eq!(stem_darkening(0.0), 0.0);
    assert_eq!(stem_darkening(f64::NAN), 0.0);
    assert_eq!(stem_darkening(-5.0), 0.0);
    // Small text grows in proportion to its pixel size...
    assert!((stem_darkening(10.0) - 10.0 * 0.0121 * 2.25 / 2.0).abs() < 1e-9);
    // ...body text on a Retina screen hits the 0.3 px cap...
    assert_eq!(stem_darkening(30.0), 0.3);
    assert_eq!(stem_darkening(72.0), 0.3);
    // ...and display sizes aren't darkened at all.
    assert_eq!(stem_darkening(72.5), 0.0);
}

/// A PNG signature, an IHDR declaring `w`×`h` 8-bit RGBA and a short IDAT (all CRCs valid, so
/// the header parses), with no real pixel data.
fn ihdr_only_png(w: u32, h: u32) -> Vec<u8> {
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        let mut crc = 0xFFFF_FFFFu32;
        for b in &body {
            crc ^= *b as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
        out.extend_from_slice(&(!crc).to_be_bytes());
    }
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = w.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &[0x78, 0x9c, 0, 0]);
    out
}

#[test]
fn decode_budget_is_checked_from_the_header() {
    let mut buf = Vec::new();
    let img = image::RgbaImage::from_fn(16, 8, |x, y| image::Rgba([x as u8, y as u8, 9, 255]));
    img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png).unwrap();
    // Decode, the RGBA conversion and the premultiplied copy are charged: two buffers at peak.
    assert!(decode_pixmap_within(&buf, 1024).is_some());
    assert!(decode_pixmap_within(&buf, 1023).is_none());
    // 16-bit RGBA decodes to 8 bytes a pixel, alive with its RGBA8 copy: 12 bytes a pixel.
    let mut wide = Vec::new();
    let img16 = image::ImageBuffer::<image::Rgba<u16>, _>::from_fn(16, 8, |x, y| image::Rgba([x as u16 * 999, y as u16, 9, 65535]));
    image::DynamicImage::ImageRgba16(img16).write_to(&mut std::io::Cursor::new(&mut wide), image::ImageFormat::Png).unwrap();
    assert!(decode_pixmap_within(&wide, 1024).is_none(), "two RGBA8 buffers' worth is not enough for RGBA16");
    assert!(decode_pixmap_within(&wide, 1536).is_some());
    // A header (valid CRC) claiming 60000x60000 with no pixel data reads fine, then the budget refuses it.
    let hdr = ihdr_only_png(60_000, 60_000);
    assert_eq!(image_size(&hdr), Some((60_000, 60_000)));
    assert!(decode_pixmap(&hdr).is_none());
}

/// A `Rendered` whose pixels don't match its claimed size isn't padded out to that size: a
/// 60000×60000 claim over no pixels would allocate 14 GB. It, and any mismatch, encodes to
/// nothing (JPEG used to assert on the length).
#[test]
fn encoders_refuse_pixels_that_dont_match_the_size() {
    let huge = Rendered { width: 60_000, height: 60_000, pixels: Vec::new() };
    assert!(huge.to_png().is_empty());
    assert!(huge.to_jpeg(80).is_empty());
    let short = Rendered { width: 2, height: 2, pixels: vec![255; 4] };
    assert!(short.to_png().is_empty());
    assert!(short.to_jpeg(80).is_empty());
    let long = Rendered { width: 1, height: 1, pixels: vec![255; 8] };
    assert!(long.to_png().is_empty());
    let ok = Rendered { width: 2, height: 2, pixels: vec![255; 16] };
    assert!(!ok.to_png().is_empty());
    assert!(!ok.to_jpeg(80).is_empty());
}

#[test]
fn page_raster_is_capped_by_total_pixels() {
    let page = letter(Vec::new());
    let opts = PaintOptions::default();
    let big = render_region_capped(&page, &NoMedia, 3000, 2000, Affine::scale(4.0), &opts, 100_000);
    assert!(big.width as u64 * big.height as u64 <= 100_000, "{}x{}", big.width, big.height);
    assert!(big.width > 300 && big.height > 200);
    assert_eq!(big.pixels.len() as u64, big.width as u64 * big.height as u64 * 4);
    let ok = render_region_capped(&page, &NoMedia, 300, 200, Affine::IDENTITY, &opts, 100_000);
    assert_eq!((ok.width, ok.height), (300, 200));
}

#[test]
fn hostile_scale_is_clamped() {
    let page = letter(Vec::new());
    let img = render_list(&page, &NoMedia, f32::NAN, &PaintOptions::default());
    assert_eq!(img.width, 612);
    let big = render_list(&page, &NoMedia, 1e9, &PaintOptions::default());
    assert!(big.width <= MAX_SIDE);
    assert!(decode_pixmap(b"not an image").is_none());
}

/// A JPEG whose headers say progressive (SOF2, a DC-only first scan) and `w` × `h`, its three
/// components unsubsampled, with no pixel data that size.
fn progressive_jpeg_header(w: u16, h: u16) -> Vec<u8> {
    let mut jpeg = Vec::new();
    image::RgbImage::new(16, 16).write_to(&mut std::io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg).unwrap();
    let sof = jpeg.windows(2).position(|m| m == [0xFF, 0xC0]).unwrap();
    jpeg[sof + 1] = 0xC2;
    jpeg[sof + 5..sof + 7].copy_from_slice(&h.to_be_bytes());
    jpeg[sof + 7..sof + 9].copy_from_slice(&w.to_be_bytes());
    for c in 0..3 {
        jpeg[sof + 11 + 3 * c] = 0x11;
    }
    let sos = jpeg.windows(2).position(|m| m == [0xFF, 0xDA]).unwrap();
    let n = usize::from(jpeg[sos + 4]);
    jpeg[sos + 6 + 2 * n] = 0;
    jpeg
}

#[test]
fn progressive_jpeg_coefficients_count_toward_the_decode_budget() {
    // Two RGBA buffers of 7900 × 7900 fit 512 MB, but RGB output beside three full-size
    // coefficient planes (9 bytes a pixel) doesn't (#3644).
    let jpeg = progressive_jpeg_header(7900, 7900);
    assert!(ew_geom::decode_fits(7900, 7900, ew_geom::MAX_DECODED_BYTES));
    assert!(decode_pixmap(&jpeg).is_none());
    let mut baseline = Vec::new();
    image::RgbImage::new(64, 64).write_to(&mut std::io::Cursor::new(&mut baseline), image::ImageFormat::Jpeg).unwrap();
    assert!(decode_pixmap(&baseline).is_some(), "other JPEGs still draw");
}

/// #3665: a picture too large for the whole cache is kept at half of it, so it is cached
/// instead of decoded again on every render.
#[test]
fn pictures_too_large_for_the_cache_are_kept_smaller() {
    let px = vello_cpu::color::PremulRgba8 { r: 40, g: 80, b: 120, a: 200 };
    // 6000 × 6000 is 144 MB of RGBA, past the 128 MB cache.
    let big = Pixmap::from_parts(vec![px; 6000 * 6000], 6000, 6000);
    let small = cacheable(big);
    let bytes = small.width() as usize * small.height() as usize * 4;
    assert!(bytes <= CACHE_BYTES / 2, "{} x {}", small.width(), small.height());
    assert!(small.width() >= 3000 && small.width() == small.height(), "aspect kept");
    assert!(small.data().iter().all(|p| (p.r, p.g, p.b, p.a) == (40, 80, 120, 200)), "flat stays flat");
    let mut cache = MediaCache { map: HashMap::new(), bytes: 0 };
    // A source file larger than the whole cache (an uncompressed BMP, say) doesn't count against it.
    let src = Arc::new(vec![0u8; CACHE_BYTES + 1]);
    cache.insert("big", &src, Some(Arc::new(small)), bytes);
    assert!(cache.get("big", &src).is_some(), "cached");
    // Pictures the cache holds as they are keep their size.
    assert_eq!(cacheable(Pixmap::from_parts(vec![px; 100 * 50], 100, 50)).width(), 100);
}

#[test]
fn shrinking_averages_premultiplied_pixels() {
    let p = |v: u8| vello_cpu::color::PremulRgba8 { r: v, g: v, b: v, a: 255 };
    let pm = Pixmap::from_parts(vec![p(0), p(100), p(200), p(40)], 4, 1);
    let out = shrink(&pm, 2).unwrap();
    assert_eq!((out.width(), out.height()), (2, 1));
    assert_eq!(out.data().iter().map(|q| q.r).collect::<Vec<_>>(), [50, 120]);
    assert!(shrink(&pm, 4).is_none() && shrink(&pm, 0).is_none());
}

/// #1252: on a dark page every highlight colour is dimmed so the text drawn on it reads
/// (Automatic and explicit black text both draw white); a light page is the identity.
#[test]
fn dark_page_text_backgrounds_keep_text_readable() {
    use ew_doc::props::Highlight;
    let dark = PaintOptions { dark: true, ..Default::default() };
    let light = PaintOptions::default();
    let colours: Vec<Rgb> = Highlight::ALL.iter().filter_map(|h| h.rgb()).collect();
    assert_eq!(colours.len(), 16);
    for c in colours {
        let bg = dark.ink_bg(c);
        // Automatic text resolves to black or white (doc-layout's `text_color`).
        for (what, tc) in [("white", Rgb::WHITE), ("black", Rgb::BLACK)] {
            let fg = dark.ink_text(tc, Some(c));
            assert_eq!(fg, Rgb::WHITE, "{what} text on {c:?} draws white");
            let k = contrast(fg, bg);
            assert!(k >= 4.5, "{what} text on {c:?}: {fg:?} on {bg:?} has contrast {k:.2}");
        }
        assert_eq!(light.ink_bg(c), c, "light page keeps {c:?}");
        assert_eq!(light.ink_text(c, Some(c)), c, "light page keeps text {c:?}");
    }
    // Yellow turns a dim olive (~#4a4a10), still yellow in hue.
    let Rgb(r, g, b) = dark.ink_bg(Rgb(255, 255, 0));
    assert!(r.abs_diff(0x4A) <= 8 && g.abs_diff(0x4A) <= 8 && b.abs_diff(0x10) <= 8, "yellow → {:?}", (r, g, b));
    assert!(r == g && g > b);
    // Text off a highlight keeps the plain inversion.
    assert_eq!(dark.ink_text(Rgb::WHITE, None), dark.ink(Rgb::WHITE));
}

/// #1252 review: explicit coloured text (pure blue, red, every highlight colour) on every
/// dimmed highlight still reaches 4.5:1 on a dark page.
#[test]
fn dark_page_coloured_text_on_highlights_reads() {
    use ew_doc::props::Highlight;
    let dark = PaintOptions { dark: true, ..Default::default() };
    let colours: Vec<Rgb> = Highlight::ALL.iter().filter_map(|h| h.rgb()).collect();
    let texts: Vec<Rgb> = [Rgb(0, 0, 255), Rgb(255, 0, 0)].into_iter().chain(colours.iter().copied()).collect();
    for &h in &colours {
        let bg = dark.ink_bg(h);
        for &tc in &texts {
            let fg = dark.ink_text(tc, Some(h));
            let k = contrast(fg, bg);
            assert!(k >= 4.5, "text {tc:?} on {h:?}: {fg:?} on {bg:?} has contrast {k:.2}");
        }
    }
}

/// One EMF record: type, size, payload (a multiple of 4 bytes).
fn emf_rec(typ: u32, payload: &[u8]) -> Vec<u8> {
    let mut v = typ.to_le_bytes().to_vec();
    v.extend(((8 + payload.len()) as u32).to_le_bytes());
    v.extend(payload);
    v
}

fn le32(vals: &[i32]) -> Vec<u8> {
    vals.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// A 25 mm square EMF (device units 0.04 per 0.01 mm, so 100 device units) with a red rectangle over
/// its right half.
fn red_right_half_emf() -> Vec<u8> {
    let mut h = vec![0u8; 88];
    h[0..4].copy_from_slice(&1u32.to_le_bytes());
    h[4..8].copy_from_slice(&88u32.to_le_bytes());
    h[8..24].copy_from_slice(&le32(&[0, 0, 100, 100]));
    h[24..40].copy_from_slice(&le32(&[0, 0, 2500, 2500]));
    h[40..44].copy_from_slice(&0x464D_4520u32.to_le_bytes());
    h[72..88].copy_from_slice(&le32(&[1000, 1000, 250, 250]));
    let brush = emf_rec(39, &le32(&[1, 0, 0x0000_00FF, 0]));
    let select = emf_rec(37, &le32(&[1]));
    let rect = emf_rec(43, &le32(&[50, 0, 100, 100]));
    let eof = emf_rec(14, &[0; 12]);
    [h, brush, select, rect, eof].concat()
}

/// An EMF text run whose anchor sits inside the picture but whose font is billions of units
/// tall: each glyph's curves would span billions of device pixels, which the rasteriser
/// subdivides for ever. Glyphs that big (or off the raster) are left out; the page renders.
#[test]
fn metafile_text_with_a_huge_font_is_left_out() {
    let mut font = emf_rec(82, &le32(&[1, -2_000_000_000, 0, 0, 0, 400, 0, 0]));
    let mut name: Vec<u8> = "Arial".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    name.resize(64, 0);
    font.extend(name);
    font[4..8].copy_from_slice(&104u32.to_le_bytes());
    let mut text = emf_rec(84, &le32(&[0, 0, 100, 100, 1, 0, 0, 5, 40, 4, 76, 0, 0, 0, 0, 0, 0]));
    text.extend("WOWS".encode_utf16().flat_map(|u| u.to_le_bytes()));
    text[4..8].copy_from_slice(&84u32.to_le_bytes());
    let mut emf = red_right_half_emf()[..88].to_vec();
    emf.extend([font, emf_rec(37, &le32(&[1])), emf_rec(24, &le32(&[0])), text, emf_rec(14, &[0; 12])].concat());
    let media: HashMap<String, Arc<Vec<u8>>> = HashMap::from([("emf".to_string(), Arc::new(emf))]);
    let rect = ew_geom::Rect::new(72.0, 72.0, 70.0, 70.0);
    let pic = Draw::Image { rect, media: "emf".into(), crop: [0.0; 4], alpha: 1.0, alt: String::new(), decorative: false };
    let start = std::time::Instant::now();
    let img = render_list(&letter(vec![Layer::of(vec![pic])]), &media, 1.0, &PaintOptions::default());
    // About 20 ms without the huge glyphs; drawing them ran past 4 minutes without finishing.
    assert!(start.elapsed() < std::time::Duration::from_secs(10), "{:?}", start.elapsed());
    assert_eq!(img.width, 612);
    // Leaving them out is logged (once a run, so it may have been by another test already).
    assert!(OVERSIZED_GLYPHS_NOTED.load(std::sync::atomic::Ordering::Relaxed), "the left-out glyphs are logged");
}

/// Glyphs left out for their size are logged the first time only: a page is drawn on every
/// repaint. A run with none left out logs nothing and doesn't use up the warning.
#[test]
fn oversized_glyphs_are_logged_once_a_run() {
    let noted = std::sync::atomic::AtomicBool::new(false);
    assert!(!note_oversized_glyphs(&noted, 0), "nothing left out, nothing logged");
    assert!(!noted.load(std::sync::atomic::Ordering::Relaxed));
    assert!(note_oversized_glyphs(&noted, 4), "the first glyphs left out are logged");
    assert!(!note_oversized_glyphs(&noted, 2), "later ones aren't");
}

#[test]
fn shapes_have_paths() {
    let r = kurbo::Rect::new(0.0, 0.0, 10.0, 10.0);
    for k in [
        ShapeKind::Rectangle,
        ShapeKind::Ellipse,
        ShapeKind::FlowchartOr,
        ShapeKind::Star,
        ShapeKind::Heart,
        ShapeKind::Arrow,
        ShapeKind::ArrowLeft,
        ShapeKind::ArrowUp,
        ShapeKind::ArrowDown,
        ShapeKind::Line,
    ] {
        assert!(!shape_path(k, r, None).elements().is_empty());
    }
}

/// Dash lengths too small to cut the path make kurbo's dash iterator spin without moving along
/// it (and every piece is more stroke to build): such a pattern is drawn solid, as are negative
/// and non-finite ones. A normal dash pattern still dashes.
#[test]
fn hostile_dash_patterns_draw_solid_and_finish() {
    use ew_doc::graphic::PathSeg;
    let line = |dash: Vec<f32>| Draw::Path {
        segs: vec![PathSeg::Move(10.0, 20.0), PathSeg::Line(90.0, 20.0)],
        fill: None,
        stroke: Some(Rgb(0, 0, 0)),
        stroke_width: 2.0,
        dash,
        cap: Default::default(),
    };
    let start = std::time::Instant::now();
    for dash in [vec![1e-30, 1e-30], vec![1e-30], vec![-1.0, 2.0], vec![f32::NAN, 1.0], vec![f32::INFINITY, 1.0], vec![0.0, 0.0]] {
        let img =
            render_items(&[line(dash.clone())], &NoMedia, ew_geom::Rect::new(0.0, 0.0, 100.0, 40.0), 1.0, &PaintOptions::default());
        assert!(img.pixel(50, 20)[3] > 200, "{dash:?} draws solid");
    }
    // Milliseconds drawn solid; drawn as dashes they ran past 4 minutes without finishing.
    assert!(start.elapsed() < std::time::Duration::from_secs(10), "{:?}", start.elapsed());
    let dashed =
        render_items(&[line(vec![10.0, 10.0])], &NoMedia, ew_geom::Rect::new(0.0, 0.0, 100.0, 40.0), 1.0, &PaintOptions::default());
    assert!(dashed.pixel(15, 20)[3] > 200 && dashed.pixel(25, 20)[3] == 0, "a normal pattern dashes");
    assert!(safe_dashes([3.0, 1.0], 1000.0).len() == 2);
    assert!(safe_dashes([1e-3, 1e-3], 1000.0).is_empty(), "a million pieces");
    assert!(safe_dashes(std::iter::repeat_n(1.0, 200_000), 1.0).is_empty(), "too many entries");
}

#[test]
fn flowchart_or_spokes() {
    let r = kurbo::Rect::new(0.0, 0.0, 10.0, 10.0);
    let path = shape_path(ShapeKind::FlowchartOr, r, None);
    let elements = path.elements();
    for pair in [
        [kurbo::PathEl::MoveTo((0.0, 5.0).into()), kurbo::PathEl::LineTo((10.0, 5.0).into())],
        [kurbo::PathEl::MoveTo((5.0, 0.0).into()), kurbo::PathEl::LineTo((5.0, 10.0).into())],
    ] {
        assert!(elements.windows(2).any(|w| w == pair), "missing spoke {pair:?}");
    }
}

/// A rounded rectangle's corner is its file's (`roundRect`'s `adj`), not always 16%.
#[test]
fn rounded_rectangle_corners_follow_their_radius() {
    use kurbo::Shape;
    let r = kurbo::Rect::new(0.0, 0.0, 200.0, 100.0);
    let inside = |corner, pt: (f64, f64)| shape_path(ShapeKind::RoundedRectangle, r, corner).contains(pt.into());
    // Two points inside the top-left corner: 1 pt and 4 pt in from both edges.
    let (tip, near) = ((1.0, 1.0), (4.0, 4.0));
    assert!(inside(Some(0), tip), "square corner");
    assert!(!inside(Some(3_565), tip) && inside(Some(3_565), near), "3.565 pt corner");
    assert!(!inside(None, near), "16 pt corner by default");
    assert!(!inside(Some(u32::MAX), (14.0, 14.0)) && inside(Some(u32::MAX), (100.0, 1.0)), "round ends");
}

/// #611: a line runs as DrawingML's `line` preset does, top-left to bottom-right (Word's
/// files flip it for the other diagonal), not bottom-left to top-right.
#[test]
fn a_line_runs_from_top_left_to_bottom_right() {
    let p = shape_path(ShapeKind::Line, kurbo::Rect::new(10.0, 20.0, 30.0, 60.0), None);
    assert_eq!(p.elements(), &[kurbo::PathEl::MoveTo((10.0, 20.0).into()), kurbo::PathEl::LineTo((30.0, 60.0).into())]);
}
