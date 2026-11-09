// The Objects package's rows of the Documents engine table (docs/plans/engine/stage2.md): pictures, shapes, text boxes, ink,
// equations, wrapping and arrange (S2). Only that package edits this file. Rows by tooling id in the forms of forms.mjs (APP,
// exec, off, a CommandSpec); commands.mjs joins them. Pure: node tests load it (the picture pickers load on first use).
//
// Word's meaning wins over a same-named engine id: Bring Forward and Send Backward change the stacking order (`arrange.order`),
// not the wrap (`arrange.bringForward` sets In Front of Text); Align and Position store Word's alignment (`arrange.align`,
// `arrange.position` presets), not an offset. The selected object's properties come from `object.get` (ctx.read).
import { APP, exec, off } from './forms.mjs';
import { textEffectsDialog } from './home.mjs';
import { GALLERY } from '../../../flow/gallery.mjs';
import { transparencyOf, withTransparency } from '../../../tooling/kit/color.mjs';
import { UNITS, unitOf } from '../../../tooling/kit/units.mjs';
import { REASONS } from '../../../tooling/reasons.mjs';
import { BUILT_INS, STRUCTURES, SYMBOL_SETS } from '../../wp/equations/templates.mjs';
import { THEME } from '../../defaults.mjs';
import { activeTool } from '../tools/state.mjs';
import { diagramLook, diagramOf } from '../smart-art/state.mjs';
import { ruler } from '../tools/ink.js';
import { dialogFill, engineFill } from '../../wp/page-background/engine-fill.mjs';
import { nudgedShadow, PX, shadowParams, SHADOW_ON, SHADOW_STYLES, styleGallery } from '../../wp/shapes/map.mjs';
import { effectParams, graphicColour, graphicStyle, hex6, outlineParams, recolouredSvg, styleOf, styleSteps } from '../../wp/picture-format/engine.mjs';
import { ARTISTIC, WEIGHTS } from '../../wp/picture-format/pictures.mjs';
import { signatureAlt, signatureData } from '../signature-line.mjs';
import { themeOfSettings } from '../../wp/styles/engine.mjs';

// ---------------------------------------------------------------------------------------------
// Shared helpers

/** A row that turns page tool `name` on (or off again) on a canvas draft: `make(arg, ctx)` → the tool factory, from the tools'
 * files (src/document/canvas/tools, loaded on first use), or null to do nothing (engine-page-tools). */
const toolRow = (name, make, { need = () => true, reason = null } = {}) => ({
  async run(ctx, arg) {
    const { toggleTool } = await import('../tools/index.js');
    const m = await make(arg, ctx);
    return !!m && toggleTool(ctx, name, m);
  },
  enabled: (ctx) => !!ctx.engine && need(ctx),
  reason: (ctx) => (need(ctx) ? null : reason),
  active: () => activeTool() === name,
});

/** '#RRGGBB', {color} or 'RRGGBB' → the engine's 'RRGGBB'; null for none. */
export const hexOf = (c) => {
  const v = typeof c === 'object' && c ? c.color : c;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(v ?? ''));
  return m ? m[1].toUpperCase() : null;
};
const css = (h) => (h ? `#${h}` : null);
/** The selected object's properties (`object.get`) for drawing a control: null until the engine answers or with none selected. */
export const objOf = (ctx) => ctx.read?.('object.get', {}) ?? null;
/** The same, read now: a command acts on what the object is, not on the last drawn reading. */
export const objNow = async (ctx) => (await ctx.engine.query?.('object.get', {}))?.value ?? null;
const ok = (r) => !!r?.ok;
export const run1 = (ctx, id, args = {}) => Promise.resolve(ctx.engine.exec(id, args)).then(ok, () => false);
const runMany = (ctx, steps) => Promise.resolve(ctx.engine.execMany(steps)).then(ok, () => false);
/** Points one step of a size spinner moves: a tenth of the user's unit, as the DOM editor's spinners. */
const stepPt = (ctx) => 0.1 * UNITS[unitOf(ctx.settings, ctx.profile)];
export const kindIs = (...kinds) => (ctx) => kinds.includes(ctx.obj?.kind);
/** A CommandSpec that needs an engine and, when `need` says no, gives `reason`. */
export const spec = (run, { need = () => true, reason = null, active, value } = {}) => ({
  run,
  enabled: (ctx) => !!ctx.engine && need(ctx),
  reason: (ctx) => (need(ctx) ? null : reason),
  ...(active && { active }),
  ...(value && { value }),
});
/** A row that opens a pane or dialog that still reads the DOM editor: disabled with its own reason until it reads the engine. */
const domOnly = (what) => off(`${what} does not work on canvas drafts yet.`);
/** Insert > Boards on a canvas draft: the app's insert (flows.js insertCanvasBox and insertFlowchartDialog, plans.js
 * insertPlanChartDialog, loaded on first use), which puts a box at the caret of the open canvas draft. */
const flows = () => import('../../../app/flows.js');
const boxInsert = (insert) => spec(async () => {
  await insert();
  return true;
});

const PICK_PICTURE = 'Select a picture first.';
const PICK_SHAPE = 'Select a shape first.';
const PICK_TEXTBOX = 'Select a text box first.';
const PICK_OBJECT = 'Select a picture or shape first.';
const isPicture = kindIs('picture', 'graphic');
const isShape = kindIs('shape', 'textbox');
const sized = kindIs('shape', 'textbox', 'smartArt');
const isDiagram = kindIs('smartArt');
// A diagram EasyWriter can edit: one from another program has no model, so the rows stay off with their reason.
const shapeOrDiagram = (ctx) => isShape(ctx) || !!diagramOf(ctx);

/** A picture file's base64 from the app's file picker (picture-format/edit.js pickPicture), or null. */
async function pickedPicture(svg = false) {
  const { pickPicture } = await import('../../wp/picture-format/edit.js');
  const r = await pickPicture({ svg });
  return r?.src?.split(';base64,')[1] ?? null;
}
/** The clipboard's picture as base64, or null. */
async function clipboardPicture() {
  const { clipboardApi } = await import('../../wp/picture-format/edit.js');
  const img = (await clipboardApi()?.read?.())?.image;
  return typeof img === 'string' ? img.split(';base64,')[1] ?? null : null;
}

// ---------------------------------------------------------------------------------------------
// Shapes: Insert > Shapes (any DrawingML preset by Word's name), Shape Format's styles and sizes

/** Word's shape name → its DrawingML preset (flow/gallery.mjs, Word's groups and names). */
const PRESET_OF = Object.fromEntries(GALLERY.flatMap((s) => s.shapes.map(([prst, name]) => [name, prst])));
/** Word's Lines group → the engine's insert.shape params. */
const LINES = {
  Line: { kind: 'line' }, 'Line Arrow': { kind: 'line', arrow: 'end' }, 'Line Arrow: Double': { kind: 'line', arrow: 'both' },
  'Connector: Elbow': { kind: 'elbowConnector' }, 'Connector: Elbow Arrow': { kind: 'elbowConnector', arrow: 'end' },
  'Connector: Elbow Double-Arrow': { kind: 'elbowConnector', arrow: 'both' }, 'Connector: Curved': { kind: 'curvedConnector' },
  'Connector: Curved Arrow': { kind: 'curvedConnector', arrow: 'end' }, 'Connector: Curved Double-Arrow': { kind: 'curvedConnector', arrow: 'both' },
};
const DRAWN = new Set(['Curve', 'Freeform: Shape', 'Freeform: Scribble']);

/** The engine steps that insert Word's shape `name` at the caret (one undo step), or null for a shape the engine cannot make. */
export function shapeSteps(name) {
  if (name === 'Text Box') return [['insert.textBox', {}]];
  if (name === 'Vertical Text Box') return [['insert.textBox', {}], ['shape.textDirection', { dir: 'eaVert' }]];
  if (LINES[name]) return [['insert.shape', LINES[name]]];
  const prst = PRESET_OF[name];
  if (!prst) return null;
  return prst === 'rect' ? [['insert.shape', { kind: 'rectangle' }]] : [['insert.shape', { kind: 'rectangle' }], ['shape.change', { preset: prst }]];
}

/** Insert > Shapes: the crosshair for Word's shape `name`; a drag draws it there, a click makes it 1 inch (tools/shapes.js). */
const insertShape = async (ctx, name) => {
  if (DRAWN.has(name)) {
    ctx.toast?.('Curves and freeforms are drawn point by point, which canvas drafts do not take yet.');
    return false;
  }
  const steps = shapeSteps(name);
  if (!steps) return false;
  const [{ startTool }, { crosshair }] = await Promise.all([import('../tools/index.js'), import('../tools/shapes.js')]);
  return startTool(ctx, 'crosshair', crosshair(steps, { line: !!LINES[name] }));
};

/** Insert Frame: the selected text in a frame, or with only a caret the crosshair, whose box becomes an empty frame there. */
async function insertFrame(ctx) {
  const sel = await ctx.engine.selection?.();
  if (sel && JSON.stringify(sel.anchor) !== JSON.stringify(sel.head)) return run1(ctx, 'insert.frame', {});
  const [{ startTool }, { boxTool }] = await Promise.all([import('../tools/index.js'), import('../tools/shapes.js')]);
  return startTool(ctx, 'insertFrame', boxTool((b, page) => run1(ctx, 'insert.frame', { page, x: b.x, y: b.y, width: b.w, height: b.h })));
}

/** Change Shape: a preset by Word's name; a line or connector by its kind. */
const changeShape = (ctx, name) => {
  const prst = PRESET_OF[name];
  if (prst) return run1(ctx, 'shape.change', prst === 'rect' ? { kind: 'rectangle' } : { preset: prst });
  return LINES[name] ? run1(ctx, 'shape.change', { kind: LINES[name].kind }) : false;
};

// Shape Fill's and Shape Outline's main part apply the last colour picked, as Word's do; until one is, the theme's Accent 1 and
// its darker outline (the document's default shape look).
let lastFill = hexOf(THEME.colors?.accent1 ?? '#156082');
let lastLine = '0F4761';
const shapeFill = (ctx, arg, transparency) => {
  const color = arg === undefined ? lastFill : hexOf(arg);
  if (color) lastFill = color;
  if (isDiagram(ctx)) return diagramLook(ctx, { fill: color ?? 'none' });
  return run1(ctx, 'shape.fill', { color, ...(transparency != null && { transparency }) });
};
const shapeLine = (ctx, arg) => {
  const color = arg === undefined ? lastLine : hexOf(arg);
  if (color) lastLine = color;
  if (isDiagram(ctx)) return diagramLook(ctx, { line: color ?? 'none' });
  return run1(ctx, 'shape.outline', { color });
};
/** Shape Fill > Gradient's items (shapes/index.js GRADIENTS): a linear angle, or from the centre. */
const GRADIENTS = { linearDown: 90, linearRight: 0, linearUp: 270, linearLeft: 180, fromCenter: null };
const gradientFill = async (ctx, id) => {
  if (!(id in GRADIENTS)) return false;
  const base = (await objNow(ctx))?.shape?.fill?.color ?? lastFill;
  const stops = [{ pos: 0, color: base }, { pos: 100, color: 'FFFFFF' }];
  const angle = GRADIENTS[id];
  return run1(ctx, 'shape.fill', { gradient: angle == null ? { stops, type: 'radial' } : { stops, type: 'linear', angle } });
};
/** Shape Outline > Arrows (shapes/map.mjs HEAD_MAP): which ends get a head. */
// ponytail: the engine has one head type (a triangle), so styles 5 to 11 (triangle, circle, diamond and bar heads) draw as
// styles 2 to 4 do. Give ShapeExtra a head type per end (DrawingML a:headEnd/a:tailEnd type) when those matter.
const HEADS = {
  style1: [false, false], style2: [false, true], style3: [true, false], style4: [true, true], style5: [false, true], style6: [true, false],
  style7: [true, true], style8: [true, true], style9: [true, true], style10: [true, true], style11: [true, true],
};
/** object.get's dash (DrawingML's name) → the Dashes item: Round Dot is the system dot (with round ends), Square Dot the
 * system dash, and the long ones are spelt out in the gallery. */
const DASH_ID = { sysDot: 'roundDot', sysDash: 'squareDot', lgDash: 'longDash', lgDashDot: 'longDashDot', lgDashDotDot: 'longDashDotDot' };
/** The shapes Word gives arrowheads to (open ones: lines and connectors). */
const LINE_KINDS = new Set(['line', 'straightConnector', 'elbowConnector', 'curvedConnector']);
/** Shape Effects (shapes/index.js EFFECTS): the engine draws shadow, glow and soft edges on shapes. */
const SHAPE_EFFECTS = {
  shadow: (o) => ({ shadow: o?.shape?.effects?.shadow ? null : 'offsetBottomRight' }),
  glow: (o) => ({ glow: o?.shape?.effects?.glow ? null : { size: 5, color: hexOf(THEME.colors?.accent1 ?? '#156082'), transparency: 60 } }),
  softEdges: (o) => ({ softEdge: o?.shape?.effects?.softEdge ? null : 2.5 }),
};

/** A size box: `side` 'h' or 'w' of the selected object, through `id` (arrange.bounds, or picture.size keeping the proportions). */
const sizeRow = (id, side, need, reason) => exec(id, (pt) => ({ [side === 'h' ? 'height' : 'width']: Number(pt) }), {
  state: 'arrange.bounds',
  when: (ctx) => (need(ctx) ? null : reason),
  value: (e) => (e?.value ? Math.round(e.value[side] * 100) / 100 : null),
});
const sizeStep = (id, side, dir, need, reason) => spec(async (ctx) => {
  const now = (await objNow(ctx))?.[side];
  if (now == null) return false;
  return run1(ctx, id, { [side === 'h' ? 'height' : 'width']: Math.max(1, now + dir * stepPt(ctx)) });
}, { need, reason });

/** A shape right-click entry the engine lacks: no reason (so tool search leaves it out) unless a shape is selected. */
const shapeMenuGap = (reason) => ({ run: () => false, enabled: () => false, reason: (ctx) => (isShape(ctx) ? reason : null) });

/** Fill Effects (page-background/FillEffectsDialog.jsx in value mode) on tab `tab`, opened on the selected shape's fill
 * (`now(object)`), its pick applied through `apply(ctx, params)` (engine-fill.mjs gives the engine's params). */
const fillEffects = (tab, apply, now = (o) => dialogFill(o?.shape?.fill)) => spec(async (ctx) => {
  const v = await ctx.dialog('fillEffects', { mode: 'value', value: now(await objNow(ctx)), tab });
  const params = v ? await engineFill(v) : null;
  return !!params && apply(ctx, params);
}, { need: isShape, reason: PICK_SHAPE });
const fillShape = (ctx, params) => run1(ctx, 'shape.fill', params);
/** Shape Outline > Pattern: only the dialog's Pattern tab gives an outline. */
const outlinePattern = (ctx, params) => {
  if (params.pattern) return run1(ctx, 'shape.outline', { pattern: params.pattern });
  ctx.toast?.('An outline takes a pattern only. Pick one on the Pattern tab.');
  return false;
};
/** Shape Styles item `id` (shapes/map.mjs styleGallery) → the engine's steps: the fill (none, the colour, or diagonal hatching
 * in it) and the outline's colour, weight and dash, one undo step. */
export function shapeStyleSteps(id) {
  const p = styleGallery('light').find((s) => s.id === id)?.patch;
  if (!p) return null;
  const fill = p.fill === 'none' ? { color: null } : p.fill === 'hatch' ? { pattern: { preset: 'ltUpDiag', fg: hexOf(p.fillColor), bg: 'FFFFFF' } } : { color: hexOf(p.fillColor) };
  return [['shape.fill', fill], ['shape.outline', { color: hexOf(p.color), width: Math.round((p.width / PX) * 100) / 100, dash: p.dash === 'dashed' ? 'dash' : 'solid' }]];
}
/** A shape or text box selected, or the caret in one's text (Shape Format acts on that box, as in Word). */
const shapeOrText = (ctx) => isShape(ctx) || !!ctx.in?.textbox;
/** Opens the Format Shape pane at `section` (shapes/ui.jsx draws its canvas form from object.get). */
const formatPane = (section) => spec((ctx) => {
  ctx.pane('formatShape', true, { section });
  return true;
}, { need: shapeOrText, reason: PICK_SHAPE });

const SF = 'shapeFormat.shapeStyles';
const DROPDOWN = { run: () => true }; // a menu button: the ribbon opens the menu
const SHAPES = {
  'insert.illustrations.shapes': spec((ctx, name) => (name ? insertShape(ctx, name) : false)),
  'shapeFormat.insertShapes.insertShapes': spec((ctx, name) => (name ? insertShape(ctx, name) : false)),
  'draw.insert.drawingCanvas': 'insert.canvas',
  'shapeFormat.insertShapes.editShape': DROPDOWN,
  'shapeFormat.insertShapes.editShape.editPoints': toolRow('editPoints', async () => (await import('../tools/shapes.js')).editPoints,
    { need: kindIs('shape'), reason: PICK_SHAPE }),
  'shapeFormat.insertShapes.editShape.rerouteConnectors': exec('shape.reroute', {}),
  'shapeFormat.insertShapes.addText': exec('shape.addText', {}, { when: (ctx) => (kindIs('shape')(ctx) ? null : PICK_SHAPE) }),
  [`${SF}.shapeStyles`]: spec((ctx, id) => {
    const steps = shapeStyleSteps(id);
    if (!steps) return false;
    if (isDiagram(ctx)) {
      const [[, f], [, l]] = steps;
      return diagramLook(ctx, { fill: f.color ?? f.pattern?.fg ?? 'none', line: l.color ?? 'none', lineWidth: l.width });
    }
    return runMany(ctx, steps);
  }, { need: shapeOrDiagram, reason: PICK_SHAPE }),
  [`${SF}.shapeFill`]: spec(shapeFill, { need: shapeOrDiagram, reason: PICK_SHAPE, value: (ctx) => css(objOf(ctx)?.shape?.fill?.color ?? lastFill) }),
  // The picker shows the fill's transparency as its opacity (the engine keeps a fill's; an outline has none). A diagram fill
  // has no transparency.
  [`${SF}.shapeFill.moreFillColors`]: spec(async (ctx) => {
    const fill = objOf(ctx)?.shape?.fill;
    const r = transparencyOf(await ctx.dialog('colors', { value: withTransparency(css(fill?.color) ?? css(lastFill), fill?.transparency), alpha: !isDiagram(ctx) }));
    return !!r && shapeFill(ctx, r.color, r.transparency);
  }, { need: shapeOrDiagram, reason: PICK_SHAPE }),
  [`${SF}.shapeFill.picture`]: spec(async (ctx) => {
    const data = await pickedPicture();
    return !!data && fillShape(ctx, { picture: { data } });
  }, { need: isShape, reason: PICK_SHAPE }),
  [`${SF}.shapeFill.gradient`]: spec(gradientFill, { need: isShape, reason: PICK_SHAPE }),
  [`${SF}.shapeFill.gradient.moreGradients`]: fillEffects('gradient', fillShape),
  [`${SF}.shapeFill.texture`]: fillEffects('texture', fillShape),
  [`${SF}.shapeFill.texture.moreTextures`]: fillEffects('texture', fillShape),
  [`${SF}.shapeFill.pattern`]: fillEffects('pattern', fillShape),
  [`${SF}.shapeOutline`]: spec(shapeLine, { need: shapeOrDiagram, reason: PICK_SHAPE, value: (ctx) => css(objOf(ctx)?.shape?.outline?.color ?? lastLine) }),
  [`${SF}.shapeOutline.moreOutlineColors`]: spec(async (ctx) => {
    const r = await ctx.dialog('colors', { value: css(objOf(ctx)?.shape?.outline?.color) ?? css(lastLine) });
    return !!hexOf(r) && shapeLine(ctx, r);
  }, { need: shapeOrDiagram, reason: PICK_SHAPE }),
  [`${SF}.shapeOutline.weight`]: spec((ctx, pt) => (isDiagram(ctx) ? diagramLook(ctx, { lineWidth: Number(pt) }) : run1(ctx, 'shape.outline', { width: Number(pt) })), {
    need: shapeOrDiagram, reason: PICK_SHAPE, value: (ctx) => objOf(ctx)?.shape?.outline?.width ?? null,
  }),
  [`${SF}.shapeOutline.weight.moreLines`]: formatPane('line'),
  [`${SF}.shapeOutline.dashes`]: exec('shape.outline', (id) => ({ dash: String(id) }), { value: (e) => DASH_ID[e?.value?.dash] ?? e?.value?.dash ?? null }),
  [`${SF}.shapeOutline.dashes.moreLines`]: formatPane('line'),
  [`${SF}.shapeOutline.arrows`]: exec('shape.outline', (id) => ({ arrows: { start: !!HEADS[id]?.[0], end: !!HEADS[id]?.[1] } }), {
    when: (ctx) => (LINE_KINDS.has(objOf(ctx)?.shape?.kind) ? null : 'Arrowheads go on lines and connectors.'),
  }),
  [`${SF}.shapeOutline.pattern`]: fillEffects('pattern', outlinePattern, (o) => (o?.shape?.outline?.pattern ? dialogFill({ pattern: o.shape.outline.pattern }) : null)),
  [`${SF}.changeShape`]: spec((ctx, name) => (name ? changeShape(ctx, name) : false), { need: isShape, reason: PICK_SHAPE }),
  [`${SF}.launcher`]: formatPane('fill'),
  [`${SF}.shapeEffects`]: spec(async (ctx, id) => (SHAPE_EFFECTS[id] ? run1(ctx, 'shape.effects', SHAPE_EFFECTS[id](await objNow(ctx))) : false), {
    need: isShape, reason: PICK_SHAPE,
  }),
  // The right-click menu's entries: hidden away from a shape, as in the DOM editor; at one, disabled with their reason.
  'contextMenu.shape.setAsDefaultShape': shapeMenuGap('Default shape looks are not on the canvas engine yet.'),
  'contextMenu.shape.setAsDefaultLine': shapeMenuGap('Default line looks are not on the canvas engine yet.'),
  'contextMenu.shape.setAsDefaultTextBox': shapeMenuGap('Default text box looks are not on the canvas engine yet.'),
  'shapeFormat.size.shapeHeight': sizeRow('arrange.bounds', 'h', sized, PICK_SHAPE),
  'shapeFormat.size.shapeWidth': sizeRow('arrange.bounds', 'w', sized, PICK_SHAPE),
  'shapeFormat.size.shapeHeight.more': sizeStep('arrange.bounds', 'h', 1, sized, PICK_SHAPE),
  'shapeFormat.size.shapeHeight.less': sizeStep('arrange.bounds', 'h', -1, sized, PICK_SHAPE),
  'shapeFormat.size.shapeWidth.more': sizeStep('arrange.bounds', 'w', 1, sized, PICK_SHAPE),
  'shapeFormat.size.shapeWidth.less': sizeStep('arrange.bounds', 'w', -1, sized, PICK_SHAPE),
};

// ---------------------------------------------------------------------------------------------
// Text boxes and WordArt

const DIR_IN = { lrTb: 'horz', tbRl: 'vert', btLr: 'vert270', stacked: 'wordArtVert' };
const DIR_OUT = Object.fromEntries(Object.entries(DIR_IN).map(([k, v]) => [v, k]));
const ANCHOR_IN = { top: 't', center: 'ctr', bottom: 'b' };
const ANCHOR_OUT = Object.fromEntries(Object.entries(ANCHOR_IN).map(([k, v]) => [v, k]));
// WordArt wa1..wa30 (textbox/boxes.mjs WORDART): six looks in five shades → the engine's looks and the shade's colour.
const WA_LOOKS = ['solid', 'outlined', 'shadowed', 'glowing', 'reflected', 'shadowed'];
const WA_SHADES = ['#000000', THEME.colors?.accent1, THEME.colors?.accent2, THEME.colors?.accent4, THEME.colors?.accent5];
/** WordArt item `id` → {style, fill} for the engine, or null. */
export function wordArtOf(id) {
  const n = Number(/^wa(\d+)$/.exec(String(id ?? 'wa1'))?.[1]) - 1;
  if (!(n >= 0 && n < 30)) return null;
  return { style: WA_LOOKS[Math.floor(n / 5)], fill: hexOf(WA_SHADES[n % 5] ?? '#000000') };
}
let lastTextFill = '000000';
let lastTextLine = '000000';

const TEXTBOX = {
  // ponytail: every built-in text box is the Simple Text Box on a canvas draft; the styled ones' fills and text looks wait for
  // the shared Format Shape port.
  'insert.text.textBox': exec('insert.textBox', {}),
  // Draw Text Box: the crosshair; the box goes where it is drawn (tools/shapes.js).
  'insert.text.textBox.drawHorizontalTextBox': spec((ctx) => insertShape(ctx, 'Text Box')),
  'insert.text.textBox.drawVerticalTextBox': spec((ctx) => insertShape(ctx, 'Vertical Text Box')),
  'insert.text.wordArt': spec((ctx, id) => {
    const w = wordArtOf(id);
    return !!w && runMany(ctx, [['insert.wordArt', { style: w.style }], ['wordArt.textFill', { fill: w.fill }]]);
  }),
  // No item: the next direction from the current one, as the button cycles in Word.
  'shapeFormat.text.textDirection': exec('shape.textDirection', (id, ctx) => ({
    dir: DIR_IN[id] ?? (id || ({ horz: 'vert', vert: 'vert270' }[objOf(ctx)?.shape?.textBox?.dir] ?? 'horz')),
  }), { value: (e) => DIR_OUT[e?.value] ?? null }),
  'shapeFormat.text.alignText': exec('shape.alignText', (id) => ({ anchor: ANCHOR_IN[id] ?? id }), { value: (e) => ANCHOR_OUT[e?.value] ?? null }),
  // Create Link: the next click picks the empty text box the text continues in (tools/shapes.js linkPick). A linked box: Break Link.
  'shapeFormat.text.createLink': toolRow('linkTextBox', async (arg, ctx) => {
    if ((await objNow(ctx))?.shape?.textBox?.linked) {
      await run1(ctx, 'shape.breakLink', {});
      return null;
    }
    return (await import('../tools/shapes.js')).linkPick((text) => ctx.toast?.(text));
  }, { need: (ctx) => ctx.obj?.kind === 'textbox' || !!ctx.in?.textbox, reason: PICK_TEXTBOX }),
  'shapeFormat.wordArtStyles.quickStyles': spec((ctx, id) => {
    const w = wordArtOf(id);
    return !!w && runMany(ctx, [['wordArt.style', { style: w.style }], ['wordArt.textFill', { fill: w.fill }]]);
  }),
  'shapeFormat.wordArtStyles.textFill': spec(async (ctx, arg) => {
    if (arg === 'none') return run1(ctx, 'wordArt.textFill', { fill: 'none' });
    if (arg === 'grad:none') return run1(ctx, 'wordArt.textFill', { fill: null });
    if (arg === 'grad:light' || arg === 'grad:dark') {
      return run1(ctx, 'wordArt.textFill', { fill: { gradient: [arg === 'grad:light' ? 'FFFFFF' : '000000', lastTextFill], angle: 90 } });
    }
    const pick = arg === 'more' ? await ctx.dialog('colors', { value: css(lastTextFill) }) : arg;
    const color = pick === undefined ? lastTextFill : hexOf(pick);
    if (!color) return false;
    lastTextFill = color;
    return run1(ctx, 'wordArt.textFill', { fill: color });
  }, { value: () => css(lastTextFill) }),
  'shapeFormat.wordArtStyles.textOutline': spec(async (ctx, arg) => {
    if (arg === 'none') return run1(ctx, 'wordArt.textOutline', { outline: 'none' });
    if (typeof arg === 'string' && arg.startsWith('w:')) return run1(ctx, 'wordArt.textOutline', { color: lastTextLine, width: Number(arg.slice(2)) });
    if (typeof arg === 'string' && arg.startsWith('d:')) {
      ctx.toast?.('Dashed text outlines are not on the canvas engine yet.');
      return false;
    }
    const pick = arg === 'more' ? await ctx.dialog('colors', { value: css(lastTextLine) }) : arg;
    const color = pick === undefined ? lastTextLine : hexOf(pick);
    if (!color) return false;
    lastTextLine = color;
    return run1(ctx, 'wordArt.textOutline', { color });
  }, { value: () => css(lastTextLine) }),
  // Format Text Effects on the shape's text (format.textEffects formats a selected shape's whole text; rows/home.mjs).
  'shapeFormat.wordArtStyles.textEffects': textEffectsDialog(),
  'shapeFormat.wordArtStyles.launcher': formatPane('text'),
};

// ---------------------------------------------------------------------------------------------
// Picture Format and Graphics Format

const PF = 'pictureFormat';
/** Corrections item (picture-format/index.js CORRECTIONS) → picture.corrections params, percent. */
export function correctionOf(id) {
  const s = /^(soften|sharpen)(\d+)$/.exec(String(id));
  if (s) return { sharpen: (s[1] === 'soften' ? -1 : 1) * Number(s[2]) };
  const bc = /^b(-?\d+)c(-?\d+)$/.exec(String(id));
  return bc ? { brightness: Number(bc[1]), contrast: Number(bc[2]) } : null;
}
/** A theme colour of the Office theme by slot ('accent1'), '#RRGGBB'. */
const accent = (slot) => THEME.colors?.[slot] ?? '#156082';
/** Color item (picture-format/index.js colorItems) → picture.color params, or null. The variations take the theme's colours as
 * the DOM editor's gallery does (a light variation of Background 2 is Text 2's). */
export function colorOf(id) {
  const s = String(id ?? '');
  const sat = /^sat(\d+)$/.exec(s);
  if (sat) return { mode: 'saturation', saturation: Number(sat[1]) };
  const tone = /^tone(\d+)$/.exec(s);
  if (tone) return { mode: 'tone', temperature: Number(tone[1]) };
  const bw = /^recolor-bw(\d+)$/.exec(s);
  if (bw) return { mode: 'blackAndWhite', threshold: Number(bw[1]) };
  const v = /^recolor-(dark|light)-(\w+)$/.exec(s);
  if (v) return { mode: v[1], color: hex6(accent(v[1] === 'light' && v[2] === 'lt2' ? 'dk2' : v[2])) };
  return { 'recolor-none': { mode: 'none' }, 'recolor-grayscale': { mode: 'grayscale' }, 'recolor-sepia': { mode: 'sepia' },
    'recolor-washout': { mode: 'washout' } }[s] ?? null;
}
// Picture Border is the picture's outline in the engine (picture.format), drawn and saved as Word's a:ln: its colour, weight,
// dashes and sketched look each change alone, and one picked on a picture with no outline draws it black, as in Word.
let lastBorder = '000000';
const outline = (ctx, change) => run1(ctx, 'picture.format', { outline: change });
const borderColor = (ctx, arg) => {
  if (arg === 'none' || arg === null || arg?.color === 'none') return run1(ctx, 'picture.format', { outline: null });
  const color = arg === undefined ? lastBorder : hexOf(arg);
  if (!color) return false;
  lastBorder = color;
  return outline(ctx, { color });
};
const lookOf = (ctx) => objOf(ctx)?.picture ?? null;
/** Crop to aspect ratio `rw`:`rh` (Word's centred crop at the largest visible area) → picture.crop params from object.get. */
export function aspectCrop(o, rw, rh) {
  const p = o?.picture;
  if (!p?.original || !(rw > 0 && rh > 0)) return null;
  const [l, t, r, b] = p.crop ?? [0, 0, 0, 0];
  const fullW = p.original.w / Math.max(0.05, 1 - l - r);
  const fullH = p.original.h / Math.max(0.05, 1 - t - b);
  const want = rw / rh;
  const have = fullW / fullH;
  const fw = have > want ? want / have : 1;
  const fh = have > want ? 1 : have / want;
  const side = (f) => Math.round(((1 - f) / 2) * 10000) / 10000;
  return { left: side(fw), right: side(fw), top: side(fh), bottom: side(fh), width: o.w, height: Math.round((o.w / want) * 100) / 100 };
}
const ASPECTS = { 11: [1, 1], 23: [2, 3], 34: [3, 4], 35: [3, 5], 45: [4, 5], 32: [3, 2], 43: [4, 3], 53: [5, 3], 54: [5, 4], 169: [16, 9], 1610: [16, 10] };
const pic = (run, extra) => spec(run, { need: isPicture, reason: PICK_PICTURE, ...extra });
const changePicture = (svg) => pic(async (ctx) => {
  const data = await pickedPicture(svg);
  return !!data && run1(ctx, 'picture.change', { data });
});
const graphic = (run, extra) => spec(run, { need: kindIs('graphic'), reason: 'Select an SVG graphic first.', ...extra });
// The last Graphics Fill and Outline picked, which the split buttons' faces apply again.
let lastGraphicFill = '#FF0000';
let lastGraphicOutline = '#000000';
/** The draft's own theme, which Graphics Styles, Fill and Outline resolve their theme colours in, as the galleries show them. */
const docTheme = async (ctx) => themeOfSettings((await Promise.resolve(ctx.engine.exec('document.settings', {})).catch(() => null))?.value);
/** The selected SVG graphic recoloured with `opts` (engine.mjs recolouredSvg) and put back through picture.change. */
async function recolourGraphic(ctx, opts) {
  const o = await objNow(ctx);
  const d = (await ctx.engine.query?.('picture.data', { stored: true }))?.value;
  const data = o?.picture?.svg && d?.base64 ? recolouredSvg(d.base64, opts, o.w) : null;
  return !!data && run1(ctx, 'picture.change', { data });
}
/** A Picture Effects item → picture.format (Graphics Effects' items are 'kind:item'). */
const effectRow = (kind) => pic((ctx, id) => {
  const [k, item] = kind ? [kind, id] : String(id ?? '').split(':');
  const params = effectParams(k, item, accent);
  return !!params && run1(ctx, 'picture.format', params);
});
// The Options items open the Format Picture pane at their section; it reads and writes the engine on a canvas draft.
const pictureOptions = APP;
/** The windows Insert > Screenshot captures, as picture-format/index.js lists them (a stubbed capture in the harness). */
async function screenshotData(id) {
  const { captureApi } = await import('../../wp/picture-format/edit.js');
  if (id === 'screenClipping') {
    const { clipScreen } = await import('../../wp/picture-format/crop.js');
    const size = { width: Math.round(globalThis.screen.width * devicePixelRatio), height: Math.round(globalThis.screen.height * devicePixelRatio) };
    const [screen] = (await captureApi({ types: ['screen'], thumbnail: size })) ?? [];
    return screen?.thumbnail ? clipScreen(screen.thumbnail) : null;
  }
  const want = String(id ?? '').replace(/^window:/, '');
  const list = (await captureApi({ types: ['window'], thumbnail: { width: 3840, height: 2160 } })) ?? [];
  return list.find((w) => String(w.id) === want)?.thumbnail ?? null;
}

/** Insert > Signature Line: Signature Setup, then the line as a picture at the caret. */
const signatureLine = spec(async (ctx) => {
  const r = await ctx.dialog('signatureSetup');
  return !!r && run1(ctx, 'insert.picture', { data: signatureData(r), width: 192, alt: signatureAlt(r) });
});

const PICTURES = {
  [`${PF}.adjust.removeBackground`]: spec((ctx) => run1(ctx, 'picture.removeBackground'), { need: kindIs('picture'), reason: PICK_PICTURE }),
  [`${PF}.adjust.artisticEffects`]: spec((ctx, id) => ARTISTIC.some((e) => e.id === id) && run1(ctx, 'picture.effects', { effect: id }),
    { need: kindIs('picture'), reason: PICK_PICTURE }),
  [`${PF}.adjust.artisticEffects.artisticEffectsOptions`]: spec((ctx) => (ctx.pane('formatPicture', true, { section: 'effects.artistic' }), true),
    { need: kindIs('picture'), reason: PICK_PICTURE }),
  'insert.text.signatureLine': signatureLine,
  'insert.text.signatureLine.microsoftOfficeSignatureLine': signatureLine,
  [`${PF}.adjust.corrections`]: pic((ctx, id) => !!correctionOf(id) && run1(ctx, 'picture.corrections', correctionOf(id))),
  [`${PF}.adjust.corrections.pictureCorrectionsOptions`]: pictureOptions,
  [`${PF}.adjust.color`]: pic((ctx, id) => {
    const p = colorOf(id);
    if (!p) ctx.toast?.('This recolour is not on the canvas engine yet.');
    return !!p && run1(ctx, 'picture.color', p);
  }),
  [`${PF}.adjust.color.moreVariations`]: pic((ctx, arg) => !!hexOf(arg) && run1(ctx, 'picture.color', { mode: 'dark', color: hexOf(arg) })),
  [`${PF}.adjust.color.moreVariations.moreColors`]: pic(async (ctx) => {
    const color = hexOf(await ctx.dialog('colors', { value: '#156082' }));
    return !!color && run1(ctx, 'picture.color', { mode: 'dark', color });
  }),
  [`${PF}.adjust.color.setTransparentColor`]: toolRow('transparentColor', async () => (await import('../tools/pictures.js')).transparentTool,
    { need: kindIs('picture'), reason: PICK_PICTURE }),
  [`${PF}.adjust.color.pictureColorOptions`]: pictureOptions,
  [`${PF}.adjust.transparency`]: pic((ctx, id) => {
    const n = Number(/^transparency(\d+)$/.exec(String(id))?.[1]);
    return Number.isFinite(n) && run1(ctx, 'picture.transparency', { percent: n });
  }),
  [`${PF}.adjust.transparency.pictureTransparencyOptions`]: pictureOptions,
  // Not awaited: the dialog does the work on OK (picture.compress), as the DOM editor's does.
  [`${PF}.adjust.compressPictures`]: pic((ctx) => (ctx.dialog('compressPictures', { apply: (opts) => run1(ctx, 'picture.compress', opts) }), true)),
  [`${PF}.adjust.changePicture.thisDevice`]: changePicture(false),
  [`${PF}.adjust.changePicture.fromClipboard`]: pic(async (ctx) => {
    const data = await clipboardPicture();
    return !!data && run1(ctx, 'picture.change', { data });
  }),
  [`${PF}.adjust.resetPicture`]: 'picture.reset',
  [`${PF}.adjust.resetPicture.resetPicture`]: 'picture.reset',
  [`${PF}.adjust.resetPicture.resetPictureSize`]: pic((ctx) => runMany(ctx, [['picture.reset', {}], ['picture.size', { original: true }]])),
  // Word's 28 styles as their outline, effects and shape (pictures.mjs PICTURE_STYLES), in one undo step.
  [`${PF}.pictureStyles.pictureStyles`]: pic((ctx, id) => !!styleSteps(id) && runMany(ctx, styleSteps(id)), { value: (ctx) => styleOf(lookOf(ctx)) }),
  [`${PF}.pictureStyles.pictureBorder`]: pic(borderColor, { value: (ctx) => css(lookOf(ctx)?.outline?.color ?? null) }),
  [`${PF}.pictureStyles.pictureBorder.moreOutlineColors`]: pic(async (ctx) => {
    const r = await ctx.dialog('colors', { value: css(lookOf(ctx)?.outline?.color ?? lastBorder) });
    return !!hexOf(r) && borderColor(ctx, r);
  }),
  [`${PF}.pictureStyles.pictureBorder.weight`]: pic((ctx, id) => {
    const pt = Number(String(id ?? '').replace(/^w/, '').replace('_', '.'));
    return pt > 0 && outline(ctx, { width: pt });
  }),
  [`${PF}.pictureStyles.pictureBorder.sketched`]: pic((ctx, id) => !!outlineParams('sketch', id) && outline(ctx, outlineParams('sketch', id))),
  [`${PF}.pictureStyles.pictureBorder.dashes`]: pic((ctx, id) => !!outlineParams('dash', id) && outline(ctx, outlineParams('dash', id))),
  [`${PF}.pictureStyles.pictureBorder.weight.moreLines`]: pictureOptions,
  [`${PF}.pictureStyles.pictureBorder.sketched.moreLines`]: pictureOptions,
  [`${PF}.pictureStyles.pictureBorder.dashes.moreLines`]: pictureOptions,
  ...Object.fromEntries(['shadow', 'reflection', 'glow', 'softEdges', 'bevel', '3DRotation', 'preset']
    .map((k) => [`${PF}.pictureStyles.pictureEffects.${k}`, effectRow(k)])),
  // A theme slot or '#RRGGBB' (picture-format/index.js colourItems): the glow in that colour, its size kept.
  [`${PF}.pictureStyles.pictureEffects.glow.moreGlowColors`]: pic(async (ctx, id) => {
    const color = hexOf(THEME.colors?.[id] ?? id);
    if (!color) return false;
    const size = (await objNow(ctx))?.picture?.fx?.glow?.size ?? 8;
    return run1(ctx, 'picture.format', { glow: { color, size, transparency: 60 } });
  }),
  ...Object.fromEntries(['preset.3DOptions', 'shadow.shadowOptions', 'reflection.reflectionOptions', 'glow.glowOptions', 'softEdges.softEdgesOptions',
    'bevel.3DOptions', '3DRotation.3DRotationOptions'].map((k) => [`${PF}.pictureStyles.pictureEffects.${k}`, pictureOptions])),
  [`${PF}.pictureStyles.launcher`]: pictureOptions,
  // The Alt Text pane reads object.get and writes object.altText on a canvas draft (picture-format/panes.jsx altTarget).
  [`${PF}.accessibility.altText`]: APP,
  'review.accessibility.checkAccessibility.altText': APP,
  [`${PF}.size.crop`]: toolRow('crop', async () => (await import('../tools/pictures.js')).cropTool, { need: isPicture, reason: PICK_PICTURE }),
  [`${PF}.size.crop.crop`]: toolRow('crop', async () => (await import('../tools/pictures.js')).cropTool, { need: isPicture, reason: PICK_PICTURE }),
  'graphicsFormat.arrangeSize.crop': toolRow('crop', async () => (await import('../tools/pictures.js')).cropTool, { need: isPicture, reason: PICK_PICTURE }),
  [`${PF}.size.crop.cropToShape`]: pic((ctx, id) => !!id && run1(ctx, 'picture.cropToShape', { preset: String(id) }), {
    value: (ctx) => lookOf(ctx)?.cropShape ?? 'rect',
  }),
  ...Object.fromEntries(Object.entries(ASPECTS).map(([k, [rw, rh]]) => [`${PF}.size.crop.aspectRatio.${k}`, pic(async (ctx) => {
    const p = aspectCrop(await objNow(ctx), rw, rh);
    return !!p && run1(ctx, 'picture.crop', p);
  })])),
  // Fill: crop to the frame's own proportions; Fit: the whole picture, sized into the frame.
  [`${PF}.size.crop.fill`]: pic(async (ctx) => {
    const o = await objNow(ctx);
    const p = o && aspectCrop(o, o.w, o.h);
    return !!p && run1(ctx, 'picture.crop', { ...p, height: o.h });
  }),
  [`${PF}.size.crop.fit`]: pic(async (ctx) => {
    const o = await objNow(ctx);
    const p = o?.picture;
    if (!p?.original) return false;
    const [l, t, r, b] = p.crop ?? [0, 0, 0, 0];
    const k = Math.min(o.w / (p.original.w / Math.max(0.05, 1 - l - r)), o.h / (p.original.h / Math.max(0.05, 1 - t - b)));
    return runMany(ctx, [['picture.crop', {}], ['picture.size', { width: (p.original.w / Math.max(0.05, 1 - l - r)) * k, lockAspect: true }]]);
  }),
  [`${PF}.size.shapeHeight`]: sizeRow('picture.size', 'h', isPicture, PICK_PICTURE),
  [`${PF}.size.shapeWidth`]: sizeRow('picture.size', 'w', isPicture, PICK_PICTURE),
  [`${PF}.size.shapeHeight.more`]: sizeStep('picture.size', 'h', 1, isPicture, PICK_PICTURE),
  [`${PF}.size.shapeHeight.less`]: sizeStep('picture.size', 'h', -1, isPicture, PICK_PICTURE),
  [`${PF}.size.shapeWidth.more`]: sizeStep('picture.size', 'w', 1, isPicture, PICK_PICTURE),
  [`${PF}.size.shapeWidth.less`]: sizeStep('picture.size', 'w', -1, isPicture, PICK_PICTURE),
  'insert.illustrations.pictures.thisDevice': spec(async (ctx) => {
    const data = await pickedPicture();
    return !!data && run1(ctx, 'insert.picture', { data });
  }),
  // A window's picture or a screen clipping, inserted at the caret as a picture (the paste setting's wrap, as the DOM editor).
  'insert.illustrations.screenshot': spec(async (ctx, id) => {
    if (!id) return false;
    const src = await screenshotData(id);
    const data = typeof src === 'string' ? src.split(';base64,')[1] : null;
    if (!data) return false;
    const wrap = ctx.settings?.word?.paste?.pictures ?? 'inline';
    return runMany(ctx, [['insert.picture', { data }], ...(wrap !== 'inline' ? [['arrange.wrap', { wrap: WRAPS[wrap] ?? DOM_WRAPS[wrap] ?? wrap }]] : [])]);
  }),
  'paste.pastePicture': spec(async (ctx) => {
    const data = await clipboardPicture();
    if (!data) ctx.toast?.('The clipboard holds no picture.');
    return !!data && run1(ctx, 'insert.picture', { data });
  }),
  'graphicsFormat.change.changeGraphic': spec(async (ctx, id) => (id && id !== 'thisDevice' ? false : changePicture(true).run(ctx)), {
    need: kindIs('graphic'), reason: 'Select an SVG graphic first.',
  }),
  // G23 (engine-pictures-2): Convert to Shape makes the graphic's shapes; the styles, fill and outline recolour it as vector art.
  'graphicsFormat.change.convertToShape': graphic((ctx) => run1(ctx, 'graphic.convertToShape')),
  'graphicsFormat.graphicsStyles.styles': graphic(async (ctx, id) => {
    const opts = graphicStyle(id, await docTheme(ctx));
    return !!opts && recolourGraphic(ctx, opts);
  }),
  'graphicsFormat.graphicsStyles.graphicsFill': graphic(async (ctx, id) => {
    const c = id === undefined ? lastGraphicFill : graphicColour(id, await docTheme(ctx));
    if (!c) return false;
    lastGraphicFill = c;
    return recolourGraphic(ctx, { fill: c });
  }, { value: () => lastGraphicFill }),
  'graphicsFormat.graphicsStyles.graphicsOutline': graphic(async (ctx, id) => {
    const w = WEIGHTS.find((x) => x.id === id)?.value;
    if (w) return recolourGraphic(ctx, { stroke: lastGraphicOutline === 'none' ? '#000000' : lastGraphicOutline, strokeWidth: w });
    const c = id === undefined ? lastGraphicOutline : graphicColour(id, await docTheme(ctx));
    if (!c) return false;
    lastGraphicOutline = c;
    return recolourGraphic(ctx, c === 'none' ? { stroke: 'none' } : { stroke: c });
  }, { value: () => lastGraphicOutline }),
  'graphicsFormat.graphicsStyles.graphicsEffects': effectRow(null),
  // base: Insert > Pictures opens its menu; the board kinds are EasyWriter's own objects, engine boxes at the caret
  // (engine-canvas-read: box.insert), which open in the box edit mode. Flowcharts and plan charts ask what to insert first.
  'insert.illustrations.pictures': APP,
  'insert.illustrations.shapes.newDrawingCanvas': boxInsert(async () => (await flows()).insertCanvasBox()),
  'x.insert.boards.canvas': boxInsert(async () => (await flows()).insertCanvasBox()),
  'x.insert.boards.flowchart': boxInsert(async () => (await flows()).insertFlowchartDialog()),
  'x.insert.boards.planChart': boxInsert(async () => (await import('../../../app/plans.js')).insertPlanChartDialog()),
};

// ---------------------------------------------------------------------------------------------
// Draw: ink on the page needs the pen on the canvas, which is input routing still to come

/** The Draw gallery's pick on a canvas draft: Select (no tool), the ink eraser, or pen `pen-<n>` of the app's pens. */
async function drawPick(ctx, id) {
  const ink = await import('../tools/ink.js');
  const { endTool, startTool } = await import('../tools/index.js');
  if (id === 'select') return endTool(), true;
  if (id === 'lasso') return startTool(ctx, 'ink:lasso', ink.lassoTool);
  if (id === 'eraser') return startTool(ctx, 'ink:eraser', ink.inkEraserTool);
  const { pensOf } = await import('../../wp/draw/pens.mjs');
  const pen = pensOf(ctx.settings?.word?.pens)[Number(String(id).slice(4))];
  return !!pen && startTool(ctx, `ink:${id}`, ink.penTool(pen));
}
/** Ink Replay: draw.replay's strokes drawn again in order over the pages. */
async function inkReplay(ctx) {
  if (activeTool() === 'ink:replay') {
    (await import('../tools/index.js')).endTool();
    return true;
  }
  // The engine's flag hides the ink on the pages while the page area draws it again; the tool's end turns it off.
  const engine = ctx.engine;
  const r = await engine.exec('draw.replay', { value: true });
  const off = () => engine.exec('draw.replay', { value: false });
  if (!r?.ok || !r.value?.strokes?.length) {
    if (r?.ok) await off();
    ctx.toast?.('There is no ink to replay.');
    return false;
  }
  const [{ startTool }, { replayTool }] = await Promise.all([import('../tools/index.js'), import('../tools/ink.js')]);
  if (startTool(ctx, 'ink:replay', replayTool(r.value.strokes, 2000, off))) return true;
  await off();
  return false;
}
/** The stencil ruler on (across the caret's page) or off. */
async function stencilRuler(ctx) {
  if (ruler.at) return ruler.set(null), true;
  const s = await ctx.engine.selection();
  const c = s && (await ctx.engine.caret(s.head));
  const page = await ctx.engine.query('layout.page', { page: c?.page ?? 0 });
  const b = page?.value?.body;
  if (!b) return false;
  ruler.set({ surface: c?.page ?? 0, x: b.x, y: b.y + b.h / 2, deg: 0, len: b.w });
  return true;
}
const DRAW = {
  'draw.drawingTools.drawingTools': {
    run: drawPick,
    enabled: (ctx) => !!ctx.engine,
    value: () => (activeTool()?.startsWith('ink:') ? activeTool().slice(4) : 'select'),
  },
  ...Object.fromEntries(['pen', 'highlighter', 'fountainPen', 'brushPen', 'pencil'].map((k) => [`draw.drawingTools.add.${k}`, APP])), // the pens are settings
  'draw.touch.drawWithTouch': APP,
  'draw.stencils.ruler': { run: stencilRuler, enabled: (ctx) => !!ctx.engine, active: () => !!ruler.at },
  'draw.replay.inkReplay': { run: inkReplay, enabled: (ctx) => !!ctx.engine, active: () => activeTool() === 'ink:replay' },
  'review.ink.hideInk': exec('review.hideInk', {}),
  'review.ink.hideInk.hideInk': exec('review.hideInk', {}),
  'review.ink.hideInk.deleteAllInkInDocument': 'draw.deleteAll',
  'draw.convert.inkToShape': exec('draw.inkToShape', {}),
};

// ---------------------------------------------------------------------------------------------
// Equations

/** The app's built-in equation ids (equations/templates.mjs) → the engine's built-ins. */
const BUILTIN = {
  areaOfCircle: 'area', binomialTheorem: 'binomial', expansionOfASum: 'expansion', fourierSeries: 'fourier', pythagoreanTheorem: 'pythagoras',
  quadraticFormula: 'quadratic', taylorExpansion: 'taylor', trigIdentity1: 'trig1', trigIdentity2: 'trig2',
};
const builtIn = (id) => BUILT_INS.find((b) => b.id === id);
/** Insert > Equation item `id`: the engine's built-in, else the template as UnicodeMath; none: a new empty equation. */
const insertEquation = (id) => (id == null ? {} : BUILTIN[id] ? { builtin: BUILTIN[id] } : builtIn(id) ? { linear: builtIn(id).math } : null);
const symbolOf = (id) => Object.values(SYMBOL_SETS).flatMap((s) => s.items).find((i) => i.id === id)?.ch ?? null;
const inEquation = (ctx) => (ctx.in?.equation ? null : 'Put the caret in an equation first.');
const convertTo = (to, all = false) => exec('equation.convert', all ? { to, all } : { to }, all ? {} : { when: inEquation });

const EQUATIONS = {
  'insert.symbols.equation': spec((ctx, id) => {
    const p = insertEquation(id);
    return !!p && run1(ctx, 'insert.equation', p);
  }),
  'insert.symbols.equation.insertNewEquation': exec('insert.equation', {}),
  'equation.tools.equation': spec((ctx, id) => {
    const p = id == null ? null : insertEquation(id);
    return !!p && run1(ctx, 'insert.equation', p);
  }),
  'equation.conversions.unicode': exec('equation.inputFormat', { format: 'unicode' }, { active: (e) => e?.value === 'unicode' }),
  'equation.conversions.laTeX': exec('equation.inputFormat', { format: 'latex' }, { active: (e) => e?.value === 'latex' }),
  'equation.conversions.text': exec('equation.normalText', {}, { when: inEquation }),
  'equation.conversions.convert': spec(async (ctx) => {
    const eq = await ctx.engine.query?.('equation.get', {});
    return run1(ctx, 'equation.convert', { to: eq?.value?.linear ? 'professional' : 'linear' });
  }, { need: (ctx) => !!ctx.in?.equation, reason: 'Put the caret in an equation first.' }),
  'equation.conversions.convert.currentProfessional': convertTo('professional'),
  'equation.conversions.convert.currentLinear': convertTo('linear'),
  'equation.conversions.convert.allProfessional': convertTo('professional', true),
  'equation.conversions.convert.allLinear': convertTo('linear', true),
  'equation.conversions.launcher': APP, // Equation Options: the app's math settings
  'equation.symbols.symbols': exec('equation.insertSymbol', (id) => ({ char: symbolOf(id) ?? String(id ?? '') })),
  'equation.symbols.symbols.basicMath': APP, // the gallery's set switch
  ...Object.fromEntries(Object.keys(STRUCTURES).map((g) => [g, exec('equation.insertStructure', (id) => ({
    linear: STRUCTURES[g].find((i) => i.id === id)?.math ?? '',
  }))])),
};

// ---------------------------------------------------------------------------------------------
// Wrap Text and Position

const WR = 'layout.arrange.wrapText';
/** The Wrap Text items → the engine's wraps. */
const WRAPS = {
  inLineWithText: 'inline', square: 'square', tight: 'tight', through: 'through', topAndBottom: 'topAndBottom', behindText: 'behindText',
  inFrontOfText: 'inFrontOfText',
};
const WRAP_ITEM = Object.fromEntries(Object.entries(WRAPS).map(([k, v]) => [v, k]));
// The DOM editor's own wrap names (float-layout WRAP_ITEMS) reach the dropdown too.
const DOM_WRAPS = { inline: 'inline', topBottom: 'topAndBottom', behind: 'behindText', front: 'inFrontOfText' };
/** Position gallery `positionIn{Top,Middle,Bottom}{Left,Center,Right}WithSquareTextWrapping` → the engine's preset. */
export function positionOf(id) {
  const m = /^positionIn(Top|Middle|Bottom)(Left|Center|Right)WithSquareTextWrapping$/.exec(String(id));
  return m ? `${m[1].toLowerCase()}${m[2]}` : null;
}
const V_ALIGN = { top: 'Top', center: 'Middle', bottom: 'Bottom' };
const H_ALIGN = { left: 'Left', center: 'Center', right: 'Right' };
/** The Position gallery's item object `o` (object.get) shows: In Line with Text, or one of the nine aligned to the margins. */
export function positionItem(o) {
  if (!o) return null;
  if (!o.floating) return 'inLineWithText';
  const { hRel, vRel, hAlign, vAlign } = o.position ?? {};
  if (o.wrap !== 'square' || hRel !== 'margin' || vRel !== 'margin' || !V_ALIGN[vAlign] || !H_ALIGN[hAlign]) return null;
  return `positionIn${V_ALIGN[vAlign]}${H_ALIGN[hAlign]}WithSquareTextWrapping`;
}
/** The Layout dialog (float-layout/dialogs.jsx) at `tab`, given the selected object (object.get); it applies through the engine. */
const layoutDialog = (tab) => spec(async (ctx) => {
  const object = await objNow(ctx);
  return !!object && !!(await ctx.dialog('layout', { tab, object }));
}, { need: (ctx) => !!ctx.obj, reason: PICK_OBJECT });
/** The engine's wraps by the DOM editor's names, which Insert > Pictures reads as the default (float-layout setAsDefaultLayout). */
const DOM_WRAP = { inline: 'inline', square: 'square', tight: 'tight', through: 'through', topAndBottom: 'topBottom', behindText: 'behind', inFrontOfText: 'front' };

const FLOAT = {
  [WR]: exec('arrange.wrap', (arg) => ({ wrap: WRAPS[arg] ?? DOM_WRAPS[arg] ?? arg }), { value: (e) => WRAP_ITEM[e?.value] ?? null }),
  ...Object.fromEntries(Object.entries(WRAPS).map(([item, wrap]) => [`${WR}.${item}`, exec('arrange.wrap', { wrap }, {
    active: (e) => e?.value === wrap,
  })])),
  [`${WR}.editWrapPoints`]: toolRow('editWrapPoints', async () => (await import('../tools/shapes.js')).editWrapPoints,
    { need: (ctx) => !!objOf(ctx)?.floating, reason: 'Select a floating picture or shape first.' }),
  [`${WR}.moveWithText`]: exec('arrange.moveWithText', { value: true }),
  [`${WR}.fixPositionOnPage`]: exec('arrange.moveWithText', { value: false }, { active: (e, ctx) => !e?.checked && !!objOf(ctx)?.floating }),
  [`${WR}.moreLayoutOptions`]: layoutDialog('textWrapping'),
  // The app's setting, as in the DOM editor: a picture's wrap, never a text box's.
  [`${WR}.setAsDefaultLayout`]: spec(async (ctx) => {
    const wrap = DOM_WRAP[(await objNow(ctx))?.wrap];
    if (!wrap) return false;
    const { saveWord } = await import('../../word/settings.mjs');
    saveWord({ paste: { pictures: wrap } }).catch(() => ctx.toast?.('The default layout could not be saved.'));
    return true;
  }, { need: (ctx) => !!ctx.obj, reason: PICK_OBJECT }),
  // In Line with Text from the Position gallery is a wrap, not a preset.
  'layout.arrange.position': spec((ctx, id) => (id === 'inLineWithText' ? run1(ctx, 'arrange.wrap', { wrap: 'inline' })
    : positionOf(id) ? run1(ctx, 'arrange.position', { preset: positionOf(id) }) : false), {
    need: (ctx) => !!ctx.obj, reason: PICK_OBJECT, value: (ctx) => positionItem(objOf(ctx)),
  }),
  'layout.arrange.position.moreLayoutOptions': layoutDialog('position'),
  'pictureFormat.size.launcher': layoutDialog('size'),
  'layout.pageSetup.breaks.textWrapping': exec('layout.textWrappingBreak', {}),
  // Selected text is framed where it is, as Word frames a selection; without one the crosshair draws a new frame (engine-tools-2).
  'developer.controls.legacyTools.insertFrame': spec(insertFrame, { active: () => activeTool() === 'insertFrame' }),
  'pictures.textBoxConvert': exec('shape.toFrame', {}, { when: (ctx) => (ctx.obj?.kind === 'textbox' || ctx.in?.textbox ? null : PICK_TEXTBOX) }),
};

// ---------------------------------------------------------------------------------------------
// Arrange

const AR = 'layout.arrange';
let alignTo = 'margin'; // Align to Page, Align to Margin, Align Selected Objects: Word keeps the choice for the session
const order = (op) => exec('arrange.order', { op });
const align = (value) => exec('arrange.align', () => ({ value, to: alignTo }));
const alignMode = (m) => ({ run: () => ((alignTo = m), true), enabled: (ctx) => !!ctx.engine, active: () => alignTo === m });
/** Next and previous object: the Selection Pane's list from the selected one, wrapping at the ends (document order). */
const nextObject = (dir) => spec(async (ctx) => {
  const list = (await ctx.engine.query?.('arrange.selectionPane', {}))?.value ?? [];
  if (!list.length) return false;
  const at = JSON.stringify((await objNow(ctx))?.pos ?? null); // now: the drawn reading may still be the last object's
  const i = list.findIndex((o) => JSON.stringify(o.pos) === at);
  const n = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  return run1(ctx, 'select.objects', { index: list[n].index });
});
// The Selection pane reads arrange.selectionPane and writes object.hidden on a canvas draft (arrange/SelectionPane.jsx).
const selectionPane = APP;
/** A dropdown that opens its menu (the renderer draws it) when an object is selected. */
const MENU = spec(() => true, { need: (ctx) => !!ctx.obj, reason: PICK_OBJECT });

const ARRANGE = {
  [`${AR}.bringForward`]: order('forward'),
  [`${AR}.bringForward.bringForward`]: order('forward'),
  [`${AR}.bringForward.bringToFront`]: order('front'),
  [`${AR}.bringForward.bringInFrontOfText`]: exec('arrange.wrap', { wrap: 'inFrontOfText' }, { active: (e) => e?.value === 'inFrontOfText' }),
  [`${AR}.sendBackward`]: order('backward'),
  [`${AR}.sendBackward.sendBackward`]: order('backward'),
  [`${AR}.sendBackward.sendToBack`]: order('back'),
  [`${AR}.sendBackward.sendBehindText`]: exec('arrange.wrap', { wrap: 'behindText' }, { active: (e) => e?.value === 'behindText' }),
  [`${AR}.selectionPane`]: selectionPane,
  'home.editing.select.selectionPane': selectionPane,
  'panes.selection': selectionPane,
  [`${AR}.align`]: MENU,
  [`${AR}.align.alignLeft`]: align('left'),
  [`${AR}.align.alignCenter`]: align('center'),
  [`${AR}.align.alignRight`]: align('right'),
  [`${AR}.align.alignTop`]: align('top'),
  [`${AR}.align.alignMiddle`]: align('middle'),
  [`${AR}.align.alignBottom`]: align('bottom'),
  [`${AR}.align.distributeHorizontally`]: exec('arrange.distribute', () => ({ axis: 'horizontal', to: alignTo })),
  [`${AR}.align.distributeVertically`]: exec('arrange.distribute', () => ({ axis: 'vertical', to: alignTo })),
  [`${AR}.align.alignToPage`]: alignMode('page'),
  [`${AR}.align.alignToMargin`]: alignMode('margin'),
  [`${AR}.align.alignSelectedObjects`]: alignMode('selected'),
  [`${AR}.align.useAlignmentGuides`]: APP, // a setting
  // The gridlines are the app's setting (settings.word.guides), drawn over a canvas draft's pages (tools/overlays.jsx); Grid and
  // Guides writes the spacing through layout.drawingGrid there (arrange/GridDialog.jsx).
  [`${AR}.align.viewGridlines`]: APP,
  'view.show.gridlines': APP,
  [`${AR}.align.gridSettings`]: APP,
  [`${AR}.group`]: MENU,
  [`${AR}.group.group`]: 'arrange.group',
  [`${AR}.group.regroup`]: spec(async (ctx) => {
    if (await run1(ctx, 'arrange.regroup')) return true;
    ctx.toast?.('There is nothing to regroup. Ungroup objects first.');
    return false;
  }),
  [`${AR}.group.ungroup`]: 'arrange.ungroup',
  [`${AR}.rotate`]: MENU,
  [`${AR}.rotate.rotateRight90`]: exec('arrange.rotate', { direction: 'right' }),
  [`${AR}.rotate.rotateLeft90`]: exec('arrange.rotate', { direction: 'left' }),
  [`${AR}.rotate.flipVertical`]: exec('arrange.rotate', { direction: 'flipVertical' }),
  [`${AR}.rotate.flipHorizontal`]: exec('arrange.rotate', { direction: 'flipHorizontal' }),
  [`${AR}.rotate.moreRotationOptions`]: layoutDialog('size'),
  'graphicsFormat.arrangeSize.arrange': MENU,
  'home.editing.select.selectObjects': toolRow('selectObjects', async () => (await import('../tools/select.js')).selectObjectsTool),
  'pictures.nextObject': nextObject(1),
  'pictures.prevObject': nextObject(-1),
  'pictures.objectLayer': spec(async (ctx) => {
    const { layerOf, objectLayerTool } = await import('../tools/select.js');
    const l = await layerOf(ctx.engine);
    if (!l?.floats.length) {
      ctx.toast?.('There are no floating objects on this page.');
      return false;
    }
    return (await import('../tools/index.js')).startTool(ctx, 'objectLayer', objectLayerTool(l.back, l.floats));
  }),
};

// Word's legacy Shadow Effects, on files in compatibility mode 11 or 12. Word keeps a shadow's settings while it is off.
// ponytail: this session's memory, one entry per shape position; a file's own off-shadow settings need a field on the engine's Shadow.
const lastShadows = new Map();
const shadowKey = (o) => JSON.stringify(o?.pos ?? null);
const legacyShape = (ctx) => !!ctx.in?.compat && isShape(ctx);
const legacyRow = (run, more = {}) => ({
  run,
  enabled: (ctx) => !!ctx.engine && legacyShape(ctx),
  reason: (ctx) => (legacyShape(ctx) ? null : ctx.in?.compat ? PICK_SHAPE : REASONS.compat),
  ...more,
});
const setShadow = (ctx, shadow) => run1(ctx, 'shape.effects', { shadow });
const shadowNow = async (ctx) => (await objNow(ctx))?.shape?.effects?.shadow ?? null;
/** A nudge: on a shape with no shadow, Word turns the default one on first. */
const nudgeShadow = (dx, dy) => legacyRow(async (ctx) => setShadow(ctx, nudgedShadow((await shadowNow(ctx)) ?? SHADOW_ON, dx, dy)));
const LS = 'shapeFormat.shadowEffects';
const LEGACY_SHADOW = {
  [`${LS}.shadowEffects`]: legacyRow((ctx, id) => {
    if (id === undefined) return true; // the button itself: the ribbon opens the menu
    if (id === 'noShadow') return setShadow(ctx, null);
    return !!SHADOW_STYLES[id] && setShadow(ctx, SHADOW_STYLES[id]);
  }),
  [`${LS}.shadowEffects.shadowColor`]: legacyRow(async (ctx) => {
    const now = await shadowNow(ctx);
    const base = now ? shadowParams(now) : SHADOW_ON;
    const color = hexOf(await ctx.dialog('colors', { value: css(base.color) }));
    return !!color && setShadow(ctx, { ...base, color });
  }),
  [`${LS}.shadowOnOff`]: legacyRow(async (ctx) => {
    const o = await objNow(ctx);
    const now = o?.shape?.effects?.shadow ?? null;
    const key = shadowKey(o);
    if (now) lastShadows.set(key, shadowParams(now));
    return setShadow(ctx, now ? null : lastShadows.get(key) ?? SHADOW_ON);
  }, { active: (ctx) => !!objOf(ctx)?.shape?.effects?.shadow }),
  [`${LS}.nudgeShadowUp`]: nudgeShadow(0, -1),
  [`${LS}.nudgeShadowLeft`]: nudgeShadow(-1, 0),
  [`${LS}.nudgeShadowRight`]: nudgeShadow(1, 0),
  [`${LS}.nudgeShadowDown`]: nudgeShadow(0, 1),
};
// The Text Box tab's ids the spec does not alias: the same rows as Insert's and Shape Format's, with no private copies.
const TEXTBOX_TAB = {
  'textBox.text.drawTextBox': DROPDOWN,
  'textBox.text.drawTextBox.drawHorizontalTextBox': TEXTBOX['insert.text.textBox.drawHorizontalTextBox'],
  'textBox.text.drawTextBox.drawVerticalTextBox': TEXTBOX['insert.text.textBox.drawVerticalTextBox'],
  'textBox.text.textDirection': TEXTBOX['shapeFormat.text.textDirection'],
  'textBox.text.createLink': TEXTBOX['shapeFormat.text.createLink'],
  'textBox.textBoxStyles.textBoxStyles': SHAPES[`${SF}.shapeStyles`],
  'textBox.size.shapeHeight.more': SHAPES['shapeFormat.size.shapeHeight.more'],
  'textBox.size.shapeHeight.less': SHAPES['shapeFormat.size.shapeHeight.less'],
  'textBox.size.shapeWidth.more': SHAPES['shapeFormat.size.shapeWidth.more'],
  'textBox.size.shapeWidth.less': SHAPES['shapeFormat.size.shapeWidth.less'],
};

/** {toolingId: row}. */
export const OBJECTS = { ...SHAPES, ...TEXTBOX, ...PICTURES, ...DRAW, ...EQUATIONS, ...FLOAT, ...ARRANGE, ...LEGACY_SHADOW, ...TEXTBOX_TAB };
