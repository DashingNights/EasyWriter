// Print page choices (src/document/wp/print/ranges.mjs): the Pages box, odd and even pages, book fold order and api.word.print args.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookletOrder, parsePages, pdfRanges, pickPages, printArgs, runsOf } from '../src/document/wp/print/ranges.mjs';

// Two sections; the second restarts numbering at 1: shown numbers 1 2 3 | 1 2 3 4.
const PAGES = [1, 2, 3, 1, 2, 3, 4].map((number, index) => ({ index, number, section: index < 3 ? 0 : 1 }));
const idx = (text) => parsePages(text, PAGES);

test('pages box: numbers, ranges, sections and spaces', () => {
  assert.deepEqual(idx('1,3').indices, [0, 2]);
  assert.deepEqual(idx(' 1 , 2 - 3 ').indices, [0, 1, 2]);
  assert.deepEqual(idx('p1s2').indices, [3]);
  assert.deepEqual(idx('P2S1-p3s2').indices, [1, 2, 3, 4, 5]);
  assert.deepEqual(idx('s2').indices, [3, 4, 5, 6]);
  assert.deepEqual(idx('4').indices, [6], 'a plain number is the shown number');
  assert.deepEqual(idx('').indices, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(idx('3,1,1').indices, [0, 2], 'ascending, once each');
});

test('pages box: messages', () => {
  assert.match(idx('3-1').error, /runs backwards/);
  assert.match(idx('9').error, /no page 9/);
  assert.match(idx('p5s1').error, /no page p5s1/);
  assert.match(idx('abc').error, /not a page or a range/);
  assert.match(idx('1-2-3').error, /not a page or a range/);
  assert.equal(idx('1-3').error, null);
});

test('what to print: current, selection, odd and even by page number', () => {
  assert.deepEqual(pickPages({ what: 'current', current: 4 }, PAGES).indices, [4]);
  assert.deepEqual(pickPages({ what: 'selection', selection: [1, 3] }, PAGES).indices, [1, 2, 3]);
  assert.deepEqual(pickPages({ what: 'all', odd: true }, PAGES).indices, [0, 2, 3, 5]);
  assert.deepEqual(pickPages({ what: 'all', even: true }, PAGES).indices, [1, 4, 6]);
  assert.deepEqual(pickPages({ what: 'custom', text: 's1', even: true }, PAGES).indices, [1]);
  assert.deepEqual(pickPages({ what: 'info' }, PAGES).indices, []);
});

test('book fold order for 8 and 12 pages', () => {
  const one = (n) => bookletOrder(n).map((side) => side.map((i) => (i == null ? null : i + 1)));
  assert.deepEqual(one(8), [[8, 1], [2, 7], [6, 3], [4, 5]]);
  assert.deepEqual(one(12), [[12, 1], [2, 11], [10, 3], [4, 9], [8, 5], [6, 7]]);
  assert.deepEqual(bookletOrder(6).map((s) => s.map((i) => (i == null ? null : i + 1))), [[null, 1], [2, null], [6, 3], [4, 5]], 'padded to 8');
  // Two booklets of one sheet each, and right-to-left.
  assert.deepEqual(bookletOrder(8, 1).map((s) => s.map((i) => i + 1)), [[4, 1], [2, 3], [8, 5], [6, 7]]);
  assert.deepEqual(bookletOrder(4, 0, true).map((s) => s.map((i) => i + 1)), [[1, 4], [3, 2]]);
});

test('settings map to api.word.print arguments', () => {
  const a4 = { w: 595.3, h: 841.9 };
  const pick = parsePages('2-3', PAGES).indices;
  const args = printArgs({ copies: 2, collate: false, sides: 'long', perSheet: 1, printer: 'Office' }, { sheet: a4, runs: runsOf(pick) });
  assert.deepEqual(args.pageRanges, [{ from: 1, to: 2 }]);
  assert.equal(args.copies, 2);
  assert.equal(args.collate, false);
  assert.equal(args.duplexMode, 'longEdge');
  assert.equal(args.deviceName, 'Office');
  assert.equal(args.landscape, false);
  assert.equal(args.printBackground, true);
  assert.deepEqual(args.margins, { marginType: 'none' });
  assert.deepEqual(args.pageSize, { width: 210009, height: 297004 });
  const quick = printArgs({ copies: 1, sides: 'short', perSheet: 4 }, { sheet: { w: 841.9, h: 595.3 }, silent: true });
  assert.equal(quick.silent, true);
  assert.equal(quick.duplexMode, 'shortEdge');
  assert.equal(quick.landscape, true);
  assert.equal(quick.pagesPerSheet, 4);
  assert.equal('pageRanges' in quick, false);
  assert.equal('deviceName' in quick, false);
  assert.equal(printArgs({ sides: 'manual' }, {}).duplexMode, 'simplex');
  assert.deepEqual(runsOf([0, 2, 3, 4, 6]), [{ from: 0, to: 0 }, { from: 2, to: 4 }, { from: 6, to: 6 }]);
  assert.equal(pdfRanges(runsOf([1, 2, 5])), '2-3, 6');
});
