// The EQ field's legacy layout as MathML Core (docs/plans/word/plan.md §3 fields-draw; Word's rules in index-fields.md EQ).
// \a array, \b brackets, \d displace, \f fraction, \i integral, \l list, \o overstrike, \r radical, \s script, \x box. Switch
// letters ignore case, arguments split on commas, \, \( \) and \\ are literal, and EQ nests. Any error is Word's bold "Error!".
// Pure: code in, a MathML string out.

const OPTS = {
  a: ['al', 'ac', 'ar', 'co', 'vs', 'hs'], b: ['lc', 'rc', 'bc'], d: ['fo', 'ba', 'li'], f: [], i: ['su', 'pr', 'in', 'fc', 'vc'], l: [],
  o: ['al', 'ac', 'ar'], r: [], s: ['up', 'do', 'ai', 'di'], x: ['to', 'bo', 'le', 'ri'],
};
const CHAR_OPTS = new Set(['lc', 'rc', 'bc', 'fc', 'vc']);
const NUM_OPTS = new Set(['co', 'vs', 'hs', 'fo', 'ba', 'up', 'do', 'ai', 'di']);
// How many arguments each command takes: [min, max].
const ARITY = { a: [1, Infinity], b: [1, 1], d: [0, 1], f: [2, 2], i: [3, 3], l: [0, Infinity], o: [1, Infinity], r: [1, 2], s: [1, 2], x: [1, 1] };

/** The characters Enclose Characters puts around a character. */
export const ENCLOSURES = ['○', '□', '△', '◇'];

class EqError extends Error {}
const fail = () => {
  throw new EqError('Error!');
};

/** The EQ code `code` (with or without its EQ name) → its nodes: {t: 'text', s} and {t: 'cmd', c, opts, args: nodes[][]}. Throws
 * EqError on a syntax error. */
export function parseEq(code) {
  const s = String(code ?? '').replace(/^\s*EQ\b/i, '').trim();
  let i = 0;
  const seq = (inArgs) => {
    const out = [];
    let depth = 0;
    const text = (ch) => {
      const last = out.at(-1);
      if (last?.t === 'text') last.s += ch;
      else out.push({ t: 'text', s: ch });
    };
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\') {
        const next = s[i + 1];
        if (next === undefined) fail();
        if (/[a-z]/i.test(next)) out.push(command());
        else {
          text(next);
          i += 2;
        }
        continue;
      }
      if (inArgs && depth === 0 && (ch === ',' || ch === ')')) break;
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      text(ch);
      i++;
    }
    return out;
  };
  const command = () => {
    const c = s[i + 1].toLowerCase();
    if (!OPTS[c]) fail();
    i += 2;
    const opts = {};
    for (;;) {
      while (s[i] === ' ') i++;
      const name = s[i] === '\\' ? s.slice(i + 1, i + 3).toLowerCase() : '';
      if (!name || !OPTS[c].includes(name)) break;
      i += 3;
      if (CHAR_OPTS.has(name)) {
        if (s[i] === '\\') i++;
        if (i >= s.length) fail();
        opts[name] = s[i++];
      } else if (NUM_OPTS.has(name)) {
        const m = /^\d+(\.\d+)?/.exec(s.slice(i));
        opts[name] = m ? Number(m[0]) : null;
        i += m ? m[0].length : 0;
      } else opts[name] = true;
    }
    while (s[i] === ' ') i++;
    if (s[i] !== '(') fail();
    i++;
    const args = [];
    for (;;) {
      args.push(seq(true));
      if (s[i] === ',') i++;
      else if (s[i] === ')') {
        i++;
        break;
      } else fail(); // a missing parenthesis
    }
    if (args.length === 1 && !args[0].length && ARITY[c][0] === 0) args.length = 0;
    if (args.length < ARITY[c][0] || args.length > ARITY[c][1]) fail();
    return { t: 'cmd', c, opts, args };
  };
  return seq(false);
}

const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const MIRROR = { '(': ')', '[': ']', '{': '}', '<': '>', '〈': '〉', ')': '(', ']': '[', '}': '{', '>': '<' };
const ENCLOSE_SCALE = { '○': 1.6, '□': 2, '△': 2, '◇': 1.9 };
const ALIGN = (o) => (o.al ? 'left' : o.ar ? 'right' : 'center');

/** Nodes → MathML (without the <math> element). */
function ml(nodes) {
  const parts = nodes.map(one);
  return parts.length === 1 ? parts[0] : `<mrow>${parts.join('')}</mrow>`;
}
const row = (nodes) => `<mrow>${nodes.map(one).join('')}</mrow>`;
const mo = (ch, attrs = '') => `<mo${attrs}>${esc(ch)}</mo>`;

function one(n) {
  // Text keeps its spaces: MathML trims and collapses them, so they go in as no-break spaces.
  if (n.t === 'text') return `<mtext>${esc(n.s.replace(/ /g, ' '))}</mtext>`;
  const { c, opts: o, args } = n;
  switch (c) {
    case 'f':
      return `<mfrac>${row(args[0])}${row(args[1])}</mfrac>`;
    case 'r':
      return args.length === 2 && args[0].length ? `<mroot>${row(args[1])}${row(args[0])}</mroot>` : `<msqrt>${row(args.at(-1))}</msqrt>`;
    case 'a': {
      const cols = Math.max(1, o.co ?? 1);
      const pad = `padding:${(o.vs ?? 0) / 2}pt ${(o.hs ?? 0) / 2 + 2}pt;text-align:${ALIGN(o)}`;
      const rows = [];
      for (let k = 0; k < args.length; k += cols) {
        rows.push(`<mtr>${args.slice(k, k + cols).map((a) => `<mtd style="${pad}">${row(a)}</mtd>`).join('')}</mtr>`);
      }
      return `<mtable>${rows.join('')}</mtable>`;
    }
    case 'b': {
      let l = o.lc ?? null;
      let r = o.rc ?? null;
      if (o.bc) {
        l = o.bc;
        r = MIRROR[o.bc] ?? o.bc;
      }
      if (l == null && r == null) {
        l = '(';
        r = ')';
      }
      const st = ' stretchy="true" symmetric="true"';
      return `<mrow>${l != null ? mo(l, `${st} form="prefix"`) : ''}${row(args[0])}${r != null ? mo(r, `${st} form="postfix"`) : ''}</mrow>`;
    }
    case 'd': {
      const fo = o.fo ?? 0;
      const ba = o.ba ?? 0;
      const line = o.li ? 'border-bottom:1px solid currentColor;' : '';
      const space = fo ? `<mspace width="${fo}pt" style="${line}"/>` : '';
      const back = ba ? `<mspace width="0" style="margin-left:-${ba}pt"/>` : '';
      return `<mrow>${space}${back}${args.length ? row(args[0]) : ''}</mrow>`;
    }
    case 'i': {
      const sym = o.fc ?? o.vc ?? (o.su ? '∑' : o.pr ? '∏' : '∫');
      const op = mo(sym, ` largeop="true" stretchy="${o.vc ? 'true' : 'false'}" movablelimits="false"`);
      const tag = o.in ? 'msubsup' : 'munderover';
      // Word draws the operator at display size inside running text; largeop only enlarges it in display style.
      return `<mrow><${tag} displaystyle="true">${op}${row(args[0])}${row(args[1])}</${tag}>${row(args[2])}</mrow>`;
    }
    case 'l':
      return `<mrow>${args.map(row).join('<mtext>,</mtext>')}</mrow>`;
    case 'o': {
      // Overstrike: every element in one CSS grid cell. An enclosure character is drawn enlarged behind the text (Enclose
      // Characters' Shrink text and Enlarge symbol both draw this way: the code cannot hold the style's sizes).
      const just = o.al ? 'start' : o.ar ? 'end' : 'center';
      const cells = args.map((a) => {
        const enclosure = a.length === 1 && a[0].t === 'text' && ENCLOSURES.includes(a[0].s.trim());
        // The square, triangle and diamond glyphs sit smaller in their em than the circle, so they scale further to clear the text.
        const k = enclosure ? ENCLOSE_SCALE[a[0].s.trim()] : 0;
        const big = k ? `font-size:${k}em;line-height:${(1 / k).toFixed(3)};` : '';
        return `<mrow style="grid-area:1/1;justify-self:${just};align-self:center;${big}">${ml(a.length ? a : [{ t: 'text', s: '' }])}</mrow>`;
      });
      return `<mrow class="fd-over" style="display:inline-grid;align-items:center">${cells.join('')}</mrow>`;
    }
    case 's': {
      if (args.length === 2) return `<mtable class="fd-stack"><mtr><mtd>${row(args[0])}</mtd></mtr><mtr><mtd>${row(args[1])}</mtd></mtr></mtable>`;
      const v = (o.up ?? 0) - (o.do ?? 0);
      const a = [v ? ` voffset="${v}pt"` : '', o.ai ? ` height="+${o.ai}pt"` : '', o.di ? ` depth="+${o.di}pt"` : ''].join('');
      return `<mpadded${a}>${row(args[0])}</mpadded>`;
    }
    case 'x': {
      const all = !o.to && !o.bo && !o.le && !o.ri;
      const side = (on, s) => (all || on ? `border-${s}:1px solid currentColor;` : '');
      return `<mrow style="${side(o.to, 'top')}${side(o.bo, 'bottom')}${side(o.le, 'left')}${side(o.ri, 'right')}padding:1px 2px">${row(args[0])}</mrow>`;
    }
    default:
      return fail();
  }
}

/** The EQ code `code` → {mathml} (a <math> element) or {error: 'Error!'}. */
export function eqMathML(code) {
  try {
    const nodes = parseEq(code);
    return { mathml: `<math display="inline">${ml(nodes.length ? nodes : [{ t: 'text', s: '' }])}</math>` };
  } catch (e) {
    if (e instanceof EqError) return { error: 'Error!' };
    throw e;
  }
}

/** Text `text` escaped for an EQ argument (\, \( \) and \\). */
export const eqEscape = (text) => String(text).replace(/[\\,()]/g, '\\$&');

/** The code Enclose Characters writes for `text` in `enclosure`. */
export const encloseCode = (enclosure, text) => `EQ \\o\\ac(${enclosure},${eqEscape(text)})`;

/** The enclosure and text of an Enclose Characters code (EQ \o\ac(○,A)) → {enclosure, text}, or null for any other code. */
export function enclosedOf(code) {
  let nodes;
  try {
    nodes = parseEq(code);
  } catch {
    return null;
  }
  const n = nodes.filter((x) => !(x.t === 'text' && !x.s.trim()));
  if (n.length !== 1 || n[0].t !== 'cmd' || n[0].c !== 'o' || n[0].args.length !== 2) return null;
  const [a, b] = n[0].args;
  const flat = (nodes2) => (nodes2.every((x) => x.t === 'text') ? nodes2.map((x) => x.s).join('') : null);
  const enclosure = flat(a)?.trim();
  const text = flat(b);
  return ENCLOSURES.includes(enclosure) && text != null ? { enclosure, text } : null;
}
