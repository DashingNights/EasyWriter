// The dialog registry (docs/plans/word/plan.md §1.6): the kit's own dialogs and every work package's `dialogs`, by dialog id
// (the camelCase Word dialog name). Dialogs.jsx spreads WORD_DIALOGS into its FORMS, so actions.js openDialog(id, props) opens any of
// them, stacked over an open dialog. The modules merge by §1.2's keyed rule: one may replace a kit dialog, two on one id is an error
// that keeps the first.
import { MODULES } from '../document/wp/index.js';
import { ColorDialog } from './kit/ColorPicker.jsx';
import { KitSample } from './kit/KitSample.jsx';
import { putKeyed } from './registry.js';

const dialogs = new Map();
// colors: More Colors, the app's colour picker in a dialog (Word's Colors dialog is gone; the id stays for its callers).
putKeyed(dialogs, 'dialog', 'base', { colors: ColorDialog, kitSample: KitSample });
for (const mod of MODULES) putKeyed(dialogs, 'dialog', mod.id, mod.dialogs);

export const WORD_DIALOGS = Object.fromEntries([...dialogs].map(([id, e]) => [id, e.value]));
