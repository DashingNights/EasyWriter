//! The forum post's editing profile (docs/plans/engine/stage3-forum.md section 2): the blocks and marks a post allows, the
//! forum's colours, fonts and percent sizes, and the style sheet and numbering a post opens with. The values are the forum's
//! own (SPEC.md section 1, src/page.css): CSS pixels times 0.75 are points, and the 16 px base is 12 points.
//!
//! A post's stored model is read and written in the dark palette; the light theme is a paint remap ([`LIGHT`]), so a saved
//! model never depends on the theme the app showed it in.

use crate::numbering::{AbstractNum, Level, Numbering};
use crate::props::{Border, BorderStyle, Borders, CharProps, LineSpacing, ParaProps, Rgb, TextColor, Underline};
use crate::section::NumFormat;
use crate::styles::{Style, StyleKind, StyleSheet, TableStyleParts};

/// `Settings::profile` of a forum post (src/tooling/profile.mjs `TEXT_PROFILE`).
pub const PROFILE: &str = "post";

/// The block names the post kit has (src/extensions.js `forumExtensions`), which the post commands and the reader allow.
pub const BLOCKS: [&str; 20] = [
    "paragraph",
    "heading",
    "blockquote",
    "codeBlock",
    "horizontalRule",
    "bulletList",
    "orderedList",
    "listItem",
    "table",
    "tableRow",
    "tableHeader",
    "tableCell",
    "box",
    "boxTitle",
    "boxContent",
    "canvas",
    "planChart",
    "media",
    "hardBreak",
    "text",
];

/// The marks the post kit has; inline code drops every other mark.
pub const MARKS: [&str; 12] = [
    "bold",
    "italic",
    "underline",
    "strike",
    "subscript",
    "superscript",
    "code",
    "link",
    "fontSize",
    "textColor",
    "highlight",
    "fontFamily",
];

/// The sizes a run or the post's base text may take, percent (src/format.mjs `FONT_SIZES`). 100 is the base size, which is
/// not a mark.
pub const FONT_SIZES: [u16; 7] = [80, 90, 100, 125, 150, 175, 200];

/// The font choices, as CSS family names (src/format.mjs `FONTS`).
pub const FONTS: [&str; 18] = [
    "Helvetica",
    "Arial",
    "Arial Black",
    "Verdana",
    "Tahoma",
    "Trebuchet MS",
    "Impact",
    "Gill Sans",
    "Times New Roman",
    "Georgia",
    "Palatino",
    "Baskerville",
    "Andale Mono",
    "Courier",
    "Monaco",
    "Bradley Hand",
    "Brush Script MT",
    "Luminari",
];

/// A text colour key and its dark and light palette colours, from src/page.css. `root` is the default text and names no
/// colour, so it has no entry: a run with it carries no colour at all.
pub const COLORS: [(&str, Rgb, Rgb); 9] = [
    ("soft", SOFT, SOFT_LIGHT),
    ("hard", HARD, HARD_LIGHT),
    ("red", RED, RED),
    ("orange", ORANGE, ORANGE),
    ("yellow", YELLOW, YELLOW),
    ("green", GREEN, GREEN),
    ("blue", BLUE, BLUE),
    ("indigo", INDIGO, INDIGO),
    ("violet", VIOLET, VIOLET),
];

/// The highlight hues (src/format.mjs `HIGHLIGHTS`): each is [`blend`]ed over the page background at 25 %.
pub const HIGHLIGHT_HUES: [(&str, Rgb); 7] = [
    ("red", RED),
    ("orange", ORANGE),
    ("yellow", YELLOW),
    ("green", GREEN),
    ("blue", BLUE),
    ("indigo", INDIGO),
    ("violet", VIOLET),
];

/// The forum's dark palette, which models are saved in.
pub const TEXT: Rgb = Rgb(0xC5, 0xC6, 0xD0);
pub const HEAD: Rgb = Rgb(0xFF, 0xFF, 0xFF);
pub const PAPER: Rgb = Rgb(0x30, 0x30, 0x39);
pub const QUOTE_BG: Rgb = Rgb(0x3A, 0x3B, 0x46);
pub const QUOTE_BORDER: Rgb = Rgb(0x4C, 0x4D, 0x55);
pub const QUOTE_TEXT: Rgb = Rgb(0xA3, 0xA6, 0xB8);
pub const ICODE_BG: Rgb = Rgb(0x45, 0x46, 0x5A);
pub const TABLE_BORDER: Rgb = Rgb(0x6B, 0x6D, 0x80);
pub const TH_BG: Rgb = Rgb(0x45, 0x46, 0x5A);
pub const HR: Rgb = Rgb(0xC5, 0xC6, 0xD0);
pub const SOFT: Rgb = Rgb(0xA3, 0xA6, 0xB8);
pub const HARD: Rgb = Rgb(0xFF, 0xFF, 0xFF);
pub const RED: Rgb = Rgb(0xE0, 0x52, 0x52);
pub const ORANGE: Rgb = Rgb(0xE0, 0x99, 0x52);
pub const YELLOW: Rgb = Rgb(0xE0, 0xC9, 0x52);
pub const GREEN: Rgb = Rgb(0x62, 0xD9, 0x26);
pub const BLUE: Rgb = Rgb(0x3D, 0x99, 0xF5);
pub const INDIGO: Rgb = Rgb(0x9C, 0x6E, 0xF7);
pub const VIOLET: Rgb = Rgb(0xE0, 0x52, 0xE0);

/// The light palette's own values (src/page.css), for the ones that differ from the dark palette.
const SOFT_LIGHT: Rgb = Rgb(0x6B, 0x6D, 0x80);
const HARD_LIGHT: Rgb = Rgb(0x00, 0x00, 0x00);

/// Dark to light, for the paint remap (`PaintOptions::remap`): every palette colour whose light value differs. The dark
/// palette has one white for both headings and the `hard` text colour, whose light values differ (#111111 and #000000), so a
/// `hard` run in the light theme draws as the heading's nearly equal #111111.
pub const LIGHT: [(Rgb, Rgb); 10] = [
    (TEXT, Rgb(0x33, 0x33, 0x40)),
    (HEAD, Rgb(0x11, 0x11, 0x11)),
    (PAPER, Rgb(0xFF, 0xFF, 0xFF)),
    (QUOTE_BG, Rgb(0xF0, 0xF0, 0xF4)),
    (QUOTE_BORDER, Rgb(0xD0, 0xD0, 0xDA)),
    (QUOTE_TEXT, SOFT_LIGHT),
    (ICODE_BG, Rgb(0xEC, 0xEC, 0xF2)),
    (TABLE_BORDER, Rgb(0xD0, 0xD0, 0xDA)),
    (TH_BG, Rgb(0xEC, 0xEC, 0xF2)),
    (HR, Rgb(0xD0, 0xD0, 0xDA)),
];

/// The style ids a post names: the container roles' table styles, the paragraph styles inside them, the table style and the
/// inline code character style.
pub const QUOTE: &str = "PostQuote";
pub const CODE_BLOCK: &str = "PostCodeBlock";
pub const CODE_TEXT: &str = "PostCodeText";
pub const BOX: &str = "PostBox";
pub const BOX_TITLE: &str = "PostBoxTitle";
pub const RULE: &str = "PostRule";
pub const LIST_MORE: &str = "PostListMore";
pub const TABLE: &str = "PostTable";
pub const TABLE_HEAD: &str = "PostTh";
pub const CODE: &str = "PostCode";
pub const LINK: &str = "Hyperlink";

/// The list numbering's abstract definitions, which a list node's own `Num` refers to.
pub const BULLET_ABSTRACT: u32 = 0;
pub const NUMBER_ABSTRACT: u32 = 1;

/// The code's font (`ui-monospace, "Cascadia Code", monospace`; the system fallback is not a font name the engine knows).
pub const CODE_FONT: &str = "Cascadia Code";

/// A paragraph's space after: 1em at the 16 px base (src/page.css), points.
#[cfg(test)]
const GAP: f32 = 12.0;
/// A heading's margin, 14.5 px.
#[cfg(test)]
const HEAD_GAP: f32 = 10.875;
/// The base text's size at 100 %, points: 16 px.
const BASE_PT: f32 = 12.0;
/// The space one list level is indented, 1.5em at the 16 px base (src/page.css `ul, ol`).
pub const LIST_INDENT: f32 = 18.0;

/// The gap below a quote, code block or box: the forum's 1em margin, points (src/page.css `blockquote`, `pre`).
pub const CONTAINER_GAP: f32 = 12.0;

/// CSS pixels to points: the post kit's sizes are given in pixels, the engine's in points (`x * 0.75`).
pub const PX: f32 = 0.75;

/// The heading styles, by level: the reader maps a level to its style id and the writer the id back.
pub const HEADINGS: [&str; 6] = ["Heading1", "Heading2", "Heading3", "Heading4", "Heading5", "Heading6"];
/// The inline code's size, 1em of the text (`p code` in src/page.css undoes the base scale).
#[cfg(test)]
const CODE_PT: f32 = 12.0;
/// The code block's text size, 0.9em of 16 px.
#[cfg(test)]
const CODE_BLOCK_PT: f32 = 10.8;

/// A highlight's colour: `hue` at 25 % over `bg`, as `rgba(hue, .25)` composites it (src/page.css `mark`).
pub fn blend(hue: Rgb, bg: Rgb) -> Rgb {
    let mix = |h: u8, b: u8| ((f32::from(h) * 0.25 + f32::from(b) * 0.75).round() as i32).clamp(0, 255) as u8;
    Rgb(mix(hue.0, bg.0), mix(hue.1, bg.1), mix(hue.2, bg.2))
}

/// The style sheet a post opens with, as the stored model's own JSON (docs/plans/engine/stage3-forum.md section 2): the
/// forum's sizes, colours and lines written once as data, at the base font and size [`styles`] puts back.
const SHEET: &str = r#"{"defaultChr":{"font":"Helvetica","size":12,"color":{"Rgb":[197,198,208]},"lang":"en-US"},"defaultPara":{"spaceBefore":0,"spaceAfter":12},"defaultParaPresent":true,"styles":[{"id":"Normal","name":"Normal","para":{"spaceBefore":0,"spaceAfter":12},"priority":0,"quick":true,"builtin":true},{"id":"Heading1","name":"Heading 1","basedOn":"Normal","next":"Normal","para":{"spaceBefore":0,"spaceAfter":10.875,"keepNext":true,"outlineLevel":0},"chr":{"size":36,"bold":true,"color":{"Rgb":[255,255,255]}},"priority":1,"quick":true,"builtin":true},{"id":"Heading2","name":"Heading 2","basedOn":"Normal","next":"Normal","para":{"spaceBefore":10.875,"spaceAfter":10.875,"keepNext":true,"outlineLevel":1},"chr":{"size":26.4,"bold":true,"color":{"Rgb":[255,255,255]}},"priority":2,"quick":true,"builtin":true},{"id":"Heading3","name":"Heading 3","basedOn":"Normal","next":"Normal","para":{"spaceBefore":10.875,"spaceAfter":10.875,"keepNext":true,"outlineLevel":2},"chr":{"size":21.6,"bold":true,"color":{"Rgb":[255,255,255]}},"priority":3,"quick":true,"builtin":true},{"id":"Heading4","name":"Heading 4","basedOn":"Normal","next":"Normal","para":{"spaceBefore":10.875,"spaceAfter":10.875,"keepNext":true,"outlineLevel":3},"chr":{"size":18,"bold":true,"color":{"Rgb":[255,255,255]}},"priority":4,"quick":true,"builtin":true},{"id":"Heading5","name":"Heading 5","basedOn":"Normal","next":"Normal","para":{"spaceBefore":10.875,"spaceAfter":10.875,"keepNext":true,"outlineLevel":4},"chr":{"size":14.4,"bold":true,"color":{"Rgb":[255,255,255]}},"priority":5,"quick":true,"builtin":true},{"id":"Heading6","name":"Heading 6","basedOn":"Normal","next":"Normal","para":{"spaceBefore":10.875,"spaceAfter":10.875,"keepNext":true,"outlineLevel":5},"chr":{"size":12,"bold":true,"color":{"Rgb":[255,255,255]}},"priority":6,"quick":true,"builtin":true},{"id":"Hyperlink","name":"Hyperlink","kind":"character","chr":{"underline":"single","color":{"Rgb":[255,255,255]}},"builtin":true},{"id":"PostCode","name":"Post Code","kind":"character","chr":{"font":"Cascadia Code","size":12,"shading":[69,70,90]}},{"id":"PostCodeText","name":"Post Code Text","basedOn":"Normal","next":"Normal","para":{"spaceBefore":0,"spaceAfter":0},"chr":{"font":"Cascadia Code","size":10.8}},{"id":"PostBoxTitle","name":"Post Box Title","basedOn":"Normal","next":"Normal","para":{"spaceBefore":0,"spaceAfter":0},"chr":{"bold":true,"color":{"Rgb":[255,255,255]}}},{"id":"PostTh","name":"Post Table Header","basedOn":"Normal","next":"Normal","para":{"spaceBefore":0,"spaceAfter":0},"chr":{"bold":true}},{"id":"PostListMore","name":"Post List More","basedOn":"Normal","next":"Normal","para":{"spaceBefore":0,"spaceAfter":0}},{"id":"PostRule","name":"Post Rule","basedOn":"Normal","next":"Normal","para":{"spaceBefore":0,"spaceAfter":12,"borders":{"bottom":{"style":"single","width":0.75,"color":[197,198,208],"space":0}}}},{"id":"PostQuote","name":"Post Quote","kind":"table","chr":{"color":{"Rgb":[163,166,184]}},"table":{"borders":{"left":{"style":"single","width":2.25,"color":[76,77,85],"space":0}},"fill":[58,59,70],"cellMargins":[15,15,15,15]}},{"id":"PostCodeBlock","name":"Post Code Block","kind":"table","table":{"borders":{"left":{"style":"single","width":2.25,"color":[76,77,85],"space":0}},"fill":[58,59,70],"cellMargins":[13.5,13.5,13.5,13.5]}},{"id":"PostBox","name":"Post Box","kind":"table","table":{"borders":{"top":{"style":"single","width":0.75,"color":[107,109,128],"space":0},"left":{"style":"single","width":0.75,"color":[107,109,128],"space":0},"bottom":{"style":"single","width":0.75,"color":[107,109,128],"space":0},"right":{"style":"single","width":0.75,"color":[107,109,128],"space":0},"between":{"style":"single","width":0.75,"color":[107,109,128],"space":0},"inside_v":{"style":"single","width":0.75,"color":[107,109,128],"space":0}},"cellMargins":[6,12,6,12],"headerFill":[69,70,90],"headerChr":{"bold":true,"color":{"Rgb":[255,255,255]}}}},{"id":"PostTable","name":"Post Table","kind":"table","para":{"spaceBefore":0,"spaceAfter":0},"table":{"borders":{"top":{"style":"single","width":0.75,"color":[107,109,128],"space":0},"left":{"style":"single","width":0.75,"color":[107,109,128],"space":0},"bottom":{"style":"single","width":0.75,"color":[107,109,128],"space":0},"right":{"style":"single","width":0.75,"color":[107,109,128],"space":0},"between":{"style":"single","width":0.75,"color":[107,109,128],"space":0},"inside_v":{"style":"single","width":0.75,"color":[107,109,128],"space":0}},"cellMargins":[8.25,8.25,8.25,8.25],"headerFill":[69,70,90],"headerChr":{"bold":true}}}]}"#;

/// The style sheet a post opens with: `font` is its base font and `pct` its base size (percent, [`FONT_SIZES`]). The sizes
/// are the forum's, in points: paragraphs scale with `pct`, headings do not, and code is fixed (src/page.css).
pub fn styles(font: &str, pct: u16) -> StyleSheet {
    let pct = pct.clamp(FONT_SIZES[0], FONT_SIZES[FONT_SIZES.len() - 1]);
    let font = if font.is_empty() { FONTS[0] } else { font };
    let mut s = sheet();
    s.default_chr.font = Some(font.into());
    s.default_chr.size = Some(BASE_PT * f32::from(pct) / 100.0);
    // The forum's CSS line height (src/page.css): 1.8 for text, approximated by at-least spacing, and 1.1 for H1 to H3
    // (exact, as the DOM's line box is shorter than the glyphs), 1.8 for H4 to H6. A style's own size is its line's size.
    let base = s.default_chr.size.unwrap_or(BASE_PT);
    s.default_para.line_spacing = Some(line_spacing("Normal", base));
    for st in s.styles.iter_mut().filter(|st| st.kind == StyleKind::Paragraph) {
        let size = st.chr.size.unwrap_or(base);
        st.para.line_spacing = Some(line_spacing(&st.id, size));
    }
    s
}

/// The line spacing of paragraph style `id` at `size` points: CSS's line height for the forum (see [`styles`]).
fn line_spacing(id: &str, size: f32) -> LineSpacing {
    let points = |v: f32| (v * 100.0).round() / 100.0;
    match id {
        "Heading1" | "Heading2" | "Heading3" => LineSpacing::Exactly(points(size * 1.1)),
        _ => LineSpacing::AtLeast(points(size * 1.8)),
    }
}

/// The sheet's data as the model: the design's tables read through the engine's one JSON reader, field by field.
fn sheet() -> StyleSheet {
    let Ok(v) = crate::chart::read_value(SHEET) else { return StyleSheet::empty() };
    let mut s = StyleSheet::empty();
    if let Some(c) = v.get("defaultChr") {
        s.default_chr = char_props(c);
    }
    if let Some(p) = v.get("defaultPara") {
        s.default_para = para_props(p);
    }
    s.default_para_present = v.get("defaultParaPresent").and_then(serde_json::Value::as_bool).unwrap_or(true);
    for st in v.get("styles").and_then(serde_json::Value::as_array).into_iter().flatten() {
        s.styles.push(style(st));
    }
    s
}

fn text(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(serde_json::Value::as_str).map(str::to_string)
}

fn num(v: &serde_json::Value, key: &str) -> Option<f32> {
    v.get(key).and_then(serde_json::Value::as_f64).map(|n| n as f32)
}

fn flag(v: &serde_json::Value, key: &str) -> Option<bool> {
    v.get(key).and_then(serde_json::Value::as_bool)
}

fn count(v: &serde_json::Value, key: &str) -> Option<u32> {
    v.get(key).and_then(serde_json::Value::as_u64).and_then(|n| u32::try_from(n).ok())
}

/// `[r, g, b]` as a colour.
fn rgb(v: &serde_json::Value) -> Option<Rgb> {
    let a = v.as_array()?;
    let ch = |i: usize| a.get(i).and_then(serde_json::Value::as_u64).and_then(|n| u8::try_from(n).ok());
    Some(Rgb(ch(0)?, ch(1)?, ch(2)?))
}

fn colour(v: &serde_json::Value) -> Option<TextColor> {
    rgb(v.get("Rgb")?).map(TextColor::Rgb)
}

fn char_props(v: &serde_json::Value) -> CharProps {
    CharProps {
        font: text(v, "font"),
        size: num(v, "size"),
        bold: flag(v, "bold"),
        underline: text(v, "underline").and_then(|u| match u.as_str() {
            "single" => Some(Underline::Single),
            "words" => Some(Underline::Words),
            "double" => Some(Underline::Double),
            "thick" => Some(Underline::Thick),
            "dotted" => Some(Underline::Dotted),
            "dash" => Some(Underline::Dash),
            _ => None,
        }),
        color: v.get("color").and_then(colour),
        shading: v.get("shading").and_then(rgb),
        lang: text(v, "lang"),
        ..CharProps::default()
    }
}

fn para_props(v: &serde_json::Value) -> ParaProps {
    ParaProps {
        space_before: num(v, "spaceBefore"),
        space_after: num(v, "spaceAfter"),
        keep_next: flag(v, "keepNext"),
        outline_level: count(v, "outlineLevel").and_then(|n| u8::try_from(n).ok()),
        borders: v.get("borders").map(borders),
        ..ParaProps::default()
    }
}

fn borders(v: &serde_json::Value) -> Borders {
    let side = |k: &str| v.get(k).and_then(border);
    Borders { top: side("top"), left: side("left"), bottom: side("bottom"), right: side("right"), between: side("between"), inside_v: side("inside_v") }
}

fn border(v: &serde_json::Value) -> Option<Border> {
    Some(Border {
        style: match text(v, "style")?.as_str() {
            "single" => BorderStyle::Single,
            "double" => BorderStyle::Double,
            "dotted" => BorderStyle::Dotted,
            "dashed" => BorderStyle::Dashed,
            "thick" => BorderStyle::Thick,
            "triple" => BorderStyle::Triple,
            "dotDash" => BorderStyle::DotDash,
            "wave" => BorderStyle::Wave,
            _ => return None,
        },
        width: num(v, "width").unwrap_or(0.0),
        color: v.get("color").and_then(rgb),
        space: num(v, "space").unwrap_or(0.0),
    })
}

fn style(v: &serde_json::Value) -> Style {
    Style {
        id: text(v, "id").unwrap_or_default(),
        name: text(v, "name").unwrap_or_default(),
        kind: match text(v, "kind").as_deref() {
            Some("character") => StyleKind::Character,
            Some("table") => StyleKind::Table,
            Some("numbering") => StyleKind::Numbering,
            _ => StyleKind::Paragraph,
        },
        based_on: text(v, "basedOn"),
        next: text(v, "next"),
        para: v.get("para").map(para_props).unwrap_or_default(),
        chr: v.get("chr").map(char_props).unwrap_or_default(),
        priority: count(v, "priority"),
        quick: flag(v, "quick").unwrap_or(false),
        hidden: flag(v, "hidden").unwrap_or(false),
        builtin: flag(v, "builtin").unwrap_or(false),
        table: v.get("table").map(parts),
        ..Style::default()
    }
}

fn parts(v: &serde_json::Value) -> TableStyleParts {
    TableStyleParts {
        borders: v.get("borders").map(borders),
        fill: v.get("fill").and_then(rgb),
        cell_margins: v.get("cellMargins").and_then(|m| {
            let a = m.as_array()?;
            let at = |i: usize| a.get(i).and_then(serde_json::Value::as_f64).map(|n| n as f32);
            Some([at(0)?, at(1)?, at(2)?, at(3)?])
        }),
        header_fill: v.get("headerFill").and_then(rgb),
        header_chr: v.get("headerChr").map(char_props).unwrap_or_default(),
        ..TableStyleParts::default()
    }
}

#[cfg(test)]
fn text_colour(c: Rgb) -> Option<TextColor> {
    Some(TextColor::Rgb(c))
}

#[cfg(test)]
fn line(width: f32, colour: Rgb) -> Border {
    Border { style: BorderStyle::Single, width, color: Some(colour), space: 0.0 }
}

#[cfg(test)]
fn para_style(id: &str, name: &str, based_on: &str) -> Style {
    Style { id: id.into(), name: name.into(), kind: StyleKind::Paragraph, based_on: Some(based_on.into()), next: Some("Normal".into()), ..Default::default() }
}

#[cfg(test)]
fn table_style(id: &str, name: &str, parts: TableStyleParts) -> Style {
    Style { id: id.into(), name: name.into(), kind: StyleKind::Table, table: Some(parts), ..Default::default() }
}

/// [`styles`] built struct by struct, as the design's tables read: the test-only reference the sheet's JSON is compared with.
#[cfg(test)]
fn built_styles(font: &str, pct: u16) -> StyleSheet {
    let pct = pct.clamp(FONT_SIZES[0], FONT_SIZES[FONT_SIZES.len() - 1]);
    let size = BASE_PT * f32::from(pct) / 100.0;
    let font = if font.is_empty() { FONTS[0] } else { font };
    let mut s = StyleSheet::empty();
    s.default_chr = CharProps { font: Some(font.into()), size: Some(size), color: text_colour(TEXT), lang: Some("en-US".into()), ..CharProps::default() };
    s.default_para = ParaProps { space_before: Some(0.0), space_after: Some(GAP), ..ParaProps::default() };
    s.styles.push(Style {
        id: "Normal".into(),
        name: "Normal".into(),
        para: ParaProps { space_before: Some(0.0), space_after: Some(GAP), ..ParaProps::default() },
        priority: Some(0),
        quick: true,
        builtin: true,
        ..Default::default()
    });
    // h1 to h6: 3em to 1em of the 16 px base, bold, in the heading colour (src/page.css). h1 has no space above.
    let heads: [(f32, f32); 6] = [(36.0, 0.0), (26.4, HEAD_GAP), (21.6, HEAD_GAP), (18.0, HEAD_GAP), (14.4, HEAD_GAP), (12.0, HEAD_GAP)];
    for (i, (head_size, before)) in heads.into_iter().enumerate() {
        let n = i + 1;
        let mut style = para_style(&format!("Heading{n}"), &format!("Heading {n}"), "Normal");
        style.priority = Some(n as u32);
        style.quick = true;
        style.builtin = true;
        style.para = ParaProps { space_before: Some(before), space_after: Some(HEAD_GAP), keep_next: Some(true), outline_level: Some(i as u8), ..ParaProps::default() };
        style.chr = CharProps { size: Some(head_size), bold: Some(true), color: text_colour(HEAD), ..CharProps::default() };
        s.styles.push(style);
    }
    s.styles.push(Style {
        id: LINK.into(),
        name: "Hyperlink".into(),
        kind: StyleKind::Character,
        chr: CharProps { color: text_colour(HEAD), underline: Some(Underline::Single), ..CharProps::default() },
        builtin: true,
        ..Default::default()
    });
    s.styles.push(Style {
        id: CODE.into(),
        name: "Post Code".into(),
        kind: StyleKind::Character,
        chr: CharProps { font: Some(CODE_FONT.into()), size: Some(CODE_PT), shading: Some(ICODE_BG), ..CharProps::default() },
        ..Default::default()
    });
    // A code block's lines: 0.9em of the base, `pre`'s spacing with no paragraph gap.
    let mut code_text = para_style(CODE_TEXT, "Post Code Text", "Normal");
    code_text.para = ParaProps { space_before: Some(0.0), space_after: Some(0.0), ..ParaProps::default() };
    code_text.chr = CharProps { font: Some(CODE_FONT.into()), size: Some(CODE_BLOCK_PT), ..CharProps::default() };
    s.styles.push(code_text);
    let mut box_title = para_style(BOX_TITLE, "Post Box Title", "Normal");
    box_title.para = ParaProps { space_before: Some(0.0), space_after: Some(0.0), ..ParaProps::default() };
    box_title.chr = CharProps { bold: Some(true), color: text_colour(HEAD), ..CharProps::default() };
    s.styles.push(box_title);
    // A table header cell's text: bold (600) in the table's own fill, with no paragraph gap.
    let mut th = para_style(TABLE_HEAD, "Post Table Header", "Normal");
    th.para = ParaProps { space_before: Some(0.0), space_after: Some(0.0), ..ParaProps::default() };
    th.chr = CharProps { bold: Some(true), ..CharProps::default() };
    s.styles.push(th);
    // A list item's blocks after its first paragraph: indented to the level (its own indent) and with no gap between them.
    let mut more = para_style(LIST_MORE, "Post List More", "Normal");
    more.para = ParaProps { space_before: Some(0.0), space_after: Some(0.0), ..ParaProps::default() };
    s.styles.push(more);
    // A horizontal rule: an empty paragraph with a bottom border, and the 1em gap below it.
    let mut rule = para_style(RULE, "Post Rule", "Normal");
    rule.para = ParaProps {
        space_before: Some(0.0),
        space_after: Some(GAP),
        borders: Some(Borders { bottom: Some(line(0.75, HR)), ..Borders::default() }),
        ..ParaProps::default()
    };
    s.styles.push(rule);

    // A quote: the grey fill and its 3 px left rule, 20 px of padding, in the quote's text colour.
    let mut quote = table_style(
        QUOTE,
        "Post Quote",
        TableStyleParts {
            fill: Some(QUOTE_BG),
            borders: Some(Borders { left: Some(line(2.25, QUOTE_BORDER)), ..Borders::default() }),
            cell_margins: Some([15.0; 4]),
            ..TableStyleParts::default()
        },
    );
    quote.chr = CharProps { color: text_colour(QUOTE_TEXT), ..CharProps::default() };
    s.styles.push(quote);
    // A code block: the same fill and left rule, 18 px of padding; its text is PostCodeText.
    s.styles.push(table_style(
        CODE_BLOCK,
        "Post Code Block",
        TableStyleParts {
            fill: Some(QUOTE_BG),
            borders: Some(Borders { left: Some(line(2.25, QUOTE_BORDER)), ..Borders::default() }),
            cell_margins: Some([13.5; 4]),
            ..TableStyleParts::default()
        },
    ));
    // A titled box: a 1 px border all round, a title band in the header colour, 8 px by 16 px of padding.
    s.styles.push(table_style(
        BOX,
        "Post Box",
        TableStyleParts {
            borders: Some(Borders::all(line(0.75, TABLE_BORDER))),
            cell_margins: Some([6.0, 12.0, 6.0, 12.0]),
            header_fill: Some(TH_BG),
            header_chr: CharProps { bold: Some(true), color: text_colour(HEAD), ..CharProps::default() },
            ..TableStyleParts::default()
        },
    ));
    // A table: 1 px borders all round, 11 px of cell padding, a header row in the light fill, no paragraph gap.
    let mut table = table_style(
        TABLE,
        "Post Table",
        TableStyleParts {
            borders: Some(Borders::all(line(0.75, TABLE_BORDER))),
            cell_margins: Some([8.25; 4]),
            header_fill: Some(TH_BG),
            header_chr: CharProps { bold: Some(true), ..CharProps::default() },
            ..TableStyleParts::default()
        },
    );
    table.para = ParaProps { space_before: Some(0.0), space_after: Some(0.0), ..ParaProps::default() };
    s.styles.push(table);
    // The CSS line height on the defaults and every paragraph style, as [`styles`] sets it.
    s.default_para.line_spacing = Some(line_spacing("Normal", size));
    for st in s.styles.iter_mut().filter(|st| st.kind == StyleKind::Paragraph) {
        let own = st.chr.size.unwrap_or(size);
        st.para.line_spacing = Some(line_spacing(&st.id, own));
    }
    s
}

fn levels(bullet: bool) -> Vec<Level> {
    (0..9)
        .map(|i| {
            let n = i + 1;
            Level {
                format: if bullet { NumFormat::Bullet } else { NumFormat::Decimal },
                text: if bullet { ['•', '○', '▪'][i % 3].to_string() } else { format!("%{n}.") },
                indent: LIST_INDENT * n as f32,
                hanging: LIST_INDENT,
                chr: if bullet { CharProps { font: Some("Arial".into()), ..CharProps::default() } } else { CharProps::default() },
                ..Level::default()
            }
        })
        .collect()
}

/// The numbering a post opens with: one bulleted and one numbered abstract definition, nine levels each, at 1.5em a level.
/// A list node gets a `Num` of its own, referring to one of the two ([`BULLET_ABSTRACT`], [`NUMBER_ABSTRACT`]).
pub fn numbering() -> Numbering {
    Numbering {
        abstracts: vec![
            AbstractNum { id: BULLET_ABSTRACT, name: Some("Post Bullet".into()), levels: levels(true), ..AbstractNum::default() },
            AbstractNum { id: NUMBER_ABSTRACT, name: Some("Post Number".into()), levels: levels(false), ..AbstractNum::default() },
        ],
        nums: Vec::new(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_sheet_reads_as_the_design_s_tables() {
        // Every field, against the design's tables built struct by struct (the test-only builder above), at the base font
        // and at a scaled one.
        for (font, pct) in [("Helvetica", 100), ("Georgia", 150), ("", 80), ("Arial Black", 200)] {
            assert_eq!(styles(font, pct), built_styles(font, pct), "{font} {pct}");
        }
    }

    #[test]
    fn the_style_sheet_holds_the_posts_sizes_colours_and_line() {
        let s = styles("Georgia", 100);
        let normal = s.get("Normal").unwrap();
        assert_eq!((normal.chr.size, normal.para.space_after, s.default_chr.size), (None, Some(12.0), Some(12.0)));
        assert_eq!(s.default_chr.font.as_deref(), Some("Georgia"));
        let h1 = s.get("Heading1").unwrap();
        assert_eq!((h1.chr.size, h1.para.space_before, h1.chr.bold), (Some(36.0), Some(0.0), Some(true)));
        let h3 = s.get("Heading3").unwrap();
        assert_eq!((h3.chr.size, h3.para.space_before, h3.para.space_after), (Some(21.6), Some(HEAD_GAP), Some(HEAD_GAP)));
        // The forum's CSS line height: text 1.8 (at least) and H1 to H3 1.1 (exact).
        assert_eq!((normal.para.line_spacing, s.default_para.line_spacing), (Some(LineSpacing::AtLeast(21.6)), Some(LineSpacing::AtLeast(21.6))));
        assert_eq!(h1.para.line_spacing, Some(LineSpacing::Exactly(39.6)));
        assert_eq!(s.get("PostCodeText").unwrap().para.line_spacing, Some(LineSpacing::AtLeast(19.44)));
        // A paragraph scales with the base size; headings and code do not.
        assert_eq!(styles("Georgia", 150).default_chr.size, Some(18.0));
        assert_eq!(styles("Georgia", 150).get("Heading1").unwrap().chr.size, Some(36.0));
        assert_eq!(styles("Georgia", 150).get("Normal").unwrap().para.line_spacing, Some(LineSpacing::AtLeast(32.4)));
        // The quote is a table style: the grey fill, its 3 px left rule and 20 px of padding.
        let quote = s.table_style(QUOTE).unwrap();
        assert_eq!(quote.parts.fill, Some(QUOTE_BG));
        assert_eq!(quote.parts.borders.and_then(|b| b.left), Some(line(2.25, QUOTE_BORDER)));
        assert_eq!(quote.parts.cell_margins, Some([15.0; 4]));
        assert_eq!(quote.chr.color, text_colour(QUOTE_TEXT));
        // The box's title band repeats in the header colour.
        let b = s.table_style(BOX).unwrap();
        assert_eq!((b.parts.header_fill, b.parts.header_chr.bold), (Some(TH_BG), Some(true)));
        assert_eq!(b.parts.cell_margins, Some([6.0, 12.0, 6.0, 12.0]));
        // The rule is a bottom border; inline code is shaded, in the code font.
        let rule = s.get(RULE).unwrap();
        assert_eq!(rule.para.borders.and_then(|b| b.bottom), Some(line(0.75, HR)));
        let code = s.get(CODE).unwrap();
        assert_eq!((code.chr.font.as_deref(), code.chr.shading), (Some(CODE_FONT), Some(ICODE_BG)));
        assert_eq!(s.get("Hyperlink").unwrap().chr.underline, Some(Underline::Single));
    }

    #[test]
    fn a_highlight_is_a_quarter_of_its_hue_over_the_page() {
        assert_eq!(blend(RED, Rgb(0, 0, 0)), Rgb(0x38, 0x15, 0x15));
        assert_eq!(blend(RED, PAPER), Rgb(0x5C, 0x39, 0x3F));
        assert_eq!(COLORS.len(), 9);
        assert_eq!(HIGHLIGHT_HUES.len(), 7);
    }

    #[test]
    fn numbering_is_a_bulleted_and_a_numbered_list_of_nine_levels() {
        let n = numbering();
        assert!(n.nums.is_empty());
        let [bullet, number] = [n.abstracts.first().unwrap(), n.abstracts.get(1).unwrap()];
        assert_eq!((bullet.id, bullet.levels.len()), (BULLET_ABSTRACT, 9));
        assert_eq!((bullet.levels[0].format, bullet.levels[1].text.as_str()), (NumFormat::Bullet, "○"));
        assert_eq!((number.id, number.levels[0].format), (NUMBER_ABSTRACT, NumFormat::Decimal));
        // 1.5em a level: 18 points for the first, 162 for the ninth.
        assert_eq!((bullet.levels[0].indent, bullet.levels[8].indent), (18.0, 162.0));
        assert_eq!(number.levels[0].text, "%1.");
    }

    #[test]
    fn the_lists_are_the_kit_and_the_design() {
        assert!(BLOCKS.contains(&"box") && BLOCKS.contains(&"media") && BLOCKS.contains(&"hardBreak") && BLOCKS.contains(&"text"));
        assert!(MARKS.contains(&"code") && MARKS.contains(&"fontFamily"));
        assert_eq!((BLOCKS.len(), MARKS.len(), FONTS.len(), FONT_SIZES.len()), (20, 12, 18, 7));
        assert_eq!(PROFILE, "post");
    }
}
