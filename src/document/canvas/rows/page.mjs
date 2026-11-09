// The Page and Tables package's rows of the Documents engine table (docs/plans/engine/stage2.md): sections, page background,
// headers and footers, design, tables and the ruler (S3). Only that package edits this file. Rows by tooling id in the forms of
// forms.mjs (APP, exec, off, a CommandSpec); commands.mjs joins them. Pure: node tests load it (dialogs load when they open).
//
// State is read only through the engine's pure readers (each spec's `state`): the toggles (`layout.hyphenation`,
// `table.repeatHeader`, `layout.differentFirstPage`) change the document when run without a value, so a toggle row always
// passes the value it wants (stage2.md risks), read from the engine when it runs (toggle below). A gallery's parent given no
// valid pick (tool search, an agent's tool.run, a main click) runs nothing, as the DOM rows do.
import { UNITS, unitOf } from '../../../tooling/kit/units.mjs';
import { COLOR_SETS, EFFECTS, FONT_SETS, THEMES } from '../../wp/design/model.mjs';
import { WATERMARK_GALLERY } from '../../wp/page-background/model.mjs';
import { dialogFill, engineFill } from '../../wp/page-background/engine-fill.mjs';
import { MARGIN_PRESETS, PAPERS } from '../../wp/sections/model.mjs';
import { APP, exec, off } from './forms.mjs';
import { activeTool } from '../tools/state.mjs';

// ---------------------------------------------------------------------------------------------
// Helpers

/** The value of pure engine command `id`, or null (dialogs read with it when they open). */
async function query(ctx, id, args = {}) {
  const r = await Promise.resolve(ctx.engine?.query?.(id, args)).catch(() => null);
  return r?.ok ? r.value ?? null : null;
}

/** Runs engine command `id` → whether it ran. */
const run = async (ctx, id, args = {}) => !!(await Promise.resolve(ctx.engine.exec(id, args)).catch(() => null))?.ok;

/** Runs the steps [[id, args]] as one undo step → whether they ran. */
const runMany = async (ctx, steps) => !!(await Promise.resolve(ctx.engine.execMany(steps)).catch(() => null))?.ok;

/** A row that opens a dialog and acts on its result through the engine: `go(ctx, arg)` → true when it acted. */
const dialogRow = (go, more = {}) => ({ run: (ctx, arg) => (ctx.engine ? go(ctx, arg) : false), enabled: (ctx) => !!ctx.engine, ...more });

/** The snapshot entry of engine id `id` (null until a control has read it). */
const snap = (ctx, id) => ctx.engineState?.[id] ?? null;

/** "#RRGGBB" or "RRGGBB" → "RRGGBB"; null for none. */
const hex6 = (c) => (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c) ? c.replace('#', '').toUpperCase() : null);
const hash = (c) => (c ? `#${c}` : null);

/** A tenth of the unit lengths show in (0.1 cm or 0.1 inch), as the ribbon's spinner arrows step. */
const tenth = (ctx) => (UNITS[unitOf(ctx.settings, ctx.profile, globalThis.navigator?.language)] ?? UNITS.cm) / 10;

const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.5;
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

/** A spinner of the ribbon: `id` takes a value in points through `params(pt)`, its More and Less parts step by `step(ctx)` from
 * `get(entry)` within `min`. */
function spinner(id, engine, params, get, step, { state, min = 0, max = 1584 } = {}) {
  const key = state ?? engine;
  const clamp = (x) => Math.min(max, Math.max(min, x));
  const cur = (ctx) => get(snap(ctx, key)) ?? 0;
  return {
    [id]: exec(engine, (pt) => (num(pt) == null ? {} : params(clamp(num(pt)))), { state: key, value: (e) => get(e) }),
    [`${id}.more`]: exec(engine, (_a, ctx) => params(clamp(cur(ctx) + step(ctx))), { state: key }),
    [`${id}.less`]: exec(engine, (_a, ctx) => params(clamp(cur(ctx) - step(ctx))), { state: key }),
  };
}

/** The state entry of engine id `id` read now: the snapshot holds only the ids a drawn control has read, so a control on a tab
 * not drawn yet (tool search, an agent) has none there. */
async function stateNow(ctx, id) {
  const r = await Promise.resolve(ctx.engine?.state?.([id])).catch(() => null);
  return r?.[id] ?? null;
}

/** A toggle's params `params(value)`: a boolean argument is the value (an agent or tool search setting it), else the opposite
 * of `now(entry)`, its state entry read now; nothing runs when the state cannot be read. */
const toggle = (id, now, params) => async (a, ctx) => {
  if (typeof a === 'boolean') return params(a);
  const e = await stateNow(ctx, id);
  return e ? params(!now(e)) : null;
};

/** A paragraph toggle of the Layout tab written with para.set: `prop` read from the caret paragraph (layout.paragraph). */
const paraToggle = (prop) => exec('para.set', toggle('layout.paragraph', (e) => !!e.value?.[prop], (v) => ({ props: { [prop]: v } })), {
  state: 'layout.paragraph', active: (e) => !!e?.value?.[prop],
});

const inTable = (ctx) => (ctx.in?.table ? null : 'Put the cursor in a table first.');
/** In a table: page and column breaks and drop caps are off there with no reason, as the DOM editor's are. */
const tableHides = (ctx) => !!ctx.in?.table;
const inHeader = (ctx) => (ctx.story === 'header' || ctx.story === 'footer' ? null : 'Open a header or footer first.');

// ---------------------------------------------------------------------------------------------
// Sections: margins, orientation, size, breaks, text direction (Page Setup is the dialog's own engine branch)

const SIDES = ['top', 'bottom', 'left', 'right'];
const MARGIN_KEYS = Object.keys(MARGIN_PRESETS);
const marginParams = (m) => (m ? { top: m.top, bottom: m.bottom, left: m.left, right: m.right, mirror: !!m.mirror } : {});

/** The Margins menu's item the caret section's margins match (layout.margins' state), Last Custom Setting, or null. */
function marginKey(v, ctx) {
  if (!v) return null;
  const same = (m) => !!m.mirror === !!v.mirror && SIDES.every((k) => near(v[k], m[k]));
  const k = MARGIN_KEYS.find((x) => same(MARGIN_PRESETS[x]));
  if (k) return k;
  const last = ctx.settings?.word?.lastMargins;
  return last && same(last) ? 'lastCustomSetting' : null;
}

/** The Size menu's paper the section's page matches either way round, or null (a custom size). */
function paperKey(v) {
  if (!v) return null;
  return Object.keys(PAPERS).find((k) => {
    const [, w, h] = PAPERS[k];
    return (near(v.width, w) && near(v.height, h)) || (near(v.width, h) && near(v.height, w));
  }) ?? null;
}

const BREAKS = ['nextPage', 'continuous', 'evenPage', 'oddPage'];
const TEXT_DIRS = ['horizontal', 'down', 'up', 'rotate90', 'asian270'];
const inTextBox = (ctx) => !!ctx.in?.textbox || ctx.obj?.kind === 'textbox';
const cellOrBox = (ctx) => (ctx.in?.table || inTextBox(ctx) ? null : 'Put the cursor in a table cell or a text box first.');
const notInBox = (ctx) => (inTextBox(ctx) && !ctx.in?.table ? 'A text box cannot rotate East Asian characters.' : null);

/** Opens Page Setup on `tab` for a canvas draft: the dialog reads the section and writes it through the engine itself. */
const pageSetup = (tab) => dialogRow(async (ctx, arg) => {
  const index = typeof arg?.section === 'number' ? arg.section : undefined;
  const [sect, settings] = await Promise.all([query(ctx, 'layout.section', index == null ? {} : { index }), query(ctx, 'document.settings')]);
  if (!sect) return false;
  await ctx.dialog('pageSetup', { tab, engine: { sect, settings: settings ?? {} } });
  return true;
});

const SECTIONS = {
  'layout.pageSetup.margins': exec('layout.margins', (arg, ctx) => marginParams(arg === 'lastCustomSetting' ? ctx.settings?.word?.lastMargins : MARGIN_PRESETS[arg]), {
    value: (e, ctx) => marginKey(e?.value, ctx),
  }),
  ...Object.fromEntries(MARGIN_KEYS.map((k) => [`layout.pageSetup.margins.${k}`, exec('layout.margins', marginParams(MARGIN_PRESETS[k]), {
    active: (e, ctx) => marginKey(e?.value, ctx) === k,
  })])),
  'layout.pageSetup.margins.customMargins': pageSetup('margins'),
  'layout.pageSetup.orientation': exec('layout.orientation', (o) => (o === 'landscape' || o === 'portrait' ? { value: o } : null), {
    value: (e) => e?.value ?? null,
  }),
  ...Object.fromEntries(['portrait', 'landscape'].map((o) => [`layout.pageSetup.orientation.${o}`, exec('layout.orientation', { value: o }, {
    active: (e) => e?.value === o,
  })])),
  'layout.pageSetup.size': exec('layout.size', (k) => (PAPERS[k] ? { width: PAPERS[k][1], height: PAPERS[k][2] } : {}), { value: (e) => paperKey(e?.value) }),
  'layout.pageSetup.size.morePaperSizes': pageSetup('paper'),
  'layout.pageSetup.launcher': pageSetup('margins'),
  // The engine refuses a section break outside the main text, as the DOM's inBody does; a page break in a table splits it.
  'layout.pageSetup.breaks': exec('layout.break', (kind) => ({ kind })),
  ...Object.fromEntries(BREAKS.map((kind) => [`layout.pageSetup.breaks.${kind}`, exec('layout.break', { kind })])),
  'insert.pages.blankPage': 'insert.blankPage',
  'layout.pageSetup.textDirection': exec('layout.textDirection', (v) => (TEXT_DIRS.includes(v) ? { value: v } : null), { value: (e) => e?.value ?? null }),
  'layout.pageSetup.textDirection.horizontal': exec('layout.textDirection', { value: 'horizontal' }, { active: (e) => e?.value === 'horizontal' }),
  'layout.pageSetup.textDirection.vertical': exec('layout.textDirection', { value: 'down' }, { active: (e) => e?.value === 'down' }),
  'layout.pageSetup.textDirection.rotateAllText90': exec('layout.textDirection', { value: 'rotate90' }, { when: cellOrBox, active: (e) => e?.value === 'rotate90' }),
  'layout.pageSetup.textDirection.rotateAllText270': exec('layout.textDirection', { value: 'up' }, { when: cellOrBox, active: (e) => e?.value === 'up' }),
  'layout.pageSetup.textDirection.rotateAsianCharacters270': exec('layout.textDirection', { value: 'asian270' }, { when: notInBox, active: (e) => e?.value === 'asian270' }),
  'layout.pageSetup.textDirection.textDirectionOptions': dialogRow(async (ctx) => {
    const target = ctx.in?.table ? 'cell' : inTextBox(ctx) ? 'textbox' : 'section';
    await ctx.dialog('textDirection', { engine: { value: ctx.stateOf?.('layout.textDirection')?.value ?? 'horizontal', target } });
    return true;
  }, { reads: ['layout.textDirection'] }),
};

// ---------------------------------------------------------------------------------------------
// Columns

const COLUMNS = { one: { count: 1 }, two: { count: 2 }, three: { count: 3 }, left: { count: 2, preset: 'left' }, right: { count: 2, preset: 'right' } };
// More Columns' Apply to (columns/model.mjs applyToOptions) → layout.columns' `apply`.
const COLUMN_SCOPES = { selected: 'selection', sections: 'section', section: 'section', forward: 'forward', whole: 'document' };

const COLUMN_ROWS = {
  'layout.pageSetup.columns': exec('layout.columns', (id) => COLUMNS[id] ?? null, { value: (e) => e?.value?.preset ?? null }),
  ...Object.fromEntries(Object.entries(COLUMNS).map(([k, params]) => [`layout.pageSetup.columns.${k}`, exec('layout.columns', params, {
    active: (e) => e?.value?.preset === k,
  })])),
  'layout.pageSetup.columns.moreColumns': dialogRow(async (ctx) => {
    const sect = await query(ctx, 'layout.section');
    if (!sect) return false;
    const text = sect.pageW - sect.marginLeft - sect.marginRight - (sect.gutter ?? 0);
    const c = sect.columns ?? { count: 1, space: 36, separator: false, widths: [] };
    const equal = !c.widths?.length;
    const value = { count: c.count, sep: !!c.separator, equal,
      cols: equal ? Array.from({ length: c.count }, (_, i) => ({ w: (text - (c.count - 1) * c.space) / c.count, space: i < c.count - 1 ? c.space : 0 }))
        : c.widths.map(([w, space]) => ({ w, space })) };
    const applyTo = [['section', 'This section'], ['forward', 'This point forward'], ['whole', 'Whole document']];
    const out = await ctx.dialog('columns', { value, text, applyTo });
    if (!out) return false;
    const a = out.attrs;
    const params = !a ? { count: 1 } : { count: a.count, space: a.space, separator: !!a.sep, ...(a.equal ? {} : { widths: a.widths.map((w) => [w.w, w.space]) }) };
    return run(ctx, 'layout.columns', { ...params, apply: COLUMN_SCOPES[out.scope] ?? 'section' });
  }),
  // In a table Ctrl+Shift+Enter is Split Table's (tables.splitTableKey): this one declines there, so the key falls through.
  // In a table Ctrl+Shift+Enter is table-tools' split (its key row wins there).
  'layout.pageSetup.breaks.column': exec('layout.break', { kind: 'column' }, { hide: tableHides }),
};

// ---------------------------------------------------------------------------------------------
// Page background

const WATERMARKS = WATERMARK_GALLERY.flatMap(([, items]) => items);
const GALLERY_GREY = 'C0C0C0';
const watermarkKey = (w) => (w ? WATERMARKS.find(([, text, layout]) => text === w.text && (layout === 'diagonal') === !!w.diagonal)?.[0] ?? null : null);
const RULE_KINDS = ['narrowRuled', 'collegeRuled', 'standardRuled', 'wideRuled', 'smallGrid', 'mediumGrid', 'largeGrid', 'veryLargeGrid'];

// The colours panel passes {color, themeColor} ({color: null} is No Color); no pick runs nothing.
const pageColor = exec('design.pageColor', (pick) => (pick === undefined ? null : { color: hex6(pick && typeof pick === 'object' ? pick.color : pick) }), {
  value: (e) => hash(e?.value),
});
const pageMoreColors = dialogRow(async (ctx) => {
  const hex = await ctx.dialog('colors', { value: hash((await stateNow(ctx, 'design.pageColor'))?.value) ?? '#FFFFFF' });
  return hex ? run(ctx, 'design.pageColor', { color: hex6(hex) }) : false;
});

// engine-gaps-shapes (G30): Fill Effects for the page, the dialog in value mode on the page's fill (design.pageFillInfo), its
// pick written with design.pageFill (a gradient or pattern, or a picture stretched or a texture tiled).
const pageFillEffects = dialogRow(async (ctx) => {
  const v = await ctx.dialog('fillEffects', { mode: 'value', value: dialogFill(await query(ctx, 'design.pageFillInfo')), page: true });
  const params = v ? await engineFill(v) : null;
  return !!params && run(ctx, 'design.pageFill', params);
});

const BACKGROUND = {
  'design.pageBackground.watermark': exec('design.watermark', (id) => {
    const hit = WATERMARKS.find(([i]) => i === id);
    return hit ? { text: hit[1], diagonal: hit[2] === 'diagonal', color: GALLERY_GREY, semitransparent: true } : null;
  }, { value: (e) => watermarkKey(e?.value) }),
  // Printed Watermark on the engine's watermark (gap G44): text, font, size, colour, semitransparent, layout and language, or a
  // picture with its scale and washout (engine-gaps-rest). The engine keeps one for the document, so the dialog writes it for
  // every section. A picture picked now is a data URL; the one the engine holds is sent as no data.
  'design.pageBackground.watermark.customWatermark': dialogRow(async (ctx) => {
    const now = (await stateNow(ctx, 'design.watermark'))?.value ?? null;
    const picture = (wm) => ({ ...(String(wm.src ?? '').startsWith('data:') && { data: wm.src.slice(wm.src.indexOf(',') + 1) }), scale: wm.scale ?? null,
      washout: !!wm.washout });
    const write = (wm) => run(ctx, 'design.watermark', !wm ? { remove: true } : wm.kind === 'picture' ? { picture: picture(wm) }
      : { text: wm.text, font: wm.font, size: wm.size ?? null, color: hex6(wm.color) ?? 'C0C0C0', semitransparent: !!wm.semi, diagonal: wm.layout !== 'horizontal',
        lang: wm.lang ?? null });
    await ctx.dialog('printedWatermark', { engine: { now, write } });
    return true;
  }),
  'design.pageBackground.watermark.removeWatermark': exec('design.watermark', { remove: true }, {
    state: 'design.watermark', when: (ctx) => (snap(ctx, 'design.watermark') && !snap(ctx, 'design.watermark').value ? 'This document has no watermark.' : null),
  }),
  'design.pageBackground.pageColor': pageColor,
  'design.pageBackground.pageColor.moreColors': pageMoreColors,
  'design.pageBackground.pageColor.fillEffects': pageFillEffects,
  // Borders and Shading is Home's dialog; its Page Border tab flips here once it reads the engine (stage2.md cross-package rows).
  // Borders and Shading's Page Border tab, which reads and writes design.pageBorders (rows/home.mjs, engine-gaps-styles).
  'design.pageBackground.pageBorders': { run: (ctx) => ctx.run('home.paragraph.borders.bordersAndShading', { tab: 'pageBorder' }) },
  // Draw > Format Background's lines (gap G13): a kind checked while it is the page's; Apply to Full Page waits for one with None.
  ...Object.fromEntries(['none', ...RULE_KINDS].map((k) => [`draw.edit.formatBackground.${k}`, exec('design.formatBackground', { kind: k }, {
    active: (e) => (e?.value?.kind ?? 'none') === k,
  })])),
  'draw.edit.formatBackground.applyToFullPage': exec('design.formatBackground', toggle('design.formatBackground', (e) => !!e.value?.full, (full) => ({ full })), {
    active: (e) => !!e?.value?.full,
  }),
  'draw.edit.formatBackground.pageColor': pageColor,
  'draw.edit.formatBackground.pageColor.moreColors': pageMoreColors,
  'draw.edit.formatBackground.pageColor.fillEffects': pageFillEffects,
};

// ---------------------------------------------------------------------------------------------
// Line numbers, hyphenation, drop caps

const LINE_NUMBERS = { none: 'none', continuous: 'continuous', restartEachPage: 'restartPage', restartEachSection: 'restartSection' };
const lnKey = (v) => Object.keys(LINE_NUMBERS).find((k) => LINE_NUMBERS[k] === v) ?? null;
// The Line Numbers dialog's restart (layout-misc/logic.mjs) ↔ layout.lineNumbers' value.
const LN_RESTART = { newPage: 'restartPage', newSection: 'restartSection', continuous: 'continuous' };
const DROP = { none: 'none', dropped: 'dropped', inMargin: 'margin' };
const dropKey = (p) => (!p ? null : !p.dropCap ? 'none' : p.dropCapMargin ? 'inMargin' : 'dropped');

/** Manual hyphenation on a canvas draft: each word the engine finds at a line end is offered in the prompt; Yes puts an optional
 * hyphen at the chosen break, No goes on, Cancel stops. The engine finds every next word from its own layout, so an answer moves
 * the words after it (the DOM's ponytail found them once). */
async function manualHyphenation(ctx) {
  let from;
  for (let n = 0; n < 2000; n++) {
    const f = await query(ctx, 'layout.manualHyphenation', from ? { from } : {});
    if (!f || f.done) return true;
    const k = await ctx.dialog('manualHyphenation', { word: f.word, breaks: f.points ?? [], at: f.suggest });
    if (k == null) return true;
    const at = { ...f.pos, off: f.pos.off + (typeof k === 'number' ? k : f.word.length) };
    if (typeof k === 'number') await runMany(ctx, [['caret.set', { pos: at }], ['text.optionalHyphen']]);
    from = { ...f.pos, off: f.pos.off + f.word.length + (typeof k === 'number' ? 1 : 0) };
  }
  return true;
}

const LAYOUT_MISC = {
  'layout.pageSetup.lineNumbers': exec('layout.lineNumbers', (k) => (LINE_NUMBERS[k] ? { value: LINE_NUMBERS[k] } : null), { value: (e) => lnKey(e?.value) }),
  ...Object.fromEntries(Object.entries(LINE_NUMBERS).map(([k, v]) => [`layout.pageSetup.lineNumbers.${k}`, exec('layout.lineNumbers', { value: v }, {
    active: (e) => e?.value === v,
  })])),
  'layout.pageSetup.lineNumbers.suppressForCurrentParagraph': paraToggle('suppressLineNumbers'),
  'paragraph.suppressLineNumbers': paraToggle('suppressLineNumbers'),
  'layout.pageSetup.lineNumbers.lineNumberingOptions': dialogRow(async (ctx) => {
    const sect = await query(ctx, 'layout.section');
    if (!sect) return false;
    const ln = sect.lineNumbers;
    const restart = Object.keys(LN_RESTART).find((k) => LN_RESTART[k] === { page: 'restartPage', section: 'restartSection', continuous: 'continuous' }[ln?.restart]);
    const v = await ctx.dialog('lineNumbers', { value: { on: !!ln, start: ln?.start ?? 1, countBy: ln?.countBy ?? 1, distance: ln?.distance ?? 0, restart: restart ?? 'newPage' } });
    if (!v) return false;
    return run(ctx, 'layout.lineNumbers', v.on ? { value: LN_RESTART[v.restart] ?? 'restartPage', start: v.start, countBy: v.countBy, distance: v.distance || 0 } : { value: 'none' });
  }),
  'layout.pageSetup.hyphenation': exec('layout.hyphenation', (k) => (k === 'automatic' || k === 'none' ? { value: k === 'automatic' } : null), {
    value: (e) => (e ? (e.checked ? 'automatic' : 'none') : null),
  }),
  'layout.pageSetup.hyphenation.none': exec('layout.hyphenation', { value: false }, { active: (e) => !!e && !e.checked }),
  'layout.pageSetup.hyphenation.automatic': exec('layout.hyphenation', { value: true }, { active: (e) => !!e?.checked }),
  'layout.pageSetup.hyphenation.manual': dialogRow(manualHyphenation),
  'layout.pageSetup.hyphenation.hyphenationOptions': dialogRow(async (ctx) => {
    const st = await query(ctx, 'document.settings');
    if (!st) return false;
    const v = await ctx.dialog('hyphenation', { value: { auto: !!st.autoHyphenation, caps: !!st.hyphenateCaps, limit: st.consecutiveHyphenLimit ?? 0, zone: st.hyphenationZone ?? 18 } });
    if (!v) return false;
    const done = await run(ctx, 'layout.hyphenation', { value: !!v.auto, caps: !!v.caps, limit: v.limit ?? 0 });
    if (v.manual) await manualHyphenation(ctx);
    return done;
  }),
  'paragraph.dontHyphenate': paraToggle('suppressHyphens'),
  'chars.optionalHyphen': 'text.optionalHyphen',
  // The caret paragraph's drop cap (layout.paragraph); the engine refuses one where it cannot go (its drop_cap_off).
  'insert.text.dropCap': exec('insert.dropCap', (k) => (DROP[k] ? { position: DROP[k] } : null), {
    state: 'layout.paragraph', value: (e) => dropKey(e?.value), hide: tableHides,
  }),
  ...Object.fromEntries(Object.entries(DROP).map(([k, position]) => [`insert.text.dropCap.${k}`, exec('insert.dropCap', { position }, {
    state: 'layout.paragraph', active: (e) => dropKey(e?.value) === k, hide: tableHides,
  })])),
  'insert.text.dropCap.dropCapOptions': dialogRow(async (ctx) => {
    const p = await query(ctx, 'layout.paragraph');
    const v = await ctx.dialog('dropCap', { value: { position: !p?.dropCap ? 'none' : p.dropCapMargin ? 'margin' : 'drop', font: p?.dropCapFont ?? '',
      lines: p?.dropCap || 3, distance: p?.dropCapDistance ?? 0 } });
    if (!v) return false;
    const position = { none: 'none', drop: 'dropped', margin: 'margin' }[v.position] ?? 'none';
    return run(ctx, 'insert.dropCap', position === 'none' ? { position } : { position, lines: v.lines, distance: v.distance, ...(v.font ? { font: v.font } : {}) });
  }, { enabled: (ctx) => !!ctx.engine && !tableHides(ctx) }),
};

// ---------------------------------------------------------------------------------------------
// Headers, footers and page numbers

// The Header and Footer galleries (headers-footers/model.mjs HF_GALLERY) → the engine's presets, the same designs.
const HF_PRESETS = { blank: 'blank', blankThreeColumns: 'blankThree', titleRule: 'titleRule', titleNumber: 'titleNumber' };
const NUMBER_ALIGNS = ['left', 'center', 'right'];

/** A page number at the top or bottom from the gallery's id (left, center, right, pageXofY). */
const numberAt = (position) => exec('insert.pageNumber', (id) => (id === 'pageXofY' ? { position, align: 'center', format: 'x of y' }
  : { position, align: NUMBER_ALIGNS.includes(id) ? id : 'center' }));

/** {at, align, start} (base's Page Number panel, the agents' helper): the number and its start as one undo step; null removes them. */
const pageNumber = dialogRow(async (ctx, arg) => {
  if (arg === null) return run(ctx, 'hf.removePageNumbers');
  if (!arg || typeof arg !== 'object') return false;
  const steps = [['insert.pageNumber', { position: arg.at === 'top' ? 'top' : 'bottom', align: NUMBER_ALIGNS.includes(arg.align) ? arg.align : 'center' }]];
  if (num(arg.start) != null) steps.push(['layout.pageNumberFormat', { start: num(arg.start) }]);
  return runMany(ctx, steps);
});

/** x.reveal.header and x.reveal.footer {section, part}: the caret into that section's header or footer (its first page's). */
const reveal = (kind) => dialogRow(async (ctx, arg) => {
  const sect = await query(ctx, 'layout.section', typeof arg?.section === 'number' ? { index: arg.section } : {});
  const set = sect?.[kind === 'header' ? 'headers' : 'footers'];
  const id = set?.[arg?.part ?? 'default'] ?? set?.default;
  if (id == null) return run(ctx, kind === 'header' ? 'insert.editHeader' : 'insert.editFooter');
  return run(ctx, 'caret.set', { pos: { story: { part: id }, path: [0], off: 0 } });
});

const HEADERS_FOOTERS = {
  'insert.headerFooter.header': exec('insert.header', (id) => ({ preset: HF_PRESETS[id] ?? 'blank' })),
  'insert.headerFooter.footer': exec('insert.footer', (id) => ({ preset: HF_PRESETS[id] ?? 'blank' })),
  'insert.headerFooter.header.editHeader': 'insert.editHeader',
  'insert.headerFooter.footer.editFooter': 'insert.editFooter',
  'insert.headerFooter.header.removeHeader': 'insert.removeHeader',
  'insert.headerFooter.footer.removeFooter': 'insert.removeFooter',
  'insert.headerFooter.pageNumber': pageNumber,
  'x.headersFooters.pageNumber': pageNumber,
  'insert.headerFooter.pageNumber.topOfPage': numberAt('top'),
  'insert.headerFooter.pageNumber.bottomOfPage': numberAt('bottom'),
  // Page Margins' Number in the left or right margin (headers-footers/model.mjs MARGIN_GALLERY); no pick runs nothing.
  'insert.headerFooter.pageNumber.pageMargins': exec('insert.pageNumber', (id) => (id === 'left' || id === 'right' ? { position: 'margin', align: id } : null)),
  'insert.headerFooter.pageNumber.currentPosition': exec('insert.pageNumber', (id) => ({ position: 'current', ...(id === 'pageXofY' ? { format: 'x of y' } : {}) })),
  'insert.headerFooter.pageNumber.formatPageNumbers': dialogRow(async (ctx) => {
    const sect = await query(ctx, 'layout.section');
    if (!sect) return false;
    const r = await ctx.dialog('pageNumberFormat', { value: { fmt: sect.pageNumFormat ?? 'decimal', start: sect.pageNumStart ?? null } });
    if (!r) return false;
    // Chapter numbers and the dash format wait (gap G15); the format and start apply.
    const format = ['decimal', 'lowerRoman', 'upperRoman', 'lowerLetter', 'upperLetter'].includes(r.fmt) ? r.fmt : 'decimal';
    return run(ctx, 'layout.pageNumberFormat', { format, start: r.start ?? null });
  }),
  'insert.headerFooter.pageNumber.removePageNumbers': 'hf.removePageNumbers',
  'headerFooter.navigation.goToHeader': exec('insert.editHeader', {}, { when: (ctx) => (ctx.story === 'footer' ? null : 'Open a footer first.') }),
  'headerFooter.navigation.goToFooter': exec('insert.editFooter', {}, { when: (ctx) => (ctx.story === 'header' ? null : 'Open a header first.') }),
  'headerFooter.navigation.previous': 'hf.previous',
  'headerFooter.navigation.next': 'hf.next',
  // Pressed while the section the part was opened from shows the previous section's; off in the first section (engine `when`).
  'headerFooter.navigation.linkToPrevious': exec('layout.linkToPrevious', {}, { when: inHeader, active: (e) => !!e?.checked }),
  'headerFooter.options.differentFirstPage': exec('layout.differentFirstPage', toggle('layout.differentFirstPage', (e) => !!e.checked, (value) => ({ value }))),
  'headerFooter.options.differentOddEvenPages': exec('layout.differentOddEven', toggle('layout.differentOddEven', (e) => !!e.checked, (value) => ({ value }))),
  'headerFooter.options.showDocumentText': exec('hf.showDocumentText', toggle('hf.showDocumentText', (e) => !!e.checked, (value) => ({ value })), {
    when: inHeader, active: (e) => !!e?.checked,
  }),
  ...spinner('headerFooter.position.headerPositionFromTop', 'hf.position', (pt) => ({ header: pt }), (e) => e?.value?.header ?? null, tenth, { max: 300 }),
  ...spinner('headerFooter.position.footerPositionFromBottom', 'hf.position', (pt) => ({ footer: pt }), (e) => e?.value?.footer ?? null, tenth, { max: 300 }),
  'headerFooter.close.closeHeaderAndFooter': { run: (ctx) => runMany(ctx, [['insert.removeEmptyHeaders'], ['insert.closeHeader']]), enabled: (ctx) => !inHeader(ctx), reason: inHeader },
  // Alt+Shift+R: off with no reason outside a header or footer, as the DOM editor's key is (tool search hides it there).
  'headersFooters.copyPrevious': {
    run: (ctx) => run(ctx, 'hf.copyPrevious'),
    enabled: (ctx) => !inHeader(ctx) && ctx.stateOf?.('hf.copyPrevious')?.enabled !== false,
    reads: ['hf.copyPrevious'],
  },
  'x.reveal.header': reveal('header'),
  'x.reveal.footer': reveal('footer'),
};

// ---------------------------------------------------------------------------------------------
// Design

// The theme's twelve colour slots in the engine's order (Settings.themeColors, theme1.xml's clrScheme).
const SLOTS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
const colorsOf = (colors) => SLOTS.map((k) => hex6(colors[k]) ?? '000000');
/** The app's theme `t` ({name, fonts, colors}) as an explicit engine theme (gap G8: the engine's own six stay its). */
const themeParams = (t) => (t ? { name: t.name, colors: colorsOf(t.colors), major: t.fonts.major, minor: t.fonts.minor } : {});
// Effects add " (name)" to the engine's theme name (design.effects), so the theme is the part before it.
const themeKey = (name) => THEMES.find((t) => t.name === String(name ?? '').split(' (')[0])?.id ?? null;
const SPACINGS = ['noParagraphSpace', 'compact', 'tight', 'open', 'relaxed', 'double'];
/** The built-in sets `list` with the user's own `custom` ones (settings.word.themeColors or themeFonts, by name) as the galleries
 * list them: id 'custom:<name>'. */
const setsWith = (list, custom) => [...list, ...(custom ?? []).map((x) => ({ ...x, id: `custom:${x.name}` }))];
const setOf = (list, id, custom) => setsWith(list, custom).find((x) => x.id === id) ?? null;
const spacingValue = (k) => (k === 'noParagraphSpace' ? 'none' : k);

const DESIGN_ROWS = {
  'design.documentFormatting.themes': exec('design.theme', (id) => themeParams(THEMES.find((t) => t.id === id)), { value: (e) => themeKey(e?.value) }),
  'design.documentFormatting.themes.resetToThemeFromTemplate': exec('design.theme', themeParams(THEMES[0])),
  // Browse for Themes, Save Current Theme, Customize Colors and Fonts, the app's style sets and Templates and Add-ins read and write
  // the engine in design/index.js (engine-gaps-styles, G8).
  'design.documentFormatting.themes.browseForThemes': APP,
  'design.documentFormatting.themes.saveCurrentTheme': APP,
  'design.documentFormatting.colors': exec('design.themeColors', (id, ctx) => {
    const set = setOf(COLOR_SETS, id, ctx?.settings?.word?.themeColors);
    return set ? { colors: colorsOf(set.colors) } : {};
  }, { value: (e, ctx) => setsWith(COLOR_SETS, ctx?.settings?.word?.themeColors).find((x) => colorsOf(x.colors).join() === (e?.value ?? []).join())?.id ?? null }),
  'design.documentFormatting.colors.customizeColors': APP,
  'design.documentFormatting.fonts': exec('design.themeFonts', (id, ctx) => {
    const set = setOf(FONT_SETS, id, ctx?.settings?.word?.themeFonts);
    return set ? { heading: set.major, body: set.minor } : {};
  }, { value: (e, ctx) => setsWith(FONT_SETS, ctx?.settings?.word?.themeFonts).find((x) => x.major === e?.value?.heading && x.minor === e?.value?.body)?.id
    ?? null }),
  'design.documentFormatting.fonts.customizeFonts': APP,
  'design.documentFormatting.effects': exec('design.effects', (id) => ({ name: EFFECTS.find((x) => x.id === id)?.name ?? 'Plain' })),
  'design.documentFormatting.documentFormatting': APP,
  'design.documentFormatting.documentFormatting.resetToTheDefaultStyleSet': exec('design.styleSet', { name: 'default' }),
  // The DOM editor's commands read a canvas draft's styles and theme from the .docx the engine writes (design/index.js docAttrs).
  'design.documentFormatting.documentFormatting.saveAsANewStyleSet': APP,
  'design.documentFormatting.paragraphSpacing.default': exec('design.paragraphSpacing', { value: 'default' }, { active: (e) => e?.value === 'default' }),
  ...Object.fromEntries(SPACINGS.map((k) => [`design.documentFormatting.paragraphSpacing.${k}`, exec('design.paragraphSpacing', { value: spacingValue(k) }, {
    active: (e) => e?.value === spacingValue(k),
  })])),
  // Manage Styles' Set Defaults tab, which reads and writes the engine (rows/home.mjs styles.manage).
  'design.documentFormatting.paragraphSpacing.customParagraphSpacing': { run: (ctx) => ctx.run('styles.manage', 'setDefaults') },
  'design.documentFormatting.setAsDefault': APP,
  'developer.templates.documentTemplate': APP,
};

// ---------------------------------------------------------------------------------------------
// The ruler: the app draws it and keeps its setting.

const RULER = {
  'view.show.ruler': APP,
  'ruler.keyboardRuler': APP,
};

// ---------------------------------------------------------------------------------------------
// Tables

const LOOK = ['headerRow', 'totalRow', 'bandedRows', 'firstColumn', 'lastColumn', 'bandedColumns'];
const MOVES = { 'tables.cellNavigation': 'rowStart', 'tables.endOfRow': 'rowEnd', 'tables.startOfColumn': 'columnTop', 'tables.endOfColumn': 'columnBottom' };
/** Draw Table, Eraser and Border Painter: the page tools that follow the store's word.tableTool, as the DOM editor's do
 * (tools/tables.js); `arg.pen` is a Table Design pen pick that arms the painter. */
const tableTool = (name) => ({
  run: async (_ctx, arg) => (await import('../tools/tables.js')).tableTool(name, arg),
  enabled: (ctx) => !!ctx.engine,
  active: () => activeTool() === `table:${name}`,
});
// Convert Text to Table's separators (table-tools) and Convert Table to Text's (table-layout) → the engine's.
const TEXT_SEPS = { paragraphs: 'paragraph', tabs: 'tab', commas: 'comma', other: 'other' };
const tableSep = (sep) => (sep === 'para' ? { separator: 'paragraph' } : sep === '\t' ? { separator: 'tab' } : sep === ',' ? { separator: 'comma' }
  : { separator: 'other', char: String(sep ?? '-').slice(0, 1) || '-' });
// Table Layout > Text Direction's value as the DOM names it.
const DIRS = { horizontal: 'lrTb', down: 'tbRlV', rotate90: 'tbRl', up: 'btLr', asian270: 'lrTbV' };
const CELL_ALIGNS = ['Top', 'Center', 'Bottom'].flatMap((v) => ['Left', 'Center', 'Right'].map((h) => [
  v === 'Center' && h === 'Center' ? 'alignCenter' : `align${v}${h}`, v === 'Center' && h === 'Center' ? 'center' : `${v.toLowerCase()}${h}`]));
/** Insert Cells' and Delete Cells' choices that shift cells (gap G54) → the engine's params. */
const INSERT_SHIFT = { right: 'right', down: 'down' };
const DELETE_SHIFT = { left: 'left', up: 'up' };

// Shading's split button applies its last pick, as on the DOM path.
let lastShading = null;

/** Insert or Delete Cells with a shift: the engine refuses one in a table with merged cells or while Track Changes is on, and
 * that reason shows as a toast. */
async function shiftCells(ctx, id, shift) {
  const r = await Promise.resolve(ctx.engine.exec(id, { shift })).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
  if (!r?.ok) ctx.toast(`Cells did not shift: ${String(r?.error ?? 'the engine refused it').replace(/^[^:]*: /, '')}.`);
  return !!r?.ok;
}

/** Table Properties on a canvas draft (gap G31): the dialog's value from the engine's table.get, its result as one undo step of
 * table.properties, table.columnWidth and table.cellMargins calls (the steps the engine has). */
async function tableProperties(ctx, tab) {
  const t = await query(ctx, 'table.get');
  if (!t) return false;
  const { tablePropsValue, tablePropsSteps } = await import('../../wp/table-layout/canvas.mjs');
  const sect = await query(ctx, 'layout.section');
  const was = tablePropsValue(t, sect);
  const out = await ctx.dialog('tableProperties', { value: was, tab: typeof tab === 'string' ? tab : 'table', borders: false, engine: true });
  if (!out) return false;
  const steps = tablePropsSteps(out, was);
  return steps.length ? runMany(ctx, steps) : true;
}

const insertTable = dialogRow(async (ctx) => {
  const r = await ctx.dialog('insertTable', { initial: ctx.settings?.word?.insertTable ?? null });
  if (!r) return false;
  import('../../word/settings.mjs').then(({ saveWord }) => saveWord({ insertTable: r.remember ? { cols: r.cols, rows: r.rows, autofit: r.fit } : null })).catch(() => {});
  const steps = [['insert.table', { rows: r.rows, cols: r.cols }]];
  if (r.fit?.kind === 'contents' || r.fit?.kind === 'window') steps.push(['table.autofit', { mode: r.fit.kind }]);
  else if (r.fit?.width) steps.push(['table.selectRow'], ['table.columnWidth', { width: r.fit.width }]);
  return runMany(ctx, steps);
});

const TABLES = {
  'insert.tables.table': exec('insert.table', (a) => ({ rows: a?.rows, cols: a?.cols })),
  'insert.tables.table.insertTable': insertTable,
  'insert.tables.table.convertTextToTable': dialogRow(async (ctx) => {
    const sel = await query(ctx, 'document.selection');
    const texts = String(sel?.text ?? '').split(/\r?\n/).filter((t, i, all) => t || i < all.length - 1);
    if (!texts.length || !sel?.text) {
      ctx.toast('Select the text to turn into a table.');
      return false;
    }
    const r = await ctx.dialog('convertTextToTable', { texts });
    if (!r) return false;
    const autofit = r.fit?.kind === 'fixed' ? 'fixed' : r.fit?.kind ?? 'fixed';
    return run(ctx, 'table.fromText', { ...(TEXT_SEPS[r.sep] ? { separator: TEXT_SEPS[r.sep] } : {}), ...(r.sep === 'other' ? { char: r.other || '-' } : {}),
      columns: r.cols, autofit, width: r.fit?.width ?? 0 });
  }),
  'insert.tables.table.drawTable': tableTool('draw'),
  'tableLayout.draw.drawTable': tableTool('draw'),
  'tableLayout.draw.eraser': tableTool('erase'),
  'tableDesign.borders.borderPainter': tableTool('paint'),
  ...Object.fromEntries(Object.entries(MOVES).map(([id, to]) => [id, exec('table.moveTo', (a) => ({ to, extend: a === 'extend' }))])),
  'tables.moveRow': exec('table.moveRow', (a) => ({ dir: a === 'up' ? 'up' : 'down' })),
  'tables.splitTableKey': 'table.splitTable',
  'tables.updateAutoFormat': 'table.clearDirect',
  'tables.selectTable': 'table.selectTable',

  // Table Design
  ...Object.fromEntries(LOOK.map((k) => [`tableDesign.tableStyleOptions.${k}`, exec('table.look', toggle('table.look', (e) => !!e.value?.[k], (v) => ({ [k]: v })), {
    active: (e) => !!e?.value?.[k],
  })])),
  // A gallery style the document lacks goes in from the app's definition first (table-design/canvas.mjs), as Word adds a built-in.
  'tableDesign.tableStyles.tableStyles': exec('table.style', async (id) => {
    if (typeof id !== 'string' || !id) return null;
    const { defineOf } = await import('../../wp/table-design/canvas.mjs');
    const define = defineOf(id);
    return define ? { style: id, define } : { style: id };
  }, { value: (e) => e?.value ?? null }),
  'tableDesign.tableStyles.tableStyles.clear': exec('table.style', { style: 'TableNormal' }),
  // Modify Table Style and New Table Style: the DOM editor's dialog reads a canvas draft's styles through a .docx and the engine
  // writes the parts (table-design/index.js editStyleOnCanvas).
  'tableDesign.tableStyles.tableStyles.modifyTableStyle': APP,
  'tableDesign.tableStyles.tableStyles.newTableStyle': APP,
  'tableDesign.tableStyles.shading': exec('table.shading', (pick) => {
    if (pick !== undefined) lastShading = hex6(pick && typeof pick === 'object' ? pick.color : pick);
    return { color: lastShading };
  }, { value: (e) => hash(e?.value) }),
  'tableDesign.tableStyles.shading.moreColors': dialogRow(async (ctx) => {
    const hex = await ctx.dialog('colors', { value: hash((await stateNow(ctx, 'table.shading'))?.value) ?? '#FFFFFF' });
    return hex ? run(ctx, 'table.shading', { color: hex6(hex) }) : false;
  }, { enabled: (ctx) => !!ctx.engine && !inTable(ctx), reason: inTable }),
  // The pen is the app's (store word.pen); it arms Border Painter, which waits with Draw Table.
  'tableDesign.borders.borderStyles': APP,
  'tableDesign.borders.penStyle': APP,
  'tableDesign.borders.penWeight': APP,
  'tableDesign.borders.penColor': APP,
  'tableDesign.borders.penColor.moreColors': APP,
  'tableDesign.borders.borderStyles.borderSampler': {
    run: async (ctx) => (await import('../tools/tables.js')).startSampler(ctx),
    enabled: (ctx) => !!ctx.engine,
    active: () => activeTool() === 'table:sample',
  },

  // Table Layout
  'tableLayout.table.select.selectCell': 'table.selectCell',
  'tableLayout.table.select.selectRow': 'table.selectRow',
  'tableLayout.table.select.selectColumn': 'table.selectColumn',
  'tableLayout.table.select.selectTable': 'table.selectTable',
  // The setting is the app's (settings.word.tableGridlines); the page area draws them from layout.cells (tools/overlays.jsx).
  'tableLayout.table.viewGridlines': APP,
  'tableLayout.table.properties': dialogRow((ctx, tab) => tableProperties(ctx, tab), { enabled: (ctx) => !!ctx.engine && !inTable(ctx), reason: inTable }),
  'tableLayout.rowsColumns.delete.deleteCells': dialogRow(async (ctx) => {
    const mode = await ctx.dialog('deleteCells', {});
    if (mode === 'row') return run(ctx, 'table.deleteRow');
    if (mode === 'column') return run(ctx, 'table.deleteColumn');
    return DELETE_SHIFT[mode] ? shiftCells(ctx, 'table.deleteCells', DELETE_SHIFT[mode]) : false;
  }),
  'tableLayout.rowsColumns.launcher': dialogRow(async (ctx) => {
    const mode = await ctx.dialog('insertCells', {});
    if (mode === 'row') return run(ctx, 'table.insertRowAbove');
    if (mode === 'column') return run(ctx, 'table.insertColumnLeft');
    return INSERT_SHIFT[mode] ? shiftCells(ctx, 'table.insertCells', INSERT_SHIFT[mode]) : false;
  }),
  'tableLayout.merge.splitCells': dialogRow(async (ctx) => {
    const t = await query(ctx, 'table.get');
    const o = await ctx.dialog('splitCells', { several: !!t?.selection });
    return o ? run(ctx, 'table.split', { columns: o.cols, rows: o.rows, mergeFirst: !!o.merge }) : false;
  }),
  'tableLayout.merge.splitTable': 'table.splitTable',
  'tableLayout.cellSize.autoFit.autoFitContents': exec('table.autofit', { mode: 'contents' }),
  'tableLayout.cellSize.autoFit.autoFitWindow': exec('table.autofit', { mode: 'window' }),
  'tableLayout.cellSize.autoFit.fixedColumnWidth': exec('table.autofit', { mode: 'fixed' }),
  ...spinner('tableLayout.cellSize.tableRowHeight', 'table.rowHeight', (pt) => ({ height: Math.max(1, pt), rule: 'atLeast' }), (e) => e?.value ?? null, tenth),
  ...spinner('tableLayout.cellSize.tableColumnWidth', 'table.columnWidth', (pt) => ({ width: Math.max(6, pt) }), (e) => e?.value ?? null, tenth),
  'tableLayout.cellSize.distributeRows': 'table.distributeRows',
  'tableLayout.cellSize.distributeColumns': 'table.distributeColumns',
  'tableLayout.alignment.textDirection': exec('table.textDirection', {}, { value: (e) => DIRS[e?.value] ?? null }),
  'tableLayout.alignment.cellMargins': dialogRow(async (ctx) => {
    const t = await query(ctx, 'table.get');
    if (!t) return false;
    const [top, left, bottom, right] = t.props?.cellMargins ?? [0, 5.4, 0, 5.4];
    const out = await ctx.dialog('tableOptions', { value: { cellMargin: { top, left, bottom, right }, spacing: 0, spacingOn: false, autofit: !t.props?.fixed }, engine: true });
    if (!out) return false;
    const steps = [['table.cellMargins', out.cellMargin]];
    if (!!out.autofit === !!t.props?.fixed) steps.push(['table.autofit', { mode: out.autofit ? 'contents' : 'fixed' }]);
    return runMany(ctx, steps);
  }),
  'home.paragraph.sort': dialogRow(async (ctx) => {
    const lang = ctx.settings?.word?.proofing?.languages?.[0] ?? 'en-US';
    if (ctx.in?.table) {
      const t = await query(ctx, 'table.get');
      if (!t) return false;
      const cols = t.grid?.length ?? 1;
      const o = await ctx.dialog('sort', { mode: 'table', lang, cols, heads: (t.rows?.[0]?.cells ?? []).map((c) => c.text), header: !!t.rows?.[0]?.props?.header,
        columnSel: false, column: t.rows?.[t.row]?.cells?.[t.cell]?.col ?? 0 });
      const key = o?.keys?.[0];
      // One key, as text (gap: up to three keys, types, separators, case and language).
      return key ? run(ctx, 'table.sort', { column: Number(key.field) || 0, descending: !!key.desc, header: !!o.header }) : false;
    }
    const sel = await query(ctx, 'document.selection');
    const texts = String(sel?.text ?? '').split(/\r?\n/).filter(Boolean);
    if (texts.length < 2) {
      ctx.toast('Select the paragraphs to sort.');
      return false;
    }
    const o = await ctx.dialog('sort', { mode: 'text', lang, texts });
    return o ? run(ctx, 'para.sort', { descending: !!o.keys?.[0]?.desc }) : false;
  }),
  'tableLayout.data.repeatHeaderRows': exec('table.repeatHeader', toggle('table.repeatHeader', (e) => !!e.checked, (value) => ({ value }))),
  'tableLayout.data.convertToText': dialogRow(async (ctx) => {
    const t = await query(ctx, 'table.get');
    const o = await ctx.dialog('convertTableToText', { nested: !!t?.nested });
    return o ? run(ctx, 'table.toText', tableSep(o.sep)) : false;
  }),

  // base's table rows: Rows & Columns, Merge, the nine alignments and Shading's colours
  'tableLayout.rowsColumns.insertRowAbove': 'table.insertRowAbove',
  'tableLayout.rowsColumns.insertRowBelow': 'table.insertRowBelow',
  'tableLayout.rowsColumns.insertColumnLeft': 'table.insertColumnLeft',
  'tableLayout.rowsColumns.insertColumnRight': 'table.insertColumnRight',
  'tableLayout.rowsColumns.delete.deleteRows': 'table.deleteRow',
  'tableLayout.rowsColumns.delete.deleteColumns': 'table.deleteColumn',
  'tableLayout.rowsColumns.delete.deleteTable': 'table.deleteTable',
  // Off with no reason at one cell, as the DOM editor's is (tool search hides it there).
  'tableLayout.merge.mergeCells': exec('table.merge', undefined, { hide: (ctx) => !!ctx.in?.table && ctx.stateOf?.('table.merge')?.enabled === false }),
  ...Object.fromEntries(CELL_ALIGNS.map(([key, value]) => [`tableLayout.alignment.${key}`, exec('table.cellAlign', { value }, { active: (e) => e?.value === value })])),
};

// ---------------------------------------------------------------------------------------------
// base's page break rows and Layout > Paragraph

const PARAGRAPH = {
  // In a table cell the engine splits the table there, as Word does.
  'insert.pages.pageBreak': exec('text.pageBreak'),
  'layout.pageSetup.breaks.page': exec('text.pageBreak'),
  ...spinner('layout.paragraph.indentLeft', 'para.indents', (pt) => ({ left: pt }), (e) => e?.value?.indentLeft ?? null, tenth, { state: 'layout.paragraph', min: -1584 }),
  ...spinner('layout.paragraph.indentRight', 'para.indents', (pt) => ({ right: pt }), (e) => e?.value?.indentRight ?? null, tenth, { state: 'layout.paragraph', min: -1584 }),
  ...spinner('layout.paragraph.spacingBefore', 'para.spacing', (pt) => ({ before: pt }), (e) => e?.value?.spaceBefore ?? null, () => 6, { state: 'layout.paragraph' }),
  ...spinner('layout.paragraph.spacingAfter', 'para.spacing', (pt) => ({ after: pt }), (e) => e?.value?.spaceAfter ?? null, () => 6, { state: 'layout.paragraph' }),
};

/** {toolingId: row}. */
export const PAGE = { ...SECTIONS, ...COLUMN_ROWS, ...BACKGROUND, ...LAYOUT_MISC, ...HEADERS_FOOTERS, ...DESIGN_ROWS, ...RULER, ...TABLES, ...PARAGRAPH };
