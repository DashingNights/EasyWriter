import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromThousandths, patched, placeAt } from '../src/app/commands/board.mjs';
import { $defs, byId, CATALOGUE, MODEL_DEFS } from '../src/app/commands/catalogue.mjs';
import { endBoxes, facing, straightPatch } from '../src/app/commands/connectors.mjs';
import { argsMessage, ID_RE, RISKS, UNDOS } from '../src/app/commands/define.mjs';
import { PALETTE_COMMANDS } from '../src/app/commands/palette.mjs';
import { CATEGORIES, categoryOf, CORE, VIEW_SETS } from '../src/app/commands/tool-sets.mjs';
import { toolsFor } from '../src/app/commands/tools-schema.mjs';
import { GATES } from '../src/app/gates.mjs';
import { checkSchema, validate } from '../src/app/schema.mjs';
import { rotBox } from '../src/flow/shapes.mjs';
import { parseBoard } from '../src/whiteboard.js';

// The command contract (SPEC §8): what every catalogue entry must satisfy, whatever stage adds it.

const LINK_REMOVALS = ['plan.deps.remove', 'plan.tickets.labels.remove'];
// What a destructive command can remove (SPEC §8 What counts as destructive): its title names one of them.
const OBJECTS = /\b(drafts?|folders?|threads?|tags?|blocks?|items?|plans?|tickets?|columns?|units?|labels?|views?|holidays?|checklist|links?|flowcharts?|prefabs?)\b/i;

/** Whether `schema` (or a schema inside it) is the PATH $ref. */
const usesPath = (schema) => JSON.stringify(schema).includes('"#/$defs/PATH"');

test('ids are unique, well formed, and short enough for MCP tool names', () => {
  assert.equal(new Set(CATALOGUE.map((d) => d.id)).size, CATALOGUE.length);
  for (const d of CATALOGUE) {
    assert.match(d.id, ID_RE, d.id);
    assert.ok(d.id.length <= 48, d.id);
    assert.ok(d.id.replace(/\./g, '_').length <= 64, d.id);
    assert.equal(byId(d.id), d);
  }
});

test('risk, undo, headless, slow and needs are in range; every gate exists with a message and a fix', () => {
  for (const d of CATALOGUE) {
    assert.ok(RISKS.includes(d.risk), d.id);
    assert.ok(UNDOS.includes(d.undo), d.id);
    assert.equal(typeof d.headless, 'boolean', d.id);
    assert.equal(typeof d.slow, 'boolean', d.id);
    for (const n of d.needs) {
      const g = GATES[typeof n === 'string' ? n : n.gate];
      assert.ok(g, `${d.id} needs ${JSON.stringify(n)}`);
      assert.ok(g.message && g.fix, `${d.id}: gate without message or fix`);
    }
  }
});

test('every example validates against its command\'s args', () => {
  for (const d of CATALOGUE) {
    assert.ok(d.examples.length >= 1, d.id);
    for (const ex of d.examples) assert.deepEqual(validate(d.args, ex.args, $defs), [], `${d.id} ${JSON.stringify(ex.args)}`);
  }
});

test('path arguments use the PATH schema; doc writes undo through the document', () => {
  for (const d of CATALOGUE) {
    for (const [k, s] of Object.entries(d.args.properties ?? {})) {
      if (['path', 'paths', 'at'].includes(k) && d.group === 'doc') assert.ok(usesPath(s), `${d.id}.${k} must use #/$defs/PATH`);
    }
    if (d.group === 'doc' && d.risk !== 'read') assert.equal(d.undo, 'doc', d.id);
  }
});

test('removals are destructive (links excepted), destructive titles name the object, no .set takes a whole list', () => {
  for (const d of CATALOGUE) {
    if (/\.(delete|remove)$/.test(d.id) && !LINK_REMOVALS.includes(d.id)) assert.equal(d.risk, 'destructive', d.id);
    if (d.risk === 'destructive') assert.match(d.title, OBJECTS, `${d.id}: "${d.title}" names no object`);
    if (/\.set[A-Z]?\w*$/.test(d.id)) {
      for (const [k, s] of Object.entries(d.args.properties ?? {})) assert.notEqual(s.type, 'array', `${d.id}.${k} is a whole list`);
    }
  }
});

test('$defs hold the shared schemas', () => {
  assert.deepEqual(Object.keys($defs).sort(), ['ID', 'ITEM', 'PATH', 'TAG_ID', 'URL']);
  assert.deepEqual(validate($defs.PATH, [0, 2]), []);
  assert.equal(validate($defs.URL, 'https://example.com/topic/1').length, 1);
});

test('every command the palette runs is in the catalogue', () => {
  for (const id of PALETTE_COMMANDS) assert.ok(byId(id), id);
});

test('ITEM: board items take #/$defs/ITEM; it accepts what parseBoard keeps and refuses a nested canvas', () => {
  for (const d of CATALOGUE) if (d.args.properties?.items) assert.ok(JSON.stringify(d.args.properties.items).includes('"#/$defs/ITEM"'), d.id);
  const items = [
    { id: 't', type: 'text', html: 'Hi', x: 0, y: 0, w: 200, size: 20, color: '#ffffff', bold: false, align: 'left', bg: null },
    { id: 's', type: 'shape', shape: 'diam', x: 0, y: 80, w: 160, h: 110, color: '#ffffff', width: 2, opacity: 1, fill: 'none', fillColor: '#ffffff', rot: 30 },
    { id: 'c', type: 'connector', from: { item: 't', anchor: 's' }, to: { item: 's', anchor: [0.5, 0] }, labels: { mid: { html: 'yes' } } },
    { id: 'k', type: 'stroke', x: 0, y: 0, w: 10, h: 10, vw: 10, vh: 10, d: 'M0 0L10 10', color: '#e05252', width: 4, opacity: 1 },
    { id: 'v', type: 'canvas', x: 300, y: 0, w: 400, h: 225, aw: 800, ah: 450, frame: null, bg: 'post', items: [{ id: 'i', type: 'text', html: 'In', x: 0, y: 0, w: 100 }] },
  ];
  assert.equal(parseBoard(JSON.stringify({ items })).items.length, items.length);
  for (const i of items) assert.deepEqual(validate($defs.ITEM, i), [], i.type);
  const nested = { ...items[4], items: [{ ...items[4], id: 'w', items: [] }] };
  assert.notDeepEqual(validate($defs.ITEM, nested), []);
  assert.notDeepEqual(validate($defs.ITEM, { type: 'shape', shape: 'blob', x: 0, y: 0, w: 1, h: 1 }), []);
});

test('every command has a category with an about-line, and a title of at most 90 characters', () => {
  for (const d of CATALOGUE) {
    assert.ok(CATEGORIES[categoryOf(d)], `${d.id}: category ${categoryOf(d)} has no line in tool-sets.mjs CATEGORIES`);
    assert.ok(d.title.length <= 90, `${d.id}: ${d.title.length} characters`);
  }
});

test('commands.index filters the catalogue; commands.describe returns model-form schemas with every $ref resolved', () => {
  const caps = CATALOGUE.map(({ id, title, group, risk, args }) => ({ id, title, group, risk, args, needs: [] }));
  const ctx = { lib: { capabilities: () => caps, tools: (ids) => toolsFor(caps, { ids, $defs: MODEL_DEFS, form: 'model' }) } };
  const index = (a) => byId('commands.index').run(ctx, a);
  const names = (r) => r.tools.map((t) => t.name);
  const { categories } = index({});
  assert.equal(categories.reduce((n, c) => n + c.count, 0), CATALOGUE.length);
  assert.ok(categories.every((c) => c.about), JSON.stringify(categories));
  const board = index({ category: 'board' });
  assert.ok(names(board).includes('board_items_add') && board.tools.every((t) => t.about && RISKS.includes(t.risk)));
  assert.deepEqual(names(index({ view: 'editor' })).sort(), [...CORE, ...VIEW_SETS.editor].map((id) => id.replaceAll('.', '_')).sort());
  assert.deepEqual(names(index({ category: 'drafts', q: 'set tag' })), ['drafts_setTag']);
  // A word search also returns the matching playbooks (playbooks.mjs), only then.
  assert.deepEqual(index({ q: 'tag' }).playbooks.map((p) => p.title), ['Set the tag of a draft']);
  assert.ok(index({ q: 'tag' }).playbooks[0].text.includes('drafts_setTag') && !index({ category: 'board' }).playbooks);
  assert.throws(() => index({ category: 'nope' }), (e) => e.code === 'not_found');
  const r = byId('commands.describe').run(ctx, { names: ['board_set', 'nope', 'doc.command'] });
  assert.deepEqual(r.tools.map((t) => t.function.name), ['doc_command', 'board_set']);
  assert.deepEqual(r.unknown, ['nope']);
  assert.deepEqual(r.risk, { board_set: 'write', doc_command: 'write' });
  assert.ok(!JSON.stringify(r.tools).includes('$ref'));
  for (const t of r.tools) checkSchema(t.function.parameters);
});

test('argsMessage: the validator line, the nearest description up the path and the first example', () => {
  const msg = (id, args, at) => argsMessage(byId(id), validate(byId(id).args, args, $defs)[0], $defs, at);
  assert.equal(msg('board.get', { path: [4], itemPath: ['the yes arrow'] }),
    'args/itemPath/0 must match ^[A-Za-z0-9_-]{1,32}$. itemPath: Only for a canvas item inside a whiteboard, as its id. Omit it for a canvas block. Example: {"path":[4]}');
  assert.equal(msg('board.items.update', { path: [4], id: 'k3j9x0a' }),
    'args/patch is required. patch: Item fields to set, such as x, y, html or route. A null label slot removes it. Example: {"path":[4],"id":"k3j9x0a","patch":{"x":300,"y":140}}');
  assert.match(msg('drafts.open', { draftId: 'Week 1' }), /^args\/draftId must match .+\. draftId: The draft id from drafts_list\. Example: \{"draftId":"0b2c8f0e-/); // beside a $ref
  assert.equal(msg('tags.list', { x: 1 }), 'args/x is not allowed (allowed: none). Example: {}'); // no description on the way
  assert.match(msg('doc.delete', { paths: [[-1]] }, 'steps[1].args'), /^steps\[1\]\.args\/paths\/0\/0 must be at least 0\. paths: Block paths from doc_get outline, such as \[\[4\]\]\. Example: /);
  // A union names its alternatives (wave 1c): its own words, else each branch's.
  assert.match(msg('doc.insert', { at: '[3]', content: { markdown: 'x' } }), /^args\/at must match exactly one of 2 forms\. at: A block path such as \[3\], or one of start, end, cursor\. Example: /);
  assert.match(msg('drafts.setThread', { draftId: '0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55', threadUrl: 5 }), /^args\/threadUrl must match one of 2 forms\. threadUrl: Text, or null\. Example: /);
  assert.match(msg('doc.format', { path: [1] }), /^args must match one of 3 forms\. With marks, or with block, or with presetId\. Example: /);
});

test('a batch step id may be a tool name', () => {
  assert.deepEqual(validate(byId('batch').args, { steps: [{ id: 'doc_insert', args: { at: 'end', content: { markdown: 'x' } } }] }, $defs), []);
});

test('board.items.update: route straight drops a connector\'s waypoints unless the patch sets points; slots merge', () => {
  const c = { id: 'c', type: 'connector', route: 'straight', points: [{ x: 1, y: 2 }], labels: { mid: { html: 'yes' }, end: { html: 'x' } }, heads: { end: 'arrow' } };
  assert.deepEqual(patched(c, { route: 'straight' }).points, []);
  assert.deepEqual(patched(c, { route: 'straight', points: [{ x: 5, y: 5 }] }).points, [{ x: 5, y: 5 }]);
  assert.deepEqual(patched(c, { route: 'ortho' }).points, [{ x: 1, y: 2 }]);
  assert.deepEqual(patched(c, { labels: { end: null }, heads: { start: 'bar' } }), { ...c, labels: { mid: { html: 'yes' } }, heads: { end: 'arrow', start: 'bar' } });
  assert.match(byId('board.items.update').brief, /route straight also drops an arrow's bends/);
});

test('board.items.place: the box goes gap px beside the other one, the other axis lined up unless align is false', () => {
  const pump = { x: 230, y: 220, w: 160, h: 80 };
  const valve = { x: 420, y: 40, w: 160, h: 80 };
  assert.deepEqual(placeAt(valve, pump, 'left', 24, true), { x: 46, y: 220 }); // the eval's move-valve: right edge 206, 24 px left of 230
  assert.deepEqual(placeAt(valve, pump, 'right', 24, true), { x: 414, y: 220 });
  assert.deepEqual(placeAt(valve, pump, 'above', 10, true), { x: 230, y: 130 });
  assert.deepEqual(placeAt(valve, pump, 'below', 0, true), { x: 230, y: 300 });
  assert.deepEqual(placeAt(valve, pump, 'left', 24, false), { x: 46, y: 40 });
  assert.deepEqual(placeAt(valve, pump, 'below', 24, false), { x: 420, y: 324 });
  assert.deepEqual(placeAt(valve, pump, 'right', 24, false), { x: 414, y: 40 });
  assert.deepEqual(placeAt(valve, pump, 'above', 24, false), { x: 420, y: 116 });
  const place = byId('board.items.place');
  assert.deepEqual([place.risk, place.undo, place.args.properties.gap.default, place.args.properties.align.default], ['write', 'doc', 24, true]);
  const render = byId('view.render');
  assert.deepEqual([render.risk, render.headless], ['read', true]); // a board's picture needs no window; the whole view gates on window.visible
});

test('board.items.straighten: route straight, no points, each bound end on the side facing the other end; free ends stay', () => {
  const box = (id, x, y, w = 180, h = 80) => ({ id, type: 'shape', shape: 'rect', x, y, w, h });
  // The straighten-yes fixture (flowchart canvas at [2]): Decision and End side by side, 120 px apart, the arrow from bottom to bottom.
  const items = [box('d4q8n1x', 360, 170), box('e9r3t6w', 660, 170), box('low', 360, 400)];
  const yes = { id: 'y6b1v4z', type: 'connector', from: { item: 'd4q8n1x', anchor: [0.5, 1] }, to: { item: 'e9r3t6w', anchor: [0.5, 1] }, route: 'straight', points: [{ x: 450, y: 340 }, { x: 750, y: 340 }] };
  const boxOf = (i) => i;
  assert.deepEqual(straightPatch(items, yes, boxOf), { route: 'straight', points: [], from: { item: 'd4q8n1x', anchor: 'e' }, to: { item: 'e9r3t6w', anchor: 'w' } });
  assert.deepEqual(straightPatch(items, { ...yes, from: yes.to, to: yes.from }, boxOf).from, { item: 'e9r3t6w', anchor: 'w' }); // right to left
  assert.deepEqual(facing(items[0], items[2]), ['s', 'n']); // above: vertical gap 150 > horizontal -180
  assert.deepEqual(facing(items[2], items[0]), ['n', 's']);
  assert.deepEqual(facing({ x: 0, y: 0, w: 100, h: 100 }, { x: 150, y: 300, w: 100, h: 100 }), ['s', 'n']); // gaps 50 and 200
  assert.deepEqual(facing({ x: 0, y: 0, w: 100, h: 100 }, { x: 300, y: 150, w: 100, h: 100 }), ['e', 'w']); // gaps 200 and 50
  assert.deepEqual(facing({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 10, w: 100, h: 100 }), ['e', 'w']); // overlapping: -50 > -90
  // A turned shape: its side is picked by its bounding box, its anchor is the one now on that side (Decision turned 90: its n).
  const turned = [{ ...items[0], rot: 90 }, items[1]];
  assert.deepEqual(straightPatch(turned, yes, (i) => (i.rot ? rotBox(i) : i)).from, { item: 'd4q8n1x', anchor: 'n' });
  // A free end stays and counts as a point; an end on a missing item keeps its anchor; both ends on one item is refused.
  assert.deepEqual(straightPatch(items, { ...yes, to: { x: 100, y: 210 } }, boxOf), { route: 'straight', points: [], from: { item: 'd4q8n1x', anchor: 'w' } });
  assert.deepEqual(straightPatch(items, { ...yes, to: { item: 'gone' } }, boxOf), { route: 'straight', points: [] });
  assert.throws(() => straightPatch(items, { ...yes, to: { item: 'd4q8n1x', anchor: [0, 0.5] } }, boxOf), (e) => e.code === 'invalid_args' && /Both ends/.test(e.message));
  // The labels and heads are not in the patch, so they stay (patched merges); the result names each end's box and side.
  assert.equal(patched({ ...yes, labels: { mid: { html: 'yes' } } }, straightPatch(items, yes, boxOf)).labels.mid.html, 'yes');
  assert.deepEqual(endBoxes(items, { ...yes, from: { item: 'd4q8n1x', anchor: [1, 0.5] }, to: { x: 1.4, y: 2 } }, boxOf),
    { from: { id: 'd4q8n1x', x: 360, y: 170, w: 180, h: 80, side: 'right' }, to: { x: 1, y: 2 } });
  const [s, f] = [byId('board.items.straighten'), byId('flow.items.straighten')];
  assert.deepEqual([s.risk, s.undo, s.needs, f.risk, f.undo], ['write', 'doc', ['doc.open', 'node.board'], 'write', 'own']);
  assert.ok(VIEW_SETS.board.includes('board.items.straighten') && VIEW_SETS.flows.includes('flow.items.straighten'));
  assert.match(byId('board.items.update').notFor, /board_items_straighten/);
});

test('board.find: past 40 hits it is sparse; a q that is an item id puts that item first, even a skipped word or a shape word', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: i === 50 ? 'a' : i === 55 ? 'rect' : `s${i}`, type: 'shape', shape: 'rect', x: i, y: 0, w: 10, h: 10, html: `Step ${i}` }));
  const node = { type: { name: 'canvas' }, attrs: { items }, nodeSize: 2 };
  const ctx = { editor: { state: { doc: { childCount: 1, child: () => node, nodeAt: () => node } }, view: { nodeDOM: () => null } }, state: { rev: 1, draft: null } };
  const find = (q) => byId('board.find').run(ctx, { path: [0], q });
  const all = find('step');
  assert.deepEqual([all.hits, all.items.length, all.sparse, all.next.length], [60, 40, true, 20]);
  assert.equal(all.hint, 'Read one with board_find {"path":[0],"q":"s40"}.');
  assert.deepEqual(validate(byId('board.find').args, JSON.parse(all.hint.slice(all.hint.indexOf('{'), -1)), $defs), []);
  for (const id of ['a', 'rect', 's59']) assert.equal(find(id).items[0].id, id, id);
});

test('board.items.add and .update with coords thousandths: x and w scale by the drawn width, y and h by the height, to whole px', () => {
  // Qwen Cloud (2026-10-08): its box for a map's mid area on a 1454 x 730 whiteboard, in thousandths.
  const node = { type: { name: 'whiteboard' }, attrs: { items: [], height: 730 }, nodeSize: 2 };
  const wb = { items: [], clampItem() {}, commit() { node.attrs.items = this.items; } };
  const doc = { childCount: 1, child: () => node, nodeAt: () => node, descendants() {} };
  const view = { nodeDOM: () => ({ offsetWidth: 1454, wbView: wb }), state: { tr: { setMeta() { return this; } } }, dispatch() {} };
  const ctx = { editor: { state: { doc }, view }, state: { rev: 1, settings: { theme: 'dark' } }, lib: { stripImages: (i) => i } };
  byId('board.items.add').run(ctx, { path: [0], coords: 'thousandths', items: [{ type: 'shape', shape: 'rect', x: 571, y: 297, w: 329, h: 418 }] });
  const [s] = wb.items;
  assert.deepEqual([s.x, s.y, s.w, s.h], [830, 217, 478, 305]);
  // update converts its patch before it validates and checks it.
  const { item } = byId('board.items.update').run(ctx, { path: [0], id: s.id, coords: 'thousandths', patch: { x: 500, w: 100 } });
  assert.deepEqual([item.x, item.y, item.w, item.h], [727, 217, 145, 305]);
  // A w or h that rounds to 0 stays 1 px.
  assert.deepEqual(fromThousandths({ x: 1, w: 1, h: 1 }, { w: 300, h: 300 }), { x: 0, w: 1, h: 1 });
  // A connector's free ends and waypoints scale too; a bound end stays.
  assert.deepEqual(fromThousandths({ type: 'connector', from: { item: 'a', anchor: 's' }, to: { x: 500, y: 500 }, points: [{ x: 1000, y: 0 }] }, { w: 1454, h: 730 }),
    { type: 'connector', from: { item: 'a', anchor: 's' }, to: { x: 727, y: 365 }, points: [{ x: 1454, y: 0 }] });
});
