// engine-soon (docs/plans/engine/stage3-forum.md C5): an agent's or the smoke script's call waits for the canvas page area to
// open the draft it was just handed, and stops at once when the call is cancelled (Stop) or the page area is not showing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineSoon } from '../src/app/engine-soon.mjs';

const CLIENT = { id: 'd1' };
const read = (s) => () => s;

test('engineSoon returns the session\'s client once the page area has it', async () => {
  const ticks = [{ focus: null, areaOpens: true, draftId: 'd1' }, { focus: null, areaOpens: true, draftId: 'd1' }, { focus: CLIENT, areaOpens: true, draftId: 'd1' }];
  let i = 0;
  const client = await engineSoon({ id: 'd1', read: () => ticks[Math.min(i++, ticks.length - 1)], every: 1 });
  assert.equal(client, CLIENT);
  assert.ok(i >= 3);
});

test('engineSoon stops when the call is cancelled, without polling to the end', async () => {
  const ac = new AbortController();
  let n = 0;
  const reading = () => { if (++n === 2) ac.abort(); return { focus: null, areaOpens: true, draftId: 'd1' }; };
  assert.equal(await engineSoon({ id: 'd1', read: reading, signal: ac.signal, ms: 60000, every: 1 }), false);
  assert.ok(n <= 3, `read ${n} times, not for the whole wait`);
});

test('engineSoon gives up when the page area is not showing the draft, or another draft is open', async () => {
  assert.equal(await engineSoon({ id: 'd1', read: read({ focus: null, areaOpens: false, draftId: 'd1' }), every: 1 }), false);
  assert.equal(await engineSoon({ id: 'd1', read: read({ focus: null, areaOpens: true, draftId: 'd2' }), every: 1 }), false);
});

test('engineSoon gives up after its time, without a session', async () => {
  let n = 0;
  const reading = () => (++n, { focus: null, areaOpens: true, draftId: 'd1' });
  assert.equal(await engineSoon({ id: 'd1', read: reading, ms: 30, every: 1 }), false);
  assert.ok(n > 1, 'it polled while it waited');
});
