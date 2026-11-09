// engine-size (docs/plans/engine/viewport-design.md section 11 and P15): the app's .wasm (src/engine/wasm, npm run build) is under
// its budget and leaves out the engine's own fonts and the hyphenation data. The build copies both beside it; the fonts are added
// before the first layout (src/engine/fonts/bundled.mjs) and the hyphenation data when layout first asks for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine, takeWantedData, addData } from '../src/engine/wasm/ew.js';
import { FACES, FOLDER, addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { BUDGET, DATA } from '../scripts/build-engine-wasm.mjs';

const wasm = fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url));
initSync({ module: wasm });
const assets = (dir) => new URL(`../engine/${dir}/`, import.meta.url);
const S = JSON.stringify;
const J = JSON.parse;

test('the .wasm is under its budget and holds no font or hyphenation file', () => {
  assert.ok(wasm.length <= BUDGET, `${wasm.length} bytes against a budget of ${BUDGET}`);
  for (const [dir, f] of [['assets/fonts', FACES[0]], ['assets/hyphenation', 'en-us.dic'], ['assets/hyphenation', 'de.pat']]) {
    const bytes = fs.readFileSync(new URL(f, assets(dir)));
    assert.equal(wasm.indexOf(bytes.subarray(4096, 4160)), -1, `${f} is compiled in`);
  }
});

test('the bundled fonts are the font folder, and the build copied the fonts and the data beside the .wasm', () => {
  const ttf = fs.readdirSync(assets('assets/fonts')).filter((f) => f.endsWith('.ttf')).sort();
  assert.deepEqual([...FACES].sort(), ttf);
  for (const [from, to] of DATA) {
    for (const f of fs.readdirSync(assets(from))) {
      const there = new URL(`../src/engine/wasm/${to}/${f}`, import.meta.url);
      assert.ok(fs.existsSync(there) && fs.readFileSync(there).equals(fs.readFileSync(new URL(f, assets(from)))), `${to}/${f}`);
    }
  }
});

test('an engine lays out and paints with the bundled fonts once they are added', async () => {
  const e = new Engine();
  await addBundledFonts(e, (url) => fs.readFileSync(url));
  const files = FACES.reduce((n, f) => n + fs.statSync(new URL(f, FOLDER)).size, 0);
  assert.equal(J(e.stats()).fonts, files, 'the font bytes are the 13 files');
  assert.ok(J(e.insertText('Hello, fonts')).changed);
  const r = e.paint(0, 1);
  const px = r.pixels; // a getter that copies the buffer on every read
  r.free();
  let ink = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 128) ink++;
  assert.ok(ink > 20, `${ink} dark pixels`);
  e.free();
});

test('hyphenation data arrives on first use and changes the breaks of every session', () => {
  // Two open drafts: the data is the worker's, so the one that did not ask lays out again with it too.
  const [e, other] = [new Engine(), new Engine()];
  for (const x of [e, other]) {
    x.insertText('a extraordinarily be uncharacteristic of responsibilities the considerations '.repeat(12));
    assert.ok(J(x.exec('layout.hyphenation', S({ value: true }))).changed);
    x.takeLayout();
  }
  const find = (x) => x.exec('layout.manualHyphenation', S({ from: { story: 'body', path: [0], off: 0 } }));
  const before = find(e);
  const wanted = J(takeWantedData());
  assert.ok(wanted.includes('en-us.dic'), S(wanted));
  for (const name of wanted) assert.equal(addData(name, fs.readFileSync(new URL(name, assets('assets/hyphenation')))), true, name);
  for (const x of [e, other]) {
    x.dataChanged();
    assert.ok(x.takeLayout(), 'the data lays each document out again');
  }
  const after = find(e);
  assert.notEqual(after, before, 'the breaks come from the word list now');
  assert.equal(find(other), after, 'in the other session too');
  assert.equal(takeWantedData(), undefined, 'each file is asked for once');
  assert.equal(addData('en-us.dic', new Uint8Array(1)), false, 'and taken once');
  e.free();
  other.free();
});
