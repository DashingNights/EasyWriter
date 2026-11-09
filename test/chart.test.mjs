import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../src/document/docx/import.mjs';
import { autoColor, chartModel } from '../src/document/chart/model.mjs';
import { chartSvg, fmtNum, niceScale } from '../src/document/chart/svg.mjs';
import { CHARTS, DATA, chartDocx } from './chart-samples.mjs';

// Charts in Word files (docs/plans/word/left-out.md package 4): the model from a chart part, and the SVG drawn from the model.
const THEME = { colors: { accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5', accent4: '#FFC000', accent5: '#5B9BD5', accent6: '#70AD47', lt1: '#FFFFFF', dk1: '#000000' },
  fonts: { minor: 'Calibri' } };
const model = (xml, theme = THEME) => chartModel(parseXml(xml), theme);
const count = (svg, attr) => (svg.match(new RegExp(`\\s${attr}="`, 'g')) ?? []).length;
const C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const ser = (i, vals, extra = '') => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${extra}<c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>`
  + `${vals.map((v, k) => (v == null ? '' : `<c:pt idx="${k}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numLit></c:val></c:ser>`;
const space = (plot) => `<c:chartSpace ${C}><c:chart><c:plotArea>${plot}</c:plotArea><c:legend><c:legendPos val="r"/></c:legend></c:chart></c:chartSpace>`;

test('chart model: the samples read as Word draws them (type, grouping, series, theme colours, categories, title, legend)', () => {
  const col = model(CHARTS.column);
  assert.equal(col.other, null);
  assert.deepEqual(col.title, { text: 'Sales by region', size: 14 });
  assert.equal(col.legend.pos, 'b');
  assert.deepEqual(col.cats, DATA.column.cats);
  const [bar] = col.plots;
  assert.deepEqual([bar.type, bar.dir, bar.grouping, bar.gap, bar.overlap], ['bar', 'col', 'clustered', 219, -27]);
  assert.deepEqual(bar.series.map((s) => [s.name, s.color, s.vals]), DATA.column.series.map((s, i) => [s.name, THEME.colors[`accent${i + 1}`], s.vals]));
  assert.ok(col.y.grid && !col.x.grid, 'value gridlines only');

  const line = model(CHARTS.line);
  assert.equal(line.legend.pos, 'r');
  assert.ok(line.plots[0].series.every((s) => s.marker?.symbol === 'circle' && s.line?.width === 2.25));

  // A c:title without text on a one-series chart shows the series name; a pie varies its colours by point.
  const pie = model(CHARTS.pie);
  assert.equal(pie.title.text, 'Budget');
  assert.deepEqual(pie.plots[0].series[0].colors, ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000']);
  assert.equal(pie.plots[0].series[0].labels.pct, true);
});

test('chart model: literal data with gaps, srgbClr and automatic colours, stacked bars, and the rounds past six series', () => {
  const m = model(space(`<c:barChart><c:barDir val="bar"/><c:grouping val="percentStacked"/>${ser(0, [1, null, 3], '<c:spPr><a:solidFill><a:srgbClr val="ff0000"/></a:solidFill></c:spPr>')}`
    + `${[1, 2, 3, 4, 5, 6, 7].map((i) => ser(i, [i, i, i])).join('')}<c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/></c:catAx><c:valAx><c:axId val="2"/></c:valAx>`));
  const [p] = m.plots;
  assert.deepEqual([p.dir, p.grouping, p.overlap], ['bar', 'percentStacked', 100]);
  assert.deepEqual(p.series[0].vals, [1, null, 3]);
  assert.equal(p.series[0].color, '#FF0000');
  assert.equal(p.series[1].color, THEME.colors.accent2, 'no spPr: the accent of its place');
  assert.equal(p.series[6].color, autoColor(6, THEME.colors));
  assert.notEqual(autoColor(6, THEME.colors), THEME.colors.accent1, 'the seventh is accent 1 again, darker');
  assert.equal(p.series[0].name, 'Series 1');
  assert.equal(m.title, null, 'many series and no c:title: no title');
});

test('chart model: a colour that is not hex is refused, and radar and chartex charts keep their title', () => {
  const bad = model(space(`<c:lineChart>${ser(0, [1, 2], '<c:spPr><a:ln><a:solidFill><a:srgbClr val="&quot;/&gt;&lt;script&gt;"/></a:solidFill></a:ln></c:spPr>')}</c:lineChart>`));
  assert.equal(bad.plots[0].series[0].color, THEME.colors.accent1);
  const radar = model(`<c:chartSpace ${C}><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Skills</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:radarChart>${ser(0, [1, 2, 3])}</c:radarChart></c:plotArea></c:chart></c:chartSpace>`);
  assert.deepEqual([radar.other, radar.title.text, radar.plots[0].type], [null, 'Skills', 'radar']);
  const cx = chartModel(parseXml('<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart><cx:title><cx:tx><cx:txData><cx:v>Flow</cx:v></cx:txData></cx:tx></cx:title><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="waterfall"/></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>'), THEME);
  assert.deepEqual([cx.other, cx.title.text, cx.plots[0].type], [null, 'Flow', 'bar']);
});

test('chart svg: the samples draw their bars, points, slices and legends', () => {
  const col = chartSvg(model(CHARTS.column), 432, 252);
  assert.equal(count(col, 'data-bar'), 12, 'three series of four bars');
  assert.equal(count(col, 'data-legend'), 3);
  assert.match(col, /viewBox="0 0 432 252"/);
  assert.match(col, />Sales by region</);
  const line = chartSvg(model(CHARTS.line), 288, 216);
  assert.equal(count(line, 'data-point'), 12, 'two series of six markers');
  assert.equal(count(line, 'data-legend'), 2);
  const pie = chartSvg(model(CHARTS.pie), 324, 216);
  assert.equal(count(pie, 'data-slice'), 4);
  assert.equal(count(pie, 'data-legend'), 4, 'a pie lists its categories');
  assert.match(pie, />45%</);
  // The value axis: 0 to 6 in steps of 1 for data up to 5.
  assert.match(col, />6<\/text>/);
  assert.doesNotMatch(col, />7<\/text>/);
});

test('chart svg: text from the file is escaped, and a type it does not draw is a framed box with its title and type', () => {
  const m = model(space(`<c:barChart><c:barDir val="col"/>${ser(0, [1], '<c:tx><c:v>&lt;img src=x onerror=alert(1)&gt;</c:v></c:tx>')}</c:barChart>`));
  const svg = chartSvg(m, 200, 100);
  assert.doesNotMatch(svg, /<img/);
  assert.match(svg, /&lt;img src=x/);
  const radar = chartSvg({ other: 'Radar', title: { text: 'Skills', size: 14 }, plots: [] }, 200, 120);
  assert.match(radar, />Skills</);
  assert.match(radar, /data-other="">Radar chart</);
});

test('chart svg: Excel\'s auto scale and number formats', () => {
  assert.deepEqual(niceScale(1.8, 5), { min: 0, max: 6, unit: 1 });
  assert.deepEqual(niceScale(80, 210), { min: 0, max: 250, unit: 50 });
  assert.deepEqual(niceScale(-3, 4), { min: -4, max: 5, unit: 1 });
  assert.deepEqual(niceScale(0, 1, { max: 1, unit: 0.25 }), { min: 0, max: 1, unit: 0.25 });
  assert.deepEqual([fmtNum(0.5, 'General', 0.5), fmtNum(1234.5, '#,##0.00'), fmtNum(0.25, '0%'), fmtNum(12, '"$"#,##0'), fmtNum(45292, 'mmm-yy')],
    ['0.5', '1,234.50', '25%', '$12', 'Jan-24']);
});

test('docx import: each chart becomes a chart node of its extent, inline or floating, holding its model and parts; nothing is left out', async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const { writeZip } = await import('../src/document/docx/zip.mjs');
  const { bytes, parts } = await chartDocx(writeZip);
  const { doc, dropped } = await importDocx(bytes);
  assert.deepEqual(dropped, []);
  const charts = [];
  const walk = (n) => { if (n.type === 'chart') charts.push(n.attrs); (n.content ?? []).forEach(walk); };
  walk(doc);
  assert.deepEqual(charts.map((a) => [a.w, a.h, a.layout?.wrap ?? null, a.name]), [[432, 252, null, 'Chart 1'], [288, 216, 'square', 'Chart 2'], [324, 216, null, 'Chart 3']]);
  assert.equal(charts[1].alt, 'Visitors by month');
  assert.deepEqual(charts.map((a) => a.model.plots[0].type), ['bar', 'line', 'pie']);
  assert.deepEqual(charts[0].parts.list.map((p) => [p.name, p.type]), [
    ['word/charts/chart1.xml', 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'], ['word/charts/_rels/chart1.xml.rels', null],
    ['word/embeddings/Microsoft_Excel_Worksheet0.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]);
  for (const p of charts.flatMap((a) => a.parts.list)) assert.deepEqual(Buffer.from(p.data, 'base64'), Buffer.from(parts.get(p.name)), p.name);
});

test('docx round trip: export writes every chart part back byte for byte with its content type and relationship, and the file reads back the same', async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const { exportDocx } = await import('../src/document/docx/export.mjs');
  const { readZip, text, writeZip } = await import('../src/document/docx/zip.mjs');
  const { bytes, parts } = await chartDocx(writeZip);
  const first = await importDocx(bytes);
  const out = await exportDocx(first.doc);
  assert.deepEqual(out.dropped, []);
  const files = await readZip(out.bytes);
  for (const [name, data] of parts) assert.deepEqual(Buffer.from(files.get(name) ?? []), Buffer.from(data), name);
  const ct = text(files.get('[Content_Types].xml'));
  for (const k of [1, 2, 3]) assert.match(ct, new RegExp(`PartName="/word/charts/chart${k}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart[+]xml"`));
  assert.match(ct, /PartName="\/word\/embeddings\/Microsoft_Excel_Worksheet0.xlsx" ContentType="application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/);
  const rels = text(files.get('word/_rels/document.xml.rels'));
  const doc = text(files.get('word/document.xml'));
  for (const k of [1, 2, 3]) {
    const id = new RegExp(`Id="(rId[0-9]+)" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart${k}.xml"`).exec(rels)?.[1];
    assert.ok(id && doc.includes(`<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${id}"/>`), `chart${k} is drawn through its relationship`);
  }
  assert.match(doc, /<wp:anchor[^>]*>.*<wp:wrapSquare wrapText="bothSides"\/>.*<wp:docPr id="\d+" name="Chart 2" descr="Visitors by month"\/>/);
  const again = await importDocx(out.bytes);
  const charts = (d) => { const o = []; const walk = (n) => { if (n.type === 'chart') o.push(n.attrs); (n.content ?? []).forEach(walk); }; walk(d); return o; };
  assert.deepEqual(charts(again.doc), charts(first.doc));
  assert.deepEqual(again.dropped, []);
});

test('docx export: the same chart twice gets a second set of parts and relationships; a node whose parts are not a chart\'s is left out', async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const { exportDocx } = await import('../src/document/docx/export.mjs');
  const { readZip, text, writeZip } = await import('../src/document/docx/zip.mjs');
  const { doc } = await importDocx((await chartDocx(writeZip)).bytes);
  const chart = doc.content.find((b) => b.content?.some((n) => n.type === 'chart')).content.find((n) => n.type === 'chart');
  const bad = { type: 'chart', attrs: { ...chart.attrs, parts: { ...chart.attrs.parts, list: chart.attrs.parts.list.map((p) => ({ ...p, name: p.name.replace('word/charts/', 'word/../') })) } } };
  const out = await exportDocx({ ...doc, content: [{ type: 'paragraph', content: [chart, chart, bad] }] });
  assert.deepEqual(out.dropped, ['charts']);
  const files = await readZip(out.bytes);
  assert.ok(files.has('word/charts/chart1.xml') && files.has('word/charts/chart1_2.xml'));
  assert.equal(text(files.get('word/charts/_rels/chart1_2.xml.rels')).match(/Target="([^"]+)"/)[1], '../embeddings/Microsoft_Excel_Worksheet0_2.xlsx');
  assert.deepEqual(Buffer.from(files.get('word/embeddings/Microsoft_Excel_Worksheet0_2.xlsx')), Buffer.from(files.get('word/embeddings/Microsoft_Excel_Worksheet0.xlsx')));
  assert.match(text(files.get('word/_rels/document.xml.rels')), /Target="charts\/chart1_2.xml"/);
  assert.ok(![...files.keys()].some((k) => k.includes('..')));
});

test('docx round trip: a chartex chart (a waterfall) shows with its title and goes back inside mc:AlternateContent', async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const { exportDocx } = await import('../src/document/docx/export.mjs');
  const { readZip, text } = await import('../src/document/docx/zip.mjs');
  const xml = '<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart><cx:title><cx:tx><cx:txData><cx:v>Cash flow</cx:v></cx:txData></cx:tx></cx:title><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="waterfall"/></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>';
  const data = Buffer.from(xml).toString('base64');
  const node = { type: 'chart', attrs: { w: 300, h: 200, model: null, parts: { kind: 'cx', main: 'word/charts/chartEx1.xml', list: [{ name: 'word/charts/chartEx1.xml', type: 'application/vnd.ms-office.chartex+xml', data }] } } };
  const out = await exportDocx({ type: 'doc', attrs: {}, content: [{ type: 'paragraph', content: [node] }] });
  const files = await readZip(out.bytes);
  assert.match(text(files.get('word/document.xml')), /<w:r><mc:AlternateContent [^>]*><mc:Choice [^>]*Requires="cx"><w:drawing>.*<cx:chart [^>]*r:id="rId\d+"\/>/);
  assert.match(text(files.get('word/_rels/document.xml.rels')), /Type="http:\/\/schemas.microsoft.com\/office\/2014\/relationships\/chartEx" Target="charts\/chartEx1.xml"/);
  const back = await importDocx(out.bytes);
  const chart = back.doc.content[0].content[0];
  assert.deepEqual([chart.type, chart.attrs.model.other, chart.attrs.model.title.text], ['chart', null, 'Cash flow']);
  assert.deepEqual(back.dropped, []);
});
