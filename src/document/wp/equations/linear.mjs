// The linear form around the parsers (docs/plans/word plan.md §3 equations): the math options settings and the document give,
// conversions between the stored UnicodeMath and the input format (UnicodeMath or LaTeX), MathML for a node, and Math
// AutoCorrect's replacement at the caret. Pure, so node tests load it.
import { ENTRIES, FUNCTIONS } from './data.mjs';
import { latex, parseLatex } from './latex.mjs';
import { toMathML } from './mathml.mjs';
import { isOperator, parse, print } from './unicodemath.mjs';

/** m:mathPr's defaults (plan.md §1.8 doc settings); a document without mathPr uses these. */
export const MATH_PR = { font: 'Cambria Math', brkBin: 'before', brkBinSub: '--', smallFrac: false, dispDef: true, lMargin: 0, rMargin: 0,
  defJc: 'centerGroup', wrapIndent: 72, wrapRight: false, intLim: 'subSup', naryLim: 'undOvr' };

/** The document's math properties: MATH_PR with doc settings `settings`.mathPr over them. */
export const mathPrOf = (docSettings) => ({ ...MATH_PR, ...(docSettings?.mathPr ?? {}) });

const cache = new WeakMap();
/** Parser options from settings.word.math `m`: {entries: Map, functions: Set} (null lists are Word's shipped ones). */
export function optionsOf(m) {
  const key = m ?? cache;
  if (!cache.has(key)) cache.set(key, { entries: new Map(m?.entries ?? ENTRIES), functions: new Set(m?.functions ?? FUNCTIONS) });
  return cache.get(key);
}

/** The MathML of UnicodeMath `math` → string, or null for an empty equation. `display`, `mathPr` (the document's), `opts` (optionsOf). */
export function mmlOf(math, { display = false, mathPr = MATH_PR, opts } = {}) {
  if (!math?.trim()) return null;
  return toMathML(parse(math, opts), { display, naryLim: mathPr.naryLim, intLim: mathPr.intLim });
}

/** UnicodeMath `math` as the text the editor shows in `input` ('unicode' or 'latex'). */
export const toInput = (math, input, opts) => (input === 'latex' && math ? latex(parse(math, opts)) : math);

/** The editor's `text` in `input` back to UnicodeMath, trimmed (LaTeX converts, as Word converts it on build-up). */
export const fromInput = (text, input) => (input === 'latex' ? print(parseLatex(text)) : text).trim();

/** Whether character `c` ends a term, so Math AutoCorrect and build-up run: a space or an operator. */
export const isTrigger = (c) => c === ' ' || c === ' ' || isOperator(c);

/** Math AutoCorrect at the end of `text` (the text before a trigger) → {len, value} to replace the last `len` characters, or
 * null. A control word (\alpha) must match whole; other entries (->, +-) match as the longest entry ending the text. */
export function autoCorrect(text, entries) {
  const word = /\\[A-Za-z]+$/.exec(text);
  if (word) {
    const v = entries.get(word[0]);
    return v === undefined ? null : { len: word[0].length, value: v };
  }
  let best = null;
  for (const [k, v] of entries) if (!k.startsWith('\\') && k.length > (best?.len ?? 0) && text.endsWith(k)) best = { len: k.length, value: v };
  return best;
}
