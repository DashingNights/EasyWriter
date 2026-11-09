// Every rule of a work package's stylesheet starts with a Document scope (docs/plans/word plan.md §1.1), so no package style
// reaches a forum post. Rules inside @media, @supports, @layer and @container are checked the same way; @font-face, @keyframes
// and @page hold no selectors to scope. A print rule may lead with html or :root and its data attributes, present (data-print-bg) or absent
// (:not([data-printing]), a rule for the sheet that the print copies skip).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const WP = path.join(import.meta.dirname, '..', 'src', 'document', 'wp');
const SCOPES = ['.page[data-format="document"]', '[data-doc-text]', '#editor-area[data-word-view]', '[data-ribbon]', '[data-pane]', '[data-word-dialog]'];
const NESTED = /^@(media|supports|layer|container)\b/;

/** The selectors of `css`'s style rules, top level and inside conditional at-rules. */
export function selectorsOf(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const walk = (from, to) => {
    let i = from;
    while (i < to) {
      const open = src.indexOf('{', i);
      const semi = src.indexOf(';', i);
      if (open < 0 || open >= to) return;
      if (semi >= 0 && semi < open) { // a statement at-rule (@import, @charset)
        i = semi + 1;
        continue;
      }
      const prelude = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < src.length && depth; j++) depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0;
      if (NESTED.test(prelude)) walk(open + 1, j - 1);
      else if (!prelude.startsWith('@')) out.push(...prelude.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean));
      i = j;
    }
  };
  walk(0, src.length);
  return out;
}

const scoped = (sel) => {
  const rest = sel.replace(/^(?:html|:root)(?:\[[^\]]*\]|:not\(\[[^\]]*\]\))*\s+/, '');
  return SCOPES.some((s) => rest.startsWith(s));
};

test('the parser finds the selectors of nested and plain rules', () => {
  const css = '/* x { } */ @import "a.css"; [data-ribbon] a, [data-pane] b { color: red; } @media print { html[data-print-bg="on"] [data-doc-text] p { x: 1 } }'
    + ' @keyframes k { from { a: 1 } } .bad { }';
  assert.deepEqual(selectorsOf(css), ['[data-ribbon] a', '[data-pane] b', 'html[data-print-bg="on"] [data-doc-text] p', '.bad']);
  assert.deepEqual(selectorsOf(css).map(scoped), [true, true, true, false]);
});

test('every work package rule starts with a Document scope', () => {
  const bad = [];
  for (const id of fs.readdirSync(WP)) {
    const file = path.join(WP, id, 'style.css');
    if (!fs.existsSync(file)) continue;
    for (const sel of selectorsOf(fs.readFileSync(file, 'utf8'))) if (!scoped(sel)) bad.push(`${id}: ${sel}`);
  }
  assert.deepEqual(bad, []);
});
