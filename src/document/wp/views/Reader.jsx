// Read Mode (briefs/views.md; index-layout.md 281-284): a read-only copy of the laid-out text (the editor's DOM cloned without its
// page widgets, so list labels and field results show, inside a Document-scoped .page so the document's styles apply) set in CSS
// columns one screen high and scrolled one screen at a time. A top bar has File, Tools and View; the status bar shows "Screen n of
// m" from store word.readScreen. A double-click on a picture or table shows it enlarged in place. Esc returns to the view before.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getState, setState, useStore } from '../../../app/store.js';
import { openBackstage } from '../../ribbon/Backstage.jsx';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { run } from '../../../tooling/registry.js';
import { REASONS } from '../../../tooling/reasons.mjs';
import { paneOpen } from '../../../tooling/panes.jsx';
import { drawAll } from '../../lazy.mjs';
import { hyphenate } from '../layout-misc/hyphenate.mjs';
import { leaveView, setView } from './state.js';
import { readColumns, screenCount, SYLLABLE_WORD, syllabify } from './views.mjs';

const GAP = 48; // px between columns, and between one screen and the next
const PAD = 32; // px around the text on the screen

/** `root` with a middle dot at each syllable break of every word (Syllables), from layout-misc's hyphenate.mjs. */
function addSyllables(root) {
  const walk = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) n.data = n.data.replace(SYLLABLE_WORD, (w) => syllabify(w, hyphenate));
}

/** The text to read: a copy of the editor's DOM without the page widgets, layers or editing state. */
function copyOf(view, syllables) {
  drawAll(view); // the objects that wait to draw (lazy.mjs) draw first, so the copy shows them
  const copy = view.dom.cloneNode(true);
  copy.querySelectorAll('.pg-pages, .pg-layer, .ProseMirror-gapcursor, .ProseMirror-separator').forEach((el) => el.remove());
  for (const el of [copy, ...copy.querySelectorAll('[id], [contenteditable]')]) {
    el.removeAttribute('id');
    el.removeAttribute('contenteditable');
  }
  copy.removeAttribute('data-doc-text'); // the copy is no editor: Word's keys must not take it for Document text
  copy.classList.remove('ProseMirror-focused');
  if (syllables) addSyllables(copy);
  return copy;
}

/** A menu of the top bar. */
const Menu = ({ label, children }) => (
  <DropdownMenu modal={false}>
    <DropdownMenuTrigger data-read-menu={label} className="rounded-md px-2 py-1 hover:bg-accent data-[state=open]:bg-accent">{label}</DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-48 text-xs" onCloseAutoFocus={(e) => { e.preventDefault(); document.querySelector('[data-read-mode]')?.focus(); }}>
      {children}
    </DropdownMenuContent>
  </DropdownMenu>
);

/** A radio submenu of the View menu writing settings.word.readMode[key]. */
const Choice = ({ label, value, options, onPick }) => (
  <DropdownMenuSub>
    <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
    <DropdownMenuSubContent className="text-xs">
      <DropdownMenuRadioGroup value={value} onValueChange={onPick}>
        {options.map(([v, l]) => <DropdownMenuRadioItem key={v} value={v} data-read-item={`${label}:${v}`}>{l}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuSubContent>
  </DropdownMenuSub>
);

/** Read Mode's keys on its screens: Esc leaves, the arrows, Page Up and Down and Space turn a screen (`step(±1)`), Home and End
 * go to the first and last (`go(i)`, 0-based), digits then Enter to that screen. `digits` ({current}) holds the digits typed. */
export function readKey(e, digits, step, go) {
  if (e.target.closest('[role="menu"]')) return;
  const k = e.key;
  let used = true;
  if (k === 'Escape') leaveView();
  else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) step(1);
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || (k === ' ' && e.shiftKey)) step(-1);
  else if (k === 'Home') go(0);
  else if (k === 'End') go(Infinity);
  else if (/^\d$/.test(k)) digits.current += k;
  else if (k === 'Enter' && digits.current) go(Number(digits.current) - 1); // ponytail: goes to screen n, Word goes to page n
  else used = false;
  if (!/^\d$/.test(k)) digits.current = ''; // a number counts only when Enter follows it directly
  if (used) e.preventDefault();
}

/** A wheel handler turning one screen per notch (`step(±1)`), with a short rest so a trackpad's stream of small deltas does not
 * race through the text. */
export function useWheelStep(step) {
  const at = useRef(0);
  return (e) => {
    if (e.ctrlKey || Date.now() - at.current < 250 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
    at.current = Date.now();
    step((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? 1 : -1);
  };
}

/** Read Mode's top bar: File, Tools and View, its View menu writing settings.word.readMode. */
export function ReadBar({ opts }) {
  const set = (patch) => saveWord({ readMode: patch });
  return (
    <div data-read-bar="" className="flex h-8 shrink-0 items-center gap-1 border-b bg-card px-2 text-xs">
      <Menu label="File"><DropdownMenuItem onSelect={() => openBackstage()}>Info</DropdownMenuItem></Menu>
      <Menu label="Tools">
        <DropdownMenuItem onSelect={() => run('home.editing.find')}>Find</DropdownMenuItem>
        <DropdownMenuItem disabled title={REASONS.cloud}>Search</DropdownMenuItem>
      </Menu>
      <Menu label="View">
        <DropdownMenuItem data-read-item="edit" onSelect={() => setView('print')}>Edit Document</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked={paneOpen('navigation')} onSelect={() => run('view.show.navigationPane')}>Navigation Pane</DropdownMenuCheckboxItem>
        <DropdownMenuItem onSelect={() => run('review.comments.showComments')}>Show Comments</DropdownMenuItem>
        <DropdownMenuSeparator />
        <Choice label="Column Width" value={opts.columnWidth} onPick={(v) => set({ columnWidth: v })}
          options={[['narrow', 'Narrow'], ['default', 'Default'], ['wide', 'Wide']]} />
        <Choice label="Page Color" value={opts.pageColor} onPick={(v) => set({ pageColor: v })}
          options={[['none', 'None'], ['sepia', 'Sepia'], ['inverse', 'Inverse']]} />
        <Choice label="Layout" value={opts.layout} onPick={(v) => set({ layout: v })}
          options={[['column', 'Column Layout'], ['paper', 'Paper Layout']]} />
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={!!opts.syllables} onSelect={() => set({ syllables: !opts.syllables })}>Syllables</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={!!opts.textSpacing} onSelect={() => set({ textSpacing: !opts.textSpacing })}>Text Spacing</DropdownMenuCheckboxItem>
        <DropdownMenuItem onSelect={() => run('review.speech.readAloud')}>Read Aloud</DropdownMenuItem>
      </Menu>
    </div>
  );
}

/** The previous and next screen buttons, faded out at the first and last screen. */
export const Turns = ({ first, last, step }) => (
  <>
    <button type="button" aria-label="Previous screen" data-read-prev="" disabled={first} onClick={() => step(-1)}
      className="pointer-events-auto absolute top-1/2 left-1 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-accent disabled:opacity-0"><ChevronLeft /></button>
    <button type="button" aria-label="Next screen" data-read-next="" disabled={last} onClick={() => step(1)}
      className="pointer-events-auto absolute top-1/2 right-1 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-accent disabled:opacity-0"><ChevronRight /></button>
  </>
);

/** Read Mode on a canvas draft (engine-gaps-views): the bar and the screen turns over the page area, which shows the engine's
 * screen pages of store word.readScreen ({n, m}, 1-based; the page area keeps `m`). It covers the pages, so they read but take
 * no edits, as Read Mode's. */
export function CanvasReader() {
  const opts = useStore((s) => wordSettings(s.settings).readMode);
  const screen = useStore((s) => s.word.readScreen) ?? { n: 1, m: 1 };
  const digits = useRef('');
  const root = useRef(null);
  useEffect(() => root.current?.focus(), []);
  const go = (i) => {
    const word = getState().word;
    const m = word.readScreen?.m ?? 1;
    setState({ word: { ...word, readScreen: { n: Math.max(1, Math.min(m, i + 1)), m } } });
  };
  const step = (d) => go((getState().word.readScreen?.n ?? 1) - 1 + d);
  const onWheel = useWheelStep(step);
  return (
    <div ref={root} data-read-mode="" data-canvas-read="" tabIndex={-1} onKeyDown={(e) => readKey(e, digits, step, go)} onWheel={onWheel}
      className="pointer-events-auto absolute inset-0 z-10 flex flex-col text-foreground outline-none">
      <ReadBar opts={opts} />
      <div className="relative min-h-0 flex-1">
        <Turns first={screen.n <= 1} last={screen.n >= screen.m} step={step} />
      </div>
    </div>
  );
}

export function Reader() {
  const opts = useStore((s) => wordSettings(s.settings).readMode);
  const ed = useStore((s) => s.editor);
  const host = useRef(null);
  const frame = useRef(null);
  const [copy, setCopy] = useState(null);
  const [screen, setScreen] = useState({ n: 0, m: 1 });
  const [zoomed, setZoomed] = useState(null);
  const digits = useRef('');

  // The copy follows the document (an agent may still change it) and the Syllables setting.
  useEffect(() => {
    if (!ed) return undefined;
    const make = () => setCopy(copyOf(ed.view, opts.syllables));
    make();
    let t = 0;
    const later = ({ transaction }) => transaction.docChanged && (clearTimeout(t), (t = setTimeout(make, 300)));
    ed.on('transaction', later);
    return () => (clearTimeout(t), ed.off('transaction', later));
  }, [ed, opts.syllables]);

  // Columns one screen high: the copy is the column box; screens follow one another GAP px apart.
  const layout = useCallback(() => {
    const box = frame.current;
    if (!copy || !box) return;
    const paper = opts.layout === 'paper' ? ed?.view.dom.offsetWidth : null;
    const W = Math.max(100, box.clientWidth - 2 * PAD - 64);
    const cols = readColumns(W, opts.columnWidth, GAP, paper);
    const width = cols.count === 1 && paper ? cols.width : W;
    Object.assign(copy.style, {
      width: `${width}px`, height: `${Math.max(100, box.clientHeight - 2 * PAD)}px`, columnCount: String(cols.count), columnGap: `${GAP}px`,
      columnFill: 'auto', overflow: 'hidden', minHeight: '0', margin: '0', position: 'relative',
    });
    copy.dataset.columns = String(cols.count);
    copy.dataset.columnWidth = String(Math.round(cols.width));
    const m = screenCount(copy.scrollWidth, width, GAP);
    setScreen((s) => ({ n: Math.min(s.n, m - 1), m }));
  }, [copy, opts.columnWidth, opts.layout, ed]);

  useLayoutEffect(() => {
    if (!copy || !host.current) return undefined;
    host.current.replaceChildren(copy);
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(frame.current);
    return () => ro.disconnect();
  }, [copy, layout]);

  useEffect(() => {
    if (copy) copy.scrollLeft = screen.n * (copy.clientWidth + GAP);
    const word = getState().word;
    if (word.view === 'read' && (word.readScreen?.n !== screen.n + 1 || word.readScreen?.m !== screen.m)) {
      setState({ word: { ...word, readScreen: { n: screen.n + 1, m: screen.m } } });
    }
  }, [copy, screen]);
  useEffect(() => () => setState({ word: { ...getState().word, readScreen: null } }), []);
  useEffect(() => host.current?.closest('[data-read-mode]')?.focus(), []);

  const go = (n) => setScreen((s) => ({ ...s, n: Math.max(0, Math.min(s.m - 1, n)) }));
  const step = (d) => setScreen((s) => ({ ...s, n: Math.max(0, Math.min(s.m - 1, s.n + d)) }));

  const onKey = (e) => {
    if (zoomed && e.key === 'Escape') {
      setZoomed(null);
      e.preventDefault();
    } else readKey(e, digits, step, go);
  };
  const onWheel = useWheelStep(step);
  const onDouble = (e) => {
    const el = e.target.closest('img, table, .sc, .pc');
    if (el && copy?.contains(el)) setZoomed(el.cloneNode(true));
  };
  const big = useRef(null);
  useLayoutEffect(() => {
    if (!zoomed || !big.current) return;
    big.current.replaceChildren(zoomed);
    const box = big.current.parentElement.getBoundingClientRect();
    const r = zoomed.getBoundingClientRect();
    const k = Math.min((box.width - 64) / (r.width || 1), (box.height - 64) / (r.height || 1), 4);
    zoomed.style.cssText += `;zoom:${Math.max(1, k)};max-width:none;max-height:none`;
  }, [zoomed]);

  return (
    <div data-read-mode="" tabIndex={-1} onKeyDown={onKey} onWheel={onWheel}
      className="pointer-events-auto absolute inset-0 z-10 flex flex-col bg-background text-foreground outline-none">
      <ReadBar opts={opts} />
      <div ref={frame} className="relative min-h-0 flex-1" onDoubleClick={onDouble}>
        {/* the copy keeps the Document's scoped rules and sheet variables through .page[data-format] */}
        <div ref={host} data-read-page="" data-page-color={opts.pageColor} data-spacing={opts.textSpacing ? 'wide' : undefined}
          className="page absolute inset-0 flex justify-center" data-format="document"
          style={{ padding: PAD, width: 'auto', minHeight: 0, boxSizing: 'border-box', boxShadow: 'none' }} />
        <Turns first={screen.n === 0} last={screen.n >= screen.m - 1} step={step} />
        {zoomed && (
          <div data-read-zoom="" className="absolute inset-0 z-10 flex items-center justify-center bg-black/40" onClick={() => setZoomed(null)}>
            <div ref={big} className="page bg-white p-4" data-format="document" />
          </div>
        )}
      </div>
    </div>
  );
}
