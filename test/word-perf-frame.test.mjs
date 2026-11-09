// perf-frame (docs/plans/word/briefs/perf-frame.md): the rule shapes that made every page end widget restyle the whole text, the
// block decoration that replaced one of them, and the decoration set comparison behind pagination's cycle history.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { blockDecorations } from '../src/document/pagination.js';
import { documentExtensions } from '../src/document/schema.js';
import { changedSet, sameSet } from '../src/document/wp/page-engine/decorations.js';

/** `text` split at the characters of `at` that sit outside parentheses (`keep`: the separators stay as their own items). */
function split(text, at, keep = false) {
  const out = [''];
  let depth = 0;
  for (const ch of text) {
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (!depth && at.includes(ch)) {
      if (keep) out.push(ch);
      out.push('');
    } else out[out.length - 1] += ch;
  }
  return out.map((x) => (x === ' ' ? x : x.trim())).filter((x) => x !== '');
}

/** Every screen selector of document.css and the Word packages' style sheets. */
const root = new URL('../src/document/', import.meta.url);
const sheets = ['document.css', ...readdirSync(new URL('wp/', root), { withFileTypes: true }).filter((d) => d.isDirectory())
  .map((d) => `wp/${d.name}/style.css`).filter((f) => { try { readFileSync(new URL(f, root)); return true; } catch { return false; } })];
const selectors = sheets.flatMap((f) => {
  const css = readFileSync(new URL(f, root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media print\s*\{[\s\S]*$/, '');
  return [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(([, sel]) => split(sel, ',')).filter((x) => !x.startsWith('@')).map((s) => [f, s]);
});

test('no sibling rule matches a top-level block of the text (with MathML in the document each one restyles the whole text per page end)', () => {
  // Chromium's MathML sheet has mmultiscripts > mprescripts ~ :nth-child(2n+1): once a document holds MathML, a child added to a
  // parent whose children a sibling rule (+ or ~) was tried on restyles every child of that parent. A rule may reach the
  // text's children only below the top level (:not(.ProseMirror > *)); pagination marks the top-level cases as block attributes.
  const bad = [];
  for (const [f, s] of selectors) {
    const parts = split(s.replace(/\s*([>+~])\s*/g, '$1'), ' >+~', true); // compounds and combinators, in order
    for (let i = 1; i < parts.length; i += 2) {
      if (parts[i] !== '+' && parts[i] !== '~') continue;
      const subject = parts[i + 1];
      const before = parts.slice(0, i - 1);
      // The parent of the two siblings: the compound before the left one, if a child combinator joins them.
      const parent = before.at(-1) === '>' ? before.at(-2) : null;
      const inText = before.some((c) => c.includes('.ProseMirror'));
      const top = parent ? /\.ProseMirror(?![\w-])/.test(parent) && !parent.includes(' ') : inText;
      if (top && !subject.includes(':not(.ProseMirror>*)')) bad.push(`${f}: ${s}`);
    }
  }
  assert.deepEqual(bad, []);
});

const schema = getSchema(documentExtensions(50));
const p = (s, attrs = null) => schema.node('paragraph', attrs, [schema.text(s)]);

test('the block after a top-level style separator carries data-after-vanish; a block nested in a cell does not need it', () => {
  const cell = schema.node('tableCell', null, [p('cell sep', { specVanish: true }), p('cell next')]);
  const doc = schema.node('doc', null, [p('heading part', { specVanish: true }), p('joined'), p('alone'),
    p('sep before table', { specVanish: true }), schema.node('table', null, [schema.node('tableRow', null, [cell])]), p('after table')]);
  const marked = blockDecorations(doc, false).find().filter((d) => 'data-after-vanish' in d.type.attrs).map((d) => doc.nodeAt(d.from).textContent);
  assert.deepEqual(marked, ['joined']);
  // Cached per doc: the same set comes back.
  assert.equal(blockDecorations(doc, false), blockDecorations(doc, false));
});

test('sameSet: equal decorations built twice are the same set, a moved or changed one is not', () => {
  const doc = schema.node('doc', null, [p('one'), p('two'), p('three')]);
  const make = (at, cls = 'x') => DecorationSet.create(doc, [Decoration.node(at, at + 5, { class: cls }), Decoration.inline(1, 3, { class: 'i' })]);
  const a = make(0);
  assert.equal(sameSet(a, a), true);
  assert.equal(sameSet(a, make(0)), true);
  assert.equal(sameSet(a, make(5)), false);
  assert.equal(sameSet(a, make(0, 'y')), false);
  assert.equal(sameSet(DecorationSet.empty, DecorationSet.create(doc, [])), true);
  assert.equal(sameSet(a, null), false);
  assert.equal(sameSet(null, null), true);
});

test('changedSet: the new set holds exactly the new decorations, keeps the set when nothing changed, and swaps only what differs', () => {
  const doc = schema.node('doc', null, [p('one'), p('two'), p('three')]);
  const node = (at, cls) => Decoration.node(at, at + 5, { class: cls });
  const old = DecorationSet.create(doc, [node(0, 'a'), node(5, 'b'), Decoration.inline(1, 3, { class: 'i' })]);
  assert.equal(changedSet(doc, old, [node(0, 'a'), node(5, 'b'), Decoration.inline(1, 3, { class: 'i' })]), old);
  const next = [node(0, 'a'), node(5, 'c'), node(10, 'd')];
  assert.equal(sameSet(changedSet(doc, old, next), DecorationSet.create(doc, next)), true);
  assert.equal(sameSet(changedSet(doc, old, next, 1), DecorationSet.create(doc, next)), true); // past max: one new set
});
