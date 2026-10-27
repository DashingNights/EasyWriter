// Keybinds (SPEC §7k): the app's rebindable shortcuts, pure (Node-tested; main.js imports it too).
//
// A chord is a string of modifiers and one key, in this order: "Ctrl+Alt+Shift+K". Keys are named from KeyboardEvent.code
// (the physical key, so a layout's AltGr or Shift symbols do not change it): letters and digits as themselves, Numpad keys as
// "Num1", "Num+", arrows as "Left", "Right", "Up", "Down", and the rest by the names in NAMES. Meta (the Windows key) counts as
// Ctrl, as the app's handlers always did; Windows keeps Win+ chords for itself.
//
// On a Mac the chord has Apple's modifier order with Globe first: "Fn+Ctrl+Alt+Shift+Cmd+K". Ctrl is Control, Alt is Option and
// Cmd is Command (metaKey); Fn is Globe, which Electron never sees: main.js hears Globe+Tab and Globe+Space through
// native/globe and the renderer replays them as key events with fnKey set (actions.js globeKey). The Mac has its own defaults
// (keysFor) and its own overrides (settings.keybindsMac, keybindsKey).

import { MAC } from '../platform.mjs';

let mac = MAC;
/** Mac mode on or off (the Node tests try both on any platform). */
export function setMac(on) {
  mac = !!on;
}
export const isMac = () => mac;
const MODS = () => (mac ? ['Fn', 'Ctrl', 'Alt', 'Shift', 'Cmd'] : ['Ctrl', 'Alt', 'Shift']);

const NAMES = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'NumEnter', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Del', Insert: 'Ins',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', IntlBackslash: 'Intl\\', Semicolon: ';', Quote: "'", Comma: ',',
  Period: '.', Slash: '/', Backquote: '`', NumpadAdd: 'Num+', NumpadSubtract: 'Num-', NumpadMultiply: 'Num*', NumpadDivide: 'Num/',
  NumpadDecimal: 'Num.', PrintScreen: 'PrtSc', Pause: 'Pause', ScrollLock: 'ScrollLock', ContextMenu: 'Menu', CapsLock: 'CapsLock',
};
const CODES = Object.fromEntries(Object.entries(NAMES).map(([code, name]) => [name, code]));
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/** The key's name for KeyboardEvent.code `code`, or null for a modifier or an unknown key. */
export function keyName(code) {
  if (typeof code !== 'string' || MODIFIER_CODES.test(code)) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return NAMES[code] ?? null;
}

/** KeyboardEvent.code of key name `name` (keyName's inverse), or null. */
export function codeOf(name) {
  if (/^[A-Z]$/.test(name)) return `Key${name}`;
  if (/^\d$/.test(name)) return `Digit${name}`;
  if (/^Num\d$/.test(name)) return `Numpad${name.slice(3)}`;
  if (/^F\d{1,2}$/.test(name)) return name;
  return CODES[name] ?? null;
}

/** The modifiers held in key event `e` (as chordOf takes it): {Ctrl, Alt, Shift} on Windows, where Meta counts as Ctrl;
 * {Fn, Ctrl, Alt, Shift, Cmd} on a Mac. */
export function modsOf(e) {
  const [ctrl, meta] = [!!(e.ctrlKey ?? e.control), !!(e.metaKey ?? e.meta)];
  const rest = { Alt: !!(e.altKey ?? e.alt), Shift: !!(e.shiftKey ?? e.shift) };
  return mac ? { Fn: e.fnKey === true || !!e.getModifierState?.('Fn'), Ctrl: ctrl, ...rest, Cmd: meta } : { Ctrl: ctrl || meta, ...rest };
}

/** The chord of a key event ({code, ctrlKey, metaKey, altKey, shiftKey}, a DOM KeyboardEvent or Electron's before-input-event
 * input with {code, control, meta, alt, shift}), or null for a lone modifier. */
export function chordOf(e) {
  const key = keyName(e.code);
  if (!key) return null;
  const held = modsOf(e);
  return [...MODS().filter((m) => held[m]), key].join('+');
}

/** Chord `chord` split: {mods (lower case), key}, or null. */
function parse(chord) {
  if (typeof chord !== 'string' || !chord) return null;
  const parts = chord.split('+');
  // "Num+": its "+" belongs to the key name.
  if (chord.endsWith('Num+')) parts.splice(-2, 2, 'Num+');
  const key = parts.pop();
  return codeOf(key) ? { mods: new Set(parts.map((p) => p.toLowerCase())), key } : null;
}
const build = (order, mods, key) => [...order.filter((m) => mods.has(m.toLowerCase())), key].join('+');

/** Chord `chord` in canonical form (modifier order and names fixed), or null when it is not a chord. */
export function normalize(chord) {
  const c = parse(chord);
  const order = MODS();
  if (!c || ![...c.mods].every((m) => order.some((o) => o.toLowerCase() === m))) return null;
  return build(order, c.mods, c.key);
}

const TYPED = ['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`'];
const types = (key) => /^[A-Z0-9]$/.test(key) || TYPED.includes(key); // a letter, a digit or punctuation

/** Windows chord `chord` as the Mac has it: Ctrl becomes Cmd; Alt with a letter, digit or punctuation (Option types a
 * character there) becomes Ctrl+Cmd. */
function toMac(chord) {
  const c = parse(chord);
  if (!c) return chord;
  const mods = new Set(c.mods);
  if (mods.delete('ctrl')) mods.add('cmd');
  else if (mods.has('alt') && types(c.key)) {
    mods.delete('alt');
    mods.add('ctrl').add('cmd');
  }
  return build(['Fn', 'Ctrl', 'Alt', 'Shift', 'Cmd'], mods, c.key);
}

/** Windows chord `chord` on this platform (a fixed key a tool shows, src/app/tools.js entryKey). */
export const osChord = (chord) => (mac ? toMac(chord) : chord);

// The Mac's own defaults where the rule (toMac) gives a chord macOS takes, one that types, or a Mac app's habit differs.
const MAC_KEYS = {
  'app.toolSearch': ['Fn+Space', 'Ctrl+Shift+Space'],
  'app.quickTools': ['Fn+Tab', 'Ctrl+Tab'],
  'edit.redo': ['Shift+Cmd+Z', 'Cmd+Y'],
  'app.replace': ['Ctrl+H'], // Cmd+H hides the app
  'app.devtools': ['Alt+Cmd+I'],
  'document.indent': ['Ctrl+Shift+M'], // Cmd+M minimizes the window
  'document.outdent': ['Shift+Cmd+M'],
  'document.clearParagraph': ['Alt+Cmd+Q'], // Cmd+Q quits
  'document.pageBreak': ['Cmd+Enter'],
  'text.subscript': ['Ctrl+Cmd+-'],
  'text.superscript': ['Ctrl+Cmd+='],
  'text.strike': ['Shift+Cmd+X'],
  'plan.board': ['Cmd+1'],
  'plan.backlog': ['Cmd+2'],
  'plan.gantt': ['Cmd+3'],
  'browser.back': ['Cmd+['],
  'browser.forward': ['Cmd+]'],
  'browser.reload': ['Cmd+R'], // the F keys are media keys on a Mac
  'suggest.next': ['Alt+Cmd+Down'],
  'suggest.previous': ['Alt+Cmd+Up'],
  'suggest.accept': ['Alt+Cmd+Enter'],
  'suggest.reject': ['Alt+Cmd+Backspace'],
};

/** Binding `d`'s default chords on this platform. */
export const keysFor = (d) => (mac ? MAC_KEYS[d.id] ?? d.keys.map(toMac) : d.keys);

/** The settings key this platform stores its overrides under. */
export const keybindsKey = () => (mac ? 'keybindsMac' : 'keybinds');

// ---------------------------------------------------------------------------------------------
// Display. Windows shows the chord as it is; a Mac shows Apple's symbols with no plus signs ("⇧⌘Z"), and its sentences name the
// keys Command, Option, Control and Globe.

const SYMBOLS = {
  Fn: '🌐', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘', Enter: '↩', Backspace: '⌫', Del: '⌦', Esc: '⎋', Tab: '⇥', Left: '←', Right: '→',
  Up: '↑', Down: '↓', PageUp: '⇞', PageDown: '⇟', Home: '↖', End: '↘',
};
const PART_NAMES = { Fn: 'Globe', Ctrl: 'Control', Alt: 'Option', Cmd: 'Command' };

/** Chord or chord part `part` as a Mac shows it (a modifier's or a key's symbol), else as it is. */
export const symbolOf = (part) => (mac ? SYMBOLS[part] ?? part : part);

/** Chord part `part` (a modifier or a key) named in a sentence. */
export const partName = (part) => (mac ? PART_NAMES[part] ?? part : part);

/** Chord `chord` as the app shows it. */
export function chordText(chord) {
  const c = mac && parse(chord);
  return c ? [...MODS().filter((m) => c.mods.has(m.toLowerCase())), c.key].map(symbolOf).join('') : chord;
}

// ---------------------------------------------------------------------------------------------
// What Windows does with a chord. `system`: Windows (or the keyboard driver) takes the chord before the app sees it, so the
// binding cannot work. `standard`: a convention every Windows app keeps (clipboard, undo, text navigation); the binding takes the
// key from text boxes and pages in the app. `layout`: Ctrl+Alt is AltGr, which types a character on many keyboard layouts.

const WIN = (level, what, ...chords) => chords.map((chord) => [chord, { level, what }]);
const WINDOWS = new Map([
  ...WIN('system', 'switches windows', 'Alt+Tab', 'Alt+Shift+Tab', 'Ctrl+Alt+Tab', 'Alt+Esc', 'Alt+Shift+Esc'),
  ...WIN('system', 'opens Start', 'Ctrl+Esc'),
  ...WIN('system', 'opens Task Manager', 'Ctrl+Shift+Esc'),
  ...WIN('system', 'opens the security screen', 'Ctrl+Alt+Del', 'Ctrl+Alt+Num.'),
  ...WIN('system', 'closes the window', 'Alt+F4'),
  ...WIN('system', 'opens the window menu', 'Alt+Space'),
  ...WIN('system', 'takes a screenshot', 'PrtSc', 'Alt+PrtSc', 'Shift+PrtSc', 'Ctrl+PrtSc'),
  ...WIN('system', 'rotates the screen on some graphics drivers', 'Ctrl+Alt+Up', 'Ctrl+Alt+Down', 'Ctrl+Alt+Left', 'Ctrl+Alt+Right'),
  ...WIN('standard', 'copies', 'Ctrl+C', 'Ctrl+Ins'),
  ...WIN('standard', 'cuts', 'Ctrl+X', 'Shift+Del'),
  ...WIN('standard', 'pastes', 'Ctrl+V', 'Shift+Ins', 'Ctrl+Shift+V'),
  ...WIN('standard', 'selects all', 'Ctrl+A'),
  ...WIN('standard', 'undoes', 'Ctrl+Z'),
  ...WIN('standard', 'redoes', 'Ctrl+Y', 'Ctrl+Shift+Z'),
  ...WIN('standard', 'opens the context menu', 'Shift+F10', 'Menu'),
  ...WIN('standard', 'moves through the menu bar', 'F10'),
  ...WIN('standard', 'closes a document or tab', 'Ctrl+F4'),
  ...WIN('standard', 'moves and selects text', 'Ctrl+Left', 'Ctrl+Right', 'Ctrl+Shift+Left', 'Ctrl+Shift+Right', 'Ctrl+Home', 'Ctrl+End',
    'Ctrl+Shift+Home', 'Ctrl+Shift+End', 'Shift+Left', 'Shift+Right', 'Shift+Up', 'Shift+Down', 'Shift+Home', 'Shift+End', 'Home', 'End',
    'Left', 'Right', 'Up', 'Down', 'PageUp', 'PageDown'),
  ...WIN('standard', 'deletes a word', 'Ctrl+Backspace', 'Ctrl+Del'),
  ...WIN('standard', 'moves the focus', 'Tab', 'Shift+Tab'),
  ...WIN('layout', 'types a character with AltGr on many keyboard layouts', 'Ctrl+Alt+E', 'Ctrl+Alt+Q', 'Ctrl+Alt+4', 'Ctrl+Alt+2',
    'Ctrl+Alt+3', 'Ctrl+Alt+7', 'Ctrl+Alt+8', 'Ctrl+Alt+9', 'Ctrl+Alt+0', 'Ctrl+Alt+-', 'Ctrl+Alt+=', 'Ctrl+Alt+\\', 'Ctrl+Alt+M', 'Ctrl+Alt+[', 'Ctrl+Alt+]'),
]);

/** What Windows does with `chord` ({level: 'system' | 'standard' | 'layout', what}), or null. A chord without Ctrl or Alt that
 * types a character (a letter, a digit, punctuation, Space, with or without Shift) types it in text boxes: 'typing'. */
export function windowsUse(chord) {
  const c = normalize(chord);
  if (!c) return null;
  if (WINDOWS.has(c)) return WINDOWS.get(c);
  const key = c.replace(/^(Shift\+)/, '');
  if (!/^(Ctrl|Alt)\+/.test(c) && (/^[A-Z0-9]$/.test(key) || ['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`', 'Space'].includes(key))) {
    return { level: 'typing', what: 'types in text boxes, so it works only where no text box has the focus' };
  }
  return null;
}

// What macOS does with a chord, as WINDOWS: `system` (macOS takes it first) and `standard` (a Mac convention the binding takes over).
const MACOS = new Map([
  ...WIN('system', 'opens Spotlight', 'Cmd+Space'),
  ...WIN('system', 'opens a Finder search', 'Alt+Cmd+Space'),
  ...WIN('system', 'opens the emoji and symbols viewer', 'Ctrl+Cmd+Space'),
  ...WIN('system', 'switches apps', 'Cmd+Tab', 'Shift+Cmd+Tab'),
  ...WIN('system', "switches the app's windows", 'Cmd+`'),
  ...WIN('system', 'hides the app', 'Cmd+H'),
  ...WIN('system', 'hides the other apps', 'Alt+Cmd+H'),
  ...WIN('system', 'minimizes the window', 'Cmd+M'),
  ...WIN('system', 'quits the app', 'Cmd+Q'),
  ...WIN('system', 'locks the screen', 'Ctrl+Cmd+Q'),
  ...WIN('system', 'shows or hides the Dock', 'Alt+Cmd+D'),
  ...WIN('system', 'opens Force Quit', 'Alt+Cmd+Esc'),
  ...WIN('system', 'takes a screenshot', 'Shift+Cmd+3', 'Shift+Cmd+4', 'Shift+Cmd+5'),
  ...WIN('system', 'opens Mission Control', 'Ctrl+Up'),
  ...WIN('system', "shows the app's windows", 'Ctrl+Down'),
  ...WIN('system', 'switches desktops', 'Ctrl+Left', 'Ctrl+Right'),
  ...WIN('system', 'turns full screen on or off', 'Ctrl+Cmd+F'),
  ...WIN('system', 'switches the input source once a second one is on', 'Ctrl+Space', 'Ctrl+Alt+Space'),
  ...WIN('standard', 'copies', 'Cmd+C'),
  ...WIN('standard', 'cuts', 'Cmd+X'),
  ...WIN('standard', 'pastes', 'Cmd+V'),
  ...WIN('standard', 'selects all', 'Cmd+A'),
  ...WIN('standard', 'undoes', 'Cmd+Z'),
  ...WIN('standard', 'redoes', 'Shift+Cmd+Z'),
  ...WIN('standard', 'moves the text cursor by a word', 'Alt+Left', 'Alt+Right'),
  ...WIN('standard', 'moves the text cursor to the end of the line or the text', 'Cmd+Left', 'Cmd+Right', 'Cmd+Up', 'Cmd+Down'),
  ...WIN('standard', 'deletes a word', 'Alt+Backspace'),
  ...WIN('standard', 'deletes to the start of the line', 'Cmd+Backspace'),
  ...WIN('standard', 'moves or edits text in text boxes', ...'AEKDFBNPTHOYLV'.split('').map((k) => `Ctrl+${k}`)),
  ...WIN('standard', 'opens Raycast, Alfred or the ChatGPT app by default', 'Alt+Space'),
]);

/** What macOS does with `chord`, as windowsUse: also 'typing' for Option (Alt) with a letter, digit or punctuation. */
export function macUse(chord) {
  const c = normalize(chord);
  if (!c) return null;
  if (MACOS.has(c)) return MACOS.get(c);
  const { mods, key } = parse(c);
  const others = [...mods].filter((m) => m !== 'shift' && m !== 'alt');
  if (!others.length && !mods.has('alt') && (types(key) || key === 'Space')) {
    return { level: 'typing', what: 'types in text boxes, so it works only where no text box has the focus' };
  }
  if (!others.length && mods.has('alt') && types(key)) return { level: 'typing', what: 'types a character in text boxes' };
  return null;
}

/** What this platform does with `chord` (macUse or windowsUse). */
export const osUse = (chord) => (mac ? macUse(chord) : windowsUse(chord));

// ---------------------------------------------------------------------------------------------
// Scopes: where a binding listens. Two bindings collide when they share a chord and their scopes can be active at once.

const OVERLAP = {
  global: null, // every scope
  editor: ['editor', 'text', 'board'],
  text: ['editor', 'text'],
  document: ['editor', 'text', 'document'], // a Document's editor: never with the board scope, so Ctrl+J and Ctrl+[ ] stay the board's there
  board: ['editor', 'board', 'flows'],
  plan: ['plan'],
  flows: ['flows', 'board'],
  browser: ['browser'],
  chat: ['chat'],
};
const overlaps = (a, b) => a === 'global' || b === 'global' || OVERLAP[a]?.includes(b) || OVERLAP[b]?.includes(a);

/** The effective chords of every binding in `defs` ([{id, keys, scope}]): `overrides` ({id: [chord] | []}, settings.keybinds)
 * replace the defaults; chords that do not parse are dropped. → {id: [chord]} */
export function effective(defs, overrides = {}) {
  const out = {};
  for (const d of defs) {
    const own = Array.isArray(overrides?.[d.id]) ? overrides[d.id] : keysFor(d);
    out[d.id] = [...new Set(own.map(normalize).filter(Boolean))];
  }
  return out;
}

/** The collisions inside the app: for each binding id the other bindings ([{id, chord}]) that share one of its chords in an
 * overlapping scope. */
export function collisions(defs, binds) {
  const byChord = new Map();
  for (const d of defs) for (const c of binds[d.id] ?? []) byChord.set(c, [...(byChord.get(c) ?? []), d]);
  const out = {};
  for (const [chord, list] of byChord) {
    for (const a of list) {
      const others = list.filter((b) => b !== a && overlaps(a.scope, b.scope) && !a.shadows?.includes(b.id) && !b.shadows?.includes(a.id));
      if (others.length) (out[a.id] ??= []).push(...others.map((b) => ({ id: b.id, chord })));
    }
  }
  return out;
}

/** The overrides to store for `binds` (only the bindings that differ from their defaults). */
export function overridesOf(defs, binds) {
  const out = {};
  for (const d of defs) {
    const own = binds[d.id] ?? [];
    const def = keysFor(d).map(normalize);
    if (own.length !== def.length || own.some((c, i) => c !== def[i])) out[d.id] = own;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The registry: every rebindable shortcut, in the order Settings lists them. {id, label, group, scope, keys (the defaults),
// shadows?: ids this binding knowingly takes over in its scope (no collision)}. Keys that only move inside a widget (Enter,
// Escape, arrows and Tab in menus, lists, dialogs and text boxes; arrow nudges and Alt+Arrow on boards) stay fixed.

/** The shape kinds with a key of their own (SPEC §6c Keyboard: Figma's keys, except that R stays Rotate, so Box takes B):
 * kind → binding id. The key arms the shape tool with that kind; S arms it with the last kind used. */
export const SHAPE_KEYS = { rect: 'board.box', ellipse: 'board.circle', line: 'board.line', arrow: 'board.arrow' };

export const GROUPS = ['General', 'Text', 'Document', 'Insert', 'Suggestions', 'Boards', 'Plans', 'Flowcharts', 'Browser'];
const def = (group, scope) => (id, label, keys, more) => ({ id, label, group, scope, keys, ...more });
const general = def('General', 'global');
const generalEditor = def('General', 'editor');
const text = def('Text', 'text');
const textEditor = def('Text', 'editor');
const insert = def('Insert', 'editor');
const doc = def('Document', 'document');
const suggest = def('Suggestions', 'editor');
const board = def('Boards', 'board');
const plan = def('Plans', 'plan');
const flows = def('Flowcharts', 'flows');
const browser = def('Browser', 'browser');

export const DEFS = [
  general('app.save', 'Save', ['Ctrl+S']),
  general('edit.undo', 'Undo', ['Ctrl+Z']),
  general('edit.redo', 'Redo', ['Ctrl+Y', 'Ctrl+Shift+Z']),
  general('app.toolSearch', 'Tool search', ['Ctrl+Space']),
  general('app.quickTools', 'Quick access menu', ['Ctrl+Tab']),
  general('app.plans', 'Plans page', ['Ctrl+Alt+P']),
  general('app.browser', 'Browser page', ['Ctrl+Alt+B']),
  general('app.newDraft', 'New draft', ['Ctrl+N']),
  generalEditor('app.sidebar', 'Show or hide the sidebar', ['Ctrl+\\']),
  generalEditor('app.find', 'Find in the draft', ['Ctrl+F']),
  generalEditor('app.replace', 'Find and replace in the draft', ['Ctrl+H']),
  general('app.assistant', 'Assistant panel', ['Ctrl+Shift+A']),
  general('app.dictate', 'Hold to dictate', ['Ctrl+Shift+D']),
  general('app.zoomIn', 'Zoom the window in', ['Ctrl+=', 'Ctrl+Shift+=', 'Ctrl+Num+']),
  general('app.zoomOut', 'Zoom the window out', ['Ctrl+-', 'Ctrl+Shift+-', 'Ctrl+Num-']),
  general('app.zoomReset', 'Reset the window zoom', ['Ctrl+0', 'Ctrl+Num0']),
  general('app.devtools', 'Developer tools', ['Ctrl+Shift+I']),

  text('text.bold', 'Bold', ['Ctrl+B']),
  text('text.italic', 'Italic', ['Ctrl+I']),
  text('text.underline', 'Underline', ['Ctrl+U']),
  text('text.strike', 'Strikethrough', ['Ctrl+Shift+S']),
  text('text.code', 'Inline code', ['Ctrl+E']),
  text('text.subscript', 'Subscript', ['Ctrl+,']),
  text('text.superscript', 'Superscript', ['Ctrl+.']),
  text('text.paragraph', 'Paragraph', ['Ctrl+Alt+0']),
  ...[1, 2, 3, 4, 5, 6].map((n) => text(`text.heading${n}`, `Heading ${n}`, [`Ctrl+Alt+${n}`])),
  text('text.bulletList', 'Bullet list', ['Ctrl+Shift+8']),
  text('text.orderedList', 'Numbered list', ['Ctrl+Shift+7']),
  text('text.blockquote', 'Quote', ['Ctrl+Shift+B']),
  text('text.codeBlock', 'Code block', []), // TipTap's Ctrl+Alt+C is Insert canvas here
  text('text.alignLeft', 'Align left', ['Ctrl+Shift+L']),
  text('text.alignCenter', 'Align centre', ['Ctrl+Shift+E']),
  text('text.alignRight', 'Align right', ['Ctrl+Shift+R']),
  text('text.alignJustify', 'Justify', ['Ctrl+Shift+J']),
  textEditor('text.link', 'Link', ['Ctrl+K']),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => textEditor(`text.preset${n}`, `Font preset ${n}`, [`Alt+${n}`])),

  // Word's own chords in a Document (docs/plans/document.md Keys); the app-wide chords keep their meaning there.
  doc('document.alignLeft', 'Align left', ['Ctrl+L']),
  doc('document.alignCenter', 'Align centre', ['Ctrl+E'], { shadows: ['text.code'] }), // a Document has no inline code
  doc('document.alignRight', 'Align right', ['Ctrl+R']),
  doc('document.justify', 'Justify', ['Ctrl+J']),
  doc('document.growFont', 'Grow font', ['Ctrl+Shift+.']),
  doc('document.shrinkFont', 'Shrink font', ['Ctrl+Shift+,']),
  doc('document.growFont1', 'Grow font by 1 point', ['Ctrl+]']),
  doc('document.shrinkFont1', 'Shrink font by 1 point', ['Ctrl+[']),
  doc('document.spacing1', 'Single line spacing', ['Ctrl+1']),
  doc('document.spacing15', '1.5 line spacing', ['Ctrl+5']),
  doc('document.spacing2', 'Double line spacing', ['Ctrl+2']),
  doc('document.indent', 'Increase indent', ['Ctrl+M']),
  doc('document.outdent', 'Decrease indent', ['Ctrl+Shift+M']),
  doc('document.hanging', 'Hanging indent', ['Ctrl+T']),
  doc('document.removeHanging', 'Remove hanging indent', ['Ctrl+Shift+T']),
  doc('document.clearParagraph', 'Clear paragraph formatting', ['Ctrl+Q']),
  doc('document.normalStyle', 'Normal style', ['Ctrl+Shift+N']),
  doc('document.pageBreak', 'Page break', ['Ctrl+Enter']), // TipTap's hard break also takes Mod-Enter; DocumentKeys swallows it

  insert('insert.canvas', 'Insert canvas', ['Ctrl+Alt+C']),
  insert('insert.flowchart', 'Insert flowchart', ['Ctrl+Alt+F']),

  // Agent edits waiting as suggestions (docs/plans/suggestions.md Keys): none types a character with AltGr. Accept and reject act
  // on the active change.
  suggest('suggest.next', 'Next suggestion', ['Ctrl+Alt+PageDown']),
  suggest('suggest.previous', 'Previous suggestion', ['Ctrl+Alt+PageUp']),
  suggest('suggest.accept', 'Accept suggestion', ['Ctrl+Alt+Enter']),
  suggest('suggest.reject', 'Reject suggestion', ['Ctrl+Alt+Backspace']),

  board('board.select', 'Select tool', ['V']),
  board('board.text', 'Text tool', ['T']),
  board('board.image', 'Add image', ['I']),
  board('board.pen', 'Pen', ['P']),
  board('board.eraser', 'Eraser', ['E']),
  board('board.shape', 'Shape tool', ['S']),
  board('board.connector', 'Connector tool', ['A']),
  board('board.box', 'Box shape', ['B']),
  board('board.circle', 'Circle shape', ['O']),
  board('board.line', 'Line shape', ['L']),
  board('board.arrow', 'Arrow shape', ['Shift+L']),
  board('board.keepTool', 'Keep tool on or off', ['Q']),
  board('board.selectAll', 'Select all items', ['Ctrl+A']),
  board('board.deselect', 'Deselect', ['Ctrl+D']),
  board('board.duplicate', 'Duplicate', ['Ctrl+J']),
  board('board.copy', 'Copy items', ['Ctrl+C']),
  board('board.cut', 'Cut items', ['Ctrl+X']),
  board('board.copyStyle', 'Copy style', ['Ctrl+Shift+C']),
  board('board.pasteStyle', 'Paste style', ['Ctrl+Shift+V']),
  board('board.delete', 'Delete items', ['Del', 'Backspace']),
  board('board.forward', 'Bring forward', ['Ctrl+]']),
  board('board.front', 'Bring to front', ['Ctrl+Shift+]']),
  board('board.backward', 'Send backward', ['Ctrl+[']),
  board('board.back', 'Send to back', ['Ctrl+Shift+[']),
  board('board.rotate', 'Rotate 90 degrees', ['R']),
  board('board.rotateBack', 'Rotate back 90 degrees', ['Shift+R']),
  board('board.flipH', 'Flip horizontal', ['Shift+H']),
  board('board.flipV', 'Flip vertical', ['Shift+V']),
  board('board.lock', 'Lock or unlock items', ['Ctrl+Shift+L']), // Align left's chord in the text scope, which never overlaps
  board('board.hide', 'Hide or show items', ['Ctrl+Shift+H']),
  board('board.group', 'Group items', ['Ctrl+G']),
  board('board.ungroup', 'Ungroup items', ['Ctrl+Shift+G']),
  board('board.snap', 'Snapping on or off', ['Ctrl+Shift+;']),
  board('board.grid', 'Grid snap on or off', ["Ctrl+'"]),

  plan('plan.board', 'Board tab', ['Alt+1']),
  plan('plan.backlog', 'Backlog tab', ['Alt+2']),
  plan('plan.gantt', 'Gantt tab', ['Alt+3']),
  plan('plan.filter', 'Filter', ['/']),
  plan('plan.newTicket', 'New ticket', ['N']),
  plan('plan.convert', 'Convert a draft card (Board)', ['C']),
  plan('plan.done', 'Done or not done (Board)', ['D']),
  plan('plan.today', 'Scroll to today (Gantt)', ['T']),
  plan('plan.zoomIn', 'Zoom in (Gantt)', ['=', 'Shift+=', 'Num+']),
  plan('plan.zoomOut', 'Zoom out (Gantt)', ['-', 'Num-']),

  flows('flows.new', 'New flowchart', ['N']),
  flows('flows.find', 'Filter the list or search shapes', ['/']),

  browser('browser.newTab', 'New tab', ['Ctrl+T']),
  browser('browser.closeTab', 'Close tab', ['Ctrl+W']),
  browser('browser.address', 'Address bar', ['Ctrl+L']),
  browser('browser.reload', 'Reload', ['Ctrl+R', 'F5']),
  browser('browser.back', 'Back', ['Alt+Left']),
  browser('browser.forward', 'Forward', ['Alt+Right']),
  browser('browser.zoomIn', 'Zoom the page in', ['Ctrl+=', 'Ctrl+Shift+=', 'Ctrl+Num+'], { shadows: ['app.zoomIn'] }),
  browser('browser.zoomOut', 'Zoom the page out', ['Ctrl+-', 'Ctrl+Shift+-', 'Ctrl+Num-'], { shadows: ['app.zoomOut'] }),
  browser('browser.zoomReset', 'Reset the page zoom', ['Ctrl+0', 'Ctrl+Num0'], { shadows: ['app.zoomReset'] }),
];
