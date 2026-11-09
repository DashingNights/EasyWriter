// The layout cache (docs/plans/word/briefs/layout-cache.md): a Document opens from its last layout. For each top-level block it
// keeps the height the page engine last measured, keyed by a hash of the block's content (its node JSON) and of the inputs that
// change its layout: its section's page setup, the document's styles, theme, lists and settings, whether the fonts it names are
// installed and this cache's version. The screen's pixel ratio is left out: a move to a screen at another scale (or the app's zoom)
// moves a height by a rounding at most, which the check corrects, where a key holding it missed every block. With them go the page
// starts and the page count. The record is stored with the draft, in its own file beside it (app/actions.js,
// main.js drafts.saveLayout: out of the record, so writing it neither marks the draft updated nor reaches the backup), written when
// the pages settle and when the draft closes. On the next open each block whose key matches takes its height before it renders, so the page engine skips its layout
// (pagination.js culling), and the engine checks every block it skipped in the background: a stale entry costs a relayout of that
// block, never a wrong final layout.
// A Word file's own hints (w:lastRenderedPageBreak and app.xml's Pages, docx/import.mjs props.breaks and props.pages) are the first
// guess of its page count on a first open, until the layout predictor's first layout; the export writes the app's own page starts
// as w:lastRenderedPageBreak (pageStartsOf).
// Pure: no DOM. The page engine passes the font probe (env), and node tests run it as is.
import { cyrb53 } from '../app/digest.mjs';
import { sectionsOf } from './model/sections.mjs';

/** The cache's version: bump it when a change to the editor's layout (its CSS or the page engine) changes block heights. A cache
 * left stale only costs the check's relayout of the blocks it got wrong, never a wrong layout. */
export const VERSION = 1;

/** A 53-bit hash of a string in base 36 (cyrb53, app/digest.mjs: pure and import-free): fast, and collisions are rare enough for a
 * cache that is checked anyway. */
export const hash = cyrb53;

// The font names a block's runs or a style name (textStyle marks and run properties: font, fontEA, fontCS). '+major' and '+minor'
// are the theme's fonts, which the document's inputs cover.
const FONT = /"font(?:EA|CS)?":"([^"+][^"]*)"/g;
const familiesIn = (json) => [...new Set([...json.matchAll(FONT)].map((m) => m[1]))].sort();

const blocks = new WeakMap(); // top-level node → {h: its JSON's hash, fonts: the families it names}

/** Top-level node `node`'s content hash and font families, kept per node: ProseMirror keeps an unchanged block's node across
 * edits, so after an edit only the changed blocks serialise again. */
function blockOf(node) {
  let b = blocks.get(node);
  if (!b) {
    const json = JSON.stringify(node.toJSON());
    blocks.set(node, (b = { h: hash(json), fonts: familiesIn(json) }));
  }
  return b;
}

/** Which of `families` are installed, by `env.available(family)` → '1' or '0' each (no probe: all count as installed). */
const fontsPrint = (families, env) => families.map((f) => (env?.available ? (env.available(f) ? '1' : '0') : '1')).join('');

const docInputs = new WeakMap(); // doc attrs → {env, key}

/** The document-wide inputs of every block's layout: this version, styles, theme, lists, settings, the theme's and styles' fonts
 * (installed or not). Kept per attrs object (a transaction that changes none keeps it). */
function inputsOf(attrs, env) {
  const hit = docInputs.get(attrs);
  if (hit?.env === env) return hit.key;
  const json = JSON.stringify([attrs.styles ?? null, attrs.theme ?? null, attrs.numbering ?? null, attrs.settings ?? null]);
  const fonts = [attrs.theme?.fonts?.major, attrs.theme?.fonts?.minor, ...familiesIn(json)].filter(Boolean);
  const key = hash(`${VERSION}|${fonts.join(',')}:${fontsPrint(fonts, env)}|${json}`);
  docInputs.set(attrs, { env, key });
  return key;
}

/** The key of each top-level block of ProseMirror doc `doc` (an array in document order): its content hash, its section's page
 * setup, the document's inputs and its own fonts. `env`: {available(family) → bool}, the same object across calls. */
export function keysOf(doc, env = null) {
  const docKey = inputsOf(doc.attrs, env);
  const secs = sectionsOf(doc);
  const sectKeys = secs.map((s) => hash(JSON.stringify(s.sect)));
  const out = [];
  let si = 0;
  doc.forEach((node, pos) => {
    while (si < secs.length - 1 && pos >= secs[si].to) si++;
    const b = blockOf(node);
    out.push(`${b.h}${sectKeys[si]}${docKey.slice(0, 6)}${fontsPrint(b.fonts, env)}`);
  });
  return out;
}

// Heights keep four decimals: the browser lays out in 1/64 px, and a height off by a rounding in each of a thousand blocks would
// move the page ends below them.
const fine = (v) => Math.round(v * 10000) / 10000;

/** The record stored with a draft, from the page engine's layout of `doc`:
 *   heights  each top-level block's height in px for its culling (its content box: what contain-intrinsic-size takes), null
 *            where none was measured
 *   pages    [[block, line]]: where each page after the first starts (block index, line in it), blank pages left out
 *   count    the page count, blank pages included
 * Object frames are not kept: nothing on open reads them yet (the predictor works them out again in under a second).
 * → {v, keys, h, pages, count} (plain JSON). */
export function buildCache(doc, { env = null, heights, pages = [], count = 0 }) {
  const keys = keysOf(doc, env);
  const h = keys.map((_, i) => (heights[i] == null || !(heights[i] >= 0) ? null : fine(heights[i])));
  return { v: VERSION, keys, h, pages: pages.map(([b, l]) => [b, l]), count };
}

/** Cache `cache` (buildCache's record, as stored) matched against ProseMirror doc `doc`: each block whose key it holds takes its
 * height; a block moved by an insertion or deletion above it is found by its key. A cache of another version, or none, matches
 * nothing. → {heights (Float64Array, NaN: unknown), from (Int32Array: the cached block each came from, -1), pages ([[block, line]]
 * of the blocks kept), count, hits} or null. */
export function matchCache(doc, cache, env = null) {
  if (!cache || cache.v !== VERSION || !Array.isArray(cache.keys)) return null;
  const keys = keysOf(doc, env);
  const n = keys.length;
  const heights = new Float64Array(n).fill(NaN);
  const from = new Int32Array(n).fill(-1);
  const old = cache.keys;
  // Same place first (the usual case: nothing or a few blocks changed), then by key in order for the rest.
  const byKey = new Map();
  old.forEach((k, j) => {
    if (keys[j] !== k) byKey.set(k, [...(byKey.get(k) ?? []), j]);
  });
  const used = new Uint8Array(old.length);
  for (let i = 0; i < n; i++) {
    let j = old[i] === keys[i] ? i : -1;
    if (j < 0) {
      const list = byKey.get(keys[i]);
      while (list?.length && used[list[0]]) list.shift();
      j = list?.shift() ?? -1;
    }
    if (j < 0 || used[j]) continue;
    used[j] = 1;
    from[i] = j;
    const h = cache.h?.[j];
    if (h != null && h >= 0) heights[i] = h;
  }
  const to = new Map();
  from.forEach((j, i) => j >= 0 && to.set(j, i));
  const pages = (cache.pages ?? []).filter(([b]) => to.has(b)).map(([b, l]) => [to.get(b), l]);
  let hits = 0;
  for (let i = 0; i < n; i++) if (from[i] >= 0) hits++;
  return { heights, from, pages, count: cache.count ?? 0, hits };
}

const floats = new WeakMap(); // top-level node → whether it holds a float or a note reference

/** Whether top-level node `node` holds what reaches past its own box or reads its own lines each layout: an anchored picture or
 * chart, a floating text box, canvas or table, a framed paragraph, or a footnote reference (pagination reads where it sits). From
 * the model, as the predictor's engine marks them (layout/engine.mjs EST.float and EST.note). */
export function holdsFloat(node) {
  let v = floats.get(node);
  if (v === undefined) {
    const wraps = (n) => !!n.attrs?.frame || !!n.attrs?.float || (!!n.attrs?.layout?.wrap && n.attrs.layout.wrap !== 'inline');
    v = wraps(node);
    if (!v) {
      node.descendants((d) => {
        if (v) return false;
        if (d.type.name === 'noteRef' || wraps(d)) v = true;
        return !v && !d.isText;
      });
    }
    floats.set(node, v);
  }
  return v;
}

const passes = new WeakMap(); // top-level node → whether a layout pass reads inside it each layout
const TAB = String.fromCharCode(9);

/** Whether a layout pass reads inside top-level paragraph `node` on every layout, which would draw it again each time if it were
 * culled (a read inside a culled block lays that block out on its own, about a millisecond each on the Word fixture): the tab
 * boxes the tabs pass measures (wp/tabs: a tab, a positional tab or a list number before its tab). Line numbering, which reads
 * every line of its sections, is the page engine's to leave out (by section). */
export function readByPasses(node) {
  let v = passes.get(node);
  if (v === undefined) {
    v = !!node.attrs?.numbering;
    if (!v) {
      node.descendants((d) => {
        if (v) return false;
        if (d.type.name === 'ptab' || (d.isText && d.text.includes(TAB))) v = true;
        return !v;
      });
    }
    passes.set(node, v);
  }
  return v;
}

/** The top-level blocks to cull, of `n`: each block `ok(i)` allows whose `height(i)` is known (a number), except the blocks
 * around each page start in `starts` (ascending block indexes: the block a page starts at, whose lines a page end splits, and
 * the one before it, which the page end's place is read from) and every block from the start of the page of a block that
 * `float(i)` (holdsFloat) to the end of the page after it: its float reaches over the blocks below it, and a culled block is
 * laid out on its own, so it would not wrap round the float. → Uint8Array (1: cull). */
export function cullSet(n, { ok, height, float, starts }) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = ok(i) && height(i) >= 0 ? 1 : 0;
  for (const s of starts) {
    if (s > 0 && s - 1 < n) out[s - 1] = 0;
    if (s < n) out[s] = 0;
  }
  let p = 0; // the page of block i: the number of starts at or before it
  for (let i = 0; i < n; i++) {
    while (p < starts.length && starts[p] <= i) p++;
    if (!float(i)) continue;
    const a = p ? starts[p - 1] : 0;
    const b = starts[p + 1] ?? n;
    out.fill(0, a, b);
  }
  return out;
}

/** Word's page count from its hints in ProseMirror doc `doc` (docx/import.mjs): app.xml's Pages, else one more than the page starts
 * its w:lastRenderedPageBreak marks gave (props.breaks), else null. Stale when Word saved before its layout finished (the Word
 * fixture says 522 where Word draws 966), so only a first guess. */
export function hintCount(doc) {
  const p = doc.attrs.props;
  return p?.pages ?? (Array.isArray(p?.breaks) ? p.breaks.length + 1 : null);
}

// A cache the app read with a draft, waiting for that draft's editor (pagination.js takes it when the editor's state starts).
let staged = null;

/** Hands `cache` (draft.layout, or null) to the next Document editor that starts (actions.js, just before it mounts the draft). */
export function stageCache(cache) {
  staged = cache ?? null;
}

/** The staged cache, once: the first editor that starts after stageCache takes it. */
export function takeCache() {
  const c = staged;
  staged = null;
  return c;
}

/** Page starts of the laid-out document for Word's w:lastRenderedPageBreak (docx/export.mjs pageStarts): each page after the
 * first as [top-level block index, characters into that block], from ProseMirror doc `doc` and the page start positions `from`
 * (geometry's PageBox.from). Characters count text as its length and every other inline leaf as one, in document order through
 * nested blocks, as export.mjs counts them back. */
export function pageStartsOf(doc, from) {
  const out = [];
  const tops = [];
  doc.forEach((n, pos) => tops.push(pos));
  let i = 0;
  for (const at of from) {
    if (at == null || at <= 0 || at >= doc.content.size) continue;
    while (i + 1 < tops.length && tops[i + 1] <= at) i++;
    const node = doc.child(i);
    let chars = 0;
    node.descendants((d, p) => {
      const abs = tops[i] + 1 + p;
      if (abs >= at) return false;
      if (d.isText) chars += Math.min(d.text.length, at - abs);
      else if (d.isLeaf && d.isInline) chars += 1;
      return true;
    });
    const last = out.at(-1);
    if (!last || last[0] !== i || last[1] !== chars) out.push([i, chars]);
  }
  return out;
}
