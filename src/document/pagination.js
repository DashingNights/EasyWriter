// A Document's pages on screen (docs/plans/document.md Page view, step 9): float-widget pagination, own code with
// tiptap-pagination-plus 3.1.0 (MIT) as the reference for the technique, none of its code. A widget at the start of the text,
// and one after each top-level page break, holds a float stack: per page a spacer as tall as the page's text area (it carries
// the page number), and between two pages a full-width breaker drawing the bottom margin, the gap and the next top margin.
// Lines wrap around floats, so text crosses a page end line by line; a table row, a grid of its own (document.css), moves
// whole. A page break clears the floats before it, so it starts at its page's text bottom and draws the page end itself.
// The plugin only keeps the number of spacers right: after each change it measures where each run of text ends (offsetTop,
// layout px, so the zoom's transform does not count) in requestAnimationFrame, and redraws through a meta-only transaction,
// measuring again in the same frame until the count holds (objects moving whole past new page ends need more than one
// pass), so no frame paints a sheet that is not whole pages. Objects that scale themselves to a page ([data-pg-fit], their
// pgFit()) fit first, so a measure never counts one unscaled.
// Its state also holds the caret's page for the status bar (Page X of Y). Imports no app module: Node tests load schema.js.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ptToPx } from '../office.mjs';
import { GAP, pageAt, pageGuard, pagesFor } from './pages.mjs';

export const paginationKey = new PluginKey('pagination');

/** The page in px (DOCUMENT.paper's numbers): text width and height, margins, and the breaker between two pages. */
function pageBox(sect) {
  const px = Object.fromEntries(['top', 'right', 'bottom', 'left', 'header', 'footer'].map((k) => [k, ptToPx(sect.margin[k] ?? 0)]));
  const w = ptToPx(sect.w);
  const body = ptToPx(sect.h) - px.top - px.bottom;
  return { ...px, w, text: w - px.left - px.right, body, breaker: px.bottom + GAP + px.top };
}

/** Where each run of text starts: 0 and after each top-level page break. */
function runStarts(doc) {
  const at = [0];
  doc.forEach((n, pos) => {
    if (n.type.name === 'pageBreak') at.push(pos + 1);
  });
  return at;
}

const el = (doc, cls, style, text) => Object.assign(doc.createElement('div'), { className: cls, style, textContent: text ?? '' });

/** One run's float stack: `pages` spacers with breakers between them; `first` is the first page's number (0-based). */
function stack(view, box, pages, first, sect) {
  const d = view.dom.ownerDocument;
  const root = el(d, 'pg-pages');
  root.contentEditable = 'false';
  const pn = sect.pageNumber;
  for (let i = 0; i < pages; i++) {
    if (i) root.append(el(d, 'pg-breaker', `width:${box.w}px;margin-left:${-box.left}px;height:${box.breaker}px;`
      + `background:linear-gradient(#ffffff ${box.bottom}px, var(--pg-bg) 0 ${box.bottom + GAP}px, #ffffff 0)`));
    const page = root.appendChild(el(d, 'pg-page', `height:${box.body}px`));
    // Word's header and footer distances: from the page edge to the header's top, and to the footer's bottom.
    if (pn) page.append(el(d, 'pg-number', `width:${box.text}px;text-align:${pn.align};`
      + (pn.at === 'top' ? `top:${box.header - box.top}px` : `bottom:${box.footer - box.bottom}px`), String(first + i + (pn.start ?? 1))));
  }
  return root;
}

function decorations(doc, counts) {
  const sect = doc.attrs.sect;
  if (!sect) return DecorationSet.empty;
  const box = pageBox(sect);
  const pn = sect.pageNumber ? JSON.stringify(sect.pageNumber) : '';
  let first = 0;
  return DecorationSet.create(doc, runStarts(doc).map((pos, i) => {
    const pages = counts[i] ?? 1;
    const from = first;
    first += pages;
    // The key names everything the DOM shows, so ProseMirror keeps an unchanged stack's DOM.
    return Decoration.widget(pos, (view) => stack(view, box, pages, from, sect),
      { key: `pg${i}:${pages}:${from}:${sect.w}x${sect.h}:${JSON.stringify(sect.margin)}:${pn}`, side: -1, ignoreSelection: true, marks: [] });
  }));
}

export const Pagination = Extension.create({
  name: 'pagination',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: paginationKey,
      state: {
        init: (_, state) => ({ counts: runStarts(state.doc).map(() => 1), page: 1, pages: 1 }),
        apply(tr, value, _, state) {
          const next = tr.getMeta(paginationKey);
          if (next) return next;
          if (!tr.docChanged) return value;
          const n = runStarts(state.doc).length;
          if (n === value.counts.length) return value;
          // A page break came or went: the runs before it keep their counts until the next measure.
          const counts = Array.from({ length: n }, (_, i) => value.counts[i] ?? 1);
          return { ...value, counts, pages: counts.reduce((a, b) => a + b, 0) };
        },
      },
      props: {
        decorations: (state) => decorations(state.doc, paginationKey.getState(state).counts),
      },
      view(view) {
        const settle = pageGuard();
        let frame = 0;
        let version = 0;
        let doc = view.state.doc;
        // One pass: true when it redrew the pages.
        const pass = () => {
          const { state } = view;
          const sect = state.doc.attrs.sect;
          if (!sect || !view.dom.isConnected) return false;
          for (const el of view.dom.querySelectorAll('[data-pg-fit]')) el.pgFit?.();
          if (state.doc !== doc) {
            doc = state.doc;
            version++;
          }
          const box = pageBox(sect);
          const step = box.body + box.breaker;
          const widgets = [...view.dom.querySelectorAll(':scope > .pg-pages')];
          if (widgets.length !== runStarts(state.doc).length) return false; // not drawn yet
          // Each run ends at the bottom of its last block: the one before the next page break, or the doc's last.
          const ends = [];
          let last = -1;
          state.doc.forEach((n, pos) => {
            if (n.type.name !== 'pageBreak') last = pos;
            else {
              ends.push(last);
              last = -1;
            }
          });
          ends.push(last);
          const segments = widgets.map((w, i) => {
            const top = w.offsetTop;
            let end = top;
            const at = ends[i];
            if (at >= 0) {
              const dom = view.nodeDOM(at);
              if (dom?.offsetParent === view.dom) end = Math.max(top, dom.offsetTop + dom.offsetHeight);
            }
            return { top, pages: pagesFor(end - top, box.body, box.breaker) };
          });
          const counts = settle(version, segments.map((s) => s.pages));
          segments.forEach((s, i) => { s.pages = counts[i]; });
          // The caret's page: the middle of its line in layout px (the page's zoom divided out).
          let page = 1;
          try {
            const r = view.dom.getBoundingClientRect();
            const scale = r.height / view.dom.offsetHeight || 1;
            const c = view.coordsAtPos(state.selection.head);
            page = pageAt(((c.top + c.bottom) / 2 - r.top) / scale, segments, step) + 1;
          } catch { /* a position without coordinates: keep page 1 */ }
          const pages = counts.reduce((a, b) => a + b, 0);
          const now = paginationKey.getState(state);
          if (now.page === page && now.pages === pages && now.counts.join() === counts.join()) return false;
          view.dispatch(state.tr.setMeta(paginationKey, { counts, page, pages }).setMeta('addToHistory', false));
          return true;
        };
        const measure = () => {
          frame = 0;
          for (let i = 0; i < 12 && pass(); i++); // pageGuard ends a flip-flop well before 12
        };
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(measure);
        };
        // Layout changes without a transaction (a picture loading, a font arriving, a canvas growing) move text too.
        const resize = new ResizeObserver(schedule);
        resize.observe(view.dom);
        schedule();
        return {
          update(v, prev) {
            if (v.state.doc !== prev.doc || !v.state.selection.eq(prev.selection)) schedule();
          },
          destroy() {
            cancelAnimationFrame(frame);
            resize.disconnect();
          },
        };
      },
    })];
  },
});
