import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor, getSchema } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { Canvas } from '../src/canvas.js';
import { documentExtensions } from '../src/document/schema.js';
import * as core from '../src/suggest/core.mjs';
import { Suggestions, suggestKey, withCall } from '../src/suggest/extension.js';

// Agent edits as suggestions (docs/plans/suggestions.md step 1): records, the converter, normalize, accept and reject.
const DOC_KIT = () => [...documentExtensions(50), Suggestions];
const FORUM_KIT = () => [StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }), Canvas, Suggestions]; // codeBlock (marks ''), an atom

// A headless editor with its plugins (headless TipTap leaves the state without them).
function editor(kit, content) {
  const ed = new Editor({ element: null, extensions: kit(), content });
  ed.view.updateState(ed.state.reconfigure({ plugins: ed.extensionManager.plugins }));
  return ed;
}
const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const p = (text) => ({ type: 'paragraph', content: text ? [t(text)] : [] });
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const doc = (...content) => ({ type: 'doc', content });
const json = (ed) => JSON.stringify(ed.getJSON());
const texts = (ed) => ed.getJSON().content.map((b) => ed.schema.nodeFromJSON(b).textContent);
let gi = 0;
const call = (g = `g${++gi}`) => ({ g, by: 'agent:test', at: 1000 + gi, ids: [] });
const agent = (ed, c, fn) => withCall(ed, c, 'exact', () => fn(ed));
const run = (ed, tr) => ed.view.dispatch(tr);
const reject = (ed, ids) => run(ed, core.reject(ed.state, ids));
const accept = (ed, ids) => run(ed, core.accept(ed.state, ids));
const posOf = (ed, i) => {
  let pos = 0;
  for (let k = 0; k < i; k++) pos += ed.state.doc.child(k).nodeSize;
  return pos;
};
const hasRecords = (ed) => /"suggest":\{/.test(json(ed));

// ---------- hunks ----------
test('hunks: an insert in the middle, two separate deletes, a replace, an append', () => {
  const schema = getSchema(DOC_KIT());
  const d = (...xs) => schema.nodeFromJSON(doc(...xs.map((x) => p(x))));
  assert.deepEqual(core.hunks(d('a', 'b', 'c'), d('a', 'x', 'b', 'c')), [{ a: [1, 1], b: [1, 2] }]);
  assert.deepEqual(core.hunks(d('a', 'b', 'c', 'd', 'e'), d('a', 'c', 'e')), [{ a: [1, 2], b: [1, 1] }, { a: [3, 4], b: [2, 2] }]);
  assert.deepEqual(core.hunks(d('a', 'b', 'c'), d('a', 'B', 'c')), [{ a: [1, 2], b: [1, 2] }]);
  assert.deepEqual(core.hunks(d('a', 'b'), d('a', 'b', 'c', 'd')), [{ a: [2, 2], b: [2, 4] }]);
});

// ---------- convert, reject, accept ----------
// Runs `change` as an agent call on a fresh editor: rejecting gives the exact old doc, accepting the doc the change makes without
// the extension's conversion (records all null). → the converted editor state, for more checks.
function roundTrip(kit, content, change, label) {
  const ed = editor(kit, content);
  const before = json(ed);
  const c = call();
  agent(ed, c, change);
  assert.ok(c.ids.length, `${label}: the change has an id`);
  assert.ok(core.pendingCount(ed.state.doc) > 0, `${label}: records are in the doc`);
  const converted = ed.state;
  reject(ed, c.ids);
  assert.equal(json(ed), before, `${label}: reject gives the old doc`);
  assert.equal(core.pendingCount(ed.state.doc), 0);
  ed.view.updateState(converted);
  accept(ed, c.ids);
  const plain = editor(kit, content);
  change(plain);
  assert.equal(json(ed), json(plain), `${label}: accept gives the new doc without records`);
  ed.view.updateState(converted);
  return { ed, c };
}

test('convert then reject restores the old doc, accept keeps the new one without records', () => {
  const base = doc(p('The quick brown fox'), p('Second line'), p('Third'));
  roundTrip(DOC_KIT, base, (ed) => run(ed, ed.state.tr.insertText('red', 11, 16)), 'a word');
  roundTrip(DOC_KIT, doc(h(1, 'Title'), p('Body')), (ed) => run(ed, ed.state.tr.setNodeMarkup(0, null, { ...ed.state.doc.child(0).attrs, level: 2 })), 'heading level');
  roundTrip(DOC_KIT, base, (ed) => run(ed, ed.state.tr.addMark(5, 10, ed.schema.marks.bold.create())), 'bold on one word');
  roundTrip(FORUM_KIT, doc({ type: 'bulletList', content: [{ type: 'listItem', content: [p('one')] }] }, p('after')),
    (ed) => run(ed, ed.state.tr.insert(ed.state.doc.child(0).nodeSize - 1, ed.schema.nodeFromJSON({ type: 'listItem', content: [p('two')] }))), 'a list item added');
  roundTrip(DOC_KIT, doc(p('one'), { type: 'paragraph', attrs: { numbering: { numId: 1, ilvl: 0 } }, content: [t('item')] }),
    (ed) => run(ed, ed.state.tr.insert(ed.state.doc.content.size, ed.schema.nodeFromJSON({ type: 'paragraph', attrs: { numbering: { numId: 1, ilvl: 0 } }, content: [t('item 2')] }))),
    'a Document list paragraph added');
  const table = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p('cell')] }, { type: 'tableCell', content: [p('other')] }] }] };
  roundTrip(DOC_KIT, doc(p('before'), table, p('after')), (ed) => {
    let at = 0;
    ed.state.doc.descendants((n, pos) => { if (n.isText && n.text === 'cell') at = pos; });
    run(ed, ed.state.tr.insertText('CELL', at, at + 4));
  }, "a table cell's text");
  roundTrip(FORUM_KIT, doc(p('x'), { type: 'codeBlock', content: [t('let a = 1;')] }, p('y')), (ed) => run(ed, ed.state.tr.insertText('2', 12, 13)), "a code block's text");
  const items = [{ id: 'i1', type: 'text', x: 0, y: 0, w: 10, h: 10, text: 'a' }];
  roundTrip(FORUM_KIT, doc(p('x'), { type: 'canvas', attrs: { items } }, p('y')),
    (ed) => run(ed, ed.state.tr.setNodeMarkup(3, null, { ...ed.state.doc.child(1).attrs, items: [...items, { id: 'i2', type: 'text', x: 5, y: 5, w: 10, h: 10, text: 'b' }] })),
    'a canvas attrs change');
  const last = roundTrip(DOC_KIT, base, (ed) => run(ed, ed.state.tr.delete(posOf(ed, 2), ed.state.doc.content.size)), 'the last block deleted');
  assert.equal(core.entries(last.ed.state.doc)[0].kind, 'delete');
  assert.equal(last.ed.state.doc.lastChild.attrs.suggest.del[0].side, 'after');
  const every = roundTrip(DOC_KIT, base, (ed) => run(ed, ed.state.tr.replaceWith(0, ed.state.doc.content.size, ed.schema.nodes.paragraph.create())), 'every block deleted');
  assert.equal(every.ed.state.doc.childCount, 1);
  roundTrip(DOC_KIT, base, (ed) => run(ed, ed.state.tr.setDocAttribute('sect', { w: 612, h: 792, margin: {} })), 'page setup');
  // A heading appended at the end: TrailingNode adds an empty paragraph in the same round, and both are one change.
  const tail = roundTrip(FORUM_KIT, doc(p('one')), (ed) => run(ed, ed.state.tr.insert(ed.state.doc.content.size, ed.schema.nodeFromJSON(h(2, 'New part')))), 'a heading at the end');
  const [e] = core.entries(tail.ed.state.doc);
  assert.equal(core.entries(tail.ed.state.doc).length, 1);
  assert.deepEqual(e.nodes.map((n) => n.type.name), ['heading', 'paragraph']);
  assert.equal(core.describe(e, tail.ed.schema), 'Add “New part”');
});

test('two calls of one group keep one id; another group takes a pending change over with its first base', () => {
  const ed = editor(DOC_KIT, doc(p('one'), p('two')));
  const before = json(ed);
  const g = call();
  agent(ed, g, (x) => run(x, x.state.tr.insert(5, x.schema.nodeFromJSON(p('new')))));
  agent(ed, { ...g, ids: [] }, (x) => run(x, x.state.tr.insertText(' text', 9)));
  assert.equal(core.entries(ed.state.doc).length, 1);
  assert.equal(core.entries(ed.state.doc)[0].nodes[0].textContent, 'new text');
  reject(ed, [g.ids[0]]);
  assert.equal(json(ed), before);
  // Group A replaces "two", group B changes it again: B takes it over, and its reject brings back "two".
  const a = call();
  agent(ed, a, (x) => run(x, x.state.tr.insertText('TWO', 6, 9)));
  const b = call();
  agent(ed, b, (x) => run(x, x.state.tr.insertText('2', 6, 9)));
  const es = core.entries(ed.state.doc);
  assert.equal(es.length, 1);
  assert.equal(es[0].g, b.g);
  assert.equal(es[0].old[0].content[0].text, 'two');
  reject(ed, b.ids);
  assert.equal(json(ed), before);
});

// ---------- normalize ----------
const userSplit = (ed, pos) => {
  ed.commands.setTextSelection(pos);
  ed.commands.splitBlock();
};

test('normalize: Enter inside a run keeps one base; reject restores it and the change counts as edited', () => {
  const ed = editor(DOC_KIT, doc(p('alpha'), p('The quick brown fox'), p('omega')));
  const before = json(ed);
  const c = call();
  agent(ed, c, (x) => run(x, x.state.tr.insertText('red', 18, 23)));
  userSplit(ed, 13); // inside "quick"
  const carriers = [];
  ed.state.doc.forEach((n) => n.attrs.suggest?.ins && carriers.push(!!n.attrs.suggest.ins.old));
  assert.deepEqual(carriers, [true, false]);
  assert.equal(core.edited(ed.state.doc, c.ids[0]), true);
  reject(ed, c.ids);
  assert.equal(json(ed), before);
});

test('normalize: Enter at the start of a deletion carrier keeps the user paragraph after the base', () => {
  const ed = editor(DOC_KIT, doc(p('X'), p('gone'), p('C')));
  const c = call();
  agent(ed, c, (x) => run(x, x.state.tr.delete(3, 9)));
  assert.deepEqual(texts(ed), ['X', 'C']);
  userSplit(ed, 4); // the start of C
  assert.equal(core.pendingCount(ed.state.doc), 1);
  reject(ed, c.ids);
  assert.deepEqual(texts(ed), ['X', 'gone', '', 'C']);
  assert.ok(!hasRecords(ed));
});

test('normalize: Backspace joining a run into the block before brings every base block back once', () => {
  // A two-block run: its old moves to the run's next block.
  const ed = editor(DOC_KIT, doc(p('U'), p('one'), p('two'), p('end')));
  const c = call();
  agent(ed, c, (x) => run(x, x.state.tr.replaceWith(3, 13, [x.schema.nodeFromJSON(p('ONE')), x.schema.nodeFromJSON(p('TWO'))])));
  ed.commands.setTextSelection(4);
  ed.commands.joinBackward();
  assert.deepEqual(texts(ed), ['UONE', 'TWO', 'end']);
  reject(ed, c.ids);
  assert.deepEqual(texts(ed), ['UONE', 'one', 'two', 'end']);
  assert.ok(!hasRecords(ed));
  // A one-block run: its old becomes a deletion record after the joined block.
  const one = editor(DOC_KIT, doc(p('U'), p('one'), p('end')));
  const d = call();
  agent(one, d, (x) => run(x, x.state.tr.insertText('ONE', 4, 7)));
  one.commands.setTextSelection(4);
  one.commands.joinBackward();
  assert.deepEqual(texts(one), ['UONE', 'end']);
  assert.equal(core.entries(one.state.doc)[0].kind, 'delete');
  reject(one, d.ids);
  assert.deepEqual(texts(one), ['UONE', 'one', 'end']);
  assert.ok(!hasRecords(one));
});

test('normalize: Backspace joining a deletion carrier into the block before keeps the record', () => {
  const ed = editor(DOC_KIT, doc(p('U'), p('gone'), p('C')));
  const c = call();
  agent(ed, c, (x) => run(x, x.state.tr.delete(3, 9)));
  ed.commands.setTextSelection(4);
  ed.commands.joinBackward();
  assert.deepEqual(texts(ed), ['UC']);
  assert.equal(core.pendingCount(ed.state.doc), 1);
  reject(ed, c.ids);
  assert.deepEqual(texts(ed), ['UC', 'gone']);
  assert.ok(!hasRecords(ed));
});

test('normalize: a list around a suggested paragraph takes its record, and taking the list off gives it back', () => {
  const ed = editor(FORUM_KIT, doc(p('a'), p('The quick brown fox'), p('z')));
  const before = json(ed);
  const c = call();
  agent(ed, c, (x) => run(x, x.state.tr.insertText('red', 14, 19)));
  ed.commands.setTextSelection(6);
  ed.commands.toggleBulletList();
  assert.equal(ed.state.doc.child(1).type.name, 'bulletList');
  assert.ok(ed.state.doc.child(1).attrs.suggest?.ins?.old);
  let nested = 0;
  ed.state.doc.child(1).descendants((n) => void (n.attrs.suggest && nested++));
  assert.equal(nested, 0);
  const listed = ed.state;
  reject(ed, c.ids);
  assert.equal(json(ed), before);
  ed.view.updateState(listed);
  ed.commands.setTextSelection(8);
  ed.commands.toggleBulletList();
  assert.equal(ed.state.doc.child(1).type.name, 'paragraph');
  assert.ok(ed.state.doc.child(1).attrs.suggest?.ins?.old);
  reject(ed, c.ids);
  assert.equal(json(ed), before);
});

test('normalize: a drag-move of a suggested block brings the base back at the old place and keeps the moved copy', () => {
  const ed = editor(DOC_KIT, doc(p('a'), p('old text'), p('b'), p('c')));
  const c = call();
  agent(ed, c, (x) => run(x, x.state.tr.insertText('new', 4, 7)));
  // A drop: the dragged slice loses its records (transformPasted), the source goes, the copy lands after "c".
  const plugin = ed.state.plugins.find((x) => x.spec.key === suggestKey);
  const from = 3;
  const to = from + ed.state.doc.child(1).nodeSize;
  const slice = plugin.props.transformPasted(ed.state.doc.slice(from, to));
  assert.equal(slice.content.firstChild.attrs.suggest, null);
  const tr = ed.state.tr.delete(from, to);
  tr.insert(tr.doc.content.size, slice.content);
  run(ed, tr);
  assert.deepEqual(texts(ed), ['a', 'b', 'c', 'new text']);
  reject(ed, c.ids);
  assert.deepEqual(texts(ed), ['a', 'old text', 'b', 'c', 'new text']);
  assert.ok(!hasRecords(ed));
});

test("edited: a doc attribute record after the user sets the same key; a block's text", () => {
  const ed = editor(DOC_KIT, doc(p('one')));
  const c = call();
  agent(ed, c, (x) => run(x, x.state.tr.setDocAttribute('sect', { w: 612 })));
  assert.equal(core.edited(ed.state.doc, c.ids[0]), false);
  run(ed, ed.state.tr.setDocAttribute('sect', { w: 595 }));
  assert.equal(core.edited(ed.state.doc, c.ids[0]), true);
  reject(ed, c.ids);
  assert.equal(ed.state.doc.attrs.sect, null);
  const d = call();
  agent(ed, d, (x) => run(x, x.state.tr.insertText('ONE', 1, 4)));
  assert.equal(core.edited(ed.state.doc, d.ids[0]), false);
  run(ed, ed.state.tr.insertText('!', 4));
  assert.equal(core.edited(ed.state.doc, d.ids[0]), true);
});

// ---------- attribution ----------
test('attribute(): who a dispatch under an agent scope belongs to', () => {
  const now = 10000;
  assert.equal(core.attribute('ui', { isTrusted: false, type: 'click' }, -Infinity, now), 'agent');
  assert.equal(core.attribute('ui', { isTrusted: true, type: 'click' }, -Infinity, now), 'user'); // the user's toolbar click, outside the editor
  assert.equal(core.attribute('ui', { isTrusted: true, type: 'focus' }, -Infinity, now), 'agent');
  assert.equal(core.attribute('ui', undefined, now - 20, now), 'user'); // a keydown in the editor 20 ms ago
  assert.equal(core.attribute('ui', undefined, -Infinity, now), 'agent'); // a keydown elsewhere (the chat input) does not count
  assert.equal(core.attribute('computer', { isTrusted: true, type: 'keydown' }, now, now), 'agent');
  assert.equal(core.attribute('exact', undefined, now, now), 'agent');
});

test('a user round is never converted; an agent scope on another editor does not reach this one', () => {
  const ed = editor(DOC_KIT, doc(p('one')));
  const other = editor(DOC_KIT, doc(p('two')));
  run(ed, ed.state.tr.insertText('!', 4));
  agent(other, call(), () => run(ed, ed.state.tr.insertText('?', 5)));
  assert.equal(core.pendingCount(ed.state.doc), 0);
});

// ---------- agent JSON ----------
test('strip removes forged records; brief leaves the live JSON as it was', () => {
  const forged = doc({ type: 'paragraph', attrs: { suggest: { ins: { id: 'sx', old: [] } } }, content: [t('x')] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', attrs: { suggest: { del: [] } } }] }] });
  const s = core.strip(forged);
  assert.ok(!JSON.stringify(s).includes('suggest'));
  assert.ok(JSON.stringify(forged).includes('"sx"')); // the input is untouched
  const ed = editor(DOC_KIT, doc(p('The quick brown fox'), p('two')));
  agent(ed, call(), (x) => run(x, x.state.tr.insertText('red', 11, 16)));
  const live = ed.getJSON();
  const was = JSON.stringify(live);
  const b = core.brief(live);
  assert.equal(JSON.stringify(live), was);
  assert.equal(JSON.stringify(ed.getJSON()), was);
  assert.deepEqual(Object.keys(b.content[0].attrs.suggest), ['id', 'kind']);
  assert.equal(b.content[0].attrs.suggest.kind, 'replace');
  assert.ok(!('suggest' in b.content[1].attrs));
  assert.ok(!JSON.stringify(b).includes('brown'));
});

// ---------- row text ----------
test('describe: the row text of each kind of change', () => {
  const rows = (kit, content, change) => {
    const ed = editor(kit, content);
    agent(ed, call(), change);
    return core.entries(ed.state.doc).map((e) => core.describe(e, ed.schema));
  };
  const base = doc(p('The quick brown fox jumps'), p('Second line'));
  assert.deepEqual(rows(DOC_KIT, base, (ed) => run(ed, ed.state.tr.insertText('red', 11, 16))), ['Replace “brown” with “red”']);
  assert.deepEqual(rows(DOC_KIT, base, (ed) => run(ed, ed.state.tr.addMark(5, 10, ed.schema.marks.bold.create()))), ['Format bold']);
  assert.deepEqual(rows(DOC_KIT, base, (ed) => run(ed, ed.state.tr.insert(ed.state.doc.content.size, ed.schema.nodeFromJSON(p('A new closing line'))))), ['Add “A new closing line”']);
  assert.deepEqual(rows(DOC_KIT, base, (ed) => run(ed, ed.state.tr.delete(posOf(ed, 1), ed.state.doc.content.size))), ['Delete “Second line”']);
  assert.deepEqual(rows(DOC_KIT, base, (ed) => run(ed, ed.state.tr.setDocAttribute('sect', { w: 1 }))), ['Change page setup']);
  const three = rows(DOC_KIT, doc(p('The quick brown fox jumps over the lazy dog')), (ed) => run(ed, ed.state.tr.insertText('sleepy', 36, 40).insertText('cat', 17, 20).insertText('slow', 5, 10)));
  assert.deepEqual(three, ['Change 3 places in “The slow brown cat jumps over the…”']);
  const items = [1, 2, 3, 4].map((i) => ({ id: `i${i}`, type: 'text', x: i, y: 0, w: 10, h: 10, text: String(i) }));
  const canvas = rows(FORUM_KIT, doc(p('x'), { type: 'canvas', attrs: { items } }, p('y')), (ed) => run(ed, ed.state.tr.setNodeMarkup(3, null, {
    ...ed.state.doc.child(1).attrs,
    items: [{ ...items[0], text: 'changed' }, items[1], ...[5, 6, 7].map((i) => ({ id: `i${i}`, type: 'text', x: i, y: 0, w: 10, h: 10, text: 'n' }))],
  })));
  assert.deepEqual(canvas, ['Add 3 items, change 1, remove 2']);
  assert.deepEqual(rows(FORUM_KIT, doc(p('x')), (ed) => run(ed, ed.state.tr.insert(ed.state.doc.content.size, ed.schema.nodes.canvas.create()))), ['Add smart canvas']);
});

// ---------- the attribute ----------
test('every top-level node type and the doc carry the attribute; pasted HTML and slices give no record', () => {
  for (const kit of [DOC_KIT, FORUM_KIT]) {
    const schema = getSchema(kit());
    const top = Object.values(schema.nodes).filter((n) => n.isInGroup?.('block') || (n.spec.group ?? '').split(' ').includes('block'));
    assert.ok(top.length > 3);
    for (const n of [...top, schema.topNodeType]) assert.ok('suggest' in n.spec.attrs, `${n.name} has suggest`);
    // A <p suggest="..."> parses without a record (parseHTML () => null; a falsy parseHTML would read the attribute).
    const el = { getAttribute: (k) => (/suggest/.test(k) ? '{"ins":{"id":"sx"}}' : null), hasAttribute: () => false, style: {}, classList: [], parentElement: null };
    const attrs = schema.nodes.paragraph.spec.parseDOM[0].getAttrs(el);
    assert.ok(!attrs || !('suggest' in attrs));
  }
  const ed = editor(DOC_KIT, doc(p('one')));
  agent(ed, call(), (x) => run(x, x.state.tr.insertText('ONE', 1, 4)));
  const plugin = ed.state.plugins.find((x) => x.spec.key === suggestKey);
  const slice = plugin.props.transformPasted(new Slice(ed.state.doc.content, 0, 0));
  assert.equal(slice.content.firstChild.attrs.suggest, null);
});

test("rejecting a draft's last blocks leaves one empty paragraph", () => {
  const ed = editor(DOC_KIT, doc(p('mine')));
  const c = call();
  agent(ed, c, (x) => run(x, x.state.tr.insert(x.state.doc.content.size, x.schema.nodeFromJSON(p('theirs')))));
  run(ed, ed.state.tr.delete(0, ed.state.doc.child(0).nodeSize)); // the user deletes their own paragraph
  assert.deepEqual(texts(ed), ['theirs']);
  reject(ed, c.ids);
  assert.deepEqual(texts(ed), ['']);
  assert.ok(!hasRecords(ed));
});

// ---------- review fixes (2026-10-26) ----------
const at = (ed, s) => {
  let found = -1;
  ed.state.doc.descendants((n, pos) => {
    if (found < 0 && n.isText && n.text.includes(s)) found = pos + n.text.indexOf(s);
  });
  return found;
};

test("normalize: the user's paragraph joined into a suggested one stays the user's; an empty one rejoins the run", () => {
  for (const kit of [FORUM_KIT, DOC_KIT]) {
    const ed = editor(kit, doc(p('alpha'), p('agent target'), p('my own paragraph'), p('omega')));
    const c = call();
    agent(ed, c, (x) => run(x, x.state.tr.insertText('changed', at(x, 'target'), at(x, 'target') + 6)));
    ed.commands.setTextSelection(at(ed, 'my own'));
    ed.commands.joinBackward();
    assert.deepEqual(texts(ed), ['alpha', 'agent changedmy own paragraph', 'omega']);
    assert.equal(ed.state.doc.child(1).attrs.suggest?.ins, undefined);
    assert.equal(core.edited(ed.state.doc, c.ids[0]), true);
    reject(ed, c.ids);
    assert.deepEqual(texts(ed), ['alpha', 'agent target', 'agent changedmy own paragraph', 'omega']);
    assert.ok(!hasRecords(ed));
  }
  // Enter at the run's end, then Backspace: the run is whole again.
  const ed = editor(DOC_KIT, doc(p('alpha'), p('agent target'), p('omega')));
  const before = json(ed);
  const c = call();
  agent(ed, c, (x) => run(x, x.state.tr.insertText('changed', at(x, 'target'), at(x, 'target') + 6)));
  userSplit(ed, at(ed, 'changed') + 7);
  ed.commands.joinBackward();
  assert.equal(core.entries(ed.state.doc)[0].kind, 'replace');
  reject(ed, c.ids);
  assert.equal(json(ed), before);
});

test('a page break at the end of a suggested paragraph starts a paragraph of the user', () => {
  const ed = editor(DOC_KIT, doc(p('alpha'), p('agent target')));
  const c = call();
  agent(ed, c, (x) => run(x, x.state.tr.insertText('changed', at(x, 'target'), at(x, 'target') + 6)));
  ed.commands.setTextSelection(ed.state.doc.content.size - 1);
  ed.commands.setPageBreak();
  run(ed, ed.state.tr.insertText('my new page text'));
  reject(ed, c.ids);
  assert.deepEqual(texts(ed), ['alpha', 'agent target', '', 'my new page text']);
});

test("diff: word changes land in their own blocks when the user's paragraph sits between a run's blocks", () => {
  const ed = editor(DOC_KIT, doc(p('alpha'), p('one two three'), p('four five six'), p('omega')));
  agent(ed, call(), (x) => {
    const tr = x.state.tr.insertText('TWO', at(x, 'five'), at(x, 'five') + 4);
    run(x, tr.insertText('2', at(x, 'two'), at(x, 'two') + 3));
  });
  userSplit(ed, at(ed, 'three') + 5);
  run(ed, ed.state.tr.insertText('my own words'));
  const [e] = core.entries(ed.state.doc);
  const words = core.diff(e, ed.state.doc, ed.schema).map((d) => [d.kind, d.text, ed.state.doc.textBetween(d.from, d.to), ed.state.doc.resolve(d.from).parent.textContent]);
  assert.deepEqual(words, [['del', 'two', '', 'one 2 three'], ['add', '2', '2', 'one 2 three'], ['del', 'five', '', 'four TWO six'], ['add', 'TWO', 'TWO', 'four TWO six']]);
});

test("edited: an agent's own later call is never the user's edit", () => {
  // A same-group list around a suggested paragraph.
  const ed = editor(FORUM_KIT, doc(p('a'), p('The quick brown fox'), p('z')));
  const c = call();
  agent(ed, c, (x) => run(x, x.state.tr.insertText('red', at(x, 'brown'), at(x, 'brown') + 5)));
  agent(ed, { ...c, ids: [] }, (x) => {
    x.commands.setTextSelection(6);
    x.commands.toggleBulletList();
  });
  assert.equal(core.edited(ed.state.doc, c.ids[0]), false);
  // A same-group call removing one block of its own two-block insert.
  const two = editor(FORUM_KIT, doc(p('mine'), p('end')));
  const d = call();
  agent(two, d, (x) => run(x, x.state.tr.insert(6, [x.schema.nodeFromJSON(p('new one')), x.schema.nodeFromJSON(p('new two'))])));
  agent(two, { ...d, ids: [] }, (x) => {
    const s = posOf(x, 2);
    run(x, x.state.tr.delete(s, s + x.state.doc.child(2).nodeSize));
  });
  assert.deepEqual(texts(two), ['mine', 'new one', 'end']);
  assert.equal(core.edited(two.state.doc, d.ids[0]), false);
});

test('describe: writing into an empty line is an add, deleting the last block before the trailing line a delete', () => {
  const rows = (kit, content, change) => {
    const ed = editor(kit, content);
    agent(ed, call(), change);
    return core.entries(ed.state.doc).map((e) => core.describe(e, ed.schema));
  };
  assert.deepEqual(rows(FORUM_KIT, doc(p('')), (ed) => run(ed, ed.state.tr.insertText('Hello world', 1))), ['Add “Hello world”']);
  assert.deepEqual(rows(DOC_KIT, doc(p('Intro'), p('')), (ed) => run(ed, ed.state.tr.replaceWith(7, 9, ed.schema.nodeFromJSON(p('A closing line'))))), ['Add “A closing line”']);
  assert.deepEqual(rows(FORUM_KIT, doc(p('a'), h(2, 'Head'), p('closing words')), (ed) => run(ed, ed.state.tr.delete(posOf(ed, 2), ed.state.doc.content.size))),
    ['Delete “closing words”']);
});

test("groups: another group's takeover of a page setup record does not keep the first group's note", () => {
  const ed = editor(DOC_KIT, doc(p('one')));
  agent(ed, { g: 'gA', by: 'agent:assistant', at: 1, note: 'Make it A4', ids: [] }, (x) => run(x, x.state.tr.setDocAttribute('sect', { w: 595 })));
  agent(ed, { g: 'gB', by: 'agent:claude-code', at: 2, ids: [] }, (x) => run(x, x.state.tr.setDocAttribute('sect', { w: 612 })));
  assert.deepEqual(core.groups(ed.state.doc).map(({ g, by, note }) => ({ g, by, note })), [{ g: 'gB', by: 'agent:claude-code', note: null }]);
  assert.equal(ed.state.doc.attrs.suggest.attrs[0].old, null);
});
