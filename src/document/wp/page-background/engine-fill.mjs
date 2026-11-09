// The Fill Effects dialog's fills on a canvas draft (docs/plans/engine/stage2b.md, engine-gaps-shapes): the dialog's value
// ({kind: 'gradient' | 'texture' | 'pattern' | 'picture', ...}, FillEffectsDialog.jsx) as the engine's fill params (shape.fill,
// shape.outline's pattern, design.pageFill) and back. Textures are our own tiles, drawn into a picture for the engine. Pure but
// for the texture's drawing, which needs a browser.
import { gradientStops, TEXTURES, textureCss } from './model.mjs';

const hex6 = (c) => (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c) ? c.replace('#', '').toUpperCase() : null);
const hash = (c) => (c ? `#${String(c).replace('#', '').toUpperCase()}` : null);

/** A CSS colour from gradientStops ('#RRGGBB' or 'rgba(r, g, b, a)') → [RRGGBB, transparency percent]. */
export function stopColor(css) {
  const h = hex6(css);
  if (h) return [h, 0];
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(String(css).trim());
  if (!m) return ['000000', 0];
  const c = [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  return [c, Math.round((1 - Number(m[4] ?? 1)) * 100)];
}

// The dialog's linear styles as the engine's angles (0 runs left to right, 90 top to bottom): Horizontal runs its first stop from
// the top, Vertical from the left, Diagonal up from the top left, Diagonal down from the bottom left (model.mjs ANGLES).
const ANGLE = { horizontal: 90, vertical: 0, diagonalUp: 45, diagonalDown: 315 };
// From corner's variants: the corner the first stop sits in, as the engine's focus (percent insets left, top, right, bottom).
const CORNER = [[0, 0, 100, 100], [100, 0, 0, 100], [0, 100, 100, 0], [100, 100, 0, 0]];

/** A gradient fill of the dialog → shape.fill's {gradient}: its stops evenly spread in the variant's order. */
export function gradientParams(f) {
  const stops = gradientStops(f).map(stopColor);
  const v = f.variant ?? 0;
  const back = [...stops].reverse();
  let list = stops;
  if (f.style === 'fromCenter') list = v % 2 ? back : stops;
  else if (f.style !== 'fromCorner') list = v === 1 ? back : v === 2 ? [...stops, ...back.slice(1)] : v === 3 ? [...back, ...stops.slice(1)] : stops;
  const spread = list.map(([color, transparency], i) => ({ pos: Math.round((i / Math.max(1, list.length - 1)) * 1000) / 10, color, transparency }));
  if (f.style === 'fromCorner') return { gradient: { stops: spread, type: 'radial', focus: CORNER[v] ?? CORNER[0] } };
  if (f.style === 'fromCenter') return { gradient: { stops: spread, type: 'radial', focus: [50, 50, 50, 50] } };
  return { gradient: { stops: spread, type: 'linear', angle: ANGLE[f.style] ?? 90 } };
}

/** The base64 of a data: URL, or null. */
const base64Of = (src) => (typeof src === 'string' ? src.split(';base64,')[1] ?? null : null);

/** Texture `id`'s tile (our own, 96 px) as a PNG's base64: the SVG tile drawn on a canvas. Null where nothing draws (node). */
export async function textureData(id) {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return null;
  const url = /^url\("(.*)"\)$/.exec(textureCss({ texture: id }).image)?.[1];
  if (!url) return null;
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 96;
  c.getContext('2d').drawImage(img, 0, 0, 96, 96);
  return base64Of(c.toDataURL('image/png'));
}

/** The dialog's fill `f` → the engine's params ({gradient} | {pattern} | {picture: {data, tile, title?}}), or null. */
export async function engineFill(f) {
  const kind = f?.kind ?? f?.type;
  if (kind === 'gradient') return gradientParams(f);
  if (kind === 'pattern') return { pattern: { preset: f.pattern ?? 'pct5', fg: hex6(f.fg) ?? '000000', bg: hex6(f.bg) ?? 'FFFFFF' } };
  if (kind === 'picture') {
    const data = base64Of(f.src);
    return data ? { picture: { data, tile: false } } : null;
  }
  if (kind === 'texture') {
    const data = f.src ? base64Of(f.src) : await textureData(f.texture ?? TEXTURES[0][0]);
    return data ? { picture: { data, tile: true, ...(!f.src && { title: f.texture ?? TEXTURES[0][0] }) } } : null;
  }
  return null;
}

/** An engine fill (object.get's shape.fill, design.pageFillInfo) → the dialog's value, so it opens on what the object has; a
 * gradient opens as its first and last colours. Null for a solid colour or none. */
export function dialogFill(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.pattern) return { kind: 'pattern', pattern: e.pattern.preset, fg: hash(e.pattern.fg), bg: hash(e.pattern.bg) };
  if (e.picture) {
    const t = e.picture.tile;
    const known = TEXTURES.some(([id]) => id === e.picture.title);
    return t ? { kind: 'texture', texture: known ? e.picture.title : TEXTURES[0][0], src: null } : { kind: 'picture', src: null };
  }
  const g = e.gradient;
  if (g) {
    const stops = g.stops ?? [];
    const angle = g.kind?.angle ?? g.angle ?? 90;
    let style = Object.entries(ANGLE).find(([, a]) => Math.abs(a - angle) < 1)?.[0] ?? 'horizontal';
    let variant = 0;
    // A radial, rectangular or path gradient: From corner when its focus is one of CORNER's, else From center.
    if (g.kind?.type === 'path' || ['radial', 'rectangular', 'path'].includes(g.type)) {
      const focus = g.focus ?? g.kind?.focus ?? [];
      const corner = CORNER.findIndex((c) => c.every((x, i) => Math.abs(x - (focus[i] ?? 50)) < 1));
      [style, variant] = corner < 0 ? ['fromCenter', 0] : ['fromCorner', corner];
    }
    return { kind: 'gradient', colors: 'two', color1: hash(stops[0]?.color) ?? '#4472C4', color2: hash(stops.at(-1)?.color) ?? '#FFFFFF',
      style, variant, from: 0, to: 0 };
  }
  return null;
}
