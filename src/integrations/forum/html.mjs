// The forum post's HTML (docs/plans/engine/stage3-forum.md A4): a post document as the post kit's editor writes it
// (generateHTML(doc, forumExtensions(50)), SPEC.md section 1). Pure: node --test loads it. renderPost replaces generateHTML
// when the post moves to the engine (D2), so it must write the same markup tag for tag.

// A browser escapes &, <, > and the no-break space in text, and &, " and the no-break space in an attribute value.
const NBSP = String.fromCharCode(0xa0);
const text = (s) => String(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;')).replaceAll(NBSP, '&nbsp;');
const value = (s) => String(s).replace(/[&"<>]/g, (c) => (c === '&' ? '&amp;' : c === '"' ? '&quot;' : c === '<' ? '&lt;' : '&gt;')).replaceAll(NBSP, '&nbsp;');

// Attributes in the DOM editor's order; null and undefined write nothing (renderSpec skips them). An empty string writes `name=""`.
const attrs = (pairs) => pairs.filter(([, v]) => v != null).map(([k, v]) => ` ${k}="${value(v)}"`).join('');

/** The post kit's schema defaults (src/extensions.js), which a node's attrs carry even when its JSON leaves them out. */
export const NODE_DEFAULTS = {
  paragraph: { textAlign: null },
  heading: { level: 1, textAlign: null },
  orderedList: { start: 1, type: null },
  tableCell: { colspan: 1, rowspan: 1, colwidth: null, align: null },
  tableHeader: { colspan: 1, rowspan: 1, colwidth: null, align: null },
  canvas: { w: 800, h: 450, dw: 800, frame: null, bg: 'post', items: [], flow: null, source: null },
  planChart: { id: null, planId: null, view: 'kanban', options: {}, frozen: null, dw: null },
  media: { src: null, name: 'media', dw: null },
};

/** The same for marks; a mark's other attrs (a link's target and rel) are the editor's, not the document's. */
export const MARK_DEFAULTS = {
  link: { href: null },
  fontSize: { size: null },
  textColor: { color: null },
  highlight: { color: 'yellow' },
  fontFamily: { font: null },
};

// A mark's nesting, outermost first: the DOM editor's schema rank (extension priority, then forumExtensions order).
export const MARK_ORDER = ['link', 'bold', 'code', 'italic', 'strike', 'underline', 'subscript', 'superscript', 'fontSize', 'textColor', 'highlight', 'fontFamily'];
const RANK = new Map(MARK_ORDER.map((name, i) => [name, i]));
const SIMPLE_MARKS = { bold: 'strong', italic: 'em', underline: 'u', strike: 's', subscript: 'sub', superscript: 'sup', code: 'code' };

const ALIGNMENTS = ['left', 'center', 'right', 'justify'];
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6]; // a level outside these is written h1, as the kit's heading extension clamps it
const CELL_MIN = 20; // the post kit's Table cellMinWidth (src/extensions.js MIN_COLUMN)

// A link's protocols, as @tiptap/extension-link's isAllowedUri reads them; whitespace is stripped before the test.
const PROTOCOLS = ['http', 'https', 'ftp', 'ftps', 'mailto', 'tel', 'callto', 'sms', 'cid', 'xmpp'];
const ALLOWED_URI = new RegExp(`^(?:(?:${PROTOCOLS.join('|')}):|[^a-z]|[a-z0-9+.-]+(?:[^a-z+.:-]|$))`, 'i');
const WHITESPACE = /\p{White_Space}/gu;

const align = (a) => (ALIGNMENTS.includes(a) ? `text-align: ${a};` : null);

function mark(m, inner) {
  const a = m.attrs ?? {};
  switch (m.type) {
    case 'link': {
      const href = a.href == null || a.href === '' || ALLOWED_URI.test(String(a.href).replace(WHITESPACE, '')) ? a.href : '';
      return `<a${attrs([['target', '_blank'], ['rel', 'noopener noreferrer nofollow'], ['href', href]])}>${inner}</a>`;
    }
    case 'fontSize':
      return `<span${attrs([['data-ips-font-size', a.size]])}>${inner}</span>`;
    case 'textColor':
      return `<span${attrs([['data-i-color', a.color]])}>${inner}</span>`;
    case 'highlight':
      return `<mark${attrs([['data-i-background-color', a.color ?? 'yellow']])}>${inner}</mark>`;
    case 'fontFamily':
      return `<span${attrs([['style', a.font ? `font-family: ${a.font.includes(' ') ? `"${a.font}"` : a.font};` : null]])}>${inner}</span>`;
    default:
      return SIMPLE_MARKS[m.type] ? `<${SIMPLE_MARKS[m.type]}>${inner}</${SIMPLE_MARKS[m.type]}>` : inner;
  }
}

function inline(node) {
  if (node.type === 'hardBreak') return '<br>';
  const marks = [...(node.marks ?? [])].sort((x, y) => (RANK.get(x.type) ?? MARK_ORDER.length) - (RANK.get(y.type) ?? MARK_ORDER.length));
  let html = text(node.text ?? '');
  for (let i = marks.length - 1; i >= 0; i--) html = mark(marks[i], html);
  return html;
}

const children = (node) => (node.content ?? []).map((c) => (c.type === 'text' || c.type === 'hardBreak' ? inline(c) : blocks(c))).join('');

// A paragraph or heading with its alignment style, when the alignment is one the editor takes.
const blockTag = (tag, node) => `<${tag}${attrs([['style', align(node.attrs?.textAlign)]])}>${children(node)}</${tag}>`;

const span = (n) => (n === 1 || n === '1' || n == null ? null : n); // the editor omits colspan and rowspan of 1

function cell(tag, node) {
  const a = { ...NODE_DEFAULTS[tag], ...node.attrs };
  return `<${tag}${attrs([
    ['colspan', span(a.colspan)],
    ['rowspan', span(a.rowspan)],
    ['colwidth', a.colwidth],
    ['style', align(a.align)],
  ])}>${children(node)}</${tag}>`;
}

// <table style="width: Npx;"> with a <col> per column of the first row (the forum lays a table out fixed at these widths).
function table(node) {
  const rows = node.content ?? [];
  if (!rows.length) return '<table></table>';
  const cols = [];
  let total = 0;
  let fixed = true;
  for (const c of rows[0].content ?? []) {
    const { colspan = 1, colwidth } = c.attrs ?? {};
    for (let j = 0; j < colspan; j++) {
      const w = colwidth?.[j];
      if (w) total += w; else fixed = false;
      cols.push(`<col${attrs([['style', w ? `width: ${Math.max(w, CELL_MIN)}px;` : `min-width: ${CELL_MIN}px;`]])}>`);
    }
  }
  const style = fixed ? `width: ${total}px;` : `min-width: ${total}px;`;
  const body = rows.map((r) => `<tr>${(r.content ?? []).map((c) => cell(c.type === 'tableHeader' ? 'th' : 'td', c)).join('')}</tr>`).join('');
  return `<table${attrs([['style', style]])}><colgroup>${cols.join('')}</colgroup><tbody>${body}</tbody></table>`;
}

function media(node) {
  const a = { ...NODE_DEFAULTS.media, ...node.attrs };
  // A forum import's placeholder keeps its URL only, never an <img> that would load it (Media.renderHTML).
  if (!String(a.src ?? '').startsWith('data:')) return `<div${attrs([['data-media', ''], ['data-name', a.name], ['data-dw', a.dw], ['data-src', a.src]])}></div>`;
  const style = a.dw ? `width: ${a.dw}px;` : null;
  const el = String(a.src).startsWith('data:video/')
    ? `<video${attrs([['src', a.src], ['controls', ''], ['preload', 'metadata'], ['style', style]])}></video>`
    : `<img${attrs([['src', a.src], ['alt', a.name], ['style', style]])}>`;
  return `<div${attrs([['data-media', ''], ['data-name', a.name], ['data-dw', a.dw]])}>${el}</div>`;
}

// A canvas, plan chart or media object's attributes as the editor keeps them: the schema's keys in their order with the
// schema's defaults, so a hint (nw, nh, ch), `shown` or a suggestion's record never reaches the forum.
function objectJSON(node, defaults) {
  const a = node.attrs ?? {};
  return JSON.stringify(Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, k in a ? a[k] : v])));
}

function blocks(node) {
  const a = node.attrs ?? {};
  switch (node.type) {
    case 'paragraph': return blockTag('p', node);
    case 'heading': return blockTag(`h${HEADING_LEVELS.includes(a.level) ? a.level : 1}`, node);
    case 'blockquote': return `<blockquote>${children(node)}</blockquote>`;
    case 'codeBlock': return `<pre><code${attrs([['class', a.language ? `language-${a.language}` : null]])}>${children(node)}</code></pre>`;
    case 'horizontalRule': return '<hr>';
    case 'bulletList': return `<ul>${children(node)}</ul>`;
    case 'orderedList': return `<ol${attrs([['start', a.start === 1 || a.start == null ? null : a.start], ['type', a.type && a.type !== '1' ? a.type : null]])}>${children(node)}</ol>`;
    case 'listItem': return `<li>${children(node)}</li>`;
    case 'table': return table(node);
    case 'box': return `<div class="ipsRichTextBox ipsRichTextBox--alwaysopen">${children(node)}</div>`;
    case 'boxTitle': return `<div class="ipsRichTextBox__title"><p>${children(node)}</p></div>`;
    case 'boxContent': return `<i-richtext-box-content class="ipsRichText">${children(node)}</i-richtext-box-content>`;
    case 'canvas': return `<div${attrs([['data-canvas', ''], ['data-json', objectJSON(node, NODE_DEFAULTS.canvas)]])}></div>`;
    case 'planChart': return `<div${attrs([['data-plan-chart', ''], ['data-json', objectJSON(node, NODE_DEFAULTS.planChart)]])}></div>`;
    case 'media': return media(node);
    default: return children(node);
  }
}

/** `doc` (the post's JSON) as the forum's HTML, as generateHTML(doc, forumExtensions(50)) writes it. */
export function renderPost(doc) {
  return (doc?.content ?? []).map((node) => (node.type === 'text' || node.type === 'hardBreak' ? inline(node) : blocks(node))).join('');
}
