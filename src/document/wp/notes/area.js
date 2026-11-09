// Footnote areas (docs/plans/word/plan.md §1.9 page layers and layout passes, briefs/notes.md How): an 'after' layout pass finds
// each footnote's page (pageAtPos, so a reference inside a long paragraph counts on its own line's page), measures the notes at
// the text width, and splits the areas over the pages (model.mjs splitAreas); the page layer then draws each page's area at the
// bottom of its body, or right under its last text line with Below text. The layer gives the page engine each note's height
// (notes): engine 2 ends a page's text where its notes fit below, and moves a reference line to the next page with its note when
// not even the note's first line fits (page-engine/layout.mjs planPages), so the areas settle in the engine's own round.
import { geometryOf, nodeDOMs, pageAtPos, paginationKey, rangeIn, scaleOf } from '../../geometry.js';
import { indexAt } from '../../geometry.mjs';
import { classTables } from '../../stylesheet.js';
import { lineBoxes } from '../page-engine/layout.mjs';
import { contentId, noteBox, sepBox } from './draw.js';
import { effectivePr, labelsOf, notesOf, sectionsUseEachPage, splitAreas } from './model.mjs';
import { labelsFor, setLabels } from './view.js';

const layouts = new WeakMap(); // doc → Map(page index → {key, parts, cont, notice, height, top, kind})
const measurers = new WeakMap(); // EditorView → {el, boxes: Map(key → element)}

/** The hidden box footnotes are measured in, drawn by the notes widget at the document's start (view.js). Its layout and size are
 * contained, so the browser lays out a note box added in it on its own: without that each box's first read laid the whole document
 * out again. */
export function measurer(view) {
  const d = view.dom.ownerDocument;
  const el = d.createElement('div');
  el.dataset.noteMeasure = '';
  el.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict';
  measurers.set(view, { el, boxes: new Map() });
  return el;
}

/** The line bottoms of `box` from its top in layout px, ascending (for cutting a note between two lines). A measuring box keeps
 * its content, so they are read again only when the zoom or its height (a web font arriving) changes. */
function lineBottoms(box, scale) {
  const h = box.offsetHeight;
  if (box.noteLines?.scale === scale && box.noteLines.h === h) return box.noteLines.out;
  const top = box.getBoundingClientRect().top;
  const range = rangeIn(box.ownerDocument);
  range.selectNodeContents(box);
  const out = new Set();
  for (const r of range.getClientRects()) if (r.height > 0) out.add(Math.round(((r.bottom - top) / scale) * 2) / 2);
  box.noteLines = { scale, h, out: [...out].sort((a, b) => a - b) };
  return box.noteLines.out;
}

/** The bottom of the line box at screen y `mid` in the textblock holding `pos` (layout px from the document top), or null. The
 * page engine keeps a note under its reference's line box (lineBoxes), which ends below the raised reference mark. */
function lineBottom(view, pos, mid, domTop, scale, doms) {
  const $pos = view.state.doc.resolve(pos);
  const el = $pos.parent.isTextblock && $pos.depth > 0 ? (doms ? doms.get($pos.before()) : view.nodeDOM($pos.before())) : null;
  if (!el?.getClientRects) return null;
  const range = rangeIn(el.ownerDocument);
  range.selectNodeContents(el);
  const y = (mid - domTop) / scale;
  const line = lineBoxes([...range.getClientRects()].map((r) => ({ top: (r.top - domTop) / scale, bottom: (r.bottom - domTop) / scale })))
    .find((l) => l.top <= y && y <= l.bottom);
  return line ? line.bottom : null;
}

/** Where the text on page `page` ends (layout px from the paper top): the bottom of the last block whose first line is on it. */
function textBottom(view, geo, page) {
  let bottom = null;
  view.state.doc.forEach((node, pos, i) => {
    if (geo.blocks?.[i] !== page.index) return;
    const el = view.nodeDOM(pos);
    if (el?.offsetParent === view.dom) bottom = el.offsetTop + el.offsetHeight;
  });
  return bottom == null ? null : bottom - page.top;
}

/** The footnotes of `view` measured (kept between frames while their content, label and width hold), with the separators →
 * {notes: [{id, pos, node, label, page, refBottom, h, lines()}], sepH, contH, noticeH, seps, pr, sepKey, geo} or null when no
 * footnote area is drawn. Without `where` no note's page or reference bottom is read: the page engine asks every round and on
 * every keypress and needs only the heights (reading each reference's place cost 100 to 400 ms a round on the Word fixture,
 * whose sections differ in width). A note is measured at its reference's section's text width either way, so the heights the
 * engine plans with are the ones the areas draw. */
function measure(view, where = true) {
  const { state } = view;
  const { doc } = state;
  const geo = geometryOf(state);
  const foot = notesOf(doc).filter((n) => n.node.attrs.kind === 'footnote');
  const m = measurers.get(view);
  if (!foot.length || !geo?.pages?.length || !paginationKey.getState(state)?.draw || !m?.el.isConnected) return null;
  const scale = scaleOf(view);
  const domTop = where ? view.dom.getBoundingClientRect().top : 0;
  // The separators are the document's (Word keeps one set); Bottom of page or Below text is each section's.
  const pr = effectivePr('footnote', doc.attrs.settings, null);
  const labels = labelsFor(view);
  const width = geo.pages[0].box.text;
  // A section's text width is its first page's (sections differ: a landscape one is wider).
  const widthAt = (pos) => geo.pages[geo.sectionOf(pos)?.firstPage]?.box.text ?? width;
  const tops = geo.pages.map((p) => p.bodyTop);
  const ctxAt = (w) => ({ schema: state.schema, doc, width: w, ownerDocument: view.dom.ownerDocument });
  const ctx = ctxAt(width);
  // Every node's DOM from one walk where there are many references (view.nodeDOM walks the top-level blocks per call); a few find
  // theirs one by one (the walk visits every node of the document, tens of ms on the Word fixture).
  let doms = null;

  const seen = new Set();
  const boxOf = (key, make, w = width) => {
    seen.add(key);
    let el = m.boxes.get(key);
    if (!el) {
      el = make() ?? m.el.ownerDocument.createElement('div');
      classTables(el); // the table style's class (stylesheet.js tableStyleClass)
      el.style.width = `${w}px`;
      m.boxes.set(key, el);
      m.el.append(el);
    }
    return el;
  };
  const sepKey = contentId(pr.sep);
  // Every box first, then every height: a read between two new boxes lays the measurer out again.
  const seps = ['separator', 'continuationSeparator', 'continuationNotice'].map((part) => boxOf(`${part}:${width}:${sepKey}`, () => sepBox(ctx, 'footnote', part, pr.sep)));
  const notes = foot.map(({ pos, node }) => {
    const { id, content } = node.attrs;
    const label = labels.get(pos)?.label ?? '';
    let page = 0;
    let refBottom = 0;
    try {
      if (where) {
        // pageAtPos's own read, done once for both.
        const c = view.coordsAtPos(pos, 1);
        page = geo.pages[indexAt(tops, ((c.top + c.bottom) / 2 - domTop) / scale)].index;
        refBottom = lineBottom(view, pos, (c.top + c.bottom) / 2, domTop, scale, (foot.length > 64 ? (doms ??= nodeDOMs(view)) : null)) ?? (c.bottom - domTop) / scale;
      }
    } catch { /* a reference without coordinates counts on page 1 at the top */ }
    const w = widthAt(pos);
    const box = boxOf(`${w}:${contentId(content)}:${label}`, () => noteBox(ctxAt(w), { id, kind: 'footnote', label, content }), w);
    return { id, pos, node, label, page, refBottom, box, lines: () => lineBottoms(box, scale) };
  });
  const [sepH, contH, noticeH] = seps.map((el) => el.offsetHeight);
  for (const n of notes) n.h = n.box.offsetHeight;
  for (const [key, el] of m.boxes) {
    if (seen.has(key)) continue;
    el.remove();
    m.boxes.delete(key);
  }
  return { notes, sepH, contH, noticeH, seps: Math.max(sepH, contH) + noticeH, pr, sepKey, geo };
}

/** The layout pass: footnote pages, exact labels for Restart each page, note heights and the split per page → true when a label
 * changed, which moves text. The areas' heights move none: the page engine laid the pages out with the notes (footnoteLayer.notes). */
export function layoutNotes(view) {
  if (view.dom.hasAttribute('data-story')) return false;
  const { state } = view;
  const { doc } = state;
  let moved = false;
  // Restart each page: the labels need each reference's exact page.
  if (sectionsUseEachPage(doc)) {
    const exact = labelsOf(doc, (pos) => pageAtPos(view, pos));
    const now = labelsFor(view);
    if ([...exact].some(([pos, l]) => now.get(pos)?.label !== l.label)) moved = setLabels(view, exact) || moved;
  }
  const M = measure(view);
  if (!M) {
    layouts.set(doc, new Map());
    return moved;
  }
  const { notes, contH, sepH, noticeH, seps, pr, sepKey, geo } = M;
  const posOf = (page) => effectivePr('footnote', doc.attrs.settings, geo.sections?.[page.section]?.sect).pos;

  // Split over the pages: the area up to each own note must fit below that note's reference line, so a low reference does not
  // push the notes above it off the page.
  const byId = new Map(notes.map((n) => [n.id, n]));
  const split = splitAreas(geo.pages.map((page) => {
    const bodyBottom = page.bodyTop + page.bodyHeight;
    const own = notes.filter((n) => n.page === page.index).map((n) => ({ ...n, room: Math.max(0, bodyBottom - n.refBottom - seps) }));
    // ponytail: a page holding only a continued note gives it half its body (planPages leaves the text the same room).
    return { room: Math.max(0, (own.length ? page.bodyHeight : page.bodyHeight / 2) - seps), notes: own };
  }));
  const out = new Map();
  split.forEach((s, i) => {
    if (!s.parts.length) return;
    const page = geo.pages[i];
    const { box } = page;
    const height = s.height + (s.cont ? contH : sepH) + (s.notice ? noticeH : 0);
    let top = box.h - box.bottom - height;
    if (posOf(page) === 'beneathText') {
      const end = textBottom(view, geo, page);
      if (end != null) top = Math.min(top, Math.max(box.top, end));
    }
    const parts = s.parts.map((p) => {
      const n = byId.get(p.id);
      return { ...p, h: n.h, label: n.label, content: n.node.attrs.content };
    });
    const key = [top, s.cont, s.notice, sepKey, ...parts.map((p) => `${p.id}:${p.label}:${contentId(p.content)}:${p.from}-${p.to}`)].join('|');
    out.set(page.index, { key, parts, cont: s.cont, notice: s.notice, height, top, sep: pr.sep });
  });
  layouts.set(doc, out);
  return moved;
}

/** The footnote area page layer (z 1, over the text): draws `layouts`, and gives the page engine each note's height and first
 * line's (notes) to keep with its reference line. `onArea(el, view)` wires an area's clicks (edit.js). */
export const footnoteLayer = (onArea) => ({
  id: 'notes',
  z: 1,
  key: (state, page) => layouts.get(state.doc)?.get(page.index)?.key ?? '',
  notes(view) {
    if (view.dom.hasAttribute('data-story')) return null;
    const M = measure(view, false);
    return M && { sep: M.seps, refs: M.notes.map((n) => ({ pos: n.pos, h: n.h, first: n.lines()[0] ?? n.h })) };
  },
  render(el, page, view) {
    const a = layouts.get(view.state.doc)?.get(page.index);
    if (!a) return;
    const d = el.ownerDocument;
    const { box } = page;
    const ctx = { schema: view.state.schema, doc: view.state.doc, width: box.text, ownerDocument: d };
    const area = d.createElement('div');
    area.dataset.noteArea = 'footnote';
    area.style.cssText = `position:absolute;left:${box.left}px;top:${a.top}px;width:${box.text}px;pointer-events:auto`;
    const sep = sepBox(ctx, 'footnote', a.cont ? 'continuationSeparator' : 'separator', a.sep);
    if (sep) area.append(sep);
    for (const p of a.parts) {
      const note = noteBox(ctx, { id: p.id, kind: 'footnote', label: p.label, content: p.content });
      if (p.from > 0 || p.to < p.h) {
        // A part of a cut note: a window on the whole note, from its line `from` to its line `to`.
        const clip = d.createElement('div');
        clip.dataset.notePart = p.from > 0 ? 'rest' : 'start';
        clip.style.cssText = `height:${p.to - p.from}px;overflow:hidden`;
        note.style.marginTop = `${-p.from}px`;
        clip.append(note);
        area.append(clip);
      } else area.append(note);
    }
    if (a.notice) {
      const notice = sepBox(ctx, 'footnote', 'continuationNotice', a.sep);
      if (notice) area.append(notice);
    }
    classTables(area);
    el.append(area);
    onArea?.(area, view);
  },
});
