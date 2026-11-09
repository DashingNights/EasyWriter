// engine-gaps-styles (docs/plans/engine/stage2b.md): the conversions between the engine's style sheet and the DOM editor's form
// that the style panes and dialogs read and write on a canvas draft, the Borders and Shading, Format Text Effects and typography
// mappings, and the rows that open them. The harness case engine-gaps-styles runs them in the app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { HOME } from '../src/document/canvas/rows/home.mjs';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import { canvasRead, canvasSteps, edgeOfEngine } from '../src/document/wp/borders/canvas.mjs';
import { effectsOfEngine, textEffectsParams, typographyProps, charPropsOf } from '../src/document/wp/font/run.mjs';
import { canvasEd, stylesSteps } from '../src/document/wp/style-panes/canvas-ed.mjs';
import { chrOfRun, defineSteps, hexOf, ppOfPara, runOfChr, stylesOfSheet, themeOfSettings } from '../src/document/wp/styles/engine.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const J = JSON.parse;

/** A fresh engine on a small document → {run(id, args) → value, e}. */
function engine(text = 'One\nTwo') {
  const e = new Engine();
  e.open(new TextEncoder().encode(text), 'txt');
  const run = (id, args = {}) => {
    const r = J(e.exec(id, JSON.stringify(args)));
    assert.ok(r.ok, `${id}: ${r.error}`);
    return r.value;
  };
  return { e, run };
}

test('the engine sheet reads as the DOM editor\'s styles and a style written back keeps its formatting', () => {
  const { run } = engine();
  const styles = stylesOfSheet(run('styles.get'));
  const h1 = styles.list.Heading1;
  assert.equal(h1.type, 'paragraph');
  assert.equal(h1.link, 'Heading1Char');
  assert.equal(h1.run.font, 'Aptos Display');
  assert.equal(h1.run.color, '#0F4761');
  assert.equal(h1.para.keepNext, true);
  assert.equal(h1.para.outline, 0);
  // A new style in the DOM form goes in through styles.define and reads back the same.
  const next = { ...styles, list: { ...styles.list, Note: { type: 'paragraph', name: 'Note', basedOn: 'Normal', run: { bold: true, size: 9, color: '#C00000' },
    para: { textAlign: 'center', spacing: { after: 4, line: { rule: 'auto', value: 1.5 } }, indent: { left: 18 } } } } };
  for (const [id, args] of defineSteps(styles, next)) run(id, args);
  const back = stylesOfSheet(run('styles.get')).list.Note;
  assert.deepEqual(back.run, { bold: true, size: 9, color: '#C00000' });
  assert.equal(back.para.textAlign, 'center');
  assert.deepEqual(back.para.spacing, { after: 4, line: { rule: 'auto', value: 1.5 } });
  assert.deepEqual(back.para.indent, { left: 18 });
});

test('Modify Style OK keeps what the dialog does not show: a numbered, right-to-left heading keeps its numbering and bidi', () => {
  const { run } = engine();
  run('styles.define', { style: 'Heading1', para: { numbering: { num: 1, level: 0 }, bidi: true } });
  const styles = stylesOfSheet(run('styles.get'));
  // OK with no change sends nothing; a colour change sends only the colour.
  assert.deepEqual(defineSteps(styles, { ...styles, list: { Heading1: structuredClone(styles.list.Heading1) } }), []);
  const h1 = styles.list.Heading1;
  const steps = defineSteps(styles, { ...styles, list: { Heading1: { ...h1, run: { ...h1.run, color: '#C00000' } } } });
  assert.deepEqual(steps, [['styles.define', { style: 'Heading1', chr: { color: 'C00000' } }]]);
  for (const [id, args] of steps) run(id, args);
  const back = run('styles.get', { style: 'Heading1' });
  assert.deepEqual([back.para.numbering, back.para.bidi], [{ num: 1, level: 0 }, true]);
  assert.equal(stylesOfSheet(run('styles.get')).list.Heading1.run.color, '#C00000');
  // A built-in style keeps its name: a new one is its alias, as Word writes 'Heading 1,Chapter'.
  run('styles.define', { style: 'Heading1', name: 'Chapter' });
  const renamed = stylesOfSheet(run('styles.get')).list.Heading1;
  assert.deepEqual([renamed.name, renamed.aliases], ['Heading 1', 'Chapter']);
});

test('the canvas stand-in reads the engine back and says so when the engine refuses a write', async () => {
  const sheet = { defaults: {}, styles: [{ id: 'Normal', name: 'Normal', type: 'paragraph' }] };
  let said = null;
  const ed = canvasEd({ execMany: async () => ({ ok: false, error: 'a style named `Normal` already exists' }), exec: async () => ({ ok: true, value: sheet }) },
    { styles: stylesOfSheet(sheet), theme: null }, {}, (e) => (said = e));
  ed.chain().command(({ tr }) => {
    tr.setDocAttribute('styles', { list: { ...tr.doc.attrs.styles.list, Mine: { type: 'paragraph', name: 'Normal' } } });
    return true;
  }).run();
  assert.ok(ed.state.doc.attrs.styles.list.Mine, 'the dialog reads its own write at once');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(said, 'a style named `Normal` already exists');
  assert.equal(ed.state.doc.attrs.styles.list.Mine, undefined, 'the refused write is read back out');
});

test('a changed style sends only the fields that changed, and a dropped one is deleted', () => {
  const a = { defaults: { run: { size: 12 }, para: {} }, list: { Normal: { type: 'paragraph', name: 'Normal' },
    Mine: { type: 'paragraph', name: 'Mine', run: { bold: true }, uiPriority: 5 }, Gone: { type: 'character', name: 'Gone' } } };
  const b = { defaults: { run: { size: 13 }, para: {} }, list: { Normal: a.list.Normal, Mine: { ...a.list.Mine, uiPriority: 2, semiHidden: true, unhideWhenUsed: true } } };
  const steps = stylesSteps(a, b);
  assert.deepEqual(steps[0], ['styles.define', { style: 'Mine', hidden: true, unhideWhenUsed: true, priority: 2 }]);
  assert.deepEqual(steps[1], ['styles.delete', { style: 'Gone' }]);
  assert.equal(steps[2][0], 'styles.setDefaults');
  assert.equal(steps[2][1].chr.size, 13);
  assert.equal(steps[2][1].para, undefined);
});

test('the canvas stand-in turns a dialog\'s transaction into engine steps and reads its own write', async () => {
  const sent = [];
  const ed = canvasEd({ execMany: async (s) => (sent.push(s), { ok: true }) }, { styles: { list: { Normal: { type: 'paragraph', name: 'Normal' } } }, theme: null },
    { Normal: 3 });
  ed.chain().command(({ tr }) => {
    tr.setDocAttribute('styles', { list: { ...tr.doc.attrs.styles.list, New: { type: 'character', name: 'New', run: { italic: true } } } });
    return true;
  }).run();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][0][1], { style: 'New', name: 'New', type: 'character', chr: { italic: true } });
  assert.ok(ed.state.doc.attrs.styles.list.New);
  assert.deepEqual(ed.state.doc.counts, { Normal: 3 });
});

test('engine character and paragraph props convert both ways', () => {
  const run = runOfChr({ font: 'Georgia', size: 14, bold: true, underline: 'double', underlineColor: [255, 0, 0], color: { Rgb: [0, 32, 96] },
    highlight: 'brightGreen', vertAlign: 'superscript', hidden: true, numForm: 'oldStyle', stylisticSet: 4, ligatures: { standard: true } });
  assert.equal(run.underline.val, 'double');
  assert.equal(run.underline.color, '#FF0000');
  assert.equal(run.color, '#002060');
  assert.equal(run.highlight, 'green');
  assert.equal(run.superscript, true);
  assert.equal(run.vanish, true);
  assert.deepEqual(run.typography, { ligatures: 'standard', numForm: 'oldStyle', stylisticSet: 4 });
  const chr = chrOfRun(run);
  assert.equal(chr.font, 'Georgia');
  assert.equal(chr.highlight, 'brightGreen');
  assert.equal(chr.underline, 'double');
  assert.equal(chr.vertAlign, 'superscript');
  assert.equal(chr.numForm, 'oldStyle');
  assert.equal(chr.stylisticSet, 4);
  assert.equal(chrOfRun({ bold: true }).vertAlign, undefined, 'a style that names no position leaves it unset');
  const pp = ppOfPara({ textAlign: 'right', spacing: { before: 6, line: { rule: 'exact', value: 14 } }, borders: { top: { style: 'single', width: 1, color: '#00FF00' } },
    shading: { val: 'clear', fill: '#FFFF00' } });
  assert.deepEqual(pp.lineSpacing, { rule: 'exactly', value: 14 });
  assert.equal(pp.align, 'right');
  assert.deepEqual(pp.borders, { top: { style: 'single', width: 1, space: 0, color: '00FF00' } });
  assert.equal(pp.shading, 'FFFF00');
  assert.equal(hexOf([1, 2, 255]), '#0102FF');
});

test('document.settings reads as the DOM theme', () => {
  const { run } = engine();
  const t = themeOfSettings(run('document.settings'));
  assert.equal(t.fonts.major, 'Aptos Display');
  assert.equal(t.colors.accent1, '#156082');
  assert.equal(t.colors.dk1, '#000000');
});

test('Number forms, spacing and stylistic sets go to format.set and show in format.state (G41)', () => {
  const { run } = engine('0123456789');
  run('select.all');
  run('format.set', { props: charPropsOf({ typography: { numForm: 'oldStyle', numSpacing: 'tabular', stylisticSet: 2, contextual: true } }) });
  const fs = run('format.state');
  assert.deepEqual([fs.numForm, fs.numSpacing, fs.stylisticSet, fs.contextualAlternates], ['oldStyle', 'tabular', 2, true]);
  assert.deepEqual(typographyProps({ numForm: null, stylisticSet: null }), { numForm: 'default', stylisticSet: 0 });
  const row = HOME['home.font.textEffectsAndTypography.numberStyles'];
  assert.deepEqual(row.args('proportionalLining'), { props: { numSpacing: 'proportional', numForm: 'lining' } });
  assert.equal(row.value({ value: { numSpacing: 'tabular', numForm: 'oldStyle' } }), 'tabularOldStyle');
  // The .docx keeps them (w14:numForm, w14:numSpacing, w14:stylisticSets, w14:cntxtAlts).
  const { e } = engine('0123456789');
  e.exec('select.all', '{}');
  e.exec('format.set', JSON.stringify({ props: { numForm: 'lining', stylisticSet: 7 } }));
  const again = new Engine();
  again.open(e.save('docx'), 'docx');
  again.exec('select.all', '{}');
  const back = J(again.exec('format.state', '{}')).value;
  assert.deepEqual([back.numForm, back.stylisticSet], ['lining', 7]);
});

test('Format Text Effects maps the engine\'s effects to the dialog\'s and its changes to format.textEffects', () => {
  const e = effectsOfEngine({ fill: { type: 'solid', color: [255, 0, 0] }, outline: { color: [0, 0, 0], width: 1 }, shadow: { color: [0, 0, 0], transparency: 40,
    blur: 4, distance: 3, angle: 45 }, glow: { color: [0, 0, 255], size: 5, transparency: 60 } });
  assert.deepEqual(e.fill, { type: 'solid', color: '#FF0000' });
  assert.equal(e.shadow.alpha, 0.6);
  assert.equal(e.glow.alpha, 0.4);
  const p = textEffectsParams({ fill: { type: 'gradient', angle: 90, stops: [{ pos: 0, color: '#FFFFFF' }, { pos: 100, color: '#156082' }] }, outline: null,
    shadow: { color: '#000000', alpha: 0.6, blur: 4, dist: 3, angle: 45 } });
  assert.deepEqual(p.fill, { gradient: ['FFFFFF', '156082'], angle: 90 });
  assert.equal(p.outline, 'none');
  assert.equal(p.shadow.transparency, 40);
  const { run } = engine('Effects');
  run('select.all');
  run('format.textEffects', textEffectsParams({ fill: { type: 'solid', color: '#00B050' } }));
  assert.equal(effectsOfEngine(run('format.state').textEffects).fill.color, '#00B050');
});

test('Borders and Shading reads the engine and writes engine steps, the page border with art and placement', () => {
  const read = canvasRead({ fs: { borderDetail: null, shading: null }, ps: { borders: { top: { style: 'double', width: 1.5, color: [0, 0, 0], space: 1 } } },
    context: null, pages: { sides: { top: { style: { art: 'apples' }, width: 20, space: 24 } }, measureFrom: 'text', display: 'firstPage', behind: true },
    kind: 'paras', paras: 2 });
  assert.deepEqual(read.read.paragraph.borders.top, { style: 'double', width: 1.5, color: '#000000', space: 1 });
  assert.equal(read.page.top.style, 'apples');
  assert.equal(read.page.offsetFrom, 'text');
  assert.equal(edgeOfEngine({ style: 'none' }), null);
  const box = { style: 'single', width: 0.5, color: null, space: 1 };
  const steps = canvasSteps({
    touched: { b: true, p: true, s: true },
    b: { apply: 'paragraph', borders: { top: box, bottom: box } },
    s: { apply: 'paragraph' },
    p: { apply: 'first', borders: { top: { style: 'apples', width: 16 } }, space: { top: 10, left: 24, bottom: 24, right: 24 }, offsetFrom: 'page', front: true },
  }, { val: 'clear', fill: '#FFFF00' });
  assert.deepEqual(steps[0], ['para.borders', { sides: { top: { style: 'single', width: 0.5, space: 1 }, bottom: { style: 'single', width: 0.5, space: 1 } } }]);
  assert.deepEqual(steps[1], ['para.shading', { color: 'FFFF00' }]);
  assert.equal(steps[2][0], 'design.pageBorders');
  assert.deepEqual(steps[2][1].sides.top, { style: 'apples', width: 16, space: 10 });
  assert.equal(steps[2][1].display, 'firstPage');
  assert.equal(steps[2][1].measureFrom, 'edge');
  // The engine takes them.
  const { run } = engine();
  run('select.all');
  for (const [id, args] of steps) run(id, args);
  assert.equal(run('para.state').borders.top.style, 'single');
  assert.equal(run('para.state').shading[0], 255);
});

test('the style rows open their dialogs with the engine\'s styles and Set As Default writes the defaults', async () => {
  for (const id of ['home.styles.styles.createAStyle', 'styles.modify', 'x.styles.rename', 'styles.manage', 'styles.organizer', 'font.setAsDefault',
    'paragraph.setAsDefault', 'home.paragraph.borders.bordersAndShading', 'home.font.phoneticGuide', 'font.textEffects']) {
    assert.equal(formOf(HOME[id]), 'spec', id);
  }
  const { e, run } = engine();
  const client = { exec: async (id, args) => J(e.exec(id, JSON.stringify(args ?? {}))), execMany: async (s) => J(e.execMany(JSON.stringify(s))) };
  const opened = [];
  const ctx = { engine: client, engineState: {}, stateOf: () => undefined, read: () => null, toast: () => {},
    dialog: async (name, props) => (opened.push([name, props]), name === 'styleSetAsDefault' ? 'doc' : null) };
  await HOME['styles.modify'].run(ctx, 'Heading1');
  assert.equal(opened[0][0], 'modifyStyle');
  assert.equal(opened[0][1].styleId, 'Heading1');
  assert.equal(opened[0][1].engineStyles.list.Heading1.name, 'Heading 1');
  await HOME['font.setAsDefault'].run(ctx, { font: 'Georgia', size: 13 });
  await HOME['paragraph.setAsDefault'].run(ctx, { spacing: { after: 9 } });
  const d = run('styles.get').defaults;
  assert.deepEqual([d.chr.font, d.chr.size, d.para.spaceAfter], ['Georgia', 13, 9]);
});

test('Fit Text and Horizontal in Vertical go to the engine as run properties and show in format.state (G33)', () => {
  const { run } = engine('Fit these words');
  run('select.all');
  run('format.set', { props: { fitText: { width: 144, id: 3 }, eastAsianLayout: { vert: true, vertCompress: true } } });
  const fs = run('format.state');
  assert.deepEqual(fs.fitText, { width: 144, id: 3 });
  assert.equal(fs.eastAsianLayout.vert, true);
  run('format.set', { props: { fitText: { width: 0 } } });
  assert.equal(run('format.state').fitText, null, 'width 0 takes it off');
  const row = HOME['home.paragraph.asianLayout.fitText'];
  assert.equal(formOf(row), 'spec');
});
