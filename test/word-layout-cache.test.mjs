// layout-cache (docs/plans/word/briefs/layout-cache.md): the keys, matching, culling rules, Word's hints and the page hints a .docx
// carries out and back in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { documentExtensions } from '../src/document/schema.js';
import { buildCache, cullSet, hash, hintCount, holdsFloat, keysOf, matchCache, pageStartsOf, readByPasses, VERSION } from '../src/document/layout-cache.mjs';
import { exportDocx, withRenderedBreaks } from '../src/document/docx/export.mjs';
import { importDocx } from '../src/document/docx/import.mjs';

const schema = getSchema(documentExtensions(50));
const P = (s, attrs = {}, marks) => ({ type: 'paragraph', attrs, content: s ? [{ type: 'text', text: s, ...(marks && { marks }) }] : [] });
const SECT = { w: 595.3, h: 841.9, orient: 'portrait', margin: { top: 72, right: 72, bottom: 72, left: 72, header: 35.4, footer: 35.4, gutter: 0 } };
const ATTRS = {
  sect: SECT,
  styles: { defaults: { run: { font: '+minor', size: 12 } }, list: { Normal: { type: 'paragraph', name: 'Normal' } } },
  theme: { name: 'T', fonts: { major: 'Aptos Display', minor: 'Aptos' } },
  settings: { defaultTabStop: 36 },
};
const docOf = (content, attrs = ATTRS) => schema.nodeFromJSON({ type: 'doc', attrs, content });
const body = (n) => Array.from({ length: n }, (_, i) => P(`Paragraph ${i} ${'text '.repeat(i % 7)}`));
const env = { available: (f) => f !== 'Missing Font' };

test('hash is stable and tells strings apart', () => {
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
  assert.match(hash(''), /^[0-9a-z]+$/);
});

test('a block keeps its key until its content, its section or the document inputs change', () => {
  const a = docOf(body(6));
  const k = keysOf(a, env);
  assert.equal(k.length, 6);
  assert.equal(new Set(k).size, 6);
  assert.deepEqual(keysOf(docOf(body(6)), env), k, 'the same content gives the same keys');
  const edited = body(6);
  edited[3] = P('Changed');
  const k2 = keysOf(docOf(edited), env);
  assert.deepEqual(k2.map((x, i) => x === k[i]), [true, true, true, false, true, true], 'only the edited block');
  const styled = keysOf(docOf(body(6), { ...ATTRS, styles: { ...ATTRS.styles, defaults: { run: { font: '+minor', size: 13 } } } }), env);
  assert.ok(styled.every((x, i) => x !== k[i]), 'a style change changes every key');
  const wide = keysOf(docOf(body(6), { ...ATTRS, sect: { ...SECT, margin: { ...SECT.margin, left: 36 } } }), env);
  assert.ok(wide.every((x, i) => x !== k[i]), 'the page setup is in the key');
  assert.deepEqual(keysOf(a, { available: env.available }), k, 'the pixel ratio is not in the key (a screen at another scale keeps the cache)');
  // A run's own font: only that block's key follows whether it is installed.
  const fonted = body(4);
  fonted[1] = P('Odd font', {}, [{ type: 'textStyle', attrs: { font: 'Missing Font' } }]);
  const f1 = keysOf(docOf(fonted), env);
  const f2 = keysOf(docOf(fonted), { available: () => true });
  assert.deepEqual(f1.map((x, i) => x === f2[i]), [true, false, true, true]);
});

test('a cache matches blocks by key, also after blocks were inserted above them', () => {
  const doc = docOf(body(8));
  const heights = [10, 20, 30, 40, 50, 60, 70, 80];
  const cache = buildCache(doc, { env, heights, pages: [[3, 0], [6, 2]], count: 3 });
  assert.equal(cache.v, VERSION);
  assert.equal('frames' in cache, false, 'object frames are not stored');
  const same = matchCache(doc, JSON.parse(JSON.stringify(cache)), env);
  assert.equal(same.hits, 8);
  assert.deepEqual([...same.heights], heights);
  // Two blocks in, one changed: the others keep their heights at their new places, the page starts follow their blocks.
  const next = body(8);
  next.splice(1, 0, P('New one'), P('New two'));
  next[7] = P('Edited');
  const m = matchCache(docOf(next), cache, env);
  assert.equal(m.hits, 7);
  assert.deepEqual([...m.heights].map((h) => (Number.isNaN(h) ? null : h)), [10, null, null, 20, 30, 40, 50, null, 70, 80]);
  assert.deepEqual(m.pages, [[5, 0], [8, 2]]);
  assert.equal(matchCache(doc, { ...cache, v: VERSION + 1 }, env), null, 'another version matches nothing');
  assert.equal(matchCache(doc, null, env), null);
});

test('culling leaves the blocks at page starts and the pages around a float', () => {
  const n = 20;
  const all = cullSet(n, { ok: () => true, height: () => 10, float: () => false, starts: [5, 10, 15] });
  assert.deepEqual([...all].map((v, i) => (v ? -1 : i)).filter((i) => i >= 0), [4, 5, 9, 10, 14, 15]);
  const unknown = cullSet(n, { ok: () => true, height: (i) => (i === 2 ? NaN : 10), float: () => false, starts: [] });
  assert.equal(unknown[2], 0, 'no height, no culling');
  // A float in block 7 (page 1: blocks 5 to 9): page 1 and page 2 (10 to 14) stay drawn.
  const f = cullSet(n, { ok: () => true, height: () => 10, float: (i) => i === 7, starts: [5, 10, 15] });
  assert.deepEqual([...f.slice(5, 15)], new Array(10).fill(0));
  assert.equal(f[2], 1);
  assert.equal(f[16], 1);
});

test('holdsFloat finds anchored objects, frames and note references from the model', () => {
  const plain = docOf([P('Plain')]).child(0);
  assert.equal(holdsFloat(plain), false);
  assert.equal(holdsFloat(docOf([P('Framed', { frame: { w: 100 } })]).child(0)), true);
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const anchored = docOf([{ type: 'paragraph', content: [{ type: 'image', attrs: { src: PNG, width: 40, height: 30, layout: { wrap: 'square' } } }] }]).child(0);
  assert.equal(holdsFloat(anchored), true);
  const inline = docOf([{ type: 'paragraph', content: [{ type: 'image', attrs: { src: PNG, width: 40, height: 30 } }] }]).child(0);
  assert.equal(holdsFloat(inline), false);
  const noted = docOf([{ type: 'paragraph', content: [{ type: 'text', text: 'x' }, { type: 'noteRef', attrs: { kind: 'footnote', id: 'n1', content: [P('n')] } }] }]).child(0);
  assert.equal(holdsFloat(noted), true);
});

test('paragraphs the tabs pass reads each layout stay drawn', () => {
  assert.equal(readByPasses(docOf([P('Plain words')]).child(0)), false);
  assert.equal(readByPasses(docOf([P('A	B')]).child(0)), true, 'a tab');
  assert.equal(readByPasses(docOf([P('Item', { numbering: { numId: '1', ilvl: 0 } })]).child(0)), true, 'a list number before its tab');
  const ptab = docOf([{ type: 'paragraph', content: [{ type: 'text', text: 'x' }, { type: 'ptab', attrs: { align: 'right', relativeTo: 'margin', leader: 'none' } }] }]).child(0);
  assert.equal(readByPasses(ptab), true, 'a positional tab');
});

test("Word's hints give the page count: app.xml's Pages, else the marked page starts", () => {
  assert.equal(hintCount(docOf(body(3), { ...ATTRS, props: { breaks: [1, 2], pages: 7 } })), 7);
  assert.equal(hintCount(docOf(body(3), { ...ATTRS, props: { breaks: [1, 2] } })), 3);
  assert.equal(hintCount(docOf(body(3))), null);
});

test('page starts count characters as the export counts them back', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const json = { type: 'doc', attrs: ATTRS, content: [
    P('First block'),
    { type: 'paragraph', content: [{ type: 'text', text: 'abc' }, { type: 'image', attrs: { src: PNG, width: 4, height: 4 } }, { type: 'text', text: 'defgh' }] },
    { type: 'table', content: [{ type: 'tableRow', content: [
      { type: 'tableCell', content: [P('cell one')] }, { type: 'tableCell', content: [P('cell two')] }] }] },
  ] };
  const doc = schema.nodeFromJSON(json);
  const at = (i) => { let p = 0; for (let k = 0; k < i; k++) p += doc.child(k).nodeSize; return p; };
  // Block 1 at "d" (after abc and the picture), block 2 at the second cell's text start.
  const posD = at(1) + 1 + 4;
  let posCell2 = null;
  doc.child(2).descendants((n, p) => { if (n.isText && n.text === 'cell two') posCell2 = at(2) + 1 + p; });
  const starts = pageStartsOf(doc, [posD, posCell2]);
  assert.deepEqual(starts, [[1, 4], [2, 8]]);
  const marked = withRenderedBreaks(json, starts);
  assert.notEqual(marked, json);
  assert.deepEqual(json.content[1].content.map((n) => n.type), ['text', 'image', 'text'], 'the input stays as it was');
  assert.deepEqual(marked.content[1].content.map((n) => n.type === 'text' ? n.text : n.type), ['abc', 'image', 'lastRenderedPageBreak', 'defgh']);
  assert.deepEqual(marked.content[2].content[0].content[1].content[0].content.map((n) => n.type), ['lastRenderedPageBreak', 'text']);
});

test('a .docx carries the page hints out and back in, and opens with the same content', async () => {
  const content = [...body(5), { type: 'paragraph', content: [{ type: 'text', text: 'one two three four' }] }, ...body(3)];
  const json = { type: 'doc', attrs: ATTRS, content };
  const plain = await importDocx((await exportDocx(json)).bytes);
  const hinted = await exportDocx(json, { pageStarts: [[3, 0], [5, 8]] });
  const back = await importDocx(hinted.bytes);
  assert.deepEqual(back.doc.attrs.props?.breaks, [3, 5]);
  const strip = (d) => JSON.stringify(d.content);
  assert.equal(strip(back.doc), strip(plain.doc), 'the hints change nothing else');
  assert.equal(plain.doc.attrs.props?.breaks, undefined);
});
