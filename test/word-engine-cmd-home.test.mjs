// engine-cmd-home (docs/plans/engine/stage2.md, S1 Home): the Home rows' translations from the app's ids to the engine's, where a
// straight pass-through would give a wrong result without an error (stage2.md's risks), and the Font and Paragraph dialogs'
// mapping to format.set and para.set. The harness case engine-cmd-home runs them against the engine.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HIGHLIGHTS } from '../src/office.mjs';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import { appLevel, CASE, fontName, highlightOf, HOME, hooks, levelOf, pasteStep, pickLevel, SPACINGS } from '../src/document/canvas/rows/home.mjs';
import { MULTILEVEL } from '../src/document/numbering.mjs';
import { charPropsOf, LIGATURE_FLAGS, runOfEngine } from '../src/document/wp/font/run.mjs';
import { paraOfEngine, paraPropsOf } from '../src/document/wp/paragraph/rules.mjs';

/** A fake canvas ctx whose engine records the calls. */
function fakeCtx(engineState = {}) {
  const calls = [];
  const engine = {
    exec: async (id, args) => (calls.push([id, args]), { ok: true, value: null }),
    execMany: async (steps) => (calls.push(['many', steps]), { ok: true }),
    selection: async () => ({ anchor: { path: [0], off: 0 }, head: { path: [0], off: 3 } }),
  };
  return { calls, ctx: { engine, engineState, stateOf: (id) => engineState[id], toast: () => {}, dialog: async () => null, run: () => false, read: () => null } };
}
const runRow = async (id, arg, state, dialog) => {
  const { calls, ctx } = fakeCtx(state);
  if (dialog) ctx.dialog = async (name, props) => dialog(name, props);
  const row = HOME[id];
  if (typeof row === 'string') await ctx.engine.exec(row, arg ?? {});
  else if (row.exec) await ctx.engine.exec(row.exec, typeof row.args === 'function' ? row.args(arg, ctx) : row.args ?? arg ?? {});
  else await row.run(ctx, arg);
  return calls;
};

test('every Home row is one of the row forms', () => {
  for (const [id, row] of Object.entries(HOME)) assert.ok(formOf(row), id);
  assert.ok(Object.keys(HOME).length >= 210);
});

test('the app highlight names go to the engine as they are (OOXML names, which format.highlight reads first)', () => {
  for (const app of Object.keys(HIGHLIGHTS)) assert.equal(highlightOf(app), app);
  assert.equal(highlightOf(null), 'none');
  assert.equal(highlightOf('brightGreen'), 'none'); // never the engine's own names: its green is a different colour
});

test('a highlight pick over a selection sends the engine name', async () => {
  assert.deepEqual(await runRow('home.font.textHighlightColor', 'green'), [['format.highlight', { color: 'green' }]]);
  assert.deepEqual(await runRow('home.font.textHighlightColor', 'darkGreen'), [['format.highlight', { color: 'darkGreen' }]]);
});

test('Change Case, underline and line spacing items translate', async () => {
  assert.deepEqual(await runRow('home.font.changeCase.capitalizeEachWord'), [['format.changeCase', { mode: 'title' }]]);
  assert.deepEqual(await runRow('home.font.changeCase', 'tOGGLECASE'), [['format.changeCase', { mode: 'toggle' }]]);
  assert.deepEqual(await runRow('home.font.changeCase'), [['format.changeCase', {}]]);
  assert.equal(Object.keys(CASE).length, 7);
  assert.deepEqual(await runRow('home.font.underline', 'dottedUnderline'), [['format.underline', { style: 'dotted' }]]);
  assert.deepEqual(await runRow('home.font.underline', 'noUnderline'), [['format.underline', { value: false }]]);
  assert.deepEqual(await runRow('home.font.underline'), [['format.underline', {}]]);
  assert.deepEqual(await runRow('home.paragraph.lineAndParagraphSpacing.115'), [['para.lineSpacing', { value: 1.15 }]]);
  assert.deepEqual(await runRow('home.paragraph.lineAndParagraphSpacing', '20'), [['para.lineSpacing', { value: SPACINGS[20] }]]);
  assert.deepEqual(await runRow('home.font.textEffectsAndTypography.ligatures', 'standardContextual'),
    [['format.set', { props: { ligatures: LIGATURE_FLAGS.standardContextual } }]]);
});

test('the pressed states read the engine state entries', () => {
  const fs = { 'format.state': { value: { underlineStyle: 'double', doubleStrike: true, scale: 150 } } };
  assert.equal(HOME['font.doubleUnderline'].active(fs['format.state']), true);
  assert.equal(HOME['font.wordUnderline'].active(fs['format.state']), false);
  assert.equal(HOME['font.doubleStrikethrough'].active(fs['format.state']), true);
  assert.equal(HOME['home.font.underline'].value(fs['format.state']), 'doubleUnderline');
  assert.equal(HOME['home.paragraph.asianLayout.characterScaling.150'].active(fs['format.state']), true);
  const ps = { value: { lineSpacing: { rule: 'multiple', value: 1.15 } } };
  assert.equal(HOME['home.paragraph.lineAndParagraphSpacing.115'].active(ps), true);
  assert.equal(HOME['home.paragraph.lineAndParagraphSpacing'].value(ps), '115');
  const list = { 'document.context': { value: { list: { num: 3, level: 1, numbered: false } } } };
  assert.equal(HOME['home.paragraph.bullets'].active({ engineState: list }), true);
  assert.equal(HOME['home.paragraph.numbering'].active({ engineState: list }), false);
});

test('the list galleries change the caret list in place, else start one', async () => {
  const inList = { 'document.context': { value: { list: { num: 3, level: 1, numbered: false } } } };
  const [[id, args]] = await runRow('home.paragraph.bullets', 'hollowArrow', inList);
  assert.equal(id, 'list.define');
  assert.equal(args.num, 3);
  assert.deepEqual(args.levels[1], { format: 'bullet', text: '➢' }); // a Wingdings bullet goes in as its Unicode character
  assert.deepEqual((await runRow('home.paragraph.numbering', 'lowerRomanRight'))[0], ['list.define', { levels: [pickLevel('number', 'lowerRomanRight')] }]);
  assert.deepEqual(pickLevel('number', 'upperRomanRight'), { format: 'upperRoman', text: '%1.', align: 'right' });
  assert.deepEqual(await runRow('home.paragraph.bullets'), [['para.bullets', {}]]);
  assert.deepEqual(await runRow('home.paragraph.multilevelList', 'lib:headings'), [['list.multilevelPreset', { preset: 'headings' }]]);
  const outline = levelOf(MULTILEVEL.find((m) => m.id === 'outline').levels[1]);
  assert.equal(outline.format, 'decimal');
  assert.equal(outline.text, '%1.%2.');
  assert.ok(outline.indentAt > outline.alignedAt);
});

test('fonts, paste options and borders pick the engine forms', async () => {
  assert.equal(fontName('recent:Arial'), 'Arial');
  assert.equal(fontName('+major'), 'Aptos Display');
  const d = { text: 'a', html: '<b>a</b>', rtf: '', image: 'data:image/png;base64,QUJD' };
  assert.deepEqual(pasteStep('keepTextOnly', d), ['edit.pasteText', { text: 'a' }]);
  assert.deepEqual(pasteStep('mergeFormatting', d), ['edit.pasteMerge', { text: 'a', html: '<b>a</b>', rtf: undefined }]);
  assert.deepEqual(pasteStep('picture', d), ['edit.pasteSpecial', { as: 'picture', picture: 'QUJD' }]);
  // A selection inside one paragraph takes a character border; a table cell, the table's borders.
  assert.deepEqual(await runRow('home.paragraph.borders', 'bottomBorder'), [['format.border', { value: true }]]);
  const cells = { 'document.context': { value: { table: { path: [1], row: 0, cell: 0 } } } };
  const [[id, args]] = await runRow('home.paragraph.borders', 'outsideBorders', cells);
  assert.equal(id, 'table.borders');
  assert.equal(args.kind, 'outside');
});

test('the Font dialog reads format.state and writes format.set', () => {
  const r = runOfEngine({ font: 'Arial', size: 14, bold: true, color: 'FF0000', underlineStyle: 'double', underlineColor: 'auto', doubleStrike: true,
    hidden: true, scale: 90, ligatures: { standard: true, contextual: true } });
  assert.equal(r.color, '#FF0000');
  assert.deepEqual(r.underline, { val: 'double', color: null });
  assert.equal(r.typography.ligatures, 'standardContextual');
  assert.deepEqual(charPropsOf({ dstrike: false, vanish: false, superscript: true, color: null, underline: { val: 'wave', color: '#00FF00' }, size: 20 }),
    { doubleStrike: false, hidden: false, vertAlign: 'superscript', color: 'auto', underline: 'wave', underlineColor: '00FF00', size: 20 });
  // The Latin font leaves the complex script font alone; Headings and Body come from the theme.
  assert.deepEqual(charPropsOf({ font: '+minor' }), { font: 'Aptos' });
  assert.deepEqual(charPropsOf({ font: 'Arial', fontCS: 'Times New Roman' }), { font: 'Arial', fontCs: 'Times New Roman' });
  // A toggle on part of the selection shows mixed (null), the rest as they are.
  const mixed = runOfEngine({ bold: false, italic: true, mixed: ['bold'] });
  assert.equal(mixed.bold, null);
  assert.equal(mixed.italic, true);
  assert.equal(mixed.strike, false);
});

test('the Paragraph dialog reads para.state and writes para.set', () => {
  const p = paraOfEngine({ align: 'center', indentLeft: 36, indentFirst: -18, spaceBefore: 6, spaceAfter: 8, lineSpacing: { rule: 'exactly', value: 20 },
    keepNext: true, outlineLevel: 1 });
  assert.equal(p.textAlign, 'center');
  assert.deepEqual(p.spacing.line, { rule: 'exact', value: 20 });
  assert.equal(p.indent.firstLine, -18);
  assert.deepEqual(paraPropsOf({ textAlign: 'right', indent: { firstLine: null }, spacing: { line: { rule: 'auto', value: 1.5 }, before: 12, beforeAuto: null } }),
    { align: 'right', indentFirst: 0, lineSpacing: { rule: 'multiple', value: 1.5 }, spaceBefore: 12, spaceBeforeAuto: false });
});

test('the Spike, Paste All and Clear All use the app ring and Spike (stage2.md Decisions)', async () => {
  const added = [];
  const ring = [{ id: 'c2', html: '<b>new</b>', text: 'new' }, { id: 'c1', html: '', text: '', image: 'data:image/png;base64,QUJD' }];
  Object.assign(hooks, { spikeAdd: async (p) => added.push(p), ringItems: () => ring,
    spikeInsert: async (paste) => paste({ html: '<p>cut</p>', text: 'cut' }) });
  assert.deepEqual(await runRow('editing.spike'), [['edit.spike', {}]]);
  assert.deepEqual(added, [{ html: '', text: '' }]);
  assert.deepEqual(await runRow('editing.insertSpike'), [['edit.paste', { html: '<p>cut</p>', text: 'cut' }]]);
  // Paste All: oldest first, as one undo step; a picture alone pastes as a picture.
  assert.deepEqual(await runRow('x.clipboard.pasteAll'), [['many', [['edit.pasteSpecial', { as: 'picture', picture: 'QUJD' }],
    ['edit.paste', { text: 'new', html: '<b>new</b>', rtf: undefined }]]]]);
  assert.equal(HOME['x.clipboard.pasteAll'].enabled(), true);
});

test('Set Numbering Value and Adjust List Indents work on the caret list', async () => {
  const at = { 'document.context': { value: { list: { num: 4, level: 1, numbered: true } } } };
  const calls = await runRow('home.paragraph.numbering.setNumberingValue', undefined, at, () => ({ mode: 'start', value: 7 }));
  assert.deepEqual(calls.at(-1), ['para.setNumberingValue', { value: 7 }]);
  assert.equal(HOME['home.paragraph.numbering.setNumberingValue'].enabled({ engineState: {} }), false);
  const engineLevel = { format: 'decimal', text: '%1.', start: 1, align: 'left', alignedAt: 18, indentAt: 36, follow: 'tab', tabAt: null };
  assert.deepEqual(levelOf(appLevel(engineLevel)), { format: 'decimal', text: '%1.', start: 1, align: 'left', indentAt: 36, alignedAt: 18, follow: 'tab' });
});
