// DrawingML colours and shape styles (ECMA-376 Part 1 §20.1.2.3 colours and their transforms, §20.1.4.1.14 the format scheme,
// §20.1.4.2.6 style references), fills (§20.1.8: one gradient, pattern and picture fill reader and writer for Word shapes, text
// boxes and VML's translations), pictures and their effects: one resolver for Word shapes, groups, SmartArt, text boxes and
// pictures. Pure, on the element trees of import.mjs's XML reader ({name, attrs, kids}).
import { CAMERAS, cameraOf, FOV, rotationOf } from '../../tooling/rotation3d.mjs';

const kids = (n, name) => (n?.kids ?? []).filter((k) => typeof k === 'object' && (!name || k.name === name));
const kid = (n, name) => kids(n, name)[0] ?? null;
const at = (n, a) => n?.attrs?.[a] ?? null;
const num = (s) => (s == null || s === '' || Number.isNaN(+s) ? null : +s);
const on = (s) => /^(1|true|on)$/i.test(s ?? '');
/** An element ({name, attrs, kids}) as the XML reader makes them: attributes as strings (null and false left out), children flat. */
export const E = (name, attrs = {}, ...ks) => ({ name, attrs: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v != null && v !== false).map(([k, v]) => [k, String(v)])),
  kids: ks.flat().filter((k) => k != null && k !== false && k !== '') });
/** An element tree as XML text. */
export const xmlOf = (n) => {
  if (typeof n === 'string') return q(n);
  const a = Object.entries(n.attrs ?? {}).map(([k, v]) => ` ${k}="${q(v)}"`).join('');
  const inner = (n.kids ?? []).map(xmlOf).join('');
  return inner ? `<${n.name}${a}>${inner}</${n.name}>` : `<${n.name}${a}/>`;
};
const clamp = (v) => Math.min(1, Math.max(0, v));

// ---------- colours ----------
const COLOR_TAGS = new Set(['a:srgbClr', 'a:sysClr', 'a:schemeClr', 'a:prstClr', 'a:scrgbClr', 'a:hslClr']);
const SCHEME = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
// ponytail: the basic HTML colours of ST_PresetColorVal; the rest of its 140 names read as null. Add them if a file uses one.
const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', cyan: '00FFFF', magenta: 'FF00FF',
  gray: '808080', grey: '808080', silver: 'C0C0C0', maroon: '800000', olive: '808000', lime: '00FF00', navy: '000080', teal: '008080', purple: '800080',
  orange: 'FFA500', fuchsia: 'FF00FF', aqua: '00FFFF' };
const rgbHex = (h) => (/^#?[0-9a-f]{6}$/i.test(h ?? '') ? { r: parseInt(h.slice(-6, -4), 16) / 255, g: parseInt(h.slice(-4, -2), 16) / 255, b: parseInt(h.slice(-2), 16) / 255 } : null);
// A percentage: ST_Percentage in 1000ths ('50000') or a strict '50%'.
const pct = (s) => (String(s ?? '').trim().endsWith('%') ? parseFloat(s) / 100 : (num(s) ?? 0) / 100000);
// sRGB and its linear form (scRGB), through the sRGB transfer function.
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function toHsl({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}
function fromHsl({ h, s, l }) {
  if (!s) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const t = (x) => {
    const k = ((x % 1) + 1) % 1;
    return k < 1 / 6 ? p + (q - p) * 6 * k : k < 1 / 2 ? q : k < 2 / 3 ? p + (q - p) * (2 / 3 - k) * 6 : p;
  };
  const hh = h / 360;
  return { r: t(hh + 1 / 3), g: t(hh), b: t(hh - 1 / 3) };
}
const hsl = (c, f) => Object.assign(c, fromHsl(f(toHsl(c))));
const each = (c, f) => { c.r = clamp(f(c.r)); c.g = clamp(f(c.g)); c.b = clamp(f(c.b)); };

// The colour transforms, applied in the order the file lists them: the HSL ones in sRGB's HSL, tint and shade in linear RGB as
// Office does (a 10% tint is 10% of the colour and 90% white, a 10% shade 10% of it and 90% black).
const MODS = {
  'a:alpha': (c, v) => { c.a = clamp(pct(v)); },
  'a:alphaMod': (c, v) => { c.a = clamp(c.a * pct(v)); },
  'a:alphaOff': (c, v) => { c.a = clamp(c.a + pct(v)); },
  'a:lum': (c, v) => hsl(c, (x) => ({ ...x, l: clamp(pct(v)) })),
  'a:lumMod': (c, v) => hsl(c, (x) => ({ ...x, l: clamp(x.l * pct(v)) })),
  'a:lumOff': (c, v) => hsl(c, (x) => ({ ...x, l: clamp(x.l + pct(v)) })),
  'a:sat': (c, v) => hsl(c, (x) => ({ ...x, s: clamp(pct(v)) })),
  'a:satMod': (c, v) => hsl(c, (x) => ({ ...x, s: clamp(x.s * pct(v)) })),
  'a:satOff': (c, v) => hsl(c, (x) => ({ ...x, s: clamp(x.s + pct(v)) })),
  'a:hue': (c, v) => hsl(c, (x) => ({ ...x, h: ((num(v) ?? 0) / 60000) % 360 })),
  'a:hueMod': (c, v) => hsl(c, (x) => ({ ...x, h: (x.h * pct(v)) % 360 })),
  'a:hueOff': (c, v) => hsl(c, (x) => ({ ...x, h: (((x.h + (num(v) ?? 0) / 60000) % 360) + 360) % 360 })),
  'a:tint': (c, v) => each(c, (x) => gam(lin(x) * pct(v) + (1 - pct(v)))),
  'a:shade': (c, v) => each(c, (x) => gam(lin(x) * pct(v))),
  'a:comp': (c) => hsl(c, (x) => ({ ...x, h: (x.h + 180) % 360 })),
  'a:inv': (c) => each(c, (x) => 1 - x),
  'a:gray': (c) => { const y = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; c.r = c.g = c.b = y; },
};

/** The colour that `n` holds (a fill, a gradient stop, a style reference, or a colour element itself) → {r, g, b, a} (0 to 1) or
 * null. `colors`: the theme's ({dk1: '#RRGGBB', ...}); `ph`: what phClr stands for in a style reference. */
export function rgbaOf(n, colors, ph = null) {
  const c = COLOR_TAGS.has(n?.name) ? n : kids(n).find((k) => COLOR_TAGS.has(k.name));
  if (!c) return null;
  const v = at(c, 'val');
  let base = null;
  if (c.name === 'a:srgbClr') base = rgbHex(v);
  else if (c.name === 'a:sysClr') base = rgbHex(at(c, 'lastClr')) ?? (v === 'window' ? rgbHex('FFFFFF') : rgbHex('000000'));
  else if (c.name === 'a:schemeClr') base = v === 'phClr' ? ph && { ...ph } : rgbHex(colors?.[SCHEME[v] ?? v]);
  else if (c.name === 'a:prstClr') base = rgbHex(PRESET[v]);
  else if (c.name === 'a:scrgbClr') base = { r: gam(clamp(pct(at(c, 'r')))), g: gam(clamp(pct(at(c, 'g')))), b: gam(clamp(pct(at(c, 'b')))) };
  else if (c.name === 'a:hslClr') base = fromHsl({ h: (num(at(c, 'hue')) ?? 0) / 60000, s: clamp(pct(at(c, 'sat'))), l: clamp(pct(at(c, 'lum'))) });
  if (!base) return null;
  const out = { a: 1, ...base };
  for (const m of kids(c)) MODS[m.name]?.(out, at(m, 'val'));
  return out;
}

const h2 = (x) => Math.round(clamp(x) * 255).toString(16).padStart(2, '0').toUpperCase();
/** {r, g, b, a} → '#RRGGBB', or '#RRGGBBAA' below full opacity. */
export const hexOf = (c) => (c ? `#${h2(c.r)}${h2(c.g)}${h2(c.b)}${c.a < 0.999 ? h2(c.a) : ''}` : null);
/** The colour `n` holds as '#RRGGBB' ('#RRGGBBAA' when not opaque), or null. */
export const dmlColor = (n, colors, ph = null) => hexOf(rgbaOf(n, colors, ph));

// ---------- theme links ----------
// A colour the file gives as anything but a plain a:srgbClr keeps that element as data beside the colour it resolved to: a link
// {el, attrs, mods: [[name, val]], color}. While the item's colour still equals `color`, Design > Colors re-resolves a scheme
// colour (rethemeItems) and export writes the element back (colorXml); a colour the user changed no longer matches and goes out
// as itself.
const local = (name) => name.slice(name.indexOf(':') + 1);
const clrData = (c) => ({ el: local(c.name), attrs: { ...c.attrs }, mods: kids(c).map((m) => [local(m.name), at(m, 'val')]) });
const clrNode = (d) => E(`a:${d.el}`, d.attrs, ...(d.mods ?? []).map(([n, v]) => E(`a:${n}`, v == null ? {} : { val: v })));
const q = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** A colour as data (a link, or a style reference's colour) → its DrawingML element. */
export const clrXml = (d) => xmlOf(clrNode(d));
/** The link of the colour `n` holds (a fill, a stop, a reference, or the colour element), or null for an a:srgbClr that srgbXml
 * writes as it is (no transform but a:alpha). phClr takes `ph` (the style reference's link) with its own transforms after the
 * reference's. */
export function linkOf(n, ph = null) {
  const c = COLOR_TAGS.has(n?.name) ? n : kids(n).find((k) => COLOR_TAGS.has(k.name));
  if (!c) return null;
  const d = clrData(c);
  if (d.el === 'schemeClr' && d.attrs.val === 'phClr') return ph && { el: ph.el, attrs: { ...ph.attrs }, mods: [...ph.mods, ...d.mods] };
  return d.el === 'srgbClr' && d.mods.every(([m]) => m === 'alpha') ? null : d;
}
/** Link `l` resolved against theme colours `colors` → '#RRGGBB' or '#RRGGBBAA'. */
export const linkColor = (l, colors) => dmlColor(clrNode(l), colors);

/** The value at dotted `path` ('fillColor', 'gradient.stops.0.color') in `o`. */
export const pathGet = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
const pathSet = (o, [k, ...rest], v) => {
  const val = rest.length ? pathSet(o?.[k], rest, v) : v;
  return Array.isArray(o) ? Object.assign([...o], { [k]: val }) : { ...o, [k]: val };
};
const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase();
// The colour part of '#RRGGBB' or '#RRGGBBAA': a transparency the user changed leaves the colour, and so its link, as it was.
const sameRgb = (a, b) => typeof a === 'string' && typeof b === 'string' && sameHex(a.slice(0, 7), b.slice(0, 7));
/** The link of `o`'s colour at `path` (o.themeColors[path]) while that colour (`hex`, else the value at `path`) is still the one
 * it resolved to, its transparency aside; else null. */
export const heldLink = (o, path, hex = pathGet(o, path)) => { const l = o?.themeColors?.[path]; return l?.el && sameRgb(hex, l.color) ? l : null; };

// Alpha in a:alpha's thousandths of a percent: '#RRGGBBAA's byte as the whole percent that gives the same byte, as Word writes it
// (128 is 50000, not 50196), else exactly.
const ALPHA = 100000;
const byteOf = (hex) => (/^#[0-9a-f]{8}$/i.test(hex ?? '') ? parseInt(hex.slice(7), 16) : 255);
const alphaVal = (b) => { const p = Math.round(b / 2.55); return Math.round((p * 255) / 100) === b ? p * 1000 : Math.round((b / 255) * ALPHA); };
const sameByte = (a, b) => Math.round((a / ALPHA) * 255) === Math.round((b / ALPHA) * 255);
/** Colour '#RRGGBB' (or '#RRGGBBAA') as an a:srgbClr element, at `alpha` (0 to 1) when given, else at its own alpha byte. */
function srgbEl(c, alpha = null) {
  const h = String(c ?? '#000000').replace('#', '').toUpperCase();
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(h)) return E('a:srgbClr', { val: '000000' });
  const a = alpha != null ? Math.round(clamp(alpha) * ALPHA) : alphaVal(byteOf(`#${h}`));
  return E('a:srgbClr', { val: h.slice(0, 6) }, a < ALPHA && E('a:alpha', { val: a }));
}
/** `o`'s colour at `path` as a DrawingML colour element: its link's while it holds (with the transparency `hex` or `alpha` gives in
 * place of the link's own when they differ), else `hex` itself as an a:srgbClr. */
export function colorEl(o, path, hex = pathGet(o, path), alpha = null) {
  const l = heldLink(o, path, hex);
  if (!l) return srgbEl(hex, alpha);
  const want = alpha != null ? Math.round(clamp(alpha) * ALPHA) : alphaVal(byteOf(hex));
  const own = (l.mods ?? []).find(([m]) => m === 'alpha');
  if (sameByte(own ? num(own[1]) ?? ALPHA : ALPHA, want)) return clrNode(l);
  const mods = (l.mods ?? []).filter(([m]) => m !== 'alpha');
  return clrNode({ ...l, mods: want < ALPHA ? [...mods, ['alpha', String(want)]] : mods });
}
/** `o`'s colour at `path` as DrawingML text (colorEl). */
export const colorXml = (o, path, hex = pathGet(o, path), alpha = null) => xmlOf(colorEl(o, path, hex, alpha));

/** Board `items` (or any objects with themeColors, such as a picture's or a text box's attrs) with every held scheme colour link
 * re-resolved against `colors` (a theme's), the colours and links moved together → `items` itself when nothing changed. A colour
 * keeps its own transparency. */
export function rethemeItems(items, colors) {
  if (!Array.isArray(items) || !colors) return items;
  let changed = false;
  const out = items.map((it) => {
    let next = it;
    for (const [path, l] of Object.entries(it?.themeColors ?? {})) {
      if (l?.el !== 'schemeClr' || !heldLink(next, path)) continue;
      const cur = pathGet(next, path);
      const rgb = linkColor({ ...l, mods: (l.mods ?? []).filter(([m]) => m !== 'alpha') }, colors)?.slice(0, 7);
      const c = rgb && rgb + cur.slice(7);
      if (!c || sameHex(c, cur)) continue;
      next = pathSet(next, path.split('.'), c);
      next = { ...next, themeColors: { ...next.themeColors, [path]: { ...l, color: c } } };
    }
    next = withMiddle(it, next);
    changed ||= next !== it;
    return next;
  });
  return changed ? out : items;
}
// A gradient's middle colour stands in for it (a board item's fillColor, a text box's fill and gradient.color), so it moves with
// the stops a theme change re-resolved, and the gradient still holds.
function withMiddle(prev, next) {
  if (next === prev || !next.gradient?.stops?.length) return next;
  const mid = gradientMid(next.gradient.stops);
  if (heldGradient(prev)) return { ...next, fillColor: mid };
  if (typeof prev.fill === 'string' && sameHex(prev.gradient?.color, prev.fill)) return { ...next, fill: mid, gradient: { ...next.gradient, color: mid } };
  return next;
}

// ---------- style references ----------
const REFS = [['lnRef', '0'], ['fillRef', '0'], ['effectRef', '0'], ['fontRef', 'minor']];
/** A shape's style (wps:style, dsp:style) → its references as data {lnRef, fillRef, effectRef, fontRef: {idx, clr}}, or null. */
export function refsOf(style) {
  const out = {};
  for (const r of kids(style)) {
    const name = local(r.name);
    if (!REFS.some(([n]) => n === name)) continue;
    const c = kids(r).find((k) => COLOR_TAGS.has(k.name));
    out[name] = { idx: at(r, 'idx'), ...(c && { clr: clrData(c) }) };
  }
  return Object.keys(out).length ? out : null;
}
/** References as refsOf gives them → wps:style (all four, in the schema's order), or '' without any. */
export const refsXml = (refs) => (refs ? `<wps:style>${REFS.map(([n, d]) => `<a:${n} idx="${q(refs[n]?.idx ?? d)}">${refs[n]?.clr ? clrXml(refs[n].clr) : ''}</a:${n}>`).join('')}</wps:style>` : '');

// ---------- the theme's format scheme ----------
const PH = () => E('a:schemeClr', { val: 'phClr' });
const SOLID = () => E('a:solidFill', {}, PH());
const LINE = (w) => E('a:ln', { w: String(w) }, SOLID());
/** What a file without a theme part gets: Word's plain lists (solid phClr fills, 1/2, 1 and 1 1/2 pt lines, no effects). */
export const PLAIN_FMT = { fill: [SOLID(), SOLID(), SOLID()], line: [LINE(6350), LINE(12700), LINE(19050)], effect: [], bg: [SOLID(), SOLID(), SOLID()] };
/** A theme part's a:fmtScheme → its fill, line, effect and background fill style lists, the elements as they are. */
export function fmtOf(theme) {
  const f = kid(kid(theme, 'a:themeElements'), 'a:fmtScheme');
  if (!f) return PLAIN_FMT;
  return { fill: kids(kid(f, 'a:fillStyleLst')), line: kids(kid(f, 'a:lnStyleLst'), 'a:ln'), effect: kids(kid(f, 'a:effectStyleLst'), 'a:effectStyle'),
    bg: kids(kid(f, 'a:bgFillStyleLst')) };
}

// ---------- fills, lines, effects ----------
const FILLS = new Set(['a:noFill', 'a:solidFill', 'a:gradFill', 'a:pattFill', 'a:blipFill', 'a:grpFill']);
/** The fill element among `n`'s children, or null. */
export const fillEl = (n) => kids(n).find((k) => FILLS.has(k.name)) ?? null;

/** Fill element `f` → {type: 'none'} | {type: 'solid', color} | {type: 'gradient', ...gradientOf} | {type: 'pattern', prst, fg,
 * bg, links {fg, bg}, color (fg)} | {type: 'picture', rid (its picture's relationship id), tile {tx, ty, sx, sy, flip, algn} (a
 * texture) or stretch (a picture stretched to the box: a:fillRect's sides), color: null}; `grp` is what a:grpFill takes (the
 * group's fill). A solid colour and each stop carry their `link` (linkOf, phClr as `phLink`) when they have one. */
export function fillOf(f, colors, ph = null, grp = null, phLink = null) {
  const solid = (n) => { const c = dmlColor(n, colors, ph); const link = c && linkOf(n, phLink); return c ? { type: 'solid', color: c, ...(link && { link }) } : { type: 'none' }; };
  switch (f?.name) {
    case 'a:noFill': return { type: 'none' };
    case 'a:solidFill': return solid(f);
    case 'a:pattFill': {
      const [fg, bg] = [kid(f, 'a:fgClr'), kid(f, 'a:bgClr')];
      const c = dmlColor(fg, colors, ph) ?? '#000000';
      return { type: 'pattern', prst: at(f, 'prst') ?? 'pct5', fg: c, bg: dmlColor(bg, colors, ph) ?? '#FFFFFF', links: { fg: linkOf(fg, phLink), bg: linkOf(bg, phLink) }, color: c };
    }
    case 'a:blipFill': {
      const blip = kid(f, 'a:blip');
      const tile = kid(f, 'a:tile');
      const fr = kid(kid(f, 'a:stretch'), 'a:fillRect');
      return { type: 'picture', rid: at(blip, 'r:embed') ?? at(blip, 'r:link'), color: null,
        ...(tile ? { tile: Object.fromEntries(['tx', 'ty', 'sx', 'sy', 'flip', 'algn'].filter((k) => at(tile, k) != null).map((k) => [k, num(at(tile, k)) ?? at(tile, k)])) }
          : { stretch: rectOf(fr) ?? {} }) };
    }
    case 'a:grpFill': return grp ?? { type: 'none' };
    case 'a:gradFill': { const g = gradientOf(f, colors, ph, phLink); return g ? { type: 'gradient', ...g } : { type: 'none' }; }
    default: return null;
  }
}
// A rectangle's sides (a:fillToRect, a:tileRect, a:fillRect: l, t, r, b in thousandths of a percent) → fractions, or null.
const rectOf = (e) => e && Object.fromEntries(['l', 't', 'r', 'b'].filter((k) => num(at(e, k)) != null).map((k) => [k, num(at(e, k)) / ALPHA]));
const rectAttrs = (r) => Object.fromEntries(['l', 't', 'r', 'b'].map((k) => [k, Number.isFinite(r?.[k]) ? Math.round(r[k] * ALPHA) : null]));

/** a:gradFill `f` → {kind: 'linear' | 'radial', angle (degrees, 0 left to right, 90 top to bottom), stops [{pos 0 to 1, color, link?}],
 * color (the colour at the middle), and where the file differs from what gradFillEl writes by default: scaled (a:lin's, when on),
 * path (a:path's rect or shape; circle is the default), focus (its a:fillToRect, when not the middle), tile (a:tileRect, {} when
 * empty), flip and rotWithShape (when off)}, or null without stops. One reader for Word shapes, text boxes and VML's gradients
 * (vml.mjs translates them into a:gradFill). */
export function gradientOf(f, colors, ph = null, phLink = null) {
  const stops = kids(kid(f, 'a:gsLst'), 'a:gs').map((g) => ({ pos: clamp(pct(at(g, 'pos'))), c: rgbaOf(g, colors, ph), link: linkOf(g, phLink) })).filter((s) => s.c).sort((a, b) => a.pos - b.pos);
  if (!stops.length) return null;
  const lin = kid(f, 'a:lin');
  const path = kid(f, 'a:path');
  const focus = rectOf(kid(path, 'a:fillToRect'));
  const tile = kid(f, 'a:tileRect');
  return { kind: path ? 'radial' : 'linear', angle: lin ? (num(at(lin, 'ang')) ?? 0) / 60000 : 90,
    stops: stops.map((s) => ({ pos: r5(s.pos), color: hexOf(s.c), ...(s.link && { link: s.link }) })), color: hexOf(colorAt(stops, 0.5)),
    ...(on(at(lin, 'scaled')) && { scaled: true }), ...(path && at(path, 'path') && at(path, 'path') !== 'circle' && { path: at(path, 'path') }),
    ...(focus && ['l', 't', 'r', 'b'].some((k) => focus[k] !== 0.5) && { focus }), ...(tile && { tile: rectOf(tile) }),
    ...(at(f, 'flip') != null && { flip: at(f, 'flip') }), ...(at(f, 'rotWithShape') != null && !on(at(f, 'rotWithShape')) && { rotWithShape: false }) };
}
/** The middle colour of stops [{pos, color '#RRGGBB(AA)'}] as '#RRGGBB' or '#RRGGBBAA'. */
export const gradientMid = (stops) => hexOf(colorAt(stops.map((s) => ({ pos: s.pos, c: rgbaOf(srgbEl(s.color)) })).filter((s) => s.c), 0.5));
// A board item's Word fill holds while its fillColor is still the colour that fill shows as (its gradient's middle, its pattern's
// foreground): a colour picked by any tool replaces it, so it is neither drawn nor written any more.
// The import worked the middle out from unrounded stop colours: within 2 of 255 a channel is the same colour.
const nearRgb = (a, b) => { const [x, y] = [rgbHex(String(a).slice(0, 7)), rgbHex(String(b).slice(0, 7))]; return !!x && !!y && ['r', 'g', 'b'].every((k) => Math.abs(x[k] - y[k]) <= 2 / 255); };
/** Board item `it`'s gradient while it holds, else null. */
export const heldGradient = (it) => (it?.fill === 'solid' && it.gradient?.stops?.length && nearRgb(gradientMid(it.gradient.stops), it.fillColor) ? it.gradient : null);
/** Board item `it`'s Word pattern ({prst, fg, bg}) while it holds, else null. */
export const heldPattern = (it) => (it?.fill === 'solid' && it.pattern?.prst && sameRgb(it.pattern.fg, it.fillColor) ? it.pattern : null);

/** `o`'s gradient at `base` ({kind, angle, stops, scaled, path, focus, tile, flip, rotWithShape} as gradientOf reads it) as an
 * a:gradFill element, each stop's colour through its theme link while that holds (colorEl at `${base}.stops.N.color`). A
 * radial one without a path is Word's From Center (a circle from the middle); a linear one is scaled when the file said so. */
export function gradFillEl(o, base = 'gradient') {
  const g = pathGet(o, base);
  const shade = g.kind === 'radial' || g.path ? E('a:path', { path: g.path ?? 'circle' }, E('a:fillToRect', rectAttrs(g.focus ?? { l: 0.5, t: 0.5, r: 0.5, b: 0.5 })))
    : E('a:lin', { ang: Math.round(((((g.angle ?? 90) % 360) + 360) % 360) * 60000), scaled: g.scaled ? 1 : 0 });
  return E('a:gradFill', { flip: g.flip ?? null, rotWithShape: g.rotWithShape === false ? 0 : 1 },
    E('a:gsLst', {}, g.stops.map((s, i) => E('a:gs', { pos: Math.round(s.pos * ALPHA) }, colorEl(o, `${base}.stops.${i}.color`)))), shade, g.tile && E('a:tileRect', rectAttrs(g.tile)));
}
/** `o`'s pattern at `base` ({prst, fg, bg}) as an a:pattFill element, its colours through their links (`${base}.fg`, `${base}.bg`). */
export const pattFillEl = (o, base) => {
  const p = pathGet(o, base);
  return E('a:pattFill', { prst: p.pattern ?? p.prst ?? 'pct5' }, E('a:fgClr', {}, colorEl(o, `${base}.fg`, p.fg ?? '#000000')), E('a:bgClr', {}, colorEl(o, `${base}.bg`, p.bg ?? '#FFFFFF')));
};
/** A picture fill: relationship id `rid` of its picture, tiled as `tile` says (a texture; Word's default tile when `tile` is true)
 * or stretched over the box (`stretch`, a:fillRect's sides) → a:blipFill. */
export const blipFillEl = (rid, { tile = null, stretch = null } = {}) => E('a:blipFill', {}, E('a:blip', { 'r:embed': rid }),
  tile ? E('a:tile', tile === true ? { tx: 0, ty: 0, sx: ALPHA, sy: ALPHA, flip: 'none', algn: 'tl' } : tile) : E('a:stretch', {}, E('a:fillRect', rectAttrs(stretch))));
/** The colour at `pos` along sorted stops [{pos, c}]. */
function colorAt(stops, pos) {
  const j = stops.findIndex((s) => s.pos >= pos);
  if (j <= 0) return stops[j === 0 ? 0 : stops.length - 1].c;
  const [a, b] = [stops[j - 1], stops[j]];
  const t = b.pos === a.pos ? 0 : (pos - a.pos) / (b.pos - a.pos);
  const mix = (k) => a.c[k] + (b.c[k] - a.c[k]) * t;
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: mix('a') };
}

const END = { none: 'none', triangle: 'triangle', stealth: 'stealth', diamond: 'diamond', oval: 'oval', arrow: 'arrow' };
/** Line `ln` (a:ln) over the style's line `base` (the theme's a:ln for lnRef, its phClr as `ph`) → {fill, width (EMU), dash,
 * cap, head, tail} or null when no line is drawn. The shape's own a:ln wins attribute by attribute and element by element.
 * `basePhLink` is the link phClr takes in `base`. */
export function lineOf(ln, base, colors, ph = null, basePh = null, basePhLink = null) {
  if (!ln && !base) return null;
  const pick = (name) => kid(ln, name) ?? kid(base, name);
  const fe = fillEl(ln) ?? fillEl(base);
  const fill = fe ? fillOf(fe, colors, fillEl(ln) ? ph : basePh, null, fillEl(ln) ? null : basePhLink) : { type: 'none' };
  if (fill.type === 'none' || !fill.color) return null; // ponytail: a picture line draws as none
  const end = (name) => {
    const e = pick(name);
    const t = END[at(e, 'type')];
    return t && t !== 'none' ? { type: t, w: at(e, 'w') ?? 'med', len: at(e, 'len') ?? 'med' } : null;
  };
  return { fill, width: num(at(ln, 'w')) ?? num(at(base, 'w')) ?? 9525, dash: at(pick('a:prstDash'), 'val') ?? (pick('a:custDash') ? 'dash' : 'solid'),
    cap: at(ln, 'cap') ?? at(base, 'cap') ?? null, head: end('a:headEnd'), tail: end('a:tailEnd') };
}

/** An a:effectLst → its outer shadow as {color, alpha, blur, dist (pt), angle (degrees)}, or null. */
export function shadowOf(list, colors, ph = null) {
  const s = kid(list, 'a:outerShdw');
  if (!s) return null;
  const c = rgbaOf(s, colors, ph) ?? { r: 0, g: 0, b: 0, a: 1 };
  const pt = (k) => Math.round(((num(at(s, k)) ?? 0) / 12700) * 100) / 100;
  return { color: hexOf({ ...c, a: 1 }), alpha: Math.round(c.a * 100) / 100, blur: pt('blurRad'), dist: pt('dist'), angle: (num(at(s, 'dir')) ?? 0) / 60000 };
}

/** A shape's look from its shape properties `sp` (wps:spPr, dsp:spPr, pic:spPr) over its style `style` (wps:style), with
 * `ctx` {colors, fmt (fmtOf), fonts {major, minor}} and the enclosing group's fill `grp` → {fill, line, shadow, font {face,
 * color} | null, links {shadow, font} (their colours' links), refs (refsOf)}. A property the shape leaves out comes from its
 * style's reference into the theme's lists, with phClr the reference's colour; without a style it is none. The fill's and the
 * line fill's links ride in those objects (fillOf). */
export function shapeLook(sp, style, ctx, grp = null) {
  const { colors, fmt = PLAIN_FMT, fonts } = ctx;
  const ref = (name) => kid(style, name);
  const idx = (name) => num(at(ref(name), 'idx')) ?? 0;
  const phOf = (name) => rgbaOf(ref(name), colors);
  const phLink = (name) => linkOf(ref(name));
  const own = fillEl(sp);
  let fill = own ? fillOf(own, colors, null, grp) : null;
  if (!fill) {
    const i = idx('a:fillRef');
    const entry = i >= 1001 ? fmt.bg[i - 1001] : i > 0 ? fmt.fill[i - 1] : null;
    fill = entry ? fillOf(entry, colors, phOf('a:fillRef'), grp, phLink('a:fillRef')) ?? { type: 'none' } : { type: 'none' };
    if (fill.type === 'picture') fill = { type: 'none' }; // its picture is the theme part's, not this part's
  }
  const li = idx('a:lnRef');
  const line = lineOf(kid(sp, 'a:ln'), li > 0 ? fmt.line[li - 1] ?? null : null, colors, null, phOf('a:lnRef'), phLink('a:lnRef'));
  const ei = idx('a:effectRef');
  const fx = kid(sp, 'a:effectLst');
  const list = fx ?? (ei > 0 ? kid(fmt.effect[ei - 1], 'a:effectLst') : null);
  const shadow = list ? shadowOf(list, colors, fx ? null : phOf('a:effectRef')) : null;
  const fr = ref('a:fontRef');
  const font = fr ? { face: { major: fonts?.major, minor: fonts?.minor }[at(fr, 'idx')] ?? null, color: dmlColor(fr, colors) } : null;
  const links = { shadow: shadow && linkOf(kid(list, 'a:outerShdw'), fx ? null : phLink('a:effectRef')), font: fr && linkOf(fr) };
  return { fill, line, shadow, font, links, refs: refsOf(style) };
}

// ---------- what a shape keeps of what it hides ----------
const HIDDEN = { '{909E8E84-426E-40DD-AFC4-6F175D3DCCD1}': 'fill', '{91240B29-F687-4F45-9708-019B960494DF}': 'line' };
/** What Word keeps of a fill and a line the user turned off (No Fill, No Outline), from shape properties `sp`: the line element
 * itself (its width and dashes beside a:noFill) and a14:hiddenFill and a14:hiddenLine from its a:extLst → {ln, fill, line} as XML
 * text, or null. Export writes each back while the shape still has no fill or no line (hiddenXml). */
export function hiddenOf(sp) {
  const out = {};
  const ln = kid(sp, 'a:ln');
  const NONE = '<a:ln><a:noFill/></a:ln>'; // what export writes anyway
  if (fillEl(ln)?.name === 'a:noFill' && xmlOf(ln) !== NONE) out.ln = xmlOf(ln);
  for (const e of kids(kid(sp, 'a:extLst'), 'a:ext')) if (HIDDEN[at(e, 'uri')]) out[HIDDEN[at(e, 'uri')]] = xmlOf(e);
  return Object.keys(out).length ? out : null;
}
/** A shape's line when it has none (its kept a:ln, else a plain one), and the a:extLst of what it hides: `hidden` (hiddenOf), with
 * `fill` and `line` whether the shape has them → {ln, ext}. */
export function hiddenXml(hidden, { fill, line }) {
  const ext = [!fill && hidden?.fill, !line && hidden?.line].filter(Boolean).join('');
  return { ln: hidden?.ln ?? '<a:ln><a:noFill/></a:ln>', ext: ext ? `<a:extLst>${ext}</a:extLst>` : '' };
}

// The links among `links` (path → link or null) whose colour at that path in `o` is a colour, with that colour → themeColors or null.
function heldOf(o, links) {
  const held = {};
  for (const [p, l] of Object.entries(links)) {
    const v = pathGet(o, p);
    if (l && /^#[0-9A-F]{6}([0-9A-F]{2})?$/i.test(v ?? '')) held[p] = { ...l, color: v };
  }
  return Object.keys(held).length ? held : null;
}

// ---------- pictures ----------
const share = (s, d = 0) => (num(s) ?? d) / 100000;
const pt = (v, d = 0) => Math.round(((num(v) ?? d) / 12700) * 100) / 100;
const r5 = (n) => Math.round(n * 100000) / 100000;
const r2 = (n) => Math.round(n * 100) / 100;
// An angle in 60000ths of a degree → degrees in (-180, 180].
const deg = (v) => { const d = (((num(v) ?? 0) / 60000) % 360 + 360) % 360; return d > 180 ? r5(d - 360) : r5(d); };
/** A colour element's holder `n` → {color '#RRGGBB', transparency 0 to 1}, black when it names none. */
const tone = (n, colors) => { const c = rgbaOf(n, colors) ?? { r: 0, g: 0, b: 0, a: 1 }; return { color: hexOf({ ...c, a: 1 }), transparency: r5(1 - c.a) }; };

const SVG_EXT = '{96DAC541-7B7A-43D3-8B79-37D633B846F1}';
/** A short key of a picture's data URL (its length and FNV-1a hash), so a kept fallback knows the SVG it was drawn from. */
export function svgKey(src) {
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i += 1) h = Math.imul(h ^ src.charCodeAt(i), 0x01000193);
  return `${src.length}:${(h >>> 0).toString(16)}`;
}
/**
 * What a picture's a:blip shows, through `picture(rid)` → a data URL or null: an SVG that Word stores beside its PNG (a:extLst's
 * asvg:svgBlip) is the picture, and the PNG its fallback, kept with the key of the SVG it shows ({src, of}) → {src, fallback?}, or
 * null when nothing can be read.
 */
export function pictureSource(blip, picture) {
  const own = picture(at(blip, 'r:embed') ?? at(blip, 'r:link'));
  const ext = kids(kid(blip, 'a:extLst'), 'a:ext').find((e) => at(e, 'uri') === SVG_EXT);
  const svgBlip = kids(ext).find((k) => local(k.name) === 'svgBlip');
  const svg = svgBlip && picture(at(svgBlip, 'r:embed') ?? at(svgBlip, 'r:link'));
  if (!/^data:image\/svg\+xml/.test(svg ?? '')) return own ? { src: own } : null;
  return { src: svg, ...(own && { fallback: { src: own, of: svgKey(svg) } }) };
}
/** An image's (or board picture's) kept fallback while it still belongs to its SVG `src` → the fallback's src, else null: a
 * recoloured or changed picture needs a new one. */
export const heldFallback = (a) => (a?.fallback?.src && /^data:image\/svg\+xml/.test(a.src ?? '') && a.fallback.of === svgKey(a.src) ? a.fallback.src : null);

/**
 * A picture (pic:pic) → its look in the image node's terms (model/attrs.js IMAGE_ATTRS_V2; lengths in pt, shares 0 to 1): crop from
 * a:srcRect and the crop shape from pic:spPr's preset, border from a:ln (No Outline as color 'none'), adjust from the blip effects
 * Word draws live (ECMA-376 §20.1.8: alphaModFix, lum, grayscl, biLevel, duotone, clrChange), effects from a:effectLst, a:sp3d's
 * bevel and a:scene3d's camera; cstate, Word's record of how the picture was compressed; themeColors, the links of the border's,
 * the recolour's, the shadow's and the glow's colours (dml.mjs links), which Design > Colors re-resolves and export writes back.
 * Word's own corrections and colour (a14:imgEffect) are baked into the blip's pixels, so they are not read again. A duotone runs
 * from its first colour to its second: black to a colour is the 'dark' recolor, a colour to white the 'light' one (pictures.mjs
 * filterSvg); any other pair reads as dark to its second colour.
 */
export function pictureLook(pic, colors) {
  const bf = kid(pic, 'pic:blipFill');
  const blip = kid(bf, 'a:blip');
  const sp = kid(pic, 'pic:spPr');
  const out = {};
  const links = {};
  const sr = kid(bf, 'a:srcRect');
  const shape = at(kid(sp, 'a:prstGeom'), 'prst');
  const sides = Object.fromEntries(['t', 'r', 'b', 'l'].map((k) => [k, share(at(sr, k))]));
  const cut = Object.values(sides).some(Boolean);
  if (cut || (shape && shape !== 'rect')) out.crop = { ...(cut && sides), ...(shape && shape !== 'rect' && { shape }) };
  const ln = kid(sp, 'a:ln');
  const line = ln && lineOf(ln, null, colors);
  const dash = at(kid(ln, 'a:prstDash'), 'val');
  if (line) out.border = { color: line.fill.color, width: pt(line.width), ...(dash && { dash }) };
  else if (fillEl(ln)?.name === 'a:noFill') out.border = { color: 'none' };
  links['border.color'] = line?.fill.link;

  const adjust = {};
  for (const e of kids(blip)) {
    switch (e.name) {
      case 'a:alphaModFix': if (share(at(e, 'amt'), 100000) < 1) adjust.transparency = r5(1 - share(at(e, 'amt'), 100000)); break;
      case 'a:lum': {
        const [b, c] = [share(at(e, 'bright')), share(at(e, 'contrast'))];
        if (b === 0.7 && c === -0.7) adjust.recolor = { kind: 'washout' }; // Word's Washout
        else Object.assign(adjust, b && { brightness: b }, c && { contrast: c });
        break;
      }
      case 'a:grayscl': adjust.recolor = { kind: 'grayscale' }; break;
      case 'a:biLevel': adjust.recolor = { kind: 'bw', threshold: share(at(e, 'thresh'), 50000) }; break;
      case 'a:duotone': {
        const cs = kids(e).filter((k) => COLOR_TAGS.has(k.name));
        const [c1, c2] = cs.map((k) => tone(k, colors).color);
        const light = c2 === '#FFFFFF';
        adjust.recolor = light ? { kind: 'light', color: c1 } : { kind: 'dark', color: c2 ?? c1 };
        links['adjust.recolor.color'] = linkOf(cs[light ? 0 : cs.length - 1]);
        break;
      }
      case 'a:clrChange': if (rgbaOf(kid(e, 'a:clrTo'), colors)?.a === 0) adjust.transparentColor = tone(kid(e, 'a:clrFrom'), colors).color; break;
      default: break;
    }
  }
  if (Object.keys(adjust).length) out.adjust = adjust;
  const fx = effectsOf(sp, colors);
  if (fx) out.effects = fx;
  const list = kid(sp, 'a:effectLst');
  links['effects.shadow.color'] = linkOf(kid(list, 'a:outerShdw') ?? kid(list, 'a:innerShdw'));
  links['effects.glow.color'] = linkOf(kid(list, 'a:glow'));
  const held = heldOf(out, links);
  if (held) out.themeColors = held;
  if (at(blip, 'cstate')) out.cstate = at(blip, 'cstate');
  return out;
}

/** Shape properties `sp` (pic:spPr, wps:spPr) → effects in the picture model's terms {shadow {kind, color, transparency, size, blur,
 * angle, distance}, glow {size, color, transparency}, reflection {size, distance, transparency, blur}, softEdge, bevel {kind, width,
 * height}, rotation3d {x, y, z, perspective, camera?}} (lengths in pt, angles in degrees), from a:effectLst, a:sp3d and a:scene3d;
 * or null. A preset camera without its own a:rot turns by the preset's angles (src/tooling/rotation3d.mjs) and keeps its name, so
 * export writes the preset back; the plain front cameras are no rotation of their own. */
export function effectsOf(sp, colors) {
  const fx = {};
  const list = kid(sp, 'a:effectLst');
  const sh = kid(list, 'a:outerShdw') ?? kid(list, 'a:innerShdw');
  if (sh) {
    const [sx, sy] = [share(at(sh, 'sx'), 100000), share(at(sh, 'sy'), 100000)];
    const kind = sh.name === 'a:innerShdw' ? 'inner' : num(at(sh, 'kx')) || num(at(sh, 'ky')) || sx !== sy ? 'perspective' : 'outer';
    fx.shadow = { kind, ...tone(sh, colors), ...(kind !== 'inner' && { size: sx }), blur: pt(at(sh, 'blurRad')), angle: r5((((num(at(sh, 'dir')) ?? 0) / 60000) % 360 + 360) % 360), distance: pt(at(sh, 'dist')) };
  }
  const glow = kid(list, 'a:glow');
  if (glow) fx.glow = { size: pt(at(glow, 'rad')), ...tone(glow, colors) };
  const rf = kid(list, 'a:reflection');
  if (rf) fx.reflection = { size: share(at(rf, 'endPos'), 100000), distance: pt(at(rf, 'dist')), transparency: r5(1 - share(at(rf, 'stA'), 100000)), blur: pt(at(rf, 'blurRad')) };
  const soft = kid(list, 'a:softEdge');
  if (soft) fx.softEdge = pt(at(soft, 'rad'));
  const bevel = kid(kid(sp, 'a:sp3d'), 'a:bevelT');
  if (bevel) fx.bevel = { kind: at(bevel, 'prst') ?? 'circle', width: pt(at(bevel, 'w'), 76200), height: pt(at(bevel, 'h'), 76200) };
  // Word's X and Z rotations turn the other way from the camera's longitude and revolution.
  const cam = kid(kid(sp, 'a:scene3d'), 'a:camera');
  const prst = at(cam, 'prst') ?? '';
  const rot = kid(cam, 'a:rot');
  const perspective = /^perspective/.test(prst) ? (num(at(cam, 'fov')) ?? FOV * 60000) / 60000 : 0;
  const named = CAMERAS[prst] && !/^(orthographic|perspective)Front$/.test(prst) ? { camera: prst } : {};
  if (rot) {
    fx.rotation3d = { x: r5(-deg(at(rot, 'lon'))) || 0, y: deg(at(rot, 'lat')), z: r5(-deg(at(rot, 'rev'))) || 0, perspective, ...named };
  } else if (CAMERAS[prst] && prst !== 'orthographicFront') {
    const { x, y, z } = CAMERAS[prst];
    fx.rotation3d = { x, y, z, perspective, camera: prst };
  }
  return Object.keys(fx).length ? fx : null;
}

const thou = (v) => Math.round(v * 100000);
const emu = (v) => Math.round(v * 12700);
const ang = (v) => Math.round(((((v % 360) + 360) % 360) * 60000)) % 21600000;
const attrsXml = (o) => Object.entries(o).filter(([, v]) => v != null && v !== false).map(([k, v]) => ` ${k}="${v}"`).join('');
const word = (s, d) => (/^\w+$/.test(s ?? '') ? s : d);
// The corner Word aligns an outer shadow to: the one its direction points away from.
const ALIGN = ['l', 'tl', 't', 'tr', 'r', 'br', 'b', 'bl'];
const SEPIA = '<a:duotone><a:prstClr val="black"/><a:srgbClr val="D9C3A5"><a:tint val="50000"/><a:satMod val="180000"/></a:srgbClr></a:duotone>'; // Word's Sepia

/** Image attrs `a` → the DrawingML pictureLook reads back: {blip (a:blip's children), blipAttrs (its cstate), crop (a:srcRect),
 * geom (a:prstGeom), sp (a:ln, a:effectLst, a:scene3d and a:sp3d, in pic:spPr's order)}. `svg`: the relationship id of the SVG
 * the picture shows when a:blip is its fallback (asvg:svgBlip). Colours go out through their links while they hold (colorEl), and
 * a recolour's black or white end as Word's preset colour. Missing shares and lengths take the defaults pictures.mjs draws with. */
export function pictureXml(a, { svg = null } = {}) {
  const d = a.adjust ?? {};
  const rc = d.recolor;
  const tint = rc?.color && colorXml(a, 'adjust.recolor.color', rc.color);
  const blip = [
    d.transparentColor && `<a:clrChange><a:clrFrom>${srgbXml(d.transparentColor)}</a:clrFrom><a:clrTo>${xmlOf(srgbEl(d.transparentColor, 0))}</a:clrTo></a:clrChange>`,
    { grayscale: '<a:grayscl/>', washout: '<a:lum bright="70000" contrast="-70000"/>', sepia: SEPIA, bw: `<a:biLevel thresh="${thou(rc?.threshold ?? 0.5)}"/>` }[rc?.kind],
    tint && rc.kind === 'dark' && `<a:duotone><a:prstClr val="black"/>${tint}</a:duotone>`,
    tint && rc.kind === 'light' && `<a:duotone>${tint}<a:prstClr val="white"/></a:duotone>`,
    (d.brightness || d.contrast) && `<a:lum${attrsXml({ bright: d.brightness ? thou(d.brightness) : null, contrast: d.contrast ? thou(d.contrast) : null })}/>`,
    d.transparency > 0 && `<a:alphaModFix amt="${thou(1 - Math.min(1, d.transparency))}"/>`,
    svg && `<a:extLst><a:ext uri="${SVG_EXT}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${q(svg)}"/></a:ext></a:extLst>`,
  ].filter(Boolean).join('');
  const c = a.crop ?? {};
  const sides = attrsXml(Object.fromEntries(['l', 't', 'r', 'b'].map((k) => [k, c[k] ? thou(c[k]) : null])));
  const b = a.border;
  const line = !b ? '' : b.color === 'none' ? '<a:ln><a:noFill/></a:ln>'
    : `<a:ln w="${emu(b.width ?? 0.75)}"><a:solidFill>${colorXml(a, 'border.color', b.color ?? '#000000')}</a:solidFill>${b.dash ? `<a:prstDash val="${word(b.dash, 'solid')}"/>` : ''}</a:ln>`;
  return { blip, blipAttrs: { cstate: word(a.cstate, null) }, crop: sides ? `<a:srcRect${sides}/>` : '', geom: `<a:prstGeom prst="${word(c.shape, 'rect')}"><a:avLst/></a:prstGeom>`,
    sp: line + effectsXml(a.effects, a) };
}

/** Effects in effectsOf's terms → a:effectLst, a:scene3d and a:sp3d (spPr's order), or ''. `owner` holds them at `base` with its
 * colours' links (themeColors), which the shadow and the glow go out through while they hold. A rotation keeps its preset camera
 * while its angles are the preset's (src/tooling/rotation3d.mjs cameraOf), else turns the front camera by its own angles. Missing
 * values take the defaults pictures.mjs draws with. */
export function effectsXml(e = {}, owner = null, base = 'effects') {
  if (!e) return '';
  const s = e.shadow;
  const shadow = s && (() => {
    const inner = s.kind === 'inner';
    const angle = s.angle ?? 45;
    const size = !inner && s.size != null && s.size !== 1 ? thou(s.size) : null;
    const o = { blurRad: s.blur ? emu(s.blur) : null, dist: s.distance ? emu(s.distance) : null, dir: ang(angle) || null, sx: size, sy: size,
      algn: inner ? null : s.distance || ang(angle) ? ALIGN[Math.round((((angle % 360) + 360) % 360) / 45) % 8] : 'ctr' };
    return `<a:${inner ? 'innerShdw' : 'outerShdw'}${attrsXml(o)}>${colorXml(owner, `${base}.shadow.color`, s.color ?? '#000000', 1 - (s.transparency ?? 0.6))}</a:${inner ? 'innerShdw' : 'outerShdw'}>`;
  })();
  const g = e.glow;
  const r = e.reflection;
  const rt = r?.transparency ?? 0.5;
  const fx = [
    g && `<a:glow rad="${emu(g.size ?? 0)}">${colorXml(owner, `${base}.glow.color`, g.color ?? '#156082', 1 - (g.transparency ?? 0.4))}</a:glow>`, shadow,
    r && `<a:reflection${attrsXml({ blurRad: r.blur ? emu(r.blur) : null, stA: rt ? thou(1 - rt) : null, endA: 300,
      endPos: (r.size ?? 0.5) < 1 ? thou(r.size ?? 0.5) : null, dist: r.distance ? emu(r.distance) : null, dir: 5400000, sy: -100000, algn: 'bl', rotWithShape: 0 })}/>`,
    e.softEdge > 0 && `<a:softEdge rad="${emu(e.softEdge)}"/>`,
  ].filter(Boolean).join('');
  const t = rotationOf(e.rotation3d);
  const bv = e.bevel;
  const cam = t ? cameraOf(t) : { camera: 'orthographicFront', rot: false };
  const fov = t?.perspective > 0 && Math.abs(t.perspective - FOV) > 0.01 ? ` fov="${Math.round(t.perspective * 60000)}"` : '';
  const rot = cam.rot ? `<a:rot lat="${ang(t.y ?? 0)}" lon="${ang(-(t.x ?? 0))}" rev="${ang(-(t.z ?? 0))}"/>` : '';
  const scene = (t || bv) && `<a:scene3d><a:camera prst="${cam.camera}"${fov}${rot ? `>${rot}</a:camera>` : '/>'}`
    + '<a:lightRig rig="threePt" dir="t"/></a:scene3d>';
  const sp3d = bv && `<a:sp3d><a:bevelT${attrsXml({ w: (bv.width ?? 6) !== 6 ? emu(bv.width ?? 6) : null, h: (bv.height ?? 6) !== 6 ? emu(bv.height ?? 6) : null,
    prst: bv.kind && bv.kind !== 'circle' ? word(bv.kind, null) : null })}/></a:sp3d>`;
  return (fx ? `<a:effectLst>${fx}</a:effectLst>` : '') + (scene || '') + (sp3d || '');
}

// ---------- text boxes ----------
/**
 * A text box's look (wps:spPr `sp` over wps:style `style`, shapeLook's `ctx`; `picture(rid)` → a data URL) in the textBox node's
 * terms (model/nodes.js TEXTBOX_DEFAULTS; lengths in pt): fill a colour, or a pattern, texture or picture fill in Fill Effects'
 * terms (page-background/model.mjs fillCss draws them); a gradient keeps Word's whole a:gradFill (gradientOf) with fill its middle
 * colour; line; effects in the terms textbox/boxes.mjs draws (opacities, a reflection's size in percent, bevel {type, w, h},
 * rotation3d as effectsOf reads it); themeColors (the colours' links), styleRefs (wps:style) and hidden (hiddenOf), which export
 * writes back.
 */
export function boxLook(sp, style, ctx, picture = () => null) {
  const look = shapeLook(sp, style, ctx);
  const f = look.fill;
  const links = {};
  let fill = null;
  let gradient = null;
  if (f.type === 'solid') [fill, links.fill] = [f.color, f.link];
  else if (f.type === 'gradient') {
    const { type, stops, ...g } = f;
    gradient = { ...g, stops: stops.map(({ pos, color }) => ({ pos, color })) };
    fill = f.color;
    stops.forEach((s, i) => { links[`gradient.stops.${i}.color`] = s.link; });
  } else if (f.type === 'pattern') {
    fill = { kind: 'pattern', pattern: f.prst, fg: f.fg, bg: f.bg };
    Object.assign(links, { 'fill.fg': f.links.fg, 'fill.bg': f.links.bg });
  } else if (f.type === 'picture') {
    const src = f.rid && picture(f.rid);
    if (src) fill = f.tile ? { kind: 'texture', src, tile: f.tile } : { kind: 'picture', src, ...(Object.keys(f.stretch ?? {}).length && { stretch: f.stretch }) };
  }
  const ln = look.line;
  links['line.color'] = ln?.fill.link;
  const fx = effectsOf(sp, ctx.colors) ?? {};
  const list = kid(sp, 'a:effectLst');
  const effects = Object.fromEntries(Object.entries({ shadow: look.shadow, glow: fx.glow && { color: fx.glow.color, size: fx.glow.size, alpha: r2(1 - fx.glow.transparency) },
    reflection: fx.reflection && { size: r2(fx.reflection.size * 100), dist: fx.reflection.distance, alpha: r2(1 - fx.reflection.transparency) },
    softEdges: fx.softEdge && { size: fx.softEdge }, bevel: fx.bevel && { type: fx.bevel.kind, w: fx.bevel.width, h: fx.bevel.height },
    rotation3d: fx.rotation3d }).filter(([, v]) => v));
  Object.assign(links, { 'effects.shadow.color': look.links.shadow, 'effects.glow.color': linkOf(kid(list, 'a:glow')) });
  const out = { fill, ...(gradient && { gradient }), line: ln ? { color: ln.fill.color, width: pt(ln.width), dash: ln.dash } : null,
    ...(Object.keys(effects).length && { effects }) };
  const held = heldOf(out, links);
  const hidden = hiddenOf(sp);
  return { ...out, ...(held && { themeColors: held }), ...(look.refs && { styleRefs: look.refs }), ...(hidden && { hidden }) };
}

/** Text box attrs `a` → wps:spPr's fill, line, effects and the a:extLst of what it hides, in spPr's order (boxLook read back).
 * `rid`: the relationship id of a texture or picture fill's picture. A gradient goes out while fill is still its middle colour (a
 * fill the Shape Fill tool set replaces it); colours go out through their links while they hold. */
export function boxSpXml(a, rid = null) {
  const f = a.fill;
  const grad = a.gradient?.stops?.length && sameHex(a.gradient.color, typeof f === 'string' ? f : null);
  const fill = grad ? xmlOf(gradFillEl(a))
    : typeof f === 'string' && f !== 'none' ? `<a:solidFill>${colorXml(a, 'fill')}</a:solidFill>`
      : f?.kind === 'pattern' ? xmlOf(pattFillEl(a, 'fill'))
        : (f?.kind === 'texture' || f?.kind === 'picture') && rid ? xmlOf(blipFillEl(rid, f.kind === 'texture' ? { tile: f.tile ?? true } : { stretch: f.stretch }))
          : null;
  const lined = !!a.line?.width;
  const hide = hiddenXml(a.hidden, { fill: !!fill, line: lined });
  const line = lined ? `<a:ln w="${emu(a.line.width)}"><a:solidFill>${colorXml(a, 'line.color')}</a:solidFill>${a.line.dash ? `<a:prstDash val="${word(a.line.dash, 'solid')}"/>` : ''}</a:ln>` : hide.ln;
  const { shadow: s, glow: g, reflection: r, softEdges, bevel, rotation3d } = a.effects ?? {};
  const fx = effectsXml({ shadow: s && { color: s.color, transparency: 1 - (s.alpha ?? 0.6), blur: s.blur ?? 4, distance: s.dist ?? 3, angle: s.angle ?? s.dir ?? 45 },
    glow: g?.size && { size: g.size, color: g.color, transparency: 1 - (g.alpha ?? 0.6) },
    reflection: r && { size: (r.size ?? 50) / 100, distance: r.dist ?? 0, transparency: 1 - (r.alpha ?? 0.5) }, softEdge: softEdges?.size,
    bevel: bevel && { kind: bevel.type ?? bevel.kind, width: bevel.w ?? bevel.width, height: bevel.h ?? bevel.height }, rotation3d }, a);
  return (fill ?? '<a:noFill/>') + line + fx + hide.ext;
}

/** wp:docPr's a:extLst for a drawing marked decorative (Word's adec:decorative), or ''. */
export const decorativeXml = (yes) => (yes ? '<a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst>' : '');

/** Colour '#RRGGBB' or '#RRGGBBAA' as an a:srgbClr, its alpha as a:alpha (export.mjs and shapes-out.mjs). */
export const srgbXml = (c) => xmlOf(srgbEl(c));
