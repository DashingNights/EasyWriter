// Readers shared by the chart models (model.mjs for c:chartSpace, cx.mjs for chartex): the element tree of import.mjs's parseXml
// ({name, attrs, kids}), DrawingML colours, fills and lines under the Document's theme, rich text and cached data. Pure and
// import-free.

export const kids = (n, name) => (n?.kids ?? []).filter((k) => typeof k === 'object' && (!name || k.name === name));
export const kid = (n, name) => kids(n, name)[0] ?? null;
export const deep = (n, name, out = []) => {
  for (const k of kids(n)) (k.name === name ? out.push(k) : deep(k, name, out));
  return out;
};
export const textOf = (n) => (n?.kids ?? []).map((k) => (typeof k === 'string' ? k : textOf(k))).join('');
export const at = (n, a) => n?.attrs?.[a] ?? null;
export const val = (n, name) => at(kid(n, name), 'val');
export const num = (s) => (s == null || s === '' || !Number.isFinite(+s) ? null : +s);
// A c: boolean element: present without val is true (CT_Boolean); absent is `def`.
export const on = (n, name, def = false) => {
  const e = kid(n, name);
  if (!e) return def;
  const v = at(e, 'val');
  return v == null || v === '1' || v === 'true';
};

// ---------- colours ----------
const SCHEME = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
// Office's theme (2013-2022), for a slot the Document's theme lacks.
const OFFICE = { dk1: '#000000', lt1: '#FFFFFF', dk2: '#44546A', lt2: '#E7E6E6', accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5',
  accent4: '#FFC000', accent5: '#5B9BD5', accent6: '#70AD47', hlink: '#0563C1', folHlink: '#954F72' };
const HEX = /^#[0-9A-Fa-f]{6}$/;
const PRESET = { black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF', yellow: '#FFFF00', gray: '#808080', grey: '#808080' };

const hex2 = (x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0');
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** `hex` with DrawingML modifiers `mods` ([[name, fraction]]): lumMod and lumOff in HSL, tint toward white, shade toward black. */
export function modColor(hex, mods) {
  let [r, g, b] = rgbOf(hex).map((x) => x / 255);
  for (const [m, f] of mods) {
    if (m === 'tint') [r, g, b] = [r, g, b].map((c) => c + (1 - c) * (1 - f));
    else if (m === 'shade') [r, g, b] = [r, g, b].map((c) => c * f);
    else if (m === 'lumMod' || m === 'lumOff') {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      let l = (max + min) / 2;
      const d = max - min;
      const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
      let h = 0;
      if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      l = Math.max(0, Math.min(1, m === 'lumMod' ? l * f : l + f));
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs((h % 2 + 2) % 2 - 1));
      const k = l - c / 2;
      const seg = Math.floor(((h % 6) + 6) % 6);
      [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg].map((v) => v + k);
    }
  }
  return `#${hex2(r * 255)}${hex2(g * 255)}${hex2(b * 255)}`.toUpperCase();
}

/** The colour element `c` (a:srgbClr, a:schemeClr, a:sysClr, a:prstClr) with its modifiers, `colors` the theme's, `ph` what phClr
 * stands for → '#RRGGBB' or null. */
function colorOf(c, colors, ph) {
  if (!c) return null;
  const v = at(c, 'val');
  let base = null;
  if (c.name === 'a:srgbClr') base = v && `#${v}`;
  else if (c.name === 'a:sysClr') base = at(c, 'lastClr') && `#${at(c, 'lastClr')}`;
  if (base && !HEX.test(base)) base = null; // a file's colour reaches SVG attributes: hex only
  else if (c.name === 'a:prstClr') base = PRESET[v] ?? null;
  else if (c.name === 'a:schemeClr') base = v === 'phClr' ? ph : colors[SCHEME[v] ?? v] ?? OFFICE[SCHEME[v] ?? v] ?? null;
  if (!base) return null;
  const mods = kids(c).filter((m) => /^a:(lumMod|lumOff|tint|shade)$/.test(m.name)).map((m) => [m.name.slice(2), (num(at(m, 'val')) ?? 100000) / 100000]);
  return mods.length ? modColor(base.toUpperCase(), mods) : base.toUpperCase();
}
const firstColor = (n, colors, ph) => colorOf(kids(n).find((k) => /^a:(srgbClr|schemeClr|sysClr|prstClr)$/.test(k.name)), colors, ph);
/** The fill of a:spPr-like `sp`: '#RRGGBB', 'none', or null when it names none. */
export function fillOf(sp, colors, ph) {
  if (kid(sp, 'a:noFill')) return 'none';
  if (kid(sp, 'a:solidFill')) return firstColor(kid(sp, 'a:solidFill'), colors, ph);
  if (kid(sp, 'a:gradFill')) return firstColor(kid(deep(sp, 'a:gsLst')[0], 'a:gs'), colors, ph); // ponytail: a gradient shows its first stop
  if (kid(sp, 'a:pattFill')) return firstColor(kid(kid(sp, 'a:pattFill'), 'a:fgClr'), colors, ph);
  return null;
}
/** The line of `sp`: {color ('none' when a:noFill), width (pt), dash (an a:prstDash name, null for solid)} or null when it names
 * none. */
export function lineOf(sp, colors, ph) {
  const ln = kid(sp, 'a:ln');
  if (!ln) return null;
  const color = fillOf(ln, colors, ph);
  const w = num(at(ln, 'w'));
  return color == null && w == null ? null : { color, width: w == null ? null : Math.round((w / 12700) * 100) / 100, dash: val(ln, 'a:prstDash') };
}

// Office's automatic colours for series (or points) past the sixth: the accents again, darker or lighter each round.
const ROUNDS = [[], [['lumMod', 0.6]], [['lumMod', 0.8], ['lumOff', 0.2]], [['lumMod', 0.8]], [['lumMod', 0.6], ['lumOff', 0.4]], [['lumMod', 0.5]]];
/** The automatic colour of series or point `i` under theme `colors`. */
export function autoColor(i, colors = {}) {
  const base = (colors[`accent${(i % 6) + 1}`] ?? OFFICE[`accent${(i % 6) + 1}`]).toUpperCase();
  const mods = ROUNDS[Math.floor(i / 6) % ROUNDS.length];
  return mods.length ? modColor(base, mods) : base;
}

// ---------- text ----------
/** The text of a c:title or c:tx (rich text paragraphs as lines, or a cached string), or null. */
export function richText(n) {
  const tx = kid(n, 'c:tx') ?? n;
  const rich = kid(tx, 'c:rich');
  if (rich) return kids(rich, 'a:p').map((p) => deep(p, 'a:t').map(textOf).join('')).join('\n');
  const cache = kid(kid(tx, 'c:strRef'), 'c:strCache');
  if (cache) return kids(cache, 'c:pt').map((p) => textOf(kid(p, 'c:v'))).join(' ');
  return kid(tx, 'c:v') ? textOf(kid(tx, 'c:v')) : null;
}
/** The font size (pt) of the first run property or default run property under `n`, or `def`. */
export function sizeOf(n, def) {
  const r = [...deep(n, 'a:rPr'), ...deep(n, 'a:defRPr')].find((e) => num(at(e, 'sz')));
  return r ? num(at(r, 'sz')) / 100 : def;
}

// ---------- data ----------
/** The cached points of a data reference (c:cat, c:val, c:xVal, c:yVal, c:bubbleSize) → {pts: [string | null], fmt, numeric}. */
export function cached(ref) {
  const numCache = kid(kid(ref, 'c:numRef'), 'c:numCache') ?? kid(ref, 'c:numLit');
  const multi = kid(kid(ref, 'c:multiLvlStrRef'), 'c:multiLvlStrCache');
  const cache = numCache ?? kid(kid(ref, 'c:strRef'), 'c:strCache') ?? kid(ref, 'c:strLit') ?? multi;
  if (!cache) return { pts: [], fmt: null, numeric: false };
  const pts = kids(multi ? kid(multi, 'c:lvl') : cache, 'c:pt'); // a multi-level category shows its innermost level
  const n = num(val(cache, 'c:ptCount')) ?? Math.max(0, ...pts.map((p) => (num(at(p, 'idx')) ?? 0) + 1));
  const out = Array.from({ length: n }, () => null);
  for (const p of pts) {
    const i = num(at(p, 'idx'));
    if (i != null && i < n) out[i] = textOf(kid(p, 'c:v'));
  }
  return { pts: out, fmt: kid(cache, 'c:formatCode') ? textOf(kid(cache, 'c:formatCode')) : null, numeric: !!numCache };
}

const LABEL_KEYS = { val: 'c:showVal', pct: 'c:showPercent', cat: 'c:showCatName', ser: 'c:showSerName' };
/** Which data labels c:dLbls `d` shows → {val, pct, cat, ser, pos}, false when it shows none, null when there is no `d`. */
export function labelsOf(d) {
  if (!d) return null;
  if (on(d, 'c:delete')) return false;
  const out = Object.fromEntries(Object.entries(LABEL_KEYS).map(([k, tag]) => [k, on(d, tag)]));
  return out.val || out.pct || out.cat || out.ser ? { ...out, pos: val(d, 'c:dLblPos') } : false;
}
