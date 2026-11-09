// The board's draw tools (docs/plans/board/briefs/bd-api.md): the Shape tool makes a shape in the dragged rectangle (a click
// places the default one, T38), the Line and Arrow tools make a two-point line, and the Hand tool pans. Keys B, O, L, Shift+L,
// V, H and Q. A press with a tool armed is this module's gesture: `pick` takes it, so pointer.js only dispatches.
import { keyAmong } from '../../app/keybinds.js';
import { kOf } from '../../engine/view/camera.mjs';
import { armTool } from '../../tooling/shape-picker.mjs';
import { ink, planeTools } from '../../whiteboard.js';
import { DRAG_PX } from '../gestures.mjs';
import { newShape, rgb, toPt } from '../look.mjs';
import { modelOf } from '../model.mjs';
import { registerTool, tools } from './registry.js';

const ACCENT = '#0d99ff';
const PRESETS = 64; // cached preset sizes, the last drawn
const presets = new Map(); // JSON [prst, av, w, h] → the promise of its fields
let chain = Promise.resolve(); // one item session: presets are made one at a time

/** A DrawingML preset as stored shape fields {kind, freeform, extra}, made in the item session with the engine's own commands
 * (design section 2: presets cost no Rust). The session is shared, so calls queue instead of interleaving: each opens the
 * model it makes, runs the commands and reads it back before the next begins. Cached by preset, adjust values and size. */
export function presetFields(ctx, prst, av, w, h) {
  const key = JSON.stringify([prst, av, w, h]);
  const had = presets.get(key);
  if (had) return had;
  const mine = () => build(ctx, prst, av, w, h);
  const p = (chain = chain.then(mine, mine));
  chain = p.catch(() => {}); // a failure is that call's, not every later one's
  presets.set(key, p);
  p.catch(() => presets.delete(key));
  for (const old of presets.keys()) {
    if (presets.size <= PRESETS) break;
    presets.delete(old);
  }
  return p;
}

/** The one preset build, with the item session to itself until it returns. */
async function build(ctx, prst, av, w, h) {
  await ctx.item.open(modelOf({ type: 'shape', kind: 'rectangle', w, h }), 'engine');
  await ctx.item.execMany([['select.all', {}], ['shape.change', { preset: prst, ...(av?.length ? { av } : {}) }], ['arrange.bounds', { width: w, height: h }]]);
  const saved = await ctx.item.save('engine');
  const model = JSON.parse(typeof saved === 'string' ? saved : new TextDecoder().decode(saved));
  const object = model.body?.find((b) => b.objects?.length)?.objects?.[0];
  if (!object) throw new Error(`The preset ${prst} made no shape.`);
  return { kind: object.kind, freeform: object.freeform ?? null, extra: object.extra ?? { preset: [prst, av] } };
}

/** The box a drag from `a` to `b` draws: Shift keeps it square, Alt keeps `a` at its centre. */
function shapeBox(a, b, { shift = false, alt = false } = {}) {
  let [dx, dy] = [b.x - a.x, b.y - a.y];
  if (shift) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  if (!alt) return { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
  return { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), w: 2 * Math.abs(dx), h: 2 * Math.abs(dy) };
}

/** A line's fields from `a` to `b`: its box, the direction in flipX / flipY, Shift snapped to 45 degrees. */
function lineFields(a, b, { shift = false } = {}) {
  let [dx, dy] = [b.x - a.x, b.y - a.y];
  if (shift) {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    [dx, dy] = [Math.cos(angle) * len, Math.sin(angle) * len];
  }
  const look = planeTools.line;
  const fields = {
    type: 'shape', kind: 'line', x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy),
    w: Math.abs(dx), h: Math.abs(dy), extra: { arrowEnd: look.heads?.end === 'arrow' },
    stroke: rgb(look.color) ?? rgb(ink()), strokeWidth: toPt(look.width || 1),
  };
  if (dx < 0) fields.flipX = true;
  if (dy < 0) fields.flipY = true;
  if (look.opacity != null) fields.opacity = look.opacity;
  return fields;
}

let gesture = null; // the shape being drawn, or the hand's drag
let preview = null; // its outline, in the screen plane

/** The outline of a drag: a plain element over the board, in the screen plane (world points, at the camera's scale). */
function showPreview(ctx, box) {
  const v = ctx.vp;
  if (!v) return;
  if (!preview) {
    preview = document.createElement('div');
    preview.dataset.boardPlace = '';
    Object.assign(preview.style, { position: 'absolute', left: '0', top: '0', boxSizing: 'border-box', pointerEvents: 'none', zIndex: 5,
      border: `1px solid ${ACCENT}`, background: 'color-mix(in srgb, #0d99ff 8%, transparent)' });
    v.root.append(preview);
  }
  const k = kOf(v.camera.zoom);
  preview.style.transform = `translate(${Math.round((box.x - v.camera.x) * k)}px, ${Math.round((box.y - v.camera.y) * k)}px)`;
  preview.style.width = `${Math.round(box.w * k)}px`;
  preview.style.height = `${Math.round(box.h * k)}px`;
}

function hidePreview() {
  preview?.remove();
  preview = null;
}

/** The item the gesture draws, one undo step; then the selection (and the end of the tool unless Keep tool is on). */
async function place(ctx, g, box) {
  const api = ctx.api;
  const look = { ...planeTools.shape };
  let fields;
  if (g.kind === 'line') {
    fields = lineFields(g.a, g.b, { shift: g.shift });
  } else {
    const click = !box;
    const base = newShape(look, click ? null : box);
    const [w, h] = [base.w, base.h];
    if (base.prst) {
      const preset = base.prst;
      delete base.prst;
      Object.assign(base, await presetFields(ctx, preset, look.av ?? [], w, h)); // a preset's own fields, made in the item session
    }
    fields = click ? { ...base, x: g.a.x - (base.w ?? w) / 2, y: g.a.y - (base.h ?? h) / 2 } : base;
  }
  let id = null;
  ctx.store.change('Add shape', (tx) => {
    id = tx.create({ ...fields, at: [null, ctx.store.orderKey(null, ctx.store.children(null).length, tx)] });
  });
  if (api.mode && !planeTools.keep()) api.setMode(null);
  ctx.selection.set(id ? [id] : []);
}

export default registerTool({
  id: 'place',
  modes: ['shape', 'line', 'hand'], // the tools this module draws with (PlaneBoard.setMode refuses any other)

  // A right click on the board opens its menu at the pointer (BoardMenu). The listener is on the document so it binds
  // before the view exists, and it takes only presses inside the board's own view. A text being edited keeps its own press
  // there (bd-text): the browser's spelling and paste menu opens, and the board's does not.
  mount(ctx) {
    const menu = (e) => {
      const root = ctx.vp?.root;
      if (!root || !root.contains(e.target) || e.target.closest?.('[data-board-chrome]')) return;
      if (ctx.api.inside?.(ctx.vp.fromClient(e.clientX, e.clientY).world)) return;
      e.preventDefault();
      ctx.api.menu(e);
    };
    document.addEventListener('contextmenu', menu);
    return () => {
      document.removeEventListener('contextmenu', menu);
      hidePreview();
    };
  },

  // With a tool armed, the press is this module's, not a selection's.
  pick(ctx, _world, _e) {
    const mode = ctx.api.mode;
    if (mode === 'hand') return { kind: 'hand' };
    if (mode === 'shape' || mode === 'line') return { kind: 'place' };
    return null;
  },

  down(ctx, hit, e) {
    const api = ctx.api;
    if (hit?.kind === 'hand') {
      gesture = { kind: 'hand', x: e.clientX, y: e.clientY };
      return true;
    }
    if (hit?.kind !== 'place') return false;
    const start = ctx.vp.fromClient(e.clientX, e.clientY).world;
    gesture = { kind: api.mode === 'line' ? 'line' : 'shape', a: start, b: start, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      shift: e.shiftKey, alt: e.altKey };
    return true;
  },

  move(ctx, e) {
    if (!gesture) return;
    if (gesture.kind === 'hand') {
      ctx.api.panBy(e.clientX - gesture.x, e.clientY - gesture.y);
      gesture.x = e.clientX;
      gesture.y = e.clientY;
      return;
    }
    gesture.x = e.clientX;
    gesture.y = e.clientY;
    // The point being drawn snaps as a point: every line of a zero box, on both axes, as Board's own draw tools do.
    const world = ctx.vp.fromClient(e.clientX, e.clientY).world;
    const step = tools.frame(ctx, { ids: [], box: { x: world.x, y: world.y, w: 0, h: 0 }, edges: ['n', 'e', 's', 'w'] },
      world.x - gesture.a.x, world.y - gesture.a.y, { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
    gesture.b = { x: gesture.a.x + step.dx, y: gesture.a.y + step.dy };
    gesture.shift = e.shiftKey;
    gesture.alt = e.altKey;
    showPreview(ctx, gesture.kind === 'line' ? lineBox(gesture) : shapeBox(gesture.a, gesture.b, gesture));
  },

  // `e` is the press's event (pointer.js hands `up` the press, not the release), so the last move's point says whether it was
  // a click or a drag.
  up(ctx) {
    const g = gesture;
    gesture = null;
    hidePreview();
    if (!g || g.kind === 'hand') return;
    const click = Math.hypot(g.x - g.x0, g.y - g.y0) < DRAG_PX;
    if (g.kind === 'line') {
      const line = { ...g, b: click ? { x: g.a.x + toPt(160), y: g.a.y } : g.b }; // a click draws the default line, as Board does
      place(ctx, line, null).catch((err) => console.warn('The line was not placed', err));
      return;
    }
    place(ctx, g, click ? null : shapeBox(g.a, g.b, g)).catch((err) => console.warn('The shape was not placed', err));
  },

  cancel() {
    gesture = null;
    hidePreview();
  },

  // The board's tool keys, by the user's own chords (app/keys.mjs): V, H, B, O, L, Shift+L and Q. Esc disarms.
  keydown(ctx, e) {
    const api = ctx.api;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.code === 'Escape') {
      if (!api.mode) return false;
      api.setMode(null);
      return true;
    }
    const keys = {
      'board.select': () => api.setMode(null),
      'board.hand': () => api.setMode('hand'),
      'board.box': () => armTool(api, { kind: 'rect' }),
      'board.circle': () => armTool(api, { kind: 'ellipse' }),
      'board.line': () => api.armLine(false),
      'board.arrow': () => api.armLine(true),
      'board.keepTool': () => api.setKeepTool(!planeTools.keep()),
    };
    const id = keyAmong(Object.keys(keys), e);
    if (!id) return false;
    keys[id]();
    return true;
  },
});

/** A line's box for the preview and the drag: the two points' extent. */
function lineBox(g) {
  const { a, b } = g;
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
