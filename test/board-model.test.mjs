// bd-paint (docs/plans/board/briefs/bd-paint.md): the engine models a board item is stamped from. The pure checks need nothing
// built; the last ones stamp through the built .wasm (src/engine/wasm), as the board's worker does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { blankModel, modelOf, storyOf, mergeStory } from '../src/board/model.mjs';

// A floating red rectangle the item session saved after insert.shape; its body is emptied to make the blank base.
const saved = JSON.parse(fs.readFileSync(new URL('./fixtures/board/shape-model.json', import.meta.url), 'utf8'));
const base = blankModel({ ...saved, body: [{ kind: 'para', text: '', runs: [] }] });
const parsed = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
const para = (text, style) => ({ kind: 'para', text, runs: [{ len: Buffer.byteLength(text) }], ...(style && { props: { style } }) });
const ids = (m) => m.styles.styles.map((s) => s.id);

test('a 100 x 50 shape is a model of a 100 x 50 pt page holding the shape in front of the text', () => {
  const m = parsed(modelOf({ type: 'shape', kind: 'rectangle', w: 100, h: 50, fill: [255, 0, 0], stroke: null }, base));
  assert.equal(m.lastSection.pageW, 100);
  assert.equal(m.lastSection.pageH, 50);
  for (const k of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'header', 'footer']) assert.equal(m.lastSection[k], 0, k);
  assert.equal(m.body.length, 1);
  const [o] = m.body[0].objects;
  assert.deepEqual([m.body[0].text, o.type, o.kind, o.w, o.h, o.fill, o.stroke, o.float.wrap, o.float.hRel], ['\uFFFC', 'shape', 'rectangle', 100, 50, [255, 0, 0], null, 'inFrontOfText', 'page']);
  assert.equal(base.lastSection.pageW, 612, 'the base is not changed');
});

test('a model carries the styles its paragraphs use and not the other fifty', () => {
  const bytes = modelOf({ type: 'shape', kind: 'rectangle', w: 100, h: 50 }, base);
  assert.deepEqual(ids(parsed(bytes)).sort(), ['DefaultParagraphFont', 'Normal', 'TableNormal']);
  assert.ok(bytes.length < 5000, `${bytes.length} bytes`);
});

test('a line with no height still has a page', () => {
  const m = parsed(modelOf({ type: 'shape', kind: 'line', w: 100, h: 0, stroke: [0, 0, 0], strokeWidth: 4 }, base));
  assert.equal(m.lastSection.pageH, 1);
  assert.deepEqual([m.body[0].objects[0].h, m.body[0].objects[0].stroke_width], [0, 4]);
});

test('a story keeps the styles its blocks use, with what they are based on, and drops the others', () => {
  const story = storyOf({ ...base, body: [para('Heading', 'Heading1'), para('Body')] });
  const have = ids({ styles: story.styles });
  assert.ok(have.includes('Heading1') && have.includes('Normal'), have.join());
  assert.ok(!have.includes('Title'), 'Title is not named');
  assert.deepEqual(story.blocks.map((b) => b.text), ['Heading', 'Body']);
});

test('a story keeps the lists its paragraphs name and the styles those name, and drops the others', () => {
  const numbering = {
    abstracts: [{ id: 0, levels: [{ style: 'Heading2' }] }, { id: 1, levels: [{ style: null }] }, { id: 2, levels: [] }],
    nums: [{ id: 1, abstractId: 0 }, { id: 2, abstractId: 1 }, { id: 3, abstractId: 2 }],
  };
  const item = { ...para('A listed line'), props: { numbering: { num: 1, level: 0 } } };
  const story = storyOf({ ...base, numbering, body: [item] });
  assert.deepEqual(story.numbering.nums.map((n) => n.id), [1]);
  assert.deepEqual(story.numbering.abstracts.map((a) => a.id), [0]);
  assert.ok(ids({ styles: story.styles }).includes('Heading2'), 'a list level names a style');
});

test('a story keeps the text box parts its blocks name', () => {
  const box = { ...para('\uFFFC'), objects: [{ type: 'shape', kind: 'rectangle', story: 7 }] };
  const parts = { 7: { kind: 'textBox', blocks: [para('In the box', 'Heading3')], body: { next: 8 } }, 8: { kind: 'textBox', blocks: [para('More')] }, 9: { kind: 'textBox', blocks: [] } };
  const story = storyOf({ ...base, parts, body: [box] });
  assert.deepEqual(Object.keys(story.parts), ['7', '8']);
  assert.ok(ids({ styles: story.styles }).includes('Heading3'), 'the part\'s paragraphs count');
});

test('a story merged into the base brings its blocks and keeps the base\'s other styles', () => {
  const story = storyOf({ ...base, body: [para('Heading', 'Heading1')] });
  const m = mergeStory(base, story);
  assert.equal(m.body[0].text, 'Heading');
  assert.ok(ids(m).includes('Title') && ids(m).includes('Heading1'));
  assert.equal(ids(base).filter((i) => i === 'Heading1').length, 1, 'the base is not changed');
  assert.ok(ids(parsed(modelOf({ type: 'text', w: 200, h: 20, story }, base))).includes('Heading1'));
  assert.ok(ids(parsed(modelOf({ type: 'text', w: 200, h: 20, story }, base, {}, { allStyles: true }))).includes('Title'), 'a model for editing keeps the gallery');
});

test('a shape\'s label is a text box part the shape names, and an empty label is none', () => {
  const label = { blocks: [para('Label', 'Heading2')] };
  const m = parsed(modelOf({ type: 'shape', kind: 'rectangle', w: 80, h: 40, story: label }, base));
  const id = m.body[0].objects[0].story;
  assert.equal(m.parts[id].kind, 'textBox');
  assert.equal(m.parts[id].blocks[0].text, 'Label');
  assert.ok(ids(m).includes('Heading2'));
  const none = parsed(modelOf({ type: 'shape', kind: 'rectangle', w: 80, h: 40, story: { blocks: [para('')] } }, base));
  assert.deepEqual([none.body[0].objects[0].story, none.parts], [null, {}]);
});

test('a picture names its media and carries only that picture', () => {
  const m = parsed(modelOf({ type: 'picture', media: 'a.png', w: 40, h: 30, crop: [0, 0.1, 0, 0], alt: 'A' }, base, new Map([['a.png', new Uint8Array([1, 2, 3])], ['b.png', new Uint8Array([4])]])));
  const [o] = m.body[0].objects;
  assert.deepEqual([o.type, o.media, o.crop, o.alt], ['image', 'a.png', [0, 0.1, 0, 0], 'A']);
  assert.deepEqual(m.media, { 'a.png': 'AQID' });
});

test('a text item with a fill gets a shape behind its first paragraph, which keeps its text', () => {
  const story = { blocks: [para('One'), para('Two')] };
  const m = parsed(modelOf({ type: 'text', w: 200, h: 30, story, fill: [255, 255, 0], stroke: null }, base));
  assert.deepEqual(m.body.map((b) => b.text), ['One\uFFFC', 'Two']);
  assert.deepEqual([m.body[0].objects[0].float.wrap, m.body[0].objects[0].fill], ['behindText', [255, 255, 0]]);
  assert.equal(parsed(modelOf({ type: 'text', w: 200, h: 30, story }, base)).body[0].objects, undefined);
});

test('a connector is a freeform shape with a box for each label at its point', () => {
  const freeform = { w: 100, h: 20, paths: [{ pts: [[0, 0], [100, 20]], closed: false }] };
  const m = parsed(modelOf({ type: 'connector', kind: 'freeform', w: 100, h: 20, freeform, stroke: [0, 0, 0], labelAt: { mid: [50, 10] }, labels: { mid: { blocks: [para('Yes')] } } }, base));
  const [line, label] = m.body[0].objects;
  assert.deepEqual([line.kind, line.freeform], ['freeform', freeform]);
  assert.deepEqual([label.float.x, label.float.y], [50 - 80, 10 - 12]);
  assert.equal(m.parts[label.story].blocks[0].text, 'Yes');
});

test('groups and instances have no stamp', () => {
  assert.equal(modelOf({ type: 'group', w: 10, h: 10 }, base), null);
  assert.equal(modelOf({ type: 'doc', w: 10, h: 10 }, base), null);
});

const built = fs.existsSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url));

test('the built engine stamps a model, and trimming the styles does not change how text lays out', { skip: !built && 'the engine is not built here' }, async () => {
  const { initSync, Engine } = await import('../src/engine/wasm/ew.js');
  const { addBundledFonts } = await import('../src/engine/fonts/bundled.mjs');
  initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
  const e = new Engine();
  await addBundledFonts(e, (url) => fs.readFileSync(url));
  e.boardInit();
  const stamp = (item, opts, handle = 1) => JSON.parse(e.boardSet(handle, modelOf(item, base, {}, opts), 0, false, false, 1, item.type === 'text' ? item.w : -1));

  const shape = stamp({ type: 'shape', kind: 'rectangle', w: 100, h: 50, fill: [255, 0, 0], stroke: null });
  assert.deepEqual([shape.ok, shape.ox, shape.oy, shape.w, shape.h], [true, 0, 0, 100, 50]);
  assert.equal(e.boardHit(1, 50, 25, 1), true);
  assert.equal(e.boardHit(1, 150, 25, 1), false);

  const heading = { blocks: [para('A heading that is long enough to take two lines at this width', 'Heading1')] };
  const plain = { blocks: [para('A heading that is long enough to take two lines at this width')] };
  const trimmed = stamp({ type: 'text', w: 150, h: 20, story: heading }, {}, 2);
  const whole = stamp({ type: 'text', w: 150, h: 20, story: heading }, { allStyles: true }, 3);
  const normal = stamp({ type: 'text', w: 150, h: 20, story: plain }, {}, 4);
  assert.equal(trimmed.textH, whole.textH);
  assert.equal(trimmed.textW, whole.textW);
  assert.ok(trimmed.textH > normal.textH, `a Heading 1 is taller: ${trimmed.textH} against ${normal.textH}`);

  const bad = JSON.parse(e.boardSet(1, new TextEncoder().encode('not a model'), 0, false, false, 1, -1));
  assert.equal(bad.ok, false);
  assert.equal(e.boardHit(1, 50, 25, 1), true, 'the old stamp stays');
  e.free();
});
