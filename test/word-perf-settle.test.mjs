// perf-settle (docs/plans/word/briefs/perf-settle.md): the top-level decoration sets of a long document. The patched forChild and
// topLevelSet must give exactly what prosemirror-view's own code gives.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { endKeys, topLevelSet } from '../src/document/wp/page-engine/decorations.js';

const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*' }, text: {} } });
const doc = schema.node('doc', null, Array.from({ length: 60 }, (_, i) => schema.node('paragraph', null, i % 7 ? [schema.text(`block ${i}`)] : [])));
const starts = [];
doc.forEach((n, pos) => starts.push([pos, n]));
const own = DecorationSet.prototype.pgForChild;

/** Every child's decorations by both forChild implementations, as comparable lists. */
function both(set) {
  const list = (s) => {
    const out = [];
    s.forEachSet((x) => out.push(...x.find().map((d) => `${d.from}-${d.to}:${d.spec.key}`)));
    return out.sort().join();
  };
  return starts.map(([pos, n]) => [own.call(set, pos, n), set.forChild(pos, n)].map(list));
}

test('forChild answers as prosemirror-view does, with and without inline decorations', () => {
  const top = [];
  starts.forEach(([pos, n], i) => {
    if (i % 3 === 0) top.push(Decoration.widget(pos, () => null, { key: `w${i}` }));
    if (i % 4 === 0) top.push(Decoration.node(pos, pos + n.nodeSize, { class: 'x' }, { key: `n${i}` }));
    if (i % 5 === 1 && n.content.size) top.push(Decoration.inline(pos + 1, pos + 3, { class: 'in' }, { key: `i${i}` }));
  });
  const set = DecorationSet.create(doc, [...top]); // create consumes its array
  for (const [a, b] of both(set)) assert.equal(b, a);
  // An inline range across blocks lives at the top level: the scan stays.
  const across = DecorationSet.create(doc, [...top, Decoration.inline(starts[10][0] + 1, starts[14][0] + 2, { class: 'r' }, { key: 'across' })]);
  for (const [a, b] of both(across)) assert.equal(b, a);
  assert.ok(both(across).some(([a]) => a.includes('across')));
});

test('topLevelSet builds the set DecorationSet.create builds', () => {
  const decos = () => {
    const out = [Decoration.widget(doc.content.size, () => null, { key: 'end', side: 1 }), Decoration.widget(0, () => null, { key: 'start', side: -2 })];
    starts.forEach(([pos, n], i) => {
      if (i % 2) out.push(Decoration.node(pos, pos + n.nodeSize, { 'data-k': String(i) }));
      if (i % 6 === 0) out.push(Decoration.widget(pos, () => null, { key: `p${i}`, side: -1 }), Decoration.widget(pos, () => null, { key: `q${i}`, side: 2 }));
    });
    return out;
  };
  const a = DecorationSet.create(doc, decos());
  const b = topLevelSet(doc, decos());
  const list = (s) => s.find().map((d) => `${d.from}-${d.to}:${d.spec.key ?? ''}:${JSON.stringify(d.type.attrs ?? null)}`);
  assert.deepEqual(list(b), list(a));
  assert.ok(b.eq(a) || list(b).join() === list(a).join());
  assert.equal(topLevelSet(doc, []), DecorationSet.empty);
});

test('a page end keeps its widget key while it stays at its place', () => {
  const first = endKeys([], [], [], [10, 50, 90], [false, false, false]);
  assert.equal(new Set(first).size, 3);
  // A page more near the top (an end at 30) and the end at 50 moved to 60: the ends at 10 and 90 keep theirs.
  const next = endKeys([10, 50, 90], [false, false, false], first, [10, 30, 60, 90], [false, false, false, false]);
  assert.equal(next[0], first[0]);
  assert.equal(next[3], first[2]);
  assert.ok(!first.includes(next[1]) && !first.includes(next[2]) && next[1] !== next[2]);
  // The side of the flow widgets counts: the same place after them is another widget.
  const side = endKeys([10], [false], [first[0]], [10], [true]);
  assert.notEqual(side[0], first[0]);
  // Two ends at one place (a block longer than a page) keep theirs in turn.
  const two = endKeys([], [], [], [40, 40], [false, false]);
  assert.deepEqual(endKeys([40, 40], [false, false], two, [40, 40], [false, false]), two);
});

