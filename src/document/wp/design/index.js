// The design work package (docs/plans/word/plan.md §3 design, briefs/design.md): the Design tab's Document Formatting group on
// doc.attrs.theme and doc.attrs.styles (Themes, style sets, Colors, Fonts, Paragraph Spacing, Effects, Set as Default, their
// dialogs and resets) and Developer > Document Template. Each pick is one setDocAttribute transaction, so one Undo returns it.
// Theme colours are stored resolved (renderHTML reads only color), so a colour change re-resolves every themeColor in that same
// transaction (model.mjs setTheme).
import { createElement as h } from 'react';
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { confirmDialog } from '../../../app/actions.js';
import { getState } from '../../../app/store.js';
import { saveWord } from '../../word/settings.mjs';
import { THEME } from '../../defaults.mjs';
import { deepPatch } from '../../../office.mjs';
import { thmxOf } from '../../docx/export.mjs';
import { readThemeFile } from '../../docx/import.mjs';
import { docAttrs } from '../../canvas/attrs.js';
import { base64, bytesOf } from '../../../tooling/base64.mjs';
import { commandOf } from '../../../tooling/registry.js';
import {
  colorItems, COLOR_SETS, customSet, EFFECTS, eastAsian, FONT_SETS, fontItems, newDocumentOf, rethemeValue, savedSet, setTheme, SPACING, spacingKey, STYLE_SETS, styleSetOf, THEMES,
  themeWith, withSetSpacing, withSpacing, withStyleSet, withTemplate,
} from './model.mjs';
import { ColorsRow, CreateNewThemeColors, CreateNewThemeFonts, FontsRow, SaveAsANewStyleSet, StyleSetItem, TemplatesAndAddIns, ThemeTile } from './ui.jsx';
import { both } from '../../../tooling/engine-provider.mjs';
import { stylesSteps } from '../style-panes/canvas-ed.mjs';
import { readStyles, readTheme, themeColorList, themeOfSettings } from '../styles/engine.mjs';
import { docOfDraft } from '../../docx/files.js';

const ID = 'design.documentFormatting';
const store = () => window.api?.word?.store;

// The saved style sets (word store 'styleSets', [{name, styles}]), read when a Document opens and after each save, so the
// galleries stay synchronous.
let savedSets = [];
async function loadSets() {
  try {
    const v = await store()?.get('styleSets');
    savedSets = Array.isArray(v) ? v : [];
  } catch {
    savedSets = [];
  }
  return savedSets;
}

// On a canvas draft the theme and styles come from the engine (styles/engine.mjs): galleries read them through ctx.read, commands
// read them fresh before they write (engine-gaps-styles, stage2.md G8).
const themeOf = (ctx) => (ctx.engine ? readTheme(ctx) : ctx.ed?.state.doc.attrs.theme ?? THEME);
/** The theme now, read from the engine on a canvas draft. */
const themeNow = async (ctx) => (ctx.engine ? themeOfSettings((await ctx.engine.exec('document.settings', {}))?.value) : themeOf(ctx));
/** The style set a canvas draft took last in this session, keyed by its client: the engine keeps no style set name. */
// ponytail: forgotten at a reload; keep the name in the document's settings when the engine gets a field for it.
const canvasSet = new WeakMap();


/** Browse for Themes: the theme of an Office theme file or a Word file the user picks, applied to the Document. */
async function browseTheme(ctx) {
  const f = await window.api.word.openFile({ filters: [{ name: 'Office Themes and Themed Documents', extensions: ['thmx', 'docx', 'dotx', 'xml'] }], as: 'base64' });
  if (!f) return false;
  const theme = await readThemeFile(f.name, bytesOf(f.data), await themeNow(ctx)).catch(() => null);
  if (!theme) {
    ctx.toast(`${f.name} holds no theme.`);
    return false;
  }
  return applyTheme(ctx, themeWith(await themeNow(ctx), { name: theme.name, fonts: theme.fonts, colors: theme.colors }));
}

/** Save Current Theme: the Document's theme colours and fonts as an Office theme file (.thmx) Word and PowerPoint open. */
async function saveTheme(ctx) {
  const theme = await themeNow(ctx);
  const bytes = await thmxOf(theme);
  const path = await window.api.word.saveFile({ name: `${(theme.name || 'Theme').replace(/[\/:*?"<>|]+/g, ' ').trim() || 'Theme'}.thmx`, data: base64(bytes),
    filters: [{ name: 'Office Theme', extensions: ['thmx'] }], as: 'base64' });
  if (path) ctx.toast('Theme saved.');
  return !!path;
}
const stylesOf = (ctx) => (ctx.engine ? readStyles(ctx) ?? {} : ctx.ed?.state.doc.attrs.styles ?? {});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const onDoc = { enabled: (ctx) => !!ctx.ed };

/** Dispatches one transaction on the main editor built by `fn(tr)` (doc attributes live on the main doc, not on a story). */
function change(ctx, fn) {
  const ed = ctx.ed;
  if (!ed) return false;
  const tr = ed.state.tr;
  fn(tr, ed.state.doc.attrs);
  if (!tr.docChanged) return false;
  ed.view.dispatch(tr);
  return true;
}

/** Applies theme `theme` (whole) with its colours re-resolved everywhere. */
const applyTheme = (ctx, theme) => (ctx.engine
  ? Promise.resolve(ctx.engine.exec('design.theme', { name: theme.name || 'Custom', colors: themeColorList(theme.colors), major: theme.fonts?.major,
    minor: theme.fonts?.minor })).then((r) => !!r?.ok)
  : change(ctx, (tr) => setTheme(tr, theme)));

/** Applies style set `set` to the Document. */
const applySet = async (ctx, set) => {
  if (!set) return false;
  if (!ctx.engine) return change(ctx, (tr, a) => tr.setDocAttribute('styles', withStyleSet(a.styles, set, a.theme ?? THEME)));
  // A canvas draft: the set's styles over the engine's, sent as the changes only (one undo step).
  const attrs = await docAttrs(ctx);
  if (!attrs) return false;
  const steps = stylesSteps(attrs.styles, withStyleSet(attrs.styles, set, attrs.theme ?? THEME));
  const ok = !steps.length || !!(await ctx.engine.execMany(steps))?.ok;
  if (ok) canvasSet.set(ctx.engine, set.id);
  return ok;
};

const customColors = (ctx) => ctx.settings.word.themeColors ?? [];
const customFonts = (ctx) => ctx.settings.word.themeFonts ?? [];
const byId = (list, id, custom) => (String(id).startsWith('custom:') ? custom.find((x) => `custom:${x.name}` === id) : list.find((x) => x.id === id));

/** Saves `entry` ({name, ...}) into settings.word[key], replacing one of the same name. */
const saveNamed = (ctx, key, entry) => saveWord({ [key]: [...(ctx.settings.word[key] ?? []).filter((x) => x.name !== entry.name), entry] });

// ---------- Galleries ----------

/** A gallery that serves a canvas draft too: there the current item is the engine row's value (src/document/canvas/rows/page.mjs). */
const engineNow = (ctx, id) => commandOf(id)?.value?.(ctx) ?? null;

const galleries = {
  [`${ID}.themes`]: both((ctx) => {
    const now = themeOf(ctx);
    const pick = ctx.engine ? engineNow(ctx, `${ID}.themes`) : null;
    return THEMES.map((t) => ({
      id: t.id, label: t.name, group: 'Built-In', preview: h(ThemeTile, { theme: t }),
      active: ctx.engine ? pick === t.id
        : now.name === t.name && same(now.colors, t.colors) && same([now.fonts?.major, now.fonts?.minor], [t.fonts.major, t.fonts.minor]),
    }));
  }),
  [`${ID}.colors`]: both((ctx) => colorItems(themeOf(ctx), customColors(ctx)).map(({ set, ...it }) => ({
    ...it, ...(ctx.engine && { active: engineNow(ctx, `${ID}.colors`) === it.id }), preview: h(ColorsRow, { set }) }))),
  [`${ID}.fonts`]: both((ctx) => fontItems(themeOf(ctx), customFonts(ctx)).map(({ set, ...it }) => ({
    ...it, ...(ctx.engine && { active: engineNow(ctx, `${ID}.fonts`) === it.id }), preview: h(FontsRow, { set }) }))),
  // The engine keeps no effect set of its own (it adds the name to the theme's), so nothing shows picked on a canvas draft.
  [`${ID}.effects`]: both((ctx) => {
    const now = themeOf(ctx).effects ?? 'Plain';
    return EFFECTS.map((e) => ({ id: e.id, label: e.name, group: 'Built-In', active: !ctx.engine && now === e.name }));
  }),
  // On a canvas draft the set taken last in this session shows picked (canvasSet), with This Document while there is none.
  [`${ID}.documentFormatting`]: both((ctx) => {
    const styles = stylesOf(ctx);
    const theme = themeOf(ctx);
    const now = ctx.engine ? canvasSet.get(ctx.engine) ?? null : null;
    const tile = (set, group, active) => ({ id: set.id, label: set.name, group, active, preview: h(StyleSetItem, { set: rethemeValue(set, theme), theme }) });
    return [
      tile({ id: 'thisDocument', name: 'This Document', defaults: styles.defaults, list: styles.list }, 'This Document', !now),
      ...STYLE_SETS.map((s) => tile(s, 'Built-In', s.id === now)),
      ...savedSets.map((s) => tile(customSet(s), 'Custom', `custom:${s.name}` === now)),
    ];
  }),
};

// ---------- Commands ----------

const spacingItem = (key) => ({
  ...onDoc,
  run: (ctx) => change(ctx, (tr, a) => tr.setDocAttribute('styles', withSpacing(a.styles, key))),
  active: (ctx) => spacingKey(stylesOf(ctx), savedSets) === key,
});

const onDocOrCanvas = { enabled: (ctx) => !!ctx.ed || !!ctx.engine };

async function setAsDefault(ctx) {
  const ok = await confirmDialog({
    title: 'Set as default',
    description: 'New documents will start with this theme and style set. Documents you already have keep theirs.',
    confirmText: 'Set as default',
  });
  const attrs = ok ? await docAttrs(ctx) : null;
  if (!attrs) return false;
  await saveWord({ newDocument: newDocumentOf(attrs) });
  ctx.toast('New documents now start with this theme and style set.');
  return true;
}

async function customizeColors(ctx) {
  const now = await themeNow(ctx);
  const r = await ctx.dialog('createNewThemeColors', { colors: now.colors, names: customColors(ctx).map((x) => x.name) });
  if (!r) return false;
  await saveNamed(ctx, 'themeColors', r);
  return applyTheme(ctx, themeWith(await themeNow(ctx), { colors: r.colors }));
}

async function customizeFonts(ctx) {
  const r = await ctx.dialog('createNewThemeFonts', {
    fonts: (await themeNow(ctx)).fonts, names: customFonts(ctx).map((x) => x.name), asian: eastAsian(ctx.settings.word.proofing?.languages),
  });
  if (!r) return false;
  await saveNamed(ctx, 'themeFonts', r);
  const { name, ...fonts } = r;
  return applyTheme(ctx, themeWith(await themeNow(ctx), { fonts }));
}

async function saveStyleSet(ctx) {
  await loadSets();
  const name = await ctx.dialog('saveAsANewStyleSet', { names: savedSets.map((s) => s.name) });
  const attrs = name ? await docAttrs(ctx) : null;
  if (!attrs) return false;
  const next = [...savedSets.filter((s) => s.name !== name), savedSet(name, attrs.styles ?? {})];
  await store()?.set('styleSets', next);
  savedSets = next;
  // The Document now uses the saved set, as Word's gallery then shows it (a canvas draft's in this session: canvasSet).
  if (ctx.engine) canvasSet.set(ctx.engine, `custom:${name}`);
  else change(ctx, (tr, a) => tr.setDocAttribute('styles', { ...a.styles, styleSet: `custom:${name}` }));
  return true;
}

/** Opens a registered Word dialog `id` without waiting for it; an unregistered one toasts the pending reason. → whether it opened. */
async function openOther(ctx, id, props) {
  const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js');
  if (!WORD_DIALOGS[id]) {
    ctx.toast('Not built yet.');
    return false;
  }
  ctx.dialog(id, props);
  return true;
}

/** The styles of draft `id` (a Document) → its doc.attrs.styles or null. */
async function templateStyles(id) {
  try {
    const d = await window.api.drafts.load(id);
    return d?.format === 'document' ? (await docOfDraft(d))?.attrs?.styles ?? null : null; // a canvas draft's through the engine
  } catch {
    return null;
  }
}

/** Templates and Add-ins on a canvas draft: the engine keeps the attached template (a draft's id, as the DOM editor's
 * props.app.template) and Automatically update document styles (tools.templates); a linked template's styles go in at OK. */
async function canvasTemplate(ctx, documents) {
  const t = (await ctx.engine.exec('tools.templates', {}))?.value ?? {};
  const r = await ctx.dialog('templatesAndAddIns', { template: t.template ?? null, linkStyles: !!t.linkStyles, documents,
    organizer: () => ctx.run('styles.organizer') });
  if (!r) return false;
  const steps = [];
  if ((t.template ?? null) !== r.template) steps.push(r.template ? ['tools.attachTemplate', { path: r.template, linkStyles: r.linkStyles }] : ['tools.detachTemplate', {}]);
  else if (!!t.linkStyles !== r.linkStyles) steps.push(['tools.linkStyles', { value: r.linkStyles }]);
  const tpl = r.linkStyles && r.template ? await templateStyles(r.template) : null;
  const attrs = tpl && await docAttrs(ctx);
  const styles = attrs && withTemplate(attrs.styles, tpl, attrs.theme ?? THEME);
  if (styles) steps.push(...stylesSteps(attrs.styles, styles));
  return !steps.length || !!(await ctx.engine.execMany(steps))?.ok;
}

async function documentTemplate(ctx) {
  if (ctx.engine) {
    const here = getState().draft?.id;
    return canvasTemplate(ctx, getState().drafts.filter((d) => d.format === 'document' && d.id !== here).map(({ id, title }) => ({ id, title })));
  }
  const attrs = ctx.ed?.state.doc.attrs;
  if (!attrs) return false;
  const here = getState().draft?.id;
  const documents = getState().drafts.filter((d) => d.format === 'document' && d.id !== here).map(({ id, title }) => ({ id, title }));
  const r = await ctx.dialog('templatesAndAddIns', {
    template: attrs.props?.app?.template ?? null, linkStyles: !!attrs.settings?.linkStyles, documents,
    organizer: () => openOther(ctx, 'organizer'),
  });
  if (!r || !ctx.ed) return false;
  const tpl = r.linkStyles && r.template ? await templateStyles(r.template) : null;
  return change(ctx, (tr, a) => {
    if ((a.props?.app?.template ?? null) !== r.template) tr.setDocAttribute('props', deepPatch(a.props ?? {}, { app: { template: r.template } }));
    if (!!a.settings?.linkStyles !== r.linkStyles) tr.setDocAttribute('settings', deepPatch(a.settings ?? {}, { linkStyles: r.linkStyles }));
    const styles = tpl && withTemplate(tr.doc.attrs.styles, tpl, tr.doc.attrs.theme ?? THEME);
    if (styles) tr.setDocAttribute('styles', styles);
  });
}

const commands = {
  [`${ID}.themes`]: { ...onDoc, run: (ctx, id) => {
    const t = THEMES.find((x) => x.id === id);
    return !!t && applyTheme(ctx, themeWith(themeOf(ctx), { name: t.name, fonts: t.fonts, colors: t.colors, effects: t.effects }));
  } },
  [`${ID}.themes.resetToThemeFromTemplate`]: { ...onDoc, run: (ctx) => applyTheme(ctx, structuredClone(THEME)) },
  [`${ID}.themes.browseForThemes`]: { ...onDocOrCanvas, run: browseTheme },
  [`${ID}.themes.saveCurrentTheme`]: { ...onDocOrCanvas, run: saveTheme },
  [`${ID}.colors`]: { ...onDoc, run: (ctx, id) => {
    const set = byId(COLOR_SETS, id, customColors(ctx));
    return !!set && applyTheme(ctx, themeWith(themeOf(ctx), { colors: set.colors }));
  } },
  [`${ID}.colors.customizeColors`]: { ...onDocOrCanvas, run: customizeColors },
  [`${ID}.fonts`]: { ...onDoc, run: (ctx, id) => {
    const set = byId(FONT_SETS, id, customFonts(ctx));
    if (!set) return false;
    const fonts = { major: set.major, minor: set.minor, ...(set.majorEA !== undefined && { majorEA: set.majorEA, minorEA: set.minorEA }) };
    return applyTheme(ctx, themeWith(themeOf(ctx), { fonts }));
  } },
  [`${ID}.fonts.customizeFonts`]: { ...onDocOrCanvas, run: customizeFonts },
  [`${ID}.effects`]: { ...onDoc, run: (ctx, id) => {
    const e = EFFECTS.find((x) => x.id === id);
    return !!e && change(ctx, (tr, a) => tr.setDocAttribute('theme', themeWith(a.theme, { effects: e.name })));
  } },
  [`${ID}.documentFormatting`]: { ...onDocOrCanvas, run: (ctx, id) => (id === 'thisDocument' ? true : applySet(ctx, styleSetOf(id, savedSets))) },
  [`${ID}.documentFormatting.resetToTheDefaultStyleSet`]: { ...onDoc, run: (ctx) => applySet(ctx, STYLE_SETS[0]) },
  [`${ID}.documentFormatting.saveAsANewStyleSet`]: { ...onDocOrCanvas, run: saveStyleSet },
  [`${ID}.paragraphSpacing.default`]: {
    ...onDoc,
    run: (ctx) => change(ctx, (tr, a) => tr.setDocAttribute('styles', withSetSpacing(a.styles, savedSets))),
    active: (ctx) => spacingKey(stylesOf(ctx), savedSets) === 'default',
  },
  ...Object.fromEntries(Object.keys(SPACING).map((k) => [`${ID}.paragraphSpacing.${k}`, spacingItem(k)])),
  [`${ID}.paragraphSpacing.customParagraphSpacing`]: { ...onDoc, run: (ctx) => openOther(ctx, 'manageStyles', { tab: 'setDefaults' }) },
  [`${ID}.setAsDefault`]: { ...onDocOrCanvas, run: setAsDefault },
  'developer.templates.documentTemplate': { ...onDocOrCanvas, run: documentTemplate },
};

// ---------- Automatically update document styles ----------

// Template styles waiting for the user's first edit (plan.md §1.10: what changes on open is written inside the user's first
// transaction, never by an open-time rewrite): editor → the template's styles.
const pending = new WeakMap();

/** Copies a linked template's styles into the Document with the first user transaction after it opens (one undo step with it). */
const TemplateStyles = Extension.create({
  name: 'designTemplateStyles',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      appendTransaction(trs, _old, state) {
        const tpl = pending.get(editor);
        if (!tpl || !trs.some((tr) => tr.docChanged && tr.getMeta('addToHistory') !== false)) return null;
        pending.delete(editor);
        const styles = withTemplate(state.doc.attrs.styles, tpl, state.doc.attrs.theme ?? THEME);
        return styles ? state.tr.setDocAttribute('styles', styles) : null;
      },
    })];
  },
});

/** On a Document's open: reads the saved style sets, and the linked template's styles when it updates styles automatically. */
function setup(editor) {
  loadSets();
  const { settings, props } = editor.state.doc.attrs;
  const id = props?.app?.template;
  if (!settings?.linkStyles || !id) return;
  let live = true;
  templateStyles(id).then((tpl) => {
    if (live && tpl) pending.set(editor, tpl);
  });
  return () => {
    live = false;
    pending.delete(editor);
  };
}

export default {
  id: 'design',
  extensions: [TemplateStyles],
  commands,
  galleries,
  dialogs: { createNewThemeColors: CreateNewThemeColors, createNewThemeFonts: CreateNewThemeFonts, saveAsANewStyleSet: SaveAsANewStyleSet, templatesAndAddIns: TemplatesAndAddIns },
  // +Headings and +Body keep following the theme's fonts ('+major' and '+minor' through --doc-major and --doc-minor); Paragraph
  // Spacing is a menu of its own commands.
  implements: ['font.themeFonts', `${ID}.paragraphSpacing`],
  setup,
};
