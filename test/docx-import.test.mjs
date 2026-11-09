import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocx, parseXml, selectAlternates } from '../src/document/docx/import.mjs';
import { writeZip } from '../src/document/docx/zip.mjs';

const U = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture', wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  wp14: 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing', mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  wpi: 'http://schemas.microsoft.com/office/word/2010/wordprocessingInk', w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  am3d: 'http://schemas.microsoft.com/office/drawing/2017/model3d', cx1: 'http://schemas.microsoft.com/office/drawing/2015/9/8/chartex',
  v: 'urn:schemas-microsoft-com:vml', o: 'urn:schemas-microsoft-com:office:office', w10: 'urn:schemas-microsoft-com:office:word',
};
const NS = Object.entries(U).map(([p, u]) => `xmlns:${p}="${u}"`).join(' ');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
/** A .docx of `body` (with `sect` as its final w:sectPr), plus `parts` [[name, xml]] and document relationships `rels`. */
const docx = (body, { sect = '<w:sectPr/>', parts = [], rels = '' } = {}) => writeZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['word/document.xml', `<w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`],
  ['word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`],
  ['word/media/image1.png', Buffer.from(PNG, 'base64')],
  ...parts,
]);
const imageRel = `<Relationship Id="rIdP" Type="${IMAGE}" Target="media/image1.png"/>`;
const picture = (w = 72, h = 36) => `<w:drawing><wp:inline><wp:extent cx="${w * 12700}" cy="${h * 12700}"/><wp:docPr id="9" name="Fallback picture"/><a:graphic><a:graphicData uri="${U.pic}">`
  + '<pic:pic><pic:nvPicPr><pic:cNvPr id="9" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdP"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
const walk = (n, out = []) => { if (n && typeof n === 'object') { out.push(n); for (const k of n.content ?? []) walk(k, out); } return out; };
const textOf = (doc) => walk(doc).filter((n) => n.type === 'text').map((n) => n.text).join('');

test('markup compatibility: the first Choice whose required namespaces the importer reads, else the Fallback, else nothing', () => {
  const pick = (inner, root = NS) => {
    const r = selectAlternates(parseXml(`<w:body ${root}><w:p>${inner}</w:p></w:body>`));
    return r.kids[0].kids.map((k) => k.attrs?.id ?? k.name);
  };
  const ac = (...parts) => `<mc:AlternateContent>${parts.join('')}</mc:AlternateContent>`;
  const choice = (req, id, ns = '') => `<mc:Choice Requires="${req}"${ns}><w:r id="${id}"/></mc:Choice>`;
  const fallback = '<mc:Fallback><w:r id="fallback"/></mc:Fallback>';
  assert.deepEqual(pick(ac(choice('wps', 'shape'), fallback)), ['shape'], 'wps is read');
  assert.deepEqual(pick(ac(choice('wpi', 'ink'), fallback)), ['fallback'], 'ink is not: its fallback picture is read');
  assert.deepEqual(pick(ac(choice('am3d', '3d'), choice('wps', 'second'), fallback)), ['second'], 'the first Choice that is understood wins');
  assert.deepEqual(pick(ac(choice('wps am3d', 'both'), fallback)), ['fallback'], 'every required prefix must be understood');
  assert.deepEqual(pick(ac(choice('w14', 'w14'))), [], 'no understood Choice and no Fallback: nothing');
  assert.deepEqual(pick(ac(choice('cx1', 'chartex'), fallback)), ['chartex'], 'chartex (cx1) is read');
  assert.deepEqual(pick(ac(choice('cx', 'own', ` xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"`), fallback), 'xmlns:w="w"'), ['own'],
    'a prefix declared on the Choice itself resolves there');
  assert.deepEqual(pick(ac(choice('wps', 'undeclared'), fallback), 'xmlns:w="w"'), ['fallback'], 'a prefix the part does not declare is not understood');
  assert.deepEqual(pick(ac('<mc:Choice Requires="wpi"><w:r id="outer"/></mc:Choice>', `<mc:Fallback>${ac(choice('wps', 'nested'))}</mc:Fallback>`)), ['nested'], 'nested AlternateContent');
  // A part that binds the markup-compatibility namespace to another prefix (Word 2007's ve:).
  assert.deepEqual(pick('<ve:AlternateContent><ve:Choice Requires="wpi"><w:r id="ink"/></ve:Choice><ve:Fallback><w:r id="ve-fallback"/></ve:Fallback></ve:AlternateContent>',
    `${NS} xmlns:ve="${U.mc}"`), ['ve-fallback']);
});

test('a list made from a list style (w:numStyleLink) numbers with the levels of the definition the style links to', async () => {
  const lvl = (fmt, text) => `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl>`;
  const numbering = `<w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/><w:styleLink w:val="StepList"/>${lvl('lowerLetter', '%1)')}</w:abstractNum>`
    + '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/><w:numStyleLink w:val="StepList"/></w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>';
  const styles = `<w:styles ${NS}><w:style w:type="numbering" w:customStyle="1" w:styleId="StepList"><w:name w:val="Step List"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style></w:styles>`;
  const body = '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Item</w:t></w:r></w:p>';
  const { doc } = await importDocx(await docx(body, { parts: [['word/numbering.xml', numbering], ['word/styles.xml', styles]] }), { fresh: true });
  const { abstract, nums } = doc.attrs.numbering;
  assert.equal(nums['2'].abstract, '0');
  assert.deepEqual([abstract['0'].levels[0].fmt, abstract['0'].levels[0].text], ['lowerLetter', '%1)']);
});

test('docx import: ink and a 3D model show their fallback pictures; a block-level AlternateContent and a VML Fallback read too', async () => {
  const ink = `<w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="3" name="Ink 3"/><a:graphic><a:graphicData uri="${U.wpi}">`
    + '<w14:contentPart r:id="rIdInk"/></a:graphicData></a:graphic></wp:inline></w:drawing>';
  const body = `<w:p><w:r><w:t>Ink </w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires="wpi">${ink}</mc:Choice><mc:Fallback>${picture(72, 36)}</mc:Fallback></mc:AlternateContent></w:r></w:p>`
    + `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="am3d"><w:t>model</w:t></mc:Choice><mc:Fallback>${picture(30, 20)}</mc:Fallback></mc:AlternateContent></w:r></w:p>`
    + '<mc:AlternateContent><mc:Choice Requires="am3d"><w:p><w:r><w:t>unreadable block</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>block fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>'
    + '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wpi"><w:t>ink2</w:t></mc:Choice><mc:Fallback><w:pict><v:rect style="width:40pt;height:20pt" fillcolor="red"/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>';
  const { doc, dropped } = await importDocx(await docx(body, { rels: imageRel }), { fresh: true });
  assert.deepEqual(dropped, []);
  const images = walk(doc).filter((n) => n.type === 'image');
  assert.deepEqual(images.map((i) => [i.attrs.width, i.attrs.height, i.attrs.name]), [[96, 48, 'Fallback picture'], [40, 26.6667, 'Fallback picture']]);
  assert.equal(textOf(doc), 'Ink block fallback');
  const canvas = walk(doc).find((n) => n.type === 'canvas');
  assert.equal(canvas?.attrs.items[0].fillColor, '#FF0000', 'the VML Fallback rectangle draws');
});

test('a header that only the first section holds stays when that section\'s break goes into a columns run (sections without one link to it)', async () => {
  const HDR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header';
  const sect = (inner) => `<w:p><w:pPr><w:sectPr>${inner}<w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr></w:p>`;
  const body = '<w:p><w:r><w:t>Title</w:t></w:r></w:p>'
    + sect('<w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/><w:type w:val="continuous"/>')
    + '<w:p><w:r><w:t>Two columns</w:t></w:r></w:p>' + sect('<w:type w:val="continuous"/><w:cols w:num="2"/>')
    + '<w:p><w:r><w:t>One column</w:t></w:r></w:p>' + sect('<w:type w:val="continuous"/><w:headerReference w:type="first" r:id="rIdH2"/><w:titlePg/>')
    + '<w:p><w:r><w:t>Last</w:t></w:r></w:p>';
  const part = (tag, words) => `<w:${tag} ${NS}><w:p><w:r><w:t>${words}</w:t></w:r></w:p></w:${tag}>`;
  const bytes = await docx(body, {
    sect: '<w:sectPr><w:type w:val="nextPage"/></w:sectPr>',
    parts: [['word/header1.xml', part('hdr', 'Head')], ['word/footer1.xml', part('ftr', 'Foot')], ['word/header2.xml', part('hdr', 'First head')]],
    rels: `<Relationship Id="rIdH" Type="${HDR}" Target="header1.xml"/><Relationship Id="rIdF" Type="${HDR.replace('header', 'footer')}" Target="footer1.xml"/>`
      + `<Relationship Id="rIdH2" Type="${HDR}" Target="header2.xml"/>`,
  });
  const { doc } = await importDocx(bytes, { fresh: true });
  const breaks = doc.content.filter((n) => n.type === 'sectionBreak');
  const words = (part) => (part ? textOf({ content: part }) : null);
  // The first two sections' breaks go (continuous around the columns run): the third section's break holds what they held.
  assert.deepEqual(doc.content.map((n) => n.type), ['paragraph', 'columns', 'paragraph', 'sectionBreak', 'paragraph']);
  assert.deepEqual([words(breaks[0].attrs.sect.hdr.default), words(breaks[0].attrs.sect.hdr.first), words(breaks[0].attrs.sect.ftr.default)], ['Head', 'First head', 'Foot']);
  assert.equal(doc.attrs.sect.hdr, null, 'the last section still links to the one before it');
});

test('relative sizes (wp14:sizeRelH, sizeRelV) size floating drawings from their section\'s page, as Word does; inline ones keep their extent', async () => {
  const { exportDocx } = await import('../src/document/docx/export.mjs');
  const { readZip, text } = await import('../src/document/docx/zip.mjs');
  const rel = (h, v) => (h ? `<wp14:sizeRelH relativeFrom="${h[0]}"><wp14:pctWidth>${h[1]}</wp14:pctWidth></wp14:sizeRelH>` : '')
    + (v ? `<wp14:sizeRelV relativeFrom="${v[0]}"><wp14:pctHeight>${v[1]}</wp14:pctHeight></wp14:sizeRelV>` : '');
  const shape = '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="228600"/></a:xfrm>'
    + '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>';
  const box = '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>'
    + '<wps:txbx><w:txbxContent><w:p><w:r><w:t>Boxed</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>';
  const pic = `<a:graphic><a:graphicData uri="${U.pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdP"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic>`;
  const anchor = (graphic, sz, id) => `<w:p><w:r><w:drawing><wp:anchor behindDoc="0" relativeHeight="251658240" allowOverlap="1" layoutInCell="1"><wp:simplePos x="0" y="0"/>`
    + '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>'
    + `<wp:extent cx="457200" cy="228600"/><wp:wrapNone/><wp:docPr id="${id}" name="D${id}"/>${graphic}${sz}</wp:anchor></w:drawing></w:r></w:p>`;
  const inline = (graphic, sz, id) => `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="457200" cy="228600"/><wp:docPr id="${id}" name="D${id}"/>${graphic}${sz}</wp:inline></w:drawing></w:r></w:p>`;
  // Section 1: Letter, margins 1.5 in left and 1 in elsewhere (text 432 x 648 pt). Section 2: 400 x 500 pt, margins 50 pt.
  const sect1 = '<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="2160" w:header="720" w:footer="720" w:gutter="0"/>';
  const body = anchor(shape, rel(['margin', 50000], ['page', 25000]), 1) + inline(shape, rel(['margin', 50000]), 2) + anchor(box, rel(['leftMargin', 100000]), 3)
    + anchor(pic, rel(['page', 50000]), 4) + `<w:p><w:pPr><w:sectPr>${sect1}</w:sectPr></w:pPr></w:p>`
    + anchor(shape, rel(['margin', 100000], ['bottomMargin', 100000]), 5) + '<w:p><w:r><w:pict><v:rect style="width:0;height:1.5pt" o:hralign="center" o:hrstd="t" o:hr="t"/></w:pict></w:r></w:p>';
  const sect2 = '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="8000" w:h="10000"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="400" w:footer="400" w:gutter="0"/></w:sectPr>';
  const bytes = await docx(body, { sect: sect2, rels: `${imageRel}<Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`,
    parts: [['word/header1.xml', `<w:hdr ${NS}>${anchor(shape, rel(['page', 100000]), 6)}</w:hdr>`]] });
  const { doc, dropped } = await importDocx(bytes, { fresh: true });
  assert.deepEqual(dropped, []);
  const nodes = walk(doc).filter((n) => ['canvas', 'textBox', 'image'].includes(n.type));
  const size = (n) => (n.type === 'canvas' ? [n.attrs.w * 0.75, n.attrs.h * 0.75] : n.type === 'image' ? [n.attrs.width * 0.75, n.attrs.height * 0.75] : [n.attrs.w, n.attrs.h]);
  assert.deepEqual(nodes.map((n) => [n.type, ...size(n).map((x) => Math.round(x * 10) / 10)]), [
    ['canvas', 216, 198], // 50 % of the 432 pt text width, 25 % of the 792 pt page
    ['canvas', 36, 18], // inline: its extent, as Word draws it
    ['textBox', 108, 18], // the 1.5 in left margin
    ['image', 306, 18], // 50 % of the page
    ['canvas', 300, 50], // section 2: its 300 pt text width and 50 pt bottom margin
    ['canvas', 300, 1.5], // section 2's horizontal line: the text width
  ]);
  assert.deepEqual(nodes[0].attrs.layout.relSize, { h: { from: 'margin', pct: 50000, emu: 2743200 }, v: { from: 'page', pct: 25000, emu: 2514600 } });
  const head = walk({ content: doc.attrs.sect.hdr.default }).find((n) => n.type === 'canvas');
  assert.equal(Math.round(head.attrs.w * 0.75), 400, 'a header drawing sizes from the page of the section that holds the header');

  // Export writes the relative size back, unless the drawing was resized here.
  const xmlOf = async (d) => text((await readZip((await exportDocx(d)).bytes)).get('word/document.xml'));
  const xml = await xmlOf(doc);
  assert.match(xml, /mc:Ignorable="wp14[ "]/);
  assert.match(xml, /<wp14:sizeRelH relativeFrom="margin"><wp14:pctWidth>50000<\/wp14:pctWidth><\/wp14:sizeRelH><wp14:sizeRelV relativeFrom="page"><wp14:pctHeight>25000<\/wp14:pctHeight><\/wp14:sizeRelV><\/wp:anchor>/);
  assert.match(xml, /<wp14:sizeRelH relativeFrom="leftMargin"><wp14:pctWidth>100000</);
  const again = await importDocx((await exportDocx(doc)).bytes, { fresh: true });
  assert.equal(Math.round(walk(again.doc).filter((n) => n.type === 'canvas')[0].attrs.w * 0.75), 216, 'and it reads back at the same size');
  const resized = structuredClone(doc);
  const first = walk(resized).find((n) => n.type === 'canvas');
  for (const it of first.attrs.items) it.w /= 2;
  first.attrs.w /= 2;
  first.attrs.dw /= 2;
  assert.doesNotMatch(await xmlOf(resized), /relativeFrom="margin"><wp14:pctWidth>50000</, 'a drawing resized here goes out at its own width');
});

test('DrawingML WordArt (wps:wsp with a:prstTxWarp) shows its text: a text box in a rectangle, a label in another shape (the warp is not drawn)', async () => {
  const art = (prst) => '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="2540000" cy="635000"/><wp:docPr id="1" name="WordArt 1"/><a:graphic>'
    + '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr>'
    + `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx><w:txbxContent><w:p><w:r><w:rPr><w:b/><w:color w:val="4472C4"/><w:sz w:val="72"/></w:rPr>`
    + '<w:t>Big words</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr wrap="none"><a:prstTxWarp prst="textArchUp"><a:avLst/></a:prstTxWarp><a:spAutoFit/></wps:bodyPr></wps:wsp>'
    + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const { doc, dropped } = await importDocx(await docx(art('rect') + art('ellipse')), { fresh: true });
  assert.deepEqual(dropped, []);
  const box = walk(doc).find((n) => n.type === 'textBox');
  assert.equal(textOf({ content: box.content }), 'Big words');
  const label = walk(doc).find((n) => n.type === 'canvas').attrs.items[0];
  assert.deepEqual([label.html, label.textColor, label.bold, Math.round(label.size * 0.75)], ['Big words', '#4472C4', true, 36]);
});

// ---------- run, paragraph, field and content control properties (checked against Word's all-features fixture) ----------
/** `body` imported, exported and imported again → {doc, xml (the export's document.xml), styles (its styles.xml), back (the second import)}. */
const roundTrip = async (body, opts) => {
  const { exportDocx } = await import('../src/document/docx/export.mjs');
  const { readZip, text } = await import('../src/document/docx/zip.mjs');
  const { doc } = await importDocx(await docx(body, opts), { fresh: true });
  const { bytes } = await exportDocx(doc);
  const files = await readZip(bytes);
  return { doc, xml: text(files.get('word/document.xml')), styles: text(files.get('word/styles.xml')), back: (await importDocx(bytes, { fresh: true })).doc };
};
const r = (rpr, inner) => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}${inner}</w:r>`;
const fld = (t, ff = '') => r('', `<w:fldChar w:fldCharType="${t}">${ff}</w:fldChar>`);
const fieldsOf = (doc) => walk(doc).filter((n) => n.type === 'field');
const styleOf = (n) => n.marks?.find((m) => m.type === 'textStyle')?.attrs ?? {};

test('a field draws in its result\'s formatting: a complex field\'s first result run, a simple field\'s first run', async () => {
  const body = `<w:p>${fld('begin')}${r('', '<w:instrText> QUOTE "27" \\* Hebrew1 </w:instrText>')}${fld('separate')}`
    + `${r('<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:noProof/>', '<w:t>כז</w:t>')}${fld('end')}</w:p>`
    + '<w:p><w:fldSimple w:instr=" SEQ Chapter \\* ARABIC "><w:r><w:rPr><w:b/><w:noProof/></w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p>';
  const { doc, xml, back } = await roundTrip(body);
  const [quote, seq] = fieldsOf(doc);
  assert.deepEqual([styleOf(quote).font, styleOf(quote).fontCS, styleOf(quote).noProof], ['Arial', 'Arial', true]);
  assert.deepEqual([seq.marks[0].type, styleOf(seq).noProof], ['bold', true]);
  assert.match(xml, /<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"\/><w:noProof\/><\/w:rPr><w:t xml:space="preserve">כז/);
  assert.deepEqual(fieldsOf(back).map((f) => f.marks), [quote.marks, seq.marks]);
});

test('legacy form fields keep their options (w:ffData as the field\'s ff) and write them back as Word does', async () => {
  const ff = (inner, rest = '<w:enabled/><w:calcOnExit w:val="0"/>') => `<w:ffData><w:name w:val="F"/>${rest}${inner}</w:ffData>`;
  const form = (code, data, result) => `<w:p>${fld('begin', data)}${r('', `<w:instrText> ${code} </w:instrText>`)}${fld('separate')}${r('<w:noProof/>', `<w:t>${result}</w:t>`)}${fld('end')}</w:p>`;
  const body = form('FORMTEXT', ff('<w:textInput><w:type w:val="number"/><w:default w:val="1,234"/><w:maxLength w:val="10"/><w:format w:val="#,##0"/></w:textInput>'), '1,234')
    + form('FORMCHECKBOX', ff('<w:checkBox><w:size w:val="20"/><w:default w:val="0"/><w:checked/></w:checkBox>',
      '<w:enabled w:val="0"/><w:calcOnExit/><w:helpText w:type="text" w:val="Help"/><w:statusText w:type="text" w:val="Status"/>'), '☒')
    + form('FORMDROPDOWN', ff('<w:ddList><w:result w:val="1"/><w:listEntry w:val="Red"/><w:listEntry w:val="Green"/></w:ddList>'), 'Green')
    + form('FORMCHECKBOX', ff('<w:checkBox><w:sizeAuto/><w:default w:val="1"/></w:checkBox>'), '☒');
  const { doc, xml, back } = await roundTrip(body);
  const common = { name: 'F', help: null, status: null, enabled: true, calcOnExit: false };
  const expected = [{ ...common, type: 'number', default: '1,234', maxLength: 10, format: '#,##0' },
    { ...common, enabled: false, calcOnExit: true, help: 'Help', status: 'Status', default: false, checked: true, size: 10 },
    { ...common, items: ['Red', 'Green'], result: 1 }, { ...common, default: true, checked: null, size: null }];
  assert.deepEqual(fieldsOf(doc).map((f) => f.attrs.ff), expected);
  assert.deepEqual(fieldsOf(back).map((f) => f.attrs.ff), expected);
  for (const x of ['<w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="F"/><w:enabled/><w:calcOnExit w:val="0"/><w:textInput><w:type w:val="number"/><w:default w:val="1,234"/><w:maxLength w:val="10"/><w:format w:val="#,##0"/></w:textInput></w:ffData></w:fldChar>',
    '<w:enabled w:val="0"/><w:calcOnExit/><w:helpText w:type="text" w:val="Help"/><w:statusText w:type="text" w:val="Status"/><w:checkBox><w:size w:val="20"/><w:default w:val="0"/><w:checked/></w:checkBox>',
    '<w:ddList><w:result w:val="1"/><w:listEntry w:val="Red"/><w:listEntry w:val="Green"/></w:ddList>', '<w:checkBox><w:sizeAuto/><w:default w:val="1"/></w:checkBox>']) assert.ok(xml.includes(x), x);
});

test('run properties: theme fonts per script, Fit Text, Asian layout, OpenType features, a symbol\'s font, an exact theme shade and tracked formatting', async () => {
  const body = `<w:p>${r('<w:rFonts w:eastAsiaTheme="majorEastAsia"/>', '<w:t>EA</w:t>')}${r('<w:rFonts w:cstheme="minorBidi"/>', '<w:t>CS</w:t>')}`
    + `${r('<w:fitText w:val="1440" w:id="-35"/>', '<w:t>Fit</w:t>')}${r('<w:eastAsianLayout w:id="-36" w:combine="1" w:combineBrackets="round"/>', '<w:t>Two</w:t>')}`
    + `${r('<w14:ligatures w14:val="standardContextual"/><w14:numForm w14:val="oldStyle"/><w14:stylisticSets><w14:styleSet w14:id="3"/></w14:stylisticSets><w14:cntxtAlts w14:val="0"/>', '<w:t>Liga</w:t>')}`
    + `${r('', '<w:sym w:font="Wingdings" w:char="F04A"/>')}${r('<w:color w:val="1F3864" w:themeColor="accent1" w:themeShade="D8"/>', '<w:t>Shade</w:t>')}`
    + `${r('<w:b/><w:rPrChange w:id="7" w:author="Kim" w:date="2026-10-29T00:00:00Z"><w:rPr><w:i/></w:rPr></w:rPrChange>', '<w:t>Changed</w:t>')}</w:p>`;
  const { doc, xml, back } = await roundTrip(body);
  const runs = walk(doc).filter((n) => n.type === 'text');
  const ts = runs.map(styleOf);
  assert.deepEqual([ts[0].fontEA, ts[1].fontCS], ['+major', '+minor']);
  assert.deepEqual(ts[2].fitText, { w: 72, id: -35 });
  assert.deepEqual(ts[3].eastAsianLayout, { id: -36, combine: true, combineBrackets: 'round' });
  assert.deepEqual(ts[4].typography, { ligatures: 'standardContextual', numForm: 'oldStyle', stylisticSet: 3, contextual: false });
  assert.deepEqual([runs[5].text, ts[5].font], ['', 'Wingdings']);
  assert.deepEqual(ts[6].themeColor, { slot: 'accent1', lum: -0.1529 });
  assert.deepEqual(runs[7].marks.find((m) => m.type === 'formatChange').attrs, { id: '7', author: 'Kim', date: '2026-10-29T00:00:00Z', old: [{ type: 'italic' }] });
  for (const x of ['<w:rFonts w:eastAsiaTheme="majorEastAsia"/>', '<w:rFonts w:cstheme="minorBidi"/>', '<w:fitText w:val="1440" w:id="-35"/>',
    '<w:eastAsianLayout w:id="-36" w:combine="1" w:combineBrackets="round"/>',
    '<w14:ligatures w14:val="standardContextual"/><w14:numForm w14:val="oldStyle"/><w14:stylisticSets><w14:styleSet w14:id="3"/></w14:stylisticSets><w14:cntxtAlts w14:val="0"/>',
    'w:themeShade="D8"', '<w:rPrChange w:id="1" w:author="Kim" w:date="2026-10-29T00:00:00Z"><w:rPr><w:i/><w:iCs/></w:rPr></w:rPrChange>']) assert.ok(xml.includes(x), x);
  assert.deepEqual(walk(back).filter((n) => n.type === 'text').map(styleOf).slice(0, 7), ts.slice(0, 7));
});

test('text effects (w14 glow, shadow, reflection, outline and fill) read as textStyle effects, a theme colour resolved, and write back', async () => {
  const theme = ['word/theme/theme1.xml', '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="T">'
    + '<a:accent1><a:srgbClr val="156082"/></a:accent1></a:clrScheme></a:themeElements></a:theme>'];
  const body = `<w:p>${r('<w14:glow w14:rad="63500"><w14:schemeClr w14:val="accent1"><w14:alpha w14:val="60000"/></w14:schemeClr></w14:glow>'
    + '<w14:shadow w14:blurRad="50800" w14:dist="38100" w14:dir="2700000" w14:sx="100000" w14:sy="100000" w14:kx="0" w14:ky="0" w14:algn="tl"><w14:srgbClr w14:val="000000"><w14:alpha w14:val="60000"/></w14:srgbClr></w14:shadow>'
    + '<w14:reflection w14:blurRad="6350" w14:stA="55000" w14:stPos="0" w14:endA="300" w14:endPos="45500" w14:dist="12700" w14:dir="5400000" w14:sy="-100000" w14:algn="bl"/>'
    + '<w14:textOutline w14:w="19050" w14:cap="rnd" w14:cmpd="sng" w14:algn="ctr"><w14:solidFill><w14:srgbClr w14:val="C00000"/></w14:solidFill><w14:prstDash w14:val="lgDash"/><w14:bevel/></w14:textOutline>'
    + '<w14:textFill><w14:gradFill><w14:gsLst><w14:gs w14:pos="0"><w14:srgbClr w14:val="4472C4"/></w14:gs><w14:gs w14:pos="100000"><w14:srgbClr w14:val="000000"/></w14:gs></w14:gsLst><w14:lin w14:ang="5400000" w14:scaled="1"/></w14:gradFill></w14:textFill>',
  '<w:t>All</w:t>')}${r('<w14:textFill><w14:solidFill><w14:srgbClr w14:val="7030A0"><w14:alpha w14:val="50000"/></w14:srgbClr></w14:solidFill></w14:textFill>', '<w:t>Half</w:t>')}</w:p>`;
  const { doc, xml, back } = await roundTrip(body, { parts: [theme] });
  const [all, half] = walk(doc).filter((n) => n.type === 'text').map((n) => styleOf(n).effects);
  assert.deepEqual(all, { fill: { type: 'gradient', angle: 90, stops: [{ pos: 0, color: '#4472C4' }, { pos: 100, color: '#000000' }] },
    outline: { color: '#C00000', width: 1.5, dash: 'longDash' }, shadow: { color: '#000000', alpha: 0.4, blur: 4, dist: 3, angle: 45 },
    glow: { color: '#156082', alpha: 0.4, size: 5 }, reflection: { size: 45.5, dist: 1, alpha: 0.55 } });
  assert.deepEqual(half.fill, { type: 'solid', color: '#7030A080' });
  for (const x of ['<w14:glow w14:rad="63500"><w14:srgbClr w14:val="156082"><w14:alpha w14:val="60000"/></w14:srgbClr></w14:glow>',
    '<w14:shadow w14:blurRad="50800" w14:dist="38100" w14:dir="2700000"><w14:srgbClr w14:val="000000"><w14:alpha w14:val="60000"/></w14:srgbClr></w14:shadow>',
    'w14:stA="55000" w14:stPos="0" w14:endA="300" w14:endPos="45500" w14:dist="12700"', '<w14:prstDash w14:val="lgDash"/>',
    '<w14:gs w14:pos="0"><w14:srgbClr w14:val="4472C4"/></w14:gs>', '<w14:srgbClr w14:val="7030A0"><w14:alpha w14:val="50000"/></w14:srgbClr>']) assert.ok(xml.includes(x), x);
  assert.deepEqual(walk(back).filter((n) => n.type === 'text').map((n) => styleOf(n).effects), [all, half]);
});

test('paragraph properties: Collapsed by default and tracked paragraph formatting', async () => {
  const body = '<w:p><w:pPr><w:pStyle w:val="Heading3"/><w15:collapsed/></w:pPr><w:r><w:t>Head</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="Quote"/><w:jc w:val="center"/><w:pPrChange w:id="3" w:author="Kim" w:date="2026-10-29T00:00:00Z"><w:pPr><w:ind w:left="720"/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>Body</w:t></w:r></w:p>';
  const { doc, xml, back } = await roundTrip(body);
  assert.equal(doc.content[0].attrs.collapsed, true);
  assert.deepEqual(doc.content[1].attrs.pChange, { id: '3', author: 'Kim', date: '2026-10-29T00:00:00Z', old: { indent: { left: 36 } } });
  assert.ok(xml.includes('<w15:collapsed/></w:pPr>'));
  assert.match(xml, /<w:pPrChange w:id="\d+" w:author="Kim" w:date="2026-10-29T00:00:00Z"><w:pPr><w:ind w:left="720"\/><\/w:pPr><\/w:pPrChange><\/w:pPr>/);
  assert.deepEqual([back.content[0].attrs.collapsed, back.content[1].attrs.pChange.old], [true, { indent: { left: 36 } }]);
});

test('a phonetic guide keeps its font for every script and the base text\'s size', async () => {
  const body = '<w:p><w:r><w:ruby><w:rubyPr><w:rubyAlign w:val="center"/><w:hps w:val="12"/><w:hpsRaise w:val="22"/><w:hpsBaseText w:val="24"/><w:lid w:val="ja-JP"/></w:rubyPr>'
    + '<w:rt><w:r><w:rPr><w:rFonts w:ascii="MS Mincho" w:eastAsia="MS Mincho" w:hAnsi="MS Mincho"/><w:sz w:val="12"/></w:rPr><w:t>かんじ</w:t></w:r></w:rt>'
    + '<w:rubyBase><w:r><w:t>漢字</w:t></w:r></w:rubyBase></w:ruby></w:r></w:p>';
  const styles = ['word/styles.xml', `<w:styles ${NS}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="24"/></w:rPr></w:style></w:styles>`];
  const { doc, xml } = await roundTrip(body, { parts: [styles] });
  assert.equal(walk(doc).find((n) => n.type === 'ruby').attrs.font, 'MS Mincho');
  assert.match(xml, /<w:hpsBaseText w:val="24"\/>.*<w:rFonts w:ascii="MS Mincho" w:hAnsi="MS Mincho" w:eastAsia="MS Mincho"\/>/);
});

test('content controls keep their id, run style, appearance, colour, temporary, multi-line, date storage and calendar, check box state and symbols, repeating section and Document Property binding', async () => {
  const sdt = (pr, content = '<w:r><w:t>x</w:t></w:r>') => `<w:p><w:sdt><w:sdtPr>${pr}</w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt></w:p>`;
  const bind = (map, xpath, store) => `<w:dataBinding w:prefixMappings="${map}" w:xpath="${xpath}" w:storeItemID="${store}"/>`;
  const body = sdt('<w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:id w:val="-2017149346"/><w:temporary/><w15:color w:val="2E8B57"/><w15:appearance w15:val="tags"/><w:text w:multiLine="1"/>')
    + sdt('<w:id w:val="5"/><w:date w:fullDate="2026-10-29T00:00:00Z"><w:dateFormat w:val="d MMMM yyyy"/><w:lid w:val="ja-JP"/><w:storeMappedDataAs w:val="text"/><w:calendar w:val="japan"/></w:date>')
    + sdt('<w:id w:val="6"/><w14:checkbox><w14:checked w14:val="1"/><w14:checkedState w14:val="2713" w14:font="Segoe UI Symbol"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox>', '<w:r><w:t>✓</w:t></w:r>')
    // Word's cover pages declare the namespaces the other way round: the binding reads by namespace, not by prefix.
    + sdt(`<w:id w:val="7"/>${bind("xmlns:ns0='http://schemas.openxmlformats.org/package/2006/metadata/core-properties' xmlns:ns1='http://purl.org/dc/elements/1.1/'",
      '/ns0:coreProperties[1]/ns1:title[1]', '{6C3C8BC8-F283-45AE-878A-BAB7291924A1}')}<w:text/>`)
    + sdt(`<w:id w:val="8"/>${bind("xmlns:ns0='http://schemas.microsoft.com/office/2006/coverPageProps'", '/ns0:CoverPageProperties[1]/ns0:PublishDate[1]', '{55AF091B-3C7A-41E3-B477-F2FDAA23CFDA}')}<w:text/>`)
    + sdt(`<w:id w:val="11"/>${bind("xmlns:ns0='urn:own'", '/ns0:order[1]/ns0:paid[1]', '{4A23C0D3-FAD1-4AB1-A0DC-AB7A84F93C58}')}<w:text/>`)
    + '<w:sdt><w:sdtPr><w:id w:val="9"/><w15:repeatingSection><w15:sectionTitle w:val="Line"/><w15:doNotAllowInsertDeleteSection w:val="1"/></w15:repeatingSection></w:sdtPr><w:sdtContent>'
    + '<w:sdt><w:sdtPr><w:id w:val="10"/><w15:repeatingSectionItem/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:sdtContent></w:sdt></w:sdtContent></w:sdt>';
  const { doc, xml, back } = await roundTrip(body);
  const sdts = (d) => walk(d).filter((n) => /^sdt/.test(n.type)).map((n) => n.attrs.sdt);
  const [text, date, box, title, publish, custom, rep, item] = sdts(doc);
  assert.deepEqual([text.id, text.style, text.appearance, text.color, text.temporary, text.multiLine], ['-2017149346', 'Strong', 'tags', '#2E8B57', true, true]);
  assert.deepEqual(date.date, { format: 'd MMMM yyyy', lang: 'ja-JP', full: '2026-10-29T00:00:00Z', store: 'text', calendar: 'japan' });
  assert.deepEqual([box.type, box.checked, box.checkedChar, box.uncheckedChar], ['checkbox', true, '✓', '☐']);
  assert.deepEqual([title.binding, publish.binding, custom.binding], [{ prop: 'core.title' }, { prop: 'cover.publishDate' }, null]);
  assert.deepEqual([rep.type, rep.repeat, item.type], ['repeating', { title: 'Line', allowAddRemove: false }, 'repeatingItem']);
  for (const x of ['<w:sdtPr><w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:id w:val="-2017149346"/><w:temporary/><w15:color w:val="2E8B57"/><w15:appearance w15:val="tags"/><w:text w:multiLine="1"/></w:sdtPr>',
    '<w:storeMappedDataAs w:val="text"/><w:calendar w:val="japan"/>', '<w14:checkbox><w14:checked w14:val="1"/><w14:checkedState w14:val="2713"/><w14:uncheckedState w14:val="2610"/></w14:checkbox>',
    'w:xpath="/ns1:coreProperties[1]/ns0:title[1]" w:storeItemID="{6C3C8BC8-F283-45AE-878A-BAB7291924A1}"', 'w:xpath="/ns0:CoverPageProperties[1]/ns0:PublishDate[1]"',
    '<w15:repeatingSection><w15:sectionTitle w:val="Line"/><w15:doNotAllowInsertDeleteSection w:val="1"/></w15:repeatingSection>', '<w15:repeatingSectionItem/>']) assert.ok(xml.includes(x), x);
  assert.deepEqual(sdts(back), sdts(doc));
});

test('styles.xml and numbering.xml declare w14 for the OpenType features a style or level run holds', async () => {
  const styles = ['word/styles.xml', `<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/>`
    + '<w14:ligatures w14:val="standardContextual"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>'];
  const { doc, styles: xml } = await roundTrip('<w:p><w:r><w:t>x</w:t></w:r></w:p>', { parts: [styles] });
  assert.deepEqual([doc.attrs.styles.defaults.run.fontEA, doc.attrs.styles.defaults.run.fontCS, doc.attrs.styles.defaults.run.typography], ['+minor', '+minor', { ligatures: 'standardContextual' }]);
  assert.match(xml, /^<\?xml[^>]*>\s*<w:styles [^>]*xmlns:w14="http:\/\/schemas.microsoft.com\/office\/word\/2010\/wordml"[^>]* mc:Ignorable="w14">/);
  // The unchanged defaults come back as the file wrote them (parts-roundtrip).
  assert.ok(xml.includes('<w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/>'));
  assert.ok(xml.includes('<w14:ligatures w14:val="standardContextual"/>'));
});

test("Word's watermarks (VML in each header) read as their section's watermark and leave the header; a linked header passes it on", async () => {
  const HDR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header';
  const where = 'position:absolute;margin-left:0;margin-top:0;z-index:-251657216;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin';
  const run = (shape) => `<w:r><w:rPr><w:noProof/></w:rPr><w:pict>${shape}</w:pict></w:r>`;
  const text = run(`<v:shape id="PowerPlusWaterMarkObject357476642" o:spid="_x0000_s2049" type="#_x0000_t136" style="${where};width:532.45pt;height:88.15pt;rotation:315" o:allowincell="f" fillcolor="silver" stroked="f">`
    + '<v:fill opacity=".5"/><v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="CONFIDENTIAL"/><w10:wrap anchorx="margin" anchory="margin"/></v:shape>');
  // A 1 px picture 1.5 pt wide is 200 % of its own size; Word's washout is gain and blacklevel.
  const picture = run(`<v:shape id="WordPictureWatermark2" o:spid="_x0000_s2050" type="#_x0000_t75" style="${where};width:1.5pt;height:1.5pt" o:allowincell="f">`
    + '<v:imagedata r:id="rIdP" o:title="photo" gain="19661f" blacklevel="22938f"/></v:shape>');
  const hdr = (inner) => `<w:hdr ${NS}>${inner}</w:hdr>`;
  const gallery = (p) => `<w:sdt><w:sdtPr><w:id w:val="1"/><w:docPartObj><w:docPartGallery w:val="Watermarks"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>${p}</w:sdtContent></w:sdt>`;
  const sect = (rid) => `<w:sectPr>${rid ? `<w:headerReference w:type="default" r:id="${rid}"/>` : ''}</w:sectPr>`;
  const bytes = await docx(`<w:p><w:pPr>${sect('rIdH1')}</w:pPr><w:r><w:t>One</w:t></w:r></w:p><w:p><w:pPr>${sect('rIdH2')}</w:pPr><w:r><w:t>Two</w:t></w:r></w:p><w:p/>`, {
    sect: sect(null),
    rels: `<Relationship Id="rIdH1" Type="${HDR}" Target="header1.xml"/><Relationship Id="rIdH2" Type="${HDR}" Target="header2.xml"/>`,
    parts: [['word/header1.xml', hdr(gallery(`<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr>${text}</w:p>`))],
      ['word/header2.xml', hdr(`<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr>${picture}<w:r><w:t>Head</w:t></w:r></w:p>`)],
      ['word/_rels/header2.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${imageRel}</Relationships>`]],
  });
  const { doc, dropped } = await importDocx(bytes);
  const [one, two] = doc.content.filter((n) => n.type === 'sectionBreak').map((n) => n.attrs.sect);
  assert.deepEqual(one.watermark, { kind: 'text', text: 'CONFIDENTIAL', font: 'Calibri', size: 88.15, color: '#C0C0C0', semi: true, layout: 'diagonal' });
  assert.deepEqual(one.hdr.default.map((n) => [n.type, n.content ?? []]), [['paragraph', []]], 'the gallery block and the shape go: an empty Header paragraph stays');
  assert.deepEqual({ ...two.watermark, src: two.watermark.src.slice(0, 22) }, { kind: 'picture', src: 'data:image/png;base64,', scale: 200, washout: true });
  assert.equal(textOf({ content: two.hdr.default }), 'Head', 'the header keeps its text, without a picture');
  assert.ok(!walk({ content: two.hdr.default }).some((n) => n.type === 'image'));
  assert.deepEqual(doc.attrs.sect.watermark, two.watermark, 'the last section shows the header before it, so its watermark');
  assert.deepEqual(dropped, []);
});

test("Word's page fill effects (w:background's v:background) read as the page background's fill", async () => {
  // Word's own 8 x 8 Plaid tile (palette white, black: the white pixels take fillcolor).
  const plaid = Buffer.from('4749463837610800080077010021fe1a536f6674776172653a204d6963726f736f6674204f6666696365002c000000000800080080ffffff000000020f448c718b99cc8034eacc6a259e5415003b', 'hex');
  const fillOf = async (fill, fillcolor = '#4472c4', image = null) => {
    const name = `media/b.${image ? 'gif' : 'png'}`;
    const bytes = await writeZip([
      ['word/document.xml', `<w:document ${NS}><w:background w:color="4472C4"><v:background id="_x0000_s1025" o:bwmode="white" fillcolor="${fillcolor}">${fill}</v:background></w:background><w:body><w:p/><w:sectPr/></w:body></w:document>`],
      ['word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdB" Type="${IMAGE}" Target="${name}"/></Relationships>`],
      [`word/${name}`, image ?? Buffer.from(PNG, 'base64')],
    ]);
    return (await importDocx(bytes)).doc.attrs.background.fill;
  };
  const two = { kind: 'gradient', colors: 'two', color1: '#4472C4', color2: '#FFFFFF' };
  assert.deepEqual(await fillOf('<v:fill focus="100%" type="gradient"/>'), { ...two, style: 'horizontal', variant: 0 });
  assert.deepEqual(await fillOf('<v:fill angle="-90" focus="-50%" type="gradient"/>'), { ...two, style: 'vertical', variant: 3 });
  assert.deepEqual(await fillOf('<v:fill angle="90" focus="100%" type="gradient"/>'), { ...two, style: 'vertical', variant: 1 }, 'the opposite angle runs the colours back');
  assert.deepEqual(await fillOf('<v:fill angle="-45" type="gradient"/>'), { ...two, style: 'diagonalDown', variant: 1 });
  assert.deepEqual(await fillOf('<v:fill focusposition="1,1" focussize="" focus="100%" type="gradientRadial"/>'), { ...two, style: 'fromCorner', variant: 3 });
  assert.deepEqual(await fillOf('<v:fill focusposition=".5,.5" focussize="" type="gradientRadial"/>'), { ...two, style: 'fromCenter', variant: 1 });
  assert.deepEqual(await fillOf('<v:fill color2="fill darken(128)" method="linear sigma" focus="100%" type="gradient"/>'),
    { kind: 'gradient', colors: 'one', color1: '#4472C4', shade: 0.25, style: 'horizontal', variant: 0 });
  assert.deepEqual(await fillOf('<v:fill color2="#ff8200" colors="0 #000082;19661f #66008f;1 #ff8200" method="none" focus="100%" type="gradient"/>'),
    { kind: 'gradient', colors: 'two', color1: '#000082', color2: '#FF8200', style: 'horizontal', variant: 0 }, 'a colour list that is none of our presets: its ends');
  assert.deepEqual(await fillOf('<v:fill color2="#0B4F7C" colors="0 #0B4F7C;.5 #13A3C9;1 #9BE3F2" method="none" focus="100%" type="gradient"/>'),
    { kind: 'gradient', colors: 'preset', preset: 'ocean', style: 'horizontal', variant: 0 });
  assert.deepEqual(await fillOf('<v:fill r:id="rIdB" o:title="Plaid" color2="#ff9" type="pattern"/>', 'red', plaid), { kind: 'pattern', pattern: 'plaid', fg: '#FF0000', bg: '#FFFF99' });
  assert.deepEqual(await fillOf('<v:fill r:id="rIdB" o:title=" Dark" type="pattern"/>', 'black', plaid), { kind: 'pattern', pattern: 'plaid', fg: '#000000', bg: '#FFFFFF' }, 'the tile decides, not the title');
  const texture = await fillOf('<v:fill r:id="rIdB" o:title="Papyrus" type="tile"/>', '#fc9');
  assert.deepEqual([texture.kind, texture.texture, texture.src.slice(0, 22)], ['texture', 'papyrus', 'data:image/png;base64,']);
  const picture = await fillOf('<v:fill r:id="rIdB" o:title="photo" type="frame"/>');
  assert.deepEqual([picture.kind, picture.lockAspect, !!picture.src], ['picture', false, true]);
});
