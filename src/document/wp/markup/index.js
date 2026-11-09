// markup: Markup display, balloons and the Reviewing pane (docs/plans/word plan.md §3 markup, briefs/markup.md). The Show Markup
// menu, revision balloons and agent suggestion cards in the one margin column (MarginCards), the Reviewing pane, Track Changes
// Options and Advanced Track Changes Options, and Print Markup. It writes settings.word.tracking and print.markup; tracking draws the
// marks from them.
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { getState, subscribe } from '../../../app/store.js';
import { suggestionCards } from '../../../suggest/Review.jsx';
import { registerCards } from '../../../tooling/cards.jsx';
import { commentsOf, revisionsOf } from '../../model/review.mjs';
import { both } from '../../../tooling/engine-provider.mjs';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { authorsOf, togglePerson } from './balloons.mjs';
import { revisionCards } from './Balloon.jsx';
import { AdvancedTrackChangesOptions, TrackChangesOptions } from './dialogs.jsx';
import { paneSideNow, REVIEWING, setReviewingPane, toggleReviewingPane } from './pane.js';

const SHOW = 'review.markup.showMarkup';
const tracking = (ctx) => ctx.settings.word.tracking;
// saveWord merges one level into settings.word, so a nested key (show) is written whole.
const setTracking = (patch) => saveWord({ tracking: patch });
const showFlag = (key) => ({
  run: (ctx) => setTracking({ show: { ...tracking(ctx).show, [key]: !tracking(ctx).show[key] } }),
  active: (ctx) => tracking(ctx).show[key] !== false,
});
const balloonMode = (mode) => ({ run: () => setTracking({ balloons: mode }), active: (ctx) => tracking(ctx).balloons === mode });

/** The reviewers among engine `lists` (review.changes, review.comments), sorted. */
const namesOf = (...lists) => [...new Set(lists.flatMap((l) => l ?? []).map((c) => c.author).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/** Every reviewer of the open Document (Specific People): on a canvas draft the authors of the engine's changes and comments. */
const authors = (ctx) => {
  if (ctx.engine) return namesOf(ctx.read('review.changes', {}), ctx.read('review.comments', {}));
  return ctx.ed ? authorsOf(revisionsOf(ctx.ed.state.doc), commentsOf(ctx.ed.state.doc), ctx.ed.state.doc.attrs.people) : [];
};

/** The reviewers now: a canvas draft asks its engine, so a pick made before the gallery's first read sees them all. */
const authorsNow = async (ctx) => {
  if (!ctx.engine) return authors(ctx);
  const q = (id) => Promise.resolve(ctx.engine.query(id, {})).then((r) => r?.value ?? [], () => []);
  return namesOf(await q('review.changes'), await q('review.comments'));
};

let printMarkup = true; // settings.word.print.markup, mirrored for the editor root's data-print-markup

/** data-print-markup on the editor root ('on' | 'off'), which style.css's print rules key on. */
const PrintMarkup = Extension.create({
  name: 'wordPrintMarkup',
  addProseMirrorPlugins: () => [new Plugin({ props: { attributes: () => ({ 'data-print-markup': printMarkup ? 'on' : 'off' }) } })],
});

export default {
  id: 'markup',
  extensions: [PrintMarkup],
  commands: {
    [`${SHOW}.insertionsAndDeletions`]: showFlag('insDel'),
    [`${SHOW}.formatting`]: showFlag('formatting'),
    [`${SHOW}.balloons.showRevisionsInBalloons`]: balloonMode('revisions'),
    [`${SHOW}.balloons.showAllRevisionsInline`]: balloonMode('none'),
    [`${SHOW}.balloons.showOnlyFormattingInBalloons`]: balloonMode('comments'),
    // All Reviewers checked shows everyone; unchecking it hides every reviewer, as in Word.
    [`${SHOW}.specificPeople.allReviewers`]: {
      run: (ctx) => setTracking({ people: tracking(ctx).people == null ? [] : null }),
      active: (ctx) => tracking(ctx).people == null,
    },
    // One reviewer checked or unchecked (arg: the name, a pick in the reviewers gallery).
    [`${SHOW}.specificPeople`]: {
      run: async (ctx, name) => (typeof name === 'string' ? setTracking({ people: togglePerson(tracking(ctx).people, name, await authorsNow(ctx)) }) : false),
    },
    'review.markup.reviewingPane': { run: () => toggleReviewingPane(), active: () => !!paneSideNow() },
    'review.markup.reviewingPane.reviewingPaneVertical': { run: () => setReviewingPane('left'), active: () => paneSideNow() === 'left' },
    'review.markup.reviewingPane.reviewingPaneHorizontal': { run: () => setReviewingPane('bottom'), active: () => paneSideNow() === 'bottom' },
    'review.markup.launcher': { run: (ctx) => ctx.dialog('trackChangesOptions') },
    'print.markup': {
      run: (ctx) => saveWord({ print: { ...ctx.settings.word.print, markup: !ctx.settings.word.print.markup } }),
      active: (ctx) => ctx.settings.word.print.markup !== false,
    },
  },
  galleries: {
    // The reviewers under Specific People, each checked while shown.
    [`${SHOW}.specificPeople`]: both((ctx) => authors(ctx).map((name) => ({ id: name, label: name, active: tracking(ctx).people?.includes(name) ?? true }))),
  },
  dialogs: { trackChangesOptions: TrackChangesOptions, advancedTrackChangesOptions: AdvancedTrackChangesOptions },
  panes: { reviewing: REVIEWING },
  cards: { revisions: revisionCards, suggestions: suggestionCards },
  implements: [SHOW, `${SHOW}.balloons`],
  setup(editor) {
    // MarginCards redraws on transactions; a settings or suggestions change reaches the balloons and cards through a fresh
    // registration, and Print Markup through a transaction that only refreshes the editor root's attributes.
    let seen = {};
    const sync = () => {
      const s = getState();
      const word = wordSettings(s.settings);
      if (word.tracking !== seen.tracking || s.suggestions !== seen.suggestions) {
        registerCards('revisions', revisionCards);
        registerCards('suggestions', suggestionCards);
      }
      const on = word.print.markup !== false;
      if (on !== printMarkup && !editor.isDestroyed) {
        printMarkup = on;
        editor.view.dispatch(editor.state.tr.setMeta('wordPrintMarkup', on));
      }
      seen = { tracking: word.tracking, suggestions: s.suggestions };
    };
    sync();
    return subscribe(sync);
  },
};
