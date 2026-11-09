// Tool search entries for Word's commands (docs/plans/word/plan.md §1.14): one entry per command id of the ribbon spec (controls,
// menu and derived items, backstage commands), the Word key rows that have no control, and the registered commands outside the
// ribbon. The entries are built once at load; their state (shown, placeholder reason, active) is read per query from the
// registry, so the hub's import order never matters. app/tools.js appends WORD_TOOLS after DOC_TOOLS and wraps the existing
// entries a Word command duplicates with cover(). Every entry is Document-only (format.document) and for people only
// (agent false, headless false): agents edit Documents through doc.*, so their tool.list keeps its size.
import { createElement as h } from 'react';
import { commandOf, ctxOf, galleryOf, listed, menuViewOf, panelOf, run } from '../../tooling/registry.js';
import { grants } from '../../tooling/profile.mjs';
import { REASONS } from '../../tooling/reasons.mjs';
import { WORD_KEYS } from '../word/keymap.mjs';
import { Spin } from '../../tooling/kit/controls.jsx';
import { inDocument } from '../tools.js';
import { iconOf, RibbonIcon } from './icons.jsx';
import * as SPEC from './spec.mjs';

const { AREAS, BACKSTAGE, CONTROLS, FEATURES, ITEMS, MENUS, TABS } = SPEC;
// The registry reads the spec's `needs` through window.__word.spec (registry.js run): the spec's owner sets it.
if (typeof window !== 'undefined') window.__word = Object.assign(window.__word ?? {}, { spec: SPEC });

const NEEDS = ['doc.open', 'view.editor', 'format.document'];
const NEVER = ['model3d']; // contexts that never hold: their tabs make no entries
const ON_CANVAS = ['shapeFormat', 'draw']; // tabs whose entries also show while a canvas of the Document is edited in place
const TOGGLES = ['toggle', 'splitToggle', 'checkbox'];
const VALUES = ['combo', 'spinner', 'list'];
// Controls with no action of their own: Enter on their entry opens the options, as Word's search opens their menu (§1.14).
// Their entry keeps its run for when the options draw nothing (no MenuView yet, or empty galleries).
const NO_ACTION = ['dropdown', 'gallery', ...VALUES];

const icon = (name) => h(RibbonIcon, { name, className: 'size-4 text-muted-foreground' });
const words = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9' -]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);

/** The chord's binding id for the command `cmd` with `arg` (keys.mjs WORD_DEFS, or the app binding a row reuses), or undefined.
 * A native row counts only when it reuses an app binding: the others have no binding id to show. */
function keyOf(cmd, arg) {
  const row = WORD_KEYS.find((r) => (r.kind === 'bind' || r.reuse) && r.cmd === cmd && (r.arg ?? null) === (arg ?? null));
  return row && (row.reuse ?? `word.${cmd}${arg != null ? `.${arg}` : ''}`);
}

/** Every control's tab and group, and every item's owning control (the first that reaches it through its menus, in tab order). */
const placeOf = new Map(); // control id → {tab, group}
const ownerOf = new Map(); // item id → control id
for (const tab of TABS) {
  for (const group of tab.groups) {
    const ids = [group.launcher, ...group.layout.flatMap((c) => [c.large, c.gallery, ...(c.rows ?? []).flat(2)])].filter(Boolean);
    for (const id of ids) if (!placeOf.has(id)) placeOf.set(id, { tab, group });
  }
}
const walk = (key, owner, seen = new Set()) => {
  if (seen.has(key)) return;
  seen.add(key);
  for (const e of MENUS[key] ?? []) {
    if (e.item && !ownerOf.has(e.item)) ownerOf.set(e.item, owner);
    if (e.sub) walk(e.sub, owner, seen);
  }
};
for (const id of placeOf.keys()) if (CONTROLS[id].menu) walk(CONTROLS[id].menu, id);
// Derived list items sit in no menu (their control's gallery shows them): the longest control id they start with owns them.
for (const id of Object.keys(ITEMS)) {
  if (ownerOf.has(id)) continue;
  const parts = id.split('.');
  for (let n = parts.length - 1; n > 1; n--) {
    const c = parts.slice(0, n).join('.');
    if (placeOf.has(c)) {
      ownerOf.set(id, c);
      break;
    }
  }
}

/** Whether the item `id` runs a registered command the spec does not mark as unbuilt. */
const itemBuilt = (id) => !!commandOf(ITEMS[id]?.cmd ?? id) && !ITEMS[id]?.needs;

/** Whether MenuView draws something that acts for menu `menu` in `ctx`: a registered panel, a gallery with items or a submenu
 * that acts. Built items count only in a menu with none of those (Margins, Orientation): beside empty galleries they are
 * secondary commands (Page Number's Remove), and the covered entry's own options do more. */
function draws(menu, ctx, seen = new Set()) {
  if (!ctx || seen.has(menu)) return false;
  seen.add(menu);
  const list = MENUS[menu] ?? [{ gallery: menu }];
  const blocks = list.filter((e) => e.panel || e.gallery || e.sub);
  if (!blocks.length) return list.some((e) => e.item && itemBuilt(e.item));
  return blocks.some((e) => (e.panel ? !!panelOf(e.panel) : e.gallery ? galleryOf(e.gallery, ctx).length > 0 : draws(e.sub, ctx, seen)));
}

/** The registry's options for the command `cmd`, else the ribbon's menu for `control` (its MenuView, registered by the
 * renderer), so Enter on Margins or Borders picks from the ribbon's own choices. A menu that would draw nothing (a gallery
 * no package fills yet) gives null, so a covered entry keeps its own options. → a render function. */
function optionsOf(cmd, control) {
  return () => {
    const ctx = ctxOf();
    const spec = commandOf(cmd);
    if (spec?.options) return spec.options(ctx);
    // A spin box has no menu: a number field in the control's unit, as on the ribbon.
    if (control.type === 'spinner') return spec?.value ? h(Spin, { value: spec.value(ctx), unit: control.unit ?? 'pt', onChange: (v) => run(cmd, v) }) : null;
    const MenuView = menuViewOf();
    const menu = control.menu ?? control.gallery ?? control.id;
    // spec and icons: the ribbon shares its own only once it is drawn. cmd: gallery and colour picks run the owning control's
    // command (Cell shading must not fall back to the font colour).
    return MenuView && draws(menu, ctx) ? h(MenuView, { spec: SPEC, icons: iconOf, menu, cmd, ctx }) : null;
  };
}
const hasOptions = (control) => !!control && (!!control.menu || !!control.gallery || VALUES.includes(control.type));

/** Why the command `cmd` cannot run now: the placeholder reason while it is unregistered or the spec says it `needs` one, else
 * its own reason while it is disabled. → text or null. */
export function reasonOf(cmd, needs) {
  if (needs) return REASONS[needs] ?? REASONS.pending;
  const spec = commandOf(cmd);
  if (!spec) return REASONS.pending;
  const ctx = ctxOf();
  return listed(() => (spec.enabled && spec.enabled(ctx) === false ? spec.reason?.(ctx) ?? null : null));
}

/** Whether a Word entry for `cmd` on `tab` shows in tool search context `c`: the profile grants it, its tab's context holds,
 * no board is searched (Shape Format and Draw excepted) and a disabled command has a reason to show. */
function shows(cmd, tab, c, placeholder) {
  if (c.board && !(tab && ON_CANVAS.includes(tab.id))) return false;
  const ctx = ctxOf();
  if (!ctx?.profile || !grants(ctx.profile, cmd)) return false;
  if (tab?.context && !ctx.in?.[tab.context]) return false;
  if (placeholder) return true;
  const spec = commandOf(cmd);
  // A listing's reads: the registry drops their engine ids from the state call once it closes.
  return listed(() => !spec?.enabled || spec.enabled(ctx) !== false || !!spec.reason?.(ctx));
}

/** One entry. `o`: {id, cmd, arg, label, wordLabel, group, tab, groupLabel, owner, iconName, tip, needs, toggle, options, optionsFirst}. The
 * label is the spec's: app/tools.js copies entries at load, before any package registers a CommandSpec label. An item's owner goes
 * in as one phrase with the item's label, so "Margins" finds Narrow Margins below the Margins entry itself. */
function entry(o) {
  const placeholder = () => !!o.needs || !commandOf(o.cmd);
  return {
    id: `w-${o.id}`,
    label: o.label,
    group: o.group,
    icon: icon(o.iconName),
    keywords: [...new Set([o.label, o.wordLabel, o.owner ? `${o.owner} ${o.label}` : o.groupLabel, o.tab?.label, ...words(o.tip)].filter(Boolean))],
    needs: NEEDS,
    also: (c) => shows(o.cmd, o.tab, c, placeholder()),
    run: () => run(o.cmd, o.arg),
    ...(o.optionsFirst && { optionsFirst: true }),
    ...(o.options && { options: (c) => (placeholder() ? null : o.options(c)) }),
    ...(o.toggle && { toggle: true, active: () => listed(() => !!commandOf(o.cmd)?.active?.(ctxOf())) }),
    key: keyOf(o.cmd, o.arg),
    notice: () => reasonOf(o.cmd, o.needs),
    headless: false,
    agent: false,
  };
}

// The existing entries a Word feature duplicates (§1.14 COVERED): in a Document they run the Word command, and the Word feature
// makes no entry of its own. [entry id, feature id, arg]. Left out on purpose: doc-paragraph-layout (indent and spacing fields;
// Word's Paragraph launcher opens the dialog, a different thing) and doc-cell-align-top/center/bottom (vertical only; Word's
// nine Alignment buttons also set the paragraph's alignment).
export const COVERED = [
  ['doc-font', 'home.font.font'], ['doc-size', 'home.font.fontSize'], ['doc-grow', 'home.font.growFont'], ['doc-shrink', 'home.font.shrinkFont'],
  ['doc-underline-style', 'home.font.underline'], ['doc-color', 'home.font.fontColor'], ['doc-highlight', 'home.font.textHighlightColor'],
  ['doc-numbering', 'home.paragraph.numbering'], ['doc-indent', 'home.paragraph.increaseIndent'], ['doc-outdent', 'home.paragraph.decreaseIndent'],
  ['doc-line-spacing', 'home.paragraph.lineAndParagraphSpacing'], ['doc-paste', 'home.clipboard.paste'], ['doc-cut', 'home.clipboard.cut'],
  ['doc-space-before', 'home.paragraph.lineAndParagraphSpacing.addSpaceBeforeParagraph'],
  ['doc-space-after', 'home.paragraph.lineAndParagraphSpacing.removeSpaceAfterParagraph'], ['doc-paste-text', 'home.clipboard.paste', 'keepTextOnly'],
  ['doc-copy', 'home.clipboard.copy'], ['doc-dictate', 'home.voice.dictate'], ['doc-word-count', 'review.proofing.wordCount'],
  ['doc-page-break', 'insert.pages.pageBreak'], ['doc-table', 'insert.tables.table'], ['doc-pictures', 'insert.illustrations.pictures'],
  ['doc-page-number', 'insert.headerFooter.pageNumber'], ['doc-alt-text', 'pictureFormat.accessibility.altText'],
  ['doc-row-above', 'tableLayout.rowsColumns.insertRowAbove'], ['doc-column-left', 'tableLayout.rowsColumns.insertColumnLeft'],
  ['doc-merge', 'tableLayout.merge.mergeCells'], ['doc-split', 'tableLayout.merge.splitCells'], ['doc-header-row', 'tableDesign.tableStyleOptions.headerRow'],
  ['doc-cell-shading', 'tableDesign.tableStyles.shading'], ['doc-margins', 'layout.pageSetup.margins'], ['doc-orientation', 'layout.pageSetup.orientation'],
  ['doc-paper-size', 'layout.pageSetup.size'], ['doc-page-setup', 'layout.pageSetup.launcher'], ['doc-nav-pane', 'view.show.navigationPane'],
  ['doc-zoom-100', 'view.zoom.zoom100'], ['doc-one-page', 'view.zoom.onePage'], ['doc-page-width', 'view.zoom.pageWidth'],
  // The shared entries that pass a Document's gates.
  ['find', 'home.editing.find'], ['replace', 'home.editing.replace'], ['undo', 'frame.qat.undo'], ['redo', 'frame.qat.redoRepeat'],
  ['clear', 'home.font.clearFormatting'], ['bold', 'home.font.bold'], ['italic', 'home.font.italic'], ['underline', 'home.font.underline'],
  ['strike', 'home.font.strikethrough'], ['sub', 'home.font.subscript'], ['sup', 'home.font.superscript'], ['alignLeft', 'home.paragraph.alignLeft'],
  ['alignCenter', 'home.paragraph.center'], ['alignRight', 'home.paragraph.alignRight'], ['justify', 'home.paragraph.justify'],
  ['bulletList', 'home.paragraph.bullets'], ['orderedList', 'home.paragraph.numbering'], ['link', 'insert.links.link'],
  ['canvas', 'x.insert.boards.canvas'], ['flowchart', 'x.insert.boards.flowchart'], ['plan-insert-chart', 'x.insert.boards.planChart'],
  ['save', 'file.save'], ['addRow', 'tableLayout.rowsColumns.insertRowBelow'], ['addColumn', 'tableLayout.rowsColumns.insertColumnRight'],
  ['deleteRow', 'tableLayout.rowsColumns.delete.deleteRows'], ['deleteColumn', 'tableLayout.rowsColumns.delete.deleteColumns'],
  ['deleteTable', 'tableLayout.rowsColumns.delete.deleteTable'], ['insert-reference', 'references.citationsBibliography.insertCitation'],
  ['references', 'references.citationsBibliography.manageSources'], ['insert-reference-list', 'references.citationsBibliography.bibliography'],
  ['reference-style', 'references.citationsBibliography.style'], ['suggestion-accept', 'review.tracking.accept'],
  ['suggestion-reject', 'review.tracking.reject'],
  // One entry per gallery style: the Styles gallery with the style id.
  ...['Normal', 'NoSpacing', 'Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6', 'Title', 'Subtitle', 'Quote', 'IntenseQuote',
    'ListParagraph'].map((s) => [`doc-style-${s}`, 'home.styles.styles', s]),
];
const coveredBy = new Map(COVERED.map(([entryId, fid, arg]) => [entryId, { fid, arg }]));
const covered = new Set(COVERED.map(([, fid, arg]) => fid + (arg !== undefined ? `#${arg}` : '')));

const built = (fid) => !!commandOf(fid) && !(CONTROLS[fid] ?? ITEMS[fid])?.needs;

/** The existing entry `t` as tool search runs it: in a Document a covered entry runs its Word command and offers that command's
 * options; elsewhere, and for every other entry, `t` unchanged. */
export function cover(t) {
  const c = coveredBy.get(t.id);
  if (!c) return t;
  const control = CONTROLS[c.fid];
  const wordOptions = control && hasOptions(control) && c.arg === undefined ? optionsOf(control.cmd ?? c.fid, control) : null;
  return {
    ...t,
    // The Word command runs once it is built; before that the entry keeps doing what it did on main. While a board is
    // searched (a canvas of the Document edited in place) the entry's own run acts on the board: Undo undoes the canvas edit.
    ...(t.run && { run: (ctx) => (inDocument() && !ctx?.board && built(c.fid) ? run(c.fid, c.arg) : t.run(ctx)) }),
    // Where the Word options draw nothing (no MenuView yet, or a gallery nobody fills) the entry keeps its own.
    ...(t.options && { options: (ctx) => (inDocument() && wordOptions?.(ctx)) || t.options(ctx) }),
  };
}

/** Builds WORD_TOOLS: the spec's controls (a control that repeats another adds none), items, backstage commands, key rows with
 * no control and the registered features outside the ribbon, one entry per command id. */
function build() {
  const out = [];
  const done = new Set(covered);
  const counts = new Map();
  const rows = [];
  const add = (o) => {
    if (done.has(o.cmd + (o.arg != null ? `#${o.arg}` : ''))) return;
    done.add(o.cmd + (o.arg != null ? `#${o.arg}` : ''));
    rows.push(o);
    counts.set(o.label, (counts.get(o.label) ?? 0) + 1);
  };
  for (const [id, place] of placeOf) {
    const c = CONTROLS[id];
    if (c.cmd || NEVER.includes(place.tab.context)) continue;
    add({ id, cmd: id, label: c.label, wordLabel: c.wordLabel, group: place.tab.label, tab: place.tab, groupLabel: place.group.label,
      iconName: c.icon, tip: c.tip, needs: c.needs, toggle: TOGGLES.includes(c.type), options: hasOptions(c) ? optionsOf(id, c) : null,
      optionsFirst: hasOptions(c) && NO_ACTION.includes(c.type) });
  }
  for (const [id, it] of Object.entries(ITEMS)) {
    const owner = CONTROLS[ownerOf.get(id)];
    const place = owner && placeOf.get(owner.id);
    if (!place || NEVER.includes(place.tab.context)) continue;
    add({ id, cmd: it.cmd ?? id, arg: it.arg, label: it.label, wordLabel: it.wordLabel, group: place.tab.label, tab: place.tab,
      groupLabel: owner.label, owner: owner.label, iconName: it.icon ?? owner.icon, needs: it.needs ?? owner.needs, toggle: !!it.check });
  }
  for (const b of BACKSTAGE) {
    if (b.kind === 'command' && b.id !== 'file.back') add({ id: b.id, cmd: b.id, label: b.label, group: 'File', groupLabel: 'File', iconName: 'FileText', needs: b.needs });
  }
  for (const r of WORD_KEYS) {
    if (r.kind !== 'bind' || CONTROLS[r.cmd] || ITEMS[r.cmd]) continue;
    const area = r.cmd.split('.')[0];
    add({ id: r.arg != null ? `${r.cmd}.${r.arg}` : r.cmd, cmd: r.cmd, arg: r.arg, label: r.label ?? FEATURES[r.cmd]?.label ?? r.cmd,
      group: AREAS[area] ?? 'Document', groupLabel: AREAS[area], iconName: 'Keyboard', needs: FEATURES[r.cmd]?.needs, registeredOnly: true });
  }
  for (const [id, f] of Object.entries(FEATURES)) {
    const tab = TABS.find((t) => t.id === f.area);
    add({ id, cmd: id, label: f.label, wordLabel: f.wordLabel, group: tab?.label ?? AREAS[f.area] ?? 'Document', tab, groupLabel: AREAS[f.area],
      iconName: 'SquareDot', needs: f.needs, registeredOnly: true });
  }
  for (const o of rows) {
    // A label that appears in several places gets its group in brackets: Update Table (Captions).
    if (counts.get(o.label) > 1 && o.groupLabel && o.groupLabel !== o.label) o.label = `${o.label} (${o.groupLabel})`;
    const e = entry(o);
    // Key rows and features outside the ribbon show only once a package registers them; they are never placeholders.
    out.push(o.registeredOnly ? { ...e, also: (c) => !!commandOf(o.cmd) && e.also(c) } : e);
  }
  return out;
}

export const WORD_TOOLS = build();
