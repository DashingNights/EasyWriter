// open-worker (docs/plans/word/briefs/open-worker.md): Word's saved page count as the opening card's estimate, and the reader
// worker's messages (src/document/docx/worker.js, run here on Node's globals).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocx } from '../src/document/docx/import.mjs';
import { writeZip } from '../src/document/docx/zip.mjs';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
  + ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
/** A .docx with `body` and the extra `parts` [[name, data]]. */
const docx = (body = '<w:p><w:r><w:t>Hi</w:t></w:r></w:p>', parts = []) => writeZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['word/document.xml', `<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`],
  ...parts,
]);
const app = (pages) => ['docProps/app.xml', `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Template>Normal.dotm</Template><Pages>${pages}</Pages></Properties>`];

test('docProps/app.xml Pages is kept as doc.attrs.props.pages, beside the app properties', async () => {
  const { doc } = await importDocx(await docx(undefined, [app(966)]));
  assert.equal(doc.attrs.props.pages, 966);
  assert.equal(doc.attrs.props.app.template, 'Normal.dotm');
  assert.equal((await importDocx(await docx())).doc.attrs.props?.pages, undefined, 'no app.xml: no estimate');
  assert.equal((await importDocx(await docx(undefined, [app('none')]))).doc.attrs.props?.pages, undefined, 'not a number: no estimate');
});

test('the worker says it started, asks the page for metafile pictures, then posts the read as JSON, or the error', async () => {
  const posted = [];
  globalThis.self = globalThis;
  globalThis.postMessage = (m) => posted.push(m);
  await import('../src/document/docx/worker.js');

  // An EMF picture: the worker asks for its PNG and waits for the page's answer.
  const drawing = `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="1" name="m"/><a:graphic><a:graphicData uri="${PIC}">`
    + '<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="m"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdM"/></pic:blipFill><pic:spPr/></pic:pic>'
    + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const bytes = await docx(drawing, [app(3),
    ['word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdM" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.emf"/></Relationships>'],
    ['word/media/image1.emf', new Uint8Array([1, 0, 0, 0, 0x6c, 0, 0, 0])]]);
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const done = self.onmessage({ data: { name: 'Report.docx', bytes, settings: null } });
  for (let i = 0; i < 200 && !posted.some((m) => m.metafiles); i++) await new Promise((r) => setTimeout(r, 5));
  const ask = posted.find((m) => m.metafiles);
  assert.ok(ask && ask.items.length === 1 && typeof ask.items[0].data === 'string', 'one metafile request with the picture as base64');
  await self.onmessage({ data: { id: ask.metafiles, pngs: [PNG] } });
  await done;
  assert.equal(posted[0].stage, 'reading', 'the first message says the worker started');
  const read = JSON.parse(posted.at(-1).json);
  assert.equal(read.doc.attrs.props.pages, 3);
  const pics = [];
  (function walk(n) { if (n?.type === 'image') pics.push(n.attrs); (n?.content ?? []).forEach(walk); })(read.doc);
  assert.equal(pics[0]?.src, PNG, 'the page drew the metafile');
  assert.match(pics[0].metafile, /^data:image\/x-emf;base64,/, 'the original stays for export');
  assert.deepEqual(read.dropped, []);

  posted.length = 0;
  await self.onmessage({ data: { name: 'broken.docx', bytes: new Uint8Array([7, 7, 7, 7, 7, 7]) } });
  assert.equal(posted.length, 2);
  assert.ok(typeof posted[1].error === 'string' && posted[1].error.length > 0, 'a file that is no Word file posts the reason');
});
