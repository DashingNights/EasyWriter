// file-building-blocks (docs/plans/word briefs/file-building-blocks.md): the document's own building blocks (word/glossary) as
// entries beside the user's, Word's gallery values, placeholders hidden, and edits and deletes written back to the docPart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { documentExtensions } from '../src/document/schema.js';
import { exportDocx } from '../src/document/docx/export.mjs';
import { importDocx } from '../src/document/docx/import.mjs';
import { writeZip } from '../src/document/docx/zip.mjs';
import { autoTextResult, GALLERIES, matchAutoText } from '../src/document/wp/building-blocks/blocks.mjs';
import { docEntries, dropFromGlossary, FILE_GALLERIES, galleryName, patchGlossary } from '../src/document/wp/building-blocks/doc-blocks.mjs';
import { allEntries } from '../src/document/wp/building-blocks/store.js';

const schema = getSchema(documentExtensions(50));
const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const part = (name, gallery, extra = {}) => ({ name, gallery, category: 'General', behaviors: ['content'], content: [p(`${name} text`)], ...extra });
const GLOSSARY = [
  part('3F2A9C', 'placeholder', { types: ['bbPlcHdr'] }),
  part('Sign-off', 'docParts', { description: 'Letter end', guid: '{A1}' }),
  part('Letterhead', 'hdrs', { category: 'Company', behaviors: ['p'], guid: '{A2}' }),
  part('addr', 'autoTxt', { guid: '{A3}' }),
  part('Old', 'default'),
  part('Bad', 'docParts', { content: [{ type: 'noSuchNode' }] }),
];

test('every file gallery value names one of Word\'s 35 galleries, and all 35 are reachable', () => {
  assert.ok(Object.values(FILE_GALLERIES).every((g) => GALLERIES.includes(g)));
  assert.deepEqual(new Set(Object.values(FILE_GALLERIES)), new Set(GALLERIES));
  assert.equal(galleryName('custQuickParts'), 'Custom Quick Parts');
  assert.equal(galleryName('Quick Parts'), 'Quick Parts'); // a writer that puts the name in
  assert.equal(galleryName('placeholder'), null);
});

test('the document\'s blocks: placeholders, gallery-less and invalid docParts hidden; gallery, category and Options from the file', () => {
  const list = docEntries(GLOSSARY, schema);
  assert.deepEqual(list.map((e) => [e.id, e.name, e.gallery, e.category, e.insert, e.index, e.source]), [
    ['doc:{A1}', 'Sign-off', 'Quick Parts', 'General', 'content', 1, 'doc'],
    ['doc:{A2}', 'Letterhead', 'Headers', 'Company', 'paragraph', 2, 'doc'],
    ['doc:{A3}', 'addr', 'AutoText', 'General', 'content', 3, 'doc'],
  ]);
  assert.equal(list[0].description, 'Letter end');
  assert.deepEqual(docEntries(undefined), []);
});

test('the merged list puts the document\'s blocks first, then the stored ones; F3 and AUTOTEXT find a document block', () => {
  const doc = schema.nodeFromJSON({ type: 'doc', attrs: { settings: { glossary: GLOSSARY } }, content: [p('x')] });
  const all = allEntries(doc);
  assert.deepEqual(all.map((e) => e.name), ['Sign-off', 'Letterhead', 'addr']); // no store outside the app
  assert.equal(matchAutoText(all, 'my addr').entry.id, 'doc:{A3}');
  assert.equal(autoTextResult(all, 'addr'), 'addr text');
  assert.deepEqual(allEntries(schema.nodeFromJSON({ type: 'doc', content: [p('x')] })), []);
});

test('edit properties and delete write the docPart back in the file\'s values, keeping the rest', () => {
  const [signOff, letterhead] = docEntries(GLOSSARY, schema);
  const moved = patchGlossary(GLOSSARY, signOff, { ...signOff, name: 'Close', gallery: 'Custom Footers', category: 'Letters', description: '', insert: 'page' });
  assert.deepEqual(moved[1], { name: 'Close', gallery: 'custFtrs', category: 'Letters', behaviors: ['pg'], content: GLOSSARY[1].content, guid: '{A1}' });
  assert.equal(moved[2], GLOSSARY[2], 'other docParts untouched');
  const same = patchGlossary(GLOSSARY, letterhead, { ...letterhead, name: 'Head' });
  assert.equal(same[2].gallery, 'hdrs', 'an unchanged gallery keeps the file value');
  assert.deepEqual(same[2].behaviors, ['p']);
  const fewer = dropFromGlossary(GLOSSARY, letterhead);
  assert.equal(fewer.length, GLOSSARY.length - 1);
  assert.ok(!fewer.some((d) => d.name === 'Letterhead'));
  assert.deepEqual(docEntries(fewer, schema).map((e) => e.id), ['doc:{A1}', 'doc:{A3}'], 'GUID ids survive the delete');
});

test('a .docx glossary block imports as a document block and an edited one exports with Word\'s gallery value', async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const xmlPart = (name, gallery) => `<w:docPart><w:docPartPr><w:name w:val="${name}"/><w:category><w:name w:val="General"/><w:gallery w:val="${gallery}"/></w:category>`
    + `<w:behaviors><w:behavior w:val="content"/></w:behaviors><w:guid w:val="{G-${name}}"/></w:docPartPr><w:docPartBody><w:p><w:r><w:t>${name} body</w:t></w:r></w:p></w:docPartBody></w:docPart>`;
  const bytes = await writeZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:body></w:document>`],
    ['word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="${RT}glossaryDocument" Target="glossary/document.xml"/></Relationships>`],
    ['word/glossary/document.xml', `<?xml version="1.0"?><w:glossaryDocument ${W}><w:docParts>${xmlPart('PH', 'placeholder')}${xmlPart('Motto', 'docParts')}</w:docParts></w:glossaryDocument>`],
  ]);
  const { doc } = await importDocx(bytes, { fresh: true });
  const node = schema.nodeFromJSON(doc);
  const [motto, ...rest] = allEntries(node);
  assert.equal(rest.length, 0);
  assert.deepEqual([motto.name, motto.gallery, motto.id, motto.content[0].content[0].text], ['Motto', 'Quick Parts', 'doc:{G-Motto}', 'Motto body']);
  const glossary = patchGlossary(doc.attrs.settings.glossary, motto, { ...motto, gallery: 'AutoText' });
  const out = await exportDocx({ ...doc, attrs: { ...doc.attrs, settings: { ...doc.attrs.settings, glossary } } }, { title: 'x' });
  const back = (await importDocx(out.bytes, { fresh: true })).doc.attrs.settings.glossary;
  assert.deepEqual(back.map((d) => [d.name, d.gallery]), [['PH', 'placeholder'], ['Motto', 'autoTxt']]);
});
