import assert from 'node:assert/strict';
import test from 'node:test';
import { collisions, DEFS, effective, macUse, normalize, setMac, WORD_DEFS } from '../src/app/keys.mjs';
import { WORD_KEYS } from '../src/document/word/keymap.mjs';

// Word's key table (plan.md §1.13) as keymap.mjs holds it and keys.mjs builds it.

const onMac = (fn) => () => {
  setMac(true);
  try { fn(); } finally { setMac(false); }
};
const ids = new Set(DEFS.map((d) => d.id));

test('keymap: 288 rows (207 bind with 20 window-wide, 65 native, 7 window, 9 off), every chord in normal form', () => {
  const count = (k) => WORD_KEYS.filter((r) => r.kind === k).length;
  assert.deepEqual([WORD_KEYS.length, count('bind'), count('native'), count('window'), count('off')], [288, 207, 65, 7, 9]);
  assert.equal(WORD_KEYS.filter((r) => r.kind === 'bind' && r.when === 'window').length, 20);
  for (const r of WORD_KEYS) assert.equal(normalize(r.chord), r.chord, r.chord);
  for (const r of WORD_KEYS) assert.ok(['table', 'outline', 'header', 'tabContext', 'window', undefined].includes(r.when), r.chord);
});

test('keymap: every bind command is a feature (its label written in) or an x. id; reuse ids exist; explicit Mac chords are Mac chords', () => {
  for (const r of WORD_KEYS.filter((x) => x.kind === 'bind')) assert.ok(r.label || r.cmd.startsWith('x.'), r.cmd);
  for (const r of WORD_KEYS.filter((x) => x.reuse)) assert.ok(ids.has(r.reuse), r.reuse);
  setMac(true);
  try {
    for (const r of WORD_KEYS.filter((x) => x.mac)) for (const k of r.mac) assert.equal(normalize(k), k, `${r.chord} ${k}`);
  } finally { setMac(false); }
});

test('WORD_DEFS: one binding per (cmd, arg) of the bind rows without reuse, in the Document group and scope; a row with `when` shares it with its siblings', () => {
  const rows = WORD_KEYS.filter((r) => r.kind === 'bind' && !r.reuse);
  assert.equal(WORD_DEFS.length, new Set(rows.map((r) => `${r.cmd}|${r.arg}`)).size);
  for (const d of WORD_DEFS) {
    assert.ok(d.id.startsWith('word.') && d.group === 'Document' && d.scope === 'document', d.id);
    assert.equal(new Set(d.rows.map((r) => r.when)).size, 1, `${d.id}: one context for all its chords`);
    assert.ok(DEFS.includes(d), d.id);
  }
  assert.deepEqual(WORD_DEFS.find((d) => d.id === 'word.file.print').keys, ['Ctrl+P', 'Ctrl+F2', 'Ctrl+Shift+F12', 'Ctrl+Alt+I']);
  assert.ok(WORD_DEFS.find((d) => d.id === 'word.chars.symbols.€'));
  // Ctrl+Shift+Z is font.resetChar's (it shadows edit.redo); Ctrl+Y stays edit.redo's, which WordKeys runs as Redo / Repeat.
  assert.deepEqual(WORD_DEFS.find((d) => d.id === 'word.font.resetChar').keys, ['Ctrl+Space', 'Ctrl+Shift+Z']);
  assert.equal(WORD_DEFS.find((d) => d.id === 'word.frame.qat.redoRepeat').keys.includes('Ctrl+Y'), false);
  assert.equal(WORD_KEYS.find((r) => r.chord === 'Ctrl+Y').reuse, 'edit.redo');
});

test('fallthrough marks exactly the bind rows on Esc, arrows, Home, End, PageUp, PageDown, Enter, Tab and Backspace', () => {
  const keys = new Set(['Esc', 'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', 'Tab', 'Backspace']);
  for (const r of WORD_KEYS.filter((x) => x.kind === 'bind')) assert.equal(!!r.fallthrough, keys.has(r.chord.split('+').pop()), r.chord);
});

test('no two defaults collide with the Word bindings in, on Windows and on a Mac', () => {
  assert.deepEqual(collisions(DEFS, effective(DEFS)), {});
  onMac(() => assert.deepEqual(collisions(DEFS, effective(DEFS)), {}))();
});

// plan.md §1.13 Mac: the rows whose Mac form differs from the rule's toMac chord, and what they get.
const MAC_TABLE = {
  'word.home.editing.replace': ['Ctrl+H'],
  'word.font.resetChar': [],
  'word.chars.tabInCell': [],
  'word.references.footnotes.insertEndnote': [],
  'word.home.font.textHighlightColor': [],
  'word.review.speech.readAloud': [],
  'word.font.symbolFont': [],
  'word.insert.comments.comment': [],
  'word.navigation.webGoBack': [],
  'word.navigation.webGoForward': [],
  'word.keys.xmlTags': [],
  'word.insert.symbols.equation': ['Ctrl+Cmd+='],
  'word.navigation.paraUp': ['Cmd+Up'],
  'word.navigation.paraDown': ['Cmd+Down'],
  'word.file.print': ['Cmd+P', 'Cmd+F2', 'Shift+Cmd+F12'], // Ctrl+Alt+I has none: Alt+Cmd+I is the developer tools
};

test('Mac: no Word chord is a macOS system or typing chord, and the §1.13 Mac table holds', onMac(() => {
  const b = effective(DEFS);
  for (const d of WORD_DEFS) for (const k of b[d.id]) assert.ok(!['system', 'typing'].includes(macUse(k)?.level), `${d.id} ${k}`);
  for (const [id, keys] of Object.entries(MAC_TABLE)) assert.deepEqual(b[id], keys, id);
  const prefixes = b['word.chars.accentPrefixes'];
  assert.ok(!prefixes.includes('Cmd+`') && prefixes.includes('Cmd+,') && prefixes.includes("Cmd+'")); // only Ctrl+` loses its Mac form
  assert.ok(WORD_DEFS.find((d) => d.id === 'word.insert.symbols.equation').shadows.includes('text.superscript'));
  // Every other Word binding keeps its rows' toMac forms: Ctrl to Cmd, Alt with a typing key to Ctrl+Cmd.
  const toMac = (c) => {
    const parts = c.split('+');
    const key = c.endsWith('Num+') ? (parts.splice(-2, 2), 'Num+') : parts.pop();
    const mods = new Set(parts);
    if (mods.delete('Ctrl')) mods.add('Cmd');
    else if (mods.has('Alt') && /^([A-Z0-9]|[-=[\]\\;',./`])$/.test(key)) { mods.delete('Alt'); mods.add('Ctrl').add('Cmd'); }
    return normalize([...mods, key].join('+'));
  };
  for (const d of WORD_DEFS) {
    if (d.id in MAC_TABLE || d.id === 'word.chars.accentPrefixes') continue;
    assert.deepEqual(b[d.id], d.keys.map(toMac), d.id);
  }
}));
