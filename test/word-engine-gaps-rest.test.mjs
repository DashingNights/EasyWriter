// engine-gaps-rest (docs/plans/word/briefs/engine-gaps-rest.md): the rows that were still off on a canvas draft, through the
// real engine (src/engine/wasm, npm run build first) and the canvas row tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { HOME } from '../src/document/canvas/rows/home.mjs';
import { REFERENCES } from '../src/document/canvas/rows/references.mjs';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import { ART, BASIC_ART } from '../src/document/wp/borders/canvas.mjs';
import { DEFAULTS, engineArgs } from '../src/document/wp/compare/compare.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });

const exec = (e, id, args = {}) => JSON.parse(e.exec(id, JSON.stringify(args)));
const query = (e, id, args = {}) => JSON.parse(e.query(id, JSON.stringify(args)));
const engineOf = (html) => {
  const e = new Engine();
  e.paste('html', new TextEncoder().encode(html));
  return e;
};
const model = (e) => new TextDecoder().decode(e.save('engine'));

test('the rows built here run on a canvas draft', () => {
  for (const id of ['home.paragraph.asianLayout.twoLinesInOne', 'home.paragraph.asianLayout.horizontalInVertical', 'home.paragraph.asianLayout.combineCharacters']) {
    assert.equal(formOf(HOME[id]), 'spec', id);
  }
  assert.equal(formOf(REFERENCES['developer.mapping.xmlMappingPane']), 'app');
  // The two rows left off here before run now: styles.styleSeparator since engine-style-separator, and styles.selectAllInstances
  // since engine-multi-select (test/word-engine-multi-select.test.mjs).
  assert.equal(formOf(HOME['styles.styleSeparator']), 'engine', 'engine-style-separator built it');
  assert.ok(BASIC_ART.every((a) => ART.includes(a)) && BASIC_ART.length === 10);
});

test('Compare sends every More >> setting to the engine', () => {
  const a = engineArgs('Me', { ...DEFAULTS, moves: false, notes: false });
  assert.deepEqual([a.moves, a.comments, a.headersFooters, a.footnotes, a.textBoxes, a.fields], [false, true, true, false, true, true]);
});

test('Combine Characters, a bound control and Next Citation in the engine', () => {
  const e = engineOf('<p>x ABCDEFGH y</p><p>See Smith v. Jones.</p>');
  exec(e, 'select.text', { text: 'ABCDEFGH' });
  assert.equal(query(e, 'format.combineState').value.text, 'ABCDEF');
  assert.ok(exec(e, 'format.combineCharacters', {}).ok);
  assert.match(model(e), /eq \\\\o\(\\\\s\\\\up 6\(ABC\),\\\\s\\\\do 2\(DEF\)\)/);
  assert.equal(query(e, 'format.combineState').value.current, true);
  assert.ok(exec(e, 'file.properties', { title: 'Gap Report' }).ok);
  exec(e, 'caret.docEnd');
  assert.ok(exec(e, 'developer.insertBound', { property: 'title' }).ok);
  assert.match(model(e), /ns0:title\[1\]/);
  assert.ok(new TextDecoder().decode(e.save('txt')).includes('Gap Report'));
  exec(e, 'caret.docStart');
  assert.ok(exec(e, 'references.nextCitation').ok);
  assert.equal(query(e, 'document.selection').value.text, 'v.');
});
