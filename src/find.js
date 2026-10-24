import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// Find and replace in the draft (Ctrl+F / Ctrl+H, the find bar FindBar.jsx): every match of the query highlighted
// (.find-match), the current one marked (.find-current). Plain text, case-insensitive, within one paragraph or heading at a
// time. The matches follow edits.

const key = new PluginKey('find');

/** The ranges of `query` in `doc` ([{from, to}], document order). */
export function findMatches(doc, query) {
  const out = [];
  const q = query.toLowerCase();
  if (!q) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // An inline leaf (a line break) counts as one character, its size in the document, so offsets stay positions.
    const text = node.textBetween(0, node.content.size, undefined, '￼').toLowerCase();
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) out.push({ from: pos + 1 + i, to: pos + 1 + i + q.length });
    return false;
  });
  return out;
}

export const Find = Extension.create({
  name: 'find',
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: {
        init: () => ({ query: '', matches: [], index: 0 }),
        apply(tr, prev) {
          const meta = tr.getMeta(key);
          if (!meta && !tr.docChanged) return prev;
          const query = meta?.query ?? prev.query;
          const matches = meta?.query !== undefined || tr.docChanged ? findMatches(tr.doc, query) : prev.matches;
          return { query, matches, index: Math.min(meta?.index ?? prev.index, Math.max(0, matches.length - 1)) };
        },
      },
      props: {
        decorations(state) {
          const { matches, index } = key.getState(state);
          if (!matches.length) return null;
          return DecorationSet.create(state.doc, matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === index ? 'find-match find-current' : 'find-match' })));
        },
      },
    })];
  },
});

/** The editor's find state: {query, matches, index}. */
export const findState = (editor) => key.getState(editor.state);

const CLEAR = 100; // px kept clear at the viewport's top (the find bar) and bottom (the toolbar island)

// The current match centred in the page's viewport when it is not in view, by hand (the page's CSS zoom misleads scrollIntoView).
function reveal(editor) {
  const { matches, index } = findState(editor);
  const m = matches[index];
  const area = editor.view.dom.closest('[data-viewport]');
  if (!m || !area) return;
  const a = editor.view.coordsAtPos(m.from);
  const b = editor.view.coordsAtPos(m.to);
  const v = area.getBoundingClientRect();
  if (a.top < v.top + CLEAR || b.bottom > v.bottom - CLEAR) area.scrollTop += a.top - v.top - v.height / 2;
  if (a.left < v.left || b.right > v.right) area.scrollLeft += a.left - v.left - v.width / 2;
}

/** Finds `query`: the current match is the first one from the caret on. */
export function findText(editor, query) {
  const { state } = editor;
  const at = findMatches(state.doc, query).findIndex((m) => m.from >= state.selection.from);
  editor.view.dispatch(state.tr.setMeta(key, { query, index: Math.max(0, at) }));
  reveal(editor);
}

/** The next match (`dir` 1) or the previous one (-1), wrapping around. */
export function findStep(editor, dir) {
  const { matches, index } = findState(editor);
  if (!matches.length) return;
  editor.view.dispatch(editor.state.tr.setMeta(key, { index: (index + dir + matches.length) % matches.length }));
  reveal(editor);
}

/** Replaces the current match with `text` (keeping the marks across it), one undo step; the next match after it becomes the
 * current one, so a replacement that contains the query is not found again first. */
export function findReplace(editor, text) {
  const { query, matches, index } = findState(editor);
  const m = matches[index];
  if (!m) return;
  const tr = closeHistory(editor.state.tr.insertText(text, m.from, m.to));
  const next = findMatches(tr.doc, query).findIndex((n) => n.from >= m.from + text.length);
  editor.view.dispatch(tr.setMeta(key, { index: Math.max(0, next) }));
  reveal(editor);
}

/** Replaces every match with `text`, one undo step. → the number replaced. */
export function findReplaceAll(editor, text) {
  const { matches } = findState(editor);
  if (!matches.length) return 0;
  const tr = editor.state.tr;
  for (const m of [...matches].reverse()) tr.insertText(text, m.from, m.to); // last first: the earlier positions stay valid
  editor.view.dispatch(closeHistory(tr).setMeta(key, { index: 0 }));
  return matches.length;
}

/** Ends the find: no highlights; the current match, if any, becomes the selection. */
export function findEnd(editor) {
  const { matches, index } = findState(editor);
  const m = matches[index];
  const tr = editor.state.tr.setMeta(key, { query: '' });
  if (m) tr.setSelection(TextSelection.create(tr.doc, m.from, m.to));
  editor.view.dispatch(tr);
}
