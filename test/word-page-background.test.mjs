// Page background (docs/plans/word briefs/page-background.md): Auto watermark sizes, the sections a watermark reaches through
// linked headers, page border boxes, the gradient, pattern and texture CSS and the rule and grid spacings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoWatermarkSize, borderBox, bordersShowOn, fillCss, galleryIdOf, galleryWatermark, gradientCss, isDark, PATTERNS, patternBits, patternCss,
  ruleCss, ruleSpacingPx, TEXTURES, textureCss, watermarkPatch, watermarkSections,
} from '../src/document/wp/page-background/model.mjs';

test('Auto size fills the margins box width when horizontal and fits the turned text when diagonal', () => {
  // Letter with 1 inch margins: a 468 x 648 pt box; a word 6 pt wide at 1 pt.
  const flat = autoWatermarkSize(6, 468, 648, 'horizontal');
  assert.equal(flat, 78);
  const diag = autoWatermarkSize(6, 468, 648, 'diagonal');
  // Turned 45 degrees, its run and its line height together fit the narrower side: (6 + 1.2) * size / sqrt 2 <= 468.
  assert.ok(Math.abs(((6 + 1.2) * diag) / Math.SQRT2 - 468) < 1, String(diag));
  assert.ok(diag > flat, 'the diagonal is longer than the width');
  // A short word is held by the box's height, not its width.
  assert.equal(autoWatermarkSize(0.5, 468, 120, 'horizontal'), 100);
  assert.equal(autoWatermarkSize(0, 468, 648), 36);
});

test('a watermark reaches its section and the following sections whose headers are linked', () => {
  const s = (hdr) => ({ sect: { hdr } });
  const sections = [s(null), s(null), s({ default: [] }), s(null)];
  assert.deepEqual(watermarkSections(sections, 0), [0, 1]);
  assert.deepEqual(watermarkSections(sections, 1), [1]);
  assert.deepEqual(watermarkSections(sections, 2), [2, 3]);
  assert.deepEqual(watermarkSections(sections, 3), [3]);
});

test('the gallery gives text watermarks and finds them again', () => {
  const wm = galleryWatermark('confidential1', 'Aptos');
  assert.deepEqual(wm, { kind: 'text', text: 'CONFIDENTIAL', font: 'Aptos', size: null, color: '#C0C0C0', semi: true, layout: 'diagonal' });
  assert.equal(galleryIdOf(wm), 'confidential1');
  assert.equal(galleryIdOf({ ...wm, layout: 'horizontal' }), 'confidential2');
  assert.equal(galleryIdOf({ ...wm, size: 72 }), null);
  assert.equal(galleryWatermark('nope'), null);
  // Switching kind removes the other kind's keys, so a picture's data URL does not stay behind a text.
  assert.equal(watermarkPatch(wm).watermark.src, null);
  assert.equal(watermarkPatch({ kind: 'picture', src: 'data:x' }).watermark.text, null);
});

test('page border boxes for page and text offsets', () => {
  const side = (space) => ({ style: 'single', width: 1, space, color: '#000000' });
  const margin = { top: 72, right: 72, bottom: 72, left: 90, header: 36, footer: 36 };
  // From the page edge: the space is the distance to the line's outer edge.
  assert.deepEqual(borderBox({ offsetFrom: 'page', top: side(24), left: side(24), bottom: side(24), right: side(24) }, margin),
    { top: 24, right: 24, bottom: 24, left: 24 });
  // From the text: outside the margins box by the space and the line, taking the header and footer in.
  assert.deepEqual(borderBox({ offsetFrom: 'text', top: side(1), left: side(4), bottom: side(1), right: side(4) }, margin),
    { top: 34, right: 67, bottom: 34, left: 85 });
  assert.deepEqual(borderBox({ offsetFrom: 'text', top: side(1), bottom: side(1) }, margin,
    { bordersDoNotSurroundHeader: true, bordersDoNotSurroundFooter: true }), { top: 70, right: null, bottom: 70, left: null });
  assert.equal(borderBox({ offsetFrom: 'page', top: { style: 'none' } }, margin), null);
  assert.equal(borderBox(null, margin), null);
});

test('page borders show on all pages, the first only or all but the first', () => {
  assert.deepEqual([0, 1, 2].map((i) => bordersShowOn({ display: 'allPages' }, i)), [true, true, true]);
  assert.deepEqual([0, 1, 2].map((i) => bordersShowOn({ display: 'firstPage' }, i)), [true, false, false]);
  assert.deepEqual([0, 1, 2].map((i) => bordersShowOn({ display: 'notFirstPage' }, i)), [false, true, true]);
  assert.deepEqual([0, 1].map((i) => bordersShowOn({}, i)), [true, true]);
  assert.equal(bordersShowOn(null, 0), false);
});

test('gradient CSS for two colours, one shaded colour, presets, variants and transparency', () => {
  const two = { kind: 'gradient', colors: 'two', color1: '#FF0000', color2: '#0000FF', style: 'horizontal', variant: 0 };
  assert.equal(gradientCss(two), 'linear-gradient(180deg, #FF0000, #0000FF)');
  assert.equal(gradientCss({ ...two, variant: 1 }), 'linear-gradient(180deg, #0000FF, #FF0000)');
  assert.equal(gradientCss({ ...two, variant: 2 }), 'linear-gradient(180deg, #FF0000, #0000FF, #FF0000)');
  assert.equal(gradientCss({ ...two, style: 'vertical' }), 'linear-gradient(90deg, #FF0000, #0000FF)');
  assert.equal(gradientCss({ ...two, style: 'diagonalUp' }), 'linear-gradient(135deg, #FF0000, #0000FF)');
  assert.equal(gradientCss({ ...two, style: 'diagonalDown' }), 'linear-gradient(45deg, #FF0000, #0000FF)');
  assert.equal(gradientCss({ ...two, style: 'fromCorner', variant: 3 }), 'radial-gradient(circle farthest-corner at bottom right, #FF0000, #0000FF)');
  assert.equal(gradientCss({ ...two, style: 'fromCenter', variant: 1 }), 'radial-gradient(ellipse farthest-corner at center, #0000FF, #FF0000)');
  assert.equal(gradientCss({ ...two, from: 50, to: 0 }), 'linear-gradient(180deg, rgba(255, 0, 0, 0.5), #0000FF)');
  // One colour shades toward black (0) or white (1).
  assert.equal(gradientCss({ kind: 'gradient', colors: 'one', color1: '#FF0000', shade: 0 }), 'linear-gradient(180deg, #FF0000, #000000)');
  assert.equal(gradientCss({ kind: 'gradient', colors: 'one', color1: '#FF0000', shade: 1 }), 'linear-gradient(180deg, #FF0000, #FFFFFF)');
  assert.match(gradientCss({ kind: 'gradient', colors: 'preset', preset: 'fire' }), /^linear-gradient\(180deg, #FFF000, #FF8A00, #C80000\)$/);
  assert.equal(fillCss(two).image, gradientCss(two));
});

test('pattern and texture CSS', () => {
  assert.equal(PATTERNS.length, 48);
  assert.equal(new Set(PATTERNS.map(([id]) => id)).size, 48);
  assert.deepEqual(patternBits('ltHorz'), ['11111111', '00000000', '00000000', '00000000', '11111111', '00000000', '00000000', '00000000']);
  assert.equal(patternBits('lgCheck')[0], '11110000');
  // Densities grow with the percent.
  const ones = (id) => patternBits(id).join('').split('1').length - 1;
  assert.ok(ones('pct5') < ones('pct25') && ones('pct25') < ones('pct50') && ones('pct50') < ones('pct90'));
  const css = patternCss({ pattern: 'smGrid', fg: '#FF0000', bg: '#FFFFFF' });
  assert.equal(css.size, '8px 8px');
  assert.match(decodeURIComponent(css.image), /fill="#FFFFFF".*fill="#FF0000"/);
  assert.equal(TEXTURES.length, 24);
  const tex = textureCss({ texture: 'oak' });
  assert.equal(tex.size, '96px 96px');
  assert.match(decodeURIComponent(tex.image), /feTurbulence/);
  assert.equal(textureCss({ src: 'data:image/png;base64,AA' }).image, 'url("data:image/png;base64,AA")');
  assert.equal(fillCss({ kind: 'picture', src: 'data:x', lockAspect: true }).size, 'cover');
  // A page background picture tiles at its own size, as Word's does.
  assert.deepEqual(fillCss({ kind: 'picture', src: 'data:x', lockAspect: true }, { page: true }), { image: 'url("data:x")', size: 'auto', repeat: 'repeat' });
  assert.equal(fillCss({ type: 'pattern', pattern: 'pct50' }).size, '8px 8px'); // the brief's name of the key reads too
  assert.equal(fillCss(null), null);
});

test('rule and grid spacings in px', () => {
  const mm = (n) => (n * 96) / 25.4;
  assert.deepEqual(['narrowRuled', 'collegeRuled', 'standardRuled', 'wideRuled'].map(ruleSpacingPx), [6.35, 7.1, 8, 8.7].map(mm));
  assert.deepEqual(['smallGrid', 'mediumGrid', 'largeGrid', 'veryLargeGrid'].map(ruleSpacingPx), [3.2, 6.4, 12.7, 25.4].map(mm));
  assert.equal(ruleSpacingPx('none'), null);
  const college = ruleCss('collegeRuled');
  assert.equal(college.image.split('linear-gradient').length - 1, 1);
  assert.equal(college.size, `${Math.round(mm(7.1) * 1000) / 1000}px ${Math.round(mm(7.1) * 1000) / 1000}px`);
  assert.equal(ruleCss('largeGrid').image.split('linear-gradient').length - 1, 2);
});

test('automatic text turns white only on a dark page colour', () => {
  assert.equal(isDark('#000000'), true);
  assert.equal(isDark('#002060'), true);
  assert.equal(isDark('#FF0000'), false);
  assert.equal(isDark('#FFFF00'), false);
  assert.equal(isDark(null), false);
});
