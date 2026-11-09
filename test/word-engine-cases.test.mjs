// engine-cases (docs/plans/word/briefs/engine-cases.md): a document whose East Asian font is a missing Simplified Chinese one
// (the Word fixture's 等线, DengXian) reports Microsoft YaHei in the same first fonts.missing report, because chinese_fallback
// (engine/crates/doc-layout/src/para/builder.rs) looks YaHei up once DengXian is there: one round of fonts brings both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

test('the first missing-font report names Microsoft YaHei with the missing DengXian', () => {
  const e = new Engine();
  e.open(new Uint8Array(fs.readFileSync(new URL('../.smoke-data/word/fixture/all-features.docx', import.meta.url))), 'docx');
  e.takeLayout();
  const families = JSON.parse(e.takeMissingFonts()).families.map((f) => f.family);
  assert.ok(families.includes('等线'), families.join(', '));
  assert.ok(families.includes('Microsoft YaHei'), families.join(', '));
  e.free();
});
