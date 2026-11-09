// engine-cmd-review (docs/plans/engine/stage2.md S5 Review): every command of the Review group's owners has a row on a canvas
// draft, each gap row's reason is plain UI copy, and the composite rows act through the session and the app's side
// (rows/review.mjs reviewApp): the none-left guards read the engine's state values, the comment rows act on the active card, and
// Change File Type saves the engine's .docx. A fake session stands in for the SessionClient, as in the scaffold's test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setState } from '../src/app/store.js';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import { bindReviewApp, levelLabel, REVIEW } from '../src/document/canvas/rows/review.mjs';
import { commandOf, ctxOf, registerModule, run } from '../src/tooling/registry.js';

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

// The ids engine-coverage found on the generic reason for this package's owners (out/engine-coverage/report.json at the
// scaffold), plus base's four File rows and Print's three session rows (commands.mjs sessionRows covers those).
const OWNED = {
  comments: 'insert.comments.comment review.comments.newComment review.comments.delete review.comments.delete.delete review.comments.delete.deleteAllCommentsShown review.comments.delete.deleteAllCommentsInDocument review.comments.delete.deleteAllResolvedComments review.comments.previous review.comments.next review.comments.showComments review.comments.showComments.contextual review.comments.showComments.list frame.tabRow.comments review.markup.filterAllMarkup.resetAllFilters review.markup.filterAllMarkup.activeOnly review.markup.filterAllMarkup.resolvedOnly comments.jumpToCard comments.resolve comments.cards x.reveal.comment',
  tracking: 'review.tracking.accept review.tracking.accept.acceptThisChange review.tracking.accept.acceptAllChanges review.tracking.reject review.tracking.reject.rejectChange review.tracking.reject.rejectAllChanges review.tracking.previous review.tracking.next review.tracking.trackChanges review.tracking.trackChanges.forEveryone review.tracking.trackChanges.lockTracking review.tracking.accept.acceptAndMoveToNext review.tracking.accept.acceptAllChangesShown review.tracking.accept.acceptAllChangesAndStopTracking review.tracking.reject.rejectAndMoveToNext review.tracking.reject.rejectAllChangesShown review.tracking.reject.rejectAllChangesAndStopTracking review.markup.displayForReview review.markup.displayForReview.simpleMarkup review.markup.displayForReview.allMarkup review.markup.displayForReview.noMarkup review.markup.displayForReview.original frame.tabRow.editingMode frame.tabRow.editingMode.editing frame.tabRow.editingMode.reviewing frame.tabRow.editingMode.viewing tracking.userName tracking.authorColors',
  markup: 'review.markup.showMarkup.insertionsAndDeletions review.markup.showMarkup.formatting review.markup.showMarkup.balloons.showRevisionsInBalloons review.markup.showMarkup.balloons.showAllRevisionsInline review.markup.showMarkup.balloons.showOnlyFormattingInBalloons review.markup.showMarkup.specificPeople.allReviewers review.markup.showMarkup.specificPeople review.markup.reviewingPane review.markup.reviewingPane.reviewingPaneVertical review.markup.reviewingPane.reviewingPaneHorizontal review.markup.launcher print.markup',
  compare: 'review.compare.compare.compare review.compare.compare.combine review.compare.compare.showSourceDocuments file.info.versionHistory',
  protect: 'review.protect.restrictEditing file.info.protectDocument',
  proofing: 'review.proofing.spellingAndGrammar review.proofing.spellingAndGrammar.spelling proofing.nextMisspelling proofing.ignore review.proofing.wordCount wordCount.recount review.speech.readAloud review.accessibility.checkAccessibility review.accessibility.checkAccessibility.checkAccessibility review.accessibility.checkAccessibility.optionsAccessibility review.language.language review.language.language.setProofingLanguage review.language.language.languagePreferences',
  outline: 'view.views.outline outlining.close.closeOutlineView outlining.outlineTools.promoteToHeading1 outlining.outlineTools.promote outlining.outlineTools.demote outlining.outlineTools.demoteToBodyText outlining.outlineTools.outlineLevel outlining.outlineTools.moveUp outlining.outlineTools.moveDown outlining.outlineTools.expand outlining.outlineTools.collapse outlining.outlineTools.showLevel outlining.outlineTools.showTextFormatting outlining.outlineTools.showFirstLineOnly outline.promote outline.demote outline.moveUp outline.moveDown outline.firstLine outline.showAllHeadings outline.showHeading1 outline.showHeading2 outline.showHeading3 outline.showHeading4 outline.showHeading5 outline.showHeading6 outline.showHeading7 outline.showHeading8 outline.showHeading9',
  navpane: 'view.show.navigationPane review.accessibility.checkAccessibility.navigationPane navPane.expandHeading navPane.collapseHeading navPane.toggleHeading navPane.collapsibleHeadings paragraph.collapsedByDefault',
  mailings: 'mailings.create.envelopes mailings.create.labels mailings.startMailMerge.startMailMerge.letters mailings.startMailMerge.startMailMerge.envelopes mailings.startMailMerge.startMailMerge.labels mailings.startMailMerge.startMailMerge.directory mailings.startMailMerge.startMailMerge.normalWordDocument mailings.startMailMerge.startMailMerge.stepByStepMailMergeWizard mailings.startMailMerge.selectRecipients.typeANewList mailings.startMailMerge.selectRecipients.useAnExistingList mailings.startMailMerge.editRecipientList keys.mailMergeEditSource mailings.writeInsertFields.highlightMergeFields mailings.writeInsertFields.addressBlock mailings.writeInsertFields.greetingLine mailings.writeInsertFields.insertMergeField mailings.writeInsertFields.matchFields mailings.writeInsertFields.updateLabels mailings.writeInsertFields.rules.ask mailings.writeInsertFields.rules.fillIn mailings.writeInsertFields.rules.ifThenElse mailings.writeInsertFields.rules.mergeRecord mailings.writeInsertFields.rules.mergeSequence mailings.writeInsertFields.rules.nextRecord mailings.writeInsertFields.rules.nextRecordIf mailings.writeInsertFields.rules.setBookmark mailings.writeInsertFields.rules.skipRecordIf mailings.previewResults.previewResults mailings.previewResults.first mailings.previewResults.previous mailings.previewResults.next mailings.previewResults.last mailings.previewResults.record mailings.previewResults.findRecipient mailings.previewResults.checkForErrors mailings.finish.finishMerge.editIndividualDocuments mailings.finish.finishMerge.printDocuments',
  backstage: 'file.home file.open file.info file.saveAs file.saveAs.saveAsCopy file.export file.info.inspectDocument file.close file.open.dialog window.openDialog file.export.changeFileType',
  'context-menu': 'contextMenu.hyperlink.open contextMenu.hyperlink.copy contextMenu.hyperlink.remove contextMenu.picture.saveAsPicture',
  marks: 'home.paragraph.showAll',
  views: 'view.views.printLayout view.views.readMode view.views.webLayout view.views.draft view.immersive.focus review.accessibility.checkAccessibility.focus view.immersive.immersiveReader immersiveReader.close.closeImmersiveReader immersiveReader.immersiveReader.columnWidth immersiveReader.immersiveReader.pageColor immersiveReader.immersiveReader.lineFocus immersiveReader.immersiveReader.textSpacing immersiveReader.immersiveReader.syllables view.pageMovement.vertical view.pageMovement.sideToSide views.thumbnails views.closePane',
  statusbar: 'statusBar.formattedPageNumber statusBar.section statusBar.pageNumber statusBar.verticalPosition statusBar.lineNumber statusBar.column statusBar.wordCount statusBar.characterCount statusBar.proofing statusBar.language statusBar.trackChanges statusBar.capsLock statusBar.overtype statusBar.selectionMode statusBar.accessibility statusBar.focus statusBar.viewShortcuts statusBar.zoom statusBar.customize',
  'ribbon-chrome': 'frame.qat.touchMouseMode keytips.alt keytips.tooltip panes.nextPane panes.prevPane panes.paneMenu options.customizeRibbon options.qat',
  options: 'file.options options.customizeKeyboard',
  base: 'frame.qat.save file.save file.new frame.titleBar.documentName',
};

test('every command of the Review owners has a row, and each gap row says why in plain words', () => {
  const missing = Object.entries(OWNED).flatMap(([owner, ids]) => ids.split(' ').filter((id) => !REVIEW[id]).map((id) => `${owner}: ${id}`));
  assert.deepEqual(missing, []);
  for (const [id, row] of Object.entries(REVIEW)) {
    assert.ok(formOf(row), `${id} is a row form`);
    if (formOf(row) !== 'off') continue;
    assert.match(row.off, /^[A-Z].*\.$/, `${id}: a sentence`);
    assert.doesNotMatch(row.off, /[—–]|: /, `${id}: no dash, no colon pivot`);
    assert.notEqual(row.off, 'Not built for the canvas engine yet.', `${id}: its own reason`);
  }
  // The rows Review must not map: the Spelling pane and Read Aloud use the app's checker and speech (stage2.md S5).
  for (const id of ['review.spelling', 'review.issues', 'review.suggestions', 'review.ignoreAll', 'review.addToDictionary', 'review.readAloud']) {
    assert.ok(!Object.values(REVIEW).some((r) => r === id || r?.exec === id), `${id} is not mapped`);
  }
  assert.deepEqual([1, 9, 10, null].map(levelLabel), ['Level 1', 'Level 9', 'Body Text', '']);
});

function fakeSession() {
  const calls = [];
  const handlers = {};
  const states = {};
  const answers = {};
  return {
    calls,
    states,
    answers,
    exec: async (id, args) => (calls.push(['exec', id, args]), { ok: true, changed: true, value: answers[`exec ${id}`] ?? null }),
    execMany: async (steps) => (calls.push(['execMany', steps]), { ok: true, changed: true }),
    query: async (id, args) => (calls.push(['query', id, args]), { ok: true, value: answers[id] ?? null }),
    state: async (ids) => (calls.push(['state', ids]), Object.fromEntries(ids.map((id) => [id, states[id] ?? { enabled: true, reason: null, checked: false, value: null }]))),
    save: async (kind) => (calls.push(['save', kind]), new Uint8Array([80, 75])),
    on: (event, fn) => ((handlers[event] ??= new Set()).add(fn), () => handlers[event].delete(fn)),
    emit: (event) => handlers[event]?.forEach((fn) => fn({})),
  };
}

const entry = (value, checked = null) => ({ enabled: true, reason: null, checked, value });
registerModule({ id: 'canvas-engine', engine: REVIEW }, ['document']);
registerModule({ id: 'outline', commands: { 'view.views.outline': { run: () => 'store view' } } }, ['document']);

test('the Review rows act through the session and the app side on a canvas draft', async () => {
  const s = fakeSession();
  const app = { active: null, edits: [], saved: [], mode: 'editing' };
  bindReviewApp({
    activeComment: () => app.active,
    editComment: (id, mode, isNew) => (app.edits.push([id, mode, isNew]), true),
    saveFile: async (f) => (app.saved.push(f), 'C:/out.docx'),
    title: () => 'Report: final?',
    mode: () => app.mode,
    setMode: (m) => (app.mode = m),
  });
  setState({ editor: null, draft: { format: 'document' }, view: { type: 'editor' }, settings: {}, focusedSession: s, word: { view: 'print' } });
  await settle();
  const ctx = () => ctxOf();
  const read = (id) => commandOf(id).enabled(ctx()); // reading registers the state ids the rows watch
  const reread = async () => {
    for (const id of ['review.tracking.accept.acceptThisChange', 'review.tracking.accept.acceptAllChanges', 'outlining.outlineTools.expand',
      'mailings.previewResults.next', 'review.comments.next']) read(id);
    await settle();
  };
  const layout = async () => {
    s.emit('layout');
    await new Promise((r) => setTimeout(r, 150)); // ctx.read reads again once typing pauses
    await settle();
  };

  // None left: Accept All and the comment rows are off without a reason (tool search leaves them out, as on the DOM path); the
  // rows that act at the selection or in a mode say why.
  s.answers['review.counts'] = { changes: false, comments: 0 };
  Object.assign(s.states, { 'mailings.preview': entry(null, false) });
  await reread();
  s.emit('selection');
  await settle();
  await reread();
  assert.equal(read('review.tracking.accept.acceptThisChange'), false, 'no change at the caret');
  assert.equal(read('review.tracking.accept.acceptAllChanges'), false);
  assert.equal(commandOf('review.tracking.accept.acceptAllChanges').reason?.(ctx()) ?? null, null);
  assert.equal(read('review.comments.next'), false);
  assert.equal(commandOf('mailings.previewResults.next').reason(ctx()), 'Turn on Preview Results first.');
  assert.equal(commandOf('outlining.outlineTools.expand').reason(ctx()), 'Works in Outline view.');
  s.answers['review.counts'] = { changes: true, comments: 4 };
  Object.assign(s.states, { 'document.context': entry({ revision: 'insert', comments: [] }), 'mailings.preview': entry(null, true) });
  await layout();
  s.emit('selection');
  await settle();
  assert.equal(read('review.tracking.accept.acceptThisChange'), true);
  assert.equal(read('review.tracking.accept.acceptAllChanges'), true);
  assert.equal(read('review.comments.next'), true);
  assert.equal(read('mailings.previewResults.next'), true);

  // The commands' engine calls.
  s.calls.length = 0;
  await run('review.tracking.accept');
  await run('review.tracking.reject.rejectAllChangesAndStopTracking');
  await run('outlining.outlineTools.outlineLevel', 'bodyText');
  await run('outlining.outlineTools.outlineLevel', 'level3');
  await run('mailings.previewResults.record', 4);
  await run('paragraph.collapsedByDefault');
  const execs = s.calls.filter((c) => c[0] === 'exec').map((c) => c.slice(1));
  assert.deepEqual(execs, [['review.accept', { next: true }], ['review.rejectAll', { stopTracking: true }], ['outline.level', { level: 'body' }],
    ['outline.level', { level: 3 }], ['mailings.goToRecord', { record: 4 }], ['outline.collapsedByDefault', {}]]);

  // Reviewing turns Track Changes on and leaves Viewing; New Comment opens its card in edit mode.
  app.mode = 'viewing';
  s.calls.length = 0;
  await run('frame.tabRow.editingMode.reviewing');
  assert.deepEqual(s.calls.find((c) => c[0] === 'exec').slice(1), ['review.trackChanges', { value: true }]);
  assert.equal(app.mode, 'reviewing');
  s.states['review.trackChanges'] = entry(null, true);
  s.emit('selection');
  await settle();
  assert.equal(commandOf('frame.tabRow.editingMode').value(ctx()), 'frame.tabRow.editingMode.reviewing');
  assert.equal(commandOf('review.tracking.trackChanges').active(ctx()), true);
  s.answers['exec review.newComment'] = { id: 7, story: 2 };
  await run('review.comments.newComment');
  assert.deepEqual(app.edits.at(-1), [7, 'edit', true]);

  // The comment rows act on the active card, else the one at the selection; Delete All Resolved is one undo step.
  app.active = 7;
  s.calls.length = 0;
  await run('comments.resolve');
  assert.deepEqual(s.calls.find((c) => c[0] === 'exec').slice(1), ['review.resolveComment', { id: 7, value: true }]);
  s.answers['review.comments'] = [{ id: 1, parent: null, resolved: true }, { id: 2, parent: 1, resolved: false }, { id: 3, parent: null, resolved: false },
    { id: 4, parent: null, resolved: true }];
  await run('review.comments.delete.deleteAllResolvedComments');
  assert.deepEqual(s.calls.find((c) => c[0] === 'execMany')[1], [['review.deleteComment', { id: 1 }], ['review.deleteComment', { id: 4 }]]);

  // Change File Type: the engine's .docx, named after the draft without the characters a file name cannot hold.
  await run('file.export.changeFileType');
  assert.ok(s.calls.some((c) => c[0] === 'save' && c[1] === 'docx'));
  assert.equal(app.saved.at(-1).name, 'Report  final.docx');
  assert.equal(app.saved.at(-1).data, 'UEs=');

  // Accept All Changes Shown runs while Track Changes Options hides a kind (the engine's `shown`); Word Count's recount follows
  // Options > Proofing's count setting.
  assert.equal(read('review.tracking.accept.acceptAllChangesShown'), false, 'every kind shown');
  setState({ settings: { word: { tracking: { show: { formatting: false } }, proofing: { countNotes: false } } } });
  await settle();
  assert.equal(read('review.tracking.accept.acceptAllChangesShown'), true);
  s.calls.length = 0;
  s.answers['review.wordCount'] = { words: 3 };
  await run('review.tracking.accept.acceptAllChangesShown');
  await run('wordCount.recount');
  assert.deepEqual(s.calls.filter((c) => c[0] === 'exec' || (c[0] === 'query' && c[1] === 'review.wordCount')).map((c) => c.slice(1)),
    [['review.acceptAll', { shown: true }], ['review.wordCount', { includeTextBoxes: false }]]);

  // An APP row runs the registered command. (A gap row with its own reason was checked here until engine-gaps-review and
  // engine-gaps-mailings built the last ones in these tables.)
  assert.equal(commandOf('view.views.outline').run(), 'store view');
});
