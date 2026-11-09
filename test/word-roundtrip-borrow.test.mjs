// roundtrip-borrow (docs/plans/word/briefs/roundtrip-borrow.md): what WordCraft's round trip keeps comes back from import and
// export here too: equations as Word built them (OMML both ways, and their own XML while unchanged), run font hints and
// web-hidden runs, a link's frame and history, a phonetic guide's language, comments' durable ids and UTC dates, people's
// sign-ins, ink, a text box's gradient fill, and a table's row alignment, cell spacing, short rows and overlap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocx, parseXml } from '../src/document/docx/import.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { readZip, text, writeZip } from '../src/document/docx/zip.mjs';
import { linearText, readOmml, writeOmml } from '../src/document/wp/equations/omml.mjs';
import { normalize, parse, print } from '../src/document/wp/equations/unicodemath.mjs';
import { BUILT_INS, STRUCTURES } from '../src/document/wp/equations/templates.mjs';

const { kitOf, loadable } = await import('../src/editors.js');
const schema = kitOf('document').schema;

const NS = ['w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"', 'r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"', 'a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'pic="http://schemas.openxmlformats.org/drawingml/2006/picture"', 'm="http://schemas.openxmlformats.org/officeDocument/2006/math"',
  'wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"', 'w14="http://schemas.microsoft.com/office/word/2010/wordml"',
  'w15="http://schemas.microsoft.com/office/word/2012/wordml"', 'mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"', 'w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"',
  'w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"'].map((x) => `xmlns:${x}`).join(' ');
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
/** A .docx of `body` with more `parts` ([name, xml or bytes]) and document relationships `rels` ([id, type, target]). */
const docx = (body, parts = [], rels = []) => writeZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['word/document.xml', `<w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`],
  ['word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${/^http/.test(type) ? type : REL + type}" Target="${target}"/>`).join('')}</Relationships>`],
  ...parts,
]);
/** Imports, checks the doc in the kit's schema and keeps what that schema keeps, exports → {doc, files, xml (document.xml)}. */
async function roundTrip(bytes) {
  const { doc: raw } = await importDocx(await bytes);
  const node = schema.nodeFromJSON(raw);
  node.check();
  const doc = JSON.parse(JSON.stringify(node.toJSON()));
  const files = await readZip((await exportDocx(doc, { picture: async () => null })).bytes);
  return { doc, files, xml: text(files.get('word/document.xml')) };
}
const find = (n, type, out = []) => { if (n.type === type) out.push(n); for (const c of n.content ?? []) find(c, type, out); return out; };
const marksOf = (doc, type) => find(doc, 'text').flatMap((t) => t.marks ?? []).filter((m) => m.type === type);
const r = (t, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const mr = (t) => `<m:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr><m:t>${t}</m:t></m:r>`;
const CTRL = '<m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:i/></w:rPr></m:ctrlPr>';
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

test('every gallery equation goes to OMML and back to the same math', () => {
  const all = [...BUILT_INS, ...Object.values(STRUCTURES).flat()].map((t) => t.math);
  assert.ok(all.length > 200);
  for (const s of all) assert.deepEqual(normalize(readOmml(parseXml(writeOmml(parse(s))))), normalize(parse(s)), s);
});

test('OMML reads as Word built it: structures, hidden limits and degrees, stacked limits, empty matrix cells, linear form', () => {
  const read = (x) => print(readOmml(parseXml(`<m:oMath ${NS}>${x}</m:oMath>`)));
  assert.equal(read(`<m:f><m:fPr><m:type m:val="noBar"/>${CTRL}</m:fPr><m:num>${mr('n')}</m:num><m:den>${mr('k')}</m:den></m:f>`), 'n¦k');
  assert.equal(read(`<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr><m:sub>${mr('k=0')}</m:sub><m:sup>${mr('n')}</m:sup><m:e>${mr('k')}</m:e></m:nary>`),
    '∑┬(k=0)┴n▒k');
  assert.equal(read(`<m:nary><m:naryPr><m:subHide m:val="1"/><m:supHide m:val="1"/></m:naryPr><m:sub/><m:sup/><m:e>${mr('x')}</m:e></m:nary>`), '∫▒x');
  assert.equal(read(`<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${mr('x')}</m:e></m:rad>`), '√x');
  assert.equal(read(`<m:func><m:fName><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>sin</m:t></m:r></m:fName><m:e>${mr('θ')}</m:e></m:func>`), 'sin⁡θ');
  assert.equal(read(`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>${mr('a')}</m:e><m:e>${mr('b')}</m:e></m:d>`), '[a│b]');
  assert.equal(read(`<m:m><m:mPr><m:plcHide m:val="1"/></m:mPr><m:mr><m:e>${mr('1')}</m:e><m:e/></m:mr><m:mr><m:e/><m:e>${mr('1')}</m:e></m:mr></m:m>`), '■(1&@&1)');
  assert.equal(read(`${mr('A')}<m:groupChr><m:groupChrPr><m:chr m:val="→"/><m:vertJc m:val="bot"/></m:groupChrPr><m:e><m:r><m:rPr><m:nor/></m:rPr><m:t>yields</m:t></m:r></m:e></m:groupChr>`),
    'A"yields"┬(→)');
  // Word keeps an equation shown in linear form as runs of its linear text; runs without structure are plain math.
  assert.equal(linearText(parseXml(`<m:oMath ${NS}>${mr('x=(-b±√(b^2-4ac))/2a')}</m:oMath>`)), 'x=(-b±√(b^2-4ac))/2a');
  assert.equal(linearText(parseXml(`<m:oMath ${NS}>${mr('x+1=y')}</m:oMath>`)), null);
});

test('an equation keeps its own OMML while its math is unchanged, and is built from its math once edited', async () => {
  const sup = `<m:sSup><m:sSupPr>${CTRL}</m:sSupPr><m:e>${mr('x')}</m:e><m:sup>${mr('2')}</m:sup></m:sSup>`;
  const { doc, xml } = await roundTrip(docx(`<w:p><m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr><m:oMath>${sup}</m:oMath></m:oMathPara></w:p>`
    + `<w:p>${r('In ')}<m:oMath>${mr('a/b')}</m:oMath></w:p>`));
  const [display, inline] = find(doc, 'equation');
  assert.equal(display.attrs.math, 'x^2');
  assert.equal(display.attrs.align, 'left');
  assert.ok(display.attrs.omml.xml.includes('Cambria Math'));
  assert.deepEqual([inline.attrs.math, inline.attrs.linear, inline.attrs.display], ['a/b', true, false]);
  assert.match(xml, /<m:oMathPara><m:oMathParaPr><m:jc m:val="left"\/><\/m:oMathParaPr><m:oMath><m:sSup><m:sSupPr><m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math"/);
  assert.match(xml, /<m:oMath><m:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"\/><\/w:rPr><m:t>a\/b<\/m:t><\/m:r><\/m:oMath>/);
  // Edited: the math is built up again, without the old XML.
  display.attrs.math = 'x^3';
  inline.attrs.linear = false;
  const out = text((await readZip((await exportDocx(doc, { picture: async () => null })).bytes)).get('word/document.xml'));
  assert.match(out, /<m:sSup><m:e><m:r><m:t>x<\/m:t><\/m:r><\/m:e><m:sup><m:r><m:t>3<\/m:t><\/m:r><\/m:sup><\/m:sSup>/);
  assert.match(out, /<m:f><m:num><m:r><m:t>a<\/m:t><\/m:r><\/m:num><m:den><m:r><m:t>b<\/m:t><\/m:r><\/m:den><\/m:f>/);
  assert.doesNotMatch(out, /Cambria Math/);
});

test('runs keep their font hint and Web Layout hiding, links their frame and Word\'s history, phonetic guides their language', async () => {
  const { doc, files, xml } = await roundTrip(docx(`<w:p>${r('漢字', '<w:rFonts w:hint="eastAsia"/>')}${r('3', '<w:webHidden/>')}</w:p>`
    + `<w:p><w:hyperlink r:id="rIdL" w:tgtFrame="_blank" w:history="1">${r('site')}</w:hyperlink></w:p>`
    + '<w:p><w:r><w:ruby><w:rubyPr><w:rubyAlign w:val="center"/><w:hps w:val="12"/><w:hpsRaise w:val="22"/><w:hpsBaseText w:val="24"/><w:lid w:val="zh-CN"/></w:rubyPr>'
    + '<w:rt><w:r><w:rPr><w:rFonts w:ascii="MS Mincho" w:eastAsia="MS Mincho" w:hint="eastAsia"/><w:sz w:val="12"/></w:rPr><w:t>hon3</w:t></w:r></w:rt>'
    + '<w:rubyBase><w:r><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr><w:t>漢</w:t></w:r></w:rubyBase></w:ruby></w:r></w:p>', [], [['rIdL', 'hyperlink', 'https://example.com']]));
  const styles = marksOf(doc, 'textStyle').map((m) => m.attrs);
  assert.ok(styles.some((a) => a.hint === 'eastAsia') && styles.some((a) => a.webHidden === true));
  assert.equal(marksOf(doc, 'link')[0].attrs.frame, '_blank');
  const ruby = find(doc, 'ruby')[0].attrs;
  assert.deepEqual([ruby.lang, ruby.hint], ['zh-CN', 'eastAsia']);
  assert.match(xml, /<w:rFonts w:hint="eastAsia"\/>.*漢字/);
  assert.match(xml, /<w:webHidden\/>/);
  assert.match(xml, /<w:hyperlink r:id="rId\d+" w:tgtFrame="_blank" w:history="1">/);
  assert.match(xml, /<w:lid w:val="zh-CN"\/>.*<w:rFonts w:ascii="MS Mincho" w:hAnsi="MS Mincho" w:eastAsia="MS Mincho" w:hint="eastAsia"\/>.*<w:rubyBase><w:r><w:rPr><w:rFonts w:hint="eastAsia"\/>/);
  assert.ok(files.get('word/document.xml'));
});

test('comments keep their durable ids and UTC dates, people their sign-in', async () => {
  const comment = `<w:comments ${NS}><w:comment w:id="0" w:author="Ana Ruiz" w:initials="AR" w:date="2026-10-29T21:49:00Z"><w:p w14:paraId="5F7C917C">${r('Note')}</w:p></w:comment></w:comments>`;
  const { doc, files } = await roundTrip(docx(`<w:p><w:commentRangeStart w:id="0"/>${r('text')}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>`, [
    ['word/comments.xml', comment],
    ['word/commentsIds.xml', `<w16cid:commentsIds ${NS}><w16cid:commentId w16cid:paraId="5F7C917C" w16cid:durableId="2A453509"/></w16cid:commentsIds>`],
    ['word/commentsExtensible.xml', `<w16cex:commentsExtensible ${NS}><w16cex:commentExtensible w16cex:durableId="2A453509" w16cex:dateUtc="2026-10-29T13:49:00Z"/></w16cex:commentsExtensible>`],
    ['word/people.xml', `<w15:people ${NS}><w15:person w15:author="Ana Ruiz"><w15:presenceInfo w15:providerId="AD" w15:userId="S::ana@example.com::1"/></w15:person></w15:people>`],
  ], [['rIdC', 'comments', 'comments.xml'], ['rIdI', 'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds', 'commentsIds.xml'],
    ['rIdE', 'http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible', 'commentsExtensible.xml'],
    ['rIdP', 'http://schemas.microsoft.com/office/2011/relationships/people', 'people.xml']]));
  const c = Object.values(doc.attrs.comments)[0];
  assert.deepEqual([c.durableId, c.dateUtc], ['2A453509', '2026-10-29T13:49:00Z']);
  assert.deepEqual(doc.attrs.people, [{ name: 'Ana Ruiz', initials: 'AR', presence: { providerId: 'AD', userId: 'S::ana@example.com::1' } }]);
  assert.match(text(files.get('word/commentsIds.xml')), /<w16cid:commentId w16cid:paraId="[0-9A-F]{8}" w16cid:durableId="2A453509"\/>/);
  assert.match(text(files.get('word/commentsExtensible.xml')), /<w16cex:commentExtensible w16cex:durableId="2A453509" w16cex:dateUtc="2026-10-29T13:49:00Z"\/>/);
  assert.match(text(files.get('word/people.xml')), /<w15:person w15:author="Ana Ruiz"><w15:presenceInfo w15:providerId="AD" w15:userId="S::ana@example.com::1"\/><\/w15:person>/);
  const rels = text(files.get('word/_rels/document.xml.rels'));
  for (const t of ['2016/09/relationships/commentsIds', '2018/08/relationships/commentsExtensible', '2011/relationships/people']) assert.ok(rels.includes(t), t);
});

test('ink keeps its ink part beside the picture Word falls back to', async () => {
  const pic = '<w:drawing><wp:inline><wp:extent cx="900000" cy="300000"/><wp:docPr id="2" name="Ink 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Ink 1"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdP"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
  const ink = '<w:drawing><wp:inline><wp:extent cx="864000" cy="288000"/><wp:docPr id="1" name="Ink 1"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingInk">'
    + '<w14:contentPart bwMode="auto" r:id="rIdK"><w14:nvContentPartPr><w14:cNvContentPartPr/></w14:nvContentPartPr><w14:xfrm><a:off x="0" y="0"/><a:ext cx="864000" cy="288000"/></w14:xfrm></w14:contentPart></a:graphicData></a:graphic></wp:inline></w:drawing>';
  const inkml = '<inkml:ink xmlns:inkml="http://www.w3.org/2003/InkML"><inkml:trace>0 0,10 10</inkml:trace></inkml:ink>';
  const { doc: raw } = await importDocx(await docx(`<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wpi">${ink}</mc:Choice><mc:Fallback>${pic}</mc:Fallback></mc:AlternateContent></w:r></w:p>`,
    [['word/media/ink.png', PNG], ['word/ink/ink1.xml', inkml]], [['rIdP', 'image', 'media/ink.png'], ['rIdK', 'customXml', 'ink/ink1.xml']]));
  const img = find(raw, 'image')[0];
  assert.equal(img.attrs.ink, inkml);
  assert.deepEqual([Math.round(img.attrs.width * 9525), Math.round(img.attrs.height * 9525)], [864000, 288000]);
  const files = await readZip((await exportDocx(JSON.parse(JSON.stringify(schema.nodeFromJSON(raw).toJSON())))).bytes);
  const xml = text(files.get('word/document.xml'));
  assert.match(xml, /<mc:AlternateContent><mc:Choice Requires="wpi"><w:drawing><wp:inline [^>]*><wp:extent cx="864000" cy="288000"\/>.*<w14:contentPart bwMode="auto" r:id="(rId\d+)">.*<\/mc:Choice><mc:Fallback><w:drawing>.*<pic:pic>/);
  assert.ok(xml.includes('xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"'));
  assert.equal(text(files.get('word/ink/ink1.xml')), inkml);
  assert.match(text(files.get('[Content_Types].xml')), /PartName="\/word\/ink\/ink1.xml" ContentType="application\/inkml\+xml"/);
});

test('a text box keeps its gradient fill while its fill is the colour it was read with', async () => {
  const box = '<w:r><w:drawing><wp:inline><wp:extent cx="1371600" cy="685800"/><wp:docPr id="1" name="Text Box 1"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
    + '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1371600" cy="685800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
    + '<a:gradFill flip="none" rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="4472C4"/></a:gs><a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="1"/><a:tileRect/></a:gradFill>'
    + `</wps:spPr><wps:txbx><w:txbxContent><w:p>${r('Down')}</w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const { doc, xml } = await roundTrip(docx(`<w:p>${box}</w:p>`));
  const tb = find(doc, 'textBox')[0];
  assert.equal(tb.attrs.gradient.color, tb.attrs.fill);
  assert.deepEqual(tb.attrs.gradient.stops, [{ pos: 0, color: '#4472C4' }, { pos: 1, color: '#FFFFFF' }]);
  // As Word wrote it, its flip and empty tile rectangle too (drawing-roundtrip: dml.mjs gradFillEl).
  assert.match(xml, /<a:gradFill flip="none" rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="4472C4"\/><\/a:gs><a:gs pos="100000"><a:srgbClr val="FFFFFF"\/><\/a:gs><\/a:gsLst><a:lin ang="5400000" scaled="1"\/><a:tileRect\/><\/a:gradFill>/);
  tb.attrs.fill = '#FF0000';
  const out = text((await readZip((await exportDocx(doc)).bytes)).get('word/document.xml'));
  assert.match(out, /<a:solidFill><a:srgbClr val="FF0000"\/><\/a:solidFill>/);
  assert.doesNotMatch(out, /gradFill/);
});

test('a table writes each row\'s alignment and cell spacing, the grid a short row leaves, and its overlap', async () => {
  const tc = (t) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p>${r(t)}</w:p></w:tc>`;
  const { xml } = await roundTrip(docx('<w:tbl><w:tblPr><w:tblpPr w:tblpY="2881"/><w:tblOverlap w:val="never"/><w:tblW w:w="0" w:type="auto"/><w:jc w:val="right"/>'
    + '<w:tblCellSpacing w:w="36" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>'
    + `<w:tr>${tc('A1')}${tc('B1')}</w:tr><w:tr><w:trPr><w:gridAfter w:val="1"/><w:wAfter w:w="3000" w:type="dxa"/></w:trPr>${tc('A2')}</w:tr></w:tbl><w:p/>`));
  assert.match(xml, /<w:tblOverlap w:val="never"\/>.*<w:jc w:val="right"\/>/);
  assert.match(xml, /<w:tr><w:trPr><w:tblCellSpacing w:w="36" w:type="dxa"\/><w:jc w:val="right"\/><\/w:trPr>/);
  assert.match(xml, /<w:tr><w:trPr><w:gridAfter w:val="1"\/><w:wAfter w:w="3000" w:type="dxa"\/><w:tblCellSpacing w:w="36" w:type="dxa"\/><w:jc w:val="right"\/><\/w:trPr>/);
});

test('an old draft without the new attributes still loads, and a draft with them keeps them', () => {
  const old = { format: 'document', formatVersion: 2, doc: { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs: { font: 'Aptos' } }, { type: 'link', attrs: { href: 'https://example.com' } }] },
    { type: 'equation', attrs: { math: 'x^2' } }, { type: 'ruby', attrs: { base: '漢', text: 'hon3' } }] },
  { type: 'textBox', content: [{ type: 'paragraph' }] }] } };
  assert.ok(loadable(old, {}));
  const node = schema.nodeFromJSON(old.doc);
  assert.equal(node.firstChild.child(1).attrs.omml, null);
  assert.equal(node.child(1).attrs.gradient, null);
  const omml = { xml: '<m:oMath/>', math: 'x^2' };
  const full = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs: { hint: 'eastAsia', webHidden: true } }, { type: 'link', attrs: { href: 'https://example.com', frame: '_top' } }] },
    { type: 'equation', attrs: { math: 'x^2', omml } }, { type: 'ruby', attrs: { base: '漢', text: 'hon3', lang: 'zh-HK', hint: 'eastAsia' } }] }] };
  const back = JSON.parse(JSON.stringify(schema.nodeFromJSON(full).toJSON()));
  const [t, eq, ruby] = back.content[0].content;
  const mark = (type) => t.marks.find((m) => m.type === type).attrs;
  assert.deepEqual([mark('textStyle').hint, mark('textStyle').webHidden, mark('link').frame], ['eastAsia', true, '_top']);
  assert.deepEqual(eq.attrs.omml, omml);
  assert.deepEqual([ruby.attrs.lang, ruby.attrs.hint], ['zh-HK', 'eastAsia']);
});
