// engine-fixes-edit (docs/plans/word/briefs/engine-fixes-edit.md): a reader that measures a draft waits for the fonts on their
// way. A caret read right after an open came back 50 pt above its line while the draft's fonts still arrived; whenSettled
// resolves only once they are in and the layout they make is settled. Over a stand-in Worker that answers every call at once.
// The harness case .smoke-data/word/cases/engine-fixes-edit.js checks the package's other items in the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeWorker {
  static all = [];
  sent = [];
  answers = {};
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m) {
    this.sent.push(m);
    if (m.id) queueMicrotask(() => this.onmessage({ data: { id: m.id, result: this.answers[m.method] ?? true } }));
  }
  terminate() {}
}
globalThis.Worker = FakeWorker;

test('whenSettled waits for the fonts on their way, then for the layout they make', async () => {
  const { EngineHost } = await import('../src/engine/client.js');
  FakeWorker.all.length = 0;
  const host = new EngineHost(new URL('file:///worker.js'), { fonts: false });
  const w = FakeWorker.all[0];
  let arrive;
  let pending = new Promise((r) => (arrive = r));
  host.fonts = { ready: () => pending, stop() {} };
  const s = host.session('s');
  let done = false;
  const p = s.whenSettled().then(() => (done = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false, 'not while fonts are on their way');
  // The fonts' layout is in slices: settled again only at its layout event.
  w.answers.settled = false;
  arrive();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false, 'not while the fonts\' layout is in slices');
  w.answers.settled = true;
  w.onmessage({ data: { event: 'layout', data: { settled: true }, session: 's' } });
  await p;
  pending = Promise.resolve();
  host.terminate();
});
