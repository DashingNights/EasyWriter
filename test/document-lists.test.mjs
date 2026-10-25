import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { MarkdownManager } from '@tiptap/markdown';
import { Marked } from 'marked';
import { DEFAULT_NUMBERING, newDocumentJson } from '../src/document/defaults.mjs';
import { kindOf, listLabels, numberNewLists } from '../src/document/numbering.mjs';
import { Lists } from '../src/document/lists.js';
import { documentExtensions } from '../src/document/schema.js';

// Flat lists (docs/plans/document.md Lists): labels per num and level from doc.attrs.numbering, and list paragraphs in Markdown.
const N = (numId, ilvl = 0) => ({ numId, ilvl });
const numbering = { ...DEFAULT_NUMBERING, nums: { ...DEFAULT_NUMBERING.nums, 3: { abstract: 'decimal' }, 4: { abstract: 'decimal', start: 5 } } };

test('numbering continues across a Normal paragraph and deeper levels restart', () => {
  // The Normal paragraph between b. and 3. holds no numbering, so it is not an item at all.
  assert.deepEqual(listLabels([N(2), N(2), N(2, 1), N(2, 1), N(2), N(2, 1)], numbering), ['1.', '2.', 'a.', 'b.', '3.', 'a.']);
});

test('the third level counts in lower roman', () => {
  assert.deepEqual(listLabels([N(2), N(2, 1), N(2, 2), N(2, 2), N(2, 2), N(2, 2)], numbering), ['1.', 'a.', 'i.', 'ii.', 'iii.', 'iv.']);
});

test('bullet glyphs cycle per level', () => {
  assert.deepEqual(listLabels([0, 1, 2, 3, 4].map((l) => N(1, l)), numbering), ['•', 'o', '▪', '•', 'o']);
  assert.equal(kindOf(numbering, 1), 'bullet');
  assert.equal(kindOf(numbering, 2), 'number');
});

test('a new num restarts, and its start value counts', () => {
  assert.deepEqual(listLabels([N(2), N(2), N(3), N(2), N(4), N(4)], numbering), ['1.', '2.', '1.', '3.', '5.', '6.']);
  assert.deepEqual(listLabels([N(9), N(2, 9)], numbering), [null, null]); // unknown num or level
});

test('Markdown lists become list paragraphs and come back as the same list', () => {
  const ext = documentExtensions(50);
  const schema = getSchema(ext);
  const md = new MarkdownManager({ marked: new Marked(), extensions: ext });
  const src = '- one\n  - two\n- three\n\n1. first\n   1. inner\n2. second';
  const json = numberNewLists({ ...newDocumentJson({}), content: md.parse(src).content }); // each list gets a num of its own
  const doc = schema.nodeFromJSON(json);
  assert.deepEqual(doc.content.content.map((b) => [b.textContent, b.attrs.numbering]),
    [['one', N(3)], ['two', N(3, 1)], ['three', N(3)], ['first', N(4)], ['inner', N(4, 1)], ['second', N(4)]]);
  assert.equal(md.serialize(json), src.replace('2. second', '1. second')); // Markdown counts
});

test('separate Markdown lists count separately', () => {
  const md = new MarkdownManager({ marked: new Marked(), extensions: documentExtensions(50) });
  const src = '## Install\n\n1. Download\n2. Run setup\n\n## Use\n\n1. Open the app\n2. Sign in';
  const json = numberNewLists({ ...newDocumentJson({}), content: md.parse(src).content });
  const items = json.content.filter((b) => b.attrs?.numbering).map((b) => b.attrs.numbering);
  assert.deepEqual(listLabels(items, json.attrs.numbering), ['1.', '2.', '1.', '2.']);
});

// A Document of paragraphs [text, numbering] (numbering on num 3 = decimal), with nums 1-3 as a new Document's first list has.
const schema = getSchema(documentExtensions(50));
const docOf = (paras) => schema.nodeFromJSON({ ...newDocumentJson({}), attrs: { ...newDocumentJson({}).attrs, numbering: { ...DEFAULT_NUMBERING,
  nums: { ...DEFAULT_NUMBERING.nums, 3: { abstract: 'decimal' } } } }, content: paras.map(([text, numbering]) => ({ type: 'paragraph',
  attrs: { numbering }, content: text ? [{ type: 'text', text }] : [] })) });
const labelsOf = (doc) => {
  const items = [];
  doc.forEach((b) => b.attrs.numbering && items.push(b));
  const labels = listLabels(items.map((b) => b.attrs.numbering), doc.attrs.numbering);
  return items.map((b, i) => `${b.textContent} ${labels[i]}`);
};
const at = (doc, text) => { let s = null; doc.descendants((n, pos) => { if (s == null && n.textContent === text) s = pos + 1; return s == null; }); return s; };

test('a Numbering library pick inside a list changes the whole list', () => {
  const doc = docOf(['one', 'two', 'three', 'four', 'five'].map((t) => [t, N(3)]));
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, at(doc, 'two')) });
  const tr = state.tr;
  Lists.config.addCommands.call({}).applyList('lowerLetter')({ state, tr, dispatch: () => {} });
  assert.deepEqual(labelsOf(state.apply(tr).doc), ['one a.', 'two b.', 'three c.', 'four d.', 'five e.']);
});

test('Tab over several paragraphs indents them and never replaces them with a tab', () => {
  const doc = docOf([['Normal', null], ['Bullet one', N(1)], ['Bullet two', N(1)]]);
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, doc.content.size - 1) });
  const ran = [];
  const editor = { get state() { return state; }, commands: {
    increaseIndent: () => ran.push('increaseIndent'), sinkListLevel: () => ran.push('sinkListLevel'),
    command: (f) => { const tr = state.tr; f({ tr }); state = state.apply(tr); return true; } } };
  Lists.config.addKeyboardShortcuts.call({ editor }).Tab();
  assert.equal(state.doc.textContent, 'NormalBullet oneBullet two');
  assert.deepEqual(ran, ['increaseIndent']);
});

test("a list pasted from another Document does not join this one's list of the same numId", () => {
  const plugins = () => Lists.config.addProseMirrorPlugins.call({})[0]; // one per editor
  const [a, b] = [plugins(), plugins()];
  const docA = docOf([['x', N(3)], ['y', N(3)]]);
  const docB = docOf([...['b1', 'b2', 'b3', 'b4'].map((t) => [t, N(3)]), ['Gap', null], ['', null]]);
  const viewOf = (doc, from, to, draft = null) => ({ state: EditorState.create({ doc, selection: TextSelection.create(doc, from, to) }),
    dom: { getAttribute: () => draft }, dragging: null });
  const stateB = EditorState.create({ doc: docB, plugins: [b], selection: TextSelection.create(docB, docB.content.size - 1) });
  const copy = (plugin, view) => {
    plugin.props.handleDOMEvents.copy(view); // the copy event, then ProseMirror's serialisation
    return plugin.props.transformCopied(view.state.selection.content(), view);
  };
  const paste = (plugin, slice, draft = null) => labelsOf(stateB.applyTransaction(stateB.tr.replaceSelection(
    plugin.props.transformPasted(slice, { state: stateB, dom: { getAttribute: () => draft }, dragging: null }))).state.doc);
  const fromA = copy(a, viewOf(docA, at(docA, 'x'), at(docA, 'y') + 1));
  // A drag in B serialises B's slice too, but the clipboard still holds A's copy.
  const inB = viewOf(docB, at(docB, 'b1'), at(docB, 'b1') + 1);
  b.props.transformCopied(inB.state.selection.content(), inB);
  assert.deepEqual(paste(b, fromA), ['b1 1.', 'b2 2.', 'b3 3.', 'b4 4.', 'x 1.', 'y 2.']);
  // A copy inside one Document stays in its list, also after the Document is opened again (a new editor on the same draft).
  const fromB = copy(b, viewOf(docB, at(docB, 'b1'), at(docB, 'b2') + 2, 'draft-b'));
  assert.deepEqual(paste(plugins(), fromB, 'draft-b'), ['b1 1.', 'b2 2.', 'b3 3.', 'b4 4.', 'b1 5.', 'b2 6.']);
});

test('a Numbering library pick on a nested item changes that level of the list', () => {
  const doc = docOf([['One', N(3)], ['Sub', N(3, 1)], ['Two', N(3)], ['Other', N(1)]]);
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, at(doc, 'Sub')) });
  const tr = state.tr;
  Lists.config.addCommands.call({}).applyList('upperRoman')({ state, tr, dispatch: () => {} });
  const after = state.apply(tr).doc;
  assert.deepEqual(labelsOf(after), ['One 1.', 'Sub I.', 'Two 2.', 'Other •']);
  // Then the first level as well: the list's levels are no library definition, so it keeps one of its own.
  const top = EditorState.create({ doc: after, selection: TextSelection.create(after, at(after, 'One')) });
  const tr2 = top.tr;
  Lists.config.addCommands.call({}).applyList('lowerLetter')({ state: top, tr: tr2, dispatch: () => {} });
  const last = top.apply(tr2).doc;
  assert.deepEqual(labelsOf(last), ['One a.', 'Sub I.', 'Two b.', 'Other •']);
  assert.match(last.attrs.numbering.nums[3].abstract, /^custom/);
});
