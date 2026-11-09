// Headers, footers and page numbers, the pure rules (docs/plans/word/plan.md §3 headers-footers): part resolution through Link to
// Previous, the section an edit writes to, Link to Previous on and off, the gallery blocks, the v1 page number, Remove Page
// Numbers, the editing label and reserve().
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPages, pageBox } from '../src/document/geometry.mjs';
import { deepPatch } from '../src/office.mjs';
import {
  CHAPTER_ERROR, drawnSect, galleryBlocks, hasPageNumbers, isLinked, labelOf, layoutFieldText, numberBlocks, pageNumberText, partOf,
  partsInOrder, previousContent, reserveOf, resolvePart, setPageNumberPart, stripPageNumbers, withoutPart, withPart, writeTarget,
} from '../src/document/wp/headers-footers/model.mjs';

const P = (t) => [{ type: 'paragraph', content: [{ type: 'text', text: t }] }];
const sect = (extra) => ({ w: 612, h: 792, margin: { top: 72, right: 72, bottom: 72, left: 72, header: 36, footer: 36, gutter: 0 }, ...extra });

test('a part resolves back through linked sections; a null part in the first section is empty', () => {
  const sects = [sect({ hdr: { default: P('A'), first: P('A1') } }), sect({ hdr: null }), sect({ hdr: { default: P('C') } })];
  assert.deepEqual(resolvePart(sects, 1, 'hdr', 'default'), { content: P('A'), holder: 0 });
  assert.deepEqual(resolvePart(sects, 2, 'hdr', 'default'), { content: P('C'), holder: 2 });
  assert.deepEqual(resolvePart(sects, 2, 'hdr', 'first'), { content: P('A1'), holder: 0 }, 'part by part');
  assert.deepEqual(resolvePart(sects, 1, 'hdr', 'even'), { content: null, holder: null });
  assert.deepEqual(resolvePart([sect({ ftr: { default: null } })], 0, 'ftr', 'default'), { content: null, holder: null });
  assert.equal(isLinked(sects, 1, 'hdr', 'default'), true);
  assert.equal(isLinked(sects, 2, 'hdr', 'default'), false);
  assert.equal(isLinked(sects, 0, 'hdr', 'default'), false, 'never in the first section');
  // An edit of a linked part writes to the nearest earlier holder, else the first section.
  assert.equal(writeTarget(sects, 1, 'hdr', 'default'), 0);
  assert.equal(writeTarget(sects, 2, 'hdr', 'default'), 2);
  assert.equal(writeTarget(sects, 2, 'hdr', 'even'), 0);
});

test('pages pick first, even and odd parts from titlePg and evenAndOddHeaders', () => {
  const s = sect({ titlePg: true });
  const box = pageBox(s);
  const step = box.body + box.breaker;
  const pages = buildPages({ segments: [{ top: 0, pages: 4 }], box, starts: [0, 10, 20, 30], tops: [0, step, 2 * step, 3 * step], size: 40,
    sections: [{ index: 0, from: 0, to: 40, sect: s }], evenAndOdd: true }).pages;
  assert.deepEqual(pages.map((p) => partOf(p.part)), ['first', 'even', 'default', 'even']);
  assert.deepEqual(partsInOrder(pages).map((x) => `${x.section}:${x.part}@${x.page}`), ['0:first@0', '0:even@1', '0:default@2']);
});

test('Link to Previous on drops the part; off keeps a copy of what it showed', () => {
  const sects = [sect({ ftr: { default: P('Base') } }), sect({ ftr: { default: P('Own'), even: P('E') }, keep: 1 })];
  const on = withoutPart(sects[1], 'ftr', 'default');
  assert.deepEqual(on.ftr, { even: P('E') });
  assert.equal(on.keep, 1, 'unknown keys survive');
  const linked = [sects[0], on];
  assert.equal(isLinked(linked, 1, 'ftr', 'default'), true);
  const copy = previousContent(linked, 1, 'ftr', 'default');
  assert.deepEqual(copy, P('Base'));
  copy[0].content[0].text = 'changed';
  assert.equal(sects[0].ftr.default[0].content[0].text, 'Base', 'a copy, not the same object');
  assert.deepEqual(withPart(on, 'ftr', 'default', P('Base')).ftr, { even: P('E'), default: P('Base') });
  assert.deepEqual(previousContent([sect()], 1, 'hdr', 'default'), [], 'nothing before: an empty own part');
  // The scaffold's patch rule reads the same: null deletes.
  assert.deepEqual(deepPatch({ hdr: { default: P('x'), first: P('y') } }, { hdr: { first: null } }), { hdr: { default: P('x') } });
});

test('gallery blocks: Blank, three columns on the style stops, plain numbers and Page X of Y', () => {
  assert.deepEqual(galleryBlocks('hdr', 'blank'), [{ type: 'paragraph', attrs: { styleId: 'Header' }, content: [{ type: 'text', text: '[Type here]' }] }]);
  assert.equal(galleryBlocks('ftr', 'blankThreeColumns')[0].content[0].text, '[Type here]\t[Type here]\t[Type here]');
  assert.equal(galleryBlocks('ftr', 'blank')[0].attrs.styleId, 'Footer');
  assert.equal(galleryBlocks('hdr', 'someUserBlock'), null, 'unknown ids decline');
  assert.deepEqual(numberBlocks('ftr', 'center', '3'), [{ type: 'paragraph', attrs: { styleId: 'Footer', textAlign: 'center' },
    content: [{ type: 'field', attrs: { code: 'PAGE', result: '3' } }] }]);
  assert.equal(numberBlocks('hdr', 'left')[0].attrs.textAlign, 'left');
  const xy = numberBlocks('ftr', 'pageXofY', '2', '5')[0].content;
  assert.deepEqual(xy.map((n) => n.text ?? `{${n.attrs.code}}`), ['Page ', '{PAGE}', ' of ', '{NUMPAGES}']);
  assert.deepEqual(xy[1].marks, [{ type: 'bold' }]);
  assert.equal(numberBlocks('ftr', 'nope'), null);
});

test('a v1 page number becomes a footer part with pgNum.start, drawn the same without a write', () => {
  const v1 = sect({ pageNumber: { at: 'bottom', align: 'right', start: 4 }, custom: 'kept' });
  const out = setPageNumberPart(v1, v1.pageNumber);
  assert.equal(out.pageNumber, null);
  assert.equal(out.custom, 'kept');
  assert.equal(out.pgNum.start, 4);
  assert.deepEqual(out.ftr.default, [{ type: 'paragraph', attrs: { styleId: 'Footer', textAlign: 'right' }, content: [{ type: 'field', attrs: { code: 'PAGE', result: '4' } }] }]);
  assert.equal(out.hdr, undefined);
  assert.deepEqual(drawnSect(v1), out, 'the layer draws what the conversion writes');
  assert.equal(drawnSect(sect()).pageNumber, undefined, 'a v2 sect draws as stored');
  // The page layer keys on part identity: the same stored parts give the same drawn arrays, so pages do not redraw per keystroke.
  assert.equal(drawnSect({ ...v1 }).ftr.default, drawnSect({ ...v1 }).ftr.default);
  assert.deepEqual(drawnSect({ ...v1, ftr: { first: [] } }).ftr.first, [], 'a changed footer is drawn afresh');
  // Setting a number at the top takes it out of the footer: a page never shows two. Without a start the user's Start at stays.
  const top = setPageNumberPart(out, { at: 'top', align: 'center' });
  assert.deepEqual(top.ftr.default, []);
  assert.equal(top.hdr.default[0].attrs.styleId, 'Header');
  assert.equal(top.pgNum.start, 4);
  assert.equal(setPageNumberPart(out, { at: 'top', start: null }).pgNum.start, null);
  // null removes it.
  const none = setPageNumberPart(top, null);
  assert.equal(hasPageNumbers(none), false);
  assert.equal(hasPageNumbers(top), true);
  assert.equal(hasPageNumbers(v1), true);
});

test('Remove Page Numbers drops number paragraphs and margin boxes, keeps other text', () => {
  const blocks = [
    ...P('Title'),
    { type: 'paragraph', content: [{ type: 'text', text: 'Page ' }, { type: 'field', attrs: { code: 'PAGE' } }, { type: 'text', text: ' of ' }, { type: 'field', attrs: { code: 'NUMPAGES' } }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Draft ' }, { type: 'field', attrs: { code: ' PAGE \\* roman ' } }] },
    { type: 'paragraph', content: [{ type: 'field', attrs: { code: 'PAGEREF x' } }] },
    { type: 'textBox', content: [{ type: 'paragraph', content: [{ type: 'field', attrs: { code: 'PAGE' } }] }] },
  ];
  const out = stripPageNumbers(blocks);
  assert.deepEqual(out, [...P('Title'), { type: 'paragraph', content: [{ type: 'text', text: 'Draft ' }] }, blocks[3]]);
  const same = P('x');
  assert.equal(stripPageNumbers(same), same, 'unchanged parts stay the same object');
});

test('page number text: format label, chapter number and the layout fields', () => {
  const page = { label: 'v', section: 1 };
  assert.equal(pageNumberText('v', { chapStyle: null }), 'v');
  assert.equal(pageNumberText('3', { chapStyle: 1, chapSep: 'period' }, '2'), '2.3');
  assert.equal(pageNumberText('3', { chapStyle: 1, chapSep: 'enDash' }, '2'), '2–3');
  assert.equal(pageNumberText('3', { chapStyle: 1 }, null), CHAPTER_ERROR);
  const info = { page, pages: 7, sectionPages: 3, pgNum: {} };
  assert.equal(layoutFieldText('PAGE', info), 'v');
  assert.equal(layoutFieldText(' NUMPAGES ', info), '7');
  assert.equal(layoutFieldText('SECTIONPAGES', info), '3');
  assert.equal(layoutFieldText('SECTION', info), '2');
  assert.equal(layoutFieldText('DATE', info), null);
});

test('label text per page kind and section', () => {
  assert.deepEqual(labelOf({ kind: 'header', part: 'default', evenAndOdd: false, section: 0, sections: 1, linked: false }), { text: 'Header', right: '' });
  assert.equal(labelOf({ kind: 'header', part: 'default', evenAndOdd: true, section: 0, sections: 1 }).text, 'Odd Page Header');
  assert.equal(labelOf({ kind: 'footer', part: 'first', section: 0, sections: 1 }).text, 'First Page Footer');
  assert.deepEqual(labelOf({ kind: 'footer', part: 'even', evenAndOdd: true, section: 1, sections: 2, linked: true }),
    { text: 'Even Page Footer -Section 2-', right: 'Same as Previous' });
});

test('reserve: distance plus the drawn height, nothing for an edge with a negative margin', () => {
  const box = pageBox(sect());
  assert.deepEqual(reserveOf(box, { headerH: 100, footerH: 20 }), { top: 48 + 100, bottom: 48 + 20 });
  assert.deepEqual(reserveOf(box, {}), {});
  const neg = pageBox(sect({ margin: { top: -72, right: 72, bottom: 72, left: 72, header: 36, footer: 36 } }));
  assert.deepEqual(reserveOf(neg, { headerH: 100, footerH: 20 }), { bottom: 68 });
  // The measured case of index-layout.md: 8 header lines moved the body from 72 to 152.75 pt.
  const eight = reserveOf(box, { headerH: (152.75 - 36) * (4 / 3), footerH: 0 });
  assert.equal(Math.round(eight.top * 0.75 * 100) / 100, 152.75);
});
