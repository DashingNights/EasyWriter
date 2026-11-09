import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { keyAmong, setKeybinds } from '../src/app/keybinds.js';
import { chordOf, DEFS, isMac, setMac } from '../src/app/keys.mjs';
import { graphemes, underlines, unitBoxes } from '../src/engine/input/compose.mjs';
import { attachInput } from '../src/engine/input/index.js';
import { BINDS, createKeymap } from '../src/engine/input/keys.mjs';
import { ENGINE_COMMANDS } from '../src/document/canvas/commands.mjs';
import { Engine, initSync } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

// The canvas editor's input (briefs/engine-input.md) against the real engine (engine-core's WebAssembly, in process), with just
// enough of a page in Node: an element, a window and an EditContext that behave as Chromium's do for these events. The harness case
// (.smoke-data/word/cases/engine-input.js) runs the same paths in Electron with the engine's worker, real EditContext and CDP
// input-method events.

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
// The engine's own fonts ship beside the .wasm, not in it (viewport-design.md section 11): added once for this file's engines.
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

setMac(false);
// The host's keymap (PageArea passes the same): the app's key helpers into the engine's Word keys. Word's keys run their
// commands through the tool registry there (keyCommand); here a Word command's table row (src/document/canvas/commands.mjs) runs
// its engine id on the page's client, as the registry does for an engine id or exec row. The run function names its command.
let toolClient = null;
function tool(cmd, arg) {
  const row = ENGINE_COMMANDS[cmd];
  if (row === undefined) return null;
  const id = typeof row === 'string' ? row : row?.exec;
  const params = typeof row?.args === 'function' ? row.args(arg) : row?.args ?? arg ?? {};
  return Object.assign(() => (id ? toolClient.exec(id, params) : undefined), { cmd });
}
const keyAction = createKeymap({ defs: DEFS, among: keyAmong, chordOf, isMac, tool });
globalThis.DOMRect ??= class DOMRect {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    Object.assign(this, { x, y, width, height, left: x, top: y });
  }
};

const ev = (type, props = {}) => Object.assign(new Event(type, { cancelable: true, bubbles: true }), props);
const CODES = { Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', Del: 'Delete' };
/** A keydown for chord 'Ctrl+Shift+Left' as KeyboardEvent fields. */
const keydown = (chord) => {
  const parts = chord.split('+');
  const k = parts.pop();
  const code = CODES[k] ?? (/^[A-Z]$/.test(k) ? `Key${k}` : /^\d$/.test(k) ? `Digit${k}` : k);
  return ev('keydown', { code, key: k, ctrlKey: parts.includes('Ctrl'), shiftKey: parts.includes('Shift'), altKey: parts.includes('Alt'),
    metaKey: false, isComposing: false, keyCode: 0 });
};

/** Chromium's EditContext for these tests: text, selection, and a composition range the input method rewrites. */
class FakeEditContext extends EventTarget {
  text = '';
  selectionStart = 0;
  selectionEnd = 0;
  comp = null;
  chars = null;
  updateText(s, e, t) {
    this.text = this.text.slice(0, s) + t + this.text.slice(e);
  }
  updateSelection(s, e) {
    [this.selectionStart, this.selectionEnd] = [s, e];
  }
  updateControlBounds(r) {
    this.control = r;
  }
  updateSelectionBounds(r) {
    this.caretBounds = r;
  }
  updateCharacterBounds(start, rects) {
    this.chars = { start, rects };
  }
  /** A key or a commit outside a composition: text at the caret. */
  type(t) {
    const s = this.selectionStart;
    this.updateText(s, this.selectionEnd, t);
    this.updateSelection(s + t.length, s + t.length);
    this.dispatchEvent(ev('textupdate', { text: t, updateRangeStart: s, updateRangeEnd: s, selectionStart: s + t.length, selectionEnd: s + t.length }));
  }
  /** The input method shows `t` as the composition, with its caret at the end, and `formats` as its ranges. */
  compose(t, formats = []) {
    if (!this.comp) {
      this.comp = [this.selectionStart, this.selectionStart];
      this.dispatchEvent(ev('compositionstart'));
    }
    const [s, e] = this.comp;
    this.updateText(s, e, t);
    this.comp = [s, s + t.length];
    this.updateSelection(s + t.length, s + t.length);
    this.dispatchEvent(ev('textupdate', { text: t, updateRangeStart: s, updateRangeEnd: e, selectionStart: s + t.length, selectionEnd: s + t.length }));
    this.dispatchEvent(ev('textformatupdate', { getTextFormats: () => formats }));
  }
  commit(t) {
    this.compose(t);
    this.comp = null;
    this.dispatchEvent(ev('compositionend'));
  }
}

const J = (s) => (s == null ? null : JSON.parse(s));
const S = JSON.stringify;
const at = (para, off) => ({ story: 'body', path: [para], off });

/** The engine in process, answering as src/engine/worker.js does (JSON in and out, a 'layout' event after each change, then a
 * 'selection' event after each change to the selection or its layout) and logging each call. */
function engineClient(text) {
  const e = new Engine();
  const listeners = { layout: new Set(), selection: new Set() };
  let sel = null;
  const calls = {
    selection: () => J(e.selection()),
    selectionEvent: () => J(e.selectionEvent()),
    caret: (p) => J(e.caret(S(p))),
    rects: (a, h) => J(e.rects(S(a), S(h))),
    move: (p, unit, dir, goalX) => J(e.move(S(p), unit, dir, goalX ?? undefined)),
    select: (a, h) => e.select(S(a), S(h)),
    hit: (page, x, y) => J(e.hit(page, x, y)),
    exec: (id, args = {}) => J(e.exec(id, S(args))),
    format: () => J(e.format()),
    state: (ids) => J(e.state(S(ids))),
    insertText: (t) => J(e.insertText(t)),
    deleteBackward: (unit = 'character') => J(e.deleteBackward(unit)),
    deleteForward: (unit = 'character') => J(e.deleteForward(unit)),
    compose: (t, s = t.length, f = s) => J(e.compose(t, s, f)),
    commit: () => e.commit(),
    undo: () => J(e.undo()),
    redo: () => J(e.redo()),
    text: (a, h) => e.text(S(a), S(h)),
    copy: (kind) => e.copy(kind),
    paste: (kind, bytes) => J(e.paste(kind, bytes)),
  };
  const client = { log: [], on: (ev, fn) => (listeners[ev]?.add(fn), () => listeners[ev]?.delete(fn)), call: (m, args = []) => client[m](...args) };
  for (const [name, fn] of Object.entries(calls)) {
    client[name] = async (...args) => {
      client.log.push([name, ...args]);
      const r = fn(...args);
      const layout = e.takeLayout();
      if (layout) for (const l of listeners.layout) l(J(layout));
      const now = `${e.version} ${e.selection()}`;
      if (now !== sel) {
        sel = now;
        const ev = J(e.selectionEvent());
        for (const l of listeners.selection) l(ev);
      }
      return r;
    };
  }
  text.split('\n').forEach((t, i) => {
    if (i) e.exec('text.newParagraph', '{}');
    e.insertText(t);
  });
  e.exec('caret.docStart', '{}');
  e.takeLayout();
  /** The whole text, paragraphs joined by \n. */
  client.all = () => e.text(S(at(0, 0)), S(J(e.move(S(at(0, 0)), 'document', 1)).pos)).replace(/\r/g, '\n');
  client.sel = () => J(e.selection());
  client.selText = () => calls.text(client.sel().anchor, client.sel().head).replace(/\r/g, '\n');
  return client;
}

/** A page area on a fake page: one point is one pixel, page 0 at the client origin. */
function page(text, opts = {}) {
  const win = new EventTarget();
  const doc = { defaultView: win, activeElement: null };
  const el = Object.assign(new EventTarget(), {
    ownerDocument: doc, tabIndex: -1, editContext: null, kids: [], style: {},
    getBoundingClientRect: () => new DOMRect(0, 0, 800, 900),
    contains(x) {
      return x === this || this.kids.includes(x);
    },
    append(x) {
      this.kids.push(x);
    },
    focus() {
      doc.activeElement = this;
      this.dispatchEvent(ev('focusin'));
    },
  });
  doc.createElement = () => {
    const ta = Object.assign(new EventTarget(), { style: {}, value: '', selectionStart: 0, selectionEnd: 0, setAttribute() {}, remove() {},
      focus() {
        doc.activeElement = ta;
        el.dispatchEvent(ev('focusin'));
      } });
    return ta;
  };
  const client = engineClient(text);
  toolClient = client;
  const written = [];
  const input = attachInput(el, {
    client,
    locate: (x, y) => ({ page: 0, x, y }),
    toClient: (_, x, y) => ({ x, y }),
    keymap: keyAction,
    clipboard: { write: async (d) => written.push(d) },
    ...opts,
  });
  const settle = async () => {
    for (let i = 0; i < 4; i++) await input.idle();
  };
  return { el, win, client, input, written, settle, ec: el.editContext };
}

globalThis.EditContext = FakeEditContext;

test('keys: Word movement and editing, app keybinds routed to engine commands', () => {
  const ids = new Set(DEFS.map((d) => d.id));
  assert.deepEqual(Object.keys(BINDS).filter((id) => !ids.has(id)), [], 'every bound id is in keys.mjs DEFS');
  const a = (chord) => keyAction(keydown(chord));
  assert.deepEqual(a('Left'), { call: 'exec', args: ['caret.left', { extend: false }] });
  assert.deepEqual(a('Ctrl+Shift+Right'), { call: 'exec', args: ['caret.wordRight', { extend: true }] });
  assert.deepEqual(a('Ctrl+Shift+End'), { call: 'exec', args: ['caret.docEnd', { extend: true }] });
  assert.deepEqual(a('Shift+PageDown'), { call: 'exec', args: ['caret.pageDown', { extend: true }] });
  const word = (chord) => a(chord)?.run?.cmd ?? null; // the Word command a key runs through the registry
  assert.equal(word('Ctrl+Up'), 'navigation.paraUp', "Word's row, through the table");
  assert.deepEqual(a('Ctrl+Backspace'), { call: 'deleteBackward', args: ['word'] });
  assert.deepEqual(a('Shift+Enter'), { call: 'exec', args: ['text.lineBreak'] });
  assert.deepEqual(a('Ctrl+B'), { call: 'exec', args: ['format.bold'] }, "Ctrl+B is Word's native key: the app's text.bold binding");
  assert.equal(word('Ctrl+Shift+B'), 'home.font.bold', "Word's own Ctrl+Shift+B runs through the table");
  assert.deepEqual(a('Ctrl+E'), { call: 'exec', args: ['para.alignCenter'] }, 'a Document centres on Ctrl+E');
  assert.equal(word('Ctrl+Shift+E'), 'review.tracking.trackChanges', "Word's Track Changes row takes Ctrl+Shift+E from Align centre");
  assert.deepEqual(a('Ctrl+Z'), { call: 'undo', args: [] });
  assert.deepEqual(a('Ctrl+Enter'), { call: 'exec', args: ['text.pageBreak'] });
  assert.equal(word('Ctrl+Shift+V'), 'paste.pasteTextOnly', 'Paste Text Only reads the clipboard through its row');
  assert.equal(word('Ctrl+Shift+F8'), 'selection.columnSelect', 'Column Select');
  assert.deepEqual(Object.keys(BINDS).filter((id) => id.startsWith('word.')), [], 'the table is the one map for Word’s keys');
  assert.equal(a('A'), null, 'a typed letter is the text source’s');
  assert.equal(a('Ctrl+S'), null, 'an app chord stays the app’s');
  setKeybinds({ 'text.bold': ['Ctrl+Alt+J'] });
  try {
    assert.deepEqual(a('Ctrl+Alt+J'), { call: 'exec', args: ['format.bold'] }, "the user's keybind override counts");
    assert.equal(a('Ctrl+B'), null);
  } finally {
    setKeybinds({});
  }
});

test('composition helpers: graphemes, unit boxes and underlines from format ranges', () => {
  assert.deepEqual(graphemes('𠮷你a'), ['𠮷', '你', 'a']);
  const b = (x, y = 72) => ({ page: 0, x, y, w: 14, h: 14 });
  const boxes = unitBoxes('𠮷你', [b(72), b(86)]);
  assert.equal(boxes.length, 3, '𠮷 is two UTF-16 units');
  assert.deepEqual(underlines(boxes, [], 3), [{ page: 0, x: 72, y: 86, w: 28, thick: false, style: 'solid' }]);
  const wrapped = [b(72), b(86), b(72, 86)];
  const u = underlines(wrapped, [{ rangeStart: 0, rangeEnd: 3, underlineStyle: 'Dashed', underlineThickness: 'Thick' }], 3);
  assert.deepEqual(u.map((x) => [x.y, x.w, x.thick, x.style]), [[86, 28, true, 'dashed'], [100, 14, true, 'dashed']], 'one underline per line');
  assert.deepEqual(underlines(wrapped, [{ rangeStart: 0, rangeEnd: 3, underlineStyle: 'none' }], 3), []);
});

test('typing, Cantonese compositions and the candidate window at the caret', async () => {
  const { ec, client, input, settle } = page('Hello world');
  assert.ok(ec instanceof FakeEditContext, 'EditContext on the page area');
  ec.type('A');
  ec.type('b');
  await settle();
  assert.equal(client.all(), 'AbHello world');
  assert.equal(ec.text, '', 'the EditContext keeps no copy of the document');

  // Microsoft Quick or a phonetic method: Latin keys first, then the character.
  for (const t of ['n', 'ne', 'nei']) ec.compose(t);
  await settle();
  assert.equal(client.all(), 'AbneiHello world', 'the composition is laid out inline');
  const nei = (await client.rects(at(0, 2), at(0, 5)))[0];
  const near = (a, b) => Math.abs(a - b) < 0.01;
  const snap = input.snapshot();
  assert.equal(snap.comp.length, 1, 'one underline under the composition');
  assert.ok(near(snap.comp[0].x, nei.x) && near(snap.comp[0].w, nei.w) && near(snap.comp[0].y, nei.y + nei.h), 'it spans the three composed letters');
  assert.equal(ec.chars.rects.length, 3, 'character bounds for each composed unit');
  assert.ok(near(ec.chars.rects[0].x, nei.x) && near(ec.chars.rects[2].x + ec.chars.rects[2].width, nei.x + nei.w), 'from the composition start to its end');
  assert.ok(near(ec.caretBounds.x, (await client.caret(at(0, 5))).x), 'selection bounds at the caret (the candidate window anchor)');
  ec.compose('你');
  ec.commit('你');
  for (const t of ['h', 'ho', 'hou']) ec.compose(t);
  ec.commit('好');
  await settle();
  assert.equal(client.all(), 'Ab你好Hello world');
  assert.deepEqual(input.snapshot().comp, [], 'no underline after the commit');

  // 廣東話 through a phonetic method that converts as it goes, committed once.
  for (const t of ['g', 'gw', 'gwo', 'gwong', '廣', '廣d', '廣du', '廣dung', '廣東', '廣東w', '廣東wa', '廣東waa', '廣東話']) ec.compose(t);
  await settle();
  assert.equal(ec.chars.rects.length, 3);
  const r = ec.chars.rects;
  assert.ok(r.every((b, i) => b.width > 0 && (!i || near(r[i - 1].x + r[i - 1].width, b.x))), 'one box per character, side by side');
  ec.commit('廣東話');
  await settle();
  assert.equal(client.all(), 'Ab你好廣東話Hello world');
  const composes = client.log.filter((l) => l[0] === 'compose').length;
  assert.ok(composes < 3 + 1 + 3 + 1 + 13 + 1, `updates queued behind a busy engine collapse (${composes} compose calls)`);
  await client.undo();
  assert.equal(client.all(), 'Ab你好Hello world', 'a composition is one undo step');
  await client.redo();

  // Escape cancels a composition: the input method empties it, nothing is inserted.
  ec.compose('x');
  ec.commit('');
  await settle();
  assert.equal(client.all(), 'Ab你好廣東話Hello world');
  // Frame timings land on a later frame: wait for them (a fixed 20 ms failed under load).
  for (let i = 0; i < 100 && !input.timings.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(input.timings.length > 0, 'input to frame times are kept');
});

test('keys move and select, delete, undo and redo through the engine', async () => {
  const { el, client, settle } = page('one two three\nsecond line');
  const key = async (chord) => {
    const e = keydown(chord);
    el.dispatchEvent(e);
    await settle();
    return e.defaultPrevented;
  };
  const sel = () => {
    const { anchor, head } = client.sel();
    return [anchor.path[0], anchor.off, head.path[0], head.off];
  };
  assert.equal(await key('End'), true, 'a handled key is prevented');
  assert.deepEqual(sel(), [0, 13, 0, 13]);
  await key('Ctrl+Left');
  assert.deepEqual(sel(), [0, 8, 0, 8]);
  await key('Ctrl+Shift+Left');
  assert.deepEqual(sel(), [0, 8, 0, 4]);
  await key('Left');
  assert.deepEqual(sel(), [0, 4, 0, 4], 'Left collapses a selection to its start, as in Word');
  const x = (await client.caret(client.sel().head)).x;
  await key('Down');
  const below = await client.caret(client.sel().head);
  assert.ok(sel()[2] === 1 && Math.abs(below.x - x) < 8, `Down keeps the column (${x} to ${below.x})`);
  await key('Ctrl+Home');
  await key('Ctrl+Shift+End');
  assert.deepEqual(sel(), [0, 0, 1, 11]);
  await key('Ctrl+End');
  await key('Ctrl+Backspace');
  assert.equal(client.all(), 'one two three\nsecond ');
  await key('Enter');
  assert.equal(client.all(), 'one two three\nsecond \n');
  await key('Ctrl+Z');
  await key('Ctrl+Z');
  assert.equal(client.all(), 'one two three\nsecond line');
  await key('Ctrl+Y');
  assert.equal(client.all(), 'one two three\nsecond ');
  await key('Ctrl+Shift+Home');
  await key('Ctrl+B');
  assert.equal((await client.state(['format.bold']))['format.bold'].checked, true, 'Ctrl+B bolds through the engine');
  assert.equal(await key('Ctrl+S'), false, 'an app chord is left alone');
});

test('pointer: click, drag, double and triple click, Shift+click', async () => {
  const { el, win, client, settle } = page('alpha beta gamma\nnext paragraph');
  // The client point just right of the caret before character `off` of paragraph `para`.
  const pt = async (off, para = 0) => {
    const c = await client.caret(at(para, off));
    return { clientX: c.x + 0.5, clientY: c.y + c.h / 2 };
  };
  const down = async (off, para, more = {}) => el.dispatchEvent(ev('mousedown', { button: 0, detail: 1, ...(await pt(off, para)), ...more }));
  const move = async (off, para = 0) => win.dispatchEvent(ev('mousemove', await pt(off, para)));
  const up = () => win.dispatchEvent(ev('mouseup'));
  await down(6, 0);
  up();
  await settle();
  assert.deepEqual(client.sel().head, at(0, 6), 'a click places the caret where it hits');
  await down(0, 0);
  await move(10);
  await move(12);
  up();
  await settle();
  assert.equal(client.selText(), 'alpha beta g', 'a drag selects to the pointer');
  await down(13, 0, { detail: 2 });
  up();
  await settle();
  assert.match(client.selText(), /^gamma/, 'a double click selects the word');
  await down(2, 1, { detail: 3 });
  up();
  await settle();
  assert.match(client.selText(), /^next paragraph/, 'a triple click selects the paragraph');
  await down(0, 0);
  up();
  await down(5, 0, { shiftKey: true });
  up();
  await settle();
  assert.equal(client.selText(), 'alpha', 'Shift+click extends from the anchor');
  await down(1, 0, { detail: 2 });
  await move(8);
  up();
  await settle();
  assert.match(client.selText(), /^alpha beta/, 'a drag after a double click grows by words');

  // A press on the scroll element's scrollbar (past its client box) or on a control inside it is not a click on the pages.
  await down(0, 0);
  up();
  await settle();
  Object.assign(el, { clientWidth: 780, clientHeight: 880 });
  await down(6, 0, { offsetX: 790, offsetY: 10 });
  const badge = { closest: () => badge };
  el.kids.push(badge);
  const onBadge = ev('mousedown', { button: 0, detail: 1, ...(await pt(6)) });
  Object.defineProperty(onBadge, 'target', { value: badge });
  el.dispatchEvent(onBadge);
  await settle();
  assert.deepEqual(client.sel().head, at(0, 0), 'the caret stays put');
  // A move with no button down ends the drag (its mouseup went elsewhere).
  await down(0, 0);
  win.dispatchEvent(ev('mousemove', { ...(await pt(4)), buttons: 0 }));
  await move(8);
  await settle();
  assert.equal(client.selText(), '', 'the selection no longer follows the pointer');
  // Alt+drag selects a column.
  await down(1, 0, { altKey: true });
  await move(3, 1);
  up();
  await settle();
  assert.ok(client.log.findLast((l) => l[0] === 'exec' && l[1] === 'select.column'), 'Alt+drag runs select.column');
});

test('a click while composing commits the composition where it is', async () => {
  const { el, ec, client, input, settle } = page('alpha beta');
  ec.compose('nei');
  await settle();
  const c = await client.caret(at(0, 8));
  el.dispatchEvent(ev('mousedown', { button: 0, detail: 1, clientX: c.x + 0.5, clientY: c.y + c.h / 2 }));
  el.ownerDocument.defaultView.dispatchEvent(ev('mouseup'));
  ec.comp = null;
  ec.dispatchEvent(ev('compositionend')); // the browser's late compositionend commits nothing twice
  ec.type('x');
  await settle();
  assert.equal(client.all(), 'neialphax beta');
  assert.deepEqual(input.snapshot().comp, [], 'no underline left');
});

test('clipboard: copy and cut write text and HTML; paste goes through the engine', async () => {
  const { el, client, input, written, settle } = page('copy me please');
  const clip = (type, data = {}, files = []) => {
    const e = ev(type, { clipboardData: { getData: (t) => data[t] ?? '', files } });
    el.dispatchEvent(e);
    return e;
  };
  const bold = async (a, b) => {
    await client.select(at(0, a), at(0, b));
    return (await client.state(['format.bold']))['format.bold'].checked;
  };
  await client.select(at(0, 0), at(0, 4));
  assert.equal(clip('copy').defaultPrevented, true);
  await settle();
  assert.ok(written.at(-1)?.text === 'copy' && written.at(-1).html.includes('>copy</'), JSON.stringify(written.at(-1)));
  clip('cut');
  await settle();
  assert.equal(client.all(), ' me please');
  clip('paste', { 'text/plain': 'Pasted bold', 'text/html': '<p>Pasted <b>bold</b></p>', 'text/rtf': '{\\rtf1 x}' });
  await settle();
  assert.equal(client.all(), 'Pasted bold me please', 'HTML from another program pastes');
  assert.equal(await bold(7, 11), true, 'with its formatting');
  // A copy made here pastes back from the engine's own copy, whatever HTML the clipboard holds.
  await client.select(at(0, 0), at(0, 11));
  clip('copy');
  await settle();
  await client.select(at(0, 21), at(0, 21));
  clip('paste', { 'text/plain': 'Pasted bold', 'text/html': '<p>Pasted bold</p>' });
  await settle();
  assert.equal(client.all(), 'Pasted bold me pleasePasted bold');
  assert.equal(await bold(28, 32), true, 'the engine pastes its own copy without loss');
  // A .docx file pastes as one: a Word file the engine writes.
  await client.select(at(0, 0), at(0, 6));
  const docx = new File([await client.copy('docx')], 'Report.docx');
  await client.select(at(0, 0), at(0, 0));
  clip('paste', {}, [docx]);
  await settle();
  assert.ok(client.log.some((l) => l[0] === 'paste' && l[1] === 'docx'), 'a .docx file goes to paste(docx)');
  assert.match(client.all(), /^PastedPasted bold/);
  // Paste Text Only (the ribbon's and the menus' handle; its key runs the row, which reads the clipboard itself).
  input.paste({ text: 'plain', html: '<b>rich</b>' }, true);
  await settle();
  assert.deepEqual(client.log.findLast((l) => l[0] === 'exec'), ['exec', 'edit.pasteText', { text: 'plain' }], 'Paste Text Only');
  assert.match(client.all(), /plain/);
  clip('paste', { 'text/plain': 'rich', 'text/html': '<b>rich</b>' });
  await settle();
  assert.equal(client.log.findLast((l) => l[0] === 'exec')[1], 'edit.paste');
  // A caret copies nothing.
  const n = written.length;
  clip('copy');
  await settle();
  assert.equal(written.length, n);
});

test('the textarea fallback types and composes the same way', async () => {
  const { el, client, input, settle } = page('xy', { editContext: false });
  assert.equal(el.editContext, null);
  const ta = el.kids[0];
  input.focus();
  assert.equal(el.ownerDocument.activeElement, ta, 'the focus goes to the hidden textarea');
  ta.value = 'a';
  ta.dispatchEvent(ev('input', { inputType: 'insertText', data: 'a' }));
  assert.equal(ta.value, '', 'emptied after each insert');
  ta.dispatchEvent(ev('compositionstart'));
  for (const t of ['nei', '你']) {
    ta.value = t;
    ta.selectionStart = ta.selectionEnd = t.length;
    ta.dispatchEvent(ev('input', { inputType: 'insertCompositionText', data: t }));
  }
  ta.dispatchEvent(ev('compositionend', { data: '你' }));
  ta.dispatchEvent(ev('input', { inputType: 'insertFromComposition', data: '你' })); // Safari's repeat, ignored
  await settle();
  assert.equal(client.all(), 'a你xy');
  assert.equal(ta.style.left, `${(await client.caret(at(0, 4))).x}px`, 'the textarea sits at the caret for the candidate window');
});
