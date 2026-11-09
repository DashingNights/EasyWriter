// The Review package's rows of the Documents engine table (docs/plans/engine/stage2.md): comments, tracking, proofing,
// protection, compare, outline, navigation, mail merge, backstage and views (S5). Only that package edits this file. Rows by
// tooling id in the forms of forms.mjs (APP, exec, off, a CommandSpec); commands.mjs joins them. Pure: node tests load it.
//
// A row that also acts on the app (the store's view and mode, a per-user setting, a card) calls `reviewApp`, which the comments
// module binds in the browser (src/document/wp/comments/canvas.js); its defaults do nothing, so node tests load the table alone.
import { base64 } from '../../../tooling/base64.mjs';
import { sourceOfDoc } from '../../wp/mailings/data.mjs';
import { canSplit, setSplit, splitAt } from '../split.mjs';
import { APP, exec, off } from './forms.mjs';

/** The app's side of the rows, bound by bindReviewApp: setMode(mode), mode() (the store's editing mode), saveWord(patch), title(), saveFile({name,
 * data, filters}) → path, openLink(href), copyText(text), and the canvas comment cards (comments/canvas.js): activeComment(),
 * editComment(id, mode, isNew), filter(), setFilter(f), jumpToCard(), shownComments(list) → the list the filter shows; and
 * proofing's (proofing/canvas.js): spelling(ctx, {grammar?}) opens the Spelling pane, nextMisspelling(ctx) (Alt+F7), readAloud(ctx) starts or
 * stops reading, reading() whether it reads, recheck() forgets Ignore and Ignore All; and mail merge's (mailings/canvas.js):
 * newDraft(title, model, {print}) opens a document a merge made as a new canvas draft, confirm({title, description, confirmText}),
 * openFile(opts) the system Open dialog, loadDraft(id) a draft's {title, doc} (a canvas draft's doc read from its engine form);
 * and views' move(): the store's page movement (viewsMove), null until the app binds it. */
export const reviewApp = {
  setMode: () => {},
  mode: () => 'editing',
  saveWord: async () => {},
  title: () => '',
  saveFile: async () => null,
  openLink: () => false,
  copyText: async () => false,
  activeComment: () => null,
  editComment: () => false,
  filter: () => null,
  setFilter: () => {},
  jumpToCard: () => false,
  shownComments: (list) => list,
  spelling: () => false,
  nextMisspelling: async () => false,
  readAloud: async () => false,
  reading: () => false,
  recheck: () => false,
  newDraft: async () => false,
  confirm: async () => true,
  openFile: async () => null,
  loadDraft: async () => null,
  move: () => null,
};
export const bindReviewApp = (fns) => Object.assign(reviewApp, fns);

// ---------- reasons (UI copy: plain words, no em dashes) ----------

const R = {
  outline: 'Works in Outline view.',
  merge: 'Start a mail merge first.',
  noList: 'Select a recipient list first.',
  labelMerge: 'Start a label merge first.',
  preview: 'Turn on Preview Results first.',
  bookmarkLink: 'This link goes to a bookmark. Use Go To in Find and Replace.',
};

// ---------- small readers of the engine state ----------

const state = (ctx, id) => ctx.engineState?.[id] ?? null;
const context = (ctx) => state(ctx, 'document.context')?.value ?? null;
const notOutline = (ctx) => (ctx.view === 'outline' ? null : R.outline);
// Whether a tracked change or a comment is left (review.counts, read again after each change). The commands that act on them
// are off without a reason while none is, as on the DOM path, so tool search leaves them out. Until the engine first answers
// they stay on: a command run before any control read the count must not be refused.
// ponytail: a read right after an edit answers with the value from before it (ctx.read reads again in the background), so
// the first change after none can be refused once within that round trip; a per-event state read would close it.
const counts = (ctx) => ctx.read('review.counts', {});
const anyChange = (ctx) => counts(ctx)?.changes !== false;
const anyComment = (ctx) => counts(ctx)?.comments !== 0;
/** Engine command `id` with `args` ((arg, ctx) => params, an object, or the control's argument), enabled while `enabled`, else
 * off with `reason` (none: tool search leaves it out, as the DOM path's commands without one). A CommandSpec row, so it serves
 * ids that are no ribbon control too (keys, menus), where an exec row may not stand. */
const runWhile = (id, args, enabled, reason) => ({
  run: async (ctx, arg) => {
    const params = typeof args === 'function' ? args(arg, ctx) : args ?? arg ?? {};
    const r = await Promise.resolve(ctx.engine.exec(id, params)).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
    if (!r?.ok) console.error(`Engine command '${id}' failed:`, r?.error);
    return !!r?.ok;
  },
  enabled,
  reason,
});
// A `when` that reads a state passes while the snapshot lacks it: the registry asks for a row's state only after its `when`
// passes, so the first read must get through to register it.
// A merge is on when Start Mail Merge chose a kind or a recipient list is attached, as on the DOM path (mailings/commands.js inMerge).
const merging = (ctx) => {
  const e = state(ctx, 'mailings.start');
  return !e || e.value !== 'normal' || mergeOf(ctx)?.hasList ? null : R.merge;
};
const never = () => false;

/** Runs `steps` ([[id, args]]) as one undo step → whether it ran. */
const many = async (ctx, steps) => (steps.length ? !!(await ctx.engine.execMany(steps))?.ok : false);

// ---------- comments ----------

/** The comment the card commands act on: the active card's, else the innermost one at the selection. */
const commentHere = (ctx) => reviewApp.activeComment() ?? context(ctx)?.comments?.at(-1) ?? null;

const newComment = {
  run: async (ctx) => {
    const r = await ctx.engine.exec('review.newComment', {});
    // The card's isNew is the undo step that made the comment, so leaving it empty takes that step back (CanvasCards.jsx).
    const step = r?.ok ? (await Promise.resolve(ctx.engine.steps?.()).catch(() => null))?.undo : null;
    if (r?.ok) reviewApp.editComment(r.value?.id, 'edit', step ?? true);
    return !!r?.ok;
  },
  // New comments go on the body text, as on the DOM path.
  enabled: (ctx) => ctx.story === 'body' && state(ctx, 'review.newComment')?.enabled !== false,
  reason: (ctx) => (ctx.story === 'body' ? state(ctx, 'review.newComment')?.reason ?? null : 'Put the caret in the body text first.'),
};
const deleteOne = runWhile('review.deleteComment', (_arg, ctx) => (commentHere(ctx) != null ? { id: commentHere(ctx) } : {}), anyComment);
const commentStep = (id) => runWhile(id, {}, anyComment);

/** Deletes every thread `pick` keeps (top comments; their replies go with them) as one undo step. */
const deleteThreads = (pick) => ({
  run: async (ctx) => {
    const list = (await ctx.engine.query('review.comments', {}))?.value ?? [];
    return many(ctx, list.filter((c) => c.parent == null && pick(c, list)).map((c) => ['review.deleteComment', { id: c.id }]));
  },
  enabled: anyComment,
});
const filterIs = (f) => ({ run: () => (reviewApp.setFilter(reviewApp.filter() === f ? null : f), true), active: () => reviewApp.filter() === f });

const COMMENTS = {
  'insert.comments.comment': newComment,
  'review.comments.newComment': newComment,
  'review.comments.delete': deleteOne,
  'review.comments.delete.delete': deleteOne,
  'review.comments.delete.deleteAllCommentsShown': deleteThreads((c, list) => reviewApp.shownComments(list).includes(c)),
  'review.comments.delete.deleteAllCommentsInDocument': runWhile('review.deleteComment', { all: true }, anyComment),
  'review.comments.delete.deleteAllResolvedComments': deleteThreads((c) => c.resolved),
  'review.comments.previous': commentStep('review.previousComment'),
  'review.comments.next': commentStep('review.nextComment'),
  // Show Comments, its List and Contextual items and the tab row's Comments button act on the app: the cards and the pane
  // (comments/canvas.js, Pane.jsx) read the engine on a canvas draft.
  'review.comments.showComments': APP,
  'review.comments.showComments.contextual': APP,
  'review.comments.showComments.list': APP,
  'frame.tabRow.comments': APP,
  'review.markup.filterAllMarkup.resetAllFilters': { run: () => (reviewApp.setFilter(null), true), enabled: () => !!reviewApp.filter() },
  'review.markup.filterAllMarkup.activeOnly': filterIs('active'),
  'review.markup.filterAllMarkup.resolvedOnly': filterIs('resolved'),
  'comments.jumpToCard': { run: () => reviewApp.jumpToCard() },
  'comments.resolve': runWhile('review.resolveComment', (_arg, ctx) => ({ id: commentHere(ctx), value: true }), (ctx) => commentHere(ctx) != null),
  'comments.cards': {
    run: (ctx, arg) => (arg === 'reply' || arg === 'edit' ? commentHere(ctx) != null && reviewApp.editComment(commentHere(ctx), arg) : reviewApp.jumpToCard()),
    enabled: anyComment,
  },
  'x.reveal.comment': { run: (_ctx, arg) => arg?.id != null && reviewApp.editComment(arg.id, 'edit') },
};

// ---------- tracking and markup ----------

const DISPLAY_IDS = ['simpleMarkup', 'allMarkup', 'noMarkup', 'original'].map((v) => `review.markup.displayForReview.${v}`);
const trackingOn = (ctx) => !!state(ctx, 'review.trackChanges')?.checked;
const modeOf = (ctx) => (reviewApp.mode() === 'viewing' ? 'viewing' : trackingOn(ctx) ? 'reviewing' : 'editing');
const MODE = { editing: 'frame.tabRow.editingMode.editing', reviewing: 'frame.tabRow.editingMode.reviewing', viewing: 'frame.tabRow.editingMode.viewing' };
/** Track Changes on or off for the tab row's Editing and Reviewing (Track Changes itself toggles), which also leave Viewing. They
 * run while Viewing holds (the session then refuses review.trackChanges until the mode, which tracking/engine.js pushes first,
 * has left it) and read review.trackChanges's state, which modeOf reads. */
const setTracking = (on, mode) => ({
  run: async (ctx) => {
    if (reviewApp.mode() === 'viewing') reviewApp.setMode(mode); // the store's Viewing mode is the app's; the switch leaves it
    const r = await Promise.resolve(ctx.engine.exec('review.trackChanges', { value: on })).catch(() => null);
    state(ctx, 'review.trackChanges'); // read once more, so the state call keeps the id modeOf reads
    return !!r?.ok;
  },
  enabled: (ctx) => reviewApp.mode() === 'viewing' || state(ctx, 'review.trackChanges')?.enabled !== false,
  reason: (ctx) => state(ctx, 'review.trackChanges')?.reason ?? null,
  active: (ctx) => modeOf(ctx) === mode,
  reads: ['review.trackChanges'],
});
// Accept or Reject and Move to Next run while any change is left; This Change only at one (document.context's revision: the
// character before the caret, or the selection's end).
const here = (id, next) => runWhile(id, next ? { next: true } : {}, next ? anyChange : (ctx) => context(ctx)?.revision != null);
const all = (id, args) => runWhile(id, args, anyChange);
// Accept or Reject All Changes Shown run while Track Changes Options hides a kind of change or Specific People hides a reviewer, as
// on the DOM path; the engine resolves what its session shows, which tracking/engine.js keeps to these settings.
const hidesKind = (ctx) => {
  const t = ctx.settings?.word?.tracking;
  return t?.show?.insDel === false || t?.show?.formatting === false || t?.people != null;
};
const shown = (id) => runWhile(id, { shown: true }, (ctx) => anyChange(ctx) && hidesKind(ctx));

// Lock Tracking is Restrict Editing's tracked changes mode in the engine (review.restrict, saved as w:documentProtection), with
// the DOM path's dialog for the password. review.trackChanges's state value is 'locked' while it holds.
const locked = (ctx) => state(ctx, 'review.trackChanges')?.value === 'locked';
const lockTracking = {
  run: async (ctx) => {
    const unlock = locked(ctx);
    const r = await ctx.dialog('lockTracking', unlock ? { unlock: true } : {});
    if (!r) return false;
    if (unlock) {
      const res = await ctx.engine.exec('review.restrict', { stop: true, password: r.password ?? '' });
      if (!res?.ok) ctx.toast('That password is not right, so Track Changes stays on.');
      return !!res?.ok;
    }
    const ok = await many(ctx, [['review.trackChanges', { value: true }], ['review.restrict', { mode: 'trackedChanges', ...(r.password && { password: r.password }) }]]);
    if (ok && reviewApp.mode() !== 'viewing') reviewApp.setMode('reviewing');
    return ok;
  },
  active: locked,
};

const TRACKING = {
  'review.tracking.trackChanges': 'review.trackChanges',
  'review.tracking.trackChanges.forEveryone': 'review.trackChanges',
  'review.tracking.trackChanges.lockTracking': lockTracking,
  'review.tracking.accept': here('review.accept', true),
  'review.tracking.accept.acceptAndMoveToNext': here('review.accept', true),
  'review.tracking.accept.acceptThisChange': here('review.accept'),
  'review.tracking.accept.acceptAllChangesShown': shown('review.acceptAll'),
  'review.tracking.accept.acceptAllChanges': all('review.acceptAll', {}),
  'review.tracking.accept.acceptAllChangesAndStopTracking': all('review.acceptAll', { stopTracking: true }),
  'review.tracking.reject': here('review.reject', true),
  'review.tracking.reject.rejectAndMoveToNext': here('review.reject', true),
  'review.tracking.reject.rejectChange': here('review.reject'),
  'review.tracking.reject.rejectAllChangesShown': shown('review.rejectAll'),
  'review.tracking.reject.rejectAllChanges': all('review.rejectAll', {}),
  'review.tracking.reject.rejectAllChangesAndStopTracking': all('review.rejectAll', { stopTracking: true }),
  'review.tracking.previous': all('review.previousChange', {}),
  'review.tracking.next': all('review.nextChange', {}),
  // Display for Review is the per-user setting (settings.word.tracking.display), pushed to every session as review.markup
  // (tracking/engine.js). The engine draws all four (stage2.md G43) and view.state reports which one holds.
  'review.markup.displayForReview': APP,
  ...Object.fromEntries(DISPLAY_IDS.map((id) => [id, APP])),
  'frame.tabRow.editingMode': { value: (ctx) => MODE[modeOf(ctx)], run: (ctx, arg) => (arg ? ctx.run(arg) : true) },
  [MODE.editing]: setTracking(false, 'editing'),
  [MODE.reviewing]: setTracking(true, 'reviewing'),
  // Viewing is the store's mode; tracking/engine.js sets the session read-only (view.readOnly) while it holds.
  [MODE.viewing]: { run: () => (reviewApp.setMode('viewing'), true), active: (ctx) => modeOf(ctx) === 'viewing' },
  'tracking.userName': APP,
  'tracking.authorColors': APP,
};

const SHOW = 'review.markup.showMarkup';
const MARKUP = {
  // Settings the sessions follow (tracking/engine.js pushes them as review.trackingOptions and file.printMarkup).
  [`${SHOW}.insertionsAndDeletions`]: APP,
  [`${SHOW}.formatting`]: APP,
  [`${SHOW}.balloons.showAllRevisionsInline`]: APP,
  // The balloons beside the page (comments/CanvasCards.jsx draws review.balloons) and Specific People (review.trackingOptions
  // {people}, the display and the lists) follow the same settings.
  [`${SHOW}.balloons.showRevisionsInBalloons`]: APP,
  [`${SHOW}.balloons.showOnlyFormattingInBalloons`]: APP,
  [`${SHOW}.specificPeople.allReviewers`]: APP,
  [`${SHOW}.specificPeople`]: APP,
  // The Reviewing pane lists the engine's changes and comments on a canvas draft (markup/ReviewingPane.jsx).
  'review.markup.reviewingPane': APP,
  'review.markup.reviewingPane.reviewingPaneVertical': APP,
  'review.markup.reviewingPane.reviewingPaneHorizontal': APP,
  'review.markup.launcher': APP,
  'print.markup': APP,
};

// ---------- compare and protect ----------

// Compare, Combine, the Source Documents pane and Version History run as registered (wp/compare): a comparison into a canvas
// draft runs in the engine with the other draft's bytes, and a backup version is restored through `file.restoreVersion`
// (engine-canvas-read, G37).
const COMPARE = {
  'review.compare.compare.compare': APP,
  'review.compare.compare.combine': APP,
  'review.compare.compare.showSourceDocuments': APP,
  'file.info.versionHistory': APP,
};

// The Restrict Editing pane and the Protect Document menu read and write review.restrict, file.info and file.markAsFinal on a
// canvas draft (protect/CanvasPane.jsx, Info.jsx).
const PROTECT = {
  'review.protect.restrictEditing': APP,
  'file.info.protectDocument': APP,
};

// ---------- proofing ----------

const PROOFING = {
  // The Spelling pane, Alt+F7 and Read Aloud use the app's checker and speech over the engine's blocks(page), as the canvas
  // squiggles do (proofing/canvas.js), not engine commands.
  'review.proofing.spellingAndGrammar': { run: (ctx) => reviewApp.spelling(ctx) },
  'review.proofing.spellingAndGrammar.spelling': { run: (ctx) => reviewApp.spelling(ctx) },
  'review.proofing.spellingAndGrammar.spellingAndGrammar': { run: (ctx) => reviewApp.spelling(ctx, { grammar: true }) },
  'proofing.nextMisspelling': { run: (ctx) => reviewApp.nextMisspelling(ctx) },
  // arg 'recheck' (Options > Proofing > Recheck Document) forgets Ignore and Ignore All.
  'proofing.ignore': { run: (_ctx, arg) => arg === 'recheck' && reviewApp.recheck() },
  // Word Count reads review.wordCount on a canvas draft (proofing/dialogs.jsx).
  'review.proofing.wordCount': { run: (ctx) => (ctx.dialog('wordCount'), true) },
  'review.proofing.thesaurus': { run: (ctx) => (ctx.pane('thesaurus', true, { n: Date.now() }), true), enabled: (ctx) => !!ctx.engine },
  'wordCount.recount': {
    run: async (ctx) => {
      const n = (await ctx.engine.query('review.wordCount', { includeTextBoxes: ctx.settings?.word?.proofing?.countNotes ?? true }))?.value?.words;
      if (n == null) return false;
      ctx.toast(`${n.toLocaleString('en-GB')} ${n === 1 ? 'word' : 'words'}`);
      return n;
    },
  },
  'review.speech.readAloud': { run: (ctx) => reviewApp.readAloud(ctx), active: () => reviewApp.reading() },
  // The Accessibility pane reads file.accessibility and the Language dialog writes review.language on a canvas draft
  // (proofing/A11yPane.jsx, dialogs.jsx).
  'review.accessibility.checkAccessibility': APP,
  'review.accessibility.checkAccessibility.checkAccessibility': APP,
  'review.accessibility.checkAccessibility.optionsAccessibility': APP,
  'review.language.language': APP,
  'review.language.language.setProofingLanguage': APP,
  'review.language.language.languagePreferences': APP,
};

// ---------- outline ----------

/** 'level1'..'level9', 'bodyText' or a number → outline.level's level. */
const levelArg = (arg) => (arg === 'bodyText' || arg === 10 ? 'body' : typeof arg === 'number' ? arg : /^level([1-9])$/.test(arg ?? '') ? +arg.slice(5) : null);
/** The Outline Level box's text for engine level `n` (1-9, 10 body text), as outline/levels.mjs levelLabel names them. */
export const levelLabel = (n) => (n == null ? '' : n >= 10 ? 'Body Text' : `Level ${n}`);
const inOutline = (id, args = {}, more = {}) => exec(id, args, { when: notOutline, ...more });
// Outline's keys, which are no ribbon controls.
const outlineKey = (id) => runWhile(id, {}, (ctx) => ctx.view === 'outline', notOutline);
const anywhere = (id) => runWhile(id, {});

const OUTLINE = {
  // The store's view (the Outlining tab, the ribbon's contexts) is the app's; the session's view mode follows it (tracking/engine.js).
  'view.views.outline': APP,
  'outlining.close.closeOutlineView': APP,
  'outlining.outlineTools.promoteToHeading1': 'outline.promoteToHeading1',
  'outlining.outlineTools.promote': 'outline.promote',
  'outlining.outlineTools.demote': 'outline.demote',
  'outlining.outlineTools.demoteToBodyText': 'outline.demoteToBody',
  'outlining.outlineTools.outlineLevel': exec('outline.level', (arg) => ({ level: levelArg(arg) }), { value: (e) => levelLabel(e?.value) }),
  'outlining.outlineTools.moveUp': 'outline.moveUp',
  'outlining.outlineTools.moveDown': 'outline.moveDown',
  'outlining.outlineTools.expand': inOutline('outline.expand'),
  'outlining.outlineTools.collapse': inOutline('outline.collapse'),
  'outlining.outlineTools.showLevel': inOutline('outline.showLevel', (arg) => ({ level: arg === 'allLevels' || arg == null ? 'all' : levelArg(arg) }), {
    value: (e, ctx) => (ctx.view !== 'outline' ? '' : !e?.value ? 'All Levels' : levelLabel(e.value)),
  }),
  'outlining.outlineTools.showTextFormatting': inOutline('outline.showFormatting'),
  'outlining.outlineTools.showFirstLineOnly': inOutline('outline.firstLineOnly'),
  'outline.promote': anywhere('outline.promote'),
  'outline.demote': anywhere('outline.demote'),
  'outline.moveUp': anywhere('outline.moveUp'),
  'outline.moveDown': anywhere('outline.moveDown'),
  'outline.firstLine': outlineKey('outline.firstLineOnly'),
  'outline.showAllHeadings': outlineKey('outline.showAll'),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`outline.showHeading${n}`, outlineKey(`outline.showLevel${n}`)])),
};

// ---------- navigation pane ----------

// The Navigation pane reads the engine on a canvas draft (navpane/CanvasNav.jsx); headings fold in the page views through
// heading.collapse (stage2.md G19), the heading at or above the caret by default.
const fold = (op) => runWhile('heading.collapse', { op });
const NAVPANE = {
  'view.show.navigationPane': APP,
  'review.accessibility.checkAccessibility.navigationPane': APP,
  'navPane.expandHeading': fold('expand'),
  'navPane.collapseHeading': fold('collapse'),
  'navPane.toggleHeading': fold('toggle'),
  // The text's right-click menu: arg 'toggle', 'expand', 'collapse', 'expandAll' or 'collapseAll'.
  'navPane.collapsibleHeadings': runWhile('heading.collapse', (arg) => ({ op: typeof arg === 'string' ? arg : 'toggle' })),
  // Saved as w15:collapsed; a heading set so folds in the page views until the reader opens it. The Paragraph dialog draws its own
  // check box.
  'paragraph.collapsedByDefault': anywhere('outline.collapsedByDefault'),
};

// ---------- mailings ----------
// The list and the merge's choices are the document's (the engine's MailMerge, saved with the canvas record); the dialogs are the
// DOM editor's, which take and return data, so these rows read the engine, open them and write what they return
// (engine-gaps-mailings, stage2.md G7 and G24). The documents a merge makes come back from `mailings.document` as the engine's
// stored form and open as new canvas drafts.

const M = 'mailings.';
const startAs = (kind) => exec('mailings.start', { kind }, { active: (e) => (e?.value || 'normal') === kind });
// These read another command's state, so they watch it (`state`) and keep their own button unpressed.
const inMerge = (id, args) => exec(id, args, { state: 'mailings.start', when: merging, active: never, value: never });
const stepRecord = (id) => exec(id, {}, { state: 'mailings.preview', when: (ctx) => (state(ctx, 'mailings.preview')?.checked === false ? R.preview : null), active: never });

/** The merge the snapshot holds ({kind, hasList, source, records, total, preview, record, fields, envelope, label}), or null until
 * the engine answers. */
const mergeOf = (ctx) => state(ctx, 'mailings.state')?.value ?? null;
const listReason = (ctx) => (mergeOf(ctx) && !mergeOf(ctx).hasList ? R.noList : null);
/** A dialog row that needs a recipient list. Its `when` passes while the snapshot lacks the state, as `merging` does. */
const withList = (run) => ({ run, enabled: (ctx) => !listReason(ctx), reason: listReason, reads: ['mailings.state'] });
/** A dialog row for a mail merge (any kind but a normal document). */
const forMerge = (run) => ({ run, enabled: (ctx) => !merging(ctx), reason: merging, reads: ['mailings.start', 'mailings.state'] });

/** Runs engine command `id` → its value, or null after saying why it failed. */
async function call(ctx, id, params = {}) {
  const r = await Promise.resolve(ctx.engine.exec(id, params)).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
  if (r?.ok) return r.value ?? {};
  console.error(`Engine command '${id}' failed:`, r?.error);
  return null;
}

/** The user's name and address from Word's options (the return address). */
const userAddress = (ctx) => {
  const u = ctx.settings?.word?.user ?? {};
  return [u.name, u.address].filter((s) => String(s ?? '').trim()).join('\n');
};

// The engine's comparison ids the Filter and Sort dialog names otherwise (the engine reads the dialog's too).
const DIALOG_OP = { equal: 'eq', notEqual: 'ne', less: 'lt', greater: 'gt', lessOrEqual: 'le', greaterOrEqual: 'ge', notBlank: 'nonblank' };

/** The engine's list (mailings.list) as the mail merge dialogs take it: a source {name, fields, records} and the merge's choices
 * {filter, sort, exclude (record numbers), map}. */
const dialogList = (l) => ({
  source: { name: l.source, fields: l.fields, records: l.records },
  merge: { filter: l.rules.map((r, i) => ({ join: i ? r.join : 'and', field: r.field, op: DIALOG_OP[r.op] ?? r.op, value: r.value })),
    sort: l.sort.map((k) => ({ field: k.field, desc: k.descending })), exclude: l.excluded, map: l.map },
});

/** Makes `source` ({name, fields, records}, a dialog's or a file's) the document's recipient list → whether it was taken. */
async function setList(ctx, source) {
  if (!source?.fields?.length) {
    ctx.toast('That list has no column names in its first row.');
    return false;
  }
  return !!(await call(ctx, 'mailings.recipients', { name: source.name, fields: source.fields, rows: source.records }));
}

/** Use an Existing List: `arg` {draftId} reads that Document draft's first table, else the Open dialog picks a list file (CSV,
 * TSV, TXT or a workbook, which the engine reads; a workbook of several sheets gives its first). */
async function useExisting(ctx, arg) {
  if (arg?.draftId) {
    const draft = await reviewApp.loadDraft(arg.draftId);
    const source = draft?.doc && sourceOfDoc(draft.doc, draft.title || 'Draft');
    if (!source) return ctx.toast('That draft has no table to use as a list.'), false;
    return setList(ctx, source);
  }
  const file = await reviewApp.openFile({ filters: [{ name: 'Lists', extensions: ['csv', 'tsv', 'txt', 'xlsx', 'xlsm', 'xls', 'ods'] }], as: 'base64' });
  if (!file) return false;
  const params = { path: file.name, data: file.data };
  const r = await call(ctx, 'mailings.recipients', params);
  if (r?.chooseSheet) return !!(await call(ctx, 'mailings.recipients', { ...params, sheet: 1 }));
  if (!r) ctx.toast('That file could not be read as a list.');
  return !!r;
}

/** Asks before an envelope or label merge replaces the document's text (undo brings it back). */
async function replaceOk(ctx, what) {
  const text = (await call(ctx, 'document.text'))?.text ?? '';
  return !text.trim() || reviewApp.confirm({ title: 'Replace the document’s content?',
    description: `Starting ${what} lays the page out again and replaces what the document holds. Undo brings it back.`, confirmText: 'Replace' });
}

const TITLES = { letters: 'Letters', envelopes: 'Envelopes', labels: 'Labels', directory: 'Directory' };
let made = 0; // Word numbers its merge results Letters1, Letters2 for the session

/** Opens the document `r` of mailings.document holds as a new canvas draft titled `title` (and prints it with `print`). */
const openMade = async (ctx, title, r, print = false) => !!r?.model && reviewApp.newDraft(title, r.model, { print, from: ctx.engine });

/** Edit Individual Documents and Print Documents: the merge range, then a new canvas draft with one copy per record; Print also
 * prints it. */
async function finish(ctx, print) {
  const st = await call(ctx, 'mailings.state');
  if (!st?.records) return ctx.toast('No recipient is ticked in the list.'), false;
  const range = await ctx.dialog(print ? 'printDocuments' : 'editIndividualDocuments', { current: st.record ?? 1, count: st.records });
  if (!range) return false;
  const r = await call(ctx, 'mailings.document', { of: 'merge', from: range.from, to: range.to });
  if (!r?.records) return ctx.toast('Every record was skipped, so the merge made nothing.'), false;
  return openMade(ctx, `${TITLES[st.kind] ?? 'Letters'}${++made}`, r, print);
}

/** Check for Errors: simulate (a report as a new draft, or a note that there are none) or complete the merge. */
async function checkErrors(ctx) {
  const how = await ctx.dialog('checkingAndReportingErrors', {});
  if (!how) return false;
  const missing = (await call(ctx, 'mailings.checkErrors'))?.unknownFields ?? [];
  if (how !== 'simulate') {
    if (missing.length && how === 'pause') ctx.toast(`The list has no column named ${missing.map((m) => `"${m}"`).join(', ')}.`);
    return finish(ctx, false);
  }
  if (!missing.length) return ctx.toast('No mail merge errors were found.'), true;
  return openMade(ctx, 'Mail merge errors', await call(ctx, 'mailings.document', { of: 'errors' }));
}

/** Envelopes and Labels: Add to Document puts the envelope in a section of its own before the body (in place of one added
 * before); New Document makes a label sheet as a new canvas draft. */
async function envelopesAndLabels(ctx, tab) {
  const delivery = (await call(ctx, 'document.selection'))?.text ?? '';
  const st = mergeOf(ctx);
  const r = await ctx.dialog('envelopesAndLabels', { tab, delivery, ret: userAddress(ctx), envelope: st?.envelope ?? null, label: st?.label ?? null });
  if (!r) return false;
  if (r.action === 'newDocument') {
    return openMade(ctx, 'Labels', await call(ctx, 'mailings.document', { of: 'labels', label: r.label, text: r.address ?? '',
      ...(r.single && { single: { row: r.row, col: r.col } }) }));
  }
  return !!(await call(ctx, 'mailings.envelopes', { add: true, delivery: r.delivery ?? '', return: r.envelope?.ret?.omit ? '' : r.ret ?? '',
    envelope: r.envelope }));
}

/** Start Mail Merge > Envelopes and Labels: their options, then the page laid out as the envelope or one sheet of labels. */
const startLayout = (kind, dialog, what, extra = () => ({})) => ({
  run: async (ctx) => {
    const value = await ctx.dialog(dialog, { value: mergeOf(ctx)?.[kind === 'envelopes' ? 'envelope' : 'label'] ?? null });
    if (!value || !(await replaceOk(ctx, what))) return false;
    return !!(await call(ctx, 'mailings.start', { kind, [kind === 'envelopes' ? 'envelope' : 'label']: value, ...extra(ctx, value) }));
  },
  active: (ctx) => state(ctx, 'mailings.start')?.value === kind,
  reads: ['mailings.start', 'mailings.state'],
});

/** Address Block and Greeting Line: the dialog builds the field's code from the list and its matched fields; a mapping changed
 * there is kept with the document, in the same undo step as the field. */
const addressField = (id, dialog) => forMerge(async (ctx) => {
  const list = mergeOf(ctx)?.hasList ? await call(ctx, 'mailings.list') : null;
  const r = await ctx.dialog(dialog, list ? dialogList(list) : { source: null, merge: {} });
  if (!r?.code) return false;
  return many(ctx, [...(list && r.map ? [['mailings.matchFields', { map: r.map }]] : []), [id, { code: r.code }]]);
});

/** Inserts one of Rules' fields from its Insert Word Field dialog `dialog`: the list's fields and the document's bookmarks. */
const rule = (dialog) => forMerge(async (ctx) => {
  const bookmarks = (await call(ctx, 'link.targets'))?.bookmarks ?? [];
  const code = await ctx.dialog(dialog, { fields: mergeOf(ctx)?.fields ?? [], bookmarks });
  return code ? !!(await call(ctx, 'insert.field', { instr: code })) : false;
});

const MAILINGS = {
  [`${M}create.envelopes`]: { run: (ctx) => envelopesAndLabels(ctx, 'envelopes'), reads: ['mailings.state'] },
  [`${M}create.labels`]: { run: (ctx) => envelopesAndLabels(ctx, 'labels'), reads: ['mailings.state'] },
  [`${M}startMailMerge.startMailMerge.letters`]: startAs('letters'),
  [`${M}startMailMerge.startMailMerge.envelopes`]: startLayout('envelopes', 'envelopeOptions', 'an envelope merge',
    (ctx, env) => ({ return: env.ret?.omit ? '' : userAddress(ctx) })),
  [`${M}startMailMerge.startMailMerge.labels`]: startLayout('labels', 'labelOptions', 'a label merge'),
  [`${M}startMailMerge.startMailMerge.directory`]: startAs('directory'),
  [`${M}startMailMerge.startMailMerge.normalWordDocument`]: startAs('normal'),
  [`${M}startMailMerge.startMailMerge.stepByStepMailMergeWizard`]: { run: (ctx) => (ctx.pane('mailMerge', true), true) },
  [`${M}startMailMerge.selectRecipients.typeANewList`]: {
    run: async (ctx) => {
      const source = await ctx.dialog('typeANewList', {});
      return source ? setList(ctx, source) : false;
    },
  },
  [`${M}startMailMerge.selectRecipients.useAnExistingList`]: { run: useExisting },
  [`${M}startMailMerge.editRecipientList`]: withList(async (ctx) => {
    const list = await call(ctx, 'mailings.list');
    if (!list) return false;
    const r = await ctx.dialog('mailMergeRecipients', dialogList(list));
    if (!r) return false;
    const fields = r.source?.fields ?? list.fields;
    const rules = (r.filter ?? []).filter((x) => x?.field && x.op && fields.includes(x.field));
    return many(ctx, [
      ...(r.source ? [['mailings.editRecipients', { name: r.source.name, fields, rows: r.source.records }]] : []),
      ['mailings.filterRecipients', { rules, sort: (r.sort ?? []).filter((k) => k?.field && fields.includes(k.field)) }],
      ['mailings.editRecipients', { exclude: r.exclude ?? [] }],
    ]);
  }),
  'keys.mailMergeEditSource': withList(async (ctx) => {
    const list = await call(ctx, 'mailings.list');
    const source = list && (await ctx.dialog('typeANewList', { source: dialogList(list).source }));
    return source ? !!(await call(ctx, 'mailings.editRecipients', { name: source.name, fields: source.fields, rows: source.records })) : false;
  }),
  [`${M}writeInsertFields.highlightMergeFields`]: 'mailings.highlightFields',
  [`${M}writeInsertFields.addressBlock`]: addressField('mailings.addressBlock', 'insertAddressBlock'),
  [`${M}writeInsertFields.greetingLine`]: addressField('mailings.greetingLine', 'insertGreetingLine'),
  [`${M}writeInsertFields.insertMergeField`]: exec('mailings.insertField', (arg) => ({ field: arg }), { state: 'mailings.start', when: merging, active: never, value: never }),
  [`${M}writeInsertFields.matchFields`]: withList(async (ctx) => {
    const m = await call(ctx, 'mailings.matchFields');
    const map = m && (await ctx.dialog('matchFields', { fields: m.fields, map: m.map }));
    return map ? !!(await call(ctx, 'mailings.matchFields', { map })) : false;
  }),
  [`${M}writeInsertFields.updateLabels`]: {
    run: async (ctx) => !!(await call(ctx, 'mailings.updateLabels')),
    enabled: (ctx) => (state(ctx, 'mailings.start')?.value ?? 'labels') === 'labels',
    reason: (ctx) => ((state(ctx, 'mailings.start')?.value ?? 'labels') === 'labels' ? null : R.labelMerge),
    reads: ['mailings.start'],
  },
  [`${M}writeInsertFields.rules.ask`]: rule('insertWordFieldAsk'),
  [`${M}writeInsertFields.rules.fillIn`]: rule('insertWordFieldFillIn'),
  [`${M}writeInsertFields.rules.ifThenElse`]: rule('ifThenElse'),
  [`${M}writeInsertFields.rules.mergeRecord`]: inMerge('mailings.rules', { rule: 'MERGEREC' }),
  [`${M}writeInsertFields.rules.mergeSequence`]: inMerge('insert.field', { instr: 'MERGESEQ', result: '«Merge Sequence #»' }),
  [`${M}writeInsertFields.rules.nextRecord`]: inMerge('mailings.rules', { rule: 'NEXT' }),
  [`${M}writeInsertFields.rules.nextRecordIf`]: rule('nextRecordIf'),
  [`${M}writeInsertFields.rules.setBookmark`]: rule('setBookmark'),
  [`${M}writeInsertFields.rules.skipRecordIf`]: rule('skipRecordIf'),
  [`${M}previewResults.previewResults`]: 'mailings.preview',
  [`${M}previewResults.first`]: stepRecord('mailings.first'),
  [`${M}previewResults.previous`]: stepRecord('mailings.previous'),
  [`${M}previewResults.next`]: stepRecord('mailings.next'),
  [`${M}previewResults.last`]: stepRecord('mailings.last'),
  [`${M}previewResults.record`]: exec('mailings.goToRecord', (arg) => ({ record: arg })),
  // Each Find Next asks the engine for the next match after the record shown (wrapping round), which it then shows.
  [`${M}previewResults.findRecipient`]: withList(async (ctx) => {
    const fields = mergeOf(ctx)?.fields ?? (await call(ctx, 'mailings.state'))?.fields ?? [];
    return ctx.dialog('findEntry', { fields, onFind: async (text, field) => {
      const r = await Promise.resolve(ctx.engine.exec('mailings.findRecipient', { text, ...(field != null && { field }), next: true })).catch(() => null);
      return !!r?.ok;
    } });
  }),
  [`${M}previewResults.checkForErrors`]: withList(checkErrors),
  [`${M}finish.finishMerge.editIndividualDocuments`]: withList((ctx) => finish(ctx, false)),
  [`${M}finish.finishMerge.printDocuments`]: withList((ctx) => finish(ctx, true)),
};

// ---------- backstage, context menu, marks ----------

const BACKSTAGE = {
  // The File pages and the draft commands act on the app; a save flushes the canvas session (actions.js doSave, saveCanvas).
  ...Object.fromEntries(['file.home', 'file.open', 'file.info', 'file.saveAs', 'file.saveAs.saveAsCopy', 'file.export', 'file.close',
    'file.open.dialog', 'window.openDialog', 'file.save', 'frame.qat.save', 'file.new', 'frame.titleBar.documentName'].map((id) => [id, APP])),
  // The Document Inspector reads file.inspectFindings and removes through file.inspect on a canvas draft (backstage/Inspector.jsx).
  'file.info.inspectDocument': APP,
  // Change File Type: the engine's .docx (host save), saved where the user picks. Only .docx is offered on a canvas draft: the
  // Export page's other types (PDF has its own command) read the DOM editor.
  'file.export.changeFileType': {
    run: async (ctx) => {
      const bytes = await ctx.engine.save('docx');
      const name = `${(reviewApp.title() || 'Document').replace(/[\\/:*?"<>|]+/g, ' ').trim()}.docx`;
      return reviewApp.saveFile({ name, data: base64(bytes), filters: [{ name: 'Word Document', extensions: ['docx'] }] });
    },
  },
};

const linkOf = (ctx) => context(ctx)?.link ?? null;
const CONTEXT_MENU = {
  // The menu rows show only where they act, as on the DOM path (no reason off a link or a picture).
  'contextMenu.hyperlink.open': {
    run: (ctx) => !!linkOf(ctx)?.url && reviewApp.openLink(linkOf(ctx).url),
    enabled: (ctx) => !!linkOf(ctx)?.url,
    reason: (ctx) => (linkOf(ctx)?.bookmark != null ? R.bookmarkLink : null),
  },
  'contextMenu.hyperlink.copy': {
    run: (ctx) => !!linkOf(ctx) && reviewApp.copyText(linkOf(ctx).url ?? `#${linkOf(ctx).bookmark}`),
    enabled: (ctx) => !!linkOf(ctx),
  },
  'contextMenu.hyperlink.remove': runWhile('insert.removeLink', {}, (ctx) => !!linkOf(ctx)),
  'contextMenu.picture.saveAsPicture': {
    run: async (ctx) => {
      const r = await ctx.engine.query('picture.data', {});
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' }[r?.value?.mime] ?? 'png';
      return !!r?.ok && reviewApp.saveFile({ name: `Picture.${ext}`, data: r.value.base64, filters: [{ name: 'Picture', extensions: [ext] }] });
    },
    enabled: (ctx) => context(ctx)?.object?.kind === 'picture',
  },
};

const MARKS = {
  // Show All is the per-user setting settings.word.marks.all, pushed to every session as view.marks (tracking/engine.js).
  'home.paragraph.showAll': {
    run: (ctx) => (reviewApp.saveWord({ marks: { all: !ctx.settings?.word?.marks?.all } }), true),
    active: (ctx) => !!ctx.settings?.word?.marks?.all,
  },
};

// ---------- views, status bar, ribbon chrome, options ----------

// The views are the store's (views/state.js): the session's view follows it (tracking/engine.js) and the page area shows it on the
// engine's pages with the room and Reader options it gives the engine (PageArea.jsx, views/canvas.mjs; engine-gaps-views).
const VIEWS = {
  'view.views.printLayout': APP,
  'view.views.readMode': APP,
  'view.views.webLayout': APP,
  'view.views.draft': APP,
  'view.window.split': {
    run: () => (setSplit(splitAt() == null ? 0.5 : null), true),
    enabled: (ctx) => !!ctx.engine && canSplit(ctx.view, reviewApp.move()),
    reason: () => 'Split works in Print Layout, Web Layout, Outline and Draft, with Vertical page movement.',
    label: () => (splitAt() == null ? 'Split' : 'Remove Split'),
  },
  'view.immersive.focus': APP,
  'review.accessibility.checkAccessibility.focus': APP,
  'view.immersive.immersiveReader': APP,
  'immersiveReader.close.closeImmersiveReader': APP,
  ...Object.fromEntries(['columnWidth', 'pageColor', 'lineFocus', 'textSpacing', 'syllables'].map((k) => [`immersiveReader.immersiveReader.${k}`, APP])),
  'view.pageMovement.vertical': APP,
  'view.pageMovement.sideToSide': APP,
  'views.thumbnails': APP,
  'views.closePane': APP,
};

// The status bar's items (shown or hidden, Customize), the ribbon's own chrome and Word Options act on the app only.
const CHROME = Object.fromEntries([
  ...['formattedPageNumber', 'section', 'pageNumber', 'verticalPosition', 'lineNumber', 'column', 'wordCount', 'characterCount', 'proofing',
    'language', 'trackChanges', 'capsLock', 'overtype', 'selectionMode', 'accessibility', 'focus', 'viewShortcuts', 'zoom', 'customize']
    .map((k) => `statusBar.${k}`),
  'frame.qat.touchMouseMode', 'keytips.alt', 'keytips.tooltip', 'panes.nextPane', 'panes.prevPane', 'panes.paneMenu', 'options.customizeRibbon',
  'options.qat', 'file.options', 'options.customizeKeyboard',
].map((id) => [id, APP]));

/** {toolingId: row}. */
export const REVIEW = {
  ...COMMENTS, ...TRACKING, ...MARKUP, ...COMPARE, ...PROTECT, ...PROOFING, ...OUTLINE, ...NAVPANE, ...MAILINGS, ...BACKSTAGE,
  ...CONTEXT_MENU, ...MARKS, ...VIEWS, ...CHROME,
};
