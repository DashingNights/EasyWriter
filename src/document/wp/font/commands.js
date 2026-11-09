// The font package's commands and galleries (docs/plans/word/plan.md §1.3, §1.4; briefs/font.md): every Home > Font control and
// menu item, the font.* key features, and the providers of the Font and Font Size combos, the Underline menu and the Text Effects
// and Typography and Gradient submenus. Every character command acts on the whole word when the caret is strictly inside one
// (extension.js onWord). Agents' doc.format goes through setRunProps, never through these.
import { createElement as h } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { fontStack, HIGHLIGHTS, resolveColor, STANDARD_COLORS, STANDARD_NAMES } from '../../../office.mjs';
import { saveWord } from '../../word/settings.mjs';
import { THEME } from '../../defaults.mjs';
import { fontLabel, fontsNow } from '../../fonts.js';
import { effectiveProps } from '../../schema.js';
import { changeCase, nextCase } from './case.mjs';
import { armedPen, lastUnderline, onWord, patchRuns, posText, runsOf, setPen, underlined, wordRange } from './extension.js';
import { stripRuns } from '../fields-core/runs.mjs';
import { afterMouseSelect } from '../../../engine/input/pointer.js';
import { highlighter } from '../../canvas/rows/home.mjs';
import { charPropsOf, LIGATURES, NUMBER_STYLES, parseSize, RESET_MARKS, resetMarks, SIZES, textEffectsParams, toggleWrite, UNDERLINE_MENU } from './run.mjs';

// On a canvas draft the armed highlighter pen highlights each mouse selection (src/document/canvas/rows/home.mjs).
afterMouseSelect.add((client) => highlighter.afterSelect(client));

// ---------- helpers ----------
/** Runs `fn(props)` as one focused command on `ctx`'s target, on the whole word when the caret is strictly inside one. */
export const apply = (ctx, fn, edge = false) => ctx.chain((c) => c.command((p) => onWord(p, () => fn(p), edge)));

const textStyleOf = (marks) => marks.find((m) => m.type.name === 'textStyle')?.attrs ?? {};
const has = (marks, name) => marks.some((m) => m.type.name === name);
const underlineOf = (v) => (v == null || v === false ? null : typeof v === 'object' ? { val: v.val ?? 'single', color: v.color ?? null } : { val: v === true ? 'single' : v, color: null });

/** The run object (plan.md §1.6 value mode) text with `marks` in `parent` shows: its own formatting, else its style's. */
export function runOf(doc, marks, parent) {
  const ts = textStyleOf(marks);
  const st = effectiveProps(doc, parent).run;
  const pick = (k, d = null) => ts[k] ?? st[k] ?? d;
  const u = marks.find((m) => m.type.name === 'underline');
  return {
    font: pick('font', '+minor'), fontEA: pick('fontEA'), fontCS: pick('fontCS'), size: pick('size', 12), sizeCS: pick('sizeCS'),
    bold: has(marks, 'bold') || !!st.bold, italic: has(marks, 'italic') || !!st.italic,
    color: ts.color ?? st.color ?? null, themeColor: ts.color != null ? ts.themeColor ?? null : st.themeColor ?? null,
    underline: u ? { val: u.attrs.val ?? 'single', color: u.attrs.color ?? null } : underlineOf(st.underline), em: pick('em'),
    strike: has(marks, 'strike') || !!st.strike, dstrike: !!pick('dstrike', false), superscript: has(marks, 'superscript'), subscript: has(marks, 'subscript'),
    smallCaps: !!pick('smallCaps', false), caps: !!pick('caps', false), vanish: !!pick('vanish', false),
    scale: pick('scale', 100), spacing: pick('spacing', 0), position: pick('position', 0), kern: pick('kern'),
    typography: { ...st.typography, ...ts.typography }, effects: pick('effects'),
  };
}

/** The run objects of `state`'s selection (or the caret's). */
export const selectionRuns = (state) => runsOf(state).map((r) => runOf(state.doc, r.marks, r.parent));

const MARKS = ['bold', 'italic', 'strike', 'subscript', 'superscript'];
const BOOLS = new Set(['dstrike', 'smallCaps', 'caps', 'vanish']);
// The value a property has when nothing sets it: writing it means back to the style.
const NEUTRAL = { scale: 100, spacing: 0, position: 0 };

/** Applies `changes` (a run object's changed keys, from the Font dialog) to `ctx`'s selection: marks through their commands, the
 * rest into textStyle, each boolean written against its paragraph's style (toggleWrite). */
export function applyRun(ctx, changes) {
  if (ctx.engine) {
    // The Font dialog's Text Effects... changes go as format.textEffects in the same undo step (G6).
    const steps = [['format.set', { props: charPropsOf(changes) }], ...(changes.effects ? [['format.textEffects', textEffectsParams(changes.effects)]] : [])];
    return Promise.resolve(ctx.engine.execMany(steps)).then((r) => !!r?.ok);
  }
  return apply(ctx, (p) => {
    const c = p.commands;
    for (const m of MARKS) if (m in changes) (changes[m] ? c.setMark(m) : c.unsetMark(m));
    if ('underline' in changes) (changes.underline?.val ? c.setMark('underline', { val: changes.underline.val, color: changes.underline.color ?? null }) : c.unsetMark('underline'));
    const rest = Object.entries(changes).filter(([k]) => !MARKS.includes(k) && k !== 'underline');
    if (!rest.length) return true;
    return patchRuns(p, (_old, parent) => {
      const st = effectiveProps(p.state.doc, parent).run;
      return Object.fromEntries(rest.map(([k, v]) => [k, BOOLS.has(k) ? toggleWrite(!!v, st[k]) : v === NEUTRAL[k] && st[k] == null ? null : v]));
    });
  });
}

/** Toggles boolean run property `key` over the selection: on unless every run shows it, each written against its style. */
function toggleRun(ctx, key) {
  return apply(ctx, (p) => {
    const on = runsOf(p.state).every((r) => runOf(p.state.doc, r.marks, r.parent)[key]);
    return patchRuns(p, (_old, parent) => ({ [key]: toggleWrite(!on, effectiveProps(p.state.doc, parent).run[key]) }));
  });
}
const runActive = (key) => (ctx) => !!ctx.state && selectionRuns(ctx.state).every((r) => r[key]);

/** Toggles underline style `val` (double, words): off when every run has it, else on. */
function toggleUnderline(ctx, val) {
  return apply(ctx, (p) => {
    const all = runsOf(p.state).every((r) => r.marks.find((m) => m.type.name === 'underline')?.attrs.val === val);
    return all ? p.commands.unsetMark('underline') : p.commands.setMark('underline', { val });
  });
}
const underlineIs = (val) => (ctx) => !!ctx.state && runsOf(ctx.state).every((r) => r.marks.find((m) => m.type.name === 'underline')?.attrs.val === val);

/** Toggles a JSON run property `key` to `on` (Character Border, Character Shading): off when every run has one. */
function toggleObject(ctx, key, on) {
  return apply(ctx, (p) => {
    const all = runsOf(p.state).every((r) => textStyleOf(r.marks)[key]);
    return patchRuns(p, () => ({ [key]: all ? null : on }));
  });
}
const objectActive = (key) => (ctx) => !!ctx.state && runsOf(ctx.state).every((r) => textStyleOf(r.marks)[key]);

/** Sets run properties `patch` over the selection (the whole word inside one). */
const setRun = (ctx, patch) => apply(ctx, (p) => patchRuns(p, () => patch));

/** Reset Char (Ctrl+Space, Ctrl+Shift+Z): removes the direct character formatting, keeping links, comments, revisions, permissions,
 * the language and Do not check spelling (run.mjs resetMarks). */
function resetChar(ctx) {
  return apply(ctx, (p) => {
    const { state, tr, dispatch } = p;
    if (!dispatch) return true;
    const ts = state.schema.marks.textStyle;
    const rebuild = (marks) => resetMarks(marks.map((m) => ({ type: m.type.name, attrs: m.attrs, mark: m }))).map((x) => x.mark ?? ts.create(x.attrs));
    if (state.selection.empty) {
      tr.setStoredMarks(rebuild(state.storedMarks ?? state.selection.$from.marks()));
      return true;
    }
    for (const { $from: { pos: from }, $to: { pos: to } } of state.selection.ranges) {
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isInline) return;
        const a = Math.max(from, pos);
        const b = Math.min(to, pos + node.nodeSize);
        for (const name of [...RESET_MARKS, 'textStyle']) if (state.schema.marks[name]) tr.removeMark(a, b, state.schema.marks[name]);
        const kept = rebuild(node.marks).find((m) => m.type === ts);
        if (kept) tr.addMark(a, b, kept);
      });
      stripRuns(tr, from, to, resetMarks); // a field result's own runs, which removeMark misses
    }
    return true;
  });
}

/** Whether the text at resolved `$pos` belongs to a content control that keeps it: one inside a contentLocked or sdtContentLocked
 * control, or directly inside a group. Change Case skips that text so the rest of the selection still changes: content-controls'
 * lockRefusal would refuse the whole step otherwise. */
function lockedText($pos) {
  let nearest = true;
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d);
    if (n.type.name !== 'sdtInline' && n.type.name !== 'sdtBlock') continue;
    const { lock, type } = n.attrs.sdt ?? {};
    if (lock === 'contentLocked' || lock === 'sdtContentLocked' || (nearest && type === 'group')) return true;
    nearest = false;
  }
  return false;
}

/** Change Case to `mode` (a case.mjs mode, or undefined for Shift+F3's next case) over the selection, else the word at the
 * caret, which keeps its place. Characters change one for one inside each text node, so the marks stay. */
function changeCaseOf(ctx, mode) {
  return ctx.chain((c) => c.command((p) => {
    const { state, tr, dispatch } = p;
    const sel = state.selection;
    let { from, to } = sel;
    if (sel.empty) {
      const r = wordRange(state, true);
      if (!r) return false;
      ({ from, to } = r);
    }
    const m = mode ?? nextCase(state.doc.textBetween(from, to, '\n', '￼'));
    if (!m) return false;
    if (!dispatch) return true;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true;
      const a = Math.max(from, pos + 1);
      const b = Math.min(to, pos + 1 + node.content.size);
      if (a >= b) return false;
      // One character per position, so the text inside a content control and after one lines up with its place.
      const was = posText(node).slice(a - pos - 1, b - pos - 1);
      const now = changeCase(was, m);
      node.descendants((child, off) => {
        const x = Math.max(a, pos + 1 + off);
        const y = Math.min(b, pos + 1 + off + child.nodeSize);
        if (!child.isText || x >= y || now.slice(x - a, y - a) === was.slice(x - a, y - a) || lockedText(state.doc.resolve(x))) return;
        // Same length and only text replaced, so the positions of later text nodes stay valid in tr.
        tr.replaceWith(x, y, state.schema.text(now.slice(x - a, y - a), child.marks));
      });
      return false;
    });
    tr.setSelection(TextSelection.create(tr.doc, sel.anchor, sel.head));
    return true;
  }));
}

// ---------- session state ----------
const last = { highlight: 'yellow', color: { color: '#FF0000', themeColor: null } };
const recentFonts = []; // Recently Used Fonts, this session, newest first (Word keeps them across sessions; v)

const themeOf = (ctx) => ctx.state?.doc.attrs.theme ?? THEME;
const attrs = (ctx) => (ctx.target ? ctx.target.getAttributes('textStyle') : {});

/** Applies font `name` ('+major', '+minor' or a family) and records it as recently used. */
function setFont(ctx, name) {
  if (!name.startsWith('+')) {
    const i = recentFonts.indexOf(name);
    if (i >= 0) recentFonts.splice(i, 1);
    recentFonts.unshift(name);
    recentFonts.length = Math.min(recentFonts.length, 10);
  }
  return setRun(ctx, { font: name });
}

// ---------- galleries ----------
let fontMemo = null;
/** The Font combo's rows (§1.4 rendering contract): Theme Fonts, Recently Used Fonts and All Fonts, each name in its face. Recent
 * rows carry a 'recent:' id so ids stay unique; the command strips it. */
function fontItems(ctx) {
  const theme = themeOf(ctx);
  const all = fontsNow();
  const key = [theme, all, recentFonts.join('|')];
  if (fontMemo && key.every((v, i) => v === fontMemo.key[i])) return fontMemo.items;
  const row = (id, name, label, group) => ({ id, label, group, preview: h('span', { style: { fontFamily: fontStack(name, theme) } }, label) });
  const items = [
    row('+major', '+major', `${fontLabel(theme.fonts?.major ?? 'Aptos Display')} (Headings)`, 'Theme Fonts'),
    row('+minor', '+minor', `${fontLabel(theme.fonts?.minor ?? 'Aptos')} (Body)`, 'Theme Fonts'),
    ...recentFonts.map((f) => row(`recent:${f}`, f, fontLabel(f), 'Recently Used Fonts')),
    ...all.map((f) => row(f, f, fontLabel(f), 'All Fonts')),
  ];
  fontMemo = { key, items };
  return items;
}

const SIZE_ITEMS = SIZES.map((s) => ({ id: String(s), label: String(s) }));
const swatch = (background, label) => h('span', { className: 'flex items-center gap-2' },
  h('span', { className: 'inline-block size-4 rounded-xs ring-1 ring-foreground/20', style: { background } }), label);
const line = (style, label) => h('span', { className: 'flex items-center gap-3' },
  h('span', { className: 'inline-block w-16 border-b-2 border-current', style: { borderBottomStyle: style } }), label);

const UNDERLINE_LOOK = { single: 'solid', double: 'double', thick: 'solid', dotted: 'dotted', dash: 'dashed', dotDash: 'dashed', dotDotDash: 'dotted', wave: 'solid' };
const UNDERLINE_LABELS = { underline: 'Underline', doubleUnderline: 'Double underline', thickUnderline: 'Thick underline', dottedUnderline: 'Dotted underline',
  dashedUnderline: 'Dashed underline', dotDashUnderline: 'Dot-dash underline', dotDotDashUnderline: 'Dot-dot-dash underline', waveUnderline: 'Wave underline',
  noUnderline: 'No underline' };
const underlineNow = (ctx) => (ctx.engine ? ctx.stateOf?.('format.state')?.value?.underlineStyle ?? null
  : ctx.target?.isActive('underline') ? ctx.target.getAttributes('underline').val ?? 'single' : null);

// Theme accents and the standard colours for the outline and glow submenus, as [hex, name]: the name is the visible label, as in
// the Font Color grid.
const accentColors = (ctx) => [1, 2, 3, 4, 5, 6].map((n) => [themeOf(ctx).colors?.[`accent${n}`], `Accent ${n}`]).filter(([c]) => c);
const STANDARD_NAMED = STANDARD_COLORS.map((c, i) => [c, STANDARD_NAMES[i]]);
const OUTLINE_WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6];
const DASHES = [['solid', 'Solid'], ['dot', 'Round Dot'], ['dash', 'Dash'], ['dashDot', 'Dash Dot'], ['longDash', 'Long Dash']];
// Shadow presets (Word's Outer row): the direction the shadow falls, as an angle in degrees.
const SHADOWS = [['outerBR', 'Offset: Bottom Right', 45], ['outerB', 'Offset: Bottom', 90], ['outerBL', 'Offset: Bottom Left', 135], ['outerR', 'Offset: Right', 0],
  ['outerC', 'Offset: Center', null], ['outerL', 'Offset: Left', 180], ['outerTR', 'Offset: Top Right', -45], ['outerT', 'Offset: Top', -90], ['outerTL', 'Offset: Top Left', -135]];
const REFLECTIONS = [['tight', 'Tight Reflection', 30], ['half', 'Half Reflection', 50], ['full', 'Full Reflection', 90]];

// A tint (lum > 0, toward white) or shade (lum < 0) of `hex`, the theme colour maths of the colour grid.
const mix = (hex, lum) => resolveColor({ colors: { c: hex } }, { slot: 'c', lum });
const GRADIENT_ANGLES = [[90, 'Linear Down'], [0, 'Linear Right'], [270, 'Linear Up'], [180, 'Linear Left']];
/** The Gradient submenu's presets for colour `base`: light and dark variations in four directions → {id: fill}. */
function gradients(base) {
  const out = {};
  GRADIENT_ANGLES.forEach(([angle], i) => {
    out[`light${i}`] = { type: 'gradient', angle, stops: [{ pos: 0, color: mix(base, 0.6) }, { pos: 100, color: base }] };
    out[`dark${i}`] = { type: 'gradient', angle, stops: [{ pos: 0, color: base }, { pos: 100, color: mix(base, -0.5) }] };
  });
  return out;
}
const colorNow = (ctx) => attrs(ctx).color ?? '#404040';
const effectsNow = (ctx) => attrs(ctx).effects ?? {};
/** The typography at the selection: on a canvas draft from format.state (stage2.md G41), the engine's names as the DOM's. */
const typographyNow = (ctx) => {
  if (ctx.engine) {
    const fs = ctx.stateOf?.('format.state')?.value;
    return { numForm: fs?.numForm ?? null, numSpacing: fs?.numSpacing ?? null, stylisticSet: fs?.stylisticSet || null, contextual: fs?.contextualAlternates ?? null };
  }
  return ctx.state ? selectionRuns(ctx.state)[0]?.typography ?? {} : {};
};

const GALLERIES = {
  'home.font.font': fontItems,
  'home.font.fontSize': () => SIZE_ITEMS,
  // Replaces base's provider of the same id (§1.2): the nine styles drawn as lines.
  'home.font.underline': (ctx) => Object.entries(UNDERLINE_MENU).map(([id, val]) => ({
    id, label: UNDERLINE_LABELS[id], active: underlineNow(ctx) === val, preview: val ? line(UNDERLINE_LOOK[val], UNDERLINE_LABELS[id]) : UNDERLINE_LABELS[id],
  })),
  'home.font.fontColor.gradient': (ctx) => {
    const g = gradients(colorNow(ctx));
    const fill = effectsNow(ctx).fill;
    return [
      { id: 'none', label: 'No Gradient', active: fill?.type !== 'gradient' },
      ...GRADIENT_ANGLES.map(([, label], i) => ({ id: `light${i}`, label, group: 'Light Variations', preview: swatch(`linear-gradient(${g[`light${i}`].angle}deg, ${g[`light${i}`].stops.map((s) => s.color).join(', ')})`, label) })),
      ...GRADIENT_ANGLES.map(([, label], i) => ({ id: `dark${i}`, label, group: 'Dark Variations', preview: swatch(`linear-gradient(${g[`dark${i}`].angle}deg, ${g[`dark${i}`].stops.map((s) => s.color).join(', ')})`, label) })),
      { id: 'more', label: 'More Gradients...' },
    ];
  },
  'home.font.textEffectsAndTypography.outline': (ctx) => {
    const o = effectsNow(ctx).outline;
    return [
      { id: 'none', label: 'No Outline', active: !o },
      ...[...accentColors(ctx), ...STANDARD_NAMED].map(([c, name]) => ({ id: `color:${c}`, label: name, group: 'Colors', active: o?.color === c, preview: swatch(c, name) })),
      ...OUTLINE_WEIGHTS.map((w) => ({ id: `weight:${w}`, label: `${w} pt`, group: 'Weight', active: o?.width === w })),
      { id: 'more', label: 'More Outline Colors...', group: 'Colors' },
      ...DASHES.map(([d, label]) => ({ id: `dash:${d}`, label, group: 'Dashes', active: (o?.dash ?? 'solid') === d && !!o })),
    ];
  },
  'home.font.textEffectsAndTypography.shadow': (ctx) => [
    { id: 'none', label: 'No Shadow', active: !effectsNow(ctx).shadow },
    ...SHADOWS.map(([id, label]) => ({ id, label, group: 'Outer', active: effectsNow(ctx).shadow?.preset === id })),
    { id: 'options', label: 'Shadow Options...' },
  ],
  'home.font.textEffectsAndTypography.reflection': (ctx) => [
    { id: 'none', label: 'No Reflection', active: !effectsNow(ctx).reflection },
    ...REFLECTIONS.map(([id, label]) => ({ id, label, group: 'Reflection Variations', active: effectsNow(ctx).reflection?.preset === id })),
    { id: 'options', label: 'Reflection Options...' },
  ],
  'home.font.textEffectsAndTypography.glow': (ctx) => [
    { id: 'none', label: 'No Glow', active: !effectsNow(ctx).glow },
    ...accentColors(ctx).map(([c, name]) => ({ id: `glow:${c}`, label: `${name}, 5 pt glow`, group: 'Glow Variations', active: effectsNow(ctx).glow?.color === c, preview: swatch(c, `${name}, 5 pt glow`) })),
    { id: 'more', label: 'More Glow Colors' },
    { id: 'options', label: 'Glow Options...' },
  ],
  'home.font.textEffectsAndTypography.numberStyles': (ctx) => Object.entries(NUMBER_STYLES).map(([id, [label, sp, form]]) => ({
    id, label, active: (typographyNow(ctx).numSpacing ?? null) === sp && (typographyNow(ctx).numForm ?? null) === form,
  })),
  'home.font.textEffectsAndTypography.ligatures': (ctx) => LIGATURES.map(([id, label]) => ({ id, label, active: (typographyNow(ctx).ligatures ?? 'none') === id })),
  'home.font.textEffectsAndTypography.stylisticSets': (ctx) => [
    { id: 'default', label: 'Default', active: !typographyNow(ctx).stylisticSet },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `ss${i + 1}`, label: String(i + 1), group: 'Individual', active: typographyNow(ctx).stylisticSet === i + 1 })),
    { id: 'contextual', label: 'Use Contextual Alternates', active: !!typographyNow(ctx).contextual },
  ],
};

// The providers a canvas draft gets too (registry galleryOf): they read the app's lists, the theme or ctx.stateOf, not the editor.
for (const id of ['home.font.font', 'home.font.fontSize', 'home.font.underline', 'home.font.fontColor.gradient', 'home.font.textEffectsAndTypography.outline',
  'home.font.textEffectsAndTypography.shadow', 'home.font.textEffectsAndTypography.reflection', 'home.font.textEffectsAndTypography.glow',
  'home.font.textEffectsAndTypography.ligatures', 'home.font.textEffectsAndTypography.numberStyles',
  'home.font.textEffectsAndTypography.stylisticSets']) GALLERIES[id].engine = true;

// ---------- commands ----------
const dialog = (ctx, id, props) => {
  ctx.dialog(id, props);
  return true;
};
const effects = (ctx, patch) => setRun(ctx, { effects: patch });
const typography = (ctx, patch) => setRun(ctx, { typography: patch });

/** Picks the underline or font colour arg: {color, themeColor} from the colour panel, '#RRGGBB', or null for Automatic. */
const colorArg = (arg) => (arg && typeof arg === 'object' ? arg : { color: arg ?? null, themeColor: null });

function setUnderlineColor(ctx, arg) {
  const { color } = colorArg(arg);
  return apply(ctx, (p) => (underlined(p.state) ? p.commands.setMark('underline', { color }) : p.commands.setMark('underline', { val: lastUnderline.val, color })));
}

async function moreColors(ctx, then) {
  const hex = await ctx.dialog('colors', { value: null });
  if (!hex) return false;
  const word = ctx.settings?.word ?? {};
  saveWord({ recentColors: [hex, ...(word.recentColors ?? []).filter((c) => c !== hex)].slice(0, 10) });
  return then(hex);
}

const CASE_ITEMS = ['sentenceCase', 'lowercase', 'UPPERCASE', 'capitalizeEachWord', 'tOGGLECASE', 'halfWidth', 'fullWidth'];

export const COMMANDS = {
  'home.font.font': {
    value: ({ T }) => T.font.value,
    run: (ctx, arg) => {
      const text = String(arg ?? '').trim();
      if (!text) return false;
      const id = text.replace(/^recent:/, '');
      const hit = fontItems(ctx).find((i) => i.label.toLowerCase() === id.toLowerCase());
      return setFont(ctx, hit && hit.id.startsWith('+') ? hit.id : id); // a typed name that is not installed is accepted, as in Word
    },
    repeatable: true,
  },
  'home.font.fontSize': {
    value: ({ T }) => T.size.value,
    // Ctrl+Shift+P runs it with no value: the Font dialog with its Size box focused.
    run: (ctx, arg) => {
      if (arg === undefined) return dialog(ctx, 'font', { focus: 'size' });
      const size = parseSize(arg);
      return size == null ? (ctx.toast('The size must be a number from 1 to 1638.'), false) : setRun(ctx, { size });
    },
    repeatable: true,
  },
  'font.growOnePoint': { run: (ctx) => ctx.chain((c) => c.growFont1()), repeatable: true },
  'font.shrinkOnePoint': { run: (ctx) => ctx.chain((c) => c.shrinkFont1()), repeatable: true },
  'home.font.changeCase': { run: (ctx, arg) => changeCaseOf(ctx, CASE_ITEMS.includes(arg) ? arg : undefined), repeatable: true },
  ...Object.fromEntries(CASE_ITEMS.map((m) => [`home.font.changeCase.${m}`, { run: (ctx) => changeCaseOf(ctx, m), repeatable: true }])),
  'home.font.phoneticGuide': { run: (ctx) => dialog(ctx, 'phoneticGuide') },
  'home.font.characterBorder': {
    run: (ctx) => toggleObject(ctx, 'border', { style: 'single', width: 0.5, space: 0, color: null }), active: objectActive('border'), repeatable: true,
  },
  'home.font.characterShading': {
    run: (ctx) => toggleObject(ctx, 'shading', { val: 'pct15', color: null, fill: '#FFFFFF' }), active: objectActive('shading'), repeatable: true,
  },
  'home.font.underline': {
    run: (ctx, arg) => {
      if (arg === undefined) return ctx.chain((c) => c.toggleUnderline());
      if (!(arg in UNDERLINE_MENU)) return false;
      const val = UNDERLINE_MENU[arg];
      if (!val) return apply(ctx, (p) => p.commands.unsetMark('underline'));
      lastUnderline.val = val;
      return apply(ctx, (p) => p.commands.setMark('underline', { val }));
    },
    active: (ctx) => !!ctx.target?.isActive('underline'),
    value: (ctx) => Object.keys(UNDERLINE_MENU).find((k) => UNDERLINE_MENU[k] === underlineNow(ctx)) ?? null,
    repeatable: true,
  },
  'home.font.underline.moreUnderlines': { run: (ctx) => dialog(ctx, 'font', { focus: 'underline' }) },
  'home.font.underline.underlineColor': { run: (ctx, arg) => setUnderlineColor(ctx, arg), repeatable: true },
  'home.font.underline.underlineColor.moreColors': { run: (ctx) => moreColors(ctx, (hex) => setUnderlineColor(ctx, hex)) },
  'font.underlineColor': { run: (ctx, arg) => setUnderlineColor(ctx, arg) },
  'font.doubleUnderline': { run: (ctx) => toggleUnderline(ctx, 'double'), active: underlineIs('double'), repeatable: true },
  'font.wordUnderline': { run: (ctx) => toggleUnderline(ctx, 'words'), active: underlineIs('words'), repeatable: true },
  'font.doubleStrikethrough': { run: (ctx) => toggleRun(ctx, 'dstrike'), active: runActive('dstrike'), repeatable: true },
  'font.smallCaps': { run: (ctx) => toggleRun(ctx, 'smallCaps'), active: runActive('smallCaps'), repeatable: true },
  'font.allCaps': { run: (ctx) => toggleRun(ctx, 'caps'), active: runActive('caps'), repeatable: true },
  'font.hidden': { run: (ctx) => toggleRun(ctx, 'vanish'), active: runActive('vanish'), repeatable: true },
  // Word's model: the run's font becomes Symbol; how it looks depends on the installed font.
  'font.symbolFont': { run: (ctx) => setFont(ctx, 'Symbol'), repeatable: true },
  'font.resetChar': { run: (ctx) => resetChar(ctx), repeatable: true },
  // Values from tool search or other packages; with none, the Font dialog's Advanced tab.
  'font.scale': { run: (ctx, pct) => (pct >= 1 && pct <= 600 ? setRun(ctx, { scale: pct === 100 ? null : Math.round(pct) }) : dialog(ctx, 'font', { tab: 'advanced' })) },
  'font.spacing': { run: (ctx, pt) => (Number.isFinite(pt) ? setRun(ctx, { spacing: pt || null }) : dialog(ctx, 'font', { tab: 'advanced' })) },
  'font.position': { run: (ctx, pt) => (Number.isFinite(pt) ? setRun(ctx, { position: pt || null }) : dialog(ctx, 'font', { tab: 'advanced' })) },
  'font.kerning': { run: (ctx, pt) => (pt === null || Number.isFinite(pt) ? setRun(ctx, { kern: pt }) : dialog(ctx, 'font', { tab: 'advanced' })) },
  'font.openType': { run: (ctx, patch) => (patch && typeof patch === 'object' ? typography(ctx, patch) : dialog(ctx, 'font', { tab: 'advanced' })) },
  'font.textEffects': { run: (ctx) => dialog(ctx, 'formatTextEffects') },
  // Returns the dialog's promise, so a caller (Modify Style, the harness) can open it in value mode and take the run object.
  'home.font.launcher': { run: (ctx, arg) => ctx.dialog('font', arg && typeof arg === 'object' ? arg : {}) },

  // Text Highlight Color: with a selection the main part, Ctrl+Alt+H and a picked colour highlight it; with none they arm the
  // highlighter pen (a pick arms it in that colour, No Color disarms it), and the main part pressed again disarms it.
  'home.font.textHighlightColor': {
    run: (ctx, arg) => {
      if (arg) last.highlight = arg;
      const pen = arg === undefined ? last.highlight : arg;
      if (ctx.state?.selection.empty) {
        setPen(ctx.target, arg === undefined && armedPen(ctx.state) ? null : pen && HIGHLIGHTS[pen] ? pen : null);
        return true;
      }
      return setRun(ctx, { highlight: pen && HIGHLIGHTS[pen] ? pen : null });
    },
    value: () => last.highlight,
    active: (ctx) => !!armedPen(ctx.state),
    repeatable: true,
  },
  'home.font.textHighlightColor.stopHighlighting': {
    run: (ctx) => (setPen(ctx.target, null), true),
    enabled: (ctx) => !!armedPen(ctx.state),
    reason: () => 'The highlighter is off.',
  },

  // Font Color: the main part applies the last colour picked (#FF0000 first, Word's); a solid colour drops a gradient fill.
  'home.font.fontColor': {
    run: (ctx, arg) => {
      const pick = arg === undefined ? last.color : colorArg(arg);
      if (pick.color) last.color = pick;
      return setRun(ctx, { color: pick.color ?? null, themeColor: pick.color ? pick.themeColor ?? null : null, effects: { fill: null } });
    },
    value: () => last.color,
    repeatable: true,
  },
  'home.font.fontColor.moreColors': { run: (ctx) => moreColors(ctx, (hex) => COMMANDS['home.font.fontColor'].run(ctx, hex)) },
  'home.font.fontColor.gradient': {
    run: (ctx, arg) => {
      if (arg === 'more') return dialog(ctx, 'formatTextEffects', { tab: 'fill' });
      if (arg === 'none') return effects(ctx, { fill: null });
      const fill = gradients(colorNow(ctx))[arg];
      return fill ? effects(ctx, { fill }) : false;
    },
  },

  // Text Effects and Typography: the dropdown itself opens Format Text Effects (it has no main action of its own); its
  // submenus' galleries run the commands below with their item ids.
  'home.font.textEffectsAndTypography': { run: (ctx) => dialog(ctx, 'formatTextEffects') },
  'home.font.textEffectsAndTypography.outline': {
    run: (ctx, arg) => {
      if (arg === 'none') return effects(ctx, { outline: null });
      if (arg === 'more') return moreColors(ctx, (hex) => COMMANDS['home.font.textEffectsAndTypography.outline'].run(ctx, `color:${hex}`));
      const [k, v] = String(arg).split(':');
      const o = effectsNow(ctx).outline ?? { color: colorNow(ctx), width: 0.75, dash: 'solid' };
      const next = k === 'color' ? { ...o, color: v } : k === 'weight' ? { ...o, width: Number(v) } : k === 'dash' ? { ...o, dash: v } : null;
      return next ? effects(ctx, { outline: next }) : false;
    },
  },
  'home.font.textEffectsAndTypography.shadow': {
    run: (ctx, arg) => {
      if (arg === 'none') return effects(ctx, { shadow: null });
      if (arg === 'options') return dialog(ctx, 'formatTextEffects', { tab: 'effects' });
      const s = SHADOWS.find(([id]) => id === arg);
      return s ? effects(ctx, { shadow: { preset: s[0], color: '#000000', alpha: 0.6, blur: 4, dist: s[2] == null ? 0 : 3, angle: s[2] ?? 0 } }) : false;
    },
  },
  'home.font.textEffectsAndTypography.reflection': {
    run: (ctx, arg) => {
      if (arg === 'none') return effects(ctx, { reflection: null });
      if (arg === 'options') return dialog(ctx, 'formatTextEffects', { tab: 'effects' });
      const r = REFLECTIONS.find(([id]) => id === arg);
      return r ? effects(ctx, { reflection: { preset: r[0], size: r[2], dist: 0, alpha: 0.5 } }) : false;
    },
  },
  'home.font.textEffectsAndTypography.glow': {
    run: (ctx, arg) => {
      if (arg === 'none') return effects(ctx, { glow: null });
      if (arg === 'more') return moreColors(ctx, (hex) => COMMANDS['home.font.textEffectsAndTypography.glow'].run(ctx, `glow:${hex}`));
      if (arg === 'options') return dialog(ctx, 'formatTextEffects', { tab: 'effects' });
      const c = /^glow:(#[0-9A-F]{6})$/i.exec(arg ?? '')?.[1];
      return c ? effects(ctx, { glow: { color: c, size: 5, alpha: 0.6 } }) : false;
    },
  },
  'home.font.textEffectsAndTypography.numberStyles': {
    run: (ctx, arg) => (arg in NUMBER_STYLES ? typography(ctx, { numSpacing: NUMBER_STYLES[arg][1], numForm: NUMBER_STYLES[arg][2] }) : false),
  },
  'home.font.textEffectsAndTypography.ligatures': {
    run: (ctx, arg) => (LIGATURES.some(([id]) => id === arg) ? typography(ctx, { ligatures: arg }) : false),
  },
  'home.font.textEffectsAndTypography.stylisticSets': {
    run: (ctx, arg) => {
      if (arg === 'default') return typography(ctx, { stylisticSet: null });
      if (arg === 'contextual') return typography(ctx, { contextual: typographyNow(ctx).contextual ? null : true });
      const n = Number(/^ss(\d+)$/.exec(arg ?? '')?.[1]);
      return n >= 1 && n <= 20 ? typography(ctx, { stylisticSet: n }) : false;
    },
  },
};

/** Features delivered without a command of their own id (§1.2 implements): the keys bound to other commands and the dialog's
 * fields. */
export const IMPLEMENTS = ['font.fontDialogKey', 'font.fontSizeKey', 'font.highlightKey', 'font.complexScript', 'font.emphasisMark'];

export { GALLERIES };
