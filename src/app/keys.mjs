// Keybinds (SPEC §7k): the app's rebindable shortcuts, pure and import-free (Node-tested; main.js imports it too).
//
// A chord is a string of modifiers and one key, in this order: "Ctrl+Alt+Shift+K". Keys are named from KeyboardEvent.code
// (the physical key, so a layout's AltGr or Shift symbols do not change it): letters and digits as themselves, Numpad keys as
// "Num1", "Num+", arrows as "Left", "Right", "Up", "Down", and the rest by the names in NAMES. Meta (the Windows key) counts as
// Ctrl, as the app's handlers always did; Windows keeps Win+ chords for itself.

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

/** The chord of a key event ({code, ctrlKey, metaKey, altKey, shiftKey}, a DOM KeyboardEvent or Electron's before-input-event
 * input with {code, control, meta, alt, shift}), or null for a lone modifier. */
export function chordOf(e) {
  const key = keyName(e.code);
  if (!key) return null;
  const ctrl = !!(e.ctrlKey ?? e.control) || !!(e.metaKey ?? e.meta);
  const alt = !!(e.altKey ?? e.alt);
  const shift = !!(e.shiftKey ?? e.shift);
  return `${ctrl ? 'Ctrl+' : ''}${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${key}`;
}

/** Chord `chord` in canonical form (modifier order and names fixed), or null when it is not a chord. */
export function normalize(chord) {
  if (typeof chord !== 'string' || !chord) return null;
  const parts = chord.split('+');
  // "Num+": its "+" belongs to the key name.
  if (chord.endsWith('Num+')) parts.splice(-2, 2, 'Num+');
  const key = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  if (![...mods].every((m) => ['ctrl', 'alt', 'shift'].includes(m)) || !codeOf(key)) return null;
  return `${mods.has('ctrl') ? 'Ctrl+' : ''}${mods.has('alt') ? 'Alt+' : ''}${mods.has('shift') ? 'Shift+' : ''}${key}`;
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
    'Ctrl+Alt+3', 'Ctrl+Alt+7', 'Ctrl+Alt+8', 'Ctrl+Alt+9', 'Ctrl+Alt+0', 'Ctrl+Alt+-', 'Ctrl+Alt+=', 'Ctrl+Alt+\\', 'Ctrl+Alt+M'),
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

// ---------------------------------------------------------------------------------------------
// Scopes: where a binding listens. Two bindings collide when they share a chord and their scopes can be active at once.

const OVERLAP = {
  global: null, // every scope
  editor: ['editor', 'text', 'board'],
  text: ['editor', 'text'],
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
    const own = Array.isArray(overrides?.[d.id]) ? overrides[d.id] : d.keys;
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
    const def = d.keys.map(normalize);
    if (own.length !== def.length || own.some((c, i) => c !== def[i])) out[d.id] = own;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The registry: every rebindable shortcut, in the order Settings lists them. {id, label, group, scope, keys (the defaults),
// shadows?: ids this binding knowingly takes over in its scope (no collision)}. Keys that only move inside a widget (Enter,
// Escape, arrows and Tab in menus, lists, dialogs and text boxes; arrow nudges and Alt+Arrow on boards) stay fixed.

export const GROUPS = ['General', 'Text', 'Insert', 'Boards', 'Plans', 'Flowcharts', 'Browser'];
const def = (group, scope) => (id, label, keys, more) => ({ id, label, group, scope, keys, ...more });
const general = def('General', 'global');
const generalEditor = def('General', 'editor');
const text = def('Text', 'text');
const textEditor = def('Text', 'editor');
const insert = def('Insert', 'editor');
const board = def('Boards', 'board');
const plan = def('Plans', 'plan');
const flows = def('Flowcharts', 'flows');
const browser = def('Browser', 'browser');

export const DEFS = [
  general('app.save', 'Save', ['Ctrl+S']),
  general('edit.undo', 'Undo', ['Ctrl+Z']),
  general('edit.redo', 'Redo', ['Ctrl+Y', 'Ctrl+Shift+Z']),
  general('app.toolSearch', 'Tool search', ['Ctrl+Space']),
  general('app.quickTools', 'Quick tools', ['Ctrl+Tab']),
  general('app.plans', 'Plans page', ['Ctrl+Alt+P']),
  general('app.browser', 'Browser page', ['Ctrl+Alt+B']),
  generalEditor('app.sidebar', 'Show or hide the sidebar', ['Ctrl+\\']),
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

  insert('insert.whiteboard', 'Insert whiteboard', ['Ctrl+Alt+W']),
  insert('insert.canvas', 'Insert canvas', ['Ctrl+Alt+C']),
  insert('insert.flowchart', 'Insert flowchart', ['Ctrl+Alt+F']),

  board('board.select', 'Select tool', ['V']),
  board('board.text', 'Text tool', ['T']),
  board('board.image', 'Add image', ['I']),
  board('board.pen', 'Pen', ['P']),
  board('board.eraser', 'Eraser', ['E']),
  board('board.shape', 'Shape tool', ['S']),
  board('board.connector', 'Connector tool', ['A']),
  board('board.canvas', 'Add canvas (whiteboards)', ['C']),
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
