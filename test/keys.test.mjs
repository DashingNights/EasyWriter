import assert from 'node:assert/strict';
import test from 'node:test';
import { chordOf, codeOf, collisions, DEFS, effective, GROUPS, keyName, normalize, overridesOf, windowsUse } from '../src/app/keys.mjs';

test('chordOf names the physical key with modifiers in a fixed order; Meta counts as Ctrl; a lone modifier is no chord', () => {
  assert.equal(chordOf({ code: 'KeyP', ctrlKey: true, altKey: true }), 'Ctrl+Alt+P');
  assert.equal(chordOf({ code: 'KeyA', shiftKey: true, metaKey: true }), 'Ctrl+Shift+A');
  assert.equal(chordOf({ code: 'Equal', control: true }), 'Ctrl+='); // Electron's before-input-event input
  assert.equal(chordOf({ code: 'NumpadAdd', ctrlKey: true }), 'Ctrl+Num+');
  assert.equal(chordOf({ code: 'Digit1', altKey: true }), 'Alt+1');
  assert.equal(chordOf({ code: 'ArrowLeft', altKey: true }), 'Alt+Left');
  assert.equal(chordOf({ code: 'ControlLeft', ctrlKey: true }), null);
  for (const code of ['KeyZ', 'Digit7', 'Numpad3', 'F5', 'Backslash', 'Space', 'NumpadSubtract', 'ArrowDown']) assert.equal(codeOf(keyName(code)), code);
});

test('normalize fixes modifier order and case, keeps Num+, and rejects what is no chord', () => {
  assert.equal(normalize('shift+ctrl+a'), null); // key names are case-sensitive: "a" is not a key
  assert.equal(normalize('Shift+Ctrl+A'), 'Ctrl+Shift+A');
  assert.equal(normalize('alt+ctrl+P'), 'Ctrl+Alt+P');
  assert.equal(normalize('Ctrl+Num+'), 'Ctrl+Num+');
  assert.equal(normalize('Num+'), 'Num+');
  assert.equal(normalize('Win+V'), null);
  assert.equal(normalize('Ctrl+'), null);
});

test('windowsUse: system, standard and AltGr chords, and plain typing keys', () => {
  assert.equal(windowsUse('Alt+Tab').level, 'system');
  assert.equal(windowsUse('Ctrl+Shift+Esc').level, 'system');
  assert.equal(windowsUse('Ctrl+C').level, 'standard');
  assert.equal(windowsUse('Ctrl+Alt+E').level, 'layout');
  assert.equal(windowsUse('T').level, 'typing');
  assert.equal(windowsUse('Shift+/').level, 'typing');
  assert.equal(windowsUse('Ctrl+Alt+P'), null);
  assert.equal(windowsUse('F5'), null);
});

const SAMPLE = [
  { id: 'save', keys: ['Ctrl+S'], scope: 'global' },
  { id: 'bold', keys: ['Ctrl+B'], scope: 'text' },
  { id: 'plan.new', keys: ['N'], scope: 'plan' },
  { id: 'board.text', keys: ['T'], scope: 'board' },
  { id: 'browser.tab', keys: ['Ctrl+T'], scope: 'browser' },
  { id: 'zoom', keys: ['Ctrl+=', 'Ctrl+Num+'], scope: 'global' },
];

test('effective applies overrides (an empty list unbinds) and drops chords that do not parse', () => {
  const b = effective(SAMPLE, { bold: ['Ctrl+Shift+B'], 'plan.new': [], zoom: ['Ctrl+=', 'nonsense'] });
  assert.deepEqual(b.bold, ['Ctrl+Shift+B']);
  assert.deepEqual(b['plan.new'], []);
  assert.deepEqual(b.zoom, ['Ctrl+=']);
  assert.deepEqual(b.save, ['Ctrl+S']);
  assert.deepEqual(overridesOf(SAMPLE, b), { bold: ['Ctrl+Shift+B'], 'plan.new': [], zoom: ['Ctrl+='] });
  assert.deepEqual(overridesOf(SAMPLE, effective(SAMPLE)), {});
});

test('collisions: a shared chord in overlapping scopes, both ways; separate scopes never collide', () => {
  const b = effective(SAMPLE, { bold: ['Ctrl+S'], 'plan.new': ['T'], 'browser.tab': ['Ctrl+B'] });
  const c = collisions(SAMPLE, b);
  assert.deepEqual(c.save, [{ id: 'bold', chord: 'Ctrl+S' }]); // global overlaps every scope
  assert.deepEqual(c.bold, [{ id: 'save', chord: 'Ctrl+S' }]);
  assert.equal(c['plan.new'], undefined); // plan and board are never active together
  assert.equal(c['browser.tab'], undefined); // browser and text likewise
});

test('the registry: unique ids, known groups and scopes, every default parses, and no two defaults collide', () => {
  const ids = DEFS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const d of DEFS) {
    assert.ok(GROUPS.includes(d.group), d.id);
    assert.ok(['global', 'editor', 'text', 'board', 'plan', 'flows', 'browser', 'chat'].includes(d.scope), d.id);
    for (const k of d.keys) assert.equal(normalize(k), k, `${d.id} ${k}`);
  }
  assert.deepEqual(collisions(DEFS, effective(DEFS)), {});
});
