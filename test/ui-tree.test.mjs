import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changes, createRefs, denyReason, estimateTokens, keyRefusal, PAGE_TOKENS, riskOf, snapshotPage } from '../src/app/assistant/ui-tree.mjs';

// Application control, the pure half (SPEC §8 ui.snapshot / ui.invoke): paging, refs, the deny list and the approval rules.

const AREAS = ['sidebar', 'toolbar', 'page', 'status'];
const rec = (i, extra = {}) => ({
  ref: `e${i + 1}`, tag: 'button', role: 'button', name: `Control number ${i}`, state: i % 7 ? [] : ['pressed'], area: AREAS[i % 4],
  bounds: [i, i * 2, 24, 24], ...extra,
});
const all = (snap) => snap.groups.flatMap((g) => g.nodes.map((n) => ({ ...n, area: g.area })));

test('paging: a 300-control screen in pages under the budget, every control once, areas grouped', () => {
  const records = Array.from({ length: 300 }, (_, i) => rec(i));
  const first = snapshotPage(records);
  assert.equal(first.total, 300);
  assert.ok(first.pages > 1, String(first.pages));
  const seen = [];
  for (let p = 1; p <= first.pages; p++) {
    const s = snapshotPage(records, { page: p });
    assert.ok(estimateTokens(s) <= PAGE_TOKENS, `page ${p}: ${estimateTokens(s)} tokens`);
    assert.equal(new Set(s.groups.map((g) => g.area)).size, s.groups.length, 'one group per area on a page');
    seen.push(...all(s).map((n) => n.ref));
  }
  assert.equal(seen.length, 300);
  assert.equal(new Set(seen).size, 300);
  assert.deepEqual(snapshotPage(records, { page: first.pages + 1 }).groups, []);
  // Areas in the order they first appear, each area's controls together; the nodes keep their fields, empty ones left out.
  assert.equal(first.groups[0].area, 'sidebar');
  assert.deepEqual(snapshotPage(records, { page: first.pages }).groups.at(-1).area, 'status');
  assert.deepEqual(first.groups[0].nodes[0], { ref: 'e1', role: 'button', name: 'Control number 0', state: ['pressed'], bounds: [0, 0, 24, 24] });
  assert.deepEqual(first.groups[0].nodes[1], { ref: 'e5', role: 'button', name: 'Control number 4', bounds: [4, 8, 24, 24] });
});

test('scope, query and dialogs on top', () => {
  const records = [rec(0, { name: 'Bold (Ctrl+B)', area: 'toolbar' }), rec(1, { name: 'OK', area: 'dialog' }), rec(2, { name: 'Heading 2', role: 'option', area: 'menu' }),
    rec(3, { name: 'Week 1', area: 'sidebar' })];
  assert.deepEqual(snapshotPage(records).groups.map((g) => g.area), ['dialog', 'menu', 'toolbar', 'sidebar']);
  assert.deepEqual(all(snapshotPage(records, { scope: 'dialog' })).map((n) => n.name), ['OK']);
  assert.deepEqual(all(snapshotPage(records, { scope: 'menu' })).map((n) => n.name), ['Heading 2']);
  assert.deepEqual(all(snapshotPage(records, { scope: 'view' })).map((n) => n.name), ['Bold (Ctrl+B)', 'Week 1']);
  assert.deepEqual(all(snapshotPage(records, { query: 'BOLD' })).map((n) => n.ref), ['e1']);
  assert.deepEqual(all(snapshotPage(records, { query: 'option heading' })).map((n) => n.ref), ['e3']);
  const none = snapshotPage(records, { query: 'nothing here' });
  assert.deepEqual([none.total, none.pages, none.groups], [0, 0, []]);
});

test('refs: the same node keeps its ref, a new node gets a new one, swept nodes are forgotten', () => {
  const refs = createRefs();
  const a = {};
  const b = {};
  assert.equal(refs.of(a), 'e1');
  assert.equal(refs.of(b), 'e2');
  assert.equal(refs.of(a), 'e1');
  assert.equal(refs.get('e2'), b);
  refs.sweep((n) => n !== b);
  assert.equal(refs.get('e2'), null);
  assert.equal(refs.of(a), 'e1');
  assert.equal(refs.of({}), 'e3');
  // A node swept while detached and attached again keeps its ref, and the ref finds it again.
  refs.sweep(() => false);
  assert.equal(refs.of(a), 'e1');
  assert.equal(refs.get('e1'), a);
});

test('deny list: passwords, file pickers, the assistant, the approval card, the title bar, the editor and marked controls', () => {
  assert.equal(denyReason({ tag: 'input', type: 'password' }), 'a password field');
  assert.equal(denyReason({ tag: 'input', type: 'text', autocomplete: 'current-password' }), 'a password field');
  assert.equal(denyReason({ tag: 'input', type: 'file' }), 'a file picker');
  for (const inside of ['assistant', 'ask', 'titlebar', 'editor', 'marked']) assert.ok(denyReason({ tag: 'button', inside }), inside);
  assert.equal(denyReason({ tag: 'button', inside: null }), null);
  assert.equal(denyReason({ tag: 'input', type: 'text', inside: null }), null);
  for (const name of ['Undo (Ctrl+Z)', 'Redo', 'Undo plan change']) assert.ok(denyReason({ tag: 'button', name, inside: null }), name);
  assert.equal(denyReason({ tag: 'button', name: 'Unpush', inside: null }), null);
  const listed = snapshotPage([rec(0), rec(1, { tag: 'input', type: 'password', role: 'textbox' }), rec(2, { inside: 'assistant' }), rec(3, { inside: 'marked' })]);
  assert.deepEqual(all(listed).map((n) => n.ref), ['e1']);
});

test('risk: data-agent-risk first, then the name rules', () => {
  assert.equal(riskOf({ name: 'Delete draft' }), 'destructive');
  assert.equal(riskOf({ name: 'Remove thread from list' }), 'destructive');
  assert.equal(riskOf({ name: 'Discard changes' }), 'destructive');
  assert.equal(riskOf({ name: 'Push to forum' }), 'approval');
  assert.equal(riskOf({ name: 'Log in' }), 'approval');
  assert.equal(riskOf({ name: 'Install...' }), 'approval');
  assert.equal(riskOf({ name: 'Bold (Ctrl+B)' }), 'write');
  assert.equal(riskOf({ name: 'Unpush', risk: 'destructive' }), 'destructive');
  assert.equal(riskOf({ name: 'Forum window', risk: 'approval' }), 'approval');
  assert.equal(riskOf({ name: 'Uninstall' }), 'destructive');
  assert.equal(riskOf({ name: 'Reset' }), 'destructive');
  assert.equal(riskOf({ name: 'Log out' }), 'approval');
  assert.deepEqual(snapshotPage([rec(0, { name: 'Delete draft', in: 'Week 1' })]).groups[0].nodes[0], { ref: 'e1', role: 'button', name: 'Delete draft', in: 'Week 1', state: ['pressed'], risk: 'destructive', bounds: [0, 0, 24, 24] });
});

test('keys: Delete and Backspace go only to a text field or contenteditable; other keys anywhere', () => {
  for (const key of ['Delete', 'Backspace']) {
    for (const el of [{ tag: 'div' }, { tag: 'button' }, { tag: 'li' }, { tag: 'input', type: 'checkbox' }]) assert.match(keyRefusal(key, el) ?? '', /text field/, `${key} ${el.tag}`);
    for (const el of [{ tag: 'input', type: 'text' }, { tag: 'input', type: 'number' }, { tag: 'textarea' }, { tag: 'div', editable: true }]) assert.equal(keyRefusal(key, el), null, `${key} ${el.tag}`);
  }
  assert.equal(keyRefusal('Escape', { tag: 'div' }), null);
  assert.equal(keyRefusal('Enter', { tag: 'button' }), null);
});

test('changes: focus, dialog and menu, the control\'s own value and state, new notices', () => {
  const base = { focus: null, dialog: null, menu: null, target: { name: 'Bold', value: undefined, state: '' }, notices: ['Saved'] };
  assert.deepEqual(changes(base, base), {});
  assert.deepEqual(changes(base, { ...base, target: { ...base.target, state: 'pressed' }, notices: ['Saved', 'Copied'] }), { state: 'pressed', notices: ['Copied'] });
  assert.deepEqual(changes(base, { ...base, menu: 'listbox', focus: 'option "Heading 2"' }), { focus: 'option "Heading 2"', menu: 'listbox' });
  assert.deepEqual(changes({ ...base, dialog: 'Link' }, { ...base, target: null }), { dialog: null, gone: true });
});
