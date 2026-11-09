import assert from 'node:assert/strict';
import test from 'node:test';
import { kindOf } from '../src/flow/shapes.mjs';
import { chordOf, chordText, codeOf, collisions, DEFS, effective, GROUPS, keybindsKey, keyName, macUse, normalize, osUse, overridesOf, partName, setMac,
  SHAPE_KEYS, windowsUse, WORD_DEFS } from '../src/app/keys.mjs';

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

test("Document keys: Word's chords, Ctrl+E shadowing inline code, no document.* binding taking a global chord, the board keeping its own", () => {
  const b = effective(DEFS);
  // The app's own Document bindings; Word's (word.*) are checked below and in test/word-keys.test.mjs.
  const docs = DEFS.filter((d) => d.id.startsWith('document.'));
  assert.ok(docs.every((d) => d.group === 'Document' && d.scope === 'document'));
  assert.deepEqual([b['document.alignCenter'], b['document.growFont1'], b['document.indent'], b['document.normalStyle']], [['Ctrl+E'], ['Ctrl+]'], ['Ctrl+M'], ['Ctrl+Shift+N']]);
  assert.deepEqual(DEFS.find((d) => d.id === 'document.alignCenter').shadows, ['text.code']);
  assert.deepEqual(b['document.pageBreak'], ['Ctrl+Enter']); // nothing else binds Ctrl+Enter: no collision below
  const c = collisions(DEFS, b);
  for (const d of docs) assert.equal(c[d.id], undefined, d.id);
  const global = new Set(DEFS.filter((d) => d.scope === 'global').flatMap((d) => b[d.id]));
  for (const d of docs) for (const k of b[d.id]) assert.ok(!global.has(k), `${d.id} ${k}`);
  // Without the shadow, Ctrl+E would collide with inline code.
  assert.ok(collisions(DEFS.map((d) => (d.id === 'document.alignCenter' ? { ...d, shadows: undefined } : d)), b)['document.alignCenter']);
  assert.deepEqual([b['board.forward'], b['board.duplicate']], [['Ctrl+]'], ['Ctrl+D', 'Ctrl+J']]); // same chords, scopes that never overlap
});

// Every Word chord that equals a global, editor or text chord names that binding in its shadows (plan.md §1.13 Shadows), on
// Windows and on a Mac, so the collision tests cannot pass by accident.
const shadowsComplete = () => {
  const b = effective(DEFS);
  const app = DEFS.filter((d) => ['global', 'editor', 'text'].includes(d.scope));
  for (const w of WORD_DEFS) for (const k of b[w.id]) for (const a of app) if (b[a.id].includes(k)) assert.ok(w.shadows?.includes(a.id), `${w.id} ${k} ${a.id}`);
};
test('Word keys: every chord an app binding holds in an overlapping scope is in shadows (Windows)', shadowsComplete);
test('Word keys: every chord an app binding holds in an overlapping scope is in shadows (Mac)', () => {
  setMac(true);
  try { shadowsComplete(); } finally { setMac(false); }
});

// The app chords Word moves inside Document text (plan.md §1.13 App chords this moves): a Word binding holds the chord and
// shadows the app binding, which keeps its chord everywhere else.
const MOVED = [
  ['app.toolSearch', 'Ctrl+Space', 'word.font.resetChar'], ['app.quickTools', 'Ctrl+Tab', 'word.chars.tabInCell'],
  ['app.assistant', 'Ctrl+Shift+A', 'word.font.allCaps'], ['app.dictate', 'Ctrl+Shift+D', 'word.font.doubleUnderline'],
  ['app.zoomIn', 'Ctrl+=', 'word.views.zoomIn'], ['app.zoomOut', 'Ctrl+-', 'word.views.zoomOut'], ['app.zoomReset', 'Ctrl+0', 'word.view.zoom.zoom100'],
  ['app.zoomIn', 'Ctrl+Shift+=', 'word.home.font.superscript'], ['app.zoomOut', 'Ctrl+Shift+-', 'word.home.font.subscript'],
  ['app.zoomOut', 'Ctrl+Num-', 'word.chars.enDash'], ['app.devtools', 'Ctrl+Shift+I', 'word.home.font.italic'],
  ['app.plans', 'Ctrl+Alt+P', 'word.view.views.printLayout'], ['insert.canvas', 'Ctrl+Alt+C', 'word.editing.copyFormat'],
  ['insert.flowchart', 'Ctrl+Alt+F', 'word.references.footnotes.insertFootnote'], ['suggest.next', 'Ctrl+Alt+PageDown', 'word.navigation.endOfWindow'],
  ['suggest.previous', 'Ctrl+Alt+PageUp', 'word.navigation.startOfWindow'], ['suggest.accept', 'Ctrl+Alt+Enter', 'word.styles.styleSeparator'],
  ['app.sidebar', 'Ctrl+\\', 'word.outlining.masterDocument.collapseSubdocuments'], ['text.alignLeft', 'Ctrl+Shift+L', 'word.styles.listBulletKey'],
  ['text.alignCenter', 'Ctrl+Shift+E', 'word.review.tracking.trackChanges'], ['text.alignRight', 'Ctrl+Shift+R', 'word.wordCount.recount'],
  ['text.alignJustify', 'Ctrl+Shift+J', 'word.home.paragraph.distributed'], ['text.subscript', 'Ctrl+,', 'word.chars.accentPrefixes'],
  ['text.orderedList', 'Ctrl+Shift+7', 'word.chars.accentPrefixes'], ['text.bulletList', 'Ctrl+Shift+8', 'word.home.paragraph.showAll'],
  ['text.strike', 'Ctrl+Shift+S', 'word.home.styles.styles.applyStyles'], ['edit.redo', 'Ctrl+Shift+Z', 'word.font.resetChar'],
  ['text.blockquote', 'Ctrl+Shift+B', 'word.home.font.bold'], ['text.heading5', 'Ctrl+Alt+5', 'word.pictures.objectLayer'],
];
test('Word keys: each moved app chord, its Word binding, and the app binding keeping the chord outside Document text', () => {
  const b = effective(DEFS);
  for (const [app, chord, word] of MOVED) {
    assert.ok(b[app].includes(chord), `${app} ${chord}`);
    assert.ok(b[word]?.includes(chord), `${word} ${chord}`);
    assert.ok(DEFS.find((d) => d.id === word).shadows.includes(app), `${word} shadows ${app}`);
  }
  assert.deepEqual(b['app.toolSearchDoc'], ['Alt+Q']);
  assert.deepEqual(b['edit.redo'], ['Ctrl+Y', 'Ctrl+Shift+Z']); // Document text: Ctrl+Y redoes or repeats, Ctrl+Shift+Z resets characters
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

// Mac mode (setMac): the tests run on Windows, so each Mac test turns it on and back off.
const onMac = (fn) => () => {
  setMac(true);
  try { fn(); } finally { setMac(false); }
};

test('Mac chordOf: Apple order with Globe first, Meta is Cmd, Fn from fnKey or getModifierState', onMac(() => {
  assert.equal(chordOf({ code: 'KeyK', ctrlKey: true, altKey: true, shiftKey: true, metaKey: true, fnKey: true }), 'Fn+Ctrl+Alt+Shift+Cmd+K');
  assert.equal(chordOf({ code: 'KeyA', shiftKey: true, metaKey: true }), 'Shift+Cmd+A');
  assert.equal(chordOf({ code: 'KeyA', ctrlKey: true }), 'Ctrl+A');
  assert.equal(chordOf({ code: 'Equal', meta: true, alt: true }), 'Alt+Cmd+='); // Electron's before-input-event input
  assert.equal(chordOf({ code: 'Tab', fnKey: true }), 'Fn+Tab'); // the Globe event actions.js replays
  assert.equal(chordOf({ code: 'Space', getModifierState: (m) => m === 'Fn' }), 'Fn+Space');
  assert.equal(chordOf({ code: 'MetaLeft', metaKey: true }), null);
}));

test('Mac normalize takes Cmd and Fn and fixes their order; Windows still refuses them', () => {
  assert.equal(normalize('Cmd+Shift+Z'), null);
  setMac(true);
  try {
    assert.equal(normalize('Cmd+Shift+Z'), 'Shift+Cmd+Z');
    assert.equal(normalize('cmd+fn+ctrl+K'), 'Fn+Ctrl+Cmd+K');
    assert.equal(normalize('Cmd+Num+'), 'Cmd+Num+');
    assert.equal(normalize('Win+V'), null);
  } finally { setMac(false); }
});

test('Mac defaults: Ctrl becomes Cmd, Alt+character becomes Ctrl+Cmd, the exceptions, no collisions, none taken by macOS', onMac(() => {
  const b = effective(DEFS);
  assert.deepEqual([b['app.save'], b['app.plans'], b['app.zoomIn'], b['board.select'], b['board.arrow']],
    [['Cmd+S'], ['Alt+Cmd+P'], ['Cmd+=', 'Shift+Cmd+=', 'Cmd+Num+'], ['V'], ['Shift+L']]);
  assert.deepEqual([b['text.preset1'], b['text.preset9']], [['Ctrl+Cmd+1'], ['Ctrl+Cmd+9']]);
  assert.deepEqual([b['app.toolSearch'], b['app.quickTools'], b['edit.redo'], b['app.replace'], b['browser.reload'], b['suggest.reject']],
    [['Fn+Space', 'Ctrl+Shift+Space'], ['Fn+Tab', 'Ctrl+Tab'], ['Shift+Cmd+Z', 'Cmd+Y'], ['Ctrl+H'], ['Cmd+R'], ['Alt+Cmd+Backspace']]);
  assert.deepEqual(b['app.toolSearchDoc'], []); // Alt+Q's Mac form Ctrl+Cmd+Q locks the screen
  assert.deepEqual([macUse('Shift+Cmd+Q').level, macUse('Alt+Cmd+M').level], ['system', 'system']);
  for (const d of DEFS) for (const k of b[d.id]) {
    assert.ok(normalize(k), `${d.id} ${k}`);
    assert.notEqual(macUse(k)?.level, 'system', `${d.id} ${k}`);
    if (!['board', 'plan', 'flows'].includes(d.scope)) assert.notEqual(macUse(k)?.level, 'typing', `${d.id} ${k}`);
  }
  assert.deepEqual(collisions(DEFS, b), {});
  assert.deepEqual(overridesOf(DEFS, b), {});
  assert.equal(keybindsKey(), 'keybindsMac');
}));

test('chordText: Windows as it is; a Mac in Apple symbols with no plus signs; part names', () => {
  assert.equal(chordText('Ctrl+Shift+Z'), 'Ctrl+Shift+Z');
  assert.equal(partName('Alt'), 'Alt');
  assert.equal(keybindsKey(), 'keybinds');
  setMac(true);
  try {
    assert.equal(chordText('Shift+Cmd+Z'), '⇧⌘Z');
    assert.equal(chordText('Fn+Space'), '🌐Space');
    assert.equal(chordText('Fn+Ctrl+Alt+Shift+Cmd+Enter'), '🌐⌃⌥⇧⌘↩');
    assert.equal(chordText('Cmd+Num+'), '⌘Num+');
    assert.equal(chordText('Alt+Cmd+Backspace'), '⌥⌘⌫');
    assert.deepEqual(['Cmd', 'Alt', 'Ctrl', 'Fn', 'Shift', 'Tab'].map(partName), ['Command', 'Option', 'Control', 'Globe', 'Shift', 'Tab']);
  } finally { setMac(false); }
});

test('macUse: system, standard and Option typing chords; osUse picks the platform', onMac(() => {
  assert.equal(macUse('Cmd+Space').level, 'system');
  assert.equal(macUse('Ctrl+Space').level, 'system');
  assert.equal(macUse('Shift+Cmd+4').level, 'system');
  assert.equal(macUse('Cmd+C').level, 'standard');
  assert.equal(macUse('Ctrl+E').level, 'standard');
  assert.equal(macUse('Alt+Space').level, 'standard');
  assert.equal(macUse('Alt+E').level, 'typing');
  assert.equal(macUse('Alt+Shift+2').level, 'typing');
  assert.equal(macUse('T').level, 'typing');
  assert.equal(macUse('Alt+Cmd+P'), null);
  assert.equal(macUse('Fn+Tab'), null);
  assert.equal(osUse('Cmd+Q').level, 'system');
  setMac(false);
  assert.equal(osUse('Alt+Tab').level, 'system');
}));
