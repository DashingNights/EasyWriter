import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileFamily } from '../src/file-family.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dw-family-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = '11111111-2222-3333-4444-555555555555';

test('save stamps id, created and updated; list returns summaries newest first; load returns the record', async () => {
  const dir = tempDir();
  const fam = fileFamily(() => dir, { summary: (r) => ({ id: r.id, title: r.title, updated: r.updated }) });
  assert.deepEqual(await fam.list(), []); // no folder yet
  const input = { title: 'A' };
  const a = await fam.save(input);
  assert.match(a.id, /^[a-f0-9-]{36}$/);
  assert.equal(a.created, a.updated);
  assert.deepEqual(input, { title: 'A' }); // the input is not mutated
  await wait(5);
  const b = await fam.save({ title: 'B' });
  assert.deepEqual((await fam.list()).map((r) => r.title), ['B', 'A']);
  assert.deepEqual(Object.keys((await fam.list())[0]), ['id', 'title', 'updated']);
  assert.deepEqual(await fam.load(b.id), { title: 'B', id: b.id, created: b.created, updated: b.updated });
  assert.equal(await fam.load(ID), null);
});

test('keepPrevious keeps the replaced version as .bak; created survives, updated and rev are returned', async () => {
  const dir = tempDir();
  const fam = fileFamily(() => dir, { keepPrevious: true });
  const first = await fam.save({ id: ID, rev: 1, v: 'one' });
  await wait(5);
  const second = await fam.save({ ...(await fam.load(ID)), rev: 2, v: 'two' });
  assert.equal(second.created, first.created);
  assert.ok(second.updated > first.updated);
  assert.equal(second.rev, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${ID}.json.bak`), 'utf8')).v, 'one');
  assert.equal((await fam.load(ID)).v, 'two');
});

test('validate and maxBytes refuse a record before anything is written', async () => {
  const dir = tempDir();
  const fam = fileFamily(() => dir, {
    maxBytes: 200,
    validate: (r) => {
      if (typeof r.title !== 'string') throw new Error('title must be a string');
    },
  });
  assert.throws(() => fam.save({ title: 1 }), /title must be a string/);
  assert.throws(() => fam.save({ title: 'x'.repeat(300) }), /too large/);
  assert.throws(() => fam.save([1]), /must be an object/);
  assert.deepEqual(await fam.list(), []);
});

test('remove moves the record, its .bak and its siblings into .trash', async () => {
  const dir = tempDir();
  const fam = fileFamily(() => dir, { keepPrevious: true, siblings: (id) => [path.join(dir, `${id}.history.json`)] });
  await fam.save({ id: ID });
  await fam.save({ id: ID });
  fs.writeFileSync(path.join(dir, `${ID}.history.json`), '{}');
  assert.equal(await fam.remove(ID), true);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.trash')).sort(), [`${ID}.history.json`, `${ID}.json`, `${ID}.json.bak`]);
  assert.equal(await fam.load(ID), null);
  assert.equal(await fam.remove(ID), true); // nothing left: still fine
});

test('an unparsable file is omitted; with keepPrevious it is set aside as .corrupt-<ts>, else kept as it is', async () => {
  for (const keepPrevious of [true, false]) {
    const dir = tempDir();
    const fam = fileFamily(() => dir, { keepPrevious });
    fs.writeFileSync(path.join(dir, `${ID}.json`), '{bad');
    assert.deepEqual(await fam.list(), []);
    const names = fs.readdirSync(dir);
    if (keepPrevious) assert.ok(names.length === 1 && names[0].startsWith(`${ID}.json.corrupt-`), names.join());
    else assert.deepEqual(names, [`${ID}.json`]);
  }
});

test('ids are checked before any path is built; other file names are not listed', async () => {
  const dir = tempDir();
  const fam = fileFamily(() => dir);
  for (const bad of ['../settings', `${ID}x`, 'ABCDEF', null]) {
    assert.throws(() => fam.load(bad), /invalid id/);
    assert.throws(() => fam.remove(bad), /invalid id/);
    if (bad) assert.throws(() => fam.save({ id: bad }), /invalid id/); // a null id means "new"
  }
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"updated": 1}');
  fs.writeFileSync(path.join(dir, `${ID}.history.json`), '{"updated": 1}');
  assert.deepEqual(await fam.list(), []);
});
