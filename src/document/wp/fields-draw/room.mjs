// The line room a drawn field takes, as Word gives it (docs/plans/word/briefs/eq-barcode.md). Pure: numbers in, CSS out.
//
// Word sizes a line by its items, then applies the paragraph's line spacing. Measured on Word's PDF of the fixture (Aptos 12 pt,
// multiple 278/240, pages 80 to 94):
// - A picture (a barcode) of height h on the baseline, with text beside it: the line is m h + D (A and D the text's ascent and
//   descent): the multiple scales the picture alone and its extra goes below the text. QR (94.1 pt) then CODE128 (84 pt) lines
//   pitch 110.30, CODE128 then CODE39 108.60, CASE (72 pt) then NW7 106.83: 3.30 + 0.158 h of the line above + 8 + h.
// - Glyphs Word moves or sizes itself (EQ, SYMBOL): the line is the text's own line plus how far their boxes reach past the
//   text's ascent and descent, unscaled. EQ \s\up8 raised a line by 8.04 pt, a two-row array by 9.0 above and 5.64 below.
// CSS gives a line its strut (the paragraph's line height around the font's middle) and grows it only by what a box reaches past
// that strut, so both rules go into one zero-width inline (U+200C, which adds no break) whose own line height and offset make
// its box Word's line: room above the strut `oa` and below it `ob`. Its `lh` in line-height is the paragraph's line height.

const r3 = (x) => Math.round(x * 1000) / 1000;

/** The CSS of the room inline for glyph boxes reaching `oa` pt above the text's ascent and `ob` pt below its descent (Word adds
 * them to the line unscaled), or null when they stay inside the text. The box is the strut grown by oa above and ob below. */
export function overflowRoom(oa, ob) {
  const up = Math.max(0, oa);
  const down = Math.max(0, ob);
  if (up < 0.01 && down < 0.01) return null;
  return `line-height:calc(1lh + ${r3(up + down)}pt);vertical-align:${r3((up - down) / 2)}pt`;
}

/** The CSS of the room inline for a picture `h` pt tall on the baseline of a line whose text has ascent `A` and descent `D`
 * (pt), or null when it is no taller than the text. Word's line is m h + D, the multiple m the paragraph line height over
 * A + D, so the inline's line height is 1lh h / (A + D) + D. It sits h above the baseline: its box is centred on the font's
 * middle, (A - D) / 2 up, and raised by V = h - A / 2 + D / 2 - H / 2 (its own lh is H in vertical-align).
 * ponytail: a line holding the picture alone is m h in Word (the CODE128 \h 2880 line); text beside it is assumed. */
export function pictureRoom(h, A, D) {
  if (!(h > A + 0.01) || !(A + D > 0)) return null;
  return `line-height:calc(1lh * ${r3(h / (A + D))} + ${r3(D)}pt);vertical-align:calc(${r3(h - A / 2 + D / 2)}pt - 0.5lh)`;
}

/** The CSS of a glyph (SYMBOL) whose font box reaches `oa` pt above the text's ascent and `ob` pt below its descent (negative:
 * inside it), set on the glyph itself so that no line break can part the two (the room inline would stay on the line before a
 * glyph wider than the column). Its line height is the strut's grown by the reach: CSS centres that box on the glyph's own
 * middle, which sits the strut's middle plus half the reach difference up, so with both reaches positive it needs no offset. */
export function glyphRoom(oa, ob) {
  const up = Math.max(0, oa);
  const down = Math.max(0, ob);
  if (up < 0.01 && down < 0.01) return 'line-height:0';
  return `line-height:calc(1lh + ${r3(up + down)}pt);vertical-align:${r3((up - oa - (down - ob)) / 2)}pt`;
}
