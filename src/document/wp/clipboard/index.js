// Work package clipboard (docs/plans/word plan.md §3): Word's Clipboard group and paste behaviour in Documents. Paste with the
// default for the source and the Paste Options that fit the clipboard, the Paste Options button, table paste choices, Paste
// Special, Set Default Paste, Format Painter, Copy and Paste Format, the Clipboard pane, the Spike and smart cut and paste.
// Forum posts paste as before: none of this is in their kit.
import { clip } from '../../tools.js';
import { paneOpen } from '../../../tooling/panes.jsx';
import { REASONS } from '../../../tooling/reasons.mjs';
import { run } from '../../../tooling/registry.js';
import { hooks } from '../../canvas/rows/home.mjs';
import { afterCopy } from '../../../engine/input/clipboard.js';
import { afterMouseSelect } from '../../../engine/input/pointer.js';
import { menuOpen, repickTable, toggleMenu } from './button.js';
import { DOMParser as PMDOMParser, DOMSerializer } from '@tiptap/pm/model';
import {
  addToRing, applyPick, clearRing, collectSystem, collecting, painterNow, pasteData, pickFrom, picked, readClipboard, ringItems, store,
  togglePainter,
} from './core.js';
import { pasteGallery } from './gallery.jsx';
import { MODES } from './modes.mjs';
import { ClipboardPane, pasteAll } from './Pane.jsx';
import { PasteSpecialDialog } from './PasteSpecial.jsx';
import { ClipboardExtension, clipKey } from './plugin.js';
import { spikeAppend, spikeTake } from './ring.mjs';
import { registerOverlay } from '../../canvas/overlay.jsx';
import { CanvasPasteButton } from './CanvasPasteButton.jsx';

// The Paste Options button over a canvas draft's pages, at the end of the last paste the engine keeps.
registerOverlay('paste-options', CanvasPasteButton);

// The canvas rows (src/document/canvas/rows/home.mjs) paste the same clipboard and keep the same ring and Spike.
Object.assign(hooks, { readClipboard, nativePaste: () => clip('paste')(), ringItems, clearRing, spikeAdd: spikeAddHtml, spikeInsert: spikeInsertHtml });
pasteGallery.engine = true; // it reads the clipboard snapshot, not the editor
// A copy or cut on a canvas draft joins the Clipboard pane as the DOM editor's do (core.js recordCopy).
afterCopy.add(({ html, text }) => {
  if (collecting()) addToRing({ html, text, kind: 'ours' });
});
// On a canvas draft an armed Format Painter applies once a mouse selection ends (Word's release), then turns off unless sticky.
afterMouseSelect.add(async (client) => {
  const m = await client.exec('edit.modes', {});
  if (m?.value?.painter) await client.exec('edit.pasteFormat', {});
});

const OPTIONS = new Set(Object.values(MODES));
const viewOf = (ctx) => (ctx.target?.view?.dom.isConnected ? ctx.target.view : null);
const lastPaste = (ctx) => (ctx.state ? clipKey.getState(ctx.state) : null);

/** Pastes the system clipboard into the tools' editor with option `mode` (Picture runs picture-format's paste.pastePicture). */
async function pasteWith(ctx, mode) {
  const data = await readClipboard();
  if (mode === 'picture' && !(data.image && !data.html && !data.text)) return run('paste.pastePicture');
  return pasteData(viewOf(ctx), data, mode);
}

// The Spike's store writes run one after another, so two quick Ctrl+F3 append in order.
let spikeQueue = Promise.resolve();
const BLOCKS = 'buildingBlocks';
/** Runs `fn` after the Spike's earlier store writes → its result (a failure does not stop the later ones). */
const queued = (fn) => {
  const p = spikeQueue.then(fn);
  spikeQueue = p.catch(() => {});
  return p;
};

// The Spike on a canvas draft: the same store entry as the DOM path's, its pieces in the Document schema's JSON, so a piece cut
// on either path inserts on the other. Loaded late: editors.js imports the module list this module is part of.
const schemaNow = async () => (await import('../../../editors.js')).kitOf('document').schema;
/** Appends the HTML (or the text) a canvas draft cut with Ctrl+F3 to the Spike. */
function spikeAddHtml({ html, text }) {
  return queued(async () => {
    const el = document.createElement('div');
    if (html) el.innerHTML = html;
    else for (const line of String(text ?? '').split(/\r?\n/)) el.append(Object.assign(document.createElement('p'), { textContent: line }));
    const blocks = PMDOMParser.fromSchema(await schemaNow()).parse(el).toJSON().content ?? [];
    const s = store();
    await s.set(BLOCKS, spikeAppend(await s.get(BLOCKS), blocks, { id: `spike-${Date.now()}` }));
  });
}
/** Hands the Spike's content as {html, text} to `paste` and empties the Spike when it pasted → whether it did, or null when the
 * Spike is empty. */
function spikeInsertHtml(paste) {
  return queued(async () => {
    const s = store();
    const { content, entries } = spikeTake(await s.get(BLOCKS));
    if (!content.length) return null;
    const doc = (await schemaNow()).nodeFromJSON({ type: 'doc', content });
    const el = document.createElement('div');
    el.append(DOMSerializer.fromSchema(doc.type.schema).serializeFragment(doc.content));
    if (!(await paste({ html: el.innerHTML, text: doc.textBetween(0, doc.content.size, '\n') }))) return false;
    await s.set(BLOCKS, entries);
    return true;
  });
}

const commands = {
  // The main part pastes through the window (Ctrl+V's path), so the plugin gives it the default for its source; a Paste Options
  // item pastes the clipboard read through IPC with that option.
  'home.clipboard.paste': {
    run: (ctx, arg) => {
      if (arg == null) return clip('paste')();
      if (!OPTIONS.has(arg)) return false;
      pasteWith(ctx, arg);
      return true;
    },
  },
  'paste.pasteTextOnly': { run: (ctx) => (viewOf(ctx) ? (pasteWith(ctx, 'keepTextOnly'), true) : false) },
  'home.clipboard.paste.pasteSpecial': {
    run: async (ctx) => {
      const data = await readClipboard();
      const as = await ctx.dialog('pasteSpecial', { data });
      const view = viewOf(ctx);
      if (!as || !view) return false;
      if (as === 'html') return pasteData(view, { html: data.html, text: data.text }, 'keepSourceFormatting');
      if (as === 'png') return pasteData(view, { image: data.image });
      return pasteData(view, { text: data.text }, 'keepTextOnly');
    },
  },
  'home.clipboard.paste.setDefaultPaste': {
    run: async (ctx) => {
      // The Options dialog is the options package's; until it registers, its reason shows. Loaded late: dialogs.js imports the hub.
      const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js');
      if (!WORD_DIALOGS.wordOptions) return ctx.toast(REASONS.pending), false;
      return ctx.dialog('wordOptions', { tab: 'advanced', section: 'paste' });
    },
  },
  'home.clipboard.formatPainter': { run: (ctx) => togglePainter(ctx.target), active: () => !!painterNow() },
  'home.clipboard.launcher': { run: (ctx) => ctx.pane('clipboard'), active: () => paneOpen('clipboard') },
  'panes.clipboard': { run: (ctx) => ctx.pane('clipboard'), active: () => paneOpen('clipboard') },
  'paste.optionsButton': {
    run: (ctx) => {
      const view = viewOf(ctx);
      if (!view || !lastPaste(ctx)) return false;
      toggleMenu(view);
      return true;
    },
    enabled: (ctx) => !!lastPaste(ctx),
    active: (ctx) => !!viewOf(ctx) && menuOpen(viewOf(ctx)),
  },
  'paste.tableChoices': {
    run: (ctx, arg) => (viewOf(ctx) && lastPaste(ctx)?.table ? repickTable(viewOf(ctx), arg) : false),
    enabled: (ctx) => !!lastPaste(ctx)?.table,
    value: (ctx) => lastPaste(ctx)?.table ?? null,
  },
  'editing.copyFormat': { run: (ctx) => (ctx.state ? !!pickFrom(ctx.state) : false) },
  'editing.pasteFormat': { run: (ctx) => (picked() ? applyPick(viewOf(ctx)) : false), enabled: () => !!picked() },
  'editing.spike': {
    run: (ctx) => {
      const view = viewOf(ctx);
      const sel = view?.state.selection;
      if (!sel || sel.empty) return false;
      const blocks = sel.content().content.toJSON() ?? [];
      // A cut with Word's smart spacing (the plugin treats uiEvent 'cut' as one).
      view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'));
      spikeQueue = spikeQueue.then(async () => {
        const s = store();
        await s.set(BLOCKS, spikeAppend(await s.get(BLOCKS), blocks, { id: `spike-${Date.now()}` }));
      }).catch((e) => ctx.toast(`The Spike could not be saved: ${e.message}`));
      return true;
    },
  },
  'editing.insertSpike': {
    run: (ctx) => {
      const ed = ctx.target;
      if (!viewOf(ctx)) return false;
      spikeQueue = spikeQueue.then(async () => {
        const s = store();
        const { content, entries } = spikeTake(await s.get(BLOCKS));
        if (!content.length) return ctx.toast('The Spike is empty.');
        ed.chain().focus().insertContent(content).run();
        await s.set(BLOCKS, entries);
      }).catch((e) => ctx.toast(`The Spike could not be read: ${e.message}`));
      return true;
    },
  },
  // The Clipboard pane's buttons, so tool search can reach them (EasyWriter's own ids: Word has no feature id for them).
  'x.clipboard.pasteAll': { run: (ctx) => pasteAll(ctx), enabled: () => ringItems().length > 0 },
  // The pane's Paste on one item (its id); on a canvas draft its row pastes through the engine (rows/home.mjs).
  'x.clipboard.pasteItem': {
    run: (ctx, id) => {
      const it = ringItems().find((x) => x.id === id);
      return !!it && pasteData(viewOf(ctx), { html: it.html, text: it.text, image: it.image });
    },
  },
  'x.clipboard.clearAll': { run: () => (clearRing(), true), enabled: () => ringItems().length > 0 },
};

export default {
  id: 'clipboard',
  extensions: [ClipboardExtension],
  commands,
  dialogs: { pasteSpecial: PasteSpecialDialog },
  panes: { clipboard: { title: 'Clipboard', side: 'left', Component: ClipboardPane } },
  galleries: { 'home.clipboard.paste': pasteGallery },
  // Behaviours without a command of their own: Word's clipboard HTML (paste.js and the schema keep it), the paste defaults the
  // plugin reads, and smart cut and paste.
  implements: ['paste.wordHtml', 'paste.defaults', 'editing.smartCutPaste'],
  setup() {
    // A copy in another program joins the Clipboard pane when the window gets the focus back (once per change).
    const onFocus = () => collectSystem();
    window.addEventListener('focus', onFocus);
    readClipboard();
    return () => window.removeEventListener('focus', onFocus);
  },
};
