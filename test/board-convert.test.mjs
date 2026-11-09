// bd-convert (docs/plans/board/briefs/bd-convert.md): an old DOM canvas → the board form, checked so a refusal loses nothing.
// The engine-backed steps are fakes (a story's text, a picture's key, a preset's fields); the fixtures are old canvases by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canvasToBoard, canConvert, checkConvert, convertBoxes } from '../src/board/convert.mjs';
import { BoardStore } from '../src/board/store.mjs';

const DIR = new URL('./fixtures/canvases/', import.meta.url);
const attrsOf = (name) => JSON.parse(fs.readFileSync(new URL(`${name}.json`, DIR), 'utf8'));
const NAMES = ['plain', 'text', 'pictures', 'groups', 'connectors', 'ink', 'frame', 'frame-partial'];

/** A label's lines, the way a story's plain text reads. */
const lines = (html) => html.replace(/<br\s*\/?>|<(?:div|p)(?:\s[^>]*)?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/^\n/, '');

const deps = (over = {}) => ({
  story: async (html) => ({ blocks: lines(html).split('\n').map((text) => ({ kind: 'para', text })), parts: {}, styles: [], numbering: { abstracts: [], nums: [] } }),
  mediaOf: async (src) => `k${src.length}`,
  preset: async (prst, av) => ({ kind: `preset:${prst}`, freeform: null, extra: { preset: [prst, av] } }),
  ...over,
});

/** Runs `fn` with the harness's own conversion switch set (or unset) and always deletes it after. */
async function gate(value, fn) {
  if (value === undefined) delete globalThis.__boardConvertOn;
  else globalThis.__boardConvertOn = value;
  try {
    await fn();
  } finally {
    delete globalThis.__boardConvertOn;
  }
}

/** A client over one old canvas box `data`: `box.list`, `box.get` (overridable) and `box.fill`. */
function clientOf(data, { get = null, fill = { ok: true } } = {}) {
  const calls = { query: [], exec: [] };
  return {
    calls,
    async query(id) {
      calls.query.push(id);
      if (id === 'box.list') return { value: { boxes: [{ id: 7, kind: 'canvas', data }] } };
      if (id === 'box.get') return { value: get ?? { data } };
      return null;
    },
    async exec(id, args) {
      calls.exec.push([id, args]);
      return fill;
    },
  };
}

test('every fixture but the flowchart converts and passes the check; the flowchart is refused', async () => {
  const flow = attrsOf('flow');
  assert.equal(canConvert(flow), 'flow');
  for (const name of NAMES) {
    const attrs = attrsOf(name);
    assert.equal(canConvert(attrs), null, name);
    const board = await canvasToBoard(attrs, deps());
    assert.equal(board.form, 'easywriter.board', name);
    assert.equal(checkConvert(attrs, board), null, name);
  }
});

test('a canvas form a newer build wrote is refused, and one with no items array is bad', () => {
  assert.equal(canConvert({ form: 'easywriter.board', version: 99, items: {} }), 'newer');
  assert.equal(canConvert({ w: 10 }), 'bad');
});

test('plain: a box at 40, 80 px is at 30, 60 pt, and the preset is the item session\'s fields', async () => {
  const board = await canvasToBoard(attrsOf('plain'), deps());
  const box = board.items.box1;
  assert.deepEqual([box.type, box.x, box.y, box.w, box.h], ['shape', 30, 60, 90, 45]);
  assert.equal(box.kind, 'rectangle');
  assert.deepEqual(box.stroke, [0x12, 0x34, 0x56]);
  assert.deepEqual(board.items.preset.extra.preset, ['pentagon', [0.5]]);
  assert.equal(board.items.preset.kind, 'preset:pentagon');
  assert.deepEqual(board.items.preset.at, [null, 'W']);
});

test('an item removed, or one moved 1 pt, fails the check', async () => {
  const attrs = attrsOf('plain');
  const board = await canvasToBoard(attrs, deps());
  assert.equal(checkConvert(attrs, board), null);
  const gone = structuredClone(board);
  delete gone.items.preset;
  assert.match(checkConvert(attrs, gone), /3 items were there and 2 came out/);
  const moved = structuredClone(board);
  moved.items.box1.x += 1;
  assert.match(checkConvert(attrs, moved), /box1 x moved/);
});

test('an item with no id is refused', () => {
  assert.match(checkConvert({ items: [{ type: 'shape', x: 0, y: 0, w: 1, h: 1 }] }, { items: {} }), /no id/);
});

test('a changed group parent, or a different paint order, is refused', async () => {
  const attrs = attrsOf('groups');
  const board = await canvasToBoard(attrs, deps());
  assert.equal(checkConvert(attrs, board), null);
  const regrouped = structuredClone(board);
  regrouped.items.ga.at = ['outer', 'V'];
  assert.match(checkConvert(attrs, regrouped), /ga is not in its group/);
  const reordered = structuredClone(board);
  [reordered.items.ga.at, reordered.items.gb.at] = [['inner', 'W'], ['inner', 'V']];
  assert.match(checkConvert(attrs, reordered), /paint order/);
});

test('a missing story where the old item had text is refused', async () => {
  const attrs = attrsOf('text');
  const board = await canvasToBoard(attrs, deps());
  delete board.items.note.story;
  assert.match(checkConvert(attrs, board), /text of note differs/);
});

test('the last old item paints last', async () => {
  const attrs = attrsOf('plain');
  const board = await canvasToBoard(attrs, deps());
  const store = new BoardStore(board, { client: 'test' });
  const order = store.live().filter((i) => i.type !== 'group').map((i) => i.id);
  assert.deepEqual(order, attrs.items.map((i) => i.id));
});

test('group depth matches the old nesting, innermost first', async () => {
  const board = await canvasToBoard(attrsOf('groups'), deps());
  assert.equal(board.items.outer.at[0], null);
  assert.equal(board.items.inner.at[0], 'outer');
  assert.equal(board.items.ga.at[0], 'inner');
  assert.equal(board.items.gb.at[0], 'inner');
  assert.equal(board.items.gc.at[0], 'outer');
  const store = new BoardStore(board, { client: 'test' });
  assert.deepEqual(store.live().filter((i) => i.type !== 'group').map((i) => i.id), ['ga', 'gb', 'gc']);
});

test('a real pen stroke keeps its own framed box, and its points stay local to it', async () => {
  const board = await canvasToBoard(attrsOf('ink'), deps());
  const ink = board.items.ink1;
  assert.deepEqual([ink.x, ink.y, ink.w, ink.h], [5.25, 11.25, 35.25, 9.75]);
  assert.deepEqual(ink.freeform.paths[0].pts[0], [2.55, 3.9]);
  assert.equal(checkConvert(attrsOf('ink'), board), null);
});

test('a picture keeps its bytes; the frame follows its item or its own partial frame', async () => {
  const pictures = await canvasToBoard(attrsOf('pictures'), deps());
  assert.equal(pictures.media[pictures.items.png.media], attrsOf('pictures').items[0].src);
  assert.deepEqual(pictures.items.emf.orig, { w: 40, h: 30 });
  assert.deepEqual((await canvasToBoard(attrsOf('frame'), deps())).frame, { x: 7.5, y: 15, w: 150, h: 112.5 });
  assert.deepEqual((await canvasToBoard(attrsOf('frame-partial'), deps())).frame, { x: 15, y: 7.5, w: 150, h: 112.5 });
});

test('an old fit text fits its width at WIDE; a fixed width fits its height', async () => {
  const widths = [];
  const spy = deps({ story: async (html, width) => { widths.push(width); return { blocks: [], parts: {}, styles: [], numbering: { abstracts: [], nums: [] } }; } });
  const fitted = await canvasToBoard({ aw: 10, ah: 10, items: [{ id: 't', type: 'text', x: 0, y: 0, w: 60, html: 'x', fit: true }] }, spy);
  const fixed = await canvasToBoard({ aw: 10, ah: 10, items: [{ id: 't', type: 'text', x: 0, y: 0, w: 60, html: 'x' }] }, spy);
  assert.deepEqual([fitted.items.t.fit, widths[0]], ['width', 16000]); // WIDE (bd-text's unwrapped layout width)
  assert.deepEqual([fixed.items.t.fit, widths[1]], ['height', 45]);
  assert.equal('w' in fixed.items.t, true);
});

test('a 0-size item stays', async () => {
  const attrs = { aw: 10, ah: 10, items: [{ id: 'z', type: 'shape', shape: 'rect', x: 0, y: 0, w: 0, h: 0, color: '#000000', width: 1, opacity: 1, fill: 'solid', fillColor: '#ffffff' }] };
  const board = await canvasToBoard(attrs, deps());
  assert.deepEqual([board.items.z.x, board.items.z.y, board.items.z.w, board.items.z.h], [0, 0, 0, 0]);
  assert.equal(checkConvert(attrs, board), null);
});

test('convertBoxes leaves a box a throwing story cannot convert, and says so once', async () => {
  await gate(true, async () => {
    const client = clientOf(JSON.stringify(attrsOf('text')));
    const said = [];
    await convertBoxes(client, deps({ story: async () => { throw new Error('no story'); } }), (line) => said.push(line));
    assert.deepEqual(client.calls.query, ['box.list']);
    assert.deepEqual(client.calls.exec, []);
    assert.deepEqual(said, ['1 canvas stays in its old form. It still shows and edits as before.']);
  });
});

test('convertBoxes makes no call while the gate is off, whatever the settings say', async () => {
  await gate(undefined, async () => {
    const client = clientOf(JSON.stringify(attrsOf('plain')));
    await convertBoxes(client, deps({ settings: { word: { canvasEngine: true }, postEngine: true } }), () => {});
    assert.deepEqual(client.calls.query, []);
  });
  await gate(false, async () => {
    const client = clientOf(JSON.stringify(attrsOf('plain')));
    await convertBoxes(client, deps(), () => {});
    assert.deepEqual(client.calls.query, []);
  });
});

test('convertBoxes writes the converted box with box.fill and no undo step', async () => {
  await gate(true, async () => {
    const client = clientOf(JSON.stringify(attrsOf('plain')));
    const said = [];
    await convertBoxes(client, deps(), (line) => said.push(line));
    assert.deepEqual(said, []);
    assert.deepEqual(client.calls.query, ['box.list', 'box.get']);
    assert.equal(client.calls.exec.length, 1);
    assert.equal(client.calls.exec[0][0], 'box.fill');
    assert.equal(client.calls.exec[0][1].id, 7);
    assert.equal(JSON.parse(client.calls.exec[0][1].data).form, 'easywriter.board');
  });
});

test('convertBoxes skips a box edited while it converted, and counts a failed fill', async () => {
  await gate(true, async () => {
    const edited = clientOf(JSON.stringify(attrsOf('plain')), { get: { data: '{"w":1}' } });
    const said = [];
    await convertBoxes(edited, deps(), (line) => said.push(line));
    assert.deepEqual(edited.calls.exec, []);
    assert.deepEqual(said, []);
    const failed = clientOf(JSON.stringify(attrsOf('plain')), { fill: { ok: false, error: 'no' } });
    const lines = [];
    await convertBoxes(failed, deps(), (line) => lines.push(line));
    assert.deepEqual(lines, ['1 canvas stays in its old form. It still shows and edits as before.']);
  });
});
