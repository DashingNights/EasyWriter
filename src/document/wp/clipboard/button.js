// The Paste Options button (docs/plans/word plan.md §3 clipboard, index-editing.md "Paste and Paste Options"): a small clipboard
// button in the page overlay (geometry.js overlayOf, layout px) at the end of the last paste. A click or a Ctrl tap opens its menu;
// a letter picks (K, M, S, H, U, T, the list and table choices, A for Set Default Paste); Esc closes the menu; typing or any other
// edit removes the button (the plugin's state ends). A pick selects the pasted range and pastes the kept clipboard data again with
// that option, one undo step; a table choice undoes the paste and pastes again with the choice.
import { undo } from '@tiptap/pm/history';
import { commandOf, ctxOf, galleryOf, run } from '../../../tooling/registry.js';
import { overlayOf } from '../../geometry.js';
import { pasteData, selectRange } from './core.js';
import { availableModes, LABELS, LETTERS } from './modes.mjs';

// Left out for now: Merge Table (M) and Insert as New Columns (C) from the brief.
const TABLE = [['nestTable', 'Nest Table', 'N'], ['insertAsNewRows', 'Insert as New Rows', 'R'], ['overwriteCells', 'Overwrite Cells', 'O'],
  ['keepTextOnly', 'Keep Text Only', 'T']];
const ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

const shown = new Map(); // view → {root, button, menu, keys}

let clipKeyRef = null;
/** The plugin's key, set by plugin.js (button.js and plugin.js import each other's parts). */
export const setClipKey = (key) => { clipKeyRef = key; };
const stateOf = (view) => clipKeyRef?.getState(view.state) ?? null;

/** Re-pastes the last paste of `view` with paste option `mode`. */
export function repick(view, mode) {
  const st = stateOf(view);
  if (!st) return false;
  closeMenu(view);
  if (mode === 'picture' && st.kind !== 'picture') {
    selectRange(view, st.from, st.to);
    return run('paste.pastePicture');
  }
  selectRange(view, st.from, st.to, { key: clipKeyRef, value: { keep: true } });
  return pasteData(view, st.data, mode, { src: st.src });
}

/** Undoes the last table paste of `view` and pastes it again as table choice `choice`. */
export function repickTable(view, choice) {
  const st = stateOf(view);
  if (!st) return false;
  closeMenu(view);
  if (!undo(view.state, view.dispatch)) return false;
  return pasteData(view, st.data, choice === 'keepTextOnly' ? 'keepTextOnly' : null, { src: st.src, tableChoice: choice });
}

/** The menu rows for `view`'s last paste → [{id, label, letter, pick}]. Picture shows only while paste.pastePicture is registered,
 * the list choices only while lists registers paste.listChoices. */
export function menuRows(view) {
  const st = stateOf(view);
  if (!st) return [];
  if (st.table) return TABLE.map(([id, label, letter]) => ({ id, label, letter, pick: () => repickTable(view, id) }));
  const modes = availableModes(st.kind, { stylesDiffer: st.stylesDiffer, themeDiffer: st.themeDiffer, picture: !!commandOf('paste.pastePicture') });
  const rows = modes.map((id) => ({ id, label: LABELS[id], letter: LETTERS[id], pick: () => repick(view, id) }));
  if (st.lists) {
    for (const it of galleryOf('paste.listChoices', ctxOf())) {
      rows.push({ id: it.id, label: it.label, letter: (it.letter ?? it.label[0]).toUpperCase(), pick: () => { closeMenu(view); run('paste.listChoices', it.id); } });
    }
  }
  rows.push({ id: 'setDefaultPaste', label: 'Set Default Paste...', letter: 'A', pick: () => { closeMenu(view); run('home.clipboard.paste.setDefaultPaste'); } });
  return rows;
}

/** Where the button goes: just after the end of the pasted range, in layout px from .ProseMirror's origin. */
function placeOf(view, pos) {
  const max = view.state.doc.content.size;
  let c;
  try {
    c = view.coordsAtPos(Math.min(pos, max), -1);
  } catch {
    return null;
  }
  const r = view.dom.getBoundingClientRect();
  const scale = view.dom.offsetWidth ? r.width / view.dom.offsetWidth : 1; // zoom scales the sheet; layout px stay unscaled
  return { x: (c.right - r.left) / scale + 2, y: (c.bottom - r.top) / scale + 2 };
}

/** Shows (or moves) `view`'s button; `toggle` also opens or closes its menu (a click, a Ctrl tap). */
export function showButton(view, { toggle = false } = {}) {
  const st = stateOf(view);
  const host = st && overlayOf(view);
  if (!host) return closeButton(view);
  let s = shown.get(view);
  if (!s || !s.root.isConnected) {
    const root = document.createElement('div');
    root.setAttribute('data-paste-options', '');
    root.className = 'absolute flex flex-col items-start';
    root.style.pointerEvents = 'auto';
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', 'Paste Options');
    button.setAttribute('aria-haspopup', 'menu');
    button.title = 'Paste Options (Ctrl)';
    button.className = 'flex h-5 items-center gap-0.5 rounded-sm border bg-card px-1 text-card-foreground shadow-sm hover:bg-accent';
    button.innerHTML = ICON + CHEVRON;
    button.addEventListener('mousedown', (e) => e.preventDefault()); // the editor keeps the focus
    button.addEventListener('click', () => toggleMenu(view));
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Paste Options');
    menu.hidden = true;
    menu.className = 'mt-0.5 flex min-w-52 flex-col rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-lg';
    root.append(button, menu);
    host.append(root);
    s = { root, button, menu, keys: null };
    shown.set(view, s);
  }
  const at = placeOf(view, st.to);
  if (at) {
    s.root.style.left = `${at.x}px`;
    s.root.style.top = `${at.y}px`;
  }
  if (toggle) toggleMenu(view);
  return s;
}

/** Removes `view`'s button and its menu. */
export function closeButton(view) {
  const s = shown.get(view);
  if (!s) return;
  closeMenu(view);
  s.root.remove();
  shown.delete(view);
}

/** Whether `view`'s Paste Options menu is open. */
export const menuOpen = (view) => !!shown.get(view) && !shown.get(view).menu.hidden;

/** Opens or closes `view`'s menu. */
export function toggleMenu(view) {
  if (menuOpen(view)) return closeMenu(view);
  const s = shown.get(view) ?? showButton(view);
  if (!s) return;
  const rows = menuRows(view);
  s.menu.replaceChildren(...rows.map((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.setAttribute('data-item', r.id);
    b.setAttribute('data-letter', r.letter);
    b.className = 'flex items-center justify-between gap-4 rounded-sm px-2 py-1 text-left hover:bg-accent';
    const label = document.createElement('span');
    label.textContent = r.label;
    const key = document.createElement('kbd');
    key.className = 'text-xs text-muted-foreground';
    key.textContent = r.letter;
    b.append(label, key);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => r.pick());
    return b;
  }));
  s.menu.hidden = false;
  s.button.setAttribute('aria-expanded', 'true');
  // Letters and Esc reach the menu before the editor and the app's keys (a capture listener on the document).
  s.keys = (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.key === 'Control' || e.key === 'Shift') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(view);
      return;
    }
    const row = e.key.length === 1 && rows.find((r) => r.letter === e.key.toUpperCase());
    if (row) {
      e.preventDefault();
      e.stopPropagation();
      row.pick();
      return;
    }
    closeMenu(view); // any other key goes on to the text (and its edit ends the button)
  };
  document.addEventListener('keydown', s.keys, true);
}

/** Closes `view`'s menu, leaving the button. */
export function closeMenu(view) {
  const s = shown.get(view);
  if (!s) return;
  if (s.keys) document.removeEventListener('keydown', s.keys, true);
  s.keys = null;
  s.menu.hidden = true;
  s.button.setAttribute('aria-expanded', 'false');
}
