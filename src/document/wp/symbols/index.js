// symbols: Insert > Symbol with its recently used gallery, the Symbol and Number dialogs, the symbol chords and Alt+X
// (docs/plans/word briefs/symbols.md). The data and the pure rules are in chars.mjs, the edits in insert.js.
import { createElement as h } from 'react';
import { fontStack } from '../../../office.mjs';
import { isSymbolFont, recentLabel, recentOf } from './chars.mjs';
import { canType, insertSymbol, insertText, toggleCode } from './insert.js';
import { NumberDialog } from './NumberDialog.jsx';
import { SymbolDialog } from './SymbolDialog.jsx';

const typing = { enabled: canType, reason: (ctx) => (canType(ctx) ? null : 'Put the cursor in the text first.') };

// A gallery item's id carries its symbol, so a pick needs no lookup in a list that may have changed since the menu opened.
const idOf = (e) => JSON.stringify([e.char, e.font ?? null]);
const entryOf = (id) => {
  try {
    const [char, font] = JSON.parse(id);
    return typeof char === 'string' && char ? { char, font: font ?? null } : null;
  } catch {
    return null;
  }
};

// A menu cell's box, inline because the menu draws in a portal outside every Document scope a package stylesheet may use.
const CELL = { display: 'grid', placeItems: 'center', width: '1.75rem', height: '1.75rem', fontSize: '1.25rem', lineHeight: 1 };

/** The Symbol menu's 20 cells: the recently used symbols, Word's default list on a fresh profile. */
function recentGallery(ctx) {
  return recentOf(ctx.settings?.word?.recentSymbols).map((e) => ({
    id: idOf(e),
    label: recentLabel(e),
    preview: h('span', { style: { ...CELL, ...(e.font && !isSymbolFont(e.font) && { fontFamily: fontStack(e.font) }) } }, e.char),
  }));
}

recentGallery.engine = true; // the settings' list, the same on a canvas draft

const openSymbol = (ctx, props) => ctx.dialog('symbol', props);

export default {
  id: 'symbols',
  commands: {
    // The dropdown's cells run it with their id; with no arg (tool search) it opens the dialog.
    'insert.symbols.symbol': {
      ...typing,
      run: (ctx, arg) => {
        const e = arg == null ? null : entryOf(arg);
        return e ? insertSymbol(ctx, e) : openSymbol(ctx);
      },
    },
    'insert.symbols.symbol.moreSymbols': { ...typing, run: (ctx) => openSymbol(ctx) },
    'insert.symbols.number': { ...typing, run: (ctx) => ctx.dialog('number') },
    // Ctrl+Alt+E and the other symbol chords carry their character (plan.md §1.13); typing groups with the text around it.
    'chars.symbols': { ...typing, run: (ctx, arg) => (typeof arg === 'string' && arg ? insertText(ctx, arg, { ownStep: false }) : false) },
    'chars.altX': { ...typing, run: (ctx) => toggleCode(ctx) },
  },
  galleries: { 'insert.symbols.symbol': recentGallery },
  dialogs: { symbol: SymbolDialog, number: NumberDialog },
};
