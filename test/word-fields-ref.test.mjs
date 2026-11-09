import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { documentExtensions } from '../src/document/schema.js';
import { fieldCtx, parseField, registerField, registerFieldProvider, updateState } from '../src/document/fields/registry.mjs';
import { bookmarksOf, refName, validName } from '../src/document/wp/fields-ref/bookmarks.mjs';
import { proposedFormula } from '../src/document/wp/fields-ref/cells.mjs';
import { evaluate } from '../src/document/wp/fields-ref/formula.mjs';
import { compareValues, FIELD_TYPES, mailHref, mailParts, PROVIDERS } from '../src/document/wp/fields-ref/refs.mjs';
import { refAround, refCode, targetsOf } from '../src/document/wp/fields-ref/xref.mjs';

// fields-ref (docs/plans/word/briefs/fields-ref.md Acceptance): the Formula probe rows of index-fields.md, the table probes, IF and
// COMPARE, SEQ, REF's number switches on the probe list, and the bookmark name rules.
for (const [name, type] of Object.entries(FIELD_TYPES)) registerField(name, type);
for (const [key, fn] of Object.entries(PROVIDERS)) registerFieldProvider(key, fn);

const schema = getSchema(documentExtensions(50));
const t = (text) => ({ type: 'text', text });
const p = (...content) => ({ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? t(c) : c)) });
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const field = (code, result = null) => ({ type: 'field', attrs: { code, result } });
const bm = (name, id, end = false) => ({ type: 'bookmark', attrs: { name, id, end } });
const doc = (content, attrs = {}) => schema.nodeFromJSON({ type: 'doc', attrs, content });
const cell = (...c) => ({ type: 'tableCell', content: [c.length ? p(...c) : { type: 'paragraph' }] });
const table = (rows) => ({ type: 'table', content: rows.map((r) => ({ type: 'tableRow', content: r.map((c) => (Array.isArray(c) ? cell(...c) : cell(...(c === '' ? [] : [c])))) })) });

// The result of the field at the position of the n-th field node of `d` (code as stored).
function compute(d, n = 0, shared = updateState()) {
  const fields = [];
  d.descendants((node, pos) => {
    if (node.type.name === 'field') fields.push({ node, pos });
  });
  const { node, pos } = fields[n];
  const f = parseField(node.attrs.code);
  return FIELD_TYPES[f.name].compute(f, fieldCtx({ doc: d, pos, shared }));
}
const text = (r) => (r == null ? null : typeof r === 'string' ? r : r.error ?? r.text);
const calc = (expr) => {
  const r = evaluate(expr);
  return r.error ?? r.text;
};

test('Formula: the probe rows of index-fields.md', () => {
  const rows = [
    ['2+3*4', '14'], ['-2^2', '4'], ['10%', '0.1'], ['1/3', '0.33'], ['1/8', '0.13'], ['10/0', '!Zero Divide'], ['3 5', '!Missing Operator'],
    ['1 000', '!Missing Operator'], ['SQRT(4)', '!Syntax Error, 4'], ['(1+2', '!Unexpected End of Formula'], ['ROUND(1234.5,-2)', '1200'],
    ['MOD(-7,3)', '-1'], ['INT(-2.9)', '-2'], ['$5+1', '$6.00'], ['1,000+1', '1,001'], ['SUM(1;2)', '!Syntax Error, ;'],
    ['ABS(-2.5)', '2.5'], ['AND(1,0)', '0'], ['AND(1,1)', '1'], ['AVERAGE(1,2,6)', '3'], ['COUNT(1,2,3,4)', '4'], ['FALSE', '0'], ['TRUE', '1'],
    ['IF(5>3,10,20)', '10'], ['INT(2.9)', '2'], ['MAX(2,5)', '5'], ['MIN(2,5)', '2'], ['MOD(7,3)', '1'], ['MOD(7.5,2)', '1.5'], ['NOT(1)', '0'],
    ['NOT(0)', '1'], ['OR(0,1)', '1'], ['PRODUCT(2,3,4)', '24'], ['ROUND(2.567,2)', '2.57'], ['ROUND(2.5,0)', '3'], ['SIGN(-3)', '-1'], ['SIGN(0)', '0'],
    ['SUM(1,2,3)', '6'], ['5>3', '1'], ['5<=3', '0'], ['2<>2', '0'], ['SUM(LEFT)', '!The Formula Not In Table'], ['5 + x', '!Undefined Bookmark, X'],
  ];
  for (const [expr, want] of rows) assert.equal(calc(expr), want, `= ${expr}`);
  const nums = { num: 42 };
  assert.equal(evaluate('num*2', { bookmark: (n) => nums[n] ?? null }).text, '84');
  assert.equal(evaluate('DEFINED(num)', { bookmark: (n) => nums[n] ?? null }).text, '1');
  assert.equal(evaluate('DEFINED(nobm)', { bookmark: (n) => nums[n] ?? null }).text, '0');
});

test('Formula: the table probes (6 x 5 and 3 x 3) through the cells provider', () => {
  // Column A 1, empty, 3, x, 5; column B 10 to 50; row 1 also holds C1 12, D1 7, E1 7; row 6 holds the formulas.
  const big = doc([table([
    ['1', '10', '12', '7', '7'], ['', '20', '', '', ''], ['3', '30', '', '', ''], ['x', '40', '', '', ''], ['5', '50', '', '', ''],
    [[field('= SUM(ABOVE)')], [field('= SUM(ABOVE)', '150')], [field('= A1+B1')], [field('= SUM(B:B)')], [field('= SUM(1:1)')]],
  ]), p(field('= R1C2+R2C2'))]);
  assert.equal(text(compute(big, 0)), '5', 'SUM(ABOVE) under column A stops at the cell holding x');
  assert.equal(text(compute(big, 1)), '150', 'SUM(ABOVE) under column B');
  assert.equal(text(compute(big, 2)), '11', 'A1+B1');
  assert.equal(text(compute(big, 3)), '300', 'SUM(B:B) counts the formula result in the column');
  assert.equal(text(compute(big, 4)), '37', 'SUM(1:1)');
  assert.equal(text(compute(big, 5)), '!The Formula Not In Table', 'outside a table');
  const inCell = (code) => doc([table([['1', '10', [field(code)]], ['', '20', ''], ['3', '30', ''], ['x', '40', ''], ['5', '50', '']])]);
  assert.equal(text(compute(inCell('= R1C2+R2C2'))), '30', 'R1C2+R2C2');
  assert.equal(text(compute(inCell('= SUM(A1,B2,B3)'))), '51', 'a list of cells');
  assert.equal(text(compute(inCell('= SUM(R1C1:R2C2)'))), '!Syntax Error, :', 'RnCn ranges fail as in this build');
  assert.equal(text(compute(inCell('= SUM(ABOVE,LEFT)'))), '!Syntax Error, :', 'directions do not combine');
  const small = doc([table([['1', '2', [field('= SUM(LEFT)')]], ['3', '4', [field('= PRODUCT(LEFT)')]],
    [[field('= SUM(ABOVE)')], [field('= AVERAGE(ABOVE)')], [field('= SUM(A1:B2)')]]])]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => text(compute(small, i))), ['3', '12', '4', '3', '10'], 'out2.tsv: R1C3, R2C3, R3C1, R3C2, R3C3');
  // Another table through a bookmark on it.
  const two = doc([table([[[bm('tbl', '1'), '1', bm('tbl', '1', true)], '2'], ['3', '4']]), p(field('= SUM(tbl A1:B2)')), p(field('= SUM(tbl B:B)'))]);
  assert.equal(text(compute(two, 0)), '10');
  assert.equal(text(compute(two, 1)), '6');
  // Merged cells count once.
  const merged = doc([{ type: 'table', content: [
    { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2 }, content: [p('5')] }] },
    { type: 'tableRow', content: [cell('1'), cell(field('= SUM(1:1)'))] }] }]);
  assert.equal(text(compute(merged)), '5');
  // The Formula dialog's proposal.
  const at = (d, n) => {
    let hit = 0;
    d.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && n-- === 0) hit = pos + 1;
    });
    return hit;
  };
  const prop = doc([table([['1', 'a'], ['2', ''], ['', '']])]);
  assert.equal(proposedFormula(prop, at(prop, 2)), '=SUM(ABOVE)');
  const left = doc([table([['a', 'b'], ['4', '']])]);
  assert.equal(proposedFormula(left, at(left, 3)), '=SUM(LEFT)');
  assert.equal(proposedFormula(left, at(left, 1)), '=');
});

test('IF and COMPARE: the probe rules', () => {
  const r = (code) => text(FIELD_TYPES[parseField(code).name].compute(parseField(code), fieldCtx({ doc: doc([p('x')]) })));
  assert.equal(r('IF 5 > 3 "yes" "no"'), 'yes');
  assert.equal(r('IF 5>3 "yes" "no"'), 'Error! Unknown op code for conditional.', 'IF needs spaces around the operator');
  assert.equal(r('IF 5 > 3'), '', 'neither text gives an empty result');
  assert.equal(r('IF 2 > 3 "yes"'), '', 'a missing FalseText gives nothing');
  assert.equal(r('IF "Abc" = "abc" "same" "differ"'), 'differ', 'text compares case-sensitively');
  assert.equal(r('IF "abc" = "a*" yes no'), 'yes');
  assert.equal(r('IF "abc" = "a?c" yes no'), 'yes');
  assert.equal(r('IF 10 > 9 yes no'), 'yes', 'numbers compare as numbers');
  assert.equal(r('COMPARE 5>3'), '1', 'COMPARE takes the operator without spaces');
  assert.equal(r('COMPARE "b" < "a"'), '0');
  assert.equal(compareValues('abc', '<>', 'a*', true), false);
  // A bare word naming a bookmark or a SET value reads as its text; a quoted word stays literal.
  const d = doc([p(bm('num', '1'), '5', bm('num', '1', true), field('SET who Ann'), ' ', field('IF num > 3 big small'), field('IF "num" = 5 yes no'),
    field('COMPARE who = "Ann"'))]);
  assert.deepEqual([1, 2, 3].map((n) => text(compute(d, n))), ['big', 'no', '1']);
});

test('e-mail links keep a %, & or # in the address and subject, and a stray % does not throw', () => {
  const href = mailHref('a%b@y.z', 'Save 20% & more #1');
  assert.equal(href, 'mailto:a%25b@y.z?subject=Save%2020%25%20%26%20more%20%231');
  assert.deepEqual(mailParts(href), { address: 'a%b@y.z', subject: 'Save 20% & more #1' });
  assert.equal(mailHref('x@y.z', 'Hi'), 'mailto:x@y.z?subject=Hi');
  assert.deepEqual(mailParts('mailto:x@y.z?subject=Save%2020%'), { address: 'x@y.z', subject: 'Save%2020%' });
  assert.deepEqual(mailParts('mailto:x@y.z?cc=b@c.d&subject=Hi%20there'), { address: 'x@y.z', subject: 'Hi there' });
});

test('SEQ: the probe sequence for Figure, \\s, case and SEQ id Bookmark', () => {
  const codes = ['SEQ Figure', 'SEQ Figure', 'SEQ Figure \\c', 'SEQ Figure \\n', 'SEQ Figure \\h', 'SEQ Figure', 'SEQ Figure \\r 10',
    'SEQ Figure \\* ALPHABETIC', 'SEQ Figure \\* roman', 'SEQ figure'];
  const d = doc(codes.map((c) => p(field(c))));
  assert.deepEqual(codes.map((_, i) => text(compute(d, i))), ['1', '2', '2', '3', '', '5', '10', 'K', 'xii', '13']);
  const s = doc([h(1, 'One'), p(field('SEQ T \\s 1')), p(field('SEQ T \\s 1')), h(1, 'Two'), p(field('SEQ T \\s 1'))]);
  assert.deepEqual([0, 1, 2].map((i) => text(compute(s, i))), ['1', '2', '1']);
  const b = doc([p(bm('cap', '1'), 'Figure ', field('SEQ Figure'), bm('cap', '1', true)), p(field('SEQ Figure')), p(field('SEQ Figure cap'))]);
  assert.equal(text(compute(b, 2)), '1', 'SEQ id Bookmark gives the last SEQ id inside the bookmark');
});

test('REF, SET and the probe list numbers', () => {
  const numbering = { abstract: { a: { levels: [{ fmt: 'decimal', text: '%1)', start: 1 }, { fmt: 'lowerLetter', text: '%2)', start: 1 }] } },
    nums: { 7: { abstract: 'a' } } };
  const item = (ilvl, ...c) => ({ ...p(...c), attrs: { numbering: { numId: 7, ilvl } } });
  const d = doc([item(0, 'Numbered top'), item(1, bm('para', '1'), 'Numbered sub', bm('para', '1', true)), p(field('REF para')),
    p(field('REF para \\n')), p(field('REF para \\r')), p(field('REF para \\w')), p(field('REF para \\w \\d "-"')), p(field('REF para \\p')),
    p(field('REF nothing')), p(field('nothing')), p(field('PAGEREF nothing'))], { numbering });
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => text(compute(d, i))), ['Numbered sub', 'a)', 'a)', '1)a)', '1)-a)', 'above',
    'Error! Reference source not found.', 'Error! Bookmark not defined.', 'Error! Bookmark not defined.']);
  const self = doc([p(bm('me', '1'), 'a ', field('REF me'), bm('me', '1', true))]);
  assert.equal(text(compute(self)), 'Error! Not a valid bookmark self-reference.');
  const set = doc([p(field('SET greet "Hello"')), p(field('REF greet'))]);
  assert.equal(text(compute(set, 1)), 'Hello', 'SET then REF, inserted one by one');
  const shared = updateState();
  compute(set, 0, shared);
  assert.equal(shared.assigned.get('greet'), 'Hello', 'SET writes ctx.assigned in an update');
  const style = doc([h(1, 'Chapter heading'), h(2, 'Second level'), p(field('STYLEREF 1')), p(field('STYLEREF 2')), p(field('STYLEREF "Heading 2" \\p')),
    p(field('STYLEREF Quote')), p(field('STYLEREF 1 \\s'))]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => text(compute(style, i))), ['Chapter heading', 'Second level', 'above',
    'Error! No text of specified style in document.', '0']);
});

test('Bookmarks: name rules, ranges and the cross-reference codes', () => {
  assert.equal(validName('Intro'), true);
  assert.equal(validName('a_1'), true);
  assert.equal(validName('9abc'), false, 'a name begins with a letter');
  assert.equal(validName('a b'), false, 'no spaces');
  assert.equal(validName('a'.repeat(41)), false, 'at most 40 characters');
  assert.equal(validName('a'.repeat(40)), true);
  assert.equal(validName('_Ref1'), false, 'hidden names are Word\'s own');
  const d = doc([p('A ', bm('Intro', '1'), 'bc', bm('Intro', '1', true), ' ', bm('pt', '2'), bm('pt', '2', true))]);
  const [a, b] = bookmarksOf(d);
  assert.equal(d.textBetween(a.from, a.to), 'bc');
  assert.equal(b.from, b.to, 'a point bookmark');
  assert.match(refName(d), /^_Ref[0-9]{9}$/);
  assert.equal(refCode('text', '_Ref1'), 'REF _Ref1 \\h');
  assert.equal(refCode('number', '_Ref1'), 'REF _Ref1 \\r \\h');
  assert.equal(refCode('numberFull', '_Ref1', { separator: '-' }), 'REF _Ref1 \\w \\h \\d "-"');
  assert.equal(refCode('page', '_Ref1', { hyperlink: false }), 'PAGEREF _Ref1');
  assert.equal(refCode('page', '_Ref1', { aboveBelow: true }), 'PAGEREF _Ref1 \\h \\p', 'Include above/below on a page number');
  assert.equal(refCode('noteFormatted', '_Ref1'), 'NOTEREF _Ref1 \\f \\h');
  const heads = targetsOf(doc([h(1, 'Intro'), p('x'), h(2, 'Sub')]), 'heading');
  assert.deepEqual(heads.map((x) => x.label), ['Intro', '  Sub']);
  const caps = targetsOf(doc([p('Figure ', field('SEQ Figure', '1'), ': A cat')]), 'Figure');
  assert.equal(caps[0].label, 'Figure 1: A cat');
  // A second reference to a heading reuses the _Ref the first one put around its text.
  const wrapped = doc([{ type: 'heading', attrs: { level: 1 }, content: [bm('_Ref123456789', '1'), t('Intro'), bm('_Ref123456789', '1', true)] }]);
  assert.equal(refAround(bookmarksOf(wrapped), targetsOf(wrapped, 'heading')[0]), '_Ref123456789');
});
