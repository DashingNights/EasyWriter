// perf-core (docs/plans/word/briefs/perf-core.md): the style rules a long Document restyles with. A full restyle of the Word fixture
// took 4 to 8 s, and pagination forced one for every page end it added; these checks keep the rule shapes that made it so out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { styleSheetCss, tableStyleClass } from '../src/document/stylesheet.js';

const css = readFileSync(new URL('../src/document/document.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/@media print\s*\{[\s\S]*$/, ''); // print rules match only while printing
/** `text` split at the characters of `at` that sit outside parentheses. */
function split(text, at) {
  const out = [''];
  let depth = 0;
  for (const ch of text) {
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (!depth && at.includes(ch)) out.push('');
    else out[out.length - 1] += ch;
  }
  return out.map((x) => x.trim()).filter(Boolean);
}
/** Every selector of document.css's screen rules. */
const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(([, sel]) => split(sel, ',')).filter((x) => !x.startsWith('@'));
/** The last compound of selector `sel` (after its last combinator outside parentheses). */
const last = (sel) => split(sel, ' >+~').at(-1);

test('document.css: no rule for cells or text blocks ends in an :is() list (the browser then matches it against every element)', () => {
  assert.deepEqual(selectors.filter((s) => /^:is\((td|th|p)/.test(last(s))), []);
  assert.ok(!selectors.some((s) => s.includes('[style*="--tbl-cell-margin"]')), 'a table with its own cell margins is marked data-cell-margin');
});

test('document.css: a sibling rule names an attribute or class before its +, so a block added among the text\'s children restyles no others', () => {
  for (const s of selectors) {
    const parts = split(s, '+');
    if (parts.length > 1) assert.match(split(parts.at(-2), ' >').at(-1), /\[|\./, s);
  }
  assert.ok(!selectors.some((s) => /\[data-page-break\][^,]*\+/.test(s)), 'the block after a page break is marked by pagination (data-after-break)');
});

test("document.css: no var() or attr() in every cell's own declarations (a cell style that cannot be reused restyles slowly)", () => {
  assert.doesNotMatch(css, /margin-(right|left):\s*calc\(-1 \* var\(--cell-bx/);
  assert.match(css, /td\[colspan\], [^{]*th\[colspan\] \{ grid-column: span attr\(/);
});

test("stylesheet: a table style's rules end in a cell or text tag and key the table on its class", () => {
  const list = {
    'Grid Table 4': { type: 'table', table: { borders: { style: 'single', width: 0.5, color: '#000000' }, cond: { firstRow: { run: { bold: true } }, band1Horz: { cell: { shading: { fill: 'EEEEEE' } } } } } },
  };
  const out = styleSheetCss('.s', { list }, null).split('\n').filter((r) => r.includes('table.'));
  const cls = tableStyleClass('Grid Table 4');
  assert.equal(cls, 'ts-Grid_w_Table_w_4');
  assert.ok(out.length > 4 && out.every((r) => r.includes(`table.${cls}`) && !r.includes('[data-style=')), out.join('\n'));
  for (const r of out) {
    for (const sel of split(r.slice(0, r.indexOf('{')), ',')) assert.match(last(sel), /^(table|td|th|p|h[1-6])\b/, sel);
  }
  // Ids that differ only in characters a class cannot hold get different classes.
  assert.notEqual(tableStyleClass('A.B'), tableStyleClass('A_B'));
});
