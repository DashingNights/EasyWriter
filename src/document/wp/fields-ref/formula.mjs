// The = (Formula) field's calculator (docs/plans/word/index-fields.md Formula, the table of tests). Word's order: unary minus
// first (-2^2 = 4), then ^, * and /, + and -, then the comparisons, which give 1 or 0; % after a number divides it by 100. Only
// Word's 18 functions exist, the comma separates arguments, and table references read cells through `env.cells`. Pure.

/** Word's 18 functions, in the Formula dialog's Paste function order. */
export const FUNCTIONS = ['ABS', 'AND', 'AVERAGE', 'COUNT', 'DEFINED', 'FALSE', 'IF', 'INT', 'MAX', 'MIN', 'MOD', 'NOT', 'OR', 'PRODUCT',
  'ROUND', 'SIGN', 'SUM', 'TRUE'];
/** The Formula dialog's number formats (probe/dialogs/formula.json). */
export const PICTURES = ['#,##0', '#,##0.00', '$#,##0.00;($#,##0.00)', '0', '0%', '0.00', '0.00%'];

const DIRECTIONS = new Set(['ABOVE', 'BELOW', 'LEFT', 'RIGHT']);
const CURRENCY = '$€£¥';
const COMPARE = new Set(['=', '<', '>', '<=', '>=', '<>']);

class FormulaError extends Error {}
const fail = (text) => {
  throw new FormulaError(text);
};
const syntax = (tok) => fail(tok ? `!Syntax Error, ${tok.text}` : '!Unexpected End of Formula');

// ---------- tokens ----------
// {k: 'num', v, dec, grouped, cur} | {k: 'id', text} | {k: 'op', text}. A comma followed by three digits groups thousands only
// outside a function's parentheses (1,000+1 is 1,001; SUM(1,000) lists 1 and 0).
function lex(src) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c) || (CURRENCY.includes(c) && /[0-9.]/.test(src[i + 1] ?? ''))) {
      const cur = CURRENCY.includes(c) ? c : null;
      let j = cur ? i + 1 : i;
      let s = '';
      let grouped = false;
      for (;;) {
        const m = /^[0-9]*\.?[0-9]*/.exec(src.slice(j))[0];
        s += m;
        j += m.length;
        if (!depth && !s.includes('.') && src[j] === ',' && /^[0-9]{3}(?![0-9])/.test(src.slice(j + 1))) {
          grouped = true;
          j++;
          continue;
        }
        break;
      }
      if (s === '.' || s === '') fail(`!Syntax Error, ${src[i]}`);
      out.push({ k: 'num', v: Number(s), dec: (s.split('.')[1] ?? '').length, grouped, cur, text: src.slice(i, j) });
      i = j;
    } else if (/[\p{L}_]/u.test(c)) {
      const m = /^[\p{L}\p{N}_]+/u.exec(src.slice(i))[0];
      out.push({ k: 'id', text: m });
      i += m.length;
    } else {
      const two = src.slice(i, i + 2);
      const text = ['<=', '>=', '<>'].includes(two) ? two : c;
      if (!'+-*/^%=<>(),:'.includes(text[0])) fail(`!Syntax Error, ${c}`);
      if (text === '(') depth++;
      if (text === ')') depth--;
      out.push({ k: 'op', text });
      i += text.length;
    }
  }
  return out;
}

// ---------- table references ----------
const COL = /^([A-Za-z])([0-9]+)$/;
const RC = /^[Rr]([0-9]+)[Cc]([0-9]+)$/;
const colIndex = (letter) => letter.toUpperCase().charCodeAt(0) - 65;

/** The number a table cell holds: null for an empty cell, NaN for one holding text. */
export function cellNumber(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t);
  const s = t.replace(/^\(|\)$/g, '').replace(/[$€£¥,\s]/g, '');
  const pct = s.endsWith('%');
  const n = /^[-+]?[0-9]*\.?[0-9]+$/.test(pct ? s.slice(0, -1) : s) ? Number(pct ? s.slice(0, -1) : s) : NaN;
  return (neg ? -n : n) / (pct ? 100 : 1);
}

// ---------- the parser and evaluator ----------
/** Evaluates formula `src` → {value, text} or {error}. `env`: {bookmark(name) → number | null (null: not defined), cells(table) →
 * {grid: cell[][], here: {r, c} | null} | null (table: a bookmark name for another table, or null for the formula's own)}. A grid
 * cell is {text}; a merged cell appears in every slot it covers as the same object, so it counts once. */
export function evaluate(src, env = {}) {
  try {
    const p = new Parser(lex(String(src ?? '')), env);
    const value = p.top();
    return { value, text: formatResult(value, p.style) };
  } catch (e) {
    if (e instanceof FormulaError) return { error: e.message };
    throw e;
  }
}

class Parser {
  constructor(toks, env) {
    this.t = toks;
    this.i = 0;
    this.env = env;
    this.style = { dec: 0, grouped: false, cur: null };
  }

  peek(n = 0) { return this.t[this.i + n]; }
  next() { return this.t[this.i++]; }
  isOp(text, n = 0) { const k = this.peek(n); return k?.k === 'op' && k.text === text; }
  expect(text) {
    const k = this.next();
    if (k?.k !== 'op' || k.text !== text) syntax(k);
  }

  top() {
    if (!this.t.length) fail('!Unexpected End of Formula');
    const v = this.compare();
    const rest = this.peek();
    if (rest) fail(rest.k === 'num' || rest.k === 'id' || this.isOp('(') ? '!Missing Operator' : `!Syntax Error, ${rest.text}`);
    return v;
  }

  compare() {
    let a = this.additive();
    while (this.peek()?.k === 'op' && COMPARE.has(this.peek().text)) {
      const op = this.next().text;
      const b = this.additive();
      a = Number({ '=': a === b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b, '<>': a !== b }[op]);
    }
    return a;
  }

  additive() {
    let a = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) a = this.next().text === '+' ? a + this.multiplicative() : a - this.multiplicative();
    return a;
  }

  multiplicative() {
    let a = this.power();
    while (this.isOp('*') || this.isOp('/')) {
      const op = this.next().text;
      const b = this.power();
      if (op === '/' && b === 0) fail('!Zero Divide');
      a = op === '*' ? a * b : a / b;
    }
    return a;
  }

  power() {
    let a = this.unary();
    while (this.isOp('^')) {
      this.next();
      a **= this.unary();
    }
    return a;
  }

  unary() {
    if (this.isOp('-')) {
      this.next();
      return -this.unary();
    }
    if (this.isOp('+')) {
      this.next();
      return this.unary();
    }
    let v = this.primary();
    while (this.isOp('%')) {
      this.next();
      v /= 100;
    }
    return v;
  }

  primary() {
    const k = this.next();
    if (!k) fail('!Unexpected End of Formula');
    if (k.k === 'num') {
      this.style.dec = Math.max(this.style.dec, k.dec);
      this.style.grouped ||= k.grouped;
      this.style.cur ??= k.cur;
      return k.v;
    }
    if (k.k === 'op') {
      if (k.text !== '(') syntax(k);
      const v = this.compare();
      if (!this.peek()) fail('!Unexpected End of Formula');
      this.expect(')');
      return v;
    }
    const name = k.text.toUpperCase();
    if (name === 'TRUE' || name === 'FALSE') {
      if (this.isOp('(')) {
        this.next();
        this.expect(')');
      }
      return name === 'TRUE' ? 1 : 0;
    }
    if (this.isOp('(')) {
      if (!FUNCTIONS.includes(name)) {
        this.next();
        syntax(this.peek());
      }
      return this.call(name);
    }
    if (COL.test(k.text) || RC.test(k.text)) return this.cellValue(this.refCells(k.text, null));
    if (DIRECTIONS.has(name)) fail(`!Syntax Error, ${k.text}`);
    const n = this.peek();
    if (n?.k === 'id' && (COL.test(n.text) || RC.test(n.text) || this.isOp(':', 1))) {
      fail(`!Syntax Error, ${n.text}`); // a table reference through a bookmark ("tbl A1") is only a function argument
    }
    const v = this.env.bookmark?.(k.text);
    if (v == null) fail(`!Undefined Bookmark, ${name}`);
    return v;
  }

  // A function call after its name: the arguments, each an expression or a list of cells, flattened for the list functions.
  call(name) {
    this.expect('(');
    const args = [];
    if (this.isOp(')')) this.next();
    else {
      for (;;) {
        args.push(name === 'DEFINED' ? this.defined() : this.argument());
        if (!this.peek()) fail('!Unexpected End of Formula');
        const k = this.next();
        if (k.k === 'op' && k.text === ')') break;
        if (k.k !== 'op' || k.text !== ',') syntax(k);
      }
    }
    const flat = args.flat();
    const one = (n = 0) => {
      const a = args[n];
      if (a === undefined) fail('!Syntax Error, )');
      return Array.isArray(a) ? a.reduce((s, x) => s + x, 0) : a;
    };
    switch (name) {
      case 'ABS': return Math.abs(one());
      case 'AND': return Number(!!one(0) && !!one(1));
      case 'OR': return Number(!!one(0) || !!one(1));
      case 'NOT': return Number(!one());
      case 'AVERAGE': return flat.length ? flat.reduce((s, x) => s + x, 0) / flat.length : 0;
      case 'COUNT': return flat.length;
      case 'DEFINED': return one();
      case 'IF': return one(0) ? one(1) : one(2);
      case 'INT': return Math.trunc(one());
      case 'MAX': return flat.length ? Math.max(...flat) : 0;
      case 'MIN': return flat.length ? Math.min(...flat) : 0;
      case 'MOD': {
        const b = one(1);
        if (b === 0) fail('!Zero Divide');
        return one(0) % b;
      }
      case 'PRODUCT': return flat.reduce((s, x) => s * x, 1);
      case 'ROUND': return roundAway(one(0), one(1));
      case 'SIGN': return Math.sign(one());
      case 'SUM': return flat.reduce((s, x) => s + x, 0);
      default: return 0;
    }
  }

  // DEFINED(x): 1 when x evaluates without an error (an undefined bookmark is the usual one), else 0. Consumes the argument.
  defined() {
    const start = this.i;
    let depth = 0;
    while (this.peek() && !(depth === 0 && (this.isOp(',') || this.isOp(')')))) {
      if (this.isOp('(')) depth++;
      if (this.isOp(')')) depth--;
      this.next();
    }
    const sub = new Parser(this.t.slice(start, this.i), this.env);
    try {
      sub.argument();
      return sub.peek() ? 0 : 1;
    } catch (e) {
      if (e instanceof FormulaError) return 0;
      throw e;
    }
  }

  // One function argument: a direction, a cell range (A1:B2, B:B, 1:1), a table through a bookmark ("tbl A1:B2"), or an
  // expression. Ranges and directions give arrays of numbers.
  argument() {
    const k = this.peek();
    if (k?.k === 'id' && DIRECTIONS.has(k.text.toUpperCase())) {
      this.next();
      if (this.isOp(',') && this.peek(1)?.k === 'id' && DIRECTIONS.has(this.peek(1).text.toUpperCase())) fail('!Syntax Error, :');
      return this.numbers(this.direction(k.text.toUpperCase()));
    }
    const range = this.range(null);
    if (range) return this.numbers(range);
    if (k?.k === 'id' && !COL.test(k.text) && !RC.test(k.text) && !FUNCTIONS.includes(k.text.toUpperCase())) {
      const after = this.peek(1);
      if (after && (after.k === 'id' || after.k === 'num')) {
        this.next();
        const r = this.range(k.text) ?? this.single();
        if (!r) syntax(this.peek());
        return this.numbers(r);
      }
    }
    return this.compare();
  }

  // A range at the cursor (A1:B2, B:B, 1:1) in table `table` (null: the formula's own) → its cells, or null when none starts here.
  range(table) {
    const a = this.peek();
    const b = this.peek(2);
    if (!a || !this.isOp(':', 1) || !b) return null;
    const both = (re) => re.test(a.text) && re.test(b.text);
    if (a.k === 'id' && b.k === 'id' && both(RC)) fail('!Syntax Error, :'); // RnCn ranges fail in Word 16.0.20527
    let cells = null;
    if (a.k === 'id' && b.k === 'id' && both(COL)) {
      const [, c1, r1] = COL.exec(a.text);
      const [, c2, r2] = COL.exec(b.text);
      cells = this.rect(table, +r1 - 1, colIndex(c1), +r2 - 1, colIndex(c2));
    } else if (a.k === 'id' && b.k === 'id' && /^[A-Za-z]$/.test(a.text) && /^[A-Za-z]$/.test(b.text)) {
      cells = this.rect(table, 0, colIndex(a.text), Infinity, colIndex(b.text));
    } else if (a.k === 'num' && b.k === 'num' && !a.dec && !b.dec) {
      cells = this.rect(table, a.v - 1, 0, b.v - 1, Infinity);
    } else return null;
    this.i += 3;
    return cells;
  }

  // A single cell after a table bookmark: Word 16.0.20527 refuses "tbl A1" and "tbl R1C1", so it is a syntax error here too.
  single() {
    const k = this.peek();
    if (k?.k === 'id' && (COL.test(k.text) || RC.test(k.text))) fail(`!Syntax Error, ${k.text}`);
    return null;
  }

  table(name) {
    const t = this.env.cells?.(name ?? null);
    if (!t?.grid?.length) fail(name ? `!Undefined Bookmark, ${String(name).toUpperCase()}` : '!The Formula Not In Table');
    return t;
  }

  rect(table, r1, c1, r2, c2) {
    const { grid } = this.table(table);
    const out = [];
    for (let r = Math.max(0, Math.min(r1, r2)); r <= Math.min(grid.length - 1, Math.max(r1, r2)); r++) {
      for (let c = Math.max(0, Math.min(c1, c2)); c <= Math.min(grid[r].length - 1, Math.max(c1, c2)); c++) out.push(grid[r][c]);
    }
    return out;
  }

  refCells(text, table) {
    const m = COL.exec(text);
    const [r, c] = m ? [+m[2] - 1, colIndex(m[1])] : RC.exec(text).slice(1).map((x) => +x - 1);
    return this.rect(table, r, c, r, c);
  }

  // Cells from the formula's cell in direction `dir`, stopping at the first one holding text; empty cells are passed.
  direction(dir) {
    const { grid, here } = this.table(null);
    if (!here) fail('!The Formula Not In Table');
    const [dr, dc] = { ABOVE: [-1, 0], BELOW: [1, 0], LEFT: [0, -1], RIGHT: [0, 1] }[dir];
    const out = [];
    const own = grid[here.r]?.[here.c];
    for (let r = here.r + dr, c = here.c + dc; r >= 0 && r < grid.length && c >= 0 && c < (grid[r]?.length ?? 0); r += dr, c += dc) {
      const cell = grid[r][c];
      if (cell === own) continue;
      if (Number.isNaN(cellNumber(cell.text))) break;
      out.push(cell);
    }
    return out;
  }

  // The numbers of `cells`, each merged cell once; empty and text cells hold none.
  numbers(cells) {
    const seen = new Set();
    const out = [];
    for (const cell of cells) {
      if (!cell || seen.has(cell)) continue;
      seen.add(cell);
      const n = cellNumber(cell.text);
      if (n != null && !Number.isNaN(n)) out.push(n);
    }
    return out;
  }

  cellValue(cells) {
    const n = cellNumber(cells[0]?.text);
    return n == null || Number.isNaN(n) ? 0 : n;
  }
}

/** `x` rounded to `places` decimals, halves away from zero (ROUND(2.5,0) = 3; a negative `places` rounds left of the point). */
export function roundAway(x, places = 0) {
  const f = 10 ** Math.trunc(places);
  const y = Math.abs(x) * f;
  const r = Math.round(y + 1e-9 * Math.max(1, y)) / f;
  return Math.sign(x) * r;
}

const group = (int) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Word's result text for `value` without a picture: rounded to the larger of 2 and the most decimals the expression typed,
 * trailing zeros dropped; thousands grouped when an input was; a currency symbol gives currency with two decimals. */
export function formatResult(value, { dec = 0, grouped = false, cur = null } = {}) {
  if (!Number.isFinite(value)) return '!Zero Divide';
  if (cur) {
    const [i, f] = roundAway(Math.abs(value), 2).toFixed(2).split('.');
    return `${value < 0 ? '-' : ''}${cur}${group(i)}.${f}`;
  }
  const places = Math.max(2, dec);
  let s = roundAway(value, places).toFixed(places);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  if (grouped) {
    const [i, f] = s.replace('-', '').split('.');
    s = `${s.startsWith('-') ? '-' : ''}${group(i)}${f ? `.${f}` : ''}`;
  }
  return s;
}
