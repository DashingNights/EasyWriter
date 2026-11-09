// engine-agent-latency (docs/plans/word/briefs/engine-agent-latency.md): an assistant's edit to the Word fixture (execAs) is laid
// out again from its own page, as a typed letter is. Each one adds a revision record, which the layout read as a change outside
// the body: it laid all 976 pages out again (1 to 2 s, the not-quiet round's 6 s at p95). So did the user's own key with Track
// Changes on whenever it fell in a new second, and Undo of an assistant's edit (its record goes). The letter typed beside the
// assistant's edits is timed in the harness case engine-agent-api; the layout rule is tested natively
// (cargo test --release -p ew-doc-layout revisions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const FIXTURE = new URL('../.smoke-data/word/fixture/all-features.docx', import.meta.url);
const J = JSON.parse;
const S = JSON.stringify;

test('an assistant\'s edit and a tracked key in a new second lay out only the pages around them', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here', timeout: 600000 }, async () => {
  const e = new Engine();
  J(e.open(fs.readFileSync(FIXTURE), 'docx'));
  e.takeLayout();
  const count = J(e.pages()).pages.length;
  const { paragraphs } = J(e.query('document.outline', '{}')).value;
  // A paragraph about a third of the way in, so a whole layout and one from its page differ by hundreds of pages.
  const para = paragraphs.slice(Math.floor(paragraphs.length / 3)).find((p) => p.text.length > 20).para;
  const laid = () => {
    const l = J(e.takeLayout());
    return { from: l.from, to: l.to, count: l.count };
  };
  for (let i = 0; i < 3; i++) {
    const r = J(e.execAs('Assistant', 'g', S([['select.at', { para, from: 0 }], ['text.insert', { text: 'q' }]])));
    assert.ok(r.ok && r.revisions.length === 1, S(r));
    const l = laid();
    assert.ok(l.from > 100 && l.to - l.from <= 3 && l.count === count, `the assistant's edit ${i} laid out pages ${l.from}..${l.to} of ${count}`);
  }
  // Undo takes the last edit's record away with its text: laid out from that page too.
  e.undo();
  const u = laid();
  assert.ok(u.from > 100 && u.to - u.from <= 3, `undo laid out pages ${u.from}..${u.to} of ${count}`);
  // The user's own tracked typing: a key in another second than the last makes a record of its own.
  J(e.exec('select.at', S({ para, from: 4 })));
  J(e.exec('review.trackChanges', '{}'));
  J(e.insertText('k'));
  laid();
  const changes = J(e.query('review.changes', '{}')).value.length;
  await new Promise((r) => setTimeout(r, 1100));
  J(e.insertText('k'));
  assert.equal(J(e.query('review.changes', '{}')).value.length, changes + 1, 'the second key is a change of its own');
  const l = laid();
  assert.ok(l.from > 100 && l.to - l.from <= 3, `the tracked key laid out pages ${l.from}..${l.to} of ${count}`);
  e.free();
});
