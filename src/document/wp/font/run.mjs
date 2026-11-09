// Run properties for the font package (docs/plans/word/plan.md §1.6 value mode, §1.8 textStyle; briefs/font.md): Word's lists,
// the Font dialog's merge of the selected runs, its exclusive pairs and changes, Reset Char's mark filter and the text effects'
// CSS. Pure: node tests load it.
import { deepPatch, isPlain } from '../../../office.mjs';
import { THEME } from '../../defaults.mjs';

/** The Font Size list (probe/menus/home.font-size.json): Word's 16 sizes, without the East Asian 10.5. */
export const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** A typed size → points (1 to 1638 in half points), or null. */
export function parseSize(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/pt$/i, '').trim());
  if (!Number.isFinite(n) || n < 1 || n > 1638) return null;
  return Math.round(n * 2) / 2;
}

/** The Font dialog's Underline style list (probe/dialogs/font.json, 18 items) → [[ST_Underline value or null, label]]. */
export const UNDERLINE_STYLES = [[null, '(none)'], ['words', 'Words only'], ['single', 'Single'], ['double', 'Double'], ['thick', 'Thick'],
  ['dotted', 'Dotted'], ['dottedHeavy', 'Dotted heavy'], ['dash', 'Dash'], ['dashedHeavy', 'Dashed heavy'], ['dashLong', 'Dashed long'],
  ['dashLongHeavy', 'Dashed long heavy'], ['dotDash', 'Dot dash'], ['dashDotHeavy', 'Dot dash heavy'], ['dotDotDash', 'Dot dot dash'],
  ['dashDotDotHeavy', 'Dot dot dash heavy'], ['wave', 'Wave'], ['wavyHeavy', 'Wave heavy'], ['wavyDouble', 'Wave double']];

/** The Underline menu's nine items (probe/menus/home.underline.json) by their derived id segment → ST_Underline value (null: none). */
export const UNDERLINE_MENU = {
  underline: 'single', doubleUnderline: 'double', thickUnderline: 'thick', dottedUnderline: 'dotted', dashedUnderline: 'dash',
  dotDashUnderline: 'dotDash', dotDotDashUnderline: 'dotDotDash', waveUnderline: 'wave', noUnderline: null,
};

// ---------- Reset Char ----------
/** Marks Reset Char (Ctrl+Space, Ctrl+Shift+Z) removes; every other mark (link, comment, insertion, deletion, formatChange,
 * permission) stays. textStyle loses every attribute but lang, noProof and highlight: Word keeps highlighting through Ctrl+Space and
 * Clear Formatting (Word knowledge, not probed). */
export const RESET_MARKS = ['bold', 'italic', 'underline', 'strike', 'subscript', 'superscript'];
const RESET_KEEP_ATTRS = ['lang', 'noProof', 'highlight'];

/** `marks` ([{type, attrs}], type a name) after Reset Char → the marks kept, textStyle reduced to the kept attributes or dropped. */
export function resetMarks(marks) {
  const out = [];
  for (const m of marks) {
    if (RESET_MARKS.includes(m.type)) continue;
    if (m.type !== 'textStyle') {
      out.push(m);
      continue;
    }
    const attrs = Object.fromEntries(RESET_KEEP_ATTRS.filter((k) => m.attrs?.[k] != null).map((k) => [k, m.attrs[k]]));
    if (Object.keys(attrs).length) out.push({ type: 'textStyle', attrs });
  }
  return out;
}

// ---------- Toggles ----------
/** The value a toggle writes: `want` (on or off) against the paragraph style's own value `styleOn`. → null when the style already
 * gives `want` (back to the style), else `want` (false switches off what the style turns on). */
export const toggleWrite = (want, styleOn) => (want === !!styleOn ? null : want);

// ---------- The Font dialog's value ----------
/** The run keys the Font dialog edits (plan.md §1.6 value mode: textStyle names plus the marks' booleans and underline). */
export const RUN_KEYS = ['font', 'fontEA', 'fontCS', 'size', 'sizeCS', 'bold', 'italic', 'color', 'themeColor', 'underline', 'em', 'strike', 'dstrike',
  'superscript', 'subscript', 'smallCaps', 'caps', 'vanish', 'scale', 'spacing', 'position', 'kern', 'typography', 'effects'];

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The run objects `runs` merged as the dialog shows a selection → one object, null for every key whose runs differ (a blank box,
 * a mixed check box). typography merges per key, as its boxes are separate. */
export function mergeRuns(runs) {
  if (!runs.length) return {};
  const out = {};
  for (const k of RUN_KEYS) {
    if (k === 'typography') {
      const keys = new Set(runs.flatMap((r) => Object.keys(r.typography ?? {})));
      out.typography = Object.fromEntries([...keys].map((t) => [t, runs.every((r) => same(r.typography?.[t], runs[0].typography?.[t])) ? runs[0].typography?.[t] ?? null : null]));
      continue;
    }
    out[k] = runs.every((r) => same(r[k], runs[0][k])) ? runs[0][k] ?? null : null;
  }
  return out;
}

/** Pairs that exclude each other in the Font dialog: checking one clears the other. */
export const EXCLUSIVE = { strike: 'dstrike', dstrike: 'strike', superscript: 'subscript', subscript: 'superscript', smallCaps: 'caps', caps: 'smallCaps' };

/** `run` with `key` set to `value`; turning one of a pair on turns the other off. */
export function setKey(run, key, value) {
  const out = { ...run, [key]: value };
  if (value === true && EXCLUSIVE[key]) out[EXCLUSIVE[key]] = false;
  return out;
}

/** The keys of `edited` that differ from `initial` → {key: value}: what OK applies, so a mixed box left alone stays mixed. */
export function changesOf(initial, edited) {
  const out = {};
  for (const k of Object.keys(edited)) {
    if (k === 'typography') {
      const t = Object.fromEntries(Object.entries(edited.typography ?? {}).filter(([tk, v]) => !same(v, initial.typography?.[tk])));
      if (Object.keys(t).length) out.typography = t;
    } else if (!same(edited[k], initial[k])) out[k] = edited[k];
  }
  return out;
}

/** The run object the dialog returns in value mode: `value` patched with the changes (objects key by key, plan.md §1.8). */
export function valueResult(value, changes) {
  const out = { ...value };
  for (const [k, v] of Object.entries(changes)) out[k] = isPlain(v) && isPlain(out[k]) ? deepPatch(out[k], v) : v;
  return out;
}

// ---------- Typography (Text Effects and Typography menus, the Advanced tab) ----------
/** Ligatures (w14:ligatures) → label, in the menu's and the dialog's order. */
export const LIGATURES = [['none', 'None'], ['standard', 'Standard Only'], ['standardContextual', 'Standard and Contextual'],
  ['historicalDiscretional', 'Historical and Discretionary'], ['all', 'All']];
/** Number Styles items → {numSpacing, numForm}; default clears both. */
export const NUMBER_STYLES = {
  default: ['Default', null, null], proportionalLining: ['Proportional Lining', 'proportional', 'lining'],
  tabularLining: ['Tabular Lining', 'tabular', 'lining'], proportionalOldStyle: ['Proportional Old-style', 'proportional', 'oldStyle'],
  tabularOldStyle: ['Tabular Old-style', 'tabular', 'oldStyle'],
};

// ---------- Text effects ----------
const rgba = (hex, alpha = 1) => {
  const n = parseInt(String(hex ?? '#000000').slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
};

/** CSS for textStyle `effects` {fill, outline, shadow, glow, reflection} (lengths in pt) → {css property: value}. Gradient fill
 * clips the background to the text; reflection uses -webkit-box-reflect, which needs an inline-block (single-line runs only).
 * ponytail: glow is a blurred text-shadow, the nearest CSS has to Word's soft halo. */
export function effectsCss(effects) {
  if (!effects) return {};
  const css = {};
  const shadows = [];
  const { fill, outline, shadow, glow, reflection } = effects;
  if (fill?.type === 'gradient' && fill.stops?.length) {
    css['background-image'] = `linear-gradient(${fill.angle ?? 90}deg, ${fill.stops.map((s) => `${s.color} ${s.pos}%`).join(', ')})`;
    css['-webkit-background-clip'] = 'text';
    css['background-clip'] = 'text';
    css['-webkit-text-fill-color'] = 'transparent';
  } else if (fill?.type === 'solid' && fill.color) css['-webkit-text-fill-color'] = fill.color;
  else if (fill?.type === 'none') css['-webkit-text-fill-color'] = 'transparent';
  if (outline?.width) css['-webkit-text-stroke'] = `${outline.width}pt ${outline.color ?? 'currentColor'}`;
  if (shadow) {
    const a = ((shadow.angle ?? 45) * Math.PI) / 180;
    const d = shadow.dist ?? 3;
    shadows.push(`${(Math.cos(a) * d).toFixed(2)}pt ${(Math.sin(a) * d).toFixed(2)}pt ${shadow.blur ?? 4}pt ${rgba(shadow.color, shadow.alpha ?? 0.6)}`);
  }
  if (glow?.size) shadows.push(`0 0 ${glow.size}pt ${rgba(glow.color, glow.alpha ?? 0.6)}`, `0 0 ${glow.size / 2}pt ${rgba(glow.color, glow.alpha ?? 0.6)}`);
  if (shadows.length) css['text-shadow'] = shadows.join(', ');
  if (reflection) {
    css.display = 'inline-block';
    const fade = Math.max(10, Math.min(100, reflection.size ?? 50));
    css['-webkit-box-reflect'] = `below ${reflection.dist ?? 0}pt linear-gradient(transparent ${100 - fade}%, rgb(0 0 0 / ${reflection.alpha ?? 0.5}))`;
  }
  return css;
}

/** Whether the font package draws textStyle `ts` as an inline-block: a reflection (-webkit-box-reflect needs a box) or character
 * scale (scaleX). */
export const drawnAsBlock = (ts) => !!(ts?.effects?.reflection || (ts?.scale != null && ts.scale !== 100));

/** The room Word gives a run's shadow, glow and reflection on its line → {up, down} in pt, or null for none. `s` is the run's size,
 * `single` its font's single line (Word's ascent A plus descent D) and `descent` D, all in pt. Measured in Word across Calibri,
 * Aptos and Arial from 6 to 44 pt, and the size rule from 6 to 144 pt (docs/plans/word/measurements/text-effects-line-room.md,
 * probes walk/effects3_docx.py and effects5_docx.py): the room scales with k = (s / 72)^0.7; a glow of radius r takes 0.75 k r each side; a shadow of blur b moved dy down takes
 * k (b - dy) above and k (b + dy) below; a reflection takes A - D plus 0.2646 D per pt of its distance below. Glow adds to the
 * shadow; below, the larger of shadow and reflection counts. The shadow's defaults are effectsCss's, so the room fits the drawing. */
export function fxRoom(effects, s, single, descent) {
  const { shadow, glow, reflection } = effects ?? {};
  const k = (s / 72) ** 0.7;
  const g = glow?.size > 0 ? 0.75 * k * glow.size : 0;
  let up = 0;
  let down = 0;
  if (shadow) {
    const blur = shadow.blur ?? 4;
    const dy = (shadow.dist ?? 3) * Math.sin(((shadow.angle ?? 45) * Math.PI) / 180);
    up = k * Math.max(0, blur - dy);
    down = k * Math.max(0, blur + dy);
  }
  if (reflection) down = Math.max(down, single - 2 * descent + 0.2646 * descent * (reflection.dist ?? 0));
  up += g;
  down += g;
  return up > 0.005 || down > 0.005 ? { up, down } : null;
}

/** The box a run with effect room `room` ({up, down} pt, fxRoom) needs on a line of spacing rule `line` (as linePitch takes it),
 * `L` the run's CSS line height and `single` its font's single line, all in pt → {h, v}: the box's height and how far its middle
 * sits above the run's own, or null when the line does not grow. Word grows the line as for a taller font: a multiple m (Single
 * is 1) multiplies the room too, At least takes the single line plus the room where that beats the minimum, Exactly ignores it. */
export function fxBox(room, line, L, single) {
  if (!room || line?.rule === 'exact') return null;
  const h = line?.rule === 'atLeast' ? single + room.up + room.down : L + (line?.rule === 'auto' ? line.value : 1) * (room.up + room.down);
  return { h, v: (room.up - room.down) / 2 };
}

// Languages written right to left: the Font dialog shows Complex scripts only when the proofing languages hold one.
const RTL = /^(ar|he|fa|ur|yi|ps|sd|ug|dv|syr|ku-Arab)\b/i;
/** Whether `languages` (settings.word.proofing.languages) holds a right-to-left language. */
export const hasRtl = (languages) => (languages ?? []).some((l) => RTL.test(l));

// ---------- canvas drafts ----------
// The Font dialog on a canvas draft reads the engine's format.state (cmd/format.rs) as its run object and writes its changes as
// format.set's CharProps (the engine's serde names), so the dialog itself stays the same.
const LIG_ID = { standard: 'standard', 'standard,contextual': 'standardContextual', 'historical,discretional': 'historicalDiscretional',
  'standard,contextual,historical,discretional': 'all' };
/** The Ligatures menu's ids → the engine's four flags (the canvas rows use it too). */
export const LIGATURE_FLAGS = { none: {}, standard: { standard: true }, standardContextual: { standard: true, contextual: true },
  historicalDiscretional: { historical: true, discretional: true }, all: { standard: true, contextual: true, historical: true, discretional: true } };
/** A '#RRGGBB' or 'RRGGBB' → the engine's 'RRGGBB', else null. */
export const engineHex = (c) => (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c) ? c.replace('#', '').toUpperCase() : null);
/** An engine colour (an Rgb [r, g, b], a TextColor {Rgb: [...]} or 'Auto', or an 'RRGGBB') → '#RRGGBB', or null for automatic. */
export function hexOf(c) {
  if (Array.isArray(c) && c.length === 3) return `#${c.map((x) => Number(x).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  if (c && typeof c === 'object' && Array.isArray(c.Rgb)) return hexOf(c.Rgb);
  const h = engineHex(c);
  return h ? `#${h}` : null;
}
/** A Font box name → the font it shows: the theme's for Headings (+major) and Body (+minor), since the engine keeps names, not
 * theme references (stage2.md G35). */
export const themeFont = (name) => (name === '+major' ? THEME.fonts.major : name === '+minor' ? THEME.fonts.minor : name);

/** format.state's value `fs` → the Font dialog's run object (a value mixed across the selection stays null). */
export function runOfEngine(fs) {
  if (!fs) return {};
  const lig = fs.ligatures && ['standard', 'contextual', 'historical', 'discretional'].filter((k) => fs.ligatures[k]).join(',');
  const u = fs.underlineStyle;
  // format.state's toggles are false when only part of the selection has them; `mixed` names those.
  const mixed = new Set(fs.mixed ?? []);
  const on = (key) => (mixed.has(key) ? null : !!fs[key]);
  return {
    font: fs.font ?? null, fontEA: fs.fontEastAsia ?? null, fontCS: fs.fontCs ?? null, size: fs.size ?? null, sizeCS: fs.sizeCs ?? null,
    bold: on('bold'), italic: on('italic'), color: fs.color === 'auto' ? null : hexOf(fs.color), themeColor: null,
    underline: u && u !== 'none' ? { val: u, color: fs.underlineColor === 'auto' ? null : hexOf(fs.underlineColor) } : null,
    em: fs.em ?? null, strike: on('strike'), dstrike: on('doubleStrike'), superscript: on('superscript'), subscript: on('subscript'),
    smallCaps: on('smallCaps'), caps: on('caps'), vanish: on('hidden'), scale: fs.scale ?? 100, spacing: fs.spacing ?? 0, position: fs.position ?? 0,
    kern: fs.kern || null, effects: null,
    // Number forms and spacing, the stylistic set and contextual alternates (stage2.md G41): null is the font's own.
    typography: { ligatures: lig == null ? null : lig ? LIG_ID[lig] ?? null : 'none', numForm: fs.numForm ?? null, numSpacing: fs.numSpacing ?? null,
      stylisticSet: fs.stylisticSet ?? null, contextual: fs.contextualAlternates ?? null },
  };
}

/** The Font dialog's changes (changesOf) → format.set's props. Theme colours and fonts go as the names and colours they show (the
 * engine keeps no theme references yet: stage2.md G35). */
export function charPropsOf(changes) {
  const p = {};
  for (const [k, v] of Object.entries(changes)) {
    // The Latin font only: the complex script font is its own box (fontCS), as in Word's dialog.
    if (k === 'font' && v) p.font = themeFont(v);
    else if (k === 'fontEA' && v) p.fontEa = themeFont(v);
    else if (k === 'fontCS' && v) p.fontCs = themeFont(v);
    else if (k === 'size' && v) p.size = v;
    else if (k === 'sizeCS' && v) p.sizeCs = v;
    else if (k === 'bold' || k === 'italic' || k === 'strike' || k === 'smallCaps' || k === 'caps') p[k] = !!v;
    else if (k === 'dstrike') p.doubleStrike = !!v;
    else if (k === 'vanish') p.hidden = !!v;
    else if (k === 'superscript' || k === 'subscript') {
      if (v) p.vertAlign = k;
      else if (!p.vertAlign) p.vertAlign = 'baseline';
    } else if (k === 'color') p.color = engineHex(v) ?? 'auto';
    else if (k === 'underline') {
      p.underline = v?.val ?? 'none';
      if (v?.color !== undefined) p.underlineColor = engineHex(v.color) ?? undefined;
    } else if (k === 'em') p.em = v ?? 'none';
    else if (k === 'scale' || k === 'spacing' || k === 'position') p[k] = v ?? (k === 'scale' ? 100 : 0);
    else if (k === 'kern') p.kern = v ?? 0;
    else if (k === 'typography') Object.assign(p, typographyProps(v ?? {}));
  }
  return p;
}

/** The Font dialog's typography object (Ligatures, Number spacing, Number forms, Stylistic sets, contextual alternates) → format.set's
 * props (stage2.md G41); a key left out stays as it is, null goes back to the font's own. */
export function typographyProps(t) {
  const out = {};
  if (t.ligatures !== undefined) out.ligatures = LIGATURE_FLAGS[t.ligatures ?? 'none'] ?? {};
  if (t.numForm !== undefined) out.numForm = t.numForm ?? 'default';
  if (t.numSpacing !== undefined) out.numSpacing = t.numSpacing ?? 'default';
  if (t.stylisticSet !== undefined) out.stylisticSet = Number(t.stylisticSet) || 0;
  if (t.contextual !== undefined && t.contextual !== null) out.contextualAlternates = !!t.contextual;
  return out;
}

// ---------- Format Text Effects on a canvas draft ----------
// The dialog keeps the DOM editor's effects {fill, outline, shadow, glow, reflection} (opacity as alpha 0 to 1); the engine's
// TextEffects (format.state's textEffects) and format.textEffects' params keep transparency in percent (wordart.rs).
const alphaOf = (t) => Math.round((1 - (t ?? 0) / 100) * 100) / 100;
const pctOf = (alpha) => Math.round((1 - (alpha ?? 1)) * 100);

/** format.state's textEffects (the engine's TextEffects) → the dialog's effects object. */
export function effectsOfEngine(te) {
  if (!te) return {};
  const out = {};
  const f = te.fill;
  if (f?.type === 'none') out.fill = { type: 'none' };
  else if (f?.type === 'solid') out.fill = { type: 'solid', color: hexOf(f.color) };
  else if (f?.type === 'gradient') out.fill = { type: 'gradient', angle: f.angle ?? 0, stops: (f.stops ?? []).map((x) => ({ pos: x.pos, color: hexOf(x.color) })) };
  if (te.outline?.color) out.outline = { color: hexOf(te.outline.color), width: te.outline.width ?? 0.75, dash: 'solid' };
  if (te.shadow) out.shadow = { color: hexOf(te.shadow.color), alpha: alphaOf(te.shadow.transparency), blur: te.shadow.blur, angle: te.shadow.angle, dist: te.shadow.distance };
  if (te.glow) out.glow = { color: hexOf(te.glow.color), alpha: alphaOf(te.glow.transparency), size: te.glow.size };
  if (te.reflection) out.reflection = { size: te.reflection.size, dist: te.reflection.distance, alpha: alphaOf(te.reflection.transparency) };
  return out;
}

/** The dialog's changed effects (`changed`: a key per effect it set, null for one it took off) → format.textEffects' params. */
export function textEffectsParams(changed) {
  const out = {};
  const h = (c) => engineHex(c) ?? '000000';
  for (const [k, v] of Object.entries(changed)) {
    if (k === 'fill') {
      out.fill = !v ? null : v.type === 'none' ? 'none' : v.type === 'solid' ? { color: h(v.color) }
        : { gradient: (v.stops ?? []).map((x) => h(x.color)), angle: v.angle ?? 0 };
    } else if (k === 'outline') out.outline = v ? { color: h(v.color), width: v.width ?? 0.75 } : 'none';
    else if (k === 'shadow') out.shadow = v ? { color: h(v.color), transparency: pctOf(v.alpha), blur: v.blur ?? 4, distance: v.dist ?? 3, angle: v.angle ?? 45 } : null;
    else if (k === 'glow') out.glow = v ? { color: h(v.color), size: v.size ?? 5, transparency: pctOf(v.alpha) } : null;
    else if (k === 'reflection') out.reflection = v ? { transparency: pctOf(v.alpha ?? 0.5), size: v.size ?? 50, distance: v.dist ?? 0 } : 'none';
  }
  return out;
}
