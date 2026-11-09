// The Options dialog's pages (docs/plans/word/briefs/options.md Acceptance): rows save to real keys, labels and ids are unique,
// the edit buffer becomes one saveWord patch one level deep, the units pick and the reader marks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DOC_SETTINGS } from '../src/document/defaults.mjs';
import { WORD_DEFAULTS } from '../src/document/word/settings.mjs';
import { allRows, getPath, initialOf, keyOf, PAGES, pageOf, patchesOf, UNIT_OPTIONS, unitIn, unitOut, unbuiltRows } from '../src/document/wp/options/pages.mjs';

const plain = (label) => label.replace(/&/g, '');

test('every saving row has a key in WORD_DEFAULTS, or is an app, document or store row', () => {
  for (const r of allRows().filter((r) => r.path)) {
    const store = r.store ?? 'word';
    if (store === 'word') assert.notEqual(getPath(WORD_DEFAULTS, r.path), undefined, r.path);
    else if (store === 'doc') assert.notEqual(getPath(DOC_SETTINGS, r.path), undefined, r.path);
    else assert.ok(['app', 'state'].includes(store), r.path);
  }
});

test('labels are unique per page, section ids unique, and no label names Office, Word or Microsoft', () => {
  const sections = PAGES.flatMap((p) => p.sections.map((s) => s.id));
  assert.equal(new Set(sections).size, sections.length);
  for (const p of PAGES) {
    const labels = p.sections.flatMap((s) => s.rows.map((r) => r.label).filter(Boolean)).map(plain);
    assert.equal(new Set(labels).size, labels.length, p.id);
  }
  const words = PAGES.flatMap((p) => [p.label, p.title, ...p.sections.flatMap((s) => [s.title, ...s.rows.flatMap((r) => [r.label, r.text, ...(r.options ?? []).map((o) => o[1])])])]);
  for (const w of words.filter(Boolean)) assert.doesNotMatch(plain(w), /\b(Office|Word|Microsoft)\b/, w);
  assert.deepEqual(PAGES.map((p) => p.id), ['general', 'display', 'proofing', 'save', 'language', 'accessibility', 'advanced']);
});

test('the edit buffer becomes one saveWord patch one level deep, without untouched or unchanged keys', () => {
  const initial = initialOf({ word: WORD_DEFAULTS, app: { uiTheme: 'dark' }, doc: DOC_SETTINGS, state: { overtype: false } });
  const edits = {
    'word:editing.typingReplaces': false, 'word:fieldShading': 'always', 'word:units': 'mm', 'word:marks.tabs': true, 'word:marks.spaces': true,
    'word:paste.button': true, // unchanged: left out
    'app:uiTheme': 'light', 'doc:compat.htmlAutoSpacing': false, 'state:overtype': true,
  };
  const p = patchesOf(edits, initial);
  assert.deepEqual(p.word, { editing: { typingReplaces: false }, fieldShading: 'always', units: 'mm', marks: { tabs: true, spaces: true } });
  assert.deepEqual(p.app, { uiTheme: 'light' });
  assert.deepEqual(p.doc, { compat: { htmlAutoSpacing: false } });
  assert.deepEqual(p.state, { overtype: true });
  assert.deepEqual(patchesOf({}, initial), { word: null, app: null, doc: null, state: null });
  for (const v of Object.values(p.word)) if (v && typeof v === 'object') for (const x of Object.values(v)) assert.ok(typeof x !== 'object' || x === null);
});

test('the units pick maps to in, cm, mm, pt, pi and null', () => {
  assert.deepEqual(UNIT_OPTIONS.map(([v]) => unitOut(v)), [null, 'in', 'cm', 'mm', 'pt', 'pi']);
  assert.equal(unitIn(null), 'auto');
  const row = allRows().find((r) => r.path === 'units');
  assert.equal(row.out('mm'), 'mm');
  assert.equal(keyOf(row), 'word:units');
});

test('the reader map flags rows whose reader is not registered', () => {
  const rows = allRows();
  const typing = rows.find((r) => r.path === 'editing.typingReplaces');
  assert.ok(unbuiltRows(rows, []).includes(typing));
  assert.ok(!unbuiltRows(rows, ['editing.typingReplaces']).some((r) => r.path === 'editing.typingReplaces'));
  // stored only for good, and the app's own theme never
  assert.ok(unbuiltRows(rows, rows.map((r) => r.reader)).every((r) => r.reader === null));
  assert.ok(!unbuiltRows(rows, []).some((r) => r.path === 'uiTheme'));
});

test('pageOf takes tab or page and falls back to General', () => {
  assert.equal(pageOf({ tab: 'advanced' }), 'advanced');
  assert.equal(pageOf({ page: 'proofing' }), 'proofing');
  assert.equal(pageOf({ tab: 'addIns' }), 'general');
  assert.equal(pageOf({ tab: 'qat' }, ['general', 'qat']), 'qat');
});
