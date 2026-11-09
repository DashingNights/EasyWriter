// The pane menu (Ctrl+Space in a task pane; docs/plans/word briefs/ribbon-chrome.md): Size lets the arrow keys change the
// pane's width (settings.word.paneWidths) until Enter keeps it or Esc puts it back; Close closes the pane. Word's Move is left
// out because panes dock (plan.md §1.7). The menu draws at the pane's top left and takes the keys while it is open.
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { cn } from 'cn';
import { refocusEditor } from '../../../app/actions.js';
import { setState } from '../../../app/store.js';
import { closePane } from '../../../tooling/panes.jsx';
import { saveWord } from '../../word/settings.mjs';

const ITEMS = [['size', 'Size'], ['close', 'Close']];

let st = null; // {id, mode: 'menu' | 'size', index, start (rem), width (rem)}
let version = 0;
const subs = new Set();
const emit = () => {
  version++;
  for (const f of subs) f();
};
const subscribe = (f) => {
  subs.add(f);
  return () => subs.delete(f);
};

const paneEl = (id) => document.querySelector(`[data-pane="${CSS.escape(id)}"]`);
const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

/** Whether the pane menu is open. */
export const paneMenuOpen = () => !!st;

/** Opens the menu of pane `id`. */
export function openPaneMenu(id) {
  if (!paneEl(id)) return false;
  st = { id, mode: 'menu', index: 0 };
  emit();
  return true;
}

// The width shown while sizing: written into the settings in the store at once (PaneHost reads it), saved on Enter.
function showWidth(id, width) {
  setState((s) => ({ settings: { ...s.settings, word: { ...s.settings?.word, paneWidths: { ...s.settings?.word?.paneWidths, [id]: width } } } }));
}

function shut(focusPane) {
  const id = st?.id;
  st = null;
  emit();
  const el = id && focusPane ? paneEl(id) : null;
  if (el) {
    if (el.tabIndex < 0) el.tabIndex = -1;
    el.focus({ preventScroll: true });
  }
}

function choose(what) {
  const { id } = st;
  if (what === 'close') {
    shut(false);
    closePane(id);
    refocusEditor();
    return;
  }
  const el = paneEl(id);
  const side = el?.dataset.paneSide;
  const px = side === 'bottom' ? el.getBoundingClientRect().height : el.getBoundingClientRect().width;
  const width = Math.round((px / rem()) * 4) / 4;
  st = { ...st, mode: 'size', start: width, width, side };
  emit();
}

/** Key `e` while the menu is open: Up and Down pick, Enter runs, S and C are the items' keys, Esc closes; while sizing the
 * arrows grow or shrink the pane by half a rem (the inner edge's direction), Enter keeps it and Esc puts it back. */
export function paneMenuKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (st.mode === 'menu') {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      st = { ...st, index: (st.index + 1) % ITEMS.length };
      emit();
    } else if (e.key === 'Enter' || e.key === ' ') choose(ITEMS[st.index][0]);
    else if (/^[sc]$/i.test(e.key)) choose(e.key.toLowerCase() === 's' ? 'size' : 'close');
    else if (e.key === 'Escape') shut(true);
    return;
  }
  const grow = { left: 'ArrowRight', right: 'ArrowLeft', bottom: 'ArrowUp' }[st.side];
  const shrink = { left: 'ArrowLeft', right: 'ArrowRight', bottom: 'ArrowDown' }[st.side];
  if (e.key === grow || e.key === shrink) {
    const width = Math.min(60, Math.max(10, st.width + (e.key === grow ? 0.5 : -0.5)));
    st = { ...st, width };
    showWidth(st.id, width);
    emit();
  } else if (e.key === 'Enter') {
    saveWord({ paneWidths: { [st.id]: st.width } });
    shut(true);
  } else if (e.key === 'Escape') {
    showWidth(st.id, st.start);
    shut(true);
  }
}

/** The menu, drawn at its pane's top left. */
export function PaneMenuLayer() {
  useSyncExternalStore(subscribe, () => version);
  const el = st && paneEl(st.id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return createPortal(
    <div role="menu" data-pane-menu={st.id} aria-label="Pane" style={{ left: r.left + 8, top: r.top + 28 }}
      className="fixed z-[100] min-w-36 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md">
      {st.mode === 'menu' ? ITEMS.map(([id, label], i) => (
        <div key={id} role="menuitem" data-pane-item={id} aria-selected={i === st.index}
          className={cn('rounded-sm px-2 py-1', i === st.index && 'bg-accent text-accent-foreground')}><u>{label[0]}</u>{label.slice(1)}</div>
      )) : <div className="max-w-56 px-2 py-1 text-xs text-muted-foreground">The arrow keys resize the pane. Enter keeps the size and Esc puts it back.</div>}
    </div>,
    document.body,
  );
}
