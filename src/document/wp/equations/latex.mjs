// LaTeX, Word's second linear format (docs/plans/word plan.md §3 equations): a parser for the subset Word reads (\frac, \sqrt,
// scripts, the n-ary operators, \left and \right, the matrix, pmatrix, bmatrix, vmatrix and cases environments, Greek and
// operator names, the function names) into the AST of unicodemath.mjs, and a printer back. LaTeX text typed in an equation
// becomes UnicodeMath when the equation is committed, as Word converts it.
import { ENTRIES, FUNCTIONS } from './data.mjs';
import { PH } from './unicodemath.mjs';

const ENTRY = new Map(ENTRIES);
const FUNCS = new Set(FUNCTIONS);
const NARY = { sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', oiint: '∯', bigcup: '⋃', bigcap: '⋂', bigvee: '⋁',
  bigwedge: '⋀', bigoplus: '⨁', bigotimes: '⨂', bigodot: '⨀' };
const ACCENTS = { hat: '̂', widehat: '̂', bar: '̅', vec: '⃗', dot: '̇', ddot: '̈', dddot: '⃛', tilde: '̃',
  widetilde: '̃', check: '̌', acute: '́', grave: '̀', breve: '̆' };
const BARS = { overline: '¯', underline: '▁', overbrace: '⏞', underbrace: '⏟' };
const ENVS = { matrix: ['', ''], pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'] };
const SKIP = new Set([',', ';', ':', '!', ' ', 'quad', 'qquad', 'displaystyle', 'textstyle', 'limits', 'nolimits', 'mathrm', 'mathit', 'mathbf',
  'mathbb', 'mathcal', 'mathfrak', 'mathsf', 'mathtt', 'big', 'Big', 'bigg', 'Bigg']);
const DELIMS = { '(': '(', ')': ')', '[': '[', ']': ']', '\\{': '{', '\\}': '}', '\\lbrace': '{', '\\rbrace': '}', '\\langle': '⟨', '\\rangle': '⟩',
  '|': '|', '\\|': '‖', '\\vert': '|', '\\Vert': '‖', '\\lfloor': '⌊', '\\rfloor': '⌋', '\\lceil': '⌈', '\\rceil': '⌉', '.': '' };
const OPENERS = { '(': ')', '[': ']', '\\{': '\\}', '\\lbrace': '\\rbrace', '\\langle': '\\rangle', '\\lfloor': '\\rfloor', '\\lceil': '\\rceil' };
const LETTER = /[\p{L}\p{Nl}∞∂∇]/u;

function tokens(text) {
  const out = [];
  const s = [...String(text ?? '')];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '\\') {
      let j = i + 1;
      if (/[A-Za-z]/.test(s[j] ?? '')) while (/[A-Za-z]/.test(s[j] ?? '')) j++;
      else j++;
      out.push(s.slice(i, j).join(''));
      i = j;
      continue;
    }
    out.push(c);
    i++;
  }
  return out;
}

const row = (items) => (items.length === 1 ? items[0] : { t: 'row', items });
const charNode = (c) => (c === PH ? { t: 'ph' } : /[0-9]/.test(c) ? { t: 'mn', v: c } : LETTER.test(c) ? { t: 'mi', v: c } : { t: 'mo', v: c === "'" ? '′' : c });

/** Parses LaTeX `text` → the math AST (unicodemath.mjs). */
export function parseLatex(text) {
  const tk = tokens(text);
  let i = 0;
  const peek = () => tk[i];

  // A sequence until a token of `stop`; adjacent digits join into one number.
  function seq(stop) {
    const items = [];
    while (i < tk.length && !stop.has(peek())) {
      const before = i;
      const a = scripted(stop);
      if (i === before) { i++; continue; }
      if (!a) continue;
      const prev = items.at(-1);
      if (a.t === 'mn' && prev?.t === 'mn') prev.v += a.v;
      else if (a.t === 'row') items.push(...a.items);
      else items.push(a);
    }
    return row(items);
  }

  function arg() {
    if (peek() === '{') {
      i++;
      const r = seq(new Set(['}']));
      i++;
      return r;
    }
    const a = atom(new Set());
    return a ?? { t: 'ph' };
  }

  function scripts() {
    const sc = { sub: null, sup: null };
    while (peek() === '_' || peek() === '^') {
      const k = tk[i++] === '_' ? 'sub' : 'sup';
      sc[k] = arg();
    }
    return sc;
  }

  // The operand after an n-ary operator or a function name: the next atom unless an operator or the end comes first.
  function operand(stop) {
    const t = peek();
    if (t === undefined || stop.has(t) || t === '&' || t === '\\\\' || t === '\\right' || t === '\\end') return null;
    const at = i;
    const a = scripted(stop);
    if (!a || a.t === 'mo') { i = at; return null; }
    return a;
  }

  function scripted(stop) {
    let a = atom(stop);
    if (!a) return a;
    if (a.t === 'nary') {
      Object.assign(a, scripts());
      if (peek() === '\\limits') { i++; a.lim = 'stack'; Object.assign(a, scripts()); }
      a.body = operand(stop);
      return a;
    }
    const sc = scripts();
    if (sc.sub || sc.sup) a = { t: 'script', base: a, sub: sc.sub, sup: sc.sup };
    if (a.fn || a.base?.fn) {
      delete (a.fn ? a : a.base).fn;
      const x = operand(stop);
      if (x) return { t: 'func', name: a, arg: x };
    }
    return a;
  }

  function delim() {
    const t = tk[i++];
    return DELIMS[t] ?? (t ? t.replace(/^\\/, '') : '');
  }

  function raw() { // the characters of a {...} argument, as typed (\text)
    if (peek() !== '{') return '';
    i++;
    let depth = 1;
    let v = '';
    while (i < tk.length) {
      const t = tk[i++];
      if (t === '{') depth++;
      if (t === '}' && !--depth) break;
      v += t.startsWith('\\') && t.length === 2 ? t[1] : t;
    }
    return v;
  }

  function env(name) {
    const rows = [[]];
    for (;;) {
      rows.at(-1).push(seq(new Set(['&', '\\\\', '\\end'])));
      const t = tk[i++];
      if (t === '&') continue;
      if (t === '\\\\') { rows.push([]); continue; }
      raw(); // {name} of \end
      break;
    }
    if (rows.length > 1 && rows.at(-1).length === 1 && rows.at(-1)[0].t === 'row' && !rows.at(-1)[0].items.length) rows.pop();
    if (name === 'cases') return { t: 'fence', open: '{', close: '', body: { t: 'eqarray', rows } };
    if (/^(aligned|align\*?|array|eqnarray|gathered)$/.test(name)) return { t: 'eqarray', rows };
    const [open, close] = ENVS[name] ?? ['', ''];
    const m = { t: 'matrix', rows };
    return open ? { t: 'fence', open, close, body: m } : m;
  }

  function atom(stop) {
    const t = peek();
    if (t === undefined || stop.has(t)) return null;
    i++;
    if (t === '{') {
      const r = seq(new Set(['}']));
      i++;
      return r;
    }
    if (t in OPENERS || (t === '|' && !stop.has('|'))) {
      const close = OPENERS[t] ?? '|';
      const body = seq(new Set([close, '\\right']));
      if (peek() === close) i++;
      return { t: 'fence', open: DELIMS[t], close: DELIMS[close], body };
    }
    if (!t.startsWith('\\') || t.length === 2 && !/[A-Za-z]/.test(t[1])) {
      if (t === '\\\\') return null;
      if (t.length === 2) return SKIP.has(t[1]) ? null : t === '\\{' || t === '\\}' ? { t: 'mo', v: t[1] } : charNode(t[1]);
      return charNode(t);
    }
    const name = t.slice(1);
    if (SKIP.has(name)) return null;
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') return { t: 'frac', kind: 'bar', num: arg(), den: arg() };
    if (name === 'binom') return { t: 'fence', open: '(', close: ')', body: { t: 'frac', kind: 'noBar', num: arg(), den: arg() } };
    if (name === 'sqrt') {
      let deg = null;
      if (peek() === '[') {
        i++;
        deg = seq(new Set([']']));
        i++;
      }
      return { t: 'sqrt', deg, body: arg() };
    }
    if (name === 'left') {
      const open = delim();
      const body = seq(new Set(['\\right']));
      i++;
      return { t: 'fence', open, close: delim(), body };
    }
    if (name === 'begin') return env(raw());
    if (name === 'text' || name === 'textrm' || name === 'mbox') return { t: 'text', v: raw() };
    if (name === 'operatorname') return { t: 'mi', v: raw(), fn: true };
    if (name in NARY) return { t: 'nary', op: NARY[name], sub: null, sup: null, lim: null, body: null };
    if (name in ACCENTS) return { t: 'accent', ch: ACCENTS[name], base: arg() };
    if (name in BARS) return { t: 'bar', ch: BARS[name], base: arg() };
    if (name === 'boxed') return { t: 'box', boxed: true, body: arg() };
    if (name === 'underset' || name === 'overset') {
      const lim = arg();
      return { t: name === 'underset' ? 'under' : 'over', base: arg(), lim };
    }
    if (FUNCS.has(name)) return { t: 'mi', v: name, fn: true };
    const ch = ENTRY.get(t);
    if (ch && [...ch].length === 1) return charNode(ch);
    return { t: 'text', v: t };
  }

  return clean(seq(new Set()));
}

// Drops the parser's marks.
function clean(n) {
  if (!n || typeof n !== 'object') return n;
  if (Array.isArray(n)) return n.map(clean);
  const { fn, ...rest } = n;
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, clean(v)]));
}

// ---------------------------------------------------------------------------------------------
// Printer

// Character → control word, preferring the shortest plain name (α → \alpha).
const NAME = new Map();
for (const [k, v] of ENTRIES) if ([...v].length === 1 && /^\\[A-Za-z]+$/.test(k) && (!NAME.has(v) || k.length < NAME.get(v).length)) NAME.set(v, k);
const NARY_NAME = Object.fromEntries(Object.entries(NARY).map(([k, v]) => [v, `\\${k}`]));
const ACCENT_NAME = Object.fromEntries(Object.entries(ACCENTS).filter(([k]) => !k.startsWith('wide')).map(([k, v]) => [v, `\\${k}`]));
const BAR_NAME = Object.fromEntries(Object.entries(BARS).map(([k, v]) => [v, `\\${k}`]));
const DELIM_NAME = { '{': '\\{', '}': '\\}', '⟨': '\\langle', '⟩': '\\rangle', '‖': '\\|', '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil', '': '.' };
const ENV_NAME = Object.fromEntries(Object.entries(ENVS).filter(([k]) => k !== 'matrix').map(([k, [o]]) => [o, k]));

const sym = (c) => (/^[\x20-\x7E]$/.test(c) ? (c === '{' || c === '}' ? `\\${c}` : c) : NAME.get(c) ? `${NAME.get(c)} ` : c);
const braced = (n) => `{${latex(n)}}`;
const grid = (rows) => rows.map((r) => r.map(latex).join(' & ')).join(' \\\\ ');

/** Prints the math AST `n` as LaTeX → text parseLatex reads back to the same AST. */
export function latex(n) {
  if (!n) return '';
  switch (n.t) {
    case 'row': return n.items.map(latex).join(' ').replace(/ +/g, ' ').trim();
    case 'mi': return n.v.length > 1 ? (FUNCS.has(n.v) ? `\\${n.v}` : `\\operatorname{${n.v}}`) : sym(n.v);
    case 'mn': return n.v;
    case 'mo': return sym(n.v === '′' ? "'" : n.v);
    case 'text': return `\\text{${n.v}}`;
    case 'ph': return PH;
    case 'frac': return `\\frac${braced(n.num)}${braced(n.den)}`;
    case 'script': return `${n.base.t === 'row' ? braced(n.base) : latex(n.base)}${n.sub ? `_${braced(n.sub)}` : ''}${n.sup ? `^${braced(n.sup)}` : ''}`;
    case 'pre': return `{}${n.sub ? `_${braced(n.sub)}` : ''}${n.sup ? `^${braced(n.sup)}` : ''}${braced(n.base)}`;
    case 'sqrt': return `\\sqrt${n.deg ? `[${latex(n.deg)}]` : ''}${braced(n.body)}`;
    case 'nary': return `${NARY_NAME[n.op] ?? n.op}${n.lim === 'stack' ? '\\limits' : ''}${n.sub ? `_${braced(n.sub)}` : ''}${n.sup ? `^${braced(n.sup)}` : ''}${n.body ? ` ${braced(n.body)}` : ''}`;
    case 'fence': {
      if (n.open === '{' && !n.close && n.body.t === 'eqarray') return `\\begin{cases} ${grid(n.body.rows)} \\end{cases}`;
      if (n.body.t === 'matrix' && ENV_NAME[n.open] && ENVS[ENV_NAME[n.open]][1] === n.close) {
        return `\\begin{${ENV_NAME[n.open]}} ${grid(n.body.rows)} \\end{${ENV_NAME[n.open]}}`;
      }
      return `\\left${DELIM_NAME[n.open] ?? n.open} ${latex(n.body)} \\right${DELIM_NAME[n.close] ?? n.close}`;
    }
    case 'func': return `${latex(n.name)} ${braced(n.arg)}`;
    case 'accent': return ACCENT_NAME[n.ch] ? `${ACCENT_NAME[n.ch]}${braced(n.base)}` : `${braced(n.base)}${n.ch}`;
    case 'bar': return `${BAR_NAME[n.ch] ?? '\\overline'}${braced(n.base)}`;
    case 'under': case 'over': return `\\${n.t}set${braced(n.lim)}${braced(n.base)}`;
    case 'box': return n.boxed ? `\\boxed${braced(n.body)}` : braced(n.body);
    case 'matrix': return `\\begin{matrix} ${grid(n.rows)} \\end{matrix}`;
    case 'eqarray': return `\\begin{aligned} ${grid(n.rows)} \\end{aligned}`;
    default: return '';
  }
}
