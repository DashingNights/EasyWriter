// C4 post-push, the import's side (docs/plans/engine/stage3-forum.md C4): a post the import writes is checked by the engine only
// where the engine hosts posts. With the flag off the DOM kit's schema decides, as it always did, and no engine session opens:
// a reply chain quoted twelve levels deep passes it, where the engine refuses anything past nine. A quiet session of its own per
// job, so two imports at once never share one.
import './mini-dom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { kitOf } from '../src/editors.js';
import { postSource } from '../src/document/canvas/post.js';
import { importProblem } from '../src/document/canvas/post-import.mjs';
import { quietSessionId, withQuietSession } from '../src/engine/quiet.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

/** A post of `n` quotes, one inside the next. */
const quotes = (n) => {
  let node = { type: 'paragraph', content: [{ type: 'text', text: 'deep' }] };
  for (let i = 0; i < n; i++) node = { type: 'blockquote', content: [node] };
  return { type: 'doc', content: [node] };
};

test('with the engine off a 12-deep quote chain imports, and no engine session opens', async () => {
  const draft = { id: 'deep', format: 'forum-post', doc: quotes(12) };
  const schema = kitOf('forum-post').schema;
  let sessions = 0;
  const quiet = async () => {
    sessions++;
    return 'the engine would refuse it';
  };
  const why = await importProblem(draft, { settings: {} }, () => schema.nodeFromJSON(draft.doc).check(), quiet);
  assert.equal(why, null, 'the DOM kit holds twelve levels, so the post is written as before');
  assert.equal(sessions, 0, 'the flag off opens no engine session');
});

test('with the engine on, the engine decides: the same 12-deep chain is refused', async () => {
  const draft = { id: 'deep', format: 'forum-post', doc: quotes(12) };
  let schemaChecks = 0;
  const why = await importProblem(draft, { settings: { postEngine: true } }, () => schemaChecks++, async () => 'nested past nine');
  assert.equal(why, 'nested past nine');
  assert.equal(schemaChecks, 0, 'the engine hosts posts, so the DOM kit is not asked');
});

test('the engine really refuses what the DOM kit took: twelve quoted levels against nine', () => {
  const e = new Engine();
  try {
    const settings = {};
    const open = (n) => e.open(postSource({ id: 'x', format: 'forum-post', doc: quotes(n) }, settings).bytes, 'post');
    assert.doesNotThrow(() => open(9));
    assert.throws(() => open(12), /nested|container/i);
  } finally {
    e.free();
  }
});

test('two quiet sessions never share an id, and each releases its own', async () => {
  const ids = [];
  let released = 0;
  const host = { session: (id) => {
    ids.push(id);
    return { open: async () => ({ pages: 1 }), quiet: async () => {}, release: () => released++ };
  } };
  const deps = { source: () => ({ bytes: new Uint8Array(), kind: 'post', dropped: [] }) };
  await Promise.all([withQuietSession({ id: 'a' }, deps, async () => {}, host), withQuietSession({ id: 'b' }, deps, async () => {}, host)]);
  assert.equal(ids.length, 2, 'two jobs, two sessions');
  assert.notEqual(ids[0], ids[1], 'one job cannot take the other\'s session');
  assert.notEqual(quietSessionId(), quietSessionId());
  assert.equal(released, 2, 'each session goes when its job ends');
});
