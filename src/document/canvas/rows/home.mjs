// The Home package's rows of the Documents engine table (docs/plans/engine/stage2.md): text formatting and editing (S1). Only
// that package edits this file. Rows by tooling id in the forms of forms.mjs (APP, exec, off, a CommandSpec); commands.mjs joins
// them. Pure: node tests load it. The surveys' map (docs/plans/engine/stage2/home.md) says which engine command each id runs.
//
// The app's own ids and the engine's differ in places where a straight pass-through gives a wrong result without an error: the
// underline gallery, Change Case's modes, the list galleries and the line spacing menu. The rows translate them; the highlight
// names are the one place a translation would be wrong (highlightOf). test/word-engine-cmd-home.test.mjs and the harness case
// engine-cmd-home check them against the engine.
import { getState } from '../../../app/store.js';
import { BULLETS, labelText, MULTILEVEL, NUMBERINGS } from '../../numbering.mjs';
import { EDGE_ITEMS } from '../../wp/borders/model.mjs';
import { canvasRead } from '../../wp/borders/canvas.mjs';
import { engineHex as hex, LIGATURE_FLAGS, NUMBER_STYLES, parseSize, themeFont, typographyProps, UNDERLINE_MENU } from '../../wp/font/run.mjs';
import { pasteAllOrder } from '../../wp/clipboard/ring.mjs';
import { compose } from '../../wp/editing-keys/accents.mjs';
import { addTextAction, addTextItemOf } from '../../wp/styles/model.mjs';
import { chrOfRun, engineStyleProps, ppOfPara } from '../../wp/styles/engine.mjs';
import { APP, exec, off } from './forms.mjs';

/** What the Word modules hand over at load, so this file stays pure: the Borders and Shading pen (borders); the system clipboard,
 * the window's own paste, the app's Clipboard ring and the app's Spike (clipboard). The ring and the Spike are the app's, shared by
 * every draft and editor (stage2.md Decisions): `spikeAdd({html, text})` appends a piece, `spikeInsert(paste)` hands the Spike's
 * content as {html, text} to `paste` and empties it when `paste` succeeds (null when the Spike is empty). */
export const hooks = {
  pen: () => ({ style: 'single', width: 0.5, color: null }),
  readClipboard: async () => ({}),
  nativePaste: () => false,
  ringItems: () => [],
  clearRing: () => {},
  spikeAdd: async () => {},
  spikeInsert: async () => null,
  // The focused canvas input's move to the first or last line in the window (src/engine/input, the Viewport's visible range).
  windowEdge: async () => false,
  // AutoFormat Now's plan from the paragraphs' texts (autocorrect/rules.mjs autoFormatPlan with the user's options).
  autoFormatPlan: () => null,
  // Opens or closes the Paste Options menu by the last paste (the canvas page area's button).
  pasteMenu: () => false,
  /** Set As Default's "All new documents too": the app's settings for new documents take `half` ('run' or 'para') of `value`
   * (styles). */
  newDocumentDefault: async () => {},
  // Sets store word.extend to 'move', 'copy' or null for F2 and Shift+F2, so the status bar shows the DOM editor's prompt.
  setExtend: () => {},
};

/** What Word's keys wait for on a canvas draft: the text F2 or Shift+F2 moves or copies ({id: the session's, src: {anchor, head},
 * copy, off}) until Enter, and the accent prefix chord the next letter takes (editing-keys' DOM plugin keeps its own). */
export const pending = { move: null, prefix: null };

/** Ends F2 or Shift+F2's wait: its document listener and the status bar prompt go. */
export function endMove() {
  if (!pending.move) return;
  pending.move.off?.();
  pending.move = null;
  hooks.setExtend(null);
}

// The Paste Options button and its list and table choices: the engine keeps the last paste (edit.pasteOptions, its state) while
// the caret stays at its end, and edit.repaste pastes it again with another option as one undo step (stage2.md G29). Off with no
// reason otherwise, as the DOM editor's are before a paste.
const PASTED = 'edit.pasteOptions';
/** The last paste while Paste Options show ({option, table, list, options, end}), or null. */
const pastedOf = (ctx) => {
  const e = ctx.stateOf?.(PASTED);
  return e?.checked ? e.value : null;
};
// The menu ids the DOM editor's Paste Options use (clipboard/modes.mjs, button.js TABLE, the lists gallery) → edit.repaste's.
export const REPASTE = { keepSourceFormatting: 'keepSource', mergeFormatting: 'merge', keepTextOnly: 'text', nestTable: 'nest',
  insertAsNewRows: 'rows', overwriteCells: 'overwrite', continue: 'continueList', new: 'newList' };
const offered = (lp, kind) => !!lp && (kind === 'table' ? lp.table : kind === 'list' ? lp.list : true);
/** A Paste Options row for `kind`'s choices (null: the button's, 'table', 'list'): pick → the last paste again with that option. */
const repasteRow = (kind) => ({
  run: (ctx, pick) => {
    const lp = pastedOf(ctx);
    const as = REPASTE[pick] ?? pick;
    return offered(lp, kind) && lp.options.includes(as) ? exe(ctx, 'edit.repaste', { as }) : false;
  },
  enabled: (ctx) => offered(pastedOf(ctx), kind),
  value: (ctx) => pastedOf(ctx)?.option ?? null,
  reads: [PASTED],
});

const FS = 'format.state'; // the run formatting at the selection (format.rs state, its value)
const PS = 'para.state'; // the caret paragraph's resolved properties (para.rs, its value)
const MODES = 'edit.modes'; // Format Painter, Overtype and column selection (edit.rs, its value)
const CONTEXT = 'document.context';

/** A field of an engine state entry's value. */
const field = (key) => (e) => e?.value?.[key];
/** What the selection is in (cmd/context.rs), always in the snapshot. */
const contextOf = (ctx) => ctx.engineState?.[CONTEXT]?.value ?? null;
/** The value of one engine state entry for a CommandSpec row (it joins the state call). */
const valueOf = (ctx, id) => ctx.stateOf?.(id)?.value ?? null;
/** A colour argument (a '#RRGGBB', {color, themeColor} from the colour grid, null for Automatic) → the engine's form. */
const colorOf = (arg) => hex(arg && typeof arg === 'object' ? arg.color : arg) ?? 'auto';
const exe = (ctx, id, args = {}) => Promise.resolve(ctx.engine.exec(id, args)).then((r) => !!r?.ok);
const many = (ctx, steps) => Promise.resolve(ctx.engine.execMany(steps)).then((r) => !!r?.ok);
/** Whether the selection is a caret (the host's selection). */
const caret = async (ctx) => {
  const s = await ctx.engine.selection();
  return !s || JSON.stringify(s.anchor) === JSON.stringify(s.head);
};
const NOT_IN_LIST = 'Put the cursor in a list first.';
const inList = (ctx) => (contextOf(ctx)?.list ? null : NOT_IN_LIST);
const inTable = (ctx) => (contextOf(ctx)?.table ? null : 'Put the cursor in a table first.');

/** A dialog that opens with the engine's state at the selection read first (the dialogs read their props on a canvas draft). */
const withState = (dialog, props = {}) => async (ctx, arg) => {
  const [run, para] = await Promise.all([ctx.engine.exec(FS, {}), ctx.engine.exec(PS, {})]);
  return ctx.dialog(dialog, { ...props, ...(arg && typeof arg === 'object' ? arg : {}), engineRun: run?.value ?? null, enginePara: para?.value ?? null });
};
const dialogRow = (dialog, props) => ({ run: withState(dialog, props) });

// ---------- Font ----------
// Change Case: the menu's ids → format.changeCase's modes.
export const CASE = { sentenceCase: 'sentence', lowercase: 'lower', UPPERCASE: 'upper', capitalizeEachWord: 'title', tOGGLECASE: 'toggle',
  halfWidth: 'halfWidth', fullWidth: 'fullWidth' };

/** The app's highlight names (office.mjs HIGHLIGHTS) are the ST_HighlightColor values, which format.highlight reads before its
 * own names (cmd/format.rs highlight: OOXML first), so they pass as they are. Its own names would be wrong here: its 'green' is
 * the app's darkGreen, and 'green' read as OOXML is bright green (the survey's translation table gave that wrong colour). */
const HIGHLIGHT_NAMES = new Set(['yellow', 'green', 'cyan', 'magenta', 'blue', 'red', 'darkBlue', 'darkCyan', 'darkGreen',
  'darkMagenta', 'darkRed', 'darkYellow', 'darkGray', 'lightGray', 'black', 'white']);
/** The engine colour of app highlight name `name`: the name itself, or 'none'. */
export const highlightOf = (name) => (HIGHLIGHT_NAMES.has(name) ? name : 'none');

/** The font a Font box pick names: a recent row's own, the theme's for Headings and Body (the engine keeps names, not theme
 * references: G35). */
export function fontName(arg) {
  const id = String(arg ?? '').trim().replace(/^recent:/, '');
  return themeFont(id);
}

/** The underline gallery id (UNDERLINE_MENU) of engine underline style `style`, or null. */
const underlineItem = (style) => Object.keys(UNDERLINE_MENU).find((k) => UNDERLINE_MENU[k] === style && style) ?? null;

// The split buttons repeat their last pick, as Word's do (and the DOM path's, font/commands.js).
const last = { highlight: 'yellow', color: 'FF0000', shade: null, border: 'bottomBorder', pen: null };

/** The highlighter pen: armed with no selection, it highlights each mouse selection until it is pressed again (src/engine/input
 * pointer.js asks penAfterSelect after a selection made with the mouse). */
export const highlighter = {
  armed: () => last.pen,
  /** After a mouse selection on `client`: the armed pen's highlight on it (a click that selects nothing leaves the text). */
  afterSelect: async (client) => {
    if (!last.pen) return null;
    const s = await client.selection();
    if (!s || JSON.stringify(s.anchor) === JSON.stringify(s.head)) return null;
    return client.exec('format.highlight', { color: highlightOf(last.pen) });
  },
};

const effects = (ctx, patch) => exe(ctx, 'format.textEffects', patch);
const SHADOW_ANGLES = { outerBR: 45, outerB: 90, outerBL: 135, outerR: 0, outerC: null, outerL: 180, outerTR: -45, outerT: -90, outerTL: -135 };
const REFLECTION_SIZES = { tight: 30, half: 50, full: 90 };
const ligatureItem = (l) => Object.keys(LIGATURE_FLAGS).find((k) => {
  const f = LIGATURE_FLAGS[k];
  return ['standard', 'contextual', 'historical', 'discretional'].every((x) => !!f[x] === !!l?.[x]);
}) ?? null;

/** Font Color: the colour, and a gradient fill dropped, as one undo step. */
const fontColor = (ctx, arg) => {
  const color = arg === undefined ? last.color : colorOf(arg);
  if (arg !== undefined && color !== 'auto') last.color = color;
  return many(ctx, [['format.color', { color }], ['format.textEffects', { fill: null }]]);
};
/** A gradient from colour `base` lightened (`lum` > 0) or darkened. */
const shade = (base, lum) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(base.slice(i, i + 2), 16));
  const f = (c) => Math.round(lum > 0 ? c + (255 - c) * lum : c * (1 + lum)).toString(16).padStart(2, '0');
  return `${f(r)}${f(g)}${f(b)}`.toUpperCase();
};
const GRADIENT_ANGLES = [90, 0, 270, 180];

/** Asks the colour picker for a colour, then runs `then(hex)`. */
const moreColors = (then) => async (ctx) => {
  const picked = await ctx.dialog('colors', { value: null });
  return picked ? then(ctx, picked) : false;
};

/** A run property command with a value from tool search, else the Font dialog's Advanced tab. */
const advanced = (valid, apply) => ({
  run: (ctx, v) => (valid(v) ? apply(ctx, v) : withState('font', { tab: 'advanced' })(ctx)),
});

/** Format Text Effects opened on the engine's effects at the selection (G6); its OK writes format.textEffects. Exported for the
 * WordArt row (objects.mjs), whose shape's whole text takes them. */
export const textEffectsDialog = (props = {}) => ({
  run: async (ctx, arg) => {
    const fs = (await ctx.engine.exec(FS, {}))?.value ?? null;
    return ctx.dialog('formatTextEffects', { ...props, ...(arg && typeof arg === 'object' ? arg : {}), engineEffects: fs?.textEffects ?? null });
  },
});

const FONT = {
  'home.font.font': {
    run: (ctx, arg) => (fontName(arg) ? exe(ctx, 'format.font', { name: fontName(arg) }) : false),
    value: (ctx) => valueOf(ctx, 'format.font'),
  },
  'home.font.fontSize': {
    // Ctrl+Shift+P runs it with no value: the Font dialog with its Size box focused.
    run: (ctx, arg) => {
      if (arg === undefined) return withState('font', { focus: 'size' })(ctx);
      const size = parseSize(arg);
      return size == null ? (ctx.toast('The size must be a number from 1 to 1638.'), false) : exe(ctx, 'format.size', { size });
    },
    value: (ctx) => valueOf(ctx, 'format.size'),
  },
  'font.growOnePoint': 'format.growFont1',
  'font.shrinkOnePoint': 'format.shrinkFont1',
  'home.font.changeCase': exec('format.changeCase', (arg) => (CASE[arg] ? { mode: CASE[arg] } : {})),
  ...Object.fromEntries(Object.entries(CASE).map(([id, mode]) => [`home.font.changeCase.${id}`, exec('format.changeCase', { mode })])),
  // The Phonetic Guide on the selection, or the word at the caret, as Word picks it (format.phonetic's state).
  'home.font.phoneticGuide': {
    run: async (ctx) => {
      if (await caret(ctx)) await ctx.engine.exec('select.word', {});
      const st = await Promise.resolve(ctx.engine.state(['format.phonetic'])).catch(() => null);
      return ctx.dialog('phoneticGuide', { engine: st?.['format.phonetic']?.value ?? { base: '' } });
    },
  },
  'home.font.characterBorder': 'format.border',
  // Word writes pct15 pattern shading; the engine holds one fill, so the 15% grey stands for it.
  'home.font.characterShading': exec('format.shading', (_arg, ctx) => ({ color: valueOf(ctx, FS)?.shading ? null : 'D9D9D9' }),
    { state: FS, active: (e) => !!e?.value?.shading }),
  'home.font.underline': exec('format.underline', (arg) => {
    if (arg === undefined) return {};
    const style = UNDERLINE_MENU[arg];
    return style ? { style } : { value: false };
  }, { state: FS, active: (e) => !!e?.value?.underline, value: (e) => underlineItem(e?.value?.underlineStyle) }),
  'home.font.underline.moreUnderlines': dialogRow('font', { focus: 'underline' }),
  'home.font.underline.underlineColor': exec('format.underlineColor', (arg) => ({ color: colorOf(arg) })),
  'home.font.underline.underlineColor.moreColors': { run: moreColors((ctx, c) => exe(ctx, 'format.underlineColor', { color: colorOf(c) })) },
  'font.underlineColor': exec('format.underlineColor', (arg) => ({ color: colorOf(arg) })),
  'font.doubleUnderline': exec('format.doubleUnderline', {}, { state: FS, active: (e) => e?.value?.underlineStyle === 'double' }),
  'font.wordUnderline': exec('format.wordUnderline', {}, { state: FS, active: (e) => e?.value?.underlineStyle === 'words' }),
  'font.doubleStrikethrough': exec('format.doubleStrikethrough', {}, { state: FS, active: field('doubleStrike') }),
  'font.smallCaps': 'format.smallCaps',
  'font.allCaps': 'format.allCaps',
  'font.hidden': 'format.hidden',
  'font.symbolFont': exec('format.font', { name: 'Symbol' }),
  'font.resetChar': 'format.resetChar',
  'font.scale': advanced((v) => v >= 1 && v <= 600, (ctx, v) => exe(ctx, 'format.scale', { percent: Math.round(v) })),
  'font.spacing': advanced(Number.isFinite, (ctx, v) => exe(ctx, 'format.spacing', { points: v })),
  'font.position': advanced(Number.isFinite, (ctx, v) => exe(ctx, 'format.position', { points: v })),
  'font.kerning': advanced((v) => v === null || Number.isFinite(v), (ctx, v) => exe(ctx, 'format.set', { props: { kern: v ?? 0 } })),
  // Font > Advanced's OpenType settings from tool search: ligatures, number forms and spacing, the stylistic set, contextual
  // alternates (G41).
  'font.openType': advanced((v) => !!v && typeof v === 'object' && Object.keys(typographyProps(v)).length > 0,
    (ctx, v) => exe(ctx, 'format.set', { props: typographyProps(v) })),
  'font.textEffects': textEffectsDialog(),
  'home.font.launcher': { run: (ctx, arg) => withState('font')(ctx, arg) },

  // Text Highlight Color: with a selection it highlights; with none it arms the highlighter pen (a pick arms it in that colour,
  // No Color disarms it), and the main part pressed again disarms it.
  'home.font.textHighlightColor': {
    run: async (ctx, arg) => {
      if (arg) last.highlight = arg;
      const pick = arg === undefined ? last.highlight : arg;
      const name = highlightOf(pick);
      if (await caret(ctx)) {
        last.pen = arg === undefined && last.pen ? null : name === 'none' ? null : name;
        return true;
      }
      return exe(ctx, 'format.highlight', { color: name });
    },
    value: () => last.highlight,
    active: () => !!last.pen,
  },
  'home.font.textHighlightColor.stopHighlighting': {
    run: () => ((last.pen = null), true),
    enabled: () => !!last.pen,
    reason: () => 'The highlighter is off.',
  },
  'home.font.fontColor': { run: fontColor, value: () => ({ color: `#${last.color}`, themeColor: null }) },
  'home.font.fontColor.moreColors': { run: moreColors(fontColor) },
  'home.font.fontColor.gradient': {
    run: (ctx, arg) => {
      if (arg === 'none') return effects(ctx, { fill: null });
      const m = /^(light|dark)(\d)$/.exec(arg ?? '');
      if (!m) return arg === 'more' ? (ctx.toast('More Gradients does not work on canvas drafts yet.'), false) : false;
      const c = hex(valueOf(ctx, FS)?.color) ?? '404040';
      const stops = m[1] === 'light' ? [shade(c, 0.6), c] : [c, shade(c, -0.5)];
      return effects(ctx, { fill: { gradient: stops, angle: GRADIENT_ANGLES[+m[2]] } });
    },
  },
  'home.font.textEffectsAndTypography': textEffectsDialog(),
  'home.font.textEffectsAndTypography.outline': {
    run: (ctx, arg) => {
      if (arg === 'none') return effects(ctx, { outline: 'none' });
      if (arg === 'more') return moreColors((c, picked) => effects(c, { outline: { color: hex(picked) } }))(ctx);
      const [k, v] = String(arg).split(':');
      if (k === 'color') return effects(ctx, { outline: { color: hex(v) } });
      if (k === 'weight') return effects(ctx, { outline: { width: Number(v) } });
      ctx.toast('Dashed text outlines are not built for canvas drafts yet.');
      return false;
    },
  },
  'home.font.textEffectsAndTypography.shadow': {
    run: (ctx, arg) => {
      if (arg === 'none') return effects(ctx, { shadow: null });
      if (!(arg in SHADOW_ANGLES)) return false;
      const angle = SHADOW_ANGLES[arg];
      return effects(ctx, { shadow: { color: '000000', transparency: 40, blur: 4, distance: angle == null ? 0 : 3, angle: angle ?? 0 } });
    },
  },
  'home.font.textEffectsAndTypography.reflection': {
    run: (ctx, arg) => {
      if (arg === 'none') return effects(ctx, { reflection: 'none' });
      return arg in REFLECTION_SIZES ? effects(ctx, { reflection: { transparency: 50, size: REFLECTION_SIZES[arg], distance: 0 } }) : false;
    },
  },
  'home.font.textEffectsAndTypography.glow': {
    run: (ctx, arg) => {
      if (arg === 'none') return effects(ctx, { glow: null });
      if (arg === 'more') return moreColors((c, picked) => effects(c, { glow: { color: hex(picked), size: 5, transparency: 40 } }))(ctx);
      const c = hex(/^glow:(#[0-9A-F]{6})$/i.exec(arg ?? '')?.[1]);
      return c ? effects(ctx, { glow: { color: c, size: 5, transparency: 40 } }) : false;
    },
  },
  // Number Styles and Stylistic Sets set the run's OpenType features, which the engine's shaper draws (G41).
  'home.font.textEffectsAndTypography.numberStyles': exec('format.set', (arg) => {
    const n = NUMBER_STYLES[arg];
    return n ? { props: { numSpacing: n[1] ?? 'default', numForm: n[2] ?? 'default' } } : null;
  }, { state: FS, value: (e) => Object.keys(NUMBER_STYLES).find((k) => (NUMBER_STYLES[k][1] ?? null) === (e?.value?.numSpacing ?? null)
    && (NUMBER_STYLES[k][2] ?? null) === (e?.value?.numForm ?? null)) ?? null }),
  'home.font.textEffectsAndTypography.ligatures': exec('format.set', (arg) => ({ props: { ligatures: LIGATURE_FLAGS[arg] ?? {} } }),
    { state: FS, value: (e) => ligatureItem(e?.value?.ligatures) }),
  'home.font.textEffectsAndTypography.stylisticSets': exec('format.set', (arg, ctx) => {
    if (arg === 'default') return { props: { stylisticSet: 0 } };
    if (arg === 'contextual') return { props: { contextualAlternates: !valueOf(ctx, FS)?.contextualAlternates } };
    const n = Number(/^ss(\d+)$/.exec(arg ?? '')?.[1]);
    return n >= 1 && n <= 20 ? { props: { stylisticSet: n } } : null;
  }, { state: FS, value: (e) => (e?.value?.stylisticSet ? `ss${e.value.stylisticSet}` : 'default') }),

  // base's Font group rows
  'home.font.growFont': 'format.growFont',
  'home.font.shrinkFont': 'format.shrinkFont',
  'home.font.clearFormatting': 'format.clear',
  'home.styles.styles.clearFormatting': 'format.clear',
  'home.font.strikethrough': 'format.strikethrough',
  'home.font.subscript': 'format.subscript',
  'home.font.superscript': 'format.superscript',
};

// ---------- Paragraph ----------
/** The Line and Paragraph Spacing menu's ids → multiples (base.js SPACINGS). */
export const SPACINGS = { 10: 1, 115: 1.15, 15: 1.5, 20: 2, 25: 2.5, 30: 3 };
const multiple = (e) => (e?.value?.lineSpacing?.rule === 'multiple' ? e.value.lineSpacing.value : null);
const near = (a, b) => a != null && Math.abs(a - b) < 0.01;
const SCALE = 'home.paragraph.asianLayout.characterScaling';
const SCALES = [200, 150, 100, 90, 80, 66, 50, 33];
const SPACING_MENU = 'home.paragraph.lineAndParagraphSpacing';
/** Two Lines in One or Horizontal in Vertical (`dialog`) over the engine's selection: its text, ends and East Asian layout. */
const asianDialog = async (ctx, dialog) => {
  const s = (await ctx.engine.query('document.selection', {}))?.value;
  if (!s?.text) return (ctx.toast('Select the text first.'), false);
  const flat = JSON.stringify(s.anchor?.path) === JSON.stringify(s.focus?.path) && s.anchor?.story === s.focus?.story;
  return ctx.dialog(dialog, { engineSel: { text: s.text, anchor: s.anchor, focus: s.focus, flat, ts: { eastAsianLayout: s.format?.eastAsianLayout ?? null } } });
};

const PARAGRAPH = {
  'home.paragraph.increaseIndent': 'para.indent',
  'home.paragraph.decreaseIndent': 'para.outdent',
  'indents.indentKey': 'para.indent',
  'indents.unIndentKey': 'para.outdent',
  'indents.hangingKey': 'para.hangingIndent',
  'indents.unHangKey': 'para.removeHanging',
  'home.paragraph.distributed': 'para.distribute',
  'home.paragraph.launcher': dialogRow('paragraph'),
  'home.paragraph.lineAndParagraphSpacing.lineSpacingOptions': dialogRow('paragraph', { focus: 'spacing' }),
  'home.paragraph.asianLayout': { run: () => false }, // the menu itself; its items act
  // Two Lines in One and Horizontal in Vertical (engine-gaps-rest): the selection's eastAsianLayout, which the engine lays out
  // as Word does (two half-size rows in the line; the text turned 90 degrees counterclockwise, probe g33).
  'home.paragraph.asianLayout.twoLinesInOne': { run: (ctx) => asianDialog(ctx, 'twoLinesInOne') },
  'home.paragraph.asianLayout.horizontalInVertical': { run: (ctx) => asianDialog(ctx, 'horizontalInVertical') },
  // Combine Characters: Word's EQ field (format.combineCharacters), which the dialog reads back through format.combineState.
  'home.paragraph.asianLayout.combineCharacters': {
    run: async (ctx) => {
      const st = (await ctx.engine.query('format.combineState', {}))?.value;
      if (!st?.text) return (ctx.toast('Select up to six characters in one paragraph first.'), false);
      return ctx.dialog('combineCharacters', { engineSel: st });
    },
  },
  // Fit Text (G33): the selection's fitText, which the engine lays out by spreading or squeezing its characters to the width.
  'home.paragraph.asianLayout.fitText': {
    run: async (ctx) => {
      const s = await ctx.engine.selection();
      if (!s || JSON.stringify(s.anchor) === JSON.stringify(s.head)) return (ctx.toast('Select the text to fit first.'), false);
      const [rects, fs] = await Promise.all([ctx.engine.rects(s.anchor, s.head), ctx.engine.exec(FS, {})]);
      const width = Math.round((rects ?? []).reduce((w, r) => w + (r.w ?? 0), 0) * 100) / 100;
      const fit = fs?.value?.fitText;
      return ctx.dialog('fitText', { engineSel: { width, ts: { fitText: fit ? { w: fit.width, id: fit.id } : null } } });
    },
  },
  [SCALE]: exec('format.scale', (arg) => ({ percent: Math.round(+arg) }), { state: FS, value: field('scale') }),
  ...Object.fromEntries(SCALES.map((p) => [`${SCALE}.${p}`, exec('format.scale', { percent: p }, { state: FS, active: (e) => e?.value?.scale === p })])),
  [`${SCALE}.more`]: dialogRow('font', { tab: 'advanced' }),
  'paragraph.rightToLeft': exec('para.rtl', { value: true }),
  'paragraph.leftToRight': exec('para.ltr', { value: true }),
  'paragraph.openCloseUp': 'para.addSpaceBefore',
  'paragraph.resetParagraph': 'para.reset',

  // base's Line and Paragraph Spacing rows
  [SPACING_MENU]: exec('para.lineSpacing', (arg) => ({ value: SPACINGS[arg] }),
    { state: PS, value: (e) => Object.keys(SPACINGS).find((k) => near(multiple(e), SPACINGS[k])) ?? null }),
  ...Object.fromEntries(Object.entries(SPACINGS).map(([k, m]) => [`${SPACING_MENU}.${k}`,
    exec('para.lineSpacing', { value: m }, { state: PS, active: (e) => near(multiple(e), m) })])),
  [`${SPACING_MENU}.addSpaceBeforeParagraph`]: 'para.addSpaceBefore',
  [`${SPACING_MENU}.removeSpaceAfterParagraph`]: 'para.removeSpaceAfter',
};

// ---------- Styles ----------
/** The style a styles row acts on: its argument (a gallery item's id), else the caret paragraph's. */
const styleArg = (arg, ctx) => (typeof arg === 'string' && arg ? arg : valueOf(ctx, 'para.style') ?? 'Normal');
const ADD_TEXT = ['doNotShowInTableOfContents', 'level1', 'level2', 'level3'];
/** References > Add Text item `item` on the caret paragraph: a heading style, or the outline level (styles/model.mjs). */
const addText = (ctx, item) => {
  const act = addTextAction(item, !!contextOf(ctx)?.heading);
  return act.style ? exe(ctx, 'para.style', { style: act.style }) : exe(ctx, 'para.outlineLevel', { level: act.para.outline });
};
const outlineNow = (ctx) => valueOf(ctx, PS)?.outlineLevel ?? 9;

// The style dialogs and panes on a canvas draft read the engine's sheet in the DOM editor's form (wp/styles/engine.mjs) and write
// through styles.define, styles.setDefaults and styles.delete (engine-gaps-styles, stage2.md G10 and G42).
/** A style dialog opened with the engine's styles, theme and selection formatting. */
const styleDialog = (dialog, withId = false) => ({
  run: async (ctx, arg) => ctx.dialog(dialog, { ...(await engineStyleProps(ctx)), ...(withId && { styleId: styleArg(arg, ctx) }) }),
});
/** Manage Styles' and the Organizer's `canvas` prop: the engine's styles and theme ({attrs}) and their usage ({counts}). */
const canvasAttrs = async (ctx) => {
  const [p, usage] = await Promise.all([engineStyleProps(ctx), ctx.engine.exec('styles.usage', {})]);
  return { attrs: { styles: p.engineStyles, theme: p.engineTheme }, counts: usage?.value ?? {} };
};
/** Set As Default from the Font (`half` 'run') or Paragraph ('para') dialog with that dialog's `value`: the document defaults, and
 * new documents' too when asked. */
const setAsDefault = (half) => ({
  run: async (ctx, value) => {
    if (!value || typeof value !== 'object') return false;
    const where = await ctx.dialog('styleSetAsDefault', { what: half === 'run' ? 'font' : 'paragraph' });
    if (!where) return false;
    const done = await exe(ctx, 'styles.setDefaults', half === 'run' ? { chr: chrOfRun(value) } : { para: ppOfPara(value) });
    if (done && where === 'all') await hooks.newDocumentDefault(half, value);
    return done;
  },
});

const STYLES = {
  'home.styles.styles': exec('para.style', (id) => ({ style: String(id) }), { state: 'para.style' }),
  'home.styles.styles.createAStyle': styleDialog('createNewStyleFromFormatting'),
  'styles.modify': styleDialog('modifyStyle', true),
  'styles.updateToMatch': exec('styles.updateToMatch', (id, ctx) => ({ style: styleArg(id, ctx) })),
  // The dialog starts from the name Word shows ('Heading 1,Chapter', styles.get); a built-in style keeps its name and
  // styles.define reads what follows the commas as its aliases, so 'Heading 1' alone clears them, as Rename does in Word.
  'x.styles.rename': {
    run: async (ctx, arg) => {
      const style = styleArg(arg, ctx);
      const got = (await ctx.engine.exec('styles.get', { style }))?.value;
      const shown = got ? [got.name, got.aliases].filter(Boolean).join(',') : style;
      const name = await ctx.dialog('renameStyle', { styleId: style, styleName: shown });
      return name && name !== shown ? exe(ctx, 'styles.define', { style, name }) : false;
    },
  },
  'x.styles.removeFromGallery': exec('styles.setVisibility', (id, ctx) => ({ style: styleArg(id, ctx), gallery: false })),
  'styles.headingKeys': exec('para.style', (n) => ({ style: `Heading${n ?? 1}` })),
  'styles.normalKey': 'para.normal',
  // engine-style-separator: the paragraph's mark becomes a style separator (w:specVanish) and the next paragraph runs on in its
  // line (ew-doc-layout's run_in).
  'styles.styleSeparator': 'para.styleSeparator',
  'font.setAsDefault': setAsDefault('run'),
  'paragraph.setAsDefault': setAsDefault('para'),
  'references.tableOfContents.addText': {
    run: (ctx, item) => (ADD_TEXT.includes(item) ? addText(ctx, item) : false),
    value: (ctx) => addTextItemOf(outlineNow(ctx)),
  },
  ...Object.fromEntries(ADD_TEXT.map((item) => [`references.tableOfContents.addText.${item}`, {
    run: (ctx) => addText(ctx, item),
    active: (ctx) => addTextItemOf(outlineNow(ctx)) === item,
  }])),
  // 0 to 8 for Level 1 to 9, 9 for Body Text; none goes back to the style's level.
  'paragraph.outlineLevel': exec('para.outlineLevel', (n) => (n == null ? {} : { level: Math.max(0, Math.min(9, +n)) }),
    { state: PS, value: (e) => e?.value?.outlineLevel ?? 9 }),

  // style-panes: the panes draw their canvas forms (style-panes/canvas.jsx); Manage Styles and the Organizer get the engine's
  // styles first and write through a stand-in editor (style-panes/canvas-ed.mjs).
  'home.styles.launcher': APP,
  'home.styles.styles.applyStyles': APP,
  'styles.inspector': APP,
  'panes.revealFormatting': APP,
  'styles.manage': { run: async (ctx, tab) => ctx.dialog('manageStyles', { ...(typeof tab === 'string' && { tab }), canvas: await canvasAttrs(ctx) }) },
  'styles.organizer': { run: async (ctx) => ctx.dialog('organizer', { canvas: await canvasAttrs(ctx) }) },
  // The Styles pane's Select All n Instances: every paragraph and stretch of text in the style, as several ranges (G22).
  'styles.selectAllInstances': exec('select.style', (id) => (typeof id === 'string' && id ? { style: id } : null)),
};

// ---------- Lists ----------
const SYMBOL_FONTS = /^(symbol|wingdings|webdings)/i;
/** An app list level (numbering.mjs level()) → list.define's level form. */
export function levelOf(l) {
  const out = { format: l.fmt, text: l.fmt === 'bullet' ? l.glyph ?? l.text : l.text };
  if (l.start != null) out.start = l.start;
  if (l.jc) out.align = l.jc;
  if (l.left != null) {
    out.indentAt = l.left;
    out.alignedAt = l.left - (l.hanging ?? 0);
  }
  if (l.suff) out.follow = l.suff;
  if (l.tab !== undefined) out.tabAt = l.tab;
  if (l.isLgl) out.legal = true;
  if (l.pStyle) out.style = l.pStyle;
  return out;
}
/** list.get's level → the app's level form, which the list dialogs take. */
export function appLevel(l) {
  const left = l.indentAt ?? 0;
  const out = { fmt: l.format, text: l.text ?? '', jc: l.align ?? 'left', start: l.start ?? 1, left, hanging: left - (l.alignedAt ?? 0),
    suff: l.follow ?? 'tab' };
  if (l.tabAt != null) out.tab = l.tabAt;
  if (l.legal) out.isLgl = true;
  if (l.style) out.pStyle = l.style;
  const run = { ...(l.font && { font: l.font }), ...(l.bold && { bold: true }), ...(l.italic && { italic: true }), ...(l.color && { color: `#${l.color}` }) };
  if (Object.keys(run).length) out.run = run;
  return out;
}
/** A list dialog's level → list.define's: levelOf plus the Font... button's font, bold, italic and colour. */
export function definedLevel(l) {
  const run = l.run ?? {};
  return { ...levelOf(l), ...(run.font && { font: themeFont(run.font) }), ...(run.bold != null && { bold: !!run.bold }),
    ...(run.italic != null && { italic: !!run.italic }), ...(hex(run.color) && { color: hex(run.color) }) };
}
/** The one level a Bullets or Numbering gallery pick names → list.define's level, or null. The library's symbol-font bullets
 * go in as their Unicode character in the text's font, as the DOM editor draws them. */
export function pickLevel(kind, id) {
  if (kind === 'bullet') {
    const b = BULLETS.find((x) => x.id === id);
    return b && { format: 'bullet', text: b.char, ...(!SYMBOL_FONTS.test(b.font) && { font: b.font }) };
  }
  const n = NUMBERINGS.find((x) => x.id === ({ upperRoman: 'upperRomanRight', lowerRoman: 'lowerRomanRight' }[id] ?? id));
  return n && { format: n.fmt, text: n.text, ...(n.jc && { align: n.jc }) };
}
/** list.define's params that put `level` at the caret's list level: the caret's list changes in place, as Word's gallery
 * changes the list the caret is in; outside a list the selection starts a new one. */
const defineAt = (ctx, level) => {
  const l = contextOf(ctx)?.list;
  if (!l) return { levels: [level] };
  return { num: l.num, levels: [...Array(l.level).fill({}), level] };
};
const listButton = (kind) => {
  const toggle = kind === 'bullet' ? 'para.bullets' : 'para.numbering';
  const isKind = (ctx) => {
    const l = contextOf(ctx)?.list;
    return !!l && l.numbered === (kind === 'number');
  };
  return {
    run: (ctx, arg) => {
      if (arg === undefined) return exe(ctx, toggle);
      if (arg === 'none') return isKind(ctx) ? exe(ctx, toggle, { off: true }) : false;
      const level = pickLevel(kind, arg);
      return level ? exe(ctx, 'list.define', defineAt(ctx, level)) : false;
    },
    active: isKind,
  };
};
const listNow = (ctx) => contextOf(ctx)?.list ?? null;
/** The caret list's levels (list.get), or null. */
const listLevels = async (ctx) => (await ctx.engine.exec('list.get', {}))?.value?.levels ?? null;
const NOT_NUMBERED = 'Put the cursor in a numbered list first.';
/** Define New Bullet and Define New Number Format: the dialog opens on the caret list's level when it is of that kind, and its
 * level goes to the caret's list as a gallery pick does. */
const defineLevel = (dialog, kind) => ({
  run: async (ctx) => {
    const l = listNow(ctx);
    const cur = l && l.numbered === (kind === 'number') ? (await listLevels(ctx))?.[l.level] : null;
    const r = await ctx.dialog(dialog, { level: cur ? appLevel(cur) : null });
    if (!r) return false;
    if (r.pic || r.metafile) return (ctx.toast('Picture bullets are not built for canvas drafts yet.'), false);
    return exe(ctx, 'list.define', defineAt(ctx, definedLevel(r)));
  },
});
const PRESETS = { article: 'article', headings: 'headings', roman: 'outlineHeadings', chapter: 'chapter' };
const changeLevel = exec('para.listLevel', (arg) => ({ level: Math.max(0, Math.min(8, Number(arg) | 0)) }),
  { state: CONTEXT, when: inList, value: (e) => (e?.value?.list ? String(e.value.list.level) : null) });

const LISTS = {
  'home.paragraph.bullets': listButton('bullet'),
  'home.paragraph.numbering': listButton('number'),
  'home.paragraph.multilevelList': {
    run: (ctx, arg) => {
      if (arg === undefined || arg === 'current') return true;
      if (arg === 'none') return contextOf(ctx)?.list ? exe(ctx, 'para.numbering', { off: true }) : false;
      const [src, id] = String(arg).split(/:(.*)/);
      if (src !== 'lib') return (ctx.toast('Lists from the document and list styles are not built for canvas drafts yet.'), false);
      if (PRESETS[id]) return exe(ctx, 'list.multilevelPreset', { preset: PRESETS[id] });
      const m = MULTILEVEL.find((x) => x.id === id);
      return !!m && exe(ctx, 'list.define', { ...(contextOf(ctx)?.list && { num: contextOf(ctx).list.num }), levels: m.levels.map(levelOf) });
    },
  },
  'home.paragraph.bullets.changeListLevel': changeLevel,
  'home.paragraph.numbering.changeListLevel': changeLevel,
  'home.paragraph.multilevelList.changeListLevel': changeLevel,
  'home.paragraph.multilevelList.all': APP, // the gallery's filter (front end)
  'home.paragraph.bullets.defineNewBullet': defineLevel('defineNewBullet', 'bullet'),
  'home.paragraph.numbering.defineNewNumberFormat': defineLevel('defineNewNumberFormat', 'number'),
  // Start new list sets the value from the caret on (para.setNumberingValue); Continue joins the list above. Advance value has
  // no engine form yet (G16), so it continues without skipping.
  'home.paragraph.numbering.setNumberingValue': {
    run: async (ctx) => {
      const l = listNow(ctx);
      const levels = ((await listLevels(ctx)) ?? []).map(appLevel);
      const lvl = levels[l?.level ?? 0];
      const label = (v) => (lvl ? labelText(lvl, levels, [...Array(l.level).fill(1), v]) : String(v));
      const r = await ctx.dialog('setNumberingValue', { value: lvl?.start ?? 1, canContinue: true, label });
      if (!r) return false;
      if (r.mode === 'continue') {
        if (r.advance) ctx.toast('Advance value is not built for canvas drafts yet, so the list continues without skipping.');
        return exe(ctx, 'para.continueNumbering');
      }
      return exe(ctx, 'para.setNumberingValue', { value: r.value });
    },
    enabled: (ctx) => !!listNow(ctx)?.numbered,
    reason: (ctx) => (listNow(ctx)?.numbered ? null : NOT_NUMBERED),
  },
  'home.paragraph.multilevelList.defineNewMultilevelList': {
    run: async (ctx) => {
      const l = listNow(ctx);
      const levels = l ? ((await listLevels(ctx)) ?? []).map(appLevel) : null;
      const r = await ctx.dialog('defineNewMultilevelList', { levels: levels?.length ? levels : MULTILEVEL[0].levels, inList: !!l });
      if (!r) return false;
      if (r.applyTo === 'forward') return (ctx.toast('Applying a list from this point forward is not built for canvas drafts yet.'), false);
      return exe(ctx, 'list.define', { ...(l && r.applyTo === 'whole' && { num: l.num }), levels: r.levels.map(definedLevel), ...(r.name && { name: r.name }) });
    },
  },
  // Define New List Style (G16): a new list and a list style (type numbering) holding it, in one engine step that numbers the
  // selection with it. "New documents based on this template" keeps it in this document, as on the DOM path.
  'home.paragraph.multilevelList.defineNewListStyle': {
    run: async (ctx) => {
      const levels = contextOf(ctx)?.list ? ((await listLevels(ctx)) ?? []).map(appLevel) : null;
      const r = await ctx.dialog('defineNewListStyle', { levels: levels?.length ? levels : MULTILEVEL[0].levels });
      if (!r?.name) return false;
      return exe(ctx, 'list.define', { levels: r.levels.map(definedLevel), name: r.name, listStyle: r.name });
    },
  },
  'lists.restart': exec('para.restartNumbering', {}, { state: CONTEXT, when: inList, active: () => false }),
  'lists.continue': exec('para.continueNumbering', {}, { state: CONTEXT, when: inList, active: () => false }),
  'lists.adjustIndents': {
    run: async (ctx) => {
      const l = listNow(ctx);
      const lvl = l && (await listLevels(ctx))?.[l.level];
      if (!lvl) return false;
      const r = await ctx.dialog('adjustListIndents', { pos: lvl.alignedAt, text: lvl.indentAt, suff: lvl.follow, tab: lvl.tabAt ?? null });
      if (!r) return false;
      return exe(ctx, 'list.define', { num: l.num, apply: false,
        levels: [...Array(l.level).fill({}), { alignedAt: r.pos, indentAt: r.text, follow: r.suff, tabAt: r.tab }] });
    },
    enabled: (ctx) => !!listNow(ctx),
    reason: inList,
  },
  // Word's List Bullet style (Ctrl+Shift+L): the engine adds the latent built-in style first when the document lacks it, as Word
  // does (para.style, cmd/para/style_get.rs).
  'styles.listBulletKey': exec('para.style', { style: 'ListBullet' }),
  'fieldsUi.listNumField': exec('insert.field', { instr: 'LISTNUM' }),
  'paste.listChoices': repasteRow('list'),
};

// ---------- Borders and Shading ----------
// Paragraph border kinds of the gallery's items (para.borders), and the table's (table.borders); null: no form on that target.
const PARA_KIND = { bottomBorder: 'bottom', topBorder: 'top', leftBorder: 'left', rightBorder: 'right', noBorder: 'none', allBorders: 'all',
  outsideBorders: 'outside', insideBorders: 'inside', insideHorizontalBorder: 'inside' };
const TABLE_KIND = { bottomBorder: 'bottom', topBorder: 'top', leftBorder: 'left', rightBorder: 'right', noBorder: 'none', allBorders: 'all',
  outsideBorders: 'outside', insideBorders: 'inside' };
const SIDES = { bottomBorder: ['bottom'], topBorder: ['top'], leftBorder: ['left'], rightBorder: ['right'], allBorders: ['top', 'left', 'bottom', 'right', 'between'],
  outsideBorders: ['top', 'left', 'bottom', 'right'], insideBorders: ['between'], insideHorizontalBorder: ['between'] };
const PEN_STYLES = new Set(['single', 'double', 'dotted', 'dashed', 'thick', 'triple', 'dotDash', 'wave']);

/** What the Borders and Shading items act on: 'cells' in a table, 'run' for a selection inside one paragraph, else 'paras'. */
async function borderTarget(ctx) {
  if (contextOf(ctx)?.table) return 'cells';
  const s = await ctx.engine.selection();
  const same = s && JSON.stringify(s.anchor?.path ?? s.anchor?.block) === JSON.stringify(s.head?.path ?? s.head?.block)
    && JSON.stringify(s.anchor) !== JSON.stringify(s.head);
  return same ? 'run' : 'paras';
}

/** The pen as para.borders' line: its style (when the engine has one by that name), width and colour. */
const penLine = () => {
  const p = hooks.pen();
  return { style: PEN_STYLES.has(p.style) ? p.style : 'single', width: p.width ?? 0.5, ...(hex(p.color) && { color: hex(p.color) }) };
};

async function applyBorder(ctx, item) {
  const t = await borderTarget(ctx);
  const pen = penLine();
  if (t === 'run') return exe(ctx, 'format.border', { value: item !== 'noBorder' });
  if (t === 'cells') {
    if (!TABLE_KIND[item]) return (ctx.toast('That border is not built for table cells on canvas drafts yet.'), false);
    return exe(ctx, 'table.borders', { kind: TABLE_KIND[item], width: pen.width, ...(pen.color && { color: pen.color }) });
  }
  if (!PARA_KIND[item]) return false;
  return exe(ctx, 'para.borders', { kind: PARA_KIND[item], ...pen });
}

/** Whether the caret paragraph shows `item`'s edges (the split button's pressed state); a run's border answers for any edge. */
const hasBorder = (ctx, item) => {
  const b = valueOf(ctx, PS)?.borders;
  const line = (side) => !!b?.[side] && b[side].style !== 'none';
  if (item === 'noBorder') return !SIDES.allBorders.some(line);
  return !!SIDES[item]?.every(line);
};

async function applyShading(ctx, color) {
  const t = await borderTarget(ctx);
  const c = hex(color);
  if (t === 'cells') return exe(ctx, 'table.shading', { color: c });
  return exe(ctx, t === 'run' ? 'format.shading' : 'para.shading', { color: c });
}

/** Borders and Shading with what the engine holds at the selection (wp/borders/canvas.mjs canvasRead); its OK writes engine steps.
 * `arg` may name the tab ({tab: 'pageBorder'}) and Apply to. */
async function bordersDialog(ctx, arg) {
  const value = (id) => Promise.resolve(ctx.engine.exec(id, {})).then((r) => r?.value ?? null, () => null);
  const [fs, ps, st, kind, sel] = await Promise.all([value(FS), value(PS), Promise.resolve(ctx.engine.state(['design.pageBorders'])).catch(() => null),
    borderTarget(ctx), ctx.engine.selection()]);
  const paras = Math.abs((sel?.head?.path?.[0] ?? 0) - (sel?.anchor?.path?.[0] ?? 0)) + 1;
  const engineRead = canvasRead({ fs, ps, context: contextOf(ctx), pages: st?.['design.pageBorders']?.value ?? null, kind, paras });
  return ctx.dialog('bordersAndShading', { tab: 'borders', ...(arg && typeof arg === 'object' ? arg : {}), engineRead });
}

const BORDERS = {
  'home.paragraph.borders': {
    run: async (ctx, arg) => {
      const item = EDGE_ITEMS.includes(arg) ? arg : last.border;
      const done = await applyBorder(ctx, item);
      if (done && EDGE_ITEMS.includes(arg)) last.border = arg;
      return done;
    },
    active: (ctx) => hasBorder(ctx, last.border),
    value: () => last.border,
  },
  'home.paragraph.borders.horizontalLine': 'insert.horizontalLine',
  'home.paragraph.borders.drawTable': { run: (ctx) => ctx.run('tableLayout.draw.drawTable') },
  'home.paragraph.borders.viewGridlines': exec('table.viewGridlines', {}),
  'home.paragraph.borders.bordersAndShading': { run: bordersDialog },
  'tableDesign.borders.launcher': { run: (ctx) => bordersDialog(ctx, { apply: 'table' }), enabled: (ctx) => !!contextOf(ctx)?.table },
  'home.paragraph.shading': {
    run: async (ctx, pick) => {
      const color = pick === undefined ? last.shade : pick && typeof pick === 'object' ? pick.color ?? null : pick;
      const done = await applyShading(ctx, color);
      if (done && pick !== undefined) last.shade = color;
      return done;
    },
    value: () => last.shade,
  },
  'home.paragraph.shading.moreColors': { run: moreColors((ctx, c) => ctx.run('home.paragraph.shading', c)) },
};

// ---------- Clipboard ----------
/** A Paste Options pick with the system clipboard `d` ({text, html, rtf, image}) → the engine step, or null. */
export function pasteStep(mode, d) {
  const all = { text: d.text || undefined, html: d.html || undefined, rtf: d.rtf || undefined };
  if (mode === 'keepTextOnly') return d.text ? ['edit.pasteText', { text: d.text }] : null;
  if (mode === 'mergeFormatting') return ['edit.pasteMerge', all];
  if (mode === 'picture') return d.image ? ['edit.pasteSpecial', { as: 'picture', picture: String(d.image).replace(/^data:[^,]*,/, '') }] : null;
  // Use Destination Styles and Theme have no form of their own yet (G29): they keep the source formatting.
  return ['edit.paste', all];
}
const paste = async (ctx, mode) => {
  const step = pasteStep(mode, await hooks.readClipboard());
  return step ? exe(ctx, ...step) : false;
};
const PASTE_SPECIAL = { html: 'html', png: 'picture', text: 'text' };
/** A Clipboard pane item ({html, text, image}) → its paste step with the source formatting: a picture alone pastes as one. */
export const ringStep = (it) => pasteStep(it.image && !it.html && !it.text ? 'picture' : null, it);

const CLIPBOARD = {
  'home.clipboard.paste': { run: (ctx, arg) => (arg == null ? hooks.nativePaste() : paste(ctx, arg)) },
  'paste.pasteTextOnly': { run: (ctx) => paste(ctx, 'keepTextOnly') },
  'home.clipboard.paste.pasteSpecial': {
    run: async (ctx) => {
      const data = await hooks.readClipboard();
      const as = await ctx.dialog('pasteSpecial', { data });
      if (!as) return false;
      if (as === 'png') return exe(ctx, 'edit.pasteSpecial', { as: 'picture', picture: String(data.image ?? '').replace(/^data:[^,]*,/, '') });
      return exe(ctx, 'edit.pasteSpecial', { as: PASTE_SPECIAL[as] ?? 'text', text: data.text || undefined, html: data.html || undefined });
    },
  },
  'home.clipboard.paste.setDefaultPaste': APP, // Word Options (the app's settings)
  'home.clipboard.formatPainter': exec('edit.formatPainter', (arg) => ({ sticky: !!arg?.sticky }), { state: 'edit.formatPainter' }),
  'home.clipboard.launcher': APP, // the app's Clipboard pane
  'panes.clipboard': APP,
  // Ctrl after a paste, or a click on the button over the page: the menu (hooks.pasteMenu); a pick runs that choice.
  'paste.optionsButton': { ...repasteRow(null), run: (ctx, pick) => (pick === undefined ? hooks.pasteMenu() : repasteRow(null).run(ctx, pick)) },
  'paste.tableChoices': repasteRow('table'),
  'editing.copyFormat': 'edit.copyFormat',
  // Off without a reason until formatting is copied, as on the DOM path (tool search leaves it out then).
  'editing.pasteFormat': { run: (ctx) => exe(ctx, 'edit.pasteFormat'), enabled: (ctx) => !!valueOf(ctx, MODES)?.painter },
  // The Spike: edit.spike cuts without touching the clipboard and answers the piece, which goes to the app's Spike.
  'editing.spike': {
    run: async (ctx) => {
      if (await caret(ctx)) return false;
      const r = await ctx.engine.exec('edit.spike', {});
      if (!r?.ok) return false;
      await hooks.spikeAdd({ html: r.value?.html ?? '', text: r.value?.text ?? '' });
      return true;
    },
  },
  'editing.insertSpike': {
    run: async (ctx) => {
      const done = await hooks.spikeInsert(({ html, text }) => exe(ctx, 'edit.paste', { html: html || undefined, text: text || undefined }));
      if (done === null) ctx.toast('The Spike is empty.');
      return !!done;
    },
  },
  'x.clipboard.pasteAll': {
    run: (ctx) => {
      const steps = pasteAllOrder(hooks.ringItems()).map(ringStep).filter(Boolean);
      return steps.length ? many(ctx, steps) : false;
    },
    enabled: () => hooks.ringItems().length > 0,
  },
  'x.clipboard.clearAll': { run: () => (hooks.clearRing(), true), enabled: () => hooks.ringItems().length > 0 },
  // The Clipboard pane's Paste on one item (its id), with the default option for its source.
  'x.clipboard.pasteItem': {
    run: (ctx, id) => {
      const it = hooks.ringItems().find((x) => x.id === id);
      const step = it && ringStep(it);
      return step ? exe(ctx, ...step) : false;
    },
  },
  'home.clipboard.cut': APP, // the window's own cut and copy reach the canvas input element (src/engine/input/clipboard.js)
  'home.clipboard.copy': APP,
};

// ---------- Editing keys ----------
/** Whether a board's focused document holds the keys (bd-hud): its undo is the board journal's, through the client's own. */
const boardDocument = () => getState().boardHud === 'document';

/** Undo and Redo there: the client's own, which bd-journal overrides, so the ribbon and Ctrl+Z undo one order. Elsewhere the
 * engine command, as before. */
const historyRow = (dir) => ({
  run: async (ctx) => {
    if (boardDocument() && ctx.engine?.[dir]) {
      await ctx.engine[dir]();
      return true;
    }
    return exe(ctx, dir === 'undo' ? 'edit.undo' : 'edit.redo');
  },
  enabled: (ctx) => (boardDocument() && !!ctx.engine ? true : ctx.stateOf?.(`edit.${dir}`)?.enabled ?? true),
  reads: [`edit.${dir}`],
});

/** Redo, else Repeat (F4, Ctrl+Y). Off with no reason while there is neither, as the DOM editor's button is. */
const redoRepeat = {
  run: async (ctx) => {
    // On a board's document Redo is the journal's, as Ctrl+Y is.
    if (boardDocument() && ctx.engine?.redo) {
      await ctx.engine.redo();
      return true;
    }
    const steps = await ctx.engine.steps?.();
    return exe(ctx, steps?.redo ? 'edit.redo' : 'edit.repeat');
  },
  enabled: (ctx) => (boardDocument() && !!ctx.engine ? true
    : ctx.stateOf?.('edit.redo')?.value !== false || ctx.stateOf?.('edit.repeat')?.value !== false),
  reads: ['edit.redo', 'edit.repeat'],
};

/** Whether selection `s` is a caret. */
const isCaret = (s) => !s || JSON.stringify(s.anchor) === JSON.stringify(s.head);
// Where F8 started (a caret), so Shift+F8 shrinks round it, as Word's Shrink Selection does.
let extendFrom = null;

/** F2 (move) or Shift+F2 (copy): the selection waits for Enter at the place it goes (canvasKey); Esc ends it. */
const moveMode = (copy) => ({
  run: async (ctx) => {
    const client = ctx.engine;
    const [s, steps] = await Promise.all([client.selection(), client.steps?.()]);
    if (isCaret(s)) return false;
    endMove();
    // The range is in engine positions, which any edit can shift, so a change to the document (its top undo or redo step is
    // another) ends the wait, as typing ends Word's. Layout slices and selection moves keep the steps.
    const same = (a, b) => (a?.undo ?? null) === (b?.undo ?? null) && (a?.redo ?? null) === (b?.redo ?? null);
    const off = client.on?.('layout', (e) => e?.steps && !same(e.steps, steps) && endMove());
    pending.move = { id: client.id, src: s, copy, off };
    hooks.setExtend(copy ? 'copy' : 'move');
    return true;
  },
  active: (ctx) => pending.move?.copy === copy && pending.move.id === ctx?.engine?.id,
});

/** Ctrl+Alt+PageUp and PageDown (Shift extends): the first or last line in the window. */
const windowEdge = (end, extend) => ({ run: () => hooks.windowEdge(end, extend) });

/** A key event on a canvas draft before Word's keys (src/engine/input keyHooks): Enter after F2 or Shift+F2 moves or copies the
 * text there; the letter after an accent prefix types its accented form. → the engine call to make, or null. */
export function canvasKey(e, client) {
  const mods = e.ctrlKey || e.altKey || e.metaKey;
  if (pending.prefix && !/^(Shift|Control|Alt|Meta|CapsLock)$/.test(e.key)) {
    const chord = pending.prefix;
    pending.prefix = null;
    const ch = !mods && e.key.length === 1 ? compose(chord, e.key) : null;
    return ch ? () => client.insertText(ch) : null; // a letter with no accented form types itself
  }
  // F2 in another draft: its positions mean nothing here.
  if (pending.move && pending.move.id !== client.id) endMove();
  if (pending.move && e.key === 'Enter' && !mods && !e.shiftKey) {
    const { src, copy } = pending.move;
    endMove();
    return () => client.exec('edit.moveTo', { anchor: src.anchor, focus: src.head, copy });
  }
  if (pending.move && e.key === 'Escape') {
    endMove();
    return () => true;
  }
  return null;
}

const EDITING = {
  'frame.qat.undo': historyRow('undo'),
  'draw.undo.undo': historyRow('undo'),
  'frame.qat.redoRepeat': redoRepeat,
  'draw.undo.redoRepeat': redoRepeat,
  'editing.redoKey': historyRow('redo'),
  // F8 grows the selection a step (word, sentence, paragraph, document); Extend mode's arrows are not built yet.
  'selection.extend': {
    run: async (ctx) => {
      const s = await ctx.engine.selection();
      if (isCaret(s)) extendFrom = s?.head ?? null;
      return exe(ctx, 'select.extend');
    },
  },
  'selection.shrink': exec('select.shrink', () => (extendFrom ? { at: extendFrom } : {})),
  'selection.columnSelect': exec('select.column', {}, { state: MODES, active: field('column') }),
  'editing.cancel': {
    run: async (ctx) => {
      const m = valueOf(ctx, MODES) ?? {};
      const steps = [['select.collapse', {}], ...(m.column ? [['select.column', { on: false }]] : []), ...(m.painter ? [['edit.formatPainter', {}]] : [])];
      last.pen = null;
      endMove();
      pending.prefix = null;
      for (const [id, args] of steps) await exe(ctx, id, args);
      return true;
    },
  },
  'editing.move': moveMode(false),
  'editing.copyTo': moveMode(true),
  'navigation.goBack': 'edit.goBack',
  'navigation.paraUp': exec('caret.paraUp', {}),
  'navigation.paraDown': exec('caret.paraDown', {}),
  'selection.paraUpExtend': exec('caret.paraUp', { extend: true }),
  'selection.paraDownExtend': exec('caret.paraDown', { extend: true }),
  'navigation.startOfWindow': windowEdge(false, false),
  'navigation.endOfWindow': windowEdge(true, false),
  'selection.startOfWindowExtend': windowEdge(false, true),
  'selection.endOfWindowExtend': windowEdge(true, true),
  'chars.nbsp': 'text.nbsp',
  'chars.nbHyphen': 'text.nbHyphen',
  'chars.enDash': exec('text.insert', { text: '–', raw: true }),
  'chars.emDash': 'text.emDash',
  // The prefix chord (Ctrl+', Ctrl+Shift+6...) waits for the next letter (canvasKey); keys.mjs passes the chord pressed.
  'chars.accentPrefixes': { run: (_ctx, chord) => ((pending.prefix = chord ?? null), true) },
  'editing.overtype': exec('text.overtype', {}, { state: MODES, active: field('overtype') }),
  // G22: several ranges at once (doc-edit's cmd/multi.rs). Other modules select several through the registry with
  // [{anchor, focus}] in the engine's positions (the DOM editor's form is [{from, to}]); the last range is the active one.
  'x.selection.multi': exec('select.ranges', (ranges) => (Array.isArray(ranges) && ranges.length ? { ranges } : null)),
  'window.closeWindow': APP,
  'home.editing.select.selectAll': 'select.all',
  'home.voice.dictate': APP,
  'home.voice.dictate.dictate': APP,
};

// ---------- Find, symbols, tabs, AutoCorrect ----------
const OTHER = {
  // The Navigation pane's search (its pane belongs to the Review package, which reads the engine there).
  'home.editing.find': APP,
  'home.editing.find.find': APP,
  // find/actions.js searches through the engine on a canvas draft (Find, Replace, Replace All, Reading Highlight, Go To a page
  // or a bookmark), so Find and Replace, Shift+F4 and browse run as registered.
  'home.editing.find.advancedFind': APP,
  'home.editing.replace': APP,
  'home.editing.find.goTo': APP,
  'home.editing.select.selectAllTextWithSimilarFormattingNoData': 'select.similar',
  'find.repeatFind': APP,
  'find.browseNext': APP,
  'find.browsePrev': APP,
  'find.browseSel': APP,
  // symbols/insert.js inserts through the engine on a canvas draft, so the module's commands and its dialogs run as registered.
  'insert.symbols.symbol': APP,
  'insert.symbols.symbol.moreSymbols': APP,
  'insert.symbols.number': APP,
  'chars.symbols': APP,
  'chars.altX': 'text.toggleUnicode',
  'tabs.dialog': {
    run: async (ctx, arg) => {
      const [para, settings] = await Promise.all([ctx.engine.exec(PS, {}), ctx.engine.exec('document.settings', {})]);
      return ctx.dialog('tabs', { ...(arg && typeof arg === 'object' ? arg : {}), enginePara: para?.value ?? null, engineSettings: settings?.value ?? null });
    },
  },
  // The Alignment Tab dialog returns its choices on a canvas draft (tabs/dialogs.jsx AlignmentTabDialog `engine`).
  'headerFooter.position.insertAlignmentTab': {
    run: async (ctx) => {
      const r = await ctx.dialog('alignmentTab', { engine: true });
      return r ? exe(ctx, 'text.alignmentTab', r) : false;
    },
  },
  'chars.tabInCell': 'text.insertTab',
  'autocorrect.dialog': APP, // the app's AutoCorrect settings
  // AutoFormat Now: the app's own rules (autocorrect/rules.mjs) on the engine's paragraphs, the edits applied as one undo step.
  'autoformat.autoFormatNow': {
    run: async (ctx) => {
      const paras = (await ctx.engine.query('text.paragraphs', {}))?.value ?? [];
      const plan = hooks.autoFormatPlan(paras);
      if (!plan || (!plan.edits.length && !plan.headings.length)) return false;
      return exe(ctx, 'text.applyEdits', plan);
    },
  },
};

/** {toolingId: row}. */
export const HOME = { ...FONT, ...PARAGRAPH, ...STYLES, ...LISTS, ...BORDERS, ...CLIPBOARD, ...EDITING, ...OTHER };
