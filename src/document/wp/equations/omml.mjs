// Office Math (OMML, ECMA-376 Part 1 §22.1) and the one math AST of unicodemath.mjs, both ways: readOmml for the .docx import,
// so an equation from Word shows and edits as Word built it, and writeOmml for the export of an equation made or changed here.
// An imported equation also keeps its own XML (the equation node's omml), which export writes back while its math is unchanged,
// so what the AST cannot say (run fonts, m:ctrlPr, matrix spacing, phantoms) survives the round trip. Pure: Node tests load it,
// and it reads the element tree of import.mjs's parseXml ({name, attrs, kids} with text as strings).
import { parse } from './unicodemath.mjs';

const els = (n, name) => (n?.kids ?? []).filter((k) => typeof k === 'object' && (!name || k.name === name));
const kid = (n, name) => els(n, name)[0] ?? null;
const val = (n, name) => kid(n, name)?.attrs['m:val'] ?? null;
// An on/off property: present without m:val, or with a true value.
const on = (n, name) => !!kid(n, name) && !/^(0|false|off)$/i.test(val(n, name) ?? '');
const textOf = (n) => (n?.kids ?? []).map((k) => (typeof k === 'string' ? k : textOf(k))).join('');
const row = (items) => (items.length === 1 ? items[0] : { t: 'row', items });

const LETTER = /[\p{L}\p{Nl}∞∂∇⅀ℏ]/u;
const MARK = /[̀-ͯ⃐-⃿]/;
const DIGIT = /[0-9]/;
// The group characters the AST holds as a bar over or under its base; any other (an arrow) is a limit under or over it.
const BARS = new Set(['⏞', '⏟', '⏜', '⏝']);
const OVER = new Set(['¯', '⏞', '⏜']);
const FRAC_IN = { skw: 'skew', lin: 'lin', noBar: 'noBar' };
const FRAC_OUT = { skew: 'skw', lin: 'lin', noBar: 'noBar' };

// A run's text → mi, mn and mo items, as the parser would read it with every character literal. `o.word` (a function name)
// keeps letters together.
function runItems(text, o) {
  const s = [...text];
  const out = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (/\s/.test(c)) i++;
    else if (DIGIT.test(c)) {
      let v = '';
      while (DIGIT.test(s[i] ?? '') || (s[i] === '.' && DIGIT.test(s[i + 1] ?? ''))) v += s[i++];
      out.push({ t: 'mn', v });
    } else if (LETTER.test(c)) {
      let v = s[i++];
      while (o.word && LETTER.test(s[i] ?? '')) v += s[i++];
      out.push({ t: 'mi', v });
    } else if (MARK.test(c) && out.length) out.push({ t: 'accent', ch: s[i++], base: out.pop() });
    else out.push({ t: 'mo', v: s[i++] });
  }
  return out;
}

// The items of a container's children: runs, structures, and the contents of anything unknown; properties are skipped.
function itemsOf(n, o) {
  const out = [];
  for (const k of els(n)) {
    if (k.name === 'm:r' || k.name === 'w:r') {
      const t = els(k).filter((x) => x.name === 'm:t' || x.name === 'w:t').map(textOf).join('');
      if (k.name === 'w:r' || on(kid(k, 'm:rPr'), 'm:nor')) { if (t) out.push({ t: 'text', v: t }); }
      else out.push(...runItems(t, o));
    } else if (!/Pr$/.test(k.name)) {
      const x = node(k, o);
      if (x) out.push(...(x.t === 'row' ? x.items : [x]));
    }
  }
  return out;
}

// An argument (m:e, m:num, m:sub ...): its items, or a placeholder when empty, as Word draws an empty one.
const arg = (n, o) => {
  const items = itemsOf(n, o);
  return items.length ? row(items) : { t: 'ph' };
};

function node(e, o) {
  const a = (name, x = o) => arg(kid(e, name), x);
  const pr = kid(e, `${e.name}Pr`);
  switch (e.name) {
    case 'm:f': return { t: 'frac', kind: FRAC_IN[val(pr, 'm:type')] ?? 'bar', num: a('m:num'), den: a('m:den') };
    case 'm:sSup': return { t: 'script', base: a('m:e'), sub: null, sup: a('m:sup') };
    case 'm:sSub': return { t: 'script', base: a('m:e'), sub: a('m:sub'), sup: null };
    case 'm:sSubSup': return { t: 'script', base: a('m:e'), sub: a('m:sub'), sup: a('m:sup') };
    case 'm:sPre': return { t: 'pre', sub: a('m:sub'), sup: a('m:sup'), base: a('m:e') };
    case 'm:rad': return { t: 'sqrt', deg: on(pr, 'm:degHide') ? null : a('m:deg'), body: a('m:e') };
    case 'm:nary':
      // Limits stacked under and over (m:limLoc undOvr) are the AST's 'stack'. Without limLoc the document's m:mathPr decides,
      // as with no lim. ponytail: limits forced to the side (subSup) have no AST form, so they follow m:mathPr once edited.
      return { t: 'nary', op: val(pr, 'm:chr') || '∫', sub: on(pr, 'm:subHide') ? null : a('m:sub'), sup: on(pr, 'm:supHide') ? null : a('m:sup'),
        lim: val(pr, 'm:limLoc') === 'undOvr' ? 'stack' : null, body: a('m:e') };
    case 'm:d': {
      const ch = (name, def) => (kid(pr, name) ? val(pr, name) ?? '' : def);
      const sep = ch('m:sepChr', '│');
      const parts = els(e, 'm:e').map((x) => arg(x, o));
      const body = parts.length > 1 ? row(parts.flatMap((p, i) => [...(i ? [{ t: 'mo', v: sep }] : []), ...(p.t === 'row' ? p.items : [p])])) : parts[0] ?? { t: 'ph' };
      return { t: 'fence', open: ch('m:begChr', '('), close: ch('m:endChr', ')'), body };
    }
    case 'm:func': return { t: 'func', name: a('m:fName', { ...o, word: true }), arg: a('m:e') };
    case 'm:acc': return { t: 'accent', ch: val(pr, 'm:chr') || '̂', base: a('m:e') };
    case 'm:bar': return { t: 'bar', ch: val(pr, 'm:pos') === 'top' ? '¯' : '▁', base: a('m:e') };
    case 'm:groupChr': {
      const ch = val(pr, 'm:chr') || '⏟';
      if (BARS.has(ch)) return { t: 'bar', ch, base: a('m:e') };
      return { t: val(pr, 'm:pos') === 'top' ? 'over' : 'under', base: a('m:e'), lim: { t: 'mo', v: ch } };
    }
    case 'm:limLow': return { t: 'under', base: a('m:e'), lim: a('m:lim') };
    case 'm:limUpp': return { t: 'over', base: a('m:e'), lim: a('m:lim') };
    case 'm:box': return { t: 'box', boxed: false, body: a('m:e') };
    case 'm:borderBox': return { t: 'box', boxed: true, body: a('m:e') };
    case 'm:m': { // m:plcHide: an empty cell is empty, not a placeholder
      const hide = on(pr, 'm:plcHide');
      return { t: 'matrix', rows: els(e, 'm:mr').map((r) => els(r, 'm:e').map((c) => (hide && !itemsOf(c, o).length ? { t: 'row', items: [] } : arg(c, o)))) };
    }
    case 'm:eqArr': // a row's & characters align it: they split the row into cells
      return { t: 'eqarray', rows: els(e, 'm:e').map((r) => {
        const items = itemsOf(r, o);
        if (!items.length) return [{ t: 'ph' }];
        const cells = [[]];
        for (const x of items) (x.t === 'mo' && x.v === '&' ? cells.push([]) : cells.at(-1).push(x));
        return cells.map((c) => (c.length ? row(c) : { t: 'row', items: [] }));
      }) };
    // ponytail: a phantom shows its content (the AST has no phantom); its own XML keeps it hidden in the round trip.
    default: return row(itemsOf(e, o));
  }
}

/** An m:oMath or m:oMathPara element → the math AST (an empty equation is an empty row). Several m:oMath in one m:oMathPara,
 * which Word draws one per line, become an equation array. */
export function readOmml(el) {
  const o = { word: false };
  const maths = el?.name === 'm:oMathPara' ? els(el, 'm:oMath') : [el];
  const asts = maths.map((m) => row(itemsOf(m, o)));
  if (asts.length > 1) return { t: 'eqarray', rows: asts.map((x) => [x]) };
  return asts[0] ?? { t: 'row', items: [] };
}

const LEAVES = new Set(['mi', 'mn', 'mo', 'text', 'ph']);
const flat = (n) => (n.t === 'row' ? n.items.every(flat) : LEAVES.has(n.t));

/** The text of an equation Word saved in linear form (Equation > Linear), else null. Word keeps such an equation as plain runs
 * holding its linear text (UnicodeMath, or LaTeX) and shows that text until it is built up, so runs whose text parses into
 * structures are that text. */
export function linearText(el) {
  const maths = el?.name === 'm:oMathPara' ? els(el, 'm:oMath') : [el];
  const list = maths.length === 1 ? els(maths[0]).filter((k) => !/Pr$/.test(k.name)) : [];
  if (!list.length || !list.every((k) => k.name === 'm:r' && !on(kid(k, 'm:rPr'), 'm:nor'))) return null;
  const t = list.map((k) => els(k, 'm:t').map(textOf).join('')).join('');
  return flat(parse(t)) ? null : t;
}

// ---------- writer ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const run = (v, pr = '') => `<m:r>${pr}<m:t${/^\s|\s$/.test(v) ? ' xml:space="preserve"' : ''}>${esc(v)}</m:t></m:r>`;
// A function name (a letter word) is upright, as Word writes it.
const PLAIN = '<m:rPr><m:sty m:val="p"/></m:rPr>';
const prop = (name, v) => (v == null ? '' : `<m:${name} m:val="${esc(v)}"/>`);
const tag = (name, inner, props = '') => `<${name}>${props ? `<${name}Pr>${props}</${name}Pr>` : ''}${inner}</${name}>`;
const part = (name, n) => `<m:${name}>${n ? write(n) : ''}</m:${name}>`;

function write(n) {
  switch (n?.t) {
    case 'row': {
      // Neighbouring identifiers, numbers and operators share one run, as Word writes them.
      let out = '';
      let text = '';
      const flush = () => { if (text) out += run(text); text = ''; };
      for (const x of n.items) {
        if ((x.t === 'mi' && x.v.length === 1) || x.t === 'mn' || x.t === 'mo') text += x.v;
        else { flush(); out += write(x); }
      }
      flush();
      return out;
    }
    case 'mi': return run(n.v, n.v.length > 1 ? PLAIN : '');
    case 'mn': case 'mo': return run(n.v);
    case 'text': return run(n.v, '<m:rPr><m:nor/></m:rPr>');
    case 'frac': return tag('m:f', part('num', n.num) + part('den', n.den), prop('type', FRAC_OUT[n.kind]));
    case 'script':
      if (n.sub && n.sup) return tag('m:sSubSup', part('e', n.base) + part('sub', n.sub) + part('sup', n.sup));
      return n.sub ? tag('m:sSub', part('e', n.base) + part('sub', n.sub)) : tag('m:sSup', part('e', n.base) + part('sup', n.sup));
    case 'pre': return tag('m:sPre', part('sub', n.sub) + part('sup', n.sup) + part('e', n.base));
    case 'sqrt': return tag('m:rad', part('deg', n.deg) + part('e', n.body), n.deg ? '' : prop('degHide', 1));
    case 'nary':
      return tag('m:nary', part('sub', n.sub) + part('sup', n.sup) + part('e', n.body), prop('chr', n.op === '∫' ? null : n.op)
        + prop('limLoc', n.lim === 'stack' ? 'undOvr' : null) + prop('subHide', n.sub ? null : 1) + prop('supHide', n.sup ? null : 1));
    case 'fence': { // separators (│, Word's default m:sepChr) part the content into arguments
      const parts = [[]];
      for (const x of n.body?.t === 'row' ? n.body.items : [n.body]) (x?.t === 'mo' && x.v === '│' ? parts.push([]) : parts.at(-1).push(x));
      return tag('m:d', parts.map((p) => part('e', p.length ? row(p) : null)).join(''), prop('begChr', n.open === '(' ? null : n.open) + prop('endChr', n.close === ')' ? null : n.close));
    }
    case 'func': return tag('m:func', part('fName', n.name) + part('e', n.arg));
    case 'accent': return tag('m:acc', part('e', n.base), prop('chr', n.ch));
    case 'bar':
      if (n.ch === '¯' || n.ch === '▁') return tag('m:bar', part('e', n.base), n.ch === '¯' ? prop('pos', 'top') : '');
      return tag('m:groupChr', part('e', n.base), prop('chr', n.ch) + (OVER.has(n.ch) ? prop('pos', 'top') + prop('vertJc', 'bot') : ''));
    case 'under': return tag('m:limLow', part('e', n.base) + part('lim', n.lim));
    case 'over': return tag('m:limUpp', part('e', n.base) + part('lim', n.lim));
    case 'box': return tag(n.boxed ? 'm:borderBox' : 'm:box', part('e', n.body));
    case 'matrix': {
      const hide = n.rows.some((r) => r.some((c) => c.t === 'row' && !c.items.length));
      return tag('m:m', n.rows.map((r) => `<m:mr>${r.map((c) => part('e', c)).join('')}</m:mr>`).join(''), hide ? prop('plcHide', 1) : '');
    }
    case 'eqarray': return tag('m:eqArr', n.rows.map((r) => `<m:e>${r.map(write).join(run('&'))}</m:e>`).join(''));
    default: return ''; // a placeholder is an empty argument
  }
}

/** The math AST → its m:oMath element as XML. */
export const writeOmml = (ast) => `<m:oMath>${write(ast)}</m:oMath>`;
