// engine-gaps-editing (docs/plans/word/briefs/engine-gaps-editing.md): the pure parts of the editing gaps on a canvas draft: the
// keys F2 and the accent prefixes wait for, Paste Options' rows, AutoFormat Now's plan in the engine's UTF-8 offsets, Web Go Back
// and Forward, and the harness's numpad keys. The harness case engine-gaps-editing runs them against the engine.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { canvasKey, HOME, pending } from '../src/document/canvas/rows/home.mjs';
import { byteOffsets, canvasPlan } from '../src/document/wp/autocorrect/canvas.mjs';
import { canGo, follow, followAt, linkHooks, webGo } from '../src/document/wp/fields-ref/canvas.mjs';

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
/** A fake session client recording its calls. */
function fakeClient() {
  const calls = [];
  let sel = { anchor: { path: [0], off: 0 }, head: { path: [0], off: 0 } };
  return {
    calls,
    insertText: async (t) => calls.push(['insertText', t]),
    exec: async (id, args) => (calls.push([id, args]), { ok: true, value: null }),
    selection: async () => sel,
    select: async (anchor, head) => {
      sel = { anchor, head };
      calls.push(['select', anchor.off, head.off]);
    },
  };
}

test('an accent prefix waits for the next letter, and Enter after F2 moves the text there', async () => {
  const c = fakeClient();
  pending.prefix = "Ctrl+'";
  await canvasKey(key('E', { shiftKey: true }), c)();
  assert.deepEqual(c.calls.at(-1), ['insertText', 'É']);
  pending.prefix = "Ctrl+'";
  assert.equal(canvasKey(key('q'), c), null, 'a letter with no accented form types itself');
  assert.equal(pending.prefix, null);
  pending.move = { src: { anchor: { off: 0 }, head: { off: 4 } }, copy: true };
  assert.equal(canvasKey(key('Enter', { shiftKey: true }), c), null);
  await canvasKey(key('Enter'), c)();
  assert.deepEqual(c.calls.at(-1), ['edit.moveTo', { anchor: { off: 0 }, focus: { off: 4 }, copy: true }]);
  assert.equal(pending.move, null);
});

test('F2 waits in its own draft only, and an edit ends the wait', async () => {
  const listeners = new Set();
  const draft = (id) => ({
    ...fakeClient(),
    id,
    selection: async () => ({ anchor: { off: 0 }, head: { off: 4 } }),
    steps: async () => ({ undo: 7, redo: null }),
    on: (ev, fn) => (ev === 'layout' && listeners.add(fn), () => listeners.delete(fn)),
  });
  const a = draft('A');
  const b = draft('B');
  const F2 = HOME['editing.move'];
  assert.equal(await F2.run({ engine: a }), true);
  assert.equal(F2.active({ engine: a }), true);
  assert.equal(F2.active({ engine: b }), false, 'not pressed in another draft');
  assert.equal(canvasKey(key('Enter'), b), null, 'Enter in another draft is a plain Enter');
  assert.equal(pending.move, null);
  await F2.run({ engine: a });
  for (const fn of [...listeners]) fn({ steps: { undo: 7, redo: null } }); // a layout slice: same steps
  assert.notEqual(pending.move, null);
  for (const fn of [...listeners]) fn({ steps: { undo: 8, redo: null } }); // typing: a new undo step
  assert.equal(pending.move, null, 'an edit ends the wait');
  assert.equal(listeners.size, 0);
});

test('Paste Options rows offer the last paste\'s choices and run edit.repaste', async () => {
  const calls = [];
  const lp = { option: 'keepSource', table: false, list: true, options: ['keepSource', 'merge', 'text', 'continueList', 'newList'] };
  const ctx = { engine: { exec: async (id, args) => (calls.push([id, args]), { ok: true }) }, stateOf: () => ({ checked: true, value: lp }) };
  assert.equal(HOME['paste.optionsButton'].enabled(ctx), true);
  assert.equal(HOME['paste.tableChoices'].enabled(ctx), false);
  assert.equal(HOME['paste.listChoices'].enabled(ctx), true);
  await HOME['paste.optionsButton'].run(ctx, 'keepTextOnly');
  await HOME['paste.listChoices'].run(ctx, 'new');
  assert.equal(await HOME['paste.tableChoices'].run(ctx, 'nestTable'), false);
  assert.deepEqual(calls, [['edit.repaste', { as: 'text' }], ['edit.repaste', { as: 'newList' }]]);
  const none = { stateOf: () => ({ checked: false, value: null }) };
  assert.equal(HOME['paste.optionsButton'].enabled(none), false);
  // A table pasted into a cell: Word's four table choices.
  const table = { option: 'nest', table: true, list: false, options: ['nest', 'rows', 'overwrite', 'text'] };
  const tctx = { ...ctx, stateOf: () => ({ checked: true, value: table }) };
  assert.equal(HOME['paste.tableChoices'].enabled(tctx), true);
  await HOME['paste.tableChoices'].run(tctx, 'insertAsNewRows');
  await HOME['paste.tableChoices'].run(tctx, 'overwriteCells');
  assert.deepEqual(calls.slice(-2), [['edit.repaste', { as: 'rows' }], ['edit.repaste', { as: 'overwrite' }]]);
});

test('AutoFormat Now plans in the engine\'s UTF-8 byte offsets', () => {
  assert.deepEqual(byteOffsets('aé😀b'), [0, 1, 3, 7, 7, 8]);
  const now = { quotes: true, ordinals: true, fractions: true, dashes: true, boldItalic: true, links: true, headings: false };
  const plan = canvasPlan([{ path: [0], text: 'é *big* 1st -- end', styled: false, list: false, inTable: false }], now);
  const bold = plan.edits.find((e) => e.mark === 'bold');
  assert.deepEqual(bold && [bold.from, bold.to, bold.insert], [3, 8, 'big']);
  assert.ok(plan.edits.some((e) => e.mark === 'superscript'));
  assert.ok(plan.edits.some((e) => e.insert === '–'));
});

test('a followed link joins Web Go Back, and Back and Forward walk the places', async () => {
  const c = fakeClient();
  assert.equal(canGo(c, -1), false);
  await c.select({ path: [0], off: 2 }, { path: [0], off: 2 });
  assert.equal(await follow(c, { bookmark: 'Goal' }), true);
  assert.deepEqual(c.calls.at(-1), ['edit.goto', { bookmark: 'Goal' }]);
  assert.equal(canGo(c, -1), true);
  await c.select({ path: [3], off: 0 }, { path: [3], off: 4 });
  assert.equal(await webGo(c, -1), true);
  assert.deepEqual(c.calls.at(-1), ['select', 2, 2]);
  assert.equal(canGo(c, 1), true);
  assert.equal(await webGo(c, 1), true);
  assert.deepEqual(c.calls.at(-1), ['select', 0, 4]);
});

test('a click follows a link on Ctrl+click, or on a plain click with the Ctrl+click option off', async () => {
  const c = fakeClient();
  c.exec = async (id, args) => (c.calls.push([id, args]), id === 'document.context' ? { ok: true, value: { link: { bookmark: 'Goal' } } } : { ok: true });
  const pos = { path: [0], off: 1 };
  assert.equal(await followAt(c, pos, {}), false, 'a plain click places the caret');
  assert.equal(await followAt(c, pos, { ctrlKey: true }), true);
  assert.deepEqual(c.calls.at(-1), ['edit.goto', { bookmark: 'Goal' }]);
  linkHooks.ctrlClick = () => false;
  try {
    const n = c.calls.length;
    assert.equal(await followAt(c, pos, { ctrlKey: true }), false, 'Ctrl+click selects the sentence');
    assert.equal(c.calls.length, n, 'without asking the engine');
    assert.equal(await followAt(c, pos, {}), true);
  } finally {
    linkHooks.ctrlClick = () => true;
  }
});

test('the harness key helper sends numpad keys at the numpad location', () => {
  const { chordOf } = createRequire(import.meta.url)('../.smoke-data/word/lib.js');
  assert.deepEqual([chordOf('Ctrl+Alt+Num-').code, chordOf('Ctrl+Alt+Num-').location], ['NumpadSubtract', 3]);
  assert.equal(chordOf('Ctrl+Num5').windowsVirtualKeyCode, 101);
  assert.equal(chordOf('Ctrl+-').location, undefined);
});
