// Word's Curve and Freeform: Shape as board tools (docs/plans/word/briefs/curve-freeform.md): the line through the placed points,
// the 'path' shape item it becomes, drawn where the points were, and its trip through .docx as custGeom.
import assert from 'node:assert/strict';
import test from 'node:test';
import { exportDocx } from '../src/document/docx/export.mjs';
import { importDocx } from '../src/document/docx/import.mjs';
import { readZip, text } from '../src/document/docx/zip.mjs';
import { kindOf } from '../src/flow/shapes.mjs';
import { LINE_SHAPES, lineEntry, toolLine } from '../src/tooling/shape-picker.mjs';
import { pathSegments, pathShape } from '../src/flow/presets.mjs';
import { PATH_TOOLS } from '../src/whiteboard.js';

const PTS = [{ x: 40, y: 120 }, { x: 120, y: 40 }, { x: 200, y: 130 }, { x: 300, y: 60 }];
const near = (a, b, tol = 0.05) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
// The on-curve points of path `d` (x y pairs; the last pair of each command), and its commands.
const ends = (d) => [...d.matchAll(/([MLCQ])([^MLCQZ]*)/g)].map(([, , args]) => args.trim().split(/[ ,]+/).map(Number).slice(-2)).map(([x, y]) => ({ x, y }));
const cmds = (d) => d.replace(/[^MLCQZ]/g, '');
// A path item as the board makes it (Board.pathItem), in a 2 px line.
const item = (pts, o) => ({ id: 'p', type: 'shape', shape: 'path', color: '#e05252', width: 2, opacity: 1, fill: 'none', fillColor: '#e05252', ...pathShape(pts, { pad: 1, ...o }) });
// Where the board draws item `it`'s line: its kind's path in item px (src/flow/shapes.mjs PATH_KIND), moved to the item.
const drawn = (it) => ends(kindOf('path').path(it.w, it.h, it.width / 2, it).d).map((p) => ({ x: p.x + it.x, y: p.y + it.y }));

test('Curve and Freeform: Shape arm board tools of their own; Scribble stays the pen', () => {
  assert.deepEqual(['Curve', 'Freeform: Shape', 'Freeform: Scribble'].map((n) => LINE_SHAPES[n].tool), ['curve', 'freeform', 'pen']);
  assert.deepEqual(PATH_TOOLS, ['curve', 'freeform']);
  assert.deepEqual(['curve', 'freeform', 'pen', 'shape'].map(toolLine), ['Curve', 'Freeform: Shape', 'Freeform: Scribble', null]);
  assert.ok(lineEntry('Curve').keywords.includes('bezier') && lineEntry('Freeform: Shape').keywords.includes('polygon'));
});

test('a curve runs smooth through every point: one cubic per gap, its handles in line at each inner point', () => {
  const segs = pathSegments(PTS, true);
  assert.equal(segs.length, 3);
  assert.ok(segs.every((s) => s.length === 4));
  assert.deepEqual(segs.map((s) => s[0]), PTS.slice(0, 3));
  assert.deepEqual(segs.at(-1)[3], PTS[3]);
  for (let k = 1; k < segs.length; k++) {
    const [inA, at, outB] = [segs[k - 1][2], segs[k][0], segs[k][1]];
    const cross = (at.x - inA.x) * (outB.y - at.y) - (at.y - inA.y) * (outB.x - at.x);
    assert.ok(Math.abs(cross) < 1e-6, `smooth at point ${k}`);
  }
  // Closed, it has a segment back to the first point, smooth there too.
  const shut = pathSegments(PTS, true, true);
  assert.equal(shut.length, 4);
  assert.deepEqual(shut.at(-1)[3], PTS[0]);
  // Unevenly spaced points: no handle reaches past a third of its own segment, so a short gap makes no loop.
  const odd = pathSegments([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 305, y: 5 }, { x: 305, y: 300 }], true);
  const len = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  for (const [a, c1, c2, b] of odd) assert.ok(len(a, c1) <= len(a, b) / 3 + 1e-9 && len(c2, b) <= len(a, b) / 3 + 1e-9);
  // Freeform: Shape: straight segments from corner to corner.
  assert.deepEqual(pathSegments(PTS).map((s) => s.length), [2, 2, 2]);
});

test('the line becomes a path item in its own tight box, drawn through the points it was placed by', () => {
  const open = item(PTS, { smooth: true });
  assert.equal(cmds(open.path[0].d), 'MCCC', 'open: no Z');
  assert.ok(drawn(open).every((p, k) => near(p, PTS[k])), JSON.stringify(drawn(open)));
  // The curve bows past its points: the box holds the bow, the unit square's 0 and 1 are reached on both axes.
  const xs = ends(open.path[0].d).map((p) => p.x);
  assert.ok(open.y < 40 - 1 && open.y + open.h > 130 + 1, JSON.stringify(open));
  assert.ok(Math.min(...xs) === 0 && Math.max(...xs) === 1);
  const shut = item(PTS.slice(0, 3), { smooth: true, close: true });
  assert.equal(cmds(shut.path[0].d), 'MCCCZ', 'closed: back to the first point, then Z');
  assert.ok(drawn(shut).slice(0, 3).every((p, k) => near(p, PTS[k])) && near(drawn(shut)[3], PTS[0]));
  const free = item(PTS, {});
  assert.equal(cmds(free.path[0].d), 'MLLL');
  assert.deepEqual([free.x, free.y, free.w, free.h], [39, 39, 262, 92], 'the points\' bounds grown by the half line width');
  assert.ok(drawn(free).every((p, k) => near(p, PTS[k])));
  // A straight up and down line still has a box, and no NaN.
  const flat = pathShape([{ x: 10, y: 0 }, { x: 10, y: 50 }], { pad: 1 });
  assert.deepEqual([flat.w, flat.h], [2, 52]);
  assert.doesNotMatch(flat.path[0].d, /NaN/);
  assert.equal(pathShape([{ x: 1, y: 1 }]), null, 'one point is no line');
});

test('both export to .docx as Word\'s custGeom and reopen as the same items', async () => {
  const curve = { ...item(PTS, { smooth: true }), id: 'c' };
  const shape = { ...item([{ x: 40, y: 200 }, { x: 140, y: 180 }, { x: 160, y: 260 }, { x: 150, y: 262 }, { x: 140, y: 265 }], { close: true }), id: 's', fill: 'solid' };
  const items = [curve, shape];
  const canvas = { type: 'canvas', attrs: { w: 340, h: 300, dw: 340, frame: { x: 0, y: 0, w: 340, h: 300 }, bg: 'transparent', items } };
  const { bytes, dropped } = await exportDocx({ type: 'doc', attrs: {}, content: [canvas, { type: 'paragraph', content: [] }] });
  assert.deepEqual(dropped, []);
  const xml = text((await readZip(bytes)).get('word/document.xml'));
  assert.equal((xml.match(/<a:custGeom>/g) ?? []).length, 2);
  assert.match(xml, /<a:moveTo><a:pt [^>]*\/><\/a:moveTo><a:cubicBezTo>(<a:pt [^>]*\/>){3}<\/a:cubicBezTo>/, 'the curve as cubic Béziers');
  assert.match(xml, /<a:lnTo><a:pt [^>]*\/><\/a:lnTo><a:close\/><\/a:path>/, 'the freeform as straight lines, closed');
  assert.match(xml, /<a:custGeom>.*?<\/a:custGeom><a:noFill\/>.*<a:custGeom>.*?<\/a:custGeom><a:solidFill>/s, 'the open curve unfilled, the closed shape filled');
  const back = (await importDocx(bytes, { fresh: true })).doc.content.find((n) => n.type === 'canvas').attrs.items;
  assert.equal(back.length, 2);
  for (const [k, it] of items.entries()) {
    const b = back[k];
    assert.deepEqual([b.type, b.shape, b.path, b.fill], [it.type, it.shape, it.path, it.fill], it.id);
    assert.ok(['x', 'y', 'w', 'h', 'width'].every((f) => Math.abs(b[f] - it[f]) < 0.01), JSON.stringify([b, it]));
  }
});
