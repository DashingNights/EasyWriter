// The commands the palette runs (tools.js, SPEC §7c), named here so node --test can check them against the catalogue:
// tools.js imports JSX, the contract test cannot import it. tools.js reads the ids from PALETTE.

export const PALETTE = { newDraft: 'drafts.create', setTag: 'drafts.setTag', move: 'drafts.move', selectThread: 'threads.select' };

export const PALETTE_COMMANDS = Object.values(PALETTE);
