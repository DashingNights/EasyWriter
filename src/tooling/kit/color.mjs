// Colour models of the kit's colour picker (ColorPicker.jsx; docs/plans/word/briefs/color-picker.md). Pure, so the Node tests
// read it. While picking, a colour is HSVA {h 0 to 360, s, v, a 0 to 1}: it keeps a hue where RGB has none (a grey, black), so
// dragging through grey and back keeps it; `sl` keeps its HSL saturation through white the same way.

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** '#RRGGBB' (or 'RRGGBB') → [r, g, b], or null. */
export function rgbOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
}

/** [r, g, b] (0 to 255, clamped and rounded) → '#RRGGBB'. */
export const hexOf = (rgb) => `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** '#rgb', '#rrggbb' or '#rrggbbaa' (the '#' optional) → [r, g, b, a] with a 0 to 1, or null. */
export function rgbaOf(text) {
  let x = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(text ?? '').trim())?.[1];
  if (!x) return null;
  if (x.length === 3) x = [...x].map((d) => d + d).join('');
  const n = x.match(/../g).map((p) => parseInt(p, 16));
  return [n[0], n[1], n[2], n.length > 3 ? n[3] / 255 : 1];
}

/** [r, g, b] → [h, s, v]; `keep` [h, s] stands in where RGB has no hue (a grey) or no saturation (black). */
export function hsvOf([r, g, b], keep = [0, 0]) {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!max) return [keep[0], keep[1], 0];
  if (!d) return [keep[0], 0, max / 255];
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, d / max, max / 255];
}

/** [h, s, v] → [r, g, b], unrounded. */
export const rgbOfHsv = ([h, s, v]) => [5, 3, 1].map((n) => {
  const k = (n + h / 60) % 6;
  return 255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)));
});

/** [h, s, v] → [h, s, l] of HSL (the hue is shared). Black keeps the saturation its shades tend to, s / (2 - s), so lightness
 * can go to black and back; white has none. */
export function hslOfHsv([h, s, v]) {
  const l = v * (1 - s / 2);
  if (l <= 0) return [h, s / (2 - s), 0];
  return [h, l >= 1 ? 0 : (v - l) / Math.min(l, 1 - l), l];
}

/** [h, s, l] → [h, s, v]; black keeps saturation `keepS`. */
export function hsvOfHsl([h, s, l], keepS = 0) {
  const v = l + s * Math.min(l, 1 - l);
  return [h, v ? 2 * (1 - l / v) : keepS, v];
}

/** A colour (text as rgbaOf takes, or [r, g, b, a]) as HSVA, keeping `prev`'s hue and saturation where it has none; grey when
 * the text is not a colour. */
export function hsvaOf(x, prev = { h: 0, s: 0 }) {
  const c = (Array.isArray(x) ? x : rgbaOf(x)) ?? [128, 128, 128, 1];
  const [h, s, v] = hsvOf(c, [prev.h, prev.s]);
  return { h, s, v, a: c[3] ?? 1 };
}

/** HSVA → '#rrggbb', or '#rrggbbaa' below full opacity. */
export function hexOfHsva({ h, s, v, a = 1 }) {
  const n = [...rgbOfHsv([h, s, v]), a * 255].map((x) => Math.round(clamp(x, 0, 255)));
  return `#${(n[3] < 255 ? n : n.slice(0, 3)).map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** '#RRGGBB' with a transparency in percent (how Word stores a fill's) → '#RRGGBBAA', or the hex alone when opaque. */
export function withTransparency(hex, pct) {
  const a = Math.round((1 - (Number(pct) || 0) / 100) * 255);
  return hex && a < 255 ? `${hex}${Math.max(0, a).toString(16).padStart(2, '0').toUpperCase()}` : hex;
}

/** A picked '#RRGGBB' or '#RRGGBBAA' → {color: 'RRGGBB', transparency: percent}, or null. */
export function transparencyOf(text) {
  const c = rgbaOf(text);
  return c && { color: hexOf(c.slice(0, 3)).slice(1), transparency: Math.round((1 - c[3]) * 100) };
}

// --- Formats: the typed fields under the picker ---

// A field: [key, short label, name]. r g b run 0 to 255 and h 0 to 360; sl and l (HSL), s and v (HSB) and a (opacity) are percent.
const F = {
  hex: ['hex', 'Hex', 'Hex'], r: ['r', 'R', 'Red'], g: ['g', 'G', 'Green'], b: ['b', 'B', 'Blue'], h: ['h', 'H', 'Hue'],
  sl: ['sl', 'S', 'Saturation'], l: ['l', 'L', 'Lightness'], s: ['s', 'S', 'Saturation'], v: ['v', 'B', 'Brightness'], a: ['a', 'A', 'Opacity'],
};
const MAX = { r: 255, g: 255, b: 255, h: 360, sl: 100, l: 100, s: 100, v: 100, a: 100 };
const RGB = ['r', 'g', 'b'];

/** The value formats: id → [menu label, fields, whether it shows opacity]. */
export const FORMATS = {
  hex: ['Hex', [F.hex], false],
  rgb: ['RGB', [F.r, F.g, F.b], false],
  rgba: ['RGBA', [F.r, F.g, F.b, F.a], true],
  hsl: ['HSL', [F.h, F.sl, F.l], false],
  hsla: ['HSLA', [F.h, F.sl, F.l, F.a], true],
  hsb: ['HSB', [F.h, F.s, F.v], false],
};

/** The format a picker shows for the remembered `id`: Hex when unknown, and without `alpha` RGBA and HSLA as RGB and HSL. */
export function formatShown(id, alpha) {
  const f = FORMATS[id] ? id : 'hex';
  return alpha ? f : { rgba: 'rgb', hsla: 'hsl' }[f] ?? f;
}

/** Field `key`'s text for colour `c`; HSL saturation is the one `c` keeps through white. */
export function fieldText(key, c) {
  if (key === 'hex') return hexOfHsva(c).toUpperCase();
  if (RGB.includes(key)) return String(Math.round(rgbOfHsv([c.h, c.s, c.v])[RGB.indexOf(key)]));
  if (key === 'h') return String(Math.round(c.h) % 360);
  const [, sl, l] = hslOfHsv([c.h, c.s, c.v]);
  const n = key === 'sl' ? c.sl ?? sl : key === 'l' ? l : c[key];
  return String(Math.round(n * 100));
}

/** Colour `c` with the HSL saturation it keeps through white (where HSL has none), in `sl`: its own, or the one it already has. */
export function withSat(c) {
  const [, sl, l] = hslOfHsv([c.h, c.s, c.v]);
  return { ...c, sl: l < 1 ? sl : c.sl ?? sl };
}

/** Colour `c` with field `key` typed as `text`, or null when the text is no value there. Typed lightness and the lightness
 * slider read and write the same memory, `sl`. */
export function withField(c, key, text) {
  const t = String(text ?? '').trim();
  if (key === 'hex') {
    const x = rgbaOf(t);
    return x && withSat(hsvaOf(x, c));
  }
  if (!/^\d{1,3}(\.\d+)?$/.test(t) || Number(t) > MAX[key]) return null;
  const n = Number(t);
  if (RGB.includes(key)) {
    const rgb = rgbOfHsv([c.h, c.s, c.v]).map(Math.round);
    rgb[RGB.indexOf(key)] = n;
    const [h, s, v] = hsvOf(rgb, [c.h, c.s]);
    return withSat({ ...c, h, s, v });
  }
  if (key === 'h') return withSat({ ...c, h: n % 360 });
  if (key === 's' || key === 'v' || key === 'a') return withSat({ ...c, [key]: n / 100 });
  const [h, sl, l] = hslOfHsv([c.h, c.s, c.v]);
  if (key === 'sl') {
    const [, s, v] = hsvOfHsl([h, n / 100, l], c.s);
    return { ...c, s, v, sl: n / 100 };
  }
  const keep = c.sl ?? sl;
  const [, s, v] = hsvOfHsl([h, keep, n / 100], c.s);
  return { ...c, s, v, sl: keep };
}

// --- Areas: where the pointer picks, in px of a box w × h ---
// 'square': saturation across, brightness up (HSB). 'triangle': a hue ring around a triangle whose corners are the hue, white and
// black. 'wheel': HSL, hue around and saturation outward; the lightness has its own slider.

export const AREAS = ['square', 'triangle', 'wheel'];
export const RING = 0.8; // the triangle's hue ring starts at this share of the radius
const DEG = Math.PI / 180;
const geo = (w, h) => ({ cx: w / 2, cy: h / 2, R: Math.min(w, h) / 2 });

/** The triangle's corners [[x, y] of the hue, of white, of black]: hue at the top, white bottom left, black bottom right. */
export function corners(w, h) {
  const { cx, cy, R } = geo(w, h);
  const r = R * (RING - 0.05);
  return [-90, 150, 30].map((d) => [cx + r * Math.cos(d * DEG), cy + r * Math.sin(d * DEG)]);
}

/** The part of `area` under x, y: 'ring' (the triangle's hue ring) or 'body'. A drag keeps the part it started on. */
export function areaPart(area, x, y, w, h) {
  const { cx, cy, R } = geo(w, h);
  return area === 'triangle' && Math.hypot(x - cx, y - cy) >= R * (RING - 0.025) ? 'ring' : 'body';
}

/** Colour `c` picked at x, y on `part` of `area`: the patch of {h, s, v} it changes. A press on a hueless spot (the square's
 * left edge, the wheel's centre, the triangle's white to black edge) keeps the hue. */
export function areaPick(area, c, x, y, w, h, part = 'body') {
  x = clamp(x, 0, w);
  y = clamp(y, 0, h);
  if (area === 'square') return { s: x / w, v: 1 - y / h };
  const { cx, cy, R } = geo(w, h);
  const angle = ((Math.atan2(y - cy, x - cx) / DEG) + 360) % 360;
  if (area === 'wheel') {
    const r = Math.min(1, Math.hypot(x - cx, y - cy) / R);
    const hue = r ? angle : c.h;
    const [, s, v] = hsvOfHsl([hue, r, hslOfHsv([c.h, c.s, c.v])[2]], c.s);
    return { h: hue, s, v };
  }
  if (part === 'ring') return { h: angle };
  // Barycentric weights of the hue, white and black corners; a point outside the triangle clamps onto it.
  const [[x1, y1], [x2, y2], [x3, y3]] = corners(w, h);
  const det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
  const a = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / det;
  const b = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / det;
  const [ka, kb, kk] = [a, b, 1 - a - b].map((n) => Math.max(0, n));
  const sum = ka + kb + kk;
  const v = (ka + kb) / sum;
  return { s: v ? ka / (ka + kb) : c.s, v };
}

/** Where `area` draws its handles for colour `c`: [[x, y]] of the body's handle, and the hue ring's after it on the triangle. */
export function areaHandles(area, c, w, h) {
  if (area === 'square') return [[c.s * w, (1 - c.v) * h]];
  const { cx, cy, R } = geo(w, h);
  const [cos, sin] = [Math.cos(c.h * DEG), Math.sin(c.h * DEG)];
  if (area === 'wheel') {
    const s = hslOfHsv([c.h, c.s, c.v])[1];
    return [[cx + s * R * cos, cy + s * R * sin]];
  }
  const [[x1, y1], [x2, y2], [x3, y3]] = corners(w, h);
  const [a, b, k] = [c.s * c.v, c.v * (1 - c.s), 1 - c.v];
  const ring = (R * (1 + RING)) / 2;
  return [[a * x1 + b * x2 + k * x3, a * y1 + b * y2 + k * y3], [cx + ring * cos, cy + ring * sin]];
}

const KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** The patch arrow `key` makes on `area` at colour `c` in a w × h box: a press on the body handle moved by 1 % of the box, except
 * Shift with Left or Right on the triangle, which turns its ring's hue by 3.6 degrees. Null for other keys. */
export function areaKey(area, c, key, shift, w, h) {
  if (area === 'triangle' && shift && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    return { h: (c.h + (key === 'ArrowRight' ? 3.6 : -3.6) + 360) % 360 };
  }
  const d = KEYS[key];
  if (!d) return null;
  const [x, y] = areaHandles(area, c, w, h)[0];
  return areaPick(area, c, x + (d[0] * w) / 100, y + (d[1] * h) / 100, w, h);
}
