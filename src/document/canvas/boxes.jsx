// EasyWriter's own objects in the canvas page area (docs/plans/engine/viewport-design.md section 5.3, P14): a smart canvas or a
// plan chart in an engine Document is a box, a drawing the engine places and paints (its fallback picture) with the object's data
// beside it. This frame kind draws the object live over its fallback: a canvas with drawCanvas, a plan chart with the plan's own
// chart. A double-click on a canvas opens canvas edit mode (a Board over the frame), and so does openBox (a new canvas, a new
// flowchart in the shape tool); closing it commits once through the engine's `box.set` with a new fallback picture, so the edit is
// one undo step there, and saves and prints like any other edit.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { canvasLooks } from '../../canvas.js';
import { boardPicture } from '../../export.js';
import { readForm } from '../../board/store.mjs';
import { boxOf as itemBox } from '../docx/shapes-out.mjs';
import { chartLayout, drawn, pagePalette, parseChart, planSource } from '../../plan-chart.js';
import { Board, drawCanvas, exportDensity } from '../../whiteboard.js';
import { PX_PER_PT } from '../../engine/view/camera.mjs';
import { base64 } from '../../tooling/base64.mjs';
import { useSessionWatch } from '../../tooling/engine-value.js';

const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const FALLBACK_DPI = 300;
// The edit's own events stay in the box: the page area's input would take them as typing, keys and caret moves in the text.
const OWN = ['mousedown', 'pointerdown', 'dblclick', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'compositionstart',
  'compositionupdate', 'compositionend', 'paste', 'copy', 'cut', 'contextmenu'];

const shown = new Map(); // frame id → open(mode) of its BoxFrame now drawn: whether it opened
const asked = new Map(); // frame id → {mode, until}: an open asked for before its BoxFrame could take it
const ASK_MS = 5000;
const openEdits = new Set(); // each open box edit: () => Promise, closing it with its commit

/** Commits any box being edited in place now and waits for its box.set → a promise (the push runs it before it saves, so the
 * post it uploads has every canvas's last edit). */
export async function commitOpenBoxes() {
  await Promise.all([...openEdits].map((close) => close()));
}

/** Opens canvas box `id` in box edit mode, its Board in tool `mode` ('shape': the shape tool) when given, once the page area
 * draws it (within a few seconds of the call): a new canvas or flowchart opens for editing as in the DOM editor. */
export function openBox(id, { mode = null } = {}) {
  const key = String(id);
  if (shown.get(key)?.(mode)) return;
  asked.set(key, { mode, until: performance.now() + ASK_MS });
}

/** A box's data, kind and file from session `client`'s engine → {kind, attrs, data, file} or null. */
async function boxOf(client, id) {
  const r = await client.exec('box.get', { id: Number(id) });
  if (!r?.ok) return null;
  try {
    return { kind: r.value.kind, attrs: JSON.parse(r.value.data), data: r.value.data, file: r.value.file ?? '' };
  } catch {
    return null;
  }
}

/** The part of canvas `attrs`, in artboard px, that box frame `frame` shows: the lone shape's own box when the fallback is the Word
 * shape export.mjs writes for a canvas holding one shape or connector (shapes-out.mjs shapeDrawing), else the whole artboard. */
function shownPart(frame, a) {
  const [it] = a.items ?? [];
  const lone = frame.fallback === 'shape' && a.items?.length === 1 && !a.docPr?.canvas && (it.type === 'shape' || it.type === 'connector');
  const r = lone ? itemBox(it) : { x: 0, y: 0, w: a.w, h: a.h };
  return r.w > 0 ? r : { x: 0, y: 0, w: a.w, h: a.h };
}

/** The transform that puts part `r` of an artboard on a box `width` CSS px wide. */
const placeArt = (r, width) => {
  const s = width / r.w;
  return `translate(${-r.x * s}px, ${-r.y * s}px) scale(${s})`;
};

/** The box's frame component ({frame, session, surface, k, fill, vp}): the object drawn at the frame's size, edited in place. `fill`
 * (a forum post) sizes a plan chart to its measured height through box.fill; a Document's own layout sizes its charts. `vp`: the
 * viewport, which keeps the page of a canvas being edited drawn when a scroll takes it out of view. */
export function BoxFrame({ frame, session, surface, k, fill = false, vp = null }) {
  const client = useSessionWatch(session);
  const [box, setBox] = useState(null);
  const [editing, setEditing] = useState(false);
  const el = useRef(null);
  const edit = useRef(null); // the canvas edit open here: editBox's {commit, off, place}
  const filled = useRef(null); // the last plan chart height sent to box.fill: one fill per size
  const w = frame.w * k;
  const h = frame.h * k;
  // A canvas already in the board form is the Canvas engine's to paint (bd-box): the DOM canvas editor cannot read it, so this
  // frame leaves the fallback picture and refuses the edit until then.
  const live = box?.kind === 'canvas' && readForm(box.attrs) === 'old';

  // A new frames list (a layout of its page: a commit, an undo) reads the data again.
  useEffect(() => {
    let dead = false;
    boxOf(client, frame.id).then((b) => !dead && setBox(b), () => {});
    return () => {
      dead = true;
    };
  }, [client, frame]);

  useLayoutEffect(() => {
    const host = el.current;
    if (!host || !box || editing) return undefined;
    if (live) {
      const a = box.attrs;
      const art = drawCanvas(host, { aw: a.w, ah: a.h, bg: a.bg, items: a.items ?? [] });
      art.style.transform = placeArt(shownPart(frame, a), w);
      return () => {
        art.remove();
        host.style.background = '';
      };
    }
    if (box.kind === 'media') return drawMedia(host, box, { w, h, k, frame, client });
    // A post's plan chart takes its measured height as the frame's (box.fill): the cell has no natural height of its own.
    return drawChart(host, box.attrs, w, !fill ? undefined : (cssHeight) => {
      const pt = Math.round((cssHeight / k) * 1000) / 1000;
      const last = filled.current;
      if (cssHeight > 0 && Math.abs(pt - frame.h) > 0.5 && !(last?.id === frame.id && Math.abs(last.h - pt) < 0.25)) {
        filled.current = { id: frame.id, h: pt };
        client.exec('box.fill', { id: Number(frame.id), h: pt });
      }
    });
  }, [box, editing, live, w, h, k, frame, client, fill]);

  // The box's events stop here (OWN), React's included, so the double-click is heard here too.
  const open = useRef(null);
  open.current = (mode = null) => {
    if (live) setEditing((e) => e || { mode }); // an open edit stays as it is
    else if (box?.kind === 'planChart') planSource.open(box.attrs.planId, box.attrs.view);
    else return false;
    return true;
  };
  useEffect(() => {
    const key = String(frame.id);
    shown.set(key, (mode) => open.current(mode));
    return () => shown.delete(key);
  }, [frame.id]);
  // An openBox that came before the data: taken once the box is read.
  useEffect(() => {
    const key = String(frame.id);
    const a = asked.get(key);
    if (!a || !box) return;
    asked.delete(key);
    if (a.until >= performance.now()) open.current(a.mode);
  }, [box, frame.id]);
  useEffect(() => {
    const host = el.current;
    const stop = (e) => e.stopPropagation();
    const dbl = () => open.current();
    for (const t of OWN) host.addEventListener(t, stop);
    host.addEventListener('dblclick', dbl);
    return () => {
      for (const t of OWN) host.removeEventListener(t, stop);
      host.removeEventListener('dblclick', dbl);
    };
  }, []);

  useLayoutEffect(() => {
    if (!editing || !box) return undefined;
    const part = shownPart(frame, box.attrs);
    const open = editBox(el.current, box.attrs, { part, width: w, unit: part.w / (frame.w * PX_PER_PT) }, async (attrs) => {
      setEditing(false);
      if (attrs) await commitBox(client, frame, attrs, part);
    }, editing.mode);
    edit.current = open;
    openEdits.add(open.commit);
    const key = vp?.placements.find((p) => p.session === session && p.surface === surface)?.key;
    const release = key == null ? null : vp.keep(key);
    return () => {
      release?.();
      openEdits.delete(open.commit);
      edit.current = null;
      open.off();
    };
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  // A zoom resizes the frame (its width is the frame's points times the zoom): the board follows it.
  useLayoutEffect(() => edit.current?.place(w), [w]);

  return (
    <div ref={el} data-box={box?.kind ?? ''} data-editing={editing ? '' : undefined}
      title={live ? 'Double-click to edit the canvas.' : box?.kind === 'planChart' ? 'Double-click to open the plan.' : undefined}
      style={{ position: 'absolute', inset: 0, width: w, height: h, overflow: editing || box?.kind === 'media' ? 'visible' : 'hidden', pointerEvents: 'auto',
        outline: editing ? '2px solid var(--ui-accent, Highlight)' : undefined, zIndex: editing ? 2 : undefined }} />
  );
}

/** Draws plan chart `attrs` into `host`, `width` CSS px wide, as the Document's plan chart view does → a function that removes it.
 * `measured(cssHeight)` gets the height the chart draws at. Without its plan (or the app's chart), the engine's fallback picture
 * under it stays in view. */
function drawChart(host, attrs, width, measured = () => {}) {
  const c = parseChart(attrs);
  const ctx = c.frozen?.ctx ?? planSource.context(c.planId);
  if (!ctx || !planSource.Chart) return undefined;
  const { ctx: shown, o } = drawn(ctx, c.options);
  const lay = chartLayout(c.view, shown, o, width);
  if (lay.error) return undefined;
  const inner = document.createElement('div');
  inner.style.cssText = `width:${lay.layoutWidth}px;transform-origin:0 0;transform:scale(${width / lay.layoutWidth})`;
  host.append(inner);
  const root = createRoot(inner);
  root.render(<planSource.Chart ctx={shown} view={c.view} options={o} palette={pagePalette(theme())} width={lay.layoutWidth} />);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measured(inner.getBoundingClientRect().height)) : null;
  ro?.observe(inner);
  const frame = requestAnimationFrame(() => measured(inner.getBoundingClientRect().height));
  return () => {
    cancelAnimationFrame(frame);
    ro?.disconnect();
    root.unmount();
    inner.remove();
  };
}

/** The corners a media box resizes from, and their cursor and place in it. */
const RESIZE = [
  ['nw', 'nwse-resize', { left: '-5px', top: '-5px' }], ['ne', 'nesw-resize', { right: '-5px', top: '-5px' }],
  ['sw', 'nesw-resize', { left: '-5px', bottom: '-5px' }], ['se', 'nwse-resize', { right: '-5px', bottom: '-5px' }],
];

/** A media box drawn in `host`: its picture or video at the frame's size, or the line naming a medium still downloading, with
 * the corner handles that resize it through box.set (they show while the pointer is over it). The width leads; the height keeps
 * the frame's ratio, as the DOM editor's media resize does. → a function that removes it. */
function drawMedia(host, b, { w, h, k, frame, client }) {
  const src = b.file;
  const name = b.attrs?.name || 'media';
  let el;
  if (!src.startsWith('data:')) {
    el = document.createElement('div');
    el.className = 'flex items-center justify-center rounded-md border border-dashed border-border px-4 py-8 text-sm text-muted-foreground';
    el.textContent = `Downloading ${name}`;
    el.setAttribute('data-media-pending', '');
  } else if (src.startsWith('data:video/')) {
    el = Object.assign(document.createElement('video'), { src, controls: true, preload: 'metadata' });
  } else {
    el = Object.assign(document.createElement('img'), { src, alt: name });
  }
  Object.assign(el.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain' });
  host.append(el);
  const handles = RESIZE.map(([corner, cursor, at]) => {
    const hnd = document.createElement('div');
    Object.assign(hnd.style, { position: 'absolute', width: '10px', height: '10px', background: '#ffffff',
      border: '1px solid var(--ui-accent, #2a7fff)', borderRadius: '2px', cursor, display: 'none', zIndex: 3 }, at);
    hnd.setAttribute('data-resize', corner);
    return hnd;
  });
  host.append(...handles);
  const show = (on) => {
    for (const hnd of handles) hnd.style.display = on ? 'block' : 'none';
  };

  // The column a medium may grow to: past it the reader clamps it, so the box would shrink again on the next open.
  let column = Infinity;
  Promise.resolve(client.query('box.list', {})).then((r) => {
    if (r?.value?.column > 0) column = r.value.column;
  }, () => {});

  let drag = null;
  const down = (e) => {
    const corner = e.target?.getAttribute?.('data-resize');
    if (!corner) return;
    e.preventDefault();
    e.stopPropagation();
    const [w0, h0] = [frame.w, frame.h];
    const left = corner.includes('w'); // its left-edge handles grow the box leftwards, their edge following the pointer
    const sign = left ? -1 : 1;
    const x0 = e.clientX;
    const move = (ev) => {
      const width = Math.min(Math.max(8, w0 + (sign * (ev.clientX - x0)) / k), column);
      drag = { w: width, h: (width * h0) / w0 };
      Object.assign(host.style, { width: `${drag.w * k}px`, height: `${drag.h * k}px`, transform: left ? `translateX(${-(drag.w - w0) * k}px)` : '' });
    };
    const up = async () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      const done = drag;
      drag = null;
      host.style.transform = '';
      if (!done || (done.w === w0 && done.h === h0)) return;
      // The display width goes in the data too: the post's own form (the forum push, a DOM reopen) reads `dw`, not the hint.
      const data = JSON.stringify({ ...b.attrs, dw: round3(done.w) });
      const r = await client.exec('box.set', { id: Number(frame.id), data, w: round3(done.w), h: round3(done.h) });
      if (!r?.ok) Object.assign(host.style, { width: `${w}px`, height: `${h}px` });
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  };
  const enter = () => show(true);
  const leave = () => {
    if (!drag) show(false);
  };
  host.addEventListener('pointerdown', down);
  host.addEventListener('pointerenter', enter);
  host.addEventListener('pointerleave', leave);
  return () => {
    host.removeEventListener('pointerdown', down);
    host.removeEventListener('pointerenter', enter);
    host.removeEventListener('pointerleave', leave);
    el.remove();
    for (const hnd of handles) hnd.remove();
  };
}

/** A value rounded as the post's saved form writes it (thousandths). */
const round3 = (v) => Math.round(v * 1000) / 1000;

/** Canvas edit mode in `host`: a Board on canvas `attrs`, `part` of it (shownPart) on a host `width` CSS px wide, with its own undo
 * while it is open, in tool `mode` when given. `unit` is the board px per post px at a zoom of 100 %: sizes a tool draws with stay
 * the same at any zoom. Escape (with nothing selected) or a press outside the board and its chrome ends it: `done(attrs)` gets the
 * last commit, or null when nothing changed → {commit(), off(), place(width)}: end it now with its commit (its box.set's promise) or
 * without one, or fit the board to a host that is now `width` px wide (a zoom). */
function editBox(host, attrs, { part, width, unit }, done, mode = null) {
  let cur = attrs;
  const undo = [];
  const redo = [];
  const board = new Board(attrs, {
    commit: (next) => {
      undo.push(cur);
      redo.length = 0;
      cur = next;
    },
    undo: () => undo.length && (redo.push(cur), board.setAttrs((cur = undo.pop()))),
    redo: () => redo.length && (undo.push(cur), board.setAttrs((cur = redo.pop()))),
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
    emptyClick: () => board.dom.focus({ preventScroll: true }),
    shift: () => {},
    textWidth: () => attrs.w,
    look: (tool, kind) => canvasLooks.look(tool, kind),
    setLook: (tool, patch) => canvasLooks.setLook(tool, patch),
    autoFit: false, // a Document's canvas keeps its shapes' size (canvas.js)
    overflow: false,
  }, { unit });
  Object.assign(board.dom.style, { position: 'absolute', left: 0, top: 0, width: `${attrs.w}px`, height: `${attrs.h}px`, transformOrigin: '0 0',
    transform: placeArt(part, width) });
  host.append(board.dom);
  board.dom.focus({ preventScroll: true });
  if (mode) board.setMode(mode);
  let closed = false;
  let pending = Promise.resolve();
  const close = (commit) => {
    if (closed) return pending;
    closed = true;
    window.removeEventListener('pointerdown', outside, true);
    host.removeEventListener('keydown', key, true);
    if (commit) board.finishEdit();
    board.destroy();
    board.dom.remove();
    if (commit) pending = Promise.resolve(done(cur === attrs ? null : cur));
    return pending;
  };
  // The board's own chrome (the rail, its flyouts and menus, the layers panel) and a dialog it opened (More Colors) are not outside.
  const outside = (e) => !host.contains(e.target) && !(e.target instanceof Element && e.target.closest('[data-board-chrome], [role=dialog]')) && close(true);
  const key = (e) => {
    if (e.key === 'Escape' && !board.sel.size && board.editingId == null && !board.mode) close(true);
  };
  window.addEventListener('pointerdown', outside, true);
  host.addEventListener('keydown', key, true); // before the board's own Escape clears its selection
  const place = (cssWidth) => {
    board.dom.style.transform = placeArt(part, cssWidth);
    board.refreshScale(); // the handles keep their screen size
  };
  return { commit: () => close(true), off: () => close(false), place };
}

/** Commits canvas `attrs` to the box of `frame` in `client`'s session: the data and a new fallback picture of the whole artboard at
 * FALLBACK_DPI, in one `box.set`. The artboard keeps the scale the box showed `part` (shownPart) at. */
async function commitBox(client, frame, attrs, part = { w: attrs.w }) {
  const pt = frame.w / part.w; // points per artboard px
  const [w, h] = [attrs.w * pt, attrs.h * pt];
  const { blob } = await boardPicture({ ...attrs, kind: 'canvas' }, (w * FALLBACK_DPI) / 72 / exportDensity('file'), 'light', 1);
  const fallback = `data:image/png;base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
  return client.exec('box.set', { id: Number(frame.id), data: JSON.stringify(attrs), fallback, w, h });
}
