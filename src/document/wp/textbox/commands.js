// Text box and styled text commands and menus (docs/plans/word/plan.md §3 textbox, §1.3 commands, §1.4 galleries): Insert > Text Box
// and Styled Text (WordArt), Draw Horizontal and Vertical Text Box, and Shape Format's Text group (Text Direction, Align Text,
// Create Link) and Styled Text Styles group (quick styles, Text Fill, Text Outline, Text Effects, Format Text Effects).
import { both } from '../../../tooling/engine-provider.mjs';
import { createElement as h } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { deepPatch, resolveColor, STANDARD_COLORS } from '../../../office.mjs';
import { paneOpen } from '../../../tooling/panes.jsx';
import { REASONS } from '../../../tooling/reasons.mjs';
import { setWord } from '../../../tooling/ribbon/contexts.js';
import { THEME } from '../../defaults.mjs';
import { flowPos } from '../columns/model.mjs';
import { DIRS, newBox, previewCss, reactStyle, TEXTBOX_GALLERY, VALIGNS, wordArtBox, WORDART } from './boxes.mjs';
import { createLink, drawTextBox, linkBoxes } from './pointer.js';
import { boxAt, boxOf } from './view.js';

const NO_NEST = 'A text box cannot hold another text box.';
const NO_BOX = 'Select a text box first.';
const WARP = 'Needs text warping, which EasyWriter does not have yet.';

const editorOf = (ctx) => ctx.target ?? ctx.ed;
/** Whether the selection is inside a box's text (not on a node-selected box). */
const insideBox = (ctx) => !!ctx.state && !ctx.state.selection.node && !!boxAt(ctx.state.selection.$from);
const box = (ctx) => (ctx.state ? boxOf(ctx.state) : null);
const canInsert = (ctx) => !!editorOf(ctx) && !insideBox(ctx);

/** Patches the attrs of the box the selection is on or in with `patch` (JSON attributes key by key) → true. */
export function setBox(ctx, patch) {
  const b = box(ctx);
  if (!b) return false;
  const view = editorOf(ctx).view;
  const tr = view.state.tr.setNodeMarkup(b.pos, null, deepPatch(b.node.attrs, patch));
  // A null in the patch means "none" for fill and line here, which deepPatch would drop as "unset": keep it.
  for (const [k, v] of Object.entries(patch)) if (v === null) tr.setNodeAttribute(b.pos, k, null);
  view.dispatch(tr);
  return true;
}

/** Inserts text box `json` before the selection's block in the text flow (in newspaper columns, the column's block: flowPos)
 * (moving `move` [from, to] into it when given) and selects the text of its first paragraph (or puts the caret there when it is
 * empty). One undo step. */
function insertBox(ctx, json, move) {
  const ed = editorOf(ctx);
  const { state, view } = ed;
  const at = flowPos(state.selection.$from, true);
  const node = state.schema.nodeFromJSON(json);
  const tr = state.tr.insert(at, node);
  if (move) tr.delete(tr.mapping.map(move[0]), tr.mapping.map(move[1]));
  const first = at + 2;
  tr.setSelection(TextSelection.create(tr.doc, first, first + node.firstChild.content.size));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  setWord({ tab: 'shapeFormat' }); // Word brings Shape Format forward for a new box
  return true;
}

// ---------------------------------------------------------------------------------------------
// Run formatting over the box's text: the selection inside it, else (a caret or the box node-selected) all of its text.

/** The [from, to] the styled text commands format. */
function textRange(ctx) {
  const sel = ctx.state.selection;
  if (!sel.empty && !sel.node) return [sel.from, sel.to];
  const b = box(ctx);
  return b ? [b.pos + 1, b.pos + b.node.nodeSize - 1] : null;
}

/** textStyle `patch` over the formatted range; with `replace`, the keys it names are set whole instead of merged. */
function formatText(ctx, patch, { replace = false } = {}) {
  const range = textRange(ctx);
  if (!range) return false;
  const view = editorOf(ctx).view;
  const { state } = view;
  const type = state.schema.marks.textStyle;
  const tr = state.tr;
  state.doc.nodesBetween(range[0], range[1], (node, pos, parent) => {
    if (!node.isInline || !parent.type.allowsMarkType(type)) return;
    const old = type.isInSet(node.marks)?.attrs ?? {};
    const attrs = replace ? { ...old, ...patch } : { ...old };
    if (!replace) {
      for (const [k, v] of Object.entries(patch)) {
        const next = v && typeof v === 'object' ? deepPatch(old[k] ?? {}, v) : v;
        attrs[k] = next && typeof next === 'object' && !Object.keys(next).length ? null : next;
      }
    }
    tr.addMark(Math.max(range[0], pos), Math.min(range[1], pos + node.nodeSize), type.create(attrs));
  });
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

/** The textStyle attrs where the formatted range starts (what the menus mark as current). */
function runNow(ctx) {
  const range = ctx.state && textRange(ctx);
  if (!range) return {};
  let attrs = null;
  ctx.state.doc.nodesBetween(range[0], range[1], (n) => {
    if (attrs || !n.isText) return !attrs;
    attrs = n.marks.find((m) => m.type.name === 'textStyle')?.attrs ?? {};
    return false;
  });
  return attrs ?? {};
}

const themeOf = (ctx) => ctx.state?.doc.attrs.theme ?? THEME;
const THEME_SLOTS = [['dk1', 'Text 1'], ['lt1', 'Background 1'], ['accent1', 'Accent 1'], ['accent2', 'Accent 2'], ['accent3', 'Accent 3'],
  ['accent4', 'Accent 4'], ['accent5', 'Accent 5'], ['accent6', 'Accent 6']];
const STANDARD_NAMES = ['Dark Red', 'Red', 'Orange', 'Yellow', 'Light Green', 'Green', 'Light Blue', 'Blue', 'Dark Blue', 'Purple'];
const swatch = (color, label) => h('span', { className: 'flex items-center gap-2' },
  h('span', { className: 'size-3.5 shrink-0 rounded-xs ring-1 ring-foreground/20', style: { background: color } }), label);

/** Colour items for Text Fill and Text Outline: the theme's base colours, then the standard row. Ids 'theme:<slot>' or '#RRGGBB'. */
const colorItems = (ctx, now) => [
  ...THEME_SLOTS.map(([slot, label]) => {
    const c = resolveColor(themeOf(ctx), { slot });
    return { id: `theme:${slot}`, label, group: 'Theme Colors', preview: swatch(c, label), active: now === c };
  }),
  ...STANDARD_COLORS.map((c, i) => ({ id: c, label: STANDARD_NAMES[i], group: 'Standard Colors', preview: swatch(c, STANDARD_NAMES[i]), active: now === c })),
];

/** A colour pick ('theme:<slot>', '#RRGGBB' or {color, themeColor}) → {color, themeColor} or null. */
function colorPick(ctx, arg) {
  if (arg && typeof arg === 'object') return arg.color ? { color: arg.color, themeColor: arg.themeColor ?? null } : null;
  if (typeof arg !== 'string') return null;
  if (arg.startsWith('theme:')) {
    const slot = arg.slice(6);
    return { color: resolveColor(themeOf(ctx), { slot }), themeColor: { slot, lum: 0 } };
  }
  return /^#[0-9a-f]{6}$/i.test(arg) ? { color: arg.toUpperCase(), themeColor: null } : null;
}

// A lighter or darker version of a colour, for the gradient variations.
const mix = (hex, to, f) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - f) + to * f).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

let lastFill = { color: '#FF0000', themeColor: null };
let lastOutline = { color: '#000000', themeColor: null };

const WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6];
const DASHES = [['solid', 'Solid'], ['sysDot', 'Round Dot'], ['sysDash', 'Square Dot'], ['dash', 'Dash'], ['dashDot', 'Dash Dot'], ['lgDash', 'Long Dash'],
  ['lgDashDot', 'Long Dash Dot'], ['lgDashDotDot', 'Long Dash Dot Dot']];
// Text Effects' presets in the textStyle effects shape (lengths in pt).
const SHADOWS = { outerBR: ['Offset: bottom right', { color: '#000000', alpha: 0.4, angle: 45, dist: 3, blur: 4 }],
  outerB: ['Offset: bottom', { color: '#000000', alpha: 0.4, angle: 90, dist: 3, blur: 4 }],
  outerTL: ['Offset: top left', { color: '#000000', alpha: 0.4, angle: 225, dist: 3, blur: 4 }],
  soft: ['Soft all round', { color: '#000000', alpha: 0.5, angle: 0, dist: 0, blur: 6 }] };
const REFLECTIONS = { tight: ['Tight reflection', { size: 30, dist: 0, alpha: 0.5 }], half: ['Half reflection', { size: 50, dist: 2, alpha: 0.5 }],
  full: ['Full reflection', { size: 90, dist: 4, alpha: 0.5 }] };

/** Whether a command acting on a text box can run now, with its reason when it cannot. */
const onBox = { enabled: (ctx) => !!box(ctx), reason: (ctx) => (box(ctx) ? null : NO_BOX) };

export const COMMANDS = {
  'insert.text.textBox': {
    run: (ctx, arg) => insertBox(ctx, newBox(arg ?? 'simple')),
    enabled: canInsert,
    reason: (ctx) => (insideBox(ctx) ? NO_NEST : null),
  },
  'insert.text.textBox.drawHorizontalTextBox': { run: (ctx) => drawTextBox(editorOf(ctx), 'lrTb'), enabled: canInsert, reason: (ctx) => (insideBox(ctx) ? NO_NEST : null) },
  'insert.text.textBox.drawVerticalTextBox': { run: (ctx) => drawTextBox(editorOf(ctx), 'tbRl'), enabled: canInsert, reason: (ctx) => (insideBox(ctx) ? NO_NEST : null) },
  'insert.text.wordArt': {
    // With text selected in one paragraph that text moves into the box, as Word does.
    run: (ctx, arg) => {
      const sel = ctx.state.selection;
      const one = !sel.empty && !sel.node && sel.$from.sameParent(sel.$to) && sel.$from.parent.isTextblock;
      const content = one ? ctx.state.doc.slice(sel.from, sel.to).content.toJSON() : null;
      return insertBox(ctx, wordArtBox(arg ?? WORDART[0].id, content), one ? [sel.from, sel.to] : null);
    },
    enabled: canInsert,
    reason: (ctx) => (insideBox(ctx) ? NO_NEST : null),
  },

  // Text group
  'shapeFormat.text.textDirection': {
    run: (ctx, arg) => {
      if (arg === 'options') return ctx.pane('formatShape', true, { tab: 'layout', section: 'textBox' });
      const dirs = DIRS.map(([d]) => d);
      const now = box(ctx)?.node.attrs.dir ?? 'lrTb';
      return setBox(ctx, { dir: dirs.includes(arg) ? arg : dirs[(dirs.indexOf(now) + 1) % dirs.length] });
    },
    value: (ctx) => box(ctx)?.node.attrs.dir ?? null,
    ...onBox,
  },
  'shapeFormat.text.alignText': {
    run: (ctx, arg) => (VALIGNS.some(([v]) => v === arg) ? setBox(ctx, { vAlign: arg }) : false),
    value: (ctx) => box(ctx)?.node.attrs.vAlign ?? null,
    ...onBox,
  },
  'shapeFormat.text.createLink': {
    // Linked: Break Link. Otherwise the pointer arms; arg (a box position) links at once (scripts).
    run: (ctx, arg) => {
      const b = box(ctx);
      if (b.node.attrs.link) return setBox(ctx, { link: null });
      const ed = editorOf(ctx);
      if (typeof arg === 'number') {
        const why = linkBoxes(ed.view, b.pos, arg);
        if (why) ctx.toast(why);
        return !why;
      }
      return createLink(ed, (text) => ctx.toast(text));
    },
    label: (ctx) => (box(ctx)?.node.attrs.link ? 'Break Link' : 'Create Link'),
    active: (ctx) => !!box(ctx)?.node.attrs.link,
    ...onBox,
  },

  // Styled Text Styles group
  'shapeFormat.wordArtStyles.quickStyles': {
    run: (ctx, arg) => {
      const p = WORDART.find((w) => w.id === arg);
      return p ? formatText(ctx, { color: p.color, themeColor: p.themeColor, effects: p.effects }, { replace: true }) : false;
    },
    ...onBox,
  },
  'shapeFormat.wordArtStyles.textFill': {
    // arg: a colour, 'none', 'more' (the Colors dialog), 'grad:light', 'grad:dark', 'grad:none'; none: the last colour.
    run: async (ctx, arg) => {
      if (arg === 'none') return formatText(ctx, { effects: { fill: { type: 'none' } } });
      if (arg === 'grad:none') return formatText(ctx, { effects: { fill: null } });
      if (arg === 'grad:light' || arg === 'grad:dark') {
        const c = runNow(ctx).color ?? '#000000';
        const other = arg === 'grad:light' ? mix(c, 255, 0.6) : mix(c, 0, 0.5);
        return formatText(ctx, { effects: { fill: { type: 'gradient', angle: 90, stops: [{ pos: 0, color: other }, { pos: 100, color: c }] } } });
      }
      if (arg === 'more') arg = await ctx.dialog('colors', { value: runNow(ctx).color ?? null });
      const pick = arg === undefined ? lastFill : colorPick(ctx, arg);
      if (!pick) return false;
      lastFill = pick;
      return formatText(ctx, { color: pick.color, themeColor: pick.themeColor, effects: { fill: null } });
    },
    value: () => lastFill.color,
    repeatable: true,
    ...onBox,
  },
  'shapeFormat.wordArtStyles.textOutline': {
    // arg: a colour, 'none', 'more', 'w:<pt>' or 'd:<dash>'; none: the last colour.
    run: async (ctx, arg) => {
      const now = runNow(ctx).effects?.outline ?? { color: lastOutline.color, width: 0.75, dash: 'solid' };
      if (arg === 'none') return formatText(ctx, { effects: { outline: null } });
      if (typeof arg === 'string' && arg.startsWith('w:')) return formatText(ctx, { effects: { outline: { ...now, width: +arg.slice(2) } } });
      if (typeof arg === 'string' && arg.startsWith('d:')) return formatText(ctx, { effects: { outline: { ...now, dash: arg.slice(2) } } });
      if (arg === 'more') arg = await ctx.dialog('colors', { value: now.color ?? null });
      const pick = arg === undefined ? lastOutline : colorPick(ctx, arg);
      if (!pick) return false;
      lastOutline = pick;
      return formatText(ctx, { effects: { outline: { ...now, color: pick.color } } });
    },
    value: () => lastOutline.color,
    repeatable: true,
    ...onBox,
  },
  'shapeFormat.wordArtStyles.textEffects': {
    // arg: 'shadow:<id>', 'reflection:<id>', 'glow:<slot>', or '<kind>:none'; Bevel, 3-D Rotation and Transform give their reason.
    run: (ctx, arg) => {
      const [kind, id] = String(arg ?? '').split(':');
      if (kind === 'bevel' || kind === 'rotation3d') return ctx.toast(REASONS.render3d), false;
      if (kind === 'transform') return ctx.toast(WARP), false;
      if (id === 'none' && ['shadow', 'reflection', 'glow'].includes(kind)) return formatText(ctx, { effects: { [kind]: null } });
      if (kind === 'shadow' && SHADOWS[id]) return formatText(ctx, { effects: { shadow: SHADOWS[id][1] } });
      if (kind === 'reflection' && REFLECTIONS[id]) return formatText(ctx, { effects: { reflection: REFLECTIONS[id][1] } });
      if (kind === 'glow') return formatText(ctx, { effects: { glow: { color: resolveColor(themeOf(ctx), { slot: id }), size: 5, alpha: 0.6 } } });
      return false;
    },
    ...onBox,
  },
  'shapeFormat.wordArtStyles.launcher': {
    run: (ctx) => {
      ctx.pane('formatShape', true, { tab: 'text' });
      if (!paneOpen('formatShape')) ctx.toast(REASONS.pending);
      return true;
    },
    ...onBox,
  },
};


const sample = (p) => h('span', { className: 'flex items-center gap-2' },
  h('span', { className: 'w-8 text-center text-lg font-bold leading-none', style: reactStyle(previewCss(p)) }, 'A'), p.label);
const boxPreview = (d) => h('span', { className: 'flex items-center gap-2' },
  h('span', { className: 'h-5 w-7 shrink-0 rounded-[1px]', style: { background: d.attrs.fill === undefined ? '#FFFFFF' : d.attrs.fill ?? 'transparent',
    border: d.attrs.line === null ? '1px dashed #a6a6a6' : `1px solid ${d.attrs.line?.color ?? '#000000'}` } }), d.label);

// The engine's text box body (object.get) in this module's names.
const ENGINE_DIR = { horz: 'lrTb', vert: 'tbRl', vert270: 'btLr', stacked: 'stacked' };
const bodyNow = (ctx) => ctx.read('object.get', {})?.shape?.textBox;

export const GALLERIES = {
  'insert.text.textBox': both(() => TEXTBOX_GALLERY.map((d) => ({ id: d.id, label: d.label, group: 'Built-in', preview: boxPreview(d) }))),
  'insert.text.wordArt': both(() => WORDART.map((p) => ({ id: p.id, label: p.label, preview: sample(p) }))),
  'shapeFormat.wordArtStyles.quickStyles': both(() => WORDART.map((p) => ({ id: p.id, label: p.label, preview: sample(p) }))),
  'shapeFormat.text.textDirection': both((ctx) => [
    ...DIRS.map(([id, label]) => ({ id, label, active: box(ctx)?.node.attrs.dir === id })),
    { id: 'options', label: 'Text Direction Options...' },
  ], (ctx) => DIRS.map(([id, label]) => ({ id, label, active: ENGINE_DIR[bodyNow(ctx)?.dir] === id }))),
  'shapeFormat.text.alignText': both((ctx) => VALIGNS.map(([id, label]) => ({ id, label, active: box(ctx)?.node.attrs.vAlign === id })),
    (ctx) => VALIGNS.map(([id, label]) => ({ id, label, active: bodyNow(ctx)?.anchor === id }))),
  'shapeFormat.wordArtStyles.textFill': both((ctx) => {
    const r = runNow(ctx);
    return [
      { id: 'none', label: 'No Fill', active: r.effects?.fill?.type === 'none' },
      ...colorItems(ctx, r.effects?.fill ? null : r.color),
      { id: 'more', label: 'More Fill Colors...' },
      { id: 'grad:none', label: 'No Gradient', group: 'Gradient', active: r.effects?.fill?.type !== 'gradient' },
      { id: 'grad:light', label: 'Light Variation', group: 'Gradient' },
      { id: 'grad:dark', label: 'Dark Variation', group: 'Gradient' },
    ];
  }, () => [{ id: 'none', label: 'No Fill' }, { id: 'more', label: 'More Fill Colors...' }, { id: 'grad:none', label: 'No Gradient', group: 'Gradient' },
    { id: 'grad:light', label: 'Light Variation', group: 'Gradient' }, { id: 'grad:dark', label: 'Dark Variation', group: 'Gradient' }]),
  'shapeFormat.wordArtStyles.textOutline': both((ctx) => {
    const o = runNow(ctx).effects?.outline;
    return [
      { id: 'none', label: 'No Outline', active: !o },
      ...colorItems(ctx, o?.color),
      { id: 'more', label: 'More Outline Colors...' },
      ...WEIGHTS.map((w) => ({ id: `w:${w}`, label: `${w} pt`, group: 'Weight', active: o?.width === w })),
      ...DASHES.map(([id, label]) => ({ id: `d:${id}`, label, group: 'Dashes', active: (o?.dash ?? null) === id })),
    ];
  }, () => [{ id: 'none', label: 'No Outline' }, { id: 'more', label: 'More Outline Colors...' },
    ...WEIGHTS.map((w) => ({ id: `w:${w}`, label: `${w} pt`, group: 'Weight' }))]),
  'shapeFormat.wordArtStyles.textEffects': (ctx) => {
    const e = runNow(ctx).effects ?? {};
    return [
      { id: 'shadow:none', label: 'No Shadow', group: 'Shadow', active: !e.shadow },
      ...Object.entries(SHADOWS).map(([id, [label]]) => ({ id: `shadow:${id}`, label, group: 'Shadow' })),
      { id: 'reflection:none', label: 'No Reflection', group: 'Reflection', active: !e.reflection },
      ...Object.entries(REFLECTIONS).map(([id, [label]]) => ({ id: `reflection:${id}`, label, group: 'Reflection' })),
      { id: 'glow:none', label: 'No Glow', group: 'Glow', active: !e.glow },
      ...THEME_SLOTS.slice(2).map(([slot, label]) => ({ id: `glow:${slot}`, label: `${label} glow`, group: 'Glow',
        preview: swatch(resolveColor(themeOf(ctx), { slot }), `${label} glow`) })),
      { id: 'bevel:on', label: 'Bevel', group: 'Bevel', desc: 'Needs 3-D' },
      { id: 'rotation3d:on', label: '3-D Rotation', group: '3-D Rotation', desc: 'Needs 3-D' },
      { id: 'transform:on', label: 'Transform', group: 'Transform', desc: 'Needs text warping' },
    ];
  },
};
