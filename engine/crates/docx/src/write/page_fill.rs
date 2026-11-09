//! EasyWriter engine-gaps-shapes: a gradient or pattern page background (Design › Page Color › Fill Effects) as Word
//! writes it, `w:background/v:background/v:fill` (read back by read/page_fill.rs). A pattern's fill names its picture,
//! which this writes as the 8 by 8 one-bit bitmap of the preset.

use ew_doc::fill::{Fill, GradientKind, PATTERNS, pattern_bits};

use super::{PartRels, W, Writer, rt};

/// The `v:background` of gradient or pattern fill `fill` inside an open `w:background`; nothing for another fill.
pub(super) fn page_fill(w: &mut W, wr: &mut Writer<'_>, fill: &Fill, rels: &mut PartRels) {
    let hash = |c: ew_doc::props::Rgb| format!("#{}", c.hex());
    match fill.sanitized() {
        Some(Fill::Gradient(g)) => {
            let (Some(first), Some(last)) = (g.stops.first(), g.stops.last()) else { return };
            let (c1, c2) = (hash(first.color), hash(last.color));
            w.open("v:background", &[("id", "_x0000_s1025"), ("o:bwmode", "white"), ("fillcolor", &c1)]);
            let mut a: Vec<(&str, String)> = vec![("color2", c2)];
            // Every stop when there are more than the two ends (a preset's colours), as fractions of the way.
            if g.stops.len() > 2 {
                let colors: Vec<String> = g.stops.iter().map(|s| format!("{} {}", fmt(s.pos / 100.0), hash(s.color))).collect();
                a.push(("colors", colors.join(";")));
                a.push(("method", "none".into()));
            }
            match g.kind {
                // VML's angle runs counter-clockwise from a top-to-bottom gradient.
                GradientKind::Linear { angle, .. } => {
                    a.push(("angle", fmt(90.0 - angle)));
                    a.push(("type", "gradient".into()));
                }
                GradientKind::Path { focus: [l, t, ..], .. } => {
                    a.push(("focusposition", format!("{},{}", fmt(l / 100.0), fmt(t / 100.0))));
                    a.push(("type", "gradientRadial".into()));
                }
            }
            let a: Vec<(&str, &str)> = a.iter().map(|(k, v)| (*k, v.as_str())).collect();
            w.empty("v:fill", &a);
            w.close("v:background");
        }
        Some(Fill::Pattern(p)) => {
            let Some(bits) = pattern_bits(&p.preset) else { return };
            let label = PATTERNS.iter().find(|(n, ..)| *n == p.preset).map_or("", |q| q.1);
            let file = wr.extra_media_name("pagepattern", "bmp");
            wr.extra_media.push((file.clone(), bitmap(bits)));
            let rid = rels.add(rt::IMAGE, &format!("media/{file}"), false);
            w.open("v:background", &[("id", "_x0000_s1025"), ("o:bwmode", "white"), ("fillcolor", &hash(p.fg))]);
            w.empty("v:fill", &[("r:id", &rid), ("o:title", label), ("color2", &hash(p.bg)), ("type", "pattern")]);
            w.close("v:background");
        }
        _ => {}
    }
}

/// A number for a VML attribute: up to four decimals, no trailing zeros.
fn fmt(v: f32) -> String {
    let s = format!("{:.4}", if v.is_finite() { v } else { 0.0 });
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// The 8 by 8 one-bit BMP of a pattern's cell: index 1 where a bit is set, index 0 elsewhere. Word draws index 1 in the
/// background's fill colour (the foreground) and index 0 in its `color2` (checked with a pdf.ps1 probe, 2026-10-31).
fn bitmap(bits: [u8; 8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(94);
    b.extend_from_slice(b"BM");
    b.extend_from_slice(&94u32.to_le_bytes());
    b.extend_from_slice(&[0, 0, 0, 0]);
    b.extend_from_slice(&62u32.to_le_bytes());
    for v in [40u32, 8, 8] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    for v in [0u32, 32, 2835, 2835, 2, 2] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&[0, 0, 0, 0, 255, 255, 255, 0]);
    // Rows bottom up, each padded to four bytes; the leftmost pixel is the high bit.
    for row in bits.iter().rev() {
        let byte = (0..8).fold(0u8, |acc, x| if row >> x & 1 == 1 { acc | 0x80 >> x } else { acc });
        b.extend_from_slice(&[byte, 0, 0, 0]);
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pattern_bitmap_is_its_cell() {
        let b = bitmap([0x01, 0, 0, 0, 0, 0, 0, 0x80]);
        assert_eq!((b.len(), &b[..2]), (94, &b"BM"[..]));
        // The last row (written first) has its rightmost pixel set: index 1 there, 0 elsewhere.
        assert_eq!((b[62], b[90]), (0x01, 0x80));
        assert_eq!(fmt(90.0 - 0.0), "90");
        assert_eq!(fmt(0.5), "0.5");
    }
}
