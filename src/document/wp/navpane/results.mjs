// Search results for the Navigation pane: the text hits (findMatches, §1.18) narrowed by the options find.js does not apply yet, the
// objects the search menu finds, the Results tab's snippets and the pages that hold hits. Pure: Node tests load it.
import { commentsOf } from '../../model/review.mjs';
import { hiddenAt } from './headings.mjs';

/** The search menu's Find kinds: node type names per kind; comments come from commentsOf. */
export const KINDS = {
  graphics: { label: 'Graphics', types: ['image', 'canvas', 'planChart'] },
  tables: { label: 'Tables', types: ['table'] },
  equations: { label: 'Equations', types: ['equation'] },
  notes: { label: 'Footnotes/Endnotes', types: ['noteRef'] },
  comments: { label: 'Comments', types: [] },
};

/** The objects of search menu kind `kind` in `doc` → [{from, to, label}] in document order. */
export function objectHits(doc, kind) {
  if (kind === 'comments') return commentsOf(doc).filter((c) => c.from != null && c.to != null).map((c) => ({ from: c.from, to: c.to, label: c.text || 'Comment' }));
  const types = KINDS[kind]?.types ?? [];
  const out = [];
  doc.descendants((node, pos) => {
    if (types.includes(node.type.name)) {
      out.push({ from: pos, to: pos + node.nodeSize, label: KINDS[kind].label });
      return false;
    }
    return true;
  });
  return out;
}

const WORD = /[\p{L}\p{N}_]/u;

/** `hits` of `query` narrowed to `opts` (Match case, whole words) where findMatches ignored them, and to the text collapsed headings
 * do not hide (`hidden` ranges). Plain searches only: wildcards and the fuzzy options are find.js's to apply. */
export function narrow(doc, hits, query, opts = {}, hidden = []) {
  const plain = !opts.wildcards && !opts.soundsLike && !opts.allForms && !opts.ignorePunct && !opts.ignoreSpace;
  const char = (pos) => (pos > 0 && pos < doc.content.size ? doc.textBetween(pos, pos + 1, '\n', '\n') : '');
  return hits.filter((m) => {
    if (hiddenAt(hidden, m.from)) return false;
    if (!plain) return true;
    if (opts.matchCase && doc.textBetween(m.from, m.to, '\n', '￼') !== query) return false;
    if (opts.wholeWord && (WORD.test(char(m.from - 1)) || WORD.test(char(m.to)))) return false;
    return true;
  });
}

/** The Results tab's line for a hit at text offsets [from, to) of `text` → {before, term, after}, cut to about `room` characters each
 * side at a word boundary. */
export function snippet(text, from, to, room = 40) {
  let a = Math.max(0, from - room);
  let b = Math.min(text.length, to + room);
  const sa = text.indexOf(' ', a);
  if (a > 0 && sa >= 0 && sa < from) a = sa + 1;
  const sb = text.lastIndexOf(' ', b);
  if (b < text.length && sb >= to) b = sb;
  return { before: (a > 0 ? '...' : '') + text.slice(a, from), term: text.slice(from, to), after: text.slice(to, b) + (b < text.length ? '...' : '') };
}

/** The pages holding `hits`, sorted, through `pageOf(pos)` (geometry's) → number[]. */
export const pagesWithHits = (hits, pageOf) => [...new Set(hits.map((h) => pageOf(h.from)))].sort((x, y) => x - y);
