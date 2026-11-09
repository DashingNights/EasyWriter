// Text boxes and styled text (docs/plans/word/plan.md §3 textbox, §1.8 textBox): the Text Box gallery's designs, the 30 styled text
// presets, the text direction and alignment lists, a new box's node JSON and the CSS a box draws with. Pure: Node tests load it.
// The designs and presets are our own (names, words and looks); Word's are not copied.
import { THEME } from '../../defaults.mjs';
import { TEXTBOX_DEFAULTS } from '../../model/nodes.js';
import { resolveColor } from '../../../office.mjs';
import { rotationCss } from '../../../tooling/rotation3d.mjs';
import { fillCss } from '../page-background/model.mjs';

export const PX_PER_PT = 4 / 3;
const px = (pt) => `${Math.round(pt * PX_PER_PT * 100) / 100}px`;

/** Text Direction's menu in Word's order: [dir, label]. */
export const DIRS = [['lrTb', 'Horizontal'], ['tbRl', 'Rotate all text 90°'], ['btLr', 'Rotate all text 270°'], ['stacked', 'Stacked']];
/** Align Text's menu: [vAlign, label]. */
export const VALIGNS = [['top', 'Top'], ['center', 'Middle'], ['bottom', 'Bottom']];

const theme = (slot, lum = 0) => ({ color: resolveColor(THEME, { slot, lum }), themeColor: { slot, lum } });
const para = (text, run) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(run && { marks: [{ type: 'textStyle', attrs: run }] }) }] });

/** The Text Box gallery's Built-in designs: {id, label, attrs (patched over the schema defaults), text, run (textStyle)}.
 * Simple Text Box first with the schema defaults; the caret lands on the placeholder text, selected. */
export const TEXTBOX_GALLERY = [
  { id: 'simple', label: 'Simple Text Box', attrs: {}, text: 'Type here. Drag the box where you want it, or keep it beside this paragraph.' },
  { id: 'accentQuote', label: 'Accent Quote', attrs: { w: 288, h: 86, fill: theme('accent1', 0.8).color, line: { color: theme('accent1').color, width: 1.5, dash: 'solid' } },
    text: 'Pull a line from your text that you want readers to remember.', run: { italic: true, size: 14, ...theme('accent1', -0.25) } },
  { id: 'openQuote', label: 'Open Quote', attrs: { w: 324, h: 72, fill: null, line: null, vAlign: 'center' },
    text: 'A short quote in large type, with no box around it.', run: { size: 18, ...theme('accent2') } },
  { id: 'greySidebar', label: 'Grey Sidebar', attrs: { w: 144, h: 432, fill: '#F2F2F2', line: null, inset: { t: 10.8, r: 10.8, b: 10.8, l: 10.8 } },
    text: 'A sidebar holds a note, a list or a short story next to the main text.' },
  { id: 'bandSidebar', label: 'Colour Band Sidebar', attrs: { w: 158, h: 432, fill: theme('accent1').color, line: null, inset: { t: 10.8, r: 10.8, b: 10.8, l: 10.8 } },
    text: 'Use a coloured sidebar to set a section apart.', run: { ...theme('lt1') } },
  { id: 'noteBand', label: 'Note Band', attrs: { w: 468, h: 58, fill: theme('accent4', 0.8).color, line: { color: theme('accent4').color, width: 0.75, dash: 'solid' }, vAlign: 'center' },
    text: 'A wide note across the page for a tip or a warning.' },
];

const BLACK = { color: '#000000', themeColor: { slot: 'dk1', lum: 0 } };
// Each look takes a colour and gives {color, effects} in the textStyle effects shape the font package draws
// ({fill, outline, shadow, glow, reflection}, lengths in pt).
const LOOKS = [
  ['Solid', (c) => ({ ...c, effects: { fill: { type: 'solid', color: c.color } } })],
  ['Outlined', (c) => ({ ...c, effects: { fill: { type: 'solid', color: '#FFFFFF' }, outline: { color: c.color, width: 1, dash: 'solid' } } })],
  ['Shadowed', (c) => ({ ...c, effects: { shadow: { color: '#000000', alpha: 0.45, angle: 45, dist: 3, blur: 4 } } })],
  ['Glowing', (c) => ({ ...c, effects: { glow: { color: c.color, size: 6, alpha: 0.4 } } })],
  ['Reflected', (c) => ({ ...c, effects: { reflection: { size: 50, dist: 0, alpha: 0.5 } } })],
  ['Raised', (c) => ({ ...c, effects: { outline: { color: '#FFFFFF', width: 0.5, dash: 'solid' }, shadow: { color: '#000000', alpha: 0.6, angle: 45, dist: 1.5, blur: 1 } } })],
];
const SHADES = [['Black', BLACK], ['Blue', theme('accent1')], ['Orange', theme('accent2')], ['Teal', theme('accent4')], ['Purple', theme('accent5')]];

/** The 30 styled text presets (Word's WordArt): {id, label, color, themeColor, effects}, six looks in five colours. */
export const WORDART = LOOKS.flatMap(([look, make], li) => SHADES.map(([shade, c], si) => ({
  id: `wa${li * SHADES.length + si + 1}`, label: `${look} ${shade.toLowerCase()}`, ...make(c),
})));

let seq = 0;
/** A short id for a new box (textBox.id, which Create Link stores in another box's link). */
export const boxId = () => `tb${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The chains of linked text boxes among `boxes` (Create Link: linkOf(box) names the next box's idOf(box)) → arrays of boxes in
 * story order, each from a box no other box links to. Of boxes sharing an id the first counts; a chain ends at a link to no box or
 * back into a chain. Export (Document JSON) and flow.js (the drawn boxes) both read chains through it. */
export function chainsOf(boxes, idOf, linkOf) {
  const byId = new Map();
  for (const b of boxes) if (idOf(b) && !byId.has(idOf(b))) byId.set(idOf(b), b);
  const next = (b) => (linkOf(b) && byId.get(linkOf(b))) || null;
  const followed = new Set(boxes.map(next));
  const seen = new Set();
  const out = [];
  for (const head of boxes) {
    if (!next(head) || followed.has(head) || seen.has(head)) continue;
    const chain = [head];
    for (let b = next(head); b && !seen.has(b) && !chain.includes(b); b = next(b)) chain.push(b);
    chain.forEach((b) => seen.add(b));
    out.push(chain);
  }
  return out;
}

/** Node JSON of a new text box of gallery design `id` (TEXTBOX_GALLERY), patched with `patch` (w, h, dir, layout from a drag). */
export function newBox(id = 'simple', patch = {}) {
  const d = TEXTBOX_GALLERY.find((g) => g.id === id) ?? TEXTBOX_GALLERY[0];
  const attrs = structuredClone({ ...TEXTBOX_DEFAULTS, ...d.attrs, ...patch, id: boxId() });
  return { type: 'textBox', attrs, content: [para(d.text, d.run)] };
}

/** Node JSON of a styled text box of preset `id` (WORDART): no fill, no line, In Front of Text, centred on the margin, sized
 * to its text, holding one 36 pt paragraph of `content` (inline JSON) or 'Your text here'. */
export function wordArtBox(id, content) {
  const p = WORDART.find((w) => w.id === id) ?? WORDART[0];
  const run = { size: 36, color: p.color, themeColor: p.themeColor, effects: p.effects };
  const attrs = structuredClone({ ...TEXTBOX_DEFAULTS, w: 72, h: 54, fill: null, line: null, autoFit: true, noWrap: true, id: boxId(),
    layout: { wrap: 'front', h: { rel: 'margin', align: 'center' }, v: { rel: 'paragraph', offset: 0 } } });
  const body = content?.length ? content : [{ type: 'text', text: 'Your text here' }];
  return { type: 'textBox', attrs, content: [{ type: 'paragraph', content: body.map((n) => withRun(n, run)) }] };
}

/** Inline node JSON `n` with textStyle `run` merged over its own (objects key by key, as setRunProps does). */
export function withRun(n, run) {
  if (n.type !== 'text') return n;
  const marks = n.marks ?? [];
  const own = marks.find((m) => m.type === 'textStyle');
  const attrs = { ...own?.attrs };
  for (const [k, v] of Object.entries(run)) attrs[k] = v && typeof v === 'object' && attrs[k] && typeof attrs[k] === 'object' ? { ...attrs[k], ...v } : v;
  return { ...n, marks: [...marks.filter((m) => m !== own), { type: 'textStyle', attrs }] };
}

const DASH = { solid: 'solid', sysDot: 'dotted', dot: 'dotted', roundDot: 'dotted' };
const rgba = (hex, alpha = 1) => {
  const n = parseInt(String(hex ?? '#000000').slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
};
const offset = (s) => {
  const a = ((s.angle ?? 45) * Math.PI) / 180;
  const d = s.dist ?? 3;
  return `${(Math.cos(a) * d).toFixed(2)}pt ${(Math.sin(a) * d).toFixed(2)}pt`;
};

/** The CSS (property → value) of a box's shape effects {shadow, glow, softEdges, reflection, bevel, rotation3d}, lengths in pt.
 * ponytail: bevel is an inset highlight and 3-D rotation a perspective transform; Word renders both in 3-D. */
export function effectsCss(e) {
  if (!e) return {};
  const shadows = [];
  const css = {};
  if (e.shadow) shadows.push(`${offset(e.shadow)} ${e.shadow.blur ?? 4}pt ${rgba(e.shadow.color, e.shadow.alpha ?? 0.6)}`);
  if (e.glow?.size) shadows.push(`0 0 ${e.glow.size}pt ${e.glow.size / 2}pt ${rgba(e.glow.color, e.glow.alpha ?? 0.6)}`);
  if (e.bevel) shadows.push(`inset ${e.bevel.size ?? 3}pt ${e.bevel.size ?? 3}pt ${e.bevel.size ?? 3}pt rgb(255 255 255 / 0.5)`,
    `inset -${e.bevel.size ?? 3}pt -${e.bevel.size ?? 3}pt ${e.bevel.size ?? 3}pt rgb(0 0 0 / 0.25)`);
  if (shadows.length) css['box-shadow'] = shadows.join(', ');
  if (e.reflection) css['-webkit-box-reflect'] = `below ${e.reflection.dist ?? 0}pt linear-gradient(transparent ${100 - (e.reflection.size ?? 50)}%, rgb(0 0 0 / ${e.reflection.alpha ?? 0.5}))`;
  if (e.softEdges?.size) {
    const s = `${e.softEdges.size}pt`;
    css['mask-image'] = `linear-gradient(to right, transparent, #000 ${s}, #000 calc(100% - ${s}), transparent), linear-gradient(to bottom, transparent, #000 ${s}, #000 calc(100% - ${s}), transparent)`;
    css['mask-composite'] = 'intersect';
  }
  if (e.rotation3d) css.transform = rotationCss(e.rotation3d) || null; // a preset camera or Word's X, Y and Z (src/tooling/rotation3d.mjs)
  return css;
}

const r2 = (n) => Math.round(n * 100) / 100;
/** The CSS background of a Word gradient (docx/dml.mjs gradientOf: kind, angle, stops, scaled, path, focus, tile) on a box `w` × `h`
 * (any one unit). A scaled linear gradient runs at its angle in the box stretched from a square, so its colour bands lie along the
 * stretched diagonal as Word's do; a path gradient spreads from its focus (a:fillToRect, fractions of the box) out to the edges of
 * its tile (a:tileRect, the box itself when it has none), as Word's From Corner and From Center do.
 * ponytail: CSS has no rectangular path gradient, so a rect or shape path draws as an ellipse reaching the same edges. */
export function gradientCss(g, w = 1, h = 1) {
  const stops = g.stops.map((s) => `${s.color} ${r2(s.pos * 100)}%`).join(', ');
  const t = { l: 0, t: 0, r: 0, b: 0, ...g.tile };
  if (g.kind === 'radial') {
    const f = { l: 0.5, t: 0.5, r: 0.5, b: 0.5, ...(g.focus && { l: 0, t: 0, r: 0, b: 0, ...g.focus }) };
    const [fx, fy] = [(f.l + 1 - f.r) / 2, (f.t + 1 - f.b) / 2];
    const rx = Math.max(fx - t.l, 1 - t.r - fx) * w;
    const ry = Math.max(fy - t.t, 1 - t.b - fy) * h;
    return `radial-gradient(${r2(rx)}pt ${r2(ry)}pt at ${r2(fx * 100)}% ${r2(fy * 100)}%, ${stops})`;
  }
  const a = ((g.angle ?? 90) * Math.PI) / 180;
  const deg = g.scaled ? (Math.atan2(h * Math.cos(a), -w * Math.sin(a)) * 180) / Math.PI : (g.angle ?? 90) + 90;
  // The tile: the gradient spans it; beyond it the end colours carry on.
  const [tw, th] = [1 - t.l - t.r, 1 - t.t - t.b];
  const pos = (lo, hi) => (Math.abs(lo + hi) < 1e-9 ? 0 : r2((lo / (lo + hi)) * 100));
  const tiled = tw !== 1 || th !== 1 || t.l || t.t;
  return `linear-gradient(${r2(((deg % 360) + 360) % 360)}deg, ${stops})${tiled ? ` ${pos(t.l, t.r)}% ${pos(t.t, t.b)}% / ${r2(tw * 100)}% ${r2(th * 100)}% no-repeat` : ''}`;
}

/** A text box's background (attrs `a`, lengths in pt): Word's gradient while fill is still its middle colour, a pattern, texture or
 * picture fill as Fill Effects draws it (page-background/model.mjs fillCss), else its colour or transparent. */
export function boxBackground(a) {
  const g = a.gradient;
  if (g?.stops?.length && typeof a.fill === 'string' && a.fill.toUpperCase() === String(g.color).toUpperCase()) return gradientCss(g, a.w ?? 144, a.h ?? 72);
  const f = a.fill && typeof a.fill === 'object' ? fillCss(a.fill) : null;
  if (f) return `${f.image} ${f.position ?? '0 0'} / ${f.size} ${f.repeat}`;
  return typeof a.fill === 'string' && a.fill !== 'none' ? a.fill : 'transparent';
}

// Per text direction: the inner block's writing mode and orientation, and the outer flex direction with which end is Top.
const DIR_CSS = {
  lrTb: { mode: null, flex: 'column', top: 'flex-start', bottom: 'flex-end' },
  tbRl: { mode: 'vertical-rl', flex: 'row', top: 'flex-end', bottom: 'flex-start' },
  btLr: { mode: 'sideways-lr', flex: 'row', top: 'flex-start', bottom: 'flex-end' },
  stacked: { mode: 'vertical-rl', orient: 'upright', flex: 'row', top: 'flex-end', bottom: 'flex-start' },
};

/** CSS of a text box from its attrs → {outer, inner} (property → value): the box (size, inset as padding, fill, line, effects,
 * rotation; a flex container that places the text by vAlign) and its text (writing mode by dir). Lengths go to layout px. */
export function boxCss(a) {
  const d = DIR_CSS[a.dir] ?? DIR_CSS.lrTb;
  const { t = 0, r = 0, b = 0, l = 0 } = a.inset ?? {};
  const line = a.line && a.line.width ? `${px(a.line.width)} ${DASH[a.line.dash] ?? 'dashed'} ${a.line.color}` : 'none';
  const outer = {
    display: 'flex', 'flex-direction': d.flex, 'justify-content': a.vAlign === 'center' ? 'center' : d[a.vAlign === 'bottom' ? 'bottom' : 'top'],
    width: a.noWrap ? 'max-content' : px(a.w), 'min-width': a.noWrap ? px(a.w) : null,
    height: a.autoFit ? null : px(a.h), 'min-height': a.autoFit ? px(a.h) : null,
    padding: `${px(t)} ${px(r)} ${px(b)} ${px(l)}`, background: boxBackground(a), border: line,
    // A box whose bodyPr says vertOverflow="overflow" shows its text past its bottom; document.css clips the rest.
    overflow: a.overflow === 'overflow' ? 'visible' : null,
    ...effectsCss(a.effects),
  };
  if (a.rotate) outer.transform = [outer.transform, `rotate(${a.rotate}deg)`].filter(Boolean).join(' ');
  const inner = {
    'writing-mode': d.mode, 'text-orientation': d.orient ?? null, 'white-space': a.noWrap ? 'pre' : null,
    // Do not rotate text: the text stays level while the box turns.
    transform: a.upright && a.rotate ? `rotate(${-a.rotate}deg)` : null,
  };
  return { outer, inner };
}

/** CSS of styled text preset `p` ({color, effects}) for gallery previews (property → value). The document's text is drawn by the
 * font package from textStyle effects; this copy only draws the menu samples.
 * ponytail: previews skip reflection, which needs an inline block. */
export function previewCss(p) {
  const e = p.effects ?? {};
  const shadows = [];
  if (e.shadow) shadows.push(`${offset(e.shadow)} ${e.shadow.blur ?? 4}pt ${rgba(e.shadow.color, e.shadow.alpha ?? 0.6)}`);
  if (e.glow?.size) shadows.push(`0 0 ${e.glow.size}pt ${rgba(e.glow.color, e.glow.alpha ?? 0.6)}`);
  return {
    color: p.color, '-webkit-text-fill-color': e.fill?.type === 'solid' ? e.fill.color : e.fill?.type === 'none' ? 'transparent' : null,
    '-webkit-text-stroke': e.outline?.width ? `${e.outline.width}pt ${e.outline.color}` : null, 'text-shadow': shadows.join(', ') || null,
  };
}

/** `css` (property → value) as a React style object: camelCase keys, -webkit- as Webkit, nulls dropped. */
export const reactStyle = (css) => Object.fromEntries(Object.entries(css).filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => [k.replace(/^-webkit-/, 'Webkit-').replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
