//! EasyWriter: Word's DISPLAYBARCODE field (ECMA-376 Part 1 §17.16.5.14) drawn as Word draws it. The code from WordCraft drew nothing for
//! it. Ported from the DOM editor's encoders (src/document/wp/fields-draw/barcode.mjs, qr.mjs and linear.mjs) with the sizes
//! measured there on Word's PDFs: QR 2.8515 pt a module with a 4-module quiet zone at level Q (whatever `\q` says), linear
//! codes 84 pt tall, ITF-14 and CASE 72 pt with their bearers, Japan Post 23.76 pt. `\h` (twips) sets the height and scales
//! the width with it, `\s` scales both, `\r` turns the symbol by quarter turns and `\f` and `\b` colour it.
//! `\t` draws the data under a linear symbol's bars (EasyWriter, engine-fidelity-2: Word's PDF of the fixture, page 88).
//! ponytail: the Japan Post bars follow its customer barcode rules with no Word sample checked, as in the DOM editor; the
//! `\t` text is left off a turned symbol (Word turns it with the symbol, probe barcode-15).

use ew_doc::props::Rgb;

/// A drawn barcode: its size on the line and its rectangles (x, y, w, h from its top left, points), after scale and turn.
#[derive(Clone, Debug, PartialEq)]
pub struct Barcode {
    pub w: f32,
    pub h: f32,
    pub fg: Rgb,
    pub bg: Rgb,
    pub bars: Vec<[f32; 4]>,
    /// EasyWriter: `\t`'s text under the bars in pieces, each piece's text, size, centre and baseline (points from the top
    /// left), drawn in Arial; EAN digits come one by one (engine-fidelity-3).
    pub caption: Vec<(String, f32, f32, f32)>,
}

const ERR_CHARS: &str = "Data contains unsupported character(s).";
const ERR_INVALID: &str = "Data is invalid.";
const ERR_LENGTH: &str = "Data length is not supported by current type.";
const ERR_PARAMS: &str = "Required parameters are missing or incorrect.";

const QR_MODULE: f32 = 2.8515;
const LINEAR_HEIGHT: f32 = 84.0;
const GUARD_DROP: f32 = 1.54;

/// The barcode of a DISPLAYBARCODE field code, or Word's error text for it; `None` for any other field.
pub(crate) fn barcode(instr: &str) -> Option<Result<Barcode, &'static str>> {
    let (args, sw) = field_args(instr, "DISPLAYBARCODE", "bfhpqrsc")?;
    Some(build(args.first().map_or("", String::as_str), &args.get(1).map_or(String::new(), |t| t.to_ascii_uppercase()), &sw))
}

/// The arguments and switches (letter, lower case, and value: the letters of `valued` take one) of a field code naming the
/// field `name`; `None` for another field.
pub(super) fn field_args(instr: &str, name: &str, valued: &str) -> Option<(Vec<String>, Vec<(char, String)>)> {
    let mut toks = Vec::new();
    let mut cs = instr.trim_start().chars().peekable();
    while let Some(&c) = cs.peek() {
        if c.is_whitespace() {
            cs.next();
        } else if c == '"' {
            cs.next();
            let mut t = String::new();
            for c in cs.by_ref() {
                if c == '"' {
                    break;
                }
                t.push(c);
            }
            toks.push((false, t));
        } else {
            let mut t = String::new();
            while let Some(&c) = cs.peek() {
                if c.is_whitespace() || (c == '"' && !t.is_empty()) || (c == '\\' && !t.is_empty()) {
                    break;
                }
                t.push(c);
                cs.next();
            }
            toks.push((t.starts_with('\\'), t));
        }
        if toks.len() > 64 {
            break;
        }
    }
    let (first, rest) = toks.split_first()?;
    if first.0 || !first.1.eq_ignore_ascii_case(name) {
        return None;
    }
    let (mut args, mut sw) = (Vec::new(), Vec::new());
    let mut it = rest.iter();
    while let Some((is_switch, t)) = it.next() {
        match t.chars().nth(1).filter(|_| *is_switch) {
            Some(letter) => {
                let letter = letter.to_ascii_lowercase();
                let value = if valued.contains(letter) { it.next().map(|(_, v)| v.clone()).unwrap_or_default() } else { String::new() };
                sw.push((letter, value));
            }
            None if !is_switch => args.push(t.clone()),
            None => {}
        }
    }
    Some((args, sw))
}

/// A 0xBBGGRR switch value (hex or decimal).
fn bgr(v: Option<&str>) -> Option<Rgb> {
    let s = v?.trim();
    let n = match s.get(..2) {
        Some("0x" | "0X") => u32::from_str_radix(s.get(2..)?, 16).ok()?,
        _ => s.parse::<u32>().ok()?,
    };
    (n <= 0xFF_FFFF).then(|| Rgb((n & 0xFF) as u8, ((n >> 8) & 0xFF) as u8, (n >> 16) as u8))
}

fn build(data: &str, ty: &str, sw: &[(char, String)]) -> Result<Barcode, &'static str> {
    let get = |c: char| sw.iter().find(|(l, _)| *l == c).map(|(_, v)| v.as_str());
    let has = |c: char| sw.iter().any(|(l, _)| *l == c);
    let num = |c: char| get(c).and_then(|v| v.trim().parse::<i64>().ok());
    let upper = |c: char, d: &str| get(c).filter(|v| !v.is_empty()).map_or(d.to_string(), str::to_ascii_uppercase);
    let scale = num('s').filter(|s| (10..=1000).contains(s)).map_or(1.0, |s| s as f32 / 100.0);
    let rot = num('r').unwrap_or(0).rem_euclid(4) as u8;
    let mut caption = Vec::new();
    let fg = bgr(get('f')).unwrap_or(Rgb::BLACK);
    let bg = bgr(get('b')).unwrap_or(Rgb(255, 255, 255));
    // The symbol in its own units: width, height, rectangles, and the points a unit takes.
    let (w, h, bars, k) = match ty {
        "QR" => {
            if data.is_empty() {
                return Err(ERR_LENGTH);
            }
            if !data.is_ascii() {
                return Err(ERR_CHARS);
            }
            let (size, m) = qr::encode(data).ok_or(ERR_LENGTH)?;
            let mut bars = Vec::new();
            for y in 0..size {
                let mut x = 0;
                while x < size {
                    let x0 = x;
                    while x < size && m[y * size + x] {
                        x += 1;
                    }
                    if x > x0 {
                        bars.push([(x0 + 4) as f32, (y + 4) as f32, (x - x0) as f32, 1.0]);
                    }
                    x += 1;
                }
            }
            let n = (size + 8) as f32;
            (n, n, bars, QR_MODULE * scale)
        }
        "JPPOST" => {
            let states = linear::jppost(data)?;
            let (pitch, bar_w, height) = (3.608, 1.7, 23.76);
            let third = height / 3.0;
            let bars = states
                .iter()
                .enumerate()
                .map(|(i, st)| {
                    let (y0, y1) = match st {
                        1 => (0.0, 3.0),
                        2 => (0.0, 2.0),
                        3 => (1.0, 3.0),
                        _ => (1.0, 2.0),
                    };
                    [i as f32 * pitch, y0 * third, bar_w, (y1 - y0) * third]
                })
                .collect();
            ((states.len().max(1) - 1) as f32 * pitch + bar_w, height, bars, scale)
        }
        _ => {
            let sym = match ty {
                "CODE128" => linear::code128(data)?,
                "CODE39" => linear::code39(data, has('x'))?,
                "EAN8" => linear::ean8(data)?,
                "EAN13" => linear::ean13(data, &upper('p', "STD"))?,
                "UPCA" => linear::upca(data, &upper('p', "STD"))?,
                "UPCE" => linear::upce(data)?,
                "ITF14" => linear::itf14(data, &upper('c', "STD"), false)?,
                "CASE" => linear::itf14(data, "STD", true)?,
                "NW7" => linear::nw7(data, has('x'))?,
                _ => return Err(ERR_PARAMS),
            };
            let (w, h, bars) = linear_bars(&sym, has('t'));
            let k = num('h').filter(|v| *v > 0).map_or(1.0, |v| v as f32 / 20.0 / h) * scale;
            // Word's `\t` text (84 pt symbols): EAN and UPC digits 9.48 pt on a baseline 3.84 pt over the bottom, the
            // others 16.8 pt (a fifth of the height) 6 pt over it.
            let (size, up) = if matches!(ty, "EAN8" | "EAN13" | "UPCA" | "UPCE") { (9.48, 3.84) } else { (16.8, 6.0) };
            if has('t') && rot == 0 {
                // Where the first bar starts, as `linear_bars` lays the symbol out.
                let first = (sym.bearer + if sym.frame { 10.0 } else { 0.0 } + sym.quiet) * sym.unit;
                caption = if sym.digits.is_empty() {
                    vec![(data.to_string(), size * k, w / 2.0 * k, (h - up) * k)]
                } else {
                    sym.digits.iter().map(|(c, m)| (c.to_string(), size * k, (first + m * sym.unit) * k, (h - up) * k)).collect()
                };
            }
            (w, h, bars, k)
        }
    };
    let turn = |[x, y, bw, bh]: [f32; 4]| match rot {
        1 => [h - y - bh, x, bh, bw],
        2 => [w - x - bw, h - y - bh, bw, bh],
        3 => [y, w - x - bw, bh, bw],
        _ => [x, y, bw, bh],
    };
    let bars = bars.into_iter().map(|r| turn(r).map(|v| v * k)).collect();
    let (w, h) = if rot % 2 == 1 { (h * k, w * k) } else { (w * k, h * k) };
    Ok(Barcode { w, h, fg, bg, bars, caption })
}

/// A linear symbol's bars in points at the default height: width, height and rectangles.
fn linear_bars(sym: &linear::Symbol, text: bool) -> (f32, f32, Vec<[f32; 4]>) {
    let u = sym.unit;
    let bearer = sym.bearer * u;
    // EAN \p CASE: a frame around the symbol with a gap.
    let frame = if sym.frame { 5.0 * u } else { 0.0 };
    let pad = bearer + frame * 2.0;
    let total: u32 = sym.bars.iter().map(|b| u32::from(*b)).sum();
    let left = pad + sym.quiet * u;
    let w = left * 2.0 + total as f32 * u;
    let tall = if sym.bearer > 0.0 { 72.0 - pad * 2.0 } else { LINEAR_HEIGHT };
    let guarded = !sym.guards.is_empty();
    // The EAN and UPC guard bars reach 1.54 pt below the others, inside the picture.
    let h = tall + pad * 2.0 + if guarded { GUARD_DROP } else { 0.0 };
    let text_h = if text { 9.0 * 1.25 } else { 0.0 };
    let (top, bar_h) = (pad, tall - text_h);
    let mut out = Vec::new();
    let mut x = 0u32;
    for (i, bw) in sym.bars.iter().enumerate() {
        if i % 2 == 0 {
            let guard = sym.guards.iter().any(|(a, z)| x >= *a && x < *z);
            let in_addon = sym.addon.is_some_and(|a| x >= a);
            // Guard bars run longer than the data bars; add-on bars start lower to leave room for its digits.
            let y0 = if in_addon && text { top + text_h } else { top };
            let y1 = if guard { top + tall - if text { text_h / 2.0 } else { -GUARD_DROP } } else { top + bar_h };
            out.push([left + x as f32 * u, y0, f32::from(*bw) * u, y1 - y0]);
        }
        x += u32::from(*bw);
    }
    if bearer > 0.0 {
        out.extend([[0.0, 0.0, w, bearer], [0.0, h - bearer, w, bearer], [0.0, 0.0, bearer, h], [w - bearer, 0.0, bearer, h]]);
    }
    if frame > 0.0 {
        out.extend([[0.0, 0.0, w, frame], [0.0, h - frame, w, frame], [0.0, 0.0, frame, h], [w - frame, 0.0, frame, h]]);
    }
    (w, h, out)
}

/// Linear codes: Code 128, Code 39, EAN-13, EAN-8, UPC-A, UPC-E, interleaved 2 of 5 (ITF-14, CASE), NW-7 and Japan Post.
mod linear {
    use super::{ERR_CHARS, ERR_INVALID, ERR_LENGTH};

    /// Element widths in units (bar first, alternating), the unit (pt), the quiet zone and bearer (units), the guard bar
    /// spans and the add-on's start (modules).
    pub(super) struct Symbol {
        pub bars: Vec<u8>,
        pub unit: f32,
        pub quiet: f32,
        pub bearer: f32,
        pub frame: bool,
        pub guards: Vec<(u32, u32)>,
        pub addon: Option<u32>,
        /// EasyWriter engine-fidelity-3: `\t`'s digits one by one, each centred at a distance in modules from the first
        /// bar, as Word sets EAN digits; empty for the codes whose text is centred in one piece.
        pub digits: Vec<(char, f32)>,
    }

    fn plain(bars: Vec<u8>, unit: f32, quiet: f32) -> Symbol {
        Symbol { bars, unit, quiet, bearer: 0.0, frame: false, guards: Vec::new(), addon: None, digits: Vec::new() }
    }

    fn widths(s: &str) -> impl Iterator<Item = u8> + '_ {
        s.bytes().map(|b| b - b'0')
    }

    const C128: [&str; 107] = [
        "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232",
        "122132", "122231", "113222", "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122",
        "321221", "312212", "322112", "322211", "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311",
        "211313", "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331", "231131", "213113",
        "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224", "111422",
        "121124", "121421", "141122", "141221", "112214", "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111",
        "241112", "134111", "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", "214121",
        "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
        "211214", "211232", "2331112",
    ];

    #[derive(Clone)]
    enum Step {
        Start(usize),
        Code(u8),
        Vals(Vec<u8>),
    }

    #[derive(Clone)]
    struct Node {
        cost: u32,
        from: Option<(usize, usize)>,
        step: Step,
    }

    /// The code sets B, C and A (B first: on a tie the symbol uses it), their switch codes and start codes.
    const SETS: [usize; 3] = [0, 1, 2];
    const SET_CODE: [u8; 3] = [100, 99, 101];
    const START: [u8; 3] = [104, 105, 103];

    /// The Code 128 values (start and data, no check) with the fewest symbols: a shortest path over the three code sets,
    /// with Shift for a single character of the other of A and B. `None` past ASCII.
    pub(super) fn code128_values(text: &str) -> Option<Vec<u8>> {
        let cs = text.as_bytes();
        if !text.is_ascii() {
            return None;
        }
        let n = cs.len();
        let digit = |i: usize| cs.get(i).is_some_and(u8::is_ascii_digit);
        let in_a = |c: u8| c < 96;
        let in_b = |c: u8| c >= 32;
        let val_a = |c: u8| if c < 32 { c + 64 } else { c - 32 };
        // best[i]: per set, in the order first reached (as the DOM editor's object keys), so ties break the same way.
        let mut best: Vec<Vec<(usize, Node)>> = vec![Vec::new(); n + 1];
        let relax = |best: &mut Vec<Vec<(usize, Node)>>, i: usize, set: usize, node: Node| {
            let Some(slot) = best.get_mut(i) else { return };
            match slot.iter_mut().find(|(s, _)| *s == set) {
                Some((_, cur)) if node.cost < cur.cost => *cur = node,
                Some(_) => {}
                None => slot.push((set, node)),
            }
        };
        for s in SETS {
            relax(&mut best, 0, s, Node { cost: 1, from: None, step: Step::Start(s) });
        }
        for i in 0..n {
            let before = best[i].clone();
            for (s, cur) in &before {
                for t in SETS.into_iter().filter(|t| t != s) {
                    relax(&mut best, i, t, Node { cost: cur.cost + 1, from: Some((i, *s)), step: Step::Code(SET_CODE[t]) });
                }
            }
            for s in SETS {
                let Some(cost) = best[i].iter().find(|(k, _)| *k == s).map(|(_, c)| c.cost) else { continue };
                let c = cs[i];
                let from = Some((i, s));
                if s == 1 {
                    if digit(i) && digit(i + 1) {
                        relax(&mut best, i + 2, 1, Node { cost: cost + 1, from, step: Step::Vals(vec![(c - 48) * 10 + cs[i + 1] - 48]) });
                    }
                } else {
                    let is_a = s == 2;
                    if if is_a { in_a(c) } else { in_b(c) } {
                        relax(&mut best, i + 1, s, Node { cost: cost + 1, from, step: Step::Vals(vec![if is_a { val_a(c) } else { c - 32 }]) });
                    } else if if is_a { in_b(c) } else { in_a(c) } {
                        let v = if is_a { c - 32 } else { val_a(c) };
                        relax(&mut best, i + 1, s, Node { cost: cost + 2, from, step: Step::Vals(vec![98, v]) });
                    }
                }
            }
        }
        let mut end: Option<(usize, u32)> = None;
        for s in SETS {
            if let Some((_, node)) = best[n].iter().find(|(k, _)| *k == s)
                && end.is_none_or(|(_, c)| node.cost < c)
            {
                end = Some((s, node.cost));
            }
        }
        let mut out: Vec<u8> = Vec::new();
        let mut at = end.map(|(s, _)| (n, s));
        let mut guard = 0;
        while let Some((i, s)) = at {
            let node = best.get(i)?.iter().find(|(k, _)| *k == s)?.1.clone();
            let vals = match node.step {
                Step::Start(s) => vec![START[s]],
                Step::Code(c) => vec![c],
                Step::Vals(v) => v,
            };
            out.splice(0..0, vals);
            at = node.from;
            guard += 1;
            if guard > 4 * n + 8 {
                return None;
            }
        }
        Some(out)
    }

    pub(super) fn code128(text: &str) -> Result<Symbol, &'static str> {
        if text.is_empty() {
            return Err(ERR_LENGTH);
        }
        let v = code128_values(text).ok_or(ERR_CHARS)?;
        let check = (v.iter().enumerate().map(|(i, x)| u32::from(*x) * i.max(1) as u32).sum::<u32>() % 103) as u8;
        let bars = v.iter().chain([check, 106].iter()).flat_map(|x| widths(C128[usize::from(*x)])).collect();
        Ok(plain(bars, 1.05, 10.0))
    }

    const C39_CHARS: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";
    const C39: [&str; 43] = [
        "nnnwwnwnn", "wnnwnnnnw", "nnwwnnnnw", "wnwwnnnnn", "nnnwwnnnw", "wnnwwnnnn", "nnwwwnnnn", "nnnwnnwnw", "wnnwnnwnn", "nnwwnnwnn",
        "wnnnnwnnw", "nnwnnwnnw", "wnwnnwnnn", "nnnnwwnnw", "wnnnwwnnn", "nnwnwwnnn", "nnnnnwwnw", "wnnnnwwnn", "nnwnnwwnn", "nnnnwwwnn",
        "wnnnnnnww", "nnwnnnnww", "wnwnnnnwn", "nnnnwnnww", "wnnnwnnwn", "nnwnwnnwn", "nnnnnnwww", "wnnnnnwwn", "nnwnnnwwn", "nnnnwnwwn",
        "wwnnnnnnw", "nwwnnnnnw", "wwwnnnnnn", "nwnnwnnnw", "wwnnwnnnn", "nwwnwnnnn", "nwnnnnwnw", "wwnnnnwnn", "nwwnnnwnn", "nwnwnwnnn",
        "nwnwnnnwn", "nwnnnwnwn", "nnnwnwnwn",
    ];

    /// Code 39 with its * start and stop; `check` (\x) adds the mod 43 character.
    pub(super) fn code39(text: &str, check: bool) -> Result<Symbol, &'static str> {
        if text.is_empty() {
            return Err(ERR_LENGTH);
        }
        let idx: Option<Vec<usize>> = text.chars().map(|c| C39_CHARS.find(c)).collect();
        let mut idx = idx.ok_or(ERR_CHARS)?;
        if check {
            idx.push(idx.iter().sum::<usize>() % 43);
        }
        let mut bars = Vec::new();
        let star = "nwnnwnwnn";
        for p in std::iter::once(star).chain(idx.iter().map(|i| C39[*i])).chain(std::iter::once(star)) {
            if !bars.is_empty() {
                bars.push(1);
            }
            bars.extend(p.bytes().map(|b| if b == b'w' { 2 } else { 1 }));
        }
        Ok(plain(bars, 0.99, 0.0))
    }

    const L: [&str; 10] = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
    const EAN13_PARITY: [&str; 10] = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];
    const UPCE_PARITY: [&str; 10] = ["GGGLLL", "GGLGLL", "GGLLGL", "GGLLLG", "GLGGLL", "GLLGGL", "GLLLGG", "GLGLGL", "GLGLLG", "GLLGLG"];
    const SUP5_PARITY: [&str; 10] = ["GGLLL", "GLGLL", "GLLGL", "GLLLG", "LGGLL", "LLGGL", "LLLGG", "LGLGL", "LGLLG", "LLGLG"];
    const EAN_UNIT: f32 = 0.9506;

    /// A digit's seven modules in set L, G (R reversed) or R (L inverted).
    fn code(d: u8, set: u8) -> String {
        let l = L[usize::from(d % 10)];
        let r: String = l.chars().map(|b| if b == '1' { '0' } else { '1' }).collect();
        match set {
            b'L' => l.to_string(),
            b'G' => r.chars().rev().collect(),
            _ => r,
        }
    }

    fn digits(s: &str) -> Vec<u8> {
        s.bytes().map(|b| b - b'0').collect()
    }

    /// The mod 10 check digit (weights 3 and 1 from the right).
    pub(super) fn mod10(ds: &[u8]) -> u8 {
        let sum: u32 = ds.iter().rev().enumerate().map(|(i, d)| u32::from(*d) * if i % 2 == 0 { 3 } else { 1 }).sum();
        ((10 - sum % 10) % 10) as u8
    }

    /// Modules ('1' bar, '0' space) to element widths, bar first.
    fn runs(mods: &str) -> Vec<u8> {
        let b = mods.as_bytes();
        let mut out = Vec::new();
        let mut run = 0u8;
        for i in 0..b.len() {
            run = run.saturating_add(1);
            if i + 1 == b.len() || b[i] != b[i + 1] {
                out.push(run);
                run = 0;
            }
        }
        out
    }

    /// `data` completed with its check digit to `len` digits (`len - 1` get one; `len` must carry a valid one).
    fn with_check(data: &str, len: usize) -> Result<Vec<u8>, &'static str> {
        if data.is_empty() || !data.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ERR_CHARS);
        }
        let mut d = digits(data);
        if d.len() + 1 == len {
            d.push(mod10(&d));
            return Ok(d);
        }
        if d.len() != len {
            return Err(ERR_LENGTH);
        }
        let (body, last) = d.split_at(len - 1);
        if mod10(body) == last[0] { Ok(d) } else { Err(ERR_INVALID) }
    }

    fn addon(ds: &[u8]) -> String {
        let parity = if ds.len() == 2 {
            ["LL", "LG", "GL", "GG"][usize::from(ds[0] * 10 + ds[1]) % 4]
        } else {
            SUP5_PARITY[(3 * (u32::from(ds[0]) + u32::from(ds[2]) + u32::from(ds[4])) + 9 * (u32::from(ds[1]) + u32::from(ds[3]))) as usize % 10]
        };
        let codes: Vec<String> = ds.iter().zip(parity.bytes()).map(|(d, p)| code(*d, p)).collect();
        format!("1011{}", codes.join("01"))
    }

    /// EAN digits `d` under the two halves of `n` symbol characters each, which start `left` and `right` modules from the
    /// first bar: each digit centred under its seven modules.
    fn halves(d: &[u8], n: usize, left: f32, right: f32) -> impl Iterator<Item = (char, f32)> + '_ {
        d.iter().take(2 * n).enumerate().map(move |(i, x)| {
            let start = if i < n { left + 7.0 * i as f32 } else { right + 7.0 * (i - n) as f32 };
            (char::from(b'0' + x), start + 3.5)
        })
    }

    fn ean_symbol(mods: &str, guards: &[(u32, u32)], add: Option<&[u8]>, frame: bool) -> Symbol {
        let extra = add.map_or(String::new(), |a| format!("{}{}", "0".repeat(10), addon(a)));
        Symbol {
            bars: runs(&format!("{mods}{extra}")),
            unit: EAN_UNIT,
            quiet: 9.0,
            bearer: 0.0,
            frame,
            guards: guards.to_vec(),
            addon: add.map(|_| mods.len() as u32 + 10),
            digits: Vec::new(),
        }
    }

    fn sup_len(style: &str) -> usize {
        match style {
            "SUP2" => 2,
            "SUP5" => 5,
            _ => 0,
        }
    }

    /// EAN-13 for 12 or 13 digits; \p SUP2 and SUP5 add an add-on, CASE a frame.
    pub(super) fn ean13(data: &str, style: &str) -> Result<Symbol, &'static str> {
        if !data.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ERR_CHARS);
        }
        let extra = sup_len(style);
        if extra > 0 && data.len() != 12 + extra && data.len() != 13 + extra {
            return Err(ERR_LENGTH);
        }
        let (main, add) = data.split_at(data.len() - extra);
        let d = with_check(main, 13)?;
        let par = EAN13_PARITY[usize::from(d[0])].as_bytes();
        let left: String = d[1..7].iter().zip(par).map(|(x, p)| code(*x, *p)).collect();
        let right: String = d[7..].iter().map(|x| code(*x, b'R')).collect();
        let add = digits(add);
        let mut sym = ean_symbol(&format!("101{left}01010{right}101"), &[(0, 3), (45, 50), (92, 95)], (extra > 0).then_some(&add[..]), style == "CASE");
        // Word's PDF of the fixture (page 88, EAN-13 \t): the first digit 3.5 modules left of the guard, each other one
        // under its seven modules, beside the guards.
        sym.digits = std::iter::once((char::from(b'0' + d[0]), -3.5)).chain(halves(&d[1..], 6, 3.0, 50.0)).collect();
        Ok(sym)
    }

    pub(super) fn ean8(data: &str) -> Result<Symbol, &'static str> {
        let d = with_check(data, 8)?;
        let left: String = d[..4].iter().map(|x| code(*x, b'L')).collect();
        let right: String = d[4..].iter().map(|x| code(*x, b'R')).collect();
        let mut sym = ean_symbol(&format!("101{left}01010{right}101"), &[(0, 3), (31, 36), (64, 67)], None, false);
        // Probe barcode-15: four digits under each half.
        sym.digits = halves(&d, 4, 3.0, 36.0).collect();
        Ok(sym)
    }

    /// UPC-A: EAN-13 with a leading 0, its first and last digit codes as long as the guards.
    pub(super) fn upca(data: &str, style: &str) -> Result<Symbol, &'static str> {
        if !data.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ERR_CHARS);
        }
        let extra = sup_len(style).min(data.len());
        let (main, add) = data.split_at(data.len() - extra);
        let d: String = with_check(main, 12)?.iter().map(|x| char::from(b'0' + x)).collect();
        let mut sym = ean13(&format!("0{d}{add}"), style)?;
        sym.guards = vec![(0, 10), (45, 50), (85, 95)];
        // Probe barcode-15: the first and last digits outside the guards, the ten others under their characters.
        let mut ds = sym.digits.split_off(1);
        if let Some(last) = ds.last_mut() {
            last.1 = 95.0 + RIGHT_DIGIT;
        }
        if let Some(first) = ds.first_mut() {
            first.1 = -3.5;
        }
        sym.digits = ds;
        Ok(sym)
    }

    /// The UPC-A digits a UPC-E number system and six digits stand for (zero suppression).
    fn upce_to_a(ns: u8, d: &[u8]) -> Vec<u8> {
        let mut out = vec![ns];
        out.extend(match d[5] {
            0..=2 => vec![d[0], d[1], d[5], 0, 0, 0, 0, d[2], d[3], d[4]],
            3 => vec![d[0], d[1], d[2], 0, 0, 0, 0, 0, d[3], d[4]],
            4 => vec![d[0], d[1], d[2], d[3], 0, 0, 0, 0, 0, d[4]],
            t => vec![d[0], d[1], d[2], d[3], d[4], 0, 0, 0, 0, t],
        });
        out
    }

    /// UPC-E for 7 digits starting with 0, or 8 with a valid check.
    pub(super) fn upce(data: &str) -> Result<Symbol, &'static str> {
        if !data.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ERR_CHARS);
        }
        if data.len() != 7 && data.len() != 8 {
            return Err(ERR_LENGTH);
        }
        let d = digits(data);
        if if d.len() == 7 { d[0] != 0 } else { d[0] > 1 } {
            return Err(ERR_INVALID);
        }
        let check = mod10(&upce_to_a(d[0], &d[1..7]));
        if d.len() == 8 && d[7] != check {
            return Err(ERR_INVALID);
        }
        let par = UPCE_PARITY[usize::from(check)].as_bytes();
        let body: String = d[1..7]
            .iter()
            .zip(par)
            .map(|(x, p)| code(*x, if d[0] == 1 { if *p == b'G' { b'L' } else { b'G' } } else { *p }))
            .collect();
        let mut sym = ean_symbol(&format!("101{body}010101"), &[(0, 3), (45, 51)], None, false);
        // Probe barcode-15: the number system left of the guard, the six digits under their characters, the check digit
        // right of the end guard.
        let first = std::iter::once((char::from(b'0' + d[0]), -3.5));
        let inner = d[1..7].iter().enumerate().map(|(i, x)| (char::from(b'0' + x), 3.0 + 7.0 * i as f32 + 3.5));
        sym.digits = first.chain(inner).chain(std::iter::once((char::from(b'0' + check), 51.0 + RIGHT_DIGIT))).collect();
        Ok(sym)
    }

    /// How far past the end guard a UPC code's last digit is centred, in modules (probe barcode-15: UPC-A 97.75, UPC-E
    /// 53.75 from the first bar).
    const RIGHT_DIGIT: f32 = 2.75;

    const I25: [&str; 10] = ["nnwwn", "wnnnw", "nwnnw", "wwnnn", "nnwnw", "wnwnn", "nwwnn", "nnnww", "wnnwn", "nwnwn"];

    /// ITF-14 (\c STD 13 or 14 digits, EXT 15 or 16) and CASE (13 or 14): interleaved 2 of 5, narrow 2 units, wide 5, at
    /// 0.9 pt a unit, in a bearer frame.
    pub(super) fn itf14(data: &str, ext: &str, case: bool) -> Result<Symbol, &'static str> {
        if !data.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ERR_CHARS);
        }
        // ponytail: \c ADD's length is unknown (Word rejected 13, 17 and 18 digits); it is refused with the length error.
        let len = match ext {
            _ if case => 14,
            "STD" => 14,
            "EXT" => 16,
            _ => return Err(ERR_LENGTH),
        };
        let d = with_check(data, len)?;
        let w = |b: u8| if b == b'w' { 5 } else { 2 };
        let mut bars = vec![2, 2, 2, 2];
        for pair in d.chunks(2) {
            let (a, b) = (I25[usize::from(pair[0])].as_bytes(), I25[usize::from(*pair.get(1).unwrap_or(&0))].as_bytes());
            for k in 0..5 {
                bars.extend([w(a[k]), w(b[k])]);
            }
        }
        bars.extend([5, 2, 2]);
        Ok(Symbol { bearer: 10.0, ..plain(bars, 0.9, 6.0) })
    }

    const NW7_CHARS: &str = "0123456789-$:/.+abcd";
    const NW7: [&str; 20] = [
        "0000011", "0000110", "0001001", "1100000", "0010010", "1000010", "0100001", "0100100", "0110000", "1001000", "0001100", "0011000",
        "1000101", "1010001", "1010100", "0010101", "0011010", "0101001", "0001011", "0001110",
    ];

    /// NW-7 (Codabar) between a to d start and stop characters (data without them draws between a and a); `check` (\x)
    /// adds the mod 16 character before the stop.
    pub(super) fn nw7(data: &str, check: bool) -> Result<Symbol, &'static str> {
        if data.is_empty() {
            return Err(ERR_LENGTH);
        }
        let idx: Option<Vec<usize>> = data.chars().map(|c| NW7_CHARS.find(c)).collect();
        let mut d = idx.ok_or(ERR_CHARS)?;
        let end = |i: &usize| *i >= 16;
        if !(d.len() >= 2 && end(&d[0]) && d.last().is_some_and(end)) {
            if d.iter().any(end) {
                return Err(ERR_INVALID);
            }
            d.insert(0, 16);
            d.push(16);
        }
        if d[1..d.len() - 1].iter().any(end) {
            return Err(ERR_INVALID);
        }
        if check {
            let sum: usize = d.iter().sum();
            d.insert(d.len() - 1, (16 - sum % 16) % 16);
        }
        let mut bars = Vec::new();
        for i in d {
            if !bars.is_empty() {
                bars.push(1);
            }
            bars.extend(NW7[i].bytes().map(|b| if b == b'1' { 3 } else { 1 }));
        }
        Ok(plain(bars, 1.04, 10.0))
    }

    /// Japan Post bars by symbol value (0 to 9, 10 the hyphen, 11 to 18 CC1 to CC8): 1 long, 2 ascender, 3 descender,
    /// 4 tracker.
    const JP: [&str; 19] = ["144", "114", "132", "312", "123", "141", "321", "213", "231", "411", "414", "324", "342", "234", "432", "243", "423", "441", "111"];

    /// The Japan Post customer barcode's bar states: start, the postal code and address as 20 symbols (letters as a control
    /// symbol and a digit, padded with CC4), the mod 19 check, stop. Full-width digits and letters count as half width.
    pub(super) fn jppost(data: &str) -> Result<Vec<u8>, &'static str> {
        if data.is_empty() {
            return Err(ERR_LENGTH);
        }
        let mut s = String::new();
        for c in data.chars() {
            let c = match u32::from(c) {
                0xFF01..=0xFF5E => char::from_u32(u32::from(c) - 0xFEE0).unwrap_or(c),
                _ => c,
            }
            .to_ascii_uppercase();
            if matches!(c, '\u{2010}'..='\u{2015}' | '\u{2212}' | '\u{30FC}') {
                s.push('-');
            } else if !c.is_whitespace() {
                s.push(c);
            }
        }
        let postal: Vec<u8> = s.bytes().filter(|b| *b != b'-').take(7).collect();
        if postal.len() < 7 || !postal.iter().all(u8::is_ascii_digit) {
            return Err(ERR_INVALID);
        }
        // The address starts after the seventh digit, wherever the postal code's own hyphen falls.
        let mut seen = 0;
        let k = s.char_indices().find(|(_, c)| {
            seen += usize::from(c.is_ascii_digit());
            seen == 7
        });
        let rest = k.map_or("", |(i, _)| s.get(i + 1..).unwrap_or("")).trim_start_matches('-');
        let mut syms: Vec<usize> = postal.iter().map(|b| usize::from(b - b'0')).collect();
        let mut hyphen = false;
        for c in rest.chars() {
            if c == '-' {
                if !hyphen {
                    syms.push(10);
                }
                hyphen = true;
                continue;
            }
            hyphen = false;
            match c {
                '0'..='9' => syms.push(c as usize - '0' as usize),
                'A'..='Z' => {
                    let i = c as usize - 'A' as usize;
                    syms.extend([11 + i / 10, i % 10]);
                }
                _ => return Err(ERR_CHARS),
            }
        }
        syms.resize(20, 14);
        let check = (19 - syms.iter().sum::<usize>() % 19) % 19;
        let mut states = vec![1, 3];
        for i in syms.into_iter().chain([check]) {
            states.extend(JP[i].bytes().map(|b| b - b'0'));
        }
        states.extend([3, 1]);
        Ok(states)
    }
}

/// QR Code (ISO/IEC 18004) at level Q: numeric, alphanumeric or byte mode, versions 1 to 40, Reed-Solomon over GF(256),
/// the block interleave, the 8 masks with the penalty rules, format and version information.
mod qr {
    // Error correction codewords per block and blocks, level Q, by version (index 0 unused).
    const ECC: [u32; 41] = [
        0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30,
        30, 30, 30, 30, 30, 30, 30,
    ];
    const BLOCKS: [u32; 41] = [
        0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53,
        56, 59, 62, 65, 68,
    ];
    /// Level Q's format bits.
    const LEVEL_BITS: u32 = 3;
    const ALNUM: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

    fn mul(x: u8, y: u8) -> u8 {
        let mut z: u32 = 0;
        for i in (0..8).rev() {
            z = (z << 1) ^ ((z >> 7) * 0x11D);
            z ^= ((u32::from(y) >> i) & 1) * u32::from(x);
        }
        z as u8
    }

    /// The `degree` error correction codewords of `data`.
    pub(super) fn rs_remainder(data: &[u8], degree: usize) -> Vec<u8> {
        let mut div = vec![0u8; degree];
        if let Some(last) = div.last_mut() {
            *last = 1;
        }
        let mut root = 1u8;
        for _ in 0..degree {
            for j in 0..degree {
                div[j] = mul(div[j], root);
                if j + 1 < degree {
                    div[j] ^= div[j + 1];
                }
            }
            root = mul(root, 2);
        }
        let mut r = vec![0u8; degree];
        for b in data {
            let factor = b ^ r.first().copied().unwrap_or(0);
            if !r.is_empty() {
                r.remove(0);
                r.push(0);
            }
            for (ri, c) in r.iter_mut().zip(&div) {
                *ri ^= mul(*c, factor);
            }
        }
        r
    }

    fn raw_modules(v: u32) -> u32 {
        let mut r = (16 * v + 128) * v + 64;
        if v >= 2 {
            let n = v / 7 + 2;
            r -= (25 * n - 10) * n - 55;
            if v >= 7 {
                r -= 36;
            }
        }
        r
    }

    fn capacity(v: u32) -> u32 {
        raw_modules(v) / 8 - ECC[v as usize] * BLOCKS[v as usize]
    }

    /// The data codewords of `text` at version `v`, padded, or `None` when it does not fit.
    fn data_codewords(text: &str, v: u32) -> Option<Vec<u8>> {
        let (mode, counts) = if text.bytes().all(|b| b.is_ascii_digit()) {
            (1u32, [10, 12, 14])
        } else if text.chars().all(|c| ALNUM.contains(c)) {
            (2, [9, 11, 13])
        } else {
            (4, [8, 16, 16])
        };
        let count_bits = counts[if v <= 9 { 0 } else if v <= 26 { 1 } else { 2 }];
        let count = text.len() as u32;
        if count >= 1 << count_bits {
            return None;
        }
        let cap = (capacity(v) * 8) as usize;
        let mut bits: Vec<u8> = Vec::new();
        let put = |bits: &mut Vec<u8>, v: u32, n: u32| bits.extend((0..n).rev().map(|i| ((v >> i) & 1) as u8));
        put(&mut bits, mode, 4);
        put(&mut bits, count, count_bits);
        let t = text.as_bytes();
        match mode {
            1 => {
                for g in t.chunks(3) {
                    let n = g.iter().fold(0u32, |a, d| a * 10 + u32::from(d - b'0'));
                    put(&mut bits, n, g.len() as u32 * 3 + 1);
                }
            }
            2 => {
                let ix = |b: u8| ALNUM.find(char::from(b)).unwrap_or(0) as u32;
                for g in t.chunks(2) {
                    match g {
                        [a, b] => put(&mut bits, ix(*a) * 45 + ix(*b), 11),
                        [a] => put(&mut bits, ix(*a), 6),
                        _ => {}
                    }
                }
            }
            _ => t.iter().for_each(|b| put(&mut bits, u32::from(*b), 8)),
        }
        if bits.len() > cap {
            return None;
        }
        let end = (cap - bits.len()).min(4) as u32;
        put(&mut bits, 0, end);
        let fill = ((8 - bits.len() % 8) % 8) as u32;
        put(&mut bits, 0, fill);
        let mut out: Vec<u8> = bits.chunks(8).map(|c| c.iter().fold(0u8, |a, b| (a << 1) | b)).collect();
        let mut pad = 0xECu8;
        while out.len() < cap / 8 {
            out.push(pad);
            pad ^= 0xEC ^ 0x11;
        }
        Some(out)
    }

    /// The final codewords: the data split into blocks (short ones first), each with its error correction, interleaved.
    fn codewords(data: &[u8], v: u32) -> Vec<u8> {
        let n = BLOCKS[v as usize] as usize;
        let ecc = ECC[v as usize] as usize;
        let raw = (raw_modules(v) / 8) as usize;
        let short = raw / n - ecc;
        let shorts = n - raw % n;
        let mut blocks = Vec::new();
        let mut k = 0;
        for i in 0..n {
            let len = short + usize::from(i >= shorts);
            let d = data.get(k..(k + len).min(data.len())).unwrap_or(&[]).to_vec();
            k += len;
            let e = rs_remainder(&d, ecc);
            blocks.push((d, e));
        }
        let mut out = Vec::new();
        for i in 0..=short {
            out.extend(blocks.iter().filter_map(|(d, _)| d.get(i)));
        }
        for i in 0..ecc {
            out.extend(blocks.iter().filter_map(|(_, e)| e.get(i)));
        }
        out
    }

    fn format_bits(mask: u32) -> u32 {
        let data = (LEVEL_BITS << 3) | mask;
        let mut rem = data;
        for _ in 0..10 {
            rem = (rem << 1) ^ ((rem >> 9) * 0x537);
        }
        ((data << 10) | rem) ^ 0x5412
    }

    fn version_bits(v: u32) -> u32 {
        let mut rem = v;
        for _ in 0..12 {
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
        }
        (v << 12) | rem
    }

    fn alignment(v: u32) -> Vec<usize> {
        if v == 1 {
            return Vec::new();
        }
        let n = (v / 7 + 2) as usize;
        let step = if v == 32 { 26 } else { (v * 4 + 4).div_ceil(n as u32 * 2 - 2) * 2 } as i64;
        let mut out = vec![6usize];
        let mut pos = i64::from(v * 4 + 10);
        while out.len() < n {
            out.insert(1, pos.max(0) as usize);
            pos -= step;
        }
        out
    }

    struct Matrix {
        size: usize,
        m: Vec<bool>,
        f: Vec<bool>,
    }

    impl Matrix {
        fn set(&mut self, x: usize, y: usize, dark: bool) {
            let i = y * self.size + x;
            if let (Some(m), Some(f)) = (self.m.get_mut(i), self.f.get_mut(i)) {
                *m = dark;
                *f = true;
            }
        }

        fn new(v: u32) -> Matrix {
            let size = (v * 4 + 17) as usize;
            let mut q = Matrix { size, m: vec![false; size * size], f: vec![false; size * size] };
            for i in 0..size {
                q.set(6, i, i % 2 == 0);
                q.set(i, 6, i % 2 == 0);
            }
            for (cx, cy) in [(3i64, 3i64), (size as i64 - 4, 3), (3, size as i64 - 4)] {
                for dy in -4i64..=4 {
                    for dx in -4i64..=4 {
                        let d = dx.abs().max(dy.abs());
                        let (x, y) = (cx + dx, cy + dy);
                        if (0..size as i64).contains(&x) && (0..size as i64).contains(&y) {
                            q.set(x as usize, y as usize, d != 2 && d != 4);
                        }
                    }
                }
            }
            let al = alignment(v);
            let last = al.len().saturating_sub(1);
            for i in 0..al.len() {
                for j in 0..al.len() {
                    if (i == 0 && j == 0) || (i == 0 && j == last) || (i == last && j == 0) {
                        continue;
                    }
                    for dy in -2i64..=2 {
                        for dx in -2i64..=2 {
                            q.set((al[i] as i64 + dx) as usize, (al[j] as i64 + dy) as usize, dx.abs().max(dy.abs()) != 1);
                        }
                    }
                }
            }
            q.format(0);
            if v >= 7 {
                let bits = version_bits(v);
                for i in 0..18 {
                    let bit = (bits >> i) & 1 == 1;
                    let (a, b) = (size - 11 + i % 3, i / 3);
                    q.set(a, b, bit);
                    q.set(b, a, bit);
                }
            }
            q
        }

        fn format(&mut self, bits: u32) {
            let size = self.size;
            let bit = |i: u32| (bits >> i) & 1 == 1;
            for i in 0..=5 {
                self.set(8, i as usize, bit(i));
            }
            self.set(8, 7, bit(6));
            self.set(8, 8, bit(7));
            self.set(7, 8, bit(8));
            for i in 9..15 {
                self.set(14 - i as usize, 8, bit(i));
            }
            for i in 0..8 {
                self.set(size - 1 - i as usize, 8, bit(i));
            }
            for i in 8..15 {
                self.set(8, size - 15 + i as usize, bit(i));
            }
            self.set(8, size - 8, true);
        }

        fn data(&mut self, cw: &[u8]) {
            let size = self.size;
            let mut i = 0usize;
            let mut right = size as i64 - 1;
            while right >= 1 {
                if right == 6 {
                    right = 5;
                }
                for v in 0..size {
                    for j in 0..2 {
                        let x = (right - j) as usize;
                        let upward = (right + 1) & 2 == 0;
                        let y = if upward { size - 1 - v } else { v };
                        if !self.f[y * size + x] && i < cw.len() * 8 {
                            self.m[y * size + x] = (cw[i >> 3] >> (7 - (i & 7))) & 1 == 1;
                            i += 1;
                        }
                    }
                }
                right -= 2;
            }
        }

        fn mask(&mut self, mask: u32) {
            for y in 0..self.size {
                for x in 0..self.size {
                    let i = y * self.size + x;
                    let flip = match mask {
                        0 => (x + y) % 2 == 0,
                        1 => y % 2 == 0,
                        2 => x % 3 == 0,
                        3 => (x + y) % 3 == 0,
                        4 => (x / 3 + y / 2) % 2 == 0,
                        5 => (x * y) % 2 + (x * y) % 3 == 0,
                        6 => ((x * y) % 2 + (x * y) % 3) % 2 == 0,
                        _ => ((x + y) % 2 + (x * y) % 3) % 2 == 0,
                    };
                    if !self.f[i] && flip {
                        self.m[i] = !self.m[i];
                    }
                }
            }
        }

        /// The penalty score (§7.8.3), read as the DOM editor reads it (it picks Word's own mask for its sample).
        fn penalty(&self) -> u32 {
            let size = self.size;
            let line = |get: &dyn Fn(usize) -> bool| {
                let mut s = 0;
                let mut run = 1;
                for i in 1..=size {
                    if i < size && get(i) == get(i - 1) {
                        run += 1;
                    } else {
                        if run >= 5 {
                            s += 3 + run - 5;
                        }
                        run = 1;
                    }
                }
                let light = |a: i64, b: i64| (a.max(0)..b.min(size as i64)).all(|i| !get(i as usize));
                for i in 0..size.saturating_sub(6) {
                    let core = get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6);
                    if core && (light(i as i64 - 4, i as i64) || light(i as i64 + 7, i as i64 + 11)) {
                        s += 40;
                    }
                }
                s as u32
            };
            let m = &self.m;
            let mut score = 0;
            for y in 0..size {
                score += line(&|x| m[y * size + x]);
            }
            for x in 0..size {
                score += line(&|y| m[y * size + x]);
            }
            for y in 0..size - 1 {
                for x in 0..size - 1 {
                    let c = m[y * size + x];
                    if c == m[y * size + x + 1] && c == m[(y + 1) * size + x] && c == m[(y + 1) * size + x + 1] {
                        score += 3;
                    }
                }
            }
            let dark = m.iter().filter(|c| **c).count() as i64;
            let total = (size * size) as i64;
            score + ((dark * 2 - total).abs() * 10 / total) as u32 * 10
        }
    }

    /// `text` as a level Q symbol: its size in modules and its modules row by row (dark true, no quiet zone).
    pub(super) fn encode(text: &str) -> Option<(usize, Vec<bool>)> {
        let (v, data) = (1..=40).find_map(|v| data_codewords(text, v).map(|d| (v, d)))?;
        let cw = codewords(&data, v);
        let mut best: Option<(u32, Matrix)> = None;
        for mask in 0..8 {
            let mut q = Matrix::new(v);
            q.data(&cw);
            q.mask(mask);
            q.format(format_bits(mask));
            let score = q.penalty();
            if best.as_ref().is_none_or(|(s, _)| score < *s) {
                best = Some((score, q));
            }
        }
        best.map(|(_, q)| (q.size, q.m))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_symbols_take_words_module_and_quiet_zone() {
        // "https://example.com" is a version 2 symbol (25 modules) in Word: 33 modules with the quiet zone, 94.1 pt.
        let b = barcode(r#"DISPLAYBARCODE "https://example.com" QR \q 3"#).unwrap().unwrap();
        assert!((b.w - 33.0 * QR_MODULE).abs() < 0.01 && b.w == b.h, "{} x {}", b.w, b.h);
        // Its error correction checks out: each block's remainder over the whole block is zero.
        let block: Vec<u8> = (0..20).collect();
        let mut whole = block.clone();
        whole.extend(qr::rs_remainder(&block, 13));
        assert!(qr::rs_remainder(&whole, 13).iter().all(|b| *b == 0));
        // \s scales it.
        let half = barcode(r#"DISPLAYBARCODE "https://example.com" QR \s 50"#).unwrap().unwrap();
        assert!((half.w - b.w / 2.0).abs() < 0.01);
    }

    #[test]
    fn linear_codes_take_words_sizes() {
        let size = |code: &str| barcode(code).unwrap().map(|b| (b.w, b.h));
        // Code 128 of "ABC": start, 3 data, check, stop at 1.05 pt a unit with 10 units of quiet zone each side, 84 pt tall.
        let (w, h) = size(r#"DISPLAYBARCODE "ABC" CODE128"#).unwrap();
        assert!((w - (20.0 + 5.0 * 11.0 + 13.0) * 1.05).abs() < 0.01 && h == 84.0, "{w} x {h}");
        // EAN-13: 95 modules and 9 each side at 0.9506 pt (Word's 107.42 pt), its guards 1.54 pt longer.
        let (w, h) = size(r#"DISPLAYBARCODE "400638133393" EAN13"#).unwrap();
        assert!((w - 113.0 * 0.9506).abs() < 0.01 && (h - 85.54).abs() < 0.01, "{w} x {h}");
        // ITF-14 is 72 pt tall with its bearers; \h 720 makes Code 128 36 pt tall and narrower in step; \r 1 turns it.
        assert!((size(r#"DISPLAYBARCODE "1234567890123" ITF14"#).unwrap().1 - 72.0).abs() < 0.01);
        let (w36, h36) = size(r#"DISPLAYBARCODE "ABC" CODE128 \h 720"#).unwrap();
        assert!((h36 - 36.0).abs() < 0.01 && (w36 - 88.0 * 1.05 * 36.0 / 84.0).abs() < 0.01, "{w36} x {h36}");
        let (wr, hr) = size(r#"DISPLAYBARCODE "ABC" CODE128 \h 720 \r 1"#).unwrap();
        assert_eq!((wr, hr), (h36, w36));
        // A bad check digit and an unknown type give Word's errors; another field is no barcode.
        assert_eq!(size(r#"DISPLAYBARCODE "4006381333932" EAN13"#), Err(ERR_INVALID));
        assert_eq!(size(r#"DISPLAYBARCODE "1" NOPE"#), Err(ERR_PARAMS));
        assert!(barcode("PAGE").is_none());
        // The Code 128 values: "AB1234" goes B, then C for the digits.
        assert_eq!(linear::code128_values("AB1234"), Some(vec![104, 33, 34, 99, 12, 34]));
        // Japan Post: start, 20 symbols, check and stop are 67 bars.
        let (w, h) = size("DISPLAYBARCODE \"1234567 1-2-3\" JPPOST").unwrap();
        assert!((w - (66.0 * 3.608 + 1.7)).abs() < 0.01 && (h - 23.76).abs() < 0.01, "{w} x {h}");
    }
}
