//! EasyWriter's binding to WordCraft's metafile reader (../metafile): a one-line summary, and the picture as SVG for the
//! browser to draw. The SVG's own units are `w` x `h` CSS px with the picture stretched over them, as GDI+'s
//! DrawImage(m, 0, 0, w, h) stretches the frame; its natural size is `k` times that.
use std::fmt::Write as _;

use base64::Engine as _;
use ew_metafile::{Ansi, HAlign, Item, Picture, PlacedItem, VAlign};

/// "ok WxH items paths bitmaps texts" or "err <message>".
pub fn summary(bytes: &[u8]) -> String {
    match ew_metafile::parse(bytes) {
        Ok(p) => {
            let n = |f: fn(&Item) -> bool| p.items.iter().filter(|i| f(i)).count();
            format!(
                "ok {}x{} {} {} {} {}",
                p.width,
                p.height,
                p.items.len(),
                n(|i| matches!(i, Item::Path { .. })),
                n(|i| matches!(i, Item::Bitmap { .. })),
                n(|i| matches!(i, Item::Text(_)))
            )
        }
        Err(e) => format!("err {e}"),
    }
}

/// `attr="rgb(r,g,b)"`, with `attr-opacity` only when the colour is not opaque.
fn paint(attr: &str, c: [u8; 4]) -> String {
    let mut s = format!("{attr}=\"rgb({},{},{})\"", c[0], c[1], c[2]);
    if c[3] < 255 {
        let _ = write!(s, " {attr}-opacity=\"{:.3}\"", f64::from(c[3]) / 255.0);
    }
    s
}

/// A control character XML 1.0 does not allow (one of them would make the browser reject the whole SVG): left
/// out of the text, its advance kept.
fn dropped(c: char) -> bool {
    ((c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r')) || c == '\u{FFFE}' || c == '\u{FFFF}'
}

/// Text for XML: the markup characters escaped, white space as spaces and [`dropped`] characters left out.
fn xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(' '),
            c if dropped(c) => {}
            c => out.push(c),
        }
    }
    out
}

/// Decodes the bytes of an ANSI run by an Encoding Standard label (TextDecoder in a browser); None leaves the run
/// out rather than drawing the wrong characters.
pub type Decode<'a> = &'a dyn Fn(&str, &[u8]) -> Option<String>;

/// The Encoding Standard label of a Windows code page. Johab (1361) has none.
fn label(code_page: u16) -> Option<&'static str> {
    const WINDOWS: [&str; 9] =
        ["windows-1250", "windows-1251", "windows-1252", "windows-1253", "windows-1254", "windows-1255", "windows-1256", "windows-1257", "windows-1258"];
    Some(match code_page {
        874 => "windows-874",
        932 => "shift_jis",
        936 => "gbk",
        949 => "euc-kr",
        950 => "big5",
        1250..=1258 => WINDOWS[usize::from(code_page - 1250)],
        10000 => "macintosh",
        _ => return None,
    })
}

/// An ANSI run's characters and one advance per character: a double-byte character takes the sum of its two
/// bytes' entries, as GDI's ExtTextOutA counts them. The advances are left out when they do not line up.
fn decode_run(a: &Ansi, dx: &[f32], decode: Decode) -> Option<(String, Vec<f32>)> {
    let text = decode(label(a.code_page)?, &a.bytes)?;
    let lead = |b: u8| match a.code_page {
        932 => matches!(b, 0x81..=0x9F | 0xE0..=0xFC),
        936 | 949 | 950 => (0x81..=0xFE).contains(&b),
        _ => false,
    };
    let mut adv = Vec::new();
    let mut i = 0;
    while i < a.bytes.len() && dx.len() == a.bytes.len() {
        let w = if lead(a.bytes[i]) && i + 1 < a.bytes.len() { 2 } else { 1 };
        adv.push(dx[i..i + w].iter().sum());
        i += w;
    }
    if adv.len() != text.chars().count() {
        adv.clear();
    }
    Some((text, adv))
}

/// The picture as an SVG document: `w` x `h` CSS px of drawing (0 or less: the picture's own size, its points as CSS px),
/// `k` times that as its natural size. ANSI runs in a code page the reader carries no table for go through `decode`.
pub fn svg(bytes: &[u8], w: f64, h: f64, k: f64, decode: Decode) -> Result<String, String> {
    let pic: Picture = ew_metafile::parse(bytes).map_err(|e| e.to_string())?;
    if !pic.has_size() {
        return Err("no size".into());
    }
    let ok = |v: f64| v.is_finite() && v > 0.0;
    let (w, h) = if ok(w) && ok(h) { (w, h) } else { (f64::from(pic.width) * 4.0 / 3.0, f64::from(pic.height) * 4.0 / 3.0) };
    let k = if ok(k) { k } else { 1.0 };
    let mut s = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{:.2}\" height=\"{:.2}\" viewBox=\"0 0 {w} {h}\" preserveAspectRatio=\"none\">",
        w * k,
        h * k
    );
    // Each distinct clip box is one clipPath; a run of items under the same box shares one group.
    let mut clips: Vec<kurbo::Rect> = Vec::new();
    let mut open: Option<usize> = None;
    for it in pic.place(kurbo::Rect::new(0.0, 0.0, w, h), [0.0; 4]) {
        let (PlacedItem::Path { clip, .. } | PlacedItem::Bitmap { clip, .. } | PlacedItem::Text { clip, .. }) = &it;
        let id = clip.map(|c| clips.iter().position(|k| *k == c).unwrap_or_else(|| {
            clips.push(c);
            clips.len() - 1
        }));
        if id != open {
            if open.is_some() {
                s.push_str("</g>");
            }
            if let Some(id) = id {
                let _ = write!(s, "<g clip-path=\"url(#c{id})\">");
            }
            open = id;
        }
        match it {
            PlacedItem::Path { path, fill, stroke, even_odd, .. } => {
                let fill = fill.map_or_else(|| "fill=\"none\"".to_string(), |c| paint("fill", c));
                let rule = if even_odd { "evenodd" } else { "nonzero" };
                let _ = write!(s, "<path d=\"{}\" {fill} fill-rule=\"{rule}\"", path.to_svg());
                if let Some((c, sw)) = stroke {
                    // A cosmetic (0) pen is a hairline: at least one pixel, as WordCraft's renderer draws it.
                    let _ = write!(s, " {} stroke-width=\"{:.3}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"", paint("stroke", c), sw.max(1.0));
                }
                s.push_str("/>");
            }
            PlacedItem::Bitmap { index, rect, .. } => {
                if let Some(Item::Bitmap { width, height, rgba, .. }) = pic.items.get(index) {
                    let mut png_bytes = Vec::new();
                    let mut e = png::Encoder::new(&mut png_bytes, *width, *height);
                    e.set_color(png::ColorType::Rgba);
                    e.set_depth(png::BitDepth::Eight);
                    if e.write_header().and_then(|mut wr| wr.write_image_data(rgba)).is_ok() {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
                        let _ = write!(
                            s,
                            "<image x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" preserveAspectRatio=\"none\" href=\"data:image/png;base64,{b64}\"/>",
                            rect.x0,
                            rect.y0,
                            rect.width(),
                            rect.height()
                        );
                    }
                }
            }
            PlacedItem::Text { index, tf, .. } => {
                let Some(Item::Text(t)) = pic.items.get(index) else { continue };
                let run = match &t.ansi {
                    Some(a) => decode_run(a, &t.dx, decode),
                    None => Some((t.text.clone(), t.dx.clone())),
                };
                let Some((text, dx)) = run else { continue };
                let [a, b, c, d, e, f] = tf.as_coeffs();
                let base = match t.valign {
                    VAlign::Top => "text-before-edge",
                    VAlign::Baseline => "alphabetic",
                    VAlign::Bottom => "text-after-edge",
                };
                // ponytail: a cell height is taken as 1.2 em; Text::layout does it with the font's own metrics.
                let em = if t.cell { f64::from(t.size) / 1.2 } else { f64::from(t.size) };
                // The file's own advances place each character, as GDI does; the alignment then moves the whole run.
                // A character xml() leaves out still moves the next one by its advance. Without advances the
                // browser's apply and text-anchor aligns the run.
                let chars: Vec<char> = text.chars().collect();
                let place = if dx.len() == chars.len() && !chars.is_empty() {
                    let width: f64 = dx.iter().map(|v| f64::from(*v)).sum();
                    let mut x = match t.halign {
                        HAlign::Left => 0.0,
                        HAlign::Center => -width / 2.0,
                        HAlign::Right => -width,
                    };
                    let mut xs = String::new();
                    for (ch, v) in chars.iter().zip(&dx) {
                        if !dropped(*ch) {
                            let sep = if xs.is_empty() { "" } else { " " };
                            let _ = write!(xs, "{sep}{x:.2}");
                        }
                        x += f64::from(*v);
                    }
                    format!("x=\"{xs}\"")
                } else {
                    let anchor = match t.halign {
                        HAlign::Left => "start",
                        HAlign::Center => "middle",
                        HAlign::Right => "end",
                    };
                    format!("text-anchor=\"{anchor}\"")
                };
                let _ = write!(
                    s,
                    "<text transform=\"matrix({a} {b} {c} {d} {e} {f})\" {place} font-family=\"{}\" font-size=\"{em:.2}\" font-weight=\"{}\" font-style=\"{}\" {} dominant-baseline=\"{base}\" xml:space=\"preserve\">{}</text>",
                    xml(&t.font),
                    if t.bold { "bold" } else { "normal" },
                    if t.italic { "italic" } else { "normal" },
                    paint("fill", t.color),
                    xml(&text)
                );
            }
        }
    }
    if open.is_some() {
        s.push_str("</g>");
    }
    if !clips.is_empty() {
        s.push_str("<defs>");
        for (i, c) in clips.iter().enumerate() {
            let _ = write!(s, "<clipPath id=\"c{i}\"><rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\"/></clipPath>", c.x0, c.y0, c.width(), c.height());
        }
        s.push_str("</defs>");
    }
    s.push_str("</svg>");
    Ok(s)
}

/// [`svg`] as a base64 data URL, for an img's src.
pub fn svg_url(bytes: &[u8], w: f64, h: f64, k: f64, decode: Decode) -> Result<String, String> {
    Ok(format!("data:image/svg+xml;base64,{}", base64::engine::general_purpose::STANDARD.encode(svg(bytes, w, h, k, decode)?)))
}

#[cfg(target_arch = "wasm32")]
mod web {
    use wasm_bindgen::prelude::*;

    // The platform's TextDecoder (a plain web API, in workers and Node too) decodes the code pages the reader
    // carries no tables for.
    #[wasm_bindgen]
    extern "C" {
        type TextDecoder;
        #[wasm_bindgen(constructor, catch)]
        fn new(label: &str) -> Result<TextDecoder, JsValue>;
        #[wasm_bindgen(method, catch)]
        fn decode(this: &TextDecoder, bytes: &[u8]) -> Result<String, JsValue>;
    }

    fn decode_with(label: &str, bytes: &[u8]) -> Option<String> {
        TextDecoder::new(label).ok()?.decode(bytes).ok()
    }

    #[wasm_bindgen]
    pub fn summary(bytes: &[u8]) -> String {
        super::summary(bytes)
    }

    #[wasm_bindgen]
    pub fn svg_url(bytes: &[u8], w: f64, h: f64, k: f64) -> Result<String, String> {
        super::svg_url(bytes, w, h, k, &decode_with)
    }
}
