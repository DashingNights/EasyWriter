// fields-draw's pure encoders and layouts (docs/plans/word/plan.md §3 fields-draw, briefs/fields-draw.md Acceptance).
import assert from 'node:assert/strict';
import test from 'node:test';
import { barcodeOf, barcodeSvg } from '../src/document/wp/fields-draw/barcode.mjs';
import { eqMathML, parseEq, enclosedOf, encloseCode } from '../src/document/wp/fields-draw/eq.mjs';
import { CODE128_PATTERNS, CODE39_PATTERNS, code128Values, code39, ean13, ERR, mod10, upce } from '../src/document/wp/fields-draw/linear.mjs';
import { blocksOf, dataCapacity, dataCodewords, encodeQR, formatBits, rsRemainder, syndromes, versionBits } from '../src/document/wp/fields-draw/qr.mjs';
import { symbolOf } from '../src/document/wp/fields-draw/symbol.mjs';
import { parseField } from '../src/document/fields/registry.mjs';

// Word's own symbol for DISPLAYBARCODE "https://example.com" QR, read from the modules of its PDF drawing (probe/fields/out2.pdf).
const WORD_QR = ['1111111011100111001111111', '1000001011010011101000001', '1011101011000001101011101', '1011101010111011001011101',
  '1011101011001111001011101', '1000001001100111001000001', '1111111010101010101111111', '0000000011011110100000000', '0110101101011011101011111',
  '1100010110001000001000001', '1111011010000100000110111', '0101010010101001110000010', '0000111101011000111001011', '0010110010010000111001001',
  '1011001001011110101100111', '0101100001100001100010010', '1010111011101101111111000', '0000000011001101100011011', '1111111011101101101011011',
  '1000001000111010100011001', '1011101010100110111111001', '1011101000100011000111100', '1011101011010000100010001', '1000001011110110101011010',
  '1111111000000111111100011'];
const bits = (m) => m.modules.map((r) => r.map((c) => (c ? 1 : 0)).join(''));

test('QR: ISO/IEC 18004 Annex I, "01234567" at 1-M', () => {
  const data = dataCodewords('01234567', 1, 'M');
  assert.deepEqual(data, [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17]);
  assert.deepEqual(rsRemainder(data, 10), [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
});

test('QR: format and version information', () => {
  assert.equal(formatBits('M', 0).toString(2).padStart(15, '0'), '101010000010010');
  const all = [];
  for (const l of ['L', 'M', 'Q', 'H']) for (let m = 0; m < 8; m++) all.push(formatBits(l, m));
  assert.equal(new Set(all).size, 32);
  for (let i = 0; i < 32; i++) {
    for (let j = i + 1; j < 32; j++) {
      const d = (all[i] ^ all[j]).toString(2).replace(/0/g, '').length;
      assert.ok(d >= 7, `format strings ${i} and ${j} differ in ${d} bits`);
    }
  }
  assert.equal(versionBits(7).toString(2).padStart(18, '0'), '000111110010010100');
});

test('QR: random data at 40-H has zero syndromes in every block', () => {
  const n = dataCapacity(40, 'H');
  let seed = 7;
  const data = Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) & 0xff);
  const blocks = blocksOf(data, 40, 'H');
  assert.equal(blocks.length, 81);
  assert.equal(blocks.reduce((s, b) => s + b.data.length, 0), n);
  for (const b of blocks) assert.ok(syndromes([...b.data, ...b.ecc], b.ecc.length).every((s) => s === 0));
});

test("QR: the encoder draws Word's own symbol (level Q, mask 0)", () => {
  const q = encodeQR('https://example.com', 'Q');
  assert.equal(q.version, 2);
  assert.equal(q.mask, 0);
  assert.deepEqual(bits(q), WORD_QR);
  const b = barcodeOf('https://example.com', 'QR', {});
  assert.deepEqual(bits(b.qr), WORD_QR, 'Word draws level Q without \\q');
});

test('QR: the encoder picks the smallest version that fits, with the quiet zone; Word ignores \\q; size and switches', () => {
  const b = { kind: 'qr', qr: encodeQR('https://example.com', 'H') };
  assert.equal(b.qr.level, 'H');
  assert.equal(b.qr.version, 3); // 19 bytes: version 2-H holds 14
  assert.deepEqual(bits(barcodeOf('https://example.com', 'QR', { q: '3' }).qr), WORD_QR, 'all-features.pdf page 84: \\q 3 drew the level Q symbol');
  assert.equal(dataCodewords('https://example.com', 2, 'H'), null);
  const { svg, width } = barcodeSvg(b, {});
  assert.match(svg, /viewBox="0 0 37 37"/); // 29 modules and 4 a side
  assert.ok(Math.abs(width - 37 * 2.8515) < 0.01);
  assert.ok(Math.abs(barcodeSvg(barcodeOf('https://example.com', 'QR', {}), {}).width - 94.1) < 0.05, 'Word drew 94.1 pt');
  assert.ok(Math.abs(barcodeSvg(barcodeOf('https://example.com', 'QR', {}), { s: '50' }).width - 47.05) < 0.05);
  assert.ok(Math.abs(barcodeSvg(barcodeOf('https://example.com', 'QR', {}), { s: '5' }).width - 94.1) < 0.05, '\\s out of range is ignored');
  assert.match(barcodeSvg(b, { f: '0xFF0000', b: '0x00FFFF' }).svg, /fill="#0000ff"[^>]*\/><\/svg>|path d="[^"]+" fill="#0000ff"/);
  assert.match(barcodeSvg(b, { b: '0x00FFFF' }).svg, /fill="#ffff00"/);
  assert.match(barcodeSvg(b, { r: '1' }).svg, /rotate\(90\)/);
  assert.equal(barcodeOf('日本語テキスト', 'QR').error, ERR.chars);
  assert.equal(barcodeOf('', 'QR').error, ERR.length);
});

test('linear codes: check digits and errors', () => {
  assert.equal(mod10('400638133393'), 1);
  assert.equal(ean13('4901234567890').error, ERR.invalid);
  assert.equal(barcodeOf('03600029145', 'UPCA').sym.text.at(-1).text, '2');
  assert.equal(code39('ABC123', { check: true }).checkChar, '$');
  assert.equal(barcodeOf('abc', 'CODE39').error, ERR.chars);
  assert.equal(upce('1234567').error, ERR.invalid);
  assert.equal(barcodeOf('hello', 'BOGUS').error, ERR.params);
  assert.equal(barcodeOf('1234567890123', 'ITF14', { c: 'ADD' }).error, ERR.length);
  assert.equal(barcodeOf('A12345B', 'NW7').error, ERR.chars);
  // probe/fields/out4.pdf drew "12345" NW7 \t and \x \t, showing 12345; \d prints the a ends too (out2.pdf: a12345a).
  const plain = barcodeOf('12345', 'NW7', { t: true });
  assert.equal(plain.sym.text[0].text, '1 2 3 4 5');
  assert.ok(!barcodeOf('12345', 'NW7', { x: true, t: true }).error);
  assert.deepEqual(plain.sym.bars, barcodeOf('12345', 'NW7', { d: true }).sym.bars);
  assert.equal(barcodeOf('12345', 'NW7', { d: true }).sym.text[0].text, 'a 1 2 3 4 5 a');
});

test('linear codes: Code 128 and Code 39 tables and set choice', () => {
  assert.equal(CODE128_PATTERNS.length, 107);
  assert.equal(new Set(CODE128_PATTERNS).size, 107);
  CODE128_PATTERNS.forEach((p, i) => assert.equal([...p].reduce((a, b) => a + Number(b), 0), i === 106 ? 13 : 11));
  assert.deepEqual(code128Values('123456'), [105, 12, 34, 56]);
  assert.deepEqual(code128Values('ABC-123'), [104, 33, 34, 35, 13, 17, 18, 19]);
  for (const p of Object.values(CODE39_PATTERNS)) assert.equal([...p].filter((c) => c === 'w').length, 3);
  // Widths in modules: EAN-13 95, UPC-E 51, with add-ons 95 + 10 + 20 and 95 + 10 + 47.
  const sum = (b) => b.sym.bars.reduce((a, x) => a + x, 0);
  assert.equal(sum(barcodeOf('400638133393', 'EAN13')), 95);
  assert.equal(sum(barcodeOf('0123456', 'UPCE')), 51);
  assert.equal(sum(barcodeOf('12345678901212', 'EAN13', { p: 'SUP2' })), 125);
  assert.equal(sum(barcodeOf('12345678901212345', 'EAN13', { p: 'SUP5' })), 152);
  assert.equal(barcodeOf('1000001-1-2-3', 'JPPOST').sym.states.length, 67);
});

test('EQ: fractions, radicals, arrays and errors', () => {
  assert.match(eqMathML('EQ \\f(1,2)').mathml, /<mfrac>/);
  const frac = parseEq('EQ \\f(1\\,2,3)')[0];
  assert.equal(frac.args[0][0].s, '1,2');
  assert.equal(eqMathML('EQ \\f(1;2)').error, 'Error!');
  assert.equal(eqMathML('EQ \\q(1)').error, 'Error!');
  assert.equal(eqMathML('EQ \\f(1,2').error, 'Error!');
  assert.match(eqMathML('EQ \\r(3,x)').mathml, /<mroot><mrow><mtext>x<\/mtext><\/mrow><mrow><mtext>3<\/mtext><\/mrow><\/mroot>/);
  assert.match(eqMathML('EQ \\r(,x)').mathml, /<msqrt>/);
  const a = eqMathML('EQ \\a \\al \\co2 \\vs3 \\hs3(1,2,3,4)').mathml;
  assert.equal(a.match(/<mtr>/g).length, 2);
  assert.equal(a.match(/<mtd/g).length, 4);
  assert.match(eqMathML('EQ \\f(\\r(,x),2)').mathml, /<mfrac><mrow><msqrt>/);
  assert.match(eqMathML('EQ \\b \\bc\\[(x)').mathml, /\[<\/mo>.*\]<\/mo>/);
  assert.match(eqMathML('EQ \\B \\LC\\{(x)').mathml, /\{<\/mo><mrow><mtext>x<\/mtext><\/mrow><\/mrow>/);
  assert.match(eqMathML('EQ \\i \\su(1,5,3)').mathml, /∑/);
  assert.match(eqMathML('EQ x\\s\\up5(2)').mathml, /voffset="5pt"/);
  assert.match(eqMathML('EQ \\x \\to(a)').mathml, /border-top/);
});

test('Enclose Characters codes round-trip', () => {
  assert.equal(encloseCode('□', 'A'), 'EQ \\o\\ac(□,A)');
  assert.deepEqual(enclosedOf('EQ \\o\\ac(□,A)'), { enclosure: '□', text: 'A' });
  assert.deepEqual(enclosedOf(encloseCode('○', 'a,b')), { enclosure: '○', text: 'a,b' });
  assert.equal(enclosedOf('EQ \\f(1,2)'), null);
});

test('SYMBOL: Symbol font and Unicode', () => {
  // The hub registers SYMBOL with its bare letters; here none is registered, and these codes end in the bare switch anyway.
  const sym = (code) => symbolOf(parseField(code));
  assert.equal(sym('SYMBOL 65 \\f Symbol').char, 'Α');
  assert.equal(sym('SYMBOL 0x2713 \\u').char, '✓');
  assert.equal(sym('SYMBOL 0x41 \\a').char, 'A');
  assert.equal(sym('SYMBOL 169').char, '©');
});
