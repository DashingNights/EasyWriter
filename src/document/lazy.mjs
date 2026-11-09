// Lazy drawing of heavy objects (docs/plans/word/briefs/perf-lazy.md). When an editor draws a document for the first time (it
// opens, or the editor is built again), pictures and canvases draw only once their box comes within about two screens of the
// view, the way a game engine streams only what its camera sees, and stay drawn after that. Until then a node view is a box of
// exactly its drawn size, taken from the node's attributes, so the page layout is the same before and after it draws. Objects
// a later edit makes (an insert, a paste, an undo) draw at once, as before. One IntersectionObserver per editor view. Plain web
// APIs only: the app becomes a web app later.

const MARGIN = '200%'; // about two screens beyond each side of the scroll box
const views = new WeakMap(); // EditorView → {io, waiting: Map(element → draw), opening}
const IDLE = { now: () => {}, stop: () => {} };

function stateOf(view) {
  let s = views.get(view);
  if (!s) {
    // The page area scrolls (find.js reveals in it too); a hidden session editor outside it never comes near, so never draws.
    const root = view.dom.closest?.('[data-viewport]') ?? null;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) run(s, e.target);
    }, { root, rootMargin: MARGIN });
    views.set(view, (s = { io, waiting: new Map() }));
  }
  return s;
}

function run(s, el) {
  const draw = s.waiting.get(el);
  if (!draw) return undefined;
  forget(s, el);
  return draw();
}

function forget(s, el) {
  if (!s.waiting.delete(el)) return;
  s.io.unobserve(el);
  el.removeAttribute('data-lazy');
}

/** Whether editor `view` is drawing its document for the first time: its constructor (no docView yet), or a rebuild of every
 * node view in the same task, as TipTap's Editor does at once when it adds its plugins' node views (ProseMirror then builds the
 * new docView, which view.dom.pmViewDesc names, before it replaces view.docView). A rebuild later, when the doc node's attrs
 * change, draws at once: its objects were on screen a moment ago.
 * ponytail: a large paste, or a document loaded into an editor in parts, draws at once; count the node views one task makes if
 * either shows up. */
function opening(view) {
  if (!view.docView) {
    const s = stateOf(view);
    if (!s.opening) {
      s.opening = true;
      queueMicrotask(() => { s.opening = false; });
    }
    return true;
  }
  return !!views.get(view)?.opening && view.dom.pmViewDesc !== view.docView;
}

/** Has `draw` draw element `el` of editor `view` once: at once, unless `view` is drawing its document for the first time; then
 * when `el` comes within about two screens of the view, or when drawAll runs. While it waits, `el` carries data-lazy.
 * → {now, stop}: now() draws it at once if it still waits (the selection reached it), stop() forgets it (its node view is gone). */
export function whenNear(view, el, draw) {
  if (typeof IntersectionObserver !== 'function' || !opening(view)) {
    draw();
    return IDLE;
  }
  const s = stateOf(view);
  s.waiting.set(el, draw);
  el.setAttribute('data-lazy', '');
  s.io.observe(el);
  return { now: () => void run(s, el), stop: () => forget(s, el) };
}

/** Draws now every object of editor `view` that still waits, or with `band` ({top, bottom}: layout px from view.dom's top,
 * zoom-free, as page geometry gives them) those whose box meets it. Print, PDF, page copies and anything else that reads the
 * drawings call it first. → a promise that settles once what it drew has loaded (pictures decode). */
export function drawAll(view, band = null) {
  const s = view && views.get(view);
  if (!s?.waiting.size) return Promise.resolve();
  let els = [...s.waiting.keys()];
  if (band) {
    // All the reads, then all the draws: a read after a draw would lay the document out again.
    const box = view.dom.getBoundingClientRect();
    const k = box.height / view.dom.offsetHeight || 1; // the page zoom
    els = els.filter((el) => {
      const r = el.getBoundingClientRect();
      return (r.bottom - box.top) / k >= band.top && (r.top - box.top) / k <= band.bottom;
    });
  }
  return Promise.all(els.map((el) => run(s, el))).then(() => undefined);
}

/** How many objects of editor `view` still wait to draw. */
export const waiting = (view) => views.get(view)?.waiting.size ?? 0;

// Harness cases (.smoke-data/word/cases/perf-lazy.js) reach the helper here; they cannot import modules.
if (typeof window !== 'undefined') window.__word = Object.assign(window.__word ?? {}, { lazy: { drawAll, waiting } });
