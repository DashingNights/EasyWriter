// HTML into a Document (docs/plans/document.md editorAndUi Paste): a pre-pass that turns nested HTML lists and Word's mso-list
// paragraphs into flat list paragraphs (data-num, which the numbering attribute parses) and blockquotes into Quote paragraphs,
// since the Document has no list item or blockquote node. Runs on pasted HTML (lists.js transformPastedHTML) and on html
// content for a Document (commands.js toNodes). Renderer only: it parses with the DOM.
import { newListKey } from './numbering.mjs';

const MAX_LEVEL = 8;
const BLOCK = /^(P|H[1-6]|DIV)$/;
// A numbered label ends in its suffix (1. a) iv. 1.1. (a)); Word's bullet glyphs (· o §) do not.
const NUMBERED = /^\(?[\da-z]+([.)][\da-z]+)*[.)]$/i;

/** `html` with its lists flattened into paragraphs carrying data-num 'key:ilvl:abstract': each list (an HTML list with its
 * nested lists, a Word list lN) is a new list (newListKey) on 'bullet' or 'decimal', which lists.js numbers once it is in the
 * doc. A copy from a Document carries 'numId:ilvl:abstract' already (transformCopied); a bare 'numId:ilvl' (doc.get html)
 * keeps a num `numbering` (doc.attrs.numbering) has, else becomes a new numbered list. Returns `html` itself when it holds no
 * list or quote. */
export function normaliseHtml(html, numbering) {
  if (!/<(ul|ol|blockquote)\b|mso-list|data-num=/i.test(html)) return html;
  const keys = new Map(); // a source list → its key
  const num = (list, abstract, level) => {
    if (!keys.has(list)) keys.set(list, newListKey());
    return `${keys.get(list)}:${Math.min(MAX_LEVEL, level)}:${abstract}`;
  };
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const el of doc.querySelectorAll('[data-num]')) {
    const [id, level, abstract] = el.getAttribute('data-num').split(':');
    if (!abstract && !numbering.nums[id]) el.setAttribute('data-num', num(`num${id}`, 'decimal', +level || 0));
  }

  // Word: <p style="mso-list:l0 level2 lfo1"><span style="mso-list:Ignore">a.</span>Text</p>. The label goes (the decoration
  // draws it) and so do the paragraph's own indents (the list level gives them).
  for (const p of doc.querySelectorAll('p[style*="mso-list"], h1[style*="mso-list"], h2[style*="mso-list"], h3[style*="mso-list"]')) {
    const style = p.getAttribute('style');
    const m = /mso-list:\s*(l\d+)\s+level(\d)/i.exec(style);
    if (!m) continue;
    const ignore = [...p.querySelectorAll('span')].filter((s) => /mso-list:\s*Ignore/i.test(s.getAttribute('style') ?? ''));
    const glyph = (ignore[0]?.firstChild?.textContent ?? '').replace(/[\s ]/g, '');
    for (const s of ignore) s.remove();
    p.setAttribute('data-num', num(m[1], NUMBERED.test(glyph) ? 'decimal' : 'bullet', +m[2] - 1));
    p.setAttribute('style', style.replace(/(^|;)\s*(margin-left|text-indent|mso-list)\s*:[^;]*/gi, '$1'));
  }

  // HTML lists (ours from a forum post, web pages): each item's first block is a list paragraph at the list's depth.
  const flatten = (list, level, out, top = list) => {
    const abstract = list.tagName === 'OL' ? 'decimal' : 'bullet';
    for (const li of [...list.children]) {
      let first = true;
      let para = null;
      const mark = (el) => {
        if (first && !el.hasAttribute('data-num')) el.setAttribute('data-num', num(top, abstract, level));
        first = false;
      };
      for (const child of [...li.childNodes]) {
        if (child.nodeType === 1 && /^(UL|OL)$/.test(child.tagName)) {
          flatten(child, level + 1, out, top);
          para = null;
        } else if (child.nodeType === 1 && BLOCK.test(child.tagName)) {
          mark(child);
          out.push(child);
          para = null;
        } else if (child.nodeType !== 3 || child.textContent.trim() || para) {
          if (!para) {
            para = doc.createElement('p');
            mark(para);
            out.push(para);
          }
          para.append(child);
        }
      }
      if (first) {
        const empty = doc.createElement('p');
        mark(empty);
        out.push(empty);
      }
    }
  };
  for (const list of [...doc.querySelectorAll('ul, ol')].filter((l) => !l.parentElement?.closest('ul, ol'))) {
    const out = [];
    flatten(list, 0, out);
    list.replaceWith(...out);
  }

  // Quotes: the Quote style (innermost first, so a nested quote unwraps into its parent's).
  for (const bq of [...doc.querySelectorAll('blockquote')].reverse()) {
    if (![...bq.children].some((c) => BLOCK.test(c.tagName))) bq.replaceChildren(Object.assign(doc.createElement('p'), { innerHTML: bq.innerHTML }));
    for (const c of bq.children) if (c.tagName === 'P' && !c.hasAttribute('data-style')) c.setAttribute('data-style', 'Quote');
    bq.replaceWith(...bq.childNodes);
  }
  return doc.body.innerHTML;
}
