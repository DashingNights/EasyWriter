// engine-move (docs/plans/engine/viewport-design.md sections 9 and 16, P3): the Rust workspace lives in engine/ under ew-* package
// and folder names; since the identifier rename (P7) each library and workspace key has its package's name too (ew for the wasm
// host). The builds and the release bundle look there, and nothing points at src/vendor/wordcraft any more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pins } from '../scripts/build-engine-wasm.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(root, 'engine');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
/** The `name` in a manifest's `[section]`, or undefined. */
const nameIn = (toml, section) => new RegExp(`^\\[${section}\\][^[]*?^name = "([^"]+)"`, 'ms').exec(toml)?.[1];

test('each crate has its ew-* package name, and its workspace key and library are that name', () => {
  const keys = {}; // workspace key → path
  for (const [, key, dir] of read(engine, 'Cargo.toml').matchAll(/^(ew-[a-z-]+) = \{ path = "([^"]+)" \}/gm)) keys[key] = dir;
  const crates = fs.readdirSync(path.join(engine, 'crates')).sort();
  assert.deepEqual(crates, ['board', 'doc', 'doc-edit', 'doc-layout', 'docbin', 'docx', 'fonts', 'formats', 'geom', 'metafile', 'pdf', 'proof', 'scene', 'wasm']);
  for (const dir of crates) {
    const toml = read(engine, 'crates', dir, 'Cargo.toml');
    assert.equal(nameIn(toml, 'package'), `ew-${dir}`, dir);
    if (dir === 'wasm') {
      assert.equal(nameIn(toml, 'lib'), 'ew', 'the wasm host library stays ew, so cargo writes ew.wasm');
      continue;
    }
    assert.equal(keys[`ew-${dir}`], `crates/${dir}`, `the workspace key for crates/${dir}`);
    assert.equal(nameIn(toml, 'lib'), undefined, `${dir}'s library takes its package's name`);
  }
});

test('the builds and the bundle look in engine/', () => {
  assert.ok(!fs.existsSync(path.join(root, 'src', 'vendor', 'wordcraft')));
  assert.deepEqual(pins(), { rust: '1.96.0', bindgen: '0.2.129' }, 'the pins come from engine/');
  const files = JSON.parse(read(root, 'package.json')).build.files;
  assert.ok(!files.some((f) => f.includes('vendor/wordcraft/')), files.join(' '));
  const binding = path.join(root, 'src', 'vendor', 'wordcraft-metafile', 'binding');
  const dep = /^ew-metafile = \{ path = "([^"]+)" \}/m.exec(read(binding, 'Cargo.toml'))?.[1];
  assert.equal(path.resolve(binding, dep ?? ''), path.join(engine, 'crates', 'metafile'), 'the metafile binding builds the moved crate');
});
