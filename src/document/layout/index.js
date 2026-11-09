// The layout predictor (docs/plans/word/briefs/layout-predictor.md): a large Document's page map within a second of opening, from our
// own engine (engine.mjs) in a Web Worker, while the editor's DOM still draws the pages in view. predictor(view) starts one per
// editor: it posts the doc JSON once, then only the top-level blocks a transaction changed (ProseMirror keeps unchanged nodes, so
// comparing the old and new doc's children by identity finds them, and the worker needs no schema).
// The page engine (pagination.js) starts it for each paged view: its heights size the blocks the DOM has not drawn (culling), its
// page count is the progress card's estimate, and the layout cache keeps its frames. Plain web APIs: the worker's script is
// dist/layout-worker.js beside the page, as the Word reader's is.
// ponytail: one worker. Four paid only 0.11 s on the Word fixture (layout-spike.md), and an edit lays out one block; split the
// document into page-aligned jobs over a pool if a first layout ever takes more than a second.
import { fontStack } from '../../office.mjs';
import { fieldNames, fieldType } from '../fields/registry.mjs';
import { fontEvents, loadedFaces } from '../fonts/provider.mjs';
import { ratios as editorRatios } from '../wp/paragraph/extension.js';
import { EST, RULES } from './engine.mjs';

export { EST, RULES };

const all = new WeakMap(); // view → its predictor

// Han text in the document's body font: its width tells which language the page falls back by.
const HAN = '和句號。）以及中文';

/** The language the page's canvas falls back by, for the worker's canvas: a worker's canvas picks fallback fonts for its own default
 * language, so Han text in a Latin font gets other glyphs there than in the editor (layout-spike.md: 136 px against 144 for one
 * string). The first East Asian language whose canvas measures Han text as the page's does, else the document's language. */
function pageLang(stack) {
  const g = document.createElement('canvas').getContext('2d');
  const own = document.documentElement.lang || navigator.language;
  if (!('lang' in g)) return own;
  const width = (lang) => {
    g.lang = lang;
    g.font = `16px ${stack}`;
    return g.measureText(HAN).width;
  };
  const page = width('inherit');
  return ['zh-HK', 'zh-TW', 'zh-CN', 'ja', 'ko'].find((l) => Math.abs(width(l) - page) < 0.01) ?? own;
}

/** The editor's measured single line ratios not yet sent (or changed since) → {stack: ratio} or null. */
function ratiosSince(sent) {
  let out = null;
  for (const [k, v] of editorRatios) {
    if (sent.get(k) === v) continue;
    sent.set(k, v);
    (out ??= {})[k] = v;
  }
  return out;
}

/** The predictor of `view` (a Document's editor view), started on first call with `rules` over RULES (index.js and the worker add
 * lang and ligatures: false, the editor's canvas rules). It is an EventTarget: 'change' after each layout, detail {version, page
 * (the first page whose start moved), block (the first block laid out again)}. Fields, each replaced whole per layout:
 *   heights   Float64Array, each top-level block's height in px (its box, margins left out; a floating object's own height)
 *   est       Uint8Array of EST bits: why a block's height is not the engine's own model (EST.dom: the editor's figure)
 *   pages     [{block, sub (row or wrapped paragraph in it), line, y (px down from the block's top), number, section, blank, est
 *             (its section has a header or footer, whose height the engine does not lay out)}], one per page
 *   count     pages, blank ones included; blanks: the blank ones
 *   frames    [{block, page, x, y, w, h}]: inline pictures and charts and objects in the flow, px from the page's text area
 *   version   +1 per layout; current: whether the last layout is of the editor's doc as it is
 *   ready     a promise for the first full layout (rejected when no worker can start)
 *   stats     {open: {toJSON, post, read, worker, wall}, edit: {post, read, worker, wall}} in ms, and the last layout's phases
 * correct(block, px): the DOM measured top-level block `block` at `px`; that figure stands until the block's content changes. */
export function predictor(view, rules = {}) {
  let p = all.get(view);
  if (!p) all.set(view, (p = new Predictor(view, rules)));
  return p;
}

// For harness cases (as lazy.mjs and ribbon/search.js expose theirs).
if (typeof window !== 'undefined') window.__word = Object.assign(window.__word ?? {}, { predictor });

class Predictor extends EventTarget {
  heights = new Float64Array(0);
  est = new Uint8Array(0);
  pages = [];
  count = 0;
  blanks = 0;
  frames = [];
  version = 0;
  current = false;
  stats = { open: null, edit: null, layout: null };
  #view;
  #worker;
  #doc;
  #seq = 0;
  #sent = new Map();
  #queued = false;
  #edit = null; // the edit waiting for its layout: {seq, t0, post}
  #asked = new Map(); // lines request seq → its resolve
  #off;
  #fontsOff;

  constructor(view, rules) {
    super();
    this.#view = view;
    let done;
    let fail;
    this.ready = new Promise((res, rej) => [done, fail] = [res, rej]);
    this.ready.catch(() => {}); // a consumer that never awaits it sees no unhandled rejection
    try {
      this.#worker = new Worker(new URL('dist/layout-worker.js', document.baseURI));
    } catch (e) {
      console.warn('The layout predictor could not start its worker; the pages come from the editor alone.', e);
      fail(e);
      return;
    }
    const t0 = performance.now();
    const doc = (this.#doc = view.state.doc);
    const json = doc.toJSON();
    const t1 = performance.now();
    const opts = {
      ...rules,
      lang: rules.lang ?? pageLang(fontStack('+minor', doc.attrs.theme)),
      drawn: fieldNames().filter((n) => fieldType(n)?.draw),
      ratios: { ...rules.ratios, ...ratiosSince(this.#sent) },
      faces: loadedFaces(),
    };
    this.#worker.postMessage({ seq: ++this.#seq, open: json, opts });
    this.stats.open = { toJSON: t1 - t0, post: performance.now() - t1 };
    this.#worker.onerror = (e) => {
      e.preventDefault();
      console.warn('The layout predictor stopped.', e.message);
      fail(new Error(e.message || 'The layout predictor stopped.'));
    };
    this.#worker.onmessage = ({ data }) => {
      if (data.error) {
        console.warn('The layout predictor failed.', data.error);
        return this.version || fail(new Error(data.error));
      }
      if (data.lines) {
        this.#asked.get(data.seq)?.(data.lines);
        return this.#asked.delete(data.seq);
      }
      const L = data.layout;
      const wall = performance.now() - t0;
      Object.assign(this, { heights: L.heights, est: L.est, pages: L.pages, count: L.count, blanks: L.blanks, frames: L.frames,
        version: this.version + 1, current: L.seq === this.#seq });
      this.stats.layout = { t: L.t, counts: L.counts };
      if (this.version === 1) {
        Object.assign(this.stats.open, { read: L.read, worker: L.t.total, wall });
        done(this);
      } else if (this.#edit && L.seq >= this.#edit.seq) {
        this.stats.edit = { post: this.#edit.post, read: L.read, worker: L.t.total, wall: performance.now() - this.#edit.t0 };
        this.#edit = null;
      }
      this.dispatchEvent(new CustomEvent('change', { detail: { version: this.version, page: L.changed, block: L.from } }));
    };
    // A font that finishes loading: the worker forgets the widths it measured (its canvas may draw another face for the same font
    // string), and the line ratios the editor measures again follow with the next change.
    const onFonts = () => {
      this.#worker?.postMessage({ seq: ++this.#seq, fonts: true });
      this.current = false;
    };
    // The open fonts the page has loaded (fonts/provider.mjs) load in the worker too, so it measures the face the editor draws.
    const onFaces = () => {
      this.#worker?.postMessage({ seq: ++this.#seq, faces: loadedFaces() });
      this.current = false;
    };
    document.fonts?.addEventListener?.('loadingdone', onFonts);
    fontEvents.addEventListener('faces', onFaces);
    this.#fontsOff = () => {
      document.fonts?.removeEventListener?.('loadingdone', onFonts);
      fontEvents.removeEventListener('faces', onFaces);
    };
    const editor = view.dom?.editor;
    if (editor) {
      const onTr = () => this.#later();
      const onDestroy = () => this.destroy();
      editor.on('transaction', onTr);
      editor.on('destroy', onDestroy);
      this.#off = () => {
        editor.off('transaction', onTr);
        editor.off('destroy', onDestroy);
      };
    }
  }

  /** Transactions in one task share one post. */
  #later() {
    if (this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => this.sync());
  }

  /** Posts what changed since the last post: the top-level children between the unchanged ones at either end, and changed doc attrs. */
  sync() {
    this.#queued = false;
    const doc = this.#view.state.doc;
    const old = this.#doc;
    if (!this.#worker) return;
    if (doc === old) {
      // A font file's ratio that replaced a measured one arrives with a redraw that changes no content.
      const ratios = ratiosSince(this.#sent);
      if (ratios) {
        this.#worker.postMessage({ seq: ++this.#seq, ratios });
        this.current = false;
      }
      return;
    }
    const t0 = performance.now();
    this.#doc = doc;
    const n = Math.min(old.childCount, doc.childCount);
    let a = 0;
    while (a < n && old.child(a) === doc.child(a)) a++;
    let b = 0;
    while (b < n - a && old.child(old.childCount - 1 - b) === doc.child(doc.childCount - 1 - b)) b++;
    const nodes = [];
    for (let i = a; i < doc.childCount - b; i++) nodes.push(doc.child(i).toJSON());
    let attrs = null;
    if (doc.attrs !== old.attrs) for (const k of Object.keys(doc.attrs)) if (doc.attrs[k] !== old.attrs[k]) (attrs ??= {})[k] = doc.attrs[k];
    const edit = { from: a, to: old.childCount - b, nodes: nodes.length || old.childCount - b > a ? nodes : null, attrs };
    this.#worker.postMessage({ seq: ++this.#seq, edit, ratios: ratiosSince(this.#sent) });
    this.current = false;
    this.#edit ??= { seq: this.#seq, t0 };
    this.#edit.seq = this.#seq;
    this.#edit.post = performance.now() - t0;
  }

  /** The editor measured top-level block `block` of its current doc at `px` tall. */
  correct(block, px) {
    this.sync();
    if (!this.#worker) return;
    this.#worker.postMessage({ seq: ++this.#seq, correct: { block, px } });
    this.current = false;
  }

  /** Each line's text and width of top-level blocks `blocks` (diagnostics: the harness compares them with the editor's DOM) → a
   * promise of [[{text, w, h}] per paragraph] per block. */
  lines(blocks) {
    if (!this.#worker) return Promise.resolve(null);
    this.sync();
    const seq = ++this.#seq;
    return new Promise((res) => {
      this.#asked.set(seq, res);
      this.#worker.postMessage({ seq, lines: blocks });
    });
  }

  destroy() {
    this.#off?.();
    this.#fontsOff?.();
    this.#worker?.terminate();
    this.#worker = null;
    all.delete(this.#view);
  }
}
