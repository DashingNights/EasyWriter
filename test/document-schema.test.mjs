import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor, getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { Marked } from 'marked';
import { documentExtensions } from '../src/document/schema.js';
import { newDocumentJson } from '../src/document/defaults.mjs';

// Document schema v1 (docs/plans/document.md Version guard): ProseMirror drops unknown attributes and TipTap blanks a doc with an
// unknown node, so a build that reads an older or newer Document must agree on these names. The list may grow during Phase 1;
// after 1.3.0 a change here needs the format's version bumped (formats.mjs DOCUMENT).
const PINNED = {
  nodes: {
    doc: ['numbering', 'sect', 'styles', 'theme'],
    paragraph: ['indent', 'numbering', 'spacing', 'styleId', 'textAlign'],
    heading: ['indent', 'level', 'numbering', 'spacing', 'styleId', 'textAlign'],
    text: [],
    hardBreak: [],
    table: ['styleId'],
    tableRow: [],
    tableHeader: ['align', 'colspan', 'colwidth', 'rowspan', 'shading', 'vAlign'],
    tableCell: ['align', 'colspan', 'colwidth', 'rowspan', 'shading', 'vAlign'],
    pageBreak: [],
    image: ['alt', 'height', 'src', 'title', 'width'],
  },
  marks: {
    bold: [], italic: [], strike: [], subscript: [], superscript: [],
    underline: ['val'],
    link: ['class', 'href', 'rel', 'target', 'title'],
    textStyle: ['color', 'font', 'highlight', 'size', 'themeColor'],
  },
};

const schema = getSchema(documentExtensions(50));
const names = (types) => Object.fromEntries(Object.entries(types).map(([n, t]) => [n, Object.keys(t.spec.attrs ?? {}).sort()]));

test('the Document schema holds exactly the pinned nodes, marks and attributes', () => {
  assert.deepEqual(names(schema.nodes), PINNED.nodes);
  assert.deepEqual(names(schema.marks), PINNED.marks);
});

test('a doc using every attribute survives fromJSON and toJSON', () => {
  const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
  const doc = {
    ...newDocumentJson({ paper: 'letter' }),
    content: [
      { type: 'heading', attrs: { level: 1, textAlign: 'center', styleId: null, spacing: { before: 12, after: 6, line: { rule: 'exact', value: 14 } }, indent: null, numbering: null }, content: [t('Report')] },
      { type: 'paragraph', attrs: { textAlign: 'justify', styleId: 'Quote', spacing: { line: { rule: 'auto', value: 1.5 } }, indent: { left: 36, firstLine: -18 }, numbering: { numId: 2, ilvl: 1 } }, content: [
        t('Run', [{ type: 'textStyle', attrs: { font: '+major', size: 14, color: '#0F4761', themeColor: { slot: 'accent1', lum: -0.25 }, highlight: 'yellow' } }]),
        t('under', [{ type: 'underline', attrs: { val: 'wave' } }, { type: 'bold' }, { type: 'italic' }, { type: 'strike' }]),
        t('2', [{ type: 'superscript' }]),
        t('link', [{ type: 'link', attrs: { href: 'https://a.test', target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: null } }]),
        { type: 'hardBreak' },
        t('x', [{ type: 'subscript' }]),
        { type: 'image', attrs: { src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'A chart', title: null, width: 320, height: 180 } },
      ] },
      { type: 'pageBreak' },
      { type: 'table', attrs: { styleId: 'TableGrid' }, content: [{ type: 'tableRow', content: [
        { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: [120], align: null, shading: '#E8E8E8', vAlign: 'center' }, content: [{ type: 'paragraph', content: [t('H')] }] },
        { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null, shading: null, vAlign: 'bottom' }, content: [{ type: 'paragraph', content: [t('C')] }] },
      ] }] },
    ],
  };
  const node = schema.nodeFromJSON(doc);
  node.check();
  const back = JSON.parse(JSON.stringify(node.toJSON())); // as the draft file holds it
  assert.deepEqual(back.attrs, doc.attrs);
  assert.deepEqual(back.content[0].attrs, doc.content[0].attrs);
  assert.deepEqual(back.content[1].attrs, doc.content[1].attrs);
  assert.deepEqual(back.content[1].content[0].marks, doc.content[1].content[0].marks);
  assert.deepEqual(back.content[1].content[1].marks.find((m) => m.type === 'underline'), { type: 'underline', attrs: { val: 'wave' } });
  assert.deepEqual(back.content[1].content.at(-1), doc.content[1].content.at(-1));
  assert.deepEqual(back.content[2], { type: 'pageBreak' });
  assert.deepEqual(back.content[3].attrs, doc.content[3].attrs);
  assert.deepEqual(back.content[3].content[0].content.map((c) => c.attrs), doc.content[3].content[0].content.map((c) => c.attrs));
  assert.equal(back.attrs.sect.w, 612);
});

test('sub- and superscript exclude each other (w:vertAlign holds one)', () => {
  const sub = schema.marks.subscript.create();
  assert.deepEqual(schema.marks.superscript.create().addToSet([sub]).map((m) => m.type.name), ['superscript']);
});

test('markdown code comes in as plain text', () => {
  const md = new MarkdownManager({ marked: new Marked(), extensions: documentExtensions(50) });
  const doc = schema.nodeFromJSON(md.parse('use `a<b` here\n\n```js\nx < 1\n\ny\n```\n'));
  assert.deepEqual(doc.content.content.map((b) => [b.type.name, b.textContent]),
    [['paragraph', 'use a<b here'], ['paragraph', 'x < 1'], ['paragraph', ''], ['paragraph', 'y']]);
});

test('markdown pictures keep only data URLs', () => {
  const md = new MarkdownManager({ marked: new Marked(), extensions: documentExtensions(50) });
  const doc = schema.nodeFromJSON(md.parse('a ![x](https://x.test/y.png) ![](picture) ![d](data:image/png;base64,AA==)\n'));
  const inline = doc.firstChild.content.content.map((n) => (n.isText ? n.text : `${n.type.name}:${n.attrs.src}:${n.attrs.alt}`));
  assert.deepEqual(inline, ['a x  ', 'image:data:image/png;base64,AA==:d']);
});

// A headless editor on the Document's extensions holding `content` (paragraph JSON), the caret or selection at `sel`.
const editorOn = (content, sel) => {
  const ed = new Editor({ extensions: documentExtensions(50), content: { ...newDocumentJson({ paper: 'a4' }), content } });
  ed.commands.setTextSelection(sel);
  return ed;
};

test("heading keys and setHeading apply Word's Heading style: a Title or Quote paragraph loses its styleId", () => {
  const ed = editorOn([{ type: 'paragraph', attrs: { styleId: 'Title' }, content: [{ type: 'text', text: 'Hello' }] }], 2);
  ed.chain().toggleHeading({ level: 1 }).run();
  assert.deepEqual([ed.state.doc.firstChild.type.name, ed.state.doc.firstChild.attrs.level, ed.state.doc.firstChild.attrs.styleId], ['heading', 1, null]);
  ed.chain().toggleHeading({ level: 1 }).run();
  assert.deepEqual([ed.state.doc.firstChild.type.name, ed.state.doc.firstChild.attrs.styleId], ['paragraph', null]);
  ed.chain().setStyle('Quote').setHeading({ level: 2 }).run();
  assert.deepEqual([ed.state.doc.firstChild.type.name, ed.state.doc.firstChild.attrs.level, ed.state.doc.firstChild.attrs.styleId], ['heading', 2, null]);
  ed.destroy();
});

test('Clear formatting removes run formatting and the style but keeps a hyperlink, as Word does', () => {
  const link = { type: 'link', attrs: { href: 'https://a.test' } };
  const ed = editorOn([{ type: 'paragraph', attrs: { styleId: 'Quote', textAlign: 'right' }, content: [
    { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] }, { type: 'text', text: 'link', marks: [link, { type: 'italic' }] }] }], { from: 1, to: 10 });
  ed.chain().clearFormatting().run();
  const p = ed.state.doc.firstChild;
  assert.deepEqual([p.attrs.styleId, p.attrs.textAlign], [null, null]);
  assert.deepEqual(p.content.content.map((n) => [n.text, n.marks.map((m) => m.type.name)]), [['bold ', []], ['link', ['link']]]);
  ed.destroy();
});
