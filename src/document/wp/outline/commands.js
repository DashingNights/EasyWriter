// The Outlining tab's commands, the outline keys and the View > Outline toggle (docs/plans/word/plan.md §3 outline, §1.13).
// Levels change through the built-in heading styles (Heading 1 to 6 are heading nodes, 7 to 9 paragraph styles, body text
// Normal), except a paragraph whose level comes from its own paragraph.outline, which changes that attribute.
import { TextSelection } from '@tiptap/pm/state';
import { setWord } from '../../../tooling/ribbon/contexts.js';
import { BUILTIN_STYLES } from '../../defaults.mjs';
import { ensureStyles } from '../../model/styles.mjs';
import { restyleBlock } from '../../schema.js';
import {
  BODY, blocksOf, collapseStep, expandStep, levelChanges, levelLabel, moveGap, parentOf, runEnd, subtreeEnd,
} from './levels.mjs';
import { isMain, moveRunTr, outlineKey, setOutline, viewOf } from './plugin.js';
import { both } from '../../../tooling/engine-provider.mjs';

const LEVELS = Array.from({ length: 9 }, (_, i) => i);

/** The blocks and shown set of `view`'s document; outside Outline view (Alt+Shift+Up and Down, Promote and Demote by key)
 * the same tree with every block shown. */
function treeOf(view) {
  const s = outlineKey.getState(view.state);
  if (s?.on && s.blocks.length) return { s, blocks: s.blocks, shown: s.shown, on: true };
  const blocks = blocksOf(view.state.doc);
  return { s, blocks, shown: blocks.map(() => true), on: false };
}

/** The top-level block indices `[a, b]` the selection touches. */
function selRange(state, blocks) {
  const { from, to } = state.selection;
  const n = blocks.length - 1;
  const a = Math.min(n, state.doc.resolve(from).index(0));
  const b = Math.max(a, Math.min(n, state.doc.resolve(Math.max(from, to === from ? to : to - 1)).index(0)));
  return [a, b];
}

/** The selected block indices, with each collapsed heading's hidden subtree, so a collapsed heading shifts as a whole. */
function selected(state, t) {
  const [a, b] = selRange(state, t.blocks);
  const out = new Set();
  for (let i = a; i <= b; i++) {
    out.add(i);
    if (t.on && t.blocks[i].level < BODY && t.shown[i] && !t.shown[i + 1]) for (let j = i + 1; j < subtreeEnd(t.blocks, i); j++) out.add(j);
  }
  return [...out].sort((x, y) => x - y);
}

/** Sets block `node` at `pos` to outline level `level` in `tr`, through the Home tab's setStyle path (restyleBlock). */
function setLevel(tr, pos, node, level) {
  if (Number.isInteger(node.attrs.outline)) return tr.setNodeAttribute(pos, 'outline', level);
  if (!node.isTextblock) return tr; // a table or an object stays body text
  const id = level < BODY ? `Heading${level + 1}` : null;
  if (level >= 6 && id) {
    const styles = ensureStyles(tr.doc, { [id]: BUILTIN_STYLES[id] });
    if (styles) tr.setDocAttribute('styles', styles);
  }
  return restyleBlock(tr, node, pos, id);
}

/** A collapsed heading's limit after its level moves from `from` to `to`: it moves by the same steps, as its subtree does,
 * so the same levels stay hidden; BODY (all shown) stays. */
const shiftLimit = (lim, from, to) => (lim >= BODY ? lim : Math.max(to, Math.min(BODY - 1, lim + to - from)));

/** Applies Map(index → level) `changes` to `view` in one step → whether anything changed. Positions stay (a level change
 * rewraps a block in place), so the changed headings keep their collapse limits. */
function applyLevels(view, blocks, changes) {
  if (!changes.size) return false;
  const tr = view.state.tr;
  for (const [i, level] of changes) setLevel(tr, blocks[i].pos, tr.doc.nodeAt(blocks[i].pos), level);
  const s = outlineKey.getState(view.state);
  if (s?.over.size) {
    const over = new Map(s.over);
    for (const [i, level] of changes) if (over.has(blocks[i].pos)) over.set(blocks[i].pos, shiftLimit(over.get(blocks[i].pos), blocks[i].level, level));
    setOutline(tr, { over });
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Promote (dir -1) or Demote (+1) the selected blocks, or set them all to level `to` → whether anything changed. */
function level(view, dir, to = null) {
  const t = treeOf(view);
  if (!t.blocks.length) return false;
  return applyLevels(view, t.blocks, levelChanges(t.blocks, selected(view.state, t), dir, to));
}

/** Moves the selected blocks (a collapsed heading's hidden subtree with them) past the previous or next shown block. */
function move(view, dir) {
  const t = treeOf(view);
  if (!t.blocks.length) return false;
  const [a, b] = selRange(view.state, t.blocks);
  const gap = moveGap(t.shown, a, b, dir);
  if (gap == null) return false;
  const tr = moveRunTr(view.state, t.blocks, a, runEnd(t.shown, b), gap);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}

/** Selects heading `i` with its subtree (a click on its symbol), or body block `i`. */
function selectSubtree(view, i) {
  const t = treeOf(view);
  const first = t.blocks[i];
  const last = t.blocks[subtreeEnd(t.blocks, i) - 1];
  const { doc } = view.state;
  const sel = TextSelection.between(doc.resolve(first.pos + (first.node.isTextblock ? 1 : 0)), doc.resolve(last.end - (last.node.isTextblock ? 1 : 0)));
  view.dispatch(view.state.tr.setSelection(sel));
}

/** The headings Expand and Collapse act on: each selected heading, and the heading above each selected body block. */
function headingsOf(view, t) {
  const [a, b] = selRange(view.state, t.blocks);
  const out = new Set();
  for (let i = a; i <= b; i++) {
    const h = t.blocks[i].level < BODY ? i : parentOf(t.blocks, i);
    if (h >= 0) out.add(h);
  }
  return [...out];
}

/** Sets heading limits Map(index → limit | 'clear-under') in the plugin → whether any was set. */
function setLimits(view, t, limits, clearUnder = []) {
  if (!limits.size) return false;
  const over = new Map(t.s.over);
  for (const i of clearUnder) for (let j = i + 1; j < subtreeEnd(t.blocks, i); j++) over.delete(t.blocks[j].pos);
  for (const [i, lim] of limits) over.set(t.blocks[i].pos, lim);
  view.dispatch(setOutline(view.state.tr, { over }));
  return true;
}

/** Expand: one more level under the selected headings; 'toggle' (Alt+Shift+=) shows a collapsed heading's whole subtree or
 * hides a shown one. */
function expand(view, arg) {
  const t = treeOf(view);
  if (!t.on) return false;
  const v = viewOf(t.s, t.blocks);
  const hs = headingsOf(view, t);
  const limits = new Map();
  if (arg === 'toggle') {
    const clear = [];
    for (const h of hs) {
      const hidden = t.blocks.slice(h + 1, subtreeEnd(t.blocks, h)).some((_, k) => !t.shown[h + 1 + k]);
      limits.set(h, hidden ? BODY : t.blocks[h].level);
      if (!hidden) clear.push(h);
    }
    return setLimits(view, t, limits, clear);
  }
  for (const h of hs) {
    const n = expandStep(t.blocks, h, v);
    if (n != null) limits.set(h, n);
  }
  return setLimits(view, t, limits);
}

/** Collapse: the lowest shown level under the selected headings hides. */
function collapse(view) {
  const t = treeOf(view);
  if (!t.on) return false;
  const v = viewOf(t.s, t.blocks);
  const limits = new Map();
  for (const h of headingsOf(view, t)) {
    const n = collapseStep(t.blocks, h, v);
    if (n != null) limits.set(h, n);
  }
  return setLimits(view, t, limits, [...limits.keys()]);
}

/** Double-click on a plus symbol: the heading's subtree shows whole or hides. */
function toggle(view, i) {
  const t = treeOf(view);
  const hidden = t.blocks.slice(i + 1, subtreeEnd(t.blocks, i)).some((_, k) => !t.shown[i + 1 + k]);
  return setLimits(view, t, new Map([[i, hidden ? BODY : t.blocks[i].level]]), hidden ? [] : [i]);
}

/** Show Level: levels 1 to `n` (null: all levels, body text included); the headings' own limits go. */
function showLevel(view, n) {
  const s = outlineKey.getState(view.state);
  if (!s?.on) return false;
  view.dispatch(setOutline(view.state.tr, { limit: n == null ? BODY : n - 1, over: new Map() }));
  return true;
}

/** Alt+Shift+A: all text, or only the headings when everything shows. */
function showAll(view) {
  const t = treeOf(view);
  if (!t.on) return false;
  return showLevel(view, t.shown.every(Boolean) ? BODY : null);
}

/** Drag on a symbol: block `i`'s subtree goes before gap `gap`. */
function moveTo(view, i, gap) {
  const t = treeOf(view);
  const e = Math.max(runEnd(t.shown, i), subtreeEnd(t.blocks, i) - 1);
  const tr = moveRunTr(view.state, t.blocks, i, e, gap);
  if (tr) view.dispatch(tr);
}

/** Drag left or right on a symbol: the selected subtree moves `steps` levels (negative promotes). */
function shift(view, _i, steps) {
  for (let k = 0; k < Math.abs(steps); k++) level(view, Math.sign(steps));
}

/** What the plugin's keys and symbols run (plugin.js outlineExtension). */
export const ACT = { level: (view, dir) => level(view, dir), toggle, moveTo, shift, selectSubtree };

// ---------------------------------------------------------------------------------------------
// Commands (plan.md §1.3): they act on the target editor; the outline-only ones on the main editor in Outline view.

const viewIn = (ctx) => ctx.target?.view ?? null;
const outlineView = (ctx) => (ctx.view === 'outline' && ctx.ed?.view && isMain(ctx.ed.view) ? ctx.ed.view : null);
const inOutline = (ctx) => !!outlineView(ctx);
const plugin = (ctx) => (ctx.ed ? outlineKey.getState(ctx.ed.state) : null);
const OUTLINE_ONLY = { enabled: inOutline, reason: (ctx) => (inOutline(ctx) ? null : 'Works in Outline view.') };
const LEVEL_IDS = [...LEVELS.map((l) => `level${l + 1}`), 'bodyText'];
const levelFromId = (id) => (id === 'bodyText' ? BODY : /^level([1-9])$/.test(id ?? '') ? +id.slice(5) - 1 : null);

/** The selection's first block's level in `ctx`'s target, or null. */
function selLevel(ctx) {
  const view = viewIn(ctx);
  if (!view) return null;
  const t = treeOf(view);
  if (!t.blocks.length) return null;
  return t.blocks[selRange(view.state, t.blocks)[0]].level;
}

const run = (fn) => (ctx, arg) => {
  const view = viewIn(ctx);
  return view ? fn(view, arg) : false;
};
const runOutline = (fn) => (ctx, arg) => {
  const view = outlineView(ctx);
  return view ? fn(view, arg) : false;
};
const setDisplay = (ctx, patch) => {
  const view = outlineView(ctx);
  if (!view) return false;
  view.dispatch(setOutline(view.state.tr, patch));
  return true;
};

const promote = { run: run((v) => level(v, -1)), enabled: (ctx) => !!ctx.state };
const demote = { run: run((v) => level(v, 1)), enabled: (ctx) => !!ctx.state };
const moveUp = { run: run((v) => move(v, -1)), enabled: (ctx) => !!ctx.state };
const moveDown = { run: run((v) => move(v, 1)), enabled: (ctx) => !!ctx.state };
const firstLine = {
  ...OUTLINE_ONLY,
  run: (ctx) => setDisplay(ctx, { firstLine: !plugin(ctx)?.firstLine }),
  active: (ctx) => inOutline(ctx) && !!plugin(ctx)?.firstLine,
};
const showLevelValue = (ctx) => {
  const s = plugin(ctx);
  if (!s?.on) return '';
  return s.limit >= BODY ? 'All Levels' : levelLabel(s.limit);
};

export const COMMANDS = {
  'view.views.outline': {
    run: () => setWord({ view: 'outline' }),
    active: (ctx) => ctx.view === 'outline',
  },
  'outlining.close.closeOutlineView': { run: () => setWord({ view: 'print' }) },
  'outlining.outlineTools.promoteToHeading1': { run: run((v) => level(v, 0, 0)), enabled: (ctx) => !!ctx.state },
  'outlining.outlineTools.promote': promote,
  'outlining.outlineTools.demote': demote,
  'outlining.outlineTools.demoteToBodyText': { run: run((v) => level(v, 0, BODY)), enabled: (ctx) => !!ctx.state },
  'outlining.outlineTools.outlineLevel': {
    run: run((v, arg) => {
      const l = typeof arg === 'number' ? arg : levelFromId(arg);
      return l == null ? false : level(v, 0, l);
    }),
    enabled: (ctx) => !!ctx.state,
    value: (ctx) => {
      const l = selLevel(ctx);
      return l == null ? '' : levelLabel(l);
    },
  },
  'outlining.outlineTools.moveUp': moveUp,
  'outlining.outlineTools.moveDown': moveDown,
  'outlining.outlineTools.expand': { ...OUTLINE_ONLY, run: runOutline(expand) },
  'outlining.outlineTools.collapse': { ...OUTLINE_ONLY, run: runOutline(collapse) },
  'outlining.outlineTools.showLevel': {
    ...OUTLINE_ONLY,
    run: runOutline((v, arg) => {
      if (arg === 'allLevels' || arg == null) return showLevel(v, null);
      const l = levelFromId(arg);
      return l == null || l >= BODY ? false : showLevel(v, l + 1);
    }),
    value: showLevelValue,
  },
  'outlining.outlineTools.showTextFormatting': {
    ...OUTLINE_ONLY,
    run: (ctx) => setDisplay(ctx, { plain: !plugin(ctx)?.plain }),
    active: (ctx) => !inOutline(ctx) || !plugin(ctx)?.plain,
  },
  'outlining.outlineTools.showFirstLineOnly': firstLine,
  // The outline keys' feature ids run what their buttons run (index.json `same` and the brief).
  'outline.promote': promote,
  'outline.demote': demote,
  'outline.moveUp': moveUp,
  'outline.moveDown': moveDown,
  'outline.firstLine': firstLine,
  'outline.showAllHeadings': { ...OUTLINE_ONLY, run: runOutline(showAll) },
  ...Object.fromEntries(LEVELS.map((l) => [`outline.showHeading${l + 1}`, { ...OUTLINE_ONLY, run: runOutline((v) => showLevel(v, l + 1)) }])),
};

/** The Outline Level and Show Level lists (probe menus outline.outlining.outline-level and show-level). On a canvas draft they read
 * the engine's state (outline.level: 1-9 or 10 for body text; outline.showLevel: 0 for all), so they are flagged `engine`. */
const engineLevel = (ctx) => {
  const n = ctx.engineState?.['outline.level']?.value;
  return n == null ? null : n >= 10 ? BODY : n - 1;
};
const engineShown = (ctx) => {
  if (ctx.view !== 'outline') return '';
  const n = ctx.engineState?.['outline.showLevel']?.value;
  return !n ? 'All Levels' : levelLabel(n - 1);
};

export const GALLERIES = {
  'outlining.outlineTools.outlineLevel': both((ctx) => {
    const now = ctx.engine ? engineLevel(ctx) : selLevel(ctx);
    return LEVEL_IDS.map((id) => ({ id, label: levelLabel(levelFromId(id)), active: now === levelFromId(id) }));
  }),
  'outlining.outlineTools.showLevel': both((ctx) => {
    const now = ctx.engine ? engineShown(ctx) : showLevelValue(ctx);
    return [...LEVELS.map((l) => ({ id: `level${l + 1}`, label: levelLabel(l) })), { id: 'allLevels', label: 'All Levels' }]
      .map((it) => ({ ...it, active: it.label === now }));
  }),
};
