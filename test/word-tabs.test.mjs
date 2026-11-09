// Tab stop merge and line layout (docs/plans/word/briefs/tabs.md Acceptance): Word's measured cases from index-layout.md
// "Tab stops" as fixtures, positions within 0.5 pt.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_TABS, tabStopsOf } from '../src/document/model/tabs.mjs';
import { layoutLine, nextStop, numStop, placeTab } from '../src/document/wp/tabs/layout.mjs';
import { addStop, valueTabs } from '../src/document/wp/tabs/stops.mjs';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 0.5, `${msg ?? ''} ${a} vs ${b}`);
const L = (pos, align = 'left', leader = 'none') => ({ pos, align, leader });
// A wide paragraph with default stops only: A4 text width.
const C = (o = {}) => ({ stops: [], def: 36, left: 0, firstLine: 0, right: 451.3, width: 451.3, ...o });
const xs = (items, c) => layoutLine(items, c).map((p) => p.x);

test('positions count from the column edge, not the indent: left indent 50 puts the first tab at 72', () => {
  near(layoutLine([{ tab: true }, { text: 5 }], C({ left: 50 }))[1].x, 72);
});

test('a tab goes to the first stop past the pen: "\\t\\tb" puts b at 72', () => {
  near(xs([{ tab: true }, { tab: true }, { text: 6 }], C())[2], 72);
});

test('a custom stop removes the defaults to its left: left 144, "a\\tb\\tc" puts b at 144 and c at 180', () => {
  const p = xs([{ text: 6 }, { tab: true }, { text: 6 }, { tab: true }, { text: 6 }], C({ stops: [L(144)] }));
  near(p[2], 144);
  near(p[4], 180);
});

test('a bar is not a stop and keeps the defaults: bar at 72, "a\\tb" puts b at 36', () => {
  near(xs([{ text: 6 }, { tab: true }, { text: 6 }], C({ stops: [L(72, 'bar')] }))[2], 36);
});

test('a custom stop left of the line start is skipped: first line 108 and a stop at 72 give 144', () => {
  near(xs([{ tab: true }, { text: 6 }], C({ firstLine: 108, stops: [L(72)] }))[1], 144);
});

test('negative positions work: left -36 puts the first tab at 0', () => {
  near(xs([{ tab: true }, { text: 6 }], C({ left: -36 }))[1], 0);
});

test('hanging stop: left 144 first -108 gives 144', () => {
  near(xs([{ tab: true }, { text: 6 }], C({ left: 144, firstLine: -108 }))[1], 144);
});

test('hanging stop: left 144 first -144 with a stop at 72 gives 72, then 144, then 180', () => {
  const p = xs([{ tab: true }, { text: 6 }, { tab: true }, { text: 6 }, { tab: true }, { text: 6 }], C({ left: 144, firstLine: -144, stops: [L(72)] }));
  near(p[1], 72);
  near(p[3], 144);
  near(p[5], 180);
});

test('left 36 hanging 18: "1.\\tItem" puts Item at 36 and "100.\\tItem" at 72', () => {
  near(xs([{ text: 8.5 }, { tab: true }, { text: 20 }], C({ left: 36, firstLine: -18 }))[2], 36);
  near(xs([{ text: 22 }, { tab: true }, { text: 20 }], C({ left: 36, firstLine: -18 }))[2], 72);
});

test('right stop: "x\\tabc" with a right stop at 216 ends at 216', () => {
  const p = layoutLine([{ text: 6 }, { tab: true }, { text: 18 }], C({ stops: [L(216, 'right')] }));
  near(p[2].x + 18, 216);
});

test('center stop: "abc" 19.6 wide runs 206.2 to 225.8 around 216', () => {
  near(layoutLine([{ tab: true }, { text: 19.6 }], C({ stops: [L(216, 'center')] }))[1].x, 206.2);
});

test('decimal stop: the first decimal symbol sits on the stop, and no symbol acts as right', () => {
  // "12.345": "12" is 11 wide; "ab 3.5": "ab 3" is 20 wide; "12345" 27.5 wide ends at the stop.
  const c = C({ stops: [L(216, 'decimal')] });
  near(layoutLine([{ tab: true }, { text: 30, dec: 11 }], c)[1].x + 11, 216);
  near(layoutLine([{ tab: true }, { text: 26, dec: 20 }], c)[1].x + 20, 216);
  near(layoutLine([{ tab: true }, { text: 27.5 }], c)[1].x + 27.5, 216);
});

test('right text wider than its room starts after the text before: right 60, 26 letters run 5.45 to 156', () => {
  const p = layoutLine([{ text: 5.45 }, { tab: true }, { text: 150.55 }], C({ stops: [L(60, 'right')], right: 400 }));
  near(p[2].x, 5.45);
});

test('a right stop past the right margin acts as a right stop on the margin (Word probe tabs_docx.py A)', () => {
  const p = layoutLine([{ text: 20 }, { tab: true }, { text: 40 }], C({ stops: [L(468, 'right')] }));
  assert.equal(p[2].line, 0);
  near(p[2].x + 40, 451.3);
});

test('a tab past the right indent wraps: 30 pt wide "abc\\tX" uses three lines', () => {
  const p = layoutLine([{ text: 17 }, { tab: true }, { text: 7 }], C({ right: 30, width: 30 }));
  assert.equal(p[2].line, 2);
});

test('a tab past the right indent wraps: 50 pt wide "ab\\tc\\tX" puts X at 36 on line 2', () => {
  const p = layoutLine([{ text: 11 }, { tab: true }, { text: 5 }, { tab: true }, { text: 7 }], C({ right: 50, width: 50 }));
  assert.equal(p[4].line, 1);
  near(p[4].x, 36);
});

test('A to D: stops at W/4, W/2, 3W/4 on A4 put B, C and D at 112.9, 225.8 and 338.2', () => {
  const W = 451.3;
  const c = C({ stops: [1, 2, 3].map((k) => L((k * W) / 4)) });
  const p = xs([{ text: 40 }, { tab: true }, { text: 50 }, { tab: true }, { text: 45 }, { tab: true }, { text: 48 }], c);
  near(p[2], 112.9);
  near(p[4], 225.8);
  near(p[6], 338.2);
  // Default stops only: short options land on the next 36 pt multiple.
  const d = xs([{ text: 40 }, { tab: true }, { text: 50 }, { tab: true }, { text: 40 }, { tab: true }, { text: 48 }], C());
  assert.deepEqual([d[2], d[4], d[6]], [72, 144, 216]);
});

test('with a left indent L the even spread is L + k(W - L)/4', () => {
  assert.equal(nextStop(18, { stops: [L(18 + (451.3 - 18) / 4)], def: 36 }).pos, 18 + (451.3 - 18) / 4);
});

test('the number tab (G3): label 10 with hanging 18 reaches 36, label 30 reaches 72, a level tab at 54 wins', () => {
  assert.equal(numStop(18 + 10, { left: 36, stops: [], def: 36 }), 36);
  assert.equal(numStop(18 + 30, { left: 36, stops: [], def: 36 }), 72);
  assert.equal(numStop(18 + 10, { levelTab: 54, left: 36, stops: [], def: 36 }), 54);
});

test('a default stop past the right indent at the line start fills the line', () => {
  const r = placeTab(0, { stops: [], def: 36, left: 0, right: 30, lineStart: 0, first: false });
  assert.equal(r.w, 30);
  assert.equal(r.wrap, false);
});

test('stops merge with the style chain, and a clear entry removes an inherited stop', () => {
  const doc = { attrs: { settings: { defaultTabStop: 28.35 }, styles: { list: { Normal: { para: { tabs: [L(72), L(144, 'right')] } } } } } };
  const node = { type: { name: 'paragraph' }, attrs: { tabs: [{ pos: 72, align: 'clear' }, L(200, 'center', 'dot')] } };
  const r = tabStopsOf(doc, node);
  assert.deepEqual(r.stops.map((s) => [s.pos, s.align]), [[144, 'right'], [200, 'center']]);
  assert.equal(r.default, 28.35);
});

test('the 65th stop is refused, and setting the same position replaces that stop', () => {
  const full = Array.from({ length: MAX_TABS }, (_, i) => L(i * 6 + 6));
  assert.equal(addStop(full, L(1000)), null);
  const r = addStop(full, L(6, 'right', 'dot'));
  assert.equal(r.length, MAX_TABS);
  assert.deepEqual(r[0], L(6, 'right', 'dot'));
  assert.deepEqual(addStop([L(72)], L(36)).map((s) => s.pos), [36, 72]);
});

test('a value-mode Tabs dialog keeps the clear entries of a style: opened and closed unchanged it returns them', () => {
  const given = [L(72), L(144, 'clear')];
  const shown = tabStopsOf({}, { attrs: { tabs: given } }).stops;
  assert.deepEqual(valueTabs(given, shown, []), given);
});

test('a value-mode Tabs dialog returns a clear entry for an inherited stop the user cleared', () => {
  assert.deepEqual(valueTabs([], [], [144], [L(144)]), [L(144, 'clear')]);
  assert.deepEqual(valueTabs([], [], [144]), [L(144, 'clear')]);
});
