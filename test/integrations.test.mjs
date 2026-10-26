import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { byId } from '../src/app/commands/catalogue.mjs';
import { agentNotes, bare, checkIntegrations, DEFAULTS, enabled, listed, migrateSettings, situationNotes, wakes } from '../src/integrations/index.mjs';

const SITE = 'https://forum.example.com';
const TOPIC = 'https://forum.example.com/topic/1-a/';
const PROJECT = 'project:0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55';
// main.js getSettings: defaults, then the stored file through the migration (a missing file is not migrated).
const read = (stored) => ({ ...DEFAULTS, ...(stored ? migrateSettings(stored) : {}) });
const on = (stored) => enabled(read(stored), 'forum');

test('migrate: a profile from before integrations gets the forum on only when it has forum data', () => {
  assert.equal(on({ forumUrl: SITE, threads: [] }), true);
  assert.equal(on({ threads: [{ url: PROJECT, title: 'P', thread: TOPIC }] }), true);
  assert.equal(read({ threads: [{ url: PROJECT, title: 'P', thread: TOPIC }] }).forumUrl, SITE);
  assert.equal(on({ threads: [{ url: TOPIC, title: 'A' }] }), true); // a legacy topic-URL key
  assert.equal(on({ threads: [{ url: PROJECT, title: 'P' }] }), false);
  assert.equal(on({ integrations: { forum: { enabled: false } }, forumUrl: SITE, threads: [{ url: TOPIC, title: 'A' }] }), false);
  assert.equal(on(null), false);
});

test('migrate: threads and other integrations stay as they are', () => {
  const threads = [{ url: PROJECT, title: 'P', thread: TOPIC, subject: '', year: '', forum: '' }, { url: TOPIC, title: 'A' }];
  assert.deepEqual(migrateSettings({ threads: structuredClone(threads) }).threads, threads);
  assert.deepEqual(migrateSettings({ threads: [], integrations: { other: { enabled: true } } }).integrations.other, { enabled: true });
});

test('migrate: threads with no forum site get the site of the first one; a set site stays', () => {
  const threads = [{ url: PROJECT, title: 'P' }, { url: TOPIC, title: 'A' }];
  assert.equal(migrateSettings({ threads }).forumUrl, SITE);
  assert.equal(migrateSettings({ threads: [] }).forumUrl, undefined);
  assert.equal(migrateSettings({ threads, forumUrl: 'https://other.example.org' }).forumUrl, 'https://other.example.org');
});

test('checkIntegrations takes known ids with a boolean enabled only', () => {
  checkIntegrations({ forum: { enabled: false } });
  assert.throws(() => checkIntegrations({ forum: { enabled: 'yes' } }));
  assert.throws(() => checkIntegrations({ other: { enabled: true } }));
  assert.throws(() => checkIntegrations(null));
});

test('migrate: the page width starts at a stored forum width; a set page width or none stays', () => {
  const s = migrateSettings({ forumWidth: 1200, threads: [] });
  assert.equal(s.pageWidth, 1200);
  assert.equal(s.forumWidth, 1200);
  assert.equal(migrateSettings({ pageWidth: 900, forumWidth: 1200, threads: [] }).pageWidth, 900);
  assert.equal(Object.hasOwn(migrateSettings({ threads: [] }), 'pageWidth'), false);
});

const ON = { integrations: { forum: { enabled: true } } };
const OFF = { integrations: { forum: { enabled: false } } };

test('situationNotes: the forum clause for a draft whose project links a topic, only while the forum is on', () => {
  const threads = [{ url: PROJECT, title: 'P', thread: TOPIC }];
  assert.equal(situationNotes({ threadUrl: PROJECT }, { ...ON, threads }), ', linked to a forum thread');
  assert.equal(situationNotes({ threadUrl: PROJECT }, { ...OFF, threads }), '');
  assert.equal(situationNotes({ threadUrl: PROJECT }, { ...ON, threads: [{ url: PROJECT, title: 'P' }] }), '');
});

test('listed: a forum command only while the forum is on', () => {
  const def = byId('push.prepare');
  assert.equal(listed(def, OFF), null);
  assert.equal(listed(def, ON), def);
});

test('forum services need format.post: push.prepare, export.preview, and the push and push-wake tool entries', () => {
  for (const id of ['push.prepare', 'export.preview']) assert.ok(byId(id).needs.some((n) => (n.gate ?? n) === 'format.post'), id);
  // ui.jsx is JSX (not loadable here): read its TOOLS entries as text.
  const ui = readFileSync('src/integrations/forum/ui.jsx', 'utf8');
  for (const id of ['push', 'push-wake']) {
    const entry = ui.slice(ui.indexOf(`{ id: '${id}',`)).split('keywords:')[0];
    assert.match(entry, /needs: \[[^\]]*FORMAT_POST/, id);
  }
});

test('listed: forum arguments only while the forum is on', () => {
  const add = byId('threads.add');
  const patch = byId('settings.patch');
  assert.equal(Object.hasOwn(listed(add, OFF).args.properties, 'thread'), false);
  assert.equal(Object.hasOwn(listed(patch, OFF).args.properties.patch.properties, 'forumWidth'), false);
  assert.ok(Object.hasOwn(add.args.properties, 'thread')); // the catalogue keeps it
  assert.equal(listed(add, ON), add);
  assert.equal(listed(patch, ON), patch);
});

test('bare: the keys of an off integration are left out of results; on, all stay', () => {
  const s = { ...OFF, forumUrl: SITE, forumWidth: 1200, theme: 'light', threads: [{ url: PROJECT, title: 'P', thread: TOPIC, subject: 's', year: 'y', forum: 'f' }] };
  assert.deepEqual(bare('settings', s, s), { integrations: {}, theme: 'light', threads: [{ url: PROJECT, title: 'P' }] });
  assert.deepEqual(bare('draft', { id: 'd', pushedAt: 5 }, OFF), { id: 'd' });
  const on = { ...s, ...ON };
  assert.deepEqual(bare('settings', on, on), on);
  assert.deepEqual(bare('draft', { id: 'd', pushedAt: 5 }, ON), { id: 'd', pushedAt: 5 });
});

test("wakes: with the forum off, only the open forum draft's row keeps the forum's draft controls (plan step 9)", () => {
  const threads = [{ url: PROJECT, title: 'P', thread: TOPIC }, { url: 'project:2', title: 'Q' }];
  const draft = { id: 'a', threadUrl: PROJECT };
  const off = { settings: { ...OFF, threads }, draft };
  assert.equal(wakes('forum', 'DraftRowActions', { d: draft }, off), true);
  assert.equal(wakes('forum', 'DraftRowBadge', { d: draft }, off), true);
  assert.equal(wakes('forum', 'DraftMenuItems', { d: draft }, off), true); // the sidebar menu's Push to forum (sidebar-menu.md step 2)
  assert.equal(wakes('forum', 'DraftMenuItems', { d: { id: 'b', threadUrl: PROJECT } }, off), false);
  assert.equal(wakes('forum', 'DraftRowActions', { d: { id: 'b', threadUrl: PROJECT } }, off), false); // not the open draft
  assert.equal(wakes('forum', 'ProjectRowActions', { t: threads[0] }, off), false);
  assert.equal(wakes('forum', 'StatusBarItem', {}, off), false);
  assert.equal(wakes('forum', 'DraftRowActions', { d: { id: 'a' } }, { settings: off.settings, draft: { id: 'a', threadUrl: 'project:2' } }), false); // no thread
  assert.equal(wakes('forum', 'DraftRowActions', { d: draft }, { settings: { ...ON, threads }, draft }), false); // on: the Slot renders it anyway
  assert.equal(wakes('forum', 'DraftRowActions', { d: draft }, { settings: off.settings, draft: null }), false);
});

test('agentNotes: the forum adds its push note only while on', () => {
  assert.equal(agentNotes(OFF), '');
  assert.match(agentNotes(ON), /Pushes to the forum/);
});

// docs/plans/integrations.md step 6: core reaches forum code only through the registries (integrations/ui.js, index.mjs), and
// the forum service only through forum/actions.js's one service line.
test('boundary: core imports no forum module, and only the forum and preload name api.forum', () => {
  const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile() && /\.(m?js|jsx)$/.test(f.name))
    .map((f) => join(f.parentPath, f.name).replaceAll('\\', '/'));
  const core = [...files('src'), 'main.js'].filter((f) => !f.startsWith('src/integrations/'));
  // main.js registers the forum's main process; catalogue.mjs spreads its command defs (index.mjs must not: define -> gates ->
  // index).
  const allowed = ['main.js', 'src/app/commands/catalogue.mjs'];
  const importsForum = (text) => /(?:from|import|require)\s*\(?\s*['"][^'"]*integrations\/forum\//.test(text);
  assert.deepEqual(core.filter((f) => !allowed.includes(f) && importsForum(readFileSync(f, 'utf8'))), []);
  const named = [...files('src'), 'main.js'].filter((f) => !f.startsWith('src/integrations/forum/') && readFileSync(f, 'utf8').includes('api.forum'));
  assert.deepEqual(named, []);
});

test('a forum push needs draft.settled: push.prepare, export.preview, and the push and push-wake tool entries', () => {
  for (const id of ['push.prepare', 'export.preview']) assert.ok(byId(id).needs.some((n) => (n.gate ?? n) === 'draft.settled'), id);
  const ui = readFileSync('src/integrations/forum/ui.jsx', 'utf8');
  for (const id of ['push', 'push-wake']) {
    const entry = ui.slice(ui.indexOf(`{ id: '${id}',`)).split('keywords:')[0];
    assert.match(entry, /needs: \[[^\]]*'draft\.settled'/, id);
  }
});
