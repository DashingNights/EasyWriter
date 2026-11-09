// release-wasm-opt: the release build passes wasm-opt the features the module lists in its target_features section, under
// binaryen's flag names, and a wasm-opt that is missing or rejects the module leaves the build unoptimised instead of failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { features, optimise } from '../scripts/build-engine-wasm.mjs';

/** A module with only a target_features section listing `list` ([prefix, name]), as the linker writes it. */
function module(list) {
  const leb = (n) => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, ...leb(n >> 7)]);
  const str = (s) => [...leb(s.length), ...Buffer.from(s)];
  const body = [...str('target_features'), ...leb(list.length), ...list.flatMap(([prefix, name]) => [prefix.charCodeAt(0), ...str(name)])];
  return Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0, ...leb(body.length), ...body]);
}

test('the features the module uses become binaryen flags, the ones it disallows do not', () => {
  // Rust 1.96's list for the engine, as the built module carries it, and one disallowed feature.
  const list = ['bulk-memory', 'bulk-memory-opt', 'call-indirect-overlong', 'multivalue', 'mutable-globals', 'nontrapping-fptoint',
    'reference-types', 'sign-ext', 'simd128'].map((f) => ['+', f]);
  const bytes = module([...list, ['-', 'atomics'], ['=', 'tail-call']]);
  assert.ok(WebAssembly.validate(bytes), 'the test module is valid wasm');
  // Flag names from wasm-opt --help.
  assert.deepEqual(features(bytes), ['--enable-bulk-memory', '--enable-bulk-memory-opt', '--enable-call-indirect-overlong',
    '--enable-multivalue', '--enable-mutable-globals', '--enable-nontrapping-float-to-int', '--enable-reference-types',
    '--enable-sign-ext', '--enable-simd', '--enable-tail-call']);
  assert.deepEqual(features(Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])), [], 'a module without the section');
});

test('the built engine module still carries its target_features section after wasm-bindgen', (t) => {
  const file = new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url);
  if (!fs.existsSync(file)) return t.skip('no engine build in this checkout (npm run build makes it)');
  const bytes = fs.readFileSync(file);
  assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(bytes), 'target_features').length, 1);
  assert.ok(features(bytes).includes('--enable-reference-types'), features(bytes).join(' '));
});

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-wasm-opt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const full = path.join(dir, 'ew_bg.full.wasm');
  fs.writeFileSync(full, module([['+', 'simd128']]));
  return { full, app: path.join(dir, 'ew_bg.wasm'), bytes: fs.readFileSync(full) };
}

test('a wasm-opt that rejects the module in its second run leaves the named module as it was and warns', (t) => {
  const { full, app, bytes } = scratch(t);
  const log = t.mock.method(console, 'log', () => {});
  let runs = 0;
  const ok = optimise(full, app, (cmd, args) => {
    if (++runs === 2) throw new Error('Command failed: wasm-opt --strip-debug\n[wasm-validator error] unexpected feature');
    fs.writeFileSync(args.at(-1), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])); // the first run's output
  });
  assert.equal(ok, false);
  assert.ok(fs.readFileSync(full).equals(bytes), 'the named module is the one wasm-bindgen wrote');
  assert.deepEqual(fs.readdirSync(path.dirname(full)), ['ew_bg.full.wasm'], 'no half-made output is left');
  assert.match(log.mock.calls.at(-1).arguments[0], /^::warning::engine wasm: wasm-opt failed \(Command failed: wasm-opt --strip-debug\)/);
});

test('a missing wasm-opt falls back the same way', (t) => {
  const { full, app } = scratch(t);
  t.mock.method(console, 'log', () => {});
  const missing = (cmd) => {
    throw Object.assign(new Error(`spawnSync ${cmd} ENOENT`), { code: 'ENOENT' });
  };
  assert.equal(optimise(full, app, missing), false);
  assert.ok(!fs.existsSync(app));
});

test('a wasm-opt that works gets the features and replaces the named module', (t) => {
  const { full, app } = scratch(t);
  t.mock.method(console, 'log', () => {});
  const calls = [];
  // Each run writes a valid module naming its input, so the test sees which file went where.
  const ok = optimise(full, app, (cmd, args) => {
    calls.push([cmd, ...args]);
    fs.writeFileSync(args.at(-1), module([['+', path.basename(args.at(-3))]]));
  });
  assert.equal(ok, true);
  assert.deepEqual(calls.map((c) => c.slice(0, 4)), [['wasm-opt', '-Oz', '-g', '--enable-simd'], ['wasm-opt', '--strip-debug', '--enable-simd', `${full}.opt`]]);
  assert.deepEqual(features(fs.readFileSync(full)), ['--enable-ew_bg.full.wasm']);
  assert.deepEqual(features(fs.readFileSync(app)), ['--enable-ew_bg.full.wasm.opt']);
});

// engine-fixes-3: wasm-opt's exit code of 0 says nothing about what it wrote, so the build validates the output first.
test('a wasm-opt that exits 0 with a module that does not validate falls back and warns', (t) => {
  const { full, app, bytes } = scratch(t);
  const log = t.mock.method(console, 'log', () => {});
  const ok = optimise(full, app, (cmd, args) => fs.writeFileSync(args.at(-1), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 5, 0xff])));
  assert.equal(ok, false);
  assert.ok(fs.readFileSync(full).equals(bytes), 'the named module is the one wasm-bindgen wrote');
  assert.deepEqual(fs.readdirSync(path.dirname(full)), ['ew_bg.full.wasm'], 'no half-made output is left');
  assert.match(log.mock.calls.at(-1).arguments[0], /^::warning::engine wasm: wasm-opt failed \(it wrote ew_bg\.full\.wasm\.opt, which does not validate\), so the module ships unoptimised/);
});

test('the built engine module validates, so a good wasm-opt output is kept', (t) => {
  const file = new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url);
  if (!fs.existsSync(file)) return t.skip('no engine build in this checkout (npm run build makes it)');
  assert.ok(WebAssembly.validate(fs.readFileSync(file)));
});

test('the release workflow downloads a pinned, checked binaryen in a step the release goes on without', () => {
  const { jobs } = yaml.load(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const step = jobs.engine.steps.find((s) => s.name === 'Binaryen');
  assert.equal(step['continue-on-error'], true);
  assert.match(step.env.BINARYEN, /^version_\d+$/);
  assert.match(step.env.BINARYEN_SHA256, /^[0-9a-f]{64}$/);
  assert.match(step.run, /sha256sum -c/);
  assert.doesNotMatch(step.run, /apt-get/, 'apt binaryen predates bulk-memory-opt');
  const steps = jobs.engine.steps.map((s) => s.name ?? s.run);
  assert.ok(steps.indexOf('Binaryen') < steps.indexOf('Build the engine'));
});
