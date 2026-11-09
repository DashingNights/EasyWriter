// font-metrics (docs/plans/word/briefs/font-metrics.md): Word's single line read from a font file's head, hhea and OS/2 tables.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { faceRatio, readMetrics, singleLine, stackRatio } from '../src/document/fonts/metrics.mjs';

const near = (a, b, d = 1e-4) => assert.ok(Math.abs(a - b) <= d, `${a} is not ${b}`);

/** An sfnt face of `tables` ({tag: bytes}) starting at byte `base` of its file. */
function face(tables, base = 0) {
  const tags = Object.keys(tables);
  let at = 12 + tags.length * 16;
  const dir = new DataView(new ArrayBuffer(at));
  dir.setUint32(0, 0x10000);
  dir.setUint16(4, tags.length);
  const parts = [new Uint8Array(dir.buffer)];
  tags.forEach((tag, i) => {
    for (let k = 0; k < 4; k++) dir.setUint8(12 + i * 16 + k, tag.charCodeAt(k));
    dir.setUint32(12 + i * 16 + 8, base + at);
    dir.setUint32(12 + i * 16 + 12, tables[tag].length);
    const padded = new Uint8Array(Math.ceil(tables[tag].length / 4) * 4);
    padded.set(tables[tag]);
    parts.push(padded);
    at += padded.length;
  });
  return parts;
}

const table = (n, fill) => {
  const v = new DataView(new ArrayBuffer(n));
  fill(v);
  return new Uint8Array(v.buffer);
};

/** The tables of a font with the given numbers (OS/2 left out where `win` is). */
function tables({ upm = 2048, hhea: [asc, desc, gap], typo = null, win = null, useTypo = false, ps = null }) {
  const t = {
    head: table(54, (v) => v.setUint16(18, upm)),
    hhea: table(36, (v) => [v.setInt16(4, asc), v.setInt16(6, desc), v.setInt16(8, gap)]),
  };
  if (win) {
    t['OS/2'] = table(96, (v) => [v.setUint16(0, 4), v.setUint16(62, useTypo ? 0x80 | 0x40 : 0x40), v.setInt16(68, typo[0]), v.setInt16(70, typo[1]),
      v.setInt16(72, typo[2]), v.setUint16(74, win[0]), v.setUint16(76, win[1])]);
  }
  if (ps) {
    const s = [...ps].flatMap((c) => [0, c.charCodeAt(0)]);
    t.name = table(6 + 12 + s.length, (v) => {
      [0, 1, 18, 3, 1, 0x409, 6, s.length, 0].forEach((x, i) => v.setUint16(i * 2, x));
      s.forEach((b, i) => v.setUint8(18 + i, b));
    });
  }
  return t;
}

const blob = (parts) => new Blob(parts);
const ratioOf = async (b, name) => singleLine(await readMetrics(b, name));

// Aptos's own numbers (Office's copy): USE_TYPO_METRICS, typographic 1923 / -577 / 0, Windows 2068 / 563, per 2048.
const APTOS = { hhea: [1923, -577, 0], typo: [1923, -577, 0], win: [2068, 563], useTypo: true };

test('USE_TYPO_METRICS: the typographic ascender, descender and line gap, as Word draws Aptos and Gabriola', async () => {
  // Word's PDF of the fixture: Aptos 12 pt single spaced lines are 14.64 pt apart (1.22 em), not 15.42 (its Windows figures).
  const aptos = await ratioOf(blob(face(tables(APTOS))));
  near(aptos, 2500 / 2048);
  near(aptos * 12, 14.64, 0.02);
  // Gabriola's typographic line gap counts: 1.7 em in Word's PDF (its stylistic set cases, 31.64 pt apart with 8 pt after and
  // the 278/240 multiple), against 1.84 for its Windows figures and 1.0 without the gap.
  near(await ratioOf(blob(face(tables({ upm: 1000, hhea: [1000, 0, 700], typo: [750, -250, 700], win: [1500, 341], useTypo: true })))), 1.7);
});

test('without the flag: the Windows ascent and descent plus what of hhea\'s line gap they leave over', async () => {
  // Times New Roman: hhea's ascender and descender equal the Windows figures, so its whole line gap is added (1.15 em).
  near(await ratioOf(blob(face(tables({ hhea: [1825, -443, 87], typo: [1420, -442, 307], win: [1825, 443] })))), 2355 / 2048);
  // Calibri: hhea's line gap only fills the room up to the Windows figures, so nothing is added (1.2207, as the browser has it).
  near(await ratioOf(blob(face(tables({ hhea: [1536, -512, 452], typo: [1536, -512, 452], win: [1950, 550] })))), 2500 / 2048);
  // The flag set but no typographic figures: the Windows ones.
  near(await ratioOf(blob(face(tables({ ...APTOS, typo: [0, 0, 0] })))), 2631 / 2048);
  // No OS/2 table: hhea alone.
  near(await ratioOf(blob(face(tables({ upm: 1000, hhea: [900, -300, 50] })))), 1.25);
});

test('a collection: the face whose PostScript name matches, else the first; anything else is no font', async () => {
  const a = tables({ upm: 1000, hhea: [800, -200, 0], typo: [800, -200, 0], win: [800, 200], ps: 'One' });
  const b = tables({ upm: 1000, hhea: [900, -300, 0], typo: [900, -300, 0], win: [900, 300], ps: 'Two' });
  const first = face(a, 20);
  const size = first.reduce((n, p) => n + p.length, 0);
  const head = new DataView(new ArrayBuffer(20));
  [0x74746366, 0x10000, 2, 20, 20 + size].forEach((x, i) => head.setUint32(i * 4, x));
  const ttc = blob([new Uint8Array(head.buffer), ...first, ...face(b, 20 + size)]);
  near(await ratioOf(ttc, 'Two'), 1.2);
  near(await ratioOf(ttc, 'One'), 1);
  near(await ratioOf(ttc, 'Missing'), 1);
  assert.equal(await readMetrics(blob([new TextEncoder().encode('wOFF and more bytes')])), null);
});

test('faces are read once for the session, and a stack takes its first installed family', async () => {
  let reads = 0;
  const bytes = blob(face(tables({ hhea: [1536, -512, 452], typo: [1536, -512, 452], win: [1950, 550] })));
  const calibri = { postscriptName: 'Test-Calibri', blob: async () => (reads++, bytes) };
  const faceOf = async (family) => (family === 'Calibri' ? calibri : null);
  near(await stackRatio('"Aptos", "Calibri", "Carlito", sans-serif', faceOf), 2500 / 2048);
  near(await stackRatio('"Calibri", sans-serif', faceOf), 2500 / 2048);
  assert.equal(reads, 1);
  assert.equal(await stackRatio('"Nothing", sans-serif', faceOf), null);
  assert.equal(await faceRatio({ postscriptName: 'Test-Broken', blob: async () => { throw new Error('no access'); } }), null);
});

// This machine's fonts, where they are installed: Word's figures from the files (the harness checks the app draws them).
const FONTS = 'C:/Windows/Fonts';
const file = (name) => (existsSync(`${FONTS}/${name}`) ? new Blob([readFileSync(`${FONTS}/${name}`)]) : null);

test('installed fonts: Calibri as the browser measures it, Times New Roman with its line gap, Gabriola and a CJK collection', async (t) => {
  const calibri = file('calibri.ttf');
  if (!calibri) return t.skip('no Calibri on this machine');
  // Calibri: 1.2207 em, which the browser's line-height normal (1.22 at 200 px, whole pixels) already gave.
  near(await ratioOf(calibri), 2500 / 2048);
  near(await ratioOf(calibri), 1.22, 0.001);
  near(await ratioOf(file('times.ttf')), 2355 / 2048);
  near(await ratioOf(file('cambria.ttc'), 'Cambria'), 2401 / 2048);
  near(await ratioOf(file('Gabriola.ttf')), 1.7);
  const jh = file('msjh.ttc');
  if (jh) {
    // A CJK font: 1.3 times its Windows figures (1.3301 and 1.27 em), as Word draws Microsoft JhengHei (20.76 pt at 12 pt in the
    // snap-grid-asian probe's PDF).
    near(await ratioOf(jh, 'MicrosoftJhengHeiRegular'), 1.3301 * 1.3);
    near(await ratioOf(jh, 'MicrosoftJhengHeiUIRegular'), 1.27 * 1.3);
  }
});
