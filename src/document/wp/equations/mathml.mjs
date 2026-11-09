// The math AST (unicodemath.mjs) as Presentation MathML (docs/plans/word plan.md §3 equations): what the equation node view
// draws and what its mml attribute caches for copies. Display equations stack n-ary limits per m:limLoc (the AST's 'stack'),
// else per m:naryLim (integrals per m:intLim), as Word's Equation Options set them. Inline ones keep them at the side even
// when stacked, as Word draws an inline equation (the stored math keeps 'stack' for when it becomes display).

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const el = (tag, body, attrs = '') => `<${tag}${attrs}>${body}</${tag}>`;
const INTEGRALS = new Set([...'∫∬∭∮∯∰∱∲∳']);
// Combining marks drawn as their spacing forms over the base (MathML accents are characters, not combining marks).
const ACCENT = { '̀': '`', '́': '´', '̂': 'ˆ', '̃': '˜', '̄': '¯', '̅': '¯', '̆': '˘', '̇': '˙',
  '̈': '¨', '̌': 'ˇ', '̿': '‗', '⃖': '←', '⃗': '→', '⃡': '↔', '⃐': '↼', '⃑': '⇀', '⃛': '⃛' };
const BAR_CH = { '¯': '¯', '▁': '_', '⏞': '⏞', '⏟': '⏟', '⏜': '⏜', '⏝': '⏝' };
const UNDER = new Set(['▁', '⏟', '⏝']);

/** `ast` as a MathML element string. Options: display (block equation), naryLim and intLim ('undOvr' or 'subSup', m:mathPr). */
export function toMathML(ast, { display = false, naryLim = 'undOvr', intLim = 'subSup' } = {}) {
  const o = { display, naryLim, intLim };
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}>${node(ast, o)}</math>`;
}

const wrap = (n, o) => (n.t === 'row' ? el('mrow', n.items.map((x) => node(x, o)).join('')) : node(n, o));
const mo = (v, attrs = '') => el('mo', esc(v), attrs);

function node(n, o) {
  if (!n) return '<mrow></mrow>';
  switch (n.t) {
    case 'row': return n.items.length === 1 ? node(n.items[0], o) : el('mrow', n.items.map((x) => node(x, o)).join(''));
    case 'mi': return el('mi', esc(n.v));
    case 'mn': return el('mn', esc(n.v));
    case 'mo': return mo(n.v);
    case 'text': return el('mtext', esc(n.v));
    case 'ph': return el('mi', '⬚', ' mathvariant="normal" class="eq-ph"');
    case 'frac':
      if (n.kind === 'lin') return el('mrow', wrap(n.num, o) + mo('/') + wrap(n.den, o));
      return el('mfrac', wrap(n.num, o) + wrap(n.den, o), n.kind === 'skew' ? ' bevelled="true"' : n.kind === 'noBar' ? ' linethickness="0"' : '');
    case 'script': {
      const b = wrap(n.base, o);
      if (n.sub && n.sup) return el('msubsup', b + wrap(n.sub, o) + wrap(n.sup, o));
      return n.sub ? el('msub', b + wrap(n.sub, o)) : el('msup', b + wrap(n.sup, o));
    }
    case 'pre':
      return el('mmultiscripts', `${wrap(n.base, o)}<mprescripts/>${n.sub ? wrap(n.sub, o) : '<none/>'}${n.sup ? wrap(n.sup, o) : '<none/>'}`);
    case 'sqrt': return n.deg ? el('mroot', wrap(n.body, o) + wrap(n.deg, o)) : el('msqrt', wrap(n.body, o));
    case 'nary': {
      const op = mo(n.op, ' largeop="true"');
      const lim = INTEGRALS.has(n.op) ? o.intLim : o.naryLim;
      const stack = o.display && (n.lim === 'stack' || lim === 'undOvr');
      let head = op;
      if (n.sub || n.sup) {
        const [both, lo, hi] = stack ? ['munderover', 'munder', 'mover'] : ['msubsup', 'msub', 'msup'];
        if (n.sub && n.sup) head = el(both, op + wrap(n.sub, o) + wrap(n.sup, o));
        else head = n.sub ? el(lo, op + wrap(n.sub, o)) : el(hi, op + wrap(n.sup, o));
      }
      return el('mrow', head + (n.body ? wrap(n.body, o) : ''));
    }
    case 'fence':
      return el('mrow', (n.open ? mo(n.open, ' fence="true" stretchy="true"') : '') + wrap(n.body, o)
        + (n.close ? mo(n.close, ' fence="true" stretchy="true"') : ''));
    case 'func': return el('mrow', wrap(n.name, o) + mo('⁡') + wrap(n.arg, o));
    case 'accent': {
      const ch = ACCENT[n.ch] ?? n.ch;
      return el('mover', wrap(n.base, o) + mo(ch, ' stretchy="true"'), ' accent="true"');
    }
    case 'bar': {
      const under = UNDER.has(n.ch);
      return el(under ? 'munder' : 'mover', wrap(n.base, o) + mo(BAR_CH[n.ch] ?? n.ch, ' stretchy="true"'), under ? ' accentunder="true"' : ' accent="true"');
    }
    case 'under': return el('munder', wrap(n.base, o) + wrap(n.lim, o));
    case 'over': return el('mover', wrap(n.base, o) + wrap(n.lim, o));
    case 'box': return n.boxed ? el('menclose', wrap(n.body, o), ' notation="box"') : el('mrow', wrap(n.body, o));
    case 'matrix': case 'eqarray':
      return el('mtable', n.rows.map((r) => el('mtr', r.map((c) => el('mtd', wrap(c, o))).join(''))).join(''),
        n.t === 'eqarray' ? ' columnalign="left"' : '');
    default: return '';
  }
}
