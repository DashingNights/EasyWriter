// snap-grid-asian (docs/plans/word/briefs/snap-grid-asian.md): the document grid's line pitch, a CJK font's single line and the
// theme's East Asian font. The expected figures are Word's, from its PDF of the probe .docx files that
// .smoke-data/word/fixture/walk/grid_probe_docx.py writes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { importDocx } from '../src/document/docx/import.mjs';
import { writeZip } from '../src/document/docx/zip.mjs';
import { singleLine } from '../src/document/fonts/metrics.mjs';
import { eaFamily, eastAsianRuns, fontStack } from '../src/office.mjs';
import { gridOf, gridPitch } from '../src/document/wp/paragraph/rules.mjs';

const near = (a, b, d = 0.13) => assert.ok(Math.abs(a - b) <= d, `${a} is not ${b}`);
const APTOS12 = 14.65; // Aptos 12 pt single
const auto = (v) => ({ rule: 'auto', value: v });

test('the line grid: whole grid lines for single and the tallest run, multiples of the pitch, at least and exactly', () => {
  assert.equal(gridOf({ docGrid: { type: 'lines', linePitch: 23.25 } }), 23.25);
  assert.equal(gridOf({ docGrid: { type: 'linesAndChars', linePitch: 18 } }), 18);
  assert.equal(gridOf({ docGrid: { linePitch: 18 } }), null, 'no type: no grid');
  assert.equal(gridOf({ docGrid: null }), null);
  // grid.docx at 23.25 pt (the fixture's 465 twips), 18 and 15.6 pt.
  near(gridPitch(null, APTOS12, 23.25), 23.28);
  near(gridPitch(auto(278 / 240), APTOS12, 23.25), 26.88);
  near(gridPitch(auto(1.5), APTOS12, 23.25), 34.92);
  near(gridPitch(auto(278 / 240), APTOS12, 15.6), 18.12);
  near(gridPitch({ rule: 'exact', value: 15 }, APTOS12, 23.25), 15);
  near(gridPitch({ rule: 'atLeast', value: 20 }, APTOS12, 23.25), 23.28);
  near(gridPitch({ rule: 'atLeast', value: 20 }, APTOS12, 18), 20.04);
  near(gridPitch(null, 28 * 1.2207, 23.25), 46.59);
  near(gridPitch(null, 28 * 1.2207, 15.6), 46.8);
  near(gridPitch(null, 20 * 1.2207, 18), 36.03);
  // DengXian's 12 pt CJK line (16.25 pt) needs two 15.6 pt grid lines, and 1.16 lines adds nothing to them.
  near(gridPitch(auto(278 / 240), 16.25, 15.6), 31.23);
  near(gridPitch(auto(278 / 240), 16.25, 18), 20.88);
});

test('a CJK font gets 30% of its Windows figures as leading; other fonts keep their own single line', () => {
  const m = (cjk, extra = {}) => ({ upm: 2048, ascender: 1659, descender: -475, lineGap: 0, useTypo: false, winAscent: 1659, winDescent: 475,
    typoAscender: 1659, typoDescender: -475, typoLineGap: 0, cjk, ...extra });
  near(singleLine(m(true)) * 12, 16.32, 0.1); // DengXian
  near(singleLine(m(false)) * 12, 12.5, 0.01);
  // SimSun: Windows figures of 1 em and an hhea line gap of 0.14 em: 1.3 em, not 1.14.
  near(singleLine({ upm: 256, ascender: 220, descender: -36, lineGap: 36, useTypo: false, winAscent: 220, winDescent: 36, typoAscender: 220,
    typoDescender: -36, typoLineGap: 36, cjk: true }) * 12, 15.6, 0.01);
});

test('East Asian text: the characters Word draws in the East Asian font, and the theme font stack that carries it', () => {
  assert.deepEqual(eastAsianRuns('和數字 2026，用'), [[0, 3], [8, 10]], 'ideographs, then full-width punctuation with the next one');
  assert.deepEqual(eastAsianRuns('かな한글'), [[0, 4]]);
  assert.deepEqual(eastAsianRuns('x\u{20000}y'), [[1, 3]], 'a supplementary ideograph is one stretch of two code units');
  assert.deepEqual(eastAsianRuns('Latin text 2026, “quoted”'), []);
  const theme = { fonts: { major: 'Aptos Display', minor: 'Aptos', minorEA: null, minorEAScript: '等线' } };
  assert.equal(eaFamily('+minor', theme), '等线');
  assert.equal(eaFamily('+major', theme), null);
  assert.equal(eaFamily('+minor', { fonts: { minorEA: 'MS Mincho', minorEAScript: '等线' } }), 'MS Mincho', 'the theme\'s own a:ea wins');
  assert.equal(fontStack('+minor', theme), '"Aptos", "Calibri", "Carlito", "等线", "DengXian", sans-serif');
  assert.equal(fontStack('+major', theme), '"Aptos Display", "Calibri Light", "Calibri", "Carlito", sans-serif');
  assert.equal(fontStack('Arial', theme), '"Arial", "Liberation Sans", sans-serif');
});

test('import: an empty a:ea takes the theme\'s font for the document\'s East Asian script', async () => {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const font = (latin) => `<a:latin typeface="${latin}"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="游ゴシック"/>`
    + '<a:font script="Hans" typeface="等线"/><a:font script="Hant" typeface="新細明體"/>';
  const theme = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"/>'
    + `<a:fontScheme name="Office"><a:majorFont>${font('Aptos Display')}</a:majorFont><a:minorFont>${font('Aptos')}</a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
  const open = async (lang) => importDocx(await writeZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', `<w:document xmlns:w="${W}"><w:body><w:p/><w:sectPr/></w:body></w:document>`],
    ['word/theme/theme1.xml', theme],
    ['word/settings.xml', `<w:settings xmlns:w="${W}"><w:themeFontLang w:val="en-US" w:eastAsia="${lang}"/></w:settings>`],
  ]), { fresh: true });
  const hans = (await open('zh-CN')).doc.attrs.theme.fonts;
  assert.equal(hans.minorEA ?? null, null, 'the theme\'s own stays empty, so export writes it back as it was');
  assert.equal(hans.minorEAScript, '等线');
  assert.equal((await open('zh-HK')).doc.attrs.theme.fonts.minorEAScript, '新細明體');
  assert.equal((await open('ja-JP')).doc.attrs.theme.fonts.majorEAScript, '游ゴシック');
});
