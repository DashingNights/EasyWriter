// Table Design (docs/plans/word/plan.md §3 table-design): Table Style Options on table.look, the Table Styles gallery with our
// 105 definitions under Word's names (styles.mjs), Clear, Modify and New Table Style (ModifyTableStyle.jsx), Shading's More
// Colors, and the border pen (Pen Style, Pen Weight, Pen Color, Border Styles, Border Sampler) in store word.pen.
// Picking any pen part arms Border Painter (word.tableTool 'paint') as Word does; table-tools owns the painting itself, and the
// borders package applies the pen from the Borders gallery and owns the group's launcher. Shading's main part and colour panel stay base's.
import { createElement as h } from 'react';
import { getState } from '../../../app/store.js';
import { setWord } from '../../../tooling/ribbon/contexts.js';
import { BUILTIN_STYLES, THEME } from '../../defaults.mjs';
import { ensureStyles } from '../../model/styles.mjs';
import { resolved } from '../../stylesheet.js';
import { ModifyTableStyle, TableStripes } from './ModifyTableStyle.jsx';
import { PenLine, StyleTile, WeightLine } from './preview.jsx';
import { BORDER_PRESETS, engineParts, PEN_STYLES, PEN_WEIGHTS, penOfCss, presetPen, TABLE_STYLES, tableStyleDef } from './styles.mjs';
import { docxAttrs } from '../../canvas/attrs.js';
import { commandOf } from '../../../tooling/registry.js';

const P = 'tableDesign.';

/** The table holding the selection of `state` → {node, pos}, or null. */
export function tableAt(state) {
  const $ = state?.selection.$from;
  for (let d = $?.depth ?? 0; d > 0; d--) if ($.node(d).type.name === 'table') return { node: $.node(d), pos: $.before(d) };
  return null;
}

const inTable = (ctx) => ctx.in.table && !!tableAt(ctx.state);
const themeOf = (doc) => doc.attrs.theme ?? THEME;

/** Patches the selection's table attributes with `fn(attrs)` → whether a table was there. One transaction, one undo step. */
const patchTable = (ctx, fn) => ctx.chain((c) => c.command(({ tr, state }) => {
  const t = tableAt(state);
  if (!t) return false;
  tr.setNodeMarkup(t.pos, null, { ...t.node.attrs, ...fn(t.node.attrs, tr, state) });
  return true;
}));

/** Brings style definitions `defs` ({id: def}) into the document in `tr` (with Normal Table, which every table style sits on). */
function bring(tr, state, defs) {
  const styles = ensureStyles(state.doc, { TableNormal: BUILTIN_STYLES.TableNormal, ...defs });
  if (styles) tr.setDocAttribute('styles', styles);
}

/** Sets the selection's table style to `id`, adding a gallery style's definition in the same transaction. */
function applyStyle(ctx, id) {
  if (id !== 'TableNormal' && !ctx.state?.doc.attrs.styles?.list?.[id] && !tableStyleDef(id, THEME)) return false;
  return patchTable(ctx, (_a, tr, state) => {
    const def = state.doc.attrs.styles?.list?.[id] ? null : tableStyleDef(id, themeOf(state.doc));
    bring(tr, state, def ? { [id]: def } : {});
    return { styleId: id };
  });
}

// Table Style Options: each writes one look flag; Banded Rows and Banded Columns are the inverse of Word's noHBand and noVBand.
const LOOK = { headerRow: ['firstRow', false], totalRow: ['lastRow', false], bandedRows: ['noHBand', true], firstColumn: ['firstColumn', false],
  lastColumn: ['lastColumn', false], bandedColumns: ['noVBand', true] };
const lookOf = (ctx) => tableAt(ctx.state)?.node.attrs.look ?? {};
const option = ([key, inverse]) => ({
  run: (ctx) => patchTable(ctx, (a) => ({ look: { ...a.look, [key]: !a.look?.[key] } })),
  active: (ctx) => !!lookOf(ctx)[key] !== inverse,
  enabled: inTable,
});

// ---------- the pen ----------

const penNow = () => getState().word?.pen ?? { style: 'single', width: 0.5, color: null };
/** Patches the pen and arms Border Painter, as Word does after any pen pick. */
const setPen = (patch) => {
  setWord({ pen: { ...penNow(), ...patch }, tableTool: 'paint' });
  return true;
};
const styleLabel = (s) => PEN_STYLES.find(([n]) => n === s)?.[1] ?? s;
const weightLabel = (w) => PEN_WEIGHTS.find(([v]) => v === w)?.[1] ?? `${w} pt`;
let lastPreset = BORDER_PRESETS[0].id;

// Border Sampler: the next press on a cell edge copies that edge's border into the pen; Esc or a press elsewhere cancels.
let sampling = null; // the editor view's DOM while armed
const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
function stopSampling() {
  if (sampling) delete sampling.dataset.borderSampler;
  sampling = null;
  window.removeEventListener('keydown', onSampleKey, true);
  window.removeEventListener('pointerdown', onPressAway, true);
}
// A press outside the editor (the ribbon, a pane) cancels; presses inside go to onSamplePress on the editor DOM.
const onPressAway = (e) => {
  if (sampling && !sampling.contains(e.target)) stopSampling();
};
const onSampleKey = (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  stopSampling();
};
function onSamplePress(e) {
  if (!sampling || !sampling.contains(e.target)) return;
  const cell = e.target.closest?.('td, th');
  e.preventDefault();
  e.stopPropagation();
  stopSampling();
  if (!cell) return;
  const r = cell.getBoundingClientRect();
  const gaps = [e.clientY - r.top, r.right - e.clientX, r.bottom - e.clientY, e.clientX - r.left];
  let side = SIDES[gaps.indexOf(Math.min(...gaps))];
  let el = cell;
  // Split tables draw a shared vertical edge as the left cell's right border (document.css), so read it there.
  if (side === 'Left' && getComputedStyle(cell).borderLeftStyle === 'none' && cell.previousElementSibling) [el, side] = [cell.previousElementSibling, 'Right'];
  const cs = getComputedStyle(el);
  const pen = penOfCss(cs[`border${side}Style`], cs[`border${side}Width`], cs[`border${side}Color`], 1 / (devicePixelRatio * (el.currentCSSZoom || 1)));
  setPen(pen ?? { style: 'none' });
}

// ---------- galleries ----------

// The gallery's generated definitions per theme object: the gallery provider runs on every ribbon render in a table.
const DEFS = new WeakMap();
function galleryDef(id, theme) {
  let m = DEFS.get(theme);
  if (!m) DEFS.set(theme, (m = new Map()));
  if (!m.has(id)) m.set(id, tableStyleDef(id, theme));
  return m.get(id);
}

const GALLERIES = {
  [`${P}tableStyles.tableStyles`]: (ctx) => {
    const doc = ctx.state?.doc;
    if (!doc) return [];
    const list = doc.attrs.styles?.list ?? {};
    const t = tableAt(ctx.state);
    const current = t?.node.attrs.styleId;
    const look = t?.node.attrs.look;
    const theme = themeOf(doc);
    // The document's own table styles first, under Custom, as Word lists them.
    const own = Object.entries(list).filter(([id, s]) => s?.type === 'table' && id !== 'TableNormal' && !TABLE_STYLES.some((g) => g.id === id))
      .map(([id, s]) => ({ id, name: s.name ?? id, group: 'Custom' }));
    return [...own, ...TABLE_STYLES].map(({ id, name, group }) => {
      // A style the document holds draws as the document has it (the user may have modified it).
      const def = list[id] ? resolved(list, id) : galleryDef(id, theme);
      return { id, label: name, group, active: id === current, preview: h(StyleTile, { def, label: name, look }) };
    });
  },
  // The pen's galleries are the app's (store word.pen), so they serve a canvas draft too (`engine`); its theme is the default there.
  [`${P}borders.borderStyles`]: Object.assign((ctx) => {
    const theme = ctx.state ? themeOf(ctx.state.doc) : THEME;
    return BORDER_PRESETS.map((p) => ({ id: p.id, label: p.label, group: 'Theme Borders', active: p.id === lastPreset,
      preview: h(PenLine, { ...presetPen(p, theme), label: p.label }) }));
  }, { engine: true }),
  [`${P}borders.penStyle`]: Object.assign(() => {
    const pen = penNow();
    return PEN_STYLES.map(([id, label]) => ({ id, label, active: pen.style === id, preview: h(PenLine, { style: id, label }) }));
  }, { engine: true }),
  [`${P}borders.penWeight`]: Object.assign(() => {
    const pen = penNow();
    return PEN_WEIGHTS.map(([w, label]) => ({ id: String(w), label, active: pen.width === w,
      preview: h(WeightLine, { label, style: pen.style === 'none' ? 'single' : pen.style, width: w, color: pen.color }) }));
  }, { engine: true }),
};

// ---------- commands ----------

/** Opens Modify Table Style (or Create New Style from Formatting with `create`) on the selection's table style and writes the
 * result: the style's definition, and for a new style the table's styleId, in one transaction. */
async function editStyle(ctx, create, id = null) {
  if (ctx.engine) return editStyleOnCanvas(ctx, create, id);
  const t = tableAt(ctx.state);
  if (!t) return false;
  const doc = ctx.state.doc;
  const styleId = t.node.attrs.styleId ?? 'TableGrid';
  const list = doc.attrs.styles?.list ?? {};
  const r = await ctx.dialog('modifyTableStyle', { styleId, create, list, theme: themeOf(doc), look: t.node.attrs.look });
  if (!r) return false;
  return patchTable(ctx, (a, tr, state) => {
    const styles = state.doc.attrs.styles ?? {};
    tr.setDocAttribute('styles', { ...styles, list: { ...styles.list, [r.id]: r.def } });
    bring(tr, tr, {}); // Normal Table, when an old document lacks it
    return create ? { styleId: r.id } : {};
  });
}

/** editStyle on a canvas draft: the dialog gets the document's styles in its own form (canvas/attrs.js) and the caret table's
 * style (the Table Styles row's value) or gallery style `id` (the gallery's Modify Table Style), and the engine writes the
 * result (table.newStyle, which applies it, or table.modifyStyle) from the style's parts. A gallery style the document lacks is
 * added under its id first, as Word adds a built-in style (gaps.md's table-design item). */
async function editStyleOnCanvas(ctx, create, id = null) {
  const attrs = await docxAttrs(ctx);
  const styleId = id ?? commandOf(`${P}tableStyles.tableStyles`)?.value?.(ctx) ?? 'TableGrid';
  const r = await ctx.dialog('modifyTableStyle', { styleId, create, list: attrs?.styles?.list ?? {}, theme: attrs?.theme ?? THEME, look: null });
  if (!r) return false;
  const params = { name: r.def.name, ...(r.def.basedOn && { basedOn: r.def.basedOn }), parts: engineParts(r.def) };
  const res = await Promise.resolve(ctx.engine.exec(create ? 'table.newStyle' : 'table.modifyStyle', create ? params : { style: styleId, ...params }))
    .catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
  if (!res?.ok) ctx.toast(`Could not save the table style: ${res?.error ?? 'the engine refused it'}`);
  return !!res?.ok;
}

const COMMANDS = {
  ...Object.fromEntries(Object.entries(LOOK).map(([k, v]) => [`${P}tableStyleOptions.${k}`, option(v)])),

  [`${P}tableStyles.tableStyles`]: {
    run: (ctx, id) => (typeof id === 'string' ? applyStyle(ctx, id) : false),
    value: (ctx) => tableAt(ctx.state)?.node.attrs.styleId ?? null,
    enabled: inTable,
    repeatable: true,
  },
  [`${P}tableStyles.tableStyles.clear`]: { run: (ctx) => applyStyle(ctx, 'TableNormal'), enabled: inTable },
  [`${P}tableStyles.tableStyles.modifyTableStyle`]: { run: (ctx, id) => editStyle(ctx, false, ctx.engine && typeof id === 'string' ? id : null), enabled: (ctx) => (ctx.engine ? !!ctx.in?.table : inTable(ctx)) },
  [`${P}tableStyles.tableStyles.newTableStyle`]: { run: (ctx) => editStyle(ctx, true), enabled: (ctx) => (ctx.engine ? !!ctx.in?.table : inTable(ctx)) },
  [`${P}tableStyles.shading.moreColors`]: {
    run: async (ctx) => {
      const hex = await ctx.dialog('colors', { value: ctx.T.shading?.value ?? '#FFFFFF' });
      return hex ? ctx.run(`${P}tableStyles.shading`, hex) : false;
    },
    enabled: inTable,
  },

  [`${P}borders.borderStyles`]: {
    // A preset sets style, weight and colour together; the main part loads the last picked preset again, as Word's does.
    run: (ctx, id = lastPreset) => {
      const p = BORDER_PRESETS.find((x) => x.id === id);
      if (!p) return false;
      lastPreset = id;
      return setPen(presetPen(p, ctx.state ? themeOf(ctx.state.doc) : THEME));
    },
  },
  [`${P}borders.borderStyles.borderSampler`]: {
    run: (ctx) => {
      const dom = ctx.ed?.view?.dom;
      if (!dom) return false;
      stopSampling();
      sampling = dom;
      dom.dataset.borderSampler = '';
      window.addEventListener('keydown', onSampleKey, true);
      window.addEventListener('pointerdown', onPressAway, true);
      return true;
    },
  },
  [`${P}borders.penStyle`]: {
    run: (_ctx, id) => (PEN_STYLES.some(([n]) => n === id) ? setPen({ style: id }) : false),
    value: () => h(PenLine, { style: penNow().style, label: styleLabel(penNow().style) }),
  },
  [`${P}borders.penWeight`]: {
    run: (_ctx, w) => (PEN_WEIGHTS.some(([v]) => v === Number(w)) ? setPen({ width: Number(w) }) : false),
    value: () => weightLabel(penNow().width),
  },
  [`${P}borders.penColor`]: {
    // arg: {color, themeColor} from the colour panel, a '#RRGGBB', or null for Automatic; none paints with the pen's colour.
    run: (_ctx, arg) => (arg === undefined ? setPen({}) : setPen({ color: arg && typeof arg === 'object' ? arg.color ?? null : arg })),
    value: () => penNow().color ?? '#000000',
  },
  [`${P}borders.penColor.moreColors`]: {
    run: async (ctx) => {
      const hex = await ctx.dialog('colors', { value: penNow().color ?? '#000000' });
      return hex ? setPen({ color: hex }) : false;
    },
  },
};

// The pen and the table tool for harness cases, which cannot read the store.
if (typeof window !== 'undefined') window.__word = Object.assign(window.__word ?? {}, { tableDesign: { pen: penNow, tool: () => getState().word?.tableTool ?? null } });

export default {
  id: 'table-design',
  commands: COMMANDS,
  galleries: GALLERIES,
  dialogs: { modifyTableStyle: ModifyTableStyle, tableStripes: TableStripes },
  // The table style's conditional formats are drawn by stylesheet.js from the definitions this package writes.
  implements: ['styles.tableStyles'],
  setup(editor) {
    const dom = editor.view?.dom;
    if (!dom) return undefined;
    dom.addEventListener('pointerdown', onSamplePress, true);
    return () => {
      dom.removeEventListener('pointerdown', onSamplePress, true);
      if (sampling === dom) stopSampling();
    };
  },
};
