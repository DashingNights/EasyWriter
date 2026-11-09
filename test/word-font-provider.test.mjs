// The font provider (docs/plans/word/briefs/font-provider.md Checks): the catalogue's resolution (installed, substitute, none), the
// naming rule, that every bundled file is an open font with its licence beside it and no Microsoft font is bundled or fetched, and a
// download's path through Cache Storage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fontStack } from '../src/office.mjs';
import { readMetrics, singleLine } from '../src/document/fonts/metrics.mjs';
import { BUNDLED, CATALOGUE, chainOf, docFonts, entryOf, fetchFamily, fontEvents, fontLabel, install, loadedFaces, resolve, standsFor,
  vendorOf } from '../src/document/fonts/provider.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, BUNDLED);
const has = (...names) => (f) => names.includes(f);
// Microsoft's own fonts (Windows and Office): never a file in the app, never a download.
const MICROSOFT = ['Aptos', 'Aptos Display', 'Aptos Narrow', 'Aptos Serif', 'Aptos Mono', 'Calibri', 'Calibri Light', 'Cambria', 'Cambria Math',
  'Arial', 'Times New Roman', 'Courier New', 'Segoe UI', 'Georgia', 'Consolas', 'Candara', 'Constantia', 'Corbel', 'Microsoft JhengHei',
  'PMingLiU', 'MingLiU', 'Microsoft YaHei', 'SimSun', 'DengXian'];

/** The name table strings of font file `buf` by name ID (Windows Unicode records first). */
function names(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = v.getUint16(4);
  let name = null;
  for (let i = 0; i < n; i++) if (String.fromCharCode(...buf.subarray(12 + i * 16, 16 + i * 16)) === 'name') name = v.getUint32(12 + i * 16 + 8);
  const count = v.getUint16(name + 2);
  const strings = name + v.getUint16(name + 4);
  const out = {};
  for (let i = 0; i < count; i++) {
    const r = name + 6 + i * 12;
    if (v.getUint16(r) !== 3) continue;
    const id = v.getUint16(r + 6);
    const len = v.getUint16(r + 8);
    const at = strings + v.getUint16(r + 10);
    let s = '';
    for (let k = 0; k < len; k += 2) s += String.fromCharCode(v.getUint16(at + k));
    out[id] ??= s;
  }
  return out;
}

test('resolution: the installed font, else the open font of its chain, else none', () => {
  assert.deepEqual(resolve('Calibri', has('Calibri')), { font: 'Calibri', kind: 'installed', entry: null, metric: true });
  const sub = resolve('Calibri', has());
  assert.equal(sub.font, 'Carlito');
  assert.equal(sub.kind, 'bundled');
  assert.equal(sub.metric, true);
  assert.equal(resolve('Cambria', has()).font, 'Caladea');
  assert.equal(resolve('Arial', has()).font, 'Liberation Sans');
  assert.equal(resolve('Times New Roman', has()).font, 'Liberation Serif');
  assert.equal(resolve('Courier New', has()).font, 'Liberation Mono');
  assert.equal(resolve('Segoe UI', has()).font, 'Selawik');
  // Aptos has no open font with its metrics: Calibri where installed, else Carlito, neither matching.
  assert.deepEqual(resolve('Aptos', has('Calibri')), { font: 'Calibri', kind: 'installed', entry: null, metric: false });
  assert.equal(resolve('Aptos', has()).font, 'Carlito');
  assert.equal(resolve('Aptos', has()).metric, false);
  assert.equal(resolve('Microsoft JhengHei', has()).kind, 'download');
  assert.deepEqual(resolve('Bahnschrift', has()), { font: null, kind: null, entry: null, metric: false });
  // The chain is the CSS stack's order.
  assert.equal(fontStack('Aptos'), chainOf('Aptos').map((f) => `"${f}"`).concat('sans-serif').join(', '));
});

test('naming: the open font first, the font it stands in for in brackets; installed fonts plainly', () => {
  assert.equal(fontLabel('Calibri', has()), 'Carlito (Calibri)');
  assert.equal(fontLabel('Cambria', has()), 'Caladea (Cambria)');
  assert.equal(fontLabel('Arial', has()), 'Liberation Sans (Arial)');
  assert.equal(fontLabel('Calibri', has('Calibri')), 'Calibri');
  assert.equal(fontLabel('Aptos', has('Aptos')), 'Aptos');
  assert.equal(fontLabel('Bahnschrift', has()), 'Bahnschrift');
  assert.deepEqual(standsFor('Carlito').sort(), ['Aptos', 'Aptos Display', 'Calibri', 'Calibri Light']);
  assert.equal(vendorOf('Aptos')?.url, 'https://www.microsoft.com/download/details.aspx?id=106087');
  assert.equal(vendorOf('Aptos Display')?.name, 'Microsoft Aptos Fonts');
  assert.equal(vendorOf('Calibri'), null);
});

test('every bundled file is an open font from the catalogue with its licence beside it; no Microsoft font is bundled or fetched', () => {
  const listed = new Set();
  for (const e of CATALOGUE) {
    assert.ok(!MICROSOFT.includes(e.family), e.family);
    assert.ok(e.licence && e.version && e.source && e.copyright, e.family);
    for (const m of e.matches) assert.ok(standsFor(e.family).includes(m), `${e.family} matches ${m} but FALLBACKS do not name it`);
    if (e.kind === 'download') {
      for (const f of e.faces) assert.match(f.url, /^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/[0-9a-f]{40}\/ofl\//);
      assert.match(e.licenceUrl, /\/OFL\.txt$/);
      continue;
    }
    assert.ok(fs.existsSync(path.join(DIR, e.licenceFile)), e.licenceFile);
    for (const f of e.faces) {
      listed.add(f.file);
      const n = names(fs.readFileSync(path.join(DIR, f.file)));
      assert.ok(n[1].startsWith(e.family), `${f.file} is ${n[1]}`);
      assert.match(n[13] ?? n[0], /Open Font License|Apache License/, f.file);
      assert.ok(!MICROSOFT.includes(n[1]), f.file);
    }
  }
  const files = fs.readdirSync(DIR, { recursive: true }).map((f) => f.replaceAll('\\', '/')).filter((f) => /\.(ttf|otf|ttc|woff2?)$/i.test(f));
  assert.deepEqual(files.sort(), [...listed].sort(), 'every font file in the folder is in the catalogue');
});

test('the bundled substitutes have the single line of the fonts they match (checked where Windows has them)', async () => {
  const win = 'C:\\Windows\\Fonts';
  const pairs = [['calibri.ttf', 'carlito/Carlito-Regular.ttf'], ['arial.ttf', 'liberation/LiberationSans-Regular.ttf'],
    ['times.ttf', 'liberation/LiberationSerif-Regular.ttf'], ['cour.ttf', 'liberation/LiberationMono-Regular.ttf'],
    ['segoeui.ttf', 'selawik/selawk.ttf'], ['cambriab.ttf', 'caladea/Caladea-Bold.ttf', 0.001]];
  const ratio = async (p) => singleLine(await readMetrics(new Blob([fs.readFileSync(p)])));
  for (const [word, open, tol = 1e-9] of pairs) {
    const own = await ratio(path.join(DIR, open));
    assert.ok(own > 1 && own < 1.5, open);
    if (fs.existsSync(path.join(win, word))) assert.ok(Math.abs(own - (await ratio(path.join(win, word)))) <= tol, `${open} against ${word}`);
  }
});

test("the document's fonts: theme, styles and runs, their East Asian and complex-script fonts too", () => {
  const mark = (attrs) => ({ type: { name: 'textStyle' }, attrs });
  const nodes = [{ attrs: {}, marks: [mark({ font: 'Cambria', fontEA: 'PMingLiU' })] },
    { attrs: { markRun: { font: 'Arial', fontCS: 'Arial Unicode MS' } }, marks: [mark({ font: '+major', fontEA: '+minor' })] }];
  const doc = { attrs: { theme: { fonts: { major: 'Calibri Light', minor: 'Calibri', majorEA: '', minorEA: 'MingLiU' } },
    styles: { list: { Code: { run: { font: 'Courier New', fontEA: 'SimSun' } } } } }, descendants: (fn) => nodes.forEach(fn) };
  assert.deepEqual(docFonts(doc).sort(), ['Arial', 'Arial Unicode MS', 'Calibri', 'Calibri Light', 'Cambria', 'Courier New', 'MingLiU', 'PMingLiU',
    'SimSun']);
});

test('a download: announced, fetched once from its source into Cache Storage, then added to the font set; a failure says so', async () => {
  const stored = new Map();
  const fetched = [];
  globalThis.caches = { open: async () => ({ match: async (u) => stored.get(u)?.clone(), put: async (u, r) => { stored.set(u, r); } }),
    match: async (u) => stored.get(u)?.clone() };
  globalThis.fetch = async (u) => (fetched.push(String(u)), String(u).includes('notoseriftc') ? new Response('', { status: 404 }) : new Response(new Uint8Array(8)));
  globalThis.FontFace = class {
    constructor(family, source, desc) { Object.assign(this, { family, source, desc, status: 'unloaded' }); this.loaded = new Promise((r) => { this.done = r; }); }
    load() { this.status = 'loaded'; this.done(this); return this.loaded; }
  };
  const set = new Set();
  install(set, 'file:///app/index.html');
  assert.ok([...set].some((f) => f.family === 'Carlito' && f.source === 'url("file:///app/src/vendor/fonts/carlito/Carlito-Regular.ttf")'));
  assert.ok([...set].every((f) => f.status === 'unloaded'), 'nothing loads until text needs it');
  const events = [];
  for (const t of ['download', 'faces', 'downloadFailed']) fontEvents.addEventListener(t, (e) => events.push([t, e.detail?.family]));

  const sans = entryOf('Noto Sans TC');
  assert.equal(await fetchFamily(sans), true);
  await new Promise((r) => setTimeout(r));
  assert.deepEqual(fetched, [sans.faces[0].url]);
  assert.ok(stored.has(sans.faces[0].url));
  assert.deepEqual(events, [['download', 'Noto Sans TC'], ['faces', undefined]]);
  assert.deepEqual(loadedFaces().filter((d) => d.family === 'Noto Sans TC'),
    [{ family: 'Noto Sans TC', src: sans.faces[0].url, weight: '100 900', style: 'normal', unicodeRange: 'U+0-10FFFF' }]);
  assert.equal(await fetchFamily(sans), true);
  assert.equal(fetched.length, 1, 'a second need fetches nothing');

  events.length = 0;
  assert.equal(await fetchFamily(entryOf('Noto Serif TC')), false);
  assert.deepEqual(events.map((e) => e[0]), ['download', 'downloadFailed']);
  // Every request went to the catalogue's own download URLs, never to Microsoft.
  for (const u of fetched) assert.ok(CATALOGUE.some((e) => e.faces.some((f) => f.url === u)) && !/microsoft/i.test(u), u);
});
