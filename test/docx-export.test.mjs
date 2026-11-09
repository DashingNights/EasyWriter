import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportDocx } from '../src/document/docx/export.mjs';
import { readZip, text } from '../src/document/docx/zip.mjs';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { documentExtensions } from '../src/document/schema.js';
import { accept, entries } from '../src/suggest/core.mjs';
import { Suggestions } from '../src/suggest/extension.js';

const P = (s, attrs = {}, marks) => ({ type: 'paragraph', attrs, content: s ? [{ type: 'text', text: s, ...(marks && { marks }) }] : [] });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const FIXTURE = {
  type: 'doc',
  attrs: {
    sect: { w: 595.3, h: 841.9, orient: 'portrait', margin: { top: 72, right: 72, bottom: 72, left: 72, header: 35.4, footer: 35.4, gutter: 0 },
      hdr: { default: [P('Header text')] }, ftr: null },
    styles: { defaults: { run: { font: '+minor', size: 12 }, para: { spacing: { after: 8, line: { rule: 'auto', value: 1.15 } } } },
      list: { Normal: { type: 'paragraph', name: 'Normal' }, Heading1: { type: 'paragraph', name: 'heading 1', basedOn: 'Normal', run: { font: '+major', size: 20 } } } },
    numbering: { abstract: { bullet: { levels: [{ fmt: 'bullet', text: '•', start: 1, left: 36, hanging: 18 }] } }, nums: { 1: { abstract: 'bullet' } } },
    theme: { name: 'Default', fonts: { major: 'Aptos Display', minor: 'Aptos' }, colors: { accent1: '#156082' } },
    settings: { defaultTabStop: 36 },
    comments: { c1: { author: 'Kim', initials: 'K', date: '2026-10-28T10:00:00Z', content: [P('A comment')] } },
  },
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title & <more>' }] },
    P('Bold red', { textAlign: 'center' }, [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#FF0000', size: 14 } }]),
    P('A list item', { numbering: { numId: '1', ilvl: 0 } }),
    { type: 'paragraph', content: [{ type: 'text', text: 'Noted', marks: [{ type: 'comment', attrs: { id: 'c1' } }] },
      { type: 'noteRef', attrs: { kind: 'footnote', id: 'n1', content: [P('Footnote text')] } },
      { type: 'text', text: ' link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
      { type: 'image', attrs: { src: PNG, width: 40, height: 30, alt: 'dot' } }] },
    { type: 'table', content: [
      { type: 'tableRow', content: [{ type: 'tableCell', attrs: { rowspan: 2, colwidth: [100] }, content: [P('A')] }, { type: 'tableCell', attrs: { colwidth: [100] }, content: [P('B')] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [P('C')] }] },
    ] },
    { type: 'sectionBreak', attrs: { kind: 'nextPage', sect: { type: 'nextPage', w: 841.9, h: 595.3, orient: 'landscape', margin: { top: 72, right: 72, bottom: 72, left: 72 } } } },
    P('Second section'),
  ],
};

/** Whether `xml` closes every tag it opens, in order. */
function balanced(xml) {
  const stack = [];
  for (const [, close, name, self] of xml.replace(/<\?[^>]*\?>/g, '').matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    if (self) continue;
    if (!close) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0;
}

test('docx export: the parts, and each feature in document.xml', async () => {
  const { bytes, dropped } = await exportDocx(FIXTURE, { title: 'Test' });
  const files = await readZip(bytes);
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/settings.xml', 'word/theme/theme1.xml',
    'word/footnotes.xml', 'word/comments.xml', 'word/header1.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) assert.ok(files.has(p), p);
  assert.ok(!files.has('docProps/easywriter.json'), 'no stash without canvases or plan charts');
  for (const [p, b] of files) if (/\.(xml|rels)$/.test(p)) assert.ok(balanced(text(b)), `${p} is well formed`);
  const d = text(files.get('word/document.xml'));
  assert.match(d, /<w:pStyle w:val="Heading1"\/>.*Title &amp; &lt;more&gt;/);
  assert.match(d, /<w:jc w:val="center"\/>/);
  assert.match(d, /<w:b\/>.*<w:color w:val="FF0000"\/>.*<w:sz w:val="28"\/>/);
  assert.match(d, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr>/);
  assert.match(d, /<w:commentRangeStart w:id="0"\/>.*Noted.*<w:commentRangeEnd w:id="0"\/>.*<w:commentReference w:id="0"\/>/);
  assert.match(d, /<w:footnoteReference w:id="1"\/>/);
  assert.match(d, /<w:hyperlink r:id="rId\d+" w:history="1">/);
  assert.match(d, /<wp:inline .*<wp:extent cx="381000" cy="285750"\/>.*descr="dot"/);
  assert.match(d, /<w:vMerge w:val="restart"\/>.*<w:vMerge\/>/);
  assert.match(d, /<w:sectPr><w:type w:val="nextPage"\/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"\/>/);
  assert.match(d, /<w:headerReference w:type="default" r:id="rId\d+"\/>/);
  assert.match(text(files.get('word/footnotes.xml')), /<w:footnote w:id="1">.*Footnote text/);
  assert.match(text(files.get('word/comments.xml')), /w:author="Kim".*A comment/);
  assert.match(text(files.get('word/header1.xml')), /Header text/);
  assert.ok(files.has('word/media/image1.png'));
  assert.deepEqual(dropped, []);
});

test('docx import: what export writes reads back', async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const { bytes } = await exportDocx(FIXTURE, { title: 'Test' });
  const { doc, title, dropped } = await importDocx(bytes);
  assert.equal(title, 'Test');
  assert.deepEqual(dropped, []);
  const c = doc.content;
  assert.deepEqual(c.map((n) => n.type), ['heading', 'paragraph', 'paragraph', 'paragraph', 'table', 'sectionBreak', 'paragraph']);
  assert.equal(c[0].attrs.level, 1);
  assert.equal(c[0].content[0].text, 'Title & <more>');
  assert.equal(c[1].attrs.textAlign, 'center');
  assert.deepEqual(c[1].content[0].marks.map((m) => m.type), ['bold', 'textStyle']);
  assert.equal(c[1].content[0].marks[1].attrs.color, '#FF0000');
  assert.equal(c[1].content[0].marks[1].attrs.size, 14);
  assert.deepEqual(c[2].attrs.numbering, { numId: '1', ilvl: 0 });
  assert.equal(doc.attrs.numbering.abstract[doc.attrs.numbering.nums['1'].abstract].levels[0].text, '•');
  const inl = c[3].content;
  assert.deepEqual(inl.map((n) => n.type), ['text', 'noteRef', 'text', 'image']);
  assert.equal(inl[0].marks[0].type, 'comment');
  assert.equal(doc.attrs.comments[inl[0].marks[0].attrs.id].author, 'Kim');
  assert.equal(inl[1].attrs.content[0].content[0].text, 'Footnote text');
  assert.equal(inl[2].marks[0].attrs.href, 'https://example.com');
  assert.match(inl[3].attrs.src, /^data:image\/png;base64,/);
  assert.equal(inl[3].attrs.width, 40);
  const [r1, r2] = c[4].content;
  assert.equal(r1.content[0].attrs.rowspan, 2);
  assert.equal(r2.content.length, 1);
  assert.equal(r2.content[0].content[0].content[0].text, 'C');
  assert.equal(c[5].attrs.sect.orient, 'landscape');
  assert.equal(c[5].attrs.sect.hdr, null);
  assert.equal(doc.attrs.sect.hdr.default[0].content[0].text, 'Header text');
  assert.equal(doc.attrs.styles.list.Heading1.run.size, 20);
});

test("docx stash: a file's own canvases and plan charts reopen as those only while every other part is as export wrote it", async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const { writeZip } = await import('../src/document/docx/zip.mjs');
  const { packageHash } = await import('../src/document/docx/export.mjs');
  const canvas = { type: 'canvas', attrs: { w: 300, h: 200, dw: 300, items: [{ id: 'a', type: 'rect' }] } };
  const chart = { type: 'planChart', attrs: { id: 'abc1234', planId: 'p1', view: 'gantt' } };
  const doc = { type: 'doc', attrs: FIXTURE.attrs, content: [P('Before'), { ...canvas, attrs: { ...canvas.attrs, suggest: { ins: { old: 'secret' } } } }, chart, P('After')] };
  const png = Buffer.from(PNG.split(',')[1], 'base64');
  const { bytes } = await exportDocx(doc, { picture: async () => ({ bytes: png, ext: 'png', w: 10, h: 10 }) });
  const files = await readZip(bytes);
  const raw = text(files.get('docProps/easywriter.json'));
  assert.ok(!raw.includes('secret') && !raw.includes('Before'), 'the stash holds no suggestion record and no text');
  const stash = JSON.parse(raw);
  for (const [id, n] of Object.entries(stash.nodes)) assert.match(text(files.get('word/document.xml')), new RegExp(`<wp:docPr id="${id}" name="${n.type === 'canvas' ? 'Canvas' : 'Plan chart'}"`));

  const own = (await importDocx(bytes)).doc;
  assert.deepEqual(own.content.slice(1, 3), [canvas, chart]);
  assert.deepEqual(own.content.map((n) => n.type), ['paragraph', 'canvas', 'planChart', 'paragraph']);

  const pictures = async (changed, why) => {
    const d = (await importDocx(await writeZip([...files].map(([n, b]) => [n, changed[n] ?? b])))).doc;
    assert.deepEqual(d.content.map((n) => n.type), ['paragraph', 'paragraph', 'paragraph', 'paragraph'], why);
    assert.equal(d.content[1].content[0].type, 'image', why);
    return d;
  };
  const header = text(files.get('word/header1.xml')).replace('Header text', 'Header edited');
  const edited = await pictures({ 'word/header1.xml': header }, 'a changed header part');
  assert.equal(edited.attrs.sect.hdr.default[0].content[0].text, 'Header edited');
  await pictures({ 'docProps/easywriter.json': JSON.stringify({ ...stash, hash: '0'.repeat(64) }) }, 'a wrong hash');
  await pictures({ 'docProps/easywriter.json': JSON.stringify({ hash: stash.hash, doc }) }, 'an old whole-Document stash');
  const crafted = Object.fromEntries(Object.keys(stash.nodes).map((id) => [id, { type: 'paragraph', content: [{ type: 'text', text: 'Spoof' }] }]));
  await pictures({ 'docProps/easywriter.json': JSON.stringify({ hash: await packageHash(files), nodes: crafted }) }, 'a stash with other nodes');
  assert.deepEqual((await importDocx(bytes, { fresh: true })).doc.content.map((n) => n.type), ['paragraph', 'paragraph', 'paragraph', 'paragraph'], 'fresh');
});

test('a file with no default size or font opens at Word\'s 10 pt Times New Roman, not a new Document\'s defaults', async () => {
  const { writeZip } = await import('../src/document/docx/zip.mjs');
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const bytes = await writeZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>`],
    ['word/styles.xml', `<?xml version="1.0"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault></w:docDefaults>`
      + '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>'],
  ]);
  const { doc } = await importDocx(bytes, { fresh: true });
  const run = doc.attrs.styles.defaults.run;
  assert.equal(run.size, 10);
  assert.equal(run.font, 'Times New Roman');
  assert.equal(run.typography, undefined);
  assert.deepEqual(doc.attrs.styles.defaults.para, {});
});

test('a file\'s default styles read as Normal and TableNormal, and a paragraph without a style draws as Normal', async () => {
  const { writeZip } = await import('../src/document/docx/zip.mjs');
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const { styleSheetCss } = await import('../src/document/stylesheet.js');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const cell = '<w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc>';
  const bytes = await writeZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p>`
      + '<w:p><w:pPr><w:pStyle w:val="Standard"/></w:pPr><w:r><w:t>Named</w:t></w:r></w:p>'
      + `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${cell}</w:tr></w:tbl></w:body></w:document>`],
    ['word/styles.xml', `<?xml version="1.0"?><w:styles ${W}>`
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Tahoma" w:hAnsi="Tahoma"/><w:sz w:val="20"/></w:rPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:basedOn w:val="Standard"/><w:next w:val="Standard"/></w:style>'
      + '<w:style w:type="table" w:default="1" w:styleId="NormaleTabelle"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:left w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
      + '</w:styles>'],
  ]);
  const { doc } = await importDocx(bytes, { fresh: true });
  const { list } = doc.attrs.styles;
  assert.deepEqual(list.Normal.run, { font: 'Tahoma', size: 10 });
  assert.equal(list.Standard, undefined);
  assert.equal(list.Body.basedOn, 'Normal');
  assert.equal(list.Body.next, 'Normal');
  assert.equal(list.TableNormal.table.cellMargin.left, 5.4);
  assert.deepEqual(doc.content.map((n) => n.attrs?.styleId ?? null), [null, null, 'TableNormal']);
  assert.match(styleSheetCss('.s', doc.attrs.styles, doc.attrs.theme), /\.s p:not\(\[data-style\]\)\{font-family:[^;]*Tahoma[^;]*;font-size:10pt\}/);
});

test('a .thmx written from a theme reads back as that theme', async () => {
  const { thmxOf } = await import('../src/document/docx/export.mjs');
  const { readThemeFile } = await import('../src/document/docx/import.mjs');
  const theme = { name: 'Harbour', fonts: { major: 'Georgia', minor: 'Verdana' }, colors: { accent1: '#123456' } };
  const back = await readThemeFile('Harbour.thmx', await thmxOf(theme), { name: '', fonts: {}, colors: {} });
  assert.equal(back.name, 'Harbour');
  assert.deepEqual(back.fonts, theme.fonts);
  assert.equal(back.colors.accent1, '#123456');
});

test('lists brought in from another Document get definitions and nums of their own', async () => {
  const { adoptLists } = await import('../src/document/numbering.mjs');
  const here = { abstract: { a: { levels: [{ fmt: 'decimal', text: '%1.' }] } }, nums: { 1: { abstract: 'a' } } };
  const there = { abstract: { a: { levels: [{ fmt: 'bullet', text: '■' }] } }, nums: { 1: { abstract: 'a', start: 3 } } };
  const content = [{ type: 'paragraph', attrs: { numbering: { numId: '1', ilvl: 0 } } }, { type: 'paragraph', attrs: { numbering: { numId: '9', ilvl: 0 } } }];
  const { numbering, content: out } = adoptLists(here, there, content);
  const num = numbering.nums[out[0].attrs.numbering.numId];
  assert.notEqual(out[0].attrs.numbering.numId, 1);
  assert.equal(numbering.abstract[num.abstract].levels[0].text, '■');
  assert.equal(num.start, 3);
  assert.equal(numbering.abstract.a.levels[0].text, '%1.');
  assert.equal(out[1].attrs.numbering, undefined);
  assert.equal(content[0].attrs.numbering.numId, '1');
});

test('list names, picture bullets, label fonts, style aliases and options, a table style\'s bands, fill, alignment, nil edges and theme links, and East Asian theme fonts go out and read back', async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const accent = (lum) => ({ slot: 'accent1', lum });
  const line = { style: 'single', width: 0.5, space: 0, color: '#156082', themeColor: accent(-0.251) };
  const fill = { val: 'clear', color: 'auto', fill: '#C1E4F5', themeFill: accent(0.8) };
  const attrs = { ...FIXTURE.attrs,
    numbering: { abstract: { pics: { levels: [{ fmt: 'bullet', text: '•', start: 1, left: 36, hanging: 18, pic: PNG }] },
      named: { name: 'Steps', levels: [{ fmt: 'decimal', text: '%1.', start: 1, left: 36, hanging: 18, run: { bold: true, italic: true, underline: { val: 'single' }, color: '#C00000' } }] } },
    nums: { 1: { abstract: 'pics' }, 2: { abstract: 'named' } } },
    styles: { ...FIXTURE.attrs.styles, list: { ...FIXTURE.attrs.styles.list,
      Heading1: { ...FIXTURE.attrs.styles.list.Heading1, aliases: 'Chapter,Part', autoRedefine: true },
      NoList: { type: 'numbering', name: 'No List' },
      Banded: { type: 'table', name: 'Banded', table: { rowBandSize: 2, colBandSize: 3, borders: { top: line, insideH: line }, shading: fill, vAlign: 'bottom',
        cond: { firstRow: { cell: { borders: { insideH: { style: 'nil' } }, shading: { ...fill, themeFill: accent(0) }, vAlign: 'center' } } } } } } },
    theme: { ...FIXTURE.attrs.theme, fonts: { major: 'Aptos Display', minor: 'Aptos', majorEA: 'SimHei', minorEA: 'SimSun' } } };
  const content = [P('pic', { numbering: { numId: '1', ilvl: 0 } }), P('step', { numbering: { numId: '2', ilvl: 0 } })];
  const { bytes } = await exportDocx({ type: 'doc', attrs, content });
  const files = await readZip(bytes);
  assert.match(text(files.get('word/numbering.xml')), /<w:numPicBullet w:numPicBulletId="0"><w:pict><v:shape [^>]*o:bullet="t"><v:imagedata r:id="rId1"/);
  assert.match(text(files.get('word/_rels/numbering.xml.rels')), /Id="rId1" Type="[^"]+\/image" Target="media\/image\d+\.png"/);
  assert.match(text(files.get('word/styles.xml')), /<w:style w:type="numbering" w:default="1" w:styleId="NoList">/);
  const { doc } = await importDocx(bytes);
  const { abstract, nums } = doc.attrs.numbering;
  assert.equal(abstract[nums['1'].abstract].levels[0].pic, PNG);
  assert.equal(abstract[nums['2'].abstract].name, 'Steps');
  assert.deepEqual(abstract[nums['2'].abstract].levels[0].run, { bold: true, italic: true, underline: 'single', color: '#C00000' });
  const list = doc.attrs.styles.list;
  assert.deepEqual([list.Heading1.aliases, list.Heading1.autoRedefine], ['Chapter,Part', true]);
  assert.deepEqual(list.Banded.table, attrs.styles.list.Banded.table);
  assert.deepEqual(doc.attrs.theme.fonts, attrs.theme.fonts);
});

test('a field that runs past its paragraph keeps the result in the paragraph it begins in, a field with no result stays without one, and a bookmark before a page break stays with its heading', async () => {
  const { writeZip } = await import('../src/document/docx/zip.mjs');
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const r = (x) => `<w:r>${x}</w:r>`;
  const fld = (t) => r(`<w:fldChar w:fldCharType="${t}"/>`);
  const entry = (n, page, first) => `<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>${first ? fld('begin') + r('<w:instrText>TOC \o "1-3" \h</w:instrText>') + fld('separate') : ''}`
    + `<w:hyperlink w:anchor="_Toc${n}">${r(`<w:t>Entry ${n}</w:t>`)}${r('<w:tab/>')}${fld('begin')}${r(`<w:instrText> PAGEREF _Toc${n} \h </w:instrText>`)}${fld('separate')}${r(`<w:t>${page}</w:t>`)}${fld('end')}</w:hyperlink></w:p>`;
  const body = entry(1, 3, true) + entry(2, 4) + `<w:p>${fld('end')}</w:p>`
    + `<w:p>${r('<w:t>Course: </w:t>')}${fld('begin')}${r('<w:instrText> FILLIN "Course" </w:instrText>')}${fld('end')}</w:p>`
    + `<w:p><w:bookmarkStart w:id="1" w:name="_Toc1"/>${r('<w:br w:type="page"/>')}${r('<w:t>Heading</w:t>')}<w:bookmarkEnd w:id="1"/></w:p>`;
  const bytes = await writeZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`],
  ]);
  const check = (doc) => {
    const [block, p, brk, heading] = doc.content;
    assert.equal(block.type, 'fieldBlock');
    assert.equal(block.attrs.code, 'TOC \o "1-3" \h');
    assert.deepEqual(block.content.map((b) => b.content?.map((n) => n.text ?? n.attrs.result).join('') ?? ''), ['Entry 1\t3', 'Entry 2\t4', '']);
    assert.equal(block.content[0].content[0].marks[0].attrs.anchor, '_Toc1');
    // Each entry's page number is its own PAGEREF field, which Update page numbers refreshes.
    const page = block.content[0].content.at(-1);
    assert.deepEqual([page.type, page.attrs.code.split(' ')[0], page.attrs.result, page.marks[0].attrs.anchor], ['field', 'PAGEREF', '3', '_Toc1']);
    assert.deepEqual(p.content.map((n) => n.type), ['text', 'field']);
    assert.equal(p.content[1].attrs.result, null);
    // The heading's bookmark start before its page break stays with the heading, so the entry's link lands on it.
    assert.equal(brk.type, 'pageBreak');
    assert.deepEqual(heading.content.map((n) => n.type), ['bookmark', 'text', 'bookmark']);
    assert.equal(heading.content[0].attrs.name, '_Toc1');
  };
  const { doc } = await importDocx(bytes, { fresh: true });
  check(doc);
  const back = await importDocx((await exportDocx(doc, { title: 'Toc' })).bytes, { fresh: true });
  check(back.doc);
});

test('the document\'s own building blocks (word/glossary) read in, name the placeholders of its controls and write back', async () => {
  const { writeZip } = await import('../src/document/docx/zip.mjs');
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const part = (name, gallery, body, extra = '') => `<w:docPart><w:docPartPr><w:name w:val="${name}"/><w:category><w:name w:val="General"/><w:gallery w:val="${gallery}"/></w:category>`
    + `${extra}<w:behaviors><w:behavior w:val="content"/></w:behaviors></w:docPartPr><w:docPartBody><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:docPartBody></w:docPart>`;
  const bytes = await writeZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Course: </w:t></w:r><w:sdt><w:sdtPr><w:alias w:val="Your Course"/>`
      + '<w:placeholder><w:docPart w:val="PH1"/></w:placeholder><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Design</w:t></w:r></w:sdtContent></w:sdt></w:p></w:body></w:document>'],
    ['word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="${RT}glossaryDocument" Target="glossary/document.xml"/></Relationships>`],
    ['word/glossary/document.xml', `<?xml version="1.0"?><w:glossaryDocument ${W}><w:docParts>${part('PH1', 'placeholder', 'Enter your course.')}`
      + `${part('Sign-off', 'Quick Parts', 'Kind regards', '<w:description w:val="Letter end"/>')}</w:docParts></w:glossaryDocument>`],
  ]);
  const check = (doc) => {
    const g = doc.attrs.settings.glossary;
    assert.deepEqual(g.map((d) => [d.name, d.gallery, d.category, d.description ?? null, d.behaviors, d.content[0].content[0].text]),
      [['PH1', 'placeholder', 'General', null, ['content'], 'Enter your course.'], ['Sign-off', 'Quick Parts', 'General', 'Letter end', ['content'], 'Kind regards']]);
    const sdt = doc.content[0].content[1].attrs.sdt;
    assert.equal(sdt.placeholderPart, 'PH1');
    assert.equal(sdt.placeholder, 'Enter your course.');
  };
  const first = await importDocx(bytes, { fresh: true });
  assert.ok(!first.dropped.some((d) => /building blocks/.test(d)), 'nothing reported dropped');
  check(first.doc);
  const out = await exportDocx(first.doc, { title: 'Glossary' });
  const files = await readZip(out.bytes);
  assert.match(text(files.get('[Content_Types].xml')), /PartName="\/word\/glossary\/document.xml" ContentType="[^"]+document\.glossary\+xml"/);
  assert.match(text(files.get('word/_rels/document.xml.rels')), /relationships\/glossaryDocument" Target="glossary\/document.xml"/);
  assert.match(text(files.get('word/glossary/_rels/document.xml.rels')), /Target="styles.xml"/);
  assert.match(text(files.get('word/document.xml')), /<w:placeholder><w:docPart w:val="PH1"\/><\/w:placeholder>/);
  check((await importDocx(out.bytes, { fresh: true })).doc);
});

test('docx export: a waiting suggestion goes out as w:del and w:ins by Assistant (files.js accepts on a copy first)', async () => {
  const schema = getSchema([...documentExtensions(50), Suggestions]);
  const ins = { id: 's1', g: 'g1', by: 'agent:test', at: 1, n: 1, sig: 'x', old: [P('The quick brown fox')] };
  const state = EditorState.create({ doc: schema.nodeFromJSON({ type: 'doc', attrs: FIXTURE.attrs, content: [{ ...P('The quick red fox'), attrs: { suggest: { ins } } }] }) });
  const doc = accept(state, entries(state.doc).map((e) => e.id), true).doc;
  const d = text((await readZip((await exportDocx(doc.toJSON(), { title: 'S' })).bytes)).get('word/document.xml'));
  assert.match(d, /<w:del [^>]*w:author="Assistant"[^>]*>.*?<w:delText[^>]*>brown<\/w:delText>/);
  assert.match(d, /<w:ins [^>]*w:author="Assistant"[^>]*>.*?<w:t[^>]*>red<\/w:t>/);
  assert.doesNotMatch(d, /suggest/);
});

test('docx text boxes: no line and no fill, overflow and the internal margins go out as wps:wsp before the paragraph they anchor to and read back the same; a zero-size picture stays zero', async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const { anchorOf } = await import('../src/document/wp/float-layout/plugin.js');
  const box = (text, attrs) => ({ type: 'textBox', attrs, content: [P(text)] });
  const bare = { w: 153.75, h: 152.79, fill: null, line: null, overflow: 'overflow', vAlign: 'bottom', inset: { t: 0, r: 7.2, b: 0, l: 7.2 },
    layout: { wrap: 'front', h: { rel: 'page', offset: 0 }, v: { rel: 'paragraph', offset: 22.8 } } };
  const lined = { w: 100, h: 50, fill: '#FFFF00', line: { color: '#FF0000', width: 1.5, dash: 'solid' }, layout: { wrap: 'front', h: { rel: 'margin', align: 'left' }, v: { rel: 'page', offset: 806 } } };
  const doc = { type: 'doc', attrs: FIXTURE.attrs, content: [box('Student Life', bare), box('To Whom', lined),
    { type: 'paragraph', content: [{ type: 'text', text: 'Anchor' }, { type: 'image', attrs: { src: PNG, width: 0, height: 0 } }] }, P('After')] };
  const { bytes, dropped } = await exportDocx(doc, { title: 'Boxes' });
  assert.deepEqual(dropped, []);
  const d = text((await readZip(bytes)).get('word/document.xml'));
  assert.match(d, /^(?:(?!<\/w:p>).)*<wps:wsp>.*?<a:noFill\/><a:ln><a:noFill\/><\/a:ln>.*?vertOverflow="overflow".*?anchor="b".*?<\/wps:wsp>.*?<wps:wsp>.*?<a:solidFill><a:srgbClr val="FFFF00"\/>.*?<w:t[^>]*>Anchor<\/w:t>/s, 'both boxes ride in the paragraph after them, ahead of its text');
  assert.match(d, /<wp:inline [^>]*><wp:extent cx="0" cy="0"\/>/);
  const back = (await importDocx(bytes, { fresh: true })).doc;
  assert.deepEqual(back.content.map((n) => n.type), ['textBox', 'textBox', 'paragraph', 'paragraph']);
  const [b1, b2, p] = back.content;
  for (const [got, want] of [[b1.attrs, bare], [b2.attrs, lined]]) for (const k of Object.keys(want)) assert.deepEqual(k === 'layout' ? { wrap: got.layout.wrap, h: got.layout.h, v: got.layout.v } : got[k], want[k], k);
  assert.equal(b1.content[0].content[0].text, 'Student Life');
  assert.deepEqual([p.content[1].attrs.width, p.content[1].attrs.height], [0, 0]);
  // Both boxes anchor to the paragraph after them, the second box not being one (float-layout).
  const pm = getSchema(documentExtensions(50)).nodeFromJSON(back);
  assert.deepEqual([anchorOf(pm, 0, pm.child(0)), anchorOf(pm, pm.child(0).nodeSize, pm.child(1))], [pm.child(0).nodeSize + pm.child(1).nodeSize, pm.child(0).nodeSize + pm.child(1).nodeSize]);
});

test('a picture\'s crop, border, colour, effects, title and decorative mark, and a text box\'s effects, go out as Word writes them and read back the same', async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const look = { crop: { t: 0, r: 0.1, b: 0, l: 0.25, shape: 'ellipse' }, border: { color: '#FF0000', width: 3, dash: 'sysDot' },
    adjust: { transparency: 0.5, recolor: { kind: 'grayscale' } }, effects: { shadow: { kind: 'outer', color: '#000000', transparency: 0.6, size: 1, blur: 4, angle: 45, distance: 3 }, softEdge: 5 } };
  const pic = { src: PNG, width: 59.9974, height: 40, alt: 'A dot', title: 'Dot', decorative: true, ...look,
    layout: { wrap: 'tight', side: 'both', h: { rel: 'column', offset: 10 }, v: { rel: 'paragraph', offset: 0 } } };
  const effects = { shadow: { color: '#000000', alpha: 0.4, blur: 4, dist: 3, angle: 45 }, glow: { color: '#156082', size: 8, alpha: 0.6 },
    reflection: { size: 50, dist: 4, alpha: 0.5 }, softEdges: { size: 2.5 } };
  const doc = { type: 'doc', attrs: FIXTURE.attrs, content: [{ type: 'textBox', attrs: { w: 100, h: 50, fill: '#FFFFFF', line: null, effects }, content: [P('Box')] },
    { type: 'paragraph', content: [{ type: 'image', attrs: pic }] }] };
  const { bytes, dropped } = await exportDocx(doc);
  assert.deepEqual(dropped, []);
  const d = text((await readZip(bytes)).get('word/document.xml'));
  assert.match(d, /<wp:wrapTight wrapText="bothSides"><wp:wrapPolygon edited="0"><wp:start x="0" y="0"\/>(<wp:lineTo [^>]*\/>){4}<\/wp:wrapPolygon><\/wp:wrapTight>/, 'Tight wraps around the box');
  assert.match(d, /<wp:docPr [^>]*descr="A dot" title="Dot"><a:extLst><a:ext uri="\{C183D7F6-B498-43B3-948B-1728B52AA6E4\}"><adec:decorative [^>]*val="1"\/>/);
  assert.match(d, /<a:graphicFrameLocks noChangeAspect="1"\/>.*<a:blip r:embed="rId\d+"><a:grayscl\/><a:alphaModFix amt="50000"\/><\/a:blip><a:srcRect l="25000" r="10000"\/>/s);
  assert.match(d, /<a:ext cx="571475" cy="381000"\/><\/a:xfrm><a:prstGeom prst="ellipse">/, 'the extent to the EMU');
  assert.match(d, /<wps:spPr>.*<a:effectLst><a:glow rad="101600"><a:srgbClr val="156082"><a:alpha val="60000"\/><\/a:srgbClr><\/a:glow><a:outerShdw .*<a:reflection .*<a:softEdge rad="31750"\/><\/a:effectLst><\/wps:spPr>/s);
  const back = (await importDocx(bytes, { fresh: true })).doc;
  const [box, para] = back.content;
  assert.deepEqual(box.attrs.effects, effects);
  const a = para.content.find((n) => n.type === 'image').attrs;
  for (const k of ['width', 'height', 'alt', 'title', 'decorative', ...Object.keys(look)]) assert.deepEqual(a[k], pic[k], k);
  assert.equal(a.layout.wrap, 'tight');
});

test('an EMF or WMF picture goes out as its own metafile with Word\'s content type, and reads back with that original kept', async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  // Not a drawable metafile: the bytes only have to come back unchanged.
  const EMF = `data:image/x-emf;base64,${Buffer.from('EMF bytes').toString('base64')}`;
  const WMF = `data:image/x-wmf;base64,${Buffer.from('WMF bytes').toString('base64')}`;
  const doc = { type: 'doc', attrs: FIXTURE.attrs, content: [{ type: 'paragraph', content: [
    { type: 'image', attrs: { src: PNG, metafile: EMF, width: 240, height: 160, alt: '' } },
    { type: 'image', attrs: { src: PNG, metafile: WMF, width: 200, height: 120, alt: 'A chart' } }] }] };
  const { bytes, dropped } = await exportDocx(doc);
  assert.deepEqual(dropped, []);
  const files = await readZip(bytes);
  assert.equal(text(files.get('word/media/image1.emf')), 'EMF bytes');
  assert.equal(text(files.get('word/media/image2.wmf')), 'WMF bytes');
  assert.ok(![...files.keys()].some((k) => k.endsWith('.png')), 'no PNG in place of a metafile');
  const types = text(files.get('[Content_Types].xml'));
  assert.match(types, /Extension="emf" ContentType="image\/x-emf"/);
  assert.match(types, /Extension="wmf" ContentType="image\/x-wmf"/);
  // Node has no system renderer: a converter that draws nothing gives placeholders of the picture's size naming it.
  const back = await importDocx(bytes, { fresh: true, metafiles: async (list) => list.map(() => null) });
  const pics = back.doc.content[0].content.filter((n) => n.type === 'image').map((n) => n.attrs);
  assert.deepEqual(back.dropped, []);
  assert.deepEqual(pics.map((a) => a.metafile), [EMF, WMF]);
  assert.deepEqual(pics.map((a) => [a.width, a.height, a.orig]), [[240, 160, { w: 240, h: 160 }], [200, 120, { w: 200, h: 120 }]]);
  assert.ok(pics.every((a) => a.src.startsWith('data:image/svg+xml,')));
  assert.match(decodeURIComponent(pics[0].src), /width="240" height="160".*Picture \(EMF\)/s);
  assert.match(decodeURIComponent(pics[1].src), /A chart/);
  // A drawn PNG is what shows; the converter gets each metafile's data and size.
  let asked;
  const shown = await importDocx(bytes, { fresh: true, metafiles: async (list) => { asked = list; return list.map(() => PNG); } });
  assert.deepEqual(asked, [{ data: EMF.split(',')[1], w: 240, h: 160 }, { data: WMF.split(',')[1], w: 200, h: 120 }]);
  assert.ok(shown.doc.content[0].content.filter((n) => n.type === 'image').every((n) => n.attrs.src === PNG));
});

test('a metafile draws at twice its size within the pixel caps (metafile-main.js)', async () => {
  const { createRequire } = await import('node:module');
  const { pixels } = createRequire(import.meta.url)('../src/metafile-main.js');
  assert.deepEqual(pixels(240, 160), [480, 320]);
  assert.deepEqual(pixels(4000, 100), [4096, 102]);
  assert.deepEqual(pixels(3000, 3000), [4000, 4000]);
  assert.deepEqual(pixels(0, 0), [0, 0]);
});

test("watermarks go into each header of their section as Word's VML; a linked header with another watermark becomes the section's own", async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const sect = { w: 612, h: 792, margin: { top: 72, right: 72, bottom: 72, left: 72, header: 36, footer: 36, gutter: 0 } };
  const draft = { kind: 'text', text: 'DRAFT', font: 'Calibri', size: 72, color: '#FF0000', semi: false, layout: 'horizontal' };
  const photo = { kind: 'picture', src: PNG, scale: 200, washout: true };
  // Section 1 has a header and the draft watermark; 2 links to it and shows the same; 3 links to it but has the photo.
  const doc = { type: 'doc', attrs: { ...FIXTURE.attrs, sect: { ...sect, hdr: null, watermark: photo } }, content: [
    P('One'), { type: 'sectionBreak', attrs: { kind: 'nextPage', sect: { ...sect, hdr: { default: [P('Head')] }, watermark: draft } } },
    P('Two'), { type: 'sectionBreak', attrs: { kind: 'nextPage', sect: { ...sect, hdr: null, watermark: draft } } },
    P('Three')] };
  const { bytes, dropped } = await exportDocx(doc);
  assert.deepEqual(dropped, []);
  const files = await readZip(bytes);
  const headers = [...files.keys()].filter((k) => /^word\/header\d+\.xml$/.test(k)).sort().map((k) => text(files.get(k)));
  assert.equal(headers.length, 2, 'section 2 stays linked; section 3 gets its own');
  assert.match(headers[0], /<w:p><w:r><w:rPr><w:noProof\/><\/w:rPr><w:pict><v:shapetype id="_x0000_t136" [^>]*o:spt="136"[^]*<\/v:shape><\/w:pict><\/w:r><w:r><w:t xml:space="preserve">Head<\/w:t>/,
    "the watermark opens the header's first paragraph");
  assert.match(headers[0], /<v:shape id="PowerPlusWaterMarkObject1" o:spid="_x0000_s2049" type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;width:[\d.]+pt;height:72pt;z-index:-251657216;/);
  assert.match(headers[0], /mso-position-vertical-relative:margin" fillcolor="#FF0000" stroked="f" o:allowincell="f"><v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="DRAFT"\/><w10:wrap anchorx="margin" anchory="margin"\/><\/v:shape>/,
    'horizontal and solid: no rotation, no v:fill');
  // The 1 px picture at 200 %: 1.5 pt, washed out; the header's text comes along from the header section 3 linked to.
  assert.match(headers[1], /<v:shape id="WordPictureWatermark2" [^>]*type="#_x0000_t75" style="[^"]*width:1.5pt;height:1.5pt;[^"]*"[^>]*><v:imagedata r:id="rId1" o:title="" gain="19661f" blacklevel="22938f"\/>.*Head/s);
  assert.match(text(files.get('word/_rels/header2.xml.rels')), /Id="rId1" Type="[^"]*\/image" Target="media\/image1.png"/);
  const back = (await importDocx(bytes, { fresh: true })).doc;
  const sects = [...back.content.filter((n) => n.type === 'sectionBreak').map((n) => n.attrs.sect), back.attrs.sect];
  const textOf = (n) => n.text ?? (n.content ?? []).map(textOf).join('');
  assert.deepEqual(sects.map((s) => s.watermark), [draft, draft, photo]);
  assert.deepEqual(sects.map((s) => textOf({ content: s.hdr?.default ?? [] })), ['Head', '', 'Head']);
});

test("page fill effects go out as Word's v:background and read back the same", async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const { WORD_PATTERNS } = await import('../src/document/docx/export.mjs');
  const out = async (fill, color = null) => {
    const { bytes, dropped } = await exportDocx({ type: 'doc', attrs: { ...FIXTURE.attrs, background: { color, themeColor: null, fill } }, content: [P('x')] });
    assert.deepEqual(dropped, []);
    const files = await readZip(bytes);
    const back = (await importDocx(bytes, { fresh: true })).doc.attrs.background.fill;
    return { xml: /<w:background[^]*<\/w:background>/.exec(text(files.get('word/document.xml')))[0], back, files };
  };
  const corner = { kind: 'gradient', colors: 'two', color1: '#C00000', color2: '#FFFFFF', style: 'fromCorner', variant: 2 };
  let r = await out(corner);
  assert.equal(r.xml, '<w:background w:color="C00000"><v:background id="_x0000_s1025" o:bwmode="white" fillcolor="#C00000" o:targetscreensize="1024,768">'
    + '<v:fill focusposition="0,1" focussize="" color2="#FFFFFF" focus="100%" type="gradientRadial"><o:fill v:ext="view" type="gradientCenter"/></v:fill></v:background></w:background>');
  assert.deepEqual(r.back, corner);
  const one = { kind: 'gradient', colors: 'one', color1: '#4472C4', shade: 0.75, style: 'vertical', variant: 2 };
  r = await out(one, '#4472C4');
  assert.match(r.xml, /<v:fill angle="-90" color2="fill lighten\(128\)" method="linear sigma" focus="50%" type="gradient"\/>/);
  assert.deepEqual(r.back, one);
  const preset = { kind: 'gradient', colors: 'preset', preset: 'ocean', style: 'diagonalUp', variant: 1 };
  r = await out(preset);
  assert.match(r.xml, /<v:fill angle="-135" color2="#9BE3F2" colors="0 #0B4F7C;32768f #13A3C9;1 #9BE3F2" method="none" type="gradient"\/>/);
  assert.deepEqual(r.back, preset);
  // A pattern goes out as Word's own tile of its name (Word draws no other), white bits for the foreground.
  const weave = { kind: 'pattern', pattern: 'weave', fg: '#FF0000', bg: '#FFFF99' };
  r = await out(weave);
  assert.match(r.xml, /fillcolor="#FF0000"><v:fill r:id="rId\d+" o:title="Weave" color2="#FFFF99" type="pattern"\/>/);
  const gif = r.files.get('word/media/image1.gif');
  assert.deepEqual([...gif.subarray(0, 6)].map((c) => String.fromCharCode(c)).join(''), 'GIF89a');
  assert.deepEqual(r.back, weave);
  assert.equal(WORD_PATTERNS.weave, '8854224588142251');
  const picture = { kind: 'picture', src: PNG, lockAspect: true };
  r = await out(picture, '#FFFFFF');
  assert.match(r.xml, /<w:background w:color="FFFFFF"><v:background [^>]*fillcolor="#FFFFFF" o:targetscreensize="1024,768"><v:fill r:id="rId\d+" aspect="atLeast" type="frame"\/>/);
  assert.deepEqual(r.back, picture);
  const texture = { kind: 'texture', texture: 'oak', src: PNG };
  r = await out(texture);
  assert.match(r.xml, /<v:fill r:id="rId\d+" o:title="Oak" type="tile"\/>/);
  assert.deepEqual(r.back, texture);
});
