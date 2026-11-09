// Views' viewport slot (plan.md §1.7): Read Mode, the Side to Side and Multiple Pages copies and Immersive Reader's Line Focus draw
// over the editor area here, and the editor area gets the attributes and sizes the views' CSS (style.css) keys on.
import { useEffect, useState } from 'react';
import { getState, useStore } from '../../../app/store.js';
import { wordSettings } from '../../word/settings.mjs';
import { Pages } from './Pages.jsx';
import { areaOpens } from '../../../tooling/surface.js';
import { CanvasReader, Reader } from './Reader.jsx';
import { KEEP, useMove } from './state.js';
import { focusBand } from './views.mjs';
import { afterSlide } from '../../../app/sliding.js';

const SIDE = 16; // layout px of margin inside the sheet in Web Layout and wrapped Draft

/** Writes the views' markers on #editor-area: the Reader's settings, the draft font, and --views-fit, the sheet's width when text
 * wraps to the window (the editor area's width less the home view's margins, at any zoom). */
function useAreaMarkers(view) {
  const word = useStore((s) => wordSettings(s.settings));
  const zoom = useStore((s) => s.zoomPct);
  useEffect(() => {
    const area = document.getElementById('editor-area');
    if (!area) return undefined;
    const set = (k, v) => (v ? area.setAttribute(k, v) : area.removeAttribute(k));
    const im = view === 'immersive' && word.immersive;
    set('data-reader-width', im && im.columnWidth !== 'default' && im.columnWidth);
    set('data-reader-color', im && im.pageColor !== 'none' && im.pageColor);
    set('data-reader-spacing', im?.textSpacing && 'wide');
    set('data-wrap', view === 'draft' && word.display.wrapToWindow && 'window');
    const font = (view === 'draft' || view === 'outline') && word.display.draftFont;
    set('data-draft-font', font?.name && 'on');
    area.style.setProperty('--draft-font', font?.name ? `"${font.name}"` : null);
    area.style.setProperty('--draft-size', font?.size ? `${font.size}pt` : null);
    // Once the sidebar's slide ends (sliding.js): an inherited variable that moves restyles the whole document on every frame.
    const fit = () => afterSlide(fit) || area.style.setProperty('--views-fit', `${Math.max(120, (area.clientWidth - KEEP.left - KEEP.right) / ((zoom || 100) / 100) - 2 * SIDE)}px`);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(area);
    return () => {
      ro.disconnect();
      for (const k of ['data-reader-width', 'data-reader-color', 'data-reader-spacing', 'data-wrap', 'data-draft-font']) area.removeAttribute(k);
    };
  }, [view, word, zoom]);
}

/** Line Focus: the rest of the text dimmed around a band of 1, 3 or 5 lines at the caret, which follows it (Up and Down move it). */
function LineFocus({ n }) {
  const ed = useStore((s) => s.editor);
  const [band, setBand] = useState(null);
  useEffect(() => {
    if (!ed || !n) return undefined;
    // Measured every frame: the caret and the slots' host move for reasons no single event reports (a scroll, a reflow, the
    // page zoom, the ribbon's height). Only a change re-renders.
    // ponytail: one rAF loop while Line Focus is on; switch to events if a profile ever shows it.
    let frame = 0;
    let last = '';
    const place = () => {
      frame = requestAnimationFrame(place);
      const host = document.querySelector('[data-viewport-slots]')?.getBoundingClientRect();
      if (!host || !ed.view.dom.isConnected) return;
      let line;
      try { line = ed.view.coordsAtPos(ed.state.selection.head); } catch { return; }
      if (line.bottom - line.top < 1) { // a caret between blocks has no height: take its paragraph's line height
        const lh = parseFloat(getComputedStyle(ed.view.domAtPos(ed.state.selection.head).node.parentElement ?? ed.view.dom).lineHeight) || 20;
        line = { top: line.top, bottom: line.top + lh };
      }
      // The sheet bounds the band: the text box itself can measure 0 px tall (document.css's float margins), and in the Reader
      // the sheet can end above the text too, so the bounds always take in the caret's line.
      const text = (ed.view.dom.closest('.page') ?? ed.view.dom).getBoundingClientRect();
      const b = focusBand(line, n, { top: Math.min(text.top, line.top), bottom: Math.max(text.bottom, line.bottom) });
      const next = { top: b.top - host.top, bottom: b.bottom - host.top };
      const key = `${next.top},${next.bottom}`;
      if (key !== last) { last = key; setBand(next); }
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [ed, n]);
  if (!band) return null;
  return (
    <div data-line-focus={n} className="absolute inset-0 overflow-hidden">
      <div data-dim="" className="absolute inset-x-0 top-0 bg-black/60" style={{ height: Math.max(0, band.top) }} />
      <div data-line-band="" className="absolute inset-x-0" style={{ top: band.top, height: band.bottom - band.top }} />
      <div data-dim="" className="absolute inset-x-0 bottom-0 bg-black/60" style={{ top: band.bottom }} />
    </div>
  );
}

export function ViewsSlot() {
  const view = useStore((s) => s.word.view);
  const lineFocus = useStore((s) => wordSettings(s.settings).immersive.lineFocus);
  const move = useMove();
  // On a canvas draft the page area shows the views on the engine's pages (CanvasViews.jsx); Read Mode adds its bar here.
  const canvas = useStore(areaOpens);
  // The views are a Document's: a forum post in the page area is one card (post.js), with no Read Mode bar or pages strip.
  const doc = useStore((s) => s.draft?.format === 'document');
  useAreaMarkers(view);
  if (!doc) return null;
  if (canvas) return view === 'read' ? <CanvasReader /> : null;
  return (
    <>
      {view === 'read' && <Reader />}
      {view === 'print' && move.kind !== 'vertical' && <Pages />}
      {view === 'immersive' && lineFocus > 0 && <LineFocus n={lineFocus} />}
    </>
  );
}

// Esc leaves Read Mode and Focus (Word's), unless a dialog, menu or pane field takes it first.
let escBound = false;
/** Binds the window-wide Esc of Read Mode and Focus once. */
export function bindEsc(leave) {
  if (escBound) return;
  escBound = true;
  addEventListener('keydown', (e) => {
    const view = getState().word.view;
    if (e.key !== 'Escape' || e.defaultPrevented || (view !== 'focus' && view !== 'read')) return;
    if (document.querySelector('[role="dialog"], [role="menu"], [data-word-dialog], [data-read-zoom]')) return;
    if (getState().draft?.format !== 'document') return;
    leave();
    e.preventDefault();
  }, true);
}
