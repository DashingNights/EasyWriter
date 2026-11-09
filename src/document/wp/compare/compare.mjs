// Compare and Combine (docs/plans/word plan.md §3 compare): the pure half. prepare() makes two Documents' blocks equal where they
// differ only in what the Compare Documents dialog's unchecked settings leave out, so the converter (suggest/core.mjs convert)
// records no change there. The result title counts up per session. Pure: Node tests load it.
import { isCanvas, unreadable } from '../../../engine/model/form.mjs';
import { strip } from '../../../suggest/core.mjs';

/** The Comparison settings of Word's dialog, in its order (probe/dialogs/compare-documents.json), all checked by default.
 * Insertions and deletions is always on, so it is not a setting here. */
export const SETTINGS = [
  ['moves', 'Mo&ves'], ['comments', 'Comme&nts'], ['formatting', '&Formatting'], ['caseChanges', 'Case chan&ges'], ['whiteSpace', 'White s&pace'],
  ['tables', 'T&ables'], ['headersFooters', '&Headers and footers'], ['notes', 'Footnotes an&d endnotes'], ['textboxes', 'Te&xtboxes'], ['fields', 'Field&s'],
];
/** The dialog's defaults: every setting on, Word level, the result in a new document. */
export const DEFAULTS = { ...Object.fromEntries(SETTINGS.map(([k]) => [k, true])), level: 'word', where: 'new' };

// Marks that are content to Compare: revision marks keep their authors (Combine) and comments have their own setting.
const REVISION = new Set(['insertion', 'deletion', 'formatChange']);
const TEXTBLOCKS = new Set(['paragraph', 'heading']);
const TABLE = new Set(['table', 'tableRow', 'tableCell', 'tableHeader']);

const sameMarks = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Block JSON `json` with what the unchecked settings in `o` leave out removed, so two blocks that differ only there come out equal. */
export function normal(json, o) {
  if (!json || typeof json !== 'object') return json;
  const n = { ...json };
  let attrs = n.attrs ? { ...n.attrs } : null;
  if (attrs) delete attrs.suggest;
  if (n.marks) {
    n.marks = n.marks.filter((m) => (m.type === 'comment' ? o.comments : o.formatting || REVISION.has(m.type)));
    if (!n.marks.length) delete n.marks;
  }
  if (attrs && !o.formatting && TEXTBLOCKS.has(n.type)) attrs = null;
  if (attrs && !o.tables && TABLE.has(n.type)) attrs = null;
  if (attrs && !o.fields && n.type === 'field') attrs = { ...attrs, result: null, dirty: false };
  if (attrs && !o.notes && n.type === 'noteRef') attrs = { ...attrs, content: null };
  if (attrs?.sect && !o.headersFooters && n.type === 'sectionBreak') attrs = { ...attrs, sect: { ...attrs.sect, hdr: null, ftr: null } };
  if (attrs) n.attrs = attrs;
  else delete n.attrs;
  if (!o.textboxes && n.type === 'textBox') n.content = [];
  if (Array.isArray(n.content)) {
    // Children first, then text runs that now carry the same marks join, so "Plain **words**" and "Plain words" compare as one run.
    const kids = [];
    for (const c of n.content.map((c) => normal(c, o))) {
      const last = kids.at(-1);
      if (c.type === 'text' && last?.type === 'text' && sameMarks(last.marks, c.marks)) kids[kids.length - 1] = { ...last, text: last.text + c.text };
      else kids.push(c);
    }
    n.content = kids.map((c) => (c.type === 'text' ? { ...c, text: textOf(c.text, o) } : c));
  }
  return n;
}

const textOf = (s, o) => {
  let t = s;
  if (!o.whiteSpace) t = t.replace(/\s+/g, ' ');
  if (!o.caseChanges) t = t.toLowerCase();
  return t;
};

// For each block of `list`, whether it has no identical block left in `other` (a multiset match, so two equal blocks need two).
function unmatched(list, other) {
  const left = new Map();
  for (const x of other) left.set(JSON.stringify(x), (left.get(JSON.stringify(x)) ?? 0) + 1);
  return list.map((x) => {
    const s = JSON.stringify(x);
    const n = left.get(s) ?? 0;
    if (n) left.set(s, n - 1);
    return !n;
  });
}

/** Two Documents' JSON (`original`, `revised`) prepared for the converter under settings `opts` (DEFAULTS' keys) → {original,
 * revised}: both without suggestion records, and each original block that differs from a revised block only in what an unchecked
 * setting leaves out replaced by that revised block, so no record appears there. Moves and the level change nothing: the converter
 * has no move detection and shows word-level places (recorded deviations). */
export function prepare(original, revised, opts = DEFAULTS) {
  const o = { ...DEFAULTS, ...opts };
  const a = strip(original);
  const b = strip(revised);
  const A = a.content ?? [];
  const B = b.content ?? [];
  const key = (x) => JSON.stringify(normal(x, o));
  // The blocks that already have an identical partner on the other side keep it (a multiset match); the rest pair by key.
  const freeA = unmatched(A, B);
  const freeB = unmatched(B, A);
  const pool = B.filter((_, i) => freeB[i]).map((x) => ({ x, k: key(x), used: false }));
  const content = A.map((x, i) => {
    if (!freeA[i]) return x;
    const k = key(x);
    const hit = pool.find((p) => !p.used && p.k === k);
    if (!hit) return x;
    hit.used = true;
    return hit.x;
  });
  let attrs = a.attrs;
  if (!o.headersFooters && attrs?.sect && b.attrs?.sect) attrs = { ...attrs, sect: { ...attrs.sect, hdr: b.attrs.sect.hdr ?? null, ftr: b.attrs.sect.ftr ?? null } };
  return { original: { ...a, ...(attrs && { attrs }), content }, revised: b };
}

/** The engine's `review.compare` params for the dialog's settings `opts` (DEFAULTS' keys), changes labelled `author`. The engine
 * always compares tables and honours the rest (engine-gaps-rest: engine/crates/doc-edit/src/cmd/tools/compare_parts.rs). */
export function engineArgs(author, opts = DEFAULTS) {
  const o = { ...DEFAULTS, ...opts };
  return { author, caseChanges: !!o.caseChanges, whiteSpace: !!o.whiteSpace, formatting: !!o.formatting, level: o.level === 'char' ? 'character' : 'word',
    moves: !!o.moves, comments: !!o.comments, headersFooters: !!o.headersFooters, footnotes: !!o.notes, textBoxes: !!o.textboxes, fields: !!o.fields };
}

const counts = { compare: 0, combine: 0 };
/** The next result title of `kind` ('compare' or 'combine') this session: 'Compare Result 1', 'Compare Result 2'... Combine's name
 * follows Compare's pattern (unverified in Word). */
export function resultTitle(kind) {
  counts[kind] = (counts[kind] ?? 0) + 1;
  return `${kind === 'combine' ? 'Combine' : 'Compare'} Result ${counts[kind]}`;
}

/** Why draft `draft` cannot be compared under a Document `version` → a message, or null when it can: it must be a Document no newer
 * than this build reads, with its doc, or a canvas record whose engine form this build reads (form.mjs unreadable). */
export function refusal(draft, version) {
  if (!draft || (!draft.doc && !isCanvas(draft))) return 'That draft could not be loaded.';
  if ((draft.format ?? null) !== 'document') return `"${draft.title || 'Untitled'}" is not a Document, so it cannot be compared.`;
  if ((draft.formatVersion ?? 1) > version) return 'That draft was saved by a newer EasyWriter. Update EasyWriter to compare it.';
  const why = isCanvas(draft) ? unreadable(draft.engine) : null;
  return why ? `"${draft.title || 'Untitled'}" cannot be compared: ${why}.` : null;
}
