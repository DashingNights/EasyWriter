import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateHTML } from '@tiptap/core';
import { forumExtensions } from '../src/extensions.js';
import { renderPost } from '../src/integrations/forum/html.mjs';
import { normal } from '../src/integrations/forum/normal.mjs';

// renderPost writes the markup generateHTML(doc, forumExtensions(50)) writes (SPEC.md section 1), so it is checked against
// it on every fixture. generateHTML needs a document; node has none, so this is the part of one its serializer uses.
import './mini-dom.mjs';

const kit = (doc) => generateHTML(doc, forumExtensions(50));
const p = (...content) => ({ type: 'paragraph', content });
const t = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });

const DIR = new URL('./fixtures/posts/', import.meta.url);
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  test(`a post fixture writes as the post kit writes it: ${file}`, () => {
    const doc = JSON.parse(fs.readFileSync(new URL(file, DIR), 'utf8'));
    assert.equal(renderPost(doc), kit(doc));
  });
}

// SPEC section 1's forms, written out from the spec rather than from a run.

test('SPEC: the mark forms', () => {
  const doc = { type: 'doc', content: [p(
    t('bold', [{ type: 'bold' }]), t(' '), t('italic', [{ type: 'italic' }]), t(' '), t('underline', [{ type: 'underline' }]),
    t(' '), t('strike', [{ type: 'strike' }]), t(' '), t('sub', [{ type: 'subscript' }]), t(' '),
    t('super', [{ type: 'superscript' }]), t(' '), t('code', [{ type: 'code' }]),
  )] };
  assert.equal(renderPost(doc), '<p><strong>bold</strong> <em>italic</em> <u>underline</u> <s>strike</s> <sub>sub</sub> <sup>super</sup> <code>code</code></p>');
});

test('SPEC: sizes, colours, highlights and fonts', () => {
  const doc = { type: 'doc', content: [
    p(t('small', [{ type: 'fontSize', attrs: { size: '80' } }]), t(' '), t('huge', [{ type: 'fontSize', attrs: { size: '200' } }])),
    p(t('faint', [{ type: 'textColor', attrs: { color: 'soft' } }]), t(' '), t('marked', [{ type: 'highlight', attrs: { color: 'green' } }])),
    p(t('Georgia', [{ type: 'fontFamily', attrs: { font: 'Georgia' } }]), t(' '), t('Times', [{ type: 'fontFamily', attrs: { font: 'Times New Roman' } }])),
  ] };
  assert.equal(renderPost(doc), '<p><span data-ips-font-size="80">small</span> <span data-ips-font-size="200">huge</span></p>'
    + '<p><span data-i-color="soft">faint</span> <mark data-i-background-color="green">marked</mark></p>'
    + '<p><span style="font-family: Georgia;">Georgia</span> <span style="font-family: &quot;Times New Roman&quot;;">Times</span></p>');
});

test('SPEC: a link keeps the forum attributes, a hard break is <br>', () => {
  const doc = { type: 'doc', content: [
    p(t('mail', [{ type: 'link', attrs: { href: 'mailto:help@example.com' } }])),
    p(t('one'), { type: 'hardBreak' }, t('two')),
  ] };
  assert.equal(renderPost(doc), '<p><a target="_blank" rel="noopener noreferrer nofollow" href="mailto:help@example.com">mail</a></p><p>one<br>two</p>');
});

test('SPEC: headings carry their alignment; quotes, code, rules and lists', () => {
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [t('Centred')] },
    { type: 'blockquote', content: [p(t('Quoted'))] },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [t('let a = 1;')] },
    { type: 'codeBlock', content: [t('plain')] },
    { type: 'horizontalRule' },
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p(t('three'))] }] },
  ] };
  assert.equal(renderPost(doc), '<h2 style="text-align: center;">Centred</h2><blockquote><p>Quoted</p></blockquote>'
    + '<pre><code class="language-js">let a = 1;</code></pre><pre><code>plain</code></pre><hr>'
    + '<ol start="3"><li><p>three</p></li></ol>');
});

test('SPEC: a table carries its column widths, header cells and a colspan', () => {
  const cell = (type, colwidth, ...content) => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth }, content });
  const doc = { type: 'doc', content: [{
    type: 'table',
    content: [
      { type: 'tableRow', content: [cell('tableHeader', [100], p(t('H'))), cell('tableHeader', [200], p(t('H2')))] },
      { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2, rowspan: 1, colwidth: null }, content: [p(t('Both'))] }] },
    ],
  }] };
  assert.equal(renderPost(doc), '<table style="width: 300px;"><colgroup><col style="width: 100px;"><col style="width: 200px;"></colgroup>'
    + '<tbody><tr><th colwidth="100"><p>H</p></th><th colwidth="200"><p>H2</p></th></tr>'
    + '<tr><td colspan="2"><p>Both</p></td></tr></tbody></table>');
});

test('SPEC: the titled box', () => {
  const doc = { type: 'doc', content: [{
    type: 'box',
    content: [
      { type: 'boxTitle', content: [t('Title')] },
      { type: 'boxContent', content: [p(t('Body'))] },
    ],
  }] };
  assert.equal(renderPost(doc), '<div class="ipsRichTextBox ipsRichTextBox--alwaysopen"><div class="ipsRichTextBox__title"><p>Title</p></div>'
    + '<i-richtext-box-content class="ipsRichText"><p>Body</p></i-richtext-box-content></div>');
});

test('SPEC: markup characters in a value are escaped, in a link and in an object\'s attributes', () => {
  const doc = { type: 'doc', content: [
    p(t('A link', [{ type: 'link', attrs: { href: 'https://a.test/?q=a<b>c' } }])),
    { type: 'canvas', attrs: { w: 200, h: 80, dw: 200, frame: null, bg: 'post', items: [{ label: 'a < b > c' }], flow: null, source: null } },
  ] };
  assert.equal(renderPost(doc), '<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://a.test/?q=a&lt;b&gt;c">A link</a></p>'
    + '<div data-canvas="" data-json="{&quot;w&quot;:200,&quot;h&quot;:80,&quot;dw&quot;:200,&quot;frame&quot;:null,'
    + '&quot;bg&quot;:&quot;post&quot;,&quot;items&quot;:[{&quot;label&quot;:&quot;a &lt; b &gt; c&quot;}],&quot;flow&quot;:null,&quot;source&quot;:null}"></div>');
});

test('a heading level the kit does not have is written as h1, as the kit clamps it', () => {
  assert.equal(renderPost({ type: 'doc', content: [{ type: 'heading', attrs: { level: 7 }, content: [t('Seven')] }] }), '<h1>Seven</h1>');
});

test('renderPost drops the editor\'s own records: a hint, shown and a suggestion', () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', attrs: { suggest: { ins: { id: 's1' } } }, content: [t('Line')] },
    { type: 'canvas', attrs: { w: 400, h: 100, dw: 400, frame: null, bg: 'post', items: [], flow: null, source: null, shown: 400, nw: 400, nh: 100 } },
  ] };
  assert.equal(renderPost(doc), '<p>Line</p><div data-canvas="" data-json="{&quot;w&quot;:400,&quot;h&quot;:100,&quot;dw&quot;:400,&quot;frame&quot;:null,'
    + '&quot;bg&quot;:&quot;post&quot;,&quot;items&quot;:[],&quot;flow&quot;:null,&quot;source&quot;:null}"></div>');
});

// normal: the comparison form checkPost uses (C1).

test('normal merges text runs and sorts marks into the editor\'s nesting order', () => {
  const doc = { type: 'doc', content: [p(
    t('a', [{ type: 'italic' }, { type: 'bold' }]),
    t('b', [{ type: 'bold' }, { type: 'italic' }]),
  )] };
  assert.deepEqual(normal(doc), { type: 'doc', content: [p({ type: 'text', text: 'ab', marks: [{ type: 'bold' }, { type: 'italic' }] })] });
});

test('normal keeps only a link\'s href, and drops a mark attr at its default', () => {
  const doc = { type: 'doc', content: [p(
    t('x', [{ type: 'link', attrs: { href: 'https://a.test', target: '_blank', rel: 'noopener', class: null } }]),
    t('y', [{ type: 'highlight', attrs: { color: 'yellow' } }]),
    t('z', [{ type: 'fontSize', attrs: { size: '125' } }]),
  )] };
  assert.deepEqual(normal(doc).content[0].content, [
    { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'https://a.test' } }] },
    { type: 'text', text: 'y', marks: [{ type: 'highlight' }] },
    { type: 'text', text: 'z', marks: [{ type: 'fontSize', attrs: { size: '125' } }] },
  ]);
});

test('normal drops default attrs, a null colwidth, shown, the hints and suggest', () => {
  const doc = { type: 'doc', content: [
    p(t('plain')),
    { type: 'paragraph', attrs: { textAlign: 'left' }, content: [t('left')] },
    { type: 'canvas', attrs: { w: 400, h: 100, dw: 400, frame: null, bg: 'post', items: [], flow: null, source: null, shown: 380, nw: 400, nh: 100, suggest: { ins: { id: 's' } } } },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: [] }, content: [p(t('cell'))] }] }] },
  ] };
  assert.deepEqual(normal(doc).content, [
    p(t('plain')),
    { type: 'paragraph', attrs: { textAlign: 'left' }, content: [t('left')] },
    { type: 'canvas', attrs: { w: 400, h: 100, dw: 400 } },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('cell'))] }] }] },
  ]);
});

test('normal drops an empty paragraph left after a container, and keeps one after a paragraph', () => {
  const container = { type: 'blockquote', content: [p(t('quoted'))] };
  const doc = { type: 'doc', content: [p(t('before')), container, p()] };
  assert.deepEqual(normal(doc).content, [p(t('before')), container]);
  const plain = { type: 'doc', content: [p(t('one')), p()] };
  assert.deepEqual(normal(plain), plain);
});

test('normal is its own fixed point', () => {
  const doc = JSON.parse(fs.readFileSync(new URL('suggestions.json', DIR), 'utf8'));
  assert.deepEqual(normal(normal(doc)), normal(doc));
});
