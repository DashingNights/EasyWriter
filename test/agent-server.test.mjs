import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

// agent-server.js needs Electron's app and ipcMain: stand-ins in the require cache.
const require = createRequire(import.meta.url);
const ipcMain = new EventEmitter();
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { on() {}, getPath: () => '.' }, ipcMain } };
const server = require('../src/agent-server.js');

const sent = [];
const webContents = { send: (_ch, ev) => sent.push(ev) };
server.register(() => {}, () => ({ isDestroyed: () => false, webContents }), async () => ({}));

test('a reload fails the calls the page was running; calls sent before agent.ready wait for the next one', async () => {
  const session = {};
  ipcMain.emit('agent.ready', { sender: webContents });
  const running = server.run(session, 1, { id: 'doc.read' });
  assert.equal(sent.at(-1).rid, 1); // dispatched
  server.reset();
  assert.equal((await running).error.code, 'failed');

  const queued = server.run(session, 2, { id: 'doc.read' });
  const before = sent.length;
  server.reset(); // the reload's own did-navigate: nothing was sent, nothing fails
  ipcMain.emit('agent.ready', { sender: webContents });
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).rid, 2);
  ipcMain.emit('agent.reply', { sender: webContents }, 2, { ok: true });
  assert.deepEqual(await queued, { ok: true });
});
