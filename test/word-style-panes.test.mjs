// style-panes' pure logic (docs/plans/word briefs/style-panes.md Acceptance): filters and sorts, type marks, descriptions, Reveal
// Formatting rows and their compare diff, Recommend and Restrict edits, and the instance finder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from 'prosemirror-model';
import { BUILTIN_STYLES, DOC_DEFAULTS, THEME } from '../src/document/defaults.mjs';
import {
  diffSections, filterStyles, instancesOf, kindOf, layered, nameOf, recommendPatch, restrictPatch, revealSections, runRows, sortStyles,
  styleDescription, typeMark, usage, withCopies, withoutStyle, patchStyles, infoOf,
} from '../src/document/wp/style-panes/model.mjs';

const styles = {
  defaults: DOC_DEFAULTS,
  list: {
    ...BUILTIN_STYLES,
    Hidden1: { type: 'paragraph', name: 'Secret', basedOn: 'Normal', semiHidden: true },
    Strong: { type: 'character', name: 'Strong', run: { bold: true }, uiPriority: 22, qFormat: true },
    Linked1: { type: 'paragraph', name: 'Linked One', basedOn: 'Normal', link: 'Linked1Char', uiPriority: 5 },
    MyList: { type: 'numbering', name: 'My List' },
  },
};

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', attrs: { styleId: { default: null }, numbering: { default: null } } },
    heading: { group: 'block', content: 'text*', attrs: { level: { default: 1 }, styleId: { default: null }, numbering: { default: null } } },
    text: {},
  },
  marks: { textStyle: { attrs: { charStyle: { default: null } } } },
});
const strong = schema.marks.textStyle.create({ charStyle: 'Strong' });
const doc = schema.node('doc', null, [
  schema.node('heading', { level: 1 }, [schema.text('Head')]),
  schema.node('paragraph', null, [schema.text('a '), schema.text('bold', [strong]), schema.text(' b')]),
  schema.node('heading', { level: 1 }, [schema.text('Two')]),
  schema.node('paragraph', { styleId: 'Title' }, []),
]);

test('Recommended hides semi-hidden styles until used; In use, In current document and All', () => {
  const ids = (show, counts = usage(doc)) => filterStyles(styles, counts, { show, pane: true }).map((s) => s.id);
  const rec = ids('recommended', {});
  assert.ok(rec.includes('Normal') && rec.includes('Heading1') && rec.includes('Title'));
  assert.ok(!rec.includes('Heading3') && !rec.includes('Hidden1') && !rec.includes('Hyperlink'), 'semi-hidden left out');
  assert.ok(!rec.includes('TableGrid') && !rec.includes('MyList'), 'the pane leaves out table and list styles');
  assert.ok(ids('recommended', { Heading3: 1 }).includes('Heading3'), 'a hide-until-used style shows once used');
  assert.ok(ids('recommended', { Heading1: 1 }).includes('Heading2'), 'Show next heading when previous level is used');
  assert.deepEqual(ids('inUse').sort(), ['Heading1', 'Normal', 'Strong', 'Title']);
  assert.ok(ids('inDocument').includes('Linked1') && !ids('inDocument').includes('Quote'));
  assert.ok(ids('all').includes('Hidden1') && ids('all').includes('Quote'));
});

test('a linked style stands for its character half in the pane (by link or by the <id>Char name)', () => {
  const s = { ...styles, list: { ...styles.list, Linked1Char: { type: 'character', name: 'Linked One Char' }, Heading2Char: { type: 'character', name: 'Heading 2 Char' } } };
  const shown = filterStyles(s, {}, { show: 'all', pane: true });
  const ids = shown.map((x) => x.id);
  assert.ok(!ids.includes('Linked1Char') && !ids.includes('Heading2Char') && ids.includes('Heading2'));
  assert.equal(kindOf(shown.find((x) => x.id === 'Heading2')), 'linked');
});

test('the five sorts', () => {
  const list = filterStyles(styles, {}, { show: 'all', pane: true });
  const order = (sort) => sortStyles(list, sort, styles).map((s) => s.id);
  const rec = order('recommended');
  assert.deepEqual(rec.slice(0, 3), ['Normal', 'DefaultParagraphFont', 'NoSpacing'], 'uiPriority, then name');
  assert.ok(rec.indexOf('Heading1') < rec.indexOf('Heading2') && rec.indexOf('Heading9') < rec.indexOf('Title'));
  const az = order('name').map((id) => nameOf(infoOf(id, styles.list[id])));
  assert.deepEqual(az, [...az].sort((a, b) => a.localeCompare(b)));
  const byType = order('type');
  assert.ok(byType.indexOf('Quote') < byType.indexOf('Strong'), 'paragraph styles before character styles');
  const font = order('font');
  assert.ok(font.indexOf('Heading1') < font.indexOf('Normal'), '+major sorts before +minor');
  const based = order('basedOn');
  assert.equal(based[0], 'DefaultParagraphFont', 'no base sorts first');
});

test('type marks of paragraph, character, linked, table and list styles', () => {
  assert.equal(typeMark(infoOf('Normal', styles.list.Normal)), '¶');
  assert.equal(typeMark(infoOf('Strong', styles.list.Strong)), 'a');
  assert.equal(typeMark(infoOf('Linked1', styles.list.Linked1)), '¶a');
  assert.equal(typeMark(infoOf('Linked1', styles.list.Linked1), { noLinked: true }), '¶');
  assert.equal(kindOf(infoOf('TableGrid', styles.list.TableGrid)), 'table');
  assert.equal(typeMark(infoOf('MyList', styles.list.MyList)), '☰');
});

test('descriptions: Normal and a direct-formatted run', () => {
  const normal = styleDescription(styles, 'Normal', { unit: 'cm', theme: THEME });
  assert.match(normal, /^Font: \+Body \(Aptos\), Size: 12 pt/);
  assert.match(normal, /Line spacing: Multiple 1\.16 li/);
  assert.match(normal, /Space after: 8 pt/);
  assert.match(normal, /Style: Show in the Styles gallery, Priority: 1$/);
  const h1 = styleDescription(styles, 'Heading1', { theme: THEME });
  assert.match(h1, /Font color: Accent 1, Darker 25%/);
  assert.match(h1, /Based on: Normal, Following style: Normal/);
  const rows = runRows({ bold: true, size: 14, color: '#FF0000', spacing: -0.5 });
  assert.deepEqual(rows.map((r) => `${r.label}: ${r.value}`), ['Size: 14 pt', 'Bold: Bold', 'Font color: #FF0000', 'Character spacing: Condensed by 0.5 pt']);
});

test('Reveal Formatting sections and the compare diff', () => {
  const fmt = (run, para) => ({
    run: layered([['style', { font: '+minor', size: 12 }], ['direct', run]]),
    para: layered([['style', { spacing: { after: 8 } }], ['direct', para]]),
    styleId: 'Normal', charStyle: null, list: null,
    sect: { w: 595.3, h: 841.9, orient: 'portrait', margin: { top: 72, right: 72, bottom: 72, left: 72 } },
  });
  const a = revealSections(fmt({}, {}), { unit: 'cm', theme: THEME, styles });
  assert.deepEqual(a.map((s) => s.id), ['font', 'paragraph', 'list', 'section']);
  assert.deepEqual(a.map((s) => s.dialog), ['font', 'paragraph', 'defineNewNumberFormat', 'pageSetup']);
  const size = a[0].rows.find((r) => r.key === 'size');
  assert.equal(size.value, '12 pt');
  assert.equal(size.source, 'style');
  assert.equal(a[3].rows[0].value, 'Left: 2.54 cm, Right: 2.54 cm, Top: 2.54 cm, Bottom: 2.54 cm');
  const b = revealSections(fmt({ bold: true, size: 16 }, { textAlign: 'center' }), { unit: 'cm', theme: THEME, styles });
  assert.equal(b[0].rows.find((r) => r.key === 'size').source, 'direct');
  const d = diffSections(a, b);
  assert.deepEqual(d[0].rows.map((r) => r.value), ['12 pt -> 16 pt', '(none) -> Bold']);
  assert.deepEqual(d[1].rows.map((r) => r.value), ['(none) -> Centered']);
  assert.equal(d[3].rows.length, 0);
});

test('Recommend: Move Up, Make Last and Assign Value 5 set uiPriority; Show and Hide; Restrict sets locked', () => {
  assert.deepEqual(recommendPatch(styles, ['Heading2'], 'up'), { Heading2: { uiPriority: 8 } });
  assert.deepEqual(recommendPatch(styles, ['Normal'], 'up'), { Normal: { uiPriority: 0 } });
  assert.deepEqual(recommendPatch(styles, ['Title', 'Quote'], 'last'), { Title: { uiPriority: 99 }, Quote: { uiPriority: 99 } });
  assert.deepEqual(recommendPatch(styles, ['Quote'], { value: 5 }), { Quote: { uiPriority: 4 } });
  assert.deepEqual(recommendPatch(styles, ['Heading3'], 'show'), { Heading3: { semiHidden: false, unhideWhenUsed: false } });
  const patched = patchStyles(styles, recommendPatch(styles, ['Heading2'], 'up'));
  assert.equal(patched.list.Heading2.name, 'heading 2', 'the patch keeps the style');
  const order = sortStyles(filterStyles(patched, {}, { show: 'all', pane: true }), 'recommended', patched).map((s) => s.id);
  assert.ok(order.indexOf('Heading2') < order.indexOf('Heading1'), 'Move Up changes the order');
  assert.deepEqual(restrictPatch(['Title'], true), { Title: { locked: true } });
});

test('the instance finder: a paragraph style and a character style', () => {
  assert.deepEqual(instancesOf(doc, 'Heading1'), [{ from: 1, to: 5 }, { from: 17, to: 20 }]);
  assert.deepEqual(instancesOf(doc, 'Strong'), [{ from: 9, to: 13 }]);
  assert.deepEqual(instancesOf(doc, 'Title'), [{ from: 22, to: 22 }]);
  assert.deepEqual(usage(doc), { Heading1: 2, Normal: 1, Strong: 1, Title: 1 });
});

test('delete and Organizer copy keep the list consistent', () => {
  const del = withoutStyle({ list: { Normal: {}, A: { basedOn: 'Normal' }, B: { basedOn: 'A', next: 'A' } } }, 'A');
  assert.deepEqual(del.list.B, { basedOn: 'Normal', next: 'B' });
  const cp = withCopies({ list: { Normal: {} } }, { X: { type: 'paragraph', name: 'X', basedOn: 'Missing', next: 'Normal' } });
  assert.equal(cp.list.X.basedOn, 'Normal');
});
