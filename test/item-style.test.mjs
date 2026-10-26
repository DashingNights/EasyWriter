import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardStyles, commonStyle, contrast, contrastWarnings, inkOn, matchStyle, styledText, surfaceOf } from '../src/app/commands/item-style.mjs';

const note = (id, color = '#222222', bg = '#fff59d') => ({ id, type: 'text', x: 0, y: 0, w: 200, html: 'n', size: 18, color, bold: false, bg });
const rect = (id, color, fill = 'none') => ({ id, type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, color, width: 3, opacity: 1, fill, fillColor: color });

test('matchStyle: left-out fields come from the most common style of the same type; set fields stay', () => {
  const items = [note('a'), note('b'), note('c', '#ffffff', null), rect('r', '#e53935')];
  assert.deepEqual(matchStyle({ type: 'text', x: 5, y: 5, w: 100, html: 'new' }, items),
    { size: 18, color: '#222222', bold: false, bg: '#fff59d', type: 'text', x: 5, y: 5, w: 100, html: 'new' });
  assert.equal(matchStyle({ type: 'text', x: 5, y: 5, w: 100, html: 'new', color: '#0000ff' }, items).color, '#0000ff');
});

test('matchStyle: a shape takes its own kind first, else any shape; a type with none on the board is left as it is', () => {
  const items = [rect('r1', '#e53935'), { ...rect('e1', '#1e88e5'), shape: 'ellipse' }];
  assert.equal(matchStyle({ type: 'shape', shape: 'ellipse', x: 0, y: 0, w: 5, h: 5 }, items).color, '#1e88e5');
  assert.equal(matchStyle({ type: 'shape', shape: 'diam', x: 0, y: 0, w: 5, h: 5 }, items).color, '#1e88e5'); // a tie: the latest
  const c = { type: 'connector', from: { x: 0, y: 0 }, to: { x: 9, y: 9 } };
  assert.deepEqual(matchStyle(c, items), c);
});

test('commonStyle and boardStyles: counts win, the latest breaks a tie, one entry per type present', () => {
  assert.deepEqual(commonStyle([rect('a', '#111111'), rect('b', '#222222')], ['color']), { color: '#222222' });
  assert.deepEqual(commonStyle([rect('a', '#111111'), rect('b', '#111111'), rect('c', '#222222')], ['color']), { color: '#111111' });
  assert.deepEqual(Object.keys(boardStyles([note('a'), rect('r', '#e53935')])), ['text', 'shape']);
});

test('matchStyle: a board with no item of that type takes the page\'s other boards (page), its own items first', () => {
  const page = [rect('p1', '#f50000'), rect('p2', '#f50000'), note('n')];
  assert.equal(matchStyle({ type: 'shape', shape: 'rect', x: 0, y: 0, w: 5, h: 5 }, [note('t')], page).color, '#f50000');
  assert.equal(matchStyle({ type: 'shape', shape: 'rect', x: 0, y: 0, w: 5, h: 5 }, [rect('own', '#00ff00')], page).color, '#00ff00');
});

test("matchStyle: a connector's label slots take the board's label size, colour and bold; set fields stay", () => {
  const c = (id, labels) => ({ id, type: 'connector', from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, color: '#111111', labels });
  const items = [c('c1', { mid: { html: 'yes', size: 12, textColor: '#333333', bold: true } }), c('c2', {})];
  const out = matchStyle({ type: 'connector', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, labels: { mid: { html: 'keep' }, end: { html: 'no', textColor: '#ff0000' } } }, items);
  assert.deepEqual(out.labels, { mid: { size: 12, textColor: '#333333', bold: true, html: 'keep' }, end: { size: 12, textColor: '#ff0000', bold: true, html: 'no' } });
  // No labelled connector on the board: the page's.
  const page = [c('p1', { mid: { html: 'x', textColor: '#00aa00' } })];
  assert.equal(matchStyle({ type: 'connector', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, labels: { mid: { html: 'k' } } }, [c('c2', {})], page).labels.mid.textColor, '#00aa00');
});

test('contrast and inkOn: WCAG ratios of hex colours; the theme ink unless it is unreadable on the surface', () => {
  assert.equal(contrast('#ffffff', '#000000'), 21);
  assert.equal(contrast('#fff', '#ffffff'), 1);
  assert.equal(Math.round(contrast('#ffffff', '#303039') * 10) / 10, 13.1);
  assert.equal(contrast('#ffffff', 'transparent'), null);
  assert.equal(inkOn('#ffffff', 'light'), '#111111');
  assert.equal(inkOn('#303039', 'dark'), '#ffffff');
  assert.equal(inkOn('#ffffff', 'dark'), '#111111'); // a white board in the dark theme
  assert.equal(inkOn('#fff59d', 'dark'), '#111111'); // a yellow note
  assert.equal(inkOn(null, 'light'), '#111111');
});

test('contrastWarnings: white labels on a light board are named with both colours and the ratio; drawn defaults pass', () => {
  const items = [
    { id: 'c', type: 'connector', from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, labels: { mid: { html: 'keep', textColor: '#ffffff' }, end: { html: 'ok' } } },
    { id: 's', type: 'shape', shape: 'rect', html: 'A', fill: 'solid', fillColor: '#111111', textColor: '#111111' },
    { id: 'f', type: 'shape', shape: 'rect', html: 'B', fill: 'solid', fillColor: '#1e3a8a' }, // no colour: drawn white on the fill
    { id: 't', type: 'text', html: 'note', color: null, bg: '#fff59d' },
    { id: 'x', type: 'text', html: 'skip', color: '#ffffff' }, // not in ids
  ];
  const w = contrastWarnings(items, new Set(['c', 's', 'f', 't']), 'light', '#ffffff');
  assert.deepEqual(w.map((x) => x.id), ['c', 's']);
  assert.match(w[0].message, /#ffffff on #ffffff has a contrast of 1\.0:1, under 3:1\. Set labels\.mid\.textColor/);
  assert.match(w[1].message, /Set textColor/);
  assert.deepEqual(contrastWarnings(items, new Set(['c']), 'dark', '#303039'), []);
});

test('matchStyle with the board colour: a taken text colour that does not read on the new item is left out; a set one stays', () => {
  const c = (id, labels) => ({ id, type: 'connector', from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, color: '#111111', labels });
  const legacy = [c('c1', { mid: { html: 'keep', size: 14, textColor: '#ffffff', bold: false } })]; // drafts before 2026-10-26
  const conn = { type: 'connector', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, labels: { mid: { html: 'restore' } } };
  assert.deepEqual(matchStyle(conn, legacy, [], '#ffffff').labels.mid, { size: 14, bold: false, html: 'restore' });
  assert.equal(matchStyle(conn, legacy, [], '#303039').labels.mid.textColor, '#ffffff'); // reads on the dark board
  assert.equal(matchStyle({ ...conn, labels: { mid: { html: 'w', textColor: '#ffffff' } } }, legacy, [], '#ffffff').labels.mid.textColor, '#ffffff');
  // Yellow notes with dark text: a new dark blue note leaves the colour out; a new yellow one takes it.
  const notes = [note('a', '#111111'), note('b', '#111111')];
  assert.equal('color' in matchStyle({ type: 'text', html: 'n', bg: '#1e3a8a' }, notes, [], '#ffffff'), false);
  assert.equal(matchStyle({ type: 'text', html: 'n' }, notes, [], '#ffffff').color, '#111111');
  const dark = [{ ...rect('r', '#111111', 'solid'), fillColor: '#111111', textColor: '#ffffff' }];
  assert.equal('textColor' in matchStyle({ type: 'shape', shape: 'rect', fill: 'solid', fillColor: '#fff59d' }, dark, [], '#ffffff'), false);
});

test('surfaceOf: a see-through fill or note is laid over the board; shape opacity counts', () => {
  const shape = (fillColor, opacity = 1) => ({ type: 'shape', shape: 'rect', fill: 'solid', fillColor, opacity });
  assert.equal(surfaceOf(shape('#1e3a8a'), '#ffffff'), '#1e3a8a');
  assert.equal(surfaceOf(shape('#1e3a8a4d'), '#ffffff'), '#bbc4dc');
  assert.equal(surfaceOf(shape('#000000', 0.2), '#ffffff'), '#cccccc');
  assert.equal(surfaceOf(shape('#00000000'), '#ffffff'), '#ffffff');
  assert.equal(surfaceOf({ type: 'text', bg: '#00000010' }, '#ffffff'), '#efefef');
  assert.equal(surfaceOf({ type: 'shape', shape: 'rect', fill: 'none', fillColor: '#000000' }, '#ffffff'), '#ffffff');
  assert.equal(inkOn(surfaceOf(shape('#1e3a8a4d'), '#ffffff'), 'light'), '#111111');
  const items = [{ id: 'f', type: 'shape', shape: 'rect', html: 'Faint', fill: 'solid', fillColor: '#000000', opacity: 0.2, textColor: '#ffffff' }];
  assert.deepEqual(contrastWarnings(items, new Set(['f']), 'light', '#ffffff').map((w) => w.id), ['f']);
});

test('styledText: an update warns only when it changes a colour or what the text sits on', () => {
  assert.equal(styledText({ x: 100 }), false);
  assert.equal(styledText({ html: 'Done' }), false);
  assert.equal(styledText({ color: '#ff0000' }), true);
  assert.equal(styledText({ labels: { mid: { html: 'yes' } } }), true);
  assert.equal(styledText({ fillColor: '#000000' }), true);
});
