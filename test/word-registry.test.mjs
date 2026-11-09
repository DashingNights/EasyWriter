// The Word registry's merge rules, the format profiles' grants and the Word settings' defaults (docs/plans/word plan.md §1.2,
// §1.3, §1.12, §1.19).
import assert from 'node:assert/strict';
import test from 'node:test';
import { setState } from '../src/app/store.js';
import { grantOptions, grants, NO_PROFILE, profileOf } from '../src/tooling/profile.mjs';
import { REASONS } from '../src/tooling/reasons.mjs';
import { bindServices, commandOf, duplicateList, galleryOf, lastCommand, register, registerModule, run } from '../src/tooling/registry.js';
import { WORD_DEFAULTS, wordPatch, wordSettings } from '../src/document/word/settings.mjs';

const toasts = [];
bindServices({ toast: (t) => toasts.push(t) });
// An open Document: the active surface grants the whole pool (§1.19).
const openDocument = () => setState({ editor: { state: null }, draft: { format: 'document' }, view: { type: 'editor' }, settings: {} });
const ids = (items) => items.map((i) => i.id);

test('a work package command replaces base, and a second package on one key is an error that keeps the first', () => {
  openDocument();
  register('base', { 't.cmd': { run: () => 'base' } });
  register('font', { 't.cmd': { run: () => 'font' } });
  assert.equal(commandOf('t.cmd').run(), 'font');
  const before = duplicateList().length;
  registerModule({ id: 'lists', commands: { 't.cmd': { run: () => 'lists' } } });
  assert.equal(commandOf('t.cmd').run(), 'font');
  assert.deepEqual(duplicateList().slice(before), [{ kind: 'command', key: 't.cmd', owners: ['font', 'lists'] }]);
});

test('a work package gallery replaces base, and several packages concatenate in hub order', () => {
  const all = { profile: { grants: '*' } };
  registerModule({ id: 'base', galleries: { 't.g': () => [{ id: 'b' }] } });
  assert.deepEqual(ids(galleryOf('t.g', all)), ['b']);
  registerModule({ id: 'styles', galleries: { 't.g': () => [{ id: 's' }] } });
  assert.deepEqual(ids(galleryOf('t.g', all)), ['s']);
  registerModule({ id: 'buildingBlocks', galleries: { 't.g': () => [{ id: 'u' }] } });
  assert.deepEqual(ids(galleryOf('t.g', all)), ['s', 'u']);
  assert.deepEqual(galleryOf('t.g', { profile: NO_PROFILE }), [], 'an empty profile filters galleries');
  assert.deepEqual(ids(galleryOf('t.g', { profile: { grants: { commands: ['t'], options: { 't.g': ['u'] } } } })), ['u']);
  assert.deepEqual(galleryOf('t.none', all), []);
});

test("profiles: '*' grants all, an empty profile grants nothing, prefixes grant their children", () => {
  assert.equal(grants({ grants: '*' }, 'home.font.bold'), true);
  assert.equal(grants(NO_PROFILE, 'home.font.bold'), false);
  assert.equal(grants(profileOf({ id: 'x' }), 'home.font.bold'), false, 'a format without a profile grants nothing');
  const p = { grants: { commands: ['home.font', 'view.zoom.zoom100'], options: { list: '*' } } };
  assert.equal(grants(p, 'home.font.bold'), true);
  assert.equal(grants(p, 'home.fontColor'), false);
  assert.equal(grants(p, 'view.zoom.zoom100'), true);
  assert.deepEqual(grantOptions(p, 'list', [['a', 'A']]), [['a', 'A']]);
  assert.deepEqual(grantOptions(p, 'other', [['a', 'A']]), []);
  assert.deepEqual(grantOptions({ grants: { options: { k: ['b'] } } }, 'k', ['a', 'b', { id: 'b' }]), ['b', { id: 'b' }]);
});

test("commands follow the active surface: a forum post grants only its profile's ids, and with no draft nothing is granted", () => {
  register('base', { 't.forum': { run: () => true } });
  openDocument();
  assert.ok(commandOf('t.forum'));
  setState({ draft: { format: 'forum-post' } });
  assert.equal(commandOf('t.forum'), null);
  assert.equal(run('t.forum'), false);
  setState({ editor: null, draft: null });
  assert.equal(commandOf('t.forum'), null);
});

test('run: unregistered toasts the pending reason, disabled declines, repeatable records lastCommand', () => {
  openDocument();
  toasts.length = 0;
  assert.equal(run('t.missing'), false);
  assert.deepEqual(toasts, [REASONS.pending]);
  register('base', { 't.off': { run: () => true, enabled: () => false }, 't.again': { run: (_ctx, arg) => arg, repeatable: true } });
  assert.equal(run('t.off'), false);
  assert.equal(run('t.again', 7), 7);
  assert.deepEqual(lastCommand(), { id: 't.again', arg: 7 });
});

test('Word settings: defaults deep-merge under settings.word, and saveWord patches only its keys', () => {
  assert.equal(wordSettings(null), WORD_DEFAULTS);
  const s = { word: { marks: { tabs: true }, proofing: { languages: ['en-GB'] }, units: 'cm' } };
  const w = wordSettings(s);
  assert.equal(w.marks.tabs, true);
  assert.equal(w.marks.anchors, true, 'a key the user never set keeps its default');
  assert.deepEqual(w.proofing.languages, ['en-GB'], 'arrays replace');
  assert.equal(w.proofing.asYouType, true);
  assert.equal(w.units, 'cm');
  assert.equal(w.tracking.ins.mark, 'underline');
  assert.equal(wordSettings(s), w, 'memoised per settings object');
  assert.deepEqual(wordPatch({ paneWidths: { a: 1 }, ruler: true }, { paneWidths: { b: 2 }, ruler: false }), { paneWidths: { a: 1, b: 2 }, ruler: false });
});
