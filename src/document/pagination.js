// A Document's pages on screen, engine 2 (docs/plans/word/plan.md §1.9 Engine 2, briefs/page-engine.md): float-widget pagination
// with sections, reservations and Word's keep rules. Own code; tiptap-pagination-plus 3.1.0 (MIT) was engine 1's reference for the
// float technique, none of its code.
//
// Each frame reads where the text sits (top-level blocks, table rows, and the lines of the blocks at page ends), takes away the page
// ends it drew last time to get the text as one flow, lays that flow out into pages (wp/page-engine/layout.mjs planPages: section
// starts, blank even and odd pages, widow and orphan control, keep with next, keep lines together, page break before, repeated
// header rows, vertical alignment) and writes the result back. Each page end is a widget before the block that crosses it, holding
// a zero-width spacer from the widget down to the cut and a full-width breaker from the cut to the next page's text: the browser
// moves every line that would overlap the breaker below it, so text still crosses page ends line by line, and floats and clears in
// the text before that block stay on their page (plan.md §1.9). The breaker draws the gap between pages (div.pg-gap) and nothing
// else: each page's paper, page number and page layers sit in an absolutely placed div.pg-page at its body top, so pages of
// different sizes draw as their own sheets. Heights are written in place inside the widgets; only a page end moving to another
// block re-keys a widget. The frame repeats inside one requestAnimationFrame until what it reads matches what it drew (a page end
// that moved shifts the text after it), at most a few times, then carries on next frame. A keypress that leaves every block's box
// where it was takes the quick path: the pages stay and only the model's positions move. The 'after' passes and the page layers
// of a layout run at the start of the next frame, on the layout the browser drew since: after the frame's writes each of their
// reads laid the whole text out again (plan.md §1.9 had them in the same frame).
//
// Each section lays out at its own text width, as Word does (briefs/section-widths.md). The text is one column as wide as the
// last section's text (the doc's own sect, which sizes the page outside paged views too); every top-level block of a section
// of another width carries data-pg-dr and --pg-dr, how much narrower its text is (negative: wider), and page-engine/style.css
// takes that off the block's width, its own indents kept (blockDecorations, layout.mjs sectionShifts). Each page's sheet sits
// at its own left margin around the column, so every page's text starts at its own margin. ponytail: a continuous section that
// shares a page with another section of other margins starts its text at that page's left margin (its width is its own). Justified
// (vAlign both) spreads a page's room with a translate on each block after its first (node decorations), so the flow the engine
// reads stays where it was.
//
// Tables: each row is a grid of its own (document.css), so a row that cannot split (Word's cantSplit, a header row, an exact
// height) moves below a page end whole. Any other row splits at a line boundary in every cell, as Word's "Allow row to break
// across pages" does: a grid holds its lines away from the text's floats, so each of its cells gets the page end's spacer and
// breaker of its own (decorations: widgets at the cell's start), the widget before the table only a zero-width spacer and the
// next sheet, and the row is clipped between the pages (its cells' boxes run on under the page end), each cell's breaker closing
// the two pieces with the cell's bottom and top borders, as Word draws them. The next page's repeated header rows then draw in
// its sheet. A row whose paragraphs all keep with next keeps with the next row. Print and PDF print each page on its own paper
// (the print package's named pages).
// The blocks of a content control or a field block are units of their own (inner), as Word lays them out with the rest of
// the text.
// ponytail: a split row's cells sit at their tops while split, and no widow control runs inside them.
//
// Content taller than a page (a line or block taller than the body, briefs/print-fidelity.md) holds a page alone and runs past
// its body by planPages' `over`: the next page's sheet starts below it, and a cover (sheetOf) hides the overflow down to the next
// paper, as Word clips it at the page's edge; print clips it with each page copy's paper.
//
// Pages are drawn only while #editor-area's data-word-view is print or focus (or absent); story editors (data-story) and hidden,
// disconnected views run nothing. Imports no app module: Node tests load schema.js.
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { layers, layoutY, onLayoutChange, overlayElement, paginationKey, passes, rangeIn, scaleOf } from './geometry.js';
import { indexAt, layerWork, pageLabel, pageOfPos, runFrame } from './geometry.mjs';
import { sectionsOf } from './model/sections.mjs';
import { GAP } from './pages.mjs';
import { bodyOf, collapse, frameAt, keepsOf, lineBoxes, paperOf, partOf, placeAfter, planPages, rowLines, rowSplits, sectionBodies, sectionShifts,
  stackPages, startOf, toFlow } from './wp/page-engine/layout.mjs';
import { colBoxes, fillOf } from './wp/columns/model.mjs';
import { endKeys, sameSet, topLevelSet } from './wp/page-engine/decorations.js';
import { Culler, textRects } from './wp/page-engine/cull.js';
import { buildCache, cullSet, hintCount, holdsFloat, matchCache, readByPasses, takeCache } from './layout-cache.mjs';
import { predictor } from './layout/index.js';
import { ratios } from './wp/paragraph/extension.js';

export { paginationKey };

/** Height of the line that joins two pages while white space is hidden (views.whiteSpace). */
const THIN = 6;
/** The breaker sits this far below the cut, so the first line it moves overlaps it for sure and the last line kept never does:
 * line boxes are estimated from glyph rects and drawn values move only by a pixel or more (paint), so half a pixel lost lines.
 * Less than half of any line; the breaker's own height takes it back, so the next page's text still starts at its body top. */
const BIAS = 3;
/** A line's allowance when columns guess their height from their text (px): balancing can leave one column a line longer. */
const LINE = 24;
/** Page ends a document draws in its first frame; a longer one draws more each frame after, from the top (progressive). */
const FIRST = 30;
/** A document up to this many pages draws every sheet and page layer; a longer one only those near the view (culling). */
const WHOLE = 40;
/** ms of rounds after which a layout that keeps changing stays as last drawn (with the 40-round guard). */
const MAX_UNSETTLED = 15000;
/** The most page ends one frame adds (the JS that draws them grows with their number). */
const STEP_MAX = 1000;
/** Whether blocks far from the view are culled (wp/page-engine/cull.js). Off for now: on the Word fixture (2026-10-30, three other
 * harness windows running) it settled 10 to 15% faster in open mode but no faster in drop mode, left the longest task as it was
 * (1.1 to 1.6 s, set by ProseMirror's widget updates, the 'after' passes and the page layers) and slowed an edit at the top from
 * about 2 s to 3 to 6 s: the passes that read positions in far text (the note areas' references, comment balloons, the tabs
 * pass's boxes) lay each culled block out on its own. Measured again after perf-frame (2026-10-30, open mode): with it the longest
 * task was 1,077 ms and the edit 2,192 ms, without it 379 ms and 902 ms. What still reads inside culled blocks: linesOf for a
 * culled block that is not a textblock (cull.js copies the text rects of textblocks only), posAtLine where a page now starts
 * inside a block culled before, pagination's footnote references, the revision balloons (markup Balloon.jsx) and the tabs pass's
 * first walk. layout-cache turns it on with sizes for blocks never drawn, once those readers use textRects or skip culled
 * blocks. The harness switches it on with window.__wordTest.cull. */
const CULL = () => !!globalThis.__wordTest?.cull;
/** Blocks culled in one frame at most (wp/page-engine/cull.js): each has its lines and size read first. */
const CULL_STEP = 1500;
/** Rounds after which a layout that keeps changing keeps the page ends drawn (Engine.layout: pins). */
const FREEZE = 10;
/** ms a pagination frame spends on layout rounds before it carries on in the next frame. */
const BUDGET = 40;
const LAYER_BUDGET = 24; // ms of page layer drawing per frame (syncLayers)
/** Culled blocks the check draws in its first frame; twice as many each frame after, up to CHECK_MAX (a cached open's culling). */
const CHECK = 100;
/** The most culled blocks the check draws in one frame (about a seventh of the Word fixture's paragraphs). */
const CHECK_MAX = 1000;
/** The most frames the check takes (a guard: each slice it draws stays drawn, so it ends sooner). */
const CHECK_FRAMES = 400;
/** Harness switches (window.__wordTest): pagesWhole draws every page at once (pagesAll), every sheet and layer (sheetsAll) and
 * every block a cached open culls (noCull), as before progressive drawing and culling; cull culls blocks far from the view (CULL),
 * which sheetsAll leaves drawn. */
const testHook = (k) => !!(globalThis.__wordTest?.[k] || globalThis.__wordTest?.pagesWhole);
/** Widgets in the text's flow that pages must hold like a paragraph (a waiting suggestion's deleted blocks, src/suggest): their
 * lines are units, so a page end can fall inside one. Endnote areas are widgets too but are not counted yet. */
const FLOW_WIDGETS = '.sg-del-block';

// Word's display options the engine reads (settings.word.display.whiteSpace), bound by the page-engine module at load so this file
// imports no app module. Views paginating anywhere relayout when they change.
let options = { whiteSpace: () => true, setWhiteSpace: () => {} };
const views = new Set();
/** Binds `{whiteSpace() → bool, setWhiteSpace(bool)}`; every paginating view lays out again. */
export function setPageOptions(next) {
  options = { ...options, ...next };
  pageOptionsChanged();
}
/** Lays every paginating view out again (a display option changed). */
export function pageOptionsChanged() {
  for (const fn of views) fn();
}

const engines = new WeakMap(); // view → its engine's paint, for the widgets' toDOM

const div = (d, cls) => Object.assign(d.createElement('div'), { className: cls });

/** A page widget's DOM: 'start' (page 0's sheet and top pusher), 'end' k (page k's spacer and breaker, page k + 1's sheet and top
 * pusher) or 'final' (the last page's spacer). Values are painted from the engine's model. */
function widgetDom(view, kind, k) {
  const d = view.dom.ownerDocument;
  const root = div(d, `pg-pages pg-${kind}`);
  root.contentEditable = 'false';
  root.dataset.k = String(k);
  if (kind === 'start') root.append(div(d, 'pg-page'), div(d, 'pg-push'));
  else if (kind === 'end') root.append(div(d, 'pg-cut'), div(d, 'pg-breaker'), div(d, 'pg-page'), div(d, 'pg-push'));
  else root.append(div(d, 'pg-cut'));
  engines.get(view)?.paint(root);
  return root;
}

/** Page end k's widget at the start of cell i of a row it splits: the cell's spacer and breaker. */
function cellDom(view, k, i) {
  const d = view.dom.ownerDocument;
  const root = div(d, 'pg-cell');
  root.contentEditable = 'false';
  Object.assign(root.dataset, { k: String(k), i: String(i) });
  root.append(div(d, 'pg-cut'), div(d, 'pg-breaker'));
  engines.get(view)?.paint(root);
  return root;
}

/** A split row's clip: everything but the bands between its pieces, page end k's from --pg-a<k> to --pg-b<k> (px from the row's
 * top, written on its table's wrapper by paint, so the decoration stays while the page ends move). */
const FAR = 10000;
const clipOf = (ks) => `polygon(${[`-${FAR}px -${FAR}px`, `${FAR}px -${FAR}px`,
  ...ks.flatMap((k) => [`${FAR}px var(--pg-a${k},0px)`, `-${FAR}px var(--pg-a${k},0px)`, `-${FAR}px var(--pg-b${k},0px)`, `${FAR}px var(--pg-b${k},0px)`]),
  `${FAR}px ${FAR}px`, `-${FAR}px ${FAR}px`].join(',')})`;

/** The decorations: the page widgets at their anchors, the page-break look on section breaks that start a page, Justified's
 * shifts ([pos, px] per top-level block: a translate, so the text the engine reads keeps its place in the flow) and the rows a
 * page end splits ([row pos, page end k]: its widget in each cell, the row's clip). */
function decorations(doc, s) {
  if (!s.draw) return DecorationSet.empty;
  const decos = [Decoration.widget(0, (view) => widgetDom(view, 'start', 0), { key: 'pg-start', side: -2, ignoreSelection: true, marks: [] })];
  s.anchors.forEach((pos, k) => {
    // After the flow widgets at its place (side 2, past a suggestion's deleted blocks at side 1) or before them.
    const after = !!s.after?.[k];
    if (pos <= doc.content.size) {
      decos.push(Decoration.widget(pos, (view) => widgetDom(view, 'end', k), { key: s.keys[k], side: after ? 2 : -1, ignoreSelection: true, marks: [] }));
    }
  });
  decos.push(Decoration.widget(doc.content.size, (view) => widgetDom(view, 'final', 0), { key: 'pg-final', side: 1, ignoreSelection: true, marks: [] }));
  const secs = sectionsOf(doc);
  let si = 0;
  doc.forEach((n, pos) => {
    if (n.type.name !== 'sectionBreak') return;
    while (si < secs.length - 1 && pos >= secs[si].to) si++;
    if (startOf(n.attrs.kind, secs[si].sect, secs[si + 1]?.sect) !== 'none') decos.push(Decoration.node(pos, pos + n.nodeSize, { 'data-page-break': '' }));
  });
  for (const [pos, dy] of s.shifts) {
    const n = doc.nodeAt(pos);
    if (n) decos.push(Decoration.node(pos, pos + n.nodeSize, { style: `transform:translateY(${px(dy)}px)`, 'data-pg-dy': String(dy) }));
  }
  // A split row's decorations sit inside its table: added to the top-level set, which keeps its own fast build.
  const nested = [];
  const rows = new Map();
  for (const [pos, k] of s.splits) rows.set(pos, [...(rows.get(pos) ?? []), k]);
  for (const [pos, ks] of rows) {
    const row = doc.nodeAt(pos);
    if (row?.type.name !== 'tableRow') continue;
    nested.push(Decoration.node(pos, pos + row.nodeSize, { 'data-pg-split': '', style: `clip-path:${clipOf(ks)}` }));
    row.forEach((_, off, i) => {
      for (const k of ks) nested.push(Decoration.widget(pos + 2 + off, (view) => cellDom(view, k, i), { key: `pg-cell${k}-${i}`, side: -1, ignoreSelection: true, marks: [] }));
    });
  }
  const set = topLevelSet(doc, decos);
  return nested.length ? set.add(doc, nested) : set;
}

const blockDecos = new WeakMap(); // doc → [its blockDecorations without section widths, with them, and by section bodies]

/** The top-level blocks' decorations, one walk per doc. The block after each page break carries data-after-break, which
 * document.css takes its space before away by (Word drops it), and the textblock after a style separator's carries
 * data-after-vanish, which joins it to that one's line: a sibling selector there restyled the whole text whenever a page end's
 * widget came or went (in a document holding MathML, with any sibling selector tried on the text's children). While pages are drawn (`widths`), each block of a section whose text is not as wide as the column
 * carries data-pg-dr and --pg-dr, the difference in px (sectionShifts), which page-engine/style.css takes off its width. With the
 * sections' text heights `bodies` (layout.mjs sectionBodies), each block of a section whose height is not the last section's
 * carries its own --pg-body and --fit-h (document.css: the tallest a picture, canvas or row may be), as the sheet carries the
 * last section's: --fit-h is set to var(--pg-body) on the text itself, so a block's --pg-body alone would not reach it. */
export function blockDecorations(doc, widths, bodies = null) {
  let sets = blockDecos.get(doc);
  if (!sets) blockDecos.set(doc, (sets = []));
  const tall = widths && bodies?.some((b) => b !== bodies.at(-1)) ? bodies : null;
  const k = widths ? (tall ? `1:${tall.join()}` : 1) : 0;
  if (sets[k]) return sets[k];
  const secs = widths ? sectionsOf(doc) : null;
  const shifts = secs ? sectionShifts(secs.map((s) => s.sect), doc.attrs.settings).shifts : [];
  if (k === 1 && !shifts.some(Boolean)) return (sets[1] = blockDecorations(doc, false)); // one width throughout
  const decos = [];
  let after = false;
  let vanish = false; // the block before is a style separator's (document.css data-after-vanish, for the same reason)
  let si = 0;
  doc.forEach((n, pos) => {
    if (k) while (si < secs.length - 1 && pos >= secs[si].to) si++;
    const shift = k ? shifts[si] : 0;
    const body = tall && tall[si] !== tall.at(-1) ? tall[si] : null;
    const joined = vanish && n.isTextblock;
    const style = [shift && `--pg-dr:${shift}px`, body != null && `--pg-body:${body}px;--fit-h:${body}px`].filter(Boolean).join(';');
    if (after || style || joined) {
      decos.push(Decoration.node(pos, pos + n.nodeSize, { ...(after && { 'data-after-break': '' }), ...(joined && { 'data-after-vanish': '' }),
        ...(shift && { 'data-pg-dr': '' }), ...(style && { style }) }));
    }
    after = n.type.name === 'pageBreak';
    vanish = n.isTextblock && !!n.attrs.specVanish;
  });
  return (sets[k] = topLevelSet(doc, decos));
}

/** `doc`'s section breaks (the nodes, in order): decorations hang on them and on the sects around them. */
const breaksOf = (doc) => {
  const out = [];
  doc.forEach((n) => { if (n.type.name === 'sectionBreak') out.push(n); });
  return out;
};

/** Positions `ps` (ascending) moved to the start of the top-level block holding each, so a mapped anchor never lands inside a
 * block (earlier is safe). One walk over the blocks: resolving each position would walk them once per anchor. */
function onBlocks(doc, ps) {
  const out = [];
  let i = 0;
  let pos = 0;
  for (const p of ps) {
    const want = Math.min(Math.max(0, p), doc.content.size);
    while (i < doc.childCount && pos + doc.child(i).nodeSize <= want) pos += doc.child(i++).nodeSize;
    out.push(pos);
  }
  return out;
}

const VIEWS = new Set(['print', 'focus']);
const px = (v) => Math.round(v * 100) / 100;

// ---------- culling and the layout cache (layout-cache.mjs, docs/plans/word/briefs/layout-cache.md) ----------
// A Document opens with its top-level paragraphs far from its first pages culled at a known height: content-visibility: auto
// (page-engine/style.css) with contain-intrinsic-height, so the browser skips their style, layout and paint, and the first frame
// and the first layout rounds cost about the blocks near the view and at the page ends. The height comes from the draft's layout
// cache, where the block's key matched. Culling only shrinks: a block that comes near the view or to a page end draws, and once
// the pages settle the check draws the rest in slices, nearest the view first, so the final layout is the DOM's own
// (Engine.advanceCheck). It never culls text already laid out: on the Word fixture, culling 6,000 drawn paragraphs at once took
// 8 s, and the passes that read inside culled blocks (tabs, line numbers) laid each out on its own. Word's page hints in a .docx
// (w:lastRenderedPageBreak) cull nothing: sharing each page's room among its blocks guessed so far off that a dropped Word file
// showed 3 s later and settled 7 s later; they give the page count until the predictor's.

// The probe of installed fonts that the cache's keys take (layout-cache.mjs keysOf): one object until a font finishes loading.
const PROBE = 'mmmmmmmmmmlli1WQ@#';
const fontsSeen = new Map(); // family → installed
let probe = null;
let env = null;
function envNow() {
  env ??= {
    available(family) {
      let v = fontsSeen.get(family);
      if (v !== undefined) return v;
      probe ??= globalThis.document?.createElement('canvas').getContext('2d') ?? null;
      if (!probe) return true;
      const w = (font) => {
        probe.font = font;
        return probe.measureText(PROBE).width;
      };
      // Installed when it draws the probe unlike both generic families it would fall back to.
      const f = `"${family.replace(/["\\]/g, '')}"`;
      v = ['monospace', 'serif'].some((g) => w(`40px ${f}, ${g}`) !== w(`40px ${g}`));
      fontsSeen.set(family, v);
      return v;
    },
  };
  return env;
}
globalThis.document?.fonts?.addEventListener?.('loadingdone', () => {
  fontsSeen.clear();
  env = null;
});

/** What a Document's editor opens with, before it renders: the heights of its layout cache where a block's key matches (the app
 * stages the draft's cache, layout-cache.mjs stageCache). → {heights, pages, count, src, doc} or null. */
function seedOf(doc) {
  const cache = takeCache();
  const m = cache ? matchCache(doc, cache, envNow()) : null;
  return m?.hits ? { ...m, src: 'cache', doc } : null;
}

/** The blocks culled as a Document opens with `seed` (seedOf): its paragraphs with a seed height past its first three pages (the
 * view opens at the top), not at a page start, not near a float, and none a layout pass reads each layout (layout-cache.mjs
 * readByPasses, and the sections with line numbers). */
function seedCull(doc, seed) {
  if (!seed) return DecorationSet.empty;
  const starts = seed.pages.map(([b]) => b);
  const kids = [];
  const secs = sectionsOf(doc);
  let si = 0;
  doc.forEach((node, pos) => {
    while (si < secs.length - 1 && pos >= secs[si].to) si++;
    kids.push({ node, pos, numbered: !!secs[si].sect.lnNum });
  });
  const top = starts[2] ?? Math.min(kids.length, 60);
  const cull = cullSet(kids.length, { ok: (i) => i >= top && kids[i].node.isTextblock && !kids[i].numbered && !readByPasses(kids[i].node),
    height: (i) => seed.heights[i], float: (i) => holdsFloat(kids[i].node), starts });
  return cullDecos(doc, kids, cull, (i) => seed.heights[i]);
}

/** Blocks `cull` (cullSet) of `kids` ({node, pos} per top-level block of `doc`) culled at `height(i)`: node decorations. */
function cullDecos(doc, kids, cull, height) {
  const decos = [];
  for (let i = 0; i < kids.length; i++) {
    if (!cull[i]) continue;
    const { node, pos } = kids[i];
    // The browser lays a length out in 1/64 px of the zoomed page, rounding or cutting the rest off: a little over the measured
    // height (1/512 px, under half a unit at any zoom up to 400%) lands on the same unit, where the height itself could fall one
    // short (a block 0.02 px short at 78% moved a page end on a .docx's text).
    const h = Math.round((height(i) + 1 / 512) * 1e6) / 1e6;
    decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-pg-cull': '', style: `contain-intrinsic-height:auto ${h}px` }));
  }
  return topLevelSet(doc, decos);
}

/** The culled blocks' decorations `set` after transaction `tr` (to `doc`): mapped, less those of the top-level blocks it changed,
 * whose known height no longer holds (the engine measures them again). */
function mapCull(tr, set, doc) {
  const old = tr.before;
  const n = Math.min(old.childCount, doc.childCount);
  let a = 0;
  while (a < n && old.child(a) === doc.child(a)) a++;
  let b = 0;
  while (b < n - a && old.child(old.childCount - 1 - b) === doc.child(doc.childCount - 1 - b)) b++;
  const mapped = set.map(tr.mapping, doc);
  let from = 0;
  for (let i = 0; i < a; i++) from += doc.child(i).nodeSize;
  let to = from;
  for (let i = a; i < doc.childCount - b; i++) to += doc.child(i).nodeSize;
  const stale = to > from ? mapped.find(from + 1, to - 1) : [];
  return stale.length ? mapped.remove(stale) : mapped;
}

/** The layout cache's record of `view`'s pages (layout-cache.mjs buildCache), or null until they are settled. The app stores it
 * with the draft. */
export const layoutCacheOf = (view) => view?.dom?.pgEngine?.cacheRecord?.() ?? null;

export const Pagination = Extension.create({
  name: 'pagination',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: paginationKey,
      state: {
        init: (_, { doc }) => {
          const seed = seedOf(doc);
          return { counts: [1], page: 1, pages: 1, geo: null, draw: false, anchors: [], after: [], keys: [], shifts: [], splits: [], breaks: [], bodies: null,
            deco: DecorationSet.empty, progress: null, seed, cull: seedCull(doc, seed) };
        },
        apply(tr, value, _, state) {
          const next = tr.getMeta(paginationKey);
          let cull = next && 'cull' in next ? next.cull
            : tr.docChanged && value.cull !== DecorationSet.empty ? mapCull(tr, value.cull, state.doc) : value.cull;
          // Before the first drawn frame a doc equal to the one the editor opened with (a saved undo history replays onto new nodes,
          // app/history.js rebuild) opens from the same seed.
          let { seed } = value;
          if (seed && tr.docChanged && state.doc.content.size === seed.doc.content.size && state.doc.eq(seed.doc)) {
            seed = { ...seed, doc: state.doc };
            cull = seedCull(state.doc, seed);
          }
          if (!next && (!tr.docChanged || !value.draw)) return cull === value.cull && seed === value.seed ? value : { ...value, cull, seed };
          const v = { ...value, seed, ...next, cull };
          const { doc } = state;
          // An anchor stays before its block; one whose block went moves to the start of the block holding it.
          const kept = tr.docChanged ? onBlocks(doc, value.anchors.map((p) => tr.mapping.map(p, -1))) : value.anchors;
          if (next && 'anchors' in next) v.keys = endKeys(kept, value.after, value.keys, v.anchors, v.after);
          if (tr.docChanged) {
            if (!(next && 'anchors' in next)) v.anchors = kept;
            const at = onBlocks(doc, v.shifts.map(([p]) => tr.mapping.map(p, 1)));
            v.shifts = v.shifts.map(([, dy], i) => [at[i], dy]);
            // A split row follows its row; a deleted one goes (the next layout splits whatever row is there).
            v.splits = v.splits.flatMap(([p, k]) => {
              const m = tr.mapping.mapResult(p, 1);
              return m.deleted ? [] : [[m.pos, k]];
            });
          }
          const redraw = !!next && ('anchors' in next || 'draw' in next || 'shifts' in next || 'splits' in next);
          if (!tr.docChanged && !redraw) return v;
          const breaks = breaksOf(doc);
          // A keypress maps the drawn decorations (rebuilding them walks every block); anything that moves a widget off its mapped
          // place, drops one or touches a section break builds them again.
          const mapped = !redraw && tr.before.attrs.sect === doc.attrs.sect && breaks.length === value.breaks.length && breaks.every((b, i) => b === value.breaks[i])
            && v.splits.length === value.splits.length
            && value.anchors.every((p, i) => {
              const r = tr.mapping.mapResult(p, -1);
              return !r.deleted && r.pos === v.anchors[i];
            }) ? value.deco.map(tr.mapping, doc) : null;
          v.deco = mapped && mapped.find().length === value.deco.find().length ? mapped : decorations(doc, v);
          v.breaks = breaks;
          return v;
        },
      },
      props: {
        decorations: (state) => paginationKey.getState(state).deco,
        attributes: { 'data-pg-engine': '2' },
        handleDOMEvents: {
          // Word's white space toggle: a double-click on the gap between pages hides the margins, on the joining line shows them.
          dblclick: (view, e) => {
            if (!e.target?.closest?.('.pg-gap')) return false;
            e.preventDefault();
            options.setWhiteSpace(!options.whiteSpace());
            return true;
          },
        },
      },
      view(view) {
        return new Engine(view);
      },
    }), new Plugin({ pgOwn: true, props: { decorations: (state) => {
      const st = paginationKey.getState(state);
      return blockDecorations(state.doc, !!st?.draw, st?.bodies);
    } } }),
    new Plugin({ pgOwn: true, props: { decorations: (state) => paginationKey.getState(state)?.cull ?? DecorationSet.empty } })];
  },
});

/** One editor's pagination: the frame (passes, measure, publish, layers) and the page widgets' paint. */
class Engine {
  constructor(view) {
    this.view = view;
    this.frame = 0;
    this.model = null; // {pages (plan, blank ones too), real, units, kids}
    this.lines = new WeakMap(); // element → {node, top, h, lines (layout px)}
    this.styles = new WeakMap(); // element → {node, mt, mb, pad, pb}
    this.clones = new WeakMap(); // table element → {key, el}
    this.rowsRead = new WeakMap(); // row element → {node, top, h, dy, v}: its cells' lines (rowOf)
    this.rowsFlat = new WeakMap(); // row element → {node, w, epoch, rel, v}: its read while no page end split it (rowOf)
    this.lineStarts = new WeakMap(); // element → {node, offs: Map line → {want (its top), off}}: where pages start inside it
    this.shownLayers = [];
    this.area = null;
    this.warned = false;
    this.tries = 0; // rounds spent on one doc without settling
    this.spent = 0; // ms those rounds took
    this.doc = null;
    this.relayouts = 0;
    this.published = null;
    this.sheetCss = '';
    this.last = null; // {doc}: the doc of the last round that drew nothing new, while nothing else can have moved the text since
    this.cost = 0; // ms the last frame spent (harness cases read it)
    this.cap = FIRST; // page ends drawn so far: a long document draws its pages from the top, more each frame (progressive)
    this.step = FIRST;
    this.range = null; // {top, bottom}: the layout px band near the view, where sheets and page layers draw
    this.progress = null;
    this.waiters = []; // whenDrawn's promises
    this.plans = []; // where the page ends of the last few rounds fell (layout's cycle check)
    // Culling (seedOf, syncCull): each top-level paragraph's height {h (content box px), sure (the DOM measured it), src}, the culled
    // set as last dispatched (node → h), the check's slice (nodes drawn to be measured) and what the harness reads.
    this.known = new WeakMap();
    this.culled = new Map();
    this.slice = new Set();
    this.checkStep = CHECK;
    this.inputs = null;
    this.pred = null;
    this.seedCount = null;
    this.cacheStats = { src: null, hits: 0, first: null, checked: 0, differed: [], checkFrames: 0 };
    engines.set(view, { paint: (el) => this.paint(el) });
    view.dom.pgEngine = this; // for harness cases and the inspector
    this.schedule = () => {
      if (!this.frame) this.frame = requestAnimationFrame(() => this.measure());
    };
    // A scroll moves the band near the view: sheets and layers there draw, nothing is measured.
    this.viewFrame = 0;
    this.onScroll = () => {
      if (this.frame) this.revealDue = true; // the pending frame reveals first
      else if (!this.viewFrame) this.viewFrame = requestAnimationFrame(() => this.reveal());
    };
    // Something besides the text may have moved it: the next frame reads everything (redo). A change of the layout's inputs (a
    // width, a font, an option, the view, a display setting) also starts the cycle history again (layout's cycle check compares
    // rounds of one set of inputs) and draws every culled block (its size may have changed).
    this.redo = () => {
      this.last = null;
      this.dirty = true;
      this.schedule();
    };
    this.relayout = () => {
      this.plans = [];
      this.culler.clear();
      this.redo();
    };
    this.culler = new Culler(view);
    this.areaWatch = new MutationObserver(this.relayout);
    // Word's display settings on the editor area (App.jsx) and the markup view on the editor (tracking) change the text's size.
    this.areaWatch.observe(view.dom, { attributes: true, attributeFilter: ['data-markup'] });
    // The text's own height follows the page ends this engine draws: only a new width is a new input.
    this.resize = new ResizeObserver((es) => {
      const w = es.at(-1)?.contentRect.width;
      // A height this engine's own last writes gave the text needs no new read: that round's frame reads again anyway. Consumed
      // here, so a later resize from outside (a picture loading) still reads again.
      if (w === this.width) {
        if (!this.wroteSize) this.redo();
        this.wroteSize = false;
        return;
      }
      this.width = w;
      this.relayout();
    });
    this.resize.observe(view.dom);
    view.dom.ownerDocument.fonts?.addEventListener?.('loadingdone', this.relayout);
    this.onVisibility = () => this.waiters.length && this.pump();
    view.dom.ownerDocument.addEventListener('visibilitychange', this.onVisibility);
    // Before the document's first style pass (geometry.js overlayElement says why).
    if (!view.dom.closest('[data-story]')) overlayElement(view);
    this.guessSheet();
    this.unsubscribe = onLayoutChange(this.relayout);
    // A font that finishes loading changes the paragraphs' heights: none known holds (culling measures them again).
    this.onFonts = () => {
      this.known = new WeakMap();
      this.relayout();
    };
    view.dom.ownerDocument.fonts?.addEventListener?.('loadingdone', this.onFonts);
    views.add(this.relayout);
    this.relayout();
  }

  update(v, prev) {
    // A layer's key(state, page) may read any plugin's state, so a meta-only change to one redraws too. Pagination's own meta is
    // left out: the frame that dispatched it is still running.
    const doc = v.state.doc !== prev.doc;
    const other = v.state.plugins.some((p) => p.spec.key !== paginationKey && p.getState(v.state) !== p.getState(prev));
    // Without a text change, a plugin's change (its decorations) is the only thing that can have moved the text. New decorations
    // are new layout inputs: the cycle history starts again (a view setting toggled back would match a plan of the old one).
    // A transaction of this engine's (its meta changes its state) is not one: what other plugins change with it follows the layout.
    const own = paginationKey.getState(v.state) !== paginationKey.getState(prev);
    if (other && !doc) {
      this.last = null;
      if (!own) {
        const [a, b] = [decoSets(v.state), decoSets(prev)];
        if (a.length !== b.length || a.some((d, i) => !sameSet(d, b[i]))) this.plans = [];
      }
    }
    // The doc's attributes hold its styles, page setup and settings: every culled block may have another size.
    if (doc && v.state.doc.attrs !== prev.doc.attrs) this.culler.clear();
    if (doc || other || !v.state.selection.eq(prev.selection)) this.schedule();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.viewFrame);
    this.area?.removeEventListener('scroll', this.onScroll);
    this.resize.disconnect();
    this.areaWatch.disconnect();
    this.culler.destroy();
    this.view.dom.ownerDocument.fonts?.removeEventListener?.('loadingdone', this.relayout);
    this.view.dom.ownerDocument.removeEventListener('visibilitychange', this.onVisibility);
    this.unsubscribe();
    this.view.dom.ownerDocument.fonts?.removeEventListener?.('loadingdone', this.onFonts);
    views.delete(this.relayout);
    this.release();
  }

  /** Resolves whenDrawn's promises. */
  release() {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  /** Whether pages are drawn: Print Layout and Focus show them (the editor area's data-word-view; absent is today's view). */
  wanted() {
    if (!this.area) {
      this.area = this.view.dom.closest('#editor-area');
      if (this.area) {
        this.areaWatch.observe(this.area, { attributes: true, attributeFilter: ['data-word-view', 'data-marks', 'data-field-codes'] });
        this.area.addEventListener('scroll', this.onScroll, { passive: true });
      }
    }
    return !this.area?.dataset.wordView || VIEWS.has(this.area.dataset.wordView);
  }

  /** The band near the view in layout px (two screens above and below the editor area's), from the editor's box `r0` at zoom
   * `z`: sheets and page layers outside it are not drawn. */
  band(r0, z) {
    const a = (this.area ?? this.view.dom.ownerDocument.documentElement).getBoundingClientRect();
    const h = (a.bottom - a.top) / z;
    return { top: (a.top - r0.top) / z - 2 * h, bottom: (a.bottom - r0.top) / z + 2 * h };
  }

  /** Whether page `p` (a PageBox or a planned page) is near the view; every page of a document up to WHOLE pages is. */
  near(p) {
    const r = this.range;
    return !r || testHook('sheetsAll') || (this.model?.real.length ?? 0) <= WHOLE || (p.top + p.box.h >= r.top && p.top <= r.bottom);
  }

  /** Culls the blocks more than a screen beyond the band near the view (wp/page-engine/cull.js), at a frame's start, where the
   * browser has laid the text out and reading their sizes costs nothing. A document drawn whole (up to WHOLE pages, or the harness's
   * sheetsAll) culls nothing. Off unless switched on (CULL). */
  cull() {
    const { model: m, range: r } = this;
    if (!CULL() || !m || !r || m.real.length <= WHOLE || testHook('sheetsAll')) return this.culler.clear();
    const h = (r.bottom - r.top) / 5; // a screen: the band is five
    // ponytail: CULL_STEP blocks a frame, so a first cull of the Word fixture's 10,000 blocks spreads over a few frames.
    this.culler.cull(m.kids, m.keep, { top: r.top - h, bottom: r.bottom + h }, scaleOf(this.view), CULL_STEP);
  }

  /** After a scroll: the band moved, so sheets show or hide and the layers of pages that came near draw. Two reads, no measure.
   * With a pagination frame pending, that frame does it first (`inFrame`, before its layers). */
  reveal(inFrame = false) {
    this.viewFrame = 0;
    const { view, model: m } = this;
    if (this.frame && !inFrame) {
      this.revealDue = true;
      return;
    }
    if (!m || !view.dom.isConnected || view.isDestroyed) return;
    const r0 = view.dom.getBoundingClientRect();
    const range = this.band(r0, scaleOf(view));
    this.range = range;
    // Less than half a screen moved since the sheets were drawn (a layout round reads the band without drawing them all): every
    // page that could come into view is drawn already.
    const was = this.sheetsRange;
    if (was && Math.abs(range.top - was.top) < (range.bottom - range.top) / 10) return;
    this.sheetsRange = range;
    // Culled blocks that came near draw (one the browser finds in view before this draws itself: content-visibility: auto); those
    // left far behind are culled (reads first: a scroll leaves the layout clean).
    if (!inFrame) this.cull();
    this.culler.release(m.kids, (i) => m.kids[i].bottom >= range.top && m.kids[i].top <= range.bottom);
    for (const el of view.dom.querySelectorAll(':scope > .pg-pages > .pg-page')) if (el.pgPage) this.sheetOf(el, el.pgPage);
    if (!inFrame) this.syncLayers();
    // Blocks that came near the view draw (culling; a frame's own layout does it in its round): one culled at a height the DOM
    // had not measured may move the text below it.
    if (!inFrame && this.syncCull()) this.relayout();
  }

  /** Draws page `index`'s sheet and layers whatever the band (a page copy of it is about to be made: pageClone). A page the
   * progressive layout has not drawn yet has only its plan (no page end widgets hold its text in place): with `now` the pages up
   * to it are laid out first, at once (print's last resort); else the progressive layout is asked to reach it soon and this
   * answers false (the copy waits). → whether the page is drawn. */
  ensurePage(index, now = false) {
    const { view, model: m } = this;
    let geo = paginationKey.getState(view.state).geo;
    if (!m || !geo?.pages[index]) return true;
    let r = geo.pages.slice(0, index + 1).filter((p) => !p.blank).length - 1;
    if (m.shown < m.real.length && r + 2 > m.shown) {
      if (!now) {
        this.cap = Math.max(this.cap, r + 2);
        this.last = null;
        this.schedule();
        return false;
      }
      this.settleTo(r + 2);
      geo = paginationKey.getState(view.state).geo;
      if (!geo?.pages[index]) return true;
      r = geo.pages.slice(0, index + 1).filter((p) => !p.blank).length - 1;
    }
    if (!geo.pages[index].blank) this.syncLayers(new Set([r]));
    return true;
  }

  /** Every page laid out and drawn, with the 'after' passes run on the result (print and PDF wait on it before copying pages):
   * the frames lay the rest out at their own pace, so the window keeps answering. A hidden window runs no frames (Electron throttles
   * background windows): its frames run from tasks instead (pump), each within the frame's budget. After `ms` without an end, the
   * rest is laid out at once (a last resort: it freezes the window on a long document). → a promise that resolves when done, the
   * guard gives up or the view goes. */
  whenDrawn(ms = 30000) {
    const m = this.model;
    if (!m || this.done()) return Promise.resolve();
    this.cap = Math.max(this.cap, m.real.length);
    this.last = null;
    this.schedule();
    this.pump();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        // Its waiter goes with it: left in the list, pump() went on running frames at full speed in a hidden window.
        this.waiters = this.waiters.filter((w) => w !== done);
        if (!this.view.isDestroyed && this.view.dom.isConnected) this.settleTo(this.model?.real.length ?? 0);
        resolve();
      }, ms);
      this.waiters.push(done);
    });
  }

  /** While whenDrawn waits in a hidden window, runs the frame from a task at a time: a message on a channel, which background
   * windows do not throttle as they do timers (once a second, or a minute). A visible window's frames take over. */
  pump() {
    const d = this.view.dom.ownerDocument;
    if (this.pumping || d.visibilityState !== 'hidden') return;
    this.pumping = new MessageChannel();
    const step = () => {
      if (!this.waiters.length || d.visibilityState !== 'hidden' || this.view.isDestroyed) {
        this.pumping = null;
        return;
      }
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.measure();
      this.pumping?.port2.postMessage(0);
    };
    this.pumping.port1.onmessage = step;
    this.pumping.port2.postMessage(0);
  }

  /** Whether every page is drawn, the layout settled (or given up) and the 'after' passes ran on it. */
  done() {
    return !!this.progress?.settled && !this.afterDue && !this.layersLeft && this.cap >= (this.model?.real.length ?? 0);
  }

  /** Lays the pages out now, without waiting for frames, until at least `n` page ends are drawn (twice as many as are drawn, so a
   * print that copies every page in turn settles a few times, not once per page) and a round changes nothing. */
  settleTo(n) {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.cap = Math.max(this.cap, n, this.cap * 2);
    this.last = null;
    for (let i = 0; i < 40; i++) {
      if (!this.layout()) break;
      this.cap = Math.max(this.cap, Math.min(n, this.model?.real.length ?? n)); // the plan's page count can move as pages draw
    }
    this.publish();
    this.schedule(); // the passes, progress and the rest of the pages in the next frame
  }

  measure() {
    const t0 = performance.now();
    this.frame = 0;
    this.wroteSize = false;
    const { view } = this;
    if (!view.dom.isConnected || view.isDestroyed || view.dom.closest('[data-story]')) return;
    const draw = this.wanted() && !!view.state.doc.attrs.sect;
    if (paginationKey.getState(view.state).draw !== draw) {
      view.dispatch(view.state.tr.setMeta(paginationKey, draw ? { draw } : { draw, anchors: [], after: [], shifts: [], splits: [], geo: null, counts: [1], pages: 1, page: 1,
        cull: DecorationSet.empty }).setMeta('addToHistory', false));
      if (!draw) this.culled = new Map();
    }
    if (!draw) {
      this.model = null;
      this.last = null;
      this.culler.clear();
      this.sheet(null);
      this.release();
      return;
    }
    this.takeSeed();
    // What the first frame lays out: the top-level blocks, and those culled from the start (the layout cache's harness check).
    this.cacheStats.first ??= { blocks: view.state.doc.childCount, culled: view.dom.querySelectorAll(':scope > [data-pg-cull]').length };
    this.startPredictor();
    if (view.state.doc !== this.doc) {
      this.doc = view.state.doc;
      this.tries = 0;
      this.spent = 0;
      this.plans = [];
    }
    let settled = true;
    // While the pages are still being drawn (progressive), the 'after' passes wait for the last of them: each measures the whole
    // document (line numbers, note areas, layout fields, mirrored indents) and would run once per frame for the same result.
    const growing = !testHook('pagesAll') && this.cap < (this.model?.real.length ?? 0);
    if (this.revealDue) {
      this.revealDue = false;
      this.reveal(true); // a scroll while this frame was pending
    }
    // The 'after' passes of the layout the last frame published, and the page layers it changed, run first: the browser has drawn
    // that layout since, so their reads cost nothing. Run after this frame's writes (plan.md §1.9's first frame order), the first
    // read of each laid the whole document out again, about a second per frame on the Word fixture. A pass that moves text
    // makes the measure below lay the pages out again (passes() clears `last`).
    if (this.afterDue && !growing) {
      this.afterDue = false;
      this.afterSeen = { doc: view.state.doc, version: this.relayouts };
      this.passes('after');
      // Passes that took a frame's budget leave the layers and the layout round to the next frame: on the Word fixture the two
      // together held the window for 300 to 400 ms (fields, notes, tabs, then a whole layout).
      if (performance.now() - t0 > BUDGET) {
        this.schedule();
        this.cost = performance.now() - t0;
        return;
      }
    }
    this.cull();
    this.syncLayers(null, LAYER_BUDGET);
    this.layersSeen = { state: view.state, version: this.relayouts };
    const { capped } = runFrame({
      before: () => this.passes('before'),
      measure: () => {
        settled = false;
        // A frame that keeps finding a different layout (a block pushed to and fro) stops after 40 tries per doc version. Engine 1
        // settled per-page counts on the largest seen; engine 2 draws page ends at blocks and lines, where no largest exists, so it
        // keeps the last whole layout instead (every round draws whole pages). Each round after the first lays the document out
        // again, so a frame stops once it has spent its budget and carries on in the next.
        for (let i = 0; i < 6 && !this.givenUp(); i++) {
          if (!this.unobserved(() => this.layout())) {
            settled = true;
            break;
          }
          this.tries++;
          if (performance.now() - t0 > BUDGET) break;
        }
        // Once per state, not per doc: what changes the text without an edit (float-layout's measure once the pages settle, a field
        // pass) still moves it after the guard, and the sheets stayed where the text was before.
        if (this.givenUp() && this.followed !== view.state) {
          this.followed = view.state;
          this.follow();
        }
        this.publish();
      },
      after: () => false, // next frame, first (above)
    });
    if (!settled) this.spent += performance.now() - t0;
    // Settled with only the first pages drawn: twice as many next frame. A frame that adds page ends pays a restyle of the whole
    // text once whatever their number (a document holding MathML restyles every child of a parent that gains one: Chromium's
    // MathML sheet has a sibling rule), so fewer, larger steps finish sooner. A page end that keeps moving (a block pushed to and
    // fro) stays as last drawn after a few rounds, as the 40-round guard does for a whole layout.
    const total = this.model?.real.length ?? 0;
    if ((settled || this.tries >= 3 || this.givenUp()) && this.cap < total) {
      this.step = Math.min(STEP_MAX, this.step * 2);
      this.cap = Math.min(total, this.cap + this.step);
      this.last = null; // more page ends to draw: the keypress path would keep the pages as they are
      this.tries = 0;
      this.spent = 0;
      settled = false;
    } else if ((capped || (!settled && this.givenUp())) && !this.warned) {
      this.warned = true;
      console.warn('pagination: the layout kept changing; the last layout stays');
    }
    // Every page drawn and settled, or kept by the guard: the check draws its next slice of blocks culled at a height the DOM has
    // not measured. A layout the guard kept still draws every block, so no culled block outlives the open.
    if ((settled || this.givenUp()) && this.cap >= total && this.advanceCheck()) settled = false;
    this.report(settled);
    // The 'after' passes are due once the pages are all drawn and the text or the geometry changed since they last ran; the
    // layers once anything a layer key may read changed. Both run at the next frame's start.
    const seen = this.afterSeen;
    if (!growing && this.cap >= total && (!seen || seen.doc !== view.state.doc || seen.version !== this.relayouts)) this.afterDue = true;
    const layersDue = this.layersLeft || this.layersSeen.state !== view.state || this.layersSeen.version !== this.relayouts;
    if ((!settled && !this.givenUp()) || this.afterDue || layersDue) this.schedule(); // carry on next frame
    if (this.waiters.length && this.done()) this.release();
    this.cost = performance.now() - t0;
  }

  /** `fn()` with ProseMirror's DOM observer paused while the pages are still being laid out: a round's writes (page end widgets'
   * sizes and numbers, cuts, sheets, layers) are no edits, and the observer read each as a mutation record on its next flush (20
   * to 75 ms a frame on the Word fixture). Once settled a keypress writes a few, and the pause itself cost about 2 ms of it. */
  unobserved(fn) {
    if (this.progress?.settled) return fn();
    const obs = this.view.domObserver;
    obs?.stop?.();
    try {
      return fn();
    } finally {
      obs?.start?.();
    }
  }

  /** Whether this doc's layout keeps changing past the guard: 40 rounds, or a few rounds that took MAX_UNSETTLED ms on a long
   * document whose rounds take seconds (flowing columns that a page end moves, and that move it back). The last layout stays. */
  givenUp() {
    return this.tries >= 40 || (this.tries >= 3 && this.spent > MAX_UNSETTLED);
  }

  /** The layout's progress in the plugin state for the open progress card (plan state `progress`): {done (pages drawn), estimate
   * (Word's saved page count when the import stored one, else null), settled (every page drawn and no round left: the layout
   * settled, or kept changing until the guard kept it)}. */
  report(settled) {
    const { view } = this;
    const total = this.model?.real.length ?? 0;
    const done = Math.min(this.model?.shown ?? 0, total);
    // The estimate: the predictor's page count once it has laid the document out, else the layout cache's or Word's hints'.
    const estimate = this.pred?.version ? this.pred.count : this.seedCount ?? hintCount(view.state.doc);
    const p = { done, estimate, settled: (settled || this.givenUp()) && done >= total };
    const was = this.progress;
    if (was && was.done === p.done && was.estimate === p.estimate && was.settled === p.settled) return;
    this.progress = p;
    view.dispatch(view.state.tr.setMeta(paginationKey, { progress: p }).setMeta('addToHistory', false));
  }

  // ---------- culling (see "culling and the layout cache" above) ----------

  /** The heights the editor opened with (plugin state `seed`, seedOf) become known heights at the first drawn frame, and the state
   * lets them go. The pages still draw from the top a few more each frame (progressive): every page end at once took 7 s in one
   * frame on the Word fixture (its page ends' own reads and widgets, not the text's layout). */
  takeSeed() {
    const { view } = this;
    const seed = paginationKey.getState(view.state)?.seed;
    if (!seed) return;
    // By node: a block changed since the editor opened is a new node, which the seed's height does not reach.
    seed.doc.forEach((node, _, i) => {
      if (seed.heights[i] >= 0) this.known.set(node, { h: seed.heights[i], sure: false, src: seed.src });
    });
    this.seedCount = seed.count || null;
    this.cacheStats.src = seed.src;
    this.cacheStats.hits = seed.hits ?? 0;
    this.cacheStats.misses = seed.from ? [...seed.from].flatMap((j, i) => (j < 0 ? [i] : [])).slice(0, 20) : [];
    // The blocks the editor opened culled (seedCull), so the first rounds know which they draw again.
    const decos = paginationKey.getState(view.state).cull.find();
    let j = 0;
    view.state.doc.forEach((node, pos) => {
      while (j < decos.length && decos[j].from < pos) j++;
      const h = this.known.get(node)?.h;
      if (decos[j]?.from === pos && h != null) this.culled.set(node, h);
    });
    view.dispatch(view.state.tr.setMeta(paginationKey, { seed: null }).setMeta('addToHistory', false));
  }

  /** The layout predictor of this view (layout/index.js), started with the first drawn frame: its page count is the progress card's
   * estimate, and the DOM's heights that differ from its own go back to it. */
  startPredictor() {
    if (this.pred !== null) return;
    this.pred = false;
    if (testHook('noPredictor') || typeof Worker === 'undefined') return;
    try {
      this.pred = predictor(this.view);
    } catch {
      return;
    }
    this.pred.ready.catch(() => {
      this.pred = false;
    });
    this.pred.addEventListener('change', () => this.fromPredictor());
  }

  /** A predictor layout: its page count becomes the progress card's estimate (a frame publishes it), and on its first layout of
   * the current doc the paragraphs the DOM measured at another height are reported to it (correct: it keeps the DOM's figure until
   * the block changes; measureKnown reports the ones measured after). It moves no text, so no layout runs for it. */
  fromPredictor() {
    const { view, pred: p } = this;
    if (!p || view.isDestroyed) return;
    const { doc } = view.state;
    if (!this.toldAll && p.current && p.heights.length === doc.childCount) {
      this.toldAll = true;
      doc.forEach((node, _, i) => {
        const k = this.known.get(node);
        if (k) this.tell(i, k);
      });
    }
    if (this.progress && this.progress.estimate !== p.count) this.schedule();
  }

  /** The DOM's height of each drawn top-level paragraph it has not measured yet (its content box, unrounded), from read `R` with
   * the page frames drawn now (`frames`). A paragraph reaching into a page end's band (from its cut to the next page's text) is
   * left: the band's floats push its lines down. A culled block's height is the one it was given. One that differs from the
   * height it was culled at is counted (the harness reads cacheStats). */
  measureKnown(R, frames) {
    const { kids, z } = R;
    // The bands the page widgets' floats hold, in layout px, in order: the first page's top pusher, then each page end's.
    const bands = [[-Infinity, frames[0]?.contentTop ?? 0]];
    for (let k = 1; k < frames.length; k++) if (Number.isFinite(frames[k - 1].cut)) bands.push([frames[k - 1].cut, frames[k].contentTop]);
    let b = 0;
    for (let i = 0; i < kids.length; i++) {
      const { el, node, top, bottom } = kids[i];
      while (b < bands.length && bands[b][1] <= top + 0.5) b++;
      if (!node.isTextblock || el.hasAttribute('data-pg-cull')) continue;
      const k = this.known.get(node);
      if (this.sure(k)) continue;
      if (b < bands.length && bands[b][0] < bottom - 0.5) continue;
      // ponytail: its content height is its box less its computed padding and borders, which the browser rounds to its own units
      // at a zoom; read getComputedStyle(el).height if a padded paragraph ever lands a unit off.
      // Its own computed padding and borders, not this.style's cache: that one is read where the engine needs it, and filling it
      // for every block here, before the page ends draw, changed where a few page ends fell (perf-core's whole layout check).
      const cs = getComputedStyle(el);
      const edge = (k) => (parseFloat(cs[`padding${k}`]) || 0) + (parseFloat(cs[`border${k}Width`]) || 0);
      const box = el.getBoundingClientRect().height / z;
      const h = box - edge('Top') - edge('Bottom');
      if (k && this.slice.has(node)) {
        this.cacheStats.checked++;
        if (Math.abs(k.h - h) > 0.5) this.cacheStats.differed.push(i);
      }
      const known = { h, box, sure: true, src: 'dom', epoch: this.epoch };
      this.known.set(node, known);
      this.tell(i, known);
    }
  }

  /** Whether known height `k` was measured by the DOM under the line ratios in use now. */
  sure(k) {
    return !!k?.sure && k.epoch === this.epoch;
  }

  /** Reports block `i`'s DOM height (known `k`) to the predictor when its own differs, once (it keeps the DOM's figure). */
  tell(i, k) {
    const p = this.pred;
    if (!p?.current || !this.sure(k) || k.told || p.heights.length !== this.view.state.doc.childCount || !(Math.abs(k.box - p.heights[i]) > 0.5)) return;
    k.told = true;
    p.correct(i, k.box);
  }

  /** Keeps culled what cullSet allows for the model's page plan, of the blocks culled now (culling only shrinks): outside the band
   * near the view, not at a page end and not in the check's slice. → true when it drew a block culled at a height the DOM had not
   * measured (its real height may move the text). */
  syncCull() {
    const { view, model: m } = this;
    if (!this.culled.size) return false; // culling only shrinks: nothing culled, nothing to do (a keypress's rounds)
    if (!m || testHook('noCull')) return this.setCull(new Map());
    const { kids, real, units } = m;
    if (kids.length !== view.state.doc.childCount) return false;
    const starts = [];
    for (const p of real.slice(1)) {
      const u = units[p.firstUnit];
      if (u && u.child !== starts.at(-1)) starts.push(u.child);
    }
    const r = this.range;
    const cull = cullSet(kids.length, {
      ok: (i) => this.culled.has(kids[i].node) && !this.slice.has(kids[i].node) && !(r && kids[i].bottom >= r.top && kids[i].top <= r.bottom),
      height: (i) => this.known.get(kids[i].node)?.h ?? NaN,
      float: (i) => holdsFloat(kids[i].node),
      starts,
    });
    const want = new Map();
    for (let i = 0; i < kids.length; i++) if (cull[i]) want.set(kids[i].node, this.known.get(kids[i].node).h);
    return this.setCull(want);
  }

  /** Dispatches the culled set `want` (node → height) when it changed. → true when it drew a block culled at an unsure height. */
  setCull(want) {
    const was = this.culled;
    if (want.size === was.size && [...want].every(([node, h]) => was.get(node) === h)) return false;
    let unsure = false;
    for (const node of was.keys()) if (!want.has(node) && !this.sure(this.known.get(node))) unsure = true;
    this.culled = want;
    const { view } = this;
    const { doc } = view.state;
    const kids = [];
    doc.forEach((node, pos) => kids.push({ node, pos }));
    const set = cullDecos(doc, kids, kids.map((k) => (want.has(k.node) ? 1 : 0)), (i) => want.get(kids[i].node));
    view.dispatch(view.state.tr.setMeta(paginationKey, { cull: set }).setMeta('addToHistory', false));
    return unsure;
  }

  /** The check: once the pages settle, the next slice of blocks culled at a height the DOM has not measured (the layout cache's,
   * the predictor's) draws, nearest the view first; the next round measures them (measureKnown) and the pages lay
   * out again where one differed. → true while blocks are left to check. */
  advanceCheck() {
    const m = this.model;
    if (!m || testHook('noCull') || (!this.culled.size && !this.slice.size)) return false;
    // ponytail: a fixed doubling; sizing a slice by its frame's cost shrank it to a few blocks on the Word fixture, whose rounds cost
    // a few hundred ms whatever the slice. Time the browser's layout of a slice if a slice of CHECK_MAX ever runs long.
    if (this.slice.size) this.checkStep = Math.min(this.checkStep * 2, CHECK_MAX);
    this.slice = new Set();
    const { kids } = m;
    const left = [];
    kids.forEach((kid, i) => {
      if (this.culled.has(kid.node) && !this.sure(this.known.get(kid.node))) left.push(i);
    });
    // Each slice stays drawn (culling only shrinks), so the check ends; the cap is a guard.
    if (!left.length || this.cacheStats.checkFrames >= CHECK_FRAMES) {
      this.syncCull();
      return false;
    }
    const mid = this.range ? (this.range.top + this.range.bottom) / 2 : 0;
    left.sort((a, b) => Math.abs(kids[a].top - mid) - Math.abs(kids[b].top - mid));
    for (const i of left.slice(0, this.checkStep)) this.slice.add(kids[i].node);
    this.cacheStats.checkFrames++;
    this.syncCull();
    // The cycle check's plans stay: the Word fixture has a page end that goes to and fro, which it ends in a few rounds, and each
    // slice would start that over.
    [this.last, this.tries, this.spent] = [null, 0, 0];
    return true;
  }

  /** The layout cache's record of this layout (layout-cache.mjs buildCache), once the pages are settled: each paragraph's height
   * as the DOM measured it, and the page starts and count. */
  cacheRecord() {
    const { view, model: m } = this;
    const { doc } = view.state;
    if (!m || !this.progress?.settled || m.kids.length !== doc.childCount) return null;
    const heights = [];
    doc.forEach((node) => {
      const k = this.known.get(node);
      heights.push(this.sure(k) ? k.h : null);
    });
    const pages = [];
    for (const p of m.real.slice(1)) {
      const u = m.units[p.firstUnit];
      if (u) pages.push([u.child, p.firstLine]);
    }
    return buildCache(doc, { env: envNow(), heights, pages, count: m.pages.length });
  }

  /** Whether the inputs every block's height depends on changed (styles, theme, lists, settings, a section's page setup): then no
   * height known holds, and every block draws and is measured again. */
  inputsChanged(doc) {
    if (this.inputsDoc === doc) return false; // a round of the same doc: nothing to compare
    this.inputsDoc = doc;
    const now = [doc.attrs.styles, doc.attrs.theme, doc.attrs.numbering, doc.attrs.settings, doc.attrs.sect, ...breaksOf(doc).map((b) => b.attrs.sect)];
    const was = this.inputs;
    this.inputs = now;
    return !!was && (was.length !== now.length || now.some((x, i) => x !== was[i]));
  }

  passes(phase) {
    let moved = false;
    for (const p of passes(phase)) {
      try {
        if (p.run(this.view) === true) {
          moved = true;
          this.last = null;
          this.why = [...(this.why ?? []), p.id];
        }
      } catch (e) {
        console.error(`layout pass ${p.id}:`, e);
      }
    }
    return moved;
  }

  // ---------- reading ----------

  /** The text's units in layout px: top-level blocks, a split table's rows, breaks → {units, kids, scale, top} or null mid-update. */
  read() {
    const { view } = this;
    const { doc } = view.state;
    // Blocks, and before each (and after the last) the flow widgets that sit in front of it.
    const els = [];
    const before = [[]];
    for (const el of view.dom.children) {
      if (!el.classList.contains('ProseMirror-widget')) {
        els.push(el);
        before.push([]);
      } else if (el.matches(FLOW_WIDGETS)) before.at(-1).push(el);
    }
    if (els.length !== doc.childCount) return null;
    this.culler.check(els, doc, scaleOf(view)); // writes, before the reads
    const r0 = view.dom.getBoundingClientRect();
    const z = scaleOf(view);
    this.range = this.band(r0, z);
    const secs = sectionsOf(doc);
    const units = [];
    const kids = [];
    // Every top-level box in DOM order (blocks and flow widgets): a page end goes before one of them. `after`: the box follows a
    // flow widget at its own position, so a page end before it is drawn after that widget (decorations: side 2).
    const items = [];
    let si = 0;
    const widgets = (list, pos, i) => {
      for (const el of list) {
        const top = el.offsetTop;
        const bottom = top + el.offsetHeight;
        const item = { el, node: null, pos, top, bottom, widget: true, after: false, u0: units.length, u1: units.length + 1 };
        units.push({ child: i, item: items.length, el, node: null, pos, top, bottom, section: si, table: null, header: false, keepNext: false,
          keepLines: false, widow: false, breakBefore: false, kind: 'text', widget: true });
        items.push(item);
      }
    };
    doc.forEach((node, pos, i) => {
      while (si < secs.length - 1 && pos >= secs[si].to) si++;
      widgets(before[i], pos, i);
      const el = els[i];
      // A block out of the flow (float-layout's Behind and In Front of Text place it absolutely) takes no room in it: it stands
      // at the end of the box before it. Read where it is drawn (on the Word fixture, pages from its place) it was the first
      // block below every page end down to there, and each of those pages took its flow start from the block before it.
      const out = this.outOfFlow(el, node);
      const top = out ? items.at(-1)?.bottom ?? 0 : el.offsetTop;
      const bottom = out ? top : top + el.offsetHeight;
      const kid = { el, node, pos, top, bottom, u0: units.length, after: !!before[i].length };
      kids.push(kid);
      const base = { child: i, item: items.length, el, node, pos, top, bottom, section: si, table: null, header: false, keepNext: false, keepLines: false, widow: false, breakBefore: false };
      items.push(kid);
      const name = node.type.name;
      // A framed paragraph placed down the page by its text (w:framePr, vAnchor text) is a paragraph of the flow to Word: where its
      // frame does not fit below its place, it starts the next page and the text after it follows (Word fixture page 140, the
      // Styles Format Frame case). Its height (hold) has to fit; it still takes no room from the text beside it.
      const hold = out && el.dataset.flKind === 'frame' && !el.hasAttribute('data-fl-page') ? el.offsetHeight : 0;
      if (out) units.push({ ...base, kind: 'block', out, ...(hold && { hold }) });
      else if (name === 'pageBreak') units.push({ ...base, kind: 'break', start: 'page' });
      else if (name === 'sectionBreak' && startOf(node.attrs.kind, secs[si].sect, secs[si + 1]?.sect) !== 'none') {
        units.push({ ...base, kind: 'break', start: startOf(node.attrs.kind, secs[si].sect, secs[si + 1]?.sect), section: Math.min(si + 1, secs.length - 1) });
      } else if (name === 'table' && !el.querySelector(':scope > table[data-whole]')) {
        // Rows are grids of their own (document.css): one that cannot split moves whole, any other splits between lines (rowOf).
        const trs = el.querySelectorAll(':scope > table > tbody > tr');
        const dy = dyOf(el);
        // A culled table's rows are where they were drawn in it (reading them would lay the table out again).
        const et = (el.getBoundingClientRect().top - r0.top) / z;
        const kept = el.pgCull && el.pgRows?.node === node ? el.pgRows.rows : null;
        const drawn = [];
        node.forEach((row, off, r) => {
          const tr = trs[r];
          if (!tr) return;
          const rr = kept?.[r] ? { top: r0.top + (et + kept[r].top) * z, bottom: r0.top + (et + kept[r].bottom) * z, width: kept[r].width } : tr.getBoundingClientRect();
          drawn.push({ top: (rr.top - r0.top) / z - et, bottom: (rr.bottom - r0.top) / z - et, width: rr.width });
          // Word keeps a row with the next one when every paragraph in it keeps with next.
          let keepNext = true;
          row.descendants((d) => {
            if (d.isTextblock && !keepsOf(doc, d).keepNext) keepNext = false;
            return keepNext && !d.isTextblock;
          });
          const split = rowSplits(row.attrs);
          units.push({ ...base, kind: split ? 'text' : 'block', row: split, el: tr, node: row, pos: pos + 1 + off, top: (rr.top - r0.top) / z - dy,
            bottom: (rr.bottom - r0.top) / z - dy, table: i, header: !!row.attrs.header, keepNext, w: Math.round(rr.width / z) });
        });
        if (!el.pgCull) el.pgRows = { node, rows: drawn };
        if (units.length === kid.u0) units.push({ ...base, kind: 'block' });
      } else if (name === 'columnBreak') units.push({ ...base, kind: 'break', start: 'page' }); // one column: a page break (index-layout.md 178)
      else if (name === 'columns') {
        // Flowing columns split by rows, one per page (linesOf); columns that fit their page move whole. Their width is read
        // here, with the rest, for rowStarts: read after the round's writes it laid the whole document out again.
        units.push({ ...base, kind: el.pgCols?.mode === 'flow' ? 'text' : 'block', cols: true, cw: el.clientWidth });
      } else if (node.isTextblock) units.push({ ...base, kind: 'text', ...keepsOf(doc, node) });
      else if (this.boxed(el, node)) units.push({ ...base, kind: 'block' });
      else if (!this.inner(el, node, base, units, r0, z)) units.push({ ...base, kind: 'text' });
      kid.u1 = units.length;
    });
    widgets(before[doc.childCount], doc.content.size, doc.childCount);
    // How far the text reaches right of its column (an indent past the paper's edge), for the breakers' margin boxes.
    const reach = Math.max(0, view.dom.scrollWidth - view.dom.clientWidth);
    return { units, kids, items, z, top: r0.top, reach, column: view.dom.clientWidth };
  }

  /** The blocks inside container `el` (a content control, a field block: a node of blocks that is no formatting context) as units
   * of their own, each with its box, margins and keep rules, as Word lays a content control's paragraphs out with the rest of the
   * text: read as one unit, the space between them went with the page end that fell there and the page ends never settled.
   * The page widgets stay before the container, whose floats reach its blocks. → false when it holds no block to descend to. */
  inner(el, node, base, units, r0, z) {
    const desc = el.pmViewDesc;
    if (!node.firstChild?.isBlock || desc?.node !== node || !desc.children?.some((c) => c.node)) return false;
    const { doc } = this.view.state;
    const dy = dyOf(el);
    const n0 = units.length;
    const walk = (d, pos) => {
      for (const c of d.children) {
        const n = c.node;
        const dom = c.nodeDOM ?? c.dom;
        const at = pos;
        pos += c.size;
        if (!n || dom?.nodeType !== 1) continue;
        if (this.outOfFlow(dom, n)) {
          const y = units.at(-1)?.bottom ?? base.top;
          units.push({ ...base, el: dom, node: n, pos: at, top: y, bottom: y, inner: true, kind: 'block', out: true });
          continue;
        }
        if (!n.isTextblock && !this.boxed(dom, n) && n.firstChild?.isBlock && c.children?.some((k) => k.node)) {
          walk(c, at + c.border);
          continue;
        }
        const r = dom.getBoundingClientRect();
        units.push({ ...base, el: dom, node: n, pos: at, top: (r.top - r0.top) / z - dy, bottom: (r.bottom - r0.top) / z - dy, inner: true,
          ...(n.isTextblock ? { kind: 'text', ...keepsOf(doc, n) } : { kind: this.boxed(dom, n) ? 'block' : 'text' }) });
      }
    };
    walk(desc, base.pos + desc.border);
    return units.length > n0;
  }

  /** Whether `el` is a formatting context, which moves below a page end whole (document.css: objects, whole tables). */
  boxed(el, node) {
    if (el.pgBoxNode !== node) {
      el.pgBoxNode = node;
      const cs = getComputedStyle(el);
      el.pgBox = /^(flow-root|flex|grid|table|inline-block)$/.test(cs.display);
      // A floating object (float-layout's Square, Tight and Through: a CSS float) takes no room in the text either: the text wraps
      // round it where float-layout places it on its page, as Word lays it out. Read where it is drawn, the Word fixture's cover
      // page text box placed 66 % down the page counted as text there and pushed the rest of the cover onto a page of its own.
      el.pgOut = cs.position === 'absolute' || cs.position === 'fixed' || (cs.float !== 'none' && el.hasAttribute('data-fl'));
    }
    return el.pgBox;
  }

  /** Whether `el` is out of the text's flow (position absolute or fixed, or a floating object), cached per node with boxed. */
  outOfFlow(el, node) {
    this.boxed(el, node);
    return el.pgOut;
  }

  /** `el`'s margins, its first line's offset below its box top (border and padding) and its last line's above its box bottom,
   * cached per node. */
  style(el, node) {
    let s = this.styles.get(el);
    if (!s || s.node !== node) {
      const cs = getComputedStyle(el);
      s = { node, mt: parseFloat(cs.marginTop) || 0, mb: parseFloat(cs.marginBottom) || 0,
        pad: (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.borderTopWidth) || 0),
        padB: (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0) };
      this.styles.set(el, s);
    }
    return s;
  }

  /** The line boxes of unit `x` in layout px, cached while its box and node stay. */
  linesOf(x, R) {
    if (x.cols) {
      // Once per round: read after the round's writes (publish), it laid the whole document out again.
      R.rows ??= new Map();
      if (!R.rows.has(x.el)) R.rows.set(x.el, rowsOf(x.el, R));
      return R.rows.get(x.el);
    }
    const m = this.lines.get(x.el);
    const dy = dyOf(x.el);
    if (m && m.node === x.node && m.top === x.top && m.h === x.bottom - x.top && m.dy === dy) return m.lines;
    // An empty inline box (a bookmark's mark) can report a rect at the block's top while its line starts the next page: only a
    // block with nothing wider (an empty line's break) keeps such rects.
    // textRects: a culled block's from the copy taken when it was culled (it contains its layout, so no float outside moves them).
    const all = textRects(x.el);
    const wide = all.filter((r) => r.width > 0);
    const rects = wide.length ? wide : all;
    // The block's content box and the page ends give each line its own box: a line taller than the rest (a 1,638 pt letter, raised
    // text, a large bullet) has its own leading, and one that runs past the room it was given moved below the next page end.
    const s = this.style(x.el, x.node);
    const box = { top: by(x.el, R) + s.pad, bottom: by(x.el, R, 'bottom') - s.padB };
    const lines = lineBoxes([...rects].map((r) => ({ top: (r.top - R.top) / R.z - dy, bottom: (r.bottom - R.top) / R.z - dy, left: r.left / R.z,
      right: r.right / R.z })), box, R.breaks);
    this.lines.set(x.el, { node: x.node, top: x.top, h: x.bottom - x.top, dy, lines });
    return lines;
  }

  /** Splitting row unit `x` as the plan cuts it: each cell's lines in px from the row's top as laid out with no page end in it,
   * its foot, and the row's lines (layout.mjs rowLines). A cell's page end breakers are taken back out: a line below one sits
   * where the line above it ends, or a block's first line at its block's top (a block's box stays put; only its lines move).
   * A nested table's rows and other objects in a cell count as one line each. Cached on the row while its node and box stay.
   * → {cells: [{top (its text's top, layout px), lines: [{top, bottom, blk (its textblock as a unit), i (its line there)}]}], L} */
  rowOf(x, R) {
    const tr = x.el;
    const dy = dyOf(tr);
    const hit = this.rowsRead.get(tr);
    if (hit && hit.node === x.node && hit.top === x.top && hit.h === x.bottom - x.top && hit.dy === dy) return hit.v;
    // A row a page end splits keeps the lines it was read with before the split while its node, width and line heights stay:
    // read through its cells' page ends, a merged or centred cell came out otherwise, the plan split the row elsewhere and the
    // page end took turns (the Word fixture's merged-cell tables, page ends 288 to 315).
    const split = tr.hasAttribute('data-pg-split');
    const flat = this.rowsFlat.get(tr);
    if (split && flat?.node === x.node && flat.w === x.w && flat.epoch === this.epoch) {
      const v = { cells: flat.v.cells.map((c, i) => ({ ...c, top: x.top + flat.rel[i] })), L: flat.v.L };
      this.rowsRead.set(tr, { node: x.node, top: x.top, h: x.bottom - x.top, dy, v });
      return v;
    }
    const cells = [];
    let pos = x.pos + 1;
    for (const cd of tr.pmViewDesc?.children ?? []) {
      if (/^table(Cell|Header)$/.test(cd.node?.type.name ?? '')) cells.push(this.cellOf(cd, pos, x.top, R));
      pos += cd.size;
    }
    const h = x.node.attrs.height;
    const min = h?.value && h.rule !== 'auto' && h.rule !== 'exact' ? (h.value * 4) / 3 : 0;
    const v = { cells, L: rowLines(cells, min, BIAS + 0.5) };
    this.rowsRead.set(tr, { node: x.node, top: x.top, h: x.bottom - x.top, dy, v });
    if (!split) this.rowsFlat.set(tr, { node: x.node, w: x.w, epoch: this.epoch, rel: cells.map((c) => c.top - x.top), v });
    return v;
  }

  /** Cell `cd` (its view desc, at document position `pos`) of a row whose top is `rowTop`, for rowOf → {top, lines, end}. */
  cellOf(cd, pos, rowTop, R) {
    const el = cd.dom;
    const s = this.style(el, cd.node);
    const top = by(el, R) + s.pad;
    const breaks = [...el.querySelectorAll(':scope > .pg-cell > .pg-breaker')].map((b) => by(b, R)).sort((a, b) => a - b);
    const items = [];
    const walk = (d, p) => {
      for (const ch of d.children) {
        const n = ch.node;
        if (n?.isTextblock) items.push({ el: ch.dom, node: n, pos: p, text: true });
        else if (n && (n.type.name === 'tableRow' || !ch.contentDOM)) items.push({ el: ch.dom, node: n, pos: p, text: false });
        else if (n) walk(ch, p + ch.border);
        p += ch.size;
      }
    };
    walk(cd, pos + 1);
    const lines = [];
    let shift = 0;
    let bi = 0;
    let prev = null;
    for (const it of items) {
      const blk = { el: it.el, node: it.node, pos: it.pos, top: by(it.el, R), bottom: by(it.el, R, 'bottom') };
      const ls = it.text ? this.linesOf(blk, R) : [{ top: blk.top, bottom: blk.bottom }];
      ls.forEach((l, i) => {
        let crossed = false;
        while (bi < breaks.length && (l.top + l.bottom) / 2 > breaks[bi]) {
          bi++;
          crossed = true;
        }
        if (crossed) shift = l.top - (i === 0 && it.text ? blk.top + this.style(it.el, it.node).pad - shift : prev ?? top);
        const t = l.top - shift - rowTop;
        lines.push({ top: t, bottom: t + l.bottom - l.top, blk: it.text ? blk : null, i });
        prev = l.bottom - shift;
      });
    }
    const last = items.at(-1);
    const end = (prev ?? top) + (last ? this.style(last.el, last.node).mb : 0) + s.padB - rowTop;
    // Its sides, which its breaker reaches out to, and its bottom and top borders, which close the pieces of a split (as Word does).
    const cs = getComputedStyle(el);
    const n = (k) => parseFloat(cs[k]) || 0;
    const line = (k) => (cs[`${k}Style`] === 'none' || !n(`${k}Width`) ? null : `${cs[`${k}Width`]} ${cs[`${k}Style`]} ${cs[`${k}Color`]}`);
    return { top, lines, end, left: n('paddingLeft') + n('borderLeftWidth'), right: n('paddingRight') + n('borderRightWidth'),
      close: line('borderBottom'), open: line('borderTop'), cw: n('borderBottomWidth'), ow: n('borderTopWidth') };
  }

  /** The page frames drawn now: per page its content top and cut (layout px) and F, the flow y at its content top, worked out from
   * what sits at each page's top (the line, row or block after the cut, its space before taken back). */
  frames(R) {
    const ws = [...this.view.dom.querySelectorAll(':scope > .pg-pages')];
    const start = ws.find((w) => w.classList.contains('pg-start'));
    const ends = ws.filter((w) => w.classList.contains('pg-end')).sort((a, b) => a.dataset.k - b.dataset.k);
    // Widget k sits at the drawn anchor k (decorations); posAtDOM would sum the sizes of every block before it, per widget.
    const { anchors: drawn, after } = paginationKey.getState(this.view.state);
    // Fractional reads: offsetTop rounds to whole pixels, and an error in a page end's place adds up over the pages after it.
    const topOf = (el) => fy(el, R);
    const bottomOf = (el) => (el ? fy(el, R, 'bottom') : 0);
    const frames = [{ contentTop: bottomOf(start?.children[1]), cut: Infinity, F: 0, end: null }];
    for (const w of ends) {
      if (w.children.length < 4) continue;
      const v = w.pgVirtual;
      if (v?.row) {
        // A page end inside a row: its cells' breakers hold the gap (one is enough, they share their place).
        const b = v.el.isConnected ? v.el.querySelector(`:scope > * > .pg-cell[data-k="${w.dataset.k}"] > .pg-breaker`) : null;
        if (b) {
          frames.at(-1).cut = by(b, R);
          frames.at(-1).end = { el: w, spacerTop: topOf(w.children[0]), pos: drawn[w.dataset.k] ?? null, after: after[w.dataset.k] };
          frames.push({ contentTop: by(b, R, 'bottom'), cut: Infinity, F: 0, end: null, row: v });
        }
        continue;
      }
      if (v?.el.isConnected && v.el.pgCols?.mode === 'flow') {
        // A page end inside flowing columns: the multicol's row gap draws it, so its place is the row's, read from the box.
        const { h, g } = v.el.pgCols;
        const top = fy(v.el, R) + (v.colRow - 1) * (h + g);
        frames.at(-1).cut = top + h;
        frames.at(-1).end = { el: w, spacerTop: -Infinity, pos: null };
        frames.push({ contentTop: top + h + g, cut: Infinity, F: 0, end: null });
        continue;
      }
      const cutEl = w.children[0];
      frames.at(-1).cut = topOf(w.children[1]);
      frames.at(-1).end = { el: w, spacerTop: topOf(cutEl), trim: w.pgTrim || 0, pos: drawn[w.dataset.k] ?? null, after: after[w.dataset.k] };
      // bodyTop: where the breaker ends, the page's paper as the browser drew it (Engine.layout place).
      frames.push({ contentTop: bottomOf(w.children[3]), bodyTop: topOf(w.children[3]), cut: Infinity, F: 0, end: null });
    }
    const fin = ws.find((w) => w.classList.contains('pg-final'));
    frames.at(-1).end = fin ? { el: fin, spacerTop: topOf(fin.children[0]), pos: null } : null;
    R.breaks = frames.slice(1).map((f) => f.contentTop); // where each page's text starts, for the line boxes (linesOf)
    const { units } = R;
    let j = 0;
    for (let k = 1; k < frames.length; k++) {
      const prev = frames[k - 1];
      const fr = frames[k];
      const pf = (y) => y - prev.contentTop + prev.F;
      while (j < units.length && units[j].bottom <= prev.cut + 0.5) j++;
      const x = units[j];
      fr.lead = j;
      if (fr.row && x?.el === fr.row.el && x.row) {
        // A page that starts inside a row: its flow starts where the row's lines put the page after that cut (rowLines).
        fr.F = toFlow(frames, x.top) + (this.rowOf(x, R).L[fr.row.line]?.top ?? 0);
        continue;
      }
      // Flowing columns are a formatting context: like a block, they move below the page end whole, and their place on this
      // page follows from the block before them. Read from the cut, the breaker's own BIAS would move them down every round.
      // So is a row (a grid) that a page end does not split.
      const whole = x?.kind === 'block' || x?.row || (x?.cols && x.top >= fr.contentTop - 0.5);
      if (!x || x.kind === 'break' || x.top >= fr.contentTop - 0.5 && !whole) fr.F = pf(prev.cut);
      else if (whole) {
        const p = units[j - 1];
        fr.F = x.top >= fr.contentTop - 0.5 && p
          ? pf(p.out ? p.bottom : by(p.el, R, 'bottom')) + collapse(this.style(p.el, p.node).mb, this.style(x.el, x.node).mt) : pf(prev.cut);
        fr.pushed = x.top >= fr.contentTop - 0.5;
      } else {
        const L = this.linesOf(x, R);
        const i = L.findIndex((l) => (l.top + l.bottom) / 2 >= fr.contentTop);
        fr.F = i > 0 ? pf(L[i - 1].bottom) : i === 0 ? pf(by(x.el, R)) + this.style(x.el, x.node).pad : pf(prev.cut);
      }
    }
    return frames;
  }

  // ---------- layout ----------

  /** Keeps the page ends drawn now for `doc` (planPages pins): the next rounds move only sheets and breakers. Said once per doc. */
  freeze(doc) {
    const keep = this.model.real.slice(0, this.model.shown).filter((p) => p.cut);
    this.pins = { doc, map: new Map(keep.map((p) => [`${p.firstUnit}.${p.firstLine}`, p.cut])) };
    if (this.frozenDoc !== doc) {
      this.frozenDoc = doc;
      console.info(`pagination: the page ends kept changing; the ${keep.length + 1} pages drawn stay`);
    }
  }

  /** Moves each drawn page's sheet to where the breaker above it ends as drawn. A layout a guard keeps (the cycle check, FREEZE,
   * the 40-round limit) stays as its last round drew it, and that round placed the sheets from the text it read before its own
   * writes: those sheets sat off their text until the next edit. Sheets are absolutely placed: the text does not move. */
  follow() {
    const m = this.model;
    if (!m) return;
    const { view } = this;
    const r0 = view.dom.getBoundingClientRect().top;
    const z = scaleOf(view);
    for (const w of view.dom.querySelectorAll(':scope > .pg-pages.pg-end')) {
      const b = m.real[Number(w.dataset.k) + 1];
      if (!b || w.children.length < 4 || w.pgVirtual) continue;
      const top = (w.children[3].getBoundingClientRect().top - r0) / z;
      if (Math.abs(top - b.bodyTop) < 0.5) continue;
      Object.assign(b, { bodyTop: top, top: top - b.topOff, contentTop: top + b.push });
      this.sheetOf(w.children[2], b);
      this.dirty = true; // publish the places drawn
    }
  }

  /** One round: read, plan, write. → true when it changed what is drawn (the caller reads again). */
  layout() {
    const { view } = this;
    if (this.quick()) return false;
    // Objects that fit before each measure. A kind with pgFitAll (tables) fits all its objects in one call, so their reads and
    // writes are not interleaved: each read after a write lays the whole document out again.
    const batches = new Map();
    for (const el of view.dom.querySelectorAll('[data-pg-fit]')) {
      if (!el.pgFitAll) el.pgFit?.();
      else if (batches.has(el.pgFitAll)) batches.get(el.pgFitAll).push(el);
      else batches.set(el.pgFitAll, [el]);
    }
    for (const [fitAll, els] of batches) fitAll(els);
    this.wrote = false;
    const R = this.read();
    if (!R) return false;
    if (this.inputsChanged(view.state.doc)) this.known = new WeakMap();
    // The paragraphs' single line ratios (paragraph/extension.js, from the font files or measured) set every line's height, and the
    // zoom the units a height lands on: once either changes, no measured height is sure (culled blocks keep theirs until the check
    // draws them again).
    const lines = `${R.z}|${[...ratios].join()}`;
    if (lines !== this.ratiosSeen) [this.ratiosSeen, this.epoch] = [lines, (this.epoch ?? 0) + 1];
    const frames = this.frames(R);
    this.measureKnown(R, frames);
    const { units } = R;
    for (const x of units) {
      x.ft = toFlow(frames, x.top);
      x.fb = x.bottom > x.top ? toFlow(frames, x.bottom - 1) + 1 : x.ft;
      // A row a page end splits ends where its lines do (rowOf, read before the split): its box as drawn holds its cells' page
      // ends, and read through them its flow height moved with them (the Word fixture's merged-cell rows: 218, 329, 543, 348 px
      // in turn), so the row fitted its page one round and not the next.
      if (x.row && x.el.hasAttribute('data-pg-split')) x.fb = x.ft + (this.rowOf(x, R).L.at(-1)?.bottom ?? x.fb - x.ft);
    }
    for (const fr of frames.slice(1)) {
      const x = units[fr.lead];
      if (!x) continue;
      if (x.kind === 'break') x.ft = x.fb = fr.F;
      else if (x.kind === 'block' && fr.pushed) [x.ft, x.fb] = [fr.F, fr.F + x.bottom - x.top];
    }
    const flowLines = new Map();
    const linesOf = (j) => {
      if (!flowLines.has(j) && units[j].row) {
        // A row's lines are in px from its top as if no page end split it (rowOf): its top's flow is theirs.
        const x = units[j];
        flowLines.set(j, this.rowOf(x, R).L.map((l) => ({ top: x.ft + l.top, bottom: x.ft + l.bottom })));
      }
      if (!flowLines.has(j)) {
        const x = units[j];
        const L = [];
        let prev = null;
        for (const l of this.linesOf(x, R)) {
          const mid = (l.top + l.bottom) / 2;
          const f = frameAt(frames, mid);
          // A line that starts a page continues the flow at the last line's bottom, as frames() reads the page's flow start back:
          // its own top is guessed from the glyphs and can sit a fraction off, which then added up page after page.
          const t = L.length && f !== prev ? L.at(-1).bottom : toFlow(frames, mid) - (mid - l.top);
          prev = f;
          L.push({ top: t, bottom: t + l.bottom - l.top });
        }
        // The first line box starts at the content top, as frames() reads it back when the block moves to a page's top: the two
        // must agree or every page end drifts by the difference.
        if (L.length) L[0].top = toFlow(frames, by(x.el, R)) + this.style(x.el, x.node).pad;
        flowLines.set(j, L);
      }
      return flowLines.get(j);
    };
    const { doc } = view.state;
    const secs = sectionsOf(doc);
    const hidden = !options.whiteSpace();
    const size = this.sizer(layers().filter((l) => typeof l.reserve === 'function'));
    const notes = this.footnotes(R, frames);
    // A layout still changing after FREEZE rounds keeps the page ends drawn now; only its sheets and breakers follow them after,
    // which settles. On the Word fixture split rows in the bordered tables took turns among several plans a line apart, and the
    // page count swung between 954 and 967; the cycle check below only catches two or three plans taking turns. A guard, as that
    // one is: Word does not take turns. An edit lays out afresh (a new doc).
    if (this.tries >= FREEZE && this.model && this.pins?.doc !== doc) this.freeze(doc);
    const pins = this.pins?.doc === doc ? this.pins.map : null;
    const pages = stackPages(planPages({ units, linesOf, sectOf: (i) => secs[i].sect, size, v1Start: doc.attrs.sect?.pageNumber?.start ?? null, notes, pins }),
      { hidden, gap: GAP, thin: THIN });
    const real = pages.filter((p) => !p.blank);
    // Each drawn page's index among them and the blank papers above it (sheetOf), worked out once instead of per sheet.
    for (let i = 0, ri = 0, blanks = 0; i < pages.length; i++) {
      if (pages[i].blank) blanks += pages[i].box.h;
      else Object.assign(pages[i], { ri: ri++, blanks });
    }
    // The pages drawn: the first `cap` (progressive), the last of them open below while more remain.
    const shown = testHook('pagesAll') ? real.length : Math.min(real.length, this.cap);
    // The drawn pages that start inside a block: where their line starts, read now, before this round writes (publish uses them).
    for (const p of real.slice(1, shown)) {
      const x = units[p.firstUnit];
      if (p.firstLine > 0 && x && !x.widget) this.posAtLine(x, p.firstLine, R);
    }
    this.wrote = true; // the round's writes start: publish reads nothing more (posAtLine)
    // Columns on pages not drawn yet keep their layout: below the last drawn page the text is one flow, and a node laid out there
    // moved the plan it was laid out from, round after round.
    let changed = this.columns(real, units, doc, hidden, real[shown]?.firstUnit ?? units.length);
    const why = changed ? ['columns'] : []; // what this round changed, for harness cases and the inspector (this.why)
    // Each page end: its cut in layout px and the block its widget goes before, moved earlier while the widget would sit below
    // the cut (a margin after the block before it); the spacer runs from where the widget's floats start down to the cut.
    let prevAnchor = 0;
    const cuts = new Map(); // page end → the row it splits, with each cell's spacer and the breaker (cellCuts)
    const { anchors: drawn, after: drawnAfter } = paginationKey.getState(view.state);
    const { items } = R;
    // Whether page end `r` is drawn at item `c`'s place: its position and its side of the flow widgets there.
    const at = (end, c) => !!end && end.pos === items[c].pos && !!end.after === items[c].after;
    const drawnAt = (r, c) => at({ pos: drawn[r], after: drawnAfter[r] }, c);
    // How far page k's text is drawn from where this round places it.
    const off = (k) => (frames[k] ? frames[k].contentTop - (real[k].bodyTop + real[k].push) : 0);
    // Each sheet follows the page end above it as the browser drew it (the pagination survey's recommendation (a), the user's "a
    // page break means a new page"): page b starts the gap below a's paper, or below a's breaker where that was drawn lower
    // (content that ran past a's paper), so a misjudged page end misplaces only its own page and every page, a forced page start
    // too, starts where its text does. Summed planned tops (stackPages) let one such page end move every sheet after it off its
    // text: 897 of 938 on the Word fixture. Pages not drawn yet follow the plan (a page end without breakerAt).
    // A page whose breaker the browser drew within a pixel of that place keeps the place drawn, moved with the page above as this
    // round writes it (off): paint leaves such a breaker as drawn, and each float's height rounds to 1/64 px, so places summed
    // from the plan alone crept off their text, 12 px by the Word fixture's last page.
    const place = (r) => {
      const a = real[r - 1];
      const b = real[r];
      // A page the plan already runs over (planPages over: content taller than the room) keeps that size, which the flow gives
      // whatever the pages' places: its breaker as drawn moved with objects placed from the page geometry (a Top and Bottom
      // picture 1,000 % of the margin tall), which moved the next page down by a page each round.
      const q = placeAfter(a, b, a.over > 0 ? null : a.breakerAt ?? null, { hidden, gap: GAP, thin: THIN, slack: BIAS });
      const seen = a.breakerAt != null && frames[r]?.bodyTop != null && at(frames[r - 1]?.end, a.anchorItem) ? frames[r].bodyTop - off(r - 1) : null;
      b.bodyTop = seen != null && Math.abs(seen - q.bodyTop) < 0.9 ? seen : q.bodyTop;
      b.top = b.bodyTop - b.topOff;
      a.cover = q.cover;
    };
    real.forEach((p, r) => {
      if (r) place(r);
      p.contentTop = p.bodyTop + p.push;
      // Content taller than the page runs past the body (planPages over); a last line's leading runs into the margin (lead).
      p.bodyBottom = p.bodyTop + p.bodyH + p.over + (p.lead || 0);
      if (r >= shown) return;
      if (r === shown - 1 && shown < real.length) {
        p.spacer = 0;
        return;
      }
      const next = real[r + 1];
      if (!next) {
        const lu = units.at(-1);
        const y = lu ? this.widgetY(p, lu.fb, items.at(-1), frames.at(-1)?.end, R, frames) : p.contentTop;
        p.spacer = Math.max(0, p.bodyBottom - Math.max(y, p.contentTop));
        const run = Math.max(y, p.contentTop) - (p.bodyTop + p.bodyH + (hidden ? 0 : p.botOff)) - BIAS;
        p.cover = run > 0.5 ? run + BIAS : 0;
        return;
      }
      const cu = units[p.cut.unit];
      p.virtual = null;
      if (cu.cols && p.cut.line > 0) {
        // Inside flowing columns the row gap is the page end: no spacer or breaker, the widget only carries the next sheet. It sits
        // after the columns node, where it moves no text. Its row is `colRow`: `row` marks a page end inside a table row, and
        // read as one this widget kept the margin it last drew, which moved the text after the columns up by pages.
        p.virtual = { el: cu.el, colRow: p.cut.line };
        prevAnchor = cu.item + 1;
        p.anchor = items[cu.item + 1]?.pos ?? doc.content.size;
        p.after = !!items[cu.item + 1]?.after;
        p.spacer = 0;
        p.cutY = p.breakerTop = p.bodyBottom;
        return;
      }
      // A cut inside a row falls after its last kept line: the next page's flow start (cut.flow) can lie above that (rowLines).
      const inRow = cu.row && p.cut.line > 0;
      p.cutY = p.cut.forced && cu.kind === 'break' ? null : Math.min(p.contentTop + ((inRow ? p.lastBottom : p.cut.flow) - p.F), p.bodyBottom);
      let c = cu.item;
      let y;
      // Space between the page's last block A and the block B that starts the next page runs past the next page's top when it
      // is taller than the room the page end leaves (Word's spacing runs up to 1,584 pt; less while white space is hidden), and
      // Word drops it there. The widget between them takes the excess off with negative margins, which collapse with theirs
      // through the empty widget: its top margin the part of A's space after past the cut (so its floats start at the cut), its
      // bottom margin the rest of B's space before (so B's first line starts at the next page's top). Only for the widget right
      // before B, and only margin: a block that runs past the cut itself still moves the widget before it. → yAt sets trimA.
      let trimA = 0;
      // Where the next page's text starts with this page's end where the plan puts it (place() moves it below a run-on).
      const nextTop = placeAfter(p, next, p.over > 0 ? null : p.bodyBottom + BIAS, { hidden, gap: GAP, thin: THIN, slack: BIAS }).bodyTop + next.push;
      const trims = p.cutY != null && !p.cut.forced && p.cut.line === 0 && !cu.inner;
      // How far B's first line would start below the next page's top with the widget at `raw` after A's space `mb`.
      const excess = (c, raw, mb) => {
        const s = this.style(items[c].el, items[c].node);
        return raw - mb + collapse(mb, s.mt) + s.pad - nextTop;
      };
      const yAt = (c) => {
        trimA = 0;
        const A = items[c - 1];
        const au = A && units[A.u1 - 1];
        if (!A || au.fb + this.style(A.el, A.node).mb < p.F - 0.5) return p.contentTop;
        // A fractional read of A's bottom: units hold offsetTop's whole pixels, and half a pixel off here lands a page's text off.
        const fb = au.kind === 'break' || au.out ? au.fb : toFlow(frames, by(au.el, R, 'bottom') - 1) + 1;
        const { mb } = this.style(A.el, A.node);
        const raw = this.widgetY(p, fb + mb, A, at(frames[r]?.end, c) ? frames[r].end : null, R, frames);
        if (trims && c === cu.item && excess(c, raw, mb) > 0) trimA = Math.min(Math.max(0, raw - p.cutY), Math.max(0, mb));
        return raw - trimA;
      };
      // Never before the page's first block unless the cut is inside it: the page's own text, a line taller than the page among
      // it, would move below its end.
      const first = units[p.firstUnit]?.item ?? 0;
      const least = Math.max(prevAnchor, cu.item === first ? first : first + 1);
      for (;;) {
        y = yAt(c);
        if (p.cutY == null) p.cutY = Math.max(y, p.contentTop);
        if (y <= p.cutY + 0.5 || c <= least) break;
        c--;
      }
      // A widget drawn one block earlier stays there: the place read back with it drawn and the guess without it can differ by
      // a pixel, which flipped the anchor between two blocks on every keypress and redrew every page after it.
      if (c - 1 > prevAnchor && c - 1 >= least && drawnAt(r, c - 1)) {
        const y0 = yAt(c - 1);
        if (y0 <= p.cutY + 0.5) [c, y] = [c - 1, y0];
      }
      yAt(c); // trimA for the widget's place
      const mbA = c > 0 ? this.style(items[c - 1].el, items[c - 1].node).mb : 0;
      p.trim = [trimA, trims && c === cu.item && c > 0 ? Math.max(0, excess(c, y + trimA, mbA)) : 0];
      prevAnchor = c;
      p.anchorItem = c;
      p.anchor = items[c].pos;
      p.after = items[c].after;
      if (inRow) {
        // Inside a row the cells hold the page end (cellCuts). The widget before the table keeps a zero-width spacer down to the
        // next page's text, where the floats of a page end after it start, and carries the next sheet.
        p.breakerAt = p.cutY + BIAS; // where the cells' breakers start
        place(r + 1);
        const top = next.bodyTop + next.push;
        p.virtual = { el: cu.el, row: true, line: p.cut.line };
        p.spacer = Math.max(0, top - Math.max(y, p.contentTop));
        p.breakerTop = top;
        cuts.set(r, this.cellCuts(cu, p.cutY + BIAS, top, R, cuts.get(r - 1)));
        return;
      }
      p.spacer = Math.max(0, p.cutY + (cu.kind === 'break' ? 0 : BIAS) - Math.max(y, p.contentTop));
      p.breakerTop = Math.max(y, p.contentTop) + p.spacer;
      // Where the breaker is drawn, read back: each float's height rounds to the layout's units (1/64 px), floats in the text before
      // the widget can push it down (clear), and the flow read from glyphs can put the widget off its guess. The next page starts
      // from there (place), so its sheet sits where its text does. The read moves with this page's text as this round's writes
      // will place it (off). Only for a widget drawn at this place with a breaker of its own (not inside a row or columns).
      const end = at(frames[r]?.end, c) && !frames[r].end.el.pgVirtual ? frames[r].end : null;
      const drawn = end && frames[r].cut + (p.spacer - (end.el.children[0].pgVals?.[0] ?? p.spacer)) - (p.trim[0] - (end.trim ?? 0)) - off(r);
      p.breakerAt = Number.isFinite(drawn) ? drawn : p.breakerTop;
    });
    // Blank pages (printed only) take the next page's place, as stackPages has them.
    for (let i = pages.length - 1, nx = null; i >= 0; i--) {
      if (!pages[i].blank) nx = pages[i];
      else Object.assign(pages[i], { bodyTop: nx?.bodyTop ?? 0, top: (nx?.bodyTop ?? 0) - pages[i].topOff });
    }
    // A page end that takes turns between two or three places, with every page end above it as then, changes for ever: on the
    // Word fixture a one-line paragraph taller than a page grew with the page ends drawn around its line, so two plans took turns
    // and every page after them moved each round until the 40-round guard; a framed paragraph (a float, read where it is drawn)
    // did the same between one page and two. Once the turn has come round twice (A B A B: a layout settling can go back once on
    // its way, perf-core's document did at page 65, and stopping there kept the wrong page end), the one with fewer pages stays
    // (text sits as early as it fits): the round that finds the other one again draws nothing. A guard: Word does not take turns.
    // Only where each page ends counts, not the spacers' heights: those move by a pixel with the reading noise paint() leaves.
    const ends = real.slice(0, shown).map((p) => `${p.anchor ?? ''}${p.after ? 'a' : ''}:${p.cut ? `${p.cut.unit}.${p.cut.line}` : ''}`);
    // The history goes on while more pages are drawn (progressive): a round compares only the page ends earlier rounds drew too,
    // so a new page end is never taken for a turn. Started again at each cap, a pair taking turns above them (a line taller than a
    // page on the Word fixture, page end 44) redrew every page end below it in every frame of the open.
    const drawnEnds = this.plans.at(-1);
    let first = -1;
    if (drawnEnds) for (let r = 0; r < Math.max(ends.length, drawnEnds.length) && first < 0; r++) if (ends[r] !== drawnEnds[r]) first = r;
    const same = (a, b) => !!a && !!b && a.length > first && b.length > first && a.slice(0, first + 1).every((e, r) => e === b[r]);
    const H = this.plans;
    const back = first >= 0 && first < ends.length && [2, 3].some((n) => same(ends, H.at(-n)) && same(H.at(-1), H.at(-1 - n)));
    if (!changed && this.model && back && real.length >= this.model.real.length) {
      this.why = ['cycle', `page end ${first}`];
      // A guard, not Word's behaviour (Word does not take turns between layouts): say so once per doc, so a cause is found.
      if (this.cycleDoc !== doc) {
        this.cycleDoc = doc;
        console.info(`pagination: page end ${first} took turns between two layouts; the one with fewer pages stays`);
      }
      this.follow(); // the layout drawn stays: its sheets go to its text
      this.last = { doc };
      return false;
    }
    this.plans = [...this.plans.slice(-5), ends];
    // Paint leaves changes under a pixel as drawn (read-back noise would otherwise redraw every frame), and each page's text starts
    // below the widgets before it, so those errors add up down the pages. The end widget above a page drawn more than half a pixel
    // off its place writes its values exactly.
    const exact = new Set();
    for (let r = 1; r < real.length && r < frames.length; r++) if (Math.abs(frames[r].contentTop - real[r].contentTop) > 0.5) exact.add(r - 1);
    const heads = new Map(); // split table's top-level index → its header row units, for the repeated header rows
    for (const u of units) if (u.header && u.table != null) heads.set(u.table, [...(heads.get(u.table) ?? []), u]);
    // The blocks from each page end widget to the block its cut falls in (culling's keep): a culled one would move below the page
    // end whole, so any that is culled draws now, before the widgets move to them.
    const keep = new Set();
    for (const p of real.slice(0, shown - 1)) {
      if (p.anchorItem == null || p.virtual || !p.cut) continue;
      for (let i = units[items[p.anchorItem].u0]?.child ?? doc.childCount; i <= units[p.cut.unit].child; i++) keep.add(i);
    }
    this.culler.release(R.kids, (i) => keep.has(i));
    this.model = { pages, real, shown, units, kids: R.kids, hidden, R, exact, heads, keep, notes: notes?.key ?? '', cuts };
    // Anchors first (a transaction re-keys moved widgets), then every widget's values in place.
    const anchors = real.slice(0, shown - 1).map((p) => p.anchor);
    const after = real.slice(0, shown - 1).map((p) => !!p.after);
    const splits = [...cuts].map(([k, c]) => [c.pos, k]);
    // Justified: each block after a page's first moves down by its share of the page's room.
    const shifts = [];
    for (const p of real.slice(0, shown)) {
      if (!(p.vGap > 0)) continue;
      let prev = null;
      for (let j = p.firstUnit, k = 0; j < (p.cut ? p.cut.unit : units.length); j++) {
        const x = units[j];
        if (x.kind === 'break' || x.widget || x.child === prev) continue;
        if (prev != null) shifts.push([R.kids[x.child].pos, px(++k * p.vGap)]);
        prev = x.child;
      }
    }
    const st = paginationKey.getState(view.state);
    // Each section's text height for the objects in it (blockDecorations).
    const bodies = sectionBodies(real, secs.length);
    if (anchors.join() !== st.anchors.join() || after.join() !== st.after.join() || shifts.join() !== st.shifts.join() || splits.join() !== st.splits.join()
      || bodies.join() !== st.bodies?.join()) {
      view.dispatch(view.state.tr.setMeta(paginationKey, { anchors, after, shifts, splits, bodies }).setMeta('addToHistory', false));
      changed = true;
      why.push('anchors');
      // A widget kept by its key may now end another page: each takes its page from its place among them (they stand in page order).
      let k = 0;
      for (const w of view.dom.querySelectorAll(':scope > .pg-pages.pg-end')) w.dataset.k = String(k++);
    }
    // The blocks culled for this plan: one drawn now at an unsure height may move the text, so the round reads again.
    if (this.syncCull()) {
      changed = true;
      why.push('cull');
    }
    for (const w of view.dom.querySelectorAll(':scope > .pg-pages')) {
      if (!this.paint(w)) continue;
      changed = true;
      why.push(`paint ${w.dataset.k}`);
    }
    for (const c of cuts.values()) {
      for (const w of c.el.querySelectorAll(':scope > * > .pg-cell')) {
        if (!this.paint(w)) continue;
        changed = true;
        why.push(`cell ${w.dataset.k}`);
      }
    }
    this.sheetsRange = this.range; // every sheet was drawn for the band read above
    if (this.sheet(real)) {
      changed = true;
      why.push('sheet');
    }
    this.why = why;
    if (changed) this.dirty = this.wroteSize = true;
    this.last = changed ? null : { doc };
    return changed;
  }

  /** Lays out each columns node for the page plan `real` (briefs/columns.md How): a multicol box is a block formatting context, so
   * it never crosses a page end beside the page floats. Columns that fit the room left where they stand, or a whole page, are one
   * row ('fit': balanced by CSS when text follows on the page; 'fill': column 1 first, the row as tall as the room). Longer ones
   * flow from a page top ('flow'): rows as tall as the page body with the page ends as the row gap, so each row is a page.
   * A fill or flowing node with a block after it ends at its last row's text when that text stays in column 1 (colsEnd), so the
   * block starts below it on the same page.
   * ponytail: no shorter first row (CSS multicol level 2 gives every row one height), so flowing columns that start mid-page go
   * to the next page; and a flowing node's last page fills column 1 first (column-fill has no effect with column-height,
   * checked in Electron 44). → true when a node's layout changed. */
  columns(real, units, doc, hidden, end = units.length) {
    // Every node's reads, then every node's writes: a read after another node's write laid the whole document out again.
    const writes = [];
    units.forEach((x, j) => {
      if (!x.cols || j >= end) return;
      const r = real.findIndex((p) => p.firstUnit <= j && (!p.cut || p.cut.unit > j || (p.cut.unit === j && p.cut.line > 0)));
      const P = real[r];
      if (!P) return;
      const el = x.el;
      const cur = el.pgCols;
      const atTop = P.firstUnit === j && P.firstLine === 0;
      const prev = atTop ? real[r - 1] : null;
      // The room where the node stands in the flow: on the page before when the plan moved it to this page's top.
      const moved = prev?.cut && prev.cut.unit === j && !prev.cut.forced && prev.section === P.section;
      const here = moved ? prev.F + prev.bodyH - prev.push - x.ft : P.F + P.bodyH - P.push - Math.max(x.ft, P.F);
      const top = atTop ? P.bodyH - P.push : here;
      const n = x.node.attrs.count || 1;
      const h = x.bottom - x.top;
      if (cur && cur.node !== x.node) el.pgColsNo = null;
      // Flowing over more than one row: longer than any page, so no need to measure its text (the 200-page keypress budget).
      const long = cur?.mode === 'flow' && h > cur.h + 1;
      let want = null;
      if (fillOf(doc, x.child) === 'balance') {
        // One balanced row: its height as drawn, else about a column's share of the text plus a line.
        const need = cur?.mode === 'fit' ? h : long ? Infinity : Math.max(this.colsLength(el, x.node) / n + LINE, el.pgColsNo ?? 0);
        if (need <= Math.max(here, top) + 0.5) want = { mode: 'fit' };
        else if (cur?.mode === 'fit') el.pgColsNo = h;
      } else {
        const len = long ? Infinity : this.colsLength(el, x.node) + n * LINE;
        const room = len <= n * here ? here : len <= n * top ? top : 0;
        if (cur?.mode === 'fill' && h > cur.h + 1) el.pgColsNo = Infinity; // more than one row: it needs to flow
        // A height drawn that still fits within 4 px of the room stays: the room is read from fractional places that move by a
        // fraction each round, and on the Word fixture's column cases the floor flipped between 927, 928 and 929 px for ever, moving
        // the next node to the page after and back.
        const keep = cur?.mode === 'fill' && cur.node === x.node && cur.h <= room - 0.5 && cur.h >= room - 4;
        if (room > LINE && !(el.pgColsNo >= Infinity)) want = { mode: 'fill', h: keep ? cur.h : Math.floor(room - 1), g: 0 };
      }
      if (!want) {
        // Flowing rows start at the next page top when the node stands mid-page.
        const Q = atTop || !real[r + 1] ? P : real[r + 1];
        const g = hidden ? THIN : Q.botOff + GAP + Q.topOff;
        want = { mode: 'flow', h: px(Q.bodyH - Q.push), g: px(g), gp: px(g - (hidden ? THIN : GAP)) };
      }
      want.node = x.node;
      const base = `${want.mode}:${want.h}:${want.g}:${want.gp}`;
      // The end is read with this layout already drawn: a changed layout draws first and is read on the next pass.
      if (want.mode !== 'fit' && el.pgColsBase === base && x.child + 1 < doc.childCount) Object.assign(want, this.colsEnd(el, want, x.node));
      const key = `${base}:${want.end}`;
      el.pgCols = want;
      if (el.pgColsKey === key) return;
      el.pgColsKey = key;
      el.pgColsBase = base;
      this.colsWhy = `${j} ${key}`;
      writes.push([el, want]);
    });
    for (const [el, want] of writes) {
      el.dataset.colsMode = want.mode;
      for (const [k, v] of [['--cols-h', want.h], ['--cols-g', want.g], ['--cols-gp', want.gp], ['--cols-end', want.end], ['--cols-endp', want.endp]]) {
        el.style.setProperty(k, v == null ? null : `${v}px`);
      }
    }
    return writes.length > 0;
  }

  /** The height of fill or flowing columns node `el` (drawn with layout `c`, its node `node`) when its last row's text ends in
   * column 1 above the row's foot: {end, endp} in px on screen and in print (its rows' gap is the printed one), else {}. Column 1
   * fills first, so then nothing sits in the row below that text. An explicit height leaves the rows as they are (Electron 44). */
  colsEnd(el, c, node) {
    const last = el.lastElementChild;
    const rs = last?.getClientRects();
    const lr = rs?.[rs.length - 1];
    if (!lr) return {};
    const b = el.getBoundingClientRect();
    const z = b.height / (el.offsetHeight || 1) || 1;
    const rows = Math.max(1, Math.ceil((el.offsetHeight - 0.5 + c.g) / (c.h + c.g)));
    const rowTop = (rows - 1) * (c.h + c.g);
    const kid = el.childElementCount === node.childCount ? node.lastChild : last;
    const used = Math.ceil((lr.bottom - b.top) / z - rowTop + this.style(last, kid).mb);
    if ((lr.left - b.left) / z >= el.clientWidth / (node.attrs.count || 1) || used < 0 || used >= c.h - 0.5) return {};
    return { end: px(rowTop + used), endp: px((rows - 1) * (c.h + (c.gp ?? c.g)) + used) };
  }

  /** The text of columns node `el` as one column of its width (px): its blocks' fragments with the margins between them. */
  colsLength(el, node) {
    const w = el.clientWidth;
    if (el.pgColsLen?.node === node && el.pgColsLen.w === w) return el.pgColsLen.v;
    let v = 0;
    let mb = null;
    const kids = [...el.children];
    kids.forEach((c, i) => {
      const s = this.style(c, kids.length === node.childCount ? node.child(i) : c);
      for (const rect of c.getClientRects()) v += rect.height;
      if (mb != null) v += collapse(mb, s.mt);
      mb = s.mb;
    });
    v /= el.getBoundingClientRect().height / (el.offsetHeight || 1) || 1; // zoom-free
    el.pgColsLen = { node, w, v };
    return v;
  }

  /** The footnotes a layer keeps with their reference lines (layer.notes(view) → {sep, refs: [{pos, h, first}]}) in flow px, for
   * planPages → {sep, list, key (the notes' heights)} or null. */
  footnotes(R, frames) {
    const { view } = this;
    for (const l of layers()) {
      const n = typeof l.notes === 'function' ? l.notes(view) : null;
      if (!n?.refs.length) continue;
      const list = n.refs.map((r) => {
        const c = view.coordsAtPos(r.pos, 1);
        return { ...r, y: toFlow(frames, ((c.top + c.bottom) / 2 - R.top) / R.z) };
      }).sort((a, b) => a.y - b.y);
      return { sep: n.sep, list, key: notesKey(n) };
    }
    return null;
  }

  /** A page's paper and body after the reservations of `reservers` (planPages' size): spec {index, section, number, first, blank}. */
  sizer(reservers) {
    const { state } = this.view;
    const { doc } = state;
    const secs = sectionsOf(doc);
    const set = doc.attrs.settings ?? {};
    return ({ index, section, number, first, blank }) => {
      const sect = secs[section].sect;
      const box = paperOf(sect, { mirror: !!set.mirrorMargins, gutterAtTop: !!set.gutterAtTop, number });
      const label = pageLabel(number, sect.pgNum?.fmt);
      const part = partOf(sect, first, number, !!set.evenAndOddHeaders);
      const res = blank ? [] : reservers.map((l) => {
        try {
          return l.reserve({ index, section, inSection: 0, number, label, part, blank, box, top: 0, bodyTop: box.top, bodyHeight: box.body }, state, this.view);
        } catch (e) {
          console.error(`page layer ${l.id}:`, e);
          return null;
        }
      });
      const b = bodyOf(box, res);
      return { box, sect, label, part, topOff: b.topOff, botOff: b.botOff, bodyH: b.height };
    };
  }

  /** The keypress path: the text changed only inside top-level blocks that kept their box (place and height) and no reservation
   * changed, so every page stays as drawn: a block of the same height has the same lines, so a page end inside it stays at the same
   * line (publish finds where that line now starts). The model takes the new nodes and positions; anything else lays out in full.
   * → true when it applied. */
  quick() {
    const { view, model: m } = this;
    const { doc } = view.state;
    const old = this.last?.doc;
    if (!old || !m || doc.attrs !== old.attrs || doc.childCount !== old.childCount) return false;
    const n = doc.childCount;
    const { kids, units, pages } = m;
    let i0 = 0;
    while (i0 < n && doc.child(i0) === old.child(i0)) i0++;
    if (i0 < n) {
      let i1 = n - 1;
      while (doc.child(i1) === old.child(i1)) i1--;
      for (let i = i0; i <= i1; i++) {
        const kid = kids[i];
        const node = doc.child(i);
        const x = units[kid.u0];
        const { el } = kid;
        if (kid.u1 - kid.u0 !== 1 || x.kind === 'break' || node.type !== kid.node.type || el.pmViewDesc?.node !== node) return false;
        // Columns that fit one row can change mode without changing height (more text than a fill row holds overflows sideways).
        if (x.cols && x.kind !== 'text') return false;
        // read() gives only textblocks their keeps (keepsOf's widow: true for other blocks never matched, so typing in a list,
        // a quote or columns always laid out in full).
        const k = keepsOf(doc, node);
        if (node.isTextblock && (k.keepNext !== x.keepNext || k.keepLines !== x.keepLines || k.widow !== x.widow || k.breakBefore !== x.breakBefore)) return false;
        if (!node.isTextblock && (this.boxed(el, node) ? 'block' : 'text') !== x.kind) return false;
        if (el.offsetTop !== kid.top || el.offsetTop + el.offsetHeight !== kid.bottom) return false;
        // A flowing node's height can be set (colsEnd), so its box keeps its height while its last row's text grows.
        if (x.cols && el.pgCols && i + 1 < n && this.colsEnd(el, el.pgCols, node).end !== el.pgCols.end) return false;
      }
      if (i1 + 1 < n && kids[i1 + 1].el.offsetTop !== kids[i1 + 1].top) return false;
      // A footnote that changed height moves the page ends above it. ponytail: a reference that moves to another line of a block
      // that kept its height keeps the pages until the next full layout.
      if (notesKey(layers().find((l) => typeof l.notes === 'function')?.notes(view)) !== m.notes) return false;
      const reservers = layers().filter((l) => typeof l.reserve === 'function');
      if (reservers.length) {
        const size = this.sizer(reservers);
        if (pages.some((p, index) => {
          if (p.blank) return false;
          const b = size({ index, section: p.section, number: p.number, first: p.first, blank: false });
          return b.topOff !== p.topOff || b.botOff !== p.botOff;
        })) return false;
      }
      let pos = kids[i0].pos;
      for (let i = i0; i < n; i++) {
        const kid = kids[i];
        const node = doc.child(i);
        const d = pos - kid.pos;
        if (i > i1 && !d) break;
        if (i <= i1) kid.node = units[kid.u0].node = node;
        if (d) {
          kid.pos = pos;
          // The flow widgets in front of the block sit at its position too.
          for (let j = i ? kids[i - 1].u1 : 0; j < kid.u1; j++) {
            units[j].pos += d;
            if (units[j].widget) m.R.items[units[j].item].pos = units[j].pos;
          }
        }
        pos += node.nodeSize;
      }
      for (let j = kids.at(-1).u1; j < units.length; j++) units[j].pos = m.R.items[units[j].item].pos = doc.content.size;
    }
    const r0 = view.dom.getBoundingClientRect();
    m.R.top = r0.top;
    m.R.z = scaleOf(view);
    m.R.rows = null;
    this.range = this.band(r0, m.R.z);
    this.last.doc = doc;
    this.wrote = false; // the reads above laid the text out: publish may search a changed block's page start
    return true;
  }

  /** A page end inside splitting row unit `x`, its breakers from layout y `cut` down to the next page's text at `top`: each cell's
   * spacer from where its floats start (its text's top, or the next page's text of the row's page end before, `prev`) down to the
   * cut, and the row's clip band (px from its top) between the lines that close the two pieces (each breaker's borders). */
  cellCuts(x, cut, top, R, prev) {
    const again = prev?.el === x.el;
    const { cells } = this.rowOf(x, R);
    const spacers = cells.map((c) => Math.max(0, cut - (again ? prev.top : c.top)));
    const close = Math.max(0, ...cells.map((c) => (c.close ? c.cw : 0)));
    const open = Math.max(0, ...cells.map((c) => (c.open ? c.ow : 0)));
    return { el: x.el, pos: x.pos, cells, spacers, breaker: Math.max(0, top - cut), top, a: cut + close - x.top, b: top - open - x.top };
  }

  /** Where an end widget's floats start: after block `A` (its flow bottom plus margin `fbm`) on page `p`. A widget already drawn
   * there (`end`) corrects the guess by what it measured, shifted by how far A moves. */
  widgetY(p, fbm, A, end, R, frames) {
    const guess = p.contentTop + (fbm - p.F);
    if (!end || end.spacerTop <= frameAt(frames, end.spacerTop).contentTop + 0.5) return guess;
    // A moves with its page's text: by the change of that page's content top less its flow start. Working it out from the frame
    // (fractional reads) keeps the whole-pixel rounding of offsetTop out: that error added up down the pages, about half a pixel
    // a page.
    const fr = frameAt(frames, end.spacerTop);
    // The margin the widget drew trimmed (layout's trimA) is added back: the guess is the place before the trim.
    return end.spacerTop + (end.trim ?? 0) + (p.contentTop - p.F) - (fr.contentTop - fr.F);
  }

  // ---------- painting ----------

  /** Writes widget `w`'s values from the model → true when one changed by a pixel or more. offsetTop and offsetHeight round to
   * whole pixels, so a value read back through them can flip by about half a pixel each frame; a smaller change is left as drawn. */
  paint(w) {
    const m = this.model;
    if (!m) return false;
    const k = Number(w.dataset.k);
    // The final widget ends the sheet: nothing below it reads back, so it is always exact (a whole number of pages).
    const tol = w.classList.contains('pg-final') || (!w.classList.contains('pg-start') && m.exact?.has(k)) ? 0.02 : 1;
    const set = (el, css, vals) => {
      const old = el.pgVals;
      if (old && old.length === vals.length && old.every((v, i) => Math.abs(v - vals[i]) < tol) && el.pgKey === css) return false;
      el.pgVals = vals;
      el.pgKey = css;
      el.style.cssText = vals.reduce((s, v, i) => s.replace(`$${i}`, px(v)), css);
      return true;
    };
    let changed = false;
    if (w.classList.contains('pg-cell')) {
      // The breaker spans the cell's border box, its top border closing the piece above in the cell's bottom border and its bottom
      // one opening the piece below in its top border.
      const c = m.cuts?.get(k);
      const i = Number(w.dataset.i);
      const e = c?.cells[i];
      const css = `height:$0px;width:calc(100% + $1px);margin-left:-$2px;border-top:${e?.close ?? 'none'};border-bottom:${e?.open ?? 'none'}`;
      return !!(set(w.children[0], 'height:$0px', [c?.spacers[i] ?? 0]) | set(w.children[1], css, [c?.breaker ?? 0, (e?.left ?? 0) + (e?.right ?? 0), e?.left ?? 0]));
    }
    if (w.classList.contains('pg-start')) {
      const p = m.real[0];
      changed = this.sheetOf(w.children[0], p) | this.pusher(w.children[1], p, set);
    } else if (w.classList.contains('pg-final')) {
      const p = m.shown < m.real.length ? { spacer: 0 } : m.real.at(-1);
      // The last block's space after would run past the last page's end and stretch the sheet (Word ignores it there): a negative
      // margin as large collapses with it, so the widget's floats start at the block's bottom.
      const last = m.R.items.at(-1);
      changed = set(w, 'margin-top:$0px', [last ? -this.style(last.el, last.node).mb : 0]) | set(w.children[0], 'height:$0px', [p.spacer]);
    } else {
      const a = m.real[k];
      const b = m.real[k + 1];
      // The margins trimmed at the page end (layout's trimA and trimB): negative, they collapse with those around the widget.
      const trim = (t = [0, 0]) => {
        const ch = set(w, 'margin:$0px 0 $1px', [-t[0], -t[1]]);
        w.pgTrim = -w.pgVals[0];
        return ch;
      };
      if (!a || !b) return trim() | set(w.children[0], 'height:0px;display:none', [0]) | set(w.children[1], 'display:none', [0]);
      w.pgVirtual = a.virtual;
      if (a.virtual?.row) {
        // The row's clip band, on its table's wrapper (the row's own attributes are the editor's): drawn only, nothing reads it.
        const c = m.cuts?.get(k);
        const wrap = c?.el.closest('.tableWrapper');
        if (wrap) for (const [name, v] of [[`--pg-a${k}`, c.a], [`--pg-b${k}`, c.b]]) if (wrap.style.getPropertyValue(name) !== `${px(v)}px`) wrap.style.setProperty(name, `${px(v)}px`);
        // No pusher either: a full-width float, even one of no height, moves the row (a grid) below it.
        return !!(set(w.children[0], 'height:$0px', [a.spacer]) | set(w.children[1], 'display:none', [0]) | this.sheetOf(w.children[2], b)
          | set(w.children[3], 'display:none', [0]) | this.holdHeader(w.children[3], null));
      }
      if (a.virtual) {
        return !!(trim() | set(w.children[0], 'height:0px;display:none', [0]) | set(w.children[1], 'display:none', [0]) | this.sheetOf(w.children[2], b)
          | set(w.children[3], 'height:0px', [0]));
      }
      changed = trim(a.trim);
      changed = set(w.children[0], 'height:$0px', [a.spacer]) | changed;
      changed = this.breaker(w.children[1], a, b, set) | changed;
      changed = this.sheetOf(w.children[2], b) | changed;
      changed = this.pusher(w.children[3], b, set) | changed;
    }
    return !!changed;
  }

  /** The breaker below page `a`'s cut: the rest of a's paper, the gap (with the papers of blank pages between, printed only) and
   * the top of `b`'s paper; transparent but for the gap. */
  breaker(el, a, b, set) {
    const { hidden, pages } = this.model;
    const blanks = pages.slice(pages.indexOf(a) + 1, pages.indexOf(b)).map((p) => p.box.h);
    const left = Math.max(a.box.left, b.box.left);
    const width = Math.max(a.box.w - a.box.left, b.box.w - b.box.left) + left;
    const total = b.bodyTop - (a.breakerAt ?? a.breakerTop);
    const fillB = hidden ? 0 : b.topOff;
    const gap = hidden ? THIN : GAP;
    const fillA = Math.max(0, total - fillB - gap);
    const key = `${blanks.join()}`;
    if (el.childElementCount !== 3 + blanks.length || el.pgBlanks !== key) {
      const d = el.ownerDocument;
      el.replaceChildren(div(d, 'pg-fill'), div(d, 'pg-gap'), ...blanks.map(() => div(d, 'pg-blank')), div(d, 'pg-fill'));
      el.pgBlanks = key;
      el.pgVals = null;
      for (const c of el.children) c.pgVals = null;
    }
    // No height of its own: its parts add up, so in print, where the gap goes and blank pages show, it still ends at b's text.
    // A paragraph indented past the paper's right edge (Word's indents run to 1,584 pt) has its lines out there, beside the
    // breaker, where no page end would part them: the breaker's right margin reaches as far as the text does, which scrolls
    // no further than the text already does.
    const { R } = this.model;
    const far = Math.max(0, (R?.column ?? 0) + (R?.reach ?? 0) - (width - left));
    let changed = set(el, 'width:$0px;margin-left:$1px;margin-right:$2px', [width, -left, far]);
    const kids = el.children;
    changed = set(kids[0], 'height:$0px', [fillA]) | changed;
    changed = set(kids[1], 'height:$0px', [gap]) | changed;
    blanks.forEach((h, i) => { changed = set(kids[2 + i], 'height:$0px', [h]) | changed; });
    changed = set(kids[kids.length - 1], 'height:$0px', [fillB]) | changed;
    return changed;
  }

  /** Page `p`'s top pusher: header rows repeated from the table that continues onto it, below its vertical alignment shift. It is
   * as wide as the page's text, so a section wider than the column runs no text beside it and the repeated rows take its width. */
  pusher(el, p, set) {
    const changed = set(el, 'height:$0px;padding-top:$1px;width:$2px', [p.push - p.vShift, p.vShift, p.box.text]);
    return this.holdHeader(el, p.header) | changed;
  }

  /** Puts a copy of the header rows of the table at top-level index `i` (null: none) in `el`, a page's pusher or sheet. Each page
   * takes its own copy of the one headerClone keeps: a table over three pages or more repeats its header on each. → changed. */
  holdHeader(el, i) {
    const want = i == null ? null : this.headerClone(i);
    if ((el.firstChild?.pgFrom ?? null) === want) return false;
    if (!want) el.replaceChildren();
    else el.replaceChildren(Object.assign(want.cloneNode(true), { pgFrom: want }));
    return true;
  }

  /** A copy of the header rows of the split table at top-level index `i`: drawn, not editable, in the table's own wrapper and
   * variables so it lays out as the rows do. Keyed by the table node (its rows are its children), the wrapper's style and the
   * rows' widths as read, so painting reads no layout and serialises nothing. */
  headerClone(i) {
    const kid = this.model.kids[i];
    const wrap = kid?.el;
    if (!wrap) return null;
    const rows = this.model.heads.get(i) ?? [];
    // Without the split rows' clip bands (paint), which move with the page ends and draw nothing in the header rows.
    const key = `${(wrap.getAttribute('style') ?? '').replace(/--pg-[ab]\d+:[^;]*;?\s*/g, '')}:${rows.map((u) => u.w).join()}`;
    const hit = this.clones.get(wrap);
    if (hit?.node === kid.node && hit.key === key) return hit.el;
    const table = wrap.querySelector(':scope > table');
    const out = wrap.cloneNode(false);
    out.classList.add('pg-header');
    out.removeAttribute('id');
    // The pusher holding it is as wide as its page's text already: the copy keeps no section width of its own.
    out.removeAttribute('data-pg-dr');
    out.style.removeProperty('--pg-dr');
    const t = table.cloneNode(false);
    const body = table.querySelector(':scope > tbody').cloneNode(false);
    for (const u of rows) body.append(u.el.cloneNode(true));
    t.append(body);
    out.append(t);
    for (const e of [out, ...out.querySelectorAll('[contenteditable], [id]')]) {
      e.removeAttribute('contenteditable');
      e.removeAttribute('id');
    }
    out.contentEditable = 'false';
    this.clones.set(wrap, { node: kid.node, key, el: out });
    return out;
  }

  /** Page `p`'s sheet: div.pg-page at its body top, holding its paper (painted from --page-color), the v1 page number and the
   * page layers (syncLayers). A sheet far from the view is not drawn (content-visibility: its paper and layers take no style,
   * layout or paint; the sheet is absolutely placed and sized, so nothing in the text moves). */
  sheetOf(el, p) {
    const { hidden } = this.model;
    const d = el.ownerDocument;
    let changed = false;
    // In print the gaps go and blank pages take room, so a sheet moves by the blank papers above it less the gaps above it.
    const { pages, real } = this.model;
    const r = p.ri ?? real.indexOf(p);
    const blanks = p.blanks ?? pages.slice(0, pages.indexOf(p)).reduce((a, q) => a + (q.blank ? q.box.h : 0), 0);
    const css = `top:${px(p.bodyTop)}px;height:${px(p.bodyH)}px;--pg-print-dy:${px(blanks - (hidden ? THIN : GAP) * r)}px`
      + (this.near(p) ? '' : ';content-visibility:hidden');
    if (el.pgCss !== css) {
      el.style.cssText = el.pgCss = css;
      changed = true;
    }
    el.pgPage = p;
    let paper = el.querySelector(':scope > .pg-paper');
    if (!paper) paper = el.insertBefore(div(d, 'pg-paper'), el.firstChild);
    const { box } = p;
    const pcss = hidden ? `left:${px(-box.left)}px;top:0;width:${px(box.w)}px;height:${px(p.bodyH)}px`
      : `left:${px(-box.left)}px;top:${px(-p.topOff)}px;width:${px(box.w)}px;height:${px(box.h)}px`;
    if (paper.pgCss !== pcss) paper.style.cssText = paper.pgCss = pcss;
    // Content that runs past its paper (a line taller than the page, planPages over) is covered down to the next paper (layout's
    // place: p.cover), as Word clips it at the page's edge. Print clips it with the page copy's paper.
    let cover = el.querySelector(':scope > .pg-over');
    if (p.cover > 0) {
      cover ??= el.appendChild(div(d, 'pg-over'));
      const ocss = `left:${px(-box.left)}px;top:${px(hidden ? p.bodyH : box.h - p.topOff)}px;width:${px(box.w)}px;height:${px(p.cover)}px`;
      if (cover.pgCss !== ocss) cover.style.cssText = cover.pgCss = ocss;
    } else cover?.remove();
    // The v1 page number (sect.pageNumber) keeps drawing until headers-footers converts it: Word's header and footer distances
    // from the page edge.
    const pn = this.view.state.doc.attrs.sect?.pageNumber;
    let num = el.querySelector(':scope > .pg-number');
    if (pn && !hidden) {
      if (!num) num = el.appendChild(div(d, 'pg-number'));
      const ncss = `width:${px(box.text)}px;text-align:${pn.align};`
        + (pn.at === 'top' ? `top:${px(box.header - p.topOff)}px` : `bottom:${px(box.footer - p.botOff)}px`);
      if (num.pgCss !== ncss) num.style.cssText = num.pgCss = ncss;
      if (num.textContent !== p.label) num.textContent = p.label;
    } else num?.remove();
    // A page that starts inside a row repeats its table's header rows here: no float in the text may cross the row's cells.
    if (p.header != null && p.firstLine > 0 && this.model.units[p.firstUnit]?.row) {
      const head = (el.pgHead ??= el.appendChild(div(d, 'pg-head')));
      const hcss = `width:${px(box.text)}px`;
      if (head.pgCss !== hcss) head.style.cssText = head.pgCss = hcss;
      this.holdHeader(head, p.header);
    } else if (el.pgHead) {
      el.pgHead.remove();
      el.pgHead = null;
    }
    return changed;
  }

  /** The sheet's own box (`--pg-*` on .page, read first by document.css): no paper of its own, the column's width (the last
   * section's text: blockDecorations narrows or widens the blocks of other sections from it), padding reaching the widest paper
   * and the first and last pages' margins. null clears them. → true when they changed. */
  sheet(real, hidden = this.model?.hidden) {
    const page = this.view.dom.closest('.page');
    if (!page) return false;
    let vars = null;
    if (real?.length) {
      const { doc } = this.view.state;
      const text = sectionShifts([sectionsOf(doc).at(-1).sect], doc.attrs.settings).column;
      const left = Math.max(...real.map((p) => p.box.left));
      const right = Math.max(...real.map((p) => p.box.w - p.box.left)) - text;
      // The last section's text height, as the width is its; blocks of other sections carry their own (blockDecorations).
      vars = { w: text, left, right, top: hidden ? 0 : real[0].topOff, bottom: hidden ? 0 : real.at(-1).botOff, body: sectionBodies(real, sectionsOf(doc).length).at(-1) };
    }
    const css = vars ? JSON.stringify(vars) : '';
    if (css === this.sheetCss) return false;
    this.sheetCss = css;
    for (const k of ['w', 'left', 'right', 'top', 'bottom', 'body']) page.style.setProperty(`--pg-${k}`, vars ? `${px(vars[k])}px` : null);
    for (const [k, v] of [['min', '0px'], ['sheet', 'transparent'], ['shadow', 'none']]) page.style.setProperty(`--pg-${k}`, vars ? v : null);
    return true;
  }

  /** The sheet's box from the sections alone (their papers, no reservations), written with the editor before the document's
   * first style pass. The --pg-* values are inherited, so writing them later restyles the whole document (seconds on a long
   * one); the first measure then changes them only when a header or note area takes more than a margin. */
  guessSheet() {
    const { doc } = this.view.state;
    if (this.view.dom.closest('[data-story]') || !this.wanted() || !doc.attrs.sect) return;
    const set = doc.attrs.settings ?? {};
    const list = sectionsOf(doc).flatMap(({ sect }, section) => [1, 2].map((number) => {
      const box = paperOf(sect, { mirror: !!set.mirrorMargins, gutterAtTop: !!set.gutterAtTop, number });
      return { box, section, topOff: box.top, botOff: box.bottom, bodyH: Math.max(1, box.h - box.top - box.bottom) };
    }));
    this.sheet(list, !options.whiteSpace());
  }

  /** Each page layer's div on each page's sheet, redrawn in place where its key(state, page) changed, on the pages near the view
   * (and the drawn pages `also`, by index): a page further away keeps its last drawing until it comes near. No layer: no work. */
  syncLayers(also = null, budget = Infinity) {
    this.unobserved(() => this.drawLayers(also, budget)); // the layers sit in the page end widgets, inside the text's DOM
  }

  drawLayers(also, budget) {
    this.layersLeft = false;
    const list = layers();
    if (!list.length && !this.shownLayers.length) return;
    const geo = paginationKey.getState(this.view.state).geo;
    const sheets = [...this.view.dom.querySelectorAll(':scope > .pg-pages > .pg-page')];
    const ids = new Set(list.map((l) => l.id));
    const fresh = list !== this.shownLayers; // a layer came, went or was replaced: redraw every page
    this.shownLayers = list;
    const real = geo?.pages.filter((p) => !p.blank) ?? [];
    const hidden = this.model?.hidden;
    sheets.forEach((pe, i) => {
      const page = real[i];
      pe.pgLayers ??= new Map();
      pe.pgKeys ??= new Map();
      if (fresh) pe.pgKeys.clear();
      for (const [id, d] of pe.pgLayers) {
        if (ids.has(id)) continue;
        d.remove();
        pe.pgLayers.delete(id);
      }
      if (!page) return;
      const { box } = page;
      const off = page.bodyTop - page.top;
      for (const l of list) {
        let d = pe.pgLayers.get(l.id);
        if (!d) {
          d = div(pe.ownerDocument, 'pg-layer');
          d.dataset.layer = l.id;
          pe.pgLayers.set(l.id, d);
          pe.append(d);
        }
        const clip = hidden ? `;clip-path:inset(${px(off)}px 0 ${px(box.h - off - page.bodyHeight)}px 0)` : '';
        // Its layout and size contained: a layer that measures what it drew (header and footer heights) lays out itself alone.
        const css = `left:${px(-box.left)}px;top:${px(-off)}px;width:${px(box.w)}px;height:${px(box.h)}px;z-index:${l.z};contain:layout size${clip}`;
        if (d.pgCss !== css) d.style.cssText = d.pgCss = css;
      }
    });
    if (!geo) return;
    const near = (i) => also?.has(i) || this.near(real[i]);
    const work = layerWork(list, real.slice(0, sheets.length), this.view.state, (i) => (near(i) ? sheets[i].pgKeys : null));
    const t0 = performance.now();
    for (const [n, { i, layer }] of work.entries()) {
      // Past `budget` ms the rest wait for the next frame (their keys go, so they count as changed): the first frame after a
      // long document opens drew every near page's header and footer, about 100 ms on the Word fixture.
      if (n && performance.now() - t0 > budget) {
        for (const w of work.slice(n)) sheets[w.i].pgKeys.delete(w.layer.id);
        this.layersLeft = true;
        break;
      }
      const d = sheets[i].pgLayers.get(layer.id);
      d.replaceChildren();
      try {
        layer.render(d, real[i], this.view);
      } catch (e) {
        console.error(`page layer ${layer.id}:`, e);
      }
    }
  }

  // ---------- publishing ----------

  /** The document position where line `line` of unit `x` starts: a binary search on the lines' coordinates (posAtCoords needs the
   * page on screen). */
  posAtLine(x, line, R) {
    if (x.cols) return this.rowStart(x, line, R);
    if (x.row) {
      // After the round's writes a row not read since its last change stands at its start (reading it lays the document out).
      if (this.wrote && this.rowsRead.get(x.el)?.node !== x.node) return x.pos;
      // A page inside a row starts at the first line it holds in the row's first cell that has one (a page's range is one span of
      // the document, so the other cells' lines are not in it).
      const { cells, L } = this.rowOf(x, R);
      const cut = L[line - 1]?.bottom ?? -Infinity;
      for (const c of cells) {
        const l = c.lines.find((n) => n.bottom > cut + 0.5);
        if (l) return l.blk ? this.posAtLine(l.blk, l.i, R) : x.pos;
      }
      return x.pos;
    }
    // After the round's writes a read lays the whole document out again (seconds on a long one): the start found before them
    // stands until the next round, else the block's start.
    if (this.wrote) {
      const h = this.lineStarts.get(x.el);
      return x.pos + (h?.node === x.node ? h.offs.get(line)?.off ?? 0 : 0);
    }
    const L = this.linesOf(x, R);
    const want = L[line]?.top;
    if (want == null) return x.pos;
    // Kept per block for its node and the line's top as read: layout() searches before the round's writes and publish then finds
    // it here (searched after the writes, the first read laid the whole document out again, and coordinates read after the writes
    // against a line top read before them found the line above when the page end moved).
    let hit = this.lineStarts.get(x.el);
    if (hit?.node !== x.node) this.lineStarts.set(x.el, (hit = { node: x.node, offs: new Map() }));
    const was = hit.offs.get(line);
    if (was?.want === want) return x.pos + was.off;
    const top = this.topIn(x);
    let lo = x.pos + 1;
    let hi = x.pos + x.node.nodeSize - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const y = top(mid);
      if (y >= want - 1) hi = mid;
      else lo = mid + 1;
    }
    hit.offs.set(line, { want, off: lo - x.pos });
    return lo;
  }

  /** p → the layout y of the top of position p's line inside top-level block unit `x` (layoutY's 'top', -Infinity where there is
   * none). The position is found from the block's own view description: ProseMirror's coordsAtPos walks the document's top-level
   * blocks from the start on every call, and the page starts of a long document took tens of thousands of calls. */
  topIn(x) {
    const { view } = this;
    const desc = x.el.pmViewDesc;
    const r0 = view.dom.getBoundingClientRect();
    const z = scaleOf(view);
    const exact = (p) => {
      try {
        return layoutY(view, p, 'top');
      } catch {
        return -Infinity;
      }
    };
    if (!desc?.contentDOM || desc.node !== x.node) return exact;
    return (p) => {
      let at;
      try {
        at = desc.domFromPos(p - x.pos - desc.border, 1);
      } catch {
        return exact(p);
      }
      const r = rectAt(at.node, at.offset);
      return r ? (r.top - r0.top) / z : exact(p);
    };
  }

  /** Where row `row` of flowing columns unit `x` starts. */
  rowStart(x, row, R) {
    return x.pos + (this.rowStarts(x, R)[row] ?? 0);
  }

  /** The start of each row of flowing columns unit `x`, as offsets from x.pos, kept on its element. The text up to a row start
   * decides where it falls, so after an edit the rows that start before the first changed block keep their offsets with no read.
   * The first row after it is checked with two reads (the position starts the row, the one before it does not) at its old offset
   * moved by the size change: when it holds, the rest of the text starts at the same place, so every later row moves the same way.
   * Only the rows between, usually none, need a binary search. That keeps the 200-page keypress at a few reads. */
  rowStarts(x, R) {
    const { el, node } = x;
    const rows = this.linesOf(x, R);
    const key = `${el.pgColsKey}:${x.cw}`;
    const old = el.pgRows;
    if (old?.node === node && old.key === key && old.offs.length === rows.length) return old.offs;
    // After the round's writes (publish) a search would lay the whole document out again: the starts searched before them
    // stand, and the next round searches again (columns() changed a layout, so one follows).
    if (this.wrote) return old?.node === node ? old.offs : [0];
    const y = this.topIn(x);
    const end = x.pos + node.nodeSize - 1;
    const search = (lo, want) => {
      let hi = end;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (y(mid) >= want - 1) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    // The changed children: identical ones before `a` and after the last `tail` (on both nodes).
    let a = 0;
    let tail = 0;
    let headEnd = 1; // offsets below this lie in the unchanged start
    let tailFrom = Infinity; // old offsets from this lie in the unchanged end
    const same = old && old.key === key && old.node.attrs === node.attrs;
    if (same) {
      const n0 = old.node.childCount;
      const n1 = node.childCount;
      while (a < n0 && a < n1 && old.node.child(a) === node.child(a)) {
        headEnd += node.child(a).nodeSize;
        a++;
      }
      let o = 1 + old.node.content.size;
      while (tail < n0 - a && tail < n1 - a && old.node.child(n0 - 1 - tail) === node.child(n1 - 1 - tail)) {
        o -= old.node.child(n0 - 1 - tail).nodeSize;
        tail++;
      }
      tailFrom = o;
    }
    const d = same ? node.content.size - old.node.content.size : 0;
    const offs = [0];
    for (let r = 1; r < rows.length; r++) {
      const prev = x.pos + offs[r - 1];
      const was = same ? old.offs[r] : undefined;
      if (was != null && was < headEnd) {
        offs.push(was);
        continue;
      }
      const want = rows[r].top;
      if (was != null && was >= tailFrom) {
        const p = x.pos + was + d;
        if (p > prev && p <= end && y(p) >= want - 1 && !(y(p - 1) >= want - 1)) {
          // Same text from a row start at the same place: the rows after it move by d as well.
          for (let k = r; k < rows.length && old.offs[k] != null; k++) offs.push(old.offs[k] + d);
          if (offs.length === rows.length) break;
          r = offs.length - 1;
          continue;
        }
      }
      offs.push(search(prev + 1, want) - x.pos);
    }
    el.pgRows = { node, key, offs };
    return offs;
  }

  /** Publishes geo from the model (geometry.js reads it): PageBoxes, SectionBoxes and each top-level block's page. */
  publish() {
    const { view, model: m } = this;
    const { state } = view;
    const now = paginationKey.getState(state);
    if (!m) return;
    const fresh = this.dirty || !this.published || this.published.doc !== state.doc;
    // The caret's page from the page starts (no read: coordsAtPos after the frame's writes laid the whole document out again,
    // seconds on a long one).
    const caretPage = (starts) => starts.idx[indexAt(starts.from, state.selection.head)] ?? 0;
    if (!fresh && now.geo) {
      const page = caretPage(this.published.starts);
      this.published.sel = state.selection;
      this.published.page = page;
      if (now.geo.page !== page) now.geo = { ...now.geo, page };
      // SectionBox.cols follows the columns node holding the head: worked out again only when the head moved to another one.
      const holder = colsHolder(state);
      if (holder !== this.published.holder) {
        this.published.holder = holder;
        const cols = colsOf(state, now.geo.sections);
        now.geo = { ...now.geo, sections: now.geo.sections.map((s, j) => ({ ...s, cols: cols[j] })) };
      }
      if (now.page !== page + 1) view.dispatch(state.tr.setMeta(paginationKey, { page: page + 1 }).setMeta('addToHistory', false));
      return;
    }
    const { pages, units, kids, R } = m;
    const size = state.doc.content.size;
    // The page of each unit's first line, then the first top-level block's page per block.
    const unitPage = new Array(units.length).fill(-1);
    pages.forEach((p, i) => {
      if (p.blank) return;
      const end = !p.cut ? units.length : units[p.cut.unit].kind === 'break' || p.cut.line > 0 ? p.cut.unit + 1 : p.cut.unit;
      for (let j = p.firstUnit + (p.firstLine > 0 ? 1 : 0); j < end; j++) if (unitPage[j] < 0) unitPage[j] = i;
    });
    for (let j = 0, last = 0; j < units.length; j++) {
      if (unitPage[j] < 0) unitPage[j] = last;
      last = unitPage[j];
    }
    const blocks = kids.map((k) => unitPage[k.u0] ?? 0);
    const starts = kids.map((k) => k.pos);
    // A page that starts inside a block starts at the line (a binary search on coordinates) once it is drawn; one not drawn yet
    // (progressive) at that block's start.
    const from = pages.map((p, i) => {
      if (i === 0) return 0;
      if (p.blank) return null;
      const x = units[p.firstUnit];
      if (!x) return size;
      return p.firstLine > 0 && !x.widget && p.ri < m.shown ? this.posAtLine(x, p.firstLine, R) : x.pos;
    });
    for (let i = from.length - 1, next = size; i >= 0; i--) {
      if (from[i] == null) from[i] = next;
      next = from[i];
    }
    // The drawn pages' starts, ascending, for the caret's page (a position where a page starts is on that page, as coordsAtPos
    // put it on the line after).
    const tops = { from: [], idx: [] };
    pages.forEach((p, i) => {
      if (p.blank) return;
      tops.from.push(from[i]);
      tops.idx.push(i);
    });
    const page = caretPage(tops);
    const secs = sectionsOf(state.doc);
    let inSection = 0;
    const out = pages.map((p, i) => {
      inSection = i && pages[i - 1].section === p.section ? inSection + 1 : 0;
      return { index: i, from: from[i], to: Math.max(from[i], from[i + 1] ?? size), section: p.section, inSection, number: p.number, label: p.label,
        part: p.part, blank: p.blank, top: p.top, bodyTop: p.bodyTop, bodyHeight: p.bodyH, box: p.box,
        // Whether its page ends are drawn yet (progressive): below the last drawn one the text is one flow, nowhere near its plan.
        drawn: !p.blank && p.ri < m.shown,
        // Where the page's text starts below its pusher and where its page end cuts it (layout px): a float the text wraps round
        // there (float-layout PAGE_WRAP_PASS) must end by the cut, or it pushes the page end's spacer, and the cut, down.
        textTop: p.contentTop ?? p.bodyTop, cut: p.cutY ?? p.bodyTop + p.bodyH };
    });
    const firsts = secs.map((s) => pageOfPos(blocks, starts, s.from));
    const cols = colsOf(state, secs);
    const sections = secs.map((s, j) => {
      const firstPage = firsts[j];
      const next = secs[j + 1];
      const last = !next ? out.length - 1 : Math.max(firstPage, firsts[j + 1] - (out[firsts[j + 1]]?.from === next.from ? 1 : 0));
      return { index: s.index, from: s.from, to: s.to, sect: s.sect, firstPage, pages: last - firstPage + 1, cols: cols[j] };
    });
    // ponytail: geo is replaced inside the plugin state without a transaction, as engine 1 did; the counts transaction below carries
    // the page count for React readers (StatusBar).
    now.geo = { engine: 2, version: ++this.relayouts, page, pages: out, sections, blocks, starts };
    this.published = { doc: state.doc, sel: state.selection, page, holder: colsHolder(state), starts: tops };
    this.dirty = false;
    if (now.pages !== out.length || now.page !== page + 1) {
      view.dispatch(state.tr.setMeta(paginationKey, { counts: [out.length], pages: out.length, page: page + 1 }).setMeta('addToHistory', false));
    }
  }
}


/** The client rect of DOM position (`node`, `offset`) as ProseMirror's coordsAtPos takes it for a top edge: the character after it
 * in a text node (before it at the node's end), else the child element after (or before) it; null without one. */
function rectAt(node, offset) {
  if (node.nodeType === 3) {
    const n = node.length;
    if (!n) return null;
    const range = rangeIn(node.ownerDocument);
    const from = offset < n ? offset : n - 1;
    range.setStart(node, from);
    range.setEnd(node, from + 1);
    const rs = range.getClientRects();
    return offset < n ? rs[0] ?? null : rs[rs.length - 1] ?? null;
  }
  const after = node.childNodes[offset];
  const child = after ?? node.childNodes[offset - 1];
  if (!child) return null;
  if (child.nodeType === 3) return rectAt(child, after ? 0 : child.length);
  return child.getClientRects?.()[0] ?? null;
}

/** SectionBox.cols (plan.md §1.9) of each of `secs` (ascending ranges): the column boxes of the columns node holding the selection
 * head in that section, else of its first columns node, else null; px from the text's left edge, across the section's own text
 * width (its first page can belong to the section before, after a continuous break). One walk over the blocks for all the
 * sections: one per section took about 40 ms a publish on the Word fixture's 414 sections. */
function colsOf(state, secs) {
  const { doc, selection } = state;
  const hit = new Array(secs.length).fill(null);
  const first = new Array(secs.length).fill(null);
  let j = 0;
  doc.forEach((n, pos) => {
    if (n.type.name !== 'columns') return;
    while (j < secs.length && pos >= secs[j].to) j++;
    if (j >= secs.length || pos < secs[j].from) return;
    first[j] ??= n;
    if (selection.head > pos && selection.head < pos + n.nodeSize) hit[j] = n;
  });
  return secs.map((s, i) => {
    const n = hit[i] ?? first[i];
    return n ? colBoxes(n.attrs, paperOf(s.sect, { gutterAtTop: !!doc.attrs.settings?.gutterAtTop }).text) : null;
  });
}

/** The top-level columns node holding the selection head, or null. */
function colsHolder(state) {
  const $h = state.selection.$head;
  return $h.depth >= 1 && $h.node(1).type.name === 'columns' ? $h.node(1) : null;
}

/** Element `el`'s top (or `side`) in layout px from the text's top, unrounded (R from Engine.read). */
function fy(el, R, side = 'top') {
  return (el.getBoundingClientRect()[side] - R.top) / R.z;
}

/** The rows of flowing columns node `el` as its lines, in layout px: each row as tall as the column height it was given, the last
 * one as tall as the box's rest (R from Engine.read). */
function rowsOf(el, R) {
  const top = fy(el, R);
  const h = fy(el, R, 'bottom') - top;
  const c = el.pgCols;
  if (c?.mode !== 'flow') return [{ top, bottom: top + h }];
  const step = c.h + c.g;
  const rows = Math.max(1, Math.ceil((h - 0.5 + c.g) / step));
  return Array.from({ length: rows }, (_, i) => ({ top: top + i * step, bottom: i < rows - 1 ? top + i * step + c.h : top + h }));
}

/** Justified's translate on the top-level block holding `el` (layout px): drawn only, the flow leaves it out. */
const dyOf = (el) => Number(el.closest('[data-pg-dy]')?.dataset.pgDy) || 0;
/** The decoration sets of `state`'s plugins but pagination's own (its page ends and block decorations), in plugin order. */
const decoSets = (state) => state.plugins.filter((p) => p.props.decorations && p.spec.key !== paginationKey && !p.spec.pgOwn)
  .map((p) => p.props.decorations.call(p, state));

/** What of a layer's footnotes (layer.notes) moves page ends besides their places: the separator and the notes' heights. */
const notesKey = (n) => (n?.refs.length ? `${n.sep}|${n.refs.map((r) => `${r.h}/${r.first}`).join()}` : '');

/** fy for a block or a row, without Justified's translate. */
const by = (el, R, side) => fy(el, R, side) - dyOf(el);
