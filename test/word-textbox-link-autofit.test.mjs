// textbox-link-autofit (docs/plans/word/briefs/textbox-link-autofit.md): linked text boxes keep their link through export and
// import (Word keeps the story in the first box, wps:txbx id, and names it in each box after with wps:linkedTxbx id and seq), and a
// Word shape keeps its autofit setting (a:noAutofit, a:spAutoFit); a shape with none goes out as a Document's (Do not Autofit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocx, parseXml } from '../src/document/docx/import.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { readZip, text } from '../src/document/docx/zip.mjs';
import { canvasOf } from '../src/document/docx/shapes-in.mjs';
import { shapeDrawing } from '../src/document/docx/shapes-out.mjs';
import { shapeItem } from '../src/document/wp/shapes/map.mjs';
import { chainsOf } from '../src/document/wp/textbox/boxes.mjs';
import { PLAIN_FMT } from '../src/document/docx/dml.mjs';
import { THEME } from '../src/document/defaults.mjs';
import { TEXTBOX_DEFAULTS } from '../src/document/model/nodes.js';

const para = (t) => ({ type: 'paragraph', ...(t && { content: [{ type: 'text', text: t }] }) });
const box = (id, link, content = [para()], x = 0) => ({ type: 'textBox', attrs: { ...structuredClone(TEXTBOX_DEFAULTS), id, link,
  layout: { wrap: 'front', h: { rel: 'column', offset: x }, v: { rel: 'paragraph', offset: 0 } } }, content });
const docOf = (blocks) => ({ type: 'doc', attrs: {}, content: [...blocks, para('After')] });
const xmlOf = async (doc) => text((await readZip((await exportDocx(doc)).bytes)).get('word/document.xml'));
const boxes = (doc) => {
  const out = [];
  const walk = (n) => { if (n.type === 'textBox') out.push(n); (n.content ?? []).forEach(walk); };
  walk(doc);
  return out;
};
const words = (n) => (n.content ?? []).map((p) => (p.content ?? []).map((t) => t.text ?? '').join('')).join('|');

test('three linked boxes go out as one story in the first box and come back linked in the same order', async () => {
  // In document order the third box comes first, as Word wrote the fixture's case.
  const doc = docOf([box('c', null, [para()], 300), box('a', 'b', [para('One story.'), para('Second paragraph.')]), box('b', 'c', [para()], 150)]);
  const xml = await xmlOf(doc);
  const story = [...xml.matchAll(/<wps:txbx id="(\d+)"><w:txbxContent>(.*?)<\/w:txbxContent><\/wps:txbx>/g)];
  const next = [...xml.matchAll(/<wps:linkedTxbx id="(\d+)" seq="(\d+)"\/>/g)].map((m) => [m[1], m[2]]);
  assert.equal(story.length, 1, 'one box holds the story');
  assert.match(story[0][2], /One story\..*Second paragraph\./);
  assert.deepEqual(next, [[story[0][1], '2'], [story[0][1], '1']], 'the boxes after it name the story and their place');
  assert.doesNotMatch(xml, /<wps:txbx><w:txbxContent><w:p\/?>/, 'the empty boxes write no text of their own');

  const back = (await importDocx((await exportDocx(doc)).bytes)).doc;
  const [c, a, b] = boxes(back);
  assert.equal(words(a), 'One story.|Second paragraph.');
  assert.deepEqual([a.attrs.link, b.attrs.link, c.attrs.link], [b.attrs.id, c.attrs.id, null], 'first → second → third, the last links to none');
  assert.ok(a.attrs.id && b.attrs.id && c.attrs.id && new Set([a.attrs.id, b.attrs.id, c.attrs.id]).size === 3);
  assert.deepEqual([words(b), words(c)], ['', ''], 'the boxes after the first hold no text');

  // Exported again, the same story.
  const again = await xmlOf(back);
  assert.equal([...again.matchAll(/<wps:linkedTxbx /g)].length, 2);
  assert.equal([...again.matchAll(/<wps:txbx id="/g)].length, 1);
});

test('text typed into a later box joins the story after the first box\'s; a link to no box and a loop write plain boxes', async () => {
  const xml = await xmlOf(docOf([box('a', 'b', [para('First')]), box('b', null, [para('Typed later')])]));
  assert.match(xml, /<wps:txbx id="1"><w:txbxContent>.*First.*Typed later.*<\/w:txbxContent><\/wps:txbx>/);
  assert.match(xml, /<wps:linkedTxbx id="1" seq="1"\/>/);

  const lone = await xmlOf(docOf([box('a', 'gone', [para('Alone')])]));
  assert.doesNotMatch(lone, /linkedTxbx|<wps:txbx id=/, 'a link to a box that is not there is no story');
  const loop = await xmlOf(docOf([box('a', 'b', [para('A')]), box('b', 'a', [para()])]));
  assert.doesNotMatch(loop, /linkedTxbx/, 'a loop has no first box');
});

// --- autofit ---

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
  + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const ctx = { dml: { colors: THEME.colors, fonts: THEME.fonts, fmt: PLAIN_FMT }, fonts: THEME.fonts, text: { size: 11, color: '#000000', font: null },
  picture: () => null, partXml: () => null, drop: () => {} };
const shape = (fit) => parseXml(`<a:graphicData ${NS} uri="${WPS}"><wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="685800" cy="457200"/></a:xfrm>`
  + `<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></wps:spPr><wps:txbx><w:txbxContent><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:txbxContent></wps:txbx>`
  + `<wps:bodyPr anchor="ctr">${fit}</wps:bodyPr></wps:wsp></a:graphicData>`);
const fitOut = (item, canvas = {}) => {
  let n = 0;
  const xml = shapeDrawing({ w: 72, h: 48, dw: 72, items: [item], ...canvas }, { id: () => ++n, placed: (cx, cy, pr, g) => g }).xml;
  return /<a:(noAutofit|spAutoFit|normAutofit)\/>/.exec(xml)?.[1];
};

test("a Word shape keeps its autofit setting; a shape with none is Word's in a Document and a board's in a synced flowchart", () => {
  for (const [fit, want, out] of [['<a:noAutofit/>', false, 'noAutofit'], ['<a:spAutoFit/>', true, 'spAutoFit'], ['', false, 'noAutofit'],
    ['<a:normAutofit fontScale="90000"/>', false, 'noAutofit']]) {
    const [it] = canvasOf(shape(fit), 685800, 457200, ctx).attrs.items;
    assert.equal(it.autoFit, want, fit || 'no autofit element');
    assert.equal(fitOut(it), out);
  }
  // A shape stored before the setting was kept (or pasted in from a board) has none: Word's new shape keeps its size.
  const own = { id: 'b', type: 'shape', shape: 'rect', x: 0, y: 0, w: 72, h: 48, fill: 'solid', fillColor: '#FFFFFF', color: '#000000', width: 1, html: 'Mine' };
  assert.equal(fitOut(own), 'noAutofit', "a Document's own shape with no setting");
  assert.equal(fitOut(own, { flow: { id: 'f1', rev: 1 } }), 'spAutoFit', "a library flowchart's shape grows with its text");
  assert.equal(fitOut({ ...own, autoFit: true }), 'spAutoFit');
  // Insert > Shapes draws Word's new shape: Resize shape to fit text off.
  assert.equal(shapeItem('Rectangle').autoFit, false);
  assert.equal(fitOut(shapeItem('Rectangle')), 'noAutofit');
});

test('chainsOf reads each chain once from its first box; ids imported from two files differ', async () => {
  const b = (id, link) => ({ id, link });
  const [x, y, z, lone, p, q] = [b('x', 'y'), b('y', 'z'), b('z', null), b('l', 'gone'), b('p', 'q'), b('q', 'p')];
  assert.deepEqual(chainsOf([z, y, x, lone, p, q], (o) => o.id, (o) => o.link), [[x, y, z]], 'a link to no box and a loop are no chain');
  const ids = async (words) => boxes((await importDocx((await exportDocx(docOf([box('a', 'b', [para(words)]), box('b', null)]))).bytes)).doc).map((n) => n.attrs.id);
  const [one, two] = [await ids('First file'), await ids('Second file')];
  assert.equal(new Set([...one, ...two]).size, 4, "the second file's boxes do not take the first file's ids");
});
