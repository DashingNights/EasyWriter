// Tab layout in the editor (docs/plans/word/plan.md §1.9, briefs/tabs.md "How to build it"): every tab character is an inline
// decoration span[data-tab] and every ptab node gets a node decoration, each with its width in layout px; numbered paragraphs get
// --w-num-tab (G3). The widths come from a 'before' layout pass that pagination runs in its own frame ahead of its measure, so no
// frame paints stale boxes. Only paragraphs holding a tab, a ptab, a list number or a bar stop are laid out (plus, once, a paragraph
// that lost them, so its old decorations go), and each is cached by its node, its parent, its box, the column width and the
// document's stop settings, so a keypress measures only the paragraph it changed.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { nodeDOMs } from '../../geometry.js';
import { tabStopsOf } from '../../model/tabs.mjs';
import { levelOf } from '../../numbering.mjs';
import { barsDom, boxStyle, layoutJobs, paraStyle } from './measure.js';

export const tabsKey = new PluginKey('wordTabs');

const box = (attrs, style) => ({ nodeName: 'span', 'data-tab': '', 'data-align': 'default', 'data-leader': 'none', ...attrs, style });
// A tab typed or pasted gets a box at once, so the pass finds one box per tab; the pass sizes it before the frame paints.
const PLACEHOLDER = box({}, 'width:0px;tab-size:0px');

/** {count of tabs and ptabs, numbered} of textblock `node`, cached per node (barOf adds its bar flag per styles object). */
const needs = new WeakMap();
function needOf(node) {
  let n = needs.get(node);
  if (!n) {
    let count = 0;
    node.descendants((c) => {
      if (c.isText) for (const ch of c.text) count += ch === '\t' ? 1 : 0;
      else if (c.type.name === 'ptab') count++;
    });
    n = { count, num: !!node.attrs.numbering };
    needs.set(node, n);
  }
  return n;
}

/** Whether textblock `node`'s merged stops hold a bar: Word draws a bar stop's line through the paragraph with or without a tab. */
function barOf(doc, node) {
  const n = needOf(node);
  if (n.barStyles !== doc.attrs.styles) {
    n.barStyles = doc.attrs.styles;
    n.bar = tabStopsOf(doc, node).stops.some((s) => s.align === 'bar');
  }
  return n.bar;
}

/** The decimal stop (pt) of textblock `node` when it sits in a table cell without a tab: Word aligns its number on that stop
 * (briefs/tabs.md, "Tabs in table cells" in the fixture). → pos or null */
function cellDecOf(doc, node, parent) {
  const n = needOf(node);
  if (n.count || !/^table(Cell|Header)$/.test(parent?.type.name ?? '')) return null;
  if (n.decStyles !== doc.attrs.styles) {
    n.decStyles = doc.attrs.styles;
    n.dec = tabStopsOf(doc, node).stops.find((s) => s.align === 'decimal')?.pos ?? null;
  }
  return n.dec;
}

/** Calls `f(pos, isPtab)` for each tab character and ptab inside textblock `node` at `pos`, in document order. */
function eachTab(node, pos, f) {
  node.descendants((c, off) => {
    const at = pos + 1 + off;
    if (c.isText) {
      for (let i = c.text.indexOf('\t'); i >= 0; i = c.text.indexOf('\t', i + 1)) f(at + i, false);
    } else if (c.type.name === 'ptab') f(at, true);
  });
}

/** The ranges of `tr`'s final document that its steps replaced. */
function changedRanges(tr) {
  const out = [];
  const { maps } = tr.mapping;
  maps.forEach((map, i) => map.forEach((a, b, from, to) => {
    for (let k = i + 1; k < maps.length; k++) {
      from = maps[k].map(from, -1);
      to = maps[k].map(to, 1);
    }
    out.push([from, Math.min(to, tr.doc.content.size)]);
  }));
  return out;
}

const isOurs = (s) => s.wordTab != null || s.wordPara != null;

function breakDom(view) {
  const br = view.dom.ownerDocument.createElement('br');
  br.setAttribute('data-tab-break', '');
  return br;
}

/** The decorations of paragraph `node` at `pos` from its layout result `r`, tagged with the result's signature `sig`; none when the
 * result sets nothing (a paragraph whose last tab, bar or number went). */
function decosOf(node, pos, r, sig) {
  if (!r.items.length && !r.ext && !r.bars.length && r.numTab == null && !r.dec) return [];
  const out = [Decoration.node(pos, pos + node.nodeSize, {
    ...(r.ext ? { 'data-tab-ext': '' } : {}), ...(r.dec ? { 'data-tab-dec': '' } : {}), ...(r.bars.length ? { 'data-tab-has-bars': '' } : {}), style: paraStyle(r) }, { wordPara: sig })];
  let i = 0;
  eachTab(node, pos, (p, ptab) => {
    const it = r.items[i++];
    if (!it) return;
    // A tab that does not fit on its line starts the next one (measure.js puts the same break in while it measures).
    if (it.wrap) out.push(Decoration.widget(p, breakDom, { side: -1, key: 'tab-break', wordTab: 1, ignoreSelection: true }));
    if (ptab) out.push(Decoration.node(p, p + 1, { style: boxStyle(it) }, { wordTab: 1 }));
    else out.push(Decoration.inline(p, p + 1, box({ 'data-align': it.align, 'data-leader': it.leader }, boxStyle(it)), { wordTab: 1 }));
  });
  if (r.bars.length) {
    out.push(Decoration.widget(pos + 1, (view) => barsDom(view.dom.ownerDocument, r.bars),
      { side: -1, key: `tab-bars:${r.bars.join()}`, wordTab: 1, ignoreSelection: true }));
  }
  return out;
}

const memo = new WeakMap(); // paragraph node → {parent, gkey, styles, numbering, label, geo, sig}
const tops = new WeakMap(); // top-level node → {styles, none (no paragraph in it to lay out), gkey, numbering, geo, labels: [[el, label]]}
// The paragraph's box in layout px: a section's margins or columns move or narrow it without changing the editor's width. Read after
// layout too, so our own extension into the margin is part of the cached box. ponytail: a float moving into the paragraph's lines
// leaves its box alone, so its widths stay until the paragraph changes; relayout after float layout if that shows.
const geo = (el) => `${el.offsetLeft}|${el.offsetWidth}`;
const settled = new WeakMap(); // view → {doc, gkey}: nothing left to lay out for that doc
let epoch = 0; // bumped when web fonts arrive, since every width may change
globalThis.document?.fonts?.addEventListener?.('loadingdone', () => { epoch++; });

/** The layout pass: lays out the tab paragraphs whose node, parent or settings changed since their last layout and replaces their
 * decorations in one meta transaction. → true when it changed decorations. */
export function layoutView(view) {
  const st = tabsKey.getState(view.state);
  if (!st || view.composing || view.isDestroyed || !view.dom.isConnected) return false;
  const { doc } = view.state;
  const { settings, styles, numbering } = doc.attrs;
  const gkey = `${view.dom.offsetWidth}|${settings?.defaultTabStop ?? 36}|${epoch}`;
  const last = settled.get(view);
  if (last?.doc === doc && last.gkey === gkey) return false;
  const jobs = [];
  let complete = true;
  const laid = new Set(st.find(undefined, undefined, (s) => s.wordPara != null).map((d) => d.from)); // paragraphs with decorations now
  // Each top-level block with its view description (kept while its node stays), so a block whose node, box and list labels are as
  // they were when nothing in it needed laying out is passed over without a walk or a read inside it. Reading a nested
  // paragraph's box inside a culled block (page-engine/cull.js) lays that block out on its own.
  const descs = view.docView?.children.filter((d) => d.node) ?? [];
  const byDesc = descs.length === doc.childCount;
  let doms = null; // every node's DOM from one walk, when the descriptions do not match the doc (mid-update)
  doc.forEach((top, tpos, i) => {
    const d = byDesc ? descs[i] : null;
    const t = tops.get(top);
    if (t && t.styles === styles && (t.none || (t.gkey === gkey && t.numbering === numbering && d && t.geo === geo(d.dom)
      && t.labels.every(([el, l]) => el.getAttribute('data-label') === l)))) return;
    const at = d ? nodeDOMs(view, d, tpos) : (doms ??= nodeDOMs(view));
    const before = jobs.length;
    let whole = true;
    let none = true;
    const labels = [];
    const visit = (node, pos, parent) => {
      if (!node.isTextblock) return true;
      const need = needOf(node);
      const cellDec = cellDecOf(doc, node, parent);
      if (!need.count && !need.num && !barOf(doc, node) && cellDec == null && !laid.has(pos)) return false;
      none = false;
      const el = at.get(pos);
      if (!el || el.nodeType !== 1) {
        whole = false;
        return false;
      }
      const label = need.num ? el.getAttribute('data-label') : null;
      if (need.num) labels.push([el, label]);
      const m = memo.get(node);
      // A top-level paragraph's parent is the doc, new with every edit: its box (geo) and the doc's attrs say what matters there.
      if (m && (m.parent === parent || parent === doc) && m.gkey === gkey && m.styles === styles && m.numbering === numbering && m.label === label && m.geo === geo(el)) return false;
      const spans = [...el.querySelectorAll('span[data-tab], span[data-ptab]')];
      if (spans.length !== need.count) {
        whole = false; // a box the DOM does not have yet: the next frame
        return false;
      }
      const { stops, default: def } = tabStopsOf(doc, node);
      let num = null;
      if (label != null) {
        const lvl = levelOf(numbering, node.attrs.numbering.numId, node.attrs.numbering.ilvl);
        if (!lvl?.suff || lvl.suff === 'tab') num = { label, levelTab: lvl?.tab ?? null };
      }
      jobs.push({ node, pos, parent, label, el, spans, stops, def, num, cellDec });
      return false;
    };
    if (visit(top, tpos, doc)) top.descendants((n, p, parent) => visit(n, tpos + 1 + p, parent));
    if (!whole) complete = false;
    // Passed over from now on once a walk finds nothing to lay out in it (a block just laid out is walked once more).
    else if (jobs.length === before) tops.set(top, { styles, none, gkey, numbering, geo: none || !d ? '' : geo(d.dom), labels });
  });
  if (complete) settled.set(view, { doc, gkey });
  if (!jobs.length) return false;
  const zoom = view.dom.getBoundingClientRect().width / view.dom.offsetWidth || 1;
  // Box widths are written straight into the editor's DOM while measuring; ProseMirror must not read those writes as edits.
  view.domObserver?.stop?.();
  let results;
  try {
    results = layoutJobs(jobs, zoom);
    // The breaks the measure put in for wrapped tabs go: the decorations below draw them.
    for (const j of jobs) for (const br of j.el.querySelectorAll('br[data-tab-temp]')) br.remove();
  } finally {
    view.domObserver?.start?.();
  }
  let set = st;
  let changed = false;
  jobs.forEach((j, i) => {
    const res = results[i];
    const sig = JSON.stringify(res);
    memo.set(j.node, { parent: j.parent, gkey, styles, numbering, label: j.label, geo: geo(j.el), sig });
    const to = j.pos + j.node.nodeSize;
    const now = set.find(j.pos, to, isOurs).filter((d) => d.from >= j.pos && d.to <= to);
    if (now.some((d) => d.spec.wordPara === sig && d.from === j.pos)) return;
    const add = decosOf(j.node, j.pos, res, sig);
    if (!now.length && !add.length) return;
    set = set.remove(now).add(doc, add);
    changed = true;
  });
  if (!changed) return false;
  view.dispatch(view.state.tr.setMeta(tabsKey, set).setMeta('addToHistory', false));
  return true;
}

/** The pass pagination runs ahead of its page measure (§1.9 LayoutPass). */
export const tabPass = { id: 'tabs', phase: 'before', run: layoutView };

/** The editor side: the decoration set, mapped through edits, with a box for every new tab. */
export const TabStops = Extension.create({
  name: 'wordTabStops',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: tabsKey,
      state: {
        // A document opens with its tabs boxed, so the first pass finds one box per tab.
        init: (_, { doc }) => {
          const add = [];
          doc.descendants((node, pos) => {
            if (!node.isTextblock) return true;
            if (needOf(node).count) eachTab(node, pos, (p, ptab) => { if (!ptab) add.push(Decoration.inline(p, p + 1, PLACEHOLDER, { wordTab: 0 })); });
            return false;
          });
          return DecorationSet.create(doc, add);
        },
        apply(tr, set) {
          const meta = tr.getMeta(tabsKey);
          if (meta) return meta;
          if (!tr.docChanged) return set;
          set = set.map(tr.mapping, tr.doc);
          const add = [];
          for (const [from, to] of changedRanges(tr)) {
            tr.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isTextblock) return true;
              // An undo can bring back a paragraph node laid out before, whose decorations went with it: lay it out again.
              memo.delete(node);
              if (needOf(node).count) {
                eachTab(node, pos, (p, ptab) => {
                  if (!ptab && !set.find(p, p + 1, (s) => s.wordTab != null).some((d) => d.from === p)) add.push(Decoration.inline(p, p + 1, PLACEHOLDER, { wordTab: 0 }));
                });
              }
              return false;
            });
          }
          return add.length ? set.add(tr.doc, add) : set;
        },
      },
      props: { decorations: (state) => tabsKey.getState(state) },
      // Pagination skips story editors (headers, footers, notes being edited), so their tabs are laid out here, after each update
      // and before the frame paints.
      view: (view) => {
        const story = () => !!view.dom.closest?.('[data-story]');
        let queued = false;
        const run = () => {
          if (queued || !story()) return;
          queued = true;
          queueMicrotask(() => {
            queued = false;
            if (!view.isDestroyed) layoutView(view);
          });
        };
        run();
        return { update: run };
      },
    })];
  },
});
