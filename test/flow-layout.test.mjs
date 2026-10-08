import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromGraph, nodeSize, toGraph } from '../src/flow/graph.mjs';
import { layout, MAX_NODES } from '../src/flow/layout.mjs';
import { flowPreset, rotBox } from '../src/flow/shapes.mjs';

const node = (id, more = {}) => ({ id, w: 140, h: 64, ...more });
const edge = (from, to) => ({ id: `${from}${to}`, from, to });
// A diamond-shaped DAG with a long edge, a turned node (C, 40°) and a wide one (D).
const GRAPH = {
  nodes: [node('A'), node('B'), node('C', { w: 200, h: 40, rot: 40 }), node('D', { w: 260 }), node('E')],
  edges: [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D'), edge('D', 'E'), edge('A', 'E')],
  groups: [],
};
const boxes = (g, r) => g.nodes.map((n) => rotBox({ ...r.nodes[n.id], w: n.w, h: n.h, rot: n.rot }));
const centre = (r, g, id) => {
  const n = g.nodes.find((x) => x.id === id);
  return { x: r.nodes[id].x + n.w / 2, y: r.nodes[id].y + n.h / 2 };
};
const overlap = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
const inside = (inner, outer) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

test('layout: ranks increase along the edges (TB: down, LR: right, BT: up, RL: left)', () => {
  const axis = { TB: ['y', 1], LR: ['x', 1], BT: ['y', -1], RL: ['x', -1] };
  for (const [dir, [k, sign]] of Object.entries(axis)) {
    const r = layout(GRAPH, { dir });
    for (const e of GRAPH.edges) assert.ok(sign * (centre(r, GRAPH, e.to)[k] - centre(r, GRAPH, e.from)[k]) > 0, `${dir} ${e.id}`);
  }
  assert.deepEqual(layout({ ...GRAPH, dir: 'LR' }), layout(GRAPH, { dir: 'LR' }), 'graph.dir is the default');
});

test('layout: no two nodes overlap, the turned one by its turned bounds; the drawing starts at 0,0', () => {
  for (const dir of ['TB', 'LR']) {
    const r = layout(GRAPH, { dir });
    const b = boxes(GRAPH, r);
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) assert.ok(!overlap(b[i], b[j]), `${dir} ${i} ${j}`);
    assert.ok(Math.abs(Math.min(...b.map((x) => x.x))) < 1 && Math.abs(Math.min(...b.map((x) => x.y))) < 1, dir); // whole px
  }
});

test('layout: groups hold their members (nested too), an edge to a group lays out, an empty group is a node', () => {
  const g = {
    nodes: ['A', 'B', 'C', 'D', 'E'].map((id) => node(id)),
    edges: [edge('A', 'B'), edge('B', 'C'), edge('C', 'D'), edge('A', 'G2'), edge('G1', 'E')],
    groups: [{ id: 'G1', members: ['B', 'G2'] }, { id: 'G2', members: ['C'] }, { id: 'G3', members: [], w: 200, h: 100 },
      { id: 'G4', members: ['G5'] }, { id: 'G5', members: [] }], // G4 holds only an empty group
  };
  for (const dir of ['TB', 'LR']) {
    const r = layout(g, { dir });
    assert.ok(!r.error, JSON.stringify(r.error));
    const box = (id) => ({ ...r.nodes[id], w: 140, h: 64 });
    assert.ok(inside(box('B'), r.groups.G1) && inside(box('C'), r.groups.G2) && inside(r.groups.G2, r.groups.G1), dir);
    for (const id of ['A', 'D', 'E']) assert.ok(!overlap(box(id), r.groups.G1), `${dir} ${id} outside G1`);
    assert.deepEqual([r.groups.G3.w, r.groups.G3.h], [200, 100]);
    assert.ok(inside(r.groups.G5, r.groups.G4), `${dir} G5 inside G4`);
    assert.ok([...Object.values(r.nodes), ...Object.values(r.groups)].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  }
});

test('layout: the same ids twice give the same result (dagre ≥ 3.1.1 keeps no state); more than 500 nodes fail', () => {
  assert.deepEqual(layout(GRAPH), layout(GRAPH));
  const many = { nodes: Array.from({ length: MAX_NODES + 1 }, (_, k) => node(`n${k}`)), edges: [] };
  assert.equal(layout(many).error.code, 'layout_failed');
});

test('nodeSize: a label fits its kind\'s label room; circles are square; kinds with their own box keep it', () => {
  assert.deepEqual(nodeSize({ kind: 'rect', label: 'Go' }), { w: 140, h: 64 });
  const long = nodeSize({ kind: 'rect', label: 'A label much longer than the narrow default box' });
  assert.ok(long.w === 280 && long.h > 64, JSON.stringify(long)); // capped, then wrapped
  assert.ok(nodeSize({ kind: 'diam', label: 'Is the order paid?' }).w > nodeSize({ kind: 'rect', label: 'Is the order paid?' }).w);
  const c = nodeSize({ kind: 'ellipse', label: 'Two\nlines' });
  assert.equal(c.w, c.h);
  assert.deepEqual(nodeSize({ kind: 'fork', label: 'x' }), { w: 160, h: 14 });
});

test('fromGraph: laid out at the unit, graph ids kept unless taken, frames behind, theme look; toGraph reads it back', () => {
  const preset = flowPreset('light');
  const graph = {
    dir: 'LR',
    nodes: [{ id: 'A', kind: 'rect', label: 'Start' }, { id: 'B', kind: 'diam', label: 'OK?', style: { fill: '#dae8fc' } }, { id: 'T', kind: 'text', label: 'Note' }],
    edges: [{ id: 'e1', from: 'A', to: 'B', label: 'go', heads: { start: 'none', end: 'arrow' }, dash: 'dotted', thick: true }, { id: 'e2', from: 'B', to: 'G' }],
    groups: [{ id: 'G', kind: 'frame', label: 'Group', members: ['T'] }],
  };
  const { items, ids } = fromGraph(graph, { unit: 2, preset, taken: new Set(['A']), makeId: (() => { let k = 0; return () => `x${++k}`; })() });
  assert.deepEqual(items.map((i) => [i.id, i.type, i.shape ?? null]), [
    ['G', 'shape', 'frame'], ['x1', 'shape', 'rect'], ['B', 'shape', 'diam'], ['T', 'text', null], ['e1', 'connector', null], ['e2', 'connector', null],
  ]);
  assert.equal(ids.get('A'), 'x1');
  const [frame, a, b] = items;
  assert.ok(a.x + a.w <= b.x, 'LR: A left of B');
  assert.deepEqual([a.w, a.h, a.width, a.size, a.fillColor, a.color, a.textColor], [280, 128, 4, 32, preset.fillColor, preset.color, preset.textColor]);
  assert.deepEqual([b.fillColor, frame.fill, frame.html], ['#dae8fc', 'none', 'Group']);
  const c = items[4];
  assert.deepEqual([c.from.item, c.to.item, c.dash, c.width, c.labels.mid.html, c.labels.mid.size], ['x1', 'B', 'dotted', 8, 'go', 28]);
  assert.equal(items[5].to.item, 'G');
  // Back: post px, the light look left out, B's fill kept, T a member of G, the dotted thick edge.
  const back = toGraph(items, { unit: 2, preset });
  assert.equal(back.dir, 'LR');
  assert.deepEqual(back.nodes.map((n) => [n.id, n.kind, n.label, n.style ?? null]),
    [['x1', 'rect', 'Start', null], ['B', 'diam', 'OK?', { fill: '#dae8fc' }], ['T', 'text', 'Note', null]]);
  assert.deepEqual(back.nodes[0].w, 140);
  assert.deepEqual(back.groups.map((x) => [x.id, x.kind, x.label, x.members]), [['G', 'frame', 'Group', ['T']]]);
  assert.deepEqual(back.edges.map((e) => [e.from, e.to, e.label ?? null, e.dash, !!e.thick]), [['x1', 'B', 'go', 'dotted', true], ['B', 'G', null, 'solid', false]]);
});

test('toGraph: innermost container only; free connectors left out; given positions put a group around its members', () => {
  const sh = (id, shape, x, y, w, h) => ({ id, type: 'shape', shape, x, y, w, h, color: '#fff', width: 2, opacity: 1, fill: 'none', fillColor: '#000' });
  const items = [sh('outer', 'lane', 0, 0, 600, 300), sh('inner', 'frame', 20, 40, 300, 200), sh('a', 'rect', 40, 80, 100, 60),
    sh('b', 'rect', 400, 80, 100, 60), { id: 'c', type: 'connector', from: { item: 'a' }, to: { x: 900, y: 900 }, labels: {} }];
  const g = toGraph(items);
  assert.deepEqual(g.groups.map((x) => [x.id, x.members]), [['outer', ['inner', 'b']], ['inner', ['a']]]);
  assert.deepEqual(g.edges, []);
  const made = fromGraph({ nodes: [{ id: 'a', kind: 'rect', x: 40, y: 80, w: 100, h: 60 }], edges: [], groups: [{ id: 'g', members: ['a'] }] });
  assert.deepEqual(made.items.map((i) => [i.id, i.x, i.y, i.w, i.h]), [['g', 16, 56, 148, 108], ['a', 40, 80, 100, 60]]);
  const preview = fromGraph({ nodes: [{ id: 'preview', kind: 'rect', x: 0, y: 0, w: 10, h: 10 }], edges: [], groups: [] });
  assert.notEqual(preview.items[0].id, 'preview', "the Board's id for an item being drawn");
});
