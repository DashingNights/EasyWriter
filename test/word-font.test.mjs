// The font work package's pure logic (docs/plans/word/briefs/font.md Acceptance): Change Case, Shift+F3's cycle, width conversion,
// typography and emphasis CSS (attrs.js RUN_CSS, which draws them), the Font dialog's merge, exclusive pairs and value result, and
// Reset Char's mark filter.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RUN_CSS } from '../src/document/model/attrs.js';
import { changeCase, nextCase, wordAround } from '../src/document/wp/font/case.mjs';
import { changesOf, effectsCss, mergeRuns, parseSize, resetMarks, setKey, toggleWrite, valueResult } from '../src/document/wp/font/run.mjs';

const S = 'hELLO wORLD. new one';

test('every Change Case mode', () => {
  assert.equal(changeCase(S, 'sentenceCase'), 'Hello world. New one');
  assert.equal(changeCase(S, 'lowercase'), 'hello world. new one');
  assert.equal(changeCase(S, 'UPPERCASE'), 'HELLO WORLD. NEW ONE');
  assert.equal(changeCase(S, 'capitalizeEachWord'), 'Hello World. New One');
  assert.equal(changeCase(S, 'tOGGLECASE'), 'Hello World. NEW ONE');
  for (const m of ['sentenceCase', 'lowercase', 'UPPERCASE', 'capitalizeEachWord', 'tOGGLECASE']) assert.equal(changeCase('ß', m), 'ß', m);
  assert.equal(changeCase('AB 12', 'fullWidth'), 'ＡＢ　１２');
  assert.equal(changeCase(changeCase('AB 12', 'fullWidth'), 'halfWidth'), 'AB 12');
  assert.equal(changeCase('x', 'nope'), null);
});

test("Shift+F3's next case", () => {
  const next = (t) => changeCase(t, nextCase(t));
  assert.equal(next('hello world'), 'Hello World');
  assert.equal(next('hello. world'), 'Hello. World');
  assert.equal(next('hello world.'), 'Hello world.'); // a sentence end with nothing after it still counts
  assert.equal(nextCase('Hello World'), 'UPPERCASE');
  assert.equal(nextCase('hELLO wORLD'), 'UPPERCASE');
  assert.equal(nextCase('iPhone and NASA'), 'UPPERCASE');
  assert.equal(next('HELLO'), 'hello');
  assert.equal(nextCase('123'), null);
  // The cycle three presses walk.
  assert.equal(next(next(next('hello world'))), 'hello world');
});

test('the word around the caret', () => {
  assert.deepEqual(wordAround('say Hello now', 6), [4, 9]);
  assert.equal(wordAround('say Hello now', 9), null); // at its end: typing only
  assert.deepEqual(wordAround('say Hello now', 9, true), [4, 9]);
  assert.equal(wordAround('say  now', 4, true), null);
});

test('typography and emphasis to CSS', () => {
  assert.equal(RUN_CSS.typography({ ligatures: 'standardContextual' })['font-variant-ligatures'], 'common-ligatures contextual');
  // CSS reads "ss03" alone as "ss03" 1.
  assert.match(RUN_CSS.typography({ stylisticSet: 3 })['font-feature-settings'], /^"ss03"( 1)?$/);
  assert.equal(RUN_CSS.typography({ numForm: 'oldStyle', numSpacing: 'tabular' })['font-variant-numeric'], 'oldstyle-nums tabular-nums');
  assert.match(RUN_CSS.em('underDot')['text-emphasis-position'], /^under/);
  assert.match(effectsCss({ fill: { type: 'gradient', angle: 90, stops: [{ pos: 0, color: '#FFFFFF' }, { pos: 100, color: '#000000' }] } })['background-clip'], /text/);
});

test("the Font dialog's merge, exclusive pairs and result", () => {
  const m = mergeRuns([{ bold: true, size: 12, typography: { ligatures: 'all' } }, { bold: false, size: 12, typography: { ligatures: 'all', numForm: 'lining' } }]);
  assert.equal(m.bold, null); // mixed: a blank check box
  assert.equal(m.size, 12);
  assert.deepEqual(m.typography, { ligatures: 'all', numForm: null });
  let r = setKey({ strike: true, dstrike: false }, 'dstrike', true);
  assert.deepEqual([r.strike, r.dstrike], [false, true]);
  r = setKey({ subscript: true }, 'superscript', true);
  assert.equal(r.subscript, false);
  r = setKey({ caps: true }, 'smallCaps', true);
  assert.equal(r.caps, false);
  const initial = { bold: null, size: 12, typography: { ligatures: 'all' } };
  const edited = { bold: null, size: 14, typography: { ligatures: 'all', stylisticSet: 2 } };
  const ch = changesOf(initial, edited);
  assert.deepEqual(ch, { size: 14, typography: { stylisticSet: 2 } }); // the mixed bold is left alone
  assert.deepEqual(valueResult({ font: 'Arial', typography: { ligatures: 'all' } }, ch), { font: 'Arial', size: 14, typography: { ligatures: 'all', stylisticSet: 2 } });
  assert.equal(parseSize('10.3'), 10.5);
  assert.equal(parseSize('1639'), null);
  assert.equal(toggleWrite(false, true), false);
  assert.equal(toggleWrite(true, true), null);
  assert.equal(toggleWrite(false, undefined), null);
});

test("Reset Char's mark filter", () => {
  const kept = resetMarks([
    { type: 'bold' }, { type: 'link', attrs: { href: 'x' } }, { type: 'comment', attrs: { id: 'c' } }, { type: 'insertion', attrs: { id: 'i' } },
    { type: 'underline', attrs: { val: 'double' } }, { type: 'textStyle', attrs: { color: '#FF0000', lang: { val: 'fr-FR' }, size: 20, highlight: 'yellow' } },
  ]);
  assert.deepEqual(kept.map((m) => m.type), ['link', 'comment', 'insertion', 'textStyle']);
  assert.deepEqual(kept.at(-1).attrs, { lang: { val: 'fr-FR' }, highlight: 'yellow' });
  assert.deepEqual(resetMarks([{ type: 'textStyle', attrs: { color: '#FF0000' } }]), []);
});
