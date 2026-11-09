// bd-dragout (docs/plans/board/briefs/bd-dragout.md, design section 7): content leaves a focused document by a drag and goes into one.
// A press on the selection of the focused document, or on a picture or shape in it, waits for 4 px (the engine's pointer arms it, as
// pointerOptions.textDrag says) and then the drag is this tool's: a ghost follows the pointer, a page under a possible drop gets an
// outline, Alt copies and Space keeps the drop free. A drop on the plane makes a board item, on another page moves the content into
// that draft, on a page of the same draft moves it there; a release outside the view cancels. A board item dragged onto a page goes the
// other way (moveFrame, transform and moved). transfer.js makes every move in an order that only duplicates, and every drag has one
// journal entry.
//
// The canvas editor has no drag of its own for an object, so there is no hook for it to give up the pointer: the press that arms a
// drag is `object.at` under the pointer, which selects the object, or a press inside the selection's highlight (text, a table).
//
// Everything a board keeps is on its own context (`ctx.dragout`): two boards mounted at once never share a drag. Only the engine's
// pointerOptions.textDrag is global, and it finds the board of the press from the focused document.
import { toast } from 'sonner';
import { getState } from '../../app/store.js';
import { pointerOptions } from '../../engine/input/pointer.js';
import { leaveDocument } from '../focus.js';
import { CONNECTOR, EDITING, canEdit, dropTarget, moveAcross, moveIn, moveOut, moveWithin } from '../transfer.js';
import { registerTool } from './registry.js';

/** The object kinds `object.at` names that a press grabs (a text box keeps its press for its own text). */
const GRAB = new Set(['picture', 'shape', 'group', 'graphic']);
/** The board's items that may be dropped on a page: a connector stays, a group and a document are another drop's. */
const DROPPABLE = new Set(['picture', 'shape', 'ink', 'text']);
const OBJ_BYTES = 3; // U+FFFC in the engine's UTF-8 offsets
const PILL = 30; // characters of the text a drag's pill shows

/** The mounted boards' contexts. */
const boards = new Set();
const held = { space: false }; // Figma's L5: Space keeps a drop free

/** What the overlay draws, as an observable: `{kind, box, label, pointer, over, copy}` (DragGhost.jsx), or null. World points. */
function makeState() {
  let shown = null;
  let version = 0;
  const subs = new Set();
  return {
    get current() {
      return shown;
    },
    set(next) {
      shown = next;
      version++;
      for (const fn of [...subs]) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    version: () => version,
  };
}

/** The board's own state: its overlay's, the pointer over its view (client px), a board drag's last frame `decision` and that
 * decision once the drop took it (`pending`), and whether this tool set the view's cursor to the plus. */
const own = (ctx) => (ctx.dragout ??= { state: makeState(), last: { x: 0, y: 0 }, decision: null, pending: null, copyCursor: false });

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sourceOf = (ctx, client) => ctx.store.live().find((it) => it.type === 'doc' && !it.gone && it.draft === client.id) ?? null;

/** The rect holding `rects` ([{x, y, w, h}]), or null. */
function union(rects) {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/** Runs `fn` as the only transfer: after any open text edit has ended and any item session call has finished. The tool file of
 * text loads here, as it registers itself and must keep its place in the board's order. */
async function exclusive(ctx, fn) {
  const { endEdit, queued } = await import('./text.js');
  return queued(async () => {
    await endEdit(ctx).catch(() => {});
    ctx.cutDone = false;
    return fn();
  });
}

/** The plus cursor while Alt is held over a drop, and the view's own again after. */
function cursor(ctx, copy) {
  const mine = own(ctx);
  const root = ctx.vp?.root;
  if (!root || copy === mine.copyCursor) return;
  mine.copyCursor = copy;
  root.style.cursor = copy ? 'copy' : '';
}

/** A move that threw: nothing was lost before the page lost its content, and after it Ctrl+Z brings the content back. */
const failed = (ctx, e) => {
  console.warn('The move did not finish', e);
  toast(ctx.cutDone ? 'The move did not finish. Ctrl+Z puts it back.' : 'The move did not finish, and nothing was lost.');
};

/** The drop of a drag out of `client`'s page: `g` is the drag, `world` the pointer, `target` what it was over. */
async function dropOut(ctx, g, world, target, copy) {
  const { client } = g;
  const grab = g.grab;
  if (g.source && !canEdit(g.source)) return void toast(EDITING);
  if (target.kind === 'locked') return void toast(EDITING);
  if (target.kind === 'page') {
    const item = ctx.store.get(target.doc);
    const to = item ? ctx.instances?.clientOf(item.draft) : null;
    if (!to) return void toast('That document is not open yet.');
    if (!canEdit(item)) return void toast(EDITING);
    const hit = { page: target.page, x: target.x, y: target.y, at: { x: target.x - grab.x, y: target.y - grab.y } };
    if (to === client) await moveWithin(ctx, client, hit, { copy, object: g.armed.kind === 'object' ? g.armed.object : null });
    else await moveAcross(ctx, client, to, hit, { copy });
    return;
  }
  if (target.kind === 'text' && g.armed.kind === 'selection') {
    await moveOut(ctx, client, null, { copy, into: target.id });
    return;
  }
  const id = await moveOut(ctx, client, { x: world.x - grab.x, y: world.y - grab.y }, { copy });
  // The item is the board's to hold: the board takes the focus back with it selected.
  if (id && !copy) leaveDocument(ctx.api);
}

/** The drag of a selection or an object out of the focused document `client`, from its armed press. */
function dragOf(ctx, client, armed) {
  const vp = ctx.vp;
  const state = own(ctx).state;
  const source = sourceOf(ctx, client);
  const rects = armed.kind === 'object' ? [armed.object] : (ctx.input?.input?.snapshot?.()?.rects ?? []).filter((r) => r.page === armed.at.page);
  const box = union(rects) ?? { x: armed.at.x, y: armed.at.y, w: 0, h: 0 };
  const g = { client, armed, source, grab: { x: armed.at.x - box.x, y: armed.at.y - box.y }, box, label: null, cancelled: false, last: null };
  const win = vp.root.ownerDocument?.defaultView ?? globalThis;

  const aim = (ev) => {
    const world = vp.fromClient(ev.clientX, ev.clientY).world;
    return { world, target: dropTarget(ctx, world, { space: held.space, start: { doc: source?.id, page: armed.at.page } }) };
  };
  const draw = (ev) => {
    const { world, target } = aim(ev);
    const text = armed.kind === 'selection' && g.label;
    const over = target.kind === 'page' && !target.own ? ctx.instances?.rectsFor(ctx.store.get(target.doc))?.[target.page] ?? null : null;
    state.set({ kind: 'drag', copy: ev.altKey, pointer: world, over,
      label: text || null, box: text ? null : { x: world.x - g.grab.x, y: world.y - g.grab.y, w: box.w, h: box.h } });
    cursor(ctx, !!ev.altKey);
  };
  const end = () => {
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('keyup', onKey, true);
    offView();
    state.set(null);
    cursor(ctx, false);
  };
  const cancel = () => {
    g.cancelled = true;
    end();
  };
  // While the drag is live Space is the drop's (it keeps the drop free), never the page's: the page would type it over the selection,
  // and what is copied is what the selection is then. Esc cancels.
  function onKey(e) {
    if (e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
    } else if (e.code === 'Escape' && e.type === 'keydown') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('keyup', onKey, true);
  // The view panning or zooming under a still pointer puts the pointer on other world points: the ghost and the page's outline are
  // drawn again from where the pointer is. A zoom gesture in flight draws the world plane scaled already (planeMap), so it waits.
  const offView = vp.watch(() => {
    if (g.last && !g.cancelled && !vp.gestureTransform()) draw(g.last);
  });
  // A text drag's pill shows its first words.
  if (armed.kind === 'selection') {
    client.selection().then((sel) => client.text(sel.anchor, sel.head)).then((text) => {
      const line = String(text ?? '').replace(/\s+/g, ' ').trim();
      g.label = line ? (line.length > PILL ? `${line.slice(0, PILL)}...` : line) : '';
      if (g.last && !g.cancelled) draw(g.last);
    }, () => {});
  }
  return {
    move(ev) {
      if (g.cancelled) return;
      g.last = ev;
      draw(ev);
    },
    up(ev) {
      if (g.cancelled) return;
      // A release outside the view (the ribbon, the sidebar, beyond the window) cancels, as Figma's does.
      const r = vp.root.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return cancel();
      const { world, target } = aim(ev);
      const copy = !!ev.altKey;
      end();
      exclusive(ctx, () => dropOut(ctx, g, world, target, copy)).catch((e) => failed(ctx, e));
    },
    cancel,
  };
}

/** The board a press on `client` belongs to: the one whose focused document it is. */
const boardOf = (client) => {
  const focus = getState().boardFocus;
  if (focus?.kind !== 'document' || focus.session !== client) return null;
  return [...boards].find((ctx) => ctx.instances?.clientOf(client.id) === client) ?? null;
};

/** What the engine's pointer asks of a press (pointerOptions.textDrag): arm it only on the focused document of a board. */
const textDrag = {
  async press(client, at, pos) {
    const ctx = boardOf(client);
    if (!ctx || !at) return null;
    // A picture, shape or chart under the press is taken as the selection; it waits to be dragged.
    const o = (await client.query('object.at', { page: at.page, x: at.x, y: at.y }).catch(() => null))?.value;
    if (o && GRAB.has(o.kind)) {
      await client.exec('select.range', { anchor: o.pos, focus: { ...o.pos, off: o.pos.off + OBJ_BYTES } });
      return { kind: 'object', object: o, at, ctx };
    }
    // Text or a table already selected: a press inside its highlight.
    const sel = await client.selection().catch(() => null);
    if (!sel || same(sel.anchor, sel.head) || (sel.ranges ?? 1) > 1) return null;
    const rects = ctx.input?.input?.snapshot?.()?.rects ?? [];
    const inside = rects.some((r) => r.page === at.page && at.x >= r.x && at.x <= r.x + r.w && at.y >= r.y && at.y <= r.y + r.h);
    return inside ? { kind: 'selection', at, ctx } : null;
  },
  begin({ client, armed }) {
    return armed.ctx?.vp ? dragOf(armed.ctx, client, armed) : null;
  },
};

/** Whether `ids` is one board item that a page can take. */
const droppable = (ctx, ids) => {
  const item = ids.length === 1 ? ctx.store.get(ids[0]) : null;
  return !!item && !item.gone && !item.locked && DROPPABLE.has(item.type);
};

export default registerTool({
  id: 'dragout',

  mount(ctx) {
    boards.add(ctx);
    const mine = own(ctx);
    const root = ctx.vp?.root;
    const win = root?.ownerDocument?.defaultView ?? globalThis;
    const offs = [];
    const key = (e) => {
      if (e.code === 'Space') held.space = e.type === 'keydown';
    };
    const blur = () => {
      held.space = false;
    };
    const track = (e) => {
      mine.last.x = e.clientX;
      mine.last.y = e.clientY;
    };
    win.addEventListener('keydown', key, true);
    win.addEventListener('keyup', key, true);
    win.addEventListener('blur', blur);
    root?.addEventListener('pointermove', track, true);
    offs.push(() => {
      win.removeEventListener('keydown', key, true);
      win.removeEventListener('keyup', key, true);
      win.removeEventListener('blur', blur);
      root?.removeEventListener('pointermove', track, true);
    });
    pointerOptions.textDrag = textDrag;
    // The ghost is JSX: it loads when a board mounts, so node tests can still load this file.
    let dead = false;
    import('../DragGhost.jsx').then((mod) => {
      const overlays = ctx.vp?.overlays;
      if (dead || !overlays) return;
      overlays.register('board-dragout', mod.ghostFor(mine.state), { plane: 'screen' });
      offs.push(() => overlays.register('board-dragout', null));
    }, () => {});
    return () => {
      dead = true;
      boards.delete(ctx);
      // Another board's drag-out keeps working: the engine's hook goes only with the last board.
      if (!boards.size) {
        if (pointerOptions.textDrag === textDrag) pointerOptions.textDrag = null;
        held.space = false;
      }
      mine.decision = null;
      mine.pending = null;
      mine.state.set(null);
      for (const off of offs.splice(0)) off();
    };
  },

  // A board drag over a page: the page shows it would take the item, unless Space is held. Nothing in the delta changes.
  moveFrame(ctx, sel, _dx, _dy, e) {
    if (!Array.isArray(sel) || !ctx.vp) return null;
    const mine = own(ctx);
    const connector = sel.length === 1 && ctx.store.get(sel[0])?.type === 'connector';
    if (!droppable(ctx, sel) && !connector) {
      mine.decision = null;
      if (mine.state.current) mine.state.set(null);
      return null;
    }
    const world = ctx.vp.fromClient(mine.last.x, mine.last.y).world;
    const target = dropTarget(ctx, world, { space: held.space });
    const alt = !!(e?.alt ?? e?.altKey);
    mine.decision = { ids: [...sel], target, alt, connector };
    if (connector) {
      // A connector never goes into a page: it moves on the board and the drop says why it stayed.
      if (mine.state.current) mine.state.set(null);
      return null;
    }
    const over = target.kind === 'page' ? ctx.instances?.rectsFor(ctx.store.get(target.doc))?.[target.page] ?? null : null;
    mine.state.set(over ? { kind: 'item', copy: alt, pointer: world, over, label: null, box: null } : null);
    cursor(ctx, !!over && alt);
    return null;
  },

  // The drop of that drag: on a page it is not a move on the board at all (an empty answer writes nothing), and `moved` places it. A
  // connector, or an item over a locked document, moves on the board and the drop says why it did not go in.
  transform(ctx, ids, { kind } = {}) {
    const mine = own(ctx);
    const d = mine.decision;
    mine.decision = null;
    if (kind !== 'move' || !d || !same(d.ids, ids)) return null;
    if (d.connector && d.target.kind === 'page') toast(CONNECTOR);
    if (d.target.kind === 'locked' && droppable(ctx, ids)) toast(EDITING);
    if (d.connector || d.target.kind !== 'page' || !droppable(ctx, ids)) return null;
    mine.pending = d;
    return [];
  },

  moved(ctx, ids, fields) {
    const mine = own(ctx);
    const d = mine.pending;
    mine.pending = null;
    if (!d) return null;
    const id = ids[0];
    const at = fields?.[id];
    exclusive(ctx, async () => {
      const item = ctx.store.get(d.target.doc);
      const to = item ? ctx.instances?.clientOf(item.draft) : null;
      const rect = item ? ctx.instances?.rectsFor(item)?.[d.target.page] : null;
      if (!to || !rect) return void toast('That document is not open yet.');
      if (!canEdit(item)) return void toast(EDITING);
      const hit = { page: d.target.page, x: d.target.x, y: d.target.y, at: { x: (at?.x ?? ctx.store.get(id)?.x ?? 0) - rect.x, y: (at?.y ?? ctx.store.get(id)?.y ?? 0) - rect.y } };
      await moveIn(ctx, id, to, hit, { copy: d.alt });
    }).catch((e) => failed(ctx, e));
    return [];
  },

  // Every drag ends here, dropped or cancelled: the outline and the cursor go.
  end(ctx) {
    const mine = own(ctx);
    mine.decision = null;
    if (mine.state.current?.kind === 'item') mine.state.set(null);
    cursor(ctx, false);
  },
});
