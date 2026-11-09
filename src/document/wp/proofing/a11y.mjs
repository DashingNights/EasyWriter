// The Accessibility pane's rules (docs/plans/word briefs/proofing.md). Our own rules after Word's checker: missing alternative text,
// missing table header, hard-to-read contrast, unclear link text, a skipped heading level, repeated blank characters and objects
// that are not inline. Pure; it reads ProseMirror nodes and their JSON alike and gives each issue its document position.
import { HIGHLIGHTS } from '../../../office.mjs';

const typeOf = (n) => n?.type?.name ?? n?.type;
const kidsOf = (n) => n?.content?.content ?? (Array.isArray(n?.content) ? n.content : []);
const markOf = (n, name) => (n?.marks ?? []).find((m) => (m.type?.name ?? m.type) === name) ?? null;
// A JSON node's size the way ProseMirror counts it (an empty JSON block reads as a leaf, which only shifts positions in tests).
const sizeOf = (n) => n?.nodeSize ?? (typeof n?.text === 'string' ? n.text.length : Array.isArray(n?.content) ? 2 + n.content.reduce((s, k) => s + sizeOf(k), 0) : 1);
const textOf = (n) => (typeof n?.text === 'string' ? n.text : kidsOf(n).map(textOf).join(''));

/** The relative luminance of '#RRGGBB' `hex` (WCAG 2). */
function luminance(hex) {
  const h = String(hex).replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of colours `a` and `b` ('#RRGGBB'), two decimals → 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

const HEX = /^#[0-9a-f]{6}$/i;
const fillOf = (shading) => (shading && HEX.test(shading.fill ?? '') ? shading.fill : null);
const VAGUE = new Set(['here', 'click here', 'link', 'this link', 'more', 'read more', 'click', 'this']);

/** The rules by id → {kind: 'error'|'warning'|'tip', title}. Titles are the pane's group headings. */
export const RULES = {
  altText: { kind: 'error', title: 'Missing alternative text' },
  tableHeader: { kind: 'error', title: 'Missing table header' },
  contrast: { kind: 'warning', title: 'Hard-to-read text contrast' },
  linkText: { kind: 'warning', title: 'Unclear link text' },
  notInline: { kind: 'warning', title: 'Object not inline' },
  headingLevel: { kind: 'tip', title: 'Skipped heading level' },
  blanks: { kind: 'tip', title: 'Repeated blank characters' },
};

/** The accessibility issues of document `doc` → [{rule, kind, title, label, from, to, node?}] in document order. from and to are
 * document positions: the object's (node issues) or the text's (text issues). */
export function issuesOf(doc) {
  const out = [];
  const add = (rule, label, from, to) => out.push({ rule, kind: RULES[rule].kind, title: RULES[rule].title, label, from, to });
  const page = HEX.test(doc?.attrs?.background?.color ?? '') ? doc.attrs.background.color : '#FFFFFF';
  let lastLevel = 0;
  let empties = 0;

  // Text runs of textblock `n` at content start `start` with the background under them `bg`.
  const runs = (n, start, bg) => {
    let pos = start;
    let link = null; // the link run being gathered: {href, text, from, to}
    const flush = () => {
      if (!link) return;
      const t = link.text.trim();
      if (VAGUE.has(t.toLowerCase()) || t === link.href || /^(https?:\/\/|www\.)\S+$/i.test(t)) add('linkText', t, link.from, link.to);
      link = null;
    };
    for (const k of kidsOf(n)) {
      const size = sizeOf(k);
      if (typeof k.text === 'string') {
        const style = markOf(k, 'textStyle')?.attrs ?? {};
        const hl = markOf(k, 'highlight')?.attrs?.color ?? style.highlight;
        const under = HIGHLIGHTS[hl] ?? fillOf(style.shading) ?? bg;
        if (HEX.test(style.color ?? '') && k.text.trim()) {
          const big = (style.size ?? 11) >= 18 || ((style.size ?? 11) >= 14 && !!markOf(k, 'bold'));
          const ratio = contrast(style.color, under);
          if (ratio < (big ? 3 : 4.5)) add('contrast', `${k.text.trim().slice(0, 40)} (${ratio}:1)`, pos, pos + size);
        }
        if (/ {3,}/.test(k.text)) add('blanks', 'Several spaces in a row', pos, pos + size);
        const href = markOf(k, 'link')?.attrs?.href;
        if (href && link?.href === href && link.to === pos) {
          link.text += k.text;
          link.to = pos + size;
        } else {
          flush();
          if (href) link = { href, text: k.text, from: pos, to: pos + size };
        }
      } else {
        flush();
        visit(k, pos, bg);
      }
      pos += size;
    }
    flush();
  };

  // Node `n` at position `pos` (before it; the doc itself at -1) with background `bg`.
  function visit(n, pos, bg) {
    const t = typeOf(n);
    const a = n.attrs ?? {};
    const size = sizeOf(n);
    if (t === 'image') {
      if (!String(a.alt ?? '').trim() && !a.decorative) add('altText', a.name || 'Picture', pos, pos + size);
      if (a.layout && a.layout.wrap !== 'inline') add('notInline', a.name || 'Picture', pos, pos + size);
      return;
    }
    if (t === 'textBox' && (!a.layout || a.layout.wrap !== 'inline')) add('notInline', a.name || 'Text box', pos, pos + size);
    if (t === 'table') {
      const first = kidsOf(n)[0];
      if (first && !kidsOf(first).some((c) => typeOf(c) === 'tableHeader')) add('tableHeader', 'Table', pos, pos + size);
    }
    if (t === 'heading') {
      const level = Number(a.level) || 1;
      if (lastLevel && level > lastLevel + 1) add('headingLevel', `${textOf(n).slice(0, 40) || 'Heading'} (level ${level} after ${lastLevel})`, pos, pos + size);
      lastLevel = level;
    }
    const isBlock = t === 'paragraph' || t === 'heading';
    if (isBlock) {
      // Three or more empty paragraphs in a row: flagged once, at the third.
      if (!textOf(n).trim() && !kidsOf(n).some((k) => typeof k.text !== 'string')) {
        if (++empties === 3) add('blanks', 'Several empty paragraphs in a row', pos, pos + size);
      } else empties = 0;
    }
    // Paragraph shading is {fill, ...}; a table cell's is a plain hex (schema.js cell Shading).
    const shade = fillOf(a.shading) ?? (typeof a.shading === 'string' && HEX.test(a.shading) ? a.shading : null);
    const under = shade ?? bg;
    const start = pos + 1;
    if (n.isTextblock ?? isBlock) runs(n, start, under);
    else {
      let p = start;
      for (const k of kidsOf(n)) {
        visit(k, p, under);
        p += sizeOf(k);
      }
    }
  }

  visit(doc, -1, page);
  return out;
}

/** The counts of `issues` by kind → {error, warning, tip}. */
export function tally(issues) {
  const c = { error: 0, warning: 0, tip: 0 };
  for (const i of issues) c[i.kind]++;
  return c;
}
