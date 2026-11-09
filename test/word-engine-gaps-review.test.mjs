// engine-gaps-review (docs/plans/engine/stage2b.md): the Review rows it builds are no gap rows any more, the folds and the
// Viewing mode reach the engine's commands, and the inspector's engine findings read as the DOM ones do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import { REVIEW, reviewApp } from '../src/document/canvas/rows/review.mjs';
import { describe, ENGINE_REMOVE, engineFindings, foundIn } from '../src/document/wp/backstage/inspect.mjs';

const BUILT = ['view.show.navigationPane', 'review.accessibility.checkAccessibility.navigationPane', 'navPane.expandHeading', 'navPane.collapseHeading',
  'navPane.toggleHeading', 'navPane.collapsibleHeadings', 'review.markup.showMarkup.balloons.showRevisionsInBalloons',
  'review.markup.showMarkup.balloons.showOnlyFormattingInBalloons', 'review.markup.showMarkup.specificPeople.allReviewers',
  'review.markup.showMarkup.specificPeople', 'review.accessibility.checkAccessibility', 'review.accessibility.checkAccessibility.checkAccessibility',
  'review.language.language', 'review.language.language.setProofingLanguage', 'review.protect.restrictEditing', 'file.info.protectDocument',
  'frame.tabRow.editingMode.viewing', 'file.info.inspectDocument'];

test('the rows the package builds are no gap rows', () => {
  for (const id of BUILT) assert.notEqual(formOf(REVIEW[id]), 'off', id);
  for (const id of BUILT) assert.ok(formOf(REVIEW[id]), id);
});

test('the heading rows run heading.collapse with their op', async () => {
  const calls = [];
  const ctx = { engine: { exec: async (id, args) => (calls.push([id, args]), { ok: true }) } };
  await REVIEW['navPane.collapseHeading'].run(ctx);
  await REVIEW['navPane.collapsibleHeadings'].run(ctx, 'expandAll');
  await REVIEW['navPane.collapsibleHeadings'].run(ctx);
  assert.deepEqual(calls, [['heading.collapse', { op: 'collapse' }], ['heading.collapse', { op: 'expandAll' }], ['heading.collapse', { op: 'toggle' }]]);
});

test('Viewing sets the store mode and shows pressed while it holds', () => {
  let mode = 'editing';
  const saved = { setMode: reviewApp.setMode, mode: reviewApp.mode };
  Object.assign(reviewApp, { setMode: (m) => (mode = m), mode: () => mode });
  try {
    const row = REVIEW['frame.tabRow.editingMode.viewing'];
    assert.equal(row.active({ engineState: {} }), false);
    row.run({});
    assert.equal(mode, 'viewing');
    assert.equal(row.active({ engineState: {} }), true);
  } finally {
    Object.assign(reviewApp, saved);
  }
});

test('the engine\'s inspector findings read as the DOM ones', () => {
  const f = engineFindings({ comments: 2, revisions: 1, properties: true, collapsed: 1, headers: 0, hiddenCount: 3 });
  assert.ok(foundIn(f, 'comments') && foundIn(f, 'props') && foundIn(f, 'collapsed') && foundIn(f, 'hidden'));
  assert.ok(!foundIn(f, 'headers') && !foundIn(f, 'invisible'));
  assert.match(describe(f, 'collapsed'), /1 collapsed heading/);
  assert.equal(engineFindings(null), null);
  assert.deepEqual(ENGINE_REMOVE.comments, ['comments', 'revisions']);
});
