// fields-ref: bookmarks, cross-references, hyperlinks and the reference fields (docs/plans/word/briefs/fields-ref.md). The pure parts
// are bookmarks.mjs, formula.mjs, cells.mjs, refs.mjs and xref.mjs; edit.js and plugin.js act on editors; the dialogs are the .jsx
// files. Field types whose clicks need an editor get them here.
import { BookmarkDialog } from './BookmarkDialog.jsx';
import { CrossRefDialog } from './CrossRefDialog.jsx';
import { addBookmark, deleteBookmark, follow, goToDestination, goToPlace, selectField, webGo } from './edit.js';
import { FormulaDialog } from './FormulaDialog.jsx';
import { applyLink, HyperlinkDialog, linksOf, ScreenTipDialog, SelectPlaceDialog, TargetFrameDialog } from './HyperlinkDialog.jsx';
import { FieldsRef } from './plugin.js';
import { FIELD_TYPES, hyperlinkOf, PROVIDERS } from './refs.mjs';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { toast } from '../../../app/actions.js';
import { getState } from '../../../app/store.js';
import { openPane } from '../../../app/browser.js';
import { clickHooks } from '../../../engine/input/pointer.js';
import { canGo, followAt, linkHooks } from './canvas.mjs';

// On a canvas draft Ctrl+click (a plain click with the Ctrl+click option off) follows a link (canvas.mjs), web addresses opening in the browser pane as on the DOM path.
Object.assign(linkHooks, { open: (url) => openPane(null, url), toast,
  ctrlClick: () => wordSettings(getState().settings ?? {}).editing?.ctrlClickLinks !== false });
clickHooks.add(followAt);

const fields = {
  ...FIELD_TYPES,
  HYPERLINK: { ...FIELD_TYPES.HYPERLINK, click: (f, ctx, api) => follow(api.editor, hyperlinkOf(f)) },
  GOTOBUTTON: { ...FIELD_TYPES.GOTOBUTTON, click: (f, ctx, api) => goToDestination(api.editor, f.args[0] ?? '', ctx.geometry) },
  MACROBUTTON: {
    ...FIELD_TYPES.MACROBUTTON,
    // Macros are left out (VBA): a click selects the field, so typing replaces a NoMacro placeholder.
    click: (f, ctx, api) => {
      const pos = api.getPos?.();
      return typeof pos === 'number' && selectField(api.editor.view, pos);
    },
  },
};

const dialog = (id) => ({ run: (ctx) => ctx.dialog(id, { editor: ctx.target }), enabled: (ctx) => !!ctx.target });

export default {
  id: 'fields-ref',
  extensions: [FieldsRef],
  commands: {
    // The split button applies a recent address picked from its arrow (arg), else opens Insert Hyperlink.
    'insert.links.link': {
      run: (ctx, arg) => (typeof arg === 'string' && arg ? applyLink(ctx.target, { href: arg }) : ctx.dialog('insertHyperlink', { editor: ctx.target })),
      enabled: (ctx) => !!ctx.target,
    },
    'insert.links.link.insertLink': dialog('insertHyperlink'),
    'insert.links.bookmark': dialog('bookmark'),
    'insert.links.crossReference': dialog('crossReference'),
    'tableLayout.data.formula': { ...dialog('formula'), enabled: (ctx) => !!ctx.target && ctx.in.table, reason: (ctx) => (ctx.in.table ? null : 'Put the cursor in a table cell first.') },
    // Alt+Left and Alt+Right fall through to the editor when no link was followed (keymap fallthrough).
    'navigation.webGoBack': { run: (ctx) => (ctx.target ? webGo(ctx.target, -1) : false) },
    'navigation.webGoForward': { run: (ctx) => (ctx.target ? webGo(ctx.target, 1) : false) },
  },
  galleries: {
    // The Link split button's arrow: the addresses this document already links to (Word lists recent files).
    'insert.links.link': (ctx) => (ctx.target ? linksOf(ctx.target.state.doc).filter((l) => l.href && !l.href.startsWith('#')).slice(0, 10)
      .map((l) => ({ id: l.href, label: l.href })) : []),
  },
  dialogs: {
    bookmark: BookmarkDialog,
    crossReference: CrossRefDialog,
    insertHyperlink: HyperlinkDialog,
    formula: FormulaDialog,
    setHyperlinkScreenTip: ScreenTipDialog,
    selectPlaceInDocument: SelectPlaceDialog,
    setTargetFrame: TargetFrameDialog,
  },
  fields,
  providers: PROVIDERS,
  // The Insert > Links group, Show bookmarks (settings.word.bookmarks, drawn by plugin.js and style.css) and Ctrl+click on links.
  implements: ['insert.links', 'marks.bookmarks', 'editing.ctrlClickLink'],
};

// The harness's hook (docs/plans/word/plan.md §1.16): bookmark edits and following without the dialogs.
if (typeof window !== 'undefined') {
  window.__fieldsRef = { addBookmark, deleteBookmark, goToPlace, follow, webGo, applyLink, saveWord };
  window.__fieldsRefCanvas = { canGo };
}
