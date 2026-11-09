//! EasyWriter: Word's EQ field (ECMA-376 Part 1 §17.16.5.20) laid out as Word draws it: every argument at the field's own
//! size in its own font, the boxes Word gives each switch, and the room the box takes on its line. Ported from the DOM
//! editor's src/document/wp/fields-draw/eq.mjs (`parseEq`) and eqbox.mjs, whose numbers were read off Word's PDF of the
//! fixture (all-features.pdf pages 80 to 82, Aptos 12 pt: A = 11.27 pt, D = 3.38 pt). engine-fidelity's mapping onto the
//! math layout (display-style fractions and limits, root lines up to 13 pt short of Word's) gave way to it.
//!
//! Lengths are in em of the field's size, y downwards from the baseline, until [`layout`] turns them into a
//! [`MathLayout`] (points, y up). ponytail: each switch's room was read from one line of the fixture at one size; Word
//! probes at other sizes and fonts would confirm them.

use std::collections::HashMap;

use ew_doc::props::Rgb;
use ew_fonts::FaceRef;

use crate::math::{MItem, MathLayout};

/// A parsed EQ code: text, or a switch with its options and arguments.
#[derive(Debug, Clone, PartialEq)]
enum Node {
    Text(String),
    Cmd { c: char, opts: HashMap<&'static str, Opt>, args: Vec<Vec<Node>> },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Opt {
    Flag,
    Num(Option<f32>),
    Ch(char),
}

/// Each switch's options.
fn options(c: char) -> &'static [&'static str] {
    match c {
        'a' => &["al", "ac", "ar", "co", "vs", "hs"],
        'b' => &["lc", "rc", "bc"],
        'd' => &["fo", "ba", "li"],
        'i' => &["su", "pr", "in", "fc", "vc"],
        'o' => &["al", "ac", "ar"],
        's' => &["up", "do", "ai", "di"],
        'x' => &["to", "bo", "le", "ri"],
        _ => &[],
    }
}

/// How many arguments each switch takes.
fn arity(c: char) -> (usize, usize) {
    match c {
        'a' | 'o' => (1, usize::MAX),
        'b' | 'x' => (1, 1),
        'd' => (0, 1),
        'f' => (2, 2),
        'i' => (3, 3),
        'l' => (0, usize::MAX),
        'r' | 's' => (1, 2),
        _ => (0, 0),
    }
}

const MAX_DEPTH: usize = 16;

struct Parser {
    s: Vec<char>,
    i: usize,
}

impl Parser {
    fn seq(&mut self, in_args: bool, depth: usize) -> Option<Vec<Node>> {
        let mut out: Vec<Node> = Vec::new();
        let mut paren = 0i32;
        let push = |out: &mut Vec<Node>, ch: char| match out.last_mut() {
            Some(Node::Text(t)) => t.push(ch),
            _ => out.push(Node::Text(ch.to_string())),
        };
        while let Some(&ch) = self.s.get(self.i) {
            if ch == '\\' {
                let next = *self.s.get(self.i + 1)?;
                if next.is_ascii_alphabetic() {
                    if depth >= MAX_DEPTH {
                        return None;
                    }
                    out.push(self.command(depth)?);
                } else {
                    push(&mut out, next);
                    self.i += 2;
                }
                continue;
            }
            if in_args && paren == 0 && (ch == ',' || ch == ')') {
                break;
            }
            if ch == '(' {
                paren += 1;
            } else if ch == ')' {
                paren -= 1;
            }
            push(&mut out, ch);
            self.i += 1;
        }
        Some(out)
    }

    fn command(&mut self, depth: usize) -> Option<Node> {
        let c = self.s.get(self.i + 1)?.to_ascii_lowercase();
        if !"abdfilorsx".contains(c) {
            return None;
        }
        self.i += 2;
        let mut opts = HashMap::new();
        loop {
            while self.s.get(self.i) == Some(&' ') {
                self.i += 1;
            }
            if self.s.get(self.i) != Some(&'\\') {
                break;
            }
            let name: String = self.s.get(self.i + 1..self.i + 3).map(|n| n.iter().collect::<String>().to_ascii_lowercase()).unwrap_or_default();
            let Some(&key) = options(c).iter().find(|o| **o == name) else { break };
            self.i += 3;
            let opt = if matches!(key, "lc" | "rc" | "bc" | "fc" | "vc") {
                if self.s.get(self.i) == Some(&'\\') {
                    self.i += 1;
                }
                let ch = *self.s.get(self.i)?;
                self.i += 1;
                Opt::Ch(ch)
            } else if matches!(key, "co" | "vs" | "hs" | "fo" | "ba" | "up" | "do" | "ai" | "di") {
                // A space may come before the number: Word's own Combine Characters writes `\s\up 6(`.
                let mut start = self.i;
                while self.s.get(start) == Some(&' ') && self.s.get(start + 1).is_some_and(char::is_ascii_digit) {
                    start += 1;
                }
                self.i = start;
                while self.s.get(self.i).is_some_and(|c| c.is_ascii_digit() || *c == '.') {
                    self.i += 1;
                }
                Opt::Num(self.s.get(start..self.i).and_then(|d| d.iter().collect::<String>().parse().ok()))
            } else {
                Opt::Flag
            };
            opts.insert(key, opt);
        }
        while self.s.get(self.i) == Some(&' ') {
            self.i += 1;
        }
        if self.s.get(self.i) != Some(&'(') {
            return None;
        }
        self.i += 1;
        let mut args = Vec::new();
        loop {
            args.push(self.seq(true, depth + 1)?);
            match self.s.get(self.i) {
                Some(',') => self.i += 1,
                Some(')') => {
                    self.i += 1;
                    break;
                }
                _ => return None,
            }
            if args.len() > 64 {
                return None;
            }
        }
        let (lo, hi) = arity(c);
        if args.len() == 1 && args[0].is_empty() && lo == 0 {
            args.clear();
        }
        (lo <= args.len() && args.len() <= hi).then_some(Node::Cmd { c, opts, args })
    }
}

/// The nodes of an EQ field code; `None` for another field. `Some(None)`: Word's "Error!" (a syntax error).
fn parse(instr: &str) -> Option<Option<Vec<Node>>> {
    let t = instr.trim_start();
    let name_end = t.find(|c: char| c.is_whitespace() || c == '\\').unwrap_or(t.len());
    if !t.get(..name_end)?.eq_ignore_ascii_case("eq") {
        return None;
    }
    let mut p = Parser { s: t.get(name_end..)?.trim().chars().collect(), i: 0 };
    Some(p.seq(false, 0))
}

/// Word's error text for an EQ code it cannot read.
pub(super) const EQ_ERROR: &str = "Error!";

// The numbers below are eqbox.mjs's, each with where it was read.
// Fraction: the numerator's box ends at half the ascent above the baseline, where the bar is; the denominator's starts just
// below it (\f(1,2): 1 at -9.00 pt, 2 at +5.76, bar at -5.64).
const FRAC_GAP: f32 = 0.01;
/// The bar, box and radical strokes.
const RULE: f32 = 0.05;
/// \s with neither \up nor \do raises its element a quarter em (\s\ai4(x) and \s\di4(x) drew x 3.0 pt up).
const S_RAISE: f32 = 0.25;
// Radical: the sign reaches 0.2 em over the radicand; with an index Word keeps 1.07 em over the ascent (\r(3,x): 12.84 pt
// over its two lines), the index drawn 0.65 em up (7.8 pt).
const RAD_OVER: f32 = 0.2;
const RAD_INDEX_ROOM: f32 = 1.07;
const RAD_INDEX_UP: f32 = 0.65;
// Brackets: the glyph at 1.21 times the content's height over a line, centred on the content (\b(x): ( at 14.52 pt); the
// box keeps the content's top and reaches a quarter em further down (\b lines: 3.0 pt below, none above).
const BRACKET_K: f32 = 1.21;
const BRACKET_BELOW: f32 = 0.25;
// Box (\x): 0.34 em above and 0.32 em below the content, whichever sides it draws (\x lines: 4.08 pt and 3.84 pt).
const BOX_ABOVE: f32 = 0.34;
const BOX_BELOW: f32 = 0.32;
const BOX_PAD: f32 = 0.15;
// \in puts the limits to the right of the sign: the upper 0.30 em up, the lower 0.71 em down (b at -3.62 pt, a at +8.52).
const IN_UP: f32 = 0.3;
const IN_DOWN: f32 = 0.71;
/// The font Word draws the integral, sum and product signs in.
const MATH_FONT: &str = "Cambria Math";

/// Something in a box: text at `k` times the size with its baseline at (`x`, `y`), in the field's font or `math`'s; or a
/// stroked polyline.
#[derive(Clone)]
enum Item {
    Text { x: f32, y: f32, k: f32, text: String, math: bool },
    Poly(Vec<(f32, f32)>),
}

#[derive(Clone, Default)]
struct EqBox {
    w: f32,
    asc: f32,
    desc: f32,
    items: Vec<Item>,
}

fn shifted(items: &[Item], dx: f32, dy: f32) -> Vec<Item> {
    items
        .iter()
        .map(|it| match it {
            Item::Text { x, y, k, text, math } => Item::Text { x: x + dx, y: y + dy, k: *k, text: text.clone(), math: *math },
            Item::Poly(p) => Item::Poly(p.iter().map(|(x, y)| (x + dx, y + dy)).collect()),
        })
        .collect()
}

fn line(x1: f32, y1: f32, x2: f32, y2: f32) -> Item {
    Item::Poly(vec![(x1, y1), (x2, y2)])
}

/// The field's font: its ascent and descent (em) and the widths of text in it.
struct Font {
    a: f32,
    d: f32,
    size: f32,
    face: FaceRef,
    math: FaceRef,
    /// EasyWriter engine-gaps-rest: the run's character scaling (Combine Characters writes 66 %), which narrows every glyph.
    sx: f32,
}

impl Font {
    /// The width (em) of `text` at `k` times the size.
    fn width(&self, text: &str, k: f32, math: bool) -> f32 {
        runs(if math { self.math } else { self.face }, text).iter().map(|(face, t)| advance(*face, t)).sum::<f32>() * k * self.sx
    }
}

/// `text` split into runs of the face that draws them: `face`, or a fallback where it lacks a character.
fn runs(face: FaceRef, text: &str) -> Vec<(FaceRef, String)> {
    let mut out: Vec<(FaceRef, String)> = Vec::new();
    for c in text.chars() {
        let f = if face.covers(c) || c.is_whitespace() {
            face
        } else {
            ew_fonts::FontDb::global().fallback_for(c, face.id()).map(|f| FaceRef::of(&f)).unwrap_or(face)
        };
        match out.last_mut() {
            Some((g, t)) if g.id() == f.id() => t.push(c),
            _ => out.push((f, c.to_string())),
        }
    }
    out
}

/// The advance (em) of `text` in `face`.
fn advance(face: FaceRef, text: &str) -> f32 {
    let upem = face.upem.max(1.0) as f32;
    ew_fonts::shape(&face, text, &[], |c| c).iter().map(|g| g.x_advance as f32 / upem).sum()
}

fn row(boxes: Vec<EqBox>, f: &Font) -> EqBox {
    if boxes.is_empty() {
        return EqBox { w: 0.0, asc: f.a, desc: f.d, items: Vec::new() };
    }
    let mut x = 0.0;
    let mut items = Vec::new();
    let (mut asc, mut desc) = (f32::MIN, f32::MIN);
    for b in boxes {
        items.extend(shifted(&b.items, x, 0.0));
        x += b.w;
        asc = asc.max(b.asc);
        desc = desc.max(b.desc);
    }
    EqBox { w: x, asc, desc, items }
}

/// Rows of cells stacked and centred on half the ascent, `vs` em apart, in columns of `cols` cells aligned by `align`
/// (-1 left, 0 centre, 1 right), `hs` em apart.
fn grid(cells: Vec<EqBox>, cols: usize, align: i8, f: &Font, (vs, hs): (f32, f32)) -> EqBox {
    // No more columns than cells: `\co` comes from the document, and a huge count would allocate a width per column.
    let cols = cols.clamp(1, cells.len().max(1));
    let rows: Vec<&[EqBox]> = cells.chunks(cols).collect();
    let widths: Vec<f32> = (0..cols).map(|c| rows.iter().filter_map(|r| r.get(c)).map(|b| b.w).fold(0.0, f32::max)).collect();
    let heights: Vec<(f32, f32)> =
        rows.iter().map(|r| (r.iter().map(|b| b.asc).fold(f32::MIN, f32::max), r.iter().map(|b| b.desc).fold(f32::MIN, f32::max))).collect();
    let h = heights.iter().map(|(a, d)| a + d).sum::<f32>() + vs * rows.len().saturating_sub(1) as f32;
    let top = -f.a / 2.0 - h / 2.0;
    let mut items = Vec::new();
    let mut y = top;
    for (i, r) in rows.iter().enumerate() {
        let base = y + heights[i].0;
        let mut x = 0.0;
        for (c, b) in r.iter().enumerate() {
            let room = widths[c] - b.w;
            let dx = match align {
                -1 => 0.0,
                1 => room,
                _ => room / 2.0,
            };
            items.extend(shifted(&b.items, x + dx, base));
            x += widths[c] + hs;
        }
        y = base + heights[i].1 + vs;
    }
    EqBox { w: widths.iter().sum::<f32>() + hs * (cols as f32 - 1.0), asc: -top, desc: top + h, items }
}

fn text(s: &str, f: &Font) -> EqBox {
    let items = if s.is_empty() { Vec::new() } else { vec![Item::Text { x: 0.0, y: 0.0, k: 1.0, text: s.to_string(), math: false }] };
    EqBox { w: f.width(s, 1.0, false), asc: f.a, desc: f.d, items }
}

/// A glyph at `k` times the size with its own baseline at `y` (em), boxed by the font's ascent and descent at that size.
fn glyph(ch: char, k: f32, y: f32, f: &Font, math: bool) -> EqBox {
    let s = ch.to_string();
    EqBox { w: f.width(&s, k, math), asc: f.a * k - y, desc: f.d * k + y, items: vec![Item::Text { x: 0.0, y, k, text: s, math }] }
}

fn seq(nodes: &[Node], f: &Font) -> EqBox {
    row(nodes.iter().map(|n| one(n, f)).collect(), f)
}

fn mirror(c: char) -> char {
    match c {
        '(' => ')',
        '[' => ']',
        '{' => '}',
        '<' => '>',
        '〈' => '〉',
        ')' => '(',
        ']' => '[',
        '}' => '{',
        '>' => '<',
        other => other,
    }
}

fn one(n: &Node, f: &Font) -> EqBox {
    let (c, o, args) = match n {
        Node::Text(s) => return text(s, f),
        Node::Cmd { c, opts, args } => (*c, opts, args),
    };
    let flag = |k: &str| o.contains_key(k);
    let num = |k: &str| match o.get(k) {
        Some(Opt::Num(v)) => v.unwrap_or(0.0),
        _ => 0.0,
    };
    let has_num = |k: &str| matches!(o.get(k), Some(Opt::Num(_)));
    let ch = |k: &str| match o.get(k) {
        Some(Opt::Ch(c)) => Some(*c),
        _ => None,
    };
    let pt = |v: f32| v / f.size;
    let arg = |i: usize| args.get(i).map_or(&[][..], Vec::as_slice);
    let align = if flag("al") { -1 } else if flag("ar") { 1 } else { 0 };
    match c {
        'f' => {
            let (num_b, den) = (seq(arg(0), f), seq(arg(1), f));
            let w = num_b.w.max(den.w) + 2.0 * RULE;
            let bar = -f.a / 2.0;
            let nb = bar - num_b.desc;
            let db = bar + FRAC_GAP + den.asc;
            let mut items = shifted(&num_b.items, (w - num_b.w) / 2.0, nb);
            items.extend(shifted(&den.items, (w - den.w) / 2.0, db));
            items.push(line(0.0, bar, w, bar));
            EqBox { w, asc: -(nb - num_b.asc), desc: db + den.desc, items }
        }
        'a' => {
            let cells = args.iter().map(|a| seq(a, f)).collect();
            grid(cells, num("co").max(1.0) as usize, align, f, (pt(num("vs")), pt(num("hs"))))
        }
        's' => {
            if args.len() == 2 {
                return grid(vec![seq(arg(0), f), seq(arg(1), f)], 1, 0, f, (0.0, 0.0));
            }
            let b = seq(arg(0), f);
            let up = if !has_num("up") && !has_num("do") { S_RAISE } else { pt(num("up")) - pt(num("do")) };
            EqBox { w: b.w, asc: b.asc + up + pt(num("ai")), desc: b.desc - up + pt(num("di")), items: shifted(&b.items, 0.0, -up) }
        }
        'r' => {
            let rad = seq(args.last().map_or(&[][..], Vec::as_slice), f);
            let idx = (args.len() == 2 && !arg(0).is_empty()).then(|| seq(arg(0), f));
            // The sign: a short tick, a stroke down past the baseline and a long one up to the bar over the radicand.
            let top = -rad.asc - RAD_OVER + RULE;
            let lead = idx.as_ref().map_or(0.0, |i| (i.w - 0.35).max(0.0));
            let sw = 0.62;
            let mut items = vec![Item::Poly(vec![
                (lead, -0.36),
                (lead + 0.1, -0.42),
                (lead + 0.28, rad.desc * 0.95),
                (lead + sw - 0.04, top),
                (lead + sw + rad.w + 0.06, top),
            ])];
            items.extend(shifted(&rad.items, lead + sw, 0.0));
            let mut asc = rad.asc + RAD_OVER;
            if let Some(i) = &idx {
                items.extend(shifted(&i.items, 0.0, -RAD_INDEX_UP));
                asc = asc.max(f.a + RAD_INDEX_ROOM).max(RAD_INDEX_UP + i.asc);
            }
            EqBox { w: lead + sw + rad.w + 0.08, asc, desc: rad.desc, items }
        }
        'b' => {
            let b = seq(arg(0), f);
            let (mut l, mut r) = (ch("lc"), ch("rc"));
            if let Some(bc) = ch("bc") {
                (l, r) = (Some(bc), Some(mirror(bc)));
            }
            if l.is_none() && r.is_none() {
                (l, r) = (Some('('), Some(')'));
            }
            let k = BRACKET_K * (b.asc + b.desc) / (f.a + f.d).max(0.01);
            // The bracket's middle on the content's middle.
            let y = (b.desc - b.asc) / 2.0 + k * (f.a - f.d) / 2.0;
            let (asc, desc) = (b.asc, b.desc + BRACKET_BELOW);
            let mut parts = Vec::new();
            if let Some(l) = l {
                parts.push(glyph(l, k, y, f, false));
            }
            parts.push(b);
            if let Some(r) = r {
                parts.push(glyph(r, k, y, f, false));
            }
            EqBox { asc, desc, ..row(parts, f) }
        }
        'd' => {
            let (fo, ba) = (pt(num("fo")), pt(num("ba")));
            let b = if args.is_empty() { EqBox { w: 0.0, asc: f.a, desc: f.d, items: Vec::new() } } else { seq(arg(0), f) };
            let mut items = if flag("li") && fo != 0.0 { vec![line(0.0, 0.0, fo, 0.0)] } else { Vec::new() };
            items.extend(shifted(&b.items, fo - ba, 0.0));
            // \ba moves what follows back over what came before: the advance may be negative.
            EqBox { w: fo - ba + b.w, asc: b.asc, desc: b.desc, items }
        }
        'i' => {
            let (lo, hi, body) = (seq(arg(0), f), seq(arg(1), f), seq(arg(2), f));
            let (sign, math) = match (ch("fc"), ch("vc")) {
                (Some(c), _) | (_, Some(c)) => (c, false),
                _ if flag("su") => ('∑', true),
                _ if flag("pr") => ('∏', true),
                _ => ('∫', true),
            };
            if flag("in") {
                let s = glyph(sign, 1.4, 0.2, f, math);
                let lim = lo.w.max(hi.w);
                let mut items = s.items.clone();
                items.extend(shifted(&lo.items, s.w, IN_DOWN));
                items.extend(shifted(&hi.items, s.w, -IN_UP));
                let head = EqBox { w: s.w + lim, asc: s.asc.max(IN_UP + hi.asc), desc: s.desc.max(IN_DOWN + lo.desc), items };
                return row(vec![head, body], f);
            }
            // The operator's box above and below the baseline, the limits stacked on it (from the lines' room with a full
            // size limit atop and under it: \i 14.91 and 17.04 pt, \su and \pr 15.12 and 15.72, \fc 16.32 below, \vc 18.24).
            let (oa, od, k) = if ch("fc").is_some() {
                (0.97, 0.42, 1.0)
            } else if ch("vc").is_some() {
                (0.97, 0.58, 1.0)
            } else if flag("su") || flag("pr") {
                (0.98, 0.37, BRACKET_K)
            } else {
                (0.96, 0.48, 1.6)
            };
            let s = glyph(sign, k, od - f.d * k, f, math);
            let w = s.w.max(lo.w).max(hi.w);
            let mut items = shifted(&s.items, (w - s.w) / 2.0, 0.0);
            items.extend(shifted(&hi.items, (w - hi.w) / 2.0, -oa - hi.desc));
            items.extend(shifted(&lo.items, (w - lo.w) / 2.0, od + lo.asc));
            row(vec![EqBox { w, asc: oa + hi.asc + hi.desc, desc: od + lo.asc + lo.desc, items }, body], f)
        }
        'l' => {
            let mut parts = Vec::new();
            for (i, a) in args.iter().enumerate() {
                if i > 0 {
                    parts.push(text(",", f));
                }
                parts.push(seq(a, f));
            }
            row(parts, f)
        }
        'o' => {
            // Every element over the others, each at the code's size.
            let boxes: Vec<EqBox> = args.iter().map(|a| seq(a, f)).collect();
            let w = boxes.iter().map(|b| b.w).fold(0.0, f32::max);
            let mut items = Vec::new();
            for b in &boxes {
                let dx = match align {
                    -1 => 0.0,
                    1 => w - b.w,
                    _ => (w - b.w) / 2.0,
                };
                items.extend(shifted(&b.items, dx, 0.0));
            }
            let asc = boxes.iter().map(|b| b.asc).fold(f.a, f32::max);
            let desc = boxes.iter().map(|b| b.desc).fold(f.d, f32::max);
            EqBox { w, asc, desc, items }
        }
        'x' => {
            let b = seq(arg(0), f);
            let all = !flag("to") && !flag("bo") && !flag("le") && !flag("ri");
            let w = b.w + 2.0 * BOX_PAD;
            let mut items = shifted(&b.items, BOX_PAD, 0.0);
            let (t, bt) = (-b.asc, b.desc);
            if all || flag("to") {
                items.push(line(0.0, t, w, t));
            }
            if all || flag("bo") {
                items.push(line(0.0, bt, w, bt));
            }
            if all || flag("le") {
                items.push(line(0.0, t, 0.0, bt));
            }
            if all || flag("ri") {
                items.push(line(w, t, w, bt));
            }
            EqBox { w, asc: b.asc + BOX_ABOVE, desc: b.desc + BOX_BELOW, items }
        }
        _ => EqBox { w: 0.0, asc: f.a, desc: f.d, items: Vec::new() },
    }
}

/// An EQ field laid out as Word draws it, in `face` at `size` with the line metrics `ascent` and `descent` (points),
/// narrowed to `sx` (the run's character scaling); `None` for another field, `Some(Err(()))` for a code Word shows its error
/// text for. The layout's ascent and descent are the box's (at least the font's).
pub(super) fn layout(instr: &str, (face, size, sx): (FaceRef, f32, f32), (ascent, descent): (f32, f32), color: Rgb) -> Option<Result<MathLayout, ()>> {
    let nodes = match parse(instr)? {
        Some(n) => n,
        None => return Some(Err(())),
    };
    let s = size.max(0.5);
    let math = {
        let r = ew_fonts::word::resolve(MATH_FONT, false, false);
        if r.substituted { face } else { r.face }
    };
    let sx = if sx.is_finite() && sx > 0.0 { sx } else { 1.0 };
    let f = Font { a: ascent / s, d: descent / s, size: s, face, math, sx };
    let b = seq(&nodes, &f);
    let (asc, desc) = (b.asc.max(f.a), b.desc.max(f.d));
    let mut items = Vec::new();
    for it in &b.items {
        match it {
            Item::Text { x, y, k, text, math } => {
                let mut pen = *x;
                for (fc, t) in runs(if *math { f.math } else { f.face }, text) {
                    let upem = fc.upem.max(1.0) as f32;
                    let pt = s * k / upem;
                    let mut glyphs = Vec::new();
                    for g in ew_fonts::shape(&fc, &t, &[], |c| c) {
                        glyphs.push((g.gid, pen * s + g.x_offset as f32 * pt * sx, -y * s + g.y_offset as f32 * pt));
                        pen += g.x_advance as f32 * k * sx / upem;
                    }
                    items.push(MItem::Glyphs { face: fc, size: s * k, color, synth_bold: false, synth_italic: false, glyphs, text: t });
                }
            }
            Item::Poly(pts) => {
                for w in pts.windows(2) {
                    let ((x0, y0), (x1, y1)) = (w[0], w[1]);
                    items.push(MItem::Line { x0: x0 * s, y0: -y0 * s, x1: x1 * s, y1: -y1 * s, width: RULE * s, color, dotted: false });
                }
            }
        }
    }
    Some(Ok(MathLayout { width: b.w * s, ascent: asc * s, descent: desc * s, items, slots: Vec::new() }))
}

#[cfg(test)]
mod tests {
    use super::{Node, parse};

    #[test]
    fn eq_codes_parse_as_word_reads_them() {
        let nodes = parse(r" EQ \f(1,2) ").unwrap().unwrap();
        assert!(matches!(&nodes[..], [Node::Cmd { c: 'f', args, .. }] if args.len() == 2));
        let nodes = parse(r"EQ \a \al \co2 \vs3 \hs3(1,2,3,4)").unwrap().unwrap();
        assert!(matches!(&nodes[..], [Node::Cmd { c: 'a', args, opts }] if args.len() == 4 && opts.len() == 4));
        assert!(matches!(&parse(r"EQ \b \lc\{(x)").unwrap().unwrap()[..], [Node::Cmd { c: 'b', .. }]));
        assert_eq!(parse(r"EQ \f(1)").unwrap(), None, "a fraction needs two arguments");
        assert_eq!(parse(r"EQ \q(1)").unwrap(), None, "no such switch");
        assert!(parse("PAGE").is_none());
    }

    #[test]
    fn a_huge_column_count_lays_out_as_its_cells() {
        // An untrusted `\co` must not allocate a column per digit's worth: it lays out as the cells it has.
        let face = ew_fonts::word::resolve("Calibri", false, false).face;
        let width = |instr| match super::layout(instr, (face, 12.0, 1.0), (10.0, 3.0), ew_doc::props::Rgb::BLACK) {
            Some(Ok(m)) => m.width,
            _ => panic!("{instr} did not lay out"),
        };
        assert_eq!(width(r"EQ \a \co99999999999(1,2)"), width(r"EQ \a \co2(1,2)"));
    }
}
