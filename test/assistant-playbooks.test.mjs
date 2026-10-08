import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPlaybooks, PLAYBOOKS, pickPlaybooks } from '../src/app/assistant/playbooks.mjs';
import { $defs, byId, CATALOGUE } from '../src/app/commands/catalogue.mjs';
import { toolName } from '../src/app/commands/tool-sets.mjs';
import { validate } from '../src/app/schema.mjs';

// The assistant's playbooks (SPEC §7i Playbooks; plan assistant-reliability.md wave 1b).

const att = (kind) => ({ kind, label: kind, body: '' });
const ids = (o) => pickPlaybooks(o).map((p) => p.id);

test('every playbook: unique id, triggers, short keyboard text with a Check line, and only real tool names in its calls', () => {
  assert.equal(new Set(PLAYBOOKS.map((p) => p.id)).size, PLAYBOOKS.length);
  const tools = new Set(CATALOGUE.map((d) => toolName(d.id)));
  for (const p of PLAYBOOKS) {
    assert.ok(p.title && p.triggers.length && !('words' in p.when), p.id);
    assert.ok(p.text.length <= 1050, `${p.id}: ${p.text.length} characters (about 300 tokens)`);
    // Wave 2b: a Verification line last, and a prerequisite only as the first line.
    assert.match(p.text.split('\n').at(-1), /^Check: /, p.id);
    assert.ok(p.text.split('\n').slice(1).every((l) => !l.startsWith('Before: ')), p.id);
    assert.ok(!/[–—…‘’“”]/.test(p.text) && !/;/.test(p.text), `${p.id}: no dashes, curly quotes or semicolons`);
    assert.ok(/^[\x20-\x7e\n]+$/.test(p.title + p.text), `${p.id}: not keyboard characters`);
    for (const name of p.text.match(/\b[a-z]+_[a-zA-Z_]+(?= \{)/g) ?? []) assert.ok(tools.has(name), `${p.id}: ${name}`);
    for (const [, name, args] of p.text.matchAll(/\b([a-z]+_[a-zA-Z_]+) (\{.*?\})(?=[.\s]|$)/g)) {
      const def = byId(CATALOGUE.find((d) => toolName(d.id) === name).id);
      assert.deepEqual(validate(def.args, JSON.parse(args), $defs), [], `${p.id}: ${name} ${args}`);
    }
  }
});

test('pickPlaybooks: the eval requests get the playbook they need, at most 2', () => {
  assert.deepEqual(ids({ parts: ['Straighten the yes arrow.', att('flowchart')], view: 'board' }), ['change-board-item']);
  assert.deepEqual(ids({ parts: ['Delete the selected item.', att('items')], view: 'editor' }), ['delete-board-item']);
  assert.deepEqual(ids({ parts: ['Move Valve to the left of Pump.', att('whiteboard')], view: 'board' }), ['move-board-item']);
  assert.deepEqual(ids({ parts: ['Rename the shape Pump to Pump 2.', att('whiteboard')], view: 'board' }), ['rename-board-item']);
  assert.deepEqual(ids({ parts: ['Change the text of the shape at the top left to Motor.', att('whiteboard')], view: 'board' }), ['rename-board-item']);
  assert.deepEqual(ids({ text: 'Open my blockout draft.', view: 'editor' }), ['open-draft']);
  assert.deepEqual(ids({ text: "Set this draft's tag to Done.", view: 'editor' }), ['tag-draft']);
  assert.deepEqual(ids({ text: 'Add a heading called Valve puzzle above the second paragraph.', view: 'editor' }), ['edit-draft-text']);
  assert.deepEqual(ids({ parts: ['Give me the boxes of the red circle, blue square and green triangle as JSON.', att('image')], view: 'board' }), ['picture-question']);
  assert.deepEqual(ids({ text: 'Open the canvas so I can sketch.', parts: [att('canvas')], view: 'board' }), ['canvas-mode']);
  for (const o of [{ text: 'hello', parts: [att('whiteboard')], view: 'board' }, { text: 'What is the difference between a blockout and a greybox?', view: 'editor' }]) {
    assert.deepEqual(ids(o), [], o.text);
  }
  // Wave 1c: a question about what is open or selected is answered from the situation note, in every mode, never with a change.
  assert.deepEqual(ids({ text: 'What is the title of the flowchart that is open?', view: 'flows' }), ['situation-question']);
  assert.deepEqual(ids({ text: 'What flowchart is open?', view: 'flows', permission: 'readonly' }), ['situation-question']);
  assert.deepEqual(ids({ text: "What's the open draft called?", view: 'editor' }), ['situation-question']);
  assert.deepEqual(ids({ parts: ['Which items are selected?', att('items')], view: 'board' }), ['situation-question']);
  assert.ok(!ids({ parts: ['Rename Pump to Pump 2.', att('whiteboard')], view: 'board' }).includes('situation-question'));
  assert.deepEqual(ids({ text: 'Which draft should I open?', view: 'editor' }), ['situation-question']); // not paired with open-draft
  assert.deepEqual(ids({ text: 'Open my blockout draft.', view: 'editor' }), ['open-draft']);
  assert.ok(PLAYBOOKS.every((p) => ids({ text: p.triggers.flat().join(' '), parts: [att('whiteboard')], view: 'board' }).length <= 2));
  // A change and "call no tool" never come together: the colour request gets only the change, the colour question only the picture.
  assert.deepEqual(ids({ parts: ['Change the colour of the start shape to red.', att('flowchart')], view: 'board' }), ['change-board-item']);
  assert.deepEqual(ids({ parts: ['What colour is the pump?', att('whiteboard')], view: 'board' }), ['picture-question']);
  assert.deepEqual(ids({ parts: ['Make the box bigger.', att('image')], view: 'board' }), ['change-board-item']);
});

test('pickPlaybooks: Read only gets the read-only playbook and none that changes things', () => {
  assert.deepEqual(ids({ parts: ['Rename the shape Gearbox to Gearbox A.', att('whiteboard')], view: 'board', permission: 'readonly' }), ['read-only']);
  assert.deepEqual(ids({ text: 'Open my blockout draft.', view: 'editor', permission: 'readonly' }), []);
  assert.deepEqual(ids({ parts: ['What does this picture show?', att('image')], view: 'board', permission: 'readonly' }), ['picture-question']);
  assert.ok(!ids({ parts: ['Rename the shape Pump.', att('whiteboard')], view: 'board' }).includes('read-only'));
});

test('wave 2b: open-draft opens one match without asking; the risky tools name a real playbook; prerequisites where they help', () => {
  const open = PLAYBOOKS.find((p) => p.id === 'open-draft').text;
  assert.ok(open.includes('When one title matches, open it without asking.') && open.includes('Ask which one only when several match.'));
  const byIdOf = new Map(PLAYBOOKS.map((p) => [p.id, p]));
  assert.deepEqual(['board.items.add', 'batch', 'canvas.edit'].map((id) => byId(id).guide?.playbook), ['change-board-item', 'edit-draft-text', 'canvas-mode']);
  for (const d of CATALOGUE.filter((x) => x.guide?.playbook)) {
    const p = byIdOf.get(d.guide.playbook);
    assert.ok(p, `${d.id}: ${d.guide.playbook}`);
    assert.ok(p.text.includes(toolName(d.id)), `${d.id}: its playbook names it`);
    assert.deepEqual(findPlaybooks(p.id).map((x) => x.id)[0], p.id, `commands_index {q:"${p.id}"} finds it`);
  }
  assert.deepEqual(PLAYBOOKS.filter((p) => p.text.startsWith('Before: ')).map((p) => p.id), ['change-board-item', 'delete-board-item', 'tag-draft']);
  // "Add" on a board picks the board playbook that covers board_items_add, never the draft one.
  const add = ids({ parts: ['Add a note that says Exit under the Pump.', att('whiteboard')], view: 'board' });
  assert.ok(add[0] === 'change-board-item' && !add.includes('edit-draft-text'), add.join());
  assert.deepEqual(ids({ text: 'Add a heading called Valve puzzle.', view: 'editor' }), ['edit-draft-text']);
  // Review: drawing by hand never comes with the board playbook that forbids canvas_edit (its triggers have draw too).
  for (const text of ['Let me draw on it.', 'Open the canvas so I can draw.']) assert.deepEqual(ids({ parts: [text, att('flowchart')], view: 'board' }), ['canvas-mode'], text);
  // The eval's questions about an attached board get the call-no-tool playbook, never a change.
  assert.deepEqual(ids({ parts: ['What would you change about this flowchart?', att('flowchart')], view: 'board' }), ['picture-question']);
  assert.deepEqual(ids({ parts: ['Which shape is widest?', att('whiteboard')], view: 'board' }), ['picture-question']);
  const scene = 'Identify the things in this picture. Mark each one with a shape around it and an arrow from a text label naming it.';
  assert.equal(ids({ parts: [scene, att('whiteboard')], view: 'board' })[0], 'change-board-item');
});

test('findPlaybooks: commands.index q searches titles and words', () => {
  assert.deepEqual(findPlaybooks('tag').map((p) => p.title), ['Set the tag of a draft']);
  assert.ok(findPlaybooks('straighten')[0].text.includes('board_items_update'));
  assert.deepEqual(findPlaybooks('zz'), []);
  assert.deepEqual(findPlaybooks('rename', 'readonly').map((p) => p.title), ['Read only mode']);
  assert.ok(findPlaybooks('delete').length <= 2);
});
