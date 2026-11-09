// engine-schema (docs/plans/engine/viewport-design.md section 10, P13): the engine's stored form is `easywriter.document`, with an
// integer version at the model's root (ew-doc's schema.rs) and in the record's envelope (src/engine/model/form.mjs). The form the
// canvas editor stored before it, WordCraft's JSON at pin 1be606de, reads as version 0.
// test/fixtures/engine-models/ holds each sample model saved at every version (<sample>-<version>.json; the first sample is plain
// <version>.json): each must open and save to the current version's bytes. <version>.fields.txt lists the stored form as the
// model's Rust types give it (scripts/schema-fields.mjs: every type the Document reaches, each field and variant), so a field
// added to the form fails here whether or not a sample holds it, until SCHEMA_VERSION goes up with its upgrade line. A branch
// whose types changed since it left word-parity needs a version above the one word-parity had there. Then this writes the new
// version's samples and field list from the newest ones:
//   EW_SCHEMA_WRITE=1 node --test test/engine-schema.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FORM, VERSION, adopt, openDraft, recordText, unreadable } from '../src/engine/model/form.mjs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { baseForm, header, schemaProblems, storedForm } from '../scripts/schema-fields.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
// The engine's own fonts ship beside the .wasm, not in it (viewport-design.md section 11): added once for this file's engines.
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const DIR = new URL('./fixtures/engine-models/', import.meta.url);
const WRITE = !!process.env.EW_SCHEMA_WRITE;
const FIELDS = new URL(`${VERSION}.fields.txt`, DIR);
const dec = (b) => new TextDecoder().decode(b);
const read = (file) => fs.readFileSync(new URL(file, DIR), 'utf8');

/** Model text opened in a new engine as its own form → the text its save writes. */
function resave(text) {
  const e = new Engine();
  try {
    e.open(new TextEncoder().encode(text), 'engine');
    return dec(e.save('engine'));
  } finally {
    e.free();
  }
}

/** The samples: name → [[version, file]], oldest first. */
const samples = {};
for (const file of fs.readdirSync(DIR)) {
  const m = file.match(/^(?:(.+)-)?(\d+)\.json$/);
  if (m) (samples[m[1] ?? ''] ??= []).push([Number(m[2]), file]);
}
for (const list of Object.values(samples)) list.sort((a, b) => a[0] - b[0]);
const golden = (name) => `${name ? `${name}-` : ''}${VERSION}.json`;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = baseForm(ROOT);

if (WRITE) {
  // A version word-parity already holds keeps its list: a change to the types takes the next version first.
  const late = schemaProblems(ROOT, BASE).problems.filter((p) => p.startsWith('the stored form\'s types changed since'));
  if (late.length) throw new Error(late.join('\n'));
  for (const [name, list] of Object.entries(samples)) fs.writeFileSync(new URL(golden(name), DIR), resave(read(list.at(-1)[1])));
  fs.writeFileSync(FIELDS, `${header(VERSION)}\n${storedForm(ROOT).join('\n')}\n`);
}

test('every sample, at every version, opens and saves to the current version\'s bytes', () => {
  assert.ok(samples['']?.some(([v]) => v === 0) && samples.fidelity, 'the samples are there');
  for (const [name, list] of Object.entries(samples)) {
    const want = read(golden(name));
    for (const [, file] of list) assert.ok(resave(read(file)) === want, `${file} saves to ${golden(name)}`);
  }
});

test('the stored form\'s types are this version\'s field list, and the version moved with them', () => {
  const { problems } = schemaProblems(ROOT, BASE);
  assert.ok(!problems.length, problems.join('\n'));
});

test('the model carries the schema and version the record does, at its root', () => {
  const saved = resave(read('0.json'));
  assert.ok(saved.startsWith(`{"schema":"${FORM}","version":${VERSION},"body":`), saved.slice(0, 60));
});

test('a record stored as wordcraft-json 1be606de opens and saves as easywriter.document 1', async () => {
  const e = new Engine();
  const client = { open: async (b, k) => JSON.parse(e.open(b, k)), save: async (k) => e.save(k) };
  // As the drafts file family loads it (the model an object) and as a save in the same session leaves it (the model text).
  for (const model of [JSON.parse(read('0.json')), read('fidelity-0.json')]) {
    const draft = { id: 'd', title: 'T', format: 'document', formatVersion: 3, engine: { form: 'wordcraft-json', pin: '1be606de', model } };
    assert.equal(unreadable(draft.engine), null);
    assert.equal(recordText(draft).match(/"engine":\{[^{]*/)[0], '"engine":{"form":"wordcraft-json","pin":"1be606de","model":');
    const { pages, kind } = await openDraft(client, draft, {});
    assert.ok(pages >= 1 && kind === 'engine');
    const record = adopt(draft, await client.save('engine'));
    const back = JSON.parse(record);
    assert.deepEqual([back.engine.form, back.engine.version, back.engine.model.schema, back.engine.model.version], [FORM, VERSION, FORM, VERSION]);
    assert.ok(!('pin' in back.engine) && back.formatVersion === 3 && recordText(draft) === record);
    assert.match(back.engine.model.body[0].text, /^Stored at this pin/);
  }
  e.free();
});

test('a newer model or record, or one of another kind, is refused with the reason', () => {
  assert.equal(unreadable({ form: FORM, version: VERSION, model: {} }), null);
  assert.match(unreadable({ form: FORM, version: VERSION + 1, model: {} }), /newer version/);
  assert.match(unreadable({ form: FORM, model: {} }), /newer version/);
  assert.match(unreadable({ form: 'wordcraft-json', pin: 'ffffffff', model: {} }), /newer version/);
  assert.match(unreadable({ form: 'easywriter.deck', version: 1, model: {} }), /does not know/);
  const model = read(golden(''));
  const v = (text) => text.replace(`"version":${VERSION},`, `"version":${VERSION + 1},`);
  // Whether or not this build's structs can read it: a newer model may hold a block kind this build does not know.
  assert.throws(() => resave(v(model)), /newer version/);
  assert.throws(() => resave(v(model).replace('"body":[', '"body":[{"kind":"box","data":"{}"},')), /newer version/);
  assert.throws(() => resave(model.replace(`"schema":"${FORM}"`, '"schema":"easywriter.deck"')), /does not know/);
});
