// UnicodeMath, Word's linear format (docs/plans/word plan.md §3 equations; Unicode Technical Note 28, the subset Word's
// gallery and AutoCorrect use): a parser into the one math AST and a printer back. The AST (pure data, shared with latex.mjs
// and mathml.mjs):
//   {t: 'row', items}            a sequence                  {t: 'mi'|'mn'|'mo'|'text', v}   identifier, number, operator, normal text
//   {t: 'ph'}                    a placeholder ⬚             {t: 'frac', kind: 'bar'|'skew'|'lin'|'noBar', num, den}
//   {t: 'script', base, sub, sup}  sub and sup null when absent   {t: 'pre', sub, sup, base}  left scripts
//   {t: 'sqrt', deg, body}       deg null for a square root  {t: 'nary', op, sub, sup, lim: null|'stack', body}
//   {t: 'fence', open, close, body}  '' for an invisible bracket   {t: 'func', name, arg}   function apply (U+2061)
//   {t: 'accent', ch, base}      a combining mark over base  {t: 'bar', ch, base}  ¯ ▁ ⏞ ⏟ over or under base
//   {t: 'under'|'over', base, lim}  ┬ and ┴                    {t: 'box', boxed, body}  □ (no border) and ▭ (boxed)
//   {t: 'matrix', rows}          ■( & @ )                    {t: 'eqarray', rows}   █( & @ ), rows of cells
import { ENTRIES, FUNCTIONS } from './data.mjs';

export const PH = '⬚';
const OPEN = { '(': ')', '[': ']', '{': '}', '⟨': '⟩', '〈': '〉', '⌊': '⌋', '⌈': '⌉', '⟦': '⟧' };
const CLOSE = new Set(Object.values(OPEN));
const NARY = new Set([...'∑∏∐∫∬∭∮∯∰∱∲∳⋃⋂⋁⋀⨀⨁⨂⨄⨆']);
const FRAC = { '/': 'bar', '⊘': 'skew', '∕': 'lin', '¦': 'noBar' };
const FRAC_CH = Object.fromEntries(Object.entries(FRAC).map(([c, k]) => [k, c]));
const BARS = { '¯': 'over', '▁': 'under', '⏞': 'over', '⏟': 'under', '⏜': 'over', '⏝': 'under' };
const POSTFIX = new Set([...'!′″‴']);
// Characters with a structural meaning: never an operator, never inside a unit by accident.
const STRUCT = new Set([...'_^┬┴▒■█√∛∜□▭⁡"⬚〖〗├┤&@\\', ...Object.keys(FRAC), ...Object.keys(BARS)]);
const SPACE = /[\s -​ ]/;
const LETTER = /[\p{L}\p{Nl}∞∂∇⅀ℏ]/u;
const DIGIT = /[0-9]/;
const MARK = /[̀-ͯ⃐-⃿]/;

/** Whether character `c` is an operator (an mo that ends a fraction operand): anything but letters, digits, spaces, structure,
 * brackets and postfix marks. Exported for Math AutoCorrect's triggers. */
export const isOperator = (c) => !!c && !LETTER.test(c) && !DIGIT.test(c) && !SPACE.test(c) && !STRUCT.has(c) && !POSTFIX.has(c)
  && !MARK.test(c) && !NARY.has(c) && !(c in OPEN) && !CLOSE.has(c) && c !== '|' && c !== '‖' && c !== '.';

const DEFAULT_ENTRIES = new Map(ENTRIES);
const DEFAULT_FUNCTIONS = new Set(FUNCTIONS);

/** `text` with every Math AutoCorrect control word (\alpha, \sum) replaced by its character, as Word's build-up does. */
export function expandEntries(text, entries = DEFAULT_ENTRIES) {
  return text.replace(/\\([A-Za-z]+)/g, (m) => entries.get(m) ?? m);
}

const row = (items) => (items.length === 1 ? items[0] : { t: 'row', items });
const empty = () => ({ t: 'row', items: [] });
// A paren group used only to group a script, fraction or radical operand loses its parens, as in Word's build-up.
const strip = (n) => (n?.t === 'fence' && n.open === '(' && n.close === ')' ? n.body : n);

/** Parses UnicodeMath `text` → the AST. Options: entries (Map of control words), functions (Set of recognised function names). */
export function parse(text, { entries = DEFAULT_ENTRIES, functions = DEFAULT_FUNCTIONS } = {}) {
  const s = [...expandEntries(String(text ?? ''), entries)];
  let i = 0;
  const peek = (k = 0) => s[i + k];
  const skipSpace = () => {
    let n = 0;
    while (i < s.length && SPACE.test(s[i])) { i++; n++; }
    return n;
  };

  // expr: units and operators until a character of `stop` (or the end).
  function expr(stop) {
    const items = [];
    for (;;) {
      skipSpace();
      const c = peek();
      if (c === undefined || stop.has(c)) break;
      if (isOperator(c) || (CLOSE.has(c) && !stop.has(c))) {
        i++;
        items.push(limits({ t: 'mo', v: c }));
        continue;
      }
      const before = i;
      const u = unit(stop);
      if (i === before) { // a character nothing else takes (a stray structure character): keep it as an operator
        items.push({ t: 'mo', v: s[i++] });
        continue;
      }
      if (u.t === 'row') items.push(...u.items);
      else items.push(u);
    }
    return row(items);
  }

  // ┬ and ┴ after an operator or a factor: a limit below or above it.
  function limits(base) {
    while (peek() === '┬' || peek() === '┴') {
      const t = s[i++] === '┬' ? 'under' : 'over';
      base = { t, base, lim: scriptArg() };
    }
    return base;
  }

  // unit: factors joined by fraction slashes, ending at a space or an operator.
  function unit(stop) {
    let left = factors(stop);
    while (FRAC[peek()]) {
      const kind = FRAC[s[i++]];
      const right = factors(stop);
      left = { t: 'frac', kind, num: strip(left), den: strip(right) };
    }
    return left;
  }

  function factors(stop) {
    const out = [];
    for (;;) {
      const c = peek();
      if (c === undefined || SPACE.test(c) || stop.has(c) || FRAC[c] || isOperator(c) || CLOSE.has(c)) break;
      if (POSTFIX.has(c)) {
        i++;
        out.push({ t: 'mo', v: c });
        continue;
      }
      const before = i;
      const f = factor(stop);
      if (i === before) break;
      out.push(f);
    }
    return out.length === 1 ? out[0] : { t: 'row', items: out };
  }

  // factor: a primary with its accents, scripts and limits; an n-ary operator takes its operand, a function its argument.
  function factor(stop) {
    if (peek() === '_' || peek() === '^') { // left scripts: _a^b X
      const sc = scripts();
      skipSpace();
      return { t: 'pre', sub: sc.sub, sup: sc.sup, base: primary(stop) ?? { t: 'ph' } };
    }
    let p = primary(stop);
    if (!p) return empty();
    while (MARK.test(peek() ?? '')) p = { t: 'accent', ch: s[i++], base: p };
    if (p.t === 'nary') {
      const sc = scripts(true);
      Object.assign(p, sc);
      p.body = naryBody(stop);
      return p;
    }
    const sc = scripts();
    if (sc.sub || sc.sup) p = { t: 'script', base: p, sub: sc.sub, sup: sc.sup };
    p = limits(p);
    if (isFuncName(p)) return funcApply(p, stop);
    return p;
  }

  function isFuncName(p) {
    let b = p;
    while (b.t === 'script' || b.t === 'under' || b.t === 'over') b = b.base;
    return b.t === 'mi' && b.v.length > 1;
  }

  // A function name applies to what follows a U+2061 or a space (sin x, sin⁡θ), or to a bracket right after it (sin(x)).
  function funcApply(name, stop) {
    const at = i;
    if (peek() === '⁡') i++;
    else if (peek() in OPEN) return { t: 'func', name, arg: factor(stop) };
    else if (skipSpace() === 0) return name;
    const c = peek();
    if (c === undefined || stop.has(c) || isOperator(c) || CLOSE.has(c) || FRAC[c]) {
      i = at;
      return name;
    }
    return { t: 'func', name, arg: factors(stop) };
  }

  function naryBody(stop) {
    if (peek() === '▒') {
      i++;
      return factor(stop);
    }
    const at = i;
    if (!skipSpace()) return null;
    const c = peek();
    if (c === undefined || stop.has(c) || isOperator(c) || CLOSE.has(c)) {
      i = at;
      return null;
    }
    return factors(stop);
  }

  // _a ^b (either order), and for n-ary operators ┬ and ┴, which stack the limits.
  function scripts(nary = false) {
    const sc = { sub: null, sup: null };
    for (;;) {
      const c = peek();
      if (c === '_' || c === '^') {
        i++;
        sc[c === '_' ? 'sub' : 'sup'] = scriptArg();
      } else if (nary && (c === '┬' || c === '┴')) {
        i++;
        sc[c === '┬' ? 'sub' : 'sup'] = scriptArg();
        sc.lim = 'stack';
      } else break;
    }
    return sc;
  }

  // A script argument: one primary (with its accents and inner scripts), or a sign and a primary (e^-x).
  function scriptArg() {
    const c = peek();
    if (c === undefined) return { t: 'ph' };
    if ('+-−±∓'.includes(c)) {
      i++;
      const p = primary(new Set());
      return p ? { t: 'row', items: [{ t: 'mo', v: c }, strip(p)] } : { t: 'mo', v: c };
    }
    let p = primary(new Set());
    if (!p) return { t: 'ph' };
    while (MARK.test(peek() ?? '')) p = { t: 'accent', ch: s[i++], base: p };
    return strip(p);
  }

  // A bracketed group from `open` to its closing bracket; `├x` and `┤x` name a bracket explicitly, alone an invisible one.
  function fence(open) {
    const closers = new Set([...CLOSE, '┤', '〗']);
    if (open === '|' || open === '‖') closers.add(open);
    const body = expr(closers);
    let close = '';
    const c = peek();
    if (c === '┤') {
      i++;
      const n = peek();
      if (n !== undefined && !SPACE.test(n) && !LETTER.test(n) && !DIGIT.test(n) && !STRUCT.has(n) && (CLOSE.has(n) || n in OPEN || n === '|' || n === '‖')) close = s[i++];
    } else if (c !== undefined && c !== '〗') close = s[i++];
    return { t: 'fence', open, close, body };
  }

  // Cells by & and rows by @ inside parentheses, for ■ and █.
  function grid() {
    if (peek() !== '(') return [[primary(new Set()) ?? empty()]];
    i++;
    const rows = [[]];
    for (;;) {
      const cell = expr(new Set(['&', '@', ')']));
      rows.at(-1).push(cell);
      const c = s[i++];
      if (c === '&') continue;
      if (c === '@') rows.push([]);
      else break;
    }
    return rows;
  }

  function primary(stop) {
    const c = peek();
    if (c === undefined || stop.has(c)) return null;
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(peek(1) ?? ''))) {
      let v = '';
      while (DIGIT.test(peek() ?? '') || (peek() === '.' && DIGIT.test(peek(1) ?? ''))) v += s[i++];
      return { t: 'mn', v };
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (/[A-Za-z]/.test(s[j] ?? '')) j++;
      const word = s.slice(i, j).join('');
      if (word.length > 1 && functions.has(word)) {
        i = j;
        return { t: 'mi', v: word };
      }
      i++;
      return { t: 'mi', v: c };
    }
    if (c === PH) { i++; return { t: 'ph' }; }
    if (LETTER.test(c)) { i++; return { t: 'mi', v: c }; }
    if (NARY.has(c)) { i++; return { t: 'nary', op: c, sub: null, sup: null, lim: null, body: null }; }
    if (c === '"') {
      i++;
      let v = '';
      while (i < s.length && s[i] !== '"') v += s[i++];
      i++;
      return { t: 'text', v };
    }
    if (c === '\\') { // an unknown control word stays as text; a backslash before a character quotes it
      i++;
      if (/[A-Za-z]/.test(peek() ?? '')) {
        let v = '\\';
        while (/[A-Za-z]/.test(peek() ?? '')) v += s[i++];
        return { t: 'text', v };
      }
      return peek() === undefined ? { t: 'mo', v: '\\' } : { t: 'mo', v: s[i++] };
    }
    if (c === '√' || c === '∛' || c === '∜') {
      i++;
      if (c === '√' && peek() === '(') { // √(n&x): a root of degree n
        const at = i;
        i++;
        const first = expr(new Set(['&', ')']));
        if (peek() === '&') {
          i++;
          const body = expr(new Set([')']));
          if (peek() === ')') i++;
          return { t: 'sqrt', deg: first, body };
        }
        i = at;
      }
      const body = strip(scriptArgLike());
      return { t: 'sqrt', deg: c === '√' ? null : { t: 'mn', v: c === '∛' ? '3' : '4' }, body };
    }
    if (c === '■' || c === '█') {
      i++;
      return { t: c === '■' ? 'matrix' : 'eqarray', rows: grid() };
    }
    if (c === '□' || c === '▭') {
      i++;
      return { t: 'box', boxed: c === '▭', body: strip(scriptArgLike()) };
    }
    if (BARS[c]) {
      i++;
      return { t: 'bar', ch: c, base: strip(scriptArgLike()) };
    }
    if (c === '〖') {
      i++;
      const body = expr(new Set(['〗']));
      if (peek() === '〗') i++;
      return body;
    }
    if (c === '├') {
      i++;
      const n = peek();
      const open = n !== undefined && (n in OPEN || CLOSE.has(n) || n === '|' || n === '‖') ? s[i++] : '';
      return fence(open);
    }
    if (c in OPEN || c === '|' || c === '‖') {
      i++;
      return fence(c);
    }
    return null;
  }

  // The operand of a prefix structure (√, □, ¯): one primary with its accents, else a placeholder.
  function scriptArgLike() {
    let p = primary(new Set());
    if (!p) return { t: 'ph' };
    while (MARK.test(peek() ?? '')) p = { t: 'accent', ch: s[i++], base: p };
    return p;
  }

  const out = expr(new Set());
  return out;
}

// ---------------------------------------------------------------------------------------------
// Printer

// A node that prints as one primary, so it needs no grouping as an operand.
const atomic = (n) => ['mi', 'mn', 'ph', 'text', 'fence', 'matrix', 'eqarray', 'sqrt', 'box', 'bar'].includes(n.t)
  || (n.t === 'mo' && !isOperator(n.v)) || n.t === 'accent' && atomic(n.base);
// A node that prints as one unit (factors without spaces or operators), so a fraction operand needs no parens.
const unitSafe = (n) => n.t !== 'frac' && n.t !== 'func' && n.t !== 'nary' && (n.t !== 'row' ? n.t !== 'mo' || !isOperator(n.v)
  : n.items.length > 0 && n.items.every((x) => unitSafe(x) && x.t !== 'row'));

const paren = (n) => `(${print(n)})`;
const group = (n) => `〖${print(n)}〗`;
const arg = (n) => (n.t === 'mo' && isOperator(n.v) ? `(${n.v})` : atomic(n) ? print(n) : paren(n));
const operand = (n) => (n.t === 'row' && !n.items.length ? '' : unitSafe(n) ? print(n) : paren(n));

/** Prints `node` (the AST) as UnicodeMath → text that parses back to the same AST. */
export function print(node) {
  if (!node) return '';
  switch (node.t) {
    case 'row': {
      let out = '';
      node.items.forEach((n, k) => {
        const prev = node.items[k - 1];
        // A space ends a fraction operand, a function's argument and an n-ary operand, so neighbours stay outside them.
        // ponytail: single letters that spell a recognised function (s, i, n) print joined and read back as the function.
        // An n-ary operator without an operand takes none only while nothing follows it after a space.
        const bare = prev?.t === 'nary' && !prev.body;
        if (prev && prev.t !== 'mo' && n.t !== 'mo' && !bare && [prev.t, n.t].some((t) => t === 'frac' || t === 'func' || t === 'nary')) out += ' ';
        out += print(n);
      });
      return out;
    }
    case 'mi': case 'mn': return node.v;
    // Any other character is quoted, with spaces so it stays a term of its own.
    case 'mo': return isOperator(node.v) || CLOSE.has(node.v) || POSTFIX.has(node.v) ? node.v : ` \\${node.v} `;
    case 'text': return `"${node.v}"`;
    case 'ph': return PH;
    case 'frac': return `${operand(node.num)}${FRAC_CH[node.kind] ?? '/'}${operand(node.den)}`;
    case 'script': return `${arg(node.base)}${node.sub ? `_${arg(node.sub)}` : ''}${node.sup ? `^${arg(node.sup)}` : ''}`;
    case 'pre': return `${node.sub ? `_${arg(node.sub)}` : ''}${node.sup ? `^${arg(node.sup)}` : ''}${arg(node.base)}`;
    case 'sqrt': {
      if (!node.deg) return `√${arg(node.body)}`;
      if (node.deg.t === 'mn' && (node.deg.v === '3' || node.deg.v === '4')) return `${node.deg.v === '3' ? '∛' : '∜'}${arg(node.body)}`;
      return `√(${print(node.deg)}&${print(node.body)})`;
    }
    case 'nary': {
      const [lo, hi] = node.lim === 'stack' ? ['┬', '┴'] : ['_', '^'];
      const body = node.body ? `▒${node.body.t === 'row' || !atomic(node.body) ? group(node.body) : print(node.body)}` : '';
      return `${node.op}${node.sub ? lo + arg(node.sub) : ''}${node.sup ? hi + arg(node.sup) : ''}${body}`;
    }
    case 'fence': {
      const open = node.open in OPEN || node.open === '|' || node.open === '‖' ? node.open : `├${node.open}`;
      const pair = OPEN[node.open] === node.close || ((node.open === '|' || node.open === '‖') && node.close === node.open);
      const close = pair ? node.close : `┤${node.close}`;
      return `${open}${print(node.body)}${close}`;
    }
    case 'func': {
      const a = node.arg;
      return `${print(node.name)}⁡${unitSafe(a) ? print(a) : group(a)}`;
    }
    case 'accent': return `${atomic(node.base) ? print(node.base) : paren(node.base)}${node.ch}`;
    case 'bar': return `${node.ch}${arg(node.base)}`;
    case 'under': case 'over': return `${node.base.t === 'row' ? group(node.base) : print(node.base)}${node.t === 'under' ? '┬' : '┴'}${arg(node.lim)}`;
    case 'box': return `${node.boxed ? '▭' : '□'}${arg(node.body)}`;
    case 'matrix': case 'eqarray':
      return `${node.t === 'matrix' ? '■' : '█'}(${node.rows.map((r) => r.map(print).join('&')).join('@')})`;
    default: return '';
  }
}

/** A canonical copy of `ast` for comparisons: rows flattened where they sit in a row, single-item rows unwrapped. */
export function normalize(n) {
  if (!n || typeof n !== 'object') return n;
  if (Array.isArray(n)) return n.map(normalize);
  if (n.t === 'row') {
    const items = n.items.map(normalize).flatMap((x) => (x.t === 'row' ? x.items : [x]));
    return items.length === 1 ? items[0] : { t: 'row', items };
  }
  return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, normalize(v)]));
}
