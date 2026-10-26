// The forum post import's pure half (docs/plans/onboarding.md Forum import): a post's HTML as forum.posts returns it (Invision
// Community 4 or 5 markup, its pictures and videos marked data-ew-media by inject.js postsScript) → a forum post draft's TipTap
// JSON. It keeps what the forum post kit holds (src/extensions.js and format.mjs: the push path's HTML read backwards) and turns
// other markup into plain paragraphs. A picture or video becomes a media node whose src is still the forum's https URL: the
// placeholder that the download queue (forum/actions.js) swaps for the file. No DOM: a small HTML reader, so node --test runs it.
import { cleanTitle, draftTitle } from '../../doc-utils.mjs';
import { FONT_SIZES, FONTS, HIGHLIGHTS, TEXT_COLORS } from '../../format.mjs';

// ---------------------------------------------------------------------------------------------
// HTML → a tree of {tag, attrs, children} and strings. Enough for the forum's sanitised post HTML, not for any page.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// Opening one of these closes an open <p> (the HTML rule a forum's stored HTML can lean on).
const CLOSES_P = new Set(['p', 'div', 'ul', 'ol', 'table', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'details', 'figure', 'section']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', times: '×', bull: '•' };

const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});

/** `html` → the root {tag: '#root', attrs: {}, children}. */
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const src = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  const re = /<\/([a-z][\w:-]*)\s*>|<([a-z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|<![^>]*>|([^<]+|<)/gi;
  let m;
  while ((m = re.exec(src))) {
    const [, close, open, rest, text] = m;
    if (text !== undefined) top().children.push(decode(text));
    else if (close) {
      const tag = close.toLowerCase();
      const at = stack.findLastIndex((e) => e.tag === tag);
      if (at > 0) stack.length = at; // a stray close tag is ignored
    } else if (open) {
      const tag = open.toLowerCase();
      if (CLOSES_P.has(tag) && top().tag === 'p') stack.pop();
      if (tag === 'li' && top().tag === 'li') stack.pop();
      const attrs = {};
      for (const a of (rest ?? '').matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      const el = { tag, attrs, children: [] };
      top().children.push(el);
      if (!VOID.has(tag) && !/\/\s*>$/.test(m[0])) stack.push(el);
    }
  }
  return root;
}

const textOf = (n) => (typeof n === 'string' ? n : n.tag === 'br' ? '\n' : n.children.map(textOf).join(''));
const classes = (el) => (el.attrs.class ?? '').split(/\s+/);
const hasClass = (el, c) => classes(el).includes(c);
const find = (el, test) => {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (test(c)) return c;
    const hit = find(c, test);
    if (hit) return hit;
  }
  return null;
};

/** A style attribute → {property: value}, lower-case names. */
const styleOf = (el) => Object.fromEntries((el.attrs.style ?? '').split(';').map((d) => d.split(':')).filter((p) => p.length >= 2)
  .map(([k, ...v]) => [k.trim().toLowerCase(), v.join(':').trim()]));

// ---------------------------------------------------------------------------------------------
// The kit's values from Invision 4's free CSS (Invision 5 writes the kit's own attributes)

// The hues of the forum's named colours (SPEC §1 Forum facts), for Invision 4's hex colours.
const HUES = { red: 0, orange: 30, yellow: 50, green: 100, blue: 210, indigo: 260, violet: 300 };

function rgbOf(value) {
  const v = String(value).trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  return m ? m.slice(1, 4).map(Number) : null;
}

/** A CSS colour → the nearest named colour of the forum, 'soft' for a mid grey, or null (black, white, unreadable). */
function namedColour(value, { grey = true } = {}) {
  const rgb = rgbOf(value);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((x) => x / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  if (s < 0.2 || l < 0.1 || l > 0.95) return grey && l > 0.3 && l < 0.85 ? 'soft' : null;
  const d = max - min;
  const hue = (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  const h = (hue + 360) % 360;
  const gap = (x) => Math.min(Math.abs(h - x), 360 - Math.abs(h - x));
  return Object.keys(HUES).reduce((best, k) => (gap(HUES[k]) < gap(HUES[best]) ? k : best));
}

/** A CSS font size → the nearest kit size other than 100, or null. Invision 4 posts are 14px. */
function kitSize(value) {
  const m = /^([\d.]+)\s*(px|pt|em|rem|%)?$/.exec(String(value).trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  const pct = m[2] === '%' ? n : m[2] === 'em' || m[2] === 'rem' ? n * 100 : m[2] === 'pt' ? (n * 4) / 3 / 0.14 : n / 0.14;
  const best = FONT_SIZES.reduce((a, b) => (Math.abs(b - pct) < Math.abs(a - pct) ? b : a));
  return best === 100 ? null : String(best);
}

const kitFont = (value) => {
  const key = String(value).split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
  return FONTS.find((f) => f.css.toLowerCase() === key || f.label.toLowerCase() === key)?.css ?? null;
};

// ---------------------------------------------------------------------------------------------
// Tree → TipTap JSON

const withMark = (marks, mark) => [...marks.filter((m) => m.type !== mark.type), mark];
const ALIGN = new Set(['center', 'right', 'justify']);
const alignOf = (el) => {
  const a = (styleOf(el)['text-align'] ?? el.attrs.align ?? '').toLowerCase();
  return el.tag === 'center' ? 'center' : ALIGN.has(a) ? a : null;
};
const SAFE_HREF = /^(https?:|mailto:)/i;

/** The marks an inline element adds to `marks`. */
function markup(el, marks) {
  const add = (type, attrs) => { marks = withMark(marks, attrs ? { type, attrs } : { type }); };
  switch (el.tag) {
    case 'strong': case 'b': add('bold'); break;
    case 'em': case 'i': add('italic'); break;
    case 'u': case 'ins': add('underline'); break;
    case 's': case 'strike': case 'del': add('strike'); break;
    case 'sub': add('subscript'); break;
    case 'sup': add('superscript'); break;
    case 'code': case 'kbd': case 'samp': add('code'); break;
    case 'a': if (SAFE_HREF.test(el.attrs.href ?? '')) add('link', { href: el.attrs.href }); break;
    case 'mark': add('highlight', { color: HIGHLIGHTS.includes(el.attrs['data-i-background-color']) ? el.attrs['data-i-background-color'] : 'yellow' }); break;
    default: break;
  }
  const size = el.attrs['data-ips-font-size'];
  if (FONT_SIZES.map(String).includes(size) && size !== '100') add('fontSize', { size });
  const colour = el.attrs['data-i-color'];
  if (colour && colour !== 'root' && Object.hasOwn(TEXT_COLORS, colour)) add('textColor', { color: colour });
  const css = styleOf(el);
  const c = (css.color && namedColour(css.color)) || (el.attrs.color && namedColour(el.attrs.color));
  if (c && !colour) add('textColor', { color: c });
  const bg = css['background-color'] || css.background;
  const h = bg && el.tag !== 'mark' && namedColour(bg, { grey: false });
  if (h) add('highlight', { color: h });
  const s = css['font-size'] && kitSize(css['font-size']);
  if (s && !size) add('fontSize', { size: s });
  const f = css['font-family'] && kitFont(css['font-family']);
  if (f) add('fontFamily', { font: f });
  if (/^(bold|[6-9]00)$/.test(css['font-weight'] ?? '')) add('bold');
  if (css['font-style'] === 'italic') add('italic');
  if (/underline/.test(css['text-decoration'] ?? '')) add('underline');
  if (/line-through/.test(css['text-decoration'] ?? '')) add('strike');
  return marks;
}

// Block containers with no node of their own: their blocks join the parent's, their loose text becomes paragraphs.
const CONTAINERS = new Set(['div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'figure', 'figcaption', 'center',
  'address', 'dl', 'dt', 'dd', 'li', 'tbody', 'thead', 'tfoot', 'i-richtext-box-content', 'form', 'fieldset']);
const LISTS = { ul: 'bulletList', ol: 'orderedList' };

const fileName = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'media';
  } catch {
    return 'media';
  }
};

/**
 * Walks `nodes`, pushing into `out` inline items ({type: 'text' | 'hardBreak'}) and finished blocks. `marks`: the marks the
 * inline items carry; `ctx`: {media, pre (inside a code block)}.
 */
function walk(nodes, marks, out, ctx) {
  for (const n of nodes) {
    if (typeof n === 'string') {
      const text = n.replace(/[\t\n\r ]+/g, ' ');
      if (text) out.push({ type: 'text', text, marks });
      continue;
    }
    const block = toBlock(n, marks, ctx);
    if (block !== undefined) out.push(...block);
    else walk(n.children, markup(n, marks), out, ctx);
  }
}

/** Element `el` as blocks, or undefined for an inline element (walk descends into it). */
function toBlock(el, marks, ctx) {
  const { tag, attrs } = el;
  if (attrs['data-ew-media'] !== undefined) {
    const m = ctx.media[Number(attrs['data-ew-media'])];
    if (!m?.src?.startsWith('https://')) return []; // only an https file can be downloaded later
    return [{ type: 'media', attrs: { src: m.src, name: (m.alt || fileName(m.src)).slice(0, 200), dw: null } }];
  }
  if (tag === 'br') return [{ type: 'hardBreak' }];
  if (tag === 'img') return attrs.alt ? [{ type: 'text', text: attrs.alt, marks }] : []; // an emoticon, or a picture inject.js did not keep
  if (tag === 'iframe' || tag === 'embed' || tag === 'object' || tag === 'video' || tag === 'audio') {
    const url = attrs['data-embed-src'] || attrs.src || attrs.data || '';
    return SAFE_HREF.test(url) ? [para([{ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }])] : [];
  }
  if (/^h[1-6]$/.test(tag)) return runs(el, marks, ctx, (content) => ({ type: 'heading', attrs: { level: Number(tag[1]), ...align(el) }, content }));
  if (tag === 'p') return runs(el, marks, ctx, (content) => ({ type: 'paragraph', ...(alignOf(el) && { attrs: align(el) }), content }));
  if (tag === 'hr') return [{ type: 'horizontalRule' }];
  if (tag === 'pre') {
    const text = textOf(el).replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const lang = attrs['data-language'] || /(?:^|\s)lang(?:uage)?-([\w+#-]+)/.exec(attrs.class ?? '')?.[1] || /(?:^|\s)lang(?:uage)?-([\w+#-]+)/.exec(find(el, (c) => c.tag === 'code')?.attrs.class ?? '')?.[1] || null;
    return [{ type: 'codeBlock', attrs: { language: lang }, ...(text && { content: [{ type: 'text', text }] }) }];
  }
  if (LISTS[tag]) {
    // A list item starts with a paragraph (the kit's listItem is 'paragraph block*'): an empty one before a picture, list or heading.
    const item = (content) => ({ type: 'listItem', content: content[0].type === 'paragraph' ? content : [para([]), ...content] });
    const items = el.children.filter((c) => typeof c !== 'string' || c.trim()).map((c) => item(blocks(typeof c === 'string' ? [c] : c.tag === 'li' ? c.children : [c], marks, ctx)));
    if (!items.length) return [];
    const start = Number(attrs.start);
    return [{ type: LISTS[tag], ...(tag === 'ol' && start > 1 && { attrs: { start } }), content: items }];
  }
  if (tag === 'table') return table(el, marks, ctx);
  // Invision's boxes and spoilers, and a <details>: the kit's titled box.
  if (hasClass(el, 'ipsRichTextBox') || hasClass(el, 'ipsSpoiler') || attrs['data-ipsspoiler'] !== undefined || tag === 'details') {
    const head = find(el, (c) => c.tag === 'summary' || hasClass(c, 'ipsRichTextBox__title') || hasClass(c, 'ipsSpoiler_header'));
    const body = find(el, (c) => c.tag === 'i-richtext-box-content' || hasClass(c, 'ipsSpoiler_contents'));
    const rest = body ? body.children : el.children.filter((c) => c !== head);
    let title = head ? inline((find(head, (c) => c.tag === 'p') ?? head).children, [], ctx) : []; // the kit's title is its first <p>
    if (!title.length && tag !== 'details' && !hasClass(el, 'ipsRichTextBox')) title = [{ type: 'text', text: 'Spoiler' }];
    return [{ type: 'box', content: [
      { type: 'boxTitle', ...(title.length && { content: title }) },
      { type: 'boxContent', content: blocks(rest, [], ctx) },
    ] }];
  }
  if (tag === 'blockquote') return [{ type: 'blockquote', content: blocks(el.children, marks, ctx) }];
  if (CONTAINERS.has(tag)) {
    const a = alignOf(el);
    return blocks(el.children, markup(el, marks), ctx, a ? { textAlign: a } : null);
  }
  return undefined;
}

const align = (el) => (alignOf(el) ? { textAlign: alignOf(el) } : {});
const para = (content, attrs) => ({ type: 'paragraph', ...(attrs && { attrs }), ...(content.length && { content }) });

/** The kit's text nodes from walk's inline items: whitespace collapsed across items and trimmed at both ends; code drops the
 * other marks (it excludes them). */
function textNodes(items) {
  const out = [];
  for (const it of items) {
    if (it.type === 'hardBreak') {
      if (out.length && out[out.length - 1].type === 'text') out[out.length - 1].text = out[out.length - 1].text.replace(/ +$/, '');
      out.push({ type: 'hardBreak' });
      continue;
    }
    let text = it.text;
    const prev = out[out.length - 1];
    if (!prev || prev.type === 'hardBreak' || prev.text.endsWith(' ')) text = text.replace(/^ +/, '');
    if (!text) continue;
    const marks = it.marks.some((m) => m.type === 'code') ? [{ type: 'code' }] : it.marks;
    const node = { type: 'text', text, ...(marks.length && { marks }) };
    if (prev?.type === 'text' && JSON.stringify(prev.marks ?? []) === JSON.stringify(node.marks ?? [])) prev.text += text;
    else out.push(node);
  }
  while (out.length && out[out.length - 1].type === 'hardBreak') out.pop();
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/ +$/, '');
  return out.filter((n) => n.type !== 'text' || n.text);
}

const inline = (nodes, marks, ctx) => {
  const items = [];
  walk(nodes, marks, items, ctx);
  return textNodes(items.filter((i) => i.type === 'text' || i.type === 'hardBreak'));
};

/** Walks `el`'s children; each run of inline items becomes `wrap(content)`, the blocks inside (a picture in a paragraph) stay
 * between them. */
function runs(el, marks, ctx, wrap) {
  const items = [];
  walk(el.children, markup(el, marks), items, ctx);
  const out = [];
  let run = [];
  const flush = () => {
    const content = textNodes(run);
    if (content.length) out.push(wrap(content));
    run = [];
  };
  for (const it of items) {
    if (it.type === 'text' || it.type === 'hardBreak') run.push(it);
    else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}

/** `nodes` as blocks (at least an empty paragraph): loose inline items become paragraphs with `attrs`. */
function blocks(nodes, marks, ctx, attrs = null) {
  const out = runs({ tag: '#', attrs: {}, children: nodes }, marks, ctx, (content) => para(content, attrs));
  return out.length ? out : [para([])];
}

function table(el, marks, ctx) {
  const rows = [];
  const collect = (n) => {
    for (const c of n.children) {
      if (typeof c === 'string') continue;
      if (c.tag === 'tr') rows.push(c);
      else if (['thead', 'tbody', 'tfoot'].includes(c.tag)) collect(c);
    }
  };
  collect(el);
  const cols = [];
  for (const g of el.children.filter((c) => typeof c !== 'string' && c.tag === 'colgroup')) {
    for (const col of g.children.filter((c) => typeof c !== 'string' && c.tag === 'col')) cols.push(parseInt(styleOf(col).width ?? col.attrs.width, 10) || null);
  }
  const content = rows.map((tr) => {
    let at = 0;
    const cells = tr.children.filter((c) => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th')).map((c) => {
      const colspan = Math.max(1, parseInt(c.attrs.colspan, 10) || 1);
      const rowspan = Math.max(1, parseInt(c.attrs.rowspan, 10) || 1);
      const own = (c.attrs.colwidth ?? '').split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0);
      const styled = parseInt(styleOf(c).width, 10);
      let colwidth = own.length === colspan ? own : colspan === 1 && styled > 0 && /px$/.test(styleOf(c).width) ? [styled] : null;
      if (!colwidth && cols.length) {
        const w = cols.slice(at, at + colspan);
        if (w.length === colspan && w.every(Boolean)) colwidth = w;
      }
      at += colspan;
      return { type: c.tag === 'th' ? 'tableHeader' : 'tableCell', attrs: { colspan, rowspan, colwidth }, content: blocks(c.children, marks, ctx) };
    });
    return cells.length ? { type: 'tableRow', content: cells } : null;
  }).filter(Boolean);
  return content.length ? [{ type: 'table', content }] : [];
}

/** A post's HTML (and its media list, `[{kind, src, alt}]`, indexed by data-ew-media) → the forum post draft's doc JSON. */
export function postToDoc(html, media = []) {
  const content = blocks(parseHtml(html).children, [], { media });
  // Leading and trailing empty paragraphs are Invision's spacing, not the post's.
  while (content.length > 1 && content[0].type === 'paragraph' && !content[0].content) content.shift();
  while (content.length > 1 && content[content.length - 1].type === 'paragraph' && !content[content.length - 1].content) content.pop();
  return { type: 'doc', content };
}

/** A post's draft title: its first line, else "Post on <date>" from `iso` (the post's date). */
export function postTitle(doc, iso) {
  const first = draftTitle(doc);
  if (first !== 'Untitled') return cleanTitle(first);
  const d = new Date(iso ?? NaN); // null would be 1970
  return Number.isNaN(d.getTime()) ? 'Forum post' : `Post on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

/** Whether a media node is a download placeholder: its src is still the forum's https URL. */
export const isPlaceholder = (node) => node?.type === 'media' && typeof node.attrs?.src === 'string' && node.attrs.src.startsWith('https://');

/** The URLs of `doc`'s placeholders, each once, in document order. */
export function placeholderUrls(doc) {
  const urls = new Set();
  const visit = (n) => {
    if (isPlaceholder(n)) urls.add(n.attrs.src);
    for (const c of n?.content ?? []) visit(c);
  };
  visit(doc);
  return [...urls];
}

/** `doc` with every placeholder of a URL in `files` ({url: data URL}) holding that file. `doc` is not changed. */
export function fillPlaceholders(doc, files) {
  const visit = (n) => {
    if (isPlaceholder(n) && files[n.attrs.src]) return { ...n, attrs: { ...n.attrs, src: files[n.attrs.src] } };
    return n.content ? { ...n, content: n.content.map(visit) } : n;
  };
  return visit(doc);
}
