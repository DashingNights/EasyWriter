// A second key in an object literal silently replaces the first: ph-misc-1's `dialogs:` dropped every chart dialog this way.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';

test('no object literal under src repeats a key', () => {
  const found = [];
  for (const f of fs.readdirSync('src', { recursive: true, withFileTypes: true })) {
    if (!f.isFile() || !/\.(js|mjs|jsx)$/.test(f.name) || f.parentPath.includes('vendor') || f.parentPath.endsWith(path.join('engine', 'wasm'))) continue;
    const p = path.join(f.parentPath, f.name);
    const { warnings } = transformSync(fs.readFileSync(p, 'utf8'), { loader: 'jsx', logLevel: 'silent', sourcefile: p });
    for (const w of warnings) if (w.id === 'duplicate-object-key') found.push(`${p}:${w.location.line}`);
  }
  assert.deepEqual(found, []);
});
