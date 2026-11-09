// Word's search language for Find and Replace (docs/plans/word/plan.md §3 find, §1.18): the ^ codes, Word wildcards, the search
// options and Format, run over a flat text model of a ProseMirror doc. Pure: ProseMirror nodes in, positions out.
//
// The model is one string for the whole doc with one item per character ({from, to, node, block}), so a match maps back to
// positions even across paragraphs: a textblock ends in '\r' (Word's paragraph mark), whose range runs to the start of the next
// block, so deleting a match that holds it joins the two paragraphs. A textblock whose next block sits in another container (the
// last paragraph in a table cell, the paragraph before a table) ends in Word's end-of-cell mark instead: ^p does not match it and
// its range is empty, so no match deletes across a container's edge. Leaf nodes read as Word's control characters.
import { styleIdOf } from '../../model/styles.mjs';
import { soundsAlike, sameForms } from './forms.mjs';

/** The characters leaf nodes read as (Word's codes where it has one; private use for the kinds Word folds together). */
export const CH = {
  para: '\r', cell: '\u0007', tab: '\t', line: '\u000B', page: '\f', section: '', column: '\u000E', graphic: '\u0001', foot: '\u0002',
  end: '', field: '\u0013', equation: '', nbHyphen: '‑', nbSpace: ' ', optHyphen: '­',
};

const esc = (c) => c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const escSet = (c) => c.replace(/[\\^\]\[-]/g, '\\$&'); // inside [...]
const WORD = '[\\p{L}\\p{N}_]';
const WORD_START = `(?<!${WORD})(?=${WORD})`;
const WORD_END = `(?<=${WORD})(?!${WORD})`;
const PUNCT = '\\p{P}';
const SPACE = ' \\t\\u00A0\\u2005\\u3000';
const NEVER = '(?!)';
const BREAKS = `[${CH.page}${CH.section}]`;
const NOTES = `[${CH.foot}${CH.end}]`;

/** A search error with the message the dialog shows. */
export class FindError extends Error {}

// ---------- the text model ----------

const GRAPHICS = new Set(['image', 'canvas', 'planChart']);
const hides = (display) => (display === 'original' ? 'insertion' : display === 'all' || !display ? null : 'deletion');

/** The flat text of `doc` as Find reads it → {text, items}. display: which revision text shows (plan.md §1.11); fieldCodes: a
 * field reads as one field character (^d) instead of its result. */
export function textModel(doc, { display = 'all', fieldCodes = false } = {}) {
  const hidden = hides(display);
  const chars = [];
  const items = [];
  let para = null; // the last paragraph mark, whose range ends where the next block starts
  let paraAt = 0; // its index in chars
  let paraParent = null; // the node that holds its paragraph
  const push = (c, from, to, node, block) => {
    chars.push(c);
    items.push({ from, to, node, block });
  };
  const blockStart = (at, parent) => {
    if (para && parent !== paraParent) chars[paraAt] = CH.cell; // its range stays empty
    else if (para) para.to = at;
    para = null;
  };
  const inline = (parent, start, block) => {
    parent.forEach((n, offset) => {
      const p = start + offset;
      if (hidden && n.marks.some((m) => m.type.name === hidden)) return;
      const name = n.type.name;
      if (n.isText) for (let i = 0; i < n.text.length; i++) push(n.text[i], p + i, p + i + 1, n, block);
      else if (name === 'hardBreak') push(CH.line, p, p + 1, n, block);
      else if (name === 'noteRef') push(n.attrs.kind === 'endnote' ? CH.end : CH.foot, p, p + 1, n, block);
      else if (name === 'field') {
        if (fieldCodes || n.attrs.result == null) push(CH.field, p, p + 1, n, block);
        else for (const c of n.attrs.result) push(c, p, p + 1, n, block);
      } else if (name === 'equation') push(CH.equation, p, p + 1, n, block);
      else if (name === 'ptab') push(CH.tab, p, p + 1, n, block);
      else if (GRAPHICS.has(name)) push(CH.graphic, p, p + 1, n, block);
      else if (!n.isLeaf) inline(n, p + 1, block); // sdtInline, ruby: their own text
      // bookmarks and other markers read as nothing
    });
  };
  doc.descendants((node, pos, parent) => {
    if (node.isTextblock) {
      blockStart(pos + 1, parent);
      inline(node, pos + 1, node);
      const end = pos + 1 + node.content.size;
      push(CH.para, end, end, null, node);
      para = items.at(-1);
      paraAt = chars.length - 1;
      paraParent = parent;
      return false;
    }
    if (!node.isLeaf) return true;
    blockStart(pos, parent);
    const name = node.type.name;
    const c = name === 'pageBreak' ? CH.page : name === 'sectionBreak' ? CH.section : name === 'columnBreak' ? CH.column
      : GRAPHICS.has(name) ? CH.graphic : null;
    if (c) push(c, pos, pos + node.nodeSize, node, null);
    return false;
  });
  if (para && paraParent !== doc) chars[paraAt] = CH.cell;
  return { text: chars.join(''), items };
}

// ---------- ^ codes ----------

// Letter codes: [Find what, Find what with wildcards], each a regex source or null where Word refuses the code there.
const LETTERS = {
  p: [CH.para, null], t: ['\\t', '\\t'], '?': [`[^${CH.para}${CH.cell}]`, null], '#': ['[0-9]', null], $: ['\\p{L}', null], '^': ['\\^', '\\^'],
  '%': ['§', '§'], v: ['¶', '¶'], n: [CH.column, CH.column], '+': ['—', '—'], '=': ['–', '–'], l: [CH.line, CH.line],
  m: [CH.page, BREAKS], b: [CH.section, null], k: [BREAKS, BREAKS], '~': [CH.nbHyphen, CH.nbHyphen], s: [CH.nbSpace, CH.nbSpace],
  '-': [CH.optHyphen, CH.optHyphen], w: [`[${SPACE}]+`, null], q: ['\\u2005', '\\u2005'], i: ['…', '…'], j: ['…', '…'],
  u: [NEVER, null], e: [CH.end, null], f: [CH.foot, null], g: [CH.graphic, null], d: [CH.field, null], a: [NEVER, NEVER],
  h: ['\\u200E', '\\u200E'], r: ['\\u200F', '\\u200F'], x: ['\\u200C', '\\u200C'], o: ['\\u200C', '\\u200C'], z: ['\\u200D', '\\u200D'], y: ['\\u200D', '\\u200D'],
};
// Decimal codes that name a Word control character → what it reads as here.
const DECIMAL = { 1: CH.graphic, 2: NOTES, 5: NEVER, 9: '\\t', 11: CH.line, 12: BREAKS, 13: CH.para, 14: CH.column, 19: CH.field, 21: CH.field, 30: CH.nbHyphen, 31: CH.optHyphen };
// Windows-1252's 0x80 to 0x9F, for ^0nnn.
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009Džß';

/** The code at q[i] ('^' already seen at i - 1) → {code, len} where code is the text after '^' (letters, digits or u + digits). */
function readCode(q, i) {
  if (q[i] === 'u' && /\d/.test(q[i + 1] ?? '')) return { code: q.slice(i).match(/^u\d+/)[0] };
  const d = q.slice(i).match(/^0\d{3}|^\d{1,3}/);
  return { code: d ? d[0] : q[i] ?? '' };
}

/** The character of decimal code `code` ('0169' is Windows-1252). */
function decimalChar(code) {
  const n = Number(code);
  if (code.length === 4 && code[0] === '0' && n >= 0x80 && n <= 0x9F) return CP1252[n - 0x80].replace('ß', 'Ÿ');
  return String.fromCharCode(n);
}

const invalid = (code, box = 'Find what') => new FindError(`^${code} is not a special character the ${box} box takes.`);

/** The regex source of code `code` in Find what (wild: with Use wildcards). Throws FindError when Word refuses it. */
function codeSource(code, wild) {
  if (/^u\d+$/.test(code)) {
    if (wild) throw invalid(code);
    return esc(String.fromCharCode(Number(code.slice(1))));
  }
  if (/^\d+$/.test(code)) return DECIMAL[Number(code)] ?? esc(decimalChar(code));
  const row = LETTERS[code];
  const src = row?.[wild ? 1 : 0];
  if (src == null) throw invalid(code);
  return src;
}

// ---------- Find what to a RegExp ----------

const CLOSERS = { '(': ')', '[': ']', '{': '}' };

/** Word wildcards `q` → regex source and group count (plan.md §3 find; behaviour-tests.tsv wild rows). */
function wildSource(q) {
  let out = '';
  let groups = 0;
  let depth = 0;
  let atom = false; // the last piece can take a quantifier
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c === '\\') {
      if (i + 1 >= q.length) throw new FindError('The Find what text ends with a lone backslash.');
      const d = q[++i];
      out += /[1-9]/.test(d) ? `\\${d}` : esc(d); // \1 to \9 recall a group, as in Replace with
      atom = true;
    } else if (c === '^') {
      const { code } = readCode(q, i + 1);
      out += `(?:${codeSource(code, true)})`;
      i += code.length;
      atom = true;
    } else if (c === '?') {
      out += '[\\s\\S]';
      atom = true;
    } else if (c === '*') {
      out += '[\\s\\S]*?'; // Word's * takes the shortest run
      atom = false;
    } else if (c === '@') {
      if (!atom) throw new FindError('@ needs a character, a set or a group before it.');
      out += '+?'; // one or more, shortest
      atom = false;
    } else if (c === '{') {
      const m = q.slice(i).match(/^\{(\d+)(,(\d*))?\}/);
      if (!m || !atom || (m[3] && Number(m[3]) < Number(m[1]))) throw new FindError('The Find what text holds a count in braces that is not valid.');
      out += m[0]; // greedy, as Word's braces are
      i += m[0].length - 1;
      atom = false;
    } else if (c === '[') {
      const close = q.indexOf(']', i + 2);
      if (close < 0) throw new FindError('A [ in the Find what text has no closing ].');
      let body = q.slice(i + 1, close);
      const not = body[0] === '!';
      if (not) body = body.slice(1);
      let set = '';
      for (let k = 0; k < body.length; k++) {
        if (body[k + 1] === '-' && k + 2 < body.length) {
          if (body[k] > body[k + 2]) throw new FindError(`The range ${body.slice(k, k + 3)} must run in ascending order.`);
          set += `${escSet(body[k])}-${escSet(body[k + 2])}`;
          k += 2;
        } else set += escSet(body[k]);
      }
      out += `[${not ? '^' : ''}${set}]`;
      i = close;
      atom = true;
    } else if (c === '<') {
      out += WORD_START;
      atom = false;
    } else if (c === '>') {
      out += WORD_END;
      atom = false;
    } else if (c === '(') {
      groups++;
      depth++;
      out += '(';
      atom = false;
    } else if (c === ')') {
      if (!depth--) throw new FindError('A ) in the Find what text has no opening (.');
      out += ')';
      atom = true;
    } else {
      if (c === ']' || c === '}') throw new FindError(`A ${c} in the Find what text has no opening ${Object.keys(CLOSERS).find((k) => CLOSERS[k] === c)}.`);
      out += esc(c);
      atom = true;
    }
  }
  if (depth) throw new FindError('A ( in the Find what text has no closing ).');
  return { src: out, groups };
}

const PUNCT_RE = /\p{P}/u;
const SPACE_RE = /[ \t  　]/;

/** Plain Find what `q` → regex source; codes: read ^ codes. ignorePunct and ignoreSpace drop those characters from the query and
 * let any number of them stand between the rest. */
function plainSource(q, { codes, ignorePunct, ignoreSpace }) {
  const pieces = [];
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (codes && c === '^') {
      const { code } = readCode(q, i + 1);
      if (!code) throw new FindError('The Find what text ends with a lone ^.');
      if (code === '&' || code === 'c') throw invalid(code);
      pieces.push(`(?:${codeSource(code, false)})`);
      i += code.length;
      continue;
    }
    if ((ignorePunct && PUNCT_RE.test(c)) || (ignoreSpace && SPACE_RE.test(c))) continue;
    pieces.push(esc(c));
  }
  const skip = `${ignorePunct ? PUNCT : ''}${ignoreSpace ? SPACE : ''}`;
  return pieces.join(skip ? `[${skip}]*` : '');
}

/** Find what `query` with `opts` (§1.18) → {re, groups}; throws FindError for a query Word refuses. */
export function compile(query, opts = {}) {
  if (query.length > 255) throw new FindError('Find what takes up to 255 characters.');
  if (opts.wildcards) {
    const { src, groups } = wildSource(fold(query, opts));
    try {
      return { re: new RegExp(src, 'gu'), groups }; // wildcard search is always case-sensitive
    } catch {
      throw new FindError('The Find what text holds a pattern that is not valid.');
    }
  }
  let src = plainSource(fold(query, opts), opts);
  if (opts.wholeWord) src = `(?<!${WORD})(?:${src})(?!${WORD})`;
  else {
    if (opts.prefix) src = `(?<!${WORD})(?:${src})`;
    if (opts.suffix) src = `(?:${src})(?!${WORD})`;
  }
  return { re: new RegExp(src, opts.matchCase ? 'gu' : 'giu'), groups: 0 };
}

/** The message Word shows for `query`, or null when it is a valid search. */
export function queryError(query, opts = {}) {
  try {
    compile(query, opts);
    return null;
  } catch (e) {
    if (e instanceof FindError) return e.message;
    throw e;
  }
}

// Match half/full width forms off (the default): full-width ASCII and the ideographic space read as their half-width forms.
// One character to one, so offsets stay.
function fold(s, opts) {
  if (opts.widthForms) return s;
  return s.replace(/[！-～　]/g, (c) => (c === '　' ? ' ' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
}

// ---------- Format ----------

const MARK_KEYS = new Set(['bold', 'italic', 'strike', 'subscript', 'superscript', 'underline', 'code']);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A test of one model item against Format `format` ({run, para, style, highlight, lang}; only set keys count), or null. */
export function formatTest(format) {
  if (!format) return null;
  const run = Object.entries(format.run ?? {}).filter(([, v]) => v !== undefined && v !== null);
  const para = Object.entries(format.para ?? {}).filter(([, v]) => v !== undefined && v !== null);
  const { style = null, highlight = null, lang = null } = format;
  if (!run.length && !para.length && style == null && highlight == null && lang == null) return null;
  return (item) => {
    const marks = item.node?.marks ?? [];
    const ts = marks.find((m) => m.type.name === 'textStyle')?.attrs ?? {};
    for (const [k, v] of run) {
      if (MARK_KEYS.has(k)) {
        const m = marks.find((x) => x.type.name === k);
        if (typeof v === 'boolean' ? !!m !== v : !m || (v.val && m.attrs.val && v.val !== m.attrs.val)) return false;
      } else if (!same(ts[k], v)) return false;
    }
    if (highlight != null && !!(ts.highlight || marks.some((m) => m.type.name === 'highlight')) !== highlight) return false;
    if (lang != null && (ts.lang?.val ?? null) !== lang) return false;
    if (!item.block) return !para.length && style == null;
    for (const [k, v] of para) if (!same(item.block.attrs[k], v)) return false;
    return style == null || (styleIdOf(item.block) ?? 'Normal') === style;
  };
}

// ---------- searching ----------

const TOKEN = /[\p{L}\p{N}'’]+/gu;

/** Matches of `query` in model `m` → [{i, j, groups?}] (character offsets). Throws FindError. */
export function searchModel(m, query, opts = {}) {
  const { text, items } = m;
  const test = formatTest(opts.format);
  const out = [];
  if (!query) {
    // Empty Find what with Format: every run of text that has it.
    if (!test) return out;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === CH.para || !test(items[i])) continue;
      let j = i + 1;
      while (j < text.length && text[j] !== CH.para && test(items[j])) j++;
      out.push({ i, j });
      i = j;
    }
    return out;
  }
  if (!opts.wildcards && (opts.soundsLike || opts.allForms)) {
    const want = query.trim();
    const hit = opts.soundsLike ? (w) => soundsAlike(w, want) : (w) => sameForms(w, want);
    for (const t of text.matchAll(TOKEN)) if (hit(t[0])) out.push({ i: t.index, j: t.index + t[0].length });
  } else {
    const { re } = compile(query, opts);
    const hay = fold(text, opts);
    for (const r of hay.matchAll(re)) {
      if (!r[0].length) continue;
      out.push(r.length > 1 ? { i: r.index, j: r.index + r[0].length, groups: r.slice(1) } : { i: r.index, j: r.index + r[0].length });
    }
  }
  return test ? out.filter(({ i, j }) => items.slice(i, j).every((it, k) => text[i + k] === CH.para || test(it))) : out;
}

/** Matches of `query` in ProseMirror doc `doc` with §1.18 opts → {matches: [{from, to, groups?, i, j}], model, error}. A query
 * Word refuses gives no matches and its message. */
export function searchDoc(doc, query, opts = {}) {
  const model = textModel(doc, opts);
  let found;
  try {
    found = searchModel(model, query, opts);
  } catch (e) {
    if (e instanceof FindError) return { matches: [], model, error: e.message };
    throw e;
  }
  let matches = found.map((f) => ({ ...f, from: model.items[f.i].from, to: model.items[f.j - 1].to }));
  if (opts.within) matches = matches.filter((x) => x.from >= opts.within.from && x.to <= opts.within.to);
  return { matches, model, error: null };
}

// ---------- Replace with ----------

/** Replace with `text` → parts [{text} | {node: 'para'|'line'|'page'|'column'} | {group: n} | {found: true} | {clip: true}].
 * Throws FindError for a code Word refuses there. */
export function parseReplace(text, { wildcards = false, codes = true } = {}) {
  if (text.length > 255) throw new FindError('Replace with takes up to 255 characters.');
  const parts = [];
  const add = (p) => {
    const last = parts.at(-1);
    if (p.text != null && last?.text != null) last.text += p.text;
    else parts.push(p);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (wildcards && c === '\\' && i + 1 < text.length) {
      const d = text[++i];
      add(/[1-9]/.test(d) ? { group: Number(d) } : { text: d });
    } else if (codes && c === '^') {
      const { code } = readCode(text, i + 1);
      if (!code) throw new FindError('The Replace with text ends with a lone ^.');
      add(replaceCode(code));
      i += code.length;
    } else add({ text: c });
  }
  return parts;
}

const REPLACE_LETTERS = {
  p: { node: 'para' }, t: '\t', '^': '^', '%': '§', v: '¶', n: { node: 'column' }, '+': '—', '=': '–', l: { node: 'line' },
  m: { node: 'page' }, '~': CH.nbHyphen, s: CH.nbSpace, '-': CH.optHyphen, q: ' ', i: '…', j: '…', c: { clip: true },
  '&': { found: true }, h: '‎', r: '‏', x: '‌', o: '‌', z: '‍', y: '‍',
};
const REPLACE_DECIMAL = { 9: '\t', 11: { node: 'line' }, 12: { node: 'page' }, 13: { node: 'para' }, 14: { node: 'column' }, 30: CH.nbHyphen, 31: CH.optHyphen };

function replaceCode(code) {
  const v = /^\d+$/.test(code) ? REPLACE_DECIMAL[Number(code)] ?? decimalChar(code) : REPLACE_LETTERS[code];
  if (v == null) throw invalid(code, 'Replace with');
  return typeof v === 'string' ? { text: v } : v;
}

const NODE_OF = { [CH.para]: 'para', [CH.line]: 'line', [CH.page]: 'page', [CH.column]: 'column' };

/** Model text `s` (a found text or a group) → parts, its control characters as nodes and the rest as text. */
function fromModel(s) {
  const out = [];
  for (const c of s) {
    const node = NODE_OF[c];
    if (node) out.push({ node });
    else if (c < ' ' && c !== '\t' || c >= '' && c <= '') continue; // graphics, notes, fields: not copied as text
    else if (out.at(-1)?.text != null) out.at(-1).text += c;
    else out.push({ text: c });
  }
  return out;
}

/** Parts for one match: `parts` from parseReplace with ^&, \n and ^c filled in → [{text} | {node}]. found: the match's model text. */
export function expand(parts, found, groups = [], clip = '') {
  const out = [];
  for (const p of parts) {
    if (p.found) out.push(...fromModel(found));
    else if (p.group) out.push(...fromModel(groups[p.group - 1] ?? ''));
    else if (p.clip) out.push(...fromModel(clip.replace(/\r?\n/g, CH.para)));
    else out.push(p);
  }
  return out.filter((p) => p.node || p.text);
}

/** Word's case kept: `text` in the case `like` has (all capitals, a capital first, else as typed). */
export function caseLike(text, like) {
  if (like.length > 1 && like === like.toUpperCase() && like !== like.toLowerCase()) return text.toUpperCase();
  if (like[0] && like[0] === like[0].toUpperCase() && like[0] !== like[0].toLowerCase()) return text[0].toUpperCase() + text.slice(1);
  return text;
}
