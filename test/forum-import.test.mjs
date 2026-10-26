import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { forumExtensions } from '../src/extensions.js';
import { fillPlaceholders, parseHtml, placeholderUrls, postTitle, postToDoc } from '../src/integrations/forum/import.mjs';

// The forum import's HTML → forum post doc (docs/plans/onboarding.md Forum import), on post bodies as inject.js postsScript
// returns them: Invision 5 writes the kit's own markup (SPEC §1 Forum facts), Invision 4 CKEditor's free CSS.

const t = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const p = (...content) => ({ type: 'paragraph', content });

const IC5 = `
<p>Week 3 <strong>update</strong> with <span data-ips-font-size="150">big</span> and <span data-i-color="red">red</span> text,
  <mark data-i-background-color="green">marked</mark>, <span style="font-family: &quot;Times New Roman&quot;">serif</span>
  and a <a href="https://example.com/x" rel="external nofollow">link</a>.</p>
<h2 style="text-align: center;">Centred heading</h2>
<blockquote class="ipsQuote" data-ipsquote=""><div class="ipsQuote_citation">Sam said:</div><div class="ipsQuote_contents ipsRichText"><p>Quoted words</p></div></blockquote>
<ul><li><p>One</p></li><li><p>Two <em>em</em></p></li></ul>
<ol start="3"><li><p>Three</p></li></ol>
<pre class="ipsCode" data-language="javascript"><code>const a = 1;
if (a &lt; 2) go();</code></pre>
<div class="ipsRichTextBox ipsRichTextBox--alwaysopen"><div class="ipsRichTextBox__title"><p>Box title</p></div><i-richtext-box-content class="ipsRichText"><p>Inside the box</p></i-richtext-box-content></div>
<table style="width: 300px"><colgroup><col style="width: 100px"><col style="width: 200px"></colgroup><tbody><tr><th><p>H1</p></th><th><p>H2</p></th></tr><tr><td><p>A</p></td><td><p>B</p></td></tr></tbody></table>
<p><img data-ew-media="0"></p>
<p>Text before <img data-ew-media="1"> text after<br>second line</p>
<hr>
<p>Inline <code>code()</code> here &amp; there.</p>`;
const IC5_MEDIA = [
  { kind: 'image', src: 'https://media.forum.test/monthly_2026_10/shot.png', alt: 'shot.png' },
  { kind: 'video', src: 'https://media.forum.test/monthly_2026_10/clip.mp4', alt: '' },
];

const IC4 = `<p>
	Old <span style="color:#e74c3c;">red</span> and <span style="color:#999999;">grey</span>, <span style="font-size:24px;">large</span>,
	<span style="background-color:#f1c40f;">yellow mark</span>, <span style="font-family:'Comic Sans MS', cursive;">comic</span>
	and <span style="font-family:Georgia,serif;">georgia</span>.
</p>

<p style="text-align:right;">
	Right <s>gone</s> <u>under</u> <sub>low</sub><sup>high</sup> <img alt=":)" data-emoticon="" src="https://forum.test/uploads/emoticons/smile.png">
</p>

<blockquote class="ipsQuote" data-ipsquote="" data-ipsquote-username="Sam"><div class="ipsQuote_citation">Sam said:</div><div class="ipsQuote_contents"><p>
	IC4 quote
</p></div></blockquote>

<div class="ipsSpoiler" data-ipsspoiler=""><div class="ipsSpoiler_header"><span></span></div><div class="ipsSpoiler_contents ipsClearfix"><p>Hidden part</p></div></div>

<pre class="ipsCode prettyprint lang-html prettyprinted"><span class="tag">&lt;b&gt;</span><span class="pln">bold</span><span class="tag">&lt;/b&gt;</span></pre>

<ul>
	<li>loose item</li>
	<li><strong>bold</strong> item</li>
</ul>

<table border="1" cellpadding="1" cellspacing="1" style="width:500px;"><tbody><tr><td>cell one</td><td style="width:120px;">cell two</td></tr></tbody></table>

<p><a class="ipsAttachLink" href="https://forum.test/applications/core/interface/file/attachment.php?id=9">notes.pdf</a></p>
<div><img data-ew-media="0"></div>
<iframe allowfullscreen="" data-embed-src="https://www.youtube.com/embed/abc" src="about:blank"></iframe>
<div>Loose div text</div>`;
const IC4_MEDIA = [{ kind: 'image', src: 'https://forum.test/uploads/monthly_2020_09/pic.jpg', alt: 'pic.jpg' }];

test('parseHtml: entities, void elements, an implied </p> and stray close tags', () => {
  const root = parseHtml('<p>a &amp; b&#33; &#x41;&nbsp;<br>c<div>d</div></span><img src="x">');
  assert.deepEqual(root.children.map((c) => (typeof c === 'string' ? c : c.tag)), ['p', 'div', 'img']);
  assert.equal(root.children[0].children[0], 'a & b! A ');
});

test('Invision 5: the kit markup comes back as the kit nodes and marks', () => {
  const doc = postToDoc(IC5, IC5_MEDIA);
  const [first, heading, quote, ul, ol, code, box, table, pic, before, video, after, hr, last] = doc.content;
  assert.deepEqual(first.content.slice(0, 2), [t('Week 3 '), t('update', [{ type: 'bold' }])]);
  const marked = (s) => first.content.find((n) => n.text === s)?.marks;
  assert.deepEqual(marked('big'), [{ type: 'fontSize', attrs: { size: '150' } }]);
  assert.deepEqual(marked('red'), [{ type: 'textColor', attrs: { color: 'red' } }]);
  assert.deepEqual(marked('marked'), [{ type: 'highlight', attrs: { color: 'green' } }]);
  assert.deepEqual(marked('serif'), [{ type: 'fontFamily', attrs: { font: 'Times New Roman' } }]);
  assert.deepEqual(marked('link'), [{ type: 'link', attrs: { href: 'https://example.com/x' } }]);
  assert.match(first.content.at(-1).text, /\.$/);
  assert.ok(!first.content.some((n) => /\n|  /.test(n.text)), 'whitespace collapsed');
  assert.deepEqual(heading, { type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [t('Centred heading')] });
  assert.deepEqual(quote, { type: 'blockquote', content: [p(t('Sam said:')), p(t('Quoted words'))] });
  assert.equal(ul.type, 'bulletList');
  assert.deepEqual(ul.content[1], { type: 'listItem', content: [p(t('Two '), t('em', [{ type: 'italic' }]))] });
  assert.deepEqual(ol, { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p(t('Three'))] }] });
  assert.deepEqual(code, { type: 'codeBlock', attrs: { language: 'javascript' }, content: [t('const a = 1;\nif (a < 2) go();')] });
  assert.deepEqual(box, { type: 'box', content: [{ type: 'boxTitle', content: [t('Box title')] }, { type: 'boxContent', content: [p(t('Inside the box'))] }] });
  assert.equal(table.type, 'table');
  assert.deepEqual(table.content[0].content.map((c) => [c.type, c.attrs.colwidth]), [['tableHeader', [100]], ['tableHeader', [200]]]);
  assert.deepEqual(table.content[1].content[1].content, [p(t('B'))]);
  assert.deepEqual(pic, { type: 'media', attrs: { src: IC5_MEDIA[0].src, name: 'shot.png', dw: null } });
  // A picture inside a paragraph splits it: the media node is a block.
  assert.deepEqual([before, video, after], [p(t('Text before')), { type: 'media', attrs: { src: IC5_MEDIA[1].src, name: 'clip.mp4', dw: null } },
    p(t('text after'), { type: 'hardBreak' }, t('second line'))]);
  assert.deepEqual([hr, last], [{ type: 'horizontalRule' }, p(t('Inline '), t('code()', [{ type: 'code' }]), t(' here & there.'))]);
  assert.equal(doc.content.length, 14);
});

test('Invision 4: CKEditor colours, sizes and fonts map to the kit; spoilers become boxes; loose text becomes paragraphs', () => {
  const doc = postToDoc(IC4, IC4_MEDIA);
  const [first, right, quote, spoiler, code, list, table, attach, pic, embed, loose] = doc.content;
  const marked = (block, s) => block.content.find((n) => n.text === s)?.marks;
  assert.equal(first.content[0].text, 'Old ');
  assert.deepEqual(marked(first, 'red'), [{ type: 'textColor', attrs: { color: 'red' } }]);
  assert.deepEqual(marked(first, 'grey'), [{ type: 'textColor', attrs: { color: 'soft' } }]);
  assert.deepEqual(marked(first, 'large'), [{ type: 'fontSize', attrs: { size: '175' } }]);
  assert.deepEqual(marked(first, 'yellow mark'), [{ type: 'highlight', attrs: { color: 'yellow' } }]);
  assert.equal(marked(first, 'comic'), undefined); // a font the forum does not keep
  assert.deepEqual(marked(first, 'georgia'), [{ type: 'fontFamily', attrs: { font: 'Georgia' } }]);
  assert.deepEqual(right.attrs, { textAlign: 'right' });
  assert.deepEqual(right.content.map((n) => n.marks?.[0]?.type ?? n.text), ['Right ', 'strike', ' ', 'underline', ' ', 'subscript', 'superscript', ' :)']);
  assert.deepEqual(quote.content, [p(t('Sam said:')), p(t('IC4 quote'))]);
  assert.deepEqual(spoiler, { type: 'box', content: [{ type: 'boxTitle', content: [t('Spoiler')] }, { type: 'boxContent', content: [p(t('Hidden part'))] }] });
  assert.deepEqual(code, { type: 'codeBlock', attrs: { language: 'html' }, content: [t('<b>bold</b>')] });
  assert.deepEqual(list.content.map((li) => li.content), [[p(t('loose item'))], [p(t('bold', [{ type: 'bold' }]), t(' item'))]]);
  assert.deepEqual(table.content[0].content.map((c) => [c.attrs.colwidth, c.content]), [[null, [p(t('cell one'))]], [[120], [p(t('cell two'))]]]);
  assert.equal(attach.content[0].marks[0].attrs.href, 'https://forum.test/applications/core/interface/file/attachment.php?id=9');
  assert.deepEqual(pic, { type: 'media', attrs: { src: IC4_MEDIA[0].src, name: 'pic.jpg', dw: null } });
  assert.deepEqual(embed, p(t('https://www.youtube.com/embed/abc', [{ type: 'link', attrs: { href: 'https://www.youtube.com/embed/abc' } }])));
  assert.deepEqual(loose, p(t('Loose div text')));
});

test('unknown markup and a media index without an https file: plain paragraphs, nothing invented', () => {
  const doc = postToDoc('<custom-thing>Hello <b>there</b></custom-thing><section><p>Inner</p></section><img data-ew-media="4"><script>x()</script>', []);
  assert.deepEqual(doc.content, [p(t('Hello '), t('there', [{ type: 'bold' }])), p(t('Inner'))]);
  assert.deepEqual(postToDoc('', []).content, [{ type: 'paragraph' }]);
});

test('postTitle: the first line, else "Post on <date>"', () => {
  assert.equal(postTitle(postToDoc('<p>  First   line </p><p>Second</p>'), '2026-03-04T10:00:00Z'), 'First line');
  assert.equal(postTitle(postToDoc('<p><img data-ew-media="0"></p>', [{ kind: 'image', src: 'https://m/x.png' }]), '2026-03-04T10:00:00Z'), 'Post on 4 March 2026');
  assert.equal(postTitle(postToDoc('<p><img data-ew-media="0"></p>', [{ kind: 'image', src: 'https://m/x.png' }]), null), 'Forum post', 'no date: not 1970');
});

test('every doc fits the forum kit schema, also a list item that starts with a picture, list, heading or quote', () => {
  const schema = getSchema(forumExtensions(1));
  const m = [{ kind: 'image', src: 'https://m.test/a.png', alt: 'a.png' }];
  for (const [html, media] of [[IC5, IC5_MEDIA], [IC4, IC4_MEDIA], ['<ul><li><p><img data-ew-media="0"></p></li></ul>', m], ['<ul><li><img data-ew-media="0"> caption</li></ul>', m],
    ['<ul><li><ul><li>nested</li></ul></li></ul>', m], ['<ol><li><h3>Head</h3></li></ol>', m], ['<ul><ul><li>x</li></ul></ul>', m], ['<ul><li><blockquote>q</blockquote></li></ul>', m]]) {
    assert.doesNotThrow(() => schema.nodeFromJSON(postToDoc(html, media)).check(), html.slice(0, 60));
  }
});

test('placeholders: listed once each, filled without touching the input', () => {
  const doc = postToDoc(IC5, IC5_MEDIA);
  assert.deepEqual(placeholderUrls(doc), IC5_MEDIA.map((m) => m.src));
  const filled = fillPlaceholders(doc, { [IC5_MEDIA[0].src]: 'data:image/png;base64,AAAA' });
  assert.deepEqual(placeholderUrls(filled), [IC5_MEDIA[1].src]);
  assert.deepEqual(placeholderUrls(doc).length, 2);
});
