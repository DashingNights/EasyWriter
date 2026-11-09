// Word's keys in Document text (docs/plans/word/plan.md §1.13). WordKeys runs keymap.mjs's bind rows in every editor of the Document
// kit (the main editor and each story sub-editor, all marked data-doc-text), ahead of the app's text keys; wordKeyWins tells the app's
// window-wide key handlers (actions.js, the assistant, dictation) to leave such a key alone; runWordKey runs Word's window-wide rows
// while the focus is in the Document's chrome. Forum posts never see any of it: their kit has no WordKeys.
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { chordOf, WORD_DEFS } from '../../app/keys.mjs';
import { keyAmong, keyIs, keysOf } from '../../app/keybinds.js';
import { getState } from '../../app/store.js';
import { commandOf, keyHolds, run } from '../../tooling/registry.js';
import { activeSurface } from '../../tooling/surface.js';
import { WORD_KEYS } from './keymap.mjs';

// The Document's chrome, where Word's window-wide rows (when: 'window') also work.
const CHROME = '[data-ribbon], [data-pane], [data-backstage], [data-statusbar], .titlebar';
const CONTEXTS = new Set(['table', 'outline', 'header', 'tabContext']);

// A row with a context is tried before the same chord without one; window-wide rows need none.
const ORDER = [...WORD_DEFS].sort((a, b) => CONTEXTS.has(b.rows[0].when) - CONTEXTS.has(a.rows[0].when));
// Rows that keep an app binding's chords (Ctrl+Y as edit.redo, Ctrl+Shift+N as document.normalStyle), by that binding's id.
const REUSE = new Map(WORD_KEYS.filter((r) => r.kind === 'bind' && r.reuse).map((r) => [r.reuse, r]));

const inTable = ($pos) => {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === 'table') return true;
  return false;
};

/** Whether context `when` holds in editor `view` (a missing `when` and 'window' always hold). */
function holds(when, view) {
  if (!CONTEXTS.has(when)) return true;
  const outline = getState().word?.view === 'outline';
  if (when === 'outline') return outline;
  if (when === 'header') return /^(header|footer)$/.test(view.dom.closest('[data-story]')?.dataset.story ?? '');
  const { $from, empty } = view.state.selection;
  if (when === 'table') return inTable($from);
  // tabContext: a table cell, the start of a list item, or Outline view (Word's Ctrl+Tab types a tab there).
  return inTable($from) || outline || (empty && $from.parentOffset === 0 && !!$from.parent.attrs.numbering);
}

// Rule: while the Word command a chord maps to is unregistered (a placeholder), a chord it shadows falls through to the app's own
// binding of it, so Ctrl+Alt+PageDown, PageUp and Enter keep walking and accepting the agent's suggestions until Word's commands land.
const placeholder = (d, e) => !commandOf(d.cmd) && !!d.shadows?.some((id) => keyIs(id, e));

/** The row key event `e` runs: in editor `view`, any bind row whose context holds; with `chrome`, only window-wide rows.
 * → {cmd, arg, row, reuse} or null. */
function wordKeyOf(e, view, chrome = false) {
  const live = ORDER.filter((d) => (chrome ? d.rows[0].when === 'window' : holds(d.rows[0].when, view)) && !placeholder(d, e));
  const id = keyAmong(live.map((d) => d.id), e);
  if (id) {
    const d = ORDER.find((x) => x.id === id);
    // An accent prefix passes the chord pressed, so editing-keys knows which accent the next letter takes.
    return { cmd: d.cmd, arg: d.rows[0].prefix ? chordOf(e) : d.arg, row: d.rows[0], reuse: false };
  }
  const reuse = !chrome && keyAmong([...REUSE.keys()], e);
  return reuse ? { cmd: REUSE.get(reuse).cmd, arg: REUSE.get(reuse).arg, row: REUSE.get(reuse), reuse: true } : null;
}

/** Runs the Word command of key event `e` in editor `view`. → true when the key is used up. */
function handleWordKey(view, e) {
  const hit = wordKeyOf(e, view);
  if (!hit) return false;
  if (!commandOf(hit.cmd)) {
    // Until its package registers it: a key that keeps an app binding (Ctrl+Y, Ctrl+Shift+N) or moves the caret goes on as before;
    // any other shows why it does nothing yet (run toasts the reason) and goes no further, so no older binding of its chord runs.
    if (hit.reuse || hit.row.fallthrough) return false;
    run(hit.cmd, hit.arg);
    return true;
  }
  const done = run(hit.cmd, hit.arg);
  return hit.row.fallthrough ? done !== false : true;
}

/** Whether Word owns key event `e` (plan.md §1.13): the surface now is a Document and `e` is a bind row's chord whose context
 * holds, with the focus in Document text, on a canvas draft's pages, or on a document focused on a board (bd-hud), whose page
 * area runs the engine's keymap as a canvas draft's does; or a window-wide row's with the focus in the Document's chrome. */
export function wordKeyWins(e) {
  if (activeSurface()?.format !== 'document' || !(e.target instanceof Element)) return false;
  const text = e.target.closest('[data-doc-text]');
  if (text) return !!text.editor && !!wordKeyOf(e, text.editor.view);
  if (e.target.closest(PAGES)) return !!canvasWordKey(e);
  if (e.target.closest(BOARD) && getState().boardFocus?.kind === 'document') return !!canvasWordKey(e);
  return !!e.target.closest(CHROME) && !!wordKeyOf(e, null, true);
}

// A canvas draft's page area (src/document/canvas/PageArea.jsx): its own keymap (src/engine/input/keys.mjs) runs Word's rows
// through the registry, so the window's handlers leave Word's chords there alone, as in the DOM editor's text (Ctrl+Shift+D is
// Double Underline there, not Dictate).
const PAGES = '[data-canvas-pages]';
/** A whiteboard's viewport (src/board/BoardArea.jsx), where a focused document's pages are. */
const BOARD = '[data-board]';
/** The Word binding key event `e` takes in the page area, its context (a cell, a header) read from the engine (registry keyHolds). */
function canvasWordKey(e) {
  return keyAmong(ORDER.filter((d) => keyHolds(d.rows[0].when) && !placeholder(d, e)).map((d) => d.id), e);
}

/** Runs Word's window-wide row of key event `e` (the focus in the Document's chrome; the page area's keymap runs its own). → whether
 * one ran. */
export function runWordKey(e) {
  if (e.target instanceof Element && e.target.closest(PAGES)) return false;
  const hit = wordKeyOf(e, null, true);
  if (!hit) return false;
  e.preventDefault();
  run(hit.cmd, hit.arg);
  return true;
}

/** The Word chords in force (every WORD_DEFS binding's effective chords), which main.js leaves to the text while it has the focus
 * (its developer tools chord is Word's italic there). */
export const wordChords = () => [...new Set(WORD_DEFS.flatMap((d) => keysOf(d.id)))];

/** Word's keys in an editor of the Document kit: priority 1200, ahead of the app's text keys (textKeys, 1100). Its root carries
 * data-doc-text, which wordKeyWins and the app's styles read. */
export const WordKeys = Extension.create({
  name: 'wordKeys',
  priority: 1200,
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        attributes: { 'data-doc-text': '' },
        handleKeyDown: handleWordKey,
      },
      view(view) {
        // preload.js's window.docText (plan.md §1.17); missing in Node tests and other hosts.
        const on = () => window.docText?.(true, wordChords());
        const off = () => window.docText?.(false);
        view.dom.addEventListener('focusin', on);
        view.dom.addEventListener('focusout', off);
        return {
          destroy() {
            if (view.dom.contains(document.activeElement)) off(); // no focusout comes from a removed editor
            view.dom.removeEventListener('focusin', on);
            view.dom.removeEventListener('focusout', off);
          },
        };
      },
    })];
  },
});
