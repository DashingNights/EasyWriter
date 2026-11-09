// The Draw tab's two overlays (docs/plans/word briefs/draw.md): the Ruler stencil over the canvas being edited and Ink Replay
// over a canvas. Both are fixed boxes inside #editor-area marked as board chrome, so a pointer-down on them keeps the canvas
// editor open, and both close on Esc before the canvas editor sees it.
import { CHROME } from '../../../app/components/board/controls.jsx';
import { canvasEditor } from '../../../canvas.js';
import { replayOrder, snapToRuler } from './pens.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};
const div = (cls, props = {}) => Object.assign(document.createElement('div'), { className: cls }, props);
const area = () => document.getElementById('editor-area');
const chrome = (el) => {
  for (const [k, v] of Object.entries(CHROME)) el.setAttribute(k, v);
  return el;
};
const board = () => canvasEditor.get()?.board ?? null;

// ---------------------------------------------------------------------------------------------
// Ruler: dragged to move, the wheel turns it by 1 degree (Shift: 15). A pen stroke on the open canvas whose two ends lie within
// 8 px of a long edge is straightened onto that edge when it ends.

const LENGTH = 560;
const THICK = 64;
let ruler = null; // {el, label, ticks, cx, cy, angle, unit, off}

/** Shows or hides the ruler; `unit` 'cm' or 'in' sets its ticks. → whether it shows. */
export function setRuler(on, unit = 'cm') {
  if (!on) {
    ruler?.off();
    ruler = null;
    return false;
  }
  if (ruler) return true;
  const host = area();
  if (!host) return false;
  const r = host.getBoundingClientRect();
  const el = chrome(div('draw-ruler', { role: 'slider', ariaLabel: 'Ruler', tabIndex: -1 }));
  el.dataset.drawRuler = '';
  const ticks = svg('svg', { class: 'draw-ruler-ticks', width: LENGTH, height: THICK });
  const label = div('draw-ruler-angle');
  el.append(ticks, label);
  host.append(el);
  ruler = { el, label, ticks, cx: r.left + r.width / 2, cy: r.top + Math.min(r.height / 2, 260), angle: 0, unit, scale: 0 };
  const drag = { id: null };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    Object.assign(drag, { id: e.pointerId, x: e.clientX - ruler.cx, y: e.clientY - ruler.cy });
    el.setPointerCapture?.(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== drag.id) return;
    [ruler.cx, ruler.cy] = [e.clientX - drag.x, e.clientY - drag.y];
    placeRuler();
  });
  const end = (e) => e.pointerId === drag.id && (drag.id = null);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const a = ruler.angle + Math.sign(e.deltaY || e.deltaX) * (e.shiftKey ? 15 : 1);
    ruler.angle = ((((a + 180) % 360) + 360) % 360) - 180;
    placeRuler();
  }, { passive: false });
  // The stroke a pointer-down starts on the open canvas, snapped once the board has committed it.
  let before = null;
  const down = (e) => {
    const b = board();
    before = b && b.mode === 'pen' && b.dom.contains(e.target) ? new Set(b.items.map((i) => i.id)) : null;
  };
  const up = () => {
    if (!before) return;
    const seen = before;
    before = null;
    setTimeout(() => snapNew(seen));
  };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up);
  ruler.off = () => {
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointerup', up);
    el.remove();
  };
  placeRuler();
  return true;
}

export const rulerOn = () => !!ruler;

// Screen px per post px: the canvas editor's scale times its unit, else 1.
const postScale = () => {
  const b = board();
  return b ? b.scale() * b.unit : 1;
};

function placeRuler() {
  const { el, label, cx, cy, angle } = ruler;
  Object.assign(el.style, { left: `${cx - LENGTH / 2}px`, top: `${cy - THICK / 2}px`, transform: `rotate(${angle}deg)` });
  label.textContent = `${Math.round(Math.abs(angle))}°`;
  const k = postScale();
  if (k !== ruler.scale) drawTicks(k);
}

// Ticks along the top edge at true length on the page: cm with mm ticks, or inches with eighths.
function drawTicks(k) {
  ruler.scale = k;
  const [unit, parts] = ruler.unit === 'in' ? [96, 8] : [96 / 2.54, 10];
  const step = (unit * k) / parts;
  const out = [];
  for (let i = 0; i * step <= LENGTH; i++) {
    const x = Math.round(i * step * 10) / 10;
    const len = i % parts === 0 ? 18 : i % (parts / 2) === 0 ? 12 : 7;
    out.push(svg('line', { x1: x, y1: 0, x2: x, y2: len }));
    if (i % parts === 0 && i) out.push(Object.assign(svg('text', { x, y: 30 }), { textContent: String(i / parts) }));
  }
  ruler.ticks.replaceChildren(...out);
}

// The ruler's long edges as lines in the board's px.
function edgesOn(b) {
  const { cx, cy, angle } = ruler;
  const t = (angle * Math.PI) / 180;
  const [dx, dy, nx, ny] = [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t)];
  const at = (x, y) => b.local({ clientX: x, clientY: y });
  return [-1, 1].map((side) => {
    const [ex, ey] = [cx + (side * nx * THICK) / 2, cy + (side * ny * THICK) / 2];
    return { a: at(ex - (dx * LENGTH) / 2, ey - (dy * LENGTH) / 2), b: at(ex + (dx * LENGTH) / 2, ey + (dy * LENGTH) / 2) };
  });
}

function snapNew(seen) {
  const b = board();
  if (!ruler || !b || b.destroyed) return;
  const edges = edgesOn(b);
  let changed = false;
  // The tolerance is 8 screen px in board px.
  const tol = 8 / b.scale();
  const items = b.items.map((i) => {
    if (i.type !== 'stroke' || seen.has(i.id)) return i;
    const s = snapToRuler(i, edges, tol);
    if (s) changed = true;
    return s ?? i;
  });
  if (!changed) return;
  b.items = items;
  b.commit(); // within the history's merge window: one undo step with the stroke; the session's sync redraws the board
}

// ---------------------------------------------------------------------------------------------
// Ink Replay: the stroke items of one canvas drawn again one by one in item order (SVG stroke-dashoffset), with play, pause
// and a scrub bar. The canvas's own strokes hide meanwhile ([data-draw-replay]).

let replay = null;

/** Replays `target` = {el, items, w, h}: the element showing the canvas, its items and the board size `el` shows. → false
 * when it has no strokes. */
export function startReplay(target, onEnd) {
  stopReplay();
  const strokes = replayOrder(target.items);
  const host = area();
  if (!strokes.length || !host) return false;
  const box = chrome(div('draw-replay'));
  box.dataset.drawReplay = '';
  const pic = svg('svg', { viewBox: `0 0 ${target.w} ${target.h}`, preserveAspectRatio: 'none', class: 'draw-replay-ink' });
  const parts = strokes.map((s) => {
    const inner = svg('svg', { x: s.x, y: s.y, width: s.w, height: s.h, viewBox: `0 0 ${s.vw} ${s.vh}`, preserveAspectRatio: 'none', overflow: 'visible' });
    const path = svg('path', { d: s.d, fill: 'none', stroke: s.color, 'stroke-width': s.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: s.opacity ?? 1 });
    inner.append(path);
    pic.append(inner);
    return { path };
  });
  const bar = div('draw-replay-bar');
  const play = Object.assign(document.createElement('button'), { type: 'button', className: 'draw-replay-play' });
  const scrub = Object.assign(document.createElement('input'), { type: 'range', min: 0, step: 1, ariaLabel: 'Replay position' });
  const close = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Close', ariaLabel: 'End ink replay' });
  bar.append(play, scrub, close);
  box.append(pic, bar);
  host.append(box);
  target.el.setAttribute('data-draw-replay', '');
  // Lengths are known once the paths are in the DOM; each stroke takes 4 ms per px, 200 to 1500 ms.
  let total = 0;
  for (const p of parts) {
    p.len = p.path.getTotalLength?.() || 1;
    p.start = total;
    p.ms = Math.min(1500, Math.max(200, p.len * 4));
    total += p.ms;
    p.path.style.strokeDasharray = `${p.len}`;
  }
  scrub.max = String(Math.round(total));
  replay = { box, target, parts, total, at: 0, playing: true, last: performance.now(), onEnd, raf: 0, play, scrub };
  play.addEventListener('click', () => {
    if (replay.at >= total) replay.at = 0;
    replay.playing = !replay.playing;
    replay.last = performance.now();
  });
  scrub.addEventListener('input', () => {
    replay.at = Number(scrub.value);
    replay.playing = false;
  });
  close.addEventListener('click', () => stopReplay());
  for (const el of [play, scrub, close]) el.addEventListener('mousedown', (e) => e.target !== scrub && e.preventDefault());
  tick();
  return true;
}

export const replayOn = () => !!replay;

function tick() {
  const r = replay;
  if (!r) return;
  if (!r.target.el.isConnected) return stopReplay();
  const now = performance.now();
  if (r.playing) r.at = Math.min(r.total, r.at + (now - r.last));
  r.last = now;
  if (r.at >= r.total) r.playing = false;
  const rect = r.target.el.getBoundingClientRect();
  Object.assign(r.box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  for (const p of r.parts) p.path.style.strokeDashoffset = String(p.len * (1 - Math.min(1, Math.max(0, (r.at - p.start) / p.ms))));
  r.scrub.value = String(Math.round(r.at));
  r.play.textContent = r.playing ? 'Pause' : 'Play';
  r.play.ariaLabel = r.playing ? 'Pause ink replay' : 'Play ink replay';
  r.raf = requestAnimationFrame(tick);
}

/** Ends the replay and shows the canvas's strokes again. */
export function stopReplay() {
  if (!replay) return;
  const { box, target, raf, onEnd } = replay;
  replay = null;
  cancelAnimationFrame(raf);
  box.remove();
  target.el.removeAttribute('data-draw-replay');
  onEnd?.();
}

// Esc ends the replay first, then hides the ruler, before the canvas editor closes on it.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || (!replay && !ruler)) return;
  e.preventDefault();
  e.stopPropagation();
  if (replay) stopReplay();
  else setRuler(false);
  escHook?.();
}, true);

let escHook = null;
/** Called after Esc closed an overlay, so the ribbon's toggles follow. */
export const onOverlayEsc = (fn) => {
  escHook = fn;
};
