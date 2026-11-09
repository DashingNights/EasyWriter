// symbols (docs/plans/word briefs/symbols.md Acceptance): Alt+X against Word's behaviour tests, the block table, the Special
// Characters rows, the recently used list, character codes and the Number dialog's types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  altX, BLOCKS, blockOf, charOf, codeOf, NUMBER_TYPES, numberIn, pushRecent, RECENT_DEFAULT, recentLabel, recentOf, shortcutOf, SPECIAL,
  SYMBOL_FONTS, textCells,
} from '../src/document/wp/symbols/chars.mjs';
import { numberText } from '../src/document/fields/numfmt.mjs';

// probe/behaviour-tests.tsv, the altx and altx-sel rows: kind, [typed], [result], result code units, caret after.
const ROWS = `altx	[0041]	[A]	0041	sel=1-1
altx	[41]	[A]	0041	sel=1-1
altx	[U+0041]	[A]	0041	sel=1-1
altx	[u+41]	[A]	0041	sel=1-1
altx	[x2014]	[x2014]	0078 0032 0030 0031 0034	sel=5-5
altx	[abc]	[઼]	0ABC	sel=1-1
altx	[fa1]	[ྡ]	0FA1	sel=1-1
altx	[1F600]	[😀]	D83D DE00	sel=2-2
altx	[10FFFF]	[􏿿]	DBFF DFFF	sel=2-2
altx	[110000]	[110000030]	0031 0031 0030 0030 0030 0030 0030 0033 0030	sel=9-9
altx	[A]	[0041]	0030 0030 0034 0031	sel=4-4
altx	[é]	[00E9]	0030 0030 0045 0039	sel=4-4
altx	[A0041]	[򠁁]	DA40 DC41	sel=2-2
altx	[zz]	[z007A]	007A 0030 0030 0037 0041	sel=5-5
altx	[0041 ]	[00410020]	0030 0030 0034 0031 0030 0030 0032 0030	sel=8-8
altx	[1234567]	[1234560037]	0031 0032 0033 0034 0035 0036 0030 0030 0033 0037	sel=10-10
altx-sel	[xyz all selected]	[xyz]
altx-sel	[ab0041, 0041 selected]	[abA]`;

/** Alt+X on `text` with the caret at its end, or with `sel` (a substring) selected → {text, caret}. */
function press(text, sel = '') {
  const at = sel ? text.lastIndexOf(sel) : text.length;
  const end = at + sel.length;
  const r = altX(sel ? '' : text, sel);
  if (!r) return { text, caret: end };
  const from = sel ? at : at - r.count;
  return { text: text.slice(0, from) + r.text + text.slice(end), caret: from + r.text.length };
}

test('Alt+X gives the text and caret of every altx row', () => {
  for (const line of ROWS.split('\n').filter((l) => l.startsWith('altx\t'))) {
    const [, input, output, units, sel] = line.split('\t');
    const typed = input.slice(1, -1);
    const want = output.slice(1, -1);
    const r = press(typed);
    assert.equal(r.text, want, `typed ${typed}`);
    assert.deepEqual([...r.text].flatMap((c) => c.length === 2 ? [c.charCodeAt(0), c.charCodeAt(1)] : [c.charCodeAt(0)])
      .map((n) => n.toString(16).toUpperCase().padStart(4, '0')).join(' '), units, `units of ${typed}`);
    assert.equal(`sel=${r.caret}-${r.caret}`, sel, `caret after ${typed}`);
  }
});

test('Alt+X with a selection: a selected code converts, several letters stay', () => {
  assert.equal(press('xyz', 'xyz').text, 'xyz');
  assert.equal(press('ab0041', '0041').text, 'abA');
  assert.equal(press('a€', '€').text, 'a20AC');
});

test('Alt+X again right after converts back', () => {
  const once = press('20AC').text;
  assert.equal(once, '€');
  assert.equal(press(once).text, '20AC');
  assert.equal(press(press('0041').text).text, '0041');
});

test('BLOCKS are sorted, do not overlap and hold Currency Symbols as 20A0 to 20CF', () => {
  for (let i = 1; i < BLOCKS.length; i++) assert.ok(BLOCKS[i][0] > BLOCKS[i - 1][1], `${BLOCKS[i][2]} after ${BLOCKS[i - 1][2]}`);
  for (const [a, b] of BLOCKS) assert.ok(a <= b);
  assert.deepEqual(BLOCKS.find((b) => b[2] === 'Currency Symbols'), [0x20a0, 0x20cf, 'Currency Symbols']);
  assert.equal(blockOf(0x20ac)[2], 'Currency Symbols');
  // Word's subset list starts with these 30 in this order (probe/dialogs.md, cut at 30 of 35; Word lists only the font's blocks).
  const word = ['Basic Latin', 'Latin-1 Supplement', 'Latin Extended-A', 'Latin Extended-B', 'IPA Extensions', 'Spacing Modifier Letters',
    'Combining Diacritical Marks', 'Greek and Coptic', 'Cyrillic', 'Cyrillic Supplement', 'Armenian', 'Arabic', 'Bangla', 'Gujarati', 'Tamil', 'Thai',
    'Khmer', 'Latin Extended Additional', 'General Punctuation', 'Superscripts and Subscripts', 'Currency Symbols', 'Letterlike Symbols',
    'Number Forms', 'Arrows', 'Mathematical Operators', 'Miscellaneous Technical', 'Enclosed Alphanumerics', 'Box Drawing', 'Geometric Shapes',
    'Miscellaneous Symbols'];
  const names = BLOCKS.map((b) => b[2]);
  const at = word.map((n) => names.indexOf(n));
  assert.ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), 'Word\'s subsets appear in order');
  const cells = textCells();
  assert.ok(cells.every((n, i) => i === 0 || n > cells[i - 1]), 'grid cells ascend');
  assert.equal(cells[0], 0x20);
});

test('SPECIAL has 27 rows in the probe\'s order with their code points', () => {
  assert.equal(SPECIAL.length, 27);
  assert.deepEqual(SPECIAL.map((s) => s.char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')), ['2014', '2013', '2011', '00AD', '2003', '2002',
    '2005', '00A0', '00A9', '00AE', '2122', '00A7', '00B6', '2026', '2018', '2019', '201C', '201D', '200C', '200D', '200E', '200F', '202A', '202B', '202D',
    '202E', '202C']);
  assert.deepEqual(SPECIAL.slice(0, 4).map((s) => s.name), ['Em Dash', 'En Dash', 'Nonbreaking Hyphen', 'Optional Hyphen']);
  assert.equal(SPECIAL.at(-1).name, 'Pop Directional Formatting');
});

test('shortcut keys come from our keymap', () => {
  assert.equal(shortcutOf('€'), 'Ctrl+Alt+E');
  assert.equal(shortcutOf('®'), 'Ctrl+Alt+R');
  assert.equal(shortcutOf('…'), 'Ctrl+Alt+.');
  assert.equal(shortcutOf('—'), 'Ctrl+Alt+Num-');
  assert.equal(shortcutOf('‑'), 'Alt+Shift+-');
  assert.equal(shortcutOf(' '), 'Ctrl+Shift+Space');
  assert.equal(shortcutOf('§'), '');
});

test('RECENT_DEFAULT has Word\'s 20 symbols ending with Wingdings 74, which is ☺', () => {
  assert.equal(RECENT_DEFAULT.length, 20);
  assert.equal(RECENT_DEFAULT[0].char, '€');
  assert.equal(RECENT_DEFAULT.at(-1).char, '☺');
  assert.equal(SYMBOL_FONTS.Wingdings[74], '☺');
  assert.equal(recentLabel(RECENT_DEFAULT.at(-1)), 'Wingdings: 74');
  assert.equal(recentLabel(RECENT_DEFAULT[13]), 'Micro Sign');
  assert.equal(recentLabel(RECENT_DEFAULT[17]), 'Ohm Sign');
  assert.equal(recentOf([]), RECENT_DEFAULT);
  assert.equal(SYMBOL_FONTS.Symbol[0x61], 'α');
  assert.equal(SYMBOL_FONTS.Symbol[0xa9], '♥');
  assert.equal(SYMBOL_FONTS.Symbol[0xfe], '⎭');
});

test('pushRecent moves an existing symbol to the front and keeps 20', () => {
  const moved = pushRecent(RECENT_DEFAULT, { char: '±', font: null });
  assert.equal(moved.length, 20);
  assert.equal(moved[0].char, '±');
  assert.equal(moved.filter((e) => e.char === '±').length, 1);
  const added = pushRecent(RECENT_DEFAULT, { char: '♥', font: null });
  assert.equal(added.length, 20);
  assert.equal(added[0].char, '♥');
  assert.equal(added.at(-1).char, '∑');
});

test('character codes: Unicode hex and ASCII as Windows-1252', () => {
  assert.equal(charOf('0128', 'asciiDec'), '€');
  assert.equal(codeOf('€', 'unicode'), '20AC');
  assert.equal(codeOf('€', 'asciiDec'), '0128');
  assert.equal(codeOf('€', 'asciiHex'), '80');
  assert.equal(charOf('A9', 'asciiHex'), '©');
  assert.equal(charOf('00A9', 'unicode'), '©');
  assert.equal(charOf('2665'), '♥');
  assert.equal(codeOf('♥', 'asciiDec'), '');
  assert.equal(charOf('zz'), null);
});

test('NUMBER_TYPES has Word\'s 18 rows', () => {
  assert.equal(NUMBER_TYPES.length, 18);
  assert.deepEqual(NUMBER_TYPES[3], ['I, II, III, …', 'upperRoman']);
  assert.equal(NUMBER_TYPES[11][1], 'decimalEnclosedCircleChinese');
  assert.equal(numberIn(12, 'upperRoman', numberText), 'XII');
  assert.equal(numberIn(12, 'decimal', numberText), '12');
  // A format the formatter does not show yet gives null (the dialog's message), never the plain digits.
  assert.equal(numberIn(12, 'x-unknown', numberText), null);
});
