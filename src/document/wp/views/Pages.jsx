// Side to Side and Multiple Pages (briefs/views.md; index-layout.md 293): the flow layout has no pages as columns, so pages are
// shown as clipped read-only copies (geometry.js pageClone) over the editor area, right of the vertical ruler: Side to Side one or
// two across, fitted to the window's height with the zoom set to that fit and switched off (Word's), Multiple Pages in the Zoom
// dialog's grid. Arrows, PageUp, PageDown and the wheel turn them; in Side to Side a turn moves the caret to the first page shown
// and a click puts it on the page clicked, so the rulers (ruler package) sit on the caret's page. Side to Side has a Thumbnails
// bar with a grid of every page (Ctrl+wheel toggles it, Word's). A double-click on a page returns to Vertical at that page.
// ponytail: the copies are pictures of the text, not editable pages, and are redrawn whole after each relayout; editing sideways
// needs a page renderer (engine 2's page ranges, plan.md §1.9) drawing each page on its own.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { LayoutGrid } from 'lucide-react';
import { Selection } from '@tiptap/pm/state';
import { setZoom } from '../../../app/actions.js';
import { getState, useStore } from '../../../app/store.js';
import { useViewportBox } from '../../../app/viewport.js';
import { geometryOf, pageClone, paginationKey } from '../../geometry.js';
import { setMove, settled, sideways, useMove } from './state.js';
import { GAP, sideFit, ZOOM_MAX, ZOOM_MIN } from './views.mjs';

const PAD = 24;
const THUMB = 0.16; // the scale of a thumbnail

/** Puts the caret of `ed` in the first text of page `index` (no scroll: the editor is under the copies). A page's `from` between
 * two blocks would resolve to the end of the block before, on the page before. */
function caretTo(ed, index) {
  const page = geometryOf(ed.state)?.pages[index];
  if (page) ed.view.dispatch(ed.state.tr.setSelection(Selection.near(ed.state.doc.resolve(page.from), 1)));
}

/** Back to Vertical with the caret at the start of page `index` (setMove scrolls it into view). */
function toVertical(ed, index) {
  caretTo(ed, index);
  setMove('vertical');
  ed.view.focus();
}

/** Fills `el` with copies of `pages` (indices) of `ed` at `scale`, each in a cell carrying data-page, and tells the rulers. */
function draw(el, ed, pages, scale) {
  el.replaceChildren(...pages.map((i) => {
    const cell = document.createElement('div');
    cell.dataset.page = String(i);
    cell.className = 'shrink-0 shadow-md';
    const copy = pageClone(ed.view, i, { scale, match: true });
    if (copy) cell.append(copy);
    return cell;
  }));
  dispatchEvent(new Event('pagesdrawn'));
}

/** The first page of the screen holding page `i`: screens of `per` pages from page 1, as a book's spreads. */
const screenOf = (i, per, count) => Math.max(0, Math.min(i, count - 1) - (Math.min(i, count - 1) % per));

export function Pages() {
  const move = useMove();
  const ed = useStore((s) => s.editor);
  const frame = useRef(null);
  const sheet = useRef(null);
  const [version, setVersion] = useState(0);
  const [cols, setCols] = useState(2); // Side to Side's pages across, as the last draw fitted them
  const count = (ed && geometryOf(ed.state)?.pages.length) || 0;
  const side = move.kind === 'side';
  const per = side ? cols : move.grid.cols * move.grid.rows;
  const first = screenOf(move.first, per, count);
  // Right of the vertical ruler's column (a [data-viewport-inset] strip), as the editor's own viewport is.
  const inner = useViewportBox(true);
  const outer = useViewportBox(true, true);
  const left = inner && outer ? inner.left - outer.left : 0;

  // Redraw after an edit or a relayout that changes the page count (pagination's meta transaction), at most every 200 ms while
  // they keep coming: put off until they stopped, the copies stayed blank papers for most of a long document's layout.
  useEffect(() => {
    if (!ed) return undefined;
    let t = 0;
    const later = ({ transaction: tr }) => {
      // A page copy of a page not drawn yet is a blank paper: the progress of the page layout draws it again.
      if (!tr.docChanged && tr.getMeta(paginationKey)?.pages == null && !tr.getMeta(paginationKey)?.progress) return;
      t ||= setTimeout(() => {
        t = 0;
        setVersion((v) => v + 1);
      }, 200);
    };
    ed.on('transaction', later);
    return () => (clearTimeout(t), ed.off('transaction', later));
  }, [ed]);

  useLayoutEffect(() => {
    const el = sheet.current;
    const box = frame.current;
    if (!ed || !el || !box) return undefined;
    let cancel = () => {};
    const paint = () => {
      const pages = geometryOf(ed.state)?.pages;
      const page = pages?.[0]?.box;
      if (!page) return el.replaceChildren();
      if (move.thumbs) return draw(el, ed, [...pages.keys()], THUMB);
      const area = { w: box.clientWidth - 2 * PAD, h: box.clientHeight - 2 * PAD };
      let n = move.grid.cols;
      let scale = Math.min((area.w - (n - 1) * GAP) / (n * page.w), (area.h - (move.grid.rows - 1) * GAP) / (move.grid.rows * page.h));
      if (side) {
        const fit = sideFit(area, page);
        n = fit.cols;
        // The zoom becomes the fit (the status bar shows it), and the editor under the copies lays out at it, as they do.
        const pct = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(fit.scale * 10000) / 100));
        scale = pct / 100;
        setCols(n);
        const zoom = getState().zoom; // setZoom's value ('fit' or a percent to 0.01); zoomPct is its whole percent
        if (!(Math.abs(zoom - pct) <= 0.01) && sideways()) {
          setZoom(pct);
          cancel = settled(ed, paint);
          return undefined;
        }
      }
      const k = side ? n : n * move.grid.rows;
      const from = screenOf(move.first, k, pages.length);
      draw(el, ed, [...Array(k).keys()].map((j) => from + j).filter((i) => i < pages.length), Math.max(0.05, scale));
      el.style.gridTemplateColumns = `repeat(${n}, max-content)`;
      return undefined;
    };
    const again = () => {
      cancel();
      cancel = settled(ed, paint);
    };
    again();
    const ro = new ResizeObserver(again);
    ro.observe(box);
    return () => (cancel(), ro.disconnect());
  }, [ed, move, version, side]);

  useEffect(() => frame.current?.closest('[data-page-move]')?.focus(), []);

  /** Shows the screen holding page `i`; in Side to Side the caret goes to its first page. */
  const go = (i) => {
    const f = screenOf(i, per, count);
    setMove(move.kind, { first: f });
    if (side && ed) caretTo(ed, f);
  };
  const onKey = (e) => {
    const k = e.key;
    if (move.thumbs) return;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown') go(first + per);
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') go(Math.max(0, first - per));
    else if (k === 'Home') go(0);
    else if (k === 'End') go(count - 1);
    else return;
    e.preventDefault();
  };
  const wheelAt = useRef(0);
  const onWheel = (e) => {
    if (Date.now() - wheelAt.current < 250 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
    if (e.ctrlKey) { // Word's: Ctrl+wheel goes between the pages and their thumbnails (the zoom is off here)
      if (!side || !e.deltaY) return;
      wheelAt.current = Date.now();
      setMove('side', { thumbs: e.deltaY > 0 });
      return;
    }
    if (move.thumbs) return;
    wheelAt.current = Date.now();
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? 1 : -1;
    go(Math.max(0, first + d * per));
  };
  const pageOf = (e) => Number(e.target.closest('[data-page]')?.dataset.page ?? NaN);
  const onClick = (e) => {
    const i = pageOf(e);
    if (!Number.isFinite(i) || !ed) return;
    if (move.thumbs) {
      setMove(move.kind, { thumbs: false, first: i });
      caretTo(ed, i);
    } else if (side) caretTo(ed, i);
  };
  const onDouble = (e) => {
    const i = pageOf(e);
    if (Number.isFinite(i) && ed) toVertical(ed, i);
  };
  const last = Math.min(first + per, count);

  return (
    <div data-page-move={move.kind} tabIndex={-1} onKeyDown={onKey} onWheel={onWheel} style={{ left }}
      className="pointer-events-auto absolute inset-y-0 right-0 z-10 flex flex-col bg-(--pg-bg) outline-none">
      {side && (
        <div data-thumbs-bar="" className="flex h-8 shrink-0 items-center gap-2 border-b bg-card px-2 text-xs">
          <button type="button" data-thumbs-toggle="" aria-pressed={move.thumbs} onClick={() => setMove('side', { thumbs: !move.thumbs })}
            className={cn('flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent', move.thumbs && 'bg-accent')}>
            <LayoutGrid className="size-3.5" />Thumbnails
          </button>
          <span className="text-muted-foreground">
            {!count ? '' : last - first > 1 ? `Pages ${first + 1} to ${last} of ${count}` : `Page ${first + 1} of ${count}`}
          </span>
        </div>
      )}
      <div ref={frame} className={cn('relative min-h-0 flex-1', move.thumbs ? 'overflow-auto' : 'overflow-hidden')} onClick={onClick} onDoubleClick={onDouble}>
        <div ref={sheet} data-pages-sheet="" className={cn(move.thumbs ? 'flex flex-wrap content-start gap-4' : 'absolute inset-0 grid content-center justify-center')}
          style={{ padding: PAD, gap: move.thumbs ? 16 : GAP }} />
      </div>
    </div>
  );
}
