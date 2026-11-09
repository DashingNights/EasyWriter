// bd-dragout (docs/plans/board/briefs/bd-dragout.md): content moves between a page and the board in an order that only ever
// duplicates. These checks run the moves against fake sessions and saves and read the order of what they did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BoardStore, blankBoard } from '../src/board/store.mjs';
import { Journal } from '../src/board/journal.mjs';
import { blankModel } from '../src/board/model.mjs';
import dragout from '../src/board/tools/dragout.js';
import { registerTool } from '../src/board/tools/registry.js';
import { pointerOptions } from '../src/engine/input/pointer.js';
import { REFUSED, REFUSED_PICTURES, dropTarget, fieldsOf, moveAcross, moveIn, moveOut, moveWithin, refusal } from '../src/board/transfer.js';

const saved = JSON.parse(fs.readFileSync(new URL('./fixtures/board/shape-model.json', import.meta.url), 'utf8'));
blankModel({ ...saved, body: [{ kind: 'para', text: '', runs: [] }] });

const OBJ = '￼';
const para = (text, props, objects) => ({ kind: 'para', text, runs: text ? [{ len: Buffer.byteLength(text) }] : [], ...(props && { props }), ...(objects && { objects }) });
/** A model as the item session saves it after a paste: `body` and the document tables. */
const model = (body, extra = {}) => ({ ...saved, body, parts: {}, comments: {}, revisions: [], media: {}, ...extra });
const picture = { type: 'image', media: 'image1.png', w: 100, h: 50, alt: 'cat', crop: [0.1, 0.2, 0.1, 0.2],
  float: { wrap: 'inFrontOfText', hRel: 'column', vRel: 'paragraph', x: 240, y: 120, dist: 9, distTop: 0, distBottom: 0, effect: [0, 0, 0, 0], rot: 30, flipH: true, id: 3, fx: { shadow: 1 } } };

/** The first calls in order, as the checks read them. A fake draft session logs what it is asked and answers ok. */
class FakeDoc {
  constructor(id, log, { fail = {} } = {}) {
    this.id = id;
    this.log = log;
    this.fail = fail;
    this.stack = [];
    this.undone = 0;
    this.sel = { anchor: { story: 'body', path: [0], off: 0 }, head: { story: 'body', path: [0], off: 5 } };
    this.pasted = [];
  }

  async selection() {
    return structuredClone(this.sel);
  }

  async exec(name) {
    this.log.push(`${this.id}.${name}`);
    if (this.fail[name]) return { ok: false };
    if (name === 'edit.cut') {
      this.stack.push('step-cut');
      this.layout();
    }
    return { ok: true };
  }

  async execMany(steps) {
    this.log.push(`${this.id}.execMany`);
    this.many = steps;
    return { ok: true };
  }

  async steps() {
    return { undo: this.stack.at(-1) ?? null, redo: null };
  }

  async hit() {
    return { pos: { story: 'body', path: [0], off: 1 } };
  }

  async select() {}

  async call(name, args) {
    this.log.push(`${this.id}.${name}`);
    if (name === 'pasteSession') {
      this.pasted.push(args?.[0]);
      if (this.fail.paste) return { ok: false };
      this.stack.push('step-paste');
      this.layout();
      return { ok: true };
    }
    return null;
  }

  undo() {
    this.log.push(`${this.id}.undo`);
    this.stack.pop();
    this.undone++;
    this.layout();
  }

  redo() {
    this.log.push(`${this.id}.redo`);
  }

  on(event, fn) {
    if (event === 'layout') this.listener = fn;
    return () => {};
  }

  /** What a session's layout event carries after an edit: its undo and redo steps. */
  layout() {
    this.listener?.({ steps: { undo: this.stack.at(-1) ?? null, redo: null } });
  }
}

/** The item session: what `open` gets, and the model the next `save` answers. */
class FakeItem extends FakeDoc {
  constructor(log, saveModel) {
    super('item', log);
    this.saveModel = saveModel;
  }

  async open(bytes) {
    this.log.push('item.open');
    this.opened = JSON.parse(new TextDecoder().decode(bytes));
  }

  async save() {
    this.log.push('item.save');
    return JSON.stringify(this.saveModel);
  }

  async call(name, args) {
    if (name === 'blocks') return [];
    return super.call(name, args);
  }
}

function fixture({ saveModel = model([para(OBJ, null, [picture])], { media: { 'image1.png': 'data:image/png;base64,AAECAw==' } }), failBoard = false, failDoc = false, failFrom = {} } = {}) {
  const log = [];
  const store = new BoardStore(blankBoard(), { client: 'c' });
  const from = new FakeDoc('from', log, { fail: failFrom });
  const to = new FakeDoc('to', log);
  const item = new FakeItem(log, saveModel);
  const said = [];
  const journal = new Journal({ store, clients: (id) => ({ from, to }[id] ?? null), titleOf: (id) => id, say: (l) => said.push(l) });
  journal.watch(from);
  journal.watch(to);
  store.subscribe(({ step }) => journal.noteBoard(step)); // the journal tool's own wiring
  const grouped = [];
  const group = journal.group.bind(journal);
  journal.group = (parts) => {
    log.push('journal.group');
    grouped.push(parts);
    return group(parts);
  };
  const undo = store.change.bind(store);
  store.change = (label, fn, opts) => {
    log.push(`board.${label || 'silent'}`);
    return undo(label, fn, opts);
  };
  const ctx = { store, item, journal, media: new Map(), say: (l) => said.push(l),
    saveBoard: async () => { log.push('board.save'); return !failBoard; },
    saveDoc: async (id) => { log.push(`${id}.save`); return !failDoc; } };
  return { ctx, store, from, to, item, log, said, grouped, journal };
}

const at = { x: 400, y: 300 };

test('out: copy, paste, read the model, create the item, save the board, cut, then one journal entry', async () => {
  const f = fixture();
  const id = await moveOut(f.ctx, f.from, at);
  assert.ok(id, 'the item id');
  assert.deepEqual(f.log.filter((l) => !l.endsWith('.steps')), ['from.edit.copy', 'item.open', 'item.pasteSession', 'item.save',
    'board.Drag out', 'board.save', 'from.edit.cut', 'journal.group']);
  const item = f.store.get(id);
  assert.equal(item.type, 'picture');
  assert.deepEqual([item.x, item.y, item.w, item.h, item.crop, item.rot, item.flipX], [400, 300, 100, 50, [0.1, 0.2, 0.1, 0.2], 30, true]);
  assert.match(item.media, /^[0-9a-f]{64}\.png$/, 'the board names the picture by its content');
  assert.equal(f.store.board.media[item.media], 'data:image/png;base64,AAECAw==');
  // The doc part's undo brings the content back, so the journal runs it first.
  const [parts] = f.grouped;
  assert.equal(parts.find((p) => p.kind === 'doc').adds, true);
  assert.equal(parts.find((p) => p.kind === 'doc').step, 'step-cut');
});

test('out: a board save that fails removes the item, calls no cut and leaves no undo step', async () => {
  const f = fixture({ failBoard: true });
  assert.equal(await moveOut(f.ctx, f.from, at), null);
  assert.ok(!f.log.includes('from.edit.cut'), 'nothing was cut');
  assert.equal(f.store.live().length, 0);
  assert.equal(f.store.steps.length, 0);
  assert.deepEqual(f.said, ['The whiteboard could not be saved, so nothing moved.']);
});

test('out: a cut that fails removes the item and saves the board again', async () => {
  const f = fixture({ failFrom: { 'edit.cut': true } });
  assert.equal(await moveOut(f.ctx, f.from, at), null);
  assert.equal(f.store.live().length, 0);
  assert.equal(f.log.filter((l) => l === 'board.save').length, 2, 'saved with the item, then without it');
  assert.ok(!f.log.includes('journal.group'));
  assert.deepEqual(f.said, ['The document could not be changed, so nothing moved.']);
});

test('out: a copy cuts nothing, and its one journal entry is the item alone', async () => {
  const f = fixture();
  const id = await moveOut(f.ctx, f.from, at, { copy: true });
  assert.ok(id);
  assert.ok(!f.log.includes('from.edit.cut'));
  assert.deepEqual(f.grouped.map((parts) => parts.map((p) => p.kind)), [['board']]);
  assert.equal(f.store.live().length, 1);
  assert.equal(f.journal.entries.length, 1, 'Ctrl+Z takes the copy away');
});

test('out: a paste that fails changes nothing on either side', async () => {
  const f = fixture();
  f.item.fail = { paste: true };
  assert.equal(await moveOut(f.ctx, f.from, at), null);
  assert.equal(f.store.live().length, 0);
  assert.ok(!f.log.includes('from.edit.cut'));
});

test('out: a comment in the selection refuses the drag with its line and changes nothing', async () => {
  const f = fixture({ saveModel: model([para(`${OBJ}text`, null, [{ type: 'commentEnd', id: 0 }])]) });
  assert.equal(await moveOut(f.ctx, f.from, at), null);
  assert.deepEqual(f.said, [REFUSED]);
  assert.equal(f.store.live().length, 0);
  assert.ok(!f.log.includes('from.edit.cut'));
});

test('out: a picture inside text stays in the document, as the board would lose it at the next save', async () => {
  const f = fixture({ saveModel: model([para(`words ${OBJ}`, null, [picture])], { media: { 'image1.png': 'data:image/png;base64,AAECAw==' } }) });
  assert.equal(await moveOut(f.ctx, f.from, at), null);
  assert.deepEqual(f.said, [REFUSED_PICTURES]);
  assert.equal(f.store.live().length, 0);
  assert.ok(!f.log.includes('from.edit.cut'));
});

test('out: pictures of the document the fragment does not use come in the model and refuse nothing', async () => {
  const f = fixture({ saveModel: model([para('plain words')], { media: { 'image1.png': 'data:image/png;base64,AAECAw==' } }) });
  const id = await moveOut(f.ctx, f.from, at);
  assert.ok(id);
  assert.equal(f.store.get(id).type, 'text');
  assert.deepEqual(f.said, []);
  assert.deepEqual(Object.keys(f.store.board.media), [], 'nothing the item does not use goes into the board');
});

test('out: a selection that changed while the item was saved is not cut, and the item goes', async () => {
  const f = fixture();
  f.ctx.saveBoard = async () => {
    f.log.push('board.save');
    f.from.sel = { anchor: { story: 'body', path: [1], off: 0 }, head: { story: 'body', path: [1], off: 3 } };
    return true;
  };
  assert.equal(await moveOut(f.ctx, f.from, at), null);
  assert.ok(!f.log.includes('from.edit.cut'), 'what the cut would take is not what was copied');
  assert.equal(f.store.live().length, 0);
  assert.equal(f.log.filter((l) => l === 'board.save').length, 2);
  assert.deepEqual(f.said, ['The selection changed, so nothing moved.']);
});

test('across: a selection that changed is not cut, and the paste in the other draft is undone and saved again', async () => {
  const f = fixture();
  f.ctx.saveDoc = async (id) => {
    f.log.push(`${id}.save`);
    f.from.sel = { anchor: { story: 'body', path: [2], off: 0 }, head: { story: 'body', path: [2], off: 1 } };
    return true;
  };
  assert.equal(await moveAcross(f.ctx, f.from, f.to, { page: 0, x: 10, y: 10 }), false);
  assert.ok(!f.log.includes('from.edit.cut'));
  assert.equal(f.to.undone, 1);
  assert.equal(f.log.filter((l) => l === 'to.save').length, 2);
  assert.deepEqual(f.said, ['The selection changed, so nothing moved.']);
});

test('out: the journal is held for the whole move, so a Ctrl+Z in the save window finds nothing to undo', async () => {
  const f = fixture();
  const seen = {};
  f.ctx.saveBoard = async () => {
    f.log.push('board.save');
    seen.entries = f.journal.entries.length;
    seen.undone = await f.journal.undo();
    return true;
  };
  const id = await moveOut(f.ctx, f.from, at);
  assert.ok(id);
  assert.equal(seen.entries, 0, 'the first half stands as no entry of its own');
  assert.equal(seen.undone, false);
  assert.ok(!f.store.get(id).gone, 'the item stays');
  assert.ok(!f.log.includes('from.undo'));
  assert.equal(f.journal.entries.length, 1, 'the group is the one way back');
  assert.equal(f.journal.busy, false, 'the hold is released');
});

test('in: the journal is held across the draft save too', async () => {
  const f = fixture();
  const id = f.store.change('Add', (tx) => tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'a'], x: 0, y: 0, w: 10, h: 10, fill: null, stroke: null })) && f.store.live()[0].id;
  f.journal.entries.length = 0;
  const seen = {};
  f.ctx.saveDoc = async (sid) => {
    f.log.push(`${sid}.save`);
    seen.entries = f.journal.entries.length;
    seen.undone = await f.journal.undo();
    return true;
  };
  assert.equal(await moveIn(f.ctx, id, f.to, { page: 0, x: 1, y: 1 }), true);
  assert.deepEqual([seen.entries, seen.undone, f.to.undone], [0, false, 0]);
  assert.equal(f.journal.entries.length, 1);
  assert.equal(f.journal.busy, false);
});

test('in: a hold that fails releases the journal', async () => {
  const f = fixture({ failDoc: true });
  const id = f.store.change('Add', (tx) => tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'a'], x: 0, y: 0, w: 10, h: 10, fill: null, stroke: null })) && f.store.live()[0].id;
  assert.equal(await moveIn(f.ctx, id, f.to, { page: 0, x: 1, y: 1 }), false);
  assert.equal(f.journal.busy, false);
});

test('in: an item removed while the draft saved leaves the paste alone in the journal, and a later undo does not throw', async () => {
  const f = fixture();
  const id = f.store.change('Add', (tx) => tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'a'], x: 0, y: 0, w: 10, h: 10, fill: null, stroke: null })) && f.store.live()[0].id;
  f.ctx.saveDoc = async (sid) => {
    f.log.push(`${sid}.save`);
    f.store.change('Delete', (tx) => tx.remove(id));
    return true;
  };
  assert.equal(await moveIn(f.ctx, id, f.to, { page: 0, x: 1, y: 1 }), true);
  assert.deepEqual(f.grouped.at(-1).map((p) => p.kind), ['doc'], 'no board part for a step that was never made');
  await assert.doesNotReject(f.journal.undo());
});

test('in: the item is removed the way a Delete removes it, so the tools that free what it holds are asked', async () => {
  const f = fixture();
  const asked = [];
  registerTool({ removing: (ctx, ids, tx) => asked.push([ids, typeof tx.remove]) });
  const id = f.store.change('Add', (tx) => tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'a'], x: 0, y: 0, w: 10, h: 10, fill: null, stroke: null })) && f.store.live()[0].id;
  assert.equal(await moveIn(f.ctx, id, f.to, { page: 0, x: 1, y: 1 }), true);
  assert.deepEqual(asked, [[[id], 'function']]);
});

test('across: a floating object is pasted at the drop point of its new page, through the item session', async () => {
  const f = fixture();
  assert.equal(await moveAcross(f.ctx, f.from, f.to, { page: 3, x: 50, y: 60, at: { x: 12.5, y: 40.25 } }), true);
  assert.deepEqual(f.to.pasted, ['item'], 'from the item session that holds the placed copy');
  const float = f.item.opened.body[0].objects[0].float;
  assert.deepEqual([float.wrap, float.hRel, float.vRel, float.x, float.y], ['inFrontOfText', 'page', 'page', 12.5, 40.25], 'its own wrap stays');
});

test('across: an object in a line of text, and text, come from the first draft as they are', async () => {
  const inline = { ...picture, float: { wrap: 'inline' } };
  const f = fixture({ saveModel: model([para(OBJ, null, [inline])], { media: { 'image1.png': 'data:image/png;base64,AAECAw==' } }) });
  assert.equal(await moveAcross(f.ctx, f.from, f.to, { page: 0, x: 50, y: 60, at: { x: 1, y: 2 } }), true);
  assert.deepEqual(f.to.pasted, ['from']);
});

test('within: Alt on a floating object copies it to the drop point and leaves the original; one in a line copies to the text position', async () => {
  const f = fixture();
  assert.equal(await moveWithin(f.ctx, f.from, { page: 1, x: 40, y: 50, at: { x: 33, y: 44 } }, { copy: true, object: { floating: true } }), true);
  assert.deepEqual(f.from.many, [['arrange.copyTo', { page: 1, x: 33, y: 44 }]]);
  assert.equal(await moveWithin(f.ctx, f.from, { page: 1, x: 40, y: 50 }, { copy: true, object: { floating: false } }), true);
  assert.deepEqual(f.from.many, [['arrange.copyTo', { to: { story: 'body', path: [0], off: 1 } }]]);
  assert.equal(await moveWithin(f.ctx, f.from, { page: 1, x: 40, y: 50 }, { copy: true, object: null }), true);
  assert.equal(f.from.many[1][0], 'edit.moveTo');
  assert.equal(f.from.many[1][1].copy, true);
});

test('a failure after the cut is told apart from one before it', async () => {
  const after = fixture();
  after.journal.group = () => {
    throw new Error('the journal broke');
  };
  after.ctx.cutDone = false;
  await assert.rejects(moveOut(after.ctx, after.from, at));
  assert.equal(after.ctx.cutDone, true, 'the page had lost it');
  assert.equal(after.journal.busy, false);
  const before = fixture();
  before.item.save = async () => {
    throw new Error('the item session broke');
  };
  before.ctx.cutDone = false;
  await assert.rejects(moveOut(before.ctx, before.from, at));
  assert.equal(before.ctx.cutDone, false);
  assert.equal(before.journal.busy, false);
});

test('in: paste, save the draft, remove the item, save the board', async () => {
  const f = fixture();
  const id = f.store.change('Add', (tx) => tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'a'], x: 10, y: 20, w: 100, h: 50, fill: [255, 0, 0], stroke: null })) && f.store.live()[0].id;
  f.log.length = 0;
  assert.equal(await moveIn(f.ctx, id, f.to, { page: 0, x: 40, y: 50, at: { x: 33, y: 44 } }), true);
  assert.deepEqual(f.log.filter((l) => !l.endsWith('.steps') && !l.endsWith('.hit')), ['item.open', 'item.select.all', 'item.edit.copy',
    'to.pasteSession', 'to.save', 'board.Drag in', 'journal.group', 'board.save']);
});

test('in: a draft save that fails undoes the paste and keeps the item', async () => {
  const f = fixture({ failDoc: true });
  const id = f.store.change('Add', (tx) => tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'a'], x: 10, y: 20, w: 100, h: 50, fill: null, stroke: null })) && f.store.live()[0].id;
  assert.equal(await moveIn(f.ctx, id, f.to, { page: 0, x: 40, y: 50 }), false);
  assert.equal(f.to.undone, 1, 'the paste is undone through the draft');
  assert.ok(!f.store.get(id).gone, 'the item stays');
  assert.deepEqual(f.said, ['The document could not be saved, so nothing moved.']);
});

test('in: a picture floats in front of the text at the drop point of its page, with its turn', async () => {
  const f = fixture();
  f.store.board.media['k.png'] = 'data:image/png;base64,AAECAw==';
  f.ctx.media = new Map([['k.png', new Uint8Array([0, 1, 2, 3])]]);
  const id = f.store.change('Add', (tx) => tx.create({ type: 'picture', media: 'k.png', crop: [0, 0, 0, 0], look: {}, at: [null, 'a'], x: 0, y: 0, w: 80, h: 40, rot: 15, flipY: true }))
    && f.store.live()[0].id;
  assert.equal(await moveIn(f.ctx, id, f.to, { page: 2, x: 40, y: 50, at: { x: 33.5, y: 44.25 } }), true);
  const float = f.item.opened.body[0].objects[0].float;
  assert.deepEqual([float.wrap, float.hRel, float.vRel, float.x, float.y, float.rot, float.flipV], ['inFrontOfText', 'page', 'page', 33.5, 44.25, 15, true]);
});

test('in: a connector stays on the board', async () => {
  const f = fixture();
  const id = f.store.change('Add', (tx) => tx.create({ type: 'connector', at: [null, 'a'] })) && f.store.live()[0].id;
  assert.equal(await moveIn(f.ctx, id, f.to, { page: 0, x: 1, y: 1 }), false);
  assert.deepEqual(f.said, ['Connectors stay on the whiteboard.']);
});

test('across: paste into the other draft, save it, then cut from the first', async () => {
  const f = fixture();
  assert.equal(await moveAcross(f.ctx, f.from, f.to, { page: 0, x: 10, y: 10 }), true);
  assert.deepEqual(f.log.filter((l) => !l.endsWith('.steps') && !l.endsWith('.hit')), ['from.edit.copy', 'item.open', 'item.pasteSession', 'item.save',
    'to.pasteSession', 'to.save', 'from.edit.cut', 'from.save', 'journal.group']);
  const [parts] = f.grouped;
  assert.deepEqual(parts.map((p) => [p.session, !!p.adds]), [['to', false], ['from', true]]);
});

test('across: a save of the target that fails undoes the paste and cuts nothing', async () => {
  const f = fixture({ failDoc: true });
  assert.equal(await moveAcross(f.ctx, f.from, f.to, { page: 0, x: 10, y: 10 }), false);
  assert.equal(f.to.undone, 1);
  assert.ok(!f.log.includes('from.edit.cut'));
});

test('the journal undoes a move out by putting the content back before the item goes, and a move in by the item first', async () => {
  const f = fixture();
  const order = [];
  f.journal.real.get(f.from).undo = async () => order.push('doc.undo');
  const id = await moveOut(f.ctx, f.from, at);
  const bu = f.store.undo.bind(f.store);
  f.store.undo = (step) => (order.push('board.undo'), bu(step));
  f.from.stack.push('step-cut'); // the step the journal checks is still the top one
  assert.equal(await f.journal.undo(), true);
  assert.deepEqual(order, ['doc.undo', 'board.undo'], 'the page has it again before the board lets go');
  assert.ok(f.store.get(id).gone);

  // A move in: its undo brings the item back to the board (and saves it) before the page loses the paste.
  const g = fixture();
  const item = g.store.change('Add', (tx) => tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'a'], x: 0, y: 0, w: 10, h: 10, fill: null, stroke: null })) && g.store.live()[0].id;
  const seq = [];
  g.journal.real.get(g.to).undo = async () => seq.push('doc.undo');
  const saves = [];
  g.journal.save = async () => (saves.push('board.save'), seq.push('board.save'), true);
  await moveIn(g.ctx, item, g.to, { page: 0, x: 1, y: 1 });
  seq.length = 0;
  const bu2 = g.store.undo.bind(g.store);
  g.store.undo = (step) => (seq.push('board.undo'), bu2(step));
  assert.equal(await g.journal.undo(), true);
  assert.deepEqual(seq, ['board.undo', 'board.save', 'doc.undo']);
  assert.ok(!g.store.get(item).gone, 'the item is back');
});

test('refusal names comments and tracked changes anywhere in the blocks, and nothing else', () => {
  assert.equal(refusal(model([para('plain')])), null);
  assert.equal(refusal(model([para(`${OBJ}x`, null, [{ type: 'commentStart', id: 1 }])])), REFUSED);
  assert.equal(refusal(model([{ kind: 'para', text: 'x', runs: [{ len: 1, props: { ins: 0 } }] }])), REFUSED);
  assert.equal(refusal(model([{ kind: 'table', rows: [{ cells: [{ blocks: [{ kind: 'para', text: 'x', runs: [{ len: 1, props: { del: 2 } }] }] }] }] }])), REFUSED);
  assert.equal(refusal(model([para('x')], { comments: { 0: { author: 'a' } } })), REFUSED);
  assert.equal(refusal(JSON.stringify(model([para('x')], { revisions: [{ kind: 'insert' }] }))), REFUSED);
});

test('fieldsOf: a picture keeps its crop, size, turn and look, and the engine key until the board names it', () => {
  const f = fieldsOf(model([para(OBJ, null, [picture])]), { x: 12.5, y: 7 });
  assert.deepEqual([f.type, f.media, f.crop, f.alt, f.x, f.y, f.w, f.h, f.rot, f.flipX, f.flipY], ['picture', 'image1.png', [0.1, 0.2, 0.1, 0.2], 'cat', 12.5, 7, 100, 50, 30, true, undefined]);
  assert.deepEqual(f.look, { fx: { shadow: 1 } }, 'what places it on a page is not its look');
});

test('fieldsOf: a shape with a text box gives its label story and its look', () => {
  const part = { kind: 'textBox', blocks: [para('Label', { style: 'Heading1' })], body: { vert: 'horz', anchor: 'center' } };
  const shape = { type: 'shape', kind: 'ellipse', w: 120, h: 60, fill: [1, 2, 3], stroke: [4, 5, 6], stroke_width: 2, extra: { arrow_end: true },
    float: { wrap: 'inFrontOfText', hRel: 'page', vRel: 'page', x: 0, y: 0, dist: 0, distTop: 0, distBottom: 0, effect: [0, 0, 0, 0], flipV: true }, story: 1 };
  const styles = { ...saved.styles, styles: [{ id: 'Heading1', basedOn: 'Normal', chr: { size: 16 } }, { id: 'Normal' }, { id: 'Unused' }] };
  const f = fieldsOf(model([para(OBJ, null, [shape])], { parts: { 1: part }, styles }), { x: 1, y: 2 });
  assert.deepEqual([f.type, f.kind, f.fill, f.stroke, f.strokeWidth, f.w, f.h, f.flipY, f.extra], ['shape', 'ellipse', [1, 2, 3], [4, 5, 6], 2, 120, 60, true, { arrow_end: true }]);
  assert.equal(f.story.blocks[0].text, 'Label');
  const kept = f.story.styles.styles.map((s) => s.id);
  assert.ok(kept.includes('Heading1') && kept.includes('Normal') && !kept.includes('Unused'), kept.join());
});

test('fieldsOf: a styled numbered paragraph is a text that keeps its style, its list and the width it needs', () => {
  const body = [para('First line', { style: 'Heading1', numbering: { num: 9, level: 0 } })];
  const styles = { ...saved.styles, styles: [{ id: 'Heading1', basedOn: 'Normal', chr: { size: 16, bold: true } }, { id: 'Normal' }, { id: 'Unused' }] };
  const numbering = { abstracts: [{ id: 1, levels: [{ format: 'decimal', text: '%1.' }] }, { id: 2, levels: [] }], nums: [{ id: 9, abstractId: 1 }, { id: 8, abstractId: 2 }] };
  const f = fieldsOf(model(body, { styles, numbering }), { x: 0, y: 0 }, { w: 127.3 });
  assert.deepEqual([f.type, f.fit, f.w], ['text', 'height', 129.3]);
  assert.equal(f.story.blocks[0].props.style, 'Heading1');
  assert.deepEqual(f.story.numbering.nums.map((n) => n.id), [9]);
  assert.ok(f.story.styles.styles.some((s) => s.id === 'Heading1' && s.chr.bold === true));
});

test('fieldsOf: the empty paragraphs a paste leaves round a whole paragraph and before a table are not part of the item', () => {
  const heading = fieldsOf(model([para('Heading line', { style: 'Heading1' }), para('')]), { x: 0, y: 0 });
  assert.deepEqual(heading.story.blocks.map((b) => b.text), ['Heading line']);
  const table = { kind: 'table', grid: [100], rows: [] };
  const fromTable = fieldsOf(model([para(''), table, para('')]), { x: 0, y: 0 });
  assert.deepEqual(fromTable.story.blocks.map((b) => b.kind), ['table', 'para'], 'the paragraph a table needs after it stays');
  assert.equal(fieldsOf(model([para('one'), para('')]), { x: 0, y: 0 }).story.blocks.length, 1);
  assert.equal(fieldsOf(model([para('')]), { x: 0, y: 0 }).story.blocks.length, 1, 'a lone empty paragraph is the text');
});

test('fieldsOf: a table is a text as wide as its columns, capped at 480 points', () => {
  const table = { kind: 'table', grid: [150, 150, 150], rows: [{ cells: [{ blocks: [para('')] }] }] };
  assert.equal(fieldsOf(model([table, para('')]), { x: 0, y: 0 }).w, 462);
  const wide = { kind: 'table', grid: [300, 300], rows: [] };
  assert.equal(fieldsOf(model([wide, para('')]), { x: 0, y: 0 }).w, 480);
  assert.equal(fieldsOf(model([table, para('')]), { x: 0, y: 0 }).story.blocks[0].kind, 'table');
});

test('two boards keep their own drag out: unmounting one leaves the hook and the state of the other', () => {
  const win = { addEventListener() {}, removeEventListener() {} };
  const board = () => ({ vp: { root: { ownerDocument: { defaultView: win }, addEventListener() {}, removeEventListener() {} } } });
  const [a, b] = [board(), board()];
  const offA = dragout.mount(a);
  const offB = dragout.mount(b);
  assert.ok(pointerOptions.textDrag);
  assert.notEqual(a.dragout.state, b.dragout.state, 'what each board draws is its own');
  offB();
  assert.ok(pointerOptions.textDrag, 'the first board can still drag out');
  offA();
  assert.equal(pointerOptions.textDrag, null, 'the last board takes the hook of the engine with it');
});

/** A board with two documents' pages and a text item, for dropTarget. */
function board() {
  const store = new BoardStore(blankBoard(), { client: 'c' });
  const ids = {};
  store.change('Add', (tx) => {
    ids.doc = tx.create({ type: 'doc', draft: 'd', at: [null, 'a'], x: 0, y: 0, w: 300, h: 400 });
    ids.text = tx.create({ type: 'text', at: [null, 'b'], story: { blocks: [para('hi')] }, fit: 'fixed', x: 20, y: 20, w: 100, h: 40 });
  });
  const rects = [{ x: 0, y: 0, w: 100, h: 200 }, { x: 150, y: 0, w: 100, h: 200 }];
  return { store, ids, instances: { rectsFor: (item) => (item.id === ids.doc ? rects : []) } };
}

test('dropTarget prefers a page to a text item over it, and Space keeps the drop free', () => {
  const ctx = board();
  const over = { x: 50, y: 30 }; // on page 0 and on the text item
  const page = dropTarget(ctx, over, {});
  assert.deepEqual([page.kind, page.doc, page.page, page.x, page.y], ['page', ctx.ids.doc, 0, 50, 30]);
  assert.deepEqual(dropTarget(ctx, { x: 200, y: 100 }, {}).page, 1);
  assert.deepEqual(dropTarget(ctx, over, { space: true }), { kind: 'text', id: ctx.ids.text });
  assert.deepEqual(dropTarget(ctx, { x: 130, y: 100 }, {}), { kind: 'plane' }, 'between the pages');
  assert.equal(dropTarget(ctx, over, { start: { doc: ctx.ids.doc, page: 0 } }).own, true);
});

test('dropTarget takes no page of a locked document: it answers locked, and a document under it is not reached', () => {
  const ctx = board();
  ctx.store.change('Lock', (tx) => tx.set(ctx.ids.doc, 'locked', true));
  assert.deepEqual(dropTarget(ctx, { x: 50, y: 30 }, {}), { kind: 'locked', doc: ctx.ids.doc });
  assert.deepEqual(dropTarget(ctx, { x: 50, y: 30 }, { space: true }), { kind: 'text', id: ctx.ids.text }, 'Space keeps a drop free of it too');
  assert.deepEqual(dropTarget(ctx, { x: 130, y: 100 }, {}), { kind: 'plane' });
});
