import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addStop, columnDrag, defaultTicks, indentMarkers, indentPatch, keyStep, moveStop, nextSelector, removeStop,
  sectionColumnsDrag, SELECTOR, snap, ticks,
} from '../src/document/wp/ruler/ruler.mjs';

// The rulers' pure parts (plan.md §3 ruler; brief ruler.md Acceptance).
const CM = 72 / 2.54;
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

test('inch ticks across a 6.5 in column: an eighth each, a long one at the half, a number each inch', () => {
  const t = ticks('in', 0, 6.5 * 72);
  assert.equal(t.length, 6.5 * 8 + 1);
  assert.deepEqual(t.filter((x) => x.label).map((x) => [x.pos, x.label]), [[72, '1'], [144, '2'], [216, '3'], [288, '4'], [360, '5'], [432, '6']]);
  assert.deepEqual(t.filter((x) => x.kind === 'mid').map((x) => x.pos), [36, 108, 180, 252, 324, 396, 468]);
  assert.equal(t[0].label, null); // no number at 0
});

test('cm ticks across a 15.92 cm column, and numbers counting outward into the left margin', () => {
  const t = ticks('cm', 0, 15.92 * CM);
  assert.equal(t.length, 64); // 0 to 15.75 in quarters
  assert.deepEqual(t.filter((x) => x.label).map((x) => x.label), Array.from({ length: 15 }, (_, i) => String(i + 1)));
  assert.ok(t.filter((x) => x.label).every((x) => near(x.pos, Number(x.label) * CM)));
  assert.ok(near(t.find((x) => x.kind === 'mid').pos, 0.5 * CM));
  const left = ticks('cm', -2.54 * CM, 0).filter((x) => x.label);
  assert.deepEqual(left.map((x) => x.label), ['2', '1']);
});

test('cm ticks thin out as the zoom shrinks: a number every 1, 2 or 5 cm, a mid tick halfway, no tick under 6 px from the next', () => {
  const at = (zoom) => ticks('cm', 0, 15.92 * CM, (zoom / 100) * (4 / 3));
  const labels = (t) => t.filter((x) => x.label).map((x) => x.label);
  assert.deepEqual(labels(at(100)), labels(ticks('cm', 0, 15.92 * CM))); // 100 %: every centimetre, as unzoomed
  assert.equal(at(100).length, 64);
  assert.deepEqual(labels(at(50)), labels(at(100)));
  assert.deepEqual(labels(at(24)), ['2', '4', '6', '8', '10', '12', '14']);
  const t = at(10);
  assert.deepEqual(labels(t), ['5', '10', '15']);
  assert.ok(near(t.find((x) => x.kind === 'mid').pos, 2.5 * CM));
  const gaps = t.slice(1).map((x, i) => (x.pos - t[i].pos) * 0.1 * (4 / 3));
  assert.ok(Math.min(...gaps) >= 6 - 1e-9, String(Math.min(...gaps)));
});

test('snapping: 1/16 in and 0.25 cm from the ruler 0; Alt turns it off', () => {
  assert.equal(snap(40, 'in'), 40.5);
  assert.equal(snap(-3, 'in'), -4.5);
  assert.ok(near(snap(1.1 * CM, 'cm'), CM));
  assert.ok(near(snap(1.2 * CM, 'cm'), 1.25 * CM));
  assert.equal(snap(40, 'in', true), 40);
  assert.equal(keyStep('in', false), 4.5);
  assert.ok(near(keyStep('cm', true), CM / 40));
});

test('indent marker drags write Word\'s indents', () => {
  const ind = { left: 36, firstLine: 18, right: 0 };
  assert.deepEqual(indentMarkers(ind, 468), { firstLine: 54, hanging: 36, left: 36, right: 468 });
  assert.deepEqual(indentPatch('firstLine', ind, 72, 468), { firstLine: 36 });
  assert.deepEqual(indentPatch('firstLine', ind, 18, 468), { firstLine: -18 }); // left of the left indent: hanging
  const h = indentPatch('hanging', ind, 72, 468);
  assert.deepEqual(h, { left: 72, firstLine: -18 });
  assert.equal(h.left + h.firstLine, 54); // line 1 stays where it was
  assert.deepEqual(indentPatch('left', ind, 72, 468), { left: 72 }); // firstLine is relative, so the offset stays
  assert.deepEqual(indentPatch('right', ind, 500, 468), { right: -32 }); // past the margin: negative
  assert.deepEqual(indentPatch('left', ind, -5000, 468), { left: -1584 });
});

test('the tab selector cycles through Word\'s seven choices and back', () => {
  let k = 'left';
  const seen = [];
  for (let i = 0; i < 7; i++) seen.push((k = nextSelector(k)));
  assert.deepEqual(seen, [...SELECTOR.slice(1), 'left']);
});

test('default stop ticks show only right of the last custom stop', () => {
  assert.deepEqual(defaultTicks([], 36, 150), [36, 72, 108, 144]);
  assert.deepEqual(defaultTicks([{ pos: 80 }], 36, 200), [108, 144, 180]);
  assert.deepEqual(defaultTicks([{ pos: 72 }], 36, 150), [108, 144]);
});

test('stop edits: add, move, and remove with a clear entry for a style stop', () => {
  const own = [{ pos: 72, align: 'left', leader: 'none' }];
  assert.deepEqual(addStop(own, { pos: 36, align: 'center' }).map((t) => [t.pos, t.align]), [[36, 'center'], [72, 'left']]);
  assert.deepEqual(moveStop(own, [], 72, 90, own[0]), [{ pos: 90, align: 'left', leader: 'none' }]);
  assert.equal(removeStop(own, [], 72), null);
  const style = [{ pos: 144, align: 'right', leader: 'dot' }];
  assert.deepEqual(removeStop(own, style, 144), [{ pos: 72, align: 'left', leader: 'none' }, { pos: 144, align: 'clear', leader: 'none' }]);
  assert.deepEqual(moveStop(null, style, 144, 150, style[0]), [{ pos: 144, align: 'clear', leader: 'none' }, { pos: 150, align: 'right', leader: 'dot' }]);
});

test('table column drags: plain, Shift, Ctrl and Ctrl+Shift', () => {
  const w = [100, 100, 100, 100];
  assert.deepEqual(columnDrag(w, 0, 20), [120, 100, 100, 100]); // the table grows
  assert.deepEqual(columnDrag(w, 0, 20, { shift: true }), [120, 100, 100, 100]); // only the column to the left
  const ctrl = columnDrag([100, 100, 200], 0, 30, { ctrl: true });
  assert.deepEqual(ctrl, [130, 90, 180]); // the right columns in proportion, the table width kept
  assert.equal(ctrl.reduce((a, b) => a + b), 400);
  assert.deepEqual(columnDrag([100, 100, 200], 0, 30, { ctrl: true, shift: true }), [130, 135, 135]);
  assert.deepEqual(columnDrag(w, 1, -500), [100, 12, 100, 100]); // never below the minimum
});

test('section column drags: move the gap, an edge, and equal columns', () => {
  const cols = [{ w: 200, space: 36 }, { w: 200, space: 0 }];
  assert.deepEqual(sectionColumnsDrag(cols, 0, 'move', 10, false), [{ w: 210, space: 36 }, { w: 190, space: 0 }]);
  assert.deepEqual(sectionColumnsDrag(cols, 0, 'start', 10, false), [{ w: 210, space: 26 }, { w: 200, space: 0 }]);
  assert.deepEqual(sectionColumnsDrag(cols, 0, 'end', 10, false), [{ w: 200, space: 46 }, { w: 190, space: 0 }]);
  assert.deepEqual(sectionColumnsDrag(cols, 0, 'end', 10, true), [{ w: 195, space: 46 }, { w: 195, space: 46 }]);
});
