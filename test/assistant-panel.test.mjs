import assert from 'node:assert/strict';
import test from 'node:test';
import { anchorPanel, dragPanel, placePanel } from '../src/app/assistant/panel.mjs';

const min = { w: 234, h: 260 };
const p = { x: 'right', dx: 10, y: 'bottom', dy: 100, w: 385, h: 540 };

test('placePanel keeps the gaps and size when they fit, shrinks the size first, then the gaps', () => {
  assert.deepEqual(placePanel(p, { width: 1600, height: 900 }, min, 8), { left: 1205, top: 260, width: 385, height: 540 });
  assert.deepEqual(placePanel(p, { width: 1600, height: 500 }, min, 8), { left: 1205, top: 8, width: 385, height: 392 });
  assert.deepEqual(placePanel(p, { width: 1600, height: 300 }, min, 8), { left: 1205, top: 8, width: 385, height: 260 });
  assert.deepEqual(placePanel(p, { width: 200, height: 200 }, min, 8), { left: 8, top: 8, width: 184, height: 184 });
  assert.equal(placePanel({ ...p, x: 'left', y: 'top' }, { width: 1600, height: 900 }, min, 8).left, 10);
});

test('dragPanel moves inside the margin and resizes from a corner with the opposite one fixed', () => {
  const r = { left: 100, top: 100, width: 300, height: 400 };
  const vp = { width: 1000, height: 800 };
  assert.deepEqual(dragPanel(r, null, -500, 5000, vp, min, 8), { left: 8, top: 392, width: 300, height: 400 });
  assert.deepEqual(dragPanel(r, 'nw', 50, -20, vp, min, 8), { left: 150, top: 80, width: 250, height: 420 });
  assert.deepEqual(dragPanel(r, 'se', -500, 1000, vp, min, 8), { left: 100, top: 100, width: 234, height: 692 });
});

test('dragPanel resizes from an edge along its axis only, the opposite edge fixed', () => {
  const r = { left: 100, top: 100, width: 300, height: 400 };
  const vp = { width: 1000, height: 800 };
  assert.deepEqual(dragPanel(r, 'e', 50, 70, vp, min, 8), { left: 100, top: 100, width: 350, height: 400 });
  assert.deepEqual(dragPanel(r, 'n', 30, -50, vp, min, 8), { left: 100, top: 50, width: 300, height: 450 });
  assert.deepEqual(dragPanel(r, 'w', 100, 0, vp, min, 8), { left: 166, top: 100, width: 234, height: 400 });
  assert.deepEqual(dragPanel(r, 's', 0, 1000, vp, min, 8), { left: 100, top: 100, width: 300, height: 692 });
});

test('anchorPanel stores the gaps to the nearer edges (a tie: right, bottom)', () => {
  assert.deepEqual(anchorPanel({ left: 100, top: 300, width: 300, height: 400 }, { width: 1000, height: 1000 }),
    { x: 'left', dx: 100, y: 'bottom', dy: 300, w: 300, h: 400 });
  assert.deepEqual(anchorPanel({ left: 350, top: 100, width: 300, height: 400 }, { width: 1000, height: 1000 }),
    { x: 'right', dx: 350, y: 'top', dy: 100, w: 300, h: 400 });
});
