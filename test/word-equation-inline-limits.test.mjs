// equation-inline-limits (docs/plans/word briefs/equation-inline-limits.md): an inline equation draws n-ary limits beside the
// operator even when m:limLoc stacks them, as Word does; a display equation stacks them as m:limLoc or m:mathPr say.
import assert from 'node:assert/strict';
import test from 'node:test';
import { toMathML } from '../src/document/wp/equations/mathml.mjs';
import { parse, print } from '../src/document/wp/equations/unicodemath.mjs';

// The element that carries the operator and its limits.
const head = (mml) => /<(m[a-z]+)><mo largeop="true">/.exec(mml)?.[1];

test('an inline sum draws its limits beside the operator, stacked or not', () => {
  assert.equal(head(toMathML(parse('∑_(i=1)^n▒x_i'))), 'msubsup');
  assert.equal(head(toMathML(parse('∑┬(i=1)┴n▒x_i'))), 'msubsup');
  assert.equal(head(toMathML(parse('∫┬0┴1▒f(x)'), { intLim: 'undOvr' })), 'msubsup');
  assert.equal(head(toMathML(parse('∑┬i▒x_i'))), 'msub');
});

test('a display sum stacks its limits per m:limLoc, else per m:naryLim', () => {
  assert.equal(head(toMathML(parse('∑_(i=1)^n▒x_i'), { display: true })), 'munderover');
  assert.equal(head(toMathML(parse('∑_(i=1)^n▒x_i'), { display: true, naryLim: 'subSup' })), 'msubsup');
  assert.equal(head(toMathML(parse('∑┬(i=1)┴n▒x_i'), { display: true, naryLim: 'subSup' })), 'munderover');
  assert.equal(head(toMathML(parse('∫┬0┴1▒f(x)'), { display: true })), 'munderover');
  assert.equal(head(toMathML(parse('∫_0^1▒f(x)'), { display: true })), 'msubsup');
});

test('the stored math keeps the stacked limits', () => {
  assert.equal(print(parse('∑┬(i=1)┴n▒x')), '∑┬(i=1)┴n▒x');
});
