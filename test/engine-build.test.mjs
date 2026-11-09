// engine-build (docs/plans/engine/viewport-design.md section 16, P2): the built engine is this checkout's (its stamp, STAMP and
// the sources agree), it ships without its name section while the build cache keeps a copy with it, and the build lock waits
// for a live build and takes over one whose process is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSync, buildStamp } from '../src/engine/wasm/ew.js';
import { cache, freshen, locked, sourceHash, sources } from '../scripts/build-engine-wasm.mjs';

const wasm = fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url));
const stamp = fs.readFileSync(new URL('../src/engine/wasm/STAMP', import.meta.url), 'utf8').trim();
const names = (bytes) => WebAssembly.Module.customSections(new WebAssembly.Module(bytes), 'name').length;

test('the built engine carries the stamp of these sources', () => {
  initSync({ module: wasm });
  assert.equal(stamp, sourceHash(), 'STAMP is the hash of engine/: run npm run build');
  assert.equal(buildStamp(), stamp);
});

test('the app gets the .wasm without its name section, and the cache keeps the one with it', () => {
  assert.equal(names(wasm), 0);
  const full = path.join(cache, stamp, 'ew_bg.full.wasm');
  if (!fs.existsSync(full)) return console.log('no cached build of these sources on this machine');
  const kept = fs.readFileSync(full);
  assert.equal(names(kept), 1);
  console.log(`ew_bg.wasm ${wasm.length} bytes, ${kept.length} with its name section`);
});

test('the build lock waits for a live build and takes over a dead one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easywriter-engine-lock-'));
  const file = path.join(dir, 'build.lock');
  const hold = (pid) => fs.writeFileSync(file, JSON.stringify({ pid, root: 'elsewhere', at: Date.now() }));

  hold(spawnSync(process.execPath, ['-e', '']).pid);
  assert.equal(locked(file, () => 'ran'), 'ran', 'a lock whose process is gone is taken over');
  assert.ok(!fs.existsSync(file), 'and released');

  // The live holder marks its end before it lets the lock go, so a build that ran before that finds no mark.
  const done = path.join(dir, 'done');
  const holder = spawn(process.execPath, ['-e', `setTimeout(() => { const fs = require('fs'); fs.writeFileSync(${JSON.stringify(done)}, ''); `
    + `fs.rmSync(${JSON.stringify(file)}); }, 1500)`]);
  await new Promise((r) => holder.once('spawn', r));
  hold(holder.pid);
  assert.equal(locked(file, () => fs.existsSync(done)), true, 'the build ran after the live build let the lock go');
  fs.rmSync(done);
  fs.rmdirSync(dir);
});

test('a source file that differs from the shared target\'s last build gets a new time, however old it was', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easywriter-engine-freshen-'));
  const record = path.join(dir, 'target.json');
  const old = new Date('2020-01-01');
  const put = (f, text) => (fs.writeFileSync(path.join(dir, f), text), fs.utimesSync(path.join(dir, f), old, old));
  const touched = () => ['a.rs', 'b.rs'].filter((f) => fs.statSync(path.join(dir, f)).mtimeMs > old.getTime());
  const files = () => sources(dir).filter(([f]) => f.endsWith('.rs'));
  put('a.rs', 'fn a() {}');
  put('b.rs', 'fn b() {}');

  freshen(files(), dir, record)();
  assert.deepEqual(touched(), ['a.rs', 'b.rs'], 'with no record of the last build, every file');

  put('a.rs', 'fn a() {}');
  put('b.rs', 'fn b() { /* another worktree */ }');
  freshen(files(), dir, record); // and cargo fails: the record is not called, so b.rs stays unknown
  assert.deepEqual(touched(), ['b.rs'], 'only the file whose content changed');

  put('b.rs', 'fn b() { /* another worktree */ }');
  freshen(files(), dir, record);
  assert.deepEqual(touched(), ['b.rs'], 'after a failed build, b.rs again');
  for (const f of ['a.rs', 'b.rs', 'target.json']) fs.rmSync(path.join(dir, f));
  fs.rmdirSync(dir);
});
