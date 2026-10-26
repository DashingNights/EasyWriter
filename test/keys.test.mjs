import assert from 'node:assert/strict';
import test from 'node:test';
import { kindOf } from '../src/flow/shapes.mjs';
import { chordOf, codeOf, collisions, DEFS, effective, GROUPS, keyName, normalize, overridesOf, SHAPE_KEYS, windowsUse } from '../src/app/keys.mjs';

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
    assert.ok(['global', 'editor', 'text', 'document', 'board', 'plan', 'flows', 'browser', 'chat'].includes(d.scope), d.id);
    for (const k of d.keys) assert.equal(normalize(k), k, `${d.id} ${k}`);
  }
  assert.deepEqual(collisions(DEFS, effective(DEFS)), {});
});

test('board keys: B, O, L and Shift+L arm Box, Circle, Line and Arrow (R stays Rotate); Q keeps the tool on', () => {
  const b = effective(DEFS);
  assert.deepEqual(Object.fromEntries(Object.entries(SHAPE_KEYS).map(([kind, id]) => [kindOf(kind).label, b[id]])),
    { Box: ['B'], Circle: ['O'], Line: ['L'], Arrow: ['Shift+L'] });
  assert.deepEqual(b['board.rotate'], ['R']);
  assert.deepEqual(b['board.keepTool'], ['Q']);
});

test('board keys: Ctrl+Shift+L locks and Ctrl+Shift+H hides (Figma), Align left keeps Ctrl+Shift+L in text', () => {
  const b = effective(DEFS);
  assert.deepEqual([b['board.lock'], b['board.hide'], b['text.alignLeft']], [['Ctrl+Shift+L'], ['Ctrl+Shift+H'], ['Ctrl+Shift+L']]);
  assert.equal(collisions(DEFS, b)['board.lock'], undefined);
});

test('board keys: Ctrl+G groups and Ctrl+Shift+G ungroups (Figma)', () => {
  const b = effective(DEFS);
  assert.deepEqual([b['board.group'], b['board.ungroup']], [['Ctrl+G'], ['Ctrl+Shift+G']]);
});

test("Document keys: Word's chords, Ctrl+E shadowing inline code, none taking a global chord, the board keeping its own", () => {
  const b = effective(DEFS);
  const docs = DEFS.filter((d) => d.scope === 'document');
  assert.ok(docs.every((d) => d.group === 'Document' && d.id.startsWith('document.')));
  assert.deepEqual([b['document.alignCenter'], b['document.growFont1'], b['document.indent'], b['document.normalStyle']], [['Ctrl+E'], ['Ctrl+]'], ['Ctrl+M'], ['Ctrl+Shift+N']]);
  assert.deepEqual(DEFS.find((d) => d.id === 'document.alignCenter').shadows, ['text.code']);
  assert.deepEqual(b['document.pageBreak'], ['Ctrl+Enter']); // nothing else binds Ctrl+Enter: no collision below
  const c = collisions(DEFS, b);
  for (const d of docs) assert.equal(c[d.id], undefined, d.id);
  const global = new Set(DEFS.filter((d) => d.scope === 'global').flatMap((d) => b[d.id]));
  for (const d of docs) for (const k of b[d.id]) assert.ok(!global.has(k), `${d.id} ${k}`);
  // Without the shadow, Ctrl+E would collide with inline code.
  assert.ok(collisions(DEFS.map((d) => (d.id === 'document.alignCenter' ? { ...d, shadows: undefined } : d)), b)['document.alignCenter']);
  assert.deepEqual([b['board.forward'], b['board.duplicate']], [['Ctrl+]'], ['Ctrl+J']]); // same chords, scopes that never overlap
});

test('Ctrl+N opens New draft everywhere and collides with nothing (N alone stays the plan and flowchart key)', () => {
  const b = effective(DEFS);
  assert.deepEqual(b['app.newDraft'], ['Ctrl+N']);
  assert.equal(DEFS.find((d) => d.id === 'app.newDraft').scope, 'global');
  assert.equal(collisions(DEFS, b)['app.newDraft'], undefined);
  assert.deepEqual(DEFS.filter((d) => b[d.id].includes('Ctrl+N')).map((d) => d.id), ['app.newDraft']);
});

test('Suggestions: the four chords, no collisions, none an AltGr character; Ctrl+Alt+[ and ] warn as AltGr', () => {
  const b = effective(DEFS);
  assert.deepEqual(['suggest.next', 'suggest.previous', 'suggest.accept', 'suggest.reject'].map((id) => b[id]),
    [['Ctrl+Alt+PageDown'], ['Ctrl+Alt+PageUp'], ['Ctrl+Alt+Enter'], ['Ctrl+Alt+Backspace']]);
  assert.ok(DEFS.filter((d) => d.id.startsWith('suggest.')).every((d) => d.group === 'Suggestions' && d.scope === 'editor'));
  assert.ok(GROUPS.includes('Suggestions'));
  assert.deepEqual(collisions(DEFS, b), {});
  for (const id of ['suggest.next', 'suggest.previous', 'suggest.accept', 'suggest.reject']) assert.equal(windowsUse(b[id][0]), null, id);
  assert.equal(windowsUse('Ctrl+Alt+]').level, 'layout');
  assert.equal(windowsUse('Ctrl+Alt+[').level, 'layout');
});
