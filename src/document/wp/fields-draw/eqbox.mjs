// The EQ field's layout as Word draws it (docs/plans/word/briefs/eq-barcode.md): every argument at the text's own size, the
// boxes Word gives each command, and an SVG of the result. Pure: parsed EQ nodes (eq.mjs parseEq) and the font in, a box out.
//
// Lengths are in em of the field's font size, y downwards from the baseline. `font` is {a, d (the font's ascent and descent in
// em), s (its size in pt, for the switches given in points), width(text, k = 1, family = null) (em width at k times the size)}.
// The numbers are Word's, read off its PDF of the fixture (all-features.pdf pages 80 to 82, Aptos 12 pt, where A = 11.27 pt and
// D = 3.38 pt); each says where it was read. A box: {w, asc, desc, items}; items are {t: 'text', x, y, k, text, family} and
// {t: 'poly', pts: [[x, y], ...], fill}.
// ponytail: each command's room was read from one line of the fixture; Word probes at other sizes and fonts would confirm them.

const MATH_FONT = '"Cambria Math", "STIX Two Math", serif';
// Fraction: the numerator's box ends at half the ascent above the baseline, where the bar is; the denominator's starts just
// below it (\f(1,2): 1 at -9.00 pt, 2 at +5.76, bar at -5.64).
const FRAC_GAP = 0.01;
const RULE = 0.05; // the bar, box and radical strokes
// \s with neither \up nor \do raises its element a quarter em (\s\ai4(x) and \s\di4(x) drew x 3.0 pt up).
const S_RAISE = 0.25;
// Radical: the sign reaches 0.2 em over the radicand (\r(,x) grew its line by 2.76 pt above, \f(\r(,x),2) by 11.04 for
// 13.79 under the radical); with an index Word keeps 1.07 em over the ascent (\r(3,x): 12.84 pt over its two lines), the index
// drawn 0.65 em up (7.8 pt).
const RAD_OVER = 0.2;
const RAD_INDEX_ROOM = 1.07;
const RAD_INDEX_UP = 0.65;
// Brackets: the glyph at 1.21 times the content's height over a line, centred on the content (\b(x): ( at 14.52 pt, +0.84 pt);
// the box keeps the content's top and reaches a quarter em further down (\b lines: 3.0 pt below, none above).
const BRACKET_K = 1.21;
const BRACKET_BELOW = 0.25;
// Box (\x): 0.34 em above and 0.32 em below the content, whichever sides it draws (\x lines: 4.08 pt and 3.84 pt).
const BOX_ABOVE = 0.34;
const BOX_BELOW = 0.32;
const BOX_PAD = 0.15;
// Integrals (\i): the operator's box above and below the baseline, the limits stacked on it. From the lines' room with a full
// size limit atop and under it: \i 14.91 and 17.04 pt, \su and \pr 15.12 and 15.72, \fc 16.32 below, \vc 18.24 below.
const OPS = { int: [0.96, 0.48], sum: [0.98, 0.37], fixed: [0.97, 0.42], variable: [0.97, 0.58] };
// \in puts the limits to the right of the sign: the upper 0.30 em up, the lower 0.71 em down (b at -3.62 pt, a at +8.52).
const IN_UP = 0.3;
const IN_DOWN = 0.71;

const MIRROR = { '(': ')', '[': ']', '{': '}', '<': '>', '〈': '〉', ')': '(', ']': '[', '}': '{', '>': '<' };

const empty = (f) => ({ w: 0, asc: f.a, desc: f.d, items: [] });
const shift = (items, dx, dy) => items.map((it) => (it.t === 'text' ? { ...it, x: it.x + dx, y: it.y + dy } : { ...it, pts: it.pts.map(([x, y]) => [x + dx, y + dy]) }));
const line = (x1, y1, x2, y2) => ({ t: 'poly', pts: [[x1, y1], [x2, y2]] });

/** Boxes side by side on one baseline. */
function row(boxes, f) {
  if (!boxes.length) return empty(f);
  let x = 0;
  const items = [];
  for (const b of boxes) {
    items.push(...shift(b.items, x, 0));
    x += b.w;
  }
  return { w: x, asc: Math.max(...boxes.map((b) => b.asc)), desc: Math.max(...boxes.map((b) => b.desc)), items };
}

/** Rows of cells stacked and centred on half the ascent, `gap` em apart, with columns of `cols` cells aligned by `align`. */
function grid(cells, cols, align, f, { vs = 0, hs = 0 } = {}) {
  const rows = [];
  for (let k = 0; k < cells.length; k += cols) rows.push(cells.slice(k, k + cols));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(0, ...rows.map((r) => r[c]?.w ?? 0)));
  const heights = rows.map((r) => [Math.max(...r.map((b) => b.asc)), Math.max(...r.map((b) => b.desc))]);
  const H = heights.reduce((n, [a, d]) => n + a + d, 0) + vs * (rows.length - 1);
  const top = -f.a / 2 - H / 2;
  const items = [];
  let y = top;
  rows.forEach((r, i) => {
    const base = y + heights[i][0];
    let x = 0;
    r.forEach((b, c) => {
      const room = widths[c] - b.w;
      items.push(...shift(b.items, x + (align === 'left' ? 0 : align === 'right' ? room : room / 2), base));
      x += widths[c] + hs;
    });
    y = base + heights[i][1] + vs;
  });
  return { w: widths.reduce((a, b) => a + b, 0) + hs * (cols - 1), asc: -top, desc: top + H, items };
}

const ALIGN = (o) => (o.al ? 'left' : o.ar ? 'right' : 'center');

function text(s, f) {
  return { w: f.width(s), asc: f.a, desc: f.d, items: s ? [{ t: 'text', x: 0, y: 0, k: 1, text: s }] : [] };
}

/** A glyph at `k` times the size with its own baseline `y` (em), boxed by the font's ascent and descent at that size. */
function glyph(ch, k, y, f, family = null) {
  return { w: f.width(ch, k, family), asc: f.a * k - y, desc: f.d * k + y, items: [{ t: 'text', x: 0, y, k, text: ch, family }] };
}

function seq(nodes, f) {
  return row(nodes.map((n) => one(n, f)), f);
}

function one(n, f) {
  if (n.t === 'text') return text(n.s, f);
  const { c, opts: o, args } = n;
  const pt = (v) => (v ?? 0) / f.s; // a switch's points in em
  switch (c) {
    case 'f': {
      const num = seq(args[0], f);
      const den = seq(args[1], f);
      const w = Math.max(num.w, den.w) + 2 * RULE;
      const bar = -f.a / 2;
      const nb = bar - num.desc;
      const db = bar + FRAC_GAP + den.asc;
      return { w, asc: -(nb - num.asc), desc: db + den.desc, items: [...shift(num.items, (w - num.w) / 2, nb), ...shift(den.items, (w - den.w) / 2, db),
        line(0, bar, w, bar)] };
    }
    case 'a': {
      const cells = args.map((a) => seq(a, f));
      return grid(cells, Math.max(1, o.co ?? 1), ALIGN(o), f, { vs: pt(o.vs), hs: pt(o.hs) });
    }
    case 's': {
      if (args.length === 2) return grid([seq(args[0], f), seq(args[1], f)], 1, 'center', f);
      const b = seq(args[0], f);
      const up = o.up == null && o.do == null ? S_RAISE : pt(o.up) - pt(o.do);
      return { w: b.w, asc: b.asc + up + pt(o.ai), desc: b.desc - up + pt(o.di), items: shift(b.items, 0, -up) };
    }
    case 'r': {
      const rad = seq(args.at(-1), f);
      const idx = args.length === 2 && args[0].length ? seq(args[0], f) : null;
      // The sign: a short tick, a stroke down past the baseline and a long one up to the bar over the radicand.
      const top = -rad.asc - RAD_OVER + RULE;
      const lead = idx ? Math.max(0, idx.w - 0.35) : 0;
      const sw = 0.62;
      const pts = [[lead, -0.36], [lead + 0.1, -0.42], [lead + 0.28, rad.desc * 0.95], [lead + sw - 0.04, top], [lead + sw + rad.w + 0.06, top]];
      const items = [{ t: 'poly', pts }, ...shift(rad.items, lead + sw, 0)];
      let asc = rad.asc + RAD_OVER;
      if (idx) {
        items.push(...shift(idx.items, 0, -RAD_INDEX_UP));
        asc = Math.max(asc, f.a + RAD_INDEX_ROOM, RAD_INDEX_UP + idx.asc);
      }
      return { w: lead + sw + rad.w + 0.08, asc, desc: rad.desc, items };
    }
    case 'b': {
      const b = seq(args[0], f);
      let l = o.lc ?? null;
      let r = o.rc ?? null;
      if (o.bc) [l, r] = [o.bc, MIRROR[o.bc] ?? o.bc];
      if (l == null && r == null) [l, r] = ['(', ')'];
      const k = (BRACKET_K * (b.asc + b.desc)) / (f.a + f.d);
      // The bracket's middle on the content's middle.
      const y = (b.desc - b.asc) / 2 + (k * (f.a - f.d)) / 2;
      const parts = [];
      if (l != null) parts.push(glyph(l, k, y, f));
      parts.push(b);
      if (r != null) parts.push(glyph(r, k, y, f));
      const out = row(parts, f);
      return { ...out, asc: b.asc, desc: b.desc + BRACKET_BELOW };
    }
    case 'd': {
      const fo = pt(o.fo);
      const ba = pt(o.ba);
      const b = args.length ? seq(args[0], f) : { w: 0, asc: f.a, desc: f.d, items: [] };
      const items = o.li && fo ? [line(0, 0, fo, 0)] : [];
      items.push(...shift(b.items, fo - ba, 0));
      // a moves what follows back over what came before: the advance may be negative (\d a10()x drew x over "10]").
      return { w: fo - ba + b.w, asc: b.asc, desc: b.desc, items };
    }
    case 'i': {
      const [lo, hi, body] = args.map((a) => seq(a, f));
      const kind = o.fc != null ? 'fixed' : o.vc != null ? 'variable' : o.su || o.pr ? 'sum' : 'int';
      const ch = o.fc ?? o.vc ?? (o.su ? '∑' : o.pr ? '∏' : '∫');
      const family = o.fc != null || o.vc != null ? null : MATH_FONT;
      if (o.in) {
        const sign = glyph(ch, 1.4, 0.2, f, family);
        const sub = shift(lo.items, sign.w, IN_DOWN);
        const sup = shift(hi.items, sign.w, -IN_UP);
        const lim = Math.max(lo.w, hi.w);
        const out = row([{ w: sign.w + lim, asc: Math.max(sign.asc, IN_UP + hi.asc), desc: Math.max(sign.desc, IN_DOWN + lo.desc),
          items: [...sign.items, ...sub, ...sup] }, body], f);
        return out;
      }
      const [oa, od] = OPS[kind];
      const k = kind === 'sum' ? BRACKET_K : kind === 'int' ? 1.6 : 1;
      const sign = glyph(ch, k, od - f.d * k, f, family); // its descent on the operator box's bottom
      const w = Math.max(sign.w, lo.w, hi.w);
      const items = [...shift(sign.items, (w - sign.w) / 2, 0), ...shift(hi.items, (w - hi.w) / 2, -oa - hi.desc), ...shift(lo.items, (w - lo.w) / 2, od + lo.asc)];
      return row([{ w, asc: oa + hi.asc + hi.desc, desc: od + lo.asc + lo.desc, items }, body], f);
    }
    case 'l': {
      const parts = [];
      args.forEach((a, i) => {
        if (i) parts.push(text(',', f));
        parts.push(seq(a, f));
      });
      return row(parts, f);
    }
    case 'o': {
      // Every element over the others, each at the code's size as Word draws the code's text (Enclose Characters included).
      const boxes = args.map((a) => seq(a, f));
      const w = Math.max(0, ...boxes.map((b) => b.w));
      const just = (b) => (o.al ? 0 : o.ar ? w - b.w : (w - b.w) / 2);
      return { w, asc: Math.max(f.a, ...boxes.map((b) => b.asc)), desc: Math.max(f.d, ...boxes.map((b) => b.desc)),
        items: boxes.flatMap((b) => shift(b.items, just(b), 0)) };
    }
    case 'x': {
      const b = seq(args[0], f);
      const all = !o.to && !o.bo && !o.le && !o.ri;
      const w = b.w + 2 * BOX_PAD;
      const items = shift(b.items, BOX_PAD, 0);
      const t = -b.asc;
      const bt = b.desc;
      if (all || o.to) items.push(line(0, t, w, t));
      if (all || o.bo) items.push(line(0, bt, w, bt));
      if (all || o.le) items.push(line(0, t, 0, bt));
      if (all || o.ri) items.push(line(w, t, w, bt));
      return { w, asc: b.asc + BOX_ABOVE, desc: b.desc + BOX_BELOW, items };
    }
    default:
      return empty(f);
  }
}

/** The box of parsed EQ `nodes` in font `f`. */
export function eqLayout(nodes, f) {
  const b = seq(nodes, f);
  return { ...b, asc: Math.max(b.asc, f.a), desc: Math.max(b.desc, f.d) };
}

const U = 1000; // SVG units per em
const n = (x) => Math.round(x * U);
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Box `b` as an inline SVG sized in em, its baseline on the line's (the text in the element's own font and colour). */
export function eqSvg(b) {
  const h = b.asc + b.desc;
  const body = b.items.map((it) => {
    if (it.t === 'text') {
      const fam = it.family ? ` font-family='${esc(it.family)}'` : '';
      return `<text x="${n(it.x)}" y="${n(it.y)}" font-size="${n(it.k)}"${fam}>${esc(it.text)}</text>`;
    }
    return `<polyline points="${it.pts.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="none" stroke="currentColor" stroke-width="${n(RULE)}"/>`;
  }).join('');
  // Drawings left of the start (\d a) widen the picture leftwards and a negative margin keeps the advance b.w.
  const x0 = Math.min(0, b.w, ...b.items.map((it) => (it.t === 'text' ? it.x : Math.min(...it.pts.map((p) => p[0])))));
  const w = Math.max(b.w, 0) - x0;
  const margins = x0 || b.w < 0 ? `;margin-left:${x0.toFixed(3)}em;margin-right:${Math.min(b.w, 0).toFixed(3)}em` : '';
  return `<svg class="fd-eq" xmlns="http://www.w3.org/2000/svg" viewBox="${n(x0)} ${n(-b.asc)} ${Math.max(1, n(w))} ${n(h)}" ` +
    `style="width:${w.toFixed(3)}em;height:${h.toFixed(3)}em;vertical-align:${(-b.desc).toFixed(3)}em${margins}" fill="currentColor">${body}</svg>`;
}
