// Keys in the canvas editor (docs/plans/engine/plan.md section 3, briefs/engine-input.md): a key event → the engine call it makes.
// Word's movement and editing keys are fixed, as keymap.mjs lists them ('native' rows) and as Word itself has them. The app's own
// keybinds (settings.keybinds, so the user's overrides count) go to the engine's command registry through BINDS, which names
// the engine's command ids. Every Word binding (`word.<id>`) runs its command through the host's tool registry (createKeymap
// `tool`), so the Documents engine table (src/document/canvas/commands.mjs) is the one map for Word's keys (docs/plans/engine/
// stage2.md, Stage 2.6); BINDS keeps the app's own text bindings, undo and redo. The app's key helpers
// come from the host (createKeymap): src/engine imports nothing of src/app (viewport-design.md section 3), and another kind (the
// board, Sheets) passes its own keymap.

const exec = (id, params) => ({ call: 'exec', args: params ? [id, params] : [id] });

// Chord without Shift → the engine's caret command; Shift extends the selection.
const MOVES = {
  Left: 'caret.left', Right: 'caret.right', Up: 'caret.up', Down: 'caret.down',
  'Ctrl+Left': 'caret.wordLeft', 'Ctrl+Right': 'caret.wordRight',
  Home: 'caret.home', End: 'caret.end', 'Ctrl+Home': 'caret.docStart', 'Ctrl+End': 'caret.docEnd',
  PageUp: 'caret.pageUp', PageDown: 'caret.pageDown',
};
// Word for Mac: Option moves by word and paragraph, Command to the line's and the document's ends.
const MOVES_MAC = {
  Left: 'caret.left', Right: 'caret.right', Up: 'caret.up', Down: 'caret.down',
  'Alt+Left': 'caret.wordLeft', 'Alt+Right': 'caret.wordRight', 'Cmd+Left': 'caret.home', 'Cmd+Right': 'caret.end',
  'Alt+Up': 'caret.paraUp', 'Alt+Down': 'caret.paraDown', 'Cmd+Up': 'caret.docStart', 'Cmd+Down': 'caret.docEnd',
  Home: 'caret.home', End: 'caret.end', PageUp: 'caret.pageUp', PageDown: 'caret.pageDown',
};

// Whole chord → action, for keys where Shift means something else than extending.
const EDITS = {
  Backspace: { call: 'deleteBackward', args: ['character'] },
  'Ctrl+Backspace': { call: 'deleteBackward', args: ['word'] },
  Del: { call: 'deleteForward', args: ['character'] },
  'Ctrl+Del': { call: 'deleteForward', args: ['word'] },
  Enter: exec('text.newParagraph'),
  NumEnter: exec('text.newParagraph'),
  'Shift+Enter': exec('text.lineBreak'),
  Tab: exec('text.tab'),
  'Shift+Tab': exec('text.backTab'),
  'Ctrl+A': exec('select.all'),
};
const EDITS_MAC = {
  ...EDITS,
  'Alt+Backspace': EDITS['Ctrl+Backspace'],
  'Alt+Del': EDITS['Ctrl+Del'],
  'Cmd+A': EDITS['Ctrl+A'],
};
delete EDITS_MAC['Ctrl+Backspace'];
delete EDITS_MAC['Ctrl+Del'];
delete EDITS_MAC['Ctrl+A'];

const heading = (n) => (n <= 3 ? exec(`para.heading${n}`) : exec('para.style', { style: `Heading${n}` }));

// ponytail: Word keys with no engine command yet do nothing here (stage 2): Ctrl+PageUp and Ctrl+PageDown (browse previous and
// next, by page by default), Ctrl+Alt+PageUp and Ctrl+Alt+PageDown (the window's top and bottom, which needs the viewport's
// visible range), F8 and Shift+F8 (extend and shrink the selection) and Esc leaving column mode (select.column {on: false}, held
// back while Esc has other owners in the app). Ctrl+Shift+F8 and Alt+drag (pointer.js) select columns.
/** App binding id → the engine action. Ids come from src/app/keys.mjs DEFS (test/engine-input.test.mjs checks each exists). */
export const BINDS = {
  'edit.undo': { call: 'undo', args: [] },
  'edit.redo': { call: 'redo', args: [] },
  'text.bold': exec('format.bold'),
  'text.italic': exec('format.italic'),
  'text.underline': exec('format.underline'),
  'text.strike': exec('format.strikethrough'),
  'text.subscript': exec('format.subscript'),
  'text.superscript': exec('format.superscript'),
  'text.paragraph': exec('para.normal'),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`text.heading${n}`, heading(n)])),
  'text.bulletList': exec('para.bullets'),
  'text.orderedList': exec('para.numbering'),
  'text.alignLeft': exec('para.alignLeft'),
  'text.alignCenter': exec('para.alignCenter'),
  'text.alignRight': exec('para.alignRight'),
  'text.alignJustify': exec('para.justify'),
  'document.alignLeft': exec('para.alignLeft'),
  'document.alignCenter': exec('para.alignCenter'),
  'document.alignRight': exec('para.alignRight'),
  'document.justify': exec('para.justify'),
  'document.growFont': exec('format.growFont'),
  'document.shrinkFont': exec('format.shrinkFont'),
  'document.growFont1': exec('format.growFont1'),
  'document.shrinkFont1': exec('format.shrinkFont1'),
  'document.spacing1': exec('para.single'),
  'document.spacing15': exec('para.oneAndHalf'),
  'document.spacing2': exec('para.double'),
  'document.indent': exec('para.indent'),
  'document.outdent': exec('para.outdent'),
  'document.hanging': exec('para.hangingIndent'),
  'document.removeHanging': exec('para.removeHanging'),
  'document.clearParagraph': exec('para.reset'),
  'document.normalStyle': exec('para.normal'),
  'document.pageBreak': exec('text.pageBreak'),
};

// The bindings a Document's text hears, Word's first: a Word row that takes a chord (Ctrl+Shift+E Track Changes) wins over the
// text binding it shadows (Ctrl+Shift+E Align centre), as in the DOM editor. Global and editor bindings stay in the list so a chord
// the app owns (Ctrl+S, Ctrl+F) never falls through to a fixed key; actions.js handles those before this listener.
const RANK = { document: 0, text: 1, editor: 2, global: 3 };

/** A Word binding's context (keymap.mjs `when`) that limits where it holds; 'window' and none hold everywhere in the text. */
const whenOf = (d) => d.rows?.[0]?.when;
const limited = (d) => !!whenOf(d) && whenOf(d) !== 'window';

/** A Document's keymap from the app's key helpers: `defs` (keys.mjs DEFS, the binding ids with their scopes; a Word binding has
 * its command `cmd`, `arg` and keymap `rows`), `among(ids, e)` → the first of `ids` whose binding (the user's override counts)
 * takes key event `e` (keybinds.js keyAmong), `chordOf(e)` → the chord's name ('Ctrl+Shift+Left') and `isMac()`. The tool
 * registry's side, both optional: `tool(cmd, arg, row)` → a function that runs Word's command `cmd`, or null when the key goes on
 * to the fixed keys (registry keyCommand), and `holds(when)` → whether a binding's context holds now (registry keyHolds).
 * `binds` (BINDS by default): a format's own binding id → engine action, e.g. a post's text.bold as post.mark.
 * * → keymap(e): the engine action ({call, args} on the client or {run} for a registry command) or null when the
 * key is not the engine's (a typed character, or a binding that has no command here). */
export function createKeymap({ defs, among, chordOf, isMac, tool = () => null, holds = () => true, binds = BINDS }) {
  // A row with a context comes before the same chord without one, as WordKeys orders them (src/document/word/keys.js).
  const ranked = defs.filter((d) => d.scope in RANK).sort((a, b) => RANK[a.scope] - RANK[b.scope] || limited(b) - limited(a));
  const ids = ranked.map((d) => d.id);
  const word = new Map(ranked.filter((d) => d.cmd).map((d) => [d.id, d]));
  const whens = [...new Set(ranked.filter(limited).map(whenOf))];
  return (e) => {
    const chord = chordOf(e);
    if (!chord) return null;
    const off = new Set(whens.filter((w) => !holds(w)));
    const bound = among(off.size ? ids.filter((id) => !off.has(whenOf(word.get(id) ?? {}))) : ids, e);
    if (bound) {
      const d = word.get(bound);
      const row = d?.rows?.[0];
      // An accent prefix passes the chord pressed, so editing-keys knows which accent the next letter takes.
      const run = !binds[bound] && d ? tool(d.cmd, row?.prefix ? chord : d.arg, row) : null;
      const a = binds[bound] ?? (run ? { run } : null);
      if (a || !row?.fallthrough) return a;
    }
    const mac = isMac();
    const edit = (mac ? EDITS_MAC : EDITS)[chord];
    if (edit) return edit;
    const id = (mac ? MOVES_MAC : MOVES)[chord.split('+').filter((p) => p !== 'Shift').join('+')];
    return id ? exec(id, { extend: !!e.shiftKey }) : null;
  };
}
