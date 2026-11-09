// A document on a board taking the focus (docs/plans/board/briefs/bd-hud.md, design section 8): a double-click on a page that
// fills a quarter of the view homes the page to the view's centre and gives its draft the keys, as a Documents view does; under
// a quarter it homes and selects without the focus. Enter is the keyboard path, Esc or a press elsewhere leaves, and the HUD
// field follows the most verbose format among the focused one and the documents in view. The entry is cancellable until it has
// taken the keys, and the chrome shows first, so the homing lands the point at the centre of the view the reader sees.
import { getState, setState } from '../app/store.js';
import { FORMATS } from '../formats.mjs';
import { setPlaneBoard } from '../whiteboard.js';
import { QUARTER, coverage, hudOf, homeCamera, homePoint } from './hud.mjs';
import { rectsOf } from './sections.mjs';

/** The view as the camera rules read it: the world rect and the view's CSS px size. */
const viewOf = (vp) => ({ ...vp.view(), pxW: vp.size.w, pxH: vp.size.h });

/** The islands motion length in ms (0 when it is off), loaded where it plays so the node tests can import this module. */
const islandMs = () => import('../app/motion.js').then((m) => m.motion('islands'), () => 0);

/** Moves `vp` to camera `cam` over the islands motion. */
const home = (vp, cam) => islandMs().then((ms) => glide(vp, cam, ms));

/** The board's documents with every page's world rect → [{id, rects: [{x, y, w, h, page}]}]. */
function docsOf(api) {
  const out = [];
  for (const item of api.store?.live() ?? []) {
    if (item.type !== 'doc' || item.gone || item.hidden) continue;
    const pages = api.instances?.pagesOf(item.id) ?? [];
    if (!pages.length) continue;
    out.push({ id: item.id, rects: rectsOf(item, pages).map((r, page) => ({ ...r, page })) });
  }
  return out;
}

/** The format a placed draft has ('document' when the drafts list does not know it any more). */
function formatOf(api, id) {
  const item = api.store?.get(id);
  return (getState().drafts ?? []).find((d) => d.id === item?.draft)?.format ?? 'document';
}

/** The formats of the documents that count now (a quarter or more of the view). */
function inViewFormats(api) {
  const view = api.vp?.view();
  if (!view) return [];
  return docsOf(api).filter((d) => coverage(d.rects, view) >= QUARTER).map((d) => formatOf(api, d.id));
}

/** The format id the HUD follows: the focused document's, or null with none. */
const focusFormat = (s) => (s.boardFocus?.kind === 'document' ? s.boardFocus.format : null);

/** Recomputes the store's boardHud from the focus and the documents in view (a document scrolled into a quarter of the view
 * raises the ribbon over a post's HUD). */
export function refreshHud(api) {
  const s = getState();
  const next = hudOf(focusFormat(s), inViewFormats(api), FORMATS);
  if (s.boardHud !== next) setState({ boardHud: next });
}

/** Moves the camera to `to` over `ms`, easing both ways; 0 ms sets it at once. A cancelled entry stops the glide. */
function glide(vp, to, ms, alive = () => true) {
  if (!(ms > 0)) {
    vp.setCamera(to);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const from = vp.camera;
    const t0 = performance.now();
    const step = () => {
      if (!vp.root || !alive()) return resolve();
      const t = Math.min(1, (performance.now() - t0) / ms);
      const e = t * t * (3 - 2 * t);
      vp.setCamera({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e,
        zoom: from.zoom + (to.zoom - from.zoom) * e });
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/** Waits for `item`'s draft session while it opens: a broken draft, a closed board or a cancelled entry answers null at once. */
function waitClient(api, item, alive, ms = 10000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const look = () => {
      const client = api.instances?.clientOf?.(item.draft) ?? null;
      if (!alive() || client || api.destroyed || api.instances?.whyOf?.(item.id) || performance.now() - t0 > ms) resolve(client);
      else setTimeout(look, 80);
    };
    api.instances?.sync?.();
    look();
  });
}

/** The entry in hand (`{cancelled}`), cancelled by Esc, a press or another entry. */
let entry = null;

/** Cancels the entry in hand at once: its waits stop, the board takes the keys back, and a focus it had already set is left.
 * → whether one was running. */
export function cancelEntry(api) {
  const mine = entry;
  if (!mine) return false;
  mine.cancelled = true;
  entry = null;
  if (api) api.editing = false;
  if (getState().boardFocus?.kind === 'document' && !api?.destroyed) leaveDocument(api);
  return true;
}

/** Two frames on: the render and layout the entry's state change makes (the ribbon showing, a pane moving the view). */
const nextFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/**
 * Homes `point` (a world point on page `point.page` of item `itemId`) to the view's centre and gives the draft the keys, its
 * caret at the point. The chrome shows first, so the camera takes the view as it is once the ribbon is out; the draft's session
 * is waited for, and the whole entry stops when cancelled. → true when the focus was taken.
 */
export async function enterDocument(api, itemId, point) {
  const vp = api?.vp;
  const item = api?.store?.get(itemId);
  if (!vp || !item || point?.page == null) return false;
  const pages = api.instances?.pagesOf(itemId) ?? [];
  const rect = rectsOf(item, pages)[point.page];
  if (!pages[point.page] || !rect) return false;
  const mine = { cancelled: false };
  entry = mine;
  const alive = () => !mine.cancelled && entry === mine && !api.destroyed && !!api.vp;
  // The board keeps the keys until the session has them: a Backspace during the wait must not remove the document.
  api.editing = true;
  try {
    // A draft already open goes quiet, so its layout, not the camera, decides what the caret's place shows.
    const was = api.instances?.clientOf?.(item.draft) ?? null;
    if (was) await was.quiet(false).catch(() => {});
    const client = was ?? await waitClient(api, item, alive);
    if (!client || !alive()) return false;
    await client.quiet(false).catch(() => {});
    if (!alive()) return false;
    const format = formatOf(api, itemId);
    setState({ focusedSession: client, boardFocus: { kind: 'document', session: client, format },
      boardHud: hudOf(format, inViewFormats(api), FORMATS) });
    setPlaneBoard(null);
    await nextFrames();
    if (!alive()) return false;
    await islandMs().then((ms) => glide(vp, homeCamera(point, pages[point.page].w, viewOf(vp), vp.camera.zoom), ms, alive));
    if (!alive()) return false;
    const { pos } = (await client.hit(point.page, point.x - rect.x, point.y - rect.y).catch(() => null)) ?? {};
    if (!alive()) return false;
    vp.setFocus({ session: client.id, mode: 'text' });
    if (pos != null) await client.select(pos, pos).catch(() => {});
    vp.root?.focus?.({ preventScroll: true });
    return true;
  } finally {
    // A newer entry owns the flag and the focus fields; this one only takes back what is still its own.
    if (entry === mine) {
      entry = null;
      api.editing = false;
      if (mine.cancelled && !api.destroyed) leaveDocument(api);
    }
  }
}

/** Leaves the document's focus: the board's rail serves the board again and the document stays selected. */
export function leaveDocument(api) {
  if (getState().boardFocus?.kind !== 'document') return false;
  api?.vp?.setFocus({ session: null, mode: null });
  setState({ focusedSession: null, boardFocus: null, boardHud: null });
  setPlaneBoard(api);
  return true;
}

/** Whether world point `w` lies on one of the document `itemId`'s pages. */
function onPage(api, itemId, w) {
  if (!w) return false;
  const item = api.store?.get(itemId);
  const pages = api.instances?.pagesOf(itemId) ?? [];
  return !!item && rectsOf(item, pages).some((r) => w.x >= r.x && w.x <= r.x + r.w && w.y >= r.y && w.y <= r.y + r.h);
}

/** Whether world point `w` lies on a page of the document holding the focus (bd-hud's pick: the press is the session's). */
export function focusedPage(api, w) {
  return getState().boardFocus?.kind === 'document' && onPage(api, focusedItem(api), w);
}

/** Whether a press at client point `e` is the focused document's to take (the page under it belongs to that document). */
export function takesDocument(api, e) {
  const s = getState();
  if (s.boardFocus?.kind !== 'document') return false;
  const w = api?.vp?.fromClient(e.clientX, e.clientY).world;
  return onPage(api, focusedItem(api), w);
}

/** The item of the focused document: the live doc whose draft is the focused session. */
function focusedItem(api) {
  const id = getState().boardFocus?.session?.id;
  return (api.store?.live() ?? []).find((it) => it.type === 'doc' && it.draft === id)?.id ?? null;
}

/** The topmost document whose pages cover world point `w` (`docs` in paint order, later above), or null. */
function docAt(docs, w) {
  for (let i = docs.length - 1; i >= 0; i--) {
    if (docs[i].rects.some((r) => w.x >= r.x && w.x <= r.x + r.w && w.y >= r.y && w.y <= r.y + r.h)) return docs[i];
  }
  return null;
}

/** The double-click rule table (design section 8): a page of a document, or empty plane with one in view, homes to the cursor
 * or the nearest page and focuses over a quarter, else selects; an item is another tool's; nothing in view does nothing.
 * `hitId`: the document the pointer was over, so a document laid over another is the one that takes it. */
export function onDoubleClick(api, e, hitId = null) {
  const vp = api?.vp;
  if (!vp) return false;
  // A session with the keys takes the double-click as text (an entry still opening has none, so a second one is taken).
  if (vp.focus?.session != null) return false;
  if (vp.root?.style?.cursor === 'grab') return false; // a pan in hand
  const view = viewOf(vp);
  const world = vp.fromClient(e.clientX, e.clientY).world;
  const docs = docsOf(api);
  const hit = hitId ? docs.filter((d) => d.id === hitId) : docs;
  const under = docAt(hit, world);
  // Empty plane, or a document whose page the pointer missed: the page nearest the view's centre.
  const point = (under && homePoint(world, [under], view)) ?? homePoint(null, docs, view);
  if (!point) return false;
  const doc = docs.find((d) => d.id === point.doc);
  const page = doc?.rects.find((r) => r.page === point.page);
  if (!page) return false;
  api.selection.set([point.doc]);
  if (coverage(doc.rects, vp.view()) >= QUARTER) {
    enterDocument(api, point.doc, point).catch((err) => console.warn('The document did not take the focus', err));
  } else {
    home(vp, homeCamera(point, page.w, view, vp.camera.zoom));
  }
  return true;
}

/** Enter on a selected document: the double-click rule at the page of that document nearest the view's centre. */
export function enterSelected(api) {
  const vp = api?.vp;
  const ids = api?.selection?.ids ?? [];
  if (!vp || ids.length !== 1 || getState().boardFocus) return false;
  const item = api.store.get(ids[0]);
  if (!item || item.type !== 'doc') return false;
  const view = viewOf(vp);
  const doc = docsOf(api).find((d) => d.id === item.id);
  const point = doc && homePoint(null, [doc], view);
  const page = point && doc.rects.find((r) => r.page === point.page);
  if (!point || !page) return false;
  if (coverage(doc.rects, vp.view()) >= QUARTER) {
    enterDocument(api, item.id, point).catch((err) => console.warn('The document did not take the focus', err));
  } else {
    home(vp, homeCamera(point, page.w, view, vp.camera.zoom));
  }
  return true;
}
