// The mini toolbar (docs/plans/word/briefs/context-menu.md, index-editing.md "Mini toolbar"): Word's two rows of formatting
// controls, drawn with the ribbon's own parts so placeholders, menus and states match the ribbon. It shows faded above a selection
// made with the mouse when Options turns it on (settings.word.general.miniToolbar, off by default), turns solid as the pointer comes within 30 px and hides once it is 100 px
// away, on typing, Esc or scroll; it shows solid above every Document menu; and Ctrl+Tab draws its rows in the quick tools island.
// It never takes the focus and never covers the selection.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { CHROME, keepFocus } from '../../../app/components/board/controls.jsx'; // keeps the focus off buttons, not off the font boxes
import { getState } from '../../../app/store.js';
import { ctxOf, useWordCtx } from '../../../tooling/registry.js';
import { itemOf } from '../../../tooling/ribbon/layout.mjs';
import { Control, RibbonContext } from '../../../tooling/ribbon/parts.jsx';
import { iconOf } from '../../ribbon/icons.jsx';
import * as WORD_SPEC from '../../ribbon/spec.mjs';
import { FontBox, SizeBox } from '../../Ribbon.jsx';
import { wordSettings } from '../../word/settings.mjs';
import { distance, fadeAt, placeBar } from './place.mjs';

// Word's rows (index-editing.md, order unverified); a table adds Insert, Delete and Borders, a picture shows Style, Crop and New
// Comment instead (both unverified).
const ROW1 = ['home.font.font', 'home.font.fontSize', 'home.font.growFont', 'home.font.shrinkFont', 'home.clipboard.formatPainter', 'home.styles.styles'];
const ROW2 = ['home.font.bold', 'home.font.italic', 'home.font.underline', 'home.font.textHighlightColor', 'home.font.fontColor', 'home.paragraph.bullets',
  'home.paragraph.numbering', 'home.paragraph.lineAndParagraphSpacing', 'insert.comments.comment'];
const TABLE = ['x.mini.insert', 'tableLayout.rowsColumns.delete', 'home.paragraph.borders'];
const PICTURE = ['pictureFormat.pictureStyles.pictureStyles', 'pictureFormat.size.crop', 'insert.comments.comment'];

// The table's Insert menu has no ribbon control of its own (Word's mini toolbar draws one), so the bar adds it to the spec it draws.
const INSERTS = ['tableLayout.rowsColumns.insertColumnLeft', 'tableLayout.rowsColumns.insertColumnRight', 'tableLayout.rowsColumns.insertRowAbove',
  'tableLayout.rowsColumns.insertRowBelow'];
const SPEC = {
  ...WORD_SPEC,
  CONTROLS: { ...WORD_SPEC.CONTROLS, 'x.mini.insert': { id: 'x.mini.insert', type: 'dropdown', size: 'small', label: 'Insert', icon: 'BetweenHorizontalStart', menu: 'x.mini.insert', extra: true } },
  MENUS: { ...WORD_SPEC.MENUS, 'x.mini.insert': INSERTS.map((item) => ({ item })) },
  ITEMS: { ...WORD_SPEC.ITEMS, ...Object.fromEntries(INSERTS.map((id) => [id, { id, label: WORD_SPEC.CONTROLS[id].label, icon: WORD_SPEC.CONTROLS[id].icon }])) },
};
const BOXES = {
  'home.font.font': ({ ctx }) => <FontBox T={ctx.T} />,
  'home.font.fontSize': ({ ctx }) => <SizeBox T={ctx.T} />,
};

/** Control `id` as the bar draws it: small, a gallery as a dropdown of its menu (the bar has no room for an in-ribbon gallery). */
function barItem(id) {
  const item = itemOf(SPEC, id);
  if (!item) return null;
  const c = item.control;
  const control = c.type === 'gallery' ? { ...c, type: 'dropdown', size: 'small', menu: c.menu ?? id } : c.type === 'combo' ? c : { ...c, size: 'small' };
  return { ...item, control };
}
const ITEMS = Object.fromEntries([...ROW1, ...ROW2, ...TABLE, ...PICTURE].map((id) => [id, barItem(id)]));

const Row = ({ ids }) => (
  <div className="flex h-[26px] items-center gap-0.5">{ids.map((id) => ITEMS[id] && <Control key={id} item={ITEMS[id]} size={ITEMS[id].control.size} />)}</div>
);

/** The bar's rows for what is selected: a picture's, else the text rows with the table row in a table. */
export function MiniBar() {
  const ctx = useWordCtx();
  const picture = ctx.obj?.kind === 'picture' || ctx.obj?.kind === 'graphic';
  return (
    <RibbonContext.Provider value={{ spec: SPEC, icons: iconOf, boxes: BOXES, ctx }}>
      <div data-mini-rows="" className="flex flex-col gap-0.5">
        {picture ? <Row ids={PICTURE} /> : (
          <>
            <Row ids={ROW1} />
            <Row ids={ROW2} />
            {ctx.in.table && <Row ids={TABLE} />}
          </>
        )}
      </div>
    </RibbonContext.Provider>
  );
}

// The bar's state: null, or {at: {x, y} the pointer, look: 'faded' | 'solid', menu: true while a right-click menu is open, rect: the
// open menu's box once laid out, n}.
let bar = null;
const listeners = new Set();
let n = 0;
export const mini = {
  get: () => bar,
  set(next) {
    bar = next && { ...next, n: next.n ?? ++n };
    for (const fn of listeners) fn();
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Shows the bar above the selection near `at`: faded after a mouse selection, solid with a menu. Off in Options, it stays hidden
   * after a selection; Word still draws it with a menu (ShowMenuFloaties is its own option, not in our settings). */
  show(at, { menu = false } = {}) {
    if (!menu && !wordSettings(getState().settings).general?.miniToolbar) return;
    mini.set({ at, look: menu ? 'solid' : 'faded', menu });
  },
  hide: () => bar && mini.set(null),
};

/** The client rects of the target editor's selection: the selected node's box, else the caret or the ends of the range. */
function selectionRects() {
  const ed = ctxOf().target;
  const view = ed?.view;
  if (!view?.dom?.isConnected) return [];
  const sel = ed.state.selection;
  if (sel.node) {
    const dom = view.nodeDOM(sel.from);
    return dom?.getBoundingClientRect ? [dom.getBoundingClientRect()] : [];
  }
  try {
    return sel.empty ? [view.coordsAtPos(sel.head)] : [view.coordsAtPos(sel.from), view.coordsAtPos(sel.to)];
  } catch {
    return [];
  }
}

/** The page area the bar stays in ([data-viewport]), else the window below the title bar. */
function viewBox() {
  const r = document.querySelector('[data-viewport]')?.getBoundingClientRect();
  return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : { left: 0, top: 34, right: innerWidth, bottom: innerHeight };
}

/** The floating mini toolbar; mounted once by DraftMenu.jsx. */
export function MiniToolbar() {
  const state = useSyncExternalStore(mini.subscribe, mini.get);
  const ref = useRef(null);
  const [look, setLook] = useState('faded');
  useEffect(() => setLook(state?.look ?? 'faded'), [state]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !state) return;
    const { left, top } = placeBar({ rects: state.rect ? [...selectionRects(), state.rect] : selectionRects(), at: state.at, w: el.offsetWidth, h: el.offsetHeight, view: viewBox() });
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [state]);

  useEffect(() => {
    if (!state) return undefined;
    const inside = (e) => ref.current?.contains(e.target) || !!e.target?.closest?.('[data-radix-popper-content-wrapper]');
    const onMove = (e) => {
      if (mini.get()?.menu || !ref.current) return;
      const next = fadeAt(distance({ x: e.clientX, y: e.clientY }, ref.current.getBoundingClientRect()));
      if (next === 'hidden') mini.hide();
      else setLook(next);
    };
    const onKey = (e) => {
      if (mini.get()?.menu || inside(e) || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      mini.hide();
    };
    const onDown = (e) => !mini.get()?.menu && !inside(e) && mini.hide();
    const onScroll = (e) => !inside(e) && !mini.get()?.menu && mini.hide();
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('wheel', onScroll, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('wheel', onScroll, true);
    };
  }, [state]);

  if (!state) return null;
  // pointer-events auto: an open right-click menu sets none on the body, and the bar above it must still take clicks.
  return (
    <div ref={ref} {...CHROME} data-mini-toolbar="" data-look={look} role="toolbar" aria-label="Mini toolbar" onMouseDown={keepFocus}
      style={{ left: state.at.x, top: state.at.y, pointerEvents: 'auto' }}
      className={cn('fixed z-[60] rounded-md border bg-card p-1 text-foreground shadow-lg transition-opacity duration-150', look === 'faded' ? 'opacity-40' : 'opacity-100')}>
      <MiniBar />
    </div>
  );
}
