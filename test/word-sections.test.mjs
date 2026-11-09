// Section breaks and page setup (docs/plans/word/briefs/sections.md): break insertion and its sect copy, the merge on delete, margin
// rotation, presets and their descriptions, Apply to and its break transforms, the dialog's limits and Blank Page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { defaultSect } from '../src/document/defaults.mjs';
import { sectionsOf } from '../src/document/model/sections.mjs';
import { documentExtensions } from '../src/document/schema.js';
import {
  applyPageSetup, applyToOptions, checkSetup, insertBlankPage, insertSectionBreak, MARGIN_PRESETS, marginDesc, orientSect, paperDesc, paperOf,
  presetOf, sizeSect, syncKinds, touched,
} from '../src/document/wp/sections/model.mjs';

const schema = getSchema(documentExtensions(50));
const p = (s) => schema.node('paragraph', null, s ? [schema.text(s)] : []);
const brk = (sect, kind = 'nextPage') => schema.node('sectionBreak', { kind, sect });
const A = { ...defaultSect(), w: 500, type: 'nextPage' };
const LAST = { ...defaultSect(), w: 700, future: 1 };
/** A transaction over `content` with the caret (or selection) at the first match of `at` (offset `off` into it). */
function trAt(content, at, off = 0, to) {
  const doc = schema.node('doc', { sect: LAST }, content);
  const find = (text, o) => {
    let hit = null;
    doc.descendants((n, pos) => {
      if (hit == null && n.isText && n.text.includes(text)) hit = pos + n.text.indexOf(text) + o;
    });
    return hit;
  };
  const from = find(at, off);
  const sel = TextSelection.create(doc, from, to == null ? from : find(to, to.length));
  return EditorState.create({ doc, selection: sel }).tr;
}
const kinds = (doc) => {
  const out = [];
  doc.forEach((n) => out.push(n.type.name === 'sectionBreak' ? `|${n.attrs.kind}|` : n.type.name === 'pageBreak' ? '---' : n.textContent));
  return out;
};

test('a section break splits the paragraph, copies the section sect and mirrors its kind in the next section', () => {
  const tr = trAt([p('one'), brk(A), p('twothree')], 'three');
  insertSectionBreak(tr, tr.selection.from, 'oddPage');
  assert.deepEqual(kinds(tr.doc), ['one', '|nextPage|', 'two', '|oddPage|', 'three']);
  const s = sectionsOf(tr.doc);
  assert.equal(s.length, 3);
  assert.equal(s[1].sect.w, 700, 'the new break holds a copy of its section sect');
  assert.equal(s[1].sect.future, 1);
  assert.equal(s[2].sect.type, 'oddPage', 'the section after it starts as the kind');
  assert.equal(s[1].sect.type ?? 'nextPage', 'nextPage');
  assert.notEqual(tr.doc.child(3).attrs.sect, tr.doc.attrs.sect, 'a copy, not a shared object');
});

test('at a paragraph start the break goes before it; in a table before the table; in columns it splits the columns', () => {
  let tr = trAt([p('one'), p('two')], 'two');
  insertSectionBreak(tr, tr.selection.from, 'continuous');
  assert.deepEqual(kinds(tr.doc), ['one', '|continuous|', 'two']);

  const table = schema.node('table', null, [schema.node('tableRow', null, [schema.node('tableCell', null, [p('cell')])])]);
  tr = trAt([p('one'), table], 'cell', 2);
  insertSectionBreak(tr, tr.selection.from, 'nextPage');
  assert.deepEqual(tr.doc.content.content.map((n) => n.type.name), ['paragraph', 'sectionBreak', 'table']);

  const cols = schema.node('columns', { count: 3 }, [p('left'), p('right')]);
  tr = trAt([cols], 'right', 2);
  insertSectionBreak(tr, tr.selection.from, 'continuous');
  const names = tr.doc.content.content.map((n) => n.type.name);
  assert.deepEqual(names, ['columns', 'sectionBreak', 'columns']);
  assert.equal(tr.doc.child(0).attrs.count, 3);
  assert.equal(tr.doc.child(2).attrs.count, 3, 'both halves keep the columns');
  assert.deepEqual([tr.doc.child(0).textContent, tr.doc.child(2).textContent], ['leftri', 'ght']);
});

test('deleting a break merges the sections: the text before takes the following settings', () => {
  const doc = schema.node('doc', { sect: LAST }, [p('one'), brk(A), p('two')]);
  const tr = EditorState.create({ doc }).tr.delete(5, 6);
  const s = sectionsOf(tr.doc);
  assert.equal(s.length, 1);
  assert.equal(s[0].sect.w, 700);
});

test('orientation swaps the paper and rotates the margins both ways', () => {
  const portrait = { ...defaultSect(), margin: { top: 10, bottom: 20, left: 30, right: 40, header: 35.4, footer: 35.4, gutter: 0 } };
  const land = orientSect(portrait, 'landscape');
  assert.deepEqual([land.orient, land.w, land.h], ['landscape', portrait.h, portrait.w]);
  assert.deepEqual([land.margin.top, land.margin.bottom, land.margin.left, land.margin.right], [30, 40, 20, 10]);
  assert.equal(land.margin.header, 35.4);
  assert.deepEqual(orientSect(land, 'portrait'), portrait);
  assert.equal(orientSect(portrait, 'portrait'), portrait);
  assert.deepEqual([sizeSect(land, 612, 792).w, sizeSect(land, 612, 792).h], [792, 612], 'a size keeps the orientation');
});

test('margin presets, their descriptions in cm and in, the Mirrored flag and the paper list', () => {
  assert.equal(marginDesc(MARGIN_PRESETS.normalMargins, 'cm'), 'Top: 2.54 cm Bottom: 2.54 cm Left: 2.54 cm Right: 2.54 cm');
  assert.equal(marginDesc(MARGIN_PRESETS.moderateMargins, 'cm'), 'Top: 2.54 cm Bottom: 2.54 cm Left: 1.91 cm Right: 1.91 cm');
  assert.equal(marginDesc(MARGIN_PRESETS.narrowMargins, 'in'), 'Top: 0.5" Bottom: 0.5" Left: 0.5" Right: 0.5"');
  assert.equal(marginDesc(MARGIN_PRESETS.wideMargins, 'cm'), 'Top: 2.54 cm Bottom: 2.54 cm Left: 5.08 cm Right: 5.08 cm');
  assert.equal(marginDesc(MARGIN_PRESETS.mirroredMargins, 'cm', true), 'Top: 2.54 cm Bottom: 2.54 cm Inside: 3.18 cm Outside: 2.54 cm');
  const sect = { ...defaultSect(), margin: { ...defaultSect().margin, ...MARGIN_PRESETS.mirroredMargins } };
  assert.equal(presetOf(sect, true), 'mirroredMargins');
  assert.equal(presetOf(sect, false), null, 'Mirrored needs the document flag');
  assert.equal(presetOf(defaultSect(), false), 'normalMargins');
  assert.equal(presetOf(defaultSect(), true), null);
  assert.equal(paperOf(defaultSect()), 'a4');
  assert.equal(paperOf(defaultSect('letter')), 'letter');
  assert.equal(paperDesc('a4', 'cm'), '21 cm x 29.7 cm');
  assert.equal(paperDesc('letter', 'cm'), '21.59 cm x 27.94 cm');
});

test('Apply to lists the choices for each selection case', () => {
  const one = trAt([p('one two')], 'one');
  assert.deepEqual(applyToOptions(one.doc, { from: 3, to: 3, empty: true }).options, ['whole', 'forward']);
  assert.deepEqual(applyToOptions(one.doc, { from: 1, to: 4, empty: false }).options, ['whole', 'selected']);
  const two = trAt([p('one'), brk(A), p('two')], 'one');
  assert.deepEqual(applyToOptions(two.doc, { from: 2, to: 2, empty: true }).options, ['section', 'forward', 'whole']);
  assert.deepEqual(applyToOptions(two.doc, { from: 2, to: 9, empty: false }).options, ['sections', 'whole']);
  assert.deepEqual(applyToOptions(two.doc, { from: 1, to: 3, empty: false }).options, ['section', 'selected', 'whole']);
  assert.deepEqual(touched(two.doc, 2, 9), [0, 1]);
  assert.deepEqual(touched(two.doc, 1, 6), [0], 'a range ending right after a break stays in its section');
});

test('This point forward puts a Next Page break before the caret paragraph and reaches only the new section', () => {
  const tr = trAt([p('one'), p('two'), p('three')], 'two', 2);
  const targets = applyPageSetup(tr, { apply: 'forward', sel: tr.selection, sect: { orient: 'landscape' } });
  assert.deepEqual(kinds(tr.doc), ['one', '|nextPage|', 'two', 'three']);
  assert.deepEqual(targets, [1]);
  const s = sectionsOf(tr.doc);
  assert.equal(s[0].sect.orient, 'portrait');
  assert.equal(s[1].sect.orient, 'landscape');
});

test('This point forward at a section start adds no break and changes that section', () => {
  const tr = trAt([p('one'), p('two')], 'one');
  const targets = applyPageSetup(tr, { apply: 'forward', sel: tr.selection, sect: { orient: 'landscape' } });
  assert.deepEqual(kinds(tr.doc), ['one', 'two']);
  assert.deepEqual(targets, [0]);
});

test('deleting a break gives the break before it the merged section kind (Word keeps the later start type)', () => {
  const doc = schema.node('doc', { sect: { ...LAST, type: 'nextPage' } }, [p('A'), brk(A, 'continuous'), p('B'), brk({ ...A, type: 'continuous' }), p('C')]);
  const state = EditorState.create({ doc });
  const del = state.apply(state.tr.delete(7, 8)); // the second break
  assert.deepEqual(kinds(del.doc), ['A', '|continuous|', 'B', 'C']);
  const fixed = del.apply(syncKinds(del));
  assert.deepEqual(kinds(fixed.doc), ['A', '|nextPage|', 'B', 'C']);
  assert.deepEqual(sectionsOf(fixed.doc).map((s) => s.sect.type), ['nextPage', 'nextPage']);
  assert.equal(syncKinds(fixed), null, 'nothing left to change');
});

test('Selected text wraps the selected blocks in Next Page breaks', () => {
  const tr = trAt([p('one'), p('two'), p('three'), p('four')], 'wo', 0, 'thr');
  const targets = applyPageSetup(tr, { apply: 'selected', sel: tr.selection, sect: { vAlign: 'center' } });
  assert.deepEqual(kinds(tr.doc), ['one', '|nextPage|', 'two', 'three', '|nextPage|', 'four']);
  assert.deepEqual(targets, [1]);
  assert.deepEqual(sectionsOf(tr.doc).map((s) => s.sect.vAlign), ['top', 'center', 'top']);
  assert.deepEqual(sectionsOf(tr.doc).map((s) => s.sect.type), ['nextPage', 'nextPage', 'nextPage']);
  // A selection at the document's start needs no break before it.
  const first = trAt([p('one'), p('two')], 'one', 0, 'one');
  applyPageSetup(first, { apply: 'selected', sel: first.selection, sect: { vAlign: 'bottom' } });
  assert.deepEqual(kinds(first.doc), ['one', '|nextPage|', 'two']);
  assert.equal(sectionsOf(first.doc)[0].sect.vAlign, 'bottom');
});

test('Section start writes the break kind and the following sect.type; settings patch keeps unknown keys', () => {
  const doc = schema.node('doc', { sect: LAST, settings: { mystery: 1 } }, [p('one'), brk(A), p('two')]);
  const tr = EditorState.create({ doc, selection: TextSelection.create(doc, 8) }).tr;
  applyPageSetup(tr, { apply: 'section', sel: tr.selection, start: 'oddPage', sect: { titlePg: true }, settings: { evenAndOddHeaders: true } });
  assert.equal(tr.doc.child(1).attrs.kind, 'oddPage');
  assert.equal(sectionsOf(tr.doc)[1].sect.type, 'oddPage');
  assert.equal(sectionsOf(tr.doc)[1].sect.titlePg, true);
  assert.equal(sectionsOf(tr.doc)[0].sect.titlePg, false);
  assert.deepEqual(tr.doc.attrs.settings, { mystery: 1, evenAndOddHeaders: true });
  const same = EditorState.create({ doc }).tr;
  applyPageSetup(same, { apply: 'whole', sel: same.selection, sect: { w: 700 } });
  assert.equal(same.steps.length, 1, 'an unchanged section adds no step');
});

test('the dialog limits and the text area check, in the shown unit', () => {
  const ok = { w: 595.3, h: 841.9, margin: { top: 72, bottom: 72, left: 72, right: 72, gutter: 0, header: 35.4, footer: 35.4 } };
  const m = (patch) => ({ ...ok, margin: { ...ok.margin, ...patch } });
  assert.equal(checkSetup(ok, 'cm'), null);
  assert.equal(checkSetup({ ...ok, w: 7 }, 'cm'), 'The page width must be between 0.25 cm and 55.88 cm.');
  assert.equal(checkSetup({ ...ok, h: 1585 }, 'in'), 'The page height must be between 0.1" and 22".');
  assert.equal(checkSetup({ ...ok, w: 7.2, h: 1584 }, 'cm'), 'The left and right margins leave no room for text.');
  assert.equal(checkSetup(m({ top: -1585 }), 'cm'), 'The top margin must be between -55.88 cm and 55.88 cm.');
  assert.equal(checkSetup(m({ right: 1585 }), 'cm'), 'The right margin must be between -55.88 cm and 55.88 cm.');
  assert.equal(checkSetup(m({ gutter: -1 }), 'cm'), 'The gutter must be between 0 cm and 55.88 cm.');
  assert.equal(checkSetup(m({ header: 1600 }), 'cm'), 'The header distance must be between 0 cm and 55.88 cm.');
  assert.equal(checkSetup(m({ footer: NaN }), 'cm'), 'The footer distance must be between 0 cm and 55.88 cm.');
  assert.equal(checkSetup(m({ left: 300, right: 280 }), 'cm'), 'The left and right margins leave no room for text.');
  assert.equal(checkSetup(m({ gutter: 430 }), 'cm'), 'The left and right margins leave no room for text.');
  assert.equal(checkSetup({ ...m({ gutter: 430 }), gutterAtTop: true }, 'cm'), null, 'a top gutter takes height instead');
  assert.equal(checkSetup(m({ top: 410, bottom: 410 }), 'cm'), 'The top and bottom margins leave no room for text.');
  assert.equal(checkSetup(m({ top: -72 }), 'cm'), null, 'a negative margin is allowed');
});

test('Blank Page puts two page breaks around an empty paragraph and the caret on it', () => {
  const tr = trAt([p('onetwo')], 'two');
  insertBlankPage(tr, tr.selection.from);
  assert.deepEqual(kinds(tr.doc), ['one', '---', '', '---', 'two']);
  assert.equal(tr.selection.$from.parent.content.size, 0);
  assert.equal(tr.selection.$from.index(0), 2);
});

test('Whole document turns and sizes each section in its own orientation, so a landscape section keeps its margins', () => {
  const land = orientSect({ ...defaultSect(), margin: { ...defaultSect().margin, top: 10, bottom: 20, left: 30, right: 40 } }, 'landscape');
  const tr = trAt([p('one'), brk(land), p('two')], 'one');
  applyPageSetup(tr, { apply: 'whole', sel: tr.selection, sect: { orient: 'landscape' } });
  let s = sectionsOf(tr.doc);
  assert.deepEqual(s[0].sect.margin, land.margin, 'the landscape section is untouched');
  assert.equal(s[1].sect.orient, 'landscape');
  applyPageSetup(tr, { apply: 'whole', sel: tr.selection, sect: { paper: { w: 612, h: 1008 } } });
  s = sectionsOf(tr.doc);
  assert.deepEqual([s[0].sect.w, s[0].sect.h, s[1].sect.w, s[1].sect.h], [1008, 612, 1008, 612]);
  assert.deepEqual(s[0].sect.margin, land.margin);
});
