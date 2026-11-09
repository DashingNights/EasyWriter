// The chrome's view of a board item (docs/plans/board/briefs/bd-look.md): BoardRail, ItemRibbon, LayersPanel and pool-board.js
// read the old board form (px, `shape`, `color`, `fill`, `fillColor`, `html`), while a board stores ew_doc's keys in points. This
// module is the one translation, never a second stored form: nothing is saved in the old form, and only bd-convert reads old
// records. Pure: it imports the shape registry and nothing else, so the page, the worker and node share it.
import { FLAT_FILL, kindOf as entryOf, presetKind } from '../flow/shapes.mjs';

export const PX = 4 / 3; // board px per point
const r6 = (n) => Math.round(n * 1e6) / 1e6; // points, so toPt(toPx(v)) gives v back and a re-patch of an unchanged value writes nothing
export const toPt = (px) => r6(px / PX);
export const toPx = (pt) => r6(pt * PX);

const COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;

/** `#rrggbb` or `#rrggbbaa` → `[r, g, b, alpha]` (alpha defaults to 255), or null for anything else. */
function rgba(color) {
  const m = typeof color === 'string' ? COLOR.exec(color) : null;
  return m ? [1, 2, 3, 4].map((k) => (m[k] ? parseInt(m[k], 16) : 255)) : null;
}

/** An sRGB triple as `#rrggbb`, `#rrggbbaa` when it has transparency (percent), or null for anything else. */
export function hex(rgb, transparency = 0) {
  if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return null;
  const base = `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const a = Math.max(0, Math.min(255, Math.round(255 * (1 - transparency / 100))));
  return a < 255 ? `${base}${a.toString(16).padStart(2, '0')}` : base;
}

/** `#rrggbb` or `#rrggbbaa` as `[r, g, b]` (the alpha dropped: a stroke's transparency is the item's opacity), or null. */
export function rgb(color) {
  const c = rgba(color);
  return c ? c.slice(0, 3) : null;
}

// The board's kinds that are an engine ShapeKind of another name. The registry's own kind is the old form's name.
const TO_SHAPE = { rect: 'rectangle', round: 'roundedRectangle', ellipse: 'ellipse', triangle: 'triangle', diam: 'diamond', diamond: 'diamond',
  star: 'star', heart: 'heart', arrow: 'arrow', arrowLeft: 'arrowLeft', arrowUp: 'arrowUp', arrowDown: 'arrowDown' };
const TO_KIND = Object.fromEntries(Object.entries(TO_SHAPE).map(([kind, shape]) => [shape, kind]));

const enc = new TextEncoder();

/** Old kind → the stored field naming the shape: `{kind}` for an engine ShapeKind, `{prst}` for a DrawingML preset (the caller
 * turns that into fields through bd-api's `presetFields`). Unknown names pass through as their own kind. */
export function kindOf(shape) {
  if (TO_SHAPE[shape]) return { kind: TO_SHAPE[shape] };
  const k = entryOf(shape);
  return k?.prst ? { prst: k.prst } : { kind: shape };
}

/** Stored kind → the board kind that draws it (a preset's board kind where one does). */
const oldKind = (kind) => TO_KIND[kind] ?? presetKind(kind) ?? kind;

/** A stored fill's main colour: the solid colour, a pattern's foreground, a gradient's middle stop, a picture's white. */
function mainColor(fill) {
  if (Array.isArray(fill)) return fill;
  if (fill?.type === 'pattern') return fill.fg ?? null;
  if (fill?.type === 'gradient') return fill.stops?.[Math.floor((fill.stops?.length ?? 0) / 2)]?.color ?? null;
  if (fill?.type === 'solid') return fill.color ?? null;
  if (fill) return [255, 255, 255];
  return null;
}

const fillKind = (fill) => (fill == null ? 'none' : fill.type === 'pattern' ? 'hatch' : 'solid');
// What a fill with no colour of its own becomes: the new-shape look's fill (FLAT_FILL), not black.
const DEFAULT_FILL = rgb(FLAT_FILL);

/** Stored fill → the old form's `fill` and `fillColor` (an 8-digit hex when the solid has transparency). */
function legacyFill(fill) {
  if (fill == null) return { fill: 'none', fillColor: null };
  if (fill.type === 'pattern') return { fill: 'hatch', fillColor: hex(fill.fg) };
  if (fill.type === 'solid') return { fill: 'solid', fillColor: hex(fill.color, fill.transparency ?? 0) };
  return { fill: 'solid', fillColor: hex(mainColor(fill)) };
}

/** A colour and its alpha as a stored solid fill: a plain `[r, g, b]` when opaque, `{type: 'solid', ...}` when not. */
const solidFrom = ([r, g, b, a]) => {
  const transparency = ((255 - a) / 255) * 100;
  return transparency > 0 ? { type: 'solid', color: [r, g, b], transparency } : [r, g, b];
};

/** The old form's fill fields as a stored `fill` (undefined when the patch names neither), starting from what `item` holds.
 * A pattern keeps its preset and background when only its colour changes. */
function patchFill(item, patch) {
  const has = (k) => Object.hasOwn(patch, k);
  if (!has('fill') && !has('fillColor')) return undefined;
  const old = item?.fill;
  const kind = has('fill') ? patch.fill : fillKind(old);
  const color = has('fillColor') ? rgba(patch.fillColor) : null;
  if (kind === 'none') return null;
  if (kind === 'hatch') {
    const pattern = old?.type === 'pattern' ? old : { type: 'pattern', preset: 'ltUpDiag', bg: [255, 255, 255] };
    return { ...pattern, fg: color?.slice(0, 3) ?? pattern.fg ?? mainColor(old) ?? DEFAULT_FILL };
  }
  if (color) return solidFrom(color);
  return mainColor(old) ?? DEFAULT_FILL;
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The story's text, paragraphs joined with '\n'. */
export function plainOf(story) {
  return (story?.blocks ?? []).map((b) => b.text ?? '').join('\n');
}

/** The styles `story` holds, by id. */
const stylesOf = (story) => new Map((story?.styles?.styles ?? []).map((s) => [s.id, s]));

/** The props a style and its `basedOn` chain give, nearest first: a style's own props, then its base's for what it leaves out. */
function inherited(styles, id, key) {
  const out = {};
  const seen = new Set();
  for (let s = styles.get(id); s && !seen.has(s.id); s = styles.get(s.basedOn)) {
    seen.add(s.id);
    for (const [k, v] of Object.entries(s[key] ?? {})) if (out[k] === undefined) out[k] = v;
  }
  return out;
}

/** A text colour as `#rrggbb`: TextColor's `{Rgb: [r, g, b]}`, or null for `Auto` and a missing colour. */
const colorOf = (color) => (color && Array.isArray(color.Rgb) ? hex(color.Rgb) : null);

/**
 * What the chrome shows of a story (bd-text): `{font, size, bold, italic, color, align}` from its first paragraph and run, a
 * run's own props first, then its character style's `basedOn` chain, then the paragraph style's. `size` is points, `color` a
 * hex string or null, `align` 'left' | 'center' | 'right' | 'justify' | 'distribute'.
 */
export function runLook(story) {
  const styles = stylesOf(story);
  const para = (story?.blocks ?? []).find((b) => b.kind === 'para');
  const pp = para?.props ?? {};
  const paraProps = { ...inherited(styles, pp.style, 'para'), ...pp };
  const run = (para?.runs ?? []).find((r) => r.props) ?? para?.runs?.[0];
  const rp = run?.props ?? {};
  const chr = { ...inherited(styles, paraProps.style, 'chr'), ...inherited(styles, rp.style, 'chr'), ...rp };
  return {
    font: chr.font ?? null,
    size: Number.isFinite(chr.size) ? chr.size : null,
    bold: chr.bold === true,
    italic: chr.italic === true,
    color: colorOf(chr.color),
    align: paraProps.align ?? 'left',
  };
}

/** Text → a story of one paragraph per line, each run's `len` counting UTF-8 bytes (the engine's offset unit). */
export function textStory(text) {
  return {
    blocks: String(text).split('\n').map((line) => ({ kind: 'para', text: line, runs: line ? [{ len: enc.encode(line).length }] : [] })),
    parts: {},
    styles: [],
    numbering: { abstracts: [], nums: [] },
  };
}

/** The story's text as `<p>` lines, escaped: what a board's text or label item holds today. */
const htmlOf = (story) => String(plainOf(story)).split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('');

const OUT_TYPE = { picture: 'image', ink: 'stroke' };
const CONNECTOR_FIELDS = ['from', 'to', 'route', 'corner', 'points', 'heads', 'dash', 'jump', 'free'];
const SLOTS = ['start', 'mid', 'end'];
const LABEL_SIZE = 14; // the old form's label size in px, route.mjs's default

/** A stored label story as the old form's label object: its lines, size (px), colour and bold, which the Labels popover reads. */
function legacyLabel(story) {
  const look = runLook(story);
  const out = { html: htmlOf(story), size: look.size != null ? toPx(look.size) : LABEL_SIZE, bold: !!look.bold };
  if (look.color) out.textColor = look.color;
  return out;
}

/** An old-form label ({html, size px, textColor, bold}) as a story, for a patch that names labels the old way. */
function labelStory(l) {
  const lines = String(l?.html ?? '').replace(/<br\s*\/?>(?=<\/(?:div|p)>)/gi, '').replace(/<br\s*\/?>|<(?:div|p)(?:\s[^>]*)?>/gi, '\n')
    .replace(/^\n/, '').replace(/<[^>]*>/g, '').split('\n');
  const props = {};
  if (Number.isFinite(l?.size) && l.size > 0) props.size = toPt(l.size);
  const c = rgb(l?.textColor);
  if (c) props.color = { Rgb: c };
  if (typeof l?.bold === 'boolean') props.bold = l.bold;
  const styled = Object.keys(props).length > 0;
  return {
    blocks: lines.map((line) => ({ kind: 'para', text: line, runs: line ? [{ len: enc.encode(line).length, ...(styled && { props }) }] : [] })),
    parts: {}, styles: [], numbering: { abstracts: [], nums: [] },
  };
}
// A connector end or waypoint in px: its x and y scaled, everything else (item, anchor, pin) kept.
const scaled = (p, f) => (typeof p?.x === 'number' && typeof p?.y === 'number' ? { ...p, x: f(p.x), y: f(p.y) } : structuredClone(p));

/** A stored item as the old-form item the chrome reads. `ancestors` are the ids of the groups it is in, outermost last. The
 * item itself is never changed, and its objects are cloned. A group or doc item has no old form and gives null: callers skip
 * it (LayersPanel has no LOOK entry for either, and would throw drawing one). */
export function legacyOf(item, ancestors = []) {
  if (!item || item.type === 'group' || item.type === 'doc') return null;
  const out = { id: item.id, type: OUT_TYPE[item.type] ?? item.type };
  for (const k of ['x', 'y', 'w', 'h']) if (typeof item[k] === 'number') out[k] = toPx(item[k]);
  if (item.rot != null) out.rot = item.rot;
  if (item.flipX || item.flipY) {
    out.flipX = !!item.flipX;
    out.flipY = !!item.flipY;
    out.mirrorX = !!item.flipX; // the old form's two flip fields read the one stored pair
    out.mirrorY = !!item.flipY;
  }
  if (item.opacity != null) out.opacity = item.opacity;
  if (item.hidden != null) out.hidden = item.hidden;
  if (item.locked != null) out.locked = item.locked;
  if (ancestors.length) out.groups = [...ancestors];
  if (item.story) out.html = htmlOf(item.story);

  if (item.type === 'connector') {
    for (const k of CONNECTOR_FIELDS) {
      if (!(k in item)) continue;
      out[k] = k === 'from' || k === 'to' ? scaled(item[k], toPx) : k === 'points' ? item[k].map((p) => scaled(p, toPx)) : structuredClone(item[k]);
    }
    out.color = hex(item.color) ?? item.color ?? null;
    if (item.width != null) out.width = toPx(item.width);
    // The labels the Labels popover ticks: each stored story as the old form's label, so a label kept in the store reads on.
    const labels = {};
    for (const slot of SLOTS) if (item.labels?.[slot]) labels[slot] = legacyLabel(item.labels[slot]);
    out.labels = labels;
  } else {
    if ('stroke' in item) out.color = hex(item.stroke);
    if (item.strokeWidth != null) out.width = toPx(item.strokeWidth);
    if (item.type === 'shape' || item.type === 'text') Object.assign(out, legacyFill(item.fill));
  }

  // The text's own look, from its story: a text item's colour is its run colour, not the border `stroke` holds.
  if (item.story) {
    const look = runLook(item.story);
    if (look.font) out.font = look.font;
    if (look.size != null) out.size = toPx(look.size);
    out.bold = look.bold;
    out.italic = look.italic;
    out.align = look.align;
    if (look.color) out.color = look.color;
  }

  if (item.type === 'shape') {
    const preset = item.extra?.preset;
    const shape = (preset?.[0] && presetKind(preset[0])) || (item.kind && oldKind(item.kind));
    if (shape) out.shape = shape;
    if (preset) Object.assign(out, { prst: preset[0], av: structuredClone(preset[1]) });
  }
  if (item.type === 'picture') {
    out.src = item.media == null ? null : `media:${item.media}`;
    const [l, t, r, b] = Array.isArray(item.crop) ? item.crop : [0, 0, 0, 0];
    out.crop = { x: l, y: t, w: r6(1 - l - r), h: r6(1 - t - b) };
  }
  return out;
}

/** An old-form patch as the stored fields it names; old fields with no stored field (`html`, `groups`, label styles) are
 * dropped, so a patch never writes a story behind bd-text's back. */
export function patchOf(item, patch = {}) {
  const out = {};
  const has = (k) => Object.hasOwn(patch, k);
  const connector = item?.type === 'connector';
  // A value the item already has is no op: px round through points within 1e-6.
  const num = (k, v) => {
    if (!(typeof item?.[k] === 'number' && Math.abs(item[k] - v) < 1e-6)) out[k] = v;
  };

  for (const k of ['x', 'y', 'w', 'h']) if (has(k)) num(k, toPt(patch[k]));
  if (has('rot')) num('rot', patch.rot);
  const [fx, fy] = [['flipX', 'mirrorX'], ['flipY', 'mirrorY']].map(([flip, mirror]) => (has(flip) ? patch[flip] : has(mirror) ? patch[mirror] : undefined));
  if (fx !== undefined) out.flipX = !!fx;
  if (fy !== undefined) out.flipY = !!fy;
  if (has('opacity')) num('opacity', patch.opacity);
  for (const k of ['hidden', 'locked']) if (has(k)) out[k] = patch[k];

  // A text item's colour, font, size, bold, align, fit and bg live in its story: bd-text maps them, so they are dropped here.
  if (has('color') && item?.type !== 'text') {
    const c = rgb(patch.color);
    if (c) out[connector ? 'color' : 'stroke'] = c;
  }
  if (has('width')) num(connector ? 'width' : 'strokeWidth', toPt(patch.width));

  const fill = patchFill(item, patch);
  if (fill !== undefined) out.fill = fill;

  const shape = has('shape') ? kindOf(patch.shape) : null;
  let preset = item?.extra?.preset ?? null;
  if (has('prst')) preset = [patch.prst, has('av') ? patch.av : preset?.[1] ?? []];
  else if (has('av')) preset = [preset?.[0], patch.av];
  if (shape?.prst) preset = [shape.prst, preset?.[1] ?? []];
  if (shape?.kind) preset = null;
  if (preset) out.extra = { ...(item?.extra ?? {}), preset };
  else if (shape?.kind) {
    // A plain kind: the preset's fields (and a freeform) would keep drawing the old shape.
    if (item?.kind !== shape.kind) {
      out.kind = shape.kind;
      out.freeform = null;
    }
    if (item?.extra) {
      const { preset: _, ...rest } = item.extra;
      out.extra = rest;
    }
  }

  if (has('crop')) {
    const c = patch.crop;
    out.crop = c ? [r6(c.x), r6(c.y), r6(1 - c.x - c.w), r6(1 - c.y - c.h)] : [0, 0, 0, 0];
  }
  if (has('src')) {
    const key = typeof patch.src === 'string' ? patch.src.replace(/^media:/, '') : patch.src;
    if (key) out.media = key;
  }
  if (connector) {
    for (const k of CONNECTOR_FIELDS) {
      if (!has(k)) continue;
      const v = k === 'from' || k === 'to' ? scaled(patch[k], toPt) : k === 'points' ? patch[k].map((p) => scaled(p, toPt)) : patch[k];
      if (JSON.stringify(v) !== JSON.stringify(item?.[k])) out[k] = v;
    }
    // A label the old form names keeps what the store holds unless the patch gives a story or removes the slot: the panel's
    // tick never rewrites the text.
    if (has('labels')) {
      const labels = { ...(item?.labels ?? {}) };
      for (const slot of SLOTS) {
        if (!Object.hasOwn(patch.labels ?? {}, slot)) continue;
        const l = patch.labels[slot];
        if (l == null) delete labels[slot];
        else labels[slot] = l.blocks ? l : labelStory(l);
      }
      out.labels = labels;
    }
  }
  return out;
}

/** A new item's stored fields from the tool's old-form look and a box in points (none: the kind's click-placed size). A preset
 * gives `prst` (and `extra.preset`), which bd-api turns into fields through `presetFields`. */
export function newShape(look = {}, box) {
  const fields = kindOf(look.shape);
  const [dw, dh] = entryOf(look.shape)?.box ?? [160, 110];
  const out = { type: 'shape', x: box?.x ?? 0, y: box?.y ?? 0, w: box?.w ?? toPt(dw), h: box?.h ?? toPt(dh) };
  Object.assign(out, fields);
  const fill = patchFill(null, look);
  if (fill !== undefined) out.fill = fill;
  if (look.color) out.stroke = rgb(look.color);
  if (look.width != null) out.strokeWidth = toPt(look.width);
  if (look.opacity != null) out.opacity = look.opacity;
  if (out.prst) out.extra = { preset: [out.prst, look.av ?? []] };
  return out;
}
