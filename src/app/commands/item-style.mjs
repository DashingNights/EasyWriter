// New board items match the board they join (2026-10-07; the user: "the models should be able to correctly set the annotation's
// themes as well, like the flowchart item's colors, fills, or text notes spawned to have the correct text color that is
// consistent with the existing page's theme"). A style field an agent leaves out is taken from the board's own items of the same
// type (a shape: of the same kind when there is one, else any shape): the most common style among them, the latest on a tie.
// A board with no item of that type looks at the rest of the page (`page`: every board's items in the draft), so a blank
// board's marks match the marks on the page's other boards. Fields the agent sets stay as set. With no item of that type
// anywhere the theme defaults apply (board.mjs itemDefaults). A connector's label slots take the size, text colour and bold of
// the board's connector labels the same way.
//
// Text colours (2026-10-26; the user: "agents generating things ... often forget to check font colors"): text with no colour of
// its own draws in the theme's text colour for what it sits on (inkOn: a note's or a filled shape's colour, else the board), and
// an agent's write that leaves text under MIN_CONTRAST against it gets a warning (contrastWarnings). Pure.

import { fillable } from '../../flow/shapes.mjs';

export const STYLE_KEYS = {
  text: ['size', 'color', 'bold', 'align', 'bg'],
  shape: ['color', 'width', 'opacity', 'fill', 'fillColor', 'size', 'textColor'],
  connector: ['color', 'width', 'opacity', 'dash', 'route', 'corner', 'heads', 'jump'],
  stroke: ['color', 'width', 'opacity'],
};

const pick = (i, keys) => Object.fromEntries(keys.filter((k) => i[k] !== undefined).map((k) => [k, i[k]]));

/** The most common style (`keys`) among `items`, the latest on a tie; null when `items` is empty. */
export function commonStyle(items, keys) {
  const counts = new Map();
  items.forEach((i, n) => {
    const s = pick(i, keys);
    const k = JSON.stringify(s);
    const c = counts.get(k) ?? { s, n: 0, last: 0 };
    c.n += 1;
    c.last = n;
    counts.set(k, c);
  });
  let best = null;
  for (const c of counts.values()) if (!best || c.n > best.n || (c.n === best.n && c.last > best.last)) best = c;
  return best?.s ?? null;
}

/** The items of `items` whose style a new item `i` takes: the same type, for a shape the same kind when there is one. */
function poolOf(i, items) {
  const same = items.filter((x) => x?.type === i.type);
  return i.type === 'shape' && same.some((x) => x.shape === i.shape) ? same.filter((x) => x.shape === i.shape) : same;
}

const LABEL_KEYS = ['size', 'textColor', 'bold'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const labelsOf = (items) => items.filter((x) => x?.type === 'connector').flatMap((c) => Object.values(c.labels ?? {}).filter(isObj));

/** New item `i` with the style fields it leaves out taken from `items` (the board's own, before the call), else from `page`;
 * a connector's label slots likewise from the connector labels there. With `board` (the board's background hex), a taken text
 * colour that reads under MIN_CONTRAST on the new item's surface is left out, so the text draws in the theme's (inkOn): drafts
 * from before 2026-10-26 hold #ffffff on every connector label. */
export function matchStyle(i, items, page = [], board = null) {
  const keys = STYLE_KEYS[i?.type];
  if (!keys) return i;
  const own = poolOf(i, items);
  const pool = own.length ? own : poolOf(i, page);
  const s = pool.length ? commonStyle(pool, keys) : null;
  const out = s ? { ...s, ...i } : { ...i };
  const field = { text: 'color', shape: 'textColor' }[i.type];
  if (field && i[field] === undefined && !reads(out[field], surfaceOf(out, board))) delete out[field];
  if (i.type !== 'connector' || !isObj(i.labels)) return out;
  const labels = labelsOf(items).length ? labelsOf(items) : labelsOf(page);
  const l = labels.length ? commonStyle(labels, LABEL_KEYS) : null;
  if (!l) return out;
  const { textColor, ...rest } = l;
  const base = reads(textColor, board) ? l : rest;
  return { ...out, labels: Object.fromEntries(Object.entries(i.labels).map(([k, v]) => [k, isObj(v) ? { ...base, ...v } : v])) };
}

/** Every board item of ProseMirror `doc` (the canvases' items): matchStyle's `page`. */
export function pageItems(doc) {
  const out = [];
  doc?.descendants((n) => {
    if (!Array.isArray(n.attrs?.items)) return true;
    out.push(...n.attrs.items);
    return false;
  });
  return out;
}

/** The board's styles as board.get's brief names them: the most common style of each type that has items. */
export function boardStyles(items) {
  const out = {};
  for (const [type, keys] of Object.entries(STYLE_KEYS)) {
    const same = items.filter((x) => x?.type === type);
    if (same.length) out[type] = commonStyle(same, keys);
  }
  return out;
}

// --- text colour ---

export const MIN_CONTRAST = 3; // WCAG 2 ratio for large text and graphics; board text is mostly short labels
export const INK = { light: '#111111', dark: '#ffffff' }; // the theme's text colour (whiteboard.js ink, flowPreset)
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** [r, g, b, a] (0 to 255, alpha 0 to 1) of hex colour `c` (#rgb, #rrggbb, #rrggbbaa), or null for anything else. */
function rgba(c) {
  const m = HEX.exec(c ?? '');
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
  return [0, 2, 4, 6].map((k) => (k < h.length ? parseInt(h.slice(k, k + 2), 16) : 255)).map((v, k) => (k === 3 ? v / 255 : v));
}

/** WCAG relative luminance of hex colour `c`, or null for anything else. */
function luminance(c) {
  const p = rgba(c);
  if (!p) return null;
  const [r, g, b] = p.slice(0, 3).map((x) => {
    const v = x / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Hex colour `c` with its own alpha times `alpha` laid over opaque `under`, as #rrggbb; `c` itself when either is not hex. */
function over(c, alpha, under) {
  const [p, q] = [rgba(c), rgba(under)];
  if (!p || !q) return c;
  const a = p[3] * alpha;
  return `#${[0, 1, 2].map((k) => Math.round(p[k] * a + q[k] * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
}

// ponytail: a text colour's own alpha is ignored (text counts as opaque); surfaces are blended (surfaceOf).
/** WCAG contrast ratio of hex colours `a` and `b` (1 to 21), or null when either is not a hex colour. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return x === null || y === null ? null : (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** False when text colour `c` reads under MIN_CONTRAST on `surface`; true when it reads or either is not a hex colour. */
function reads(c, surface) {
  const r = contrast(c, surface);
  return r === null || r >= MIN_CONTRAST;
}

/** The colour of text with none of its own on `surface` (hex) in `theme`: the theme's ink, or the other ink where that one
 * reads under MIN_CONTRAST (white on a white board in the dark theme, ink on a dark fill). */
export function inkOn(surface, theme) {
  const own = theme === 'light' ? INK.light : INK.dark;
  const r = contrast(own, surface);
  return r === null || r >= MIN_CONTRAST ? own : own === INK.light ? INK.dark : INK.light;
}

/** What item `i`'s text is drawn on: a filled shape's fill (its alpha times the shape's opacity, which leaves the label alone)
 * or a text note's colour, laid over `board` (the board's background hex), else `board`. A connector label masks its line with
 * the board colour. */
export const surfaceOf = (i, board) => (i?.type === 'shape' && i.fill === 'solid' && fillable(i.shape) ? over(i.fillColor, i.opacity ?? 1, board)
  : i?.type === 'text' && i.bg ? over(i.bg, 1, board) : board);

/** {id, message} for each text of the items of `items` named in `ids` that reads under MIN_CONTRAST against what it is drawn on
 * (`board`: the board's background hex in `theme`); text without a colour counts as drawn (inkOn). */
export function contrastWarnings(items, ids, theme, board) {
  const out = [];
  const check = (i, field, color, surface) => {
    const r = contrast(color, surface);
    if (r !== null && r < MIN_CONTRAST) {
      out.push({ id: i.id, message: `text ${color} on ${surface} has a contrast of ${r.toFixed(1)}:1, under ${MIN_CONTRAST}:1. Set ${field} to a readable colour` });
    }
  };
  for (const i of items) {
    if (!ids.has(i.id)) continue;
    const surface = surfaceOf(i, board);
    if (i.type === 'text' && i.html) check(i, 'color', i.color ?? inkOn(surface, theme), surface);
    if (i.type === 'shape' && i.html) check(i, 'textColor', i.textColor ?? inkOn(surface, theme), surface);
    if (i.type === 'connector') {
      for (const [slot, l] of Object.entries(i.labels ?? {})) check(i, `labels.${slot}.textColor`, l.textColor ?? inkOn(board, theme), board);
    }
  }
  return out;
}

const LOOK_KEYS = ['color', 'textColor', 'bg', 'fill', 'fillColor', 'opacity', 'shape', 'labels'];
/** Whether update `patch` changes how an item's text reads (its colour or what it sits on): only then does an update warn. */
export const styledText = (patch) => LOOK_KEYS.some((k) => k in (patch ?? {}));
