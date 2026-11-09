// The engine's font provider (docs/plans/word/briefs/engine-fonts.md): the name reader, the index of installed fonts and its choice
// of revision, the open fonts as a source, and the provider's answers to the engine's fonts.missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bytesReader, familiesOf, readFaces } from '../src/engine/fonts/sfnt.mjs';
import { createFontProvider } from '../src/engine/fonts/provider.mjs';
import { openSource } from '../src/engine/fonts/sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontsMain = createRequire(import.meta.url)('../electron/fonts-main.js');
const CARLITO = path.join(ROOT, 'src/vendor/fonts/carlito/Carlito-Regular.ttf');

/** A copy of font `bytes` whose head.fontRevision is `rev`. */
function withRevision(bytes, rev) {
  const b = Buffer.from(bytes);
  const n = b.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    if (b.toString('latin1', 12 + i * 16, 16 + i * 16) === 'head') b.writeUInt32BE(Math.round(rev * 65536), b.readUInt32BE(12 + i * 16 + 8) + 4);
  }
  return b;
}

test('the name reader gives a face its typographic family, style and revision', async () => {
  const [f, ...rest] = await readFaces(bytesReader(fs.readFileSync(CARLITO)));
  assert.equal(rest.length, 0);
  assert.equal(f.family, 'Carlito');
  assert.equal(f.style, 'Regular');
  assert.ok(f.revision > 1, `revision ${f.revision}`);
  assert.ok(f.names.includes('Carlito'));
  assert.deepEqual(await familiesOf(fs.readFileSync(CARLITO)), ['Carlito']);
  assert.deepEqual(await readFaces(bytesReader(new Uint8Array(40))), [], 'not a font');
  const bumped = await readFaces(bytesReader(withRevision(fs.readFileSync(CARLITO), 7.5)));
  assert.equal(bumped[0].revision, 7.5);
});

test('the name reader reads each face of a collection and its localized family names', { skip: !fs.existsSync('C:/Windows/Fonts/msjh.ttc') }, async () => {
  const faces = await readFaces(bytesReader(fs.readFileSync('C:/Windows/Fonts/msjh.ttc')));
  assert.ok(faces.length >= 2);
  assert.ok(faces.some((f) => f.family === 'Microsoft JhengHei' && f.names.includes('微軟正黑體')), JSON.stringify(faces.map((f) => f.names)));
  assert.ok(faces.some((f) => f.family === 'Microsoft JhengHei UI'));
});

test('of the revisions of a face the highest wins, then the newest file; other styles stay', () => {
  const face = (file, style, revision, mtime) => ({ file, family: 'Aptos', style, revision, mtime });
  const faces = [face('a', 'Regular', 1.1, 5), face('b', 'Regular', 1.3, 1), face('c', 'Regular', 1.3, 2), face('d', 'Bold', 1.0, 0)];
  assert.deepEqual(fontsMain.choose(faces).map((f) => f.file), ['c', 'd']);
  assert.deepEqual(fontsMain.choose([face('x', 'Regular', 2, 1), { ...face('y', 'regular', 2, 1), family: 'APTOS' }]).map((f) => f.file), ['x'],
    'a tie keeps the earlier folder, names compared in any case');
});

test('the index reads the cloud fonts folder (a folder per family, numeric names) and picks the newest revision', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-fonts-'));
  try {
    const cloud = path.join(dir, 'CloudFonts', 'Carlito');
    fs.mkdirSync(cloud, { recursive: true });
    const bytes = fs.readFileSync(CARLITO);
    fs.writeFileSync(path.join(cloud, '26205970649.ttf'), withRevision(bytes, 1.5));
    fs.writeFileSync(path.join(cloud, '34532516108.ttf'), withRevision(bytes, 2.25));
    fs.writeFileSync(path.join(cloud, '30000000000.ttf'), withRevision(bytes, 1.0));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a font');
    fs.writeFileSync(path.join(dir, 'broken.ttf'), 'not a font either');
    const ix = await fontsMain.buildIndex([{ dir, source: 'system', deep: false }, { dir: path.join(dir, 'CloudFonts'), source: 'cloud', deep: true },
      { dir: path.join(dir, 'missing'), source: 'user', deep: false }]);
    assert.equal(ix.files, 4, 'the three cloud files and broken.ttf; the text file and the missing folder are skipped');
    const carlito = ix.byName.get('carlito');
    assert.equal(carlito.length, 1);
    assert.equal(path.basename(carlito[0].file), '34532516108.ttf');
    assert.equal(carlito[0].source, 'cloud');
    assert.equal(carlito[0].revision, 2.25);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the font folders include the per-user fonts and Office\'s cloud fonts on Windows', () => {
  const dirs = fontsMain.fontDirs({ LOCALAPPDATA: 'L:\\Local', WINDIR: 'W:\\Win' }, 'win32', 'H:\\home');
  assert.deepEqual(dirs.map((d) => [d.dir, d.source, d.deep]), [
    [path.join('W:\\Win', 'Fonts'), 'system', false],
    [path.join('L:\\Local', 'Microsoft', 'Windows', 'Fonts'), 'user', false],
    [path.join('L:\\Local', 'Microsoft', 'FontCache', '4', 'CloudFonts'), 'cloud', true],
  ]);
});

// The open fonts from the app's folder, through a fetch that reads the file a file: URL names.
const open = openSource({ base: pathToFileURL(`${ROOT}/`).href, fetch: async (url) => new Response(fs.readFileSync(fileURLToPath(url))) });

// word.rs's lists, as the engine reports them with a missing family (crates/fonts/src/word.rs substitutes).
const SANS = ['Carlito', 'Helvetica Neue', 'Arial', 'Liberation Sans', 'Noto Sans', 'DejaVu Sans', 'Source Sans 3'];
const SERIF = ['Caladea', 'Times New Roman', 'Liberation Serif', 'Georgia', 'Noto Serif', 'DejaVu Serif', 'Source Serif 4'];
const sans = (family) => ({ family, standIn: 'Source Sans 3', standIns: SANS });

/** A stub engine: records addFont and fontsDone and lets the test send fonts.missing. */
function stubEngine() {
  const added = [];
  let listener = null;
  return {
    added,
    done: 0,
    fontsDone() { this.done++; },
    on: (event, fn) => { assert.equal(event, 'fonts.missing'); listener = fn; return () => { listener = null; }; },
    addFont: async (bytes) => { added.push(bytes); },
    missing: (e) => listener?.(e),
    listening: () => !!listener,
  };
}

test('the provider loads installed families, loads the stand-in the engine picks for missing ones and names them as the app does', async () => {
  const engine = stubEngine();
  const asked = [];
  const installed = { name: 'installed', faces: async (f) => { asked.push(f); return f === 'Aptos' ? [{ name: 'a.ttf', bytes: new Uint8Array(10) }, { name: 'b.ttf', bytes: new Uint8Array(20) }] : []; } };
  const p = createFontProvider({ engine, sources: [installed, open], scripts: { Test: ['Nope', 'Carlito'] } });
  // Fixture Missing Font is a roman font the engine draws in Cambria itself; Cambria is missing too.
  engine.missing({ families: [sans('Aptos'), { family: 'Cambria', standIn: 'Source Serif 4', standIns: SERIF }, 'aptos', ' ',
    { family: 'Fixture Missing Font', standIn: 'Cambria', standIns: ['Cambria'] }], scripts: ['Test', 'Zzzz'] });
  await p.ready();
  assert.equal(engine.done, 1, 'the worker hears once that the answer is complete');
  const r = Object.fromEntries(p.results().map((x) => [x.family, x]));
  assert.deepEqual(Object.keys(r).sort(), ['Aptos', 'Cambria', 'Fixture Missing Font']);
  assert.equal(r.Aptos.from, 'installed');
  assert.equal(r.Aptos.files, 2);
  assert.equal(r.Aptos.bytes, 30);
  assert.equal(r.Cambria.standIn, 'Caladea');
  assert.equal(r.Cambria.from, 'open');
  assert.equal(r.Cambria.files, 4);
  assert.equal(p.label('Cambria'), 'Caladea (Cambria)');
  assert.equal(p.label('Aptos'), 'Aptos');
  assert.equal(r['Fixture Missing Font'].standIn, 'Cambria', 'the engine\'s own stand-in, not one the provider chose');
  assert.equal(r['Fixture Missing Font'].files, 0, 'Cambria is asked for on its own');
  assert.equal(p.label('Fixture Missing Font'), 'Caladea (Fixture Missing Font)', 'Cambria is drawn in Caladea here');
  // Aptos 2 files, Caladea 4, Carlito 4 for the script fallback (Nope is in no source).
  assert.equal(engine.added.length, 10);
  const familiesAdded = new Set(await Promise.all(engine.added.filter((b) => b.length > 100).map(async (b) => (await familiesOf(b))[0])));
  assert.deepEqual([...familiesAdded].sort(), ['Caladea', 'Carlito']);
  // Asked again (another event, another case): answered from what is loaded, nothing added twice.
  const again = await p.request(['APTOS', sans('Calibri')]);
  assert.equal(again.find((x) => x.family === 'Aptos').from, 'installed', 'the earlier answer, under the name first asked');
  assert.equal(again.find((x) => x.family === 'Calibri').standIn, 'Carlito', 'Carlito is loaded already for the script');
  assert.equal(engine.added.length, 10);
  assert.equal(asked.filter((f) => f.toLowerCase() === 'aptos').length, 1);
  p.stop();
  assert.equal(engine.listening(), false);
});

test('a family no source has keeps the stand-in the engine draws it in', async () => {
  const engine = stubEngine();
  const p = createFontProvider({ engine, sources: [{ name: 'none', faces: async () => [] }] });
  const [r, plain] = await p.request([sans('Unheard Of'), 'Not Even Asked By The Engine']);
  assert.equal(r.missing, true);
  assert.equal(r.standIn, 'Source Sans 3');
  assert.equal(p.label('Unheard Of'), 'Source Sans 3 (Unheard Of)');
  assert.equal(plain.standIn, null, 'a name alone has no stand-in to report');
  assert.equal(engine.added.length, 0);
});

test('a source that fails leaves the family to the next source', async () => {
  const engine = stubEngine();
  const bad = { name: 'bad', faces: async () => { throw new Error('ipc gone'); } };
  const p = createFontProvider({ engine, sources: [bad, open] });
  const [r] = await p.request(['Carlito']);
  assert.equal(r.from, 'open');
  assert.equal(r.files, 4);
});
