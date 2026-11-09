// nbhyphen (docs/plans/word/briefs/nbhyphen.md): the empty paragraph that holds a continuous section's properties takes no room in
// Word unless it is the only paragraph of its section (probe fixture/out/probe/nbhyphen/sectpara). Import keeps it as an empty
// paragraph only then; otherwise only the section break remains, which document.css draws at no height.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocx } from '../src/document/docx/import.mjs';
import { writeZip } from '../src/document/docx/zip.mjs';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const docx = (body) => writeZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['word/document.xml', `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`],
  ['word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'],
]);
const p = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const sectP = '<w:p><w:pPr><w:spacing w:before="400" w:after="400"/><w:sectPr><w:type w:val="continuous"/></w:sectPr></w:pPr></w:p>';
const shape = async (body) => (await importDocx(await docx(body), { fresh: true })).doc.content
  .map((n) => (n.type === 'paragraph' ? (n.content ? 'p' : 'empty') : n.type === 'sectionBreak' ? 'break' : n.type));

test('an empty section paragraph after text leaves only its break', async () => {
  assert.deepEqual(await shape(p('A') + sectP + p('B')), ['p', 'break', 'p']);
});

test('a section paragraph alone in its section keeps its empty line', async () => {
  assert.deepEqual(await shape(p('A') + sectP + sectP + p('B')), ['p', 'break', 'empty', 'break', 'p']);
  assert.deepEqual(await shape(sectP + p('B')), ['empty', 'break', 'p']);
});

test('a section paragraph with text keeps its paragraph', async () => {
  const withText = '<w:p><w:pPr><w:sectPr><w:type w:val="continuous"/></w:sectPr></w:pPr><w:r><w:t>X</w:t></w:r></w:p>';
  assert.deepEqual(await shape(p('A') + withText + sectP + p('B')), ['p', 'p', 'break', 'empty', 'break', 'p']);
});
