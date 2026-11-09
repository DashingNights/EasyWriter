// Editing actions of the symbols package: insert a symbol (with its font), type a chord's character, Alt+X and Insert > Number.
// Each acts on ctx.target (the main editor or the story being edited) in one transaction.
import { closeHistory } from '@tiptap/pm/history';
import { saveWord } from '../../word/settings.mjs';
import { altX, isSymbolFont, pushRecent, recentOf } from './chars.mjs';

/** Whether the target takes text now (a read-only view or no Document declines; a canvas draft takes it through its engine). */
export const canType = (ctx) => !!ctx.engine || !!ctx.target?.isEditable;

/** Inserts `text` at the target's selection in the marks there; `font` (a font name) also sets the run's font; `ownStep` makes it
 * its own undo step (a symbol or a number), else it groups with the typing around it (a chord). On a canvas draft: Insert >
 * Symbol's command, which keeps a symbol font as the character's own, or the typing path for a chord. */
export function insertText(ctx, text, { font = null, ownStep = true } = {}) {
  const ed = ctx.target;
  if (!canType(ctx) || !text) return false;
  if (ctx.engine) {
    if (!ownStep) ctx.engine.insertText(text);
    else ctx.engine.exec(font ? 'insert.symbol' : 'text.insert', font ? { char: text, font } : { text, raw: true });
    return true;
  }
  const { state, view } = ed;
  let tr = state.tr;
  const style = state.schema.marks.textStyle;
  if (font && style) {
    const marks = state.storedMarks ?? state.selection.$from.marks();
    const old = style.isInSet(marks);
    const node = state.schema.text(text, style.create({ ...old?.attrs, font }).addToSet(marks));
    tr = tr.replaceSelectionWith(node, false);
  } else tr = tr.insertText(text);
  if (ownStep) closeHistory(tr);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Inserts symbol `{char, font}` and moves it to the front of the recently used list. A symbol font pick goes in as its Unicode
 * character in the current font (no symbol font is bundled); a text font pick sets that font, as Word does. */
export function insertSymbol(ctx, { char, font = null }) {
  if (!insertText(ctx, char, { font: font && !isSymbolFont(font) ? font : null })) return false;
  saveWord({ recentSymbols: pushRecent(recentOf(ctx.settings?.word?.recentSymbols), { char, font }) }).catch(() => {});
  return true;
}

/** The text of the selection's textblock before the caret, leaf nodes as U+FFFC so a hex run never spans one. */
function textBefore(state) {
  const { $from } = state.selection;
  return $from.parent.textBetween(0, $from.parentOffset, null, '￼');
}

/** Alt+X at the target's selection (chars.mjs altX) → whether the text changed. One undo step each time. */
export function toggleCode(ctx) {
  if (!canType(ctx)) return false;
  const { state, view } = ctx.target;
  const sel = state.selection;
  if (!sel.empty && sel.$from.parent !== sel.$to.parent) return false;
  const selected = sel.empty ? '' : state.doc.textBetween(sel.from, sel.to, null, '￼');
  const before = sel.empty ? textBefore(state) : '';
  const r = altX(before, selected);
  // A picture, field or other leaf before the caret has no code to show: leave it.
  if (!r || (sel.empty ? before.slice(-r.count) : selected).includes('￼')) return false;
  const from = sel.empty ? sel.from - r.count : sel.from;
  const tr = state.tr.insertText(r.text, from, sel.to);
  closeHistory(tr);
  view.dispatch(tr.scrollIntoView());
  return true;
}
