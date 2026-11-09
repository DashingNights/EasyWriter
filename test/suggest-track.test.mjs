import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '@tiptap/core';
import { documentExtensions } from '../src/document/schema.js';
import * as core from '../src/suggest/core.mjs';
import { Suggestions, withCall } from '../src/suggest/extension.js';
import { exportDocx } from '../src/document/docx/export.mjs';
import { importDocx } from '../src/document/docx/import.mjs';
import { readZip, text } from '../src/document/docx/zip.mjs';

// ED3: accepting a suggestion with Track Changes on writes Word revisions by Assistant; a .docx export carries pending suggestions.
const KIT = () => [...documentExtensions(50), Suggestions];
function editor(content) {
  const ed = new Editor({ element: null, extensions: KIT(), content });
  ed.view.updateState(ed.state.reconfigure({ plugins: ed.extensionManager.plugins }));
  return ed;
}
const p = (s) => ({ type: 'paragraph', content: s ? [{ type: 'text', text: s }] : [] });
// Page and styles as test/docx-export.test.mjs FIXTURE, which exportDocx needs.
const sect = { w: 595.3, h: 841.9, orient: 'portrait', margin: { top: 72, right: 72, bottom: 72, left: 72, header: 35.4, footer: 35.4, gutter: 0 } };
const styles = { defaults: { run: { size: 12 }, para: {} }, list: { Normal: { type: 'paragraph', name: 'Normal' } } };
const docOf = (track, ...content) => ({ type: 'doc', attrs: { sect, styles, theme: { name: 'Default', fonts: { major: 'Aptos Display', minor: 'Aptos' }, colors: { accent1: '#156082' } }, settings: { trackRevisions: track }, people: [] }, content });
const json = (ed) => JSON.stringify(ed.getJSON());
let gi = 0;
const call = () => ({ g: `t${++gi}`, by: 'agent:test', at: 1000 + gi, ids: [] });
const agent = (ed, fn) => withCall(ed, call(), 'exact', () => fn(ed));
const run = (ed, tr) => ed.view.dispatch(tr);
const ids = (ed) => core.entries(ed.state.doc).map((e) => e.id);
const hasRecords = (ed) => /"suggest":\{/.test(json(ed));
// Each block's text as it reads with revisions accepted (`view` 'new') or rejected ('old').
const read = (doc, view) => {
  const skip = view === 'new' ? 'deletion' : 'insertion';
  const out = [];
  doc.forEach((b) => {
    let s = '';
    b.descendants((n) => {
      if (n.isText && !n.marks.some((m) => m.type.name === skip)) s += n.text;
    });
    out.push(s);
  });
  return out;
};
const revs = (doc) => {
  const out = [];
  doc.descendants((n) => {
    const m = n.isText && n.marks.find((x) => x.type.name === 'insertion' || x.type.name === 'deletion');
    if (m) out.push([m.type.name, n.text, m.attrs.author]);
  });
  return out;
};

test('ED3 (1): accept with Track Changes on writes revisions by Assistant, drops the record, one undo brings the suggestion back', () => {
  const ed = editor(docOf(true, p('The quick brown fox'), p('Second line')));
  agent(ed, (x) => run(x, x.state.tr.insertText('red', 11, 16)));
  const before = json(ed);
  run(ed, core.accept(ed.state, ids(ed)));
  assert.deepEqual(read(ed.state.doc, 'new'), ['The quick red fox', 'Second line']);
  assert.deepEqual(read(ed.state.doc, 'old'), ['The quick brown fox', 'Second line']);
  assert.deepEqual(revs(ed.state.doc), [['deletion', 'brown', 'Assistant'], ['insertion', 'red', 'Assistant']]);
  assert.equal(hasRecords(ed), false);
  assert.equal(core.pendingCount(ed.state.doc), 0);
  ed.commands.undo();
  assert.equal(json(ed), before);
  assert.equal(ids(ed).length, 1);
});

test('ED3 (2): with Track Changes off accept gives the plain new doc, no revision marks', () => {
  for (const content of [docOf(false, p('The quick brown fox'), p('Second line')), { type: 'doc', content: [p('The quick brown fox'), p('Second line')] }]) {
    const change = (x) => {
      const tr = x.state.tr.insertText('red', 11, 16);
      run(x, tr.insert(tr.doc.content.size, x.schema.nodeFromJSON(p('Added'))));
    };
    const ed = editor(content);
    agent(ed, change);
    run(ed, core.accept(ed.state, ids(ed)));
    const plain = editor(content);
    change(plain);
    assert.equal(json(ed), json(plain));
    assert.deepEqual(revs(ed.state.doc), []);
  }
});

test('ED3 (3): acceptPlaces on one place of several with tracking on, then accept or reject the rest: the text stays consistent', () => {
  const OLD = ['The quick brown fox jumps over the lazy dog', 'Second line stays here'];
  for (const k of [0, 1, 2]) {
    for (const rest of ['accept', 'reject']) {
      const ed = editor(docOf(true, p(OLD[0]), p(OLD[1])));
      // Three places: a replacement (quick -> slow), an insertion (" very" before lazy), a deletion (" jumps").
      agent(ed, (x) => run(x, x.state.tr.insertText(' very', 35, 35).delete(20, 26).insertText('slow', 5, 10)));
      const NEW = read(ed.state.doc, 'new');
      assert.deepEqual(NEW, ['The slow brown fox over the very lazy dog', OLD[1]]);
      const e = core.entries(ed.state.doc)[0];
      const pl = core.places(e, ed.schema);
      assert.equal(pl.length, 3, 'three places');
      run(ed, core.acceptPlaces(ed.state, [pl[k].id]));
      const label = `place ${k}, then ${rest}`;
      assert.equal(revs(ed.state.doc).every((r) => r[2] === 'Assistant'), true);
      const mid = read(ed.state.doc, 'new');
      assert.deepEqual(mid, NEW, `${label}: the text is still the new text`);
      if (rest === 'accept') {
        run(ed, core.accept(ed.state, ids(ed)));
        assert.deepEqual(read(ed.state.doc, 'new'), NEW, label);
      } else {
        run(ed, core.reject(ed.state, ids(ed)));
        // Only the accepted place's words stay changed (as revisions).
        const only = editor(docOf(false, p(OLD[0]), p(OLD[1])));
        const steps = [(x) => x.insertText('slow', 5, 10), (x) => x.delete(20, 26), (x) => x.insertText(' very', 35, 35)];
        const byPos = [...pl].sort((a, b) => a.from - b.from).indexOf(pl[k]);
        run(only, steps[byPos](only.state.tr));
        assert.deepEqual(read(ed.state.doc, 'new'), read(only.state.doc, 'new'), label);
      }
      assert.deepEqual(read(ed.state.doc, 'old'), OLD, `${label}: rejecting every revision gives the old text`);
      assert.equal(hasRecords(ed), false, label);
    }
  }
});

test('ED3 (4): pending insertion, deletion and replacement suggestions export as w:ins/w:del by Assistant and import back as revisions', async () => {
  const cases = {
    insertion: [(x) => run(x, x.state.tr.insertText(' red', 10, 10)), ['insertion']],
    deletion: [(x) => run(x, x.state.tr.delete(10, 16)), ['deletion']],
    replacement: [(x) => run(x, x.state.tr.insertText('red', 11, 16)), ['deletion', 'insertion']],
    'new paragraph': [(x) => run(x, x.state.tr.insert(x.state.doc.content.size, x.schema.nodeFromJSON(p('Added')))), ['insertion']],
    'deleted paragraph': [(x) => run(x, x.state.tr.delete(x.state.doc.child(0).nodeSize, x.state.doc.content.size)), ['deletion']],
  };
  for (const track of [false, true]) {
    for (const [name, [change, kinds]] of Object.entries(cases)) {
      const label = `${name}, tracking ${track}`;
      const ed = editor(docOf(track, p('The quick brown fox'), p('Second line')));
      agent(ed, change);
      assert.equal(ids(ed).length, 1, label);
      const { state } = ed;
      // As docxOfOpenDraft (files.js) does.
      const doc = core.accept(state, core.entries(state.doc).map((e) => e.id), true)?.doc ?? state.doc;
      const { bytes } = await exportDocx(doc.toJSON(), { title: 'T' });
      const xml = text((await readZip(bytes)).get('word/document.xml'));
      for (const k of kinds) assert.match(xml, new RegExp(`<w:${k === 'insertion' ? 'ins' : 'del'} [^>]*w:author="Assistant"`), `${label}: ${k}`);
      assert.doesNotMatch(xml, /suggest/, label);
      const back = ed.schema.nodeFromJSON((await importDocx(bytes, { fresh: true })).doc);
      const got = revs(back);
      for (const k of kinds) assert.ok(got.some((r) => r[0] === k && r[2] === 'Assistant'), `${label}: ${k} reads back ${JSON.stringify(got)}`);
      const plain = editor(docOf(false, p('The quick brown fox'), p('Second line')));
      change(plain);
      assert.deepEqual(read(back, 'old').filter(Boolean), ['The quick brown fox', 'Second line'], `${label}: old text`);
      assert.deepEqual(read(back, 'new').filter(Boolean), read(plain.state.doc, 'new').filter(Boolean), `${label}: new text`);
    }
  }
});
