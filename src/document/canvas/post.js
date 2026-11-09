// The forum post's host on the canvas engine (docs/plans/engine/stage3-forum.md C1): what opens a post there, what holds it back,
// and the one web page it shows. A post draft's saved form is the post kit's JSON (section 2), so its record goes through the
// engine's `post` kind, not a .docx. The record stays in the DOM form until the first canvas save (convert.mjs keepDom and
// restoreDom): a post the engine would change is refused, and stays in the DOM editor with one line saying why. Nothing a user
// sees changes until D2 (POSTS_ON_ENGINE). Pure (session.js and node tests load it); the DOM editor's rendered objects are read
// only for the hints, and only when a document is passed in.
import { PX_PER_PT } from '../../engine/view/camera.mjs';
import { isCanvas } from '../../engine/model/form.mjs';
import { formatOf, pageOf } from '../../formats.mjs';
import { postToDoc } from '../../integrations/forum/import.mjs';
import { normal } from '../../integrations/forum/normal.mjs';
import { pictureCanvas } from '../../tooling/picture.mjs';
import { isMedia, migrateBoards, postFiles, readImage, readMedia } from '../../whiteboard.js';
import { refused } from './convert.mjs';

// The post kit's pure converters, which the post host is the one core path to (the boundary test's allow list): the forum's HTML
// (A4) and its import rules (postToDoc), for doc_get's html and the assistant's content (C5), and the canonical form above.
export { renderPost } from '../../integrations/forum/html.mjs';
export { postToDoc } from '../../integrations/forum/import.mjs';

/** The Canvas engine hosts posts too. Off until D2 (post-retire) has the DOM post path removed. */
export const POSTS_ON_ENGINE = false;

/** Whether the engine hosts forum posts in store state `s`: POSTS_ON_ENGINE, or `settings.postEngine` (the harness cases' own
 * switch, on a throwaway profile). */
export const postsOn = (s) => (s?.settings?.postEngine ?? POSTS_ON_ENGINE) === true;

/** Whether `draft` is a post kit format (the forum post or the core page, which share one kit and move together). A draft with
 * no format is a forum post too (formats.mjs formatOf's default, as the format.post gate reads it), but null is no draft. */
export const isPost = (draft, settings) => !!draft && ['forum-post', 'page'].includes(formatOf(draft, settings)?.id);

/** The post's page as the engine shows it: the DOM page's card, width and padding in px, in points → {web, margin} for
 * view.window. The text keeps the card's width less its padding on each side. */
export function postWindow(settings, draft) {
  const { width, padding } = pageOf(draft, settings);
  return { web: (width + 2 * padding) / PX_PER_PT, margin: padding / PX_PER_PT };
}

/** A canvas post's stored model (write's {"doc", "pending"}) as its doc node. */
export function storedDoc(draft) {
  const model = draft.engine?.model;
  const saved = typeof model === 'string' ? JSON.parse(model) : model;
  return saved?.doc ?? saved;
}

/** The reader's hints: a media object's natural size (nw, nh) and a plan chart's measured height (ch), read from the DOM
 * editor's rendered objects in document order, as the push reads its widths (forum/export.js). `dom` null (node tests) leaves the
 * doc as it is; the reader falls back to 16:9 media and a 3:4 chart, so a missing hint only moves a size. */
export function withHints(doc, dom) {
  if (!dom) return doc;
  const media = [...dom.querySelectorAll('[data-media] > :is(img, video)')];
  const charts = [...dom.querySelectorAll('.pc')];
  let mi = 0;
  let ci = 0;
  let changed = false;
  const walk = (n) => {
    if (n.type === 'media') {
      const el = media[mi++];
      const nw = el?.naturalWidth || el?.videoWidth;
      const nh = el?.naturalHeight || el?.videoHeight;
      if (!nw || !nh) return n;
      changed = true;
      return { ...n, attrs: { ...n.attrs, nw, nh } };
    }
    if (n.type === 'planChart') {
      const ch = charts[ci++]?.offsetHeight;
      if (!ch) return n;
      changed = true;
      return { ...n, attrs: { ...n.attrs, ch } };
    }
    if (!Array.isArray(n.content)) return n;
    const content = n.content.map(walk);
    if (content.every((c, i) => c === n.content[i])) return n;
    changed = true;
    return { ...n, content };
  };
  const out = walk(doc);
  return changed ? out : doc;
}

/** The DOM editor's post as the engine reads it: whiteboards become canvases (migrateBoards) and the reader's hints are added
 * (withHints). checkPost compares against this same doc, so a post the migration changes is not taken for one the engine did. */
const domDoc = (draft, settings, dom) => withHints(migrateBoards(draft.doc, pageOf(draft, settings).width), dom);

/** The bytes the engine opens as kind 'post' for `draft` → {bytes, kind: 'post', dropped: []}. A DOM draft's post JSON is
 * migrated and hinted (domDoc); a canvas draft's saved doc is migrated and wrapped again with the page's width and padding and
 * the settings' base font and size, which its save left out. */
export function postSource(draft, settings, dom = null) {
  const { width, padding } = pageOf(draft, settings);
  const doc = isCanvas(draft) ? withHints(migrateBoards(storedDoc(draft), width), dom) : domDoc(draft, settings, dom);
  // The reader takes the card's width less `pad` on each side (formats post::avail_pt), as the engine's view.window does.
  const body = JSON.stringify({ doc, width: width + 2 * padding, pad: padding,
    base: { font: settings?.baseFont || '', size: Number(settings?.baseSize) || 100 } });
  return { bytes: new TextEncoder().encode(body), kind: 'post', dropped: [] };
}

/** Refuses `draft` when the engine's save would not be the post the DOM editor holds: an unknown node, an unsupported mark or a
 * lost attribute would be dropped for good at the next save, so the post stays on the DOM editor (convert.mjs refused, stayLine).
 * `client.save('post')` writes the accepted view with its waiting revisions counted (A3), and the doc it is compared with is the
 * one postSource sent (domDoc: migrated and hinted). */
export async function checkPost(client, draft, settings = {}, dom = null) {
  const saved = JSON.parse(new TextDecoder().decode(await client.save('post')));
  if (!same(normal(saved.doc), normal(domDoc(draft, settings, dom)))) throw refused('the canvas engine would change how it looks');
}

/** Pasted `html` into post session `client`: the HTML read as the post kit's nodes (postToDoc, which keeps only what a post
 * holds) and inserted with post.insert, one undo step. The engine's own copy of this post took its token first (clipboard.js
 * pasteFrom), so what reaches here is another draft's or another program's HTML; `opts` ({objects: true} from the paste) keeps
 * the kit's own canvases, plan charts and media. */
export async function insertHtml(client, html, opts = {}) {
  const doc = postToDoc(html, [], opts);
  return !!doc.content?.length && client.exec('post.insert', { json: JSON.stringify(doc) });
}

/** Pasted or picked `files` into post session `client`, in one post.insert (one undo step): a picture becomes a smart canvas
 * shown at most the column wide (pictureCanvas, as the DOM editor pastes one), a video or GIF a media node whose natural size
 * comes with it as the reader's hints (nw, nh). → false when no file could be read. */
export async function insertFiles(client, files) {
  const list = postFiles({ files });
  if (!list.length) return false;
  let width = 468;
  try {
    width = (await client.query('box.list', {}))?.value?.column ?? width;
  } catch { /* the column's default */ }
  const nodes = (await Promise.all(list.map(async (f) => {
    if (!isMedia(f)) {
      const picture = await readImage(f);
      return picture && pictureCanvas(picture, width);
    }
    const m = await readMedia(f);
    const size = m && (await mediaSize(m.src));
    return m && { type: 'media', attrs: { src: m.src, name: m.name, dw: null, ...(size && { nw: size.w, nh: size.h }) } };
  }))).filter(Boolean);
  return !!nodes.length && client.exec('post.insert', { json: JSON.stringify(nodes) });
}

/** A video's or picture's natural size in px (`{w, h}`), or null when it does not load: the hints the reader sizes a media
 * node by. */
function mediaSize(src) {
  return new Promise((resolve) => {
    const done = (w, h) => resolve(w && h ? { w, h } : null);
    if (/^data:video\//.test(src)) {
      const v = document.createElement('video');
      Object.assign(v, { preload: 'metadata', onloadedmetadata: () => done(v.videoWidth, v.videoHeight), onerror: () => done() });
      v.src = src;
    } else {
      const img = new Image();
      Object.assign(img, { onload: () => done(img.naturalWidth, img.naturalHeight), onerror: () => done() });
      img.src = src;
    }
  });
}

/** Whether two JSON values are the same: a JSON object's keys are unordered, so an object's own key order (a canvas item's
 * attributes, say) is not a change. Arrays keep their order. */
function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  }
  return a === b;
}
