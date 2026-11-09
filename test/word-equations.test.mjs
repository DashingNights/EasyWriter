// Equations (docs/plans/word plan.md §3 equations): the UnicodeMath and LaTeX parsers, the MathML and linear printers, Math
// AutoCorrect's data and the Equation tab's templates.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ENTRIES, FUNCTIONS } from '../src/document/wp/equations/data.mjs';
import { latex, parseLatex } from '../src/document/wp/equations/latex.mjs';
import { autoCorrect, fromInput, mmlOf, optionsOf, toInput } from '../src/document/wp/equations/linear.mjs';
import { toMathML } from '../src/document/wp/equations/mathml.mjs';
import { BUILT_INS, STRUCTURES, SYMBOL_SETS } from '../src/document/wp/equations/templates.mjs';
import { normalize, parse, print } from '../src/document/wp/equations/unicodemath.mjs';

/** A MathML string as a compact tag tree: 'mfrac(mi:a,mi:b)'; the math root and one outer mrow are left out. */
function tree(mml) {
  const toks = mml.replace(/^<math[^>]*>|<\/math>$/g, '').match(/<\/?[a-z]+[^>]*?\/?>|[^<]+/g) ?? [];
  const st = [[]];
  for (const t of toks) {
    if (t.startsWith('</')) {
      const kids = st.pop();
      st.at(-1).at(-1).k = kids;
    } else if (t.startsWith('<')) {
      st.at(-1).push({ n: /^<([a-z]+)/.exec(t)[1] });
      if (!t.endsWith('/>')) st.push([]);
    } else {
      const top = st.at(-2)?.at(-1);
      if (top) top.text = t;
    }
  }
  const f = (x) => x.n + (x.k?.length ? `(${x.k.map(f).join(',')})` : x.text !== undefined ? `:${x.text}` : '');
  return st[0].map(f).join(',').replace(/^mrow\((.*)\)$/, '$1');
}

const SAMPLES = [
  ['a/b', 'mfrac(mi:a,mi:b)'],
  ['x^2', 'msup(mi:x,mn:2)'],
  ['x_i^2', 'msubsup(mi:x,mi:i,mn:2)'],
  ['√(x+1)', 'msqrt(mrow(mi:x,mo:+,mn:1))'],
  ['∛x', 'mroot(mi:x,mn:3)'],
  ['∑_(i=1)^n i', 'msubsup(mo:∑,mrow(mi:i,mo:=,mn:1),mi:n),mi:i'],
  ['(a+b)', 'mo:(,mrow(mi:a,mo:+,mi:b),mo:)'],
  ['sin x', 'mi:sin,mo:⁡,mi:x'],
  ['■(a&b@c&d)', 'mtable(mtr(mtd(mi:a),mtd(mi:b)),mtr(mtd(mi:c),mtd(mi:d)))'],
  ['lim┬(n→∞) a_n', 'munder(mi:lim,mrow(mi:n,mo:→,mi:∞)),mo:⁡,msub(mi:a,mi:n)'],
  ['x̂', 'mover(mi:x,mo:ˆ)'],
  ['a⊘b', 'mfrac(mi:a,mi:b)'],
  ['a∕b', 'mi:a,mo:/,mi:b'],
  ['n¦k', 'mfrac(mi:n,mi:k)'],
  ['(n¦k)', 'mo:(,mfrac(mi:n,mi:k),mo:)'],
  ['√(n&x)', 'mroot(mi:x,mi:n)'],
  ['∜y', 'mroot(mi:y,mn:4)'],
  ['_1^n Y', 'mmultiscripts(mi:Y,mprescripts,mn:1,mi:n)'],
  ['e^(-iωt)', 'msup(mi:e,mrow(mo:-,mi:i,mi:ω,mi:t))'],
  ['x_12', 'msub(mi:x,mn:12)'],
  ['∫_0^1 x', 'msubsup(mo:∫,mn:0,mn:1),mi:x'],
  ['∏_(k=1)^n▒A_k', 'msubsup(mo:∏,mrow(mi:k,mo:=,mn:1),mi:n),msub(mi:A,mi:k)'],
  ['[a,b]', 'mo:[,mrow(mi:a,mo:,,mi:b),mo:]'],
  ['{x}', 'mo:{,mi:x,mo:}'],
  ['|x|', 'mo:|,mi:x,mo:|'],
  ['‖v‖', 'mo:‖,mi:v,mo:‖'],
  ['⌊x⌋', 'mo:⌊,mi:x,mo:⌋'],
  ['⟨a│b⟩', 'mo:⟨,mrow(mi:a,mo:│,mi:b),mo:⟩'],
  ['cos⁡2x', 'mi:cos,mo:⁡,mrow(mn:2,mi:x)'],
  ['log_2⁡x', 'msub(mi:log,mn:2),mo:⁡,mi:x'],
  ['A⃗', 'mover(mi:A,mo:→)'],
  ['¯(AB)', 'mover(mrow(mi:A,mi:B),mo:¯)'],
  ['▁x', 'munder(mi:x,mo:_)'],
  ['▭(E=mc^2)', 'menclose(mrow(mi:E,mo:=,mi:m,msup(mi:c,mn:2)))'],
  ['█(a=1@b=2)', 'mtable(mtr(mtd(mrow(mi:a,mo:=,mn:1))),mtr(mtd(mrow(mi:b,mo:=,mn:2))))'],
  ['"if "x', 'mtext:if ,mi:x'],
  ['x→┴f y', 'mi:x,mover(mo:→,mi:f),mi:y'],
  ['⏞(a+b)┴n', 'mover(mover(mrow(mi:a,mo:+,mi:b),mo:⏞),mi:n)'],
  ['2x+3=7', 'mn:2,mi:x,mo:+,mn:3,mo:=,mn:7'],
  ['x=(-b±√(b^2-4ac))/2a', 'mi:x,mo:=,mfrac(mrow(mo:-,mi:b,mo:±,msqrt(mrow(msup(mi:b,mn:2),mo:-,mn:4,mi:a,mi:c))),mrow(mn:2,mi:a))'],
];

const roundTrips = (s) => assert.deepEqual(normalize(parse(print(parse(s)))), normalize(parse(s)), `${s} → ${print(parse(s))}`);

test('UnicodeMath samples give their MathML trees and print back to the same AST', () => {
  assert.equal(SAMPLES.length, 40);
  for (const [s, want] of SAMPLES) {
    assert.equal(tree(toMathML(parse(s))), want, s);
    roundTrips(s);
  }
});

test('n-ary limits stack in display equations per naryLim and stay at the side inline; integrals follow intLim', () => {
  assert.equal(tree(toMathML(parse('∑_(i=1)^n i'), { display: true })), 'munderover(mo:∑,mrow(mi:i,mo:=,mn:1),mi:n),mi:i');
  assert.match(tree(toMathML(parse('∑_(i=1)^n i'), { display: true, naryLim: 'subSup' })), /^msubsup/);
  assert.match(tree(toMathML(parse('∫_0^1 x'), { display: true })), /^msubsup/);
  assert.match(tree(toMathML(parse('∫_0^1 x'), { display: true, intLim: 'undOvr' })), /^munderover/);
  assert.match(toMathML(parse('a'), { display: true }), /display="block"/);
});

test('brackets are stretchy fence operators; function names apply with U+2061', () => {
  assert.match(toMathML(parse('(a+b)')), /<mo fence="true" stretchy="true">\(<\/mo>/);
  assert.match(toMathML(parse('sin x')), /<mi>sin<\/mi><mo>⁡<\/mo>/);
});

const PAIRS = [
  ['\\frac{a}{b}', 'a/b'], ['x^{2}', 'x^2'], ['x_i^2', 'x_i^2'], ['\\sqrt{x+1}', '√(x+1)'], ['\\sqrt[3]{x}', '∛x'],
  ['\\sum_{i=1}^{n} i', '∑_(i=1)^n i'], ['\\left( a+b \\right)', '(a+b)'], ['(a+b)', '(a+b)'], ['\\sin x', 'sin x'],
  ['\\begin{matrix} a & b \\\\ c & d \\end{matrix}', '■(a&b@c&d)'], ['\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', '(■(a&b@c&d))'],
  ['\\begin{bmatrix} 1 & 0 \\\\ 0 & 1 \\end{bmatrix}', '[■(1&0@0&1)]'], ['\\alpha + \\beta = \\gamma', 'α+β=γ'], ['\\int_0^1 x', '∫_0^1 x'],
  ['\\prod_{k=1}^{n} A_k', '∏_(k=1)^n▒A_k'], ['\\lim_{n \\to \\infty} a_n', 'lim_(n→∞)⁡a_n'], ['\\hat{x}', 'x̂'],
  ['\\dfrac{-b \\pm \\sqrt{b^2-4ac}}{2a}', '(-b±√(b^2-4ac))/2a'], ['\\begin{cases} x & y \\\\ z & w \\end{cases}', '{█(x&y@z&w)┤'],
  ['\\iint x \\, dx', '∬▒x d x'],
];

test('LaTeX and UnicodeMath pairs give equal ASTs, and the LaTeX printer reads back', () => {
  assert.equal(PAIRS.length, 20);
  for (const [tex, um] of PAIRS) {
    assert.deepEqual(normalize(parseLatex(tex)), normalize(parse(um)), tex);
    assert.deepEqual(normalize(parseLatex(latex(parse(um)))), normalize(parse(um)), `latex of ${um}: ${latex(parse(um))}`);
  }
  assert.equal(fromInput('\\frac{1}{2} ', 'latex'), '1/2');
  assert.equal(fromInput(toInput('x^2+1', 'latex'), 'latex'), 'x^2+1');
});

test('Math AutoCorrect data holds Word\'s 496 entries and 55 functions', () => {
  // Word's own list (probe/omath-entries.tsv and the AutoCorrect dialog's 496 rows); the brief said 495.
  assert.equal(ENTRIES.length, 496);
  assert.equal(FUNCTIONS.length, 55);
  const map = new Map(ENTRIES);
  assert.equal(map.get('\\alpha'), 'α');
  assert.equal(map.get('->'), '→');
  assert.equal(map.get('\\binomial'), '(a+b)^n=∑_(k=0)^n ▒(n¦k)a^k b^(n-k)');
  const { entries } = optionsOf(null);
  assert.deepEqual(autoCorrect('x+\\alpha', entries), { len: 6, value: 'α' });
  assert.deepEqual(autoCorrect('a->', entries), { len: 2, value: '→' });
  assert.equal(autoCorrect('\\nosuch', entries), null);
  assert.equal(print(parse('\\alpha+\\beta')), 'α+β');
  for (const fn of FUNCTIONS) assert.equal(parse(`${fn} x`).t, 'func', fn);
});

test('every Structures template, built-in equation and AutoCorrect template parses and prints back', () => {
  const all = [...BUILT_INS, ...Object.values(STRUCTURES).flat()];
  assert.equal(BUILT_INS.length, 9);
  for (const it of all) {
    assert.ok(mmlOf(it.math)?.startsWith('<math'), it.label);
    roundTrips(it.math);
  }
  for (const [k, v] of ENTRIES) if ([...v].length > 1 && k !== '\\lbrace') roundTrips(v);
  for (const items of Object.values(STRUCTURES)) assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  assert.equal(Object.keys(SYMBOL_SETS).length, 8);
  assert.equal(SYMBOL_SETS.basicMath.items.length, 71);
  assert.equal(SYMBOL_SETS.basicMath.items[0].ch, '±');
});
