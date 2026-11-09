import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardStore, blankBoard } from '../src/board/store.mjs';
import { Journal } from '../src/board/journal.mjs';

const tick = () => new Promise((done) => setTimeout(done, 0));

/** A document session's client with only what the journal reads: its own undo and redo stacks and its layout events. */
class FakeSession {
  constructor(id, steps = []) {
    this.id = id;
    this.stack = [...steps];
    this.redos = [];
    this.log = [];
    this.listeners = new Map();
  }

  async steps() {
    return { undo: this.stack.at(-1) ?? null, redo: this.redos.at(-1) ?? null };
  }

  undo() {
    this.log.push('undo');
    const step = this.stack.pop() ?? null;
    if (step != null) this.redos.push(step);
    this.layout();
    return step;
  }

  redo() {
    this.log.push('redo');
    const step = this.redos.pop() ?? null;
    if (step != null) this.stack.push(step);
    this.layout();
    return step;
  }

  on(event, fn) {
    this.listeners.set(event, fn);
    return () => this.listeners.delete(event);
  }

  layout() {
    this.listeners.get('layout')?.({ steps: { undo: this.stack.at(-1) ?? null, redo: this.redos.at(-1) ?? null } });
  }

  /** An edit with its own undo step. */
  edit(step) {
    this.stack.push(step);
    this.redos = [];
    this.layout();
  }

  /** Typing that joins the open step: the same top id, laid out again. */
  extend() {
    this.layout();
  }
}

/** A board store, its undo and redo logged, and a journal over it with one document session provisioned. */
function fixture({ save = async () => true, saveDoc = async () => true } = {}) {
  const boardLog = [];
  const store = new BoardStore(blankBoard(), { client: 'c' });
  const undo = store.undo.bind(store);
  const redo = store.redo.bind(store);
  store.undo = (id) => {
    boardLog.push(['board.undo', id]);
    return undo(id);
  };
  store.redo = (id) => {
    boardLog.push(['board.redo', id]);
    return redo(id);
  };
  const sessions = new Map();
  const saves = [];
  const savesBoard = [];
  const said = [];
  const journal = new Journal({
    store,
    clients: (id) => sessions.get(id) ?? null,
    titleOf: (id) => `Title ${id}`,
    say: (line) => said.push(line),
    save: async () => {
      savesBoard.push('board');
      return save();
    },
    saveDoc: async (id) => {
      saves.push(id);
      return saveDoc(id);
    },
  });
  return { store, journal, sessions, saves, savesBoard, said, boardLog };
}

const create = (store, key = 'A') => store.change('Add', (tx) => tx.create({ type: 'shape', at: [null, key], x: 0, y: 0, w: 10, h: 10 }));

test('board, doc and board steps undo in reverse and redo forward', async () => {
  const f = fixture();
  const doc = new FakeSession('doc', ['d1']);
  f.sessions.set('doc', doc);
  const b1 = create(f.store, 'A');
  f.journal.noteBoard(b1);
  f.journal.noteDoc('doc', 'd1');
  const b2 = f.store.change('Move', (tx) => tx.set(b1.id, 'x', 50));
  f.journal.noteBoard(b2);
  assert.equal(f.journal.entries.length, 3);

  for (let i = 0; i < 3; i++) assert.equal(await f.journal.undo(), true);
  assert.deepEqual(f.boardLog, [['board.undo', b2.id], ['board.undo', b1.id]]);
  assert.deepEqual(doc.log, ['undo']);
  assert.equal(f.journal.canRedo(), true);

  for (let i = 0; i < 3; i++) assert.equal(await f.journal.redo(), true);
  assert.deepEqual(f.boardLog, [['board.undo', b2.id], ['board.undo', b1.id], ['board.redo', b1.id], ['board.redo', b2.id]]);
  assert.deepEqual(doc.log, ['undo', 'redo']);
  assert.deepEqual(f.saves, ['doc']); // a redo brings content back, so it saves the document
});

test('a group of a doc step and a board step is one undo, doc first and saved before the board runs', async () => {
  const f = fixture();
  const doc = new FakeSession('doc', ['d1']);
  f.sessions.set('doc', doc);
  const b = create(f.store);
  f.journal.noteBoard(b);
  f.journal.noteDoc('doc', 'd1');
  f.journal.group([{ kind: 'doc', session: 'doc', step: 'd1', adds: true }, { kind: 'board', step: b }]);
  assert.equal(f.journal.entries.length, 1);

  assert.equal(await f.journal.undo(), true);
  assert.deepEqual(doc.log, ['undo']);
  assert.deepEqual(f.saves, ['doc']); // saveDoc runs after the doc undo, before the board part
  assert.deepEqual(f.boardLog, [['board.undo', b.id]]);
  assert.equal(f.journal.entries.length, 0);
});

test('a doc step whose session moved on drops the entry, says once, and runs nothing', async () => {
  const f = fixture();
  const doc = new FakeSession('doc', ['d1']);
  f.sessions.set('doc', doc);
  const b = create(f.store);
  f.journal.noteBoard(b);
  f.journal.noteDoc('doc', 'd1');
  doc.stack.push('d2');

  assert.equal(await f.journal.undo(), false);
  assert.deepEqual(f.said, ['The last change in "Title doc" was made somewhere else, so it was not undone.']);
  assert.deepEqual(doc.log, []);
  assert.deepEqual(f.boardLog, []);
  assert.equal(f.journal.canRedo(), false);

  assert.equal(await f.journal.undo(), true);
  assert.deepEqual(f.boardLog, [['board.undo', b.id]]);
});

test('a closed client counts as a session that moved on', async () => {
  const f = fixture();
  f.sessions.set('doc', new FakeSession('doc', ['d1']));
  f.journal.noteDoc('doc', 'd1');
  f.sessions.delete('doc');
  assert.equal(await f.journal.undo(), false);
  assert.equal(f.said.length, 1);
});

test('two letters under one step id are one entry', () => {
  const f = fixture();
  f.sessions.set('doc', new FakeSession('doc', ['d1']));
  f.journal.noteDoc('doc', 'd1');
  f.journal.noteDoc('doc', 'd1');
  assert.equal(f.journal.entries.length, 1);
});

test('a doc step undone in its own view takes its group entry and board part with it', async () => {
  const f = fixture();
  const b = create(f.store);
  f.journal.noteBoard(b);
  f.journal.group([{ kind: 'doc', session: 'doc', step: 'd1', adds: true }, { kind: 'board', step: b }]);
  assert.equal(f.journal.entries.length, 1);

  f.journal.docUndone('doc', 'd1');
  assert.equal(f.journal.entries.length, 0);
  assert.deepEqual(f.boardLog, [['board.undo', b.id]]);
});

test('a new step clears the redo list', async () => {
  const f = fixture();
  f.journal.noteBoard(create(f.store, 'A'));
  assert.equal(await f.journal.undo(), true);
  assert.equal(f.journal.canRedo(), true);
  f.journal.noteBoard(create(f.store, 'B'));
  assert.equal(f.journal.canRedo(), false);
});

test('the document record is saved through saveDoc, and a false answer puts the entry back', async () => {
  const f = fixture({ saveDoc: async () => false });
  const doc = new FakeSession('doc', ['d1']);
  f.sessions.set('doc', doc);
  const b = create(f.store);
  f.journal.group([{ kind: 'doc', session: 'doc', step: 'd1', adds: true }, { kind: 'board', step: b }]);

  assert.equal(await f.journal.undo(), false);
  assert.deepEqual(doc.log, ['undo']); // the document was restored
  assert.deepEqual(f.saves, ['doc']);
  assert.deepEqual(f.boardLog, []); // the removal never ran
  assert.equal(f.journal.entries.length, 1); // and the entry is back where it was
  assert.equal(f.journal.redos.length, 0);
  assert.equal(f.journal.busy, false);
  assert.match(f.said[0], /^The last change in "Title doc" could not be saved, so it was not undone\.$/);
});

test('a save that throws stops the undo like a false answer, and does not throw itself', async () => {
  const f = fixture({
    saveDoc: async () => {
      throw new Error('the disk is full');
    },
  });
  f.sessions.set('doc', new FakeSession('doc', ['d1']));
  const b = create(f.store);
  f.journal.group([{ kind: 'doc', session: 'doc', step: 'd1', adds: true }, { kind: 'board', step: b }]);

  assert.equal(await f.journal.undo(), false);
  assert.deepEqual(f.boardLog, []);
  assert.equal(f.journal.entries.length, 1);
  assert.equal(f.said.length, 1);
});

test('a board save that answers false stops the undo and puts the entry back', async () => {
  const f = fixture({ save: async () => false });
  const id = create(f.store).undo[0].i;
  const del = f.store.change('Delete', (tx) => tx.remove(id));
  f.journal.noteBoard(del);

  assert.equal(await f.journal.undo(), false);
  assert.deepEqual(f.boardLog, [['board.undo', del.id]]); // the content came back...
  assert.equal(f.store.live().length, 1);
  assert.equal(f.journal.entries.length, 1); // ...but its save failed, so the entry is back
  assert.equal(f.journal.redos.length, 0);
  assert.equal(f.said.length, 1);
});

test('a board entry another path rebuilt is skipped, and the next entry runs', async () => {
  const f = fixture();
  const x = create(f.store, 'X');
  f.journal.noteBoard(x);
  const first = create(f.store, 'A');
  f.journal.noteBoard(first);
  const doc = new FakeSession('doc', ['d1']);
  f.sessions.set('doc', doc);
  f.journal.noteDoc('doc', 'd1');
  // The arrow keys' nudge join: the store undoes its own last step and makes a new one, which the journal notes on top.
  f.store.undo(first.id);
  f.boardLog.length = 0; // the nudge join's own store undo is not the journal's
  const second = create(f.store, 'B');
  f.journal.noteBoard(second);
  assert.equal(f.journal.entries.length, 4);

  assert.equal(await f.journal.undo(), true); // the new nudge step
  assert.equal(await f.journal.undo(), true); // the document step
  assert.equal(await f.journal.undo(), true); // the rebuilt step is skipped, the first entry runs
  assert.deepEqual(f.boardLog, [['board.undo', second.id], ['board.undo', x.id]]);
  assert.equal(f.journal.canUndo(), false);
});

test('typing that joins the open step after a board change starts a new entry, above it', async () => {
  const f = fixture();
  const doc = new FakeSession('doc', []);
  f.sessions.set('doc', doc);
  f.journal.watch(doc);
  await tick();
  doc.edit(1);
  await tick();
  assert.equal(f.journal.entries.length, 1);

  const b = create(f.store);
  f.journal.noteBoard(b);
  doc.extend(); // the engine keeps the same step id: the letters came after the board change
  await tick();
  assert.equal(f.journal.entries.length, 2);
  assert.equal(f.journal.entries.at(-1).parts[0].kind, 'doc');

  assert.equal(await f.journal.undo(), true);
  assert.deepEqual(doc.log, ['undo']);
  assert.deepEqual(f.boardLog, []); // the document step is above the board change
  assert.equal(await f.journal.undo(), true);
  assert.deepEqual(f.boardLog, [['board.undo', b.id]]);
});

test('an edit laid out before the baseline arrives is noted once the baseline lands', async () => {
  const f = fixture();
  const doc = new FakeSession('doc', []);
  let release;
  doc.steps = () => new Promise((done) => {
    release = done;
  });
  f.sessions.set('doc', doc);
  f.journal.watch(doc);
  doc.edit(1); // the layout event arrives while client.steps() is still out
  assert.equal(f.journal.entries.length, 0);
  release({ undo: null, redo: null });
  await tick();
  assert.equal(f.journal.entries.length, 1);
});

test('unwatch takes the override and the registration back off', async () => {
  const f = fixture();
  const doc = new FakeSession('doc', []);
  f.sessions.set('doc', doc);
  const off = f.journal.watch(doc);
  assert.equal(f.journal.watched.get('doc'), doc);
  assert.ok(f.journal.real.has(doc));
  const override = doc.undo;
  off();
  assert.equal(f.journal.watched.has('doc'), false);
  assert.equal(f.journal.real.has(doc), false);
  assert.notEqual(doc.undo, override);
  doc.undo();
  assert.deepEqual(doc.log, ['undo']);
});

test('a document step and its undo tell the chrome the stacks changed', async () => {
  let calls = 0;
  const store = new BoardStore(blankBoard(), { client: 'c' });
  const doc = new FakeSession('doc', ['d1']);
  const journal = new Journal({ store, clients: (id) => (id === 'doc' ? doc : null), changed: () => { calls++; } });
  journal.noteDoc('doc', 'd1'); // a document-only entry: Undo works, though the store has no step
  assert.equal(calls, 1);
  assert.equal(journal.canUndo(), true);
  assert.equal(await journal.undo(), true);
  assert.equal(calls, 2);
  assert.equal(journal.canUndo(), false);
  assert.equal(journal.canRedo(), true);
});

test('a closed session’s doc parts go from both stacks, a board part in the same entry staying', async () => {
  const f = fixture();
  const doc = new FakeSession('doc', ['d1', 'd2']);
  f.sessions.set('doc', doc);
  const b = create(f.store);
  f.journal.group([{ kind: 'board', step: b }, { kind: 'doc', session: 'doc', step: 'd1' }]); // one entry of both
  f.journal.noteDoc('doc', 'd2');
  assert.equal(f.journal.entries.length, 2);
  f.journal.forget('doc');
  assert.equal(f.journal.entries.length, 1, 'the entry holding only a doc part goes');
  assert.deepEqual(f.journal.entries[0].parts.map((part) => part.kind), ['board'], 'the board part stays');
  assert.equal(await f.journal.undo(), true, 'the board part still undoes without its document');
  assert.deepEqual(f.boardLog.at(-1), ['board.undo', b.id]);
});
