import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { HOME } from '../src/document/canvas/rows/home.mjs';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { pointerOf } from '../src/engine/input/pointer.js';
import { Engine, initSync } from '../src/engine/wasm/ew.js';

// engine-multi-select (docs/plans/word/briefs/engine-multi-select.md, stage2.md G22): several ranges selected at once on a canvas
// draft, against the real engine in process. The engine's own commands are checked in doc-edit's cmd/multi.rs tests; this file
// checks what the host reads (the selection and its event), the pointer's Ctrl gestures and the rows the brief turns on. The
// harness case .smoke-data/word/cases/engine-multi-select.js runs them in the app.

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

const J = (s) => JSON.parse(s);
const S = (v) => JSON.stringify(v);
const at = (block, off) => ({ story: 'body', path: [block], off });

/** An engine holding `text` (paragraphs split at \n) and a client over it in the shape the pointer calls. */
function engineOf(text) {
  const e = new Engine();
  text.split('\n').forEach((t, i) => {
    if (i) e.exec('text.newParagraph', '{}');
    e.insertText(t);
  });
  e.exec('caret.docStart', '{}');
  e.takeLayout();
  const client = {
    hit: async (page, x, y) => J(e.hit(page, x, y)),
    select: async (a, h) => e.select(S(a), S(h)),
    selection: async () => J(e.selection()),
    exec: async (id, args = {}) => J(e.exec(id, S(args))),
  };
  /** The ranges' texts in the order they were selected, the active one last. */
  const texts = () => J(e.exec('select.list', '{}')).value.ranges.map((r) => e.text(S(r.anchor), S(r.focus)));
  return { e, client, texts };
}

test('the host reads several ranges: the selection, and every range highlighted in its event', () => {
  const { e } = engineOf('alpha beta gamma\ndelta');
  e.exec('select.range', S({ anchor: at(0, 0), focus: at(0, 5) }));
  const one = J(e.selection());
  assert.equal(one.ranges, undefined, 'one range reads as before');
  const r = J(e.exec('select.add', S({ anchor: at(1, 0), focus: at(1, 5) })));
  assert.equal(r.value.count, 2);
  const sel = J(e.selection());
  assert.equal(sel.ranges, 2);
  assert.deepEqual([sel.anchor, sel.head], [at(1, 0), at(1, 5)], 'the range added last is the active one');
  const ev = J(e.selectionEvent());
  assert.equal(ev.ranges, 2);
  const lines = new Set(ev.rects.map((x) => Math.round(x.y)));
  assert.equal(lines.size, 2, 'both ranges are drawn, one on each line');
  // A new set with the same active range reads differently, so the worker sends its event.
  e.exec('select.ranges', S({ ranges: [{ anchor: at(0, 6), focus: at(0, 10) }, { anchor: at(1, 0), focus: at(1, 5) }] }));
  assert.notEqual(J(e.selection()).set, sel.set);
  e.exec('caret.right', '{}');
  assert.equal(J(e.selection()).ranges, undefined, 'moving the caret leaves one range');
});

test('Reading Highlight\'s matches come with the selection event while it is on (the Navigation pane\'s search highlights them)', () => {
  const { e } = engineOf('cat and cat\ndog');
  assert.equal(J(e.selectionEvent()).found, undefined);
  const sel = e.selection();
  e.exec('edit.advancedFind', S({ text: 'cat', highlight: true }));
  const mark = e.findMark();
  assert.ok(mark, 'findMark names the search, so the worker sends a selection event when it changes');
  assert.equal(J(e.selectionEvent()).found.length, 2);
  e.exec('edit.advancedFind', S({ text: 'dog', in: 'main' }));
  assert.equal(e.selection(), sel, 'a command that changes only the find state leaves the selection, so the worker also sends its command event');
  assert.notEqual(e.findMark(), mark);
  e.exec('edit.find', S({ text: 'dog' }));
  assert.equal(J(e.selectionEvent()).found.length, 1, 'a new search moves the highlight');
  e.exec('edit.advancedFind', S({ highlight: false }));
  assert.equal(J(e.selectionEvent()).found, undefined);
  assert.equal(e.findMark(), '');
});

/** Pointer events on a page where one point is one pixel: a press (and release) at character `off` of paragraph `para`. */
function pageOf(text) {
  const { e, client, texts } = engineOf(text);
  const win = new EventTarget();
  const el = Object.assign(new EventTarget(), { ownerDocument: { defaultView: win }, clientWidth: 800, clientHeight: 900 });
  let queue = Promise.resolve();
  const run = (fn) => (queue = queue.then(fn));
  pointerOf({ el, client, run, changed: () => {}, locate: (x, y) => ({ page: 0, x, y }), focus: () => {} });
  const point = (para, off) => {
    const c = J(e.caret(S(at(para, off))));
    return { clientX: c.x + 0.5, clientY: c.y + c.h / 2 };
  };
  /** A press at character `off` of paragraph `para`, moves to each of `to` (offsets in it) and a release. */
  const drag = async (off, para, to, more = {}) => {
    el.dispatchEvent(Object.assign(new Event('mousedown', { cancelable: true }), { button: 0, detail: 1, ...point(para, off), ...more }));
    for (const o of to) win.dispatchEvent(Object.assign(new Event('mousemove'), { buttons: 1, ...point(para, o) }));
    win.dispatchEvent(new Event('mouseup'));
    await queue;
  };
  const press = (off, para, more = {}) => drag(off, para, [], more);
  return { e, press, drag, texts };
}

test('Ctrl+click adds the sentence and Ctrl+double-click the word to the selection; a plain click leaves one range', async () => {
  const { e, press, texts } = pageOf('One two. Three four. Five six.');
  e.exec('select.range', S({ anchor: at(0, 0), focus: at(0, 3) }));
  await press(15, 0, { ctrlKey: true });
  assert.deepEqual(texts(), ['One', 'Three four. ']);
  await press(23, 0, { ctrlKey: true });
  await press(23, 0, { ctrlKey: true, detail: 2 });
  assert.deepEqual(texts(), ['One', 'Three four. ', 'Five '], "a double click's first press added the range its second press makes a word");
  await press(1, 0);
  assert.deepEqual(texts(), ['']);
  await press(15, 0, { ctrlKey: true });
  assert.deepEqual(texts(), ['Three four. '], 'Ctrl+click with a caret selects the sentence alone');
});

test('Ctrl+drag beside a selection adds a range grown by characters; with a caret it selects by sentences', async () => {
  const { e, drag, texts } = pageOf('One two. Three four. Five six.');
  e.exec('select.range', S({ anchor: at(0, 0), focus: at(0, 3) }));
  await drag(9, 0, [12, 16], { ctrlKey: true });
  assert.deepEqual(texts(), ['One', 'Three f'], 'a plain drag\'s steps, not the sentence');
  e.exec('caret.docStart', '{}');
  await drag(9, 0, [12, 16], { ctrlKey: true });
  assert.deepEqual(texts(), ['Three four. '], 'Ctrl held before any selection selects by sentences');
});

test('Select All Instances and x.selection.multi run on a canvas draft', () => {
  for (const id of ['styles.selectAllInstances', 'x.selection.multi']) assert.equal(formOf(HOME[id]), 'exec', id);
  assert.deepEqual(HOME['styles.selectAllInstances'].args('Heading1'), { style: 'Heading1' });
  assert.equal(HOME['styles.selectAllInstances'].args(undefined), null, 'no style, nothing runs');
  const ranges = [{ anchor: at(0, 0), focus: at(0, 1) }];
  assert.deepEqual(HOME['x.selection.multi'].args(ranges), { ranges });
  assert.equal(HOME['x.selection.multi'].args([]), null);
});
