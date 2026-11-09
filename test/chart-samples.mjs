// Sample .docx files with charts (docs/plans/word/left-out.md package 4): the owner's files hold none, so these are written from
// XML strings in the form Word 2016 and later writes them (the cached data complete: c:f, c:strCache and c:numCache with
// ptCount and formatCode, series colours as theme accents, the embedded workbook in word/embeddings). Shared by
// test/chart.test.mjs and the harness case .smoke-data/word/cases/docx-charts.js. Not a test file itself (npm test runs *.test.*).

const NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const GREY = '<a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill>';
const TEXT = (sz, rot = 0) => `<c:txPr><a:bodyPr rot="${rot}" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="0" i="0" u="none" strike="noStrike" kern="1200" baseline="0"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
const col = (i) => String.fromCharCode(66 + i); // B, C, D for the series columns

const strCache = (f, list) => `<c:strRef><c:f>${f}</c:f><c:strCache><c:ptCount val="${list.length}"/>${list.map((s, i) => `<c:pt idx="${i}"><c:v>${s}</c:v></c:pt>`).join('')}</c:strCache></c:strRef>`;
const numCache = (f, list, fmt = 'General') => `<c:numRef><c:f>${f}</c:f><c:numCache><c:formatCode>${fmt}</c:formatCode><c:ptCount val="${list.length}"/>${list.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache></c:numRef>`;
const title = (text) => `<c:title>${text == null ? '' : `<c:tx><c:rich><a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="0" i="0" u="none" strike="noStrike" kern="1200" spc="0" baseline="0"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill></a:defRPr></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></c:rich></c:tx>`}<c:overlay val="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>${TEXT(1400)}</c:title>`;
const legend = (pos) => `<c:legend><c:legendPos val="${pos}"/><c:overlay val="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>${TEXT(900)}</c:legend>`;
const axes = (cat, val, { catPos = 'b', valPos = 'l', between = 'between' } = {}) => `<c:catAx><c:axId val="${cat}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${catPos}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:noFill/><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">${GREY}<a:round/></a:ln><a:effectLst/></c:spPr>${TEXT(900, -60000000)}<c:crossAx val="${val}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
  + `<c:valAx><c:axId val="${val}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${valPos}"/><c:majorGridlines><c:spPr><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">${GREY}<a:round/></a:ln><a:effectLst/></c:spPr></c:majorGridlines><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>${TEXT(900, -60000000)}<c:crossAx val="${cat}"/><c:crosses val="autoZero"/><c:crossBetween val="${between}"/></c:valAx>`;
const space = (inner, rid) => `${HEAD}<c:chartSpace ${NS}><c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart>${inner}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>`
  + `<c:spPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">${GREY}<a:round/></a:ln><a:effectLst/></c:spPr>`
  + `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr><c:externalData r:id="${rid}"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;
const n = (cats) => cats.length + 1;

/** The data of the three samples: categories, and series {name, vals}. */
export const DATA = {
  column: { title: 'Sales by region', cats: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'North', vals: [4.3, 2.5, 3.5, 4.5] }, { name: 'South', vals: [2.4, 4.4, 1.8, 2.8] }, { name: 'West', vals: [2, 2, 3, 5] }] },
  line: { title: 'Visitors', cats: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ name: 'Web', vals: [120, 135, 160, 150, 190, 210] }, { name: 'Shop', vals: [80, 95, 90, 110, 105, 130] }] },
  pie: { title: null, cats: ['Rent', 'Food', 'Travel', 'Other'], series: [{ name: 'Budget', vals: [45, 25, 18, 12] }] },
};

const seriesXml = (d, i, extra) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx>${strCache(`Sheet1!$${col(i)}$1`, [d.series[i].name])}</c:tx>${extra}`
  + `<c:cat>${strCache(`Sheet1!$A$2:$A$${n(d.cats)}`, d.cats)}</c:cat><c:val>${numCache(`Sheet1!$${col(i)}$2:$${col(i)}$${n(d.cats)}`, d.series[i].vals)}</c:val>`;

/** The chart parts (c:chartSpace XML) of the samples, each with its workbook relationship `rId1`. */
export const CHARTS = {
  // Word's Clustered Column: gap width 219, overlap -27, legend at the bottom.
  column: space(`${title(DATA.column.title)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>`
    + DATA.column.series.map((_, i) => `${seriesXml(DATA.column, i, `<c:spPr><a:solidFill><a:schemeClr val="accent${i + 1}"/></a:solidFill><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr><c:invertIfNegative val="0"/>`)}</c:ser>`).join('')
    + `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls><c:gapWidth val="219"/><c:overlap val="-27"/><c:axId val="501"/><c:axId val="502"/></c:barChart>`
    + `${axes(501, 502)}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr></c:plotArea>${legend('b')}`, 'rId1'),
  // Word's Line with Markers.
  line: space(`${title(DATA.line.title)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>`
    + DATA.line.series.map((_, i) => `${seriesXml(DATA.line, i, `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:schemeClr val="accent${i + 1}"/></a:solidFill><a:round/></a:ln><a:effectLst/></c:spPr>`
      + `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:schemeClr val="accent${i + 1}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:schemeClr val="accent${i + 1}"/></a:solidFill></a:ln><a:effectLst/></c:spPr></c:marker>`)}<c:smooth val="0"/></c:ser>`).join('')
    + `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls><c:marker val="1"/><c:smooth val="0"/><c:axId val="601"/><c:axId val="602"/></c:lineChart>`
    + `${axes(601, 602)}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr></c:plotArea>${legend('r')}`, 'rId1'),
  // Word's Pie: no title text (the single series names it), each point's colour in c:dPt, percentages shown.
  pie: space(`${title(null)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:pieChart><c:varyColors val="1"/>${seriesXml(DATA.pie, 0, DATA.pie.cats.map((_, k) => `<c:dPt><c:idx val="${k}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:schemeClr val="accent${k + 1}"/></a:solidFill><a:ln w="19050"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln><a:effectLst/></c:spPr></c:dPt>`).join(''))}</c:ser>`
    + `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls><c:firstSliceAng val="0"/></c:pieChart>`
    + `<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr></c:plotArea>${legend('b')}`, 'rId1'),
};

// ---------- the embedded workbooks ----------
const XL = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELS = (list) => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list}</Relationships>`;
const cell = (ref, v) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v ?? ''}</t></is></c>`);
/** The workbook of sample `d` (Sheet1: categories in A, one series per column) → its parts for writeZip. */
const workbook = (d) => {
  const rows = [['', ...d.series.map((s) => s.name)], ...d.cats.map((c, k) => [c, ...d.series.map((s) => s.vals[k])])];
  const sheet = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(`${String.fromCharCode(65 + j)}${i + 1}`, v)).join('')}</row>`).join('');
  return [
    ['[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', RELS('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>')],
    ['xl/workbook.xml', `${HEAD}<workbook xmlns="${XL}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', RELS('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>')],
    ['xl/worksheets/sheet1.xml', `${HEAD}<worksheet xmlns="${XL}"><sheetData>${sheet}</sheetData></worksheet>`],
  ];
};

// ---------- the document ----------
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const EMU = 12700; // per pt
const graphic = (rid) => `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic>`;
const inline = (id, rid, w, h) => `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${w * EMU}" cy="${h * EMU}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Chart ${id}"/><wp:cNvGraphicFramePr/>${graphic(rid)}</wp:inline></w:drawing></w:r>`;
const anchor = (id, rid, w, h, x) => `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">`
  + `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>${x * EMU}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>`
  + `<wp:extent cx="${w * EMU}" cy="${h * EMU}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="${id}" name="Chart ${id}" descr="Visitors by month"/><wp:cNvGraphicFramePr/>${graphic(rid)}</wp:anchor></w:drawing></w:r>`;
const P = (inner) => `<w:p>${inner}</w:p>`;
const R = (s) => `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`;
const FILL = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
// A whole theme part, as Word refuses a file whose theme has no format scheme.
const THEME = `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office">`
  + [['dk1', 'sysClr val="windowText" lastClr="000000"'], ['lt1', 'sysClr val="window" lastClr="FFFFFF"'], ['dk2', 'srgbClr val="44546A"'], ['lt2', 'srgbClr val="E7E6E6"'],
    ['accent1', 'srgbClr val="4472C4"'], ['accent2', 'srgbClr val="ED7D31"'], ['accent3', 'srgbClr val="A5A5A5"'], ['accent4', 'srgbClr val="FFC000"'], ['accent5', 'srgbClr val="5B9BD5"'],
    ['accent6', 'srgbClr val="70AD47"'], ['hlink', 'srgbClr val="0563C1"'], ['folHlink', 'srgbClr val="954F72"']].map(([k, c]) => `<a:${k}><a:${c}/></a:${k}>`).join('')
  + '</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
  + `<a:fmtScheme name="Office"><a:fillStyleLst>${FILL.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}">${FILL}</a:ln>`).join('')}</a:lnStyleLst>`
  + `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${FILL.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
const DOC = `${HEAD}<w:document ${W}><w:body>`
  + P(R('A clustered column chart:')) + P(inline(1, 'rId11', 432, 252))
  + P(`${anchor(2, 'rId12', 288, 216, 200)}${R('A line chart floats to the right of this paragraph, square wrapped. ')}${R('The text runs beside it. '.repeat(12))}`)
  + P(R('A pie chart:')) + P(inline(3, 'rId13', 324, 216))
  + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const TYPES = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
  + '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
  + [1, 2, 3].map((k) => `<Override PartName="/word/charts/chart${k}.xml" ContentType="${CT_CHART}"/>`).join('') + '</Types>';
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

/** The sample .docx (a clustered column chart inline, a line chart floating, a pie chart inline, each with its workbook) →
 * {bytes, parts: Map of every chart part and workbook by name}. `writeZip` is zip.mjs's. */
export async function chartDocx(writeZip) {
  const enc = new TextEncoder();
  const names = ['column', 'line', 'pie'];
  const books = await Promise.all(names.map((k) => writeZip(workbook(DATA[k]))));
  const parts = new Map();
  names.forEach((k, i) => {
    parts.set(`word/charts/chart${i + 1}.xml`, enc.encode(CHARTS[k]));
    parts.set(`word/charts/_rels/chart${i + 1}.xml.rels`, enc.encode(RELS(`<Relationship Id="rId1" Type="${RT}package" Target="../embeddings/Microsoft_Excel_Worksheet${i}.xlsx"/>`)));
    parts.set(`word/embeddings/Microsoft_Excel_Worksheet${i}.xlsx`, books[i]);
  });
  const bytes = await writeZip([
    ['[Content_Types].xml', enc.encode(TYPES)],
    ['_rels/.rels', enc.encode(RELS(`<Relationship Id="rId1" Type="${RT}officeDocument" Target="word/document.xml"/>`))],
    ['word/document.xml', enc.encode(DOC)],
    ['word/_rels/document.xml.rels', enc.encode(RELS(`<Relationship Id="rId1" Type="${RT}theme" Target="theme/theme1.xml"/>`
      + names.map((_, i) => `<Relationship Id="rId${11 + i}" Type="${RT}chart" Target="charts/chart${i + 1}.xml"/>`).join('')))],
    ['word/theme/theme1.xml', enc.encode(THEME)],
    ...parts,
  ]);
  return { bytes, parts };
}
