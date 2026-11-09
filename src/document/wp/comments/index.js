// Comments (docs/plans/word plan.md §3 comments): threads anchored on comment marks, cards beside the page with replies, edit,
// resolve and delete, the Comments pane, Review > Comments, Filter All Markup and Alt+F12. Word's classic comments (balloons with
// initials in compatibility mode) do not apply: no Document is in compatibility mode.
import { getState } from '../../../app/store.js';
import { paneOpen } from '../../../tooling/panes.jsx';
import { anchorRect } from '../page-engine/anchors.js';
import {
  commentSettings, commentState, CommentsExtension, deleteComment, deleteMany, hasComments, jumpToCard, newComment, poke,
  saveComments, setDone, setFilter, setView, shownThreads, startEdit, stepComment, togglePaneView,
} from './actions.js';
import { MarginCard, setHot } from './Card.jsx';
import { COLORS } from './comments.mjs';
import { CommentsPane } from './Pane.jsx';
import './canvas.js'; // the cards on a canvas draft, and the Review rows' comment hooks

const any = (ctx) => hasComments(ctx.ed?.state);
const active = (ctx) => (ctx.ed ? commentState(ctx.ed.state).active : null);
const filter = (ctx) => (ctx.ed ? commentState(ctx.ed.state).filter : null);
const listing = () => paneOpen('comments');

// New Comment: on the body text only (not inside a comment, header or note being edited).
const NEW = { run: (ctx) => ctx.story === 'body' && newComment(ctx.ed), enabled: (ctx) => !!ctx.ed && ctx.story === 'body' };
const ON_ANY = (run) => ({ run, enabled: any });
const DELETE = { run: (ctx) => !!active(ctx) && deleteComment(active(ctx)), enabled: any };
const toggleFilter = (f) => ({ run: (ctx) => setFilter(filter(ctx) === f ? null : f), active: (ctx) => filter(ctx) === f });

const commands = {
  'insert.comments.comment': NEW,
  'review.comments.newComment': NEW,
  'review.comments.delete': DELETE,
  'review.comments.delete.delete': DELETE,
  'review.comments.delete.deleteAllCommentsShown': ON_ANY(() => deleteMany('shown')),
  'review.comments.delete.deleteAllCommentsInDocument': ON_ANY(() => deleteMany('all')),
  'review.comments.delete.deleteAllResolvedComments': ON_ANY(() => deleteMany('resolved')),
  'review.comments.previous': ON_ANY(() => stepComment(-1)),
  'review.comments.next': ON_ANY(() => stepComment(1)),
  'review.comments.showComments': {
    // The main part shows or hides the cards; from the list it goes back to the cards.
    run: (ctx) => (listing() ? setView('contextual') : saveComments({ show: !ctx.settings.word.comments.show })),
    active: (ctx) => ctx.settings.word.comments.show && !listing(),
  },
  'review.comments.showComments.contextual': { run: () => setView('contextual'), active: () => !listing() },
  'review.comments.showComments.list': { run: () => setView('list'), active: listing },
  'frame.tabRow.comments': { run: () => togglePaneView(), active: listing },
  'review.markup.filterAllMarkup.resetAllFilters': { run: () => setFilter(null), enabled: (ctx) => !!filter(ctx) },
  'review.markup.filterAllMarkup.activeOnly': toggleFilter('active'),
  'review.markup.filterAllMarkup.resolvedOnly': toggleFilter('resolved'),
  'comments.jumpToCard': { run: () => jumpToCard() },
  // Mark Comment Done (the comment context menu): resolves the active thread; the card's Reopen undoes it.
  'comments.resolve': {
    run: (ctx) => !!active(ctx) && (setDone(active(ctx), true), true),
    enabled: (ctx) => !!active(ctx) && !ctx.ed.state.doc.attrs.comments?.[active(ctx)]?.done,
  },
  // comments.cards: 'reply' opens the Reply box of the active thread, 'edit' edits its first comment, no arg focuses its card.
  'comments.cards': {
    run: (ctx, arg) => (arg === 'reply' || arg === 'edit' ? !!active(ctx) && (startEdit(active(ctx), arg), true) : jumpToCard()),
    enabled: any,
  },
  // Cross-package (plan.md §1.3): opens comment `id`'s story editor with `from`..`to` of its text selected (find uses it).
  'x.reveal.comment': {
    run: (ctx, arg) => {
      const c = arg && ctx.ed?.state.doc.attrs.comments?.[arg.id];
      if (!c) return false;
      const top = c.parent ?? arg.id;
      poke(ctx.ed, { active: top, opened: top, editing: { id: arg.id, mode: 'edit', isNew: false, select: { from: arg.from, to: arg.to } } });
      return true;
    },
  },
};

// The margin cards: one per thread the filter shows; none while the pane lists them; icons while Show Comments is off.
const source = {
  cards(state, view) {
    if (!view.dom.isConnected || listing()) return [];
    const ps = commentState(state);
    const { show } = commentSettings();
    return shownThreads(state).map((c) => {
      let top = 0;
      try {
        top = anchorRect(view, c.from).top; // kept per block while it stays (page-engine/anchors.js)
      } catch { /* a position without coordinates (hidden text) sits at the top */ }
      return { id: c.id, top, active: c.id === ps.active, thread: c, editing: ps.editing, icon: !show && ps.opened !== c.id, Component: MarginCard };
    });
  },
};

// The author tints: one rule per thread setting its range's colour, rewritten when the threads or people change.
function colorRules(doc) {
  const people = doc.attrs.people ?? [];
  const color = (a) => people.find((p) => p.name === a)?.color ?? COLORS[0];
  return Object.entries(doc.attrs.comments ?? {}).filter(([, c]) => !c.parent)
    .map(([id, c]) => `[data-doc-text] span[data-comment="${CSS.escape(id)}"] { --cmt: ${color(c.author)}; }`).join('\n');
}

/** The main editor's comment chrome: author tints, hovering a range lifts its card, Esc in a card returns to the text, and the
 * list view's pane opens with the Document. */
function setup(editor) {
  const style = document.head.appendChild(document.createElement('style'));
  style.dataset.wordComments = '';
  let seen = null;
  const paint = () => {
    const { comments, people } = editor.state.doc.attrs;
    if (seen && seen[0] === comments && seen[1] === people) return;
    seen = [comments, people];
    style.textContent = colorRules(editor.state.doc);
  };
  paint();
  editor.on('transaction', paint);
  const over = (e) => setHot(e.target.closest?.('span[data-comment]')?.dataset.comment ?? null, 'text');
  editor.view.dom.addEventListener('mouseover', over);
  const esc = (e) => {
    if (e.key !== 'Escape' || !(e.target instanceof Element) || e.target.closest('[data-story]')) return;
    if (!e.target.closest('[data-card^="comments:"], [data-comment-card]')) return;
    e.preventDefault();
    editor.commands.focus();
  };
  document.addEventListener('keydown', esc);
  if (commentSettings().view === 'list' && getState().draft?.format === 'document') queueMicrotask(() => setView('list'));
  return () => {
    style.remove();
    editor.off('transaction', paint);
    editor.view.dom.removeEventListener('mouseover', over);
    document.removeEventListener('keydown', esc);
    setHot(null);
  };
}

export default {
  id: 'comments',
  extensions: [CommentsExtension],
  commands,
  panes: { comments: { title: 'Comments', side: 'right', width: 20, Component: CommentsPane } },
  cards: { comments: source },
  // comments.insertKey is Ctrl+Alt+M (insert.comments.comment's key row); the rest are behaviours of the cards and the plugin.
  implements: ['comments.insertKey', 'comments.highlight', 'comments.author', 'review.markup.filterAllMarkup'],
  setup,
};

