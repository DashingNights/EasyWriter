// bd-instance fills this tool (docs/plans/board/design.md section 5): a draft placed on a board as a live document. The item
// type 'doc' places its draft's pages; the pointer picks the instance over its pages (so a drag moves it and Delete removes it);
// a draft dragged from the sidebar drops at the pointer; and the board's save context gets that draft's record save.
import { getState } from '../../app/store.js';
import { boxOf } from '../gestures.mjs';
import { registerType } from '../surfaces.mjs';
import { createInstances, placeDraft } from '../instance.js';
import { pageAt } from '../sections.mjs';
import { registerTool } from './registry.js';

// The doc item's placements come from the instances the mount makes: a board without them shows nothing for a doc.
registerType('doc', { paints: false, placements: (item, ctx) => ctx.instances?.placementsFor(item) ?? [] });

/** The draft a drag of a sidebar row carries (`text/x-ew-draft`), or null. */
const dragged = (e) => e?.dataTransfer?.getData('text/x-ew-draft') || null;

/** Whether an item painted after `index` covers `world`: it takes the press, not the document under it. */
function above(items, index, world, store) {
  for (let i = index + 1; i < items.length; i++) {
    const item = items[i];
    if (item.gone || item.hidden || item.locked || item.type === 'doc' || item.type === 'group') continue;
    const b = boxOf(item, store);
    if (world.x >= b.x && world.x <= b.x + b.w && world.y >= b.y && world.y <= b.y + b.h) return true;
  }
  return false;
}

export default registerTool({
  id: 'instance',

  mount(ctx) {
    const mine = createInstances({ store: ctx.store, vp: () => ctx.vp, journal: ctx.journal, onPages: () => ctx.place?.() });
    ctx.instances = mine;
    ctx.api.instances = mine; // placeDraft reaches the board's sessions through its api
    // The journal writes a document part through this: that draft's record, before the board takes anything away (saveOnce).
    ctx.saveDoc = (session) => mine.save(session);
    mine.sync();
    return () => {
      if (ctx.instances === mine) {
        ctx.instances = null;
        ctx.saveDoc = null;
        if (ctx.api?.instances === mine) ctx.api.instances = null;
      }
      mine.destroy();
    };
  },

  methods: {
    /** PlaneBoard.placeDraft: arg {draftId, at} places that draft at the world point; with no draftId, the dialog picks one. */
    placeDraft(arg) {
      return openPlaceDraft(this, arg);
    },
  },

  // A press over an instance's page picks that page (the section tool's gesture: it selects the document, or the page with
  // Ctrl, and a drag moves the one or the other). An armed tool draws over the page (it picks first otherwise), and while a
  // session has the keys (a focused document, a text being typed) the press is that session's. The boxes are the pages' own,
  // so far zoom (which places no page) still picks; an instance that cannot open is picked by its grey box.
  pick(ctx, world) {
    if (ctx.api?.editing || ctx.api?.mode) return null;
    const items = ctx.store.live();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type !== 'doc' || item.gone || item.hidden || item.locked) continue;
      const boxes = ctx.instances?.boxesFor(item) ?? [];
      const on = boxes.some((b) => world.x >= b.x && world.x <= b.x + b.w && world.y >= b.y && world.y <= b.y + b.h);
      if (!on || above(items, i, world, ctx.store)) continue;
      const page = ctx.instances?.whyOf(item.id) ? null : pageAt(ctx.instances?.rectsFor(item) ?? [], world);
      return page == null ? { kind: 'item', id: item.id } : { kind: 'page', id: item.id, page };
    }
    return null;
  },

  // A draft dragged from the sidebar (only while a board is open) is placed where it was dropped.
  drop(ctx, e) {
    const id = dragged(e);
    const v = ctx.vp;
    if (!id || !v) return false;
    const entry = (getState().drafts ?? []).find((d) => d.id === id);
    if (!entry) return false;
    placeDraft(ctx.api, entry, v.fromClient(e.clientX, e.clientY).world)
      .catch((err) => console.warn('The draft was not placed', err));
    return true;
  },
});

/** The dialog's choice, else the argument's draft: the id to place. */
async function openPlaceDraft(board, arg) {
  if (arg?.draftId) {
    const entry = (getState().drafts ?? []).find((d) => d.id === arg.draftId);
    return entry ? placeDraft(board, entry, arg.at) : false;
  }
  const { chooseDraft } = await import('../PlaceDraft.jsx');
  const chosen = await chooseDraft(board);
  if (!chosen) return false;
  const entry = (getState().drafts ?? []).find((d) => d.id === chosen);
  return entry ? placeDraft(board, entry, arg?.at) : false;
}
