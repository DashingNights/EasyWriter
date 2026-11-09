// drafts.create's content on a forum post (docs/plans/engine/stage3-forum.md C5): its HTML and Markdown go through the forum's
// own import (postToDoc) only while settings.postEngine hosts posts in the engine; with the flag off the draft is made exactly
// as before (the kit's toNodes: pictures kept, empty Markdown refused).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defs } from '../src/app/commands/drafts.mjs';

const create = defs.find((d) => d.id === 'drafts.create');

/** drafts.create's ctx with `toNodes` stubbed and createDraft captured → {ctx, made}. */
function ctx(settings, toNodes) {
  const out = { made: null, nodes: null };
  out.ctx = {
    source: 'smoke',
    state: { settings: { folders: [], threads: [], ...settings }, drafts: [], draft: null, rev: 7 },
    lib: { toNodes: async (content) => { out.nodes = content; return toNodes(content); } },
    actions: { createDraft: async (o) => { out.made = o; return { draftId: 'd1' }; } },
  };
  return out;
}
const node = (n) => ({ toJSON: () => n });
const IMAGE_MD = 'text ![a](https://x/a.png) more';

test('flag off: a post draft keeps the kit\'s own parse (pictures kept, not dropped)', async () => {
  const c = ctx({ postEngine: false }, () => ({ nodes: [node({ type: 'paragraph', content: [{ type: 'image', attrs: { alt: 'a' } }] })], dropped: [] }));
  await create.run(c.ctx, { format: 'forum-post', content: { markdown: IMAGE_MD } });
  assert.deepEqual(c.nodes, { markdown: IMAGE_MD }, 'the kit parsed it, not postToDoc');
  assert.deepEqual(c.made.doc, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { alt: 'a' } }] }] });
});

test('flag off: empty Markdown is refused as before (invalid_args), and nothing is created', async () => {
  const c = ctx({ postEngine: false }, () => { throw Object.assign(new Error('content.markdown: cannot be empty'), { code: 'invalid_args' }); });
  await assert.rejects(create.run(c.ctx, { format: 'forum-post', content: { markdown: '' } }), (e) => e.code === 'invalid_args');
  assert.equal(c.made, null);
});

test('flag on: a post draft\'s Markdown goes through postToDoc (a picture is its alt text, reported dropped)', async () => {
  let called = false;
  const c = ctx({ postEngine: true }, () => { called = true; return { nodes: [], dropped: [] }; });
  const r = await create.run(c.ctx, { format: 'forum-post', content: { markdown: IMAGE_MD } });
  assert.equal(called, false, 'toNodes is not used on a post while the engine hosts it');
  assert.deepEqual(c.made.doc, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'text a more' }] }] });
  assert.deepEqual(r.dropped, ['img']);
});

test('flag on: empty Markdown makes an empty post (one empty paragraph), not invalid_args', async () => {
  const c = ctx({ postEngine: true }, () => assert.fail('toNodes is not used'));
  await create.run(c.ctx, { format: 'forum-post', content: { markdown: '' } });
  assert.deepEqual(c.made.doc, { type: 'doc', content: [{ type: 'paragraph' }] });
});

test('a document draft never takes the post import', async () => {
  const c = ctx({ postEngine: true }, () => ({ nodes: [node({ type: 'paragraph' })], dropped: [] }));
  await create.run(c.ctx, { format: 'document', content: { markdown: 'Text' } });
  assert.deepEqual(c.nodes, { markdown: 'Text' });
});
