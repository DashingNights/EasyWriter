import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, leave, resumeAt, scalePercent, stepLabel } from '../src/app/setup/flow.mjs';

// pages.jsx's order: the GitHub sub-pages are one step, the warning a branch; an integration page before finish.
const LIST = [
  { id: 'welcome', step: 'welcome' }, { id: 'scale', step: 'scale' }, { id: 'github', step: 'github' },
  { id: 'github-warn', step: 'github', branch: true }, { id: 'github-account', step: 'github' }, { id: 'github-pick', step: 'github' },
  { id: 'forum.threads', step: 'forum.threads' }, { id: 'finish', step: 'finish' },
];

test('setup flow: order, branches, leaving a step, resume and the step label', () => {
  assert.equal(after(LIST, 'welcome'), 'scale');
  assert.equal(after(LIST, 'github'), 'github-account'); // the warning only by name
  assert.equal(after(LIST, 'github-warn'), 'github-account');
  assert.equal(after(LIST, 'finish'), null);
  assert.equal(before(LIST, 'github-account'), 'github');
  assert.equal(before(LIST, 'welcome'), null);
  assert.equal(leave(LIST, 'github-warn'), 'forum.threads'); // Skip backup
  assert.equal(leave(LIST, 'github-account'), 'forum.threads');
  assert.equal(resumeAt(LIST, 'github-pick'), 'github-pick');
  assert.equal(resumeAt(LIST, 'helpers'), 'welcome');
  assert.equal(resumeAt(LIST, undefined), 'welcome');
  assert.equal(stepLabel(LIST, 'welcome'), 'Step 1 of 5');
  assert.equal(stepLabel(LIST, 'github-pick'), 'Step 3 of 5');
  assert.equal(stepLabel(LIST, 'finish'), 'Step 5 of 5');
  assert.deepEqual([-3, 0, 0.5, 5].map(scalePercent), [58, 100, 110, 249]);
});

test('the tool call limit is off by default; a stored true turns it on', () => {
  const { ADVANCED, advanced } = createRequire(import.meta.url)('../src/assistant/advanced.js');
  assert.equal(ADVANCED.limitCalls, false);
  assert.equal(advanced({ advanced: { limitCalls: true } }).limitCalls, true);
});
