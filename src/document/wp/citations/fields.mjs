// CITATION and BIBLIOGRAPHY (docs/plans/word/plan.md §1.10, briefs/citations.md): what they compute from the draft's sources and
// style, which the field context gives through the 'citations' provider ({sources, style}). Pure, so node tests load it.
import { textJson, wordBibliography, wordCitation, wordLabels, numbered } from '../../../references.mjs';

export const EMPTY_TEXT = 'There are no sources in the current document.';
/** The paragraph style of bibliography entries (ensureStyles adds it on first use). */
export const BIBLIOGRAPHY_STYLE = { Bibliography: { type: 'paragraph', name: 'Bibliography', basedOn: 'Normal', next: 'Normal' } };

const unquote = (t) => t.replace(/^"(.*)"$/, '$1');
/** A CITATION field's parts (ParsedField `f`): tags (the first, then each \m tag), lcid (\l), pages (\p), volume (\v), prefix (\f),
 * suffix (\s), noAuthor (\n), noTitle (\t), noYear (\y). \m is read from the code because it may repeat. */
export function parseCitation(f) {
  const more = [...String(f.code ?? '').matchAll(/\\m\s+("[^"]*"|\S+)/gi)].map((m) => unquote(m[1]));
  const sw = f.sw ?? {};
  const text = (k) => (typeof sw[k] === 'string' ? sw[k] : '');
  return {
    tags: [f.args?.[0] ?? '', ...more].filter(Boolean), lcid: text('l'), pages: text('p'), volume: text('v'), prefix: text('f'), suffix: text('s'),
    noAuthor: !!sw.n, noTitle: !!sw.t, noYear: !!sw.y,
  };
}

/** A CITATION code for `c` (parseCitation's shape): Word's order, the tag first and \l 1033 when no language is given. */
export function citationCode(c) {
  const q = (t) => (/\s/.test(t) ? `"${t}"` : t);
  return [`CITATION ${q(c.tags[0])}`, `\\l ${c.lcid || '1033'}`, ...c.tags.slice(1).map((t) => `\\m ${q(t)}`), c.pages && `\\p ${q(c.pages)}`,
    c.volume && `\\v ${q(c.volume)}`, c.prefix && `\\f ${q(c.prefix)}`, c.suffix && `\\s ${q(c.suffix)}`, c.noAuthor && '\\n', c.noTitle && '\\t',
    c.noYear && '\\y'].filter(Boolean).join(' ');
}

const CITATION_RE = /^\s*CITATION\s+("[^"]*"|\S+)(.*)$/i;
/** The tags `doc` cites, in document order (each field's first tag, then its \m tags). */
export function citedTags(doc) {
  const out = [];
  doc.descendants((n) => {
    if (n.type.name !== 'field') return true;
    const m = CITATION_RE.exec(n.attrs.code ?? '');
    if (m) out.push(unquote(m[1]), ...[...m[2].matchAll(/\\m\s+("[^"]*"|\S+)/gi)].map((x) => unquote(x[1])));
    return false;
  });
  return out;
}

/** The text of CITATION `c` in `doc` for `env` ({sources, style}): numbered styles number by first citation in `doc`. */
export function citationText(c, doc, { sources = [], style = 'harvard' } = {}) {
  const lab = wordLabels(sources, style, numbered(style) ? citedTags(doc) : []);
  const items = c.tags.map((tag, i) => {
    const s = sources.find((x) => x.tag === tag) ?? null;
    return { s, label: s ? lab.get(s.id) ?? '' : '', ...(i === 0 && { pages: c.pages, volume: c.volume, noAuthor: c.noAuthor, noTitle: c.noTitle, noYear: c.noYear }) };
  });
  return items.length ? wordCitation(items, style, c) : 'Invalid source specified.';
}

/** The blocks of a BIBLIOGRAPHY for `env`: one Bibliography paragraph per source of the current list, or Word's line for none. */
export function bibliographyBlocks(doc, { sources = [], style = 'harvard' } = {}) {
  const list = wordBibliography(sources, style, numbered(style) ? citedTags(doc) : []);
  const para = (content) => ({ type: 'paragraph', attrs: { styleId: 'Bibliography' }, content });
  return list.length ? list.map((rs) => para(textJson(rs))) : [para([{ type: 'text', text: EMPTY_TEXT }])];
}

const env = (ctx) => ctx.get?.('citations') ?? {};
/** The field types (§1.10 FieldType), by name. */
export const FIELDS = {
  CITATION: {
    category: 'All', updates: 'manual', bare: 'nty',
    compute: (f, ctx) => citationText(parseCitation(f), ctx.doc, env(ctx)),
  },
  BIBLIOGRAPHY: {
    category: 'All', updates: 'manual', block: true,
    compute: (f, ctx) => ({ blocks: bibliographyBlocks(ctx.doc, env(ctx)) }),
  },
};
