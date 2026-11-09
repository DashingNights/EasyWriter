// Word Count's counting rules (docs/plans/word plan.md \u00a73 proofing, \u00a71.11; index-editing.md Word Count; probe/behaviour-tests.tsv rows
// 34 to 56, observed through Document.ComputeStatistics). Pure and import-free on purpose: proofing owns the rule, and proofing,
// statusbar and fields-info all import this one file (plan.md §1.11). It reads ProseMirror nodes and their JSON alike.

// Han, kana, bopomofo and the CJK compatibility blocks: each character is one word and one Asian character. Hangul is left out:
// Word counts Korean by words between spaces ("Korean words").
const CJK = /[\u2e80-\u2fdf\u3005-\u3007\u3021-\u3029\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]|[\ud840-\ud87f][\udc00-\udfff]/;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const BLANK = /^[\s\u00a0\u2000-\u200b\u3000]$/; // spaces, tabs and nonbreaking spaces: left out of Characters (no spaces)
const SPLIT = /[\s\u00a0\u2000-\u200b\u3000\u2014]+/; // an em dash splits even between letters: two words joined by one count 2
const DASHES = /^[\u2013\u2014]+$/; // a spaced en or em dash is no word; a spaced hyphen is

/** The counts of one paragraph's text `s` (a line break as '\n') → {words, chars, charsSp, farEast, korean, blank}. */
export function countText(s) {
  const out = { words: 0, chars: 0, charsSp: 0, farEast: 0, korean: 0, blank: true };
  for (const ch of s) {
    if (ch === '\n' || ch === '\r') continue; // line breaks and paragraph marks are no characters
    out.charsSp++;
    if (BLANK.test(ch)) continue;
    out.chars++;
    out.blank = false;
    if (CJK.test(ch)) out.farEast++;
  }
  for (const token of s.split(SPLIT)) {
    if (!token || DASHES.test(token)) continue;
    // Each CJK character is a word; the runs of other characters between them are one word each.
    let run = false;
    for (const ch of token) {
      if (CJK.test(ch)) {
        out.words++;
        run = false;
      } else if (!run) {
        out.words++;
        run = true;
      }
    }
    if (HANGUL.test(token)) out.korean++;
  }
  return out;
}

/** The counts of paragraph texts `paras` → {words, chars, charsSp, paras, farEast, nonAsian, korean}. Blank paragraphs (empty, or
 * only spaces and tabs) are no paragraphs, as in Word. */
export function countParas(paras) {
  const t = { words: 0, chars: 0, charsSp: 0, paras: 0, farEast: 0, nonAsian: 0, korean: 0 };
  for (const p of paras) {
    const c = countText(p);
    t.words += c.words;
    t.chars += c.chars;
    t.charsSp += c.charsSp;
    t.farEast += c.farEast;
    t.korean += c.korean;
    if (!c.blank) t.paras++;
  }
  t.nonAsian = t.words - t.farEast;
  return t;
}

// Node access that works for ProseMirror nodes (type.name, content.content) and their JSON (type, content).
const typeOf = (n) => n?.type?.name ?? n?.type;
const kidsOf = (n) => n?.content?.content ?? (Array.isArray(n?.content) ? n.content : []);
const deleted = (n) => (n?.marks ?? []).some((m) => (m.type?.name ?? m.type) === 'deletion');
const isText = (n) => typeof n?.text === 'string';
// Inline nodes a JSON textblock may hold without text; ProseMirror nodes answer isTextblock themselves.
const INLINE = new Set(['hardBreak', 'image', 'field', 'noteRef', 'equation', 'ptab', 'bookmark', 'ruby', 'sdtInline', 'tab', 'mention']);
const isTextblock = (n) => n?.isTextblock ?? kidsOf(n).some((k) => isText(k) || INLINE.has(typeOf(k)));

/** The paragraph texts of `node` (a doc, a slice's content holder or a block) in document order, as Word Count reads them:
 * deletion-marked text left out, a field as its result, a line break as '\n'. With `notes` on, footnote and endnote text (each
 * noteRef's content) and text box text count too; headers, footers and comments live in attributes and never count. */
export function parasOf(node, { notes = true } = {}) {
  const out = [];
  const noteParas = [];
  const inline = (n, acc) => {
    for (const k of kidsOf(n)) {
      if (deleted(k)) continue;
      const t = typeOf(k);
      if (isText(k)) acc.push(k.text);
      else if (t === 'hardBreak') acc.push('\n');
      else if (t === 'field') acc.push(k.attrs?.result ?? '');
      else if (t === 'noteRef') {
        if (notes) for (const b of k.attrs?.content ?? []) walk(b, noteParas);
      } else if (kidsOf(k).length) inline(k, acc);
    }
    return acc;
  };
  const walk = (n, into) => {
    if (typeOf(n) === 'textBox' && !notes) return;
    if (isTextblock(n)) into.push(inline(n, []).join(''));
    else for (const k of kidsOf(n)) walk(k, into);
  };
  walk(node, out);
  return out.concat(noteParas);
}

/** Word Count's statistics of `node` (a whole doc, or doc.cut(from, to) for a selection) → {words, chars, charsSp, paras, farEast,
 * nonAsian, korean}. Pages and lines come from the layout, not from here. */
export const countDoc = (node, opts) => countParas(parasOf(node, opts));
