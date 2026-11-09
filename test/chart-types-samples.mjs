// Chart parts of every type Word draws beyond column, bar, line, area, pie, doughnut and scatter (test/chart-samples.mjs has
// those), written in the form Word 2016 and later writes them, with their cached data: radar, filled radar, bubble, stock and
// volume stock, a column and line combination on a secondary axis, contour, wireframe contour and 3-D surface, pie of pie, bar of
// pie, trendlines on a scatter and a line chart, a 3-D column chart, and the chartex types waterfall, funnel, histogram, Pareto,
// box and whisker, treemap, sunburst and map. Shared by test/word-charts.test.mjs and the harness case
// .smoke-data/word/cases/charts.js. Not a test file itself (npm test runs *.test.*).

const NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const CX = 'xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const GREY = '<a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill>';
const fill = (c) => `<a:solidFill><a:schemeClr val="${c}"/></a:solidFill>`;
const col = (i) => String.fromCharCode(66 + i);

const str = (f, list) => `<c:strRef><c:f>${f}</c:f><c:strCache><c:ptCount val="${list.length}"/>${list.map((s, i) => `<c:pt idx="${i}"><c:v>${s}</c:v></c:pt>`).join('')}</c:strCache></c:strRef>`;
const nums = (f, list, fmt = 'General') => `<c:numRef><c:f>${f}</c:f><c:numCache><c:formatCode>${fmt}</c:formatCode><c:ptCount val="${list.length}"/>${list.map((v, i) => (v == null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numCache></c:numRef>`;
const title = (text) => `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`;
const legend = (pos = 'b') => `<c:legend><c:legendPos val="${pos}"/><c:overlay val="0"/></c:legend>`;
const ln = (c, w = 28575, dash) => `<c:spPr><a:ln w="${w}" cap="rnd">${fill(c)}${dash ? `<a:prstDash val="${dash}"/>` : ''}<a:round/></a:ln></c:spPr>`;
const noLine = '<c:spPr><a:ln w="19050" cap="rnd"><a:noFill/><a:round/></a:ln></c:spPr>';
const mark = (sym, c, size = 5) => `<c:marker><c:symbol val="${sym}"/>${sym === 'none' ? '' : `<c:size val="${size}"/><c:spPr>${fill(c)}<a:ln w="9525">${fill(c)}</a:ln></c:spPr>`}</c:marker>`;
const solid = (c) => `<c:spPr>${fill(c)}<a:ln><a:noFill/></a:ln></c:spPr>`;
const noLabels = '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>';
/** A c:ser: `i` its index, `name`, its categories and values (`cats` null leaves c:cat out), `extra` its look. */
const ser = (i, name, cats, vals, extra = '', fmt = 'General', catTag = 'c:cat', valTag = 'c:val') => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx>${str(`Sheet1!$${col(i)}$1`, [name])}</c:tx>${extra}`
  + `${cats ? `<${catTag}>${typeof cats[0] === 'number' ? nums(`Sheet1!$A$2:$A$${cats.length + 1}`, cats, 'm/d/yyyy') : str(`Sheet1!$A$2:$A$${cats.length + 1}`, cats)}</${catTag}>` : ''}`
  + `<${valTag}>${nums(`Sheet1!$${col(i)}$2:$${col(i)}$${vals.length + 1}`, vals, fmt)}</${valTag}>`;
/** A category (or date) axis and a value axis, `o` their settings. */
const axes = (cat, val, o = {}) => `<c:${o.date ? 'dateAx' : o.xy ? 'valAx' : 'catAx'}><c:axId val="${cat}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="${o.catDelete ? 1 : 0}"/><c:axPos val="${o.catPos ?? 'b'}"/>`
  + `${o.catGrid ? `<c:majorGridlines><c:spPr><a:ln w="9525">${GREY}</a:ln></c:spPr></c:majorGridlines>` : ''}<c:numFmt formatCode="${o.date ? 'm/d/yyyy' : 'General'}" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>`
  + `<c:spPr><a:noFill/><a:ln w="9525">${GREY}</a:ln></c:spPr><c:crossAx val="${val}"/><c:crosses val="autoZero"/>${o.xy ? '<c:crossBetween val="midCat"/>' : `<c:auto val="1"/><c:lblOffset val="100"/>${o.date ? '<c:baseTimeUnit val="days"/>' : '<c:lblAlgn val="ctr"/><c:noMultiLvlLbl val="0"/>'}`}</c:${o.date ? 'dateAx' : o.xy ? 'valAx' : 'catAx'}>`
  + `<c:valAx><c:axId val="${val}"/><c:scaling><c:orientation val="minMax"/>${o.max != null ? `<c:max val="${o.max}"/>` : ''}${o.min != null ? `<c:min val="${o.min}"/>` : ''}</c:scaling><c:delete val="0"/><c:axPos val="${o.valPos ?? 'l'}"/>`
  + `${o.valGrid === false ? '' : `<c:majorGridlines><c:spPr><a:ln w="9525">${GREY}</a:ln></c:spPr></c:majorGridlines>`}<c:numFmt formatCode="${o.fmt ?? 'General'}" sourceLinked="${o.fmt ? 0 : 1}"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/>`
  + `<c:tickLblPos val="nextTo"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:crossAx val="${cat}"/><c:crosses val="${o.crosses ?? 'autoZero'}"/><c:crossBetween val="${o.between ?? 'between'}"/></c:valAx>`;
const serAx = (id, cross) => `<c:serAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/></c:serAx>`;
const space = (inner, view3D = '') => `${HEAD}<c:chartSpace ${NS}><c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart>${inner.replace('<c:plotArea>', `${view3D}<c:plotArea>`)}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>`
  + `<c:spPr>${fill('bg1')}<a:ln w="9525">${GREY}</a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr></c:chartSpace>`;
const trend = (type, o = {}) => `<c:trendline>${o.name ? `<c:name>${o.name}</c:name>` : ''}${ln(o.color ?? 'accent1', 19050, 'sysDot')}<c:trendlineType val="${type}"/>`
  + `${o.order ? `<c:order val="${o.order}"/>` : ''}${o.period ? `<c:period val="${o.period}"/>` : ''}${o.forward ? `<c:forward val="${o.forward}"/>` : ''}${o.intercept != null ? `<c:intercept val="${o.intercept}"/>` : ''}`
  + `<c:dispRSqr val="${o.r2 ? 1 : 0}"/><c:dispEq val="${o.eq ? 1 : 0}"/>${o.eq || o.r2 ? '<c:trendlineLbl><c:numFmt formatCode="General" sourceLinked="0"/></c:trendlineLbl>' : ''}</c:trendline>`;

/** The data behind the samples, so tests can check what is drawn against it. */
export const DATA = {
  skills: { cats: ['Speed', 'Power', 'Range', 'Control', 'Stamina'], series: [{ name: 'Ann', vals: [4, 3, 5, 2, 4] }, { name: 'Ben', vals: [2, 5, 3, 4, 3] }] },
  bubble: { series: [{ name: 'Products', xs: [1, 2, 3, 4], ys: [10, 25, 15, 30], sizes: [5, 20, 10, 40] }] },
  // Open, high, low, close over five days (Excel serial dates).
  stock: { dates: [45292, 45293, 45294, 45295, 45296], series: [{ name: 'Open', vals: [44, 25, 38, 50, 34] }, { name: 'High', vals: [55, 57, 57, 58, 58] },
    { name: 'Low', vals: [11, 12, 13, 11, 25] }, { name: 'Close', vals: [25, 38, 50, 35, 43] }], volume: [70, 120, 150, 135, 148] },
  combo: { cats: ['Jan', 'Feb', 'Mar', 'Apr'], sales: [120, 150, 170, 140], margin: [0.12, 0.18, 0.21, 0.15] },
  surface: { cats: ['A', 'B', 'C', 'D', 'E'], series: [{ name: 'Row 1', vals: [10, 20, 30, 20, 10] }, { name: 'Row 2', vals: [20, 40, 60, 40, 20] }, { name: 'Row 3', vals: [10, 30, 45, 30, 10] }] },
  ofPie: { cats: ['Rent', 'Food', 'Travel', 'Books', 'Gifts', 'Fees'], vals: [40, 25, 15, 8, 7, 5] },
  trend: { xs: [1, 2, 3, 4, 5, 6], linear: [2.1, 3.9, 6.2, 7.8, 10.1, 12.2], exp: [1.1, 2.0, 4.2, 7.9, 16.5, 31.8] },
  waterfall: { cats: ['Start', 'Sales', 'Returns', 'Services', 'Costs', 'End'], vals: [100, 20, -15, 30, -10, 125], totals: [0, 5] },
  funnel: { cats: ['Visits', 'Leads', 'Trials', 'Deals'], vals: [1000, 600, 300, 120] },
  histogram: [12, 15, 18, 22, 25, 25, 27, 30, 31, 33, 34, 35, 36, 38, 40, 41, 43, 45, 47, 50, 52, 55, 58, 61, 65, 70, 74, 80, 88, 95],
  pareto: { cats: ['Late', 'Damaged', 'Wrong item', 'Late', 'Rude', 'Damaged', 'Late', 'Other'], vals: [30, 12, 8, 20, 3, 6, 10, 2] },
  box: { cats: ['East', 'East', 'East', 'East', 'East', 'East', 'East', 'East', 'West', 'West', 'West', 'West', 'West', 'West', 'West', 'West'],
    series: [{ name: 'Store A', vals: [12, 15, 14, 18, 20, 13, 16, 45, 22, 25, 21, 28, 30, 24, 26, 23] }, { name: 'Store B', vals: [10, 11, 13, 12, 15, 14, 12, 11, 18, 20, 19, 22, 21, 17, 20, 19] }] },
  tree: { levels: [['Fruit', null, null, 'Veg', null, 'Grain', null, null], ['Citrus', null, 'Apple', 'Root', 'Leaf', 'Rice', 'Wheat', null],
    ['Orange', 'Lemon', null, 'Carrot', 'Kale', null, 'Bread', 'Pasta']], vals: [20, 10, 25, 15, 8, 12, 9, 6] },
};
const D = DATA;

const radarXml = (style) => space(`${title(style === 'filled' ? 'Filled skills' : 'Skills')}<c:plotArea><c:layout/><c:radarChart><c:radarStyle val="${style}"/><c:varyColors val="0"/>`
  + D.skills.series.map((s, i) => `${ser(i, s.name, D.skills.cats, s.vals, style === 'filled' ? solid(`accent${i + 1}`) : `${ln(`accent${i + 1}`)}${mark('circle', `accent${i + 1}`)}`)}</c:ser>`).join('')
  + `${noLabels}<c:axId val="11"/><c:axId val="12"/></c:radarChart>${axes(11, 12, { catGrid: true, between: 'between' })}</c:plotArea>${legend('b')}`);

const surfaceXml = (tag, wire, name) => space(`${title(name)}<c:plotArea><c:layout/><c:${tag}><c:wireframe val="${wire ? 1 : 0}"/>`
  + D.surface.series.map((s, i) => `${ser(i, s.name, D.surface.cats, s.vals, solid(`accent${i + 1}`))}</c:ser>`).join('')
  + `<c:bandFmts/><c:axId val="31"/><c:axId val="32"/><c:axId val="33"/></c:${tag}>${axes(31, 32, { between: 'midCat' })}${serAx(33, 32)}</c:plotArea>${legend('r')}`,
tag === 'surface3DChart' ? '<c:view3D><c:rotX val="15"/><c:rotY val="20"/><c:rAngAx val="0"/></c:view3D>' : '<c:view3D><c:rotX val="90"/><c:rotY val="0"/><c:rAngAx val="0"/><c:perspective val="0"/></c:view3D>');

const ofPieXml = (type, split) => space(`${title(type === 'bar' ? 'Spending, bar of pie' : 'Spending, pie of pie')}<c:plotArea><c:layout/><c:ofPieChart><c:ofPieType val="${type}"/><c:varyColors val="1"/>`
  + `${ser(0, 'Spending', D.ofPie.cats, D.ofPie.vals, D.ofPie.cats.map((_, k) => `<c:dPt><c:idx val="${k}"/><c:bubble3D val="0"/>${solid(`accent${(k % 6) + 1}`)}</c:dPt>`).join(''))}</c:ser>`
  + `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls>`
  + `<c:gapWidth val="100"/>${split}<c:secondPieSize val="75"/><c:serLines><c:spPr><a:ln w="9525">${GREY}</a:ln></c:spPr></c:serLines></c:ofPieChart></c:plotArea>${legend('b')}`);

/** The chart parts (c:chartSpace or cx:chartSpace XML), by sample name. */
export const PARTS = {
  radar: radarXml('marker'),
  filledRadar: radarXml('filled'),
  bubble: space(`${title('Market size')}<c:plotArea><c:layout/><c:bubbleChart><c:varyColors val="0"/>`
    + `${ser(0, 'Products', null, D.bubble.series[0].ys, `${solid('accent1')}<c:invertIfNegative val="0"/><c:xVal>${nums('Sheet1!$A$2:$A$5', D.bubble.series[0].xs)}</c:xVal>`, 'General', 'c:cat', 'c:yVal')}`
      .replace('</c:yVal>', `</c:yVal><c:bubbleSize>${nums('Sheet1!$C$2:$C$5', D.bubble.series[0].sizes)}</c:bubbleSize><c:bubble3D val="0"/>`)
    + `</c:ser>${noLabels}<c:bubbleScale val="100"/><c:showNegBubbles val="0"/><c:axId val="21"/><c:axId val="22"/></c:bubbleChart>${axes(21, 22, { xy: true, between: 'midCat' })}</c:plotArea>`),
  stock: space(`${title('Share price')}<c:plotArea><c:layout/><c:stockChart>`
    + D.stock.series.map((s, i) => `${ser(i, s.name, D.stock.dates, s.vals, `${noLine}${mark('none')}`)}<c:smooth val="0"/></c:ser>`).join('')
    + `<c:hiLowLines><c:spPr><a:ln w="9525">${fill('tx1')}</a:ln></c:spPr></c:hiLowLines><c:upDownBars><c:gapWidth val="150"/><c:upBars><c:spPr>${fill('lt1')}<a:ln w="9525">${fill('tx1')}</a:ln></c:spPr></c:upBars>`
    + `<c:downBars><c:spPr><a:solidFill><a:schemeClr val="dk1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill><a:ln w="9525">${fill('tx1')}</a:ln></c:spPr></c:downBars></c:upDownBars>`
    + `<c:axId val="41"/><c:axId val="42"/></c:stockChart>${axes(41, 42, { date: true })}</c:plotArea>${legend('b')}`),
  // Volume-high-low-close: the volume columns on the primary axes, the stock plot on the secondary ones.
  volumeStock: space(`${title('Volume and price')}<c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>`
    + `${ser(0, 'Volume', D.stock.dates, D.stock.volume, solid('accent1'))}<c:invertIfNegative val="0"/></c:ser><c:gapWidth val="150"/><c:axId val="51"/><c:axId val="52"/></c:barChart>`
    + `<c:stockChart>${D.stock.series.slice(1).map((s, i) => `${ser(i + 1, s.name, D.stock.dates, s.vals, `${noLine}${i === 2 ? mark('dot', 'accent4', 5) : mark('none')}`)}<c:smooth val="0"/></c:ser>`).join('')}`
    + `<c:hiLowLines><c:spPr><a:ln w="9525">${fill('tx1')}</a:ln></c:spPr></c:hiLowLines><c:axId val="53"/><c:axId val="54"/></c:stockChart>`
    + `${axes(51, 52, { date: true })}${axes(53, 54, { date: true, catDelete: true, valPos: 'r', crosses: 'max', valGrid: false })}</c:plotArea>${legend('b')}`),
  // Clustered column and line on a secondary axis, Word's own combination preset.
  combo: space(`${title('Sales and margin')}<c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>`
    + `${ser(0, 'Sales', D.combo.cats, D.combo.sales, solid('accent1'))}<c:invertIfNegative val="0"/></c:ser><c:gapWidth val="219"/><c:overlap val="-27"/><c:axId val="61"/><c:axId val="62"/></c:barChart>`
    + `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser(1, 'Margin', D.combo.cats, D.combo.margin, `${ln('accent2')}${mark('none')}`, '0%')}<c:smooth val="0"/></c:ser><c:marker val="1"/><c:axId val="63"/><c:axId val="64"/></c:lineChart>`
    + `${axes(61, 62)}${axes(63, 64, { catDelete: true, valPos: 'r', crosses: 'max', valGrid: false, fmt: '0%' })}</c:plotArea>${legend('b')}`),
  contour: surfaceXml('surfaceChart', false, 'Contour'),
  wireContour: surfaceXml('surfaceChart', true, 'Wireframe contour'),
  surface3D: surfaceXml('surface3DChart', false, '3-D surface'),
  pieOfPie: ofPieXml('pie', ''),
  barOfPie: ofPieXml('bar', '<c:splitType val="val"/><c:splitPos val="10"/>'),
  trendScatter: space(`${title('Growth')}<c:plotArea><c:layout/><c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>`
    + `${ser(0, 'Linear', null, D.trend.linear, `<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr>${mark('circle', 'accent1')}${trend('linear', { eq: true, r2: true })}<c:xVal>${nums('Sheet1!$A$2:$A$7', D.trend.xs)}</c:xVal>`, 'General', 'c:cat', 'c:yVal')}<c:smooth val="0"/></c:ser>`
    + `${ser(1, 'Doubling', null, D.trend.exp, `<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr>${mark('diamond', 'accent2')}${trend('exp', { eq: true, r2: true, color: 'accent2' })}<c:xVal>${nums('Sheet1!$A$2:$A$7', D.trend.xs)}</c:xVal>`, 'General', 'c:cat', 'c:yVal')}<c:smooth val="0"/></c:ser>`
    + `<c:axId val="71"/><c:axId val="72"/></c:scatterChart>${axes(71, 72, { xy: true, between: 'midCat' })}</c:plotArea>${legend('b')}`),
  trendLine: space(`${title('Visitors with trends')}<c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>`
    + `${ser(0, 'Visitors', ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], [120, 135, 160, 150, 190, 210], `${ln('accent1')}${mark('circle', 'accent1')}${trend('movingAvg', { period: 2 })}${trend('poly', { order: 2, eq: true, color: 'accent2' })}`)}<c:smooth val="0"/></c:ser>`
    + `<c:marker val="1"/><c:axId val="81"/><c:axId val="82"/></c:lineChart>${axes(81, 82)}</c:plotArea>${legend('b')}`),
  column3D: space(`${title('Sales in 3-D')}<c:plotArea><c:layout/><c:bar3DChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>`
    + `${ser(0, 'North', D.combo.cats, D.combo.sales, solid('accent1'))}<c:invertIfNegative val="0"/></c:ser><c:gapWidth val="150"/><c:shape val="box"/><c:axId val="91"/><c:axId val="92"/><c:axId val="0"/></c:bar3DChart>`
    + `${axes(91, 92)}</c:plotArea>${legend('b')}`, '<c:view3D><c:rotX val="15"/><c:rotY val="20"/><c:rAngAx val="1"/></c:view3D><c:floor><c:thickness val="0"/></c:floor>'),
};

// ---------- chartex ----------
const cxPts = (list) => list.map((v, i) => (v == null ? '' : `<cx:pt idx="${i}">${v}</cx:pt>`)).join('');
const strDim = (levels, f = 'Sheet1!$A$2:$A$9') => `<cx:strDim type="cat"><cx:f>${f}</cx:f>${levels.map((lv) => `<cx:lvl ptCount="${lv.length}">${cxPts(lv)}</cx:lvl>`).join('')}</cx:strDim>`;
const numDim = (vals, type = 'val', f = 'Sheet1!$B$2:$B$9') => `<cx:numDim type="${type}"><cx:f>${f}</cx:f><cx:lvl ptCount="${vals.length}" formatCode="General">${cxPts(vals)}</cx:lvl></cx:numDim>`;
const cxTitle = (text) => `<cx:title pos="t" align="ctr" overlay="0"><cx:tx><cx:txData><cx:v>${text}</cx:v></cx:txData></cx:tx></cx:title>`;
const cxSeries = (layout, name, id, inner = '', extra = '') => `<cx:series layoutId="${layout}" uniqueId="{0000000${id}-0000-0000-0000-000000000000}"${extra}><cx:tx><cx:txData><cx:f>Sheet1!$B$1</cx:f><cx:v>${name}</cx:v></cx:txData></cx:tx>${inner}</cx:series>`;
const cxAxes = (gap, o = {}) => `<cx:axis id="0"${o.catHidden ? ' hidden="1"' : ''}><cx:catScaling gapWidth="${gap}"/><cx:tickLabels/></cx:axis>${o.noVal ? '' : '<cx:axis id="1"><cx:valScaling/><cx:majorGridlines/><cx:tickLabels/></cx:axis>'}${o.extra ?? ''}`;
const cxSpace = (data, chart) => `${HEAD}<cx:chartSpace ${CX}><cx:chartData>${data}</cx:chartData><cx:chart>${chart}</cx:chart></cx:chartSpace>`;
const vis = (v) => `<cx:dataLabels pos="${v.pos ?? 'outEnd'}"><cx:visibility seriesName="0" categoryName="${v.cat ? 1 : 0}" value="${v.val ? 1 : 0}"/></cx:dataLabels>`;
const treeLevels = [...D.tree.levels].reverse(); // the cache lists the innermost level first

Object.assign(PARTS, {
  waterfall: cxSpace(`<cx:data id="0">${strDim([D.waterfall.cats])}${numDim(D.waterfall.vals)}</cx:data>`,
    `${cxTitle('Cash flow')}<cx:plotArea><cx:plotAreaRegion>${cxSeries('waterfall', 'Amount', 1, `${vis({ val: true })}<cx:dataId val="0"/><cx:layoutPr><cx:subtotals>${D.waterfall.totals.map((k) => `<cx:idx val="${k}"/>`).join('')}</cx:subtotals></cx:layoutPr>`)}`
    + `</cx:plotAreaRegion>${cxAxes(0.5)}</cx:plotArea><cx:legend pos="t" align="ctr" overlay="0"/>`),
  funnel: cxSpace(`<cx:data id="0">${strDim([D.funnel.cats])}${numDim(D.funnel.vals)}</cx:data>`,
    `${cxTitle('Sales funnel')}<cx:plotArea><cx:plotAreaRegion>${cxSeries('funnel', 'Customers', 2, `${vis({ val: true, pos: 'ctr' })}<cx:dataId val="0"/>`)}</cx:plotAreaRegion>${cxAxes(0.06, { noVal: true })}</cx:plotArea>`),
  histogram: cxSpace(`<cx:data id="0">${numDim(D.histogram, 'val', 'Sheet1!$A$2:$A$31')}</cx:data>`,
    `${cxTitle('Wait times')}<cx:plotArea><cx:plotAreaRegion>${cxSeries('clusteredColumn', 'Minutes', 3, '<cx:dataId val="0"/><cx:layoutPr><cx:binning intervalClosed="r"/></cx:layoutPr>')}</cx:plotAreaRegion>${cxAxes(0)}</cx:plotArea>`),
  pareto: cxSpace(`<cx:data id="0">${strDim([D.pareto.cats])}${numDim(D.pareto.vals)}</cx:data>`,
    `${cxTitle('Complaints')}<cx:plotArea><cx:plotAreaRegion>${cxSeries('clusteredColumn', 'Count', 4, '<cx:dataId val="0"/><cx:layoutPr><cx:aggregation/></cx:layoutPr><cx:axisId val="1"/>')}`
    + `${cxSeries('paretoLine', 'Count', 5, '<cx:axisId val="2"/>', ' ownerIdx="0"')}</cx:plotAreaRegion>`
    + `${cxAxes(0.5, { extra: '<cx:axis id="2"><cx:valScaling max="1" min="0"/><cx:units unit="percentage"/><cx:tickLabels/></cx:axis>' })}</cx:plotArea><cx:legend pos="t" align="ctr" overlay="0"/>`),
  box: cxSpace(D.box.series.map((s, i) => `<cx:data id="${i}">${strDim([D.box.cats], 'Sheet1!$A$2:$A$17')}${numDim(s.vals, 'val', `Sheet1!$${col(i)}$2:$${col(i)}$17`)}</cx:data>`).join(''),
    `${cxTitle('Daily sales')}<cx:plotArea><cx:plotAreaRegion>${D.box.series.map((s, i) => cxSeries('boxWhisker', s.name, 6 + i, `<cx:dataId val="${i}"/><cx:layoutPr><cx:visibility meanLine="0" meanMarker="1" nonoutliers="0" outliers="1"/><cx:statistics quartileMethod="exclusive"/></cx:layoutPr>`, ` formatIdx="${i}"`)).join('')}`
    + `</cx:plotAreaRegion>${cxAxes(1)}</cx:plotArea><cx:legend pos="t" align="ctr" overlay="0"/>`),
  treemap: cxSpace(`<cx:data id="0">${strDim(treeLevels, 'Sheet1!$A$2:$C$9')}${numDim(D.tree.vals, 'size', 'Sheet1!$D$2:$D$9')}</cx:data>`,
    `${cxTitle('Food')}<cx:plotArea><cx:plotAreaRegion>${cxSeries('treemap', 'Sales', 8, `${vis({ cat: true, pos: 'inEnd' })}<cx:dataId val="0"/><cx:layoutPr><cx:parentLabelLayout val="banner"/></cx:layoutPr>`)}</cx:plotAreaRegion></cx:plotArea><cx:legend pos="t" align="ctr" overlay="0"/>`),
  sunburst: cxSpace(`<cx:data id="0">${strDim(treeLevels, 'Sheet1!$A$2:$C$9')}${numDim(D.tree.vals, 'size', 'Sheet1!$D$2:$D$9')}</cx:data>`,
    `${cxTitle('Food rings')}<cx:plotArea><cx:plotAreaRegion>${cxSeries('sunburst', 'Sales', 9, `${vis({ cat: true, pos: 'ctr' })}<cx:dataId val="0"/>`)}</cx:plotAreaRegion></cx:plotArea>`),
  map: cxSpace(`<cx:data id="0">${strDim([['France', 'Spain', 'Italy']])}${numDim([3, 5, 2], 'colorVal')}</cx:data>`,
    `${cxTitle('Visits by country')}<cx:plotArea><cx:plotAreaRegion>${cxSeries('regionMap', 'Visits', 10, '<cx:dataId val="0"/><cx:layoutPr><cx:regionLabelLayout val="none"/></cx:layoutPr>')}</cx:plotAreaRegion></cx:plotArea>`),
});

/** What each sample draws, for tests and the harness: the data attribute it counts and how many, and the legend's entries. */
export const EXPECT = {
  radar: { attr: 'data-point', n: 10, legend: ['Ann', 'Ben'] },
  filledRadar: { attr: 'data-series', n: 2, legend: ['Ann', 'Ben'] },
  bubble: { attr: 'data-bubble', n: 4, legend: null },
  stock: { attr: 'data-updown', n: 5, legend: ['Open', 'High', 'Low', 'Close'] },
  volumeStock: { attr: 'data-hilow', n: 5, legend: ['Volume', 'High', 'Low', 'Close'] },
  combo: { attr: 'data-bar', n: 4, legend: ['Sales', 'Margin'] },
  contour: { attr: 'data-band', n: null, legend: null },
  wireContour: { attr: 'data-band', n: null, legend: null },
  surface3D: { attr: 'data-band', n: null, legend: null },
  pieOfPie: { attr: 'data-slice', n: 7, legend: D.ofPie.cats },
  barOfPie: { attr: 'data-slice', n: 7, legend: D.ofPie.cats },
  trendScatter: { attr: 'data-trend', n: 2, legend: ['Linear', 'Doubling', 'Linear (Linear)', 'Expon. (Doubling)'] },
  trendLine: { attr: 'data-trend', n: 2, legend: ['Visitors', '2 per. Mov. Avg. (Visitors)', 'Poly. (Visitors)'] },
  column3D: { attr: 'data-bar', n: 4, legend: ['North'] },
  waterfall: { attr: 'data-bar', n: 6, legend: ['Increase', 'Decrease', 'Total'] },
  funnel: { attr: 'data-bar', n: 4, legend: null },
  histogram: { attr: 'data-bar', n: null, legend: null },
  pareto: { attr: 'data-bar', n: 5, legend: ['Count', 'Count'] },
  box: { attr: 'data-box', n: 4, legend: ['Store A', 'Store B'] },
  treemap: { attr: 'data-leaf', n: 8, legend: ['Fruit', 'Veg', 'Grain'] },
  sunburst: { attr: 'data-slice', n: 15, legend: null },
  map: { attr: 'data-other', n: 1, legend: null },
};

const CT = { c: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml', cx: 'application/vnd.ms-office.chartex+xml' };
/** A chart node for sample `name` (its part only, as export writes parts as they came) at `w` by `h` pt. */
export function chartNode(name, k, w = 360, h = 216) {
  const kind = PARTS[name].includes('<cx:chartSpace') ? 'cx' : 'c';
  const main = `word/charts/${kind === 'cx' ? 'chartEx' : 'chart'}${k}.xml`;
  return { type: 'chart', attrs: { w, h, name: `Chart ${k}`, alt: name, model: null,
    parts: { kind, main, list: [{ name: main, type: CT[kind], data: Buffer.from(PARTS[name]).toString('base64') }] } } };
}
/** A Document holding every sample, each in a paragraph after its name → the doc JSON for export.mjs's exportDocx. */
export const samplesDoc = (names = Object.keys(PARTS)) => ({ type: 'doc', attrs: {}, content: names.flatMap((name, i) => [
  { type: 'paragraph', content: [{ type: 'text', text: `${name}:` }] }, { type: 'paragraph', content: [chartNode(name, i + 1)] }]) });
