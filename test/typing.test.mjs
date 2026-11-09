// document/typing.mjs typing(): which transactions count as typing, whose re-renders wait for a pause (plan.md section 6 risk 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { typing } from '../src/document/typing.mjs';

const schema = new Schema({
  nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*' }, text: {} },
  marks: { bold: {} },
});
const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('one two')]), schema.node('paragraph', null, [schema.text('three')])]);
const tr = () => EditorState.create({ doc }).tr;

test('typing: text typed or deleted inside a paragraph, not marks, blocks or a selection move', () => {
  assert.equal(typing(tr().insertText('x', 2)), true);
  assert.equal(typing(tr().delete(2, 4)), true);
  assert.equal(typing(tr().insertText('y', 2, 5)), true);
  assert.equal(typing(tr().addMark(1, 4, schema.marks.bold.create())), false);
  assert.equal(typing(tr().split(3)), false);
  assert.equal(typing(tr().delete(6, 11)), false); // joins the two paragraphs
  assert.equal(typing(tr()), false);
  assert.equal(typing(tr().addMark(1, 4, schema.marks.bold.create()), true), true); // borders: marks count with `marks`
  assert.equal(typing(tr().split(3), true), false);
});
