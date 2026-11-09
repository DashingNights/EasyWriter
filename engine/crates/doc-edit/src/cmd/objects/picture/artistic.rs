//! EasyWriter ph-misc-1: the 16 artistic effects `picture.rs` does not draw itself, as one table of looks.
//!
//! Word's filters are its own; these are approximations built from a size, a blur, a tone quantisation, edges and grain.
// ponytail: each look approximates Word's; give any one that matters a filter of its own.

use image::imageops::FilterType;
use image::DynamicImage;

/// One look. Sizes are divisors of the picture's longer side, so a look reads the same at any resolution; 0 is off.
struct Look {
    cell: u16,
    blur: u16,
    levels: u8,
    grey: bool,
    edge: i16,
    grain: u8,
    lift: u8,
    keep: u8,
    hatch: u16,
}

const LOOKS: [(&str, Look); 16] = [
    ("Marker", Look { cell: 0, blur: 400, levels: 6, grey: false, edge: -120, grain: 0, lift: 0, keep: 100, hatch: 0 }),
    ("PaintStrokes", Look { cell: 0, blur: 300, levels: 8, grey: false, edge: -60, grain: 12, lift: 0, keep: 100, hatch: 0 }),
    ("PaintBrush", Look { cell: 0, blur: 250, levels: 6, grey: false, edge: 0, grain: 8, lift: 0, keep: 100, hatch: 0 }),
    ("GlowDiffused", Look { cell: 0, blur: 300, levels: 0, grey: false, edge: 0, grain: 10, lift: 40, keep: 100, hatch: 0 }),
    ("LightScreen", Look { cell: 0, blur: 0, levels: 0, grey: false, edge: 0, grain: 0, lift: 35, keep: 100, hatch: 120 }),
    ("WatercolorSponge", Look { cell: 0, blur: 250, levels: 5, grey: false, edge: -40, grain: 18, lift: 10, keep: 100, hatch: 0 }),
    ("FilmGrain", Look { cell: 0, blur: 0, levels: 0, grey: false, edge: 0, grain: 40, lift: 0, keep: 100, hatch: 0 }),
    ("MosiaicBubbles", Look { cell: 60, blur: 0, levels: 0, grey: false, edge: -80, grain: 0, lift: 0, keep: 100, hatch: 0 }),
    ("Glass", Look { cell: 0, blur: 350, levels: 0, grey: false, edge: 100, grain: 25, lift: 10, keep: 100, hatch: 0 }),
    ("Cement", Look { cell: 0, blur: 400, levels: 0, grey: true, edge: 80, grain: 35, lift: 0, keep: 100, hatch: 0 }),
    ("Texturizer", Look { cell: 0, blur: 0, levels: 0, grey: false, edge: 60, grain: 25, lift: 0, keep: 100, hatch: 0 }),
    ("CrisscrossEtching", Look { cell: 0, blur: 500, levels: 0, grey: true, edge: 0, grain: 0, lift: 100, keep: 0, hatch: 150 }),
    ("PastelsSmooth", Look { cell: 0, blur: 200, levels: 0, grey: false, edge: 0, grain: 0, lift: 25, keep: 100, hatch: 0 }),
    ("PlasticWrap", Look { cell: 0, blur: 400, levels: 0, grey: false, edge: 200, grain: 0, lift: 0, keep: 100, hatch: 0 }),
    ("Cutout", Look { cell: 0, blur: 500, levels: 4, grey: false, edge: 0, grain: 0, lift: 0, keep: 100, hatch: 0 }),
    ("GlowEdges", Look { cell: 0, blur: 500, levels: 0, grey: false, edge: 400, grain: 0, lift: 0, keep: 0, hatch: 0 }),
];

/// `img` with the artistic effect `name` (Word's gallery name), or `img` unchanged for an unknown one.
pub(super) fn stylise(img: DynamicImage, name: &str) -> DynamicImage {
    let Some((_, look)) = LOOKS.iter().find(|(n, _)| *n == name) else { return img };
    let (width, height) = (img.width(), img.height());
    let (w, h) = (width.max(1), height.max(1));
    let side = w.max(h) as f32;
    let mut img = img;
    if look.cell > 0 {
        let c = (side / f32::from(look.cell)).max(2.0) as u32;
        img = img
            .resize_exact((w / c).max(1), (h / c).max(1), FilterType::Nearest)
            .resize_exact(w, h, FilterType::Nearest);
    }
    if look.blur > 0 {
        img = img.blur((side / f32::from(look.blur)).max(0.5));
    }
    let mut rgba = img.to_rgba8();
    let luma: Vec<u8> = rgba
        .pixels()
        .map(|p| ((299 * u32::from(p.0[0]) + 587 * u32::from(p.0[1]) + 114 * u32::from(p.0[2])) / 1000) as u8)
        .collect();
    // The luma one pixel away, held at the picture's edge.
    let at = |x: i64, y: i64| -> i32 {
        let x = x.clamp(0, i64::from(w) - 1) as u32;
        let y = y.clamp(0, i64::from(h) - 1) as u32;
        luma.get((y * w + x) as usize).copied().unwrap_or(0) as i32
    };
    for (x, y, px) in rgba.enumerate_pixels_mut() {
        let (xi, yi) = (i64::from(x), i64::from(y));
        let l = at(xi, yi);
        let e = ((at(xi + 1, yi) - at(xi - 1, yi)).abs() + (at(xi, yi + 1) - at(xi, yi - 1)).abs()).min(255);
        let [r, g, b, a] = px.0;
        let mut v = if look.grey { [l; 3] } else { [i32::from(r), i32::from(g), i32::from(b)] };
        if look.levels > 0 {
            let step = 255 / (i32::from(look.levels) - 1);
            v = v.map(|c| (c + step / 2) / step * step);
        }
        v = v.map(|c| c * i32::from(look.keep) / 100);
        if look.edge != 0 {
            v = v.map(|c| c + e * i32::from(look.edge) / 100);
        }
        if look.grain > 0 {
            let n = (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663)).wrapping_mul(2_654_435_761) >> 24;
            let amount = n as i32 * (2 * i32::from(look.grain) + 1) / 256 - i32::from(look.grain);
            v = v.map(|c| c + amount);
        }
        if look.lift > 0 {
            v = v.map(|c| c + (255 - c) * i32::from(look.lift) / 100);
        }
        if look.hatch > 0 {
            let s = (w.max(h) / u32::from(look.hatch)).max(3);
            // Signed: the second diagonal runs down from the right edge, which is left of a pixel on a tall picture.
            let diag = i64::from(x + w) - i64::from(y);
            if ((x + y) % s == 0 && l < 170) || (diag.rem_euclid(i64::from(s)) == 0 && l < 100) {
                v = [0; 3];
            }
        }
        px.0 = [v[0].clamp(0, 255) as u8, v[1].clamp(0, 255) as u8, v[2].clamp(0, 255) as u8, a];
    }
    DynamicImage::ImageRgba8(rgba)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbaImage;

    /// 64 x 64: a smooth gradient with a hard edge at x = 32, every alpha 255.
    fn gradient() -> DynamicImage {
        let mut img = RgbaImage::new(64, 64);
        for (x, y, px) in img.enumerate_pixels_mut() {
            let edge = if x < 32 { 0 } else { 120 };
            px.0 = [(x * 4) as u8, (y * 4) as u8, ((x + y) * 2 % 256) as u8, 255];
            if x == 32 {
                px.0[0] = edge;
            }
        }
        DynamicImage::ImageRgba8(img)
    }

    #[test]
    fn every_look_changes_the_picture_and_keeps_alpha() {
        let input = gradient();
        let before = input.to_rgba8().into_raw();
        for (name, _) in LOOKS {
            let out = stylise(input.clone(), name).to_rgba8();
            assert_eq!(out.dimensions(), (64, 64), "{name} resized");
            assert!(out.pixels().all(|p| p.0[3] == 255), "{name} changed alpha");
            assert_ne!(out.into_raw(), before, "{name} left the picture unchanged");
        }
        assert_eq!(stylise(input.clone(), "Nope").to_rgba8().into_raw(), before, "unknown name changed the picture");
    }

    #[test]
    fn the_looks_differ_from_each_other() {
        let input = gradient();
        let outs: Vec<Vec<u8>> = LOOKS.iter().map(|(name, _)| stylise(input.clone(), name).to_rgba8().into_raw()).collect();
        for i in 0..outs.len() {
            for j in i + 1..outs.len() {
                assert_ne!(outs[i], outs[j], "{} and {} draw the same", LOOKS[i].0, LOOKS[j].0);
            }
        }
    }
}
