// One name and one Lines list for every shape (docs/plans/word/briefs/shape-names-lines.md): Word's 12 Lines are the one list
// every editor shows, each a connector with Word's heads or the pen; the board's Line and Arrow are two of them; every shape has
// one name, its old board label a search word.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SHAPE_GROUPS, SHAPE_MAP, shapeItem } from '../src/document/wp/shapes/map.mjs';
import { KINDS } from '../src/flow/shapes.mjs';
import { kindEntry, LINE_KINDS, LINE_SHAPES, lineEntry, lineOf, lineSection, lineSlug, searchShapes, shapeName } from '../src/tooling/shape-picker.mjs';

const WORD_LINES = ['Line', 'Line Arrow', 'Line Arrow: Double', 'Connector: Elbow', 'Connector: Elbow Arrow', 'Connector: Elbow Double-Arrow', 'Connector: Curved',
  'Connector: Curved Arrow', 'Connector: Curved Double-Arrow', 'Curve', 'Freeform: Shape', 'Freeform: Scribble'];

test('one Lines list: Word\'s 12 entries in its order, the same list Word\'s Insert Shapes draws from', () => {
  assert.deepEqual(Object.keys(LINE_SHAPES), WORD_LINES);
  assert.deepEqual(SHAPE_GROUPS[0], ['Lines', WORD_LINES]);
  for (const n of WORD_LINES) assert.equal(SHAPE_MAP[n], LINE_SHAPES[n], n);
  const s = lineSection();
  assert.equal(s.title, 'Lines');
  assert.deepEqual(s.entries.map((e) => [e.ref, e.id, e.label]), WORD_LINES.map((n) => [`line:${n}`, n, n]));
});

test('each entry is a connector with Word\'s route and heads, or a board tool', () => {
  const look = (n) => (LINE_SHAPES[n].conn ? `${LINE_SHAPES[n].conn.route} ${LINE_SHAPES[n].conn.heads.start}-${LINE_SHAPES[n].conn.heads.end}` : LINE_SHAPES[n].tool);
  assert.deepEqual(WORD_LINES.map(look), ['straight none-none', 'straight none-arrow', 'straight arrow-arrow', 'ortho none-none', 'ortho none-arrow', 'ortho arrow-arrow',
    'curve none-none', 'curve none-arrow', 'curve arrow-arrow', 'curve', 'freeform', 'pen']);
  // Word's own canvas items keep these: Connector: Elbow Arrow is an elbow connector with an end arrow.
  const it = shapeItem('Connector: Elbow Arrow', { x: 0, y: 0, w: 100, h: 50 });
  assert.equal(it.type, 'connector');
  assert.deepEqual([it.route, it.heads], ['ortho', { start: 'none', end: 'arrow' }]);
  for (const n of WORD_LINES) if (LINE_SHAPES[n].conn) assert.equal(lineOf(LINE_SHAPES[n].conn), n, 'a connector tool set by an entry reads back as it');
  assert.equal(lineOf({ route: 'ortho', heads: { start: 'none', end: 'triangle' } }), null);
  assert.equal(lineOf({}), null);
});

test('the board\'s Line and Arrow are Word\'s Line and Line Arrow, named so everywhere', () => {
  assert.deepEqual(LINE_KINDS, { line: 'Line', arrow: 'Line Arrow' });
  for (const [kind, name] of Object.entries(LINE_KINDS)) {
    assert.ok(KINDS.some((k) => k.kind === kind), kind);
    assert.equal(shapeName(kind), name);
    assert.equal(lineOf(LINE_SHAPES[name].conn), name, 'it arms the straight connector');
  }
});

test('one name per shape: the quick shapes, tool search and layers say Word\'s names; the old labels still find them', () => {
  const basic = KINDS.filter((k) => k.group === 'basic').map((k) => shapeName(k.kind));
  assert.deepEqual(basic.slice(0, 7), ['Rectangle', 'Rectangle: Rounded Corners', 'Oval', 'Isosceles Triangle', 'Star: 5 Points', 'Line Arrow', 'Line']);
  assert.ok(!basic.includes('Box') && !basic.includes('Circle'), basic.join());
  assert.equal(kindEntry('rect').label, 'Rectangle');
  assert.ok(kindEntry('rect').keywords.includes('box') && kindEntry('ellipse').keywords.includes('circle'));
  assert.equal(searchShapes([{ id: 'x', entries: KINDS.map((k) => kindEntry(k.kind)) }], 'box')[0].label, 'Rectangle');
});

test('the Lines search finds the board\'s old connector tiles by their words', () => {
  const find = (q) => searchShapes([lineSection()], q).map((e) => e.label);
  assert.ok(find('elbow').slice(0, 3).every((n) => n.startsWith('Connector: Elbow')), find('elbow').join());
  assert.ok(find('two-way').includes('Line Arrow: Double') && find('two-way').includes('Connector: Curved Double-Arrow'));
  assert.ok(find('scribble')[0] === 'Freeform: Scribble' && find('pen')[0] === 'Freeform: Scribble' && find('curve')[0] === 'Curve' && find('freeform')[0] === 'Freeform: Shape');
  assert.ok(lineEntry('Line').keywords.includes('connector') && !lineEntry('Line').keywords.includes('arrow'));
});

test('an id part per entry, each its own', () => {
  assert.equal(lineSlug('Connector: Elbow Double-Arrow'), 'connectorElbowDoubleArrow');
  assert.equal(lineSlug('Line'), 'line');
  assert.equal(new Set(WORD_LINES.map(lineSlug)).size, 12);
});
