// The styles work package (docs/plans/word/plan.md §3 styles, briefs/styles.md): the Home > Styles gallery with Word's quick
// styles and their item menus, character and linked styles, Create a Style and Modify Style, Update to Match Selection,
// Automatically update, style shortcut keys, outline levels and References > Add Text, the heading and Normal keys, the style
// separator, and Set As Default for the Font and Paragraph dialogs. stylesheet.js draws what these write.
import { createElement as h } from 'react';
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { AttrStep, Mapping, ReplaceAroundStep } from '@tiptap/pm/transform';
import { chordOf, normalize } from '../../../app/keys.mjs';
import { fontStack } from '../../../office.mjs';
import { ctxOf, run } from '../../../tooling/registry.js';
import { THEME } from '../../defaults.mjs';
import { styleIdOf } from '../../model/styles.mjs';
import { resolved, resolvedAll, runCss } from '../../stylesheet.js';
import { saveWord } from '../../word/settings.mjs';
import { hooks } from '../../canvas/rows/home.mjs';
import { applyStyle, currentStyle, setStyles, stylesOf, updateToMatch, usageOf, writeStyle } from './apply.js';
import { RenameDialog, SetAsDefaultDialog, ShortcutDialog, StyleDialog, UpdatePromptDialog } from './dialogs.jsx';
import {
  addTextAction, addTextItemOf, BUILTIN_NAMES, camelCss, CHAR_STYLES, displayName, foldDirect, galleryIds, linkedParaOf, newDocumentPatch,
  outlineLevel, patchStyle, pilcrow, withDefaults, withStyle,
} from './model.mjs';

// ---------- the gallery ----------
const tiles = new WeakMap(); // styles attribute → Map(`${id}|${theme name}` → tile)

/** The gallery tile of style `id`: "AaBbCcDd" in the style (its size capped to the tile) over its name, ¶ before a paragraph
 * style with no character half. Built from stylesheet.js resolvedAll, so a tile is made once per styles attribute. */
function tileOf(styles, theme, id) {
  if (!tiles.has(styles)) tiles.set(styles, new Map());
  const memo = tiles.get(styles);
  const key = `${id}|${theme?.name ?? ''}`;
  if (memo.has(key)) return memo.get(key);
  const list = styles.list ?? {};
  const r = resolvedAll(styles)[id] ?? (CHAR_STYLES[id] && resolved({ [id]: CHAR_STYLES[id] }, id)) ?? {};
  const pid = linkedParaOf(list, id);
  const run = { ...styles.defaults?.run, ...(pid ? resolved(list, pid).run : r.run) };
  const css = camelCss(runCss({ ...run, font: undefined, size: Math.min(run.size ?? 12, 14) }));
  const font = run.font ? fontStack(run.font, theme) : undefined;
  const tile = h('span', { className: 'flex w-full min-w-0 flex-col items-start gap-0.5 text-left', 'data-style-tile': id },
    h('span', { className: 'w-full truncate leading-tight', style: { ...css, fontFamily: font, fontSize: css.fontSize ?? '12pt' } }, 'AaBbCcDd'),
    h('span', { className: 'w-full truncate text-[11px] text-foreground/80' }, `${pilcrow(list, id) ? '¶ ' : ''}${displayName(list, id)}`));
  memo.set(key, tile);
  return tile;
}

/** The Styles gallery's items for `ctx` (Word's order, the current style checked), each with its right-click menu. */
function gallery(ctx) {
  const state = ctx.state;
  if (!state) return [];
  const styles = stylesOf(state);
  const list = styles.list ?? {};
  const theme = state.doc.attrs.theme ?? THEME;
  const used = usageOf(state.doc);
  const cur = currentStyle(state);
  return galleryIds(list, used).map((id) => {
    const name = displayName(list, id).split(',')[0];
    return {
      id, label: displayName(list, id), active: id === cur, preview: tileOf(styles, theme, id),
      menu: [
        { id: 'styles.updateToMatch', label: `Update ${name} to Match Selection` },
        { id: 'styles.modify', label: 'Modify...' },
        { id: 'styles.selectAllInstances', label: `Select All ${used[id] ?? 0} Instance(s)` },
        { id: 'x.styles.rename', label: 'Rename...' },
        { id: 'x.styles.removeFromGallery', label: 'Remove from Style Gallery' },
      ],
    };
  });
}

/** The Styles gallery on a canvas draft: the engine's quick styles (styles.manage, in its recommended order), the caret's style
 * checked. The tiles show the name over a plain sample: the engine does not answer a style's resolved look yet (stage2.md G10). */
function canvasGallery(ctx) {
  const list = ctx.read('styles.manage', {}) ?? [];
  const cur = ctx.stateOf?.('para.style')?.value ?? null;
  return list.filter((s) => s.inGallery && !s.hidden).map((s) => ({
    id: s.id, label: s.name, active: s.id === cur,
    preview: h('span', { className: 'flex w-full min-w-0 flex-col items-start gap-0.5 text-left', 'data-style-tile': s.id },
      h('span', { className: 'w-full truncate leading-tight' }, 'AaBbCcDd'),
      h('span', { className: 'w-full truncate text-[11px] text-foreground/80' }, `${s.type === 'paragraph' ? '¶ ' : ''}${s.name}`)),
    menu: [
      { id: 'styles.updateToMatch', label: `Update ${s.name} to Match Selection` },
      { id: 'x.styles.rename', label: 'Rename...' },
      { id: 'x.styles.removeFromGallery', label: 'Remove from Style Gallery' },
    ],
  }));
}

// ---------- commands ----------
const styleArg = (ctx, arg) => (typeof arg === 'string' ? arg : currentStyle(ctx.state));

/** The outline level of the paragraph at the selection of `ctx` (0 to 9). */
function levelOf(ctx) {
  const node = ctx.state?.selection.$from.parent;
  if (!node?.isTextblock) return 9;
  const list = stylesOf(ctx.state).list ?? {};
  return outlineLevel(node.attrs.outline, resolved(list, styleIdOf(node)).para, node.type.name === 'heading' ? node.attrs.level : null);
}

/** References > Add Text item `item` on the paragraph at the selection of `ctx`. */
function addText(ctx, item) {
  const node = ctx.state?.selection.$from.parent;
  if (!node?.isTextblock) return false;
  const act = addTextAction(item, node.type.name === 'heading');
  return act.style ? ctx.chain((c) => c.setStyle(act.style)) : ctx.chain((c) => c.setParaProps(act.para));
}

/** Set As Default from the Font (`half` 'run') or Paragraph ('para') dialog with that dialog's `value`: this document's
 * defaults, and new documents' too when asked (settings.word.newDocument). */
async function setAsDefault(ctx, half, value) {
  if (!value || !ctx.state) return false;
  const where = await ctx.dialog('styleSetAsDefault', { what: half === 'run' ? 'font' : 'paragraph' });
  if (!where) return false;
  const now = ctxOf();
  setStyles(now, withDefaults(stylesOf(now.state), half, value));
  if (where === 'all') await saveWord({ newDocument: newDocumentPatch(now.settings?.word?.newDocument, { half, value }) });
  return true;
}

/** The style separator (Ctrl+Alt+Enter): splits the paragraph at the caret and hides the first part's mark (specVanish), so
 * the two paragraphs share a line in their own styles. */
function separator(ctx) {
  const { state } = ctx;
  if (!state?.selection.empty || !['paragraph', 'heading'].includes(state.selection.$from.parent.type.name)) return false;
  const pos = state.selection.$from.before();
  return ctx.chain((c) => c.splitBlock().command(({ tr }) => {
    tr.setNodeAttribute(pos, 'specVanish', true);
    tr.setNodeAttribute(tr.selection.$from.before(), 'specVanish', null);
    return true;
  }));
}

const ADD_TEXT = ['doNotShowInTableOfContents', 'level1', 'level2', 'level3'];

// Set As Default on a canvas draft (canvas/rows/home.mjs) saves "All new documents too" in the same settings.
hooks.newDocumentDefault = (half, value) => saveWord({ newDocument: newDocumentPatch(ctxOf().settings?.word?.newDocument, { half, value }) });

const COMMANDS = {
  'home.styles.styles': { value: ({ state }) => currentStyle(state), run: (ctx, id) => applyStyle(ctx, id), repeatable: true, enabled: (ctx) => !!ctx.state },
  'home.styles.styles.createAStyle': { run: (ctx) => ctx.dialog('createNewStyleFromFormatting', {}), enabled: (ctx) => !!ctx.state },
  'styles.modify': { run: (ctx, id) => ctx.dialog('modifyStyle', { styleId: styleArg(ctx, id) }), enabled: (ctx) => !!ctx.state },
  'styles.updateToMatch': { run: (ctx, id) => updateToMatch(ctx, styleArg(ctx, id)), enabled: (ctx) => !!ctx.state },
  'x.styles.rename': {
    label: 'Rename Style',
    run: async (ctx, arg) => {
      const id = styleArg(ctx, arg);
      const name = await ctx.dialog('renameStyle', { styleId: id });
      if (!name) return false;
      const b = BUILTIN_NAMES[id];
      return writeStyle(ctxOf(), id, b ? { aliases: name === b ? undefined : name } : { name });
    },
  },
  'x.styles.removeFromGallery': { label: 'Remove from Style Gallery', run: (ctx, id) => writeStyle(ctx, styleArg(ctx, id), { qFormat: false }) },
  // Ctrl+Alt+1 (Ctrl+Alt+2 and 3 stay the app's own heading keys, which do the same).
  'styles.headingKeys': { run: (ctx, n) => ctx.chain((c) => c.setStyle(`Heading${n ?? 1}`)), repeatable: true },
  'styles.normalKey': { run: (ctx) => ctx.chain((c) => c.setStyle('Normal')), repeatable: true },
  'styles.styleSeparator': { run: separator },
  'font.setAsDefault': { run: (ctx, value) => setAsDefault(ctx, 'run', value) },
  'paragraph.setAsDefault': { run: (ctx, value) => setAsDefault(ctx, 'para', value) },
  'references.tableOfContents.addText': { run: (ctx, item) => (ADD_TEXT.includes(item) ? addText(ctx, item) : false), value: (ctx) => addTextItemOf(levelOf(ctx)) },
  ...Object.fromEntries(ADD_TEXT.map((item) => [`references.tableOfContents.addText.${item}`, {
    run: (ctx) => addText(ctx, item), active: (ctx) => addTextItemOf(levelOf(ctx)) === item,
  }])),
  // 0 to 8 for Level 1 to 9, 9 for Body Text; null goes back to the style's level.
  'paragraph.outlineLevel': { value: levelOf, run: (ctx, n) => ctx.chain((c) => c.setParaProps({ outline: n == null ? null : Math.max(0, Math.min(9, +n)) })) },
};

// ---------- extensions ----------
/** Style shortcut keys (a style's `shortcut`, set in Modify Style > Format > Shortcut key): above WordKeys, Document text only. */
const StyleKeys = Extension.create({
  name: 'wordStyleKeys',
  priority: 1300,
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleKeyDown(view, e) {
          if (!(e.ctrlKey || e.altKey || e.metaKey)) return false;
          const list = view.state.doc.attrs.styles?.list;
          const chord = list && chordOf(e);
          if (!chord) return false;
          const want = normalize(chord);
          const id = Object.keys(list).find((k) => list[k].shortcut && normalize(list[k].shortcut) === want);
          if (!id) return false;
          run('home.styles.styles', id);
          return true;
        },
      },
    })];
  },
});

/** Automatically update (a paragraph style's autoRedefine): direct paragraph formatting a change gives such a paragraph moves
 * into its style, as Word does. Only keys the change set count, and only while the paragraph kept its style. */
const AutoRedefine = Extension.create({
  name: 'wordAutoRedefine',
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(trs, oldState, newState) {
        let styles = newState.doc.attrs.styles;
        if (!styles?.list || !Object.values(styles.list).some((s) => s.autoRedefine)) return null;
        // Paragraph attributes change through setNodeMarkup (ReplaceAroundStep) or setNodeAttribute (AttrStep), never typing.
        if (!trs.some((t) => t.steps.some((s) => s instanceof AttrStep || s instanceof ReplaceAroundStep))) return null;
        const map = new Mapping();
        for (const t of trs) map.appendMapping(t.mapping);
        const back = map.invert();
        const clears = [];
        newState.doc.descendants((node, pos) => {
          if (!node.isTextblock) return true;
          const id = styleIdOf(node);
          const s = styles.list[id];
          if (!s?.autoRedefine || s.type !== 'paragraph') return false;
          const old = oldState.doc.nodeAt(back.map(pos, 1));
          if (!old?.isTextblock || styleIdOf(old) !== id) return false; // just styled: not a redefinition
          const { para, clear } = foldDirect(old.attrs, node.attrs);
          if (clear.length) {
            styles = withStyle(styles, id, patchStyle(styles.list[id], { para }));
            clears.push([pos, clear]);
          }
          return false;
        });
        if (!clears.length) return null;
        const tr = newState.tr.setDocAttribute('styles', styles);
        for (const [pos, keys] of clears) for (const k of keys) tr.setNodeAttribute(pos, k, null);
        return tr;
      },
    })];
  },
});

export default {
  id: 'styles',
  commands: COMMANDS,
  galleries: { 'home.styles.styles': Object.assign((ctx) => (ctx.engine ? canvasGallery(ctx) : gallery(ctx)), { engine: true }) },
  dialogs: {
    createNewStyleFromFormatting: StyleDialog,
    modifyStyle: StyleDialog,
    styleShortcutKey: ShortcutDialog,
    styleUpdatePrompt: UpdatePromptDialog,
    styleSetAsDefault: SetAsDefaultDialog,
    renameStyle: RenameDialog,
  },
  extensions: [StyleKeys, AutoRedefine],
  // Behaviours with no command of their own: character and linked styles (applying and drawing), table style conditions
  // (stylesheet.js), List as a Style type (opens lists' Define New List Style), the update prompt, a style's tab stops (Format >
  // Tabs writes para.tabs, which tabs lays out).
  implements: ['styles.characterStyles', 'styles.linkedStyles', 'styles.tableStyles', 'styles.listStyles', 'styles.promptUpdate', 'tabs.inStyles'],
};
