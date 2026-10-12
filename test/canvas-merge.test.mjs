import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { closeHistory, history, undo } from '@tiptap/pm/history';
import { encode, newLog, rebuild, record } from '../src/app/history.js';
import { flipItem, moveItem, turnItem } from '../src/flow/model.mjs';
import { migrateBoards, scaleItem, whiteboardToCanvas } from '../src/whiteboard.js';

// Converted whiteboards (§6b; docs/plans/canvas-merge.md §2 and step 1).
const W = 1454;
const img = (id, x, y, w, h, extra = {}) => ({ id, type: 'image', src: 'x', x, y, w, h, ...extra });
const text = (id, x, y, extra = {}) => ({ id, type: 'text', html: 'A', x, y, w: 100, size: 20, color: '#fff', bold: false, align: 'left', bg: null, ...extra });
const shape = (id, x, y, extra = {}) => ({ id, type: 'shape', shape: 'rect', color: '#fff', width: 8, opacity: 1, fill: 'none', fillColor: '#fff', x, y, w: 100, h: 50, ...extra });
const conn = (id, from, to, extra = {}) => ({ id, type: 'connector', from, to, x: 0, y: 0, w: 10, h: 10, ...extra });
// A canvas item 500 × 250 at 100,50 over a 2000 × 1000 artboard (k 0.25).
const canvas = (items, extra = {}) => ({ id: 'cv', type: 'canvas', x: 100, y: 50, w: 500, h: 250, aw: 2000, ah: 1000, frame: null, bg: 'transparent', items, ...extra });
const convert = (items, height = 400) => whiteboardToCanvas({ height, base: null, bg: 'post', items }, W);
const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));
const finite = (a) => Number.isFinite(a.w) && Number.isFinite(a.h);

test('1. an empty whiteboard: a forumWidth × height canvas', () => {
  assert.deepEqual(convert([]), { w: 1454, h: 400, dw: 1454, frame: { x: 0, y: 0, w: 1454, h: 400 }, bg: 'post', items: [], flow: null, source: null });
});

test('2. items unchanged; an item past forumWidth widens w, dw stays', () => {
  const items = [img('a', 10, 10, 100, 100), text('t', 20, 380)];
  const a = convert(items);
  assert.deepEqual(a.items, items);
  assert.equal(a.h, 418); // the text's estimated bottom: 380 + round(20 · 1.3 + 12)
  const b = convert([img('a', 1400, 0, 200, 100)]);
  assert.deepEqual([b.w, b.dw, b.frame.w], [1600, 1454, 1600]);
});

test('3. the demo whiteboard: its 2 image canvases become plain images', () => {
  const items = [
    { id: 'jwb5cig', type: 'canvas', x: 341, y: 42, w: 409, h: 266, aw: 1883, ah: 1224, frame: { x: 0, y: 0, w: 1883, h: 1224 }, bg: 'transparent', items: [img('vxs8dco', 0, 0, 1883, 1224)] },
    text('qrxnyay', 455, 316),
    { id: '9fvc7u8', type: 'canvas', x: 21, y: 49, w: 304, h: 171, aw: 1808, ah: 1019, frame: { x: 0, y: 0, w: 1808, h: 1019 }, bg: 'transparent', items: [img('l1wv2ns', 0, 0, 1808, 1019)] },
    img('fka4klq', 762, 46, 456, 262),
  ];
  const a = convert(items, 777);
  assert.deepEqual(a.items.map((i) => i.id), ['vxs8dco', 'qrxnyay', 'l1wv2ns', 'fka4klq']);
  const { vxs8dco: v, l1wv2ns: l } = byId(a.items);
  assert.deepEqual([v.x, v.y, v.w, v.h], [341, 42, 409, 266]);
  assert.deepEqual([l.x, l.y, l.w, l.h], [21, 49, 304, 171]);
  assert.ok(a.items.every((i) => !i.groups));
  assert.deepEqual([a.w, a.h], [1454, 777]);
});

test('4. a canvas item\'s items are scaled, moved and grouped at its index', () => {
  const a = convert([img('before', 0, 0, 10, 10), canvas([img('i', 400, 200, 800, 400), shape('s', 0, 0), text('t', 40, 80, { size: 40 })]), img('after', 0, 0, 10, 10)]);
  assert.deepEqual(a.items.map((i) => i.id), ['before', 'i', 's', 't', 'after']);
  const { i, s, t } = byId(a.items);
  assert.deepEqual([i.x, i.y, i.w, i.h], [200, 100, 200, 100]);
  assert.equal(s.width, 2);
  assert.deepEqual([t.x, t.y, t.size], [110, 70, 10]);
  for (const x of [i, s, t]) assert.deepEqual(x.groups, ['cv']);
});

test('5. an inner connector loses d and lps; its free ends are scaled and moved', () => {
  const c = conn('k', { x: 400, y: 0 }, { x: 800, y: 400 }, { d: 'M0 0', lps: { mid: { x: 1, y: 1 } }, points: [{ x: 400, y: 400 }] });
  const k = byId(convert([canvas([c, img('i', 0, 0, 100, 100)])]).items).k;
  assert.ok(!('d' in k) && !('lps' in k));
  assert.deepEqual([k.from, k.to, k.points], [{ x: 200, y: 50 }, { x: 300, y: 150 }, [{ x: 200, y: 150 }]]);
});

test('6. white bg: a backing rect first; transparent: none', () => {
  const white = convert([canvas([img('i', 0, 0, 100, 100)], { bg: 'white' })]).items;
  assert.equal(white[0].id, 'cv-bg');
  assert.deepEqual([white[0].x, white[0].y, white[0].w, white[0].h, white[0].fillColor], [100, 50, 500, 250, '#ffffff']);
  assert.deepEqual(white.map((i) => i.groups), [['cv'], ['cv']]);
  assert.deepEqual(convert([canvas([img('i', 0, 0, 100, 100)])]).items.map((i) => i.id), ['i']);
});

test('7. a turned or mirrored canvas item: turnItem / flipItem about its centre; a text with no h stays finite', () => {
  const inner = img('i', 400, 200, 800, 400);
  const placed = moveItem(scaleItem(inner, 0.25), 100, 50);
  const centre = { x: 350, y: 175 };
  assert.deepEqual(convert([canvas([inner], { rot: 90 })]).items[0], turnItem(placed, centre, 90));
  assert.deepEqual(convert([canvas([inner], { mirrorX: true })]).items[0], flipItem(placed, centre, 'x', 'mirrorX'));
  const t = convert([canvas([text('t', 40, 80)], { rot: 30, mirrorY: true })]).items[0];
  assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y));
});

test('8. id clashes: the item is renamed and its connector follows; a clashing inner group is renamed', () => {
  const a = convert([img('i', 0, 0, 10, 10, { groups: ['g'] }), img('j', 0, 0, 10, 10, { groups: ['g'] }),
    canvas([img('i', 0, 0, 100, 100, { groups: ['g'] }), img('m', 0, 0, 100, 100, { groups: ['g'] }), conn('k', { item: 'i', anchor: null }, { x: 0, y: 0 })])]);
  const items = byId(a.items);
  assert.ok(items['i-cv']);
  assert.equal(items.k.from.item, 'i-cv');
  assert.deepEqual(items['i-cv'].groups, ['g-cv', 'cv']);
  assert.deepEqual(items.i.groups, ['g']);
});

test('9. a parent connector bound to the canvas item is freed at its tip', () => {
  const c = conn('k', { item: 'cv', anchor: null }, { x: 900, y: 900 }, { x: 600, y: 100, tips: [{ x: 0, y: 0 }, { x: 300, y: 800 }] });
  const k = byId(convert([canvas([img('i', 0, 0, 100, 100)]), c]).items).k;
  assert.deepEqual(k.from, { x: 600, y: 100 });
});

test('10. a shape label with no size, k 0.35: size 5.6', () => {
  const s = convert([canvas([shape('s', 0, 0, { html: 'Hi' })], { w: 700 })]).items[0];
  assert.equal(s.size, 5.6);
});

test('11. malformed input never throws and loses no object item', () => {
  const cases = [
    { items: 'nope' },
    { items: [null, 7, img('a', 0, 0, 10, 10)] },
    { items: [canvas(undefined), img('a', 0, 0, 10, 10)] },
    { items: [canvas([img('i', 0, 0, 10, 10)], { aw: undefined }), img('a', 0, 0, 10, 10)] },
    { items: [{ id: 'x', type: 'image', x: 'a', y: null, w: {}, h: [] }] },
    { items: [canvas([conn('k', undefined, undefined)])] },
    { items: [canvas([img('i', 0, 0, 10, 10, { groups: 'g' })])] },
    { height: 'tall', bg: 'neon', items: [img('a', 0, 0, 10, 10)] },
    null,
  ];
  for (const attrs of cases) {
    const a = whiteboardToCanvas(attrs, W);
    assert.ok(finite(a), JSON.stringify(attrs));
    const ids = new Set(a.items.map((i) => i.id));
    // Every object item but a canvas item (flattened, or dropped when invalid as parseBoard drops it) is kept.
    for (const i of Array.isArray(attrs?.items) ? attrs.items : []) if (i?.type && i.type !== 'canvas') assert.ok(ids.has(i.id), JSON.stringify(attrs));
  }
});

test('12. migrateBoards: nested whiteboards, canvas nodes, a bare whiteboard, no-op, idempotent', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'box', content: [{ type: 'boxContent', content: [{ type: 'whiteboard', attrs: { height: 300, base: null, bg: 'post', items: [canvas([img('i', 0, 0, 100, 100)])] } }] }] },
      { type: 'canvas', attrs: { w: 800, h: 600, dw: 800, frame: null, bg: 'post', items: [canvas([img('j', 0, 0, 100, 100)])], flow: null, source: null } },
      { type: 'paragraph', content: [{ type: 'text', text: 'keep' }] },
    ],
  };
  const out = migrateBoards(doc, W);
  const wb = out.content[0].content[0].content[0];
  assert.equal(wb.type, 'canvas');
  assert.deepEqual(wb.attrs.items.map((i) => i.id), ['i']);
  assert.deepEqual(out.content[1].attrs.items.map((i) => i.id), ['j']);
  assert.equal(out.content[2], doc.content[2]);
  assert.deepEqual(migrateBoards({ type: 'whiteboard' }, W), { type: 'canvas', attrs: convert([]) });
  assert.equal(migrateBoards(out, W), out);
  const plain = { type: 'doc', content: [{ type: 'paragraph' }] };
  assert.equal(migrateBoards(plain, W), plain);
  assert.deepEqual(migrateBoards(doc, W), out);
});

test('13. history: a whiteboard\'s Board commits replay after the conversion', () => {
  const atom = (attrs) => ({ group: 'block', atom: true, attrs: Object.fromEntries(attrs.map((k) => [k, { default: null }])) });
  const nodes = (extra) => ({ doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*' }, text: {}, ...extra });
  const canvasAttrs = ['w', 'h', 'dw', 'frame', 'bg', 'items', 'flow', 'source'];
  const old = new Schema({ nodes: nodes({ whiteboard: atom(['height', 'base', 'bg', 'items']), canvas: atom(canvasAttrs) }) });
  const now = new Schema({ nodes: nodes({ canvas: atom(canvasAttrs) }) });
  const start = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'whiteboard', attrs: { height: 400, base: null, bg: 'post', items: [] } }] };
  let state = EditorState.create({ schema: old, doc: old.nodeFromJSON(start), plugins: [history()] });
  const log = newLog(state);
  const docs = [state.doc.toJSON()];
  for (let n = 1; n <= 3; n++) {
    const items = [canvas([img(`i${n}`, 0, 0, 100, 100)]), img(`a${n}`, 10 * n, 0, 10, 10)];
    const tr = closeHistory(state.tr.setNodeMarkup(3, undefined, { ...state.doc.nodeAt(3).attrs, items, height: 400 + n }));
    const { state: next, transactions } = state.applyTransaction(tr);
    record(log, tr, transactions.slice(1), next);
    state = next;
    docs.push(state.doc.toJSON());
  }
  const file = migrateBoards(JSON.parse(JSON.stringify(encode(log, 50))), W);
  assert.ok(!JSON.stringify(file).includes('whiteboard'));
  const saved = now.nodeFromJSON(migrateBoards(docs[3], W));
  const rebuilt = rebuild(EditorState.create({ schema: now, doc: saved, plugins: [history()] }), file, 50);
  assert.ok(rebuilt);
  let st = rebuilt.state;
  undo(st, (tr) => { st = st.apply(tr); });
  assert.ok(st.doc.eq(now.nodeFromJSON(migrateBoards(docs[2], W))));
});
