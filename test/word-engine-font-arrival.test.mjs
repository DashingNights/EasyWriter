// engine-font-arrival (docs/plans/word/briefs/engine-font-arrival.md): text laid out before its font arrives is laid out again,
// and a reader that waits for whenSettled reads that one layout. engine-style-separator's probe read one page with two fonts'
// metrics: its first label 15.912 pt tall (Source Sans 3, the stand-in) and the rest 14.648 (the document's font), because
// whenSettled resolved before the font the open asked for had arrived. These run the real worker.js and client.js over Node's
// worker threads, with the engine's .wasm and bundled fonts, and a font source that hands over Carlito when the test says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { EngineHost } from '../src/engine/client.js';
import { createFontProvider } from '../src/engine/fonts/provider.mjs';

const WORKER = new URL('../src/engine/worker.js', import.meta.url);
const CARLITO = ['Regular', 'Bold'].map((s) => new URL(`../src/vendor/fonts/carlito/Carlito-${s}.ttf`, import.meta.url));

// The page's Worker over a Node worker thread: `self`, postMessage and fetch (file: URLs, which the worker reads its .wasm, STAMP
// and bundled fonts from) as a browser worker has them. Messages that come before worker.js has set self.onmessage wait.
const BOOT = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
globalThis.self = globalThis;
const net = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.protocol !== 'file:') return net(url);
  try {
    return new Response(await fs.promises.readFile(u), { headers: { 'content-type': u.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } });
  } catch {
    return new Response(null, { status: 404 });
  }
};
globalThis.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
const early = [];
parentPort.on('message', (data) => (globalThis.onmessage ? globalThis.onmessage({ data }) : early.push(data)));
import(workerData).then(() => { for (const data of early.splice(0)) globalThis.onmessage({ data }); });
`;
globalThis.Worker = class {
  constructor(url) {
    this.w = new NodeWorker(BOOT, { eval: true, workerData: String(url) });
    this.w.on('message', (data) => this.onmessage?.({ data }));
    this.w.on('error', (e) => this.onerror?.({ message: e.message, preventDefault() {} }));
  }
  postMessage(m, transfer) {
    this.w.postMessage(m, transfer);
  }
  terminate() {
    this.w.terminate();
  }
};

const crc32 = (b) => {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
};
/** A package with its parts stored, which is all the reader needs. */
function zip(files) {
  const local = [];
  const central = [];
  let at = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name);
    const d = Buffer.from(text);
    const h = Buffer.alloc(30);
    const e = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    e.writeUInt32LE(0x02014b50, 0);
    e.writeUInt16LE(20, 4);
    e.writeUInt16LE(20, 6);
    for (const [b, o] of [[h, 14], [e, 16]]) {
      b.writeUInt32LE(crc32(d), o);
      b.writeUInt32LE(d.length, o + 4);
      b.writeUInt32LE(d.length, o + 8);
      b.writeUInt16LE(n.length, o + 12);
    }
    e.writeUInt32LE(at, 42);
    local.push(h, n, d);
    central.push(e, n);
    at += 30 + n.length + d.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(central.reduce((s, b) => s + b.length, 0), 12);
  end.writeUInt32LE(at, 16);
  return new Uint8Array(Buffer.concat([...local, ...central, end]));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const LONG = Array(4).fill('the quick brown fox jumps over the lazy dog').join(' ');
/** A .docx of `n` paragraphs in Carlito 12 pt, single spaced with no spacing after (labels, long ones and bold ones), on A4. */
function docx(n) {
  const p = (text, rPr = '') => `<w:p><w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const body = Array.from({ length: n }, (_, i) => (i % 3 === 1 ? p(`P${i} ${LONG}`) : i % 3 === 2 ? p(`B${i} bold`, '<w:b/>') : p(`[${i}] label`))).join('');
  const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/${type}" Target="${target}"/>`;
  return zip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'officeDocument/2006/relationships/officeDocument', 'word/document.xml')}</Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'officeDocument/2006/relationships/styles', 'styles.xml')}</Relationships>`,
    'word/styles.xml': `<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Carlito" w:hAnsi="Carlito"/><w:sz w:val="24"/></w:rPr></w:rPrDefault>`
      + '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>',
    'word/document.xml': `<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  });
}

/** Every paragraph's caret at its start, as [page, top, height]. */
async function carets(s, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = await s.call('caret', [{ story: 'body', path: [i], off: 0 }]);
    out.push(k && [k.page, +k.y.toFixed(2), +k.h.toFixed(3)]);
  }
  return out;
}

/** A host whose fonts come from one source that has only Carlito, whose files it hands over once `gate` resolves (a disk or
 * download that takes its time, as the desktop's installed fonts and the web's open fonts do). */
function host(gate) {
  const h = new EngineHost(WORKER, { fonts: false });
  const source = {
    name: 'test',
    faces: async (family) => (family.toLowerCase() === 'carlito' ? (await gate, CARLITO.map((u) => ({ name: u.pathname, bytes: new Uint8Array(fs.readFileSync(u)) }))) : []),
  };
  // As fonts/index.mjs wires the provider to the host, with this source in place of the app's.
  h.fonts = createFontProvider({ engine: { on: (e, fn) => h.on(e, fn), addFont: (b) => h.call('addFont', [b], [b.buffer]), fontsDone: () => h.call('fontsDone') }, sources: [source] });
  return h;
}

test('a read after whenSettled sees the draft laid out in the font that arrived after the open, in every paragraph', { timeout: 120000 }, async () => {
  const N = 90; // about two pages
  const bytes = docx(N);
  // The same document in a worker that had Carlito before the open: where every caret belongs.
  const early = new EngineHost(WORKER, { fonts: false });
  try {
    for (const u of CARLITO) await early.call('addFont', [new Uint8Array(fs.readFileSync(u))]);
    const e = early.session('d');
    await e.open(bytes.slice(), 'docx');
    const want = await carets(e, N);

    let release;
    const gate = new Promise((r) => (release = r));
    const late = host(gate);
    try {
      const s = late.session('d');
      // A reader that hears the open's layout already has the fonts it lacks on their way, as in the same task.
      const before = late.fonts.ready();
      let asked = null;
      const unhear = s.on('layout', () => queueMicrotask(() => (asked ??= late.fonts.ready() !== before)));
      await s.open(bytes.slice(), 'docx');
      // The font comes when whenSettled resolves without it, else a little later: either way a read waits for it.
      const settled = s.whenSettled();
      const timer = setTimeout(release, 300);
      await settled;
      const got = await carets(s, N);
      release();
      clearTimeout(timer);
      unhear();
      // Carlito has Calibri's metrics, and Word's single line of Calibri 12 pt is 14.65 pt (1.2207 em).
      const heights = [...new Set(got.map((k) => k?.[2]))];
      assert.deepEqual(heights, [14.648], 'every line in Carlito\'s height, none in the stand-in\'s');
      const off = got.flatMap((k, i) => (JSON.stringify(k) === JSON.stringify(want[i]) ? [] : [{ para: i, got: k, want: want[i] }]));
      assert.deepEqual(off, [], 'every paragraph where a worker that had the font from the start puts it');
      assert.equal(asked, true, 'the open\'s layout event came with the fonts it lacks');
    } finally {
      late.terminate();
    }
  } finally {
    early.terminate();
  }
});
