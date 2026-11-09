// engine-warm-scope: client.js warmEngine never competes with a real open. Busy at the start, nothing starts; busy once the warm
// draft is under way, the draft is dropped at its next step. Over a stand-in Worker that answers every call at once. Each test
// imports its own copy of client.js (a query string), because warmEngine runs once per window.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeWorker {
  static all = [];
  sent = [];
  constructor(url) {
    this.url = String(url);
    FakeWorker.all.push(this);
  }
  postMessage(m) {
    this.sent.push(m);
    if (m.id) queueMicrotask(() => this.onmessage({ data: { id: m.id, result: true } }));
  }
  terminate() {}
}

globalThis.Worker = FakeWorker;
globalThis.document ??= { baseURI: 'file:///app/' };

test('busy at the start: no worker starts and the warm draft is skipped', async () => {
  FakeWorker.all = [];
  const { warmEngine } = await import('../src/engine/client.js?skipped');
  const warm = await warmEngine({ busy: () => true });
  assert.equal(warm.draft, 'skipped');
  assert.equal(FakeWorker.all.length, 0);
});

test('busy once the warm draft is under way: the draft is dropped at its next step and its session closes', async () => {
  FakeWorker.all = [];
  const { engineHost, warmEngine } = await import('../src/engine/client.js?dropped');
  // A page area starts opening once the warm draft's paste was sent.
  const busy = () => !!FakeWorker.all[0]?.sent.some((m) => m.method === 'paste');
  const warm = await warmEngine({ busy });
  assert.equal(warm.draft, 'dropped');
  assert.deepEqual(FakeWorker.all[0].sent.filter((m) => m.session === '\u0000warm').map((m) => m.method), ['paste', 'close']);
  assert.ok(engineHost().helperRunning, 'the workers it started stay for the open');
  engineHost().terminate();
});

test('another session open: the warm draft is skipped too', async () => {
  FakeWorker.all = [];
  const { engineHost, warmEngine } = await import('../src/engine/client.js?session');
  const real = engineHost().session('draft-1');
  const warm = await warmEngine();
  assert.equal(warm.draft, 'skipped');
  assert.equal(FakeWorker.all.length, 1, 'only the worker the real session started');
  real.release();
  engineHost().terminate();
});
