// engine-build-git (docs/plans/engine/viewport-design.md sections 11 and 16, P2b): git carries no engine build, a checkout
// without Rust gets a plain message that names the toolchain, and the release workflow builds the engine in one Ubuntu job whose
// only build command is the script's --ci mode, then hands the files to the Windows and Mac jobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { pins } from '../scripts/build-engine-wasm.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const built = ['ew.js', 'ew_bg.wasm', 'STAMP'].map((f) => `src/engine/wasm/${f}`);

test('git tracks only package.json under src/engine/wasm and ignores the build', () => {
  assert.deepEqual(git('ls-files', 'src/engine/wasm'), ['src/engine/wasm/package.json']);
  assert.deepEqual(git('check-ignore', ...built), built);
});

test('a build without Rust stops with a message that names the toolchain', () => {
  // PATH holds only node's folder, so neither rustc nor wasm-bindgen runs.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  env.PATH = path.dirname(process.execPath);
  const script = new URL('../scripts/build-engine-wasm.mjs', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { tools } from '${script}'; tools(process.env, false);`],
    { env, encoding: 'utf8' });
  const { rust, bindgen } = pins();
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^engine wasm: Rust is not installed\./);
  assert.ok(r.stderr.includes(`Rust ${rust}`) && r.stderr.includes(`wasm-bindgen-cli ${bindgen}`), r.stderr);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'a plain message, not a stack trace');
});

test('the release workflow builds the engine once and hands it to the Windows and Mac jobs', () => {
  const { jobs } = yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8'));
  const engine = jobs.engine;
  assert.equal(engine['runs-on'], 'ubuntu-latest');
  assert.equal(String(engine.env.WASM_BINDGEN), pins().bindgen, 'the job installs the wasm-bindgen ew/Cargo.toml pins');

  // Its one build command is the script's --ci mode; the other run steps only install the pinned tools, and binaryen (wasm-opt)
  // in a step the release goes on without (word-release-wasm-opt.test.mjs).
  const runs = engine.steps.filter((s) => s.run && s.name !== 'Binaryen').map((s) => s.run.trim());
  assert.deepEqual(runs.filter((r) => r.includes('build-engine-wasm')), ['node scripts/build-engine-wasm.mjs --ci']);
  for (const r of runs.filter((r) => !r.includes('build-engine-wasm'))) {
    for (const line of r.split('\n')) assert.match(line.trim(), /^(rustup toolchain install|command -v wasm-bindgen .*\|\| cargo install wasm-bindgen-cli )/, line);
  }
  const upload = engine.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
  assert.deepEqual(upload.with.path.trim().split('\n'), built);

  for (const id of ['win', 'mac']) {
    const job = jobs[id];
    assert.ok(job.needs.includes('engine'), `${id} waits for the engine job`);
    const at = (pred) => job.steps.findIndex(pred);
    const download = at((s) => s.uses?.startsWith('actions/download-artifact@'));
    assert.ok(download >= 0, `${id} downloads the engine`);
    assert.equal(job.steps[download].with.name, upload.with.name);
    assert.equal(job.steps[download].with.path, 'src/engine/wasm');
    assert.ok(download < at((s) => s.run === 'npm run build'), `${id} has the engine before npm run build`);
  }
});
