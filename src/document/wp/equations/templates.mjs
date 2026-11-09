// The Equation tab's galleries as UnicodeMath (docs/plans/word plan.md §3 equations): the nine built-in equations, every
// Structures menu by Word's headings (probe/menus/equation.equation.<name>.json; Integral from Word's list, which the probe
// could not read) and the Symbols sets. ⬚ is a placeholder; a structure inserted into an equation selects its first one.
// Item ids are the camelCase of Word's labels.

const camel = (label) => label.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/)
  .map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join('');
/** [[heading, [[label, math]...]]...] → gallery items {id, label, group, math}. */
const items = (groups) => groups.flatMap(([group, list]) => list.map(([label, math]) => ({ id: camel(label), label, group, math })));

export const BUILT_INS = items([['Built-In', [
  ['Area of Circle', 'A=πr^2'],
  ['Binomial Theorem', '(x+a)^n=∑_(k=0)^n▒(n¦k) x^k a^(n-k)'],
  ['Expansion of a Sum', '(1+x)^n=1+nx/1!+(n(n-1)x^2)/2!+⋯'],
  ['Fourier Series', 'f(x)=a_0+∑_(n=1)^∞▒(a_n cos⁡〖nπx/L〗+b_n sin⁡〖nπx/L〗)'],
  ['Pythagorean Theorem', 'a^2+b^2=c^2'],
  ['Quadratic Formula', 'x=(-b±√(b^2-4ac))/2a'],
  ['Taylor Expansion', 'e^x=1+x/1!+x^2/2!+x^3/3!+⋯,    -∞<x<∞'],
  ['Trig Identity 1', 'sin⁡α±sin⁡β=2 sin⁡〖1/2 (α±β)〗 cos⁡〖1/2 (α∓β)〗'],
  ['Trig Identity 2', 'cos⁡α+cos⁡β=2 cos⁡〖1/2 (α+β)〗 cos⁡〖1/2 (α-β)〗'],
]]]);

const NARY_OPS = [['Summation', '∑'], ['Product', '∏'], ['CoProduct', '∐'], ['Union', '⋃'], ['Intersection', '⋂'], ['Logical Or', '⋁'], ['Logical And', '⋀']];
const naryRun = (name, op) => [[name, `${op}▒⬚`], [`${name} with Limits`, `${op}┬⬚┴⬚▒⬚`], [`${name} with Subscript/Superscript Limits`, `${op}_⬚^⬚▒⬚`],
  [`${name} with Lower Limit`, `${op}┬⬚▒⬚`], [`${name} with Subscript Lower Limit`, `${op}_⬚▒⬚`]];
const INTEGRALS = [['Integral', '∫'], ['Double Integral', '∬'], ['Triple Integral', '∭'], ['Contour Integral', '∮'], ['Surface Integral', '∯'], ['Volume Integral', '∰']];
const intRun = (name, op) => [[name, `${op}▒⬚`], [`${name} with Limits`, `${op}_⬚^⬚▒⬚`], [`${name} with Stacked Limits`, `${op}┬⬚┴⬚▒⬚`]];
const fn = (names, inverse) => names.map(([label, f]) => [`${inverse ? 'Inverse ' : ''}${label} Function`, `${f}${inverse ? '^(-1)' : ''}⁡⬚`]);
const TRIG = [['Sine', 'sin'], ['Cosine', 'cos'], ['Tangent', 'tan'], ['Cosecant', 'csc'], ['Secant', 'sec'], ['Cotangent', 'cot']];
const HYP = TRIG.map(([l, f]) => [`Hyperbolic ${l}`, `${f}h`]);
const BRACKETS = [['Parentheses', '(', ')'], ['Square Brackets', '[', ']'], ['Curly Braces', '{', '}'], ['Angle Brackets', '⟨', '⟩'],
  ['Floor Brackets', '⌊', '⌋'], ['Ceiling Brackets', '⌈', '⌉'], ['Vertical Bars', '|', '|'], ['Double Vertical Bars', '‖', '‖'], ['Double Brackets', '⟦', '⟧']];
const SINGLES = [['Parenthesis', '(', ')'], ['Bracket', '[', ']'], ['Brace', '{', '}'], ['Angle Bracket', '⟨', '⟩'], ['Floor Bracket', '⌊', '⌋'],
  ['Ceiling Bracket', '⌈', '⌉'], ['Vertical Bar', '|', '|'], ['Double Vertical Bar', '‖', '‖'], ['Double Bracket', '⟦', '⟧']];
const ARROWS = [['Leftwards Arrow', '←'], ['Rightwards Arrow', '→'], ['Leftwards Double Arrow', '⇐'], ['Rightwards Double Arrow', '⇒'],
  ['Left-Right Arrow', '↔'], ['Left-Right Double Arrow', '⇔']];
const m = (r, c, cell = () => '⬚') => `■(${Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => cell(i, j)).join('&')).join('@')})`;

/** Structures gallery id → items. */
export const STRUCTURES = {
  'equation.structures.fraction': items([
    ['Fraction', [['Stacked Fraction', '⬚/⬚'], ['Skewed Fraction', '⬚⊘⬚'], ['Linear Fraction', '⬚∕⬚'], ['Small Fraction', '⬚/⬚']]],
    ['Common Fraction', [['dy over dx', 'ⅆy/ⅆx'], ['cap delta y over cap delta x', 'Δy/Δx'], ['partial y over partial x', '∂y/∂x'],
      ['delta y over delta x', 'δy/δx'], ['pi Over 2', 'π/2']]],
  ]),
  'equation.structures.script': items([
    ['Subscripts and Superscripts', [['Superscript', '⬚^⬚'], ['Subscript', '⬚_⬚'], ['Subscript-Superscript', '⬚_⬚^⬚'], ['Left Subscript-Superscript', '_⬚^⬚⬚']]],
    ['Common Subscripts and Superscripts', [['x subscript y squared', 'x_y^2'], ['e to the minus i omega t', 'e^(-iωt)'], ['x squared', 'x^2'],
      ['Y left superscript n left subscript one', '_1^n Y']]],
  ]),
  'equation.structures.radical': items([
    ['Radicals', [['Square Root', '√⬚'], ['Radical With Degree', '√(⬚&⬚)'], ['Square Root With Degree', '√(2&⬚)'], ['Cubic Root', '∛⬚']]],
    ['Common Radicals', [['Right hand side of Quadratic Formula', '(-b±√(b^2-4ac))/2a'], ['Square root of a squared plus b squared', '√(a^2+b^2)']]],
  ]),
  'equation.structures.integral': items([
    ['Integrals', INTEGRALS.slice(0, 3).flatMap(([n, op]) => intRun(n, op))],
    ['Contour Integrals', INTEGRALS.slice(3).flatMap(([n, op]) => intRun(n, op))],
    ['Differentials', [['Differential x', 'ⅆx'], ['Differential y', 'ⅆy'], ['Differential theta', 'ⅆθ']]],
  ]),
  'equation.structures.largeOperator': items([
    ['Summations', naryRun(...NARY_OPS[0])],
    ['Products and Co-Products', [...naryRun(...NARY_OPS[1]), ...naryRun(...NARY_OPS[2])]],
    ['Unions and Intersections', [...naryRun(...NARY_OPS[3]), ...naryRun(...NARY_OPS[4])]],
    ['Other Large Operators', [...naryRun(...NARY_OPS[5]), ...naryRun(...NARY_OPS[6])]],
    ['Common Large Operators', [['Summation over k of n choose k', '∑_k▒(n¦k)'], ['Summation from i equal zero to n', '∑_(i=0)^n▒⬚'],
      ['Summation example using two indices', '∑_(█(0≤i≤m@0<j<n))▒P(i,j)'], ['Product example', '∏_(k=1)^n▒A_k'],
      ['Union example', '⋃_(n=1)^m▒(X_n∩Y_n)']]],
  ]),
  'equation.structures.bracket': items([
    ['Brackets', [...BRACKETS.slice(0, 8).map(([l, o, c]) => [l, `${o}⬚${c}`]), ['Placeholder between two Left Brackets', '├[⬚┤['],
      ['Placeholder between two Right Brackets', '├]⬚┤]'], ['Inverted Brackets', '├]⬚┤['], ['Double Brackets', '⟦⬚⟧']]],
    ['Brackets with Separators', [['Brackets with Separators', '(⬚│⬚)'], ['Braces with Separator', '{⬚│⬚}'], ['Angle Brackets with Separator', '⟨⬚│⬚⟩'],
      ['Angle Brackets with two Separators', '⟨⬚│⬚│⬚⟩']]],
    ['Single Brackets', SINGLES.flatMap(([l, o, c]) => [[`Left ${l} Only`, `├${o}⬚┤`], [`Right ${l} Only`, `├⬚┤${c}`]])],
    ['Cases and Stacks', [['Cases (Two Conditions)', '{█(⬚@⬚)┤'], ['Cases (Three Conditions)', '{█(⬚@⬚@⬚)┤'], ['Stack Object', '⬚¦⬚'],
      ['Stack Object in Parentheses', '(⬚¦⬚)']]],
    ['Common Brackets', [['Example equation using Cases', 'f(x)={█(-x,&x<0@x,&x≥0)┤'], ['Binomial Coefficient', '(n¦k)'],
      ['Binomial Coefficient in Angle Brackets', '⟨n¦k⟩']]],
  ]),
  'equation.structures.function': items([
    ['Trigonometric Functions', fn(TRIG, false)],
    ['Inverse Functions', fn(TRIG, true)],
    ['Hyperbolic Functions', fn(HYP, false)],
    ['Inverse Hyperbolic Functions', fn(HYP, true)],
    ['Common Functions', [['Sin θ', 'sin⁡θ'], ['Cos 2x', 'cos⁡2x'], ['Tangent formula', 'tan⁡θ=sin⁡θ/cos⁡θ']]],
  ]),
  'equation.structures.accent': items([
    ['Accents', [['Dot', '⬚̇'], ['Double Dot', '⬚̈'], ['Triple Dot', '⬚⃛'], ['Hat', '⬚̂'], ['Check', '⬚̌'], ['Acute', '⬚́'], ['Grave', '⬚̀'], ['Breve', '⬚̆'],
      ['Tilde', '⬚̃'], ['Bar', '⬚̅'], ['Double Overbar', '⬚̿'], ['Overbrace', '⏞⬚'], ['Underbrace', '⏟⬚'], ['Grouping Character Above', '⏞⬚┴⬚'],
      ['Grouping Character Below', '⏟⬚┬⬚'], ['Leftwards Arrow Above', '⬚⃖'], ['Rightwards Arrow Above', '⬚⃗'], ['Left-Right Arrow Above', '⬚⃡'],
      ['Leftwards Harpoon Above', '⬚⃐'], ['Rightwards Harpoon Above', '⬚⃑']]],
    ['Boxed Formulas', [['Boxed Formula (With Placeholder)', '▭⬚'], ['Boxed Formula (Example)', '▭(a^2=b^2+c^2)']]],
    ['Overbars and Underbars', [['Overbar', '¯⬚'], ['Underbar', '▁⬚']]],
    ['Common Accent Objects', [['Vector A', 'A⃗'], ['ABC With Overbar', '¯(ABC)'], ['x XOR y With Overbar', '¯(x⊕y)']]],
  ]),
  'equation.structures.limitAndLog': items([
    ['Functions', [['Logarithm with Empty Base', 'log_⬚⁡⬚'], ['Logarithm with No Base', 'log⁡⬚'], ['Limit', 'lim┬⬚⁡⬚'], ['Minimum', 'min┬⬚⁡⬚'],
      ['Maximum', 'max┬⬚⁡⬚'], ['Natural Logarithm', 'ln⁡⬚']]],
    ['Common Functions', [['Limit Example', 'lim┬(n→∞)⁡〖(1+1/n)^n〗'], ['Maximum Example', 'max┬(0≤x≤1)⁡〖x e^(-x^2)〗']]],
  ]),
  'equation.structures.operator': items([
    ['Basic Operators', [['Colon Equal', '≔'], ['Equal Equal', '=='], ['Plus Equal', '+='], ['Minus Equal', '-='], ['Equal To By Definition', '≝'],
      ['Measured By', '≞'], ['Delta Equal To', '≜']]],
    ['Operator Structures', ARROWS.flatMap(([l, a]) => [[`${l} Above`, `${a}┴⬚`], [`${l} Below`, `${a}┬⬚`]])],
    ['Common Operator Structures', [['Yields', '→┴"yields"'], ['Delta Yields', '→┴Δ']]],
  ]),
  'equation.structures.matrix': items([
    ['Empty Matrices', [[1, 2], [2, 1], [1, 3], [3, 1], [2, 2], [2, 3], [3, 2], [3, 3]].map(([r, c]) => [`${r}x${c} Empty Matrix`, m(r, c)])],
    ['Dots', [['Midline Dots', '⋯'], ['Baseline Dots', '…'], ['Vertical Dots', '⋮'], ['Diagonal Dots', '⋱']]],
    ['Identity Matrices', [['2x2 Identity Matrix with Zeros', m(2, 2, (i, j) => (i === j ? '1' : '0'))],
      ['2x2 Identity Matrix with blank off-diagonal cells', m(2, 2, (i, j) => (i === j ? '1' : ''))],
      ['3x3 Identity Matrix with Zeros', m(3, 3, (i, j) => (i === j ? '1' : '0'))],
      ['3x3 Identity Matrix with blank off-diagonal cells', m(3, 3, (i, j) => (i === j ? '1' : ''))]]],
    ['Matrices with Brackets', [['Empty 2 by 2 Matrix in Parentheses', `(${m(2, 2)})`], ['Empty 2 by 2 Matrix in Brackets', `[${m(2, 2)}]`],
      ['Empty 2 by 2 Determinant', `|${m(2, 2)}|`], ['Empty 2 by 2 Matrix in Double Vertical Bars', `‖${m(2, 2)}‖`]]],
    ['Sparse Matrices', [['Sparse Matrix in Parentheses', '(■(a_11&⋯&a_1n@⋮&⋱&⋮@a_m1&⋯&a_mn))'],
      ['Sparse Matrix in Brackets', '[■(a_11&⋯&a_1n@⋮&⋱&⋮@a_m1&⋯&a_mn)]']]],
  ]),
};

// ---------------------------------------------------------------------------------------------
// Symbols: the Basic Math set in the probe's order and names; the other sets are their Unicode characters.

const sym = (chars, names = []) => [...chars].map((ch, k) => ({ id: `u${ch.codePointAt(0).toString(16)}`, label: names[k] ?? ch, ch }));
const range = (from, n, holes = {}) => Array.from({ length: n }, (_, k) => holes[k] ?? String.fromCodePoint(from + k)).join('');
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Mathematical alphanumeric capitals with the letters Unicode keeps in Letterlike Symbols.
const SCRIPT = range(0x1D49C, 26, { 1: 'ℬ', 4: 'ℰ', 5: 'ℱ', 7: 'ℋ', 8: 'ℐ', 11: 'ℒ', 12: 'ℳ', 17: 'ℛ' });
const FRAKTUR = range(0x1D504, 26, { 2: 'ℭ', 7: 'ℌ', 8: 'ℑ', 17: 'ℜ', 25: 'ℨ' });
const DOUBLE = range(0x1D538, 26, { 2: 'ℂ', 7: 'ℍ', 13: 'ℕ', 15: 'ℙ', 16: 'ℚ', 17: 'ℝ', 25: 'ℤ' });

const BASIC = ['±Plus Minus', '∞Infinity', '=Equal', '≠Not Equal To', '~Approximately', '×Multiplication Sign', '÷Division Sign', '!Factorial',
  '∝Proportional To', '<Less Than', '≪Much Less Than', '>Greater Than', '≫Much Greater Than', '≤Less Than or Equal To', '≥Greater Than or Equal To',
  '∓Minus Plus', '≅Approximately Equal To', '≈Almost Equal To (Asymptotic To)', '≡Identical To', '∀For All', '∁Complement', '∂Partial Differential',
  '√Radical Sign', '∛Cube Root', '∜Fourth Root', '∪Union', '∩Intersection', '∅Empty Set', '%Percentage', '°Degrees', '℉Degrees Fahrenheit',
  '℃Degrees Celsius', '∆Increment', '∇Nabla', '∃There Exists', '∄There Does Not Exist', '∈Element Of', '∋Contains as Member', '←Left Arrow',
  '↑Up Arrow', '→Right Arrow', '↓Down Arrow', '↔Left-Right Arrow', '∴Therefore', '+Plus', '−Minus', '¬Not Sign', 'αAlpha', 'βBeta', 'γGamma',
  'δDelta', 'εEpsilon', 'ϵEpsilon Variant', 'θTheta', 'ϑTheta Variant', 'μMu', 'πPi', 'ρRho', 'σSigma', 'τTau', 'φPhi', 'ωOmega',
  '∗Asterisk Operator', '∙Bullet Operator', '⋮Vertical Ellipsis', '⋯Midline Horizontal Ellipsis', '⋰Up Right Diagonal Ellipsis',
  '⋱Down Right Diagonal Ellipsis', 'ℵAlef', 'ℶBet', '∎End of Proof (Q.E.D.)'];

/** Symbol set id → {label, items [{id, label, ch}]}. */
export const SYMBOL_SETS = {
  basicMath: { label: 'Basic Math', items: sym(BASIC.map((s) => [...s][0]).join(''), BASIC.map((s) => s.slice([...s][0].length))) },
  greekLetters: { label: 'Greek Letters', items: sym('αβγδεϵζηθϑικλμνξοπϖρϱσςτυφϕχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ') },
  letterLikeSymbols: { label: 'Letter-Like Symbols', items: sym('∀∁ℂ∂ðℇϜℱℊℋℌℍℎℏℐℑıȷℒℓℕ℘ℙℚℛℜℝℤ℧Åℬℭℯℰℳℴℵℶℷℸ') },
  operators: { label: 'Operators', items: sym('+−±∓×÷∗∘∙⋅√∑∏∫∩∪∧∨⊕⊗⊖⊙=≠<>≤≥≈≅≡∼≃∝≪≫∈∉⊂⊃⊆⊇∣∥⊥∠≔≝≟⊢⊣⊤') },
  arrows: { label: 'Arrows', items: sym('←→↑↓↔↕⇐⇒⇑⇓⇔⇕⟵⟶⟷⟸⟹⟺↦↤↩↪↼⇀↽⇁⇌⇋↗↖↘↙') },
  negatedRelations: { label: 'Negated Relations', items: sym('≠≮≯≰≱≢≁≄≉≇∉∌⊄⊅⊈⊉∤∦⊀⊁⋠⋡⋢⋣') },
  scripts: { label: 'Scripts', items: sym(SCRIPT + FRAKTUR + DOUBLE, ['Script', 'Fraktur', 'Double-struck'].flatMap((k) => [...ALPHA].map((c) => `${k} ${c}`))) },
  geometry: { label: 'Geometry', items: sym('∟∠∡∢⊾⊿⋕⊥∤∥∦∶∷∴∵∎⊡△▭○◇') },
};
