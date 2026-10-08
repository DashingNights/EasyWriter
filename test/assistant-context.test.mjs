import assert from 'node:assert/strict';
import test from 'node:test';
import {
  briefArgs, buildHistory, callKey, callsLeft, CLAIM_RE, claims, clipResult, doneReply, fullResults, guardWrite, KEEP_RESULTS, loopKind, loopNote, NOTE_DRAFTS,
  pictureMessage, promises, READS_AFTER_WRITE, readsAfterWrite, repeats, RESULT_CHARS, resultLine, shouldCompact, situationNote, takePictures, turnMessages,
  withNote, markIds, sameSentence, withMarkIds,
} from '../src/app/assistant/context.mjs';
import { familyOf, NOTE_RULE, RENDER_RULE, RULES, STYLE_RULE, SYSTEM_PROMPT, systemPrompt, THOUSANDTHS_RULE, UI_RULE } from '../src/app/assistant/prompts.mjs';

const ID = '11111111-2222-3333-4444-555555555555';

test('briefArgs: short values kept, long strings cut, long objects as their size, always a JSON object within 80 characters', () => {
  assert.equal(briefArgs(JSON.stringify({ draftId: ID })), JSON.stringify({ draftId: ID }));
  assert.equal(briefArgs(JSON.stringify({ format: 'outline', path: [2, 1] })), '{"format":"outline","path":[2,1]}');
  const long = JSON.parse(briefArgs(JSON.stringify({ path: [3], content: { markdown: 'word '.repeat(500) }, title: 'x'.repeat(200) })));
  assert.deepEqual(Object.keys(long), ['path', 'content']); // the cut title would pass 80 characters
  assert.equal(long.content, '(2515 characters)');
  const titled = JSON.parse(briefArgs(JSON.stringify({ path: [3], title: 'x'.repeat(200) })));
  assert.ok(titled.title.endsWith('...') && titled.title.length === 40);
  assert.ok(briefArgs(JSON.stringify({ a: 'x'.repeat(39), b: 'y'.repeat(39), c: 'z' })).length <= 80);
  assert.equal(briefArgs('not json'), '{}');
  assert.equal(briefArgs(''), '{}');
});

test('resultLine: read / done / failed, sizes not content, the draft title, at most 160 characters', () => {
  assert.equal(resultLine('read', { ok: true, result: [{}, {}, {}] }), 'read: 3 items');
  assert.equal(resultLine('write', { ok: true, result: { rev: 5 } }, 'Week 1 - W1P2 - Task 2'), 'done (draft "Week 1 - W1P2 - Task 2"): rev 5');
  const doc = resultLine('read', { ok: true, result: { rev: 4, draftId: ID, content: 'The secret paragraph. '.repeat(100) } });
  assert.ok(!doc.includes('secret') && /content \(2200 characters\)/.test(doc), doc);
  assert.equal(resultLine('read', { ok: true, result: { rev: 4, content: [{}, {}] } }), 'read: rev 4, content (2 items)');
  assert.equal(resultLine('write', { ok: false, error: { code: 'stale', message: 'Read again.' } }), 'failed (stale): Read again.');
  assert.ok(resultLine('write', { ok: false, error: { code: 'x', message: 'm'.repeat(500) } }).length <= RESULT_CHARS);
});

test('buildHistory: summary tool pairs, attachments only on the last message, from the last divider with its summary', () => {
  const step = (id, name, line) => ({ role: 'step', step: { call: { id, name, args: '{}' }, line } });
  const messages = [
    { role: 'user', text: 'open my task 2 draft [Selection: 3 words]', content: 'open my task 2 draft\n\nAttachment [Selection: 3 words]\nlong body' },
    { role: 'assistant', text: '' },
    step('a', 'drafts_list', 'read: 7 items'),
    { role: 'assistant', text: 'Opening it.' },
    step('b', 'drafts_open', 'done (draft "Task 2"): rev 5'),
    { role: 'assistant', text: 'I opened Task 2.' },
    { role: 'step', step: { title: 'old step without a summary' } },
    { role: 'user', text: 'ok no it was task 1', content: 'ok no it was task 1\n\nAttachment [x]\nbody' },
  ];
  const h = buildHistory(messages);
  assert.deepEqual(h.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'user']);
  assert.equal(h[0].content, 'open my task 2 draft [Selection: 3 words]'); // a past turn: the pill label only
  assert.deepEqual(h[1], { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'drafts_list', arguments: '{}' } }] });
  assert.deepEqual(h[2], { role: 'tool', tool_call_id: 'a', content: 'read: 7 items' });
  assert.equal(h[3].content, 'Opening it.'); // the text of the completion that made the call carries it
  assert.equal(h[3].tool_calls[0].function.name, 'drafts_open');
  assert.equal(h.at(-1).content, messages.at(-1).content); // the turn being answered: with its attachment
  const after = buildHistory([...messages, { role: 'divider', summary: 'We opened Task 2.' }, { role: 'user', text: 'now', content: 'now' }]);
  assert.deepEqual(after, [{ role: 'user', content: 'This is a summary of our earlier conversation.\n\nWe opened Task 2.' }, { role: 'user', content: 'now' }]);
  const failed = buildHistory([...messages, { role: 'divider' }, { role: 'user', text: 'now', content: 'now' }]);
  assert.deepEqual(failed, [{ role: 'user', content: 'now' }]);
  const many = Array.from({ length: 30 }, (_, i) => ({ role: 'user', text: `q${i}` }));
  assert.equal(buildHistory(many, 20)[0].content, 'q10');
});

test('CLAIM_RE: claims of an action, not questions or plain statements of what was not done', () => {
  for (const t of ["I've opened Week 1 - Task 2 for you.", 'I opened it.', 'I have added the paragraph.', 'Done. The title is shorter.', 'I’ve deleted it.',
    'The draft has been created.', 'Sure, I just changed the heading.']) assert.ok(CLAIM_RE.test(t), t);
  for (const t of ['I have not opened it yet.', 'Shall I open Task 2?', 'Which draft do you mean?', 'You can add a heading.', 'I can open it for you.',
    'If I removed the second paragraph, it would be shorter.', 'Should I have changed the title?', 'You wrote "I added three rooms."', 'Nothing has been changed yet.']) {
    assert.ok(!CLAIM_RE.test(t), t);
  }
  assert.ok(!claims('Here is a shorter version:\n\nI added lighting to the level.')); // a rewrite of the student's first-person draft
  assert.ok(claims("I've added the heading:\n\n## Week 2") && claims('I found it.\n\n**Done!**'));
});

test('promises: a reply that promises an action at a line or sentence start; not "Let me know", questions or rewrites', () => {
  for (const t of ["I'll straighten the yes arrow.", 'Sure. Let me fix that.', 'I will open it now.', "OK, I'm going to rename it.", 'I can do that.', 'I’ll add it.',
    '**Let me** check the board.']) assert.ok(promises(t), t);
  for (const t of ['Let me know if you want more changes.', 'Shall I open it?', 'Which arrow do you mean?', 'You will see it in the sidebar.',
    'The player will open the door.', 'I opened it.', 'Let me explain. A flowchart is a diagram of steps.', "I'll summarise it. The draft has two parts.",
    'Your intro says "Hello. I will argue that games teach." It reads well.']) assert.ok(!promises(t), t);
  assert.ok(!promises("Here is a shorter version:\n\nI'll add lighting next week.")); // a rewrite of the student's draft
});

test('loopKind: A B A B and A B C A B C are a cycle, one tool with 5 different arguments since the last write a hammer, 8 a stop', () => {
  const k = (name, n = 0) => callKey(name, JSON.stringify({ n }));
  const [A, B, C] = [k('board_items_update'), k('board_get'), k('board_find')];
  assert.equal(loopKind([A, B, A]), null);
  assert.equal(loopKind([A, B, A, B]), 'cycle');
  assert.equal(loopKind([C, A, B, A, B]), 'cycle');
  assert.equal(loopKind([A, B, C, A, B, C]), 'cycle');
  assert.equal(loopKind([A, A, A, A]), null); // the repeat key's case
  assert.equal(loopKind([A, B, C, A, B]), null);
  const reads = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => k('doc_get', n));
  assert.equal(loopKind(reads.slice(0, 4)), null); // four legitimate block reads
  assert.equal(loopKind(reads.slice(0, 5)), 'hammer');
  assert.equal(loopKind(reads.slice(0, 7)), 'hammer');
  assert.equal(loopKind(reads), 'stop');
  assert.equal(loopKind([...reads.slice(0, 5), k('board_get')]), null); // the last call's tool only
  assert.equal(loopKind([reads[0], A, ...reads.slice(1, 5)], 2), null); // since the write at index 1: four
  assert.equal(loopKind([reads[0], reads[0], ...reads.slice(1, 4)]), null); // four different arguments
  assert.equal(loopNote(['board_items_update', 'board_get']),
    'You are going round in circles (calls: board_items_update, board_get). Say what you have learned and what is missing, then make a different call or ask the user.');
});

test('shouldCompact: at or above 80 % of the context', () => {
  assert.equal(shouldCompact(null), false);
  assert.equal(shouldCompact({ used: 26213, ctx: 32768 }), false);
  assert.equal(shouldCompact({ used: 26215, ctx: 32768 }), true);
  assert.equal(shouldCompact({ used: 13108, ctx: 16384 }), true);
});

test('situationNote: page, open draft, thread, selection, canvas and the thread\'s drafts, capped at 30', () => {
  const drafts = Array.from({ length: 34 }, (_, i) => ({ title: `Week ${i + 1}`, tag: i === 1 ? 'Done' : '' }));
  const note = situationNote({
    page: 'editor', draft: { title: 'Week 2', tag: 'Done' }, thread: 'Level design dev thread',
    selection: { label: 'Flowchart canvas', summary: 'Flowchart canvas at block [4] of the draft', attached: true },
    canvas: '', drafts, total: drafts.length, scope: 'thread',
  });
  const lines = note.split('\n');
  assert.equal(lines[0], '[Situation note from the app. It is current for this message.]');
  assert.deepEqual(lines.slice(1, 7), ['Page: Editor', 'Open draft: "Week 2", tag Done', 'Thread: "Level design dev thread"',
    'Selected: Flowchart canvas at block [4] of the draft. It is attached as [Flowchart canvas].', 'Canvas being edited: none',
    'Drafts in this thread (34, the first 30 in sidebar order)']);
  assert.equal(lines.filter((l) => l.startsWith('- ')).length, NOTE_DRAFTS);
  assert.equal(lines[8], '- "Week 2", tag Done');
  assert.equal(lines.at(-1), '[End of situation note]');
  assert.ok(!/[–—]/.test(note)); // keyboard characters only
  const plans = situationNote({ page: 'plan', plan: 'Sprint 1', draft: null, selection: null, drafts: [], total: 0, scope: 'all' });
  assert.deepEqual(plans.split('\n').slice(1, -1), ['Page: Plans, plan "Sprint 1"', 'Open draft: none', 'Selected: nothing', 'Drafts (0): none']);
  assert.match(situationNote({ page: 'flows', draft: { title: '' }, selection: null, drafts: [], total: 0, scope: 'all' }), /Open draft: "Untitled draft" \(behind this page\)/);
  const ro = situationNote({ page: 'plan', draft: null, selection: null, drafts: [], total: 0, scope: 'all', permission: 'readonly' }).split('\n');
  assert.equal(ro.at(-2), 'Permission mode: Read only. You can read and answer. Every change is refused.');
  assert.ok(!situationNote({ page: 'plan', draft: null, selection: null, drafts: [], total: 0, scope: 'all', permission: 'standard' }).includes('Permission'));
  const pb = situationNote({ page: 'editor', draft: null, selection: null, drafts: [], total: 0, scope: 'all', playbooks: [{ title: 'Open a draft', text: '1. Call drafts_list {}.' }] });
  assert.deepEqual(pb.split('\n').slice(-4), ['How to do this:', 'Open a draft', '1. Call drafts_list {}.', '[End of situation note]']);
  // Wave 2b: a playbook's id follows its title, since the tool text names playbooks by id.
  const named = situationNote({ page: 'editor', draft: null, selection: null, drafts: [], total: 0, scope: 'all', playbooks: [{ id: 'open-draft', title: 'Open a draft', text: '1.' }] });
  assert.ok(named.includes('\nOpen a draft (playbook open-draft)\n1.\n'));
  assert.ok(!situationNote({ page: 'plan', draft: null, selection: null, drafts: [], total: 0, scope: 'all', playbooks: [] }).includes('How to do this'));
  assert.equal(withNote('N', 'Request: hi'), 'N\n\nRequest: hi');
  const img = { type: 'image_url', image_url: { url: 'data:,' } };
  assert.deepEqual(withNote('N', [{ type: 'text', text: 'A' }, img, { type: 'text', text: 'Request: hi' }]),
    [{ type: 'text', text: 'N\n\nA' }, img, { type: 'text', text: 'Request: hi' }]); // the note joins the first text part
  assert.deepEqual(withNote('N', [img]), [{ type: 'text', text: 'N' }, img]);
});

test('calls left, reads after a write and the done reply (wave 1c)', () => {
  assert.equal(callsLeft(5), ' Calls left in this reply: 5.');
  const w = { write: true, ok: true };
  const r = { write: false, ok: true };
  const bad = { write: false, ok: false };
  assert.equal(READS_AFTER_WRITE, 3);
  assert.equal(readsAfterWrite([w, r, r]), false);
  assert.equal(readsAfterWrite([w, r, r, r]), true); // the Gemma rename-pump turn: update, board_get, commands_index, board_list
  assert.equal(readsAfterWrite([r, r, r]), false); // no change yet: reading first is the procedure
  assert.equal(readsAfterWrite([w, r, bad, r, r]), false); // a failed read breaks the run
  assert.equal(readsAfterWrite([w, r, bad, r, r, r]), true);
  assert.equal(readsAfterWrite([w, r, r, w, r, r]), false); // a new change starts the count again
  assert.equal(readsAfterWrite([w, { write: true, ok: false }, r, r, r]), false); // the model is still working on a change
  // Wave 2: only doc.* and board.* changes count; navigation then three reads goes on (the loop marks writes with guardWrite).
  assert.ok(guardWrite('doc.replace', 'write') && guardWrite('board.items.place', 'write') && guardWrite('board.items.remove', 'destructive'));
  for (const id of ['drafts.open', 'canvas.edit', 'canvas.close', 'ui.select', 'ui.scrollTo', 'ui.zoom']) assert.equal(guardWrite(id, 'write'), false, id);
  assert.equal(guardWrite('board.get', 'read'), false);
  const nav = { write: guardWrite('drafts.open', 'write'), ok: true };
  assert.equal(readsAfterWrite([nav, r, r, r]), false);
  assert.equal(doneReply('Change one item of a whiteboard or canvas'), 'Done: changed one item of a whiteboard or canvas.');
  assert.equal(doneReply('Replace one block of the open draft (not a board)'), 'Done: replaced one block of the open draft.');
  assert.equal(doneReply('Insert blocks into the open draft'), 'Done: inserted blocks into the open draft.');
  assert.equal(doneReply('Opened the canvas'), 'Done: opened the canvas.');
  assert.equal(doneReply('Set the status tag of a draft'), 'Done: set the status tag of a draft.');
  assert.equal(doneReply('Format the text of one block'), 'Done: formatted the text of one block.');
  // Up to the first colon or "and"; both verbs of "X or Y"; ui.invoke's step label (loop.js uiStep).
  assert.equal(doneReply('Select a block or board items and bring it into view'), 'Done: selected a block or board items.');
  assert.equal(doneReply('Zoom the page: fit to the view, or a percent (10-400)'), 'Done: zoomed the page.');
  assert.equal(doneReply('Rename or recolour a status tag'), 'Done: renamed or recoloured a status tag.');
  assert.equal(doneReply('Pressed "Save" on "Row 2" (toolbar)'), 'Done: pressed "Save" on "Row 2".');
});

test('system prompt per model family: gemma12b gets the Gemma prompt, every other model the Qwen one', () => {
  assert.equal(familyOf('gemma12b'), 'gemma');
  assert.equal(familyOf('gemma12b', 'google'), 'gemini'); // Google AI runs Gemini whatever the local model choice is
  assert.equal(familyOf(undefined, 'google'), 'gemini');
  assert.equal(familyOf(undefined, 'deepseek'), 'gemini'); // the cloud models' family
  assert.equal(familyOf(undefined, 'qwen'), 'gemini'); // Qwen Cloud (2026-10-08)
  assert.ok(!systemPrompt('gemini').includes('You run on their computer.'));
  for (const m of ['qwen9b', 'fable9b', undefined, '']) assert.equal(familyOf(m), 'qwen', m);
  const qwen = systemPrompt('qwen');
  const gemma = systemPrompt('gemma');
  for (const p of [qwen, gemma]) assert.ok(p.startsWith(`${SYSTEM_PROMPT} ${NOTE_RULE}\n`) && !/[–—…‘’“”]/.test(p));
  assert.equal(qwen, `${SYSTEM_PROMPT} ${NOTE_RULE}\n${RULES.qwen}\n${STYLE_RULE}`); // the writing rules last, in every family
  assert.match(qwen, /^5\. After a write that succeeded, reply to the user in one short sentence\. Read again only when the user asked for more changes\.$/m);
  assert.ok(!/read once to check/.test(qwen));
  assert.equal(gemma, `${SYSTEM_PROMPT} ${NOTE_RULE}\n${RULES.gemma}\n${STYLE_RULE}`);
  assert.ok(gemma.includes('When the request is done, reply in one sentence and make no more calls.'));
  assert.match(gemma, /^1\. Read the situation note first\./m);
  assert.ok(!/after a write|read again|read once/i.test(RULES.gemma)); // no read after a write
  assert.ok(RULES.gemma.length < RULES.qwen.length);
  assert.equal(systemPrompt('gemma', { tools: false }), `${SYSTEM_PROMPT} ${NOTE_RULE}\n${STYLE_RULE}`); // no tools, no tool rules
  assert.ok(systemPrompt('qwen', { uiControl: true }).endsWith(`\n${UI_RULE}\n${STYLE_RULE}`));
  // Wave 2: the view_render line while it is offered, in both families.
  for (const f of ['qwen', 'gemma']) assert.equal(systemPrompt(f, { render: true }), `${SYSTEM_PROMPT} ${NOTE_RULE}\n${RULES[f]}\n${RENDER_RULE}\n${STYLE_RULE}`);
  assert.equal(RENDER_RULE, 'When a target is visual or ambiguous, call view_render. Its legend gives the item id of each number on the picture.');
  assert.equal(systemPrompt('nope'), qwen);

  // Qwen Cloud (2026-10-08): the thousandths line in place of the board pixels line, only with the option on.
  const thou = systemPrompt('gemini', { thousandths: true });
  assert.ok(thou.includes(`
${THOUSANDTHS_RULE}
`) && !thou.includes('are board pixels') && !/[–—…‘’“”]/.test(thou));
  assert.ok(!systemPrompt('gemini').includes(THOUSANDTHS_RULE) && systemPrompt('gemini').includes('x, y, w and h are board pixels'));
});

test('callKey: the same tool with the same arguments in any key order; different arguments or tools differ', () => {
  assert.equal(callKey('doc_get', '{"format":"outline","path":[1]}'), callKey('doc_get', '{ "path": [1], "format": "outline" }'));
  assert.equal(callKey('doc_get', ''), callKey('doc_get', '{}'));
  assert.notEqual(callKey('doc_get', '{"path":[1]}'), callKey('doc_get', '{"path":[2]}'));
  assert.notEqual(callKey('doc_get', '{}'), callKey('doc_find', '{}'));
  assert.equal(callKey('doc_get', 'not json'), 'doc_get not json');
});

test('repeats: a 60-character span four times is a loop; three times or varied text is not', () => {
  const unit = 'The door opens onto the corridor and the corridor leads back. '; // 62 characters
  assert.ok(repeats(unit.repeat(4)));
  assert.ok(!repeats(unit.repeat(3)));
  assert.ok(repeats(`Intro text first. ${unit.repeat(4)}`));
  assert.ok(repeats('ha '.repeat(100))); // a short loop repeats its 60-character tail too
  const varied = Array.from({ length: 30 }, (_, i) => `Step ${i + 1} moves the player ${i * 3} metres to the next room. `).join('');
  assert.ok(!repeats(varied));
});

test('clipResult: an oversized doc_get is sparse, its first whole blocks and the paths left out; other answers say not to repeat', () => {
  const block = (i) => ({ type: 'paragraph', content: [{ type: 'text', text: `${i} ${'x'.repeat(900)}` }] });
  const res = { ok: true, result: { rev: 3, draftId: 'd', content: { type: 'doc', content: Array.from({ length: 40 }, (_, i) => block(i)) } } };
  const out = JSON.parse(clipResult('doc_get', '{}', res, 16000));
  const k = out.result.content.content.length;
  assert.ok(k > 0 && k < 40 && JSON.stringify(out).length <= 16000);
  assert.equal(out.result.sparse, true);
  assert.deepEqual(out.result.next, Array.from({ length: 40 - k }, (_, i) => [k + i]));
  assert.equal(out.result.hint, `Read one with doc_get {"path":[${k}]}.`);
  // A first block too long to show: none kept, its text by path.
  const big = JSON.parse(clipResult('doc_get', '{"path":[2]}', { ok: true, result: { content: { type: 'bulletList', content: [block(0), block(1)].map((b) => ({ ...b, content: [{ type: 'text', text: 'z'.repeat(9000) }] })) } } }, 8000));
  assert.deepEqual([big.result.content.content.length, big.result.next], [0, [[2, 0], [2, 1]]]);
  assert.equal(big.result.hint, 'Block [2,0] is too long to show. Read its text with doc_get {"path":[2,0],"format":"text"}.');
  // An outline names the paths of the entries left out.
  const entries = Array.from({ length: 200 }, (_, i) => ({ path: [i], type: 'paragraph', text: 'w'.repeat(100) }));
  const ol = JSON.parse(clipResult('doc_get', '{"format":"outline"}', { ok: true, result: { content: entries } }, 8000));
  assert.ok(ol.result.sparse && ol.result.next[0][0] === ol.result.content.length && ol.result.next.length === 200 - ol.result.content.length);
  assert.equal(clipResult('doc_get', '{}', { ok: true, result: { content: 'short' } }, 16000), '{"ok":true,"result":{"content":"short"}}');
  const md = clipResult('doc_get', '{"format":"markdown"}', { ok: true, result: { content: 'y'.repeat(20000) } }, 16000);
  assert.ok(md.endsWith('(cut. Call doc_get with {"format":"outline"} for the block paths, then read one block with {"path":[n]}.)'));
  assert.match(clipResult('board_get', '{}', { ok: true, result: { items: 'z'.repeat(20000) } }, 16000), /\(cut\. Do not repeat this call\. Read a smaller part, such as one block by its path\.\)$/);
});

test('clipResult: an oversized board_get or board_find is sparse, its first whole items and the ids left out with a board_find hint', () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: `i${i}`, type: 'shape', shape: 'rect', label: `Step ${i} ${'x'.repeat(60)}`, x: i, y: 0, w: 10, h: 10 }));
  const get = JSON.parse(clipResult('board_get', '{"path":[4],"itemPath":["k3j9x0a"]}', { ok: true, result: { rev: 2, board: { kind: 'canvas', w: 800, h: 450, items } } }, 8000));
  const k = get.result.board.items.length;
  assert.ok(k > 0 && k < 120 && JSON.stringify(get).length <= 8000, String(k));
  assert.deepEqual(get.result.board.items.at(-1), items[k - 1]);
  assert.equal(get.result.sparse, true);
  assert.deepEqual(get.result.next, items.slice(k).map((i) => i.id));
  assert.equal(get.result.hint, `Read one with board_find {"path":[4],"itemPath":["k3j9x0a"],"q":"i${k}"}.`);
  // board.find past its 40 already named ids in next: those stay after the ones this cut leaves out.
  const find = JSON.parse(clipResult('board_find', '{"path":[4],"q":"step"}', { ok: true, result: { rev: 2, hits: 160, items, sparse: true, next: ['z1', 'z2'] } }, 8000));
  assert.ok(find.result.items.length < 120 && find.result.hits === 160 && find.result.sparse && JSON.stringify(find).length <= 8000);
  assert.deepEqual(find.result.next, [...items.slice(find.result.items.length).map((i) => i.id), 'z1', 'z2']);
  // More ids than fit: next keeps the first ones and more counts the rest.
  const many = Array.from({ length: 3000 }, (_, i) => ({ id: `k${String(i).padStart(6, '0')}`, type: 'shape' }));
  const huge = JSON.parse(clipResult('board_get', '{"path":[1]}', { ok: true, result: { board: { kind: 'canvas', items: many } } }, 8000));
  assert.ok(JSON.stringify(huge).length <= 8000 && huge.result.more > 0 && huge.result.board.items.length + huge.result.next.length + huge.result.more === 3000);
});

test('turnMessages: the turn sends its last two tool results in full, older ones as their summary line, and one live picture', () => {
  assert.equal(KEEP_RESULTS, 2);
  const lines = new Map();
  const tool = (n) => {
    const m = { role: 'tool', tool_call_id: 'call_0', content: `{"ok":true,"result":"full ${n}"}` }; // the same id each time, as some servers send
    lines.set(m, `read: result ${n}`);
    return m;
  };
  const call = { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'doc_get', arguments: '{}' } }] };
  const past = { role: 'tool', tool_call_id: 'old', content: 'read: an earlier turn' }; // buildHistory's, not in lines
  const asked = { role: 'user', content: [{ type: 'text', text: 'Request: look' }, { type: 'image_url', image_url: { url: 'data:a' } }] };
  const [t1, t2, t3] = [tool(1), tool(2), tool(3)];
  const pic1 = pictureMessage('Picture from view_render of the view, 1280 x 720 of a 1600 x 900 view.', 'data:1');
  const pic2 = pictureMessage('The board after your change, 900 x 400 of a 900 x 400 board.', 'data:2');
  const messages = [{ role: 'system', content: 's' }, past, asked, call, t1, call, t2, pic1, call, t3, pic2];
  const sent = turnMessages(messages, 3, lines);
  // Three results: the oldest goes as its summary line, the last two in full; an earlier turn's pair stays as it is.
  assert.deepEqual(sent.filter((m) => m.role === 'tool').map((m) => m.content), ['read: an earlier turn', 'read: result 1', t2.content, t3.content]);
  assert.deepEqual(sent[7].content, [{ type: 'text', text: pic1.content[0].text }]); // the older picture keeps its caption only
  assert.equal(sent[10], pic2); // the newest picture goes as it is
  assert.equal(sent[2], asked); // the user's own attachment picture is not a turn picture
  assert.equal(messages[4].content, '{"ok":true,"result":"full 1"}'); // messages itself is not changed
  assert.deepEqual([...fullResults(messages, lines)], [t2, t3]);
  // Before the third request of a 4-call turn the first two are both kept in full; before the fourth, the first is a summary.
  assert.equal(turnMessages([asked, call, t1, call, t2], 1, lines)[2], t1);
  assert.equal(turnMessages([asked, call, t1, call, t2, call, t3], 1, lines)[2].content, 'read: result 1');
});

test('takePictures: a picture answer loses its url, which goes as the next user message; a batch step too; errors untouched', () => {
  const size = '640 x 400 of a 1000 x 625 board';
  const pic = { legend: '1 v1 shape rect "Valve" at 420,40 size 160x80', width: 640, height: 400, size, picture: 'next message', url: 'data:image/png;base64,AAAA' };
  const one = takePictures({ ok: true, result: pic });
  assert.deepEqual(one.pictures, [{ url: 'data:image/png;base64,AAAA', size }]);
  assert.deepEqual(one.res.result, { legend: pic.legend, width: 640, height: 400, size, picture: 'next message' }); // wave 2b: both sizes stay in the answer
  assert.ok(!JSON.stringify(one.res).includes('base64'));
  const batch = takePictures({ ok: true, result: { results: [{ id: 'a' }, pic] } });
  assert.deepEqual([batch.pictures.length, batch.res.result.results[1].url], [1, undefined]);
  const fail = { ok: false, error: { code: 'x', message: 'm' } };
  assert.deepEqual(takePictures(fail), { res: fail, pictures: [] });
  assert.deepEqual(takePictures({ ok: true, result: { url: 'kept', rev: 1 } }).pictures, []); // not a picture answer
  assert.deepEqual(pictureMessage('Picture from view_render of the view.', 'data:x'), { role: 'user', content: [
    { type: 'text', text: 'Picture from view_render of the view.' }, { type: 'image_url', image_url: { url: 'data:x' } }] });
  // Later turns never carry it: buildHistory builds from the chat's messages, where a step line keeps the call's summary only.
  const h = buildHistory([{ role: 'user', text: 'look' }, { role: 'step', step: { call: { id: 'c', name: 'view_render', args: '{}' }, line: 'read: legend (40 characters)' } },
    { role: 'assistant', text: 'Valve is top right.' }, { role: 'user', text: 'ok', content: 'ok' }]);
  assert.ok(!JSON.stringify(h).includes('image_url'));
});

test('sameSentence and repeats: the same sentence four times with different lead-ins is a loop (the 2026-10-07 doom loop)', () => {
  const call = 'Let me actually call board_items_update with the whiteboard path [2] and item id "1" to rename it to "Pump 2".';
  const loop = [call, `I keep making the same mistake. ${call}`, `I need to stop. ${call}`, `Right. ${call}`].join('\n\n');
  assert.ok(sameSentence(loop));
  assert.ok(repeats(loop));
  assert.ok(!sameSentence([call, `Again. ${call}`, `Once more. ${call}`].join('\n\n'))); // three is not yet a loop
  assert.ok(!sameSentence('The first valve opens the gate. The second valve closes it. The third valve does nothing yet.'));
});

test('markIds and withMarkIds: a bare mark number in id, of, ids or a batch step becomes the legend item id', () => {
  const marks = markIds(['Whiteboard at block [4]\n1 g3n7c1f shape rect "Gearbox" at 20,20 size 160x80\n2 p8w2r5d shape rect "Pump" at 230,40 size 220x80\n3 c81hd0q connector "yes" from 1 to 2']);
  assert.deepEqual([...marks], [['1', 'g3n7c1f'], ['2', 'p8w2r5d'], ['3', 'c81hd0q']]);
  const [a, swaps] = withMarkIds({ path: [4], id: '2', patch: { html: 'Pump 2' } }, marks);
  assert.deepEqual(a, { path: [4], id: 'p8w2r5d', patch: { html: 'Pump 2' } });
  assert.deepEqual(swaps, [['2', 'p8w2r5d']]);
  assert.deepEqual(withMarkIds({ path: [4], ids: ['1', '3', 'q9'] }, marks)[0].ids, ['g3n7c1f', 'c81hd0q', 'q9']);
  assert.deepEqual(withMarkIds({ steps: [{ id: 'board_items_place', args: { path: [4], id: '1', of: '2', relation: 'left' } }] }, marks)[0].steps[0].args, { path: [4], id: 'g3n7c1f', of: 'p8w2r5d', relation: 'left' });
  assert.deepEqual(withMarkIds({ path: [4], id: 'p8w2r5d' }, marks), [{ path: [4], id: 'p8w2r5d' }, []]); // a real id stays
  assert.deepEqual(withMarkIds({ path: [4], id: '7' }, new Map()), [{ path: [4], id: '7' }, []]); // no legend, no swap
});
