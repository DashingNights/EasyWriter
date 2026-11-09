// A draft placed on a board as a live document (docs/plans/board/briefs/bd-instance.md, design section 5): each page is a
// placement of the draft's own engine session, so an edit anywhere repaints every board that shows it. Sessions start through
// assistant/sessions.js (pinSession) and are held while a page is near the view; the item's summary keeps its pages known while
// it has no session, so a closed draft keeps its place.
import { kOf } from '../engine/view/camera.mjs';
import { GAP, ROW, attention, footprint, freeSpot } from './place.mjs';
import { boundsOf, rectsOf, sectionRect, slotsOf } from './sections.mjs';

/** How many drafts a board keeps open at once (design section 5: about 1.5 s to reopen them, measured). */
export const MAX_LIVE = 24;
/** A page under this many CSS px wide draws as flat paper from PaperLayer, never as a tile: no stale picture at far zoom. */
export const PAPER_PX = 96;
/** How far from the view (view widths and heights, centre to centre) a page still wants its draft open. */
const REACH = 1.5;
/** How long the camera must be still before the open drafts are reviewed. */
const SETTLE_MS = 160;

// The app modules that need the window (a toast, a record save, a session) load when a board first needs them: the node tests
// load every board tool, and this module is one of their static imports.
let actionsModule = null;
const actions = () => (actionsModule ??= import('../app/actions.js'));
const sessions = () => import('../app/assistant/sessions.js');

/** The pages of a session's `pages()` answer (the array, or {pages}). */
const normalPages = (r) => (Array.isArray(r) ? r : r?.pages ?? []);

/** The page sizes a summary {count, w, h, keys} leaves: every page the same size, which is what the summary keeps, each with
 * the key its slot is stored under when the summary has one. */
function fromSummary(summary) {
  const n = Math.max(0, Math.floor(summary?.count ?? 0));
  if (!n || !(summary.w > 0) || !(summary.h > 0)) return [];
  const cols = Math.min(n, ROW);
  const rows = Math.ceil(n / ROW);
  const w = (summary.w - (cols - 1) * GAP) / cols;
  const h = (summary.h - (rows - 1) * GAP) / rows;
  if (!(w > 0 && h > 0)) return [];
  const keys = Array.isArray(summary.keys) && summary.keys.length === n ? summary.keys : null;
  return Array.from({ length: n }, (_, i) => (keys ? { w, h, first: keys[i] } : { w, h }));
}

/** Whether a box is within `n` view widths and heights of the view, centre to centre. */
const near = (x, y, w, h, view, n = REACH) => Math.abs(x + w / 2 - (view.x + view.w / 2)) <= n * view.w
  && Math.abs(y + h / 2 - (view.y + view.h / 2)) <= n * view.h;

/** The squared distance from a box's centre to the view's centre. */
const away = (x, y, w, h, view) => {
  const dx = x + w / 2 - (view.x + view.w / 2);
  const dy = y + h / 2 - (view.y + view.h / 2);
  return dx * dx + dy * dy;
};

/** Why a draft cannot open, from the session's failure: a deleted record says so in the words the design gives it. */
const whyOf = (e) => (e?.code === 'not_found' ? 'This draft was deleted.' : e?.message || String(e));

/**
 * The board's live documents over `store`: each doc item's session, its pages, and the placements its pages make. `vp` is the
 * viewport (or a getter, while the area mounts it); `journal` hears each session (its undo goes through the board's);
 * `onPages()` re-places the board when a draft's pages arrive or change.
 */
export function createInstances({ store, vp, journal, onPages }) {
  const viewAt = () => (typeof vp === 'function' ? vp() : vp);
  const live = new Map(); // draft id → {client, unpin, pages, off, offClosed, offWatch}
  const broken = new Map(); // item id → why its draft cannot show
  const tried = new Map(); // item id → the draft an open was attempted for (a broken one is not retried every settle)
  const attempts = new Map(); // item id → how many opens were tried (the harness sees a settle not asking again)
  let dead = false;
  let settled = 0;
  let chain = Promise.resolve();
  const offs = [];

  /** The pages of item `id` ([{w, h}]) from its session, else from its summary. */
  function pagesOf(id) {
    const item = store.get(id);
    const key = item?.type === 'doc' ? item.draft : id;
    const rec = live.get(key);
    if (rec?.pages?.length) return rec.pages;
    return fromSummary(item?.summary);
  }

  /** The session of `draft` (its draft id) while a page shows it, else null. */
  const clientOf = (draft) => live.get(draft)?.client ?? null;

  /** Why the instance of item `id` cannot show its draft, or null. */
  const whyOfItem = (id) => broken.get(id) ?? null;

  /** The placements of doc `item`: its section's fill over the box its pages take (grown by sections PAD), then one a page, at
   * the slots its keys name (the import grid with no slots). A page under PAPER_PX wide has none (PaperLayer draws it); a page
   * with no session yet is a plain paper slot; an instance that cannot open is one grey slot the board can still select and
   * delete. */
  function placementsFor(item) {
    const v = viewAt();
    const k = v ? kOf(v.camera.zoom) : 1;
    const x = item.x ?? 0;
    const y = item.y ?? 0;
    if (broken.has(item.id)) {
      return [{ key: `${item.id}:broken`, session: null, surface: 0, x, y, w: item.w || 360, h: item.h || 240, plain: true,
        doc: item.id, broken: true }];
    }
    const pages = pagesOf(item.id);
    if (!pages.length) return [];
    const rects = rectsOf(item, pages);
    const box = sectionRect(rects);
    const client = clientOf(item.draft);
    // The fill is a slot of its own only while every page has a placement: at far zoom PaperLayer draws it under the paper.
    const far = pages.some((page) => page.w * k < PAPER_PX);
    const out = far ? [] : [{ key: `sec:${item.id}`, session: null, surface: -1, x: box.x, y: box.y, w: box.w, h: box.h,
      plain: true, paper: 'color-mix(in srgb, var(--muted) 35%, transparent)',
      slotStyle: { outline: '1px solid var(--border)', borderRadius: 4 } }];
    rects.forEach((slot, i) => {
      const page = pages[i];
      if (page.w * k < PAPER_PX) return; // flat paper under every item, from PaperLayer
      if (!client) {
        out.push({ key: `${item.id}:${i}`, session: null, surface: i, x: slot.x, y: slot.y, w: page.w, h: page.h,
          paper: page.paper ?? '#ffffff', plain: true, doc: item.id });
        return;
      }
      // The worker sends no bitmap for a tile with nothing on it, so the slot's paper is what shows there.
      out.push({ key: `${item.id}:${i}`, session: item.draft, surface: i, x: slot.x, y: slot.y, w: page.w, h: page.h,
        paper: page.paper ?? '#ffffff', doc: item.id });
    });
    return out;
  }

  /** The pages' boxes of `item` whatever the zoom: a press picks by these, since far zoom places no page of its own
   * (PAPER_PX). Empty for an instance that cannot open: its grey slot is the item's own box. */
  function rectsFor(item) {
    const pages = pagesOf(item.id);
    return pages.length ? rectsOf(item, pages) : [];
  }

  /** The world boxes of `item`'s pages (or of its grey section). */
  function boxesFor(item) {
    const x = item.x ?? 0;
    const y = item.y ?? 0;
    if (broken.has(item.id)) return [{ x, y, w: item.w || 360, h: item.h || 240 }];
    const rects = rectsFor(item);
    return rects.length ? rects : [{ x, y, w: item.w ?? 0, h: item.h ?? 0 }];
  }

  /** Notes `pages` on every item that shows draft `draft`: its summary (with the pages' keys, so a closed draft keeps its
   * slots) and box, silently (no undo step) and only when changed. */
  function noteFor(draft, pages) {
    if (!pages?.length) return;
    const size = footprint(pages);
    // A page with no key (a summary read back before keys were kept) leaves the keys out: the closed draft falls back to the
    // import grid, never to a chain of pages at wrong slots.
    const keys = pages.every((page) => page.first != null) ? pages.map((page) => page.first) : null;
    const summary = { count: pages.length, w: size.w, h: size.h, ...(keys ? { keys } : {}) };
    for (const item of store.live()) {
      if (item.type !== 'doc' || item.draft !== draft) continue;
      const sameSummary = item.summary?.count === summary.count && item.summary?.w === summary.w && item.summary?.h === summary.h
        && JSON.stringify(item.summary?.keys ?? null) === JSON.stringify(summary.keys ?? null);
      // A section with its own slots is as big as its pages' box, not the import grid's footprint.
      const box = item.slots ? boundsOf(rectsOf(item, pages)) : size;
      const sameBox = item.w === box.w && item.h === box.h;
      if (sameSummary && sameBox) continue;
      store.change('Pages', (tx) => {
        if (!sameSummary) tx.set(item.id, 'summary', summary);
        if (!sameBox) {
          tx.set(item.id, 'w', box.w);
          tx.set(item.id, 'h', box.h);
        }
      }, { silent: true });
    }
  }

  /** Takes the open session of `draft` under this board: its pages (`pages`, when the caller has read them, so the item never
   * shows summary pages it knows better than), its undo (the journal) and the save its `changed` makes. `unpin` is
   * pinSession's, called when the board lets the session go. */
  function adopt(draft, client, unpin, pages = []) {
    const had = live.get(draft);
    if (had) {
      unpin?.(); // already here: one pin is enough
      return had;
    }
    const rec = { client, unpin, pages, off: null, offClosed: null, offWatch: null };
    live.set(draft, rec);
    if (pages.length) noteFor(draft, pages);
    // An adopted session is an attempt made: a draft deleted right after is not asked for again on the next settle.
    for (const item of store.live()) if (item.type === 'doc' && item.draft === draft) tried.set(item.id, draft);
    rec.offWatch = journal?.watch(client) ?? null;
    rec.off = client.on('layout', (e) => {
      if (e?.pages) rec.pages = e.pages;
      else client.pages().then((r) => { rec.pages = normalPages(r); noteFor(draft, rec.pages); onPages?.(); }, () => {});
      noteFor(draft, rec.pages);
      onPages?.();
    });
    // The session ended: a draft deleted from the sidebar shows its grey section instead of stale tiles. The record is read a
    // moment later, since a delete removes its file after the session ended; a hand-over finds it still there.
    rec.offClosed = client.on('closed', () => {
      if (dead || live.get(draft) !== rec) return;
      live.delete(draft);
      onPages?.();
      setTimeout(() => wentGone(draft), 400);
    });
    return rec;
  }

  /** Session `draft` closed: its record gone marks every item naming it, else the board opens it again if it still wants it. */
  async function wentGone(draft) {
    if (dead || live.has(draft)) return;
    const record = await window.api.drafts.load(draft).catch(() => null);
    if (dead || live.has(draft)) return;
    if (record) {
      // A delete still under way leaves the record a moment longer: the next open must try again and find it gone.
      for (const item of store.live()) if (item.type === 'doc' && item.draft === draft) tried.delete(item.id);
      sync();
      return;
    }
    for (const item of store.live()) if (item.type === 'doc' && item.draft === draft) broken.set(item.id, 'This draft was deleted.');
    onPages?.();
  }

  /** Lets a record go: its listeners, its pin and its place among the live sessions. */
  function release(rec, draft) {
    rec.off?.();
    rec.offClosed?.();
    rec.offWatch?.();
    live.delete(draft);
    rec.unpin?.();
  }

  /** Opens the session of `item`'s draft, through the promise chain so the board opens one at a time. A draft that could not
   * open is not asked again until the item names another draft (or the board opens again). */
  async function open(item) {
    const draft = item.draft;
    if (live.has(draft) || tried.get(item.id) === draft) return;
    tried.set(item.id, draft);
    attempts.set(item.id, (attempts.get(item.id) ?? 0) + 1);
    let unpin;
    let client;
    try {
      const S = await sessions();
      unpin = await S.pinSession(draft);
      if (dead) {
        unpin?.(); // the board went while the session opened
        return;
      }
      client = S.backgroundClient(draft);
    } catch (e) {
      if (dead) return;
      broken.set(item.id, whyOf(e));
      onPages?.();
      return;
    }
    if (!client) {
      unpin?.();
      broken.set(item.id, 'This draft is open in its own editor.');
      onPages?.();
      return;
    }
    broken.delete(item.id);
    const rec = adopt(draft, client, unpin);
    await client.quiet(false).catch(() => {});
    const first = dead ? null : await client.pages().catch(() => null);
    if (dead) {
      release(rec, draft);
      return;
    }
    if (first) rec.pages = normalPages(first);
    noteFor(draft, rec.pages);
    onPages?.();
  }

  /** Closes the session of `draft` once it is saved (not dirty): its undo history is saved with its record and comes back when
   * it reopens, whatever steps it has, so a session out of the view or over the cap keeps no memory. The board journal drops
   * its document parts. */
  async function close(draft) {
    const rec = live.get(draft);
    if (!rec) return;
    let S;
    let saved;
    try {
      S = await sessions();
      saved = await S.saveSession(draft);
    } catch {
      saved = false;
    }
    if (!saved || dead || live.get(draft) !== rec) return; // an unsaved edit keeps it: nothing closes with a write not made
    rec.off?.();
    rec.offClosed?.();
    rec.offWatch?.();
    live.delete(draft);
    for (const item of store.live()) if (item.type === 'doc' && item.draft === draft) tried.delete(item.id); // opens again in view
    journal?.forget(draft);
    try {
      await S.closeSession(draft); // saves (nothing left) and lets the engine session go
    } catch {}
    rec.unpin?.();
    onPages?.();
  }

  /** Writes draft `session`'s record (the journal's ctx.saveDoc): the saveOnce path an undo goes through before the board
   * takes anything away. */
  async function save(session) {
    const S = await sessions();
    const draft = S.backgroundDraft(session);
    const client = clientOf(session);
    if (!draft || !client) return false;
    const { saveCanvasOther } = await actions();
    return saveCanvasOther(draft, client);
  }

  /** Reviews the open drafts for the camera now: lets go of those out of the view or past the cap (longest first, so the few
   * nearest the view stay) and opens those wanted, nearest first, at most MAX_LIVE open at any moment. */
  async function tick() {
    if (dead) return;
    const v = viewAt();
    if (!v) return;
    const { findDraft } = await actions();
    const view = v.view();
    const wanted = [];
    for (const item of store.live()) {
      if (item.type !== 'doc' || item.gone || item.hidden) continue;
      // A uid found under another id (another machine, a later server): the item follows its draft's id here.
      const entry = findDraft(item);
      if (entry && entry.id !== item.draft) {
        store.change('Move draft', (tx) => tx.set(item.id, 'draft', entry.id), { silent: true });
        tried.delete(item.id);
      }
      const now = store.get(item.id);
      const pages = now ? pagesOf(now.id) : [];
      if (!pages.length) continue;
      const slots = slotsOf(now, pages);
      if (!slots.some((slot, i) => near(slot.x, slot.y, pages[i].w, pages[i].h, view))) continue;
      wanted.push({ item: now, d: away(now.x ?? 0, now.y ?? 0, now.w ?? 0, now.h ?? 0, view) });
    }
    wanted.sort((a, b) => a.d - b.d);
    const keep = wanted.slice(0, MAX_LIVE);
    const kept = new Set(keep.map((w) => w.item.draft));
    // Closing first keeps the cap while the next ones open.
    for (const draft of [...live.keys()]) {
      if (dead) return;
      if (!kept.has(draft)) await close(draft);
    }
    for (const w of keep) {
      if (dead) return;
      if (live.size >= MAX_LIVE) break;
      if (!live.has(w.item.draft)) await open(w.item);
    }
  }

  const sync = () => {
    if (dead) return;
    chain = chain.then(tick, tick);
  };

  // A page draws as flat paper under PAPER_PX wide and as a tile above it, so a zoom that carries any page across that line
  // places the board's pages again. Other camera moves change no placement: a pan stays a compositor transform.
  let lastK = null;
  const repaper = () => {
    const v = viewAt();
    if (!v) return;
    const k = kOf(v.camera.zoom);
    const was = lastK;
    lastK = k;
    if (was == null || was === k) return;
    for (const item of store.live()) {
      if (item.type !== 'doc') continue;
      for (const page of pagesOf(item.id)) {
        if ((page.w * was < PAPER_PX) === (page.w * k < PAPER_PX)) continue;
        onPages?.();
        return;
      }
    }
  };

  const settle = () => {
    repaper();
    clearTimeout(settled);
    settled = setTimeout(sync, SETTLE_MS);
  };

  const v = viewAt();
  if (v) {
    lastK = kOf(v.camera.zoom); // the zoom the board's first placements are made at
    offs.push(v.subscribe('camera', settle), v.subscribe('placements', settle));
  }

  return {
    sync,
    pagesOf,
    clientOf,
    placementsFor,
    rectsFor,
    boxesFor,
    whyOf: whyOfItem,
    adopt,
    save,
    /** How many opens item `id` was tried for (a harness reads it). */
    attemptsOf: (id) => attempts.get(id) ?? 0,
    /** The open sessions now, for the design's measure (a harness reads it) → {live, open, broken, view}. */
    stats: () => ({ live: live.size, open: [...live.keys()], broken: broken.size, view: !!v }),
    destroy() {
      dead = true;
      clearTimeout(settled);
      for (const off of offs.splice(0)) off();
      for (const [draft, rec] of [...live]) release(rec, draft);
      live.clear();
      broken.clear();
      tried.clear();
    },
  };
}

/**
 * Puts `draft` (a drafts-list entry) on the board `api` at world point `at`: refuses the board itself and whiteboards, and a
 * draft already on this board, each with its toast; else pins its session, reads its pages, finds the nearest free area to the
 * attention point (the pointer when it is in the view, else its centre), makes the doc item as one `Place draft` step, fits the
 * view to it when it lands partly off, and gives the session to the board (its undo goes through the journal).
 */
export async function placeDraft(api, draft, at) {
  if (!api || api.destroyed || !api.store) return false;
  const { toast } = await actions();
  if (api.destroyed) return false;
  const board = api.draft;
  if (!draft || draft.id === board?.id || draft.format === 'board') {
    toast('A whiteboard cannot hold a whiteboard yet.', true);
    return false;
  }
  if (!draft.engine) {
    toast('This draft opens in its own editor only.', true);
    return false;
  }
  const store = api.store;
  if (store.live().some((item) => item.type === 'doc' && item.draft === draft.id && !item.gone)) {
    toast('This draft is on this whiteboard already.', true);
    return false;
  }
  const vp = api.vp;
  if (!vp) return false;
  let unpin;
  let client;
  let S;
  try {
    S = await sessions();
    unpin = await S.pinSession(draft.id);
    if (api.destroyed) {
      unpin?.(); // the board went while the session opened
      return false;
    }
    client = S.backgroundClient(draft.id);
  } catch (e) {
    if (api.destroyed) return false;
    toast(whyOf(e), true);
    return false;
  }
  if (!client) {
    unpin?.();
    toast('That draft is open in its own editor, so it cannot be placed here yet.', true);
    return false;
  }
  await client.quiet(false).catch(() => {});
  const pages = normalPages(api.destroyed ? [] : await client.pages().catch(() => null));
  if (api.destroyed) {
    unpin?.();
    return false;
  }
  if (!pages.length) {
    unpin?.();
    toast('That draft has no pages to place.', true);
    return false;
  }
  // The reference a board keeps: the entry's, else the record's, else a new one written by the session's next real save (never
  // a save of its own, for a draft saved before uid existed).
  let uid = draft.uid;
  if (uid == null) {
    uid = (await window.api.drafts.load(draft.id).catch(() => null))?.uid ?? null;
    if (uid == null) {
      uid = crypto.randomUUID();
      const record = S.backgroundDraft(draft.id);
      if (record) record.uid = uid;
    }
  }
  if (api.destroyed) {
    unpin?.();
    return false;
  }
  const size = footprint(pages);
  const taken = store.live().filter((item) => !item.gone && Number.isFinite(item.x) && Number.isFinite(item.y)
    && Number.isFinite(item.w) && Number.isFinite(item.h)).map((item) => ({ x: item.x, y: item.y, w: item.w, h: item.h }));
  // A drop lands where it was dropped: its first page's top left at the pointer, over whatever is there. With no pointer (the rail,
  // tool search) it takes the free spot nearest the view's centre.
  const spot = at ? { x: at.x, y: at.y } : freeSpot(size, taken, attention(null, vp.view()));
  let id = null;
  store.change('Place draft', (tx) => {
    id = tx.create({ type: 'doc', draft: draft.id, uid, at: [null, store.orderKey(null, store.children(null).length, tx)],
      x: spot.x, y: spot.y, w: size.w, h: size.h, slots: null, rowLen: ROW,
      summary: { count: pages.length, w: size.w, h: size.h } });
  });
  // The session is this board's now: its pages show at once and its undo goes through the journal.
  api.instances?.adopt(draft.id, client, unpin, pages);
  api.instances?.sync();
  // Placing never moves the view (the user's rule, 2026-11-03): only a double-click on a document homes in on it.
  return !!id;
}
