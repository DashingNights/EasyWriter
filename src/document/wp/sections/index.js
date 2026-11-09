// Section breaks and Page Setup (docs/plans/word/plan.md §3 sections; briefs/sections.md): the Breaks, Margins, Orientation, Size and
// Text Direction menus acting on the sections the selection touches, Insert > Blank Page, the Page Setup launcher, and a double-click
// on a section break opening Page Setup for its section. The Page Setup dialog is src/document/PageSetupDialog.jsx (Dialogs.jsx's
// pageSetup); the transforms are in model.mjs.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { commandOf, ctxOf } from '../../../tooling/registry.js';
import { unitOf } from '../../../tooling/kit/units.mjs';
import { defaultSect } from '../../defaults.mjs';
import { sectionsOf } from '../../model/sections.mjs';
import {
  insertBlankPage, insertSectionBreak, MARGIN_PRESETS, marginDesc, orientSect, paperDesc, paperOf, PAPERS, patchSettings, presetOf, sizeSect, syncKinds,
  touched, updateSect,
} from './model.mjs';
import { TextDirectionDialog } from './TextDirectionDialog.jsx';

// The region's unit for menu descriptions, asked once as the kit does (cm until it answers).
let region = null;
Promise.resolve(globalThis.window?.api?.word?.region?.()).then((r) => { region = r ?? null; }, () => {});
const unit = (ctx) => unitOf(ctx.settings, ctx.profile, region);
const fallback = (ctx) => defaultSect(ctx.settings?.paper);
const mirrorOn = (ctx) => !!ctx.ed?.state.doc.attrs.settings?.mirrorMargins;

/** Runs `fn(tr)` on the main editor in one transaction (one undo step) → true; false without a Document. */
function edit(ctx, fn) {
  if (!ctx.ed) return false;
  return ctx.ed.chain().focus().command(({ tr }) => (fn(tr), true)).run();
}

/** Sets fn(old sect) on every section the selection touches (Word's ribbon menus act per section). */
const perSection = (ctx, fn, more) => edit(ctx, (tr) => {
  const { from, to } = tr.selection;
  for (const i of touched(tr.doc, from, to)) updateSect(tr, i, fn, fallback(ctx));
  more?.(tr);
});

/** The margins `m` ({top, bottom, left, right}) on the selected sections; Mirrored turns settings.mirrorMargins on, the others off. */
function setMargins(ctx, m, mirror) {
  return perSection(ctx, (old) => ({ ...old, margin: { ...old.margin, top: m.top, bottom: m.bottom, left: m.left, right: m.right } }), (tr) => {
    if (!!tr.doc.attrs.settings?.mirrorMargins !== !!mirror) patchSettings(tr, { mirrorMargins: !!mirror });
  });
}

const lastMargins = (ctx) => ctx.settings?.word?.lastMargins ?? null;
const sameMargins = (sect, m) => ['top', 'bottom', 'left', 'right'].every((k) => Math.abs(sect.margin[k] - m[k]) < 0.5);

/** Opens Page Setup on `tab`; the dialog applies its own change and resolves null. */
const pageSetup = (tab, more) => ({ run: (ctx) => (ctx.ed ? (ctx.dialog('pageSetup', { tab, ...more }), true) : false), enabled: (ctx) => !!ctx.ed });

const inBody = (ctx) => !!ctx.ed && ctx.story === 'body';
const KINDS = ['nextPage', 'continuous', 'evenPage', 'oddPage'];
const breakCmd = (kind) => ({
  run: (ctx) => edit(ctx, (tr) => {
    insertSectionBreak(tr, tr.selection.from, kind, { fallback: fallback(ctx) });
    tr.scrollIntoView();
  }),
  enabled: inBody,
});

const commands = {
  // Margins: the presets with their sizes as the second line, Last Custom Setting while one is stored, Custom Margins. `shows` and
  // `argDesc` are the derived item's visibility and second line; menus.jsx reads them once the integrator wires them in. Until then
  // the item shows with nothing stored, so a pick opens Custom Margins instead of doing nothing.
  'layout.pageSetup.margins': {
    run: (ctx, arg) => {
      if (arg === 'lastCustomSetting') return lastMargins(ctx) ? setMargins(ctx, lastMargins(ctx), lastMargins(ctx).mirror) : pageSetup('margins').run(ctx);
      return arg in MARGIN_PRESETS ? setMargins(ctx, MARGIN_PRESETS[arg], MARGIN_PRESETS[arg].mirror) : false;
    },
    value: (ctx) => presetOf(ctx.sect, mirrorOn(ctx))
      ?? (lastMargins(ctx) && sameMargins(ctx.sect, lastMargins(ctx)) && !!lastMargins(ctx).mirror === mirrorOn(ctx) ? 'lastCustomSetting' : null),
    shows: (ctx, arg) => arg !== 'lastCustomSetting' || !!lastMargins(ctx),
    argDesc: (ctx, arg) => (arg === 'lastCustomSetting' && lastMargins(ctx) ? marginDesc(lastMargins(ctx), unit(ctx), lastMargins(ctx).mirror) : null),
    enabled: (ctx) => !!ctx.ed,
  },
  ...Object.fromEntries(Object.entries(MARGIN_PRESETS).map(([k, m]) => [`layout.pageSetup.margins.${k}`, {
    run: (ctx) => setMargins(ctx, m, m.mirror),
    active: (ctx) => presetOf(ctx.sect, mirrorOn(ctx)) === k,
    desc: (ctx) => marginDesc(m, unit(ctx), m.mirror),
    enabled: (ctx) => !!ctx.ed,
  }])),
  'layout.pageSetup.margins.customMargins': pageSetup('margins'),

  'layout.pageSetup.orientation': {
    run: (ctx, o) => (o === 'portrait' || o === 'landscape' ? perSection(ctx, (old) => orientSect(old, o)) : false),
    value: (ctx) => ctx.sect.orient ?? 'portrait',
    enabled: (ctx) => !!ctx.ed,
  },
  ...Object.fromEntries(['portrait', 'landscape'].map((o) => [`layout.pageSetup.orientation.${o}`, {
    run: (ctx) => perSection(ctx, (old) => orientSect(old, o)),
    active: (ctx) => (ctx.sect.orient ?? 'portrait') === o,
    enabled: (ctx) => !!ctx.ed,
  }])),

  'layout.pageSetup.size': {
    run: (ctx, key) => (key in PAPERS ? perSection(ctx, (old) => sizeSect(old, PAPERS[key][1], PAPERS[key][2])) : false),
    value: (ctx) => paperOf(ctx.sect),
    enabled: (ctx) => !!ctx.ed,
  },
  'layout.pageSetup.size.morePaperSizes': pageSetup('paper'),
  'layout.pageSetup.launcher': pageSetup('margins'),

  // Breaks: the section breaks are ours; Page stays base's setPageBreak (Ctrl+Enter), Column and Text Wrapping their owners'.
  'layout.pageSetup.breaks': {
    run: (ctx, arg) => (KINDS.includes(arg) ? breakCmd(arg).run(ctx) : arg ? ctx.run(`layout.pageSetup.breaks.${arg}`) : false),
    enabled: inBody,
  },
  ...Object.fromEntries(KINDS.map((k) => [`layout.pageSetup.breaks.${k}`, breakCmd(k)])),

  'insert.pages.blankPage': {
    run: (ctx) => edit(ctx, (tr) => {
      insertBlankPage(tr, tr.selection.from);
      tr.scrollIntoView();
    }),
    enabled: inBody,
  },

  // Text Direction: horizontal only; the vertical entries are placeholders (spec needs verticalText).
  'layout.pageSetup.textDirection': {
    run: (ctx, arg) => (arg === 'horizontal' ? ctx.run('layout.pageSetup.textDirection.horizontal') : false),
    value: (ctx) => (ctx.sect.textDir === 'lrTb' ? 'horizontal' : null),
    enabled: (ctx) => !!ctx.ed,
  },
  'layout.pageSetup.textDirection.horizontal': {
    run: (ctx) => perSection(ctx, (old) => (old.textDir === 'lrTb' ? old : { ...old, textDir: 'lrTb' })),
    active: (ctx) => (ctx.sect.textDir ?? 'lrTb') === 'lrTb',
    enabled: (ctx) => !!ctx.ed,
  },
  'layout.pageSetup.textDirection.textDirectionOptions': {
    run: (ctx) => (ctx.ed ? (ctx.dialog('textDirection'), true) : false),
    enabled: (ctx) => !!ctx.ed,
  },
};

const galleries = {
  // Size: the common sizes with their dimensions, the current one checked (base registers the same id with five sizes).
  // On a canvas draft the current size is the engine row's value (src/document/canvas/rows/page.mjs).
  'layout.pageSetup.size': Object.assign((ctx) => {
    const now = ctx.engine ? commandOf('layout.pageSetup.size')?.value?.(ctx) : paperOf(ctx.sect);
    return Object.entries(PAPERS).map(([id, [label]]) => ({ id, label, desc: paperDesc(id, unit(ctx)), active: now === id }));
  }, { engine: true }),
};

// A double-click on a section break opens Page Setup for the section it ends (index-keys.md mouse table). A deletion that merges
// sections brings the break kinds back in step with the merged sections' sect.type (syncKinds).
const BreakClicks = Extension.create({
  name: 'wordSectionBreakClicks',
  addProseMirrorPlugins: () => [new Plugin({
    key: new PluginKey('wordSectionMerge'),
    appendTransaction: (trs, old, state) => (trs.some((tr) => tr.docChanged)
      && sectionsOf(state.doc).length < sectionsOf(old.doc).length ? syncKinds(state) : null),
  }), new Plugin({
    key: new PluginKey('wordSectionBreakClicks'),
    props: {
      handleDoubleClickOn(view, _pos, node, nodePos) {
        if (node.type.name !== 'sectionBreak' || !view.dom.isConnected) return false;
        const ctx = ctxOf();
        if (ctx.ed?.view !== view) return false; // a session or story editor
        const sec = sectionsOf(view.state.doc).find((s) => s.holder === nodePos);
        ctx.dialog('pageSetup', { tab: 'layout', section: sec?.index });
        return true;
      },
    },
  })],
});

export default {
  id: 'sections',
  commands,
  galleries,
  dialogs: { textDirection: TextDirectionDialog },
  extensions: [BreakClicks],
  // Delivered without a command of their id: Ctrl+Enter stays base's key row, the rest are parts of the Page Setup dialog.
  implements: ['editing.pageBreakKey', 'sections.applyTo', 'sections.gutter', 'sections.mirrorMargins', 'sections.documentGrid', 'sections.setAsDefault'],
};

