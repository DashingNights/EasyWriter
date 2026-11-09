// Phonetic guide (w:ruby) layout as Word draws it. Measured in Word's PDFs of .smoke-data/word/fixture/walk/ruby_docx.py (one
// property at a time, read with ruby_measure.py):
// - The reading's baseline sits its offset (w:hpsRaise) above the base's baseline, at every reading size, font and offset.
// - The line's ascent becomes the larger of its own and the offset plus the reading's ascent. The reading's descent never counts:
//   a 72 pt reading at offset 0 left the line's descent as it was.
// - An East Asian reading's ascent is Word's East Asian line: the font's ascent plus 15% of its height (ascent plus descent);
//   MS Mincho, SimSun and MS Gothic 1.009 em, DengXian 0.966, Yu Gothic 1.178, the same as a plain 72 pt run of each. A Latin
//   reading takes the font's ascent alone (Aptos 0.94 em).
// - The paragraph's spacing rule then applies to the taller line: a multiple scales it, its extra going below the text; Exactly
//   keeps the line as it is.
// - Across, the guide is as wide as the wider of base and reading, and the narrower one is set by the alignment: centred, left,
//   right, distributed with no room at the ends (1-2-1 in Word's list is room at the ends of half a gap, 0-1-0 none).
// Plain functions (the paragraph drawing and the tests use them); boxOf measures with a canvas where there is a DOM.
import { linePitch } from '../paragraph/rules.mjs';

/** Word's East Asian line adds this share of a font's height above its ascent and below its descent (1.3 times the height). */
export const EA_LEAD = 0.15;

/** Whether `text` holds East Asian characters (CJK, kana, hangul, full-width forms), which Word sets in an East Asian font. */
export const isEastAsian = (text) => /[⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/u.test(text ?? '');

/** How far reading `text` of `size` pt in a font of ascent and descent `box` ({asc, desc} over the size) reaches above its own
 * baseline in Word's line (pt). */
export const readingAscent = (text, size, box) => size * (box.asc + (isEastAsian(text) ? EA_LEAD * (box.asc + box.desc) : 0));

/** The room phonetic guide `attrs` ({offset, size, text}) needs in its line → {up, down} (pt over and under the baseline that an
 * empty box keeps open), or null where the line needs none. `line`: the paragraph's line as drawn: {A, D} its tallest font's ascent
 * and descent in Word (pt), `rule` its spacing (paragraph spacing.line), `css` the CSS line height of that font and `below` how far
 * CSS draws its line box under the baseline (pt), `base` the base's size and `box` the reading font's {asc, desc}. The box makes
 * the line Word's height: it reaches to the reading's top and to where Word's line ends below that, and where CSS's own line box
 * reaches further down (a single line: CSS centres the line on the text, Word puts the text on top), the box goes down with it,
 * with a pixel to spare for rounding, and starts that much lower. */
export function rubyRoom(attrs, line) {
  const size = attrs.size ?? line.base / 2;
  const top = (attrs.offset ?? 0) + readingAscent(attrs.text, size, line.box);
  if (top <= line.A + 1e-6 || line.rule?.rule === 'exact') return null;
  const total = linePitch(line.rule, top + line.D);
  const down = Math.max(total - Math.max(top, line.css - line.below), line.below + 0.75);
  return { up: round2(total - down), down: round2(down) };
}

const round2 = (v) => Math.round(v * 100) / 100;

const boxes = new Map();
let ctx = null;
/** Font stack `stack`'s ascent and descent over its size as the browser takes them from the first family it has (a canvas measure;
 * 0.8 and 0.2 without a DOM). */
export function boxOf(stack) {
  let b = boxes.get(stack);
  if (b) return b;
  if (typeof document === 'undefined') return { asc: 0.8, desc: 0.2 };
  ctx ??= document.createElement('canvas').getContext('2d');
  ctx.font = `1000px ${stack}`;
  const m = ctx.measureText('H');
  b = m.fontBoundingBoxAscent > 0 ? { asc: m.fontBoundingBoxAscent / 1000, desc: m.fontBoundingBoxDescent / 1000 } : { asc: 0.8, desc: 0.2 };
  boxes.set(stack, b);
  return b;
}

/** Flex alignment of each Word ruby alignment (rubyAlign): the narrower of base and reading inside the guide's width. */
export const RUBY_JUSTIFY = { center: 'center', distributeLetter: 'space-between', distributeSpace: 'space-around', left: 'flex-start', right: 'flex-end' };

/** The pieces `text` lays out as under alignment `align`: one per character where it is distributed, else the whole text. */
export const piecesOf = (text, align) => (/^distribute/.test(align ?? 'distributeSpace') && [...(text ?? '')].length > 1 ? [...text] : [text ?? '']);
