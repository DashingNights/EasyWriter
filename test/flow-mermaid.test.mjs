import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromGraph, toGraph } from '../src/flow/graph.mjs';
import { isMermaid, parseMermaid, toMermaid } from '../src/flow/mermaid.mjs';
import { resolveConnectors } from '../src/flow/route.mjs';
import { flowPreset, KINDS } from '../src/flow/shapes.mjs';

// Every bracket shape, an @{shape} node, every link form (both label forms), chains, &, a nested subgraph with a direction,
// an edge to a subgraph, classDef / class / ::: / style, comments, entity codes and <br>.
const FIXTURE = `%% every form
flowchart LR
  A[Start] --> B(Rounded) --- C([Stadium])
  C -.-> D[[Sub]] ==> E[(DB)]
  E --o F((Circle)) --x G{Decide}
  G <--> H{{Prep}}
  H o--o I[/In/]
  I x--x J[\\Out\\]
  J -->|yes| K[/Pri\\] -- no --> L[\\Man/]
  L -. maybe .-> M@{ shape: doc, label: "A #quot;doc#quot;" } == big ==> N@{ shape: cyl }
  M --- O["Two<br>lines"]
  subgraph S1 [Phase one]
    direction TB
    P & Q --> R
    subgraph S2
      T
    end
  end
  R --> S1
  classDef hot fill:#f9f,stroke:#333,color:#000
  class P,Q hot
  T:::hot
  style A fill:#fff
`;

const parsed = (text) => {
  const r = parseMermaid(text);
  assert.ok(!r.error, JSON.stringify(r.error));
  return r.graph;
};

test('parseMermaid reads every shape, link and label form of the fixture', () => {
  const g = parsed(FIXTURE);
  assert.equal(g.dir, 'LR');
  const kind = Object.fromEntries(g.nodes.map((n) => [n.id, n.kind]));
  assert.deepEqual(kind, {
    A: 'rect', B: 'round', C: 'stadium', D: 'fr-rect', E: 'cyl', F: 'ellipse', G: 'diam', H: 'hex', I: 'lean-r', J: 'lean-l', K: 'trap-b',
    L: 'trap-t', M: 'doc', N: 'cyl', O: 'rect', P: 'rect', Q: 'rect', R: 'rect', T: 'rect',
  });
  const n = (id) => g.nodes.find((x) => x.id === id);
  assert.equal(n('M').label, 'A "doc"');
  assert.equal(n('N').label, 'N');
  assert.equal(n('O').label, 'Two\nlines');
  const link = (from, to) => g.edges.find((e) => e.from === from && e.to === to);
  const form = (e) => [e.heads.start, e.heads.end, e.dash, !!e.thick, e.label ?? null];
  assert.deepEqual(form(link('A', 'B')), ['none', 'arrow', 'solid', false, null]);
  assert.deepEqual(form(link('B', 'C')), ['none', 'none', 'solid', false, null]);
  assert.deepEqual(form(link('C', 'D')), ['none', 'arrow', 'dotted', false, null]);
  assert.deepEqual(form(link('D', 'E')), ['none', 'arrow', 'solid', true, null]);
  assert.deepEqual(form(link('E', 'F')), ['none', 'circle', 'solid', false, null]);
  assert.deepEqual(form(link('F', 'G')), ['none', 'cross', 'solid', false, null]);
  assert.deepEqual(form(link('G', 'H')), ['arrow', 'arrow', 'solid', false, null]);
  assert.deepEqual(form(link('H', 'I')), ['circle', 'circle', 'solid', false, null]);
  assert.deepEqual(form(link('I', 'J')), ['cross', 'cross', 'solid', false, null]);
  assert.deepEqual(form(link('J', 'K')), ['none', 'arrow', 'solid', false, 'yes']);
  assert.deepEqual(form(link('K', 'L')), ['none', 'arrow', 'solid', false, 'no']);
  assert.deepEqual(form(link('L', 'M')), ['none', 'arrow', 'dotted', false, 'maybe']);
  assert.deepEqual(form(link('M', 'N')), ['none', 'arrow', 'solid', true, 'big']);
  assert.ok(link('P', 'R') && link('Q', 'R') && link('R', 'S1'), 'P & Q --> R, and the edge to the subgraph');
  assert.deepEqual(g.groups, [
    { id: 'S1', kind: 'frame', label: 'Phase one', members: ['S2', 'P', 'Q', 'R'], dir: 'TB' },
    { id: 'S2', kind: 'frame', label: 'S2', members: ['T'] },
  ]);
  const hot = { fill: '#ff99ff', stroke: '#333333', text: '#000000' };
  assert.deepEqual([n('P').style, n('Q').style, n('T').style, n('A').style, n('B').style], [hot, hot, hot, { fill: '#ffffff' }, undefined]);
});

// Node and member order follow the subgraph blocks toMermaid writes; edges keep their order.
const sameish = (x) => ({ ...x, nodes: [...x.nodes].sort((a, b) => a.id.localeCompare(b.id)), groups: x.groups.map((gr) => ({ ...gr, members: [...gr.members].sort() })) });

test('toMermaid → parseMermaid gives the same graph (the fixture, and the fixture through board items)', () => {
  const g = parsed(FIXTURE);
  const { text, warnings } = toMermaid(g);
  assert.deepEqual(warnings, []);
  assert.deepEqual(sameish(parsed(text)), sameish(g));
  // Through items, as Import diagram and Copy as Mermaid do: laid out, routed, read back with the theme's look left out.
  const preset = flowPreset('dark');
  const made = fromGraph(g, { unit: 2, preset });
  assert.ok(!made.error);
  const items = resolveConnectors(made.items).items;
  assert.equal(items.filter((i) => i.type === 'connector').length, g.edges.length);
  const back = toGraph(items, { unit: 2, preset });
  const again = parsed(toMermaid(back).text);
  const flat = (x) => ({ ...x, groups: x.groups.map(({ dir, ...gr }) => gr) }); // a frame keeps no subgraph direction
  assert.deepEqual(sameish(again), sameish(flat(g)));
});

test('every registry kind maps to a Mermaid shape or a box, and back', () => {
  for (const { kind } of KINDS) {
    const { text, warnings } = toMermaid({ dir: 'TB', nodes: [{ id: 'a', kind, label: 'Label' }], edges: [], groups: [] });
    const back = parsed(text).nodes[0].kind;
    if (back === 'rect' && kind !== 'rect') assert.deepEqual(warnings.map((w) => w.code), ['lossy'], kind);
    else assert.equal(back, kind, `${kind} → ${text}`);
  }
  // A text node (Mermaid's text block) too.
  assert.equal(parsed(toMermaid({ nodes: [{ id: 'a', kind: 'text', label: 'Note' }], edges: [], groups: [] }).text).nodes[0].kind, 'text');
});

test('toMermaid: start / end labels, rotation, odd heads, lanes and odd ids are reported as lossy', () => {
  const { text, warnings } = toMermaid({
    dir: 'LR',
    nodes: [{ id: 'end', kind: 'rect', label: 'x', rot: 30 }, { id: 'b c', kind: 'star', label: 'y' }],
    edges: [{ id: 'e', from: 'end', to: 'b c', label: 'mid', startLabel: '1', endLabel: 'n', heads: { start: 'diamond', end: 'one' }, dash: 'solid' }],
    groups: [{ id: 'g', kind: 'lane', label: 'Lane', members: ['end'] }],
  });
  assert.equal(warnings.length, 5, JSON.stringify(warnings)); // lane, rotation, shape, heads, start / end labels
  const g = parsed(text);
  assert.deepEqual(g.nodes.map((n) => [n.id, n.kind, n.label]), [['n1', 'rect', 'x'], ['n2', 'rect', 'y']]);
  assert.deepEqual(g.edges.map((e) => [e.from, e.to, e.label, e.heads.start, e.heads.end]), [['n1', 'n2', 'mid', 'arrow', 'arrow']]);
  assert.deepEqual(g.groups.map((x) => [x.id, x.kind, x.members]), [['g', 'frame', ['n1']]]);
});

test('parseMermaid: the first error with its line and column', () => {
  const at = (text) => {
    const { error } = parseMermaid(text);
    return error && [error.line, error.col];
  };
  assert.deepEqual(at('hello'), [1, 1]);
  assert.deepEqual(at('flowchart LR\n  A[Start --> B'), [2, 4]);
  assert.deepEqual(at('flowchart LR\n  A -- yes B'), [2, 5]);
  assert.deepEqual(at('graph TD\n  A --> B\n  end'), [3, 3]);
  assert.deepEqual(at('flowchart TB\n  A -->|yes B'), [2, 14]);
  assert.deepEqual(at('flowchart TB\n  A --> B C'), [2, 11]);
  assert.deepEqual(at('flowchart TB\n  subgraph X\n  A'), [3, 4]);
  assert.deepEqual(at('flowchart TB\n  subgraph A\n  end\n  subgraph A\n  end'), [4, 3]); // an id twice
  assert.match(parseMermaid('flowchart TB\n  subgraph X\n  A').error.message, /has no "end"/);
  assert.equal(parseMermaid('x'.repeat(1_000_001)).error.line, 1);
});

test('parseMermaid: unknown shapes and skipped statements are warnings; ~~~ draws nothing; graph TD is TB; a glued o / x is a head', () => {
  const r = parseMermaid('graph TD;A@{ shape: bogus } ~~~ B\nlinkStyle 0 stroke:#f00\nclick A callback');
  assert.equal(r.graph.dir, 'TB');
  assert.equal(r.graph.edges.length, 0);
  assert.deepEqual(r.warnings.map((w) => [w.code, w.line]), [['unknown_kind', 1], ['unsupported', 2], ['unsupported', 3]]);
  assert.deepEqual(parseMermaid('graph LR\n  A---oB\n  A--xC').graph.edges.map((e) => [e.to, e.heads.end]), [['B', 'circle'], ['C', 'cross']]);
});

test('isMermaid: a flowchart / graph header line, after blank and %% lines only', () => {
  assert.ok(isMermaid('graph TD\nA-->B'));
  assert.ok(isMermaid('%%{init: {}}%%\n\n  flowchart LR; A-->B'));
  assert.ok(isMermaid('flowchart'));
  assert.ok(!isMermaid('graph of sales'));
  assert.ok(!isMermaid('Some text\nflowchart LR'));
  assert.ok(!isMermaid(null));
});
