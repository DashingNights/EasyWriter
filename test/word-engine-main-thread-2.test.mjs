// engine-main-thread-2 (docs/plans/word/briefs/engine-main-thread-2.md): the app's own work around a key, counted. Each test counts
// the work the code does (elements built, layout reads, placements made, pages laid out in one piece), never a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createA11yCopy } from '../src/engine/a11y/copy.js';
import { EngineHost } from '../src/engine/client.js';
import { initSync, Engine } from '../src/engine/wasm/ew.js';

// ---------- a small DOM, enough for the accessibility copy ----------
// Elements count what the copy builds (`made`) and the layout reads it makes (`reads`); querySelector takes the copy's selectors:
// [a], [a="v"] and ':scope > ' chains of them.
class Text {
  constructor(doc, data) {
    Object.assign(this, { ownerDocument: doc, nodeType: 3, data, parentNode: null });
  }
  get length() {
    return this.data.length;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
}

class El {
  constructor(doc, tag) {
    Object.assign(this, { ownerDocument: doc, nodeType: 1, tagName: tag, parentNode: null, childNodes: [], attributes: new Map() });
    const props = new Map();
    this.style = new Proxy({ setProperty: (k, v) => props.set(k, v), getPropertyValue: (k) => props.get(k) ?? '' }, {
      set: (o, k, v) => (props.set(k, v), true),
      get: (o, k) => (k in o ? o[k] : props.get(k) ?? ''),
    });
    this.dataset = new Proxy({}, { get: (o, k) => this.attributes.get(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) });
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  hasAttribute(k) {
    return this.attributes.has(k);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get offsetWidth() {
    this.ownerDocument.reads++;
    return 7 * this.textContent.length;
  }
  get textContent() {
    return this.childNodes.map((n) => (n.nodeType === 3 ? n.data : n.textContent)).join('');
  }
  removeChild(n) {
    this.childNodes.splice(this.childNodes.indexOf(n), 1);
    n.parentNode = null;
    return n;
  }
  insertBefore(n, ref) {
    if (n.parentNode) {
      this.ownerDocument.moved++; // taken out and put back: laid out again
      n.parentNode.removeChild(n);
    }
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, n);
    n.parentNode = this;
    return n;
  }
  append(...ns) {
    for (const n of ns) this.insertBefore(typeof n === 'string' ? new Text(this.ownerDocument, n) : n, null);
  }
  replaceChildren(...ns) {
    for (const n of [...this.childNodes]) this.removeChild(n);
    this.append(...ns);
  }
  replaceWith(n) {
    const p = this.parentNode;
    p.insertBefore(n, this);
    p.removeChild(this);
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  querySelectorAll(sel) {
    const steps = sel.replace(/^:scope\s*>\s*/, '').split(/\s*>\s*/).map((s) => {
      const m = /^\[([\w-]+)(?:="(.*)")?\]$/.exec(s);
      return (e) => e.attributes.has(m[1]) && (m[2] == null || e.attributes.get(m[1]) === m[2]);
    });
    const direct = /^:scope/.test(sel);
    let found = direct ? this.children.filter(steps[0]) : [...descendants(this)].filter(steps[0]);
    for (const step of steps.slice(1)) found = found.flatMap((e) => e.children.filter(step));
    return found;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

function* descendants(el) {
  for (const c of el.children) {
    yield c;
    yield* descendants(c);
  }
}

class Doc {
  made = new Map(); // tag → elements built
  reads = 0;
  moved = 0;
  activeElement = null;
  createElement(tag) {
    this.made.set(tag, (this.made.get(tag) ?? 0) + 1);
    return new El(this, tag);
  }
  createTextNode(data) {
    return new Text(this, data);
  }
  getSelection() {
    return null;
  }
  get built() {
    return [...this.made.values()].reduce((a, b) => a + b, 0);
  }
}

/** Element `e` as text, its tags, attributes (but its place, which the copy sets in style) and text, nested. */
const html = (e) => (e.nodeType === 3 ? e.data
  : `<${e.tagName}${[...e.attributes].map(([k, v]) => ` ${k}="${v}"`).join('')}>${e.childNodes.map(html).join('')}</${e.tagName}>`);

globalThis.CSS ??= { escape: (s) => String(s).replace(/"/g, '\\"') };

// ---------- 1. the accessibility copy rebuilds only the paragraphs that changed ----------

const para = (id, text, y) => ({ id, kind: 'p', text, boxes: [{ line: 0, x: 72, y, w: 7 * text.length, h: 14, size: 11 }] });
/** Page 0 of a draft: a heading, a table of `rows` rows of two cells, a paragraph after it. `edit(id)` gives a cell's new text. */
function page(rows, edit = () => null) {
  const cell = (r, c) => {
    const id = `2.${r}.${c}.0`;
    return { blocks: [para(id, edit(id) ?? `Row ${r} cell ${c}`, 100 + r * 16)] };
  };
  return [para('0', 'A table of fruit', 72),
    { id: '2', kind: 'table', rows: Array.from({ length: rows }, (_, r) => ({ index: r, cells: [cell(r, 0), cell(r, 1)] })) },
    para('3', 'After the table', 100 + rows * 16)];
}

/** The copy of a client whose page 0 is `blocks()`, in element `el` → {copy, client}; client.key(blocks) is an edit. */
function copyOf(doc, blocks) {
  const fns = new Map();
  let now = blocks;
  const client = {
    on: (name, fn) => (fns.set(name, [...(fns.get(name) ?? []), fn]), () => {}),
    blocks: async (p) => (p === 0 ? structuredClone(now) : []),
    selection: async () => ({ anchor: 0, head: 0 }),
    caret: async () => ({ page: 0, x: 0, y: 0 }),
    locate: async () => null,
    key(next) {
      now = next;
      for (const fn of fns.get('layout') ?? []) fn({ from: 0, to: 1, count: 1 });
    },
  };
  const el = doc.createElement('div');
  const owner = { contains: () => false, addEventListener() {}, removeEventListener() {} };
  return { copy: createA11yCopy({ client, el, owner }), client, el };
}

test('a key in a table cell rebuilds that paragraph of the accessibility copy only, not the table', async () => {
  const doc = new Doc();
  const { copy, client, el } = copyOf(doc, page(30));
  await copy.setPages([0]);
  const table = el.querySelector('[data-id="2"]');
  const other = el.querySelector('[data-id="2.17.0.0"]');
  assert.ok(table && other, 'the copy holds the table');
  doc.made.clear();
  doc.reads = 0;

  client.key(page(30, (id) => (id === '2.4.1.0' ? 'Row 4 cell 1 and a key' : null)));
  await copy.setPages([0]);

  // The edited paragraph is one <p> with a line <span> holding one piece <span>: at most three elements, and its line's width read.
  assert.ok(doc.built <= 3 && doc.reads === 1, `built ${JSON.stringify([...doc.made])}, ${doc.reads} width reads`);
  assert.equal(el.querySelector('[data-id="2"]'), table, 'the table element stays');
  assert.equal(el.querySelector('[data-id="2.17.0.0"]'), other, 'an unchanged paragraph stays');
  // The copy is what a copy built from scratch holds.
  const fresh = copyOf(new Doc(), page(30, (id) => (id === '2.4.1.0' ? 'Row 4 cell 1 and a key' : null)));
  await fresh.copy.setPages([0]);
  assert.equal(html(el), html(fresh.el));
});

test('a row added to a table and a paragraph gone from a cell change only those parts of the copy', async () => {
  const doc = new Doc();
  const { copy, client, el } = copyOf(doc, page(5));
  await copy.setPages([0]);
  const table = el.querySelector('[data-id="2"]');
  doc.made.clear();
  // Row 2 goes, and a row 5 comes after the last.
  const next = page(6);
  next[1].rows.splice(2, 1);
  client.key(next);
  await copy.setPages([0]);
  assert.equal(el.querySelector('[data-id="2"]'), table, 'the table element stays');
  assert.equal(doc.made.get('tr'), 1, `one row built: ${JSON.stringify([...doc.made])}`);
  const fresh = copyOf(new Doc(), next);
  await fresh.copy.setPages([0]);
  assert.equal(html(el), html(fresh.el));
});

test('a block gone from the top of the copy (a page scrolled away) moves none of the blocks after it', async () => {
  const doc = new Doc();
  const blocks = page(20);
  const { copy, client, el } = copyOf(doc, blocks);
  await copy.setPages([0]);
  const table = el.querySelector('[data-id="2"]');
  doc.made.clear();
  doc.moved = 0;
  client.key(blocks.slice(1));
  await copy.setPages([0]);
  // engine-main-thread-2: on the fixture's first key the view scrolled, and the table under it was taken out and put back.
  assert.deepEqual({ built: doc.built, moved: doc.moved }, { built: 0, moved: 0 });
  assert.equal(el.querySelector('[data-id="2"]'), table);
  assert.equal(el.querySelector('[data-id="0"]'), null, 'the block gone is gone');
});

test('the footer a page set shares moves past the blocks of the pages scrolled in, and they stay where they are', async () => {
  // The copy's blocks of pages 0, 298 and 299: the header and footer every page repeats come once, where the first page puts them.
  // Page 0 scrolls away (engine-main-thread-2: the caret's page before the fixture's first key), so the footer now comes after
  // page 298's blocks.
  const doc = new Doc();
  const part = (id, text, y) => ({ id, kind: 'part', part: id === 'H' ? 'header' : 'footer', blocks: [para(`${id}0`, text, y)] });
  const body = (ids) => ids.map((id, i) => para(id, `Paragraph ${id}`, 100 + i * 16));
  const { copy, client, el } = copyOf(doc, [part('H', 'Header', 20), ...body(['a', 'b']), part('F', 'Footer', 760), ...body(['c', 'd', 'e', 'f'])]);
  await copy.setPages([0]);
  const kept = ['c', 'd', 'e', 'f'].map((id) => el.querySelector(`[data-id="${id}"]`));
  doc.made.clear();
  doc.moved = 0;
  client.key([part('H', 'Header', 20), ...body(['c', 'd', 'e', 'f']), part('F', 'Footer', 760), ...body(['g'])]);
  await copy.setPages([0]);
  assert.deepEqual(el.children.map((e) => e.getAttribute('data-id')), ['H', 'c', 'd', 'e', 'f', 'F', 'g']);
  assert.deepEqual({ moved: doc.moved, built: doc.made.get('p') }, { moved: 1, built: 1 }, 'the footer moves, and g is built');
  assert.deepEqual(['c', 'd', 'e', 'f'].map((id) => el.querySelector(`[data-id="${id}"]`)), kept);
});

// ---------- 4. the layout after a font arrives runs in slices in a session laid out whole ----------

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
const WORKER = new URL('../src/engine/worker.js', import.meta.url);
const CARLITO = new URL('../src/vendor/fonts/carlito/Carlito-Regular.ttf', import.meta.url);

// The page's Worker over a Node worker thread: `self`, postMessage and fetch of file: URLs (the .wasm, STAMP and bundled fonts), as
// word-engine-main-thread.test.mjs runs it. Messages that come before worker.js has set self.onmessage wait.
const BOOT = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
globalThis.self = globalThis;
globalThis.fetch = async (url) => {
  try {
    return new Response(await fs.promises.readFile(new URL(url)), { headers: { 'content-type': String(url).endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } });
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

/** A document of `n` paragraphs with a page break every 7th → its engine form. */
function typed(n) {
  const e = new Engine();
  for (let i = 0; i < n; i++) {
    e.insertText(`Paragraph ${i} `.repeat(30));
    e.exec(i % 7 === 6 ? 'text.pageBreak' : 'text.newParagraph', '{}');
  }
  const bytes = e.save('engine');
  e.free();
  return bytes;
}

test('a font that arrives lays a session laid out whole out again in slices, as an open does, and it settles as a whole layout', { timeout: 120000 }, async () => {
  const host = new EngineHost(WORKER, { fonts: false });
  try {
    const bytes = typed(120);
    // engine-helper's fixture session: opened with no `ahead`, so the open lays it out whole.
    const c = host.session('whole');
    const opened = await c.call('open', [bytes.slice(), 'engine']);
    assert.equal(opened.settled, true);
    await c.pages(); // the open's own layout event comes before this answer
    const events = [];
    host.on('layout', (e, s) => s === 'whole' && events.push({ settled: e.settled, count: e.count }));
    assert.ok(await host.call('addFont', [new Uint8Array(fs.readFileSync(CARLITO))]), 'the font is new to the worker');
    await host.call('fontsDone');
    await c.whenSettled();
    // The slices end where a whole layout with the font does (Carlito sets the text narrower than the stand-in did).
    const again = host.session('again');
    const whole = await again.call('open', [bytes.slice(), 'engine']);
    // engine-main-thread-2: it laid out all its pages in the turn after fontsDone, holding every other draft's calls meanwhile.
    // (engine-keys-final: until it settles, the pages not laid out again yet are listed as the last settled layout had
    // them, so the first event's count is that layout's.)
    assert.ok(events.length > 1 && events[0].settled === false, `${whole.pages} pages, the layout events after the font: ${JSON.stringify(events)}`);
    assert.deepEqual(events.at(-1), { settled: true, count: whole.pages });
    assert.deepEqual(await c.call('layoutDigest'), await again.call('layoutDigest'));
  } finally {
    host.terminate();
  }
});
