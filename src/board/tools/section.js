// bd-section (docs/plans/board/briefs/bd-section.md, design section 6): a document's pages as a section. A press on a page
// selects the document and a drag moves the whole section; Ctrl+click picks one page and a drag moves that page, written as
// its own slots. The label and the flow arrows are screen-plane overlays, the layers panel's page rows the outline tree.
import { toast } from 'sonner';
import { DRAG_PX } from '../gestures.mjs';
import { applyOrder, moveOf } from '../reorder.js';
import { boundsOf, keysOf, keyedSlots, readingOrder, rectsOf } from '../sections.mjs';
import { registerTool } from './registry.js';

/** The board the overlays read (SectionLabels.jsx, FlowArrows.jsx), set while the tool is mounted. */
let live = null;
export const sectionBoard = { get ctx() { return live; } };

/** Where a drag has taken the pages, before the drop writes it: `{id, dx, dy, page}` in points, `page` null for the whole
 * section. Selection.jsx, SectionLabels, FlowArrows and PaperLayer add it to what they draw, so the outline, the label, the
 * arrows and the far zoom's paper follow the drag. */
const offset = { id: null, dx: 0, dy: 0, page: null };
let offsetVersion = 0;
const offsetSubs = new Set();
export const dragOffset = {
  get current() {
    return offset;
  },
  set(next) {
    Object.assign(offset, { id: null, dx: 0, dy: 0, page: null }, next ?? {});
    offsetVersion++;
    for (const fn of offsetSubs) fn();
  },
  subscribe(fn) {
    offsetSubs.add(fn);
    return () => offsetSubs.delete(fn);
  },
  version: () => offsetVersion,
};

let gesture = null;

const world = (ctx, e) => ctx.vp.fromClient(e.clientX, e.clientY).world;

const isPageKey = (key, id) => key.startsWith(`${id}:`) && /^\d+$/.test(key.slice(id.length + 1));

/** The placement keys of `item`'s section and pages, for a drag's nudge. */
function keysFor(ctx, id) {
  return (ctx.vp?.placements ?? []).filter((p) => p.key === `sec:${id}` || isPageKey(p.key, id)).map((p) => p.key);
}

/** One step for a section's move: its point, which every stored slot is relative to. */
function moveSection(ctx, g) {
  const item = ctx.store.get(g.id);
  if (!item || item.gone) return;
  ctx.store.change('Move document', (tx) => tx.patch(item.id, { x: (item.x ?? 0) + g.dx, y: (item.y ?? 0) + g.dy }));
}

/** The move in the document a drop asks of the dragged page, or null (bd-pagemove): the drop changed the reading order, and the
 * page now reads in front of a page other than the one after it in the document. No other page moves. */
const moveFor = (g) => (JSON.stringify(readingOrder(g.rects)) !== JSON.stringify(readingOrder(g.before)) ? moveOf(g.rects, g.page) : null);

/** One step for a page's move: every page's slot, keyed and relative to the pages' new box, which the item takes as its own
 * point and size (what boxOf, the marquee and zoom to selection read). */
function movePage(ctx, g) {
  const item = ctx.store.get(g.id);
  if (!item || item.gone) return;
  const box = boundsOf(g.rects);
  const slots = keyedSlots(g.rects, g.keys, box);
  ctx.store.change('Move page', (tx) => tx.patch(item.id, { x: box.x, y: box.y, w: box.w, h: box.h, slots }));
}

/** A drop that changes the reading order: the draft moves the page, and the slots follow its new keys (reorder.js). The page
 * stays where it was dropped until the draft answers; a refusal puts it back with the draft's line. */
function reorder(ctx, g, move) {
  const done = () => {
    if (gesture) return; // another press has the page layer now
    ctx.vp?.nudge(null);
    dragOffset.set(null);
  };
  const item = ctx.store.get(g.id);
  if (!item || item.gone) return done();
  applyOrder(ctx, item, move, g.rects)
    .catch((e) => toast(e?.message || 'The pages could not be moved.'))
    .finally(done);
}

export default registerTool({
  id: 'section',

  mount(ctx) {
    live = ctx;
    let dead = false;
    const offs = [];
    // The overlays are JSX, so they load when a board mounts and node tests can still load this file. The specifiers are
    // literals: esbuild leaves a dynamic import of a variable as a runtime one the bundle cannot find.
    const add = (pending, id, field) => pending.then((mod) => {
      const overlays = ctx.vp?.overlays;
      if (dead || !overlays) return;
      overlays.register(id, mod[field], { plane: 'screen' });
      offs.push(() => overlays.register(id, null));
    }, () => {});
    add(import('../SectionLabels.jsx'), 'board-section-labels', 'SectionLabels');
    add(import('../FlowArrows.jsx'), 'board-section-arrows', 'FlowArrows');
    return () => {
      dead = true;
      for (const off of offs.splice(0)) off();
      gesture = null;
      dragOffset.set(null);
      if (live === ctx) live = null;
    };
  },

  // A page of a document: Ctrl picks that page, a plain press the document. Shift, and a press on a document already part of
  // a several-item selection, are pointer.js's own item path (Shift adds, a drag moves the selection). The drag otherwise is
  // this tool's, since pointer.js would move the item's own box, not the section's pages.
  down(ctx, hit, e) {
    if (hit?.kind !== 'page') return false;
    const item = ctx.store.get(hit.id);
    const pages = ctx.instances?.pagesOf(hit.id) ?? [];
    if (!item || item.gone || !pages.length) return false;
    const deep = e.ctrlKey || e.metaKey;
    if (e.shiftKey) return false;
    if (!deep && ctx.selection.ids.length > 1 && ctx.selection.has(item.id)) return false;
    const before = rectsOf(item, pages);
    ctx.selection.set([item.id]);
    if (deep) ctx.selection.setPage({ id: item.id, page: hit.page });
    gesture = { kind: deep ? 'page' : 'section', id: item.id, world0: world(ctx, e), x0: e.clientX, y0: e.clientY,
      page: hit.page, before, rects: before.map((r) => ({ ...r })), keys: keysOf(pages), dx: 0, dy: 0, moved: false };
    return true;
  },

  move(ctx, e) {
    if (!gesture) return;
    const g = gesture;
    const now = world(ctx, e);
    g.dx = now.x - g.world0.x;
    g.dy = now.y - g.world0.y;
    g.moved ||= Math.hypot(e.clientX - g.x0, e.clientY - g.y0) >= DRAG_PX;
    const page = g.kind === 'page' ? g.page : null;
    if (g.kind === 'page') {
      const r = g.rects[g.page];
      g.rects[g.page] = { ...r, x: g.before[g.page].x + g.dx, y: g.before[g.page].y + g.dy };
      ctx.vp?.nudge([`${g.id}:${g.page}`], g.dx, g.dy);
    } else {
      ctx.vp?.nudge(keysFor(ctx, g.id), g.dx, g.dy);
    }
    dragOffset.set({ id: g.id, dx: g.dx, dy: g.dy, page });
  },

  // `e` is the press's event, so the gesture's own last frame says whether it moved.
  up(ctx) {
    const g = gesture;
    gesture = null;
    if (!g) return false;
    const move = g.moved && g.kind === 'page' ? moveFor(g) : null;
    if (!move) {
      ctx.vp?.nudge(null);
      dragOffset.set(null);
    }
    if (g.moved) {
      if (g.kind === 'section') moveSection(ctx, g);
      else if (move) reorder(ctx, g, move);
      else movePage(ctx, g);
    }
    return true;
  },

  cancel(ctx) {
    if (!gesture) return;
    gesture = null;
    ctx.vp?.nudge(null);
    dragOffset.set(null);
  },

  // Delete on a selected document removes the item from the board: the draft, and its pages, stay where they are.
  keydown(ctx, e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.code !== 'Delete' && e.code !== 'Backspace') return false;
    const items = ctx.selection.ids.map((id) => ctx.store.get(id)).filter((it) => it && !it.gone);
    if (!items.length || items.some((it) => it.type !== 'doc')) return false;
    ctx.store.change('Remove document', (tx) => { for (const it of items) tx.remove(it.id); });
    ctx.selection.clear();
    toast('The draft is still in your drafts.');
    return true;
  },
});
