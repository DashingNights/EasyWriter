// Shapes and Shape Format (docs/plans/word/plan.md §3 shapes, briefs/shapes.md): Insert > Shapes as canvases holding one shape,
// the drawing canvas commands, and the Shape Format tab's Insert Shapes, Shape Styles, Shape Effects and Size groups with the
// Format Shape pane, for canvases and text boxes. Canvas writes go through canvas.js (target.js); canvas.js, whiteboard.js and
// src/flow stay as they are.
import { both } from '../../../tooling/engine-provider.mjs';
import { createElement as h } from 'react';
import { Shapes, Slash, TextCursorInput } from 'lucide-react';
import { canvasEditor, openCanvasEditor } from '../../../canvas.js';
import { SHAPE_SECTIONS } from '../../../flow/shapes.mjs';
import { UNITS, unitOf } from '../../../tooling/kit/units.mjs';
import { commandOf, galleryOf, run } from '../../../tooling/registry.js';
import { gallerySections, inGallery, kindEntry, librarySections, LINE_SHAPES, lineEntry, recentWith } from '../../../tooling/shape-picker.mjs';
import { ShapeIcon as KindIcon, ShapeList } from '../../../tooling/ShapePicker.jsx';
import { arm } from './crosshair.js';
import { changedShape, DASH_MAP, defaultOf, HEAD_MAP, PX, SHAPE_MAP, shadowGallery, shapeItem, styleGallery, WEIGHTS, weightLabel } from './map.mjs';
import { forgetChanges, lookFor, looksIn } from './looks.js';
import { withObjectDefault } from '../design/model.mjs';
import { linkColor } from '../../docx/dml.mjs';
import { THEME } from '../../defaults.mjs';
import { CANVAS_ONLY, chosen, commitCanvas, drawIn, lookOf, oneShape, patchBox, patchItems, setSize, sizeOf, targetOf } from './target.js';
import { FormatShapePane, ShapeIcon, StyleSwatch } from './ui.jsx';

const P = 'shapeFormat.shapeStyles';
const FILL = `${P}.shapeFill`;
const LINE = `${P}.shapeOutline`;
// Recently Used Shapes, Word's first row: the last shapes inserted, newest first, starting from the row Word shows on a new profile
// (probe/menus/insert.shapes.json) and as long. ponytail: kept this session only; keep it in settings if users miss it after a restart.
const WORD_RECENT = ['Text Box', 'Vertical Text Box', 'Line', 'Line Arrow', 'Rectangle', 'Oval', 'Rectangle: Rounded Corners', 'Isosceles Triangle',
  'Connector: Elbow', 'Connector: Elbow Arrow', 'Arrow: Right', 'Arrow: Down', 'Freeform: Shape', 'Freeform: Scribble', 'Arc', 'Curve', 'Left Brace', 'Right Brace'];
let recent = WORD_RECENT;
const remember = (name) => (recent = recentWith(recent, name, WORD_RECENT.length));
// Shape Fill's and Shape Outline's main part apply the last colour picked, as Word's do; until one is, the document's default shape's.
let lastFill = null;
let lastLine = null;
const fillNow = (ctx) => lastFill ?? lookFor(ctx.ed, 'shape').fillColor;
const lineNow = (ctx) => lastLine ?? lookFor(ctx.ed, 'shape').color;

const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const fillable = (it) => it.type === 'shape' && !['line', 'arrow', 'brace'].includes(it.shape);
const lineish = (it) => it.type === 'connector' || (it.type === 'shape' && (it.shape === 'line' || it.shape === 'arrow'));
const on = (ctx) => !!targetOf(ctx);
const boxOnly = { enabled: (ctx) => targetOf(ctx)?.kind === 'textbox', reason: (ctx) => (targetOf(ctx)?.kind === 'canvas' ? CANVAS_ONLY : null) };

// --- picking a shape ---

/** Insert > Shapes: with a drawing canvas edited or selected, its board's tool for the shape (target.js drawIn); else a text box, a
 * drawing canvas with a board tool on (the pen, Curve, Freeform: Shape), or the crosshair that draws a one-shape canvas. */
function insertShape(ctx, name) {
  const m = SHAPE_MAP[name];
  if (!m || !ctx.ed) return false;
  remember(name);
  if (drawIn(ctx, name)) return true;
  if (m.tool === 'textBox') return ctx.run('insert.text.textBox.drawHorizontalTextBox');
  if (m.tool === 'verticalTextBox') return ctx.run('insert.text.textBox.drawVerticalTextBox');
  if (m.tool) {
    ctx.run('insert.illustrations.shapes.newDrawingCanvas');
    canvasEditor.get()?.board.setMode(m.tool); // Curve and Freeform: Shape draw in the document's looks (looks.js), as from the rail
    return true;
  }
  arm(ctx.ed, name);
  return true;
}

/** Shape Format > Insert Shapes: as Insert > Shapes, except with a one-shape canvas selected (not edited), where a shape goes in
 * it beside the one it holds. */
function addToCanvas(ctx, name) {
  const t = targetOf(ctx);
  const m = SHAPE_MAP[name];
  if (t?.kind !== 'canvas' || t.session || !oneShape(t.attrs) || !m || m.tool) return insertShape(ctx, name);
  remember(name);
  const [one] = t.attrs.items;
  const side = 72 * PX / t.k;
  const item = shapeItem(name, { x: (one.x ?? 0) + (one.w ?? 0) + 16, y: 0, w: side, h: side }, {}, looksIn(ctx.ed));
  return commitCanvas(t, [one, item]); // the canvas refits around both
}

// --- writes for both kinds of target ---

function applyFill(ctx, color) {
  const t = targetOf(ctx);
  if (!t) return false;
  if (color) lastFill = color;
  if (t.kind === 'textbox') return patchBox(t, { fill: color });
  return patchItems(t, (it) => (fillable(it) ? (color ? { fill: 'solid', fillColor: color } : { fill: 'none' }) : null));
}

function applyLine(ctx, patch) {
  const t = targetOf(ctx);
  if (!t) return false;
  if (t.kind === 'textbox') {
    return patchBox(t, (a) => {
      if ('color' in patch && patch.color == null) return { line: null }; // No Outline: the text box draws no border
      return { line: { color: '#000000', width: 0.75, dash: 'solid', ...a.line, ...patch } };
    });
  }
  const px = (pt) => Math.round(((pt * PX) / t.k) * 100) / 100;
  return patchItems(t, (it) => ({
    ...('color' in patch && { color: patch.color ?? 'transparent' }),
    ...('width' in patch && { width: px(patch.width) }),
    ...('dash' in patch && { dash: DASH_MAP[patch.dash]?.[1] ?? 'solid' }),
  }));
}

function applyStyle(ctx, id) {
  const s = styleGallery(theme()).find((x) => x.id === id);
  const t = targetOf(ctx);
  if (!s || !t) return false;
  const p = s.patch;
  if (t.kind === 'textbox') {
    return patchBox(t, (a) => ({ fill: p.fill === 'none' ? null : p.fillColor, line: { ...a.line, color: p.color, width: p.width / PX, dash: p.dash } }));
  }
  const width = p.width / t.k;
  return patchItems(t, (it) => (it.type === 'shape' ? { ...(fillable(it) ? p : { color: p.color, dash: p.dash }), width }
    : it.type === 'connector' ? { color: p.color, width, dash: p.dash } : null));
}

// Shape Effects on a text box (the textbox package draws them through CSS): each item toggles its effect.
const EFFECTS = {
  shadow: ['Shadow', { color: '#000000', alpha: 0.4, blur: 4, dist: 3, dir: 45 }],
  reflection: ['Reflection', { size: 50, dist: 0, alpha: 0.5 }],
  glow: ['Glow', { size: 5, alpha: 0.6 }], // in the document's Accent 1 (effectOn)
  softEdges: ['Soft Edges', { size: 2.5 }],
  bevel: ['Bevel', { type: 'circle', w: 6, h: 6 }],
  rotation3d: ['3-D Rotation', { preset: 'isometricLeftDown' }],
};

const ACCENT1 = { el: 'schemeClr', attrs: { val: 'accent1' }, mods: [] };
/** Text box attrs `a` with effect `id` toggled. Glow takes the document's Accent 1 and keeps it as a theme link, as the default looks'
 * colours do (map.mjs defaultLooks), so Design > Colors recolours it and export writes the scheme colour. */
function effectOn(ctx, a, id) {
  if (a.effects?.[id] || id !== 'glow') return { effects: { ...a.effects, [id]: a.effects?.[id] ? null : EFFECTS[id][1] } };
  const color = linkColor(ACCENT1, ctx.ed?.state.doc.attrs.theme?.colors ?? THEME.colors);
  return { effects: { ...a.effects, glow: { ...EFFECTS.glow[1], color } }, themeColors: { ...a.themeColors, 'effects.glow.color': { ...ACCENT1, color } } };
}

const GRADIENTS = [['linearDown', 'Linear Down', 90], ['linearRight', 'Linear Right', 0], ['linearUp', 'Linear Up', 270], ['linearLeft', 'Linear Left', 180], ['fromCenter', 'From Center', null]];

/** Shape Fill's value-mode dialogs on a text box: the fill they return becomes textBox.fill. */
async function fillDialog(ctx, id, props) {
  const t = targetOf(ctx);
  if (t?.kind !== 'textbox') return false;
  const v = await ctx.dialog(id, { mode: 'value', value: t.node.attrs.fill, ...props });
  if (!v) return false;
  const fill = id === 'insertPictures' ? { kind: 'picture', src: v.src } : v;
  return patchBox(targetOf(ctx) ?? t, { fill });
}

async function moreColors(ctx, key) {
  const look = lookOf(targetOf(ctx));
  const hex = await ctx.dialog('colors', { value: (key === 'fill' ? look?.fill : look?.line) ?? '#000000' });
  return hex ? ctx.run(key === 'fill' ? FILL : LINE, { color: hex }) : false;
}

// --- size ---

const lenStep = (ctx) => 0.1 * UNITS[unitOf(ctx.settings, ctx.profile, ctx.T?.unit?.name)];
const sizeCmd = (side) => ({
  run: (ctx, pt) => setSize(targetOf(ctx), side, pt),
  enabled: (ctx) => on(ctx) && !(targetOf(ctx)?.kind === 'canvas' && oneShape(targetOf(ctx).attrs) && targetOf(ctx).attrs.items[0].type === 'connector'),
  reason: (ctx) => (on(ctx) ? 'A line takes its size from its ends.' : null),
  value: (ctx) => {
    const s = sizeOf(targetOf(ctx));
    return s ? Math.round(s[side] * 100) / 100 : null;
  },
});
const stepCmd = (side, dir) => ({
  run: (ctx) => {
    const s = sizeOf(targetOf(ctx));
    return s && setSize(targetOf(ctx), side, Math.max(1, s[side] + dir * lenStep(ctx)));
  },
  enabled: on,
});

// --- Set as Default ---

// Set as Default Shape, Line and Text Box (the shape's right-click menu, as Word's): the one chosen shape's, line's or text box's look
// becomes the document's default for new ones (its theme's objectDefaults, design/model.mjs; one undo step), and the rail card's
// changes to the tools that draw it this session give way to it.
const isLine = (it) => it.type === 'connector' || it.shape === 'line' || it.shape === 'arrow';
/** The object default `key` would be taken from in `ctx` (one chosen board item, or a text box's attrs), or null. */
function defaultSource(ctx, key) {
  const t = targetOf(ctx);
  if (key === 'txDef') return t?.kind === 'textbox' ? t.node.attrs : null;
  const items = t?.kind === 'canvas' ? chosen(t) : [];
  const it = items.length === 1 ? items[0] : null;
  if (!it || !['shape', 'connector'].includes(it.type)) return null;
  return isLine(it) === (key === 'lnDef') ? it : null;
}
const setDefault = (key, label, icon, keywords) => ({
  run: (ctx) => {
    const o = defaultSource(ctx, key);
    if (!o || !ctx.ed) return false;
    const look = defaultOf(key, o, key === 'txDef' ? 1 : targetOf(ctx).k);
    const { state, view } = ctx.ed;
    view.dispatch(state.tr.setDocAttribute('theme', withObjectDefault(state.doc.attrs.theme, key, look)));
    forgetChanges(ctx.ed, key);
    return true;
  },
  enabled: (ctx) => !!defaultSource(ctx, key),
  meta: { label, group: 'Shape Format', icon, keywords: ['set as default', 'default', 'new shapes look', 'make default', ...keywords] },
});
const DEFAULTS = {
  'contextMenu.shape.setAsDefaultShape': setDefault('spDef', 'Set as Default Shape', Shapes, ['default shape', 'shape style']),
  'contextMenu.shape.setAsDefaultLine': setDefault('lnDef', 'Set as Default Line', Slash, ['default line', 'line style', 'connector']),
  'contextMenu.shape.setAsDefaultTextBox': setDefault('txDef', 'Set as Default Text Box', TextCursorInput, ['default text box', 'text box style']),
};

// --- commands ---

const COMMANDS = {
  'insert.illustrations.shapes': { run: (ctx, name) => (name ? insertShape(ctx, name) : false), enabled: (ctx) => !!ctx.ed },
  'draw.insert.drawingCanvas': { run: (ctx) => ctx.run('insert.illustrations.shapes.newDrawingCanvas'), enabled: (ctx) => !!ctx.ed },

  'shapeFormat.insertShapes.insertShapes': { run: (ctx, name) => (name ? addToCanvas(ctx, name) : false), enabled: (ctx) => !!ctx.ed },
  'shapeFormat.insertShapes.editShape': { run: (ctx) => ctx.run('shapeFormat.insertShapes.editShape.editPoints'), ...canvasOnly() },
  'shapeFormat.insertShapes.editShape.editPoints': {
    run: (ctx) => {
      const t = targetOf(ctx);
      if (t?.kind !== 'canvas') return false;
      if (!t.session) openCanvasEditor(ctx.ed, t.pos);
      const first = chosen(t)[0];
      if (first) canvasEditor.get()?.board.select(first.id);
      return true;
    },
    ...canvasOnly(),
  },
  'shapeFormat.insertShapes.editShape.rerouteConnectors': {
    run: (ctx) => patchItems(targetOf(ctx), (it) => (it.type === 'connector' ? { points: [] } : null)),
    enabled: (ctx) => targetOf(ctx)?.kind === 'canvas' && targetOf(ctx).attrs.items.some((i) => i.type === 'connector'),
    reason: (ctx) => (targetOf(ctx)?.kind === 'textbox' ? 'A text box has no connectors.' : targetOf(ctx) ? 'This canvas has no connectors.' : null),
  },
  'shapeFormat.insertShapes.addText': {
    run: (ctx) => {
      const t = targetOf(ctx);
      if (t?.kind === 'textbox') return ctx.chain((c) => c.setTextSelection(t.pos + 2));
      if (t?.kind !== 'canvas') return false;
      const it = chosen(t).find((i) => i.type === 'shape' || i.type === 'connector');
      if (!t.session) openCanvasEditor(ctx.ed, t.pos);
      const board = canvasEditor.get()?.board;
      if (!board || !it) return !!board;
      board.select(it.id);
      if (it.type === 'connector') board.editLabel(it.id, 'mid');
      else board.startEdit(it.id);
      return true;
    },
    enabled: on,
  },

  [`${P}.shapeStyles`]: { run: (ctx, id) => applyStyle(ctx, id), enabled: on },
  [FILL]: { run: (ctx, arg) => applyFill(ctx, arg === undefined ? fillNow(ctx) : arg?.color ?? null), enabled: on, value: fillNow, repeatable: true },
  [`${FILL}.moreFillColors`]: { run: (ctx) => moreColors(ctx, 'fill'), enabled: on },
  [`${FILL}.picture`]: { run: (ctx) => fillDialog(ctx, 'insertPictures'), ...boxOnly },
  [`${FILL}.gradient`]: {
    run: (ctx, id) => {
      const g = GRADIENTS.find(([k]) => k === id);
      const t = targetOf(ctx);
      if (!g || t?.kind !== 'textbox') return false;
      const base = lookOf(t)?.fill ?? fillNow(ctx);
      const stops = [{ pos: 0, color: base }, { pos: 1, color: '#FFFFFF' }];
      return patchBox(t, { fill: g[2] == null ? { kind: 'gradient', type: 'radial', stops } : { kind: 'gradient', type: 'linear', angle: g[2], stops } });
    },
    ...boxOnly,
  },
  [`${FILL}.gradient.moreGradients`]: { run: (ctx) => fillDialog(ctx, 'fillEffects', { tab: 'gradient' }), ...boxOnly },
  [`${FILL}.texture`]: { run: (ctx) => fillDialog(ctx, 'fillEffects', { tab: 'texture' }), ...boxOnly },
  [`${FILL}.texture.moreTextures`]: { run: (ctx) => fillDialog(ctx, 'fillEffects', { tab: 'texture' }), ...boxOnly },
  [`${FILL}.pattern`]: { run: (ctx) => fillDialog(ctx, 'fillEffects', { tab: 'pattern' }), ...boxOnly },

  [LINE]: { run: (ctx, arg) => {
    const color = arg === undefined ? lineNow(ctx) : arg?.color ?? null;
    if (color) lastLine = color;
    return applyLine(ctx, { color });
  }, enabled: on, value: lineNow, repeatable: true },
  [`${LINE}.moreOutlineColors`]: { run: (ctx) => moreColors(ctx, 'line'), enabled: on },
  [`${LINE}.weight`]: {
    run: (ctx, pt) => (Number.isFinite(+pt) && +pt >= 0 ? applyLine(ctx, { width: +pt }) : false),
    enabled: on,
    value: (ctx) => {
      const w = lookOf(targetOf(ctx))?.width;
      return WEIGHTS.find((x) => Math.abs(x - w) < 0.01) ?? null;
    },
  },
  [`${LINE}.weight.moreLines`]: { run: (ctx) => ctx.pane('formatShape', true, { section: 'line' }), enabled: on },
  [`${LINE}.dashes`]: { run: (ctx, id) => (DASH_MAP[id] ? applyLine(ctx, { dash: id }) : false), enabled: on },
  [`${LINE}.dashes.moreLines`]: { run: (ctx) => ctx.pane('formatShape', true, { section: 'line' }), enabled: on },
  [`${LINE}.arrows`]: {
    run: (ctx, id) => {
      const heads = HEAD_MAP[id];
      const t = targetOf(ctx);
      if (!heads || t?.kind !== 'canvas') return false;
      const arrow = heads.start !== 'none' || heads.end !== 'none';
      return patchItems(t, (it) => (it.type === 'connector' ? { heads: { ...heads } } : lineish(it) ? { shape: arrow ? 'arrow' : 'line' } : null));
    },
    enabled: (ctx) => targetOf(ctx)?.kind === 'canvas' && chosen(targetOf(ctx)).some(lineish),
    reason: (ctx) => (on(ctx) ? 'Arrowheads go on lines and connectors.' : null),
  },
  [`${LINE}.pattern`]: { run: () => false, enabled: () => false, reason: (ctx) => (on(ctx) ? 'Patterned outlines are not drawn yet.' : null) },
  [`${P}.changeShape`]: {
    run: (ctx, name) => patchItems(targetOf(ctx), (it) => changedShape(it, name)),
    enabled: (ctx) => targetOf(ctx)?.kind === 'canvas' && chosen(targetOf(ctx)).some((i) => i.type === 'shape'),
    reason: (ctx) => (targetOf(ctx)?.kind === 'textbox' ? 'A text box keeps its rectangle.' : on(ctx) ? 'Lines and pictures keep their shape.' : null),
  },
  [`${P}.launcher`]: { run: (ctx) => ctx.pane('formatShape', true, { section: 'fill' }), enabled: on },
  [`${P}.shapeEffects`]: {
    run: (ctx, id) => {
      const t = targetOf(ctx);
      if (!EFFECTS[id] || t?.kind !== 'textbox') return false;
      return patchBox(t, (a) => effectOn(ctx, a, id));
    },
    ...boxOnly,
  },

  ...DEFAULTS,
  'shapeFormat.size.shapeHeight': sizeCmd('h'),
  'shapeFormat.size.shapeWidth': sizeCmd('w'),
  'shapeFormat.size.shapeHeight.more': stepCmd('h', 1),
  'shapeFormat.size.shapeHeight.less': stepCmd('h', -1),
  'shapeFormat.size.shapeWidth.more': stepCmd('w', 1),
  'shapeFormat.size.shapeWidth.less': stepCmd('w', -1),
};

function canvasOnly() {
  return { enabled: (ctx) => targetOf(ctx)?.kind === 'canvas', reason: (ctx) => (targetOf(ctx)?.kind === 'textbox' ? 'A text box has no points to edit.' : null) };
}

// --- galleries ---

// The shapes gallery's items: a shape of the library (src/flow/shapes.mjs) is its kind, drawn by the shape picker's icon, under the
// name every picker gives it; Word's own entries (its lines, text boxes and freeform tools) keep Word's drawings (ui.jsx).
const ownTools = (test) => Object.keys(SHAPE_MAP).filter((n) => !SHAPE_MAP[n].kind && test(SHAPE_MAP[n]));
const LINES = Object.keys(LINE_SHAPES);
const TEXT_BOXES = ownTools((m) => m.tool === 'textBox' || m.tool === 'verticalTextBox');
const LINES_TITLE = SHAPE_SECTIONS.find((s) => s.id === 'lines').title;
function shapeEntry(name, group) {
  const e = SHAPE_MAP[name].kind && kindEntry(SHAPE_MAP[name].kind);
  // Word's lines search by the same words as the board's Lines entries (a text box has none).
  if (!e) return { id: name, label: name, group, keywords: lineEntry(name)?.keywords, preview: h(ShapeIcon, { name }), tile: h(ShapeIcon, { name, label: false }) };
  const preview = h('span', { className: 'flex min-w-0 items-center gap-2' }, h(KindIcon, { shape: e.kind }), h('span', { className: 'truncate' }, name));
  return { id: name, label: name, group, kind: e.kind, keywords: e.keywords, preview, tile: h(KindIcon, { shape: e.kind }) };
}
// The library's sections with the presets of Word's gallery, Word's Lines first and its text boxes leading Basic Shapes; built once.
let listed = null;
const libraryItems = () => (listed ??= [
  ...LINES.map((n) => shapeEntry(n, LINES_TITLE)),
  ...librarySections(inGallery).flatMap((s) => [...(s.id === 'basic' ? TEXT_BOXES : []), ...s.entries.map((e) => e.label)].map((n) => shapeEntry(n, s.title))),
]);
/** The shapes gallery: Recently Used Shapes, then the library's sections as above; `lines` false leaves out the recent row, the
 * lines and the text box and pen tools (Change Shape). */
function shapesGallery(lines = true) {
  if (!lines) return libraryItems().filter((it) => it.kind);
  return [...recent.map((n) => shapeEntry(n, 'Recently Used Shapes')), ...libraryItems()];
}

/** Insert Shapes' and Change Shape's dropdown: the shape picker over the gallery's items (menus.jsx draws a gallery that has a panel
 * of its id as that panel, so the profile's grants apply as to any gallery). A pick runs the gallery's command with the shape's name. */
// It lists its gallery (galleryOf), which serves canvas drafts too.
ShapesMenu.engine = true;
function ShapesMenu({ ctx, cmd, close, pick, gallery }) {
  const owner = commandOf(gallery) ? gallery : cmd;
  const go = pick ?? ((fn) => (fn(), close?.()));
  return h(ShapeList, { layout: 'menu', sections: gallerySections(galleryOf(gallery, ctx)), onPick: (e) => go(() => run(owner, e.id)) });
}

const outlineNow = (ctx) => ctx.read('object.get', {})?.shape?.outline;
const styleItems = (t) => styleGallery(t).map(({ id, label, group, patch }) => ({ id, label, group, preview: h(StyleSwatch, { patch }) }));

const GALLERIES = {
  'insert.illustrations.shapes': both(() => shapesGallery()),
  'shapeFormat.insertShapes.insertShapes': both(() => shapesGallery()),
  [`${P}.changeShape`]: both(() => shapesGallery(false)),
  // A canvas draft's Word shapes take the light presets, as its rows apply them (canvas/rows/objects.mjs shapeStyleSteps).
  [`${P}.shapeStyles`]: both(() => styleItems(theme()), () => styleItems('light')),
  // ponytail: Text Box Styles shows the app's Shape Styles. Word's 70 looks cannot be read through its object model (ShapeStyle is not
  // implemented on a VML text box), so take them from a UI probe if they are ever wanted.
  'textBox.textBoxStyles.textBoxStyles': both(() => [], () => styleItems('light')),
  'shapeFormat.shadowEffects.shadowEffects': both(() => [], (ctx) => shadowGallery(ctx.read('object.get', {})?.shape?.effects?.shadow ?? null)),
  [`${LINE}.weight`]: both((ctx) => {
    const w = lookOf(targetOf(ctx))?.width;
    return WEIGHTS.map((pt) => ({ id: String(pt), label: weightLabel(pt), active: Math.abs(pt - w) < 0.01 }));
  }, (ctx) => WEIGHTS.map((pt) => ({ id: String(pt), label: weightLabel(pt), active: Math.abs(pt - (outlineNow(ctx)?.width ?? -1)) < 0.01 }))),
  [`${LINE}.dashes`]: both(() => Object.entries(DASH_MAP).map(([id, [label]]) => ({ id, label }))),
  [`${LINE}.arrows`]: both(() => Object.keys(HEAD_MAP).map((id, i) => ({ id, label: `Arrow Style ${i + 1}`, desc: `${HEAD_MAP[id].start} to ${HEAD_MAP[id].end}` }))),
  [`${FILL}.gradient`]: both(() => GRADIENTS.map(([id, label]) => ({ id, label }))),
  // The canvas engine draws a shape's shadow, glow and soft edges (canvas/rows/objects.mjs SHAPE_EFFECTS).
  [`${P}.shapeEffects`]: both((ctx) => {
    const t = targetOf(ctx);
    const fx = t?.kind === 'textbox' ? t.node.attrs.effects ?? {} : {};
    return Object.entries(EFFECTS).map(([id, [label]]) => ({ id, label, active: !!fx[id] }));
  }, (ctx) => {
    const fx = ctx.read('object.get', {})?.shape?.effects ?? {};
    return [['shadow', 'shadow'], ['glow', 'glow'], ['softEdges', 'softEdge']].map(([id, key]) => ({ id, label: EFFECTS[id][0], active: !!fx[key] }));
  }),
};

export default {
  id: 'shapes',
  commands: COMMANDS,
  galleries: GALLERIES,
  panes: { formatShape: { title: 'Format Shape', side: 'right', width: 18, Component: FormatShapePane } },
  panels: { 'insert.illustrations.shapes': ShapesMenu, 'shapeFormat.insertShapes.insertShapes': ShapesMenu, [`${P}.changeShape`]: ShapesMenu },
};
