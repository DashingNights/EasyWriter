// Outline view's display (docs/plans/word/plan.md §3 outline): node decorations that indent each top-level block by its outline
// level, draw its outline symbol and hide collapsed blocks, never a document change; the view state (Show Level, the
// headings' own Expand and Collapse limits, Show First Line Only, Show Text Formatting) lives in this plugin, apart from
// paragraph.collapsed (navpane's collapsible headings in Print Layout), and the collapse state resets when the view closes.
// Also Tab and Shift+Tab, which demote and promote in Outline view, and the symbols' click, double-click and drag.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { ReplaceAroundStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getState, subscribe } from '../../../app/store.js';
import { wordSettings } from '../../word/settings.mjs';
import { BODY, blocksOf, firstLineOf, indentsOf, moveOrder, shownOf, symbolOf } from './levels.mjs';

export const outlineKey = new PluginKey('wordOutline');

const INITIAL = { on: false, limit: BODY, over: new Map(), firstLine: false, plain: false, font: null, deco: DecorationSet.empty, blocks: [], shown: [], sig: [] };

/** Whether `view` is the open Document's main editor: story sub-editors and the assistant's hidden session editors get no
 * Outline view. */
export const isMain = (view) => view.dom.isConnected && !view.dom.closest('[data-story]') && !!view.dom.closest('#editor');

/** The plugin state's per-heading limits as a Map(block index → limit) for the pure functions of levels.mjs. */
export function viewOf(s, blocks = s.blocks) {
  const at = new Map(blocks.map((b, i) => [b.pos, i]));
  const over = new Map();
  for (const [pos, lim] of s.over) if (at.has(pos)) over.set(at.get(pos), lim);
  return { limit: s.limit, over };
}

/** Recomputes the blocks, the shown set and the decorations of `doc` for state `s`. When every block draws as it did in
 * `prev` (typing inside a paragraph), the old decorations map through `mapping` instead: DecorationSet.create costs about
 * 14 ms for 2,000 paragraphs, its map about 6 ms (both scan the top-level blocks once per decoration). */
function build(doc, s, prev, mapping) {
  if (!s.on) return { ...s, deco: DecorationSet.empty, blocks: [], shown: [], sig: [] };
  const blocks = blocksOf(doc);
  const view = viewOf(s, blocks);
  const shown = shownOf(blocks, view);
  const indents = indentsOf(blocks);
  const first = firstLineOf(blocks, s.firstLine);
  const attrs = blocks.map((b, i) => {
    const sym = symbolOf(blocks, i);
    const a = {
      'data-outline-symbol': sym === 'body' ? 'circle' : sym,
      'data-outline-level': String(b.level),
      style: `--ol-indent: ${indents[i]}`,
    };
    if (!shown[i]) a['data-outline-hidden'] = '';
    if (first[i]) a['data-outline-first'] = '';
    // Word underlines a heading whose subordinate text is collapsed; we mark it so CSS can draw that.
    if (sym === 'plus' && shown[i] && !shown[i + 1]) a['data-outline-collapsed'] = '';
    return a;
  });
  const sig = attrs.map((a) => Object.entries(a).join('|'));
  let deco = null;
  if (prev?.on && prev.sig.length === sig.length && sig.every((x, i) => x === prev.sig[i])) {
    deco = mapping ? prev.deco.map(mapping, doc) : prev.deco;
    if (deco.find().length !== blocks.length) deco = null; // a block replaced whole loses its decoration: draw again
  }
  deco ??= DecorationSet.create(doc, blocks.map((b, i) => Decoration.node(b.pos, b.end, attrs[i])));
  return { ...s, blocks, shown, sig, deco };
}

/** The per-heading limits after `tr`. A block rewrapped in place (setNodeMarkup's ReplaceAroundStep at its start: a level
 * change or its undo) keeps its limit; a moved block's limit follows it (`remap`: [[oldPos, newPos]], or the same node object
 * when undo or redo puts a moved run back); others map, and deleted ones go. */
export function remapOver(over, tr, remap) {
  const moved = new Map(remap ?? []);
  const out = new Map();
  let byNode = null;
  for (const [pos, lim] of over) {
    if (moved.has(pos)) {
      out.set(moved.get(pos), lim);
      continue;
    }
    let p = pos;
    tr.steps.forEach((step, k) => {
      if (p == null) return;
      const inPlace = step instanceof ReplaceAroundStep && step.from === p && step.gapFrom === p + 1 && step.insert === 1;
      const r = tr.mapping.maps[k].mapResult(p, inPlace ? -1 : 1);
      p = r.deleted ? null : r.pos;
    });
    if (p == null) {
      if (!byNode) {
        byNode = new Map();
        tr.doc.forEach((n, off) => byNode.set(n, off));
      }
      p = byNode.get(tr.before.nodeAt(pos)) ?? null;
    }
    if (p != null) out.set(p, lim);
  }
  return out;
}

/** The plugin's state patch through a transaction: {on, font, limit, over, firstLine, plain}; on false clears the collapse state. */
export const setOutline = (tr, patch, remap) => tr.setMeta(outlineKey, { patch, remap });

/** The index of the hidden block holding position `pos`, else -1. */
const hiddenAt = (s, pos) => s.blocks.findIndex((b, i) => !s.shown[i] && pos >= b.pos && pos <= b.end);

/** Runs the replace of the run of blocks `a`-`e` to gap `gap` in one step (as a drag move makes), so lists and suggestion
 * records travel with their paragraphs and one undo restores the order; the selection and the moved headings' limits follow
 * → the transaction, or null when the run stays. */
export function moveRunTr(state, blocks, a, e, gap) {
  const plan = moveOrder(a, e, gap);
  if (!plan) return null;
  const from = blocks[plan.lo].pos;
  const to = blocks[plan.hi].end;
  const tr = state.tr.replaceWith(from, to, plan.order.map((i) => blocks[i].node));
  const remap = [];
  let at = from;
  for (const i of plan.order) {
    remap.push([blocks[i].pos, at]);
    at += blocks[i].node.nodeSize;
  }
  const shift = remap.find(([old]) => old === blocks[a].pos)[1] - blocks[a].pos;
  const { anchor, head } = state.selection;
  const inRun = (p) => p >= blocks[a].pos && p <= blocks[e].end;
  if (inRun(anchor) && inRun(head)) {
    try {
      tr.setSelection(TextSelection.between(tr.doc.resolve(anchor + shift), tr.doc.resolve(head + shift)));
    } catch { /* a selection that cannot sit there keeps the mapped one */ }
  }
  return setOutline(tr, {}, remap).scrollIntoView();
}

/** The extension: the plugin, and Tab and Shift+Tab in Outline view (ahead of Lists' Tab, behind Word's keys). `act` holds the
 * commands the keys and the symbols run: {level(view, dir) → bool, toggle(view, index), moveTo(view, a, gap), shift(view, a, steps)}. */
export function outlineExtension(act) {
  return Extension.create({
    name: 'wordOutline',
    priority: 1150,
    addKeyboardShortcuts() {
      const tab = (dir) => ({ editor }) => {
        const s = outlineKey.getState(editor.state);
        if (!s?.on) return false;
        const { $from } = editor.state.selection;
        for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table') return false; // a table keeps Tab for its cells
        act.level(editor.view, dir);
        return true; // Word types no tab here, even when the level cannot change (Heading 9)
      };
      return { Tab: tab(1), 'Shift-Tab': tab(-1) };
    },
    addProseMirrorPlugins() {
      return [new Plugin({
        key: outlineKey,
        state: {
          init: () => INITIAL,
          apply(tr, prev, _old, state) {
            const meta = tr.getMeta(outlineKey);
            let s = prev;
            if (tr.docChanged && s.over.size) s = { ...s, over: remapOver(s.over, tr, meta?.remap) };
            if (meta?.patch) {
              s = { ...s, ...meta.patch };
              if (meta.patch.on === false) s = { ...s, limit: BODY, over: new Map() };
            }
            return s === prev && !tr.docChanged ? prev : build(state.doc, s, prev, tr.docChanged ? tr.mapping : null);
          },
        },
        props: {
          decorations: (state) => outlineKey.getState(state).deco,
          attributes: (state) => {
            const s = outlineKey.getState(state);
            if (!s.on) return {};
            const a = { 'data-outline-view': '' };
            if (s.plain) {
              // One size for all: Normal's (the document defaults' run size), as Word draws plain outline text.
              a['data-outline-plain'] = '';
              const size = state.doc.attrs.styles?.defaults?.run?.size;
              a.style = `--ol-size: ${Number(size) > 0 ? size : 12}pt;${s.font ? ` --ol-font: ${JSON.stringify(s.font)};` : ''}`;
            }
            return a;
          },
          handleDOMEvents: {
            mousedown: (view, e) => symbolDown(view, e, act),
          },
        },
        // A selection that lands in collapsed text (a click, find, undo) moves to the end of the shown block above it.
        appendTransaction(trs, _old, state) {
          const s = outlineKey.getState(state);
          if (!s.on || !trs.some((t) => t.docChanged || t.selectionSet || t.getMeta(outlineKey))) return null;
          const i = hiddenAt(s, state.selection.head);
          if (i < 0) return null;
          let j = i;
          while (j >= 0 && !s.shown[j]) j--;
          if (j < 0) for (j = i; j < s.blocks.length && !s.shown[j]; j++);
          const b = s.blocks[j];
          if (!b) return null;
          return state.tr.setSelection(TextSelection.near(state.doc.resolve(j < i ? b.end - 1 : b.pos + 1), j < i ? -1 : 1));
        },
        view(view) {
          const sync = () => {
            if (view.isDestroyed || !isMain(view)) return;
            const st = getState();
            const on = st.word?.view === 'outline';
            const font = wordSettings(st.settings ?? {}).display?.draftFont ?? null;
            const s = outlineKey.getState(view.state);
            if (s.on !== on || s.font !== font) view.dispatch(setOutline(view.state.tr, { on, font }).setMeta('addToHistory', false));
          };
          const t = setTimeout(sync, 0); // the editor finishes mounting first (a view cannot dispatch while it is built)
          const off = subscribe(sync);
          return { destroy() { clearTimeout(t); off(); } };
        },
      })];
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The outline symbols: a click selects the heading with its subtree, a double-click on a plus expands or collapses it, and a
// drag moves the subtree up or down (a guide line shows the gap) or promotes and demotes it left and right.

const GUTTER = 24; // px of a block's left padding where its symbol sits (style.css draws it there)
const DRAG = 6;
const STEP_PX = 48; // half an inch at 96 dpi: one level per step of a horizontal drag

/** The shown block whose symbol is under pointer event `e` → its index, or -1. */
function symbolIndex(view, s, e) {
  for (let i = 0; i < s.blocks.length; i++) {
    if (!s.shown[i]) continue;
    const dom = view.nodeDOM(s.blocks[i].pos);
    if (!(dom instanceof HTMLElement)) continue;
    const r = dom.getBoundingClientRect();
    if (e.clientY >= r.top && e.clientY < r.bottom && e.clientX >= r.left && e.clientX < r.left + GUTTER) return i;
  }
  return -1;
}

/** The gap (block index the run goes before) nearest pointer y among the shown blocks, and its y for the guide line. */
function gapAt(view, s, y) {
  let best = null;
  for (let i = 0; i <= s.blocks.length; i++) {
    if (i < s.blocks.length && !s.shown[i]) continue;
    const dom = i < s.blocks.length ? view.nodeDOM(s.blocks[i].pos) : null;
    let gy;
    if (dom instanceof HTMLElement) gy = dom.getBoundingClientRect().top;
    else {
      const last = [...s.blocks.keys()].reverse().find((k) => s.shown[k]);
      const ld = last == null ? null : view.nodeDOM(s.blocks[last].pos);
      if (!(ld instanceof HTMLElement)) continue;
      gy = ld.getBoundingClientRect().bottom;
    }
    if (!best || Math.abs(gy - y) < Math.abs(best.y - y)) best = { gap: i, y: gy };
  }
  return best;
}

function symbolDown(view, e, act) {
  const s = outlineKey.getState(view.state);
  if (!s?.on || e.button !== 0) return false;
  const i = symbolIndex(view, s, e);
  if (i < 0) return false;
  e.preventDefault();
  view.focus();
  if (e.detail >= 2) {
    if (s.blocks[i].level < BODY) act.toggle(view, i);
    return true;
  }
  act.selectSubtree(view, i);
  const x0 = e.clientX;
  const y0 = e.clientY;
  const area = view.dom.closest('#editor-area') ?? document.body;
  let guide = null;
  let target = null;
  const move = (m) => {
    if (Math.abs(m.clientY - y0) < DRAG) return;
    const g = gapAt(view, outlineKey.getState(view.state), m.clientY);
    if (!g) return;
    target = g.gap;
    if (!guide) {
      guide = document.createElement('div');
      guide.setAttribute('data-outline-guide', '');
      area.appendChild(guide);
    }
    const r = view.dom.getBoundingClientRect();
    Object.assign(guide.style, { top: `${g.y - 1}px`, left: `${r.left}px`, width: `${r.width}px` });
  };
  const up = (u) => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
    guide?.remove();
    const dx = u.clientX - x0;
    if (target != null && Math.abs(u.clientY - y0) >= DRAG) act.moveTo(view, i, target);
    else if (Math.abs(dx) >= STEP_PX / 2) act.shift(view, i, Math.sign(dx) * Math.max(1, Math.round(Math.abs(dx) / STEP_PX)));
  };
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', up, true);
  return true;
}
