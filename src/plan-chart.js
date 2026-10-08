// The plan chart node (Gantt plan §3.5, §7; roadmap A3, A4; SPEC §6e): a view of a plan (Board, Backlog or Gantt) embedded in
// a draft, live from the plan or from a frozen snapshot, exported to a PNG at its drawn width.
// The editor layer never imports the app layer: src/app/plans.js fills `planSource` (the plan data and the React renderer,
// src/app/components/plan/ChartView.jsx). The React chart bar (src/app/components/board/PlanChartBar.jsx) follows the
// `activeChart` store. parseChart, chartLayout and freezeCtx are pure (Node-tested); nothing touches `document` at import.
import { Node } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { toBlob } from 'html-to-image';
import { createElement as h } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { todayStr } from './plan/dates.mjs';
import { ganttLayout, GANTT_MAX_ROWS } from './plan/gantt-layout.mjs';
import { cards, columnsOf, filterTickets, newId, OPTION_DEFAULTS, parseOptions, parsePlan, tree } from './plan/plan-model.mjs';
import { schedule } from './plan/schedule.mjs';
import { contentWidth, insertBoard, make, resolveBg, topLevelPos } from './whiteboard.js';

export const VIEWS = ['kanban', 'backlog', 'gantt'];
const UUID = /^[a-f0-9-]{36}$/;
const SID = /^[a-z0-9]{7}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_W = 40; // display width
const MAX_H = 8000; // exported height
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fit = (v, min, max) => Math.max(min, Math.min(v, max));

// Readability contract (§7.4): base font 13 px, a display scale of at least 0.8.
export const PAD = 12; // chart padding
export const KANBAN_COL = 180; // minimum column width
export const KANBAN_GAP = 12;
const MAX_CARDS = 200;
const MAX_ROWS = 80;
const MIN_SCALE = 0.8;
/** Backlog chart columns: [key, label, minimum width, the `fields` that show it (null: always)]. */
export const BACKLOG_COLS = [
  ['num', '#', 44, ['num']], ['title', 'Title', 220, null], ['status', 'Status', 110, null], ['priority', 'Priority', 80, ['priority']],
  ['labels', 'Labels', 120, ['labels']], ['estimate', 'Estimate', 70, ['estimate']], ['start', 'Start', 64, ['due']], ['end', 'End', 64, ['due']],
  ['progress', 'Progress', 64, ['progress']], ['deps', 'Deps', 90, ['deps', 'blocked']], ['draft', 'Draft', 130, ['draft', 'pushed']],
  ['checklist', 'Checklist', 64, ['checklist']],
];
export const backlogColumns = (fields = OPTION_DEFAULTS.fields) => BACKLOG_COLS.filter((c) => !c[3] || c[3].some((f) => fields.includes(f)));

/** Backlog rows: the plan's tree in `order`, flattened ({ticket, depth, children}), the filtered tickets only; the children
 * of a ticket in `collapsed` (a Set of ids) are left out. */
export function backlogRows(ctx, options, collapsed = null) {
  const keep = new Set(filterTickets(ctx, options).map((t) => t.id));
  const out = [];
  const walk = (nodes) => nodes.forEach((n) => {
    if (keep.has(n.ticket.id)) out.push(n);
    if (!collapsed?.has(n.ticket.id)) walk(n.children);
  });
  walk(tree(ctx.plan));
  return out;
}

/** The Gantt layout of a chart `width` px wide (its padding off) under the export rules (§7.4: at most 60 rows, the zoom
 * falling back until the range fits, `note` saying so); {error: {code, message}} when an export would refuse it. */
export const chartGantt = (ctx, options, width) => ganttLayout(ctx, schedule(ctx), options, width - 2 * PAD, { exporting: true });

/** The width the chart is laid out at for the display width `width` (§7.4), and `error` when an export would refuse it
 * (Gantt: `note` when the zoom fell back). */
export function chartLayout(view, ctx, options, width) {
  const o = { ...OPTION_DEFAULTS, ...options };
  const scaled = (min, many, narrow) => {
    const layoutWidth = Math.max(width, min);
    if (many) return { layoutWidth, error: many };
    return width / layoutWidth < MIN_SCALE ? { layoutWidth, error: narrow } : { layoutWidth };
  };
  if (view === 'kanban') {
    const n = columnsOf(ctx, o).length;
    return scaled(n * KANBAN_COL + (n - 1) * KANBAN_GAP + 2 * PAD, cards(ctx, o).length > MAX_CARDS && `more than ${MAX_CARDS} cards; filter it in Options`,
      'too many columns for the post width; hide columns in Options');
  }
  if (view === 'backlog') {
    return scaled(backlogColumns(o.fields).reduce((s, c) => s + c[2], 0) + 2 * PAD, backlogRows(ctx, o).length > MAX_ROWS && `more than ${MAX_ROWS} rows; filter it in Options`,
      'too many fields for the post width; hide fields in Options');
  }
  const g = chartGantt(ctx, o, width); // the Gantt fits the drawn width by its zoom, never scaled
  if (g.error) {
    return { layoutWidth: width, error: g.error.code === 'too_many_rows' ? `more than ${GANTT_MAX_ROWS} rows; filter it in Options` : 'the date range is too long for the post width; shorten it in Options' };
  }
  return { layoutWidth: width, ...(g.note && { note: g.note }) };
}

// A frozen snapshot ({at, ctx}) as stored; null when it has no plan.
function parseFrozen(f) {
  if (!isObj(f) || !isObj(f.ctx) || !isObj(f.ctx.plan)) return null;
  const c = f.ctx;
  const at = Number.isFinite(f.at) ? f.at : 0;
  return {
    at,
    ctx: {
      plan: parsePlan(c.plan, { tags: c.tags }),
      tags: (Array.isArray(c.tags) ? c.tags : []).filter((t) => isObj(t) && typeof t.id === 'string' && typeof t.name === 'string'),
      drafts: (Array.isArray(c.drafts) ? c.drafts : []).filter((d) => isObj(d) && typeof d.id === 'string')
        .map((d) => ({ id: d.id, title: typeof d.title === 'string' ? d.title : '', pushedAt: Number.isFinite(d.pushedAt) ? d.pushedAt : null })),
      draftTags: isObj(c.draftTags) ? c.draftTags : {},
      today: typeof c.today === 'string' && DATE.test(c.today) ? c.today : todayStr(new Date(at)),
    },
  };
}

/** The node attrs in `json` (a JSON string or an attrs object), each key validated (§3.5): bad JSON → defaults; a missing
 * id gets one; unknown view → 'kanban'; invalid options dropped; the frozen plan through parsePlan; dw ≥ 40 or null. */
export function parseChart(json) {
  let d = json;
  if (typeof d === 'string') try { d = JSON.parse(d); } catch { d = null; }
  d = isObj(d) ? d : {};
  return {
    id: typeof d.id === 'string' && SID.test(d.id) ? d.id : newId(),
    planId: typeof d.planId === 'string' && UUID.test(d.planId) ? d.planId : null,
    view: VIEWS.includes(d.view) ? d.view : 'kanban',
    options: parseOptions(d.options),
    frozen: parseFrozen(d.frozen),
    dw: Number.isFinite(d.dw) && d.dw >= MIN_W ? Math.round(d.dw) : null,
  };
}

/** A frozen chart's snapshot of the plan context: the plan without descriptions, links, checklist text (the counts stay),
 * baselines (kept for the Gantt `view`) and ticket stamps; the thread's drafts as {id, title, pushedAt} and only their
 * tags; the global tags; today. */
export function freezeCtx(ctx, view) {
  const tickets = ctx.plan.tickets.map(({ created, updated, ...t }) => ({
    ...t, description: '', urls: [], baseline: view === 'gantt' ? t.baseline : null, checklist: t.checklist.map((c) => ({ id: c.id, text: '', done: c.done })),
  }));
  const drafts = ctx.drafts.map(({ id, title, pushedAt }) => ({ id, title, pushedAt: pushedAt ?? null }));
  const draftTags = Object.fromEntries(drafts.filter((d) => ctx.draftTags[d.id]).map((d) => [d.id, ctx.draftTags[d.id]]));
  return { plan: { ...ctx.plan, tickets }, tags: ctx.tags, drafts, draftTags, today: ctx.today };
}

/** The forum post colours of SPEC §1 the chart is drawn in (page theme 'dark' | 'light'). */
export function pagePalette(theme) {
  const shared = { accent: '#3d99f5', critical: '#e05252', conflict: '#e09952', done: '#62d926' };
  return theme === 'light'
    ? { ...shared, bg: '#ffffff', text: '#333340', strong: '#111111', muted: '#6b6d80', border: '#d0d0da', panel: '#f0f0f4', card: '#ffffff' }
    : { ...shared, bg: '#303039', text: '#c5c6d0', strong: '#ffffff', muted: '#a3a6b8', border: '#6b6d80', panel: '#3a3b46', card: '#45465a' };
}

/** The workspace tab that shows a chart view. */
export const tabOf = (view) => (view === 'kanban' ? 'board' : view);

// ---------------------------------------------------------------------------------------------
// The plans as this layer sees them: the app's plan store fills it (src/app/plans.js). Unfilled, live charts show "Plan not
// found"; frozen ones draw their snapshot once `Chart` is set.

export const planSource = {
  context: () => null, // (planId) → the plan context (Gantt plan §3.3), or null
  subscribe: () => () => {}, // (fn) → unsubscribe: fn() after any plan, draft or tag change
  Chart: null, // the React renderer: ({ctx, view, options, palette, width}) → element
  open: () => {}, // (planId, view) → the plan workspace at that view's tab
};

// ---------------------------------------------------------------------------------------------
// The chart the bar serves: the node-selected one only (hovering never shows it). Snapshot {view, attrs, w, h, missing,
// error}, rebuilt on change.

let selected = null;
let snap = null;
const chartListeners = new Set();
export const activeChart = {
  get: () => snap,
  subscribe(fn) {
    chartListeners.add(fn);
    return () => chartListeners.delete(fn);
  },
};

function emitChart() {
  const view = selected;
  snap = view && { view, attrs: view.node.attrs, w: view.dom.offsetWidth, h: view.dom.offsetHeight, missing: !view.ctx, error: view.error };
  for (const fn of chartListeners) fn();
}

const CSS = `
.pc{position:relative;box-sizing:border-box;margin:1em 0;user-select:none;-webkit-user-select:none;overflow:hidden}
.pc:not(.pc-selected){cursor:pointer}
.pc-inner{transform-origin:0 0}
.pc.pc-selected{outline:calc(2px*var(--wb-inv,1)) solid #3d99f5;outline-offset:0}
.pc-handle{position:absolute;top:0;right:0;bottom:0;width:calc(8px*var(--wb-inv,1));cursor:ew-resize}
.pc-handle:hover{background:rgba(61,153,245,.45)}
.pc-missing{display:flex;align-items:center;justify-content:center;min-height:80px;box-sizing:border-box;padding:12px;outline:1px dashed #8a8ca0;outline-offset:-1px;color:#8a8ca0;font:14px/1.3 system-ui,sans-serif;text-align:center}
.pc-warn{position:absolute;left:6px;bottom:6px;max-width:calc(100% - 12px);box-sizing:border-box;padding:1px 7px;border-radius:999px;background:rgba(224,153,82,.16);color:#e09952;outline:1px dashed #e09952;outline-offset:-1px;font:11px/16px system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
`;

function injectChartStyle() {
  if (document.getElementById('pc-style')) return;
  document.head.append(make('style', '', { id: 'pc-style', textContent: CSS }));
}

const pageTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const scaleOf = (el) => {
  const s = el.getBoundingClientRect().width / el.offsetWidth;
  return s > 0 && Number.isFinite(s) ? s : 1;
};

// ---------------------------------------------------------------------------------------------
// Document NodeView: the chart drawn by planSource.Chart at its layout width, scaled down to the drawn width when the layout
// is wider (as the forum scales the image). Click selects, the east edge handle changes dw, double-click / Enter opens the
// plan at the chart's view.

class PlanChartView {
  constructor({ node, view, getPos, editor }) {
    Object.assign(this, { node, view, getPos, editor, drag: null, chart: null, seen: null, ctx: null, error: null, width: 0, layoutWidth: 0 });
    injectChartStyle();
    this.dom = make('div', 'pc');
    this.dom.pcView = this; // the chart bar reaches the view through it
    this.inner = make('div', 'pc-inner');
    this.warn = make('div', 'pc-warn');
    this.dom.append(this.inner);
    this.root = createRoot(this.inner);
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.dom.addEventListener('pointermove', this.onPointerMove);
    this.dom.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('pointercancel', this.onPointerUp);
    this.dom.addEventListener('mousedown', (e) => e.preventDefault()); // no caret or native selection in the document
    this.dom.addEventListener('dblclick', (e) => !e.target.classList.contains('pc-handle') && this.openPlan());
    // Next frame: fit() changes the observed sizes (no ResizeObserver loop).
    this.resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => !this.destroyed && this.fit()));
    this.resizeObserver.observe(this.dom);
    this.resizeObserver.observe(this.inner);
    // Plan, draft and settings changes (a frozen chart too: the page theme may have changed), once per frame, after the store
    // has applied them.
    this.unsubscribe = planSource.subscribe(() => {
      cancelAnimationFrame(this.redraw);
      this.redraw = requestAnimationFrame(() => !this.destroyed && this.render());
    });
    this.render();
  }

  render() {
    if (this.seen !== this.node.attrs) {
      this.seen = this.node.attrs;
      this.chart = parseChart(this.node.attrs);
    }
    const c = this.chart;
    if (!this.drag) this.dom.style.width = c.dw ? `min(${c.dw}px, 100%)` : '100%';
    this.ctx = c.frozen?.ctx ?? planSource.context(c.planId);
    this.width = this.dom.offsetWidth || Math.min(c.dw ?? Infinity, contentWidth(this.view));
    const lay = this.ctx ? chartLayout(c.view, this.ctx, c.options, this.width) : null;
    this.error = lay?.error ?? null;
    this.layoutWidth = lay?.layoutWidth ?? this.width;
    this.inner.style.width = `${this.layoutWidth}px`;
    this.warn.textContent = `Refused on push: ${this.error}`;
    if (this.error) this.dom.append(this.warn);
    else this.warn.remove();
    this.root.render(this.ctx && planSource.Chart
      ? h(planSource.Chart, { ctx: this.ctx, view: c.view, options: c.options, palette: pagePalette(pageTheme()), width: this.layoutWidth })
      : h('div', { className: 'pc-missing' }, 'Plan not found. Pick a plan or delete this chart.'));
    this.fit();
  }

  // A new drawn width lays the chart out again; a layout wider than the drawn width is scaled down to it.
  fit() {
    const w = this.dom.offsetWidth;
    if (w && Math.abs(w - this.width) > 0.5) return this.render();
    const s = w && this.layoutWidth > w ? w / this.layoutWidth : 1;
    this.inner.style.transform = s === 1 ? '' : `scale(${s})`;
    this.dom.style.height = s === 1 ? '' : `${this.inner.offsetHeight * s}px`;
    if (selected === this) emitChart();
  }

  // The handle and the outline keep their on-screen size under the page zoom.
  refreshScale() {
    this.dom.style.setProperty('--wb-inv', String(1 / scaleOf(this.dom)));
  }

  maxWidth() {
    return contentWidth(this.view);
  }

  /** Changes attrs of the node: one undo step. */
  set(patch) {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    this.view.dispatch(closeHistory(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...patch })));
  }

  remove() {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
    this.view.focus();
  }

  openPlan() {
    planSource.open(this.chart.planId, this.chart.view);
  }

  // The hover hint (src/app/components/HoverHint.jsx); none once selected. A deleted plan (a frozen chart's too) cannot be
  // opened: double-click only says so.
  hint() {
    if (selected === this) return null;
    return planSource.context(this.chart.planId) ? 'Click to select. Double-click to open the plan.' : 'Click to select.';
  }

  onPointerDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.classList.contains('pc-handle')) {
      this.drag = { x: e.clientX, w0: this.dom.offsetWidth, scale: scaleOf(this.dom) };
      this.dw = this.chart.dw;
      e.target.setPointerCapture(e.pointerId);
      return;
    }
    const pos = this.getPos();
    if (typeof pos === 'number') this.editor.commands.setNodeSelection(pos);
    this.view.focus();
  };

  // Live in the DOM (the resize observer lays the chart out again), one commit on pointerup.
  onPointerMove = (e) => {
    const g = this.drag;
    if (!g) return this.refreshScale(); // the page zoom may have changed since the handle was drawn
    this.dw = Math.round(fit(g.w0 + (e.clientX - g.x) / g.scale, MIN_W, this.maxWidth()));
    this.dom.style.width = `${this.dw}px`;
  };

  onPointerUp = () => {
    if (!this.drag) return;
    this.drag = null;
    if (this.dw !== this.chart.dw) this.set({ dw: this.dw });
  };

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  // Everything inside is ours, except paste/drop, which must reach WhiteboardPaste's handlers.
  stopEvent(event) {
    return !['paste', 'drop', 'dragover', 'dragenter', 'dragleave'].includes(event.type);
  }

  ignoreMutation() {
    return true;
  }

  selectNode() {
    if (this.dom.classList.contains('pc-selected')) return;
    this.dom.classList.add('pc-selected');
    this.dom.append(make('div', 'pc-handle', { title: 'Drag to change the width' }));
    this.refreshScale();
    selected = this;
    emitChart();
  }

  deselectNode() {
    this.dom.classList.remove('pc-selected');
    this.dom.querySelector(':scope > .pc-handle')?.remove();
    if (selected === this) selected = null;
    emitChart();
  }

  destroy() {
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.unsubscribe();
    setTimeout(() => this.root.unmount()); // not inside a React render or commit that removed the node
    if (selected === this) selected = null;
    emitChart();
  }
}

// ---------------------------------------------------------------------------------------------
// Node

export const PlanChart = Node.create({
  name: 'planChart',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      id: { default: null, rendered: false }, // 7-char base36, unique in the document
      planId: { default: null, rendered: false },
      view: { default: 'kanban', rendered: false },
      options: { default: {}, rendered: false }, // Gantt plan §3.2 Options; a missing key means its default
      frozen: { default: null, rendered: false }, // {at, ctx}: the snapshot it shows instead of the live plan
      dw: { default: null, rendered: false }, // display width in post px; null: the content width
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-plan-chart]', getAttrs: (el) => parseChart(el.getAttribute('data-json')) }];
  },

  renderHTML({ node }) {
    return ['div', { 'data-plan-chart': '', 'data-json': JSON.stringify(node.attrs) }];
  },

  addCommands() {
    return {
      // A chart (attrs as parseChart reads them) after the top-level block of the selection, with a new id.
      insertPlanChart:
        (attrs = {}) =>
        ({ state, tr, dispatch }) => {
          const taken = new Set();
          state.doc.descendants((n) => void (n.type.name === this.name && taken.add(n.attrs.id)));
          let id;
          do id = newId(); while (taken.has(id));
          const node = state.schema.nodes[this.name].create({ ...parseChart(attrs), id });
          if (dispatch) insertBoard(tr, topLevelPos(state.selection.$to), node);
          return true;
        },
      // Merges `patch` into the attrs of the chart with id `id`: one undo step; false when no chart carries it.
      setPlanChart:
        (id, patch) =>
        ({ state, tr, dispatch }) => {
          let at = null;
          state.doc.descendants((n, pos) => void (at === null && n.type.name === this.name && n.attrs.id === id && (at = pos)));
          if (at === null) return false;
          if (dispatch) closeHistory(tr.setNodeMarkup(at, undefined, { ...state.doc.nodeAt(at).attrs, ...patch }));
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const sel = editor.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== this.name) return false;
        planSource.open(sel.node.attrs.planId, sel.node.attrs.view);
        return true;
      },
    };
  },

  addNodeView() {
    return (props) => new PlanChartView(props);
  },
});

// ---------------------------------------------------------------------------------------------
// Rasterizer (§7.3): the chart laid out off screen at its layout width, drawn at pixel ratio 2. `width`: the display width
// in the post; `n`: the chart's number in the post (error messages). → {blob, width, height} (height at the display width).

export async function rasterizePlanChart(attrs, { width, theme, n = 1 }) {
  const c = parseChart(attrs);
  const ctx = c.frozen?.ctx ?? planSource.context(c.planId);
  if (!ctx || !planSource.Chart) throw new Error(`Plan chart ${n}: plan not found (freeze it or pick a plan)`);
  const lay = chartLayout(c.view, ctx, c.options, width);
  if (lay.error) throw new Error(`Plan chart ${n}: ${lay.error}`);
  const { layoutWidth } = lay;
  const host = make('div', '');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none';
  const el = make('div', '');
  el.style.cssText = `width:${layoutWidth}px`;
  host.append(el);
  document.body.append(host);
  const root = createRoot(el);
  try {
    flushSync(() => root.render(h(planSource.Chart, { ctx, view: c.view, options: c.options, palette: pagePalette(theme), width: layoutWidth })));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const height = el.offsetHeight;
    if (height > MAX_H) throw new Error(`Plan chart ${n}: too tall; filter it in Options`);
    const blob = await toBlob(el, { pixelRatio: 2, width: layoutWidth, height, backgroundColor: resolveBg('post', theme), skipFonts: true });
    if (!blob) throw new Error(`Plan chart ${n}: rasterization produced no image`);
    return { blob, width, height: Math.round((height * width) / layoutWidth) };
  } finally {
    root.unmount();
    host.remove();
  }
}
