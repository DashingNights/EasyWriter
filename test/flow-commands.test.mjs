import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $defs, byId, CATALOGUE, MODEL_DEFS } from '../src/app/commands/catalogue.mjs';
import { FLOW_VIEW_SET } from '../src/app/commands/flow.mjs';
import { VIEW_SETS } from '../src/app/commands/tool-sets.mjs';
import { CORE, MAX_TOOL } from '../src/app/commands/tool-sets.mjs';
import { toolsFor } from '../src/app/commands/tools-schema.mjs';
import { GATES } from '../src/app/gates.mjs';
import { checkSchema, validate } from '../src/app/schema.mjs';

// flow.* (SPEC §8 Catalogue, §6f): the library commands' schemas, examples and tool sizes, and the reads on a stub store.

const FLOW = CATALOGUE.filter((d) => d.id.startsWith('flow.'));
const caps = CATALOGUE.map((d) => ({ id: d.id, title: d.title, args: d.args, needs: d.needs.map((n) => ({ gate: n.gate ?? n, fix: GATES[n.gate ?? n].fix })) }));
const model = (ids, family) => toolsFor(caps, { ids, $defs: MODEL_DEFS, form: 'model', family });

test('flow.*: valid schemas, examples that validate, the risks and undo of the coverage plan', () => {
  assert.equal(FLOW.length, 14);
  for (const d of FLOW) {
    checkSchema(d.args);
    for (const ex of d.examples) assert.deepEqual(validate(d.args, ex.args, $defs), [], `${d.id} ${JSON.stringify(ex.args)}`);
  }
  const risk = Object.fromEntries(FLOW.map((d) => [d.id, `${d.risk} ${d.undo}`]));
  assert.equal(risk['flow.items.add'], 'write own');
  assert.equal(risk['flow.items.remove'], 'destructive own');
  assert.equal(risk['flow.library.delete'], 'destructive none');
  assert.equal(risk['flow.insert'], 'write doc');
  assert.equal(risk['flow.items.straighten'], 'write own');
  assert.equal(byId('flow.open').headless, false);
});

test('FLOW_VIEW_SET: described for the model, keyboard characters, within 9 700 characters with CORE in either family', () => {
  for (const id of FLOW_VIEW_SET) assert.ok(byId(id), id);
  for (const family of ['qwen', 'gemma']) {
    for (const t of model(FLOW.map((d) => d.id), family)) assert.ok(JSON.stringify(t).length <= MAX_TOOL, `${family} ${t.function.name}`);
    const tools = model(FLOW_VIEW_SET, family);
    for (const t of tools) {
      const def = byId(t.function.name.replaceAll('_', '.'));
      assert.ok(def.brief || def.notFor, `${def.id}: no brief`);
      for (const [k, p] of Object.entries(t.function.parameters.properties)) assert.ok(p.description, `${def.id}.${k}: no description`);
      assert.ok(!/[–—…‘’“”]/.test(JSON.stringify(t)), `${def.id}: not keyboard characters`);
    }
    const size = JSON.stringify(model([...CORE, ...FLOW_VIEW_SET], family)).length;
    assert.ok(size < 9700, `${family} core + flows: ${size} characters`); // 9 500 before flow.insert's draftId, 9 000 before flow.items.straighten (8 993 then)
  }
});

test('flow.library.list, flow.library.get and flow.find on a stub store', async () => {
  const id = '5f0c2a9e-7b1d-4c3e-9a8f-1d2e3f4a5b6c';
  const T = 'https://daf.staffs.ac.uk/topic/1-x/';
  const shape = (sid, html) => ({ id: sid, type: 'shape', shape: 'diam', x: 0, y: 0, w: 100, h: 60, html });
  const record = {
    id, title: 'Door', rev: 3,
    board: { w: 1200, h: 675, frame: null, bg: 'post', items: [shape('a', 'Open?'), shape('b', 'End'), { id: 'c', type: 'connector', from: { item: 'a' }, to: { item: 'b' }, labels: { mid: { html: 'yes' } } }] },
  };
  const ctx = {
    lib: { stripImages: (v) => v },
    flows: {
      flowList: () => [{ id, title: 'Door', threadUrl: T, items: 3, updated: 5 }, { id: 'x', title: 'Other', threadUrl: null, items: 0, updated: 1 }],
      loadFlow: async (k) => (k === id ? record : null),
    },
  };
  assert.deepEqual(byId('flow.library.list').run(ctx, { threadUrl: T }), [{ flowId: id, title: 'Door', items: 3, updated: 5 }]);
  const got = await byId('flow.library.get').run(ctx, { flowId: id, format: 'brief' });
  assert.deepEqual(got.board.items[2], { id: 'c', type: 'connector', shape: undefined, label: 'yes', x: undefined, y: undefined, w: undefined, h: undefined,
    from: { item: 'a', label: 'Open?', side: 'nearest side' }, to: { item: 'b', label: 'End', side: 'nearest side' }, route: undefined, head: undefined, bends: 0 });
  const found = await byId('flow.find').run(ctx, { flowId: id, q: 'the yes arrow' });
  assert.deepEqual([found.hits, found.items[0].id], [1, 'c']);
  assert.equal((await byId('flow.find').run(ctx, { flowId: id, q: 'decision' })).hits, 2); // the kind's name
  await assert.rejects(byId('flow.find').run(ctx, { flowId: '00000000-0000-4000-8000-000000000000', q: 'x' }), (e) => e.code === 'not_found');
});

test('VIEW_SETS.flows is FLOW_VIEW_SET (tool-sets.mjs stays import-free, so the list is copied)', () => {
  assert.deepEqual(VIEW_SETS.flows, FLOW_VIEW_SET);
});
