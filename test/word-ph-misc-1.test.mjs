// ph-misc-1 (docs/plans/word/briefs/ph-misc-1.md): the Artistic Effects gallery, the placeholders that went, the canvas rows
// for the seven features and the Signature Line's SVG.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTROLS, ITEMS } from '../src/document/ribbon/spec.mjs';
import { ARTISTIC } from '../src/document/wp/picture-format/pictures.mjs';
import { OBJECTS } from '../src/document/canvas/rows/objects.mjs';
import { signatureAlt, signatureSvg } from '../src/document/canvas/signature-line.mjs';

const PROBE = new URL('../docs/plans/word/probe/menus/picture.picture-format.artistic-effects.json', import.meta.url);

test('ARTISTIC is the probe gallery, in its order, without its Options item', () => {
  const raw = readFileSync(PROBE, 'utf8');
  const gallery = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  const want = gallery.items.slice(0, -1).map((i) => i.name);
  assert.equal(want.length, 23);
  assert.deepEqual(ARTISTIC.map((e) => e.label), want);
  for (const e of ARTISTIC) assert.equal(e.id[0], e.id[0].toLowerCase(), `${e.id} starts lower case`);
});

test('the seven features are live and the placeholders that stay still say so', () => {
  assert.equal(CONTROLS['insert.text.object'].type, 'dropdown');
  assert.equal(CONTROLS['insert.text.object'].needs, undefined);
  assert.equal(ITEMS['insert.text.object.object'].needs, 'ole');
  const live = ['pictureFormat.adjust.removeBackground', 'pictureFormat.adjust.artisticEffects',
    'pictureFormat.adjust.artisticEffects.artisticEffectsOptions', 'draw.convert.inkToShape', 'insert.text.signatureLine',
    'insert.text.signatureLine.microsoftOfficeSignatureLine'];
  for (const id of live) assert.equal((CONTROLS[id] ?? ITEMS[id]).needs, undefined, `${id} is not a placeholder`);
  assert.equal(ITEMS['insert.text.signatureLine.stampSignatureLine'].needs, 'signature');
});

test('the canvas Objects table has a row for each feature', () => {
  const rows = ['pictureFormat.adjust.removeBackground', 'pictureFormat.adjust.artisticEffects',
    'pictureFormat.adjust.artisticEffects.artisticEffectsOptions', 'draw.convert.inkToShape', 'insert.text.signatureLine',
    'insert.text.signatureLine.microsoftOfficeSignatureLine'];
  for (const id of rows) assert.ok(OBJECTS[id], `${id} has a row`);
  assert.equal(OBJECTS['insert.text.object'], undefined, 'the Object dropdown has no row of its own');
});

test('Signature Setup draws the line as SVG and names the signer', () => {
  const svg = signatureSvg({ signer: 'A & B', title: 'CEO' });
  assert.ok(svg.includes('A &amp; B'));
  assert.ok(svg.includes('CEO'));
  const bare = signatureSvg();
  assert.equal((bare.match(/<text/g) ?? []).length, 1);
  assert.equal((bare.match(/<line/g) ?? []).length, 1);
  assert.equal(signatureAlt({}), 'Signature line');
});
