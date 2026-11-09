// The engine and the canvas editors stay web code (docs/plans/engine/viewport-design.md section 3): nothing under src/engine,
// src/board, src/document/canvas, src/tooling or src/editors.js imports Electron, a node: module or a Node built-in (they go
// through window.api), and src/engine imports only its own files and npm packages (a value it needs from the app comes from its
// host as an argument). Every engine package's done check runs this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB = ['src/engine', 'src/board', 'src/document/canvas', 'src/tooling', 'src/editors.js'];
const ENGINE = path.join(ROOT, 'src', 'engine');

// The files under src/engine that still import from the app, each with the package that makes its host pass the value in and
// deletes its entry here (section 3). A fixed file whose entry stays fails the test, so the list only shrinks.
const OFFENDERS = {
};

const NODE = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Every .js, .mjs and .jsx file under `rel` (a folder or one file), the built wasm glue excepted. */
function files(rel) {
  const at = path.join(ROOT, rel);
  if (!fs.existsSync(at)) return [];
  if (fs.statSync(at).isFile()) return [at];
  return fs.readdirSync(at, { recursive: true }).map((f) => path.join(at, f))
    .filter((f) => /\.(m?js|jsx)$/.test(f) && !f.includes(`${path.sep}wasm${path.sep}`));
}

/** The specifiers `file` imports, re-exports, imports dynamically or requires (comments left out). */
function imports(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  for (const re of [/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm, /^\s*import\s*['"]([^'"]+)['"]/gm, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

test('the web folders import no Electron, node: module or Node built-in', () => {
  const bad = [];
  for (const f of WEB.flatMap(files)) {
    for (const s of imports(f)) if (s === 'electron' || s.startsWith('electron/') || NODE.has(s) || NODE.has(s.split('/')[0])) bad.push(`${rel(f)}: ${s}`);
  }
  assert.deepEqual(bad, []);
});

test('src/engine imports only its own files and npm packages, but for the listed offenders', () => {
  const out = new Map();
  for (const f of files('src/engine')) {
    for (const s of imports(f)) {
      if (!s.startsWith('.')) continue;
      const to = path.resolve(path.dirname(f), s);
      if (to !== ENGINE && !to.startsWith(ENGINE + path.sep)) out.set(rel(f), [...(out.get(rel(f)) ?? []), s]);
    }
  }
  const unlisted = [...out].filter(([f]) => !OFFENDERS[f]).map(([f, s]) => `${f}: ${s.join(', ')}`);
  assert.deepEqual(unlisted, [], 'a file under src/engine takes a value from the app: have its host pass it in');
  const fixed = Object.keys(OFFENDERS).filter((f) => !out.has(f));
  assert.deepEqual(fixed, [], 'these no longer import from the app: delete their entries from OFFENDERS');
});
