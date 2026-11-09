// engine-gate-prep: client.js warmEngine starts the window's engine worker and the helper before the first open, over a
// stand-in Worker that answers every call at once and records what it was sent.
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
    if (m.method === 'want') queueMicrotask(() => this.onmessage({ data: { event: 'tiles', data: { list: [] }, session: m.args[0][0].session } }));
  }
  terminate() {
    this.ended = true;
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('warmEngine starts the engine worker and the helper once, opens no session, and the helper waits for its first job', async () => {
  globalThis.Worker = FakeWorker;
  globalThis.document ??= { baseURI: 'file:///app/' };
  const { engineHost, warmEngine } = await import('../src/engine/client.js');
  const host = engineHost();
  host.helperIdle = 5;
  host.warmIdle = 60;
  const first = warmEngine();
  assert.equal(warmEngine(), first, 'one start per window');
  const warm = await first;
  assert.ok(warm.worker >= 0 && warm.helper >= warm.worker && warm.ms >= warm.helper, JSON.stringify(warm));
  const [worker, helper] = FakeWorker.all;
  assert.equal(FakeWorker.all.length, 2);
  assert.match(worker.url, /worker\.js$/);
  assert.match(helper.url, /helper\.js$/);
  assert.ok(worker.sent.some((m) => m.method === 'sessions' && !('session' in m)), 'a worker-wide call, not a session\'s');
  // A warm draft through the open path and one tile painted, in a session that closes after it.
  assert.deepEqual(helper.sent.map((m) => m.method ?? 'module'), ['module', 'stats', 'engineForm']);
  assert.deepEqual(worker.sent.filter((m) => m.session === '\u0000warm').map((m) => m.method), ['paste', 'save', 'ahead', 'open', 'pages', 'close']);
  assert.equal(worker.sent.find((m) => m.method === 'want')?.args[0][0].session, '\u0000warm');
  assert.deepEqual(host.ids(), []);

  // Started ahead, the helper outlives helperIdle until a job comes; after the job it closes when idle as before.
  await tick(20);
  assert.ok(host.helperRunning && !helper.ended);
  await host.helper().call('engineForm', [new Uint8Array(1), 'docx']);
  await tick(30);
  assert.ok(!host.helperRunning && helper.ended);

  // With no job it closes after warmIdle (idleFor), so a window that never opens a Document there frees its memory.
  host.helper().idleFor(10);
  await tick(30);
  assert.ok(!host.helperRunning);
  host.terminate();
});
