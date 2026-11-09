// Word's rulers (docs/plans/word/plan.md §3 ruler, index-layout.md "Horizontal ruler" and "Vertical ruler"): the horizontal one in
// the belowRibbon slot and the vertical one in the viewport slot (Print Layout only). Both draw from the caret's section and
// paragraph in points and map them to the screen through the sheet's rect and the page zoom (CSS zoom on #page-wrap); every
// marker drags with snapping, Alt readouts and a dotted guide line, and writes on release (one undo step).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { afterSlide } from '../../../app/sliding.js';
import { insetChanged, viewportRect } from '../../../app/viewport.js';
import { useStore } from '../../../app/store.js';
import { setColumnWidths, drawnColumnWidths } from '../../../export.js';
import { useUnit } from '../../../tooling/kit/controls.jsx';
import { formatLength } from '../../../tooling/kit/units.mjs';
import { REASONS } from '../../../tooling/reasons.mjs';
import { useWordCtx } from '../../../tooling/registry.js';
import { geometryOf, scaleOf } from '../../geometry.js';
import { tabStopsOf } from '../../model/tabs.mjs';
import { sectionOf, sectionsOf } from '../../model/sections.mjs';
import { levelOf } from '../../numbering.mjs';
import { tooSmall } from '../../pages.mjs';
import { effectiveProps } from '../../schema.js';
import { CanvasHorizontalRuler, CanvasVerticalRuler } from './CanvasRuler.jsx';
import {
  addStop as addOwn, columnDrag, defaultTicks, indentMarkers, indentPatch, keyStep, moveStop as moveOwn, nextSelector, PX_PER_PT,
  removeStop as removeOwn, sectionColumnsDrag, snap, ticks, TIPS,
} from './ruler.mjs';

const H = 24; // strip height in px
const BAND = [4, 20]; // the ruler band's top and bottom inside the strip
const W = 18; // vertical ruler width in px
const SHOWN = new Set(['print', 'web', 'draft']); // Word hides the ruler in Read Mode, Outline, Focus and Immersive Reader (v)

// The strip outside the measure on the Panels colour (the user, 2026-10-28); the text band on the Bars colour, so it stands out
// from the strip as the page does.
const C = {
  strip: 'var(--background)', grey: 'var(--muted)', white: 'var(--card)', ink: 'var(--foreground)', faint: 'var(--muted-foreground)',
  line: 'var(--border)',
};

// ---------------------------------------------------------------------------------------------
// Reading the model

const isPara = (n) => n.type.name === 'paragraph' || n.type.name === 'heading';

/** The first paragraph or heading the selection of `state` touches → {node, pos} or null. */
function firstPara(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) if (isPara($from.node(d))) return { node: $from.node(d), pos: d ? $from.before(d) : 0 };
  let hit = null;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (n, pos) => {
    if (hit) return false;
    if (isPara(n)) hit = { node: n, pos };
    return !hit;
  });
  return hit;
}

/** Calls `fn(node, pos)` for every paragraph and heading the selection of `tr` touches. */
function eachPara(tr, fn) {
  const { from, to } = tr.selection;
  tr.doc.nodesBetween(from, to, (n, pos) => {
    if (!isPara(n)) return true;
    fn(n, pos);
    return false;
  });
}

/** The indents `node` shows in points: its own, else a list level's (lists' CSS beats the style), else its style's. */
function indentOf(doc, node) {
  const own = node.attrs.indent ?? {};
  const style = effectiveProps(doc, node).para.indent;
  const n = node.attrs.numbering;
  const lvl = n && levelOf(doc.attrs.numbering, n.numId, n.ilvl);
  return {
    left: own.left ?? (lvl ? lvl.left : style.left) ?? 0,
    firstLine: own.firstLine ?? (lvl ? -lvl.hanging : style.firstLine) ?? 0,
    right: own.right ?? style.right ?? 0,
  };
}

/** The ancestor of the selection head of `state` named in `names` → {node, pos} or null. */
function ancestor(state, names) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if (names.includes($from.node(d).type.name)) return { node: $from.node(d), pos: $from.before(d) };
  return null;
}

/** The stops of `node` its style chain gives (its own tabs left out). */
const inheritedStops = (doc, node) => tabStopsOf(doc, { type: node.type, attrs: { ...node.attrs, tabs: null } }).stops;

// ---------------------------------------------------------------------------------------------
// Writing

/** Opens dialog `id` with `props` when a package registered it (Page Setup falls back to the base launcher); else says it is not
 * built yet. Harness cases stub it through window.__wordTest.dialog. The registry is imported late: it imports the hub, which
 * imports this module. */
async function openDialog(ctx, id, props) {
  const stub = globalThis.__wordTest?.dialog;
  if (stub) return stub(id, props);
  const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js');
  if (WORD_DIALOGS[id]) return ctx.dialog(id, props);
  if (id === 'pageSetup') return ctx.run('layout.pageSetup.launcher');
  ctx.toast(REASONS.pending);
  return null;
}

/** Writes `next(own tabs, inherited stops, node)` → tabs into every selected paragraph of the target (one step). */
function writeTabs(ctx, next) {
  return ctx.chain((c) => c.command(({ tr }) => {
    eachPara(tr, (n, pos) => {
      const out = next(n.attrs.tabs, inheritedStops(tr.doc, n), n, tr.doc);
      if (out !== undefined) tr.setNodeAttribute(pos, 'tabs', out?.length ? out : null);
    });
    return true;
  }));
}

/** Writes `patch` into the sect of section `section` (the caret's when undefined) of the main editor, refusing margins that leave
 * no room for text. */
function writeSect(ctx, patch, section) {
  const doc = ctx.ed.state.doc;
  const sect = section == null ? ctx.sect : sectionsOf(doc)[section]?.sect ?? ctx.sect;
  const next = { ...sect, margin: { ...sect.margin, ...patch.margin } };
  const why = tooSmall(next);
  if (why) {
    ctx.toast(why);
    return false;
  }
  const index = section ?? sectionOf(doc, ctx.ed.state.selection.from).index;
  return ctx.ed.chain().setSectionProps(patch, { section: index }).run();
}

// ---------------------------------------------------------------------------------------------
// Frame: where the sheet is on screen

/** The sheet's screen rects for `ed` against the element in `ref`, re-measured on scroll, resize, zoom and `keys` changes only
 * (never per keystroke) → {pageLeft, domTop, scale, src*, left, top, bottom, vp} or null. With `side` (Side to Side, views'
 * Pages.jsx) the caret's page shows as a copy over the editor area, so the frame is that copy's (null while it is not drawn);
 * srcLeft, srcTop and srcScale stay the editor's own, for rects read from its DOM (mapRect). */
function useFrame(ed, ref, keys, side = false) {
  const [frame, setFrame] = useState(null);
  const drawn = useRef(null);
  drawn.current = frame;
  const zoom = useStore((s) => s.zoomPct);
  useLayoutEffect(() => {
    const dom = ed?.view?.dom;
    if (!dom?.isConnected) return undefined;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const page = dom.closest('.page');
      if (!page || !ref.current || !dom.isConnected) return;
      const p = page.getBoundingClientRect();
      const o = ref.current.getBoundingClientRect();
      const d = dom.getBoundingClientRect();
      const v = viewportRect(true);
      // The scale shown: the page zoom and a zoom preview's transform (panzoom.js), which scaleOf leaves out.
      const scale = dom.offsetHeight ? d.height / dom.offsetHeight : scaleOf(ed.view);
      let at = { pageLeft: p.left, domTop: d.top, scale };
      if (side) {
        const geo = geometryOf(ed.state);
        const pg = geo?.pages[geo.page];
        const copy = pg && document.querySelector(`[data-page-move="side"] [data-page="${pg.index}"] > .pg-clone`);
        if (!copy) return setFrame(null);
        const c = copy.getBoundingClientRect();
        const s = c.width / pg.box.w;
        at = { pageLeft: c.left, domTop: c.top - pg.top * s, scale: s };
      }
      const next = { ...at, srcLeft: p.left, srcTop: d.top, srcScale: scale, left: o.left, top: o.top, bottom: o.bottom,
        vpLeft: v.left, vpTop: v.top, vpBottom: v.bottom, vpRight: v.right };
      // While the sidebar slides (sliding.js) the drawn strip follows the page with one transform on its page layer and draws
      // again once the slide ends, instead of drawing every tick on every frame.
      const was = drawn.current;
      const layer = ref.current.querySelector(':scope > [data-ruler-page]');
      if (afterSlide(measure)) {
        if (was && layer) layer.style.transform = `translateX(${next.pageLeft - next.left - (was.pageLeft - was.left)}px)`;
        return;
      }
      if (layer) layer.style.transform = '';
      return setFrame((old) => (old && Object.keys(next).every((k) => Math.abs(old[k] - next[k]) < 0.01) ? old : next));
    };
    const schedule = () => { raf ||= requestAnimationFrame(measure); };
    // The first frame is measured at once; a relayout (each keypress bumps the geometry's version) waits for the next animation
    // frame, after the page engine's, so the ruler never forces a layout of its own in the commit (plan.md section 6 risk 6).
    if (frame) schedule();
    else measure();
    const area = document.getElementById('editor-area');
    area?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('zoompreview', schedule); // a zoom preview only transforms the page: no resize or scroll comes
    window.addEventListener('pagesdrawn', schedule); // Side to Side drew its copies (a turn, a relayout, a resize)
    const ro = new ResizeObserver(schedule);
    for (const el of [area, dom, ref.current]) if (el) ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      area?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('zoompreview', schedule);
      window.removeEventListener('pagesdrawn', schedule);
      ro.disconnect();
    };
  }, [ed, ref, zoom, side, ...keys]);
  return frame;
}

/** Maps a screen point read from the editor's DOM onto the page `frame` draws (Side to Side's copy; the same point otherwise). */
const mapX = (frame, x) => frame.pageLeft + (x - frame.srcLeft) * (frame.scale / frame.srcScale);
const mapY = (frame, y) => frame.domTop + (y - frame.srcTop) * (frame.scale / frame.srcScale);

/** Side to Side (views, store viewsMove): 'pages' while its page copies show, 'thumbs' while its thumbnails do (no ruler: no page
 * shows at size), else null. */
const useSide = () => useStore((s) => (s.viewsMove?.kind === 'side' ? (s.viewsMove.thumbs ? 'thumbs' : 'pages') : null));

/** The table around the caret of `ctx` measured from the DOM (pt from the paper's left or top): {pos, node, cell: {left, width},
 * cols: {left, widths (px)}, rows: [{pos, node, top, bottom}]}, or null outside a table. Measured on cell, frame, layout
 * (`version`, the geometry's relayout count) and table structure changes only, so typing in a cell reads no layout. */
function useTable(ctx, frame, version) {
  const state = ctx.state;
  const table = state && ctx.in.table ? ancestor(state, ['table']) : null;
  const cell = table && ancestor(state, ['tableCell', 'tableHeader']);
  const [out, setOut] = useState(null);
  const view = ctx.target?.view;
  const shape = table ? structureOf(table.node) : '';
  useLayoutEffect(() => {
    if (!table || !cell || !frame || !view?.dom?.isConnected) {
      setOut(null);
      return;
    }
    const pageLeft = frame.pageLeft;
    const ptX = (x) => (x - pageLeft) / frame.scale / PX_PER_PT;
    const cellEl = view.nodeDOM(cell.pos);
    const tableEl = view.nodeDOM(table.pos);
    const tEl = tableEl?.matches?.('table') ? tableEl : tableEl?.querySelector?.('table');
    if (!cellEl || !tEl) return setOut(null);
    const cs = getComputedStyle(cellEl);
    const r = cellEl.getBoundingClientRect();
    const padL = parseFloat(cs.paddingLeft) * frame.scale;
    const padR = parseFloat(cs.paddingRight) * frame.scale;
    const widths = drawnColumnWidths(view, table.node, table.pos);
    const rows = [];
    table.node.forEach((row, off) => {
      const el = view.nodeDOM(table.pos + 1 + off);
      const rr = el?.getBoundingClientRect?.();
      if (rr) rows.push({ pos: table.pos + 1 + off, node: row, top: mapY(frame, rr.top), bottom: mapY(frame, rr.bottom) });
    });
    setOut({
      pos: table.pos, node: table.node,
      cell: { left: ptX(mapX(frame, r.left) + padL), width: (mapX(frame, r.right) - mapX(frame, r.left) - padL - padR) / frame.scale / PX_PER_PT },
      // From the first cell's left: the table element is display: contents, so its own rect is all zeros.
      cols: widths && { left: ptX(mapX(frame, (tEl.querySelector('td, th') ?? tEl).getBoundingClientRect().left)), widths },
      rows,
    });
  }, [table?.pos, cell?.pos, shape, version, frame, view]);
  return table ? out : null;
}

/** A key of table `node`'s rows, cells, column widths and row heights: what moves the ruler's table markers without a relayout. */
function structureOf(node) {
  const parts = [];
  node.forEach((row) => {
    parts.push(`r${row.attrs.height?.value ?? ''}`);
    row.forEach((c) => parts.push(`${c.attrs.colspan}:${c.attrs.colwidth ?? ''}`));
  });
  return parts.join();
}

// ---------------------------------------------------------------------------------------------
// Dragging

/** Starts dragging marker `d` ({kind, i, x: its position in pt, axis}) from pointer event `e`: `toPt(event)` reads the pointer as
 * pt, `snapAt(pt, alt)` snaps it, `off(event)` says whether it is dragged off the ruler, `commit(state, event)` writes on release.
 * Alt (or the right button while the left drags) turns snapping off. Alt keys stop at the ruler's window capture listener, which
 * runs after any capture listener on window added before the drag, so a KeyTips handler there should also skip Alt while
 * [data-ruler-guide] (drawn for every drag) is in the page. */
function startDrag(e, d, { toPt, snapAt, off, commit, set }) {
  e.preventDefault();
  e.stopPropagation();
  const st = { ...d, start: d.x, alt: false, off: false, moved: false };
  const cx = e.clientX;
  const cy = e.clientY;
  set({ ...st });
  const alt = (ev) => ev.key === 'Alt' && (ev.preventDefault(), ev.stopImmediatePropagation());
  const menu = (ev) => ev.preventDefault();
  const move = (ev) => {
    st.alt = ev.altKey || (ev.buttons & 2) === 2;
    st.moved ||= Math.abs(ev.clientX - cx) > 1 || Math.abs(ev.clientY - cy) > 1;
    st.x = snapAt(toPt(ev), st.alt);
    st.off = !!off?.(ev);
    st.mods = { shift: ev.shiftKey, ctrl: ev.ctrlKey };
    set({ ...st });
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('keydown', alt, true);
    window.removeEventListener('keyup', alt, true);
    setTimeout(() => window.removeEventListener('contextmenu', menu, true), 0);
    if (ev.clientX !== undefined) move(ev);
    set(null);
    if (st.moved) commit(st);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', alt, true);
  window.addEventListener('keyup', alt, true);
  window.addEventListener('contextmenu', menu, true);
}

/** Keyboard ruler mode on a focused marker (Ctrl+Shift+F10): Tab and Shift+Tab move between markers, Left and Right (Up and Down
 * on the vertical ruler) move it one snap step (a tenth with Alt), Enter writes, Esc cancels and returns to the text (v). */
function markerKeys(e, d, { unit, drag, set, commit, ctx }) {
  const pending = drag?.kb && drag.kind === d.kind && drag.i === d.i ? drag : null;
  const back = d.axis === 'v' ? 'ArrowUp' : 'ArrowLeft';
  const fwd = d.axis === 'v' ? 'ArrowDown' : 'ArrowRight';
  if (e.key === 'Alt') return e.preventDefault();
  if (e.key === 'Tab') {
    e.preventDefault();
    const all = [...e.currentTarget.closest('[data-ruler]').querySelectorAll('[data-marker][tabindex]')];
    const k = all.indexOf(e.currentTarget);
    set(null);
    all[(k + (e.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
    return undefined;
  }
  if (e.key === back || e.key === fwd) {
    e.preventDefault();
    const base = pending ?? { ...d, start: d.x, kb: true, moved: true };
    set({ ...base, x: base.x + (e.key === fwd ? 1 : -1) * keyStep(unit, e.altKey) });
    return undefined;
  }
  if (e.key === 'Enter' && pending) {
    e.preventDefault();
    set(null);
    commit(pending);
    return undefined;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    set(null);
    ctx.target?.commands.focus();
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Drawing parts

const abs = (style) => ({ position: 'absolute', ...style });

/** A tab stop glyph of `align`, 9 px square, bottom-aligned. */
function StopGlyph({ align, color = C.ink }) {
  const p = {
    left: 'M2 0V8H8', right: 'M7 0V8H1', center: 'M4.5 0V8M0.5 8H8.5', decimal: 'M4.5 0V8M0.5 8H8.5M7 4H8', bar: 'M4.5 0V9',
  }[align] ?? 'M2 0V8H8';
  return <svg width="9" height="9" viewBox="0 0 9 9" style={{ display: 'block' }}><path d={p} stroke={color} strokeWidth="1.6" fill="none" /></svg>;
}

/** An indent marker glyph: a down triangle, an up triangle or the Left Indent box. Only the drawn shape takes the pointer (its
 * marker passes `paint`), so at indent 0 the Left Margin boundary stays reachable between the two triangles' tips, as in Word. */
function IndentGlyph({ shape }) {
  const d = shape === 'down' ? 'M0.5 0.5H9.5L5 6Z' : shape === 'up' ? 'M5 0.5L9.5 6H0.5Z' : 'M0.5 0.5H9.5V4.5H0.5Z';
  return (
    <svg width="10" height={shape === 'box' ? 5 : 7} style={{ display: 'block' }}>
      <path d={d} fill={C.white} stroke={C.faint} strokeLinejoin="round" style={{ pointerEvents: 'visiblePainted' }} />
    </svg>
  );
}

/** The dotted guide line from the ruler down (or across) the page while a marker drags. */
function Guide({ axis, at, frame }) {
  const style = axis === 'v'
    ? { left: frame.vpLeft, width: frame.vpRight - frame.vpLeft, top: at, height: 0, borderTop: `1px dotted ${C.ink}` }
    : { left: at, top: frame.bottom, height: Math.max(0, frame.vpBottom - frame.bottom), width: 0, borderLeft: `1px dotted ${C.ink}` };
  return <div data-ruler-guide="" style={{ position: 'fixed', pointerEvents: 'none', zIndex: 40, ...style }} />;
}

/** Live measurements while Alt is held: each [from, to] segment's length in `unit`, at its middle. */
function Readouts({ segs, unit, place }) {
  return segs.map(([a, b], k) => (
    <span key={k} data-ruler-readout="" style={abs({ ...place((a + b) / 2), transform: 'translate(-50%, -50%)', font: '10px/1 system-ui',
      padding: '1px 3px', background: C.strip, color: C.ink, border: `1px solid ${C.line}`, borderRadius: 'var(--radius-xs)', whiteSpace: 'nowrap', zIndex: 6,
      pointerEvents: 'none' })}>
      {formatLength(Math.abs(b - a), unit)}
    </span>
  ));
}

// ---------------------------------------------------------------------------------------------
// The horizontal ruler

/** The tab selector's glyph for `kind`. */
const SelectorGlyph = ({ kind }) => (kind === 'firstLine' ? <IndentGlyph shape="down" /> : kind === 'hanging' ? <IndentGlyph shape="up" />
  : <StopGlyph align={kind} />);

// The selector's choice lives outside React so the keyboard mode and both rulers share it for the session, as Word keeps it.
let selector = 'left';

/** Word's horizontal ruler (belowRibbon slot). */
export function HorizontalRuler() {
  const ctx = useWordCtx();
  // A canvas draft's rulers read the engine (CanvasRuler.jsx); the DOM editor under it holds no document.
  return ctx.engine ? (ctx.settings?.word?.ruler !== false && <CanvasHorizontalRuler ctx={ctx} />) : <DomHorizontalRuler ctx={ctx} />;
}

function DomHorizontalRuler({ ctx }) {
  const unit = useUnit();
  const ref = useRef(null);
  const [drag, setDrag] = useState(null);
  const [kind, setKind] = useState(selector);
  const side = useSide();
  const shown = !!ctx.ed && !!ctx.state && SHOWN.has(ctx.view) && ctx.settings?.word?.ruler !== false && side !== 'thumbs';
  const geo = shown ? geometryOf(ctx.ed.state) : null;
  const frame = useFrame(shown ? ctx.ed : null, ref, [ctx.view, geo?.version, geo?.page, shown], side === 'pages');
  const table = useTable(shown ? ctx : { in: {}, state: null }, frame, geo?.version);
  if (!shown) return null;

  const { sect, state } = ctx;
  const paperW = sect.w;
  const mL = sect.margin.left;
  const mR = sect.margin.right;
  const Z = table?.cell ? table.cell.left : mL; // the ruler's 0: the text column's left, or the cell's text edge
  const width = table?.cell ? table.cell.width : paperW - mL - mR;
  const para = firstPara(state);
  const indent = para ? indentOf(state.doc, para.node) : { left: 0, right: 0, firstLine: 0 };
  const tabs = para ? tabStopsOf(state.doc, para.node) : { stops: [], default: 36 };
  const marks = indentMarkers(indent, width);
  const sectCols = geometryOf(ctx.ed.state)?.sectionOf?.(ctx.ed.state.selection.from)?.cols ?? null;

  const x0 = frame ? frame.pageLeft - frame.left : 0;
  const k = frame ? frame.scale * PX_PER_PT : PX_PER_PT;
  const sx = (pt) => x0 + pt * k; // pt from the paper's left → px in the strip
  const toPt = (ev) => (ev.clientX - frame.left - x0) / k;
  // Margins and section columns snap on the page's grid (from the left margin), the rest on the text column's (Z).
  const snapFrom = (from) => (pt, alt) => from + snap(pt - from, unit, alt);
  const offRuler = (ev) => ev.clientY > frame.bottom + 16;
  const live = (kindOf, i, x) => (drag && drag.kind === kindOf && drag.i === i ? drag.x : x);

  const commit = (st) => {
    const rel = st.x - Z;
    if (['firstLine', 'hanging', 'leftIndent', 'rightIndent'].includes(st.kind)) {
      const patch = indentPatch({ leftIndent: 'left', rightIndent: 'right' }[st.kind] ?? st.kind, indent, rel, width);
      ctx.chain((c) => c.setParaProps({ indent: patch }));
    } else if (st.kind === 'stop') {
      const stop = tabs.stops[st.i];
      if (st.off) writeTabs(ctx, (own, inh, n, doc) => (has(doc, n, stop.pos) ? removeOwn(own, inh, stop.pos) : undefined));
      else writeTabs(ctx, (own, inh, n, doc) => (has(doc, n, stop.pos) ? moveOwn(own, inh, stop.pos, rel, stop) : undefined));
    } else if (st.kind === 'marginLeft') writeSect(ctx, { margin: { left: Math.max(0, st.x) } });
    else if (st.kind === 'marginRight') writeSect(ctx, { margin: { right: Math.max(0, paperW - st.x) } });
    else if (st.kind === 'tableCol') {
      const widths = columnDrag(table.cols.widths, st.i, (st.x - st.start) * PX_PER_PT, st.mods ?? {});
      const tr = ctx.state.tr;
      setColumnWidths(tr, ctx.state.doc.nodeAt(table.pos), table.pos, widths);
      ctx.target.view.dispatch(tr);
    } else if (st.kind === 'colGap') writeColumns(ctx, sectCols, st, unit);
  };
  const begin = (e, d) => {
    if (e.button !== 0 || !frame) return;
    const page = ['marginLeft', 'marginRight', 'colGap'].includes(d.kind);
    startDrag(e, d, { toPt, snapAt: snapFrom(page ? mL : Z), off: d.kind === 'stop' ? offRuler : null, commit, set: setDrag });
  };
  const keys = (e, d) => markerKeys(e, d, { unit, drag, set: setDrag, commit, ctx });

  // A click on the white text area adds a stop of the selector's type there in every selected paragraph, or moves the First Line
  // or Hanging marker when the selector holds one (Word).
  const click = (e) => {
    if (!frame || e.target !== e.currentTarget) return;
    const rel = snap(toPt(e) - Z, unit, e.altKey);
    if (kind === 'firstLine' || kind === 'hanging') ctx.chain((c) => c.setParaProps({ indent: indentPatch(kind, indent, rel, width) }));
    else writeTabs(ctx, (own) => addOwn(own, { pos: rel, align: kind }));
  };
  // Double-clicks (Word, v): a stop or the text area opens Tabs (the first click already set the stop), an indent marker opens
  // Paragraph on Indents and Spacing, the grey band or a margin boundary opens Page Setup on Margins.
  const dbl = (e) => {
    const m = e.target.closest('[data-marker]')?.dataset.marker;
    if (m === 'stop' || e.target.hasAttribute('data-text-area')) openDialog(ctx, 'tabs');
    else if (['firstLine', 'hanging', 'leftIndent', 'rightIndent'].includes(m)) openDialog(ctx, 'paragraph', { tab: 'indents' });
    else if (m === 'marginLeft' || m === 'marginRight' || e.target.hasAttribute('data-band')) openDialog(ctx, 'pageSetup', { tab: 'margins' });
  };
  const cycle = () => {
    selector = nextSelector(kind);
    setKind(selector);
  };

  const at = (x, top, bottom, extra) => abs({ left: sx(x), top, height: bottom - top, ...extra });
  const marker = (d, tip, glyph, top, shift = -5, paint = false) => (
    <div key={`${d.kind}${d.i ?? ''}`} data-marker={d.kind} data-i={d.i} title={tip} aria-label={tip} role="slider" tabIndex={-1}
      onPointerDown={(e) => begin(e, d)} onKeyDown={(e) => keys(e, d)}
      style={abs({ left: sx(live(d.kind, d.i, d.x)) + shift, top, zIndex: 4, cursor: 'default', outline: 'none',
        pointerEvents: paint ? 'none' : undefined,
        opacity: drag?.kind === d.kind && drag.i === d.i && drag.off ? 0.35 : 1 })}>
      {glyph}
    </div>
  );

  let readouts = null;
  if (drag?.alt) {
    if (drag.kind === 'marginLeft') readouts = [[0, drag.x], [drag.x, paperW - mR]];
    else if (drag.kind === 'marginRight') readouts = [[mL, drag.x], [drag.x, paperW]];
    else if (drag.kind === 'tableCol') {
      const ws = columnDrag(table.cols.widths, drag.i, (drag.x - drag.start) * PX_PER_PT, drag.mods ?? {});
      let x = table.cols.left;
      readouts = ws.map((w) => [x, (x += w / PX_PER_PT)]);
    } else readouts = [[Z, drag.x], [drag.x, Z + width]];
  }

  const textL = mL;
  const textR = paperW - mR;
  const lastStop = tabs.stops.at(-1)?.pos ?? 0;
  return (
    <div ref={ref} data-ruler="h" data-word-ruler="" onMouseDown={(e) => e.preventDefault()} onDoubleClick={dbl}
      style={{ position: 'relative', height: H, overflow: 'hidden', background: C.strip, borderBottom: `1px solid ${C.line}`, userSelect: 'none' }}>
      {frame && (
        <>
          {/* The page's layer: everything placed from the page's left edge, moved as one while the sidebar slides (useFrame) */}
          <div data-ruler-page="" style={{ position: 'absolute', inset: 0 }}>
          <div data-band=""
            style={at(0, BAND[0], BAND[1], { width: paperW * k, background: C.grey })} />
          <div data-text-area="" onClick={click}
            style={at(textL, BAND[0], BAND[1], { width: Math.max(0, textR - textL) * k, background: C.white, zIndex: 1 })} />
          {sectCols && sectCols.slice(0, -1).map((c, i) => {
            const a = (c.left + c.width) / PX_PER_PT;
            const b = sectCols[i + 1].left / PX_PER_PT;
            return (
              <div key={`gap${i}`} style={at(textL + a, BAND[0], BAND[1], { width: (b - a) * k, background: C.grey, zIndex: 2 })}>
                {[['start', a, 0], ['move', (a + b) / 2, 0.5], ['end', b, 1]].map(([part, x, f]) => (
                  <div key={part} data-marker="colGap" data-i={i} title={{ start: TIPS.marginRight, move: TIPS.column, end: TIPS.marginLeft }[part]}
                    onPointerDown={(e) => begin(e, { kind: 'colGap', i, part, x: textL + x })}
                    style={abs({ left: `${f * 100}%`, top: 0, bottom: 0, width: 6, marginLeft: -3, cursor: 'ew-resize' })} />
                ))}
              </div>
            );
          })}
          <div style={abs({ left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none', zIndex: 2 })}>
            {ticks(unit, -Z, paperW - Z, k).map((t) => (t.label
              ? <span key={t.pos} style={abs({ left: sx(Z + t.pos), top: 7, transform: 'translateX(-50%)', font: '9px/1 system-ui', color: C.ink })}>{t.label}</span>
              : <span key={t.pos} style={abs({ left: sx(Z + t.pos), top: t.kind === 'mid' ? 9 : 11, height: t.kind === 'mid' ? 6 : 2, width: 1, background: C.faint })} />))}
            {defaultTicks(tabs.stops, tabs.default, Math.max(width, lastStop)).map((p) => (
              <span key={`d${p}`} data-default-stop="" style={abs({ left: sx(Z + p), top: BAND[1], height: 2, width: 1, background: C.faint })} />))}
          </div>
          {[['marginLeft', textL], ['marginRight', textR]].map(([m, x]) => (
            <div key={m} data-marker={m} title={TIPS[m]} aria-label={TIPS[m]} tabIndex={-1} onPointerDown={(e) => begin(e, { kind: m, x })}
              onKeyDown={(e) => keys(e, { kind: m, x })}
              style={abs({ left: sx(live(m, undefined, x)) - 3, top: BAND[0], height: BAND[1] - BAND[0], width: 6, cursor: 'ew-resize', zIndex: 3, outline: 'none' })} />
          ))}
          {table?.cols && (() => {
            let x = table.cols.left;
            return table.cols.widths.map((w, i) => {
              x += w / PX_PER_PT;
              return marker({ kind: 'tableCol', i, x }, TIPS.tableCol,
                <div style={{ width: 6, height: BAND[1] - BAND[0], background: C.grey, border: `1px solid ${C.faint}` }} />, BAND[0], -3);
            });
          })()}
          {tabs.stops.map((s, i) => marker({ kind: 'stop', i, x: Z + s.pos }, TIPS[s.align], <StopGlyph align={s.align} />, 11,
            s.align === 'left' ? -2 : s.align === 'right' ? -7 : -4.5))}
          {marker({ kind: 'firstLine', x: Z + marks.firstLine }, TIPS.firstLine, <IndentGlyph shape="down" />, BAND[0], -5, true)}
          {/* The triangles' tips stay 1.5 px apart (10.5 and 12), the Left Margin boundary's grab point at indent 0. */}
          {marker({ kind: 'hanging', x: Z + marks.hanging }, TIPS.hanging, <IndentGlyph shape="up" />, 12, -5, true)}
          {marker({ kind: 'leftIndent', x: Z + marks.left }, TIPS.leftIndent, <IndentGlyph shape="box" />, 18, -5, true)}
          {marker({ kind: 'rightIndent', x: Z + marks.right }, TIPS.rightIndent, <IndentGlyph shape="up" />, 12, -5, true)}
          {readouts && <Readouts segs={readouts} unit={unit} place={(x) => ({ left: sx(x), top: H / 2 })} />}
          {drag && <Guide axis="h" at={frame.left + sx(drag.x)} frame={frame} />}
          </div>
          <button type="button" data-tab-selector={kind} title={TIPS[kind]} aria-label={TIPS[kind]} onClick={cycle}
            style={abs({ left: frame.vpLeft - frame.left, top: 0, width: W, height: H, display: 'grid', placeItems: 'center',
              background: C.strip, border: 'none', borderRight: `1px solid ${C.line}`, zIndex: 5, padding: 0 })}>
            <SelectorGlyph kind={kind} />
          </button>
        </>
      )}
    </div>
  );
}

/** Whether paragraph `n` of `doc` shows a stop at `pos`. */
const has = (doc, n, pos) => tabStopsOf(doc, n).stops.some((s) => Math.round(s.pos * 20) === Math.round(pos * 20));

/** Writes a section column drag `st` (gap st.i, part st.part) into the `columns` node around the caret, the columns package's
 * node (plan.md §1.8): equal columns keep `equal` and change `space`; otherwise `widths` [{w, space}] in points. */
function writeColumns(ctx, cols, st) {
  const holder = ancestor(ctx.state, ['columns']);
  if (!holder || !cols) return;
  const pt = cols.map((c, i) => ({ w: c.width / PX_PER_PT, space: i < cols.length - 1 ? (cols[i + 1].left - c.left - c.width) / PX_PER_PT : 0 }));
  const { equal } = holder.node.attrs;
  const next = sectionColumnsDrag(pt, st.i, st.part, st.x - st.start, equal);
  const attrs = equal ? { space: next[0].space } : { equal: false, widths: next };
  ctx.chain((c) => c.command(({ tr }) => {
    tr.setNodeMarkup(holder.pos, null, { ...holder.node.attrs, ...attrs });
    return true;
  }));
}

// ---------------------------------------------------------------------------------------------
// The vertical ruler

/** Word's vertical ruler (viewport slot): Print Layout only, with View > Ruler and the vertical ruler option on. Every page in view
 * gets its own working ruler in one full-height column, so the rulers move with the pages as they scroll. */
export function VerticalRuler() {
  const ctx = useWordCtx();
  const word = ctx.settings?.word;
  // Word's ruler is a Document's: a forum post in the page area has its own card and no ruler (post.js).
  const doc = useStore((s) => s.draft?.format === 'document');
  if (!doc) return null;
  if (ctx.engine) return word?.ruler !== false && word?.verticalRuler !== false ? <CanvasVerticalRuler ctx={ctx} /> : null;
  return <DomVerticalRuler ctx={ctx} />;
}

function DomVerticalRuler({ ctx }) {
  const ref = useRef(null);
  const word = ctx.settings?.word;
  const side = useSide();
  const shown = !!ctx.ed && !!ctx.state && ctx.view === 'print' && word?.ruler !== false && word?.verticalRuler !== false && side !== 'thumbs';
  const geo = shown ? geometryOf(ctx.ed.state) : null;
  const frame = useFrame(shown ? ctx.ed : null, ref, [ctx.view, geo?.version, geo?.page, shown], side === 'pages');
  useEffect(() => {
    if (!shown) return undefined;
    insetChanged();
    return insetChanged;
  }, [shown]);
  if (!shown) return null;
  // The caret's page first, so a selector without a page finds its ruler; without pagination (a hidden session) one ruler reads
  // the section alone. Side to Side rules the caret's page only: the frame is its copy, and the pages around it are not stacked.
  const pages = !geo?.pages?.length || !frame ? [null] : side ? [geo.pages[geo.page]].filter(Boolean) : inView(geo, frame);
  return (
    <div ref={ref} style={abs({ inset: 0, overflow: 'hidden', pointerEvents: 'none' })}>
      {/* The ruler's column runs the viewport's full height in the horizontal strip's colours, so the two rulers frame the pages as
          one L from the tab selector. */}
      <div data-ruler-column="" data-viewport-inset="left" style={abs({ left: 0, top: 0, bottom: 0, width: W, background: C.strip, borderRight: `1px solid ${C.line}` })} />
      {frame && pages.map((page) => (
        <PageRuler key={page?.index ?? -1} ctx={ctx} frame={frame} version={geo?.version} page={page} current={!page || page.index === geo.page} />
      ))}
    </div>
  );
}

/** The pages of geometry `geo` that `frame`'s viewport shows any of, the caret's page first. */
function inView(geo, frame) {
  const h = frame.bottom - frame.top;
  const out = geo.pages.filter((p) => {
    const y = frame.domTop + p.top * frame.scale - frame.top;
    return y < h && y + p.box.h * frame.scale > 0;
  });
  return out.sort((a, b) => (b.index === geo.page) - (a.index === geo.page));
}

/** One page's vertical ruler: its margins, and on the caret's page the header or footer area being edited and the rows of the
 * table around the caret. A margin dragged on another page sets that page's section. */
function PageRuler({ ctx, frame, version, page, current }) {
  const unit = useUnit();
  const [drag, setDrag] = useState(null);
  const table = useTable(current && ctx.story === 'body' ? ctx : { in: {}, state: null }, frame, version);
  const box = page?.box;
  const paperH = box ? box.h / PX_PER_PT : ctx.sect.h;
  const top = box ? box.top / PX_PER_PT : ctx.sect.margin.top;
  const bottom = box ? box.bottom / PX_PER_PT : ctx.sect.margin.bottom;
  const story = current ? ctx.story : 'body';
  const section = current ? undefined : page.section;
  // While a header or footer is edited the ruler shows that area: its boundary is the header or footer distance (v).
  const edges = story === 'header' ? [['marginHeader', (box?.header ?? 0) / PX_PER_PT || ctx.sect.margin.header, 'Header']]
    : story === 'footer' ? [['marginFooter', paperH - ((box?.footer ?? 0) / PX_PER_PT || ctx.sect.margin.footer), 'Footer']]
      : [['marginTop', top, TIPS.marginTop], ['marginBottom', paperH - bottom, TIPS.marginBottom]];
  const Z = story === 'header' ? edges[0][1] : top;

  const y0 = frame.domTop + (page?.top ?? 0) * frame.scale - frame.top;
  const k = frame.scale * PX_PER_PT;
  const sy = (pt) => y0 + pt * k;
  const toPt = (ev) => (ev.clientY - frame.top - y0) / k;
  const snapAt = (pt, alt) => Z + snap(pt - Z, unit, alt);
  const live = (kind, i, y) => (drag && drag.kind === kind && drag.i === i ? drag.x : y);
  const rowPt = (y) => (y - frame.top - y0) / k;

  const commit = (st) => {
    const y = Math.max(0, st.x);
    if (st.kind === 'marginTop') writeSect(ctx, { margin: { top: y } }, section);
    else if (st.kind === 'marginBottom') writeSect(ctx, { margin: { bottom: Math.max(0, paperH - y) } }, section);
    else if (st.kind === 'marginHeader') writeSect(ctx, { margin: { header: y } });
    else if (st.kind === 'marginFooter') writeSect(ctx, { margin: { footer: Math.max(0, paperH - y) } });
    else if (st.kind === 'tableRow') {
      const row = table.rows[st.i];
      const value = Math.max(0, Math.round((st.x - rowPt(row.top)) * 20) / 20);
      ctx.chain((c) => c.command(({ tr }) => {
        tr.setNodeAttribute(row.pos, 'height', { ...row.node.attrs.height, value, rule: 'atLeast' });
        return true;
      }));
    }
  };
  const begin = (e, d) => {
    if (e.button !== 0) return;
    startDrag(e, d, { toPt, snapAt, commit, set: setDrag });
  };
  const keys = (e, d) => markerKeys(e, d, { unit, drag, set: setDrag, commit, ctx });

  let readouts = null;
  if (drag?.alt) {
    if (drag.kind === 'tableRow') readouts = table.rows.map((r, i) => [rowPt(r.top), i === drag.i ? drag.x : rowPt(r.bottom)]);
    else if (drag.kind === 'marginTop') readouts = [[0, drag.x], [drag.x, paperH - bottom]];
    else if (drag.kind === 'marginBottom') readouts = [[top, drag.x], [drag.x, paperH]];
    else readouts = [[0, drag.x]];
  }
  return (
    <>
      <div data-ruler="v" data-word-ruler="" data-page={page ? page.index + 1 : undefined} data-current={current || undefined}
        onMouseDown={(e) => e.preventDefault()} onDoubleClick={() => openDialog(ctx, 'pageSetup')}
        style={abs({ left: 0, top: sy(0), width: W, height: paperH * k, pointerEvents: 'auto', userSelect: 'none', background: C.grey, overflow: 'hidden',
          borderRight: `1px solid ${C.line}` })}>
        <div data-text-area="" style={abs({ left: 2, right: 2, top: top * k, height: Math.max(0, paperH - top - bottom) * k, background: C.white })} />
        {ticks(unit, -Z, paperH - Z, k).map((t) => (t.label
          ? <span key={t.pos} style={abs({ left: 0, width: W, textAlign: 'center', top: (Z + t.pos) * k, transform: 'translateY(-50%)', font: '9px/1 system-ui', color: C.ink })}>{t.label}</span>
          : <span key={t.pos} style={abs({ top: (Z + t.pos) * k, left: t.kind === 'mid' ? 6 : 8, width: t.kind === 'mid' ? 6 : 2, height: 1, background: C.faint })} />))}
        {edges.map(([kind, y, tip]) => (
          <div key={kind} data-marker={kind} title={tip} aria-label={tip} role="slider" tabIndex={-1}
            onPointerDown={(e) => begin(e, { kind, x: y, axis: 'v' })} onKeyDown={(e) => keys(e, { kind, x: y, axis: 'v' })}
            style={abs({ left: 0, width: W, top: live(kind, undefined, y) * k - 3, height: 6, cursor: 'ns-resize', zIndex: 3, outline: 'none' })} />
        ))}
        {table?.rows.map((r, i) => {
          const y = rowPt(r.bottom);
          return (
            <div key={`row${i}`} data-marker="tableRow" data-i={i} title={TIPS.tableRow} aria-label={TIPS.tableRow} role="slider" tabIndex={-1}
              onPointerDown={(e) => begin(e, { kind: 'tableRow', i, x: y, axis: 'v' })} onKeyDown={(e) => keys(e, { kind: 'tableRow', i, x: y, axis: 'v' })}
              style={abs({ left: 2, width: W - 4, top: live('tableRow', i, y) * k - 3, height: 6, background: C.grey, border: `1px solid ${C.faint}`,
                cursor: 'ns-resize', zIndex: 4, outline: 'none' })} />
          );
        })}
        {readouts && <Readouts segs={readouts} unit={unit} place={(y) => ({ left: W / 2, top: y * k })} />}
      </div>
      {drag && <Guide axis="v" at={frame.top + sy(drag.x)} frame={frame} />}
    </>
  );
}
