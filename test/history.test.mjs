import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, Plugin } from '@tiptap/pm/state';
import { history, redo, redoDepth, undo, undoDepth } from '@tiptap/pm/history';
import { encode, newLog, rebuild, record } from '../src/app/history.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    image: { group: 'inline', inline: true, attrs: { src: {} } },
    text: { group: 'inline' },
  },
  marks: { bold: {} },
});
const IMG = `data:image/png;base64,${'A'.repeat(5000)}`;
// Like TipTap's trailing node: an appended transaction keeps an empty paragraph at the end.
const trailing = new Plugin({
  appendTransaction: (trs, _old, state) => (state.doc.lastChild.content.size ? state.tr.insert(state.doc.content.size, schema.nodes.paragraph.create()) : null),
});

// An editor stand-in: dispatch applies like EditorView + TipTap and records what the 'transaction' event reports.
function session(depth, doc) {
  const s = { state: EditorState.create({ schema, doc, plugins: [history({ depth }), trailing] }), t: Date.now() };
  s.log = newLog(s.state);
  s.dispatch = (tr) => {
    const { state, transactions } = s.state.applyTransaction(tr);
    record(s.log, tr, transactions.slice(1), state);
    s.state = state;
  };
  s.type = (text, gap = 2000) => s.dispatch(s.state.tr.insertText(text).setTime((s.t += gap)));
  s.cmd = (command) => command(s.state, s.dispatch);
  return s;
}

// Saves (JSON round trip like the IPC + file), reopens on the saved doc, rebuilds.
function reopen(s, limit, depth = limit || 50) {
  const file = JSON.parse(JSON.stringify(encode(s.log, limit)));
  const r = session(depth, s.state.doc);
  const rebuilt = rebuild(r.state, file, limit);
  if (rebuilt) Object.assign(r, rebuilt);
  return { r, file, rebuilt };
}

// The docs the undo stack steps back through, as text.
function undoTexts(s) {
  const out = [];
  let state = s.state;
  while (undo(state, (tr) => { state = state.apply(tr); })) out.push(state.doc.textContent);
  return out;
}

test('steps, grouping, marks and the redo stack survive a reopen', () => {
  const s = session(50);
  s.type('one');
  s.type('a', 2000);
  s.type('b', 100); // within the group delay and adjacent: joins the previous step
  s.type(' three');
  s.dispatch(s.state.tr.addMark(1, 4, schema.marks.bold.create()).setTime((s.t += 2000)));
  s.dispatch(s.state.tr.replaceSelectionWith(schema.nodes.image.create({ src: IMG })).setTime((s.t += 2000)));
  assert.equal(undoDepth(s.state), 5);
  s.cmd(undo);
  s.cmd(undo);
  const { r, rebuilt } = reopen(s, 50);
  assert.ok(rebuilt);
  assert.ok(r.state.doc.eq(s.state.doc));
  assert.deepEqual([undoDepth(r.state), redoDepth(r.state)], [3, 2]);
  assert.deepEqual(undoTexts(r), undoTexts(s));
  r.cmd(redo);
  s.cmd(redo);
  assert.ok(r.state.doc.eq(s.state.doc));
  r.cmd(redo);
  s.cmd(redo);
  assert.ok(r.state.doc.eq(s.state.doc));
  assert.equal(r.state.doc.firstChild.child(0).marks[0]?.type.name, 'bold');
  // The rebuilt log keeps recording: a new step after the reopen saves and reopens again.
  r.type('!');
  const again = reopen(r, 50).r;
  assert.deepEqual(undoTexts(again), undoTexts(r));
});

test('each picture is stored once', () => {
  const s = session(50, schema.node('doc', null, [schema.node('paragraph', null, [schema.nodes.image.create({ src: IMG })])]));
  for (let i = 0; i < 5; i++) s.type(`w${i} `);
  const file = encode(s.log, 50);
  assert.deepEqual(Object.values(file.images), [IMG]);
  assert.equal(JSON.stringify(file).split(IMG).length - 1, 1);
});

test('the limit keeps the last undo steps; 0 keeps none; the depth cut folds into the base', () => {
  const s = session(50);
  for (let i = 0; i < 8; i++) s.type(`w${i} `);
  const { r } = reopen(s, 5);
  assert.equal(undoDepth(r.state), 5);
  assert.deepEqual(undoTexts(r), undoTexts(s).slice(0, 5));
  assert.equal(encode(s.log, 0), null);
  assert.equal(reopen(s, 0, 50).rebuilt, null);
  // Depth 1: the 22nd step makes the history cut off 21 old ones.
  const d = session(1);
  for (let i = 0; i < 25; i++) d.type(`x${i} `);
  assert.equal(d.log.events.length, undoDepth(d.state));
  assert.deepEqual(undoTexts(reopen(d, 50, 1).r), undoTexts(d));
  assert.deepEqual(undoTexts(reopen(d, 1).r), undoTexts(d).slice(0, 1));
});

test('a file that does not lead to the saved doc, or is corrupt, gives no history', () => {
  const s = session(50);
  s.type('one');
  s.type(' two');
  const file = encode(s.log, 50);
  const other = session(50, schema.node('doc', null, [schema.node('paragraph', null, [schema.text('else')])]));
  assert.equal(rebuild(other.state, file, 50), null);
  const fresh = session(50, s.state.doc).state;
  assert.equal(rebuild(fresh, { ...file, version: 2 }, 50), null);
  assert.equal(rebuild(fresh, { ...file, base: { type: 'nope' } }, 50), null);
  assert.equal(rebuild(fresh, { ...file, events: 'x' }, 50), null);
  assert.ok(rebuild(fresh, file, 50));
});
