// Page geometry and sections (docs/plans/word/plan.md §1.9, §1.8 sect v2): page labels, sectionsOf and sectionOf over section
// breaks, engine 1's page list, the per-page layer key comparison and the frame's loop guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { defaultSect } from '../src/document/defaults.mjs';
import { buildPages, layerWork, pageBox, pageLabel, runFrame } from '../src/document/geometry.mjs';
import { pageAt } from '../src/document/pages.mjs';
import { SECT_DEFAULTS, sectionOf, sectionsOf } from '../src/document/model/sections.mjs';
import { documentExtensions } from '../src/document/schema.js';

// Schema v2 (scaffold-model), so the tests read the real sectionBreak node.
const schema = getSchema(documentExtensions(50));
const p = (s) => schema.node('paragraph', null, s ? [schema.text(s)] : []);
const brk = (sect, kind = 'nextPage') => schema.node('sectionBreak', { kind, sect });

test('pageLabel draws every page number format', () => {
  assert.equal(pageLabel(7), '7');
  assert.equal(pageLabel(7, 'decimal'), '7');
  assert.equal(pageLabel(7, 'numberInDash'), '- 7 -');
  assert.deepEqual([1, 26, 27, 53].map((n) => pageLabel(n, 'lowerLetter')), ['a', 'z', 'aa', 'aaa']);
  assert.deepEqual([2, 28].map((n) => pageLabel(n, 'upperLetter')), ['B', 'BB']);
  assert.deepEqual([4, 9, 14, 1994, 3999].map((n) => pageLabel(n, 'lowerRoman')), ['iv', 'ix', 'xiv', 'mcmxciv', 'mmmcmxcix']);
  assert.equal(pageLabel(2026, 'upperRoman'), 'MMXXVI');
  assert.equal(pageLabel(0, 'upperRoman'), '0');
  assert.equal(pageLabel(5, 'chicago'), '5');
});

test('sectionsOf splits at each break, the break ending its section, and fills sect v2 defaults', () => {
  const a = { ...defaultSect(), w: 500, pgNum: { start: 5 } };
  const last = { ...defaultSect(), w: 700, future: 1 };
  const doc = schema.node('doc', { sect: last }, [p('one'), brk(a), p('two'), brk(null, 'continuous'), p('three')]);
  const list = sectionsOf(doc);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((s) => [s.index, s.from, s.to, s.holder]), [[0, 0, 6, 5], [1, 6, 12, 11], [2, 12, doc.content.size, null]]);
  assert.equal(list[0].sect.w, 500);
  assert.deepEqual(list[0].sect.pgNum, { ...SECT_DEFAULTS.pgNum, start: 5 });
  assert.equal(list[1].sect.w, 700, 'a break without sect takes the following section\'s');
  assert.equal(list[2].sect.future, 1, 'unknown keys survive');
  assert.equal(list[2].sect.vAlign, 'top');
  assert.equal(sectionsOf(doc), list, 'memoised per doc');
  assert.equal(sectionOf(doc, 0).index, 0);
  assert.equal(sectionOf(doc, 5).index, 0, 'the break belongs to the section it ends');
  assert.equal(sectionOf(doc, 6).index, 1);
  assert.equal(sectionOf(doc, doc.content.size).index, 2);
  const one = sectionsOf(schema.node('doc', null, [p('x')]));
  assert.equal(one.length, 1);
  assert.equal(one[0].sect.w, defaultSect().w, 'no sect: the default page');
});

test('buildPages counts blocks by their first line and numbers pages per section', () => {
  const box = pageBox({ w: 600, h: 800, margin: { top: 60, right: 60, bottom: 60, left: 60, header: 30, footer: 30 } });
  assert.deepEqual([box.w, box.h, box.top, box.body, box.text], [800, 800 * 4 / 3, 80, 800 * 4 / 3 - 160, 640]);
  const step = box.body + box.breaker;
  // Run 0 has two pages, run 1 (after a page break) one; a block top in a breaker belongs to the next page.
  const segments = [{ top: 0, pages: 2 }, { top: 2 * step, pages: 1 }];
  assert.equal(pageAt(box.body + 5, segments, step, box.body), 1);
  assert.equal(pageAt(box.body + 5, segments, step), 0, 'without body, a y keeps its page');
  const sect = (extra) => ({ ...defaultSect(), ...SECT_DEFAULTS, ...extra });
  const sections = [{ index: 0, from: 0, to: 30, sect: sect({}) }, { index: 1, from: 30, to: 50, sect: sect({ titlePg: true, pgNum: { fmt: 'lowerRoman', start: 1 } }) }];
  const built = buildPages({ segments, box, starts: [0, 10, 20, 30, 40], tops: [0, 100, step + 10, 2 * step, 2 * step + 50], size: 50, sections });
  assert.deepEqual(built.blocks, [0, 0, 1, 2, 2]);
  assert.deepEqual(built.pages.map((pg) => [pg.from, pg.to, pg.section, pg.number, pg.label, pg.part]),
    [[0, 20, 0, 1, '1', 'odd'], [20, 30, 0, 2, '2', 'odd'], [30, 50, 1, 1, 'i', 'first']]);
  assert.deepEqual(built.pages.map((pg) => [pg.top, pg.bodyTop]), [[-80, 0], [step - 80, step], [2 * step - 80, 2 * step]]);
  assert.deepEqual(built.sections.map((s) => [s.firstPage, s.pages]), [[0, 2], [2, 1]]);
  // One section over 4 pages whose last block's first line is on page 2: the pages it runs onto are the section's too.
  const long = buildPages({ segments: [{ top: 0, pages: 4 }], box, starts: [0, 10], tops: [0, step + 10], size: 20,
    sections: [{ index: 0, from: 0, to: 20, sect: sect({}) }] });
  assert.deepEqual(long.sections.map((s) => [s.firstPage, s.pages]), [[0, 4]]);
});

test('layerWork redraws only the pages whose layer key changed', () => {
  const pages = [0, 1, 2].map((index) => ({ index }));
  let version = { 0: 1, 1: 1, 2: 1 };
  const layer = { id: 'test', key: (_, pg) => `v${version[pg.index]}` };
  const keys = pages.map(() => new Map());
  assert.deepEqual(layerWork([layer], pages, null, (i) => keys[i]).map((w) => w.i), [0, 1, 2], 'first draw: every page');
  assert.deepEqual(layerWork([layer], pages, null, (i) => keys[i]), [], 'same keys: nothing');
  version = { ...version, 1: 2 };
  assert.deepEqual(layerWork([layer], pages, null, (i) => keys[i]).map((w) => [w.i, w.key]), [[1, 'v2']], 'page 2 only');
});

test('runFrame runs before passes, the measure and after passes under one guard', () => {
  const log = [];
  const r1 = runFrame({ before: () => log.push('b') && false, measure: () => log.push('m'), after: () => log.push('a') && false });
  assert.deepEqual(log, ['b', 'm', 'a']);
  assert.deepEqual(r1, { rounds: 0, capped: false });
  let n = 0;
  const r2 = runFrame({ before: () => n++ < 2, measure: () => {}, after: () => false });
  assert.equal(n, 3, 'before passes rerun until none changes');
  assert.equal(r2.capped, false);
  const counts = { b: 0, m: 0, a: 0 };
  const r3 = runFrame({ before: () => { counts.b++; return true; }, measure: () => counts.m++, after: () => { counts.a++; return true; } });
  assert.equal(r3.capped, true, 'a pass that always reports a change is stopped');
  assert.deepEqual(counts, { b: 3, m: 1, a: 0 });
  const counts2 = { m: 0, a: 0 };
  const r4 = runFrame({ before: () => false, measure: () => counts2.m++, after: () => { counts2.a++; return true; } });
  assert.equal(r4.capped, true);
  assert.deepEqual(counts2, { m: 3, a: 3 }, 'at most 3 measures');
});
