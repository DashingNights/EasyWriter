// The layout predictor's Web Worker (docs/plans/word/briefs/layout-predictor.md): keeps its own copy of the open draft's doc and
// lays it out with engine.mjs, measuring with OffscreenCanvas measureText. Bundled on its own as dist/layout-worker.js
// (package.json build); index.js starts it, one per editor.
// In (each with seq, the page's count of what it sent): {open: doc JSON, opts}, {edit: {from, to, nodes, attrs}}, {ratios}, {fonts},
// {faces}, {correct: {block, px}}, {lines: [block...]}. opts.faces and {faces}: the open fonts the page's document.fonts has loaded
// (fonts/provider.mjs loadedFaces), which this worker's self.fonts loads too, so it measures what the editor draws.
// Out: {layout} after the changes that arrived together (its heights and est buffers transferred), {lines}, or {error}.
import { createLayout } from './engine.mjs';
import { makeMeasurer } from './measure.mjs';

const g = new OffscreenCanvas(1, 1).getContext('2d');
let L = null;
let measurer = null;
let seq = 0;
let read = 0; // ms spent reading (deserialising) the messages since the last layout
let queued = false;
let fontsIn = Promise.resolve(); // the faces being added; a layout waits for them
const added = new Set(); // the faces in self.fonts, by family|weight|style|src

/** Adds the faces of `list` not added yet → a promise of whether any was. The bytes come from Cache Storage for a downloaded font,
 * else from its URL (a bundled file beside the app). */
async function addFaces(list) {
  const keyOf = (d) => `${d.family}|${d.weight}|${d.style}|${d.src}`;
  const fresh = list.filter((d) => !added.has(keyOf(d)));
  await Promise.all(fresh.map(async (d) => {
    added.add(keyOf(d));
    try {
      const res = (await self.caches?.match(d.src).catch(() => null)) ?? (await fetch(d.src));
      const face = new FontFace(d.family, await res.arrayBuffer(), { weight: d.weight, style: d.style, unicodeRange: d.unicodeRange });
      self.fonts.add(await face.load());
    } catch (e) {
      added.delete(keyOf(d));
      console.warn('The layout predictor could not load a font.', d.src, e);
    }
  }));
  return fresh.length > 0;
}

/** Loads `list` before the next layout, then measures every font again (one already measured may draw another face now). */
function useFaces(list) {
  fontsIn = fontsIn.then(() => addFaces(list)).then((any) => {
    if (any && L) {
      measurer.clear();
      L.fonts();
      later(); // a layout queued before these faces came has run without them
    }
  });
}

function run() {
  queued = false;
  try {
    const layout = L.run();
    Object.assign(layout, { seq, read });
    read = 0;
    self.postMessage({ layout }, [layout.heights.buffer, layout.est.buffer]);
  } catch (e) {
    self.postMessage({ seq, error: String(e?.stack ?? e) });
  }
}

// Messages that arrive while a layout runs wait in the queue behind it, and the next layout takes them all at once.
const later = () => {
  if (!queued) {
    queued = true;
    fontsIn.then(() => setTimeout(run, 0));
  }
};

self.onmessage = (e) => {
  const t0 = performance.now();
  const msg = e.data; // the first read deserialises what the page posted
  read += performance.now() - t0;
  seq = msg.seq ?? seq;
  if (msg.open) {
    const { lang = null, ligatures = false, faces = [], ...rules } = msg.opts ?? {};
    // The page's language picks the same fallback fonts the editor's DOM gets (a worker's canvas has its own default).
    if (lang && 'lang' in g) g.lang = lang;
    measurer = makeMeasurer(g, { ligatures });
    L = createLayout(measurer, rules);
    L.open(msg.open);
    useFaces(faces);
  }
  if (!L) return;
  if (msg.fonts) {
    measurer.clear();
    L.fonts();
  }
  if (msg.faces) useFaces(msg.faces);
  if (msg.ratios) L.ratios(msg.ratios);
  if (msg.edit) L.edit(msg.edit);
  if (msg.correct) L.correct(msg.correct.block, msg.correct.px);
  if (msg.lines) {
    self.postMessage({ seq, lines: L.lines(msg.lines) });
    return;
  }
  later();
};
