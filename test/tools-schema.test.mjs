import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $defs, byId, CATALOGUE, MODEL_DEFS } from '../src/app/commands/catalogue.mjs';
import { ITEM_BRIEF } from '../src/app/commands/schema-defs.mjs';
import { assistantMode, COMPUTER, CORE, MAX_SET, MAX_TOOL, PERMISSIONS, READ_ONLY, refusal, UI_OFF, VIEW_SETS, viewOf } from '../src/app/commands/tool-sets.mjs';
import { commandIdOf, rewrite, toolName, toolsFor } from '../src/app/commands/tools-schema.mjs';
import { GATES } from '../src/app/gates.mjs';
import { validate } from '../src/app/schema.mjs';

// The OpenAI tool schemas of the assistant's tool loop (SPEC §8 Tool schemas).

test('rewrite: $ref inlined, oneOf → anyOf, nullable type list → anyOf, default / examples dropped', () => {
  const schema = {
    type: 'object', required: ['at'], additionalProperties: false, examples: [{}],
    properties: {
      at: { oneOf: [{ $ref: '#/$defs/PATH' }, { enum: ['start', 'end'] }] },
      folderId: { type: ['string', 'null'], minLength: 1 },
      flag: { type: 'boolean', default: false },
    },
  };
  assert.deepEqual(rewrite(schema, $defs), {
    type: 'object', required: ['at'], additionalProperties: false,
    properties: {
      at: { anyOf: [{ type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: 16 }, { enum: ['start', 'end'] }] },
      folderId: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
      flag: { type: 'boolean' },
    },
  });
});

test('toolsFor: the whole catalogue as tools with no $ref, oneOf, type list or default; names round-trip', () => {
  const caps = CATALOGUE.map((d) => ({ id: d.id, title: d.title, args: d.args, needs: d.needs.map((n) => ({ gate: n.gate ?? n, fix: GATES[n.gate ?? n].fix })) }));
  const tools = toolsFor(caps, { $defs });
  assert.equal(tools.length, CATALOGUE.length);
  const text = JSON.stringify(tools);
  for (const word of ['"$ref"', '"oneOf"', '"default"', '"examples"']) assert.ok(!text.includes(word), word);
  assert.ok(!/"type":\[/.test(text), 'type list');
  for (const t of tools) {
    assert.equal(t.type, 'function');
    assert.match(t.function.name, /^[a-zA-Z_]+$/);
    assert.equal(toolName(commandIdOf(t.function.name)), t.function.name);
  }
  const undo = tools.find((t) => t.function.name === 'history_undo').function.description;
  assert.match(undo, /Needs: doc\.open: .+; history\.canUndo: /);
  assert.equal(toolsFor(caps, { ids: ['doc.insert', 'drafts.delete'], $defs }).length, 2);
  assert.equal(commandIdOf('drafts_setTag'), 'drafts.setTag');
  assert.equal(commandIdOf('drafts_nope'), null);
});

const caps = CATALOGUE.map((d) => ({ id: d.id, title: d.title, args: d.args, needs: d.needs.map((n) => ({ gate: n.gate ?? n, fix: GATES[n.gate ?? n].fix })) }));
const model = (ids, family = 'qwen') => toolsFor(caps, { ids, $defs: MODEL_DEFS, form: 'model', family });
const size = (tools) => JSON.stringify(tools).length;
const descriptions = (s) => (s && typeof s === 'object'
  ? [...(typeof s.description === 'string' ? [s.description] : []), ...Object.values(s).flatMap(descriptions)] : []);

test('model form: title, brief, Not-for line, first example and guide lines; no limits, patterns or additionalProperties; every tool within MAX_TOOL', () => {
  assert.equal(MAX_TOOL, 3000);
  for (const family of ['qwen', 'gemma']) {
    const tools = model(undefined, family);
    assert.equal(tools.length, CATALOGUE.length);
    const text = JSON.stringify(tools);
    for (const word of ['Needs:', '"$ref"', '"oneOf"', '"additionalProperties"', '"pattern"', '"minimum"', '"maxLength"', '"minItems"', '"default"']) {
      assert.ok(!text.includes(word), word);
    }
    for (const t of tools) {
      const def = byId(commandIdOf(t.function.name));
      const ex = JSON.stringify(def.examples[0].args);
      const end = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
      const head = [end(def.title), def.brief, def.notFor && `Not for: ${end(def.notFor)}`, ex !== '{}' && `e.g. ${ex}`].filter(Boolean).join(' ');
      const guide = [['before', 'Before'], ['args', 'Args'], ['errors', 'Errors'], ['playbook', 'Playbook']].flatMap(([k, l]) => (def.guide?.[k] ? [`${l}: ${end(def.guide[k])}`] : []));
      assert.equal(t.function.description, [head, ...guide].join('\n'));
      assert.ok(size(t) <= MAX_TOOL, `${family} ${t.function.name}: ${size(t)} characters`);
    }
  }
  const get = model(['board.get'])[0].function;
  assert.equal(get.description, 'Read the items of a whiteboard or canvas with their ids and labels. A sparse answer lists the ids left out in next. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft. Not for: draft text. e.g. {"path":[4]}\n'
    + 'Errors: precondition_failed means that path is not a board. Call board_list.');
  assert.ok(model(['board.items.add'])[0].function.description.endsWith('\nPlaybook: change-board-item.')); // wave 2b
  assert.equal(get.parameters.properties.itemPath.description, 'Only for a canvas item inside a whiteboard, as its id. Omit it for a canvas block.');
  assert.equal(get.parameters.properties.path.description, 'Board block path, from board_list'); // a description beside a $ref is kept
  assert.equal(get.parameters.properties.path.type, 'array');
});

// The commands the brief of wave 1 names (docs/plans/assistant-reliability.md): a brief and every argument described.
const DESCRIBED = ['ui.state', 'ui.select', 'drafts.list', 'drafts.open', 'board.list', 'board.get', 'board.find', 'board.items.add', 'board.items.update',
  'board.items.remove', 'canvas.edit', 'canvas.close', 'batch', 'commands.index', 'commands.describe', 'doc.get', 'doc.find', 'doc.selection', 'doc.insert',
  'doc.replace', 'doc.delete', 'doc.format', 'drafts.create', 'drafts.get', 'drafts.setTag', 'drafts.delete', 'threads.list', 'tags.list', 'folders.list'];

test('the offered commands have a brief or a Not-for line and a description for every argument, in keyboard characters', () => {
  for (const id of new Set([...DESCRIBED, ...CORE, ...Object.values(VIEW_SETS).flat()])) {
    const [t] = model([id]);
    assert.ok(byId(id).brief || byId(id).notFor, `${id}: no brief`);
    for (const [k, p] of Object.entries(t.function.parameters.properties ?? {})) assert.ok(p.description, `${id}.${k}: no description`);
    assert.ok(!/[–—…‘’“”]/.test(JSON.stringify(t)), `${id}: not keyboard characters`);
  }
});

// Computer use (§7i): the cloud models get these beside their sets (loop.js toolList); the small models' sets never hold them.
test('computer use: described in keyboard characters, in no view set, off with on-screen controls off; its screenshot is a read', () => {
  for (const id of COMPUTER) {
    const [t] = model([id]);
    assert.ok(byId(id).brief, `${id}: no brief`);
    for (const [k, p] of Object.entries(t.function.parameters.properties ?? {})) assert.ok(p.description && p.description.length <= 90, `${id}.${k}`);
    assert.ok(!/[–—…‘’“”]/.test(JSON.stringify(t)), `${id}: not keyboard characters`);
    assert.ok(!CORE.includes(id) && !Object.values(VIEW_SETS).flat().includes(id), `${id} is in a set`);
    assert.equal(refusal(byId(id), assistantMode({ uiControl: false })), UI_OFF);
  }
  assert.equal(refusal(byId('computer.act'), assistantMode({ permission: 'readonly' })), null); // the input actions refuse in their run
  assert.equal(refusal(byId('background.open'), assistantMode({ permission: 'readonly' })), READ_ONLY);
});

test('the core and each view set exist, stay out of history.undo / redo, and fit MAX_SET as serialized tools in either family', () => {
  assert.equal(MAX_SET, 14000);
  for (const [key, ids] of Object.entries({ core: [], ...VIEW_SETS })) {
    const all = [...CORE, ...ids];
    for (const id of all) assert.ok(byId(id), `${key}: ${id}`);
    assert.ok(!all.includes('history.undo') && !all.includes('history.redo'), key);
    for (const family of ['qwen', 'gemma']) {
      const tools = model(all, family);
      assert.equal(tools.length, new Set(all).size, key);
      assert.ok(size(tools) <= MAX_SET, `${family} core + ${key}: ${size(tools)} characters`);
      // Property descriptions stay short in the offered sets (ITEM_BRIEF's field lists excepted).
      for (const d of tools.flatMap((t) => descriptions(t.function.parameters))) assert.ok(d.length <= 90 || descriptions(ITEM_BRIEF).includes(d), `${key}: ${d}`);
    }
  }
});

// Gemma 4's chat template renders a parameter from type, enum, items, properties, required and nullable only (wave 1c).
test('gemma model form: no anyOf, oneOf or type list in any tool; a union is its first branch with the alternatives named; enums typed', () => {
  const text = JSON.stringify(model(undefined, 'gemma'));
  for (const word of ['"anyOf"', '"oneOf"', '"type":[']) assert.ok(!text.includes(word), word);
  const props = (id) => model([id], 'gemma')[0].function.parameters.properties;
  assert.deepEqual(props('doc.insert').at, { type: 'array', items: { type: 'integer' }, description: 'A block path such as [3], or one of start, end, cursor' });
  assert.deepEqual(props('doc.insert').position, { enum: ['before', 'after'], description: 'Before or after the block at at', type: 'string' });
  assert.deepEqual(props('drafts.setTag').tagId, { type: 'string', description: 'A tag id from tags_list, or null to clear it' });
  assert.deepEqual(props('drafts.move').folderId, { type: 'string', description: 'Text, or null' }); // a type list, no words of its own
  assert.ok(!('anyOf' in model(['doc.format'], 'gemma')[0].function.parameters)); // constraints only: the registry checks them
  const walk = (s) => (s && typeof s === 'object' ? [s, ...Object.values(s).flatMap(walk)] : []);
  for (const s of walk(JSON.parse(text))) if (Array.isArray(s.enum)) assert.ok(s.type === 'string' && !s.enum.includes(null), JSON.stringify(s));
  const marks = props('doc.format').marks.properties; // enums with null, and numbers the template would not show
  assert.deepEqual(marks.highlight, { enum: ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet'], nullable: true, type: 'string' });
  assert.deepEqual(marks.fontSize, { nullable: true, type: 'number', description: 'One of 80, 90, 100, 125, 150, 175, 200' });
  assert.deepEqual(props('ui.zoom').value, { type: 'number', description: 'A number, or "fit"' }); // the common branch first
  // The qwen form keeps the union: llama.cpp builds Qwen3.5's tool-call grammar from it, so "end" stays possible.
  assert.ok(Array.isArray(model(['doc.insert'])[0].function.parameters.properties.at.anyOf));
  // rewrite's flat form on its own.
  const schema = { type: 'object', properties: { at: { oneOf: [{ $ref: '#/$defs/PATH' }, { enum: ['start', 'end'] }] }, n: { anyOf: [{ type: 'integer', description: 'A count' }, { type: 'null' }] } } };
  assert.deepEqual(rewrite(schema, $defs, { slim: true, flat: true }).properties, {
    at: { type: 'array', items: { type: 'integer' }, description: 'A list, or one of start, end' },
    n: { type: 'integer', description: 'A count, or null' },
  });
});

test('ITEM_BRIEF: small, and accepts the board.items.add examples', () => {
  assert.ok(JSON.stringify(ITEM_BRIEF).length <= 2100, JSON.stringify(ITEM_BRIEF).length);
  for (const ex of byId('board.items.add').examples) for (const i of ex.args.items) assert.deepEqual(validate(ITEM_BRIEF, i), [], i.type);
  const add = model(['board.items.add'])[0].function.parameters;
  assert.equal(add.properties.items.items.properties.type.enum.length, 6);
});

test('viewOf: the page, no draft, the caret in text, a board, a canvas being edited, a node-selected board block', () => {
  assert.equal(viewOf({ view: 'plan', mode: 'text', hasDoc: true }), 'plan');
  assert.equal(viewOf({ view: 'flows', mode: 'text', hasDoc: false }), 'flows');
  assert.equal(viewOf({ view: 'editor', mode: 'text', hasDoc: false }), 'none');
  assert.equal(viewOf({ view: 'editor', mode: 'text', hasDoc: true }), 'editor');
  assert.equal(viewOf({ view: 'editor', mode: 'board', hasDoc: true }), 'board');
  assert.equal(viewOf({ view: 'editor', mode: 'canvas-edit', hasDoc: true }), 'board');
  // A canvas, flowchart canvas, image or whiteboard block node-selected (ui.state gate node.board) while no board is active.
  assert.equal(viewOf({ view: 'editor', mode: 'text', hasDoc: true, nodeBoard: true }), 'board');
  assert.equal(viewOf({ view: 'editor', mode: 'text', hasDoc: false, nodeBoard: true }), 'none');
  assert.equal(viewOf({ view: 'plan', mode: 'text', hasDoc: true, nodeBoard: true }), 'plan');
  // A message that attaches board items, sent after the chat box took the focus from the board (wave 1c).
  assert.equal(viewOf({ view: 'editor', mode: 'text', hasDoc: true, boardItems: true }), 'board');
  assert.equal(viewOf({ view: 'flows', mode: 'text', hasDoc: true, boardItems: true }), 'flows');
  assert.ok(VIEW_SETS.board.includes('board.find') && GATES['node.board'].subject === 'node');
  // Wave 2: view_render in the editor and board sets, board_items_place in the board set.
  assert.ok(VIEW_SETS.editor.includes('view.render') && VIEW_SETS.board.includes('view.render') && VIEW_SETS.board.includes('board.items.place'));
});

test('Not-for lines: the tools a small model misuses say what they are not for, in the model form', () => {
  const desc = (id) => model([id])[0].function.description;
  assert.match(desc('canvas.edit'), /draw by hand\. .*Not for: changing items\. Use board_items_update\.\nPlaybook: canvas-mode\.$/); // wave 2b: shorter, with its playbook
  assert.match(desc('drafts.open'), /Not for: a title\. Get the draftId from drafts_list first\. e\.g\. /);
  assert.match(desc('drafts.list'), /Not for: opening\.$/m);
  assert.equal(model(['drafts.list'])[0].function.parameters.properties.threadUrl.description, 'Full forum thread URL. Omit it for all drafts.');
  assert.match(desc('commands.index'), /Not for: finding items or blocks\.$/);
  assert.match(desc('doc.get'), /Not for: boards\. Use board_get\. e\.g\. /);
  for (const id of ['canvas.close', 'ui.select', 'board.get', 'board.find', 'board.items.remove']) assert.match(desc(id), /Not for: [^.]+\./, id);
});

test('permission modes: the assistant decision per mode and risk; on-screen controls off', () => {
  // As the executor's policy step: a refusal denies, else the mode's rule asks or runs.
  const decide = (permission, risk, id = 'x', uiControl = true) => {
    const m = assistantMode({ permission, uiControl });
    return refusal({ id, risk }, m) ?? (PERMISSIONS[m.permission][risk] === 'ask' ? 'ask' : 'run');
  };
  const table = (permission) => ['read', 'write', 'destructive', 'approval'].map((r) => decide(permission, r));
  assert.deepEqual(table('standard'), ['run', 'run', 'ask', 'ask']);
  assert.deepEqual(table('ask'), ['run', 'ask', 'ask', 'ask']);
  assert.deepEqual(table('readonly'), ['run', READ_ONLY, READ_ONLY, READ_ONLY]);
  assert.deepEqual(table('all'), ['run', 'run', 'run', 'run']); // Allow all: nothing asks
  assert.deepEqual(table(undefined), table('standard')); // unset or unknown: Standard
  assert.deepEqual(table('bogus'), table('standard'));
  assert.equal(decide('readonly', 'read', 'ui.snapshot'), 'run');
  assert.equal(decide('readonly', 'write', 'ui.invoke'), READ_ONLY);
  assert.equal(decide('standard', 'read', 'ui.snapshot', false), UI_OFF);
  assert.equal(decide('ask', 'write', 'ui.invoke', false), UI_OFF);
  assert.deepEqual(assistantMode(undefined), { permission: 'standard', uiControl: true });
  // The real commands: doc.get reads, doc.replace writes, doc.delete asks in Standard, threads.openInForum asks (outward-facing).
  const real = (id, permission) => decide(permission, byId(id).risk, id);
  assert.deepEqual(['doc.get', 'doc.replace', 'doc.delete', 'threads.openInForum'].map((id) => real(id, 'standard')), ['run', 'run', 'ask', 'ask']);
  assert.deepEqual(['doc.get', 'doc.replace', 'doc.delete'].map((id) => real(id, 'ask')), ['run', 'ask', 'ask']);
  // commands.index for the assistant lists only what its mode allows.
  const caps = CATALOGUE.map(({ id, title, group, risk, args }) => ({ id, title, group, risk, args, needs: [] }));
  const index = (assistant) => byId('commands.index').run({ source: 'agent:assistant', state: { settings: { assistant } }, lib: { capabilities: () => caps } }, { category: 'app' })
    .tools.map((t) => t.name);
  assert.ok(index({}).includes('ui_invoke') && index({}).includes('ui_snapshot'));
  assert.ok(!index({ uiControl: false }).some((n) => n === 'ui_snapshot' || n === 'ui_invoke'));
  const ro = index({ permission: 'readonly' });
  assert.ok(ro.includes('ui_snapshot') && !ro.includes('ui_invoke') && ro.every((n) => byId(commandIdOf(n)).risk === 'read'), ro.join());
});
