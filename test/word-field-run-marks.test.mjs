// field-run-marks (docs/plans/word/briefs/field-run-marks.md): Clear Formatting, Ctrl+Space and a mark taken off a whole field
// reach the formatting of the field result's own runs, as in Word, and unlink keeps what is left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { documentExtensions } from '../src/document/schema.js';
import { newDocumentJson } from '../src/document/defaults.mjs';
import { stripRuns, without } from '../src/document/wp/fields-core/runs.mjs';
import { resetMarks } from '../src/document/wp/font/run.mjs';
import { resolveTr } from '../src/document/wp/tracking/resolve.mjs';

const { FieldRunMarks, unlinkNodes } = await import('../src/document/wp/fields-core/commands.js');

const RED = { type: 'textStyle', attrs: { color: '#FF0000', highlight: 'yellow' } };
const RUNS = [{ text: 'plain ' }, { text: 'italic', marks: [{ type: 'italic' }, RED] }, { text: ' plain' }];
const field = (marks) => ({ type: 'field', attrs: { code: 'QUOTE "plain italic plain" \\* MERGEFORMAT', result: 'plain italic plain', runs: RUNS }, ...(marks && { marks }) });

/** An editor on one paragraph "A " + the field, with the field node-selected (at 3). */
function editorWith(marks) {
  const ed = new Editor({ extensions: [...documentExtensions(50), FieldRunMarks], content: { ...newDocumentJson({ paper: 'a4' }),
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A ' }, field(marks)] }] } });
  // An editor without an element mounts no plugins of its own (as in word-docx-roundtrip-runs.test.mjs).
  ed.view.updateState(ed.state.reconfigure({ plugins: ed.extensionManager.plugins }));
  ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, 3)));
  return ed;
}
const fieldOf = (ed) => ed.state.doc.nodeAt(3);
/** A field's runs and its marks as JSON, textStyle without its unset keys. */
const shape = (node) => ({ runs: node.attrs.runs, marks: node.marks.map((m) => (m.type.name !== 'textStyle' ? m.toJSON()
  : { type: 'textStyle', attrs: Object.fromEntries(Object.entries(m.attrs).filter(([, v]) => v != null)) })) });

test('without drops mark types and textStyle keys from mark JSON', () => {
  assert.deepEqual(without(['italic'])([{ type: 'bold' }, { type: 'italic' }]), [{ type: 'bold' }]);
  assert.deepEqual(without([], ['color'])([RED]), [{ type: 'textStyle', attrs: { highlight: 'yellow' } }]);
  assert.deepEqual(without([], ['color', 'highlight'])([RED, { type: 'bold' }]), [{ type: 'bold' }]);
  assert.deepEqual(without(['textStyle'])([RED]), []);
});

test('stripRuns takes a mark type off every run, packs the runs again and keeps a node selection', () => {
  const ed = editorWith([{ type: 'bold' }]);
  try {
    const { tr } = ed.state;
    assert.equal(stripRuns(tr, 0, tr.doc.content.size, without(['italic'])), true);
    // The bold given to the whole field went into every run and stays the node's as their shared formatting.
    assert.deepEqual(shape(tr.doc.nodeAt(3)), { runs: [{ text: 'plain ', marks: [{ type: 'bold' }] }, { text: 'italic', marks: [{ type: 'bold' }, RED] },
      { text: ' plain', marks: [{ type: 'bold' }] }], marks: [{ type: 'bold' }] });
    assert.ok(tr.selection instanceof NodeSelection && tr.selection.from === 3, 'the field stays selected');
    assert.equal(stripRuns(tr, 0, tr.doc.content.size, without(['italic'])), false, 'nothing left to strip');
    // Ctrl+Space's strip keeps the highlight; the colour goes and a result in one formatting needs no runs.
    stripRuns(tr, 0, tr.doc.content.size, resetMarks);
    assert.deepEqual(shape(tr.doc.nodeAt(3)), { runs: [{ text: 'plain ' }, { text: 'italic', marks: [{ type: 'textStyle', attrs: { highlight: 'yellow' } }] }, { text: ' plain' }], marks: [] });
  } finally {
    ed.destroy();
  }
});

test('Clear Formatting clears a field result\'s runs, and unlink keeps what is left', () => {
  const ed = editorWith();
  try {
    ed.chain().clearFormatting().run();
    const node = fieldOf(ed);
    assert.deepEqual(shape(node), { runs: null, marks: [] });
    assert.ok(ed.state.selection instanceof NodeSelection, 'the field stays selected');
    const out = unlinkNodes(node, 3, new Map(), ed.schema);
    assert.deepEqual(out.map((n) => [n.text, n.marks.length]), [['plain italic plain', 0]]);
  } finally {
    ed.destroy();
  }
});

test('Ctrl+I twice on a mixed field ends with no italic, in one undo step per press, and undo of the first leaves the runs', () => {
  const ed = editorWith();
  try {
    ed.commands.toggleItalic();
    assert.deepEqual(fieldOf(ed).marks.map((m) => m.type.name), ['italic'], 'the first press makes the whole field italic');
    assert.deepEqual(fieldOf(ed).attrs.runs, RUNS);
    ed.commands.toggleItalic();
    assert.deepEqual(shape(fieldOf(ed)), { runs: [{ text: 'plain ' }, { text: 'italic', marks: [RED] }, { text: ' plain' }], marks: [] }, 'no italic is left');
    ed.commands.undo();
    assert.deepEqual(shape(fieldOf(ed)), { runs: RUNS, marks: [{ type: 'italic' }] }, 'one undo brings the italic field and its runs back');
    ed.commands.undo();
    assert.deepEqual(shape(fieldOf(ed)), { runs: RUNS, marks: [] }, 'undoing the first press keeps the italic word');
    ed.commands.redo();
    ed.commands.redo();
    assert.deepEqual(fieldOf(ed).attrs.runs[1].marks, [RED], 'redo brings the stripped runs back');
  } finally {
    ed.destroy();
  }
});

test('a textStyle replaced by setMark strips nothing; a key taken off the whole field leaves every run', () => {
  const ed = editorWith([{ type: 'textStyle', attrs: { size: 14 } }]);
  try {
    ed.commands.setMark('textStyle', { color: '#0000FF' });
    assert.deepEqual(fieldOf(ed).attrs.runs, RUNS, 'a new colour over the field leaves the runs as they were');
    ed.chain().setMark('textStyle', { color: null }).removeEmptyTextStyle().run();
    // The field's own size goes into every run, and stays the node's as what they share.
    const size = { type: 'textStyle', attrs: { size: 14 } };
    const lit = { type: 'textStyle', attrs: { highlight: 'yellow', size: 14 } };
    assert.deepEqual(shape(fieldOf(ed)), { runs: [{ text: 'plain ', marks: [size] }, { text: 'italic', marks: [{ type: 'italic' }, lit] }, { text: ' plain', marks: [size] }],
      marks: [size] }, 'the colour taken off the field leaves the red word too');
    // A node mark step (tr.removeNodeMark) reaches the runs as removeMark does.
    ed.commands.setMark('italic');
    ed.view.dispatch(ed.state.tr.removeNodeMark(3, ed.schema.marks.italic));
    assert.deepEqual(fieldOf(ed).attrs.runs, [{ text: 'plain ', marks: [size] }, { text: 'italic', marks: [lit] }, { text: ' plain', marks: [size] }]);
  } finally {
    ed.destroy();
  }
});

test('rejecting a tracked italic or colour on a mixed field puts its marks back and keeps the runs', () => {
  const fmt = (old) => ({ type: 'formatChange', attrs: { id: '1', author: 'A', date: null, old } });
  for (const [marks, old] of [[[{ type: 'italic' }], []], [[{ type: 'textStyle', attrs: { color: '#0000FF' } }], []]]) {
    const ed = editorWith([...marks, fmt(old)]);
    try {
      ed.view.dispatch(resolveTr(ed.state, 'reject'));
      assert.deepEqual(shape(fieldOf(ed)), { runs: RUNS, marks: [] }, `reject of ${marks[0].type} leaves the red italic word`);
    } finally {
      ed.destroy();
    }
  }
});
