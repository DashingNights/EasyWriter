import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardStyles, commonStyle, matchStyle } from '../src/app/commands/item-style.mjs';

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
