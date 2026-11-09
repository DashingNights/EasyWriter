//! EasyWriter engine-pictures-2: SVG pictures stay vector. An SVG is read into the metafile crate's picture model, so the
//! painter and the PDF writer draw it as they draw EMF and WMF, sharp at any zoom. Read is the subset Word's SVG pictures
//! and icons use: `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` and `text` in groups with transforms,
//! `use` of an element by id; fill, stroke, their opacities, `opacity`, `fill-rule`, `display` and `visibility` from
//! attributes, `style`, and a `<style>` sheet of element, class and id rules; the root's `viewBox` and
//! `preserveAspectRatio`. A gradient fills in its stops' mean colour.
// ponytail: no clip paths, masks, patterns, filters, markers, embedded pictures or nested viewports; each waits for a file
// that needs it.

use std::collections::HashMap;

use vello_cpu::kurbo::{self, Affine, BezPath, PathEl, Shape};
use ew_metafile::{HAlign, Item, Picture, Seg, Text, VAlign};

/// Most elements read from one file, and how deep they nest: a hostile file stops there.
const MAX_NODES: usize = 100_000;
const MAX_DEPTH: usize = 64;
/// Most items one picture draws.
const MAX_ITEMS: usize = 50_000;
/// How deep `use` may nest.
const MAX_USE_DEPTH: usize = 8;

/// Whether `bytes` are an SVG file: XML text whose first element is `svg`.
pub fn is_svg(bytes: &[u8]) -> bool {
    // Every picture is asked at each paint: a bitmap's first byte answers it.
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if body.iter().find(|b| !b.is_ascii_whitespace()) != Some(&b'<') {
        return false;
    }
    let head = &bytes[..bytes.len().min(4096)];
    let text = String::from_utf8_lossy(head);
    let t = text.trim_start_matches('\u{FEFF}').trim_start();
    t.starts_with('<') && first_element(t).is_some_and(|n| n == "svg")
}

/// The name (no prefix) of the first element in `t`, past the XML declaration, comments and the doctype.
fn first_element(mut t: &str) -> Option<&str> {
    loop {
        t = t.trim_start();
        if let Some(r) = t.strip_prefix("<!--") {
            t = r.split_once("-->")?.1;
        } else if t.starts_with("<?") || t.starts_with("<!") {
            t = t.split_once('>')?.1;
        } else {
            let r = t.strip_prefix('<')?;
            let end = r.find(|c: char| c.is_whitespace() || c == '>' || c == '/').unwrap_or(r.len());
            let name = r.get(..end)?;
            return Some(name.rsplit(':').next().unwrap_or(name));
        }
    }
}

/// The natural size of an SVG picture in points (its CSS pixels at 96 ppi), as Word inserts it.
pub fn svg_size(bytes: &[u8]) -> Option<(f32, f32)> {
    let root = parse_xml(std::str::from_utf8(bytes).ok()?)?;
    let (w, h, _) = viewport(&root);
    Some(((w * 0.75) as f32, (h * 0.75) as f32))
}

/// An SVG picture's drawing, in its CSS pixels. None when the bytes are no SVG or it has no size.
pub fn svg_picture(bytes: &[u8]) -> Option<Picture> {
    let root = parse_xml(std::str::from_utf8(bytes).ok()?)?;
    let (w, h, view) = viewport(&root);
    let mut r = Reader { sheet: sheet(&root), root: &root, items: Vec::new(), uses: 0 };
    // The root's own fill, stroke and the rest pass to what it holds.
    let style = r.style_of(&root, &Style::default());
    for k in &root.kids {
        r.element(k, &style, view, 0);
    }
    let pic = Picture { width: w as f32, height: h as f32, items: r.items, clips: Vec::new() };
    pic.has_size().then_some(pic)
}

// ---------------------------------------------------------------------------------------------
// XML

#[derive(Default, Debug)]
pub(crate) struct Node {
    pub(crate) name: String,
    pub(crate) attrs: Vec<(String, String)>,
    pub(crate) kids: Vec<Node>,
    pub(crate) text: String,
}

impl Node {
    pub(crate) fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    /// The text of this element and those in it (a `text` with its `tspan`s).
    fn all_text(&self) -> String {
        let mut s = self.text.clone();
        for k in &self.kids {
            s.push_str(&k.all_text());
        }
        s
    }
}

/// The local part of a qualified name (`svg:path` is `path`); an attribute keeps `xlink:href` as `href`.
fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

/// The `svg` element of an XML text, with its elements, attributes and text. Comments, processing instructions and the
/// doctype are skipped; CDATA is text.
pub(crate) fn parse_xml(src: &str) -> Option<Node> {
    let mut stack: Vec<Node> = vec![Node::default()];
    let mut rest = src;
    let mut count = 0usize;
    while let Some(i) = rest.find('<') {
        if let Some(top) = stack.last_mut() {
            top.text.push_str(&unescape(&rest[..i]));
        }
        rest = &rest[i..];
        if let Some(r) = rest.strip_prefix("<!--") {
            rest = r.split_once("-->").map_or("", |(_, t)| t);
        } else if let Some(r) = rest.strip_prefix("<![CDATA[") {
            let (cdata, after) = r.split_once("]]>").unwrap_or((r, ""));
            if let Some(top) = stack.last_mut() {
                top.text.push_str(cdata);
            }
            rest = after;
        } else if rest.starts_with("<!DOCTYPE") && rest.split_once('>').is_some_and(|(d, _)| d.contains('[')) {
            rest = rest.split_once("]>").map_or("", |(_, t)| t);
        } else if rest.starts_with("<?") || rest.starts_with("<!") {
            rest = rest.split_once('>').map_or("", |(_, t)| t);
        } else if let Some(r) = rest.strip_prefix("</") {
            rest = r.split_once('>').map_or("", |(_, t)| t);
            if stack.len() > 1
                && let Some(n) = stack.pop()
                && let Some(top) = stack.last_mut()
            {
                top.kids.push(n);
            }
        } else {
            let r = &rest[1..];
            let end = tag_end(r)?;
            let (body, closed) = match r[..end].strip_suffix('/') {
                Some(b) => (b, true),
                None => (&r[..end], false),
            };
            rest = &r[end + 1..];
            count += 1;
            if count > MAX_NODES || stack.len() > MAX_DEPTH {
                break;
            }
            let node = tag(body);
            if closed {
                stack.last_mut()?.kids.push(node);
            } else {
                stack.push(node);
            }
        }
    }
    while stack.len() > 1 {
        let n = stack.pop()?;
        stack.last_mut()?.kids.push(n);
    }
    stack.pop()?.kids.into_iter().find(|n| n.name == "svg")
}

/// Where a tag that starts `r` (after its `<`) ends: its `>` outside quotes.
fn tag_end(r: &str) -> Option<usize> {
    let mut quote = None;
    for (i, c) in r.char_indices() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            (None, '>') => return Some(i),
            _ => {}
        }
    }
    None
}

/// A start tag's name and attributes.
fn tag(body: &str) -> Node {
    let end = body.find(|c: char| c.is_whitespace()).unwrap_or(body.len());
    let mut node = Node { name: local(&body[..end]).to_string(), ..Node::default() };
    let mut rest = &body[end..];
    while let Some(eq) = rest.find('=') {
        let name = rest[..eq].trim();
        let after = rest[eq + 1..].trim_start();
        let Some(q) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else { break };
        let Some((value, tail)) = after[1..].split_once(q) else { break };
        if !name.is_empty() && !name.starts_with("xmlns") {
            let key = if name.ends_with(":href") { "href" } else { local(name) };
            node.attrs.push((key.to_string(), unescape(value)));
        }
        rest = tail;
    }
    node
}

fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|e| *e <= 12) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let ent = &rest[1..end];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            e => e
                .strip_prefix("#x")
                .or_else(|| e.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| e.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => out.push(c),
            None => out.push_str(&rest[..=end]),
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------------------------
// The viewport

/// The root's size in CSS pixels and the transform from its user space (the viewBox) to them.
fn viewport(root: &Node) -> (f64, f64, Affine) {
    let vb: Option<[f64; 4]> = root.attr("viewBox").and_then(|v| {
        let n = numbers(v);
        (n.len() == 4 && n[2] > 0.0 && n[3] > 0.0).then(|| [n[0], n[1], n[2], n[3]])
    });
    let side = |name: &str| root.attr(name).filter(|v| !v.trim().ends_with('%')).and_then(|v| length(v, 0.0)).filter(|v| *v > 0.0);
    // A side given alone keeps the viewBox's proportions; neither takes the viewBox's size, or CSS's 300 × 150.
    let (mut w, mut h) = match (side("width"), side("height"), vb) {
        (Some(w), Some(h), _) => (w, h),
        (Some(w), None, Some(b)) => (w, w * b[3] / b[2]),
        (None, Some(h), Some(b)) => (h * b[2] / b[3], h),
        (None, None, Some(b)) => (b[2], b[3]),
        (w, h, None) => (w.unwrap_or(300.0), h.unwrap_or(150.0)),
    };
    if !(w.is_finite() && h.is_finite()) || w <= 0.0 || h <= 0.0 {
        (w, h) = (300.0, 150.0);
    }
    let (w, h) = (w.min(1e5), h.min(1e5));
    let Some([x, y, bw, bh]) = vb else { return (w, h, Affine::IDENTITY) };
    let par = root.attr("preserveAspectRatio").unwrap_or("xMidYMid meet");
    let (sx, sy) = (w / bw, h / bh);
    if par.trim_start().starts_with("none") {
        return (w, h, Affine::scale_non_uniform(sx, sy) * Affine::translate((-x, -y)));
    }
    let s = if par.contains("slice") { sx.max(sy) } else { sx.min(sy) };
    let along = |key_min: &str, key_max: &str, room: f64| {
        if par.contains(key_min) {
            0.0
        } else if par.contains(key_max) {
            room
        } else {
            room / 2.0
        }
    };
    let dx = along("xMin", "xMax", w - bw * s);
    let dy = along("YMin", "YMax", h - bh * s);
    (w, h, Affine::translate((dx, dy)) * Affine::scale(s) * Affine::translate((-x, -y)))
}

/// The numbers in a list such as a viewBox or `points` (commas or spaces between them).
fn numbers(s: &str) -> Vec<f64> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_digit() || c == b'-' || c == b'+' || c == b'.' {
            let start = i;
            i += 1;
            let mut dot = c == b'.';
            while i < b.len() {
                let d = b[i];
                let exp = (d == b'e' || d == b'E') && i + 1 < b.len();
                if d.is_ascii_digit() || (d == b'.' && !dot) {
                    dot |= d == b'.';
                    i += 1;
                } else if exp {
                    i += if matches!(b[i + 1], b'-' | b'+') { 2 } else { 1 };
                } else {
                    break;
                }
            }
            if let Some(v) = s.get(start..i).and_then(|t| t.parse::<f64>().ok()).filter(|v| v.is_finite()) {
                out.push(v);
            }
        } else {
            i += 1;
        }
    }
    out
}

/// A length in CSS pixels: a number with an optional unit (`em` against `font`).
fn length(v: &str, font: f64) -> Option<f64> {
    let v = v.trim();
    let split = v.find(|c: char| c.is_ascii_alphabetic() || c == '%').unwrap_or(v.len());
    let n: f64 = v[..split].trim().parse().ok().filter(|n: &f64| n.is_finite())?;
    let k = match v[split..].trim() {
        "" | "px" => 1.0,
        "pt" => 4.0 / 3.0,
        "pc" => 16.0,
        "in" => 96.0,
        "cm" => 96.0 / 2.54,
        "mm" => 96.0 / 25.4,
        "em" => if font > 0.0 { font } else { 16.0 },
        "ex" => if font > 0.0 { font / 2.0 } else { 8.0 },
        _ => return None,
    };
    Some(n * k)
}

/// A `transform` attribute.
fn transform(v: &str) -> Affine {
    let mut out = Affine::IDENTITY;
    for part in v.split(')') {
        let Some((name, args)) = part.split_once('(') else { continue };
        let a = numbers(args);
        let at = |i: usize| a.get(i).copied().unwrap_or(0.0);
        let t = match name.trim().trim_start_matches(',').trim() {
            "matrix" if a.len() == 6 => Affine::new([a[0], a[1], a[2], a[3], a[4], a[5]]),
            "translate" => Affine::translate((at(0), at(1))),
            "scale" => Affine::scale_non_uniform(at(0), a.get(1).copied().unwrap_or(at(0))),
            "rotate" => Affine::translate((at(1), at(2))) * Affine::rotate(at(0).to_radians()) * Affine::translate((-at(1), -at(2))),
            "skewX" => Affine::skew(at(0).to_radians().tan(), 0.0),
            "skewY" => Affine::skew(0.0, at(0).to_radians().tan()),
            _ => continue,
        };
        out *= t;
    }
    if out.is_finite() { out } else { Affine::IDENTITY }
}

// ---------------------------------------------------------------------------------------------
// Styles

/// A fill or stroke paint.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Ink {
    None,
    Color([u8; 3]),
    Current,
}

#[derive(Clone, Debug)]
struct Style {
    fill: Ink,
    stroke: Ink,
    stroke_width: f64,
    fill_opacity: f64,
    stroke_opacity: f64,
    /// The element's own opacity times its groups'.
    opacity: f64,
    even_odd: bool,
    color: [u8; 3],
    font_size: f64,
    font: String,
    bold: bool,
    italic: bool,
    anchor: HAlign,
    hidden: bool,
}

impl Default for Style {
    fn default() -> Self {
        Style {
            fill: Ink::Color([0, 0, 0]),
            stroke: Ink::None,
            stroke_width: 1.0,
            fill_opacity: 1.0,
            stroke_opacity: 1.0,
            opacity: 1.0,
            even_odd: false,
            color: [0, 0, 0],
            font_size: 16.0,
            font: "Arial".into(),
            bold: false,
            italic: false,
            anchor: HAlign::Left,
            hidden: false,
        }
    }
}

/// A rule of a `<style>` sheet: one compound selector (element, id, classes; `*` any) and its declarations.
struct Rule {
    tag: Option<String>,
    id: Option<String>,
    classes: Vec<String>,
    /// Specificity, then the rule's place in the sheet.
    rank: (u32, usize),
    decls: Vec<(String, String)>,
}

impl Rule {
    fn matches(&self, n: &Node) -> bool {
        let classes = n.attr("class").unwrap_or("");
        self.tag.as_ref().is_none_or(|t| *t == n.name)
            && self.id.as_ref().is_none_or(|i| n.attr("id") == Some(i.as_str()))
            && self.classes.iter().all(|c| classes.split_whitespace().any(|k| k == c))
    }
}

/// The rules of every `<style>` element.
fn sheet(root: &Node) -> Vec<Rule> {
    let mut css = String::new();
    collect_css(root, &mut css, 0);
    let mut rules = Vec::new();
    let mut css = css.as_str();
    let mut stripped = String::new();
    while let Some(i) = css.find("/*") {
        stripped.push_str(&css[..i]);
        css = css[i..].split_once("*/").map_or("", |(_, t)| t);
    }
    stripped.push_str(css);
    for block in stripped.split('}') {
        let Some((sels, body)) = block.split_once('{') else { continue };
        if sels.trim_start().starts_with('@') {
            continue;
        }
        let decls = declarations(body);
        for sel in sels.split(',') {
            // A descendant or child selector is read as its last compound.
            let Some(last) = sel.split(|c: char| c.is_whitespace() || c == '>' || c == '+' || c == '~').rfind(|s| !s.is_empty()) else { continue };
            if last.contains([':', '[']) {
                continue;
            }
            let mut rule = Rule { tag: None, id: None, classes: Vec::new(), rank: (0, rules.len()), decls: decls.clone() };
            for (i, part) in split_compound(last).into_iter().enumerate() {
                match part.as_bytes().first() {
                    Some(b'.') => rule.classes.push(part[1..].to_string()),
                    Some(b'#') => rule.id = Some(part[1..].to_string()),
                    Some(b'*') => {}
                    _ if i == 0 => rule.tag = Some(local(&part).to_string()),
                    _ => {}
                }
            }
            rule.rank.0 = u32::from(rule.id.is_some()) * 100 + rule.classes.len() as u32 * 10 + u32::from(rule.tag.is_some());
            rules.push(rule);
        }
    }
    rules.sort_by_key(|r| r.rank);
    rules
}

fn collect_css(n: &Node, out: &mut String, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    if n.name == "style" {
        out.push_str(&n.all_text());
        out.push('\n');
    }
    for k in &n.kids {
        collect_css(k, out, depth + 1);
    }
}

/// `p.a#b.c` into `p`, `.a`, `#b`, `.c`.
fn split_compound(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in s.chars() {
        if c == '.' || c == '#' || out.is_empty() {
            out.push(String::new());
        }
        if let Some(last) = out.last_mut() {
            last.push(c);
        }
    }
    out
}

/// `prop: value; ...` (an `!important` is dropped).
fn declarations(body: &str) -> Vec<(String, String)> {
    body.split(';')
        .filter_map(|d| {
            let (k, v) = d.split_once(':')?;
            let v = v.trim().trim_end_matches("!important").trim();
            Some((k.trim().to_ascii_lowercase(), v.to_string()))
        })
        .filter(|(k, v)| !k.is_empty() && !v.is_empty())
        .collect()
}

/// A colour: `#rgb`, `#rrggbb`, `rgb()` and the basic names. `None` for `none`, `transparent` and what is not read.
fn color(v: &str) -> Option<[u8; 3]> {
    let v = v.trim();
    if let Some(h) = v.strip_prefix('#') {
        let d = |i: usize, n: usize| h.get(i..i + n).and_then(|x| u8::from_str_radix(x, 16).ok());
        return match h.len() {
            3 | 4 => Some([d(0, 1)? * 17, d(1, 1)? * 17, d(2, 1)? * 17]),
            6 | 8 => Some([d(0, 2)?, d(2, 2)?, d(4, 2)?]),
            _ => None,
        };
    }
    let lower = v.to_ascii_lowercase();
    if let Some(args) = lower.strip_prefix("rgb(").or_else(|| lower.strip_prefix("rgba(")) {
        let parts: Vec<&str> = args.trim_end_matches(')').split([',', ' ', '/']).filter(|p| !p.is_empty()).collect();
        let ch = |p: &str| -> Option<u8> {
            let n: f64 = p.trim_end_matches('%').parse().ok()?;
            let n = if p.ends_with('%') { n * 2.55 } else { n };
            Some(n.round().clamp(0.0, 255.0) as u8)
        };
        return Some([ch(parts.first()?)?, ch(parts.get(1)?)?, ch(parts.get(2)?)?]);
    }
    let named: &[(&str, [u8; 3])] = &[
        ("black", [0, 0, 0]),
        ("white", [255, 255, 255]),
        ("red", [255, 0, 0]),
        ("green", [0, 128, 0]),
        ("blue", [0, 0, 255]),
        ("yellow", [255, 255, 0]),
        ("cyan", [0, 255, 255]),
        ("aqua", [0, 255, 255]),
        ("magenta", [255, 0, 255]),
        ("fuchsia", [255, 0, 255]),
        ("gray", [128, 128, 128]),
        ("grey", [128, 128, 128]),
        ("silver", [192, 192, 192]),
        ("maroon", [128, 0, 0]),
        ("olive", [128, 128, 0]),
        ("lime", [0, 255, 0]),
        ("teal", [0, 128, 128]),
        ("navy", [0, 0, 128]),
        ("purple", [128, 0, 128]),
        ("orange", [255, 165, 0]),
    ];
    named.iter().find(|(n, _)| *n == lower).map(|(_, c)| *c)
}

// ---------------------------------------------------------------------------------------------
// Reading the drawing

struct Reader<'a> {
    sheet: Vec<Rule>,
    root: &'a Node,
    items: Vec<Item>,
    uses: usize,
}

impl Reader<'_> {
    /// `n`'s own style under its parent's `parent`: presentation attributes, then the sheet's rules, then `style`.
    fn style_of(&self, n: &Node, parent: &Style) -> Style {
        let mut s = Style { opacity: parent.opacity, hidden: parent.hidden, ..parent.clone() };
        for (k, v) in &n.attrs {
            self.set(&mut s, k, v);
        }
        for r in self.sheet.iter().filter(|r| r.matches(n)) {
            for (k, v) in &r.decls {
                self.set(&mut s, k, v);
            }
        }
        if let Some(st) = n.attr("style") {
            for (k, v) in declarations(st) {
                self.set(&mut s, &k, &v);
            }
        }
        s
    }

    fn set(&self, s: &mut Style, k: &str, v: &str) {
        let num = |v: &str| v.trim().trim_end_matches('%').parse::<f64>().ok().filter(|n| n.is_finite());
        let share = |v: &str| num(v).map(|n| if v.trim().ends_with('%') { n / 100.0 } else { n }.clamp(0.0, 1.0));
        match k {
            "fill" => s.fill = self.ink(v).unwrap_or(s.fill),
            "stroke" => s.stroke = self.ink(v).unwrap_or(s.stroke),
            "stroke-width" => s.stroke_width = length(v, s.font_size).unwrap_or(s.stroke_width).max(0.0),
            "fill-opacity" => s.fill_opacity = share(v).unwrap_or(s.fill_opacity),
            "stroke-opacity" => s.stroke_opacity = share(v).unwrap_or(s.stroke_opacity),
            "opacity" => s.opacity *= share(v).unwrap_or(1.0),
            "fill-rule" => s.even_odd = v.trim() == "evenodd",
            "color" => s.color = color(v).unwrap_or(s.color),
            "display" if v.trim() == "none" => s.hidden = true,
            "visibility" => s.hidden = matches!(v.trim(), "hidden" | "collapse"),
            "font-size" => s.font_size = length(v, s.font_size).filter(|f| *f > 0.0).unwrap_or(s.font_size),
            "font-family" => {
                if let Some(f) = v.split(',').map(|f| f.trim().trim_matches(['"', '\''])).find(|f| !f.is_empty()) {
                    s.font = f.to_string();
                }
            }
            "font-weight" => s.bold = v.trim() == "bold" || v.trim() == "bolder" || num(v).is_some_and(|w| w >= 600.0),
            "font-style" => s.italic = matches!(v.trim(), "italic" | "oblique"),
            "text-anchor" => {
                s.anchor = match v.trim() {
                    "middle" => HAlign::Center,
                    "end" => HAlign::Right,
                    _ => HAlign::Left,
                }
            }
            _ => {}
        }
    }

    /// A paint: `none`, `currentColor`, a colour, or `url(#id)` (a gradient's mean colour, else the fallback after it).
    fn ink(&self, v: &str) -> Option<Ink> {
        let v = v.trim();
        if v == "none" || v == "transparent" {
            return Some(Ink::None);
        }
        if v == "currentColor" {
            return Some(Ink::Current);
        }
        if let Some(r) = v.strip_prefix("url(") {
            let (id, fallback) = r.split_once(')').unwrap_or((r, ""));
            let id = id.trim().trim_matches(['"', '\'']).trim_start_matches('#');
            return self.gradient(id, 0).map(Ink::Color).or_else(|| self.ink(fallback).filter(|_| !fallback.trim().is_empty()));
        }
        color(v).map(Ink::Color)
    }

    /// The mean colour of gradient `id`'s stops (its `href`'s when it has none).
    fn gradient(&self, id: &str, depth: usize) -> Option<[u8; 3]> {
        let g = find_id(self.root, id, 0)?;
        let stops: Vec<[u8; 3]> = g
            .kids
            .iter()
            .filter(|k| k.name == "stop")
            .filter_map(|k| {
                let style = k.attr("style").map(declarations).unwrap_or_default();
                let c = style.iter().find(|(p, _)| p == "stop-color").map(|(_, v)| v.as_str()).or_else(|| k.attr("stop-color")).unwrap_or("black");
                color(c)
            })
            .collect();
        if stops.is_empty() {
            let href = g.attr("href")?.trim_start_matches('#');
            return (depth < MAX_USE_DEPTH).then(|| self.gradient(href, depth + 1)).flatten();
        }
        let n = stops.len() as u32;
        let mean = |i: usize| (stops.iter().map(|c| u32::from(c[i])).sum::<u32>() / n) as u8;
        Some([mean(0), mean(1), mean(2)])
    }

    /// Element `n` under `parent`'s style and the transform `ctm` (user space to the picture's pixels).
    fn element(&mut self, n: &Node, parent: &Style, ctm: Affine, depth: usize) {
        if depth > MAX_DEPTH || self.items.len() >= MAX_ITEMS {
            return;
        }
        if matches!(
            n.name.as_str(),
            "defs" | "style" | "title" | "desc" | "metadata" | "clipPath" | "mask" | "pattern" | "marker" | "symbol" | "linearGradient"
                | "radialGradient" | "filter" | "script" | "foreignObject" | "image"
        ) {
            return;
        }
        let s = self.style_of(n, parent);
        if n.attr("display").is_some_and(|d| d.trim() == "none") || (s.hidden && n.name != "g") {
            return;
        }
        let ctm = match n.attr("transform") {
            Some(t) => ctm * transform(t),
            None => ctm,
        };
        match n.name.as_str() {
            "g" | "svg" | "a" | "switch" => {
                for k in &n.kids {
                    self.element(k, &s, ctm, depth + 1);
                }
            }
            "use" => self.use_element(n, &s, ctm, depth),
            "text" => self.text(n, &s, ctm),
            _ => {
                if let Some(path) = geometry(n, s.font_size) {
                    self.draw(&path, &s, ctm);
                }
            }
        }
    }

    fn use_element(&mut self, n: &Node, s: &Style, ctm: Affine, depth: usize) {
        self.uses += 1;
        let Some(id) = n.attr("href").map(|h| h.trim_start_matches('#')) else { return };
        if self.uses > MAX_NODES || depth > MAX_USE_DEPTH * 4 {
            return;
        }
        let root = self.root;
        let Some(target) = find_id(root, id, 0) else { return };
        let at = |k: &str| n.attr(k).and_then(|v| length(v, s.font_size)).unwrap_or(0.0);
        let ctm = ctm * Affine::translate((at("x"), at("y")));
        if target.name == "symbol" {
            for k in &target.kids {
                self.element(k, s, ctm, depth + 1);
            }
        } else {
            self.element(target, s, ctm, depth + 1);
        }
    }

    /// `path` filled and stroked as `s` says, in the picture's pixels.
    fn draw(&mut self, path: &BezPath, s: &Style, ctm: Affine) {
        let rgba = |ink: Ink, op: f64| -> Option<[u8; 4]> {
            let c = match ink {
                Ink::None => return None,
                Ink::Color(c) => c,
                Ink::Current => s.color,
            };
            Some([c[0], c[1], c[2], (op * s.opacity * 255.0).round().clamp(0.0, 255.0) as u8])
        };
        let fill = rgba(s.fill, s.fill_opacity);
        let k = ctm.determinant().abs().sqrt();
        let stroke = rgba(s.stroke, s.stroke_opacity).filter(|_| s.stroke_width > 0.0).map(|c| (c, (s.stroke_width * k) as f32));
        if fill.is_none() && stroke.is_none() {
            return;
        }
        let segs = segs(&(ctm * path.clone()));
        if !segs.is_empty() {
            self.items.push(Item::Path { segs, fill, stroke, even_odd: s.even_odd });
        }
    }

    fn text(&mut self, n: &Node, s: &Style, ctm: Affine) {
        let text: String = n.all_text().split_whitespace().collect::<Vec<_>>().join(" ");
        let fill = match s.fill {
            Ink::None => return,
            Ink::Color(c) => c,
            Ink::Current => s.color,
        };
        if text.is_empty() {
            return;
        }
        // The first tspan's position stands for the run's when the text gives none.
        let pos = |k: &str| {
            n.attr(k).or_else(|| n.kids.iter().find_map(|t| t.attr(k))).map(numbers).and_then(|v| v.first().copied()).unwrap_or(0.0)
        };
        let p = ctm * kurbo::Point::new(pos("x"), pos("y"));
        let c = ctm.as_coeffs();
        let k = ctm.determinant().abs().sqrt();
        self.items.push(Item::Text(Text {
            text,
            ansi: None,
            x: p.x as f32,
            y: p.y as f32,
            size: (s.font_size * k) as f32,
            cell: false,
            font: s.font.clone(),
            bold: s.bold,
            italic: s.italic,
            color: [fill[0], fill[1], fill[2], (s.fill_opacity * s.opacity * 255.0).round().clamp(0.0, 255.0) as u8],
            angle: c[1].atan2(c[0]) as f32,
            halign: s.anchor,
            valign: VAlign::Baseline,
            dx: Vec::new(),
        }));
    }
}

/// The element with `id` under `n`.
fn find_id<'a>(n: &'a Node, id: &str, depth: usize) -> Option<&'a Node> {
    if n.attr("id") == Some(id) {
        return Some(n);
    }
    if depth > MAX_DEPTH {
        return None;
    }
    n.kids.iter().find_map(|k| find_id(k, id, depth + 1))
}

/// A shape element's outline in its user space.
fn geometry(n: &Node, font: f64) -> Option<BezPath> {
    let len = |k: &str| n.attr(k).and_then(|v| length(v, font)).unwrap_or(0.0);
    let path = match n.name.as_str() {
        "path" => BezPath::from_svg(n.attr("d")?).ok().or_else(|| partial_path(n.attr("d")?))?,
        "rect" => {
            let (w, h) = (len("width"), len("height"));
            if w <= 0.0 || h <= 0.0 {
                return None;
            }
            let (rx, ry) = (n.attr("rx").and_then(|v| length(v, font)), n.attr("ry").and_then(|v| length(v, font)));
            let r = rx.or(ry).unwrap_or(0.0).min(w / 2.0).min(h / 2.0);
            let rect = kurbo::Rect::new(len("x"), len("y"), len("x") + w, len("y") + h);
            if r > 0.0 { kurbo::RoundedRect::from_rect(rect, r).to_path(0.1) } else { rect.to_path(0.1) }
        }
        "circle" => kurbo::Circle::new((len("cx"), len("cy")), len("r")).to_path(0.1),
        "ellipse" => kurbo::Ellipse::new((len("cx"), len("cy")), (len("rx"), len("ry")), 0.0).to_path(0.1),
        "line" => {
            let mut p = BezPath::new();
            p.move_to((len("x1"), len("y1")));
            p.line_to((len("x2"), len("y2")));
            p
        }
        "polyline" | "polygon" => {
            let pts = numbers(n.attr("points")?);
            let mut p = BezPath::new();
            for (i, xy) in pts.chunks_exact(2).enumerate() {
                if i == 0 {
                    p.move_to((xy[0], xy[1]));
                } else {
                    p.line_to((xy[0], xy[1]));
                }
            }
            if n.name == "polygon" {
                p.close_path();
            }
            p
        }
        _ => return None,
    };
    (!path.elements().is_empty()).then_some(path)
}

/// A path's data up to its first error, as SVG draws a broken path.
fn partial_path(d: &str) -> Option<BezPath> {
    // Cut at each command letter from the end until what is left reads.
    let cuts: Vec<usize> = d.char_indices().filter(|(_, c)| c.is_ascii_alphabetic() && *c != 'e' && *c != 'E').map(|(i, _)| i).collect();
    cuts.iter().rev().skip(1).take(64).find_map(|&i| BezPath::from_svg(&d[..i]).ok())
}

/// A kurbo path as the metafile crate's segments (quadratics as cubics).
fn segs(p: &BezPath) -> Vec<Seg> {
    let mut out = Vec::with_capacity(p.elements().len());
    let mut last = kurbo::Point::ZERO;
    let f = |v: f64| v as f32;
    for el in p.elements() {
        match *el {
            PathEl::MoveTo(a) => {
                out.push(Seg::Move(f(a.x), f(a.y)));
                last = a;
            }
            PathEl::LineTo(a) => {
                out.push(Seg::Line(f(a.x), f(a.y)));
                last = a;
            }
            PathEl::QuadTo(c, a) => {
                let c1 = last + (c - last) * (2.0 / 3.0);
                let c2 = a + (c - a) * (2.0 / 3.0);
                out.push(Seg::Cubic(f(c1.x), f(c1.y), f(c2.x), f(c2.y), f(a.x), f(a.y)));
                last = a;
            }
            PathEl::CurveTo(c1, c2, a) => {
                out.push(Seg::Cubic(f(c1.x), f(c1.y), f(c2.x), f(c2.y), f(a.x), f(a.y)));
                last = a;
            }
            PathEl::ClosePath => out.push(Seg::Close),
        }
    }
    out
}

/// One shape an SVG picture draws, for Convert to Shape: its outlines as polylines (curves flattened to within a quarter of
/// a pixel), each closed or not, in the picture's pixels, with its fill and its stroke (colour and width), RGBA.
pub struct SvgShape {
    pub polys: Vec<(Vec<[f32; 2]>, bool)>,
    pub fill: Option<[u8; 4]>,
    pub stroke: Option<([u8; 4], f32)>,
}

/// The shapes an SVG picture draws (its text left out) and its size in pixels.
pub fn svg_shapes(bytes: &[u8]) -> Option<(f32, f32, Vec<SvgShape>)> {
    let pic = svg_picture(bytes)?;
    let shapes = pic
        .items
        .iter()
        .filter_map(|it| match it {
            Item::Path { segs, fill, stroke, .. } => Some(SvgShape { polys: polylines(&seg_bez(segs)), fill: *fill, stroke: *stroke }),
            _ => None,
        })
        .filter(|s| !s.polys.is_empty())
        .collect();
    Some((pic.width, pic.height, shapes))
}

fn polylines(p: &BezPath) -> Vec<(Vec<[f32; 2]>, bool)> {
    let mut out: Vec<(Vec<[f32; 2]>, bool)> = Vec::new();
    kurbo::flatten(p, 0.25, |el| match el {
        PathEl::MoveTo(a) => out.push((vec![[a.x as f32, a.y as f32]], false)),
        PathEl::LineTo(a) => {
            if let Some((pts, _)) = out.last_mut() {
                pts.push([a.x as f32, a.y as f32]);
            }
        }
        PathEl::ClosePath => {
            if let Some((_, closed)) = out.last_mut() {
                *closed = true;
            }
        }
        _ => {}
    });
    out.retain(|(pts, _)| pts.len() > 1);
    out
}

fn seg_bez(segs: &[Seg]) -> BezPath {
    let mut p = BezPath::new();
    let d = f64::from;
    for s in segs {
        match *s {
            Seg::Move(x, y) => p.move_to((d(x), d(y))),
            Seg::Line(x, y) => p.line_to((d(x), d(y))),
            Seg::Cubic(a, b, c, e, x, y) => p.curve_to((d(a), d(b)), (d(c), d(e)), (d(x), d(y))),
            Seg::Close => p.close_path(),
        }
    }
    p
}

/// What [`HashMap`] the painter's media lookup takes for one picture: used to draw an SVG to a bitmap.
pub(crate) fn one_media(key: &str, bytes: &[u8]) -> HashMap<String, std::sync::Arc<Vec<u8>>> {
    HashMap::from([(key.to_string(), std::sync::Arc::new(bytes.to_vec()))])
}

/// An SVG picture drawn as a PNG at twice its natural size (at most `max_side` pixels a side): the copy Word keeps beside
/// it for readers without SVG.
pub fn svg_png(bytes: &[u8], max_side: u32) -> Option<Vec<u8>> {
    let (w, h) = svg_size(bytes)?;
    let scale = (2.0 * 4.0 / 3.0_f32).min(max_side as f32 / w.max(h).max(1.0));
    let area = ew_geom::Rect::new(0.0, 0.0, w, h);
    let item = crate::Draw::Image { rect: area, media: "svg".into(), crop: [0.0; 4], alpha: 1.0, alt: String::new(), decorative: false };
    let img = crate::render_items(&[item], &one_media("svg", bytes), area, scale, &crate::PaintOptions::default());
    if img.width == 0 || img.height == 0 {
        return None;
    }
    Some(img.to_png()).filter(|png| !png.is_empty())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    const WORD: &str = r##"<svg width="320" height="200" viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg" overflow="hidden"><style>
.MsftOfcThm_Accent1_Fill_v2 {
 fill:#156082;
}
</style>
<rect x="0" y="0" width="160" height="100" class="MsftOfcThm_Accent1_Fill_v2" fill="#FF0000"/><circle cx="160" cy="100" r="44" fill="#FFFFFF"/><text font-family="Arial" font-size="22" text-anchor="middle" x="160" y="108">SVG</text></svg>"##;

    #[test]
    fn reads_word_s_svg_with_its_style_sheet() {
        assert!(is_svg(WORD.as_bytes()) && !is_svg(b"\x89PNG"));
        assert_eq!(svg_size(WORD.as_bytes()), Some((240.0, 150.0)));
        let pic = svg_picture(WORD.as_bytes()).unwrap();
        assert_eq!((pic.width, pic.height), (320.0, 200.0));
        // The class rule wins over the fill attribute, as in a browser.
        let Item::Path { fill, .. } = &pic.items[0] else { panic!("a path") };
        assert_eq!(*fill, Some([0x15, 0x60, 0x82, 255]));
        let Item::Text(t) = &pic.items[2] else { panic!("the text") };
        assert_eq!((t.text.as_str(), t.halign, t.size), ("SVG", HAlign::Center, 22.0));
    }

    #[test]
    fn view_box_groups_transforms_and_uses() {
        let s = r##"<?xml version="1.0"?><!-- an icon --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="20pt">
            <defs><path id="p" d="M0 0 L1 0 L1 1 Z"/><linearGradient id="g"><stop stop-color="#000"/><stop stop-color="#fff"/></linearGradient></defs>
            <g transform="translate(2 3) scale(2)" fill="url(#g)" opacity="0.5"><use href="#p" x="1"/></g>
            <polygon points="0,0 1,0 1,1" stroke="blue" stroke-width="0.5" fill="none"/></svg>"##;
        let pic = svg_picture(s.as_bytes()).unwrap();
        // 20 pt is 26.67 px; the viewBox is 10 units wide, so a unit is 2.67 px.
        assert!((pic.width - 26.666).abs() < 0.01 && (pic.height - 26.666).abs() < 0.01, "{} {}", pic.width, pic.height);
        assert_eq!(pic.items.len(), 2);
        let Item::Path { segs, fill, .. } = &pic.items[0] else { panic!("the use") };
        assert_eq!(*fill, Some([127, 127, 127, 128]));
        // (0, 0) + use's x 1 → scale 2 → translate (2, 3) → (4, 3) units → × 2.667 px.
        let Seg::Move(x, y) = segs[0] else { panic!("a move") };
        assert!((x - 10.666).abs() < 0.01 && (y - 8.0).abs() < 0.01, "{x} {y}");
        let Item::Path { fill, stroke, .. } = &pic.items[1] else { panic!("the polygon") };
        assert!(fill.is_none() && stroke.is_some_and(|(c, w)| c == [0, 0, 255, 255] && (w - 1.333).abs() < 0.01));
    }

    #[test]
    fn a_hostile_file_reads_safely() {
        let deep = format!("<svg width='10' height='10'>{}<path d='M0 0H5V5Z'/>{}</svg>", "<g>".repeat(500), "</g>".repeat(500));
        assert!(svg_picture(deep.as_bytes()).is_none_or(|p| p.items.is_empty()));
        assert!(svg_picture(b"<svg width='10' height='10'><path d='M 0 0 L 5 5 L oops'/></svg>").is_some_and(|p| p.items.len() == 1));
        assert!(svg_picture(b"<svg").is_none());
        // The root's own paint passes down, as Graphics Fill and Outline write it.
        let p = svg_picture(br##"<svg width="10" height="10" stroke="#000000" stroke-width="2"><rect width="5" height="5"/></svg>"##).unwrap();
        assert!(matches!(&p.items[0], Item::Path { stroke: Some(([0, 0, 0, 255], w)), .. } if (*w - 2.0).abs() < 1e-6));
    }
}
