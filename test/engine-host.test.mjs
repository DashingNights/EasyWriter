// engine-host (docs/plans/engine/viewport-design.md section 16, P4): one worker holds every open draft. These run the engine's
// WebAssembly in Node, several sessions in one instance as the worker holds them: a document lays out the same alone and after
// other documents, two sessions edit independently, layout events carry the top undo and redo step ids, and a copy in one
// session pastes into another with its tables and pictures. The worker and its host are the harness case's
// (.smoke-data/word/cases/engine-host.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

const WASM = fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url));
/** A WebAssembly instance of its own (a worker, as far as fonts and caches go): the glue module under another URL. */
async function worker(name) {
  const ew = await import(new URL(`../src/engine/wasm/ew.js?${name}`, import.meta.url).href);
  ew.initSync({ module: WASM });
  // The engine's own fonts ship beside the .wasm, not in it (viewport-design.md section 11): added once per instance, as the
  // worker adds them before its first session.
  await addBundledFonts(ew, (url) => fs.readFileSync(url));
  return ew;
}
const J = JSON.parse;
const LIBERATION = new URL('../src/vendor/fonts/liberation/LiberationSans-Regular.ttf', import.meta.url);
const FORM = new URL('../.smoke-data/word/fixtures/ethics-form.docx', import.meta.url);
const model = (e) => J(new TextDecoder().decode(e.save('engine')));

/** A document of `paras` (text, optional font), saved in the engine's form. */
function made(ew, paras) {
  const e = new ew.Engine();
  paras.forEach(([text, font], i) => {
    if (i) e.exec('text.newParagraph', '{}');
    if (font) e.exec('format.font', JSON.stringify({ name: font }));
    e.insertText(text);
  });
  const bytes = e.save('engine');
  e.free();
  return bytes;
}

test('a document lays out and draws the same alone and after other documents in the same worker', { skip: !fs.existsSync(LIBERATION) && 'no open fonts here' }, async () => {
  // Hebrew in Cambria, drawn in a compiled-in serif that lacks it: it falls back. Liberation Sans has Hebrew and no
  // compiled-in face does. (A sans family would take Liberation Sans as its stand-in by name, which is no fallback.)
  const a = made(await worker('author'), [['Hello שלום עולם', 'Cambria'], ['A second line, עברית', 'Cambria']]);
  const solo = await worker('solo');
  const alone = new solo.Engine();
  alone.open(a, 'engine');
  const want = alone.layoutDigest();

  const busy = await worker('busy');
  const other = new busy.Engine();
  other.open(made(busy, [['Liberation Sans text, עם עברית', 'Liberation Sans']]), 'engine');
  assert.ok(busy.addFont(new Uint8Array(fs.readFileSync(LIBERATION))) > 0);
  other.fontsChanged();
  other.pages();
  const after = new busy.Engine();
  after.open(a, 'engine');
  assert.equal(after.layoutDigest(), want, 'the other document\'s Liberation Sans is out of this document\'s fallback');
  // And once the app names Liberation Sans for Hebrew, this document falls back to it.
  busy.setScriptFonts(JSON.stringify({ Hebr: ['Liberation Sans'] }));
  after.fontsChanged();
  busy.addFont(new Uint8Array(0));
  const scripted = new busy.Engine();
  scripted.open(a, 'engine');
  assert.notEqual(scripted.layoutDigest(), want, 'the script\'s font is in reach');
  for (const e of [alone, other, after, scripted]) e.free();
});

test('two sessions in one worker edit independently', async () => {
  const ew = await worker('two');
  const [a, b] = [new ew.Engine(), new ew.Engine()];
  a.insertText('First draft');
  b.insertText('Second draft');
  const version = J(b.pages()).version;
  a.takeLayout();
  b.takeLayout();
  for (const ch of ' and more') a.insertText(ch);
  assert.ok(a.takeLayout(), 'the typing laid out its own draft');
  assert.equal(b.takeLayout(), undefined, 'the other draft has no new layout');
  assert.equal(J(b.pages()).version, version);
  const START = JSON.stringify({ story: 'body', path: [0], off: 0 });
  const end = (e) => JSON.stringify(J(e.selection()).head);
  assert.equal(a.text(START, end(a)), 'First draft and more');
  assert.equal(b.text(START, end(b)), 'Second draft');
  a.free();
  b.free();
});

test('layout events carry the top undo and redo step ids, one id for a run of typed letters', async () => {
  const ew = await worker('steps');
  const e = new ew.Engine();
  const steps = () => J(e.takeLayout()).steps;
  e.insertText('a');
  const first = steps();
  assert.ok(first.undo != null && first.redo == null, JSON.stringify(first));
  for (const ch of 'bcd') {
    e.insertText(ch);
    assert.deepEqual(steps(), first, 'typing joins the open step');
  }
  e.exec('select.all', '{}');
  e.exec('format.bold', '{}');
  const bold = steps();
  assert.ok(bold.undo > first.undo, JSON.stringify(bold));
  e.undo();
  assert.deepEqual(steps(), { undo: first.undo, redo: bold.undo }, 'undo moves the step to the redo stack, keeping its id');
  e.free();
});

test('a copy in one session pastes into another with its tables and pictures', { skip: !fs.existsSync(FORM) && 'no Word fixtures here' }, async () => {
  const ew = await worker('paste');
  const [a, b] = [new ew.Engine(), new ew.Engine()];
  a.open(fs.readFileSync(FORM), 'docx');
  a.exec('select.all', '{}');
  assert.ok(J(a.exec('edit.copy', '{}')).ok);
  const r = J(b.pasteFrom(a));
  assert.ok(r.ok && r.changed, JSON.stringify(r));
  const [ma, mb] = [model(a), model(b)];
  const tables = (m) => m.body.filter((x) => x.kind === 'table').map((t) => JSON.stringify(t));
  assert.ok(tables(ma).length > 0);
  assert.deepEqual(tables(mb), tables(ma), 'the tables arrive as they were');
  const pictures = (m) => Object.values(m.media ?? {}).sort();
  assert.ok(pictures(ma).length > 0);
  assert.deepEqual(pictures(mb), pictures(ma), 'the pictures arrive, byte for byte');
  a.free();
  b.free();
});
