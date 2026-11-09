import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, readZip, text, writeZip } from '../src/document/docx/zip.mjs';

test('zip: crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('zip: what writeZip packs, readZip reads back', async () => {
  const pic = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
  const zip = await writeZip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document>héllo</w:document>'], ['word/media/a.png', pic]]);
  const files = await readZip(zip);
  assert.deepEqual([...files.keys()], ['[Content_Types].xml', 'word/document.xml', 'word/media/a.png']);
  assert.equal(text(files.get('word/document.xml')), '<w:document>héllo</w:document>');
  assert.deepEqual(files.get('word/media/a.png'), pic);
  await assert.rejects(readZip(new Uint8Array(40)), /not a \.docx/);
});
