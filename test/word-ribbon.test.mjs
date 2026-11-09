// The ribbon's layout model (docs/plans/word/plan.md §1.4, §2.8; src/tooling/ribbon/layout.mjs) on a hand spec shaped like
// Word's Home, Layout and Table Layout tabs (probe/ribbon.md), then on the generated spec's own groups.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as WORD from '../src/document/ribbon/spec.mjs';
import { itemsOf, layoutTab, nextTab, splitLabel, tabKeytips, visibleTabs } from '../src/tooling/ribbon/layout.mjs';

const c = (type, size, label, more = {}) => ({ type, size, label, icon: 'Square', ...more });
const CONTROLS = {
  'home.clipboard.paste': c('split', 'large', 'Paste', { keytip: 'V', menu: 'home.clipboard.paste' }),
  'home.clipboard.cut': c('button', 'medium', 'Cut', { keytip: 'X' }),
  'home.clipboard.copy': c('button', 'medium', 'Copy', { keytip: 'C 1' }),
  'home.clipboard.formatPainter': c('toggle', 'medium', 'Format Painter', { keytip: 'F P' }),
  'home.clipboard.launcher': c('button', 'small', 'Clipboard', { keytip: 'F O', dialog: 'clipboard' }),
  'home.font.font': c('combo', 'medium', 'Font', { keytip: 'F F' }),
  'home.font.fontSize': c('combo', 'medium', 'Font Size', { keytip: 'F S', width: 3.5 }),
  'home.font.growFont': c('button', 'small', 'Grow Font'),
  'home.font.shrinkFont': c('button', 'small', 'Shrink Font'),
  'home.font.bold': c('toggle', 'small', 'Bold', { keytip: '1' }),
  'home.font.italic': c('toggle', 'small', 'Italic', { keytip: '2' }),
  'home.font.underline': c('splitToggle', 'small', 'Underline', { keytip: '3', menu: 'home.font.underline' }),
  'home.font.phoneticGuide': c('button', 'small', 'Phonetic Guide...', { needs: 'pending' }),
  'home.paragraph.alignLeft': c('toggle', 'small', 'Align Left'),
  'home.paragraph.center': c('toggle', 'small', 'Center'),
  'home.styles.styles': c('gallery', 'large', 'Styles', { gallery: 'home.styles.styles', grid: { rows: 1, cols: 6 } }),
  'layout.pageSetup.margins': c('dropdown', 'large', 'Margins', { keytip: 'M' }),
  'layout.pageSetup.breaks': c('dropdown', 'medium', 'Breaks'),
  'layout.paragraph.indentLeft': c('spinner', 'medium', 'Left', { unit: 'len', parts: { more: 'layout.paragraph.indentLeft.more', less: 'layout.paragraph.indentLeft.less' } }),
  'layout.paragraph.indentRight': c('spinner', 'medium', 'Right', { unit: 'len' }),
  'layout.paragraph.spacingBefore': c('spinner', 'medium', 'Before', { unit: 'pt' }),
  'layout.paragraph.spacingAfter': c('spinner', 'medium', 'After', { unit: 'pt' }),
  'layout.paragraph.launcher': c('button', 'small', 'Paragraph', { cmd: 'home.paragraph.launcher' }),
  'tableLayout.alignment.alignTopLeft': c('toggle', 'small', 'Align Top Left'),
  'tableLayout.alignment.alignTopCenter': c('toggle', 'small', 'Align Top Center'),
  'tableLayout.alignment.alignCenterLeft': c('toggle', 'small', 'Align Center Left'),
  'tableLayout.alignment.alignCenter': c('toggle', 'small', 'Align Center'),
  'tableLayout.alignment.textDirection': c('button', 'large', 'Text Direction'),
  'outlining.outlineTools.outlineLevel': c('list', 'medium', 'Outline Level', { menu: 'outlining.outlineTools.outlineLevel' }),
  'outlining.close.closeOutlineView': c('button', 'large', 'Close Outline View'),
  'header.close.close': c('button', 'large', 'Close Header and Footer'),
};
const SPEC = {
  FILE: { id: 'file', label: 'File', keytip: 'F' },
  CONTEXTS: { table: { label: 'Table' }, outline: { label: 'Outlining' }, header: { label: 'Header & Footer', activate: true }, immersive: { label: 'Reader', alone: true } },
  CONTROLS,
  TABS: [
    { id: 'home', label: 'Home', keytip: 'H', context: null, groups: [
      { id: 'home.clipboard', label: 'Clipboard', keytip: 'Z L', launcher: 'home.clipboard.launcher', layout: [
        { large: 'home.clipboard.paste' },
        { rows: [['home.clipboard.cut'], ['home.clipboard.copy'], ['home.clipboard.formatPainter']] },
      ] },
      { id: 'home.font', label: 'Font', layout: [{ rows: [
        ['home.font.font', 'home.font.fontSize', ['home.font.growFont', 'home.font.shrinkFont'], 'home.font.phoneticGuide'],
        [['home.font.bold', 'home.font.italic', 'home.font.underline']],
      ] }] },
      { id: 'home.styles', label: 'Styles', layout: [{ gallery: 'home.styles.styles' }] },
    ] },
    { id: 'layout', label: 'Layout', keytip: 'P', context: null, groups: [
      { id: 'layout.pageSetup', label: 'Page Setup', layout: [{ large: 'layout.pageSetup.margins' }, { rows: [['layout.pageSetup.breaks']] }] },
      { id: 'layout.paragraph', label: 'Paragraph', launcher: 'layout.paragraph.launcher', layout: [
        { caption: 'Indent', rows: [['layout.paragraph.indentLeft'], ['layout.paragraph.indentRight']] },
        { caption: 'Spacing', rows: [['layout.paragraph.spacingBefore'], ['layout.paragraph.spacingAfter']] },
      ] },
    ] },
    { id: 'developer', label: 'Developer', keytip: 'L', context: null, hidden: true, groups: [] },
    { id: 'tableLayout', label: 'Layout', keytip: 'J L', context: 'table', groups: [
      { id: 'tableLayout.alignment', label: 'Alignment', layout: [
        { rows: [[['tableLayout.alignment.alignTopLeft', 'tableLayout.alignment.alignTopCenter']], [['tableLayout.alignment.alignCenterLeft', 'tableLayout.alignment.alignCenter']]] },
        { large: 'tableLayout.alignment.textDirection' },
        { large: 'tableLayout.alignment.nope' },
      ] },
    ] },
    { id: 'outlining', label: 'Outlining', keytip: 'U', context: 'outline', first: true, groups: [
      { id: 'outlining.outlineTools', label: 'Outline Tools', layout: [{ rows: [['outlining.outlineTools.outlineLevel']] }] },
      { id: 'outlining.close', label: 'Close', layout: [{ large: 'outlining.close.closeOutlineView' }] },
    ] },
    { id: 'headerFooter', label: 'Header & Footer', keytip: 'J H', context: 'header', groups: [
      { id: 'header.close', label: 'Close', layout: [{ large: 'header.close.close' }] },
    ] },
  ],
};

test('Home: a large Paste, three medium rows, a launcher and the group KeyTips', () => {
  const home = layoutTab(SPEC, 'home');
  const [clip, font, styles] = home.groups;
  assert.deepEqual(home.groups.map((g) => g.label), ['Clipboard', 'Font', 'Styles']);
  assert.equal(clip.columns[0].kind, 'large');
  assert.equal(clip.columns[0].item.id, 'home.clipboard.paste');
  assert.deepEqual(clip.columns[1].rows.map((r) => r.map((e) => e.id)), [['home.clipboard.cut'], ['home.clipboard.copy'], ['home.clipboard.formatPainter']]);
  assert.equal(clip.launcher.id, 'home.clipboard.launcher');
  assert.ok(home.keytips.some(([k, id, kind]) => k === 'F O' && id === 'home.clipboard.launcher' && kind === 'launcher'));
  assert.ok(home.keytips.some(([k, id, kind]) => k === 'Z L' && id === 'home.clipboard' && kind === 'group'));
  assert.equal(styles.columns[0].kind, 'gallery');
  // Font: two rows; the grow and shrink pair and B I U drawn joined; boxes with their widths.
  const [r1, r2] = font.columns[0].rows;
  assert.deepEqual(r1[2].join.map((i) => i.id), ['home.font.growFont', 'home.font.shrinkFont']);
  assert.deepEqual(r2[0].join.map((i) => i.id), ['home.font.bold', 'home.font.italic', 'home.font.underline']);
  assert.equal(r1[0].box, 8.7);
  assert.equal(r1[1].box, 3.5);
  assert.equal(r2[0].join[0].box, null);
});

test('placeholders come from needs, or from a missing command when a registry check is given', () => {
  const plain = layoutTab(SPEC, 'home');
  const items = plain.groups.flatMap((g) => itemsOf(g.columns));
  assert.equal(items.find((i) => i.id === 'home.font.phoneticGuide').placeholder, 'pending');
  assert.equal(items.find((i) => i.id === 'home.font.bold').placeholder, null);
  const checked = layoutTab(SPEC, 'layout', { has: (id) => id === 'home.paragraph.launcher' });
  assert.equal(checked.groups[1].launcher.cmd, 'home.paragraph.launcher'); // a same control runs the canonical command
  assert.equal(checked.groups[1].launcher.placeholder, null);
  assert.equal(checked.groups[0].columns[0].item.placeholder, 'pending');
});

test('Layout: the Indent and Spacing captions over two spinner rows each', () => {
  const para = layoutTab(SPEC, 'layout').groups[1];
  assert.deepEqual(para.columns.map((c) => c.caption), ['Indent', 'Spacing']);
  assert.deepEqual(para.columns[0].rows.map((r) => r[0].id), ['layout.paragraph.indentLeft', 'layout.paragraph.indentRight']);
  assert.equal(para.columns[0].rows[0][0].box, 5.5);
  assert.equal(para.columns[0].rows[0][0].control.parts.more, 'layout.paragraph.indentLeft.more');
});

test('Table Layout: the alignment grid as joined rows; unknown ids are reported', () => {
  const tl = layoutTab(SPEC, 'tableLayout');
  const grid = tl.groups[0].columns[0];
  assert.equal(grid.rows.length, 2);
  assert.equal(grid.rows[0][0].join.length, 2);
  assert.deepEqual(tl.missing, ['tableLayout.alignment.nope']);
  assert.equal(tl.context, 'table');
  assert.equal(layoutTab(SPEC, 'nope'), null);
});

test('a list box is a medium control drawn as a box', () => {
  const [level] = itemsOf(layoutTab(SPEC, 'outlining').groups[0].columns);
  assert.equal(level.control.type, 'list');
  assert.equal(level.box, 8);
});

test('visible tabs follow the contexts; a rising context brings its tab forward', () => {
  const ids = (held, show) => visibleTabs(SPEC, held, show).map((t) => t.id);
  assert.deepEqual(ids({}), ['home', 'layout']);
  assert.deepEqual(ids({}, ['developer']), ['home', 'layout', 'developer']);
  assert.deepEqual(ids({ table: true }), ['home', 'layout', 'tableLayout']);
  assert.deepEqual(ids({ outline: true }), ['outlining', 'home', 'layout']);
  const tabs = visibleTabs(SPEC, { table: true });
  assert.equal(nextTab(SPEC, { current: 'layout', tabs, before: {}, held: { table: true } }), 'layout'); // Word does not jump to table tabs
  const head = visibleTabs(SPEC, { header: true });
  assert.equal(nextTab(SPEC, { current: 'home', tabs: head, before: {}, held: { header: true } }), 'headerFooter');
  assert.equal(nextTab(SPEC, { current: 'headerFooter', tabs: head, before: { header: true }, held: { header: true } }), 'headerFooter');
  const out = visibleTabs(SPEC, { outline: true });
  assert.equal(nextTab(SPEC, { current: 'home', tabs: out, before: {}, held: { outline: true } }), 'outlining');
  // The table context ends: the ribbon returns to the last main tab.
  assert.equal(nextTab(SPEC, { current: 'tableLayout', tabs: visibleTabs(SPEC, {}), before: { table: true }, held: {}, lastMain: 'layout' }), 'layout');
  assert.deepEqual(tabKeytips(SPEC).slice(0, 2), [['F', 'file'], ['H', 'home']]);
});

// A label holding a long text splits in one pass, where word by word it took minutes: the characters it looks at are counted
// (node:test cannot time out a synchronous body, so a timeout guards nothing).
test('large labels split on two lines as Word draws them', () => {
  assert.deepEqual(splitLabel('Margins'), ['Margins', '']);
  const long = Array.from({ length: 100000 }, () => 'word').join(' ');
  let steps = 0;
  const [a, b] = splitLabel(long, (n) => (steps += n));
  assert.ok(steps > 0 && steps <= long.length, `${steps} steps for a label of ${long.length} characters`);
  assert.ok(a.length + b.length + 1 === long.length && Math.abs(a.length - b.length) < 6);
  assert.deepEqual(splitLabel('Text Direction'), ['Text', 'Direction']);
  assert.deepEqual(splitLabel('Close Header and Footer'), ['Close Header', 'and Footer']);
});

const ids = (row) => row.map((e) => (e.join ? e.join.map((i) => i.id) : e.id));

test('the generated spec: Home > Font and Paragraph rows with their joined button groups', () => {
  const home = layoutTab(WORD, 'home');
  assert.deepEqual(home.missing, []);
  assert.deepEqual(home.groups.map((g) => g.label).slice(0, 4), ['Clipboard', 'Font', 'Paragraph', 'Styles']);
  const font = home.groups.find((g) => g.id === 'home.font');
  assert.equal(font.launcher.id, 'home.font.launcher');
  const [r1, r2] = font.columns[0].rows;
  assert.deepEqual(ids(r1).slice(0, 3), ['home.font.font', 'home.font.fontSize',
    ['home.font.growFont', 'home.font.shrinkFont', 'home.font.changeCase', 'home.font.clearFormatting']]);
  assert.deepEqual(ids(r2)[0], ['home.font.bold', 'home.font.italic', 'home.font.underline', 'home.font.strikethrough', 'home.font.subscript',
    'home.font.superscript']);
  assert.equal(r1[0].box, WORD.CONTROLS['home.font.font'].width); // the list boxes keep the spec's widths
  const para = home.groups.find((g) => g.id === 'home.paragraph').columns[0].rows;
  assert.deepEqual(ids(para[0])[0], ['home.paragraph.bullets', 'home.paragraph.numbering', 'home.paragraph.multilevelList']);
  assert.deepEqual(ids(para[1])[0], ['home.paragraph.alignLeft', 'home.paragraph.center', 'home.paragraph.alignRight', 'home.paragraph.justify',
    'home.paragraph.distributed']);
  assert.equal(home.groups.find((g) => g.id === 'home.styles').columns[0].kind, 'gallery');
});

test('the generated spec: Layout > Paragraph captions and spinners, Table Layout > Alignment grid', () => {
  const para = layoutTab(WORD, 'layout').groups.find((g) => g.id === 'layout.paragraph');
  assert.deepEqual(para.columns.map((c) => c.caption), ['Indent', 'Spacing']);
  const left = para.columns[0].rows[0][0];
  assert.equal(left.control.type, 'spinner');
  assert.equal(left.control.parts.more, 'layout.paragraph.indentLeft.more');
  assert.equal(left.box, WORD.CONTROLS['layout.paragraph.indentLeft'].width);
  const tl = layoutTab(WORD, 'tableLayout');
  assert.deepEqual(tl.missing, []);
  const align = tl.groups.find((g) => g.id === 'tableLayout.alignment');
  assert.equal(align.columns[0].rows.length, 3);
  assert.deepEqual(align.columns.slice(1).map((c) => c.kind), ['large', 'large']);
});

test('the generated spec: every tab lays out with no unknown id', () => {
  for (const t of WORD.TABS) assert.deepEqual(layoutTab(WORD, t.id).missing, [], t.id);
});
