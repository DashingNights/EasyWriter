import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { applyParts, replaceAll, replaceParts, searchDoc } from './document/wp/find/replace.mjs';

// Find and replace in the draft (Ctrl+F / Ctrl+H, the find bar FindBar.jsx): every match of the query highlighted
// (.find-match), the current one marked (.find-current). Plain text, case-insensitive, within one paragraph or heading at a
// time. The matches follow edits. findMatches is the shared search API (docs/plans/word/plan.md §1.18): with opts it runs Word's
// search language (src/document/wp/find/query.mjs), which the Document's Find and Replace dialog and the Navigation pane use;
// without opts it behaves as it always has, for the forum find bar and the agents.

const key = new PluginKey('find');

/** The ranges of `query` in `doc` ([{from, to, groups?}], document order). opts (§1.18): matchCase, wholeWord, wildcards,
 * soundsLike, allForms, prefix, suffix, widthForms, ignorePunct, ignoreSpace, codes, format, within, display, fieldCodes. No opts:
 * plain, case-insensitive, within one textblock. A query Word refuses finds nothing (query.mjs queryError gives the message). */
export function findMatches(doc, query, opts) {
  if (opts && Object.keys(opts).length) return searchDoc(doc, query, opts).matches.map(({ from, to, groups }) => (groups ? { from, to, groups } : { from, to }));
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

const matchesOf = (doc, query, opts) => (query || opts?.format ? findMatches(doc, query, opts) : []);

export const Find = Extension.create({
  name: 'find',
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: {
        // all: every match highlighted; else only the current one (the Document's Find Next).
        init: () => ({ query: '', opts: undefined, all: true, matches: [], index: 0 }),
        apply(tr, prev) {
          const meta = tr.getMeta(key);
          if (!meta && !tr.docChanged) return prev;
          const query = meta?.query ?? prev.query;
          const opts = meta && 'opts' in meta ? meta.opts : prev.opts;
          const all = meta?.all ?? (meta?.query !== undefined ? true : prev.all);
          // meta.matches: the caller already searched tr.doc (findReplace), so the search does not run twice
          const matches = meta?.matches ?? (meta?.query !== undefined || tr.docChanged ? matchesOf(tr.doc, query, opts) : prev.matches);
          return { query, opts, all, matches, index: Math.min(meta?.index ?? prev.index, Math.max(0, matches.length - 1)) };
        },
      },
      props: {
        decorations(state) {
          const { matches, index, all } = key.getState(state);
          if (!matches.length) return null;
          const shown = all ? matches.map((m, i) => [m, i]) : [[matches[index], index]];
          return DecorationSet.create(state.doc, shown.filter(([m]) => m && m.to > m.from)
            .map(([m, i]) => Decoration.inline(m.from, m.to, { class: i === index ? 'find-match find-current' : 'find-match' })));
        },
      },
    })];
  },
});

/** The editor's find state: {query, opts, all, matches, index}. */
export const findState = (editor) => key.getState(editor.state);

const CLEAR = 100; // px kept clear at the viewport's top (the find bar) and bottom (the toolbar island)

/** Brings range {from, to} of `editor` into the page's viewport, centred, when it is not in view, by hand (the page's CSS zoom
 * misleads scrollIntoView). */
export function revealRange(editor, m) {
  const area = editor.view.dom.closest('[data-viewport]');
  if (!m || !area) return;
  const a = editor.view.coordsAtPos(m.from);
  const b = editor.view.coordsAtPos(m.to);
  const v = area.getBoundingClientRect();
  if (a.top < v.top + CLEAR || b.bottom > v.bottom - CLEAR) area.scrollTop += a.top - v.top - v.height / 2;
  if (a.left < v.left || b.right > v.right) area.scrollLeft += a.left - v.left - v.width / 2;
}

const reveal = (editor) => {
  const { matches, index } = findState(editor);
  revealRange(editor, matches[index]);
};

/** Finds `query`: the current match is the first one from the caret on. opts: findMatches' opts, plus highlightAll (false: only
 * the current match is highlighted) and index (the current match). */
export function findText(editor, query, opts) {
  const { state } = editor;
  const { highlightAll = true, index, ...search } = opts ?? {};
  const o = Object.keys(search).length ? search : undefined;
  const at = index ?? matchesOf(state.doc, query, o).findIndex((m) => m.from >= state.selection.from);
  editor.view.dispatch(state.tr.setMeta(key, { query, opts: o, all: highlightAll, index: Math.max(0, at) }));
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
 * current one, so a replacement that contains the query is not found again first. opts: {clip} for ^c; with the find's opts the
 * text's ^ codes, \n groups and ^& count. */
export function findReplace(editor, text, opts) {
  const { query, matches, index, opts: o } = findState(editor);
  const m = matches[index];
  if (!m) return;
  let tr;
  let end;
  if (o) {
    tr = editor.state.tr;
    end = applyParts(tr, m, replaceParts(editor.state.doc, m, text, { ...o, ...opts, query }));
  } else {
    tr = editor.state.tr.insertText(text, m.from, m.to);
    end = m.from + text.length;
  }
  closeHistory(tr);
  const after = matchesOf(tr.doc, query, o);
  const next = after.findIndex((n) => n.from >= end);
  editor.view.dispatch(tr.setMeta(key, { index: Math.max(0, next), matches: after }));
  reveal(editor);
}

/** Replaces every match with `text`, one undo step. → the number replaced. */
export function findReplaceAll(editor, text, opts) {
  const { matches, query, opts: o } = findState(editor);
  if (!matches.length) return 0;
  const tr = editor.state.tr;
  if (o) replaceAll(tr, query, text, { ...o, ...opts }); // one search for every match
  else for (const m of [...matches].reverse()) tr.insertText(text, m.from, m.to); // last first: the earlier positions stay valid
  editor.view.dispatch(closeHistory(tr).setMeta(key, { index: 0 }));
  return matches.length;
}

/** Ends the find: no highlights; the current match, if any, becomes the selection. */
export function findEnd(editor) {
  const { matches, index } = findState(editor);
  const m = matches[index];
  const tr = editor.state.tr.setMeta(key, { query: '', opts: undefined });
  if (m) tr.setSelection(TextSelection.create(tr.doc, m.from, m.to));
  editor.view.dispatch(tr);
}

/** Clears the highlights and leaves the selection as it is (Reading Highlight > Clear Highlighting). */
export function findClear(editor) {
  if (findState(editor)?.query || findState(editor)?.opts) editor.view.dispatch(editor.state.tr.setMeta(key, { query: '', opts: undefined }));
}
