// controls-pages (docs/plans/word/briefs/controls-pages.md): the rules behind the content control pages of the Word fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocx } from '../src/document/docx/import.mjs';
import { writeZip } from '../src/document/docx/zip.mjs';
import { makeMeasurer } from '../src/document/layout/measure.mjs';
import { lineExtra } from '../src/document/wp/paragraph/rules.mjs';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
const docx = (body) => writeZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['word/document.xml', `<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`],
  ['word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'],
]);
const walk = (n, out = []) => { if (n && typeof n === 'object') { out.push(n); for (const k of n.content ?? []) walk(k, out); } return out; };

test('rows inside a repeating section and its item controls are read as rows', async () => {
  const row = (t) => `<w:tr><w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc></w:tr>`;
  const item = (t) => `<w:sdt><w:sdtPr><w:id w:val="2"/><w15:repeatingSectionItem/></w:sdtPr><w:sdtContent>${row(t)}</w:sdtContent></w:sdt>`;
  const body = `<w:tbl><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>${row('Head')}`
    + `<w:sdt><w:sdtPr><w:id w:val="1"/><w15:repeatingSection/></w:sdtPr><w:sdtContent>${item('One')}${item('Two')}</w:sdtContent></w:sdt></w:tbl>`;
  const { doc } = await importDocx(await docx(body), { fresh: true });
  const rows = walk(doc).filter((n) => n.type === 'tableRow');
  assert.deepEqual(rows.map((r) => walk(r).filter((n) => n.type === 'text').map((n) => n.text).join('')), ['Head', 'One', 'Two']);
});

test('the layout predictor measures without kerning unless the run kerns', () => {
  const seen = [];
  const g = { font: '', fontKerning: 'auto', measureText: (t) => (seen.push(g.fontKerning), { width: t.length }) };
  const m = makeMeasurer(g);
  m.width('12px Aptos', 'Ta');
  m.width('12px Aptos', 'Ta', true);
  assert.deepEqual(seen, ['none', 'normal']);
  assert.equal(g.fontKerning, 'none');
});

test('a picture line under Multiple spacing keeps the multiple share of Single under the picture', () => {
  // walk/picline_docx.py: Aptos 12 pt (Single 14.64 pt) at 1.5 lines leaves 7.32 pt, at double 14.64 pt; none at Single or Exactly.
  assert.equal(lineExtra({ rule: 'auto', value: 1.5 }, 14.64), 7.32);
  assert.equal(lineExtra({ rule: 'auto', value: 2 }, 14.64), 14.64);
  assert.equal(lineExtra({ rule: 'auto', value: 1 }, 14.64), 0);
  assert.equal(lineExtra({ rule: 'exact', value: 20 }, 14.64), 0);
  assert.equal(lineExtra(null, 14.64), 0);
});
