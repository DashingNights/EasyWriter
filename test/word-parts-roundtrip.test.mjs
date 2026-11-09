// parts-roundtrip (docs/plans/word/briefs/parts-roundtrip.md): a Word file saved back keeps its theme, list definitions, latent
// styles, settings, web settings and custom XML as Word wrote them, beside the model; what the user changes (a theme colour or
// font, a list level, a style, a setting) is written from the model instead; a draft without the kept XML exports as before; and
// headers and footers keep their part names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocx } from '../src/document/docx/import.mjs';
import { exportDocx, sig } from '../src/document/docx/export.mjs';
import { readZip, text, writeZip } from '../src/document/docx/zip.mjs';
import { themeWith } from '../src/document/wp/design/model.mjs';
import { withStyle } from '../src/document/wp/styles/model.mjs';
import { patchLevels } from '../src/document/numbering.mjs';

const { kitOf } = await import('../src/editors.js');
const schema = kitOf('document').schema;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const ROOT = `${W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"`
  + ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"'
  + ' xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"'
  + ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" mc:Ignorable="w14 w15 w16cid"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const CT = 'application/vnd.openxmlformats-officedocument.';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const clr = (slot, x) => `<a:${slot}>${x}</a:${slot}>`;
const THEME = `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office">`
  + clr('dk1', '<a:sysClr val="windowText" lastClr="000000"/>') + clr('lt1', '<a:sysClr val="window" lastClr="FFFFFF"/>')
  + [['dk2', '0E2841'], ['lt2', 'E8E8E8'], ['accent1', '156082'], ['accent2', 'E97132'], ['accent3', '196B24'], ['accent4', '0F9ED5'], ['accent5', 'A02B93'],
    ['accent6', '4EA72E'], ['hlink', '467886'], ['folHlink', '96607D']].map(([s, x]) => clr(s, `<a:srgbClr val="${x}"/>`)).join('')
  + '</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display" panose="020B0004020202020204"/><a:ea typeface=""/><a:cs typeface=""/>'
  + '<a:font script="Jpan" typeface="游ゴシック Light"/><a:font script="Hang" typeface="맑은 고딕"/></a:majorFont><a:minorFont><a:latin typeface="Aptos" panose="020B0004020202020204"/>'
  + '<a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="游明朝"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst>'
  + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/></a:schemeClr></a:gs>'
  + '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst>'
  + '<a:lnStyleLst><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>'
  + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'
  + '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst><a:extraClrScheme><a:clrScheme name="Other"><a:dk1><a:srgbClr val="111111"/></a:dk1>'
  + '<a:accent1><a:srgbClr val="222222"/></a:accent1></a:clrScheme></a:extraClrScheme></a:extraClrSchemeLst><a:extLst><a:ext uri="{05A4C25C-085E-4340-85A3-A5531E510DB2}">'
  + '<thm15:themeFamily xmlns:thm15="http://schemas.microsoft.com/office/thememl/2012/main" name="Office Theme" id="{2E142A2C-CD16-42D6-873A-C26D2A0506FA}" vid="{1BDDFF52-6CD6-40A5-AB3C-68EB2F1E4D0A}"/>'
  + '</a:ext></a:extLst></a:theme>';

const lvl = (i, more = '', attrs = '') => `<w:lvl w:ilvl="${i}"${attrs}><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/>`
  + `<w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr>${more}</w:lvl>`;
const PICT = '<w:pict><v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f">'
  + '<v:stroke joinstyle="miter"/><v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype>'
  + '<v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:11.25pt;height:11.25pt" o:bullet="t"><v:imagedata r:id="rId9" o:title="dot"/></v:shape></w:pict>';
const NUMBERING = `${HEAD}<w:numbering ${ROOT}><w:numPicBullet w:numPicBulletId="0">${PICT}</w:numPicBullet>`
  + '<w:abstractNum w:abstractNumId="0" w15:restartNumberingAfterBreak="0"><w:nsid w:val="0D883E8B"/><w:multiLevelType w:val="hybridMultilevel"/><w:tmpl w:val="B3703DDE"/>'
  + lvl(0, '<w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr>', ' w:tplc="04090019"') + lvl(1, '', ' w:tplc="0409001B" w:tentative="1"') + '</w:abstractNum>'
  + '<w:abstractNum w:abstractNumId="1"><w:nsid w:val="1C285E31"/><w:multiLevelType w:val="singleLevel"/><w:tmpl w:val="A652482C"/>'
  + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:lvlPicBulletId w:val="0"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>'
  + '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl></w:abstractNum>'
  + '<w:num w:numId="1" w16cid:durableId="1220092427"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/></w:lvlOverride></w:num>'
  + '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num><w:numIdMacAtCleanup w:val="2"/></w:numbering>';
const STYLES = `${HEAD}<w:styles ${ROOT}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/>`
  + '<w:sz w:val="22"/><w:lang w:val="en-GB" w:eastAsia="zh-HK" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="278" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:latentStyles w:defLockedState="0" w:defUIPriority="99" w:defSemiHidden="0" w:defUnhideWhenUsed="0" w:defQFormat="0" w:count="376">'
  + '<w:lsdException w:name="Normal" w:uiPriority="0" w:qFormat="1"/><w:lsdException w:name="heading 1" w:uiPriority="9" w:qFormat="1"/></w:latentStyles>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + '<w:style w:type="paragraph" w:customStyle="1" w:styleId="Callout"><w:name w:val="Callout"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="auto"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:customStyle="1" w:styleId="Aside"><w:name w:val="Aside"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr></w:style>'
  + '<w:style w:type="table" w:styleId="Plain"><w:name w:val="Plain"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:left w:w="115" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
  + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style></w:styles>';
const SETTINGS = `${HEAD}<w:settings ${ROOT}><w:zoom w:percent="120"/><w:proofState w:spelling="clean" w:grammar="clean"/><w:attachedTemplate r:id="rId1"/>`
  + '<w:trackRevisions/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>'
  + '<w:compat><w:useFELayout/><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="14"/>'
  + '<w:compatSetting w:name="enableOpenTypeFeatures" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/></w:compat>'
  + '<w:rsids><w:rsidRoot w:val="00171F89"/><w:rsid w:val="00171F89"/></w:rsids><m:mathPr><m:mathFont m:val="Cambria Math"/></m:mathPr>'
  + '<w:themeFontLang w:val="en-HK" w:eastAsia="zh-CN"/><w:clrSchemeMapping w:bg1="light1" w:t1="dark1" w:bg2="light2" w:t2="dark2" w:accent1="accent1" w:accent2="accent2"'
  + ' w:accent3="accent3" w:accent4="accent4" w:accent5="accent5" w:accent6="accent6" w:hyperlink="hyperlink" w:followedHyperlink="followedHyperlink"/>'
  + '<w:decimalSymbol w:val="."/><w:listSeparator w:val=","/><w14:docId w14:val="011BFCBE"/><w15:docId w15:val="{FF177299-EE6B-4267-8D17-F90F4C35D0C4}"/></w:settings>';
const WEB = `${HEAD}<w:webSettings ${ROOT}><w:optimizeForBrowser/><w:allowPNG/></w:webSettings>`;
const FONTS = `${HEAD}<w:fonts ${ROOT}><w:font w:name="Aptos"><w:panose1 w:val="020B0004020202020204"/><w:charset w:val="00"/></w:font></w:fonts>`;
const DATA = '<order xmlns="urn:example:order"><customer>Ada</customer></order>';
const DATA_PROPS = `${HEAD}<ds:datastoreItem ds:itemID="{4A23C0D3-FAD1-4AB1-A0DC-AB7A84F93C58}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml">`
  + '<ds:schemaRefs><ds:schemaRef ds:uri="urn:example:order"/></ds:schemaRefs></ds:datastoreItem>';
const COVER = '<CoverPageProperties xmlns="http://schemas.microsoft.com/office/2006/coverPageProps"><PublishDate>2026-10-29T00:00:00</PublishDate><Abstract>Short</Abstract>'
  + '<CompanyAddress/><CompanyPhone/><CompanyFax/><CompanyEmail>office@example.com</CompanyEmail></CoverPageProperties>';
const rels = (list) => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target, mode]) =>
  `<Relationship Id="${id}" Type="${REL}${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('')}</Relationships>`;
const P = (t, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:r><w:t>${t}</w:t></w:r></w:p>`;
const BODY = P('One', '<w:pStyle w:val="Callout"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') + P('Dot', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>')
  + P('Aside', '<w:pStyle w:val="Aside"/>');

/** A Word-made package with every part this package keeps. */
const wordFile = () => writeZip([
  ['[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="${CT.replace('officedocument.', 'package.')}relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="${CT}wordprocessingml.document.main+xml"/>`
    + `<Override PartName="/customXml/itemProps1.xml" ContentType="${CT}customXmlProperties+xml"/><Override PartName="/word/webSettings.xml" ContentType="${CT}wordprocessingml.webSettings+xml"/>`
    + `<Override PartName="/word/fontTable.xml" ContentType="${CT}wordprocessingml.fontTable+xml"/></Types>`],
  ['word/document.xml', `${HEAD}<w:document ${ROOT}><w:body>${BODY}<w:sectPr/></w:body></w:document>`],
  ['word/_rels/document.xml.rels', rels([['rId1', 'styles', 'styles.xml'], ['rId2', 'numbering', 'numbering.xml'], ['rId3', 'settings', 'settings.xml'], ['rId4', 'theme', 'theme/theme1.xml'],
    ['rId5', 'webSettings', 'webSettings.xml'], ['rId6', 'fontTable', 'fontTable.xml'], ['rId7', 'customXml', '../customXml/item1.xml'], ['rId8', 'customXml', '../customXml/item2.xml']])],
  ['word/styles.xml', STYLES], ['word/numbering.xml', NUMBERING], ['word/settings.xml', SETTINGS], ['word/theme/theme1.xml', THEME],
  ['word/_rels/numbering.xml.rels', rels([['rId9', 'image', 'media/dot.png']])], ['word/media/dot.png', PNG],
  ['word/_rels/settings.xml.rels', rels([['rId1', 'attachedTemplate', 'file:///C:/Templates/Report.dotm', 'External']])],
  ['word/webSettings.xml', WEB], ['word/fontTable.xml', FONTS],
  ['customXml/item1.xml', DATA], ['customXml/itemProps1.xml', DATA_PROPS], ['customXml/_rels/item1.xml.rels', rels([['rId1', 'customXmlProps', 'itemProps1.xml']])],
  ['customXml/item2.xml', COVER],
]);

/** Imports `bytes`, passes the doc through the editor's schema (as opening it does), lets `change` edit it, exports → {doc, files}. */
async function roundTrip(bytes, change = (d) => d) {
  const { doc: raw } = await importDocx(await bytes);
  const node = schema.nodeFromJSON(raw);
  node.check();
  const doc = change(JSON.parse(JSON.stringify(node.toJSON())));
  const files = await readZip((await exportDocx(doc, { picture: async () => null })).bytes);
  return { doc, files, part: (name) => text(files.get(name)) };
}
const withAttrs = (doc, patch) => ({ ...doc, attrs: { ...doc.attrs, ...patch } });

test('sig ignores key order and null keys, and tells values apart', () => {
  assert.equal(sig({ a: 1, b: { c: [1, 2], d: null } }), sig({ b: { c: [1, 2] }, a: 1 }));
  assert.notEqual(sig({ a: 1 }), sig({ a: 2 }));
  assert.notEqual(sig({ a: [1, 2] }), sig({ a: [2, 1] }));
});

test('a Word file saved unchanged keeps its theme, lists, latent styles, settings, web settings, font table and custom XML', async () => {
  const { doc, files, part } = await roundTrip(wordFile());
  assert.equal(part('word/theme/theme1.xml'), THEME, 'the whole theme comes back');
  const num = part('word/numbering.xml');
  for (const x of ['<w:abstractNum w:abstractNumId="0" w15:restartNumberingAfterBreak="0"><w:nsid w:val="0D883E8B"/><w:multiLevelType w:val="hybridMultilevel"/><w:tmpl w:val="B3703DDE"/>',
    lvl(0, '<w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr>', ' w:tplc="04090019"'), lvl(1, '', ' w:tplc="0409001B" w:tentative="1"'), '<w:multiLevelType w:val="singleLevel"/>',
    '<w:num w:numId="1" w16cid:durableId="1220092427"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/></w:lvlOverride></w:num>',
    '<w:numIdMacAtCleanup w:val="2"/></w:numbering>', '<v:shapetype id="_x0000_t75"', 'style="width:11.25pt;height:11.25pt" o:bullet="t"><v:imagedata r:id="rId1" o:title="dot"/>',
    '<w:lvlPicBulletId w:val="0"/>']) assert.ok(num.includes(x), x);
  assert.match(num, /^<\?xml[^>]*>\s*<w:numbering [^>]*xmlns:w15="[^"]+"[^>]*xmlns:w16cid="[^"]+"[^>]* mc:Ignorable="w14 w15 w16cid"/, 'the prefixes the kept XML uses stay declared');
  assert.equal(text(files.get('word/_rels/numbering.xml.rels')).match(/Target="media\/\w+\.png"/g)?.length, 1);
  const st = part('word/styles.xml');
  for (const x of ['<w:latentStyles w:defLockedState="0" w:defUIPriority="99"', '<w:lsdException w:name="heading 1" w:uiPriority="9" w:qFormat="1"/>',
    '<w:lang w:val="en-GB" w:eastAsia="zh-HK" w:bidi="ar-SA"/>', '<w:style w:type="paragraph" w:customStyle="1" w:styleId="Callout">', '<w:color w:val="auto"/>',
    '<w:tblInd w:w="0" w:type="dxa"/>', '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/>'])
    assert.ok(st.includes(x), x);
  assert.equal(st.match(/w:styleId="DefaultParagraphFont"/g).length, 1, 'the reference styles once');
  const set = part('word/settings.xml');
  const order = [...set.matchAll(/<(w:\w+|m:\w+|w1\d:\w+)\b/g)].map((m) => m[1]).filter((n) => !/^w:(settings|compatSetting|useFELayout|rsid|rsidRoot)$|^m:mathFont$/.test(n));
  assert.deepEqual(order, ['w:zoom', 'w:attachedTemplate', 'w:trackRevisions', 'w:defaultTabStop', 'w:hyphenationZone', 'w:characterSpacingControl', 'w:compat', 'w:rsids',
    'm:mathPr', 'w:themeFontLang', 'w:clrSchemeMapping', 'w:decimalSymbol', 'w:listSeparator', 'w14:docId', 'w15:docId'], "CT_Settings' order, the proofing state left out");
  assert.ok(set.includes('<w:compat><w:useFELayout/><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="14"/>'), "Word 2010's mode stays");
  assert.match(text(files.get('word/_rels/settings.xml.rels')), /Id="rId1" Type="[^"]*attachedTemplate" Target="file:\/\/\/C:\/Templates\/Report.dotm" TargetMode="External"/);
  assert.equal(part('word/webSettings.xml'), WEB);
  assert.equal(part('word/fontTable.xml'), FONTS);
  assert.equal(part('customXml/item1.xml'), DATA);
  assert.equal(part('customXml/itemProps1.xml'), DATA_PROPS);
  const ct = part('[Content_Types].xml');
  for (const p of ['/word/webSettings.xml', '/word/fontTable.xml', '/customXml/itemProps1.xml', '/customXml/itemProps2.xml']) assert.ok(ct.includes(`PartName="${p}"`), p);
  const docRels = part('word/_rels/document.xml.rels');
  for (const t of ['webSettings" Target="webSettings.xml"', 'fontTable" Target="fontTable.xml"', 'customXml" Target="../customXml/item1.xml"', 'customXml" Target="../customXml/item2.xml"'])
    assert.ok(docRels.includes(t), t);
  // The cover page's properties are the model's (the Document Property controls show them) and go back in Word's own part.
  assert.deepEqual(doc.attrs.props.cover, { publishDate: '2026-10-29T00:00:00', abstract: 'Short', email: 'office@example.com' });
  assert.match(part('customXml/item2.xml'), /<CoverPageProperties xmlns="http:\/\/schemas.microsoft.com\/office\/2006\/coverPageProps"><PublishDate>2026-10-29T00:00:00<\/PublishDate><Abstract>Short<\/Abstract><CompanyAddress\/>/);
  assert.match(part('customXml/itemProps2.xml'), /ds:itemID="\{55AF091B-3C7A-41E3-B477-F2FDAA23CFDA\}"/);
});

test('what the user changes wins over the kept XML: a theme colour and font, a list level, a style, a setting, a cover property', async () => {
  const { doc, part } = await roundTrip(wordFile(), (d) => {
    const theme = themeWith(d.attrs.theme, { colors: { accent1: '#FF0000' }, fonts: { major: 'Georgia' } });
    const numbering = patchLevels(d.attrs.numbering, '1', (levels) => levels.map((l, i) => (i ? l : { ...l, left: 54 })));
    const styles = withStyle(d.attrs.styles, 'Callout', { run: { bold: true } });
    const settings = { ...d.attrs.settings, trackRevisions: false, compat: { ...d.attrs.settings.compat, htmlAutoSpacing: false } };
    return withAttrs(d, { theme, numbering, styles, settings, props: { ...d.attrs.props, cover: { ...d.attrs.props.cover, abstract: 'Longer' } } });
  });
  const th = part('word/theme/theme1.xml');
  assert.ok(th.includes('<a:accent1><a:srgbClr val="FF0000"/></a:accent1>') && th.includes('<a:latin typeface="Georgia"/>'), 'Design wins');
  for (const x of ['<a:accent2><a:srgbClr val="E97132"/></a:accent2>', '<a:font script="Jpan" typeface="游ゴシック Light"/>', '<a:latin typeface="Aptos" panose="020B0004020202020204"/>',
    '<a:gradFill rotWithShape="1">', '<a:accent1><a:srgbClr val="222222"/></a:accent1>', '<thm15:themeFamily']) assert.ok(th.includes(x), `kept: ${x}`);
  const num = part('word/numbering.xml');
  const custom = doc.attrs.numbering.nums['1'].abstract;
  assert.notEqual(custom, '0', 'the edited list has a definition of its own');
  assert.match(num, new RegExp(`<w:abstractNum w:abstractNumId="\\d+"><w:multiLevelType w:val="hybridMultilevel"/>(<w:name [^>]*/>)?<w:lvl w:ilvl="0"><w:start w:val="1"/>.*?<w:ind w:left="1080" w:hanging="360"/>`),
    'the edited level is written from the model');
  assert.ok(num.includes('<w:num w:numId="1"><w:abstractNumId'), 'its num too');
  assert.ok(num.includes('<w:nsid w:val="0D883E8B"/>') && num.includes(lvl(1, '', ' w:tplc="0409001B" w:tentative="1"')), 'the definition no edit touched stays');
  const st = part('word/styles.xml');
  assert.match(st, /<w:style w:type="paragraph" w:styleId="Callout"><w:name w:val="Callout"\/><w:basedOn w:val="Normal"\/>.*?<w:b\/>/, 'the modified style is written from the model');
  assert.ok(st.includes('<w:style w:type="paragraph" w:customStyle="1" w:styleId="Aside">') && st.includes('<w:latentStyles'), 'the others stay');
  const set = part('word/settings.xml');
  assert.ok(!set.includes('<w:trackRevisions/>') && set.includes('<w:zoom w:percent="120"/>'), 'a setting the user turned off stays off');
  assert.ok(set.includes('<w:compat><w:doNotUseHTMLParagraphAutoSpacing/><w:useFELayout/><w:compatSetting w:name="compatibilityMode"'), 'a compatibility option goes in its place');
  assert.match(part('customXml/item2.xml'), /<Abstract>Longer<\/Abstract>/);
});

test('a draft without the kept XML (an old draft, a new Document) exports as before', async () => {
  const { doc } = await importDocx(await wordFile());
  const strip = ({ kept, ...rest }) => rest;
  const { parts, ...settings } = strip(doc.attrs.settings);
  const old = withAttrs(doc, { theme: strip(doc.attrs.theme), styles: strip(doc.attrs.styles), numbering: strip(doc.attrs.numbering), settings });
  assert.doesNotThrow(() => schema.nodeFromJSON(old).check());
  const files = await readZip((await exportDocx(old)).bytes);
  assert.match(text(files.get('word/theme/theme1.xml')), /<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"\/><\/a:solidFill>/, 'the plain format scheme');
  assert.match(text(files.get('word/numbering.xml')), /<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"\/><w:lvl w:ilvl="0">/);
  assert.ok(text(files.get('word/settings.xml')).includes('w:val="15"/></w:compat>'));
  assert.ok(!files.has('word/webSettings.xml') && ![...files.values()].some((b) => text(b)?.includes('urn:example:order')), 'no kept parts');
});

test("headers and footers take Word's part names: even, default, then first, per section", async () => {
  const hf = (t) => [{ type: 'paragraph', content: [{ type: 'text', text: t }] }];
  const sect = { hdr: { default: hf('HD'), first: hf('HF'), even: hf('HE') }, ftr: { default: hf('FD'), first: hf('FF'), even: hf('FE') }, titlePg: true };
  const doc = { type: 'doc', attrs: { sect, settings: { evenAndOddHeaders: true } }, content: [{ type: 'paragraph' }] };
  const files = await readZip((await exportDocx(doc)).bytes);
  assert.deepEqual([1, 2, 3].map((n) => /<w:t[^>]*>(\w+)</.exec(text(files.get(`word/header${n}.xml`)))[1]), ['HE', 'HD', 'HF']);
  assert.deepEqual([1, 2, 3].map((n) => /<w:t[^>]*>(\w+)</.exec(text(files.get(`word/footer${n}.xml`)))[1]), ['FE', 'FD', 'FF']);
});
