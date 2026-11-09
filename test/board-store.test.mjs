import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_KEY, between, after, spread } from '../src/board/order.mjs';
import { FORM, VERSION, blankBoard, newId, readForm, stampAfter, BoardStore } from '../src/board/store.mjs';

const cloneBoard = (board) => structuredClone(board);

test('between picks a key strictly inside its bounds', () => {
  assert.equal(between(null, null), 'V');
  assert.equal(between('V', null), 'W');
  assert.equal(between(null, 'V'), 'F');
  assert.equal(between('V', 'W'), 'VV');
  assert.equal(between('V', 'X'), 'W');
});

test('after steps past the last character that is not z', () => {
  assert.equal(after('V'), 'W');
  assert.equal(after('Vz'), 'W');
  assert.equal(after('z'), 'z1');
  assert.equal(after('zz'), 'zz1');
  assert.equal(after('z'.repeat(MAX_KEY - 1)).length, MAX_KEY);
  assert.throws(() => after('z'.repeat(MAX_KEY)), /64/);
  let key = 'V';
  for (let i = 0; i < 1000; i++) {
    const next = after(key);
    assert.ok(next > key, `${next} sorts after ${key}`);
    assert.ok(next.length <= 17, `${next} is longer than 17`);
    key = next;
  }
});

test('between throws on unordered or unbounded keys', () => {
  assert.throws(() => between('V', 'V'));
  assert.throws(() => between('W', 'V'));
  assert.throws(() => between('V', `V${'0'.repeat(MAX_KEY - 1)}`), /64/);
  assert.throws(() => between('z'.repeat(MAX_KEY), null), /64/);
});

test('spread lays keys evenly across the shortest length', () => {
  assert.deepEqual(spread(3), ['F', 'V', 'k']);
  const keys = spread(20);
  assert.ok(keys.every((k) => k.length === 2));
  assert.deepEqual(keys, [...keys].sort());
});

test('10,000 inserts at one spot through orderKey stay sorted and bounded', () => {
  const store = new BoardStore(blankBoard());
  store.change('seed', (tx) => {
    tx.create({ id: 'a', type: 'shape', at: [null, 'V'] });
    tx.create({ id: 'b', type: 'shape', at: [null, 'W'] });
  });
  let events = 0;
  for (let i = 0; i < 10000; i++) {
    store.change('insert', (tx) => {
      let rekeyed = false;
      const set = tx.set;
      tx.set = (id, field, value) => {
        if (field === 'at') rekeyed = true;
        set(id, field, value);
      };
      tx.create({ type: 'shape', at: [null, store.orderKey(null, 1, tx)] });
      if (rekeyed) events++;
    });
  }
  const keys = store.children(null).map((item) => item.at[1]);
  assert.ok(keys.length > 10000);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i] > keys[i - 1], `${keys[i]} follows ${keys[i - 1]}`);
  assert.ok(keys.every((k) => k.length <= MAX_KEY));
  assert.ok(events >= 1, 'the spot ran out of room at least once');
  assert.ok(events < 500, `${events} rekey events is far past the brief's 32`);
});

test('10,000 appends keep every key at most 64 characters and in order', () => {
  const store = new BoardStore(blankBoard(), { client: 'a' });
  for (let i = 0; i < 10000; i++) {
    store.change('append', (tx) => {
      const key = store.orderKey(null, store.children(null).length, tx);
      assert.ok(key.length <= MAX_KEY, `append ${i} made a ${key.length}-character key`);
      tx.create({ type: 'shape', at: [null, key] });
    });
  }
  const keys = store.children(null).map((item) => item.at[1]);
  assert.equal(keys.length, 10000);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i] > keys[i - 1], `${keys[i]} follows ${keys[i - 1]}`);
  assert.ok(keys.every((k) => k.length <= MAX_KEY));
});

test('two clients that pick one key keep both, ordered by id, and the next insert lands between them', () => {
  const board = blankBoard();
  board.items.p = { id: 'p', type: 'shape', at: [null, 'V'], _s: { at: [1, 'z'] } };
  board.items.q = { id: 'q', type: 'shape', at: [null, 'W'], _s: { at: [1, 'z'] } };
  const a = new BoardStore(cloneBoard(board), { client: 'a' });
  const b = new BoardStore(cloneBoard(board), { client: 'b' });
  let ai;
  let bi;
  a.change('add', (tx) => { ai = tx.create({ type: 'shape', at: [null, a.orderKey(null, 1, tx)] }); });
  b.change('add', (tx) => { bi = tx.create({ type: 'shape', at: [null, b.orderKey(null, 1, tx)] }); });
  assert.equal(a.get(ai).at[1], 'VV');
  assert.equal(b.get(bi).at[1], 'VV');

  const both = new BoardStore(cloneBoard(board));
  both.receive(a.deltaSince(both.seen()));
  both.receive(b.deltaSince(both.seen()));
  const ids = both.children(null).map((item) => item.id);
  assert.deepEqual(ids, ['p', ...[ai, bi].sort(), 'q']);

  let ci;
  both.change('add', (tx) => { ci = tx.create({ type: 'shape', at: [null, both.orderKey(null, 2, tx)] }); });
  const keys = both.children(null).map((item) => item.at[1]);
  assert.deepEqual(keys, [...keys].sort());
  const [before, afterKey] = [ai, bi].sort().map((id) => both.get(id).at[1]);
  const landed = both.get(ci).at[1];
  assert.ok(before < landed && landed < afterKey, `${before} < ${landed} < ${afterKey}`);
});

test('field last writer wins by clock then client', () => {
  const store = new BoardStore(blankBoard());
  store.receive([{ i: 'x', f: 'fill', v: 'red', s: [5, 'a'] }]);
  store.receive([{ i: 'x', f: 'fill', v: 'green', s: [4, 'b'] }]);
  assert.equal(store.get('x').fill, 'red');
  store.receive([{ i: 'x', f: 'fill', v: 'blue', s: [5, 'b'] }]);
  assert.equal(store.get('x').fill, 'blue');
  store.receive([{ i: 'x', f: 'fill', v: 'black', s: [6, 'a'] }]);
  assert.equal(store.get('x').fill, 'black');
  assert.equal(stampAfter([5, 'b'], [5, 'a']), true);
  assert.equal(stampAfter(undefined, [0, '']), false);
});

test('two stores joined by a link converge when their ops arrive in either order', () => {
  const board = blankBoard();
  board.items.it = { id: 'it', type: 'shape', at: [null, 'V'], _s: { at: [1, 'z'] } };
  const a = new BoardStore(cloneBoard(board), { client: 'a' });
  const b = new BoardStore(cloneBoard(board), { client: 'b' });
  const sentA = [];
  const sentB = [];
  a.link = { send: (ops) => sentA.push(...ops) };
  b.link = { send: (ops) => sentB.push(...ops) };
  a.change('one', (tx) => tx.set('it', 'x', 1));
  a.change('two', (tx) => tx.set('it', 'y', 2));
  a.change('three', (tx) => tx.set('it', 'w', 3));
  b.change('one', (tx) => tx.set('it', 'fill', 'red'));
  b.change('two', (tx) => tx.set('it', 'opacity', 0.5));

  const first = new BoardStore(cloneBoard(board));
  first.receive(sentA);
  first.receive(sentB);
  const second = new BoardStore(cloneBoard(board));
  second.receive(sentB);
  second.receive(sentA);
  assert.deepEqual(first.board.items, second.board.items);
  assert.equal(first.get('it').x, 1);
  assert.equal(first.get('it').fill, 'red');
});

test('merge is commutative and the log replays to the same items', () => {
  const base = blankBoard();
  const a = new BoardStore(cloneBoard(base), { client: 'a' });
  const b = new BoardStore(cloneBoard(base), { client: 'b' });
  let id;
  a.change('add', (tx) => { id = tx.create({ id: 'n', type: 'shape', at: [null, 'V'], fill: 'red' }); });
  a.change('move', (tx) => tx.set(id, 'x', 10));
  b.change('add', (tx) => { tx.create({ id: 'n', type: 'shape', at: [null, 'V'], fill: 'blue' }); });
  b.change('name', (tx) => tx.set(id, 'name', 'B'));

  const ab = new BoardStore(cloneBoard(base));
  ab.merge(a.board);
  ab.merge(b.board);
  const ba = new BoardStore(cloneBoard(base));
  ba.merge(b.board);
  ba.merge(a.board);
  assert.deepEqual(ab.board.items, ba.board.items);

  const replay = new BoardStore(cloneBoard(base));
  for (const op of a.log) replay.receive([op]);
  assert.deepEqual(replay.board.items, a.board.items);

  const made = new BoardStore(blankBoard(), { client: 'a' });
  made.change('add', (tx) => tx.create({ id: 'd', type: 'shape', at: [null, 'V'], fill: 'red' }));
  const delta = new BoardStore(blankBoard());
  delta.receive(made.deltaSince(delta.seen()));
  assert.deepEqual(delta.board.items, made.board.items);
});

test('merge carries a field that a peer deleted', () => {
  const base = blankBoard();
  const a = new BoardStore(cloneBoard(base), { client: 'a' });
  const b = new BoardStore(cloneBoard(base), { client: 'b' });
  a.change('create', (tx) => tx.create({ id: 'n', type: 'shape', at: [null, 'V'] }));
  b.merge(a.board);
  b.change('blue', (tx) => tx.set('n', 'fill', 'blue'));
  a.change('red', (tx) => tx.set('n', 'fill', 'red'));
  a.change('x', (tx) => tx.set('n', 'x', 1));
  a.undo();
  a.undo();
  assert.equal('fill' in a.get('n'), false);

  const fromA = new BoardStore(cloneBoard(a.board), { client: 'x' });
  fromA.merge(b.board);
  const fromB = new BoardStore(cloneBoard(b.board), { client: 'y' });
  fromB.merge(a.board);
  assert.equal('fill' in fromA.get('n'), false);
  assert.deepEqual(fromA.board.items, fromB.board.items);
});

test('a lost op is recovered by a full delta after a later op arrives', () => {
  const a = new BoardStore(blankBoard(), { client: 'a' });
  const sent = [];
  a.link = { send: (ops) => sent.push(...ops) };
  a.change('create', (tx) => tx.create({ id: 'n', type: 'shape', at: [null, 'V'] }));
  a.change('x', (tx) => tx.set('n', 'x', 1));
  a.change('y', (tx) => tx.set('n', 'y', 2));
  const peer = new BoardStore(blankBoard(), { client: 'p' });
  peer.receive(sent.filter((op) => op.f !== 'x'));
  assert.equal(peer.get('n').y, 2);
  assert.equal(peer.get('n').x, undefined);
  peer.receive(a.deltaSince({}));
  assert.equal(peer.get('n').x, 1);
  assert.deepEqual(peer.board.items, a.board.items);
});

test('merge picks the same media as it does in either order', () => {
  const a = new BoardStore(blankBoard(), { client: 'a' });
  const b = new BoardStore(blankBoard(), { client: 'b' });
  a.board.media = { k: 'data:one' };
  b.board.media = { k: 'data:two' };
  const ab = new BoardStore(blankBoard());
  ab.merge(a.board);
  ab.merge(b.board);
  const ba = new BoardStore(blankBoard());
  ba.merge(b.board);
  ba.merge(a.board);
  assert.equal(ab.board.media.k, 'data:two');
  assert.deepEqual(ab.board.media, ba.board.media);
});

test('deltaSince rebuilds a peer after a reload with an empty log', () => {
  const a = new BoardStore(blankBoard(), { client: 'a' });
  a.change('create', (tx) => tx.create({ id: 'n', type: 'shape', at: [null, 'V'], x: 1 }));
  const reloaded = new BoardStore(JSON.parse(JSON.stringify(a.toJSON())), { client: 'a2' });
  assert.equal(reloaded.log.length, 0);
  const peer = new BoardStore(blankBoard(), { client: 'p' });
  peer.receive(reloaded.deltaSince(peer.seen()));
  assert.deepEqual(peer.board.items, reloaded.board.items);
});

test('a version vector sends ops a Lamport clock would skip', () => {
  const base = blankBoard();
  const a = new BoardStore(cloneBoard(base), { client: 'a' });
  const b = new BoardStore(cloneBoard(base), { client: 'b' });
  const c = new BoardStore(cloneBoard(base), { client: 'c' });
  a.change('create', (tx) => tx.create({ id: 'n', type: 'shape', at: [null, 'V'] }));
  for (let i = 0; i < 10; i++) a.change('x', (tx) => tx.set('n', 'x', i));
  b.receive(a.deltaSince(b.seen()));
  c.receive(a.deltaSince(c.seen()).slice(0, 3));
  c.change('late', (tx) => tx.set('n', 'name', 'late'));
  a.receive(c.deltaSince(a.seen()));
  assert.equal(a.get('n').name, 'late');
  b.receive(a.deltaSince(b.seen()));
  assert.equal(b.get('n').name, 'late');
});

test('undo of a create hides it and redo shows every field', () => {
  const store = new BoardStore(blankBoard());
  let id;
  const step = store.change('add', (tx) => { id = tx.create({ type: 'shape', at: [null, 'V'], fill: 'red' }); });
  assert.ok(step);
  assert.equal(store.canUndo(), true);
  store.undo();
  assert.equal(store.get(id).gone, true);
  assert.ok(!store.live().some((item) => item.id === id));
  assert.equal(store.canRedo(), true);
  store.redo();
  const item = store.get(id);
  assert.equal(item.gone, false);
  assert.equal(item.type, 'shape');
  assert.equal(item.fill, 'red');
  assert.deepEqual(item.at, [null, 'V']);
  assert.ok(store.live().some((live) => live.id === id));
});

test('delete and undo bring back every field', () => {
  const store = new BoardStore(blankBoard());
  let id;
  store.change('add', (tx) => { id = tx.create({ id: 'del', type: 'shape', at: [null, 'V'], fill: 'red', stroke: 'blue' }); });
  store.change('mark', (tx) => tx.set(id, 'opacity', 0.4));
  store.change('delete', (tx) => tx.remove(id));
  assert.equal(store.get(id).gone, true);
  store.undo();
  assert.equal(store.get(id).gone, false);
  assert.equal(store.get(id).fill, 'red');
  assert.equal(store.get(id).stroke, 'blue');
  assert.equal(store.get(id).opacity, 0.4);
  assert.deepEqual(store.get(id).at, [null, 'V']);
});

test('undoing a delete carries the fields to a peer that stripped the item', () => {
  const base = blankBoard();
  const quiet = { silent: true };
  const a = new BoardStore(cloneBoard(base), { client: 'a' });
  const b = new BoardStore(cloneBoard(base), { client: 'b' });
  a.change('create', (tx) => tx.create({ id: 'n', type: 'shape', at: [null, 'V'], x: 1 }), quiet);
  b.merge(a.board);
  b.change('delete', (tx) => tx.remove('n'));
  a.change('move', (tx) => tx.set('n', 'x', 99), quiet);
  a.merge(b.board);
  assert.equal(a.get('n').gone, true);
  const unstripped = new BoardStore(cloneBoard(a.board), { client: 'c' });
  const stripped = new BoardStore(JSON.parse(JSON.stringify(a.toJSON())), { client: 'a2' });
  assert.equal(stripped.get('n').x, undefined);

  b.undo();
  for (const peer of [unstripped, stripped]) peer.receive(b.deltaSince(peer.seen()));
  assert.equal('x' in stripped.get('n'), true);
  assert.equal(stripped.get('n').gone, false);
  assert.equal(stripped.get('n').x, unstripped.get('n').x);
  assert.deepEqual(stripped.board.items, unstripped.board.items);
});

test('Figma rule: redo is read when the undo happens', () => {
  const store = new BoardStore(blankBoard());
  let id;
  store.change('add', (tx) => { id = tx.create({ type: 'shape', at: [null, 'V'] }); });
  store.change('red', (tx) => tx.set(id, 'fill', 'red'));
  store.undo();
  assert.equal(store.get(id).fill, undefined);
  store.receive([{ i: id, f: 'fill', v: 'blue', s: [store.board.clock + 1, 'zz'] }]);
  assert.equal(store.get(id).fill, 'blue');
  store.redo();
  assert.equal(store.get(id).fill, 'red');
  store.undo();
  assert.equal(store.get(id).fill, 'blue');
});

test('a concurrent parent cycle keeps both items live and the walk ends', () => {
  const a = new BoardStore(blankBoard(), { client: 'a' });
  a.change('add', (tx) => {
    tx.create({ id: 'p', type: 'group', at: [null, 'V'] });
    tx.create({ id: 'q', type: 'group', at: ['p', 'V'] });
  });
  const b = new BoardStore(blankBoard(), { client: 'b' });
  b.change('add', (tx) => {
    tx.create({ id: 'q', type: 'group', at: [null, 'V'] });
    tx.create({ id: 'p', type: 'group', at: ['q', 'V'] });
  });
  const store = new BoardStore(blankBoard());
  store.merge(a.board);
  store.merge(b.board);
  assert.deepEqual(store.get('p').at, ['q', 'V']);
  assert.deepEqual(store.get('q').at, ['p', 'V']);
  const seen = [];
  const walk = (parent) => {
    for (const item of store.children(parent)) {
      seen.push(item.id);
      walk(item.id);
    }
  };
  walk(null);
  assert.deepEqual(seen.sort(), ['p', 'q']);
  assert.deepEqual(store.live().map((item) => item.id).sort(), ['p', 'q']);
});

test('three replicas converge over forward, reversed, shuffled and repeated delivery', () => {
  const rng = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const canon = (v) =>
    JSON.stringify(v, (k, x) =>
      x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.keys(x).sort().map((q) => [q, x[q] === undefined ? null : x[q]]))
        : x,
    );
  const liveIds = (s) => s.live().map((i) => i.id).join(',');
  const ids = ['p', 'q', 'r', 's', 't'];
  const bad = { items: 0, live: 0, index: 0, merge: 0 };
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const base = blankBoard();
    const reps = ['a', 'b', 'c'].map((c) => new BoardStore(cloneBoard(base), { client: c }));
    reps[0].change('create', (tx) => {
      for (const id of ids) tx.create({ id, type: 'group', at: [null, between(null, null) + id] });
    });
    for (const peer of reps.slice(1)) peer.merge(reps[0].board);
    for (let k = 0; k < 25; k++) {
      const rep = reps[Math.floor(r() * 3)];
      const id = ids[Math.floor(r() * 5)];
      const op = r();
      rep.change('edit', (tx) => {
        if (op < 0.35) tx.set(id, 'at', [r() < 0.3 ? null : ids[Math.floor(r() * 5)], between(null, null) + Math.floor(r() * 3)]);
        else if (op < 0.5) tx.remove(id);
        else if (op < 0.65) tx.set(id, 'x', Math.floor(r() * 5));
        else if (op < 0.8) tx.set(id, 'fill', r() < 0.5 ? { c: 1 } : undefined);
        else if (!rep.canUndo()) tx.set(id, 'name', `n${k}`);
      });
      if (op >= 0.8 && r() < 0.5) rep.undo();
      else if (r() < 0.1) rep.redo();
    }
    const all = reps.flatMap((peer) => peer.log);
    const build = (order, twice) => {
      const store = new BoardStore(cloneBoard(base), { client: 'z' });
      let ops = [...all];
      if (order === 'rev') ops.reverse();
      else if (order === 'shuf') ops.sort(() => r() - 0.5);
      if (twice) ops = [...ops, ...ops.slice(0, 40)];
      for (const op of ops) store.receive([structuredClone(op)]);
      return store;
    };
    const built = [build('fwd'), build('rev'), build('shuf', true)];
    const sig = (s) => canon(s.board.items);
    if (new Set(built.map(sig)).size > 1) bad.items++;
    if (new Set(built.map(liveIds)).size > 1) bad.live++;
    for (const store of built) {
      const rebuilt = new BoardStore(cloneBoard(store.board), { client: 'f' });
      if (liveIds(rebuilt) !== liveIds(store)) {
        bad.index++;
        break;
      }
    }
    const merged = [[0, 1, 2], [2, 1, 0], [1, 2, 0, 1]].map((order) => {
      const store = new BoardStore(cloneBoard(base), { client: 'm' });
      for (const i of order) store.merge(reps[i].board);
      return store;
    });
    if (new Set(merged.map(sig)).size > 1) bad.merge++;
  }
  assert.deepEqual(bad, { items: 0, live: 0, index: 0, merge: 0 });
});

test('toJSON keeps gone fields while a step names the item and cuts them after', () => {
  const store = new BoardStore(blankBoard(), { limit: 1 });
  store.board.media = { m1: 'data:one', m2: 'data:two' };
  store.change('add', (tx) => {
    tx.create({ id: 'g', type: 'picture', at: [null, 'V'], media: 'm1', fill: 'red' });
  });
  const live = store.toJSON();
  assert.equal(live.media.m1, 'data:one');
  assert.equal('m2' in live.media, false);
  store.change('delete', (tx) => tx.remove('g'));
  const kept = store.toJSON();
  assert.equal(kept.items.g.fill, 'red');
  assert.equal(kept.items.g.media, 'm1');

  store.change('add other', (tx) => tx.create({ id: 'o', type: 'shape', at: [null, 'W'] }));
  const cut = store.toJSON();
  assert.deepEqual(cut.items.g, { id: 'g', type: 'picture', gone: true, _s: { gone: cut.items.g._s.gone } });
  assert.equal('fill' in cut.items.g, false);
});

test('toJSON keeps unknown top-level fields and bg merges by stamp', () => {
  const board = blankBoard();
  board.future = { a: 1 };
  const store = new BoardStore(board);
  assert.deepEqual(store.toJSON().future, { a: 1 });

  const a = new BoardStore(blankBoard(), { client: 'a' });
  const b = new BoardStore(blankBoard(), { client: 'b' });
  a.change('dots', (tx) => tx.board('bg', 'dots'));
  b.change('grid', (tx) => tx.board('bg', 'grid'));
  b.change('grid again', (tx) => tx.board('bg', 'grid'));
  const ab = new BoardStore(blankBoard());
  ab.merge(a.board);
  ab.merge(b.board);
  const ba = new BoardStore(blankBoard());
  ba.merge(b.board);
  ba.merge(a.board);
  assert.equal(ab.board.bg, 'grid');
  assert.equal(ab.board.bg, ba.board.bg);
  assert.deepEqual(ab.board._s.bg, ba.board._s.bg);
});

test('a change whose body throws leaves the board as it was', () => {
  const store = new BoardStore(blankBoard(), { client: 'a' });
  const sent = [];
  store.link = { send: (ops) => sent.push(...ops) };
  assert.throws(() =>
    store.change('boom', (tx) => {
      tx.create({ id: 'n', type: 'shape', at: [null, 'V'] });
      throw new Error('boom');
    }),
  );
  assert.equal(store.get('n'), undefined);
  assert.equal(store.steps.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(store.log.length, 0);

  store.change('ok', (tx) => tx.create({ id: 'm', type: 'shape', at: [null, 'V'], x: 1 }));
  const before = structuredClone(store.board.items);
  assert.throws(() =>
    store.change('boom', (tx) => {
      tx.set('m', 'x', 2);
      tx.set('m', 'name', 'gone');
      throw new Error('boom');
    }),
  );
  assert.deepEqual(store.board.items, before);
  assert.equal(store.steps.length, 1);
});

test('an item is live only when it has a type', () => {
  const store = new BoardStore(blankBoard());
  store.receive([{ i: 'q', f: 'x', v: 1, s: [1, 'a'] }]);
  assert.deepEqual(store.live(), []);
  store.receive([{ i: 'q', f: 'type', v: 'shape', s: [2, 'a'] }]);
  assert.deepEqual(store.live().map((item) => item.id), ['q']);
});

test('stored values are copies of what the caller passed', () => {
  const store = new BoardStore(blankBoard());
  const fill = { c: 'red' };
  store.change('create', (tx) => tx.create({ id: 'n', type: 'shape', at: [null, 'V'], fill }));
  fill.c = 'blue';
  assert.equal(store.get('n').fill.c, 'red');

  const peer = new BoardStore(blankBoard());
  peer.merge(store.board);
  assert.notEqual(peer.get('n').fill, store.get('n').fill);
  peer.get('n').fill.c = 'green';
  assert.equal(store.get('n').fill.c, 'red');

  const field = { z: 1 };
  store.change('set', (tx) => tx.set('n', 'extra', field));
  field.z = 2;
  assert.equal(store.get('n').extra.z, 1);
});

test('silent changes make ops with no step, and subscribe reports steps', () => {
  const store = new BoardStore(blankBoard());
  const events = [];
  const off = store.subscribe((event) => events.push(event));
  let id;
  store.change('add', (tx) => { id = tx.create({ type: 'shape', at: [null, 'V'] }); });
  assert.equal(events.length, 1);
  assert.ok(events[0].step);
  assert.ok(events[0].ids.has(id));

  const quiet = store.change('quiet', (tx) => tx.set(id, 'fill', 'red'), { silent: true });
  assert.equal(quiet, null);
  assert.equal(store.get(id).fill, 'red');
  assert.equal(events.length, 2);
  assert.equal(events[1].step, null);

  store.receive([{ i: id, f: 'name', v: 'peer', s: [store.board.clock + 1, 'z'] }]);
  assert.equal(events[2].step, null);
  store.undo();
  assert.equal(store.canUndo(), false);
  off();
  store.change('after off', (tx) => tx.set(id, 'x', 1));
  assert.equal(events.length, 4);
});

test('a silent change keeps the redo stack', () => {
  const store = new BoardStore(blankBoard());
  store.change('add', (tx) => tx.create({ id: 'n', type: 'shape', at: [null, 'V'] }));
  store.change('move', (tx) => tx.set('n', 'x', 1));
  store.undo();
  assert.equal(store.canRedo(), true);
  store.change('quiet', (tx) => tx.set('n', 'y', 1), { silent: true });
  assert.equal(store.canRedo(), true);
});

test('readForm tells a board from a newer or old one', () => {
  assert.equal(readForm({ form: FORM, version: VERSION }), 'board');
  assert.equal(readForm({ form: FORM, version: 2 }), 'newer');
  assert.equal(readForm({ items: [] }), 'old');
  assert.equal(readForm(null), 'old');
});

test('newId is 16 base36 characters and at required on create', () => {
  const id = newId();
  assert.equal(id.length, 16);
  assert.match(id, /^[0-9a-z]{16}$/);
  const store = new BoardStore(blankBoard());
  assert.throws(() => store.change('bad', (tx) => tx.create({ type: 'shape' })));
  assert.throws(() => store.change('bad', (tx) => tx.create({ at: [null, 'V'] })));
  assert.deepEqual(blankBoard(), { form: FORM, version: VERSION, clock: 0, items: {}, media: {}, bg: 'canvas', frame: null, _s: {} });
});
