// A3 post-write (docs/plans/engine/stage3-forum.md section 3): a post read into the engine and saved again is the same post.
// normal(write(read(f))) == normal(f) for every fixture, through the node wasm adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { renderPost } from '../src/integrations/forum/html.mjs';
import { normal } from '../src/integrations/forum/normal.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

const DIR = new URL('./fixtures/posts/', import.meta.url);
const FIXTURES = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

/** Whether two JSON values are the same: a JSON object's keys are unordered, so the order the writer emits them in is not news. */
function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  }
  return a === b;
}

/** The bytes opened as a post and saved again → {doc, pending}. The save is parsed as JSON, not just compared: a node the
 * writer closes early (a heading, say) fails here. */
function roundTrip(bytes) {
  const e = new Engine();
  try {
    e.open(bytes, 'post');
    return JSON.parse(new TextDecoder().decode(e.save('post')));
  } finally {
    e.free();
  }
}

for (const name of FIXTURES) {
  test(`${name} is the same post after a round trip through the engine`, () => {
    const bytes = fs.readFileSync(new URL(name, DIR));
    const saved = roundTrip(bytes);
    const fixture = JSON.parse(bytes.toString('utf8'));
    assert.ok(same(normal(saved.doc), normal(fixture)), `${name}\nwritten: ${JSON.stringify(normal(saved.doc))}\nfixture: ${JSON.stringify(normal(fixture))}`);
  });
}

test('a resized medium is saved with its display width, which the forum render uses', () => {
  const e = new Engine();
  try {
    e.open(fs.readFileSync(new URL('objects.json', DIR)), 'post');
    const media = JSON.parse(e.frames(0)).find((f) => f.box === 'media');
    // boxes.jsx's resize sends the frame's new size and the same width in the data, which the post's own form reads.
    const got = JSON.parse(e.exec('box.get', JSON.stringify({ id: Number(media.id) })));
    const attrs = { ...JSON.parse(got.value.data), dw: 500 };
    e.exec('box.set', JSON.stringify({ id: Number(media.id), data: JSON.stringify(attrs), w: 500, h: 281.25 }));
    const saved = JSON.parse(new TextDecoder().decode(e.save('post')));
    const node = saved.doc.content.find((n) => n.type === 'media');
    assert.equal(node.attrs.dw, 500, 'the resize reaches dw, which the DOM Media node and the push read');
    assert.match(renderPost(saved.doc), /width: 500px/, 'the forum HTML draws the medium at the resized width');
  } finally {
    e.free();
  }
});

test('a post that marks bold beside code is refused, not quietly changed', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'code' }] }] }] };
  const saved = roundTrip(new TextEncoder().encode(JSON.stringify(doc)));
  // checkPost refuses a post whose normal form differs (normal inequality): the bold is still in the post, the save writes
  // code alone, so the two differ.
  assert.deepEqual(normal(doc).content[0].content[0].marks, [{ type: 'bold' }, { type: 'code' }]);
  assert.deepEqual(normal(saved.doc).content[0].content[0].marks, [{ type: 'code' }]);
  assert.ok(!same(normal(saved.doc), normal(doc)), 'the comparison must refuse it');
});

test('a post with waiting suggestions saves as the post with every change accepted, and counts them', () => {
  const saved = roundTrip(fs.readFileSync(new URL('suggestions.json', DIR)));
  assert.equal(saved.pending, 3);
  // The blocks the assistant removed are not written and the ones it added are, so the post reads as accepted.
  const text = JSON.stringify(saved.doc);
  assert.ok(text.includes('The assistant rewritten line.'));
  assert.ok(!text.includes('The first version of this line.'));
  assert.ok(!text.includes('A line the assistant removed.'));
});
