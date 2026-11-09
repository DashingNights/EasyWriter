// Comments in the open Document (docs/plans/word plan.md §3 comments): the editor plugin and the actions the commands, cards and
// pane share. The plugin keeps the session state of the main editor (the active thread, the filter, the card opened while Show
// Comments is off, the one story editor open) and changes it through meta-only transactions, so the ribbon and the margin cards
// redraw with it; it shades the active thread with one decoration set, renumbers pasted comments and drops a thread whose
// anchored text is all deleted, in the same undo step.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getState } from '../../../app/store.js';
import { closePane, openPane, paneOpen } from '../../../tooling/panes.jsx';
import { activeSurface } from '../../../tooling/surface.js';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { writeBack } from '../../word/story.js';
import {
  accountName, addComment, addReply, authorOf, colorOf, commentAt, commentsOf, copyThreads, deleteAll, deleteThreads, filterThreads, isEmpty,
  orphaned, pasteIds, rangesOf, remapSlice, setEntry, stepThread, threadOf, untracked, withoutThreads, wordAt,
} from './comments.mjs';

export const commentsKey = new PluginKey('wordComments');
const EMPTY = { active: null, filter: null, opened: null, editing: null, deco: DecorationSet.empty };

/** The main editor of the open Document, or null. */
export const mainEditor = () => activeSurface()?.editor ?? null;
/** The comments session state of `state` (EMPTY in an editor without the plugin). */
export const commentState = (state) => (state && commentsKey.getState(state)) ?? EMPTY;
/** The Document's comment settings {show, view}. */
export const commentSettings = () => wordSettings(getState().settings).comments;

const threadsMemo = new WeakMap(); // doc → commentsOf(doc)
/** The threads of `doc` in document order (commentsOf), memoised per doc. */
export function threadsOf(doc) {
  if (!threadsMemo.has(doc)) threadsMemo.set(doc, commentsOf(doc));
  return threadsMemo.get(doc);
}
/** The anchored threads of `state` that its filter shows. */
export const shownThreads = (state) => filterThreads(threadsOf(state.doc), commentState(state).filter).filter((c) => c.from != null);
/** Whether `state`'s doc holds any comment. */
export const hasComments = (state) => !!state && Object.keys(state.doc.attrs.comments ?? {}).length > 0;

/** Sets the session state of `ed` with `patch` through a meta-only transaction (no undo step: the doc does not change). */
export function poke(ed = mainEditor(), patch = {}) {
  if (ed && !ed.isDestroyed) ed.view.dispatch(ed.state.tr.setMeta(commentsKey, patch));
}

// The decoration set that shades the active thread darker, in the thread author's colour.
function activeDeco(doc, id) {
  if (!id) return DecorationSet.empty;
  const color = colorOf(doc.attrs.people, doc.attrs.comments?.[id]?.author);
  return DecorationSet.create(doc, rangesOf(doc, id).map((r) => Decoration.inline(r.from, r.to, { class: 'comment-active', style: `--cmt: ${color}` })));
}

// What the last copy in a Document carried: thread id → threadOf, so a paste into another draft brings its threads along.
let clip = new Map();
// The threads a paste brings: {before: the doc the paste applies to, pairs: [[newId, source thread]]}, copied in appendTransaction.
let pending = null;

const isStory = (view) => !!view.dom.closest?.('[data-story]');

const plugin = new Plugin({
  key: commentsKey,
  state: {
    init: () => EMPTY,
    apply(tr, prev, _old, next) {
      const meta = tr.getMeta(commentsKey);
      let v = meta ? { ...prev, ...meta } : prev;
      if (!meta && tr.selectionSet) {
        const active = commentAt(next);
        v = { ...v, active, opened: v.opened === active ? v.opened : null };
      }
      const comments = next.doc.attrs.comments ?? {};
      if (v.active && !comments[v.active]) v = { ...v, active: null };
      if (v.editing && !comments[v.editing.id] && v.editing.mode !== 'reply') v = { ...v, editing: null };
      // One decoration set: rebuilt when the active thread changes, mapped through edits otherwise.
      const deco = v.active !== prev.active ? activeDeco(next.doc, v.active) : tr.docChanged ? prev.deco.map(tr.mapping, next.doc) : prev.deco;
      return deco === v.deco ? v : { ...v, deco };
    },
  },
  props: {
    decorations: (state) => commentsKey.getState(state).deco,
    transformCopied(slice, view) {
      if (isStory(view)) return slice;
      const comments = view.state.doc.attrs.comments ?? {};
      const next = new Map();
      remapSlice(slice, (id) => {
        const t = threadOf(comments, id);
        if (t) next.set(id, t);
        return id;
      });
      clip = next;
      return slice;
    },
    transformPasted(slice, view) {
      // Comment text holds no comments of its own.
      if (isStory(view)) return remapSlice(slice, () => null).slice;
      const { slice: out, pairs } = pasteIds(slice, view.state.doc.attrs.comments ?? {}, clip);
      pending = pairs.length ? { before: view.state.doc, pairs } : null;
      return out;
    },
  },
  appendTransaction(trs, _old, next) {
    const gone = orphaned(trs, next);
    const paste = pending && trs.some((tr) => tr.before === pending.before && tr.docChanged) ? pending : null;
    if (paste) pending = null;
    if (!gone.length && !paste) return null;
    let comments = next.doc.attrs.comments ?? {};
    if (gone.length) comments = withoutThreads(comments, gone);
    if (paste) comments = copyThreads(comments, paste.pairs.filter(([id]) => rangesOf(next.doc, id).length));
    return next.tr.setDocAttribute('comments', comments).setMeta('commentsOwn', true);
  },
});

/** The comments extension of the Document kit (main, story and session editors; it only acts where comments live). */
export const CommentsExtension = Extension.create({ name: 'wordComments', addProseMirrorPlugins: () => [plugin] });

// ---------------------------------------------------------------------------------------------
// Actions on the main editor

const now = () => new Date().toISOString();
const author = () => authorOf(wordSettings(getState().settings).user, accountName());
let added = null; // {id, doc}: the last new comment and the doc right after it, so Esc on it can remove it without an undo step

/** New comment on `ed`'s selection, or on the word at the caret; opens its card with the focus in it → true. */
export function newComment(ed = mainEditor()) {
  if (!ed) return false;
  const s = ed.state;
  const { from, to, empty } = s.selection;
  const range = empty ? (wordAt(s.doc, from) ?? { from, to: from }) : { from, to };
  const { name, initials } = author();
  const { tr, id } = addComment(s, range, { author: name, initials, date: now(), content: [{ type: 'paragraph' }] });
  ed.view.dispatch(tr.setMeta(commentsKey, { active: id, opened: id, editing: { id, mode: 'edit', isNew: true } }));
  added = { id, doc: ed.state.doc };
  return true;
}

/** Writes story `content` and the shared `attrs` it changed into comment `id`: one main undo step per edit batch. */
export function writeContent(id, content, attrs) {
  const ed = mainEditor();
  if (ed) writeBack(ed, attrs, (tr) => setEntry(ed.state, id, { content: untracked(content) }, tr));
}

/** Ends the open story editor: `post` keeps it, else a new comment left empty goes as if it never came. */
export function endEdit({ cancelNew = false } = {}) {
  const ed = mainEditor();
  if (!ed) return;
  const e = commentState(ed.state).editing;
  if (cancelNew && e?.isNew && isEmpty(ed.state.doc.attrs.comments?.[e.id]?.content)) {
    const tr = deleteThreads(ed.state, [e.id]);
    // Untouched since it came: the removal stays out of history, so no redo step brings an empty comment back (undo() would
    // leave one). The add step stays in history but undoing it changes nothing.
    if (tr) ed.view.dispatch(added?.id === e.id && added.doc === ed.state.doc ? tr.setMeta('addToHistory', false) : tr);
  }
  poke(ed, { editing: null });
  ed.commands.focus();
}

/** Posts reply `content` (block JSON) to thread `parent`. */
export function postReply(parent, content) {
  const ed = mainEditor();
  if (!ed) return;
  if (isEmpty(content)) return endEdit();
  const { name, initials } = author();
  const { tr } = addReply(ed.state, parent, { author: name, initials, date: now(), content: untracked(content) });
  ed.view.dispatch(tr.setMeta(commentsKey, { editing: null }));
  ed.commands.focus();
}

/** Opens the story editor on comment `id` (`mode` 'edit') or on a reply to thread `id` ('reply'). */
export const startEdit = (id, mode = 'edit', select = null) => poke(mainEditor(), { editing: { id, mode, isNew: false, select }, active: topOf(id) });

const topOf = (id) => mainEditor()?.state.doc.attrs.comments?.[id]?.parent ?? id;

/** Sets comment `id`'s done flag (Resolve thread, Reopen). */
export function setDone(id, done) {
  const ed = mainEditor();
  const tr = ed && setEntry(ed.state, id, { done });
  if (tr) ed.view.dispatch(tr);
}

/** Deletes thread or reply `id`. */
export function deleteComment(id) {
  const ed = mainEditor();
  const tr = ed && deleteThreads(ed.state, [id]);
  if (tr) ed.view.dispatch(tr);
  return !!tr;
}

/** Deletes every thread of `which` ('shown', 'all', 'resolved') → whether any went. */
export function deleteMany(which) {
  const ed = mainEditor();
  const tr = ed && deleteAll(ed.state, which, commentState(ed.state).filter);
  if (tr) ed.view.dispatch(tr);
  return !!tr;
}

/** Selects thread `c`'s range in the main editor and makes it active. */
export function selectThread(c, ed = mainEditor()) {
  if (!ed || c?.from == null) return false;
  const tr = ed.state.tr.setSelection(TextSelection.create(ed.state.doc, c.from, c.to)).scrollIntoView();
  ed.view.dispatch(tr.setMeta(commentsKey, { active: c.id, opened: c.id }));
  ed.commands.focus();
  return true;
}

/** Selects the next (`dir` 1) or previous (-1) shown thread after the selection, wrapping. */
export function stepComment(dir) {
  const ed = mainEditor();
  if (!ed) return false;
  return selectThread(stepThread(shownThreads(ed.state), ed.state.selection.from, dir), ed);
}

/** Sets the filter: null, 'active' or 'resolved'. */
export const setFilter = (filter) => poke(mainEditor(), { filter });

/** Saves `patch` into settings.word.comments, then redraws the cards. */
export function saveComments(patch) {
  const ed = mainEditor();
  // A change of show forgets the card a margin icon opened.
  const redraw = () => poke(ed, 'show' in patch ? { opened: null } : {});
  return saveWord({ comments: patch }).then(redraw, redraw);
}

/** Show Comments > List: the Comments pane, cards hidden; Contextual: the cards beside the page. */
export function setView(view) {
  if (view === 'list') openPane('comments');
  else closePane('comments');
  saveComments(view === 'list' ? { view } : { view, show: true });
}

/** The tab row's Comments button: opens or closes the Comments pane (the list view). */
export const togglePaneView = () => setView(paneOpen('comments') ? 'contextual' : 'list');

/** Alt+F12: the focus moves into the card beside the caret (the active thread's, else the nearest card of any source). */
export function jumpToCard() {
  const ed = mainEditor();
  if (!ed) return false;
  const id = commentState(ed.state).active;
  let el = id && (document.querySelector(`[data-card="comments:${CSS.escape(id)}"]`)
    ?? document.querySelector(`[data-pane="comments"] [data-comment-card="${CSS.escape(id)}"]`));
  if (!el) {
    let y = 0;
    try {
      y = ed.view.coordsAtPos(ed.state.selection.from).top;
    } catch { /* no coordinates: the first card wins */ }
    const all = [...document.querySelectorAll('[data-margin-cards] [data-card], [data-pane="comments"] [data-comment-card]')];
    el = all.sort((a, b) => Math.abs(a.getBoundingClientRect().top - y) - Math.abs(b.getBoundingClientRect().top - y))[0];
  }
  if (!el) return false;
  if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
  el.focus();
  return true;
}
