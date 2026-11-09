//! Design tab: themes, style sets, colours, fonts, paragraph spacing, watermark, page colour, borders.

use serde_json::{Value, json};
use ew_doc::props::{Border, BorderStyle, Borders, CharProps, LineSpacing, Rgb, TextColor};
use ew_doc::{Watermark, styles};

use super::sel_result;
use crate::{CmdError, CmdResult, CommandSpec, Session, p};

/// Our own themes: (name, heading font, body font, accent colours).
pub const THEMES: &[(&str, &str, &str, [Rgb; 6])] = &[
    (
        "Craft",
        styles::HEADING_FONT,
        styles::BODY_FONT,
        [Rgb(0x15, 0x60, 0x82), Rgb(0xE9, 0x71, 0x32), Rgb(0x19, 0x6B, 0x24), Rgb(0x0F, 0x9E, 0xD5), Rgb(0xA0, 0x2B, 0x93), Rgb(0x4E, 0xA7, 0x2E)],
    ),
    (
        "Studio",
        "Georgia",
        "Georgia",
        [Rgb(0x8C, 0x2F, 0x39), Rgb(0xC9, 0x8B, 0x2E), Rgb(0x3E, 0x5C, 0x76), Rgb(0x6B, 0x8F, 0x71), Rgb(0x9A, 0x6F, 0xB0), Rgb(0x4A, 0x4A, 0x4A)],
    ),
    (
        "Gallery",
        "Helvetica Neue",
        "Helvetica Neue",
        [Rgb(0x22, 0x22, 0x22), Rgb(0xE6, 0x39, 0x46), Rgb(0x45, 0x7B, 0x9D), Rgb(0x1D, 0x35, 0x57), Rgb(0xA8, 0xDA, 0xDC), Rgb(0xF4, 0xA2, 0x61)],
    ),
    (
        "Atelier",
        "Palatino",
        "Palatino",
        [Rgb(0x6D, 0x59, 0x7A), Rgb(0xB5, 0x65, 0x76), Rgb(0xE5, 0x6B, 0x6F), Rgb(0xEA, 0xAC, 0x8B), Rgb(0x35, 0x50, 0x70), Rgb(0x8E, 0x9A, 0xAF)],
    ),
    (
        "Darkroom",
        "Futura",
        "Avenir Next",
        [Rgb(0x26, 0x46, 0x53), Rgb(0x2A, 0x9D, 0x8F), Rgb(0xE9, 0xC4, 0x6A), Rgb(0xF4, 0xA2, 0x61), Rgb(0xE7, 0x6F, 0x51), Rgb(0x5E, 0x54, 0x8E)],
    ),
    (
        "Sketchbook",
        "Gill Sans",
        "Gill Sans",
        [Rgb(0x58, 0x81, 0x57), Rgb(0x3A, 0x5A, 0x40), Rgb(0xA3, 0xB1, 0x8A), Rgb(0xDA, 0xD7, 0xCD), Rgb(0x34, 0x4E, 0x41), Rgb(0xBC, 0x6C, 0x25)],
    ),
];

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("design.theme", "Themes", "Design › Document Formatting", theme)
            .params(r#"{"name": string, "colors"?: ["RRGGBB" × 12: dk1, lt1, dk2, lt2, accent1-6, hlink, folHlink], "major"?: font, "minor"?: font} (with colors: an explicit theme under any name, the app's own catalogue; without: one of design.themes)"#)
            .state(|s| (Value::Null, json!(s.doc.settings.theme_name))),
        CommandSpec::new("design.themeFonts", "Fonts", "Design › Document Formatting", |s, v| {
            let heading = p::req_str(v, "heading")?.to_string();
            let body = p::str(v, "body").unwrap_or(&heading).to_string();
            set_fonts(s, &heading, &body);
            sel_result(s)
        })
        .params(r#"{"heading": string, "body"?: string}"#)
        .state(|s| (Value::Null, json!({"heading": s.doc.settings.major_font, "body": s.doc.settings.minor_font}))),
        CommandSpec::new("design.themeColors", "Colors", "Design › Document Formatting", |s, v| {
            if let Some(list) = v.get("colors") {
                set_colors(s, &theme_colors(list)?);
                return sel_result(s);
            }
            let name = p::req_str(v, "name")?;
            let t = THEMES.iter().find(|t| t.0.eq_ignore_ascii_case(name)).ok_or_else(|| CmdError::Params(format!("unknown colours `{name}`")))?;
            set_accent(s, t.3[0]);
            sel_result(s)
        })
        .params(r#"{"name": string} | {"colors": ["RRGGBB" × 12]} (explicit: the theme's twelve colours in the engine's order)"#)
        .state(|s| (Value::Null, json!(s.doc.settings.theme_colors.iter().map(|c| c.hex()).collect::<Vec<_>>()))),
        CommandSpec::new("design.styleSet", "Style Set", "Design › Document Formatting", style_set)
            .params(r#"{"name": "default|basic|lines|shaded|casual|centered|minimalist|title"}"#),
        CommandSpec::new("design.paragraphSpacing", "Paragraph Spacing", "Design › Document Formatting", para_spacing)
            .params(r#"{"value": "default|none|compact|tight|open|relaxed|double"}"#)
            .state(|s| (Value::Null, json!(spacing_name(s)))),
        CommandSpec::new("design.scaleFontSizes", "Scale Font Sizes", "Design › Document Formatting", scale_font_sizes)
            .params(r#"{"delta": pt (-1638..1638, not 0) | "percent": number (-99..1000, not 0; 10 = +10%)} (exactly one)"#),
        CommandSpec::new("design.watermark", "Watermark", "Design › Page Background", watermark)
            .params(r#"{"text"?: string, "remove"?: bool, "diagonal"?: bool, "color"?: "RRGGBB", "font"?: family, "semitransparent"?: bool, "size"?: pt | null (Printed Watermark's Size; null: Auto), "lang"?: BCP 47 tag (the text's language), "picture"?: {"data"?: base64 image, "scale"?: percent | null (Auto: fitted to the margins), "washout"?: bool} (a picture watermark in place of the text)}"#)
            .state(|s| {
                let w = s.doc.settings.watermark.as_ref();
                let v = w.map_or(Value::Null, |w| {
                    json!({"text": w.text, "font": w.font, "color": w.color.hex(), "diagonal": w.diagonal, "semitransparent": w.semitransparent,
                        "size": w.size.map(|b| b[1]), "lang": w.lang,
                        "picture": w.picture.as_ref().map(|p| json!({"media": p.media, "scale": p.scale, "washout": p.washout, "size": p.size}))})
                });
                (Value::Null, v)
            }),
        CommandSpec::new("design.pageColor", "Page Color", "Design › Page Background", |s, v| {
            s.doc.settings.page_color = p::str(v, "color").and_then(Rgb::parse);
            s.doc.settings.page_picture = None;
            s.doc.settings.page_fill = None; // engine-gaps-shapes: a colour replaces a fill effect, as in Word
            sel_result(s)
        })
        .params(r#"{"color": "RRGGBB" | null}"#)
        .state(|s| (Value::Null, s.doc.settings.page_color.map_or(Value::Null, |c| json!(c.hex())))),
        CommandSpec::new("design.pageBorders", "Page Borders", "Design › Page Background", page_borders)
            .params(
                r#"{"kind"?: "box|none", "width"?: pt, "color"?: "RRGGBB", "style"?: "single|double|dotted|dashed|thick|triple|dotDash|wave|<art name>", "sides"?: {"top"|"left"|"bottom"|"right": {"style"?, "width"?: pt (art 1-31), "color"?: "RRGGBB", "space"?: pt 0-31} | null} (exactly these sides, instead of `kind`), "applyTo"?: "section|document", "measureFrom"?: "text|edge", "display"?: "all|firstPage|notFirstPage", "behind"?: bool}"#,
            )
            .state(|s| (Value::Null, page_borders_state(s))),
        CommandSpec::new("design.setDefault", "Set as Default", "Design › Document Formatting", |s, _| {
            s.status = "These settings will be used for new documents.".into();
            sel_result(s)
        })
        .pure(),
        CommandSpec::new("design.themes", "Theme List", "Design › Document Formatting", |_, _| {
            Ok(json!(THEMES.iter().map(|t| t.0).collect::<Vec<_>>()))
        })
        .pure(),
    ]
}

fn set_fonts(s: &mut Session, heading: &str, body: &str) {
    s.doc.settings.major_font = heading.into();
    s.doc.settings.minor_font = body.into();
    s.doc.styles_mut().default_chr.font = Some(body.into());
    for st in &mut s.doc.styles_mut().styles {
        if let Some(f) = &st.chr.font
            && (f == styles::HEADING_FONT || st.id.starts_with("Heading") || st.id == "Title")
        {
            st.chr.font = Some(heading.into());
        } else if st.chr.font.is_some() && st.chr.font.as_deref() != Some(heading) {
            st.chr.font = Some(body.into());
        }
    }
}

fn set_accent(s: &mut Session, accent: Rgb) {
    for st in &mut s.doc.styles_mut().styles {
        if st.id.starts_with("Heading") && st.id.len() == 8 && st.id.as_bytes().get(7).is_some_and(|d| *d <= b'5')
            || st.id == "IntenseQuote"
            || st.id == "IntenseEmphasis"
            || st.id == "IntenseReference"
        {
            st.chr.color = Some(TextColor::Rgb(accent));
            if let Some(b) = st.para.borders.as_mut() {
                for e in [&mut b.top, &mut b.bottom].into_iter().flatten() {
                    e.color = Some(accent);
                }
            }
        }
    }
    if let Some(c) = s.doc.settings.theme_colors.get_mut(4) {
        *c = accent;
    }
}

/// Twelve theme colours from `list` (an array of "RRGGBB" in Settings.themeColors' order).
fn theme_colors(list: &Value) -> Result<Vec<Rgb>, CmdError> {
    let out: Option<Vec<Rgb>> = list.as_array().map(|a| a.iter().filter_map(|c| c.as_str().and_then(Rgb::parse)).collect());
    out.filter(|c| c.len() == 12).ok_or_else(|| CmdError::Params("`colors` is twelve \"RRGGBB\" colours".into()))
}

/// The theme's colours: the twelve slots, and the accent the headings show.
fn set_colors(s: &mut Session, colors: &[Rgb]) {
    s.doc.settings.theme_colors = colors.to_vec();
    if let Some(a) = colors.get(4) {
        set_accent(s, *a);
    }
}

/// The Paragraph Spacing preset the document defaults match, or null (custom).
fn spacing_name(s: &Session) -> Option<&'static str> {
    let d = &s.doc.styles.default_para;
    let line = match d.line_spacing {
        Some(LineSpacing::Multiple(m)) => m,
        None => 1.0,
        _ => return None,
    };
    let (b, a) = (d.space_before.unwrap_or(0.0), d.space_after.unwrap_or(0.0));
    [("none", 0.0, 0.0, 1.0), ("compact", 0.0, 4.0, 1.0), ("tight", 0.0, 6.0, 1.15), ("open", 0.0, 10.0, 1.15), ("relaxed", 0.0, 6.0, 1.5), ("double", 0.0, 8.0, 2.0), ("default", 0.0, 8.0, 1.15)]
        .into_iter()
        .find(|(_, pb, pa, pl)| (b - pb).abs() < 0.05 && (a - pa).abs() < 0.05 && (line - pl).abs() < 0.005)
        .map(|(n, ..)| n)
}

fn theme(s: &mut Session, v: &Value) -> CmdResult {
    let name = p::req_str(v, "name")?;
    if let Some(list) = v.get("colors") {
        let colors = theme_colors(list)?;
        let (major, minor) = (p::str(v, "major").map(str::to_string), p::str(v, "minor").map(str::to_string));
        if major.is_some() || minor.is_some() {
            let heading = major.unwrap_or_else(|| s.doc.settings.major_font.clone());
            let body = minor.unwrap_or_else(|| s.doc.settings.minor_font.clone());
            set_fonts(s, &heading, &body);
        }
        set_colors(s, &colors);
        s.doc.settings.theme_name = name.chars().take(200).collect();
        return sel_result(s);
    }
    let t = THEMES.iter().find(|t| t.0.eq_ignore_ascii_case(name)).ok_or_else(|| CmdError::Params(format!("unknown theme `{name}`")))?;
    set_fonts(s, t.1, t.2);
    set_accent(s, t.3[0]);
    s.doc.settings.theme_name = t.0.into();
    let mut colors = s.doc.settings.theme_colors.clone();
    for (i, c) in t.3.iter().enumerate() {
        if let Some(x) = colors.get_mut(4 + i) {
            *x = *c;
        }
    }
    s.doc.settings.theme_colors = colors;
    sel_result(s)
}

fn style_set(s: &mut Session, v: &Value) -> CmdResult {
    let name = p::req_str(v, "name")?;
    let accent = s.doc.settings.theme_colors.get(4).copied().unwrap_or(styles::HEADING_BLUE);
    let mut fresh = ew_doc::StyleSheet::builtin();
    let line = Border { style: BorderStyle::Single, width: 0.75, color: Some(accent), space: 1.0 };
    for st in &mut fresh.styles {
        let heading = st.id.starts_with("Heading") || st.id == "Title";
        match name {
            "basic" if heading => {
                st.chr.color = Some(TextColor::Rgb(Rgb(0x26, 0x26, 0x26)));
                st.chr.bold = Some(true);
            }
            "lines" if st.id == "Heading1" || st.id == "Title" => st.para.borders = Some(Borders { bottom: Some(line), ..Default::default() }),
            "shaded" if st.id == "Heading1" => {
                st.para.shading = Some(accent);
                st.chr.color = Some(TextColor::Rgb(Rgb::WHITE));
            }
            "casual" if heading => st.chr.italic = Some(true),
            "centered" if heading => st.para.align = Some(ew_doc::Align::Center),
            "minimalist" if heading => {
                st.chr.caps = Some(true);
                st.chr.spacing = Some(1.0);
                st.chr.color = Some(TextColor::Rgb(Rgb(0x40, 0x40, 0x40)));
            }
            "title" if st.id == "Title" => st.chr.size = Some(36.0),
            _ => {}
        }
    }
    // Overlay the set onto the document's sheet: every other style, the latent styles and the
    // document defaults stay as they are (no set defines its own defaults).
    for mut st in fresh.styles {
        match s.doc.styles_mut().styles.iter_mut().find(|x| x.id == st.id) {
            Some(old) => {
                st.default = old.default;
                st.locked = old.locked;
                st.builtin = old.builtin;
                *old = st;
            }
            None => s.doc.styles_mut().styles.push(st),
        }
    }
    let (h, b) = (s.doc.settings.major_font.clone(), s.doc.settings.minor_font.clone());
    set_fonts(s, &h, &b);
    set_accent(s, accent);
    sel_result(s)
}

fn para_spacing(s: &mut Session, v: &Value) -> CmdResult {
    let (before, after, line) = match p::req_str(v, "value")? {
        "none" => (0.0, 0.0, 1.0),
        "compact" => (0.0, 4.0, 1.0),
        "tight" => (0.0, 6.0, 1.15),
        "open" => (0.0, 10.0, 1.15),
        "relaxed" => (0.0, 6.0, 1.5),
        "double" => (0.0, 8.0, 2.0),
        _ => (0.0, 8.0, 1.15),
    };
    s.doc.styles_mut().default_para.space_before = Some(before);
    s.doc.styles_mut().default_para.space_after = Some(after);
    s.doc.styles_mut().default_para.line_spacing = Some(LineSpacing::Multiple(line));
    sel_result(s)
}

/// Grow or shrink every style's font size at once. Only explicit style sizes change (including
/// table style parts); styles that inherit one (via `based_on` or the defaults) follow, and runs
/// keep their own direct formatting.
fn scale_font_sizes(s: &mut Session, v: &Value) -> CmdResult {
    let (delta, percent) = (p::f32(v, "delta"), p::f32(v, "percent"));
    // A field that is present but not a number is an error, not "absent".
    if (v.get("delta").is_some() && delta.is_none()) || (v.get("percent").is_some() && percent.is_none()) {
        return Err(CmdError::Params("`delta` and `percent` must be numbers".into()));
    }
    if delta.is_some() == percent.is_some() {
        return Err(CmdError::Params("give exactly one of `delta` (points) or `percent`".into()));
    }
    if delta.is_some_and(|d| !(-1638.0..=1638.0).contains(&d) || d == 0.0) || percent.is_some_and(|x| !(-99.0..=1000.0).contains(&x) || x == 0.0) {
        return Err(CmdError::Params("`delta` must be non-zero within ±1638 pt and `percent` non-zero within -99..1000".into()));
    }
    let factor = 1.0 + percent.unwrap_or(0.0) / 100.0;
    let scale = |size: f32| ((size * factor + delta.unwrap_or(0.0)).clamp(1.0, 1638.0) * 2.0).round() / 2.0;
    let scale_chr = |c: &mut CharProps| {
        c.size = c.size.map(scale);
        c.size_cs = c.size_cs.map(scale);
    };
    let st = s.doc.styles_mut();
    // An unset document default resolves to the fallback size; make it explicit so inheriting styles follow.
    st.default_chr.size = Some(scale(st.default_chr.size.unwrap_or(ew_doc::props::DEFAULT_FONT_SIZE)));
    st.default_chr.size_cs = st.default_chr.size_cs.map(scale);
    for style in &mut st.styles {
        scale_chr(&mut style.chr);
        if let Some(t) = style.table.as_mut() {
            for c in [&mut t.header_chr, &mut t.band_chr, &mut t.first_col_chr, &mut t.last_col_chr, &mut t.total_chr, &mut t.col_band_chr] {
                scale_chr(c);
            }
            for part in t.regions.values_mut() {
                scale_chr(&mut part.chr);
            }
        }
    }
    sel_result(s)
}

fn watermark(s: &mut Session, v: &Value) -> CmdResult {
    if p::bool(v, "remove").unwrap_or(false) {
        s.doc.settings.watermark = None;
        return sel_result(s);
    }
    if let Some(pv) = v.get("picture") {
        return picture_watermark(s, pv);
    }
    let mut wm = s.doc.settings.watermark.clone().unwrap_or_default();
    // EasyWriter engine-gaps-rest: a text watermark replaces a picture one; the language picks the dialog's text list.
    if p::str(v, "text").is_some() || wm.text.is_empty() {
        wm.picture = None;
        if wm.text.is_empty() {
            wm.text = ew_doc::Watermark::default().text;
        }
    }
    if let Some(l) = v.get("lang") {
        wm.lang = l.as_str().map(str::trim).filter(|l| !l.is_empty() && l.len() <= 85).map(str::to_string);
    }
    if let Some(t) = p::str(v, "text") {
        wm.text = t.chars().take(200).collect();
    }
    if let Some(d) = p::bool(v, "diagonal") {
        wm.diagonal = d;
    }
    if let Some(c) = p::str(v, "color").and_then(Rgb::parse) {
        wm.color = c;
    }
    if let Some(f) = p::str(v, "font").filter(|f| !f.trim().is_empty()) {
        wm.font = f.chars().take(64).collect();
    }
    if let Some(x) = p::bool(v, "semitransparent") {
        wm.semitransparent = x;
    }
    // A size in points is the box the text fills at that size (gap G44); null is Auto. A new text or font keeps the size.
    let size = match v.get("size") {
        Some(Value::Null) => None,
        Some(x) => x.as_f64().filter(|f| f.is_finite() && *f > 0.0).map(|f| f as f32),
        None => wm.size.map(|b| b[1]),
    };
    if ["size", "text", "font"].iter().any(|k| v.get(*k).is_some()) {
        wm.size = size.map(|pt| super::page::watermark_box(&wm.font, &wm.text, pt));
    }
    s.doc.settings.watermark = Some(Watermark { ..wm });
    sel_result(s)
}

/// EasyWriter engine-gaps-rest: Printed Watermark's Picture watermark: the picture (`data`, else the one there now) at `scale`
/// percent of its own size, or fitted to the first section's margins (Auto), washed out unless `washout` is false.
fn picture_watermark(s: &mut Session, pv: &Value) -> CmdResult {
    let old = s.doc.settings.watermark.as_ref().and_then(|w| w.picture.clone());
    let media = match p::str(pv, "data") {
        Some(d) => {
            let bytes = super::insert::base64_decode(d).ok_or_else(|| CmdError::Params("picture.data: bad base64".into()))?;
            if bytes.len() > 200 << 20 {
                return Err(CmdError::Failed("the picture is larger than 200 MB".into()));
            }
            let ext = super::insert::image_ext(&bytes);
            s.doc.add_media(bytes, ext)
        }
        None => old.as_ref().map(|p| p.media.clone()).ok_or_else(|| CmdError::Params("picture.data: the picture".into()))?,
    };
    // Its own size: pixels at 96 ppi, or a metafile's frame, as Insert › Pictures takes it.
    let bytes = s.doc.media.get(&media).cloned().unwrap_or_default();
    let (nw, nh) = match ew_geom::picture::probe(&bytes) {
        Ok(pic) => (pic.width as f32 * 0.75, pic.height as f32 * 0.75),
        Err(_) => ew_scene::metafile_size(&bytes).map(|(w, h, _)| (w, h)).ok_or_else(|| CmdError::Failed("not a supported image".into()))?,
    };
    let scale = match pv.get("scale") {
        Some(Value::Null) => None,
        Some(x) => x.as_f64().filter(|f| f.is_finite() && *f > 0.0).map(|f| (f as f32).min(5000.0)),
        None => old.as_ref().and_then(|p| p.scale),
    };
    let size = match scale {
        Some(pct) => [nw * pct / 100.0, nh * pct / 100.0],
        None => {
            let (tw, th) = s.doc.sections().first().map(|(_, sp)| (sp.text_width(), sp.page_h - sp.margin_top - sp.margin_bottom)).unwrap_or((468.0, 648.0));
            let k = (tw / nw.max(1.0)).min(th.max(1.0) / nh.max(1.0));
            [nw * k, nh * k]
        }
    };
    let washout = p::bool(pv, "washout").unwrap_or(old.as_ref().is_none_or(|p| p.washout));
    let base = s.doc.settings.watermark.clone().unwrap_or_default();
    s.doc.settings.watermark =
        Some(ew_doc::Watermark { picture: Some(ew_doc::WatermarkPicture { media, size, washout, scale }), text: String::new(), ..base });
    sel_result(s)
}

/// Page borders of the caret's section (or every section with `applyTo: "document"`).
fn page_borders(s: &mut Session, v: &Value) -> CmdResult {
    let borders = match v.get("sides") {
        Some(sides) => Some(page_sides(sides)?).filter(Borders::any_visible),
        None => {
            let kind = p::str(v, "kind").unwrap_or("box");
            let style = p::str(v, "style").map(BorderStyle::from_ooxml).unwrap_or(BorderStyle::Single);
            let width = p::f32(v, "width").unwrap_or(1.0).clamp(if style.is_art() { 1.0 } else { 0.25 }, if style.is_art() { 31.0 } else { 6.0 });
            let color = p::str(v, "color").and_then(Rgb::parse);
            (kind != "none").then(|| Borders::box_(Border { style, width, color, space: 24.0 }))
        }
    };
    let focus = s.sel.focus.path.0.first().copied().unwrap_or(0) as usize;
    let blocks: Vec<usize> = match p::str(v, "applyTo") {
        Some("document") => s.doc.sections().iter().map(|(end, _)| *end).collect(),
        Some("section") | None => vec![focus],
        Some(x) => return Err(CmdError::Params(format!("unknown `applyTo` `{x}`"))),
    };
    // EasyWriter (engine-gaps-styles): Borders and Shading's Page Border tab places them too: measured from the text or the
    // page edge, on every page, the first page only or all but it, and in front of or behind the text (`w:pgBorders`).
    let from_text = match p::str(v, "measureFrom") {
        Some("text") => Some(true),
        Some("edge") => Some(false),
        None => None,
        Some(x) => return Err(CmdError::Params(format!("unknown `measureFrom` `{x}` (text|edge)"))),
    };
    let first_page = match p::str(v, "display") {
        Some("all") => Some(None),
        Some("firstPage") => Some(Some(true)),
        Some("notFirstPage") => Some(Some(false)),
        None => None,
        Some(x) => return Err(CmdError::Params(format!("unknown `display` `{x}` (all|firstPage|notFirstPage)"))),
    };
    let behind = p::bool(v, "behind");
    for block in blocks {
        let sect = s.doc.section_mut(block);
        sect.page_borders = borders;
        if let Some(f) = from_text {
            sect.page_border_place.from_text = f;
        }
        if let Some(f) = first_page {
            sect.page_border_place.first_page = f;
        }
        if let Some(b) = behind {
            sect.page_border_place.behind = b;
        }
    }
    sel_result(s)
}

/// The page border sides of `v` ({top|left|bottom|right: {style?, width?, color?, space?}}): an art border (`apples`) takes
/// Word's art widths, 1 to 31 points, and every side its distance, 0 to 31 points (24 when not given, Word's default from the
/// page edge).
fn page_sides(v: &Value) -> Result<Borders, CmdError> {
    let obj = v.as_object().ok_or_else(|| CmdError::Params("`sides` is an object".into()))?;
    let side = |k: &str| -> Option<Border> {
        let x = obj.get(k).filter(|x| x.is_object())?;
        let style = p::str(x, "style").map(BorderStyle::from_ooxml).unwrap_or(BorderStyle::Single);
        let (lo, hi) = if style.is_art() { (1.0, 31.0) } else { (0.25, 6.0) };
        let width = p::f32(x, "width").unwrap_or(if style.is_art() { 16.0 } else { 0.5 }).clamp(lo, hi);
        let space = p::f32(x, "space").unwrap_or(24.0).clamp(0.0, 31.0);
        Some(Border { style, width, color: p::str(x, "color").and_then(Rgb::parse), space })
    };
    Ok(Borders { top: side("top"), left: side("left"), bottom: side("bottom"), right: side("right"), between: None, inside_v: None })
}

/// The page borders of the section holding the selection and where they sit (design.pageBorders' state): {sides, measureFrom,
/// display, behind}, sides null when it has none.
fn page_borders_state(s: &Session) -> Value {
    let block = s.sel.focus.path.0.first().copied().unwrap_or(0) as usize;
    let sections = s.doc.sections();
    let Some((_, sect)) = sections.iter().find(|(end, _)| block <= *end).or(sections.last()) else { return Value::Null };
    let place = sect.page_border_place;
    json!({
        "sides": sect.page_borders,
        "measureFrom": if place.from_text { "text" } else { "edge" },
        "display": match place.first_page { None => "all", Some(true) => "firstPage", Some(false) => "notFirstPage" },
        "behind": place.behind,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use ew_doc::props::BorderStyle;

    use crate::Session;

    /// Borders and Shading's Page Border tab: an art border measured from the text on the first page only, behind the text,
    /// and the state the dialog reads back.
    #[test]
    fn page_borders_take_art_and_placement() {
        let mut s = Session::new(ew_doc::Document::from_text("Text"));
        let side = json!({"style": "apples", "width": 20, "space": 4});
        s.run(
            "design.pageBorders",
            &json!({"sides": {"top": side, "left": side, "bottom": side, "right": side}, "measureFrom": "text", "display": "firstPage", "behind": true}),
        )
        .unwrap();
        let sect = &s.doc.last_section;
        let top = sect.page_borders.and_then(|b| b.top).unwrap();
        assert!(matches!(top.style, BorderStyle::Art(_)));
        assert_eq!((top.width, top.space), (20.0, 4.0));
        assert!(sect.page_border_place.from_text && sect.page_border_place.behind);
        assert_eq!(sect.page_border_place.first_page, Some(true));
        let (_, v) = (s.registry.get("design.pageBorders").and_then(|x| x.state).expect("a state reader"))(&s);
        assert_eq!((v["measureFrom"].clone(), v["display"].clone(), v["sides"]["top"]["style"].clone()), (json!("text"), json!("firstPage"), json!({"art": "apples"})), "{v}");
        s.run("design.pageBorders", &json!({"kind": "none", "display": "all"})).unwrap();
        assert!(s.doc.last_section.page_borders.is_none() && s.doc.last_section.page_border_place.first_page.is_none());
    }
}

#[cfg(test)]
mod watermark_tests {
    use crate::Session;
    use serde_json::json;
    use ew_doc::Document;

    fn png(w: u32, h: u32) -> String {
        let mut out = Vec::new();
        image::RgbImage::new(w, h).write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
        crate::cmd::insert::base64_encode(&out)
    }

    /// Picture watermarks (engine-gaps-rest): Auto fits the margins, a scale takes the picture's own size, washout is kept,
    /// and all of it reads back from .docx; a text watermark's language does too.
    #[test]
    fn picture_and_language_watermarks_round_trip() {
        let mut s = Session::new(Document::from_text("Body"));
        s.run("design.watermark", &json!({"picture": {"data": png(96, 48)}})).unwrap();
        let p = s.doc.settings.watermark.as_ref().and_then(|w| w.picture.clone()).expect("a picture watermark");
        assert!(p.washout && p.scale.is_none());
        assert!((p.size[0] / p.size[1] - 2.0).abs() < 0.01 && p.size[0] > 300.0, "fitted to the margins: {:?}", p.size);
        s.run("design.watermark", &json!({"picture": {"scale": 200, "washout": false}})).unwrap();
        let p = s.doc.settings.watermark.as_ref().and_then(|w| w.picture.clone()).unwrap();
        assert_eq!((p.size, p.washout), ([144.0, 72.0], false), "96 x 48 px at 96 ppi, doubled");
        let back = ew_docx::read(&ew_docx::write(&s.doc).unwrap()).unwrap();
        let q = back.settings.watermark.as_ref().and_then(|w| w.picture.clone()).expect("read back");
        assert_eq!((q.size, q.washout), (p.size, false));
        assert_eq!(back.media.get(&q.media).map(|b| b.len()), s.doc.media.get(&p.media).map(|b| b.len()));
        s.run("design.watermark", &json!({"text": "CONFIDENTIAL", "lang": "zh-HK"})).unwrap();
        let w = s.doc.settings.watermark.clone().unwrap();
        assert!(w.picture.is_none() && w.lang.as_deref() == Some("zh-HK"));
        let back = ew_docx::read(&ew_docx::write(&s.doc).unwrap()).unwrap();
        assert_eq!(back.settings.watermark.and_then(|w| w.lang).as_deref(), Some("zh-HK"));
    }
}
