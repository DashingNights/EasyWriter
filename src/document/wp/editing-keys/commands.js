// editing-keys' commands (docs/plans/word briefs/editing-keys.md; plan.md §1.13 bind rows): Extend, Shrink and Column Select, Esc,
// F2 and Shift+F2, Repeat, Undo and Redo, Go Back, the paragraph and window moves, the special characters, the accent prefixes,
// overtype, x.selection.multi and Close. Each acts on ctx.target, the focused story.
import { redoDepth, undoDepth } from '@tiptap/pm/history';
import { Selection, TextSelection } from '@tiptap/pm/state';
import { lastCommand } from '../../../tooling/registry.js';
import { goBack, pickRepeat } from './logic.mjs';
import { MultiSelection } from './multisel.js';
import { ekKey, endModes, pending, setWord, undoLabels, word } from './plugin.js';
import { flatOf, grow, shrink } from './words.mjs';

const viewOf = (ctx) => (ctx.target?.view?.dom?.isConnected ? ctx.target.view : null);

/** Runs `fn(view)` on the target's view → its result, false without one. */
const on = (fn) => (ctx, arg) => {
  const view = viewOf(ctx);
  return view ? fn(view, arg, ctx) : false;
};

/** Moves the head to `pos`, extending from the anchor with `extend` or in Extend mode. */
function moveTo(view, pos, extend) {
  const { doc, selection } = view.state;
  const anchor = extend || word().extend === 'extend' ? selection.anchor : pos;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, anchor, pos)).scrollIntoView());
  return true;
}

/** The start of the next textblock after the one holding `$pos`, or null. */
const nextBlock = (doc, $pos) => ($pos.depth ? Selection.findFrom(doc.resolve($pos.after()), 1, true)?.$from ?? null : null);
const prevBlock = (doc, $pos) => ($pos.depth ? Selection.findFrom(doc.resolve($pos.before()), -1, true)?.$from ?? null : null);

/** Ctrl+Up: the start of this paragraph, or of the previous one when already there. */
const paraUp = (view, extend) => {
  const { $head } = view.state.selection;
  if ($head.pos > $head.start()) return moveTo(view, $head.start(), extend);
  const prev = prevBlock(view.state.doc, $head);
  return prev ? moveTo(view, prev.start(), extend) : true;
};

/** Ctrl+Down: the start of the next paragraph; Ctrl+Shift+Down extends to this paragraph's end, then the next one's. */
const paraDown = (view, extend) => {
  const { doc, selection: { $head } } = view.state;
  if (extend && $head.pos < $head.end()) return moveTo(view, $head.end(), true);
  const next = nextBlock(doc, $head);
  if (!next) return moveTo(view, $head.end(), extend);
  return moveTo(view, extend ? next.end() : next.start(), extend);
};

/** Ctrl+Alt+PageUp and PageDown: the first or last fully visible line of the viewport ([data-viewport]). */
function windowEdge(view, end, extend) {
  const vp = view.dom.closest('[data-viewport]')?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
  const r = view.dom.getBoundingClientRect();
  const top = Math.max(vp.top, r.top);
  const bottom = Math.min(vp.bottom, r.bottom);
  let pos = view.posAtCoords({ left: end ? r.right - 1 : r.left + 1, top: end ? bottom - 2 : top + 2 })?.pos;
  if (pos == null) return true;
  // A line cut by the viewport's edge is not fully visible: take the next line in.
  const c = view.coordsAtPos(pos);
  const h = c.bottom - c.top;
  if (!end && c.top < vp.top - 0.5) pos = view.posAtCoords({ left: r.left + 1, top: c.bottom + h / 2 })?.pos ?? pos;
  if (end && c.bottom > vp.bottom + 0.5) pos = view.posAtCoords({ left: r.right - 1, top: c.top - h / 2 })?.pos ?? pos;
  return moveTo(view, pos, extend);
}

const insert = (ch) => on((view) => {
  view.dispatch(view.state.tr.insertText(ch).scrollIntoView());
  return true;
});

/** F8 and Shift+F8 on the flat text, from the caret Extend mode started at. */
function step(view, dir) {
  const { doc, selection } = view.state;
  const starting = word().extend !== 'extend';
  if (starting) {
    setWord({ extend: 'extend' });
    view.dispatch(view.state.tr.setMeta(ekKey, { origin: selection.head }));
    if (dir > 0) return true; // the first F8 turns Extend on and keeps the selection
  }
  const flat = flatOf(doc);
  const origin = flat.offset(ekKey.getState(view.state)?.origin ?? selection.head);
  const cur = [flat.offset(selection.from), flat.offset(selection.to)];
  const next = dir > 0 ? grow(flat.text, origin, cur) : shrink(flat.text, origin, cur);
  if (next) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, flat.at(next[0]), flat.at(next[1]))).scrollIntoView());
  return true;
}

/** Repeat's text: what was typed since the caret last moved, else the run before that. */
const typedOf = (state) => {
  const t = ekKey.getState(state)?.typed;
  return t ? { text: t.run || t.last, cmd: t.cmd } : { text: '', cmd: null };
};

/** What Redo / Repeat would do for `ctx` → 'redo' | 'repeat' | 'type' | null. */
function repeatKind(ctx) {
  const state = ctx.target?.state;
  if (!state) return null;
  const t = typedOf(state);
  return pickRepeat({ canRedo: redoDepth(state) > 0, cmd: lastCommand(), cmdAtTyping: t.cmd, typed: t.text });
}

const redo = (ctx) => !!ctx.target && redoDepth(ctx.target.state) > 0 && ctx.target.commands.redo();

const REPEAT = {
  run: (ctx) => {
    const kind = repeatKind(ctx);
    if (kind === 'redo') return redo(ctx);
    if (kind === 'repeat') {
      const c = lastCommand();
      return ctx.run(c.id, c.arg);
    }
    if (kind === 'type') return insert(typedOf(ctx.target.state).text)(ctx);
    return true;
  },
  value: (ctx) => {
    const kind = repeatKind(ctx);
    return kind === 'type' ? 'repeat' : kind;
  },
  enabled: (ctx) => repeatKind(ctx) != null,
  label: (ctx) => ({ redo: 'Redo', repeat: 'Repeat', type: 'Repeat' })[repeatKind(ctx)] ?? "Can't Repeat",
  icon: (ctx) => (repeatKind(ctx) === 'redo' ? 'Redo2' : 'Repeat'),
};

const UNDO = {
  run: (ctx) => !!ctx.target && undoDepth(ctx.target.state) > 0 && ctx.target.commands.undo(),
  enabled: (ctx) => !!ctx.target && undoDepth(ctx.target.state) > 0,
  label: (ctx) => {
    const top = ctx.target ? undoLabels(ctx.target.state)[0] : null;
    return top ? `Undo ${top}` : 'Undo';
  },
};

const moveMode = (kind) => on((view) => {
  const { from, to, empty } = view.state.selection;
  if (empty) return true;
  view.dispatch(view.state.tr.setMeta(ekKey, { src: { from, to } }));
  setWord({ extend: kind });
  return true;
});

export const COMMANDS = {
  'selection.extend': { run: on((view) => step(view, 1)), active: () => word().extend === 'extend' },
  'selection.shrink': { run: on((view) => step(view, -1)) },
  'selection.columnSelect': {
    run: on((view) => {
      const head = view.state.selection.head;
      const c = view.coordsAtPos(head);
      pending.col = { anchor: { left: c.left, top: c.top, bottom: c.bottom }, head };
      setWord({ extend: 'column' });
      return true;
    }),
    active: () => word().extend === 'column',
  },
  // Esc: ends Extend, column selection, F2 and Shift+F2, a pending prefix and Format Painter; declined when none was on.
  'editing.cancel': { run: (ctx) => endModes(viewOf(ctx)) },
  'editing.move': { run: moveMode('move'), active: () => word().extend === 'move' },
  'editing.copyTo': { run: moveMode('copy'), active: () => word().extend === 'copy' },
  'frame.qat.redoRepeat': REPEAT,
  'frame.qat.undo': UNDO,
  'editing.redoKey': { run: (ctx) => redo(ctx) },
  'navigation.goBack': {
    run: on((view) => {
      const v = ekKey.getState(view.state);
      const next = goBack(v?.ring ?? [], v?.idx ?? -1, view.state.selection.head);
      if (!next) return true;
      const pos = Math.min(next.pos, view.state.doc.content.size);
      view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos))).setMeta(ekKey, { idx: next.index }).scrollIntoView());
      return true;
    }),
  },
  'navigation.paraUp': { run: on((view) => paraUp(view, false)) },
  'navigation.paraDown': { run: on((view) => paraDown(view, false)) },
  'selection.paraUpExtend': { run: on((view) => paraUp(view, true)) },
  'selection.paraDownExtend': { run: on((view) => paraDown(view, true)) },
  'navigation.startOfWindow': { run: on((view) => windowEdge(view, false, false)) },
  'navigation.endOfWindow': { run: on((view) => windowEdge(view, true, false)) },
  'selection.startOfWindowExtend': { run: on((view) => windowEdge(view, false, true)) },
  'selection.endOfWindowExtend': { run: on((view) => windowEdge(view, true, true)) },
  'chars.nbsp': { run: insert(' ') },
  'chars.nbHyphen': { run: insert('‑') },
  'chars.enDash': { run: insert('–') },
  'chars.emDash': { run: insert('—') },
  // The prefix chord (Ctrl+', Ctrl+Shift+6...) waits for the next letter (plugin.js onKeyDown).
  'chars.accentPrefixes': {
    run: (ctx, chord) => {
      pending.prefix = chord ?? null;
      return true;
    },
  },
  'editing.overtype': {
    run: () => {
      setWord({ overtype: !word().overtype });
      return true;
    },
    active: () => !!word().overtype,
  },
  // Other packages (find, protect) set a multiple selection through the registry: arg [{from, to}].
  'x.selection.multi': {
    run: (ctx, ranges) => {
      const ed = ctx.target;
      const sel = ed && Array.isArray(ranges) ? MultiSelection.of(ed.state.doc, ranges) : null;
      if (!sel) return false;
      ed.view.dispatch(ed.state.tr.setSelection(sel));
      return true;
    },
  },
  'window.closeWindow': { run: (ctx) => ctx.run('file.close') },
};

