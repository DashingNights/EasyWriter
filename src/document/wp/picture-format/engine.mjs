// Picture Format on a canvas draft (docs/plans/engine/stage2b.md, engine-gaps-pictures): the galleries' items (pictures.mjs, the
// DOM editor's terms: colours '#RRGGBB', transparencies 0..1, the 3-D rotation's `perspective`) as the engine's picture.format
// params (colours 'RRGGBB', transparencies in percent, `fov`), and the engine's look (object.get picture.outline and fx) back in
// the galleries' terms, so one set of items serves both editors and an item reads as picked on either. Pure.
import { CAMERAS } from '../../../tooling/rotation3d.mjs';
import { resolveColor, THEME_SLOTS } from '../../../office.mjs';
import { THEME } from '../../defaults.mjs';
import { BEVELS, DASHES, glows, PICTURE_STYLES, PRESETS, recolorSvg, REFLECTIONS, ROTATIONS, SHADOWS, SKETCHES, SOFT_EDGES, svgOf, svgUnits,
  svgUrl } from './pictures.mjs';

/** '#RRGGBB', 'RRGGBB' or the engine's [r, g, b] → 'RRGGBB', or null. */
export function hex6(c) {
  if (Array.isArray(c) && c.length === 3) return c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c ?? ''));
  return m ? m[1].toUpperCase() : null;
}
const css = (c) => (hex6(c) ? `#${hex6(c)}` : null);
const pct = (f, d) => Math.round((f ?? d) * 1000) / 10;
const frac = (p, d) => Math.round((p ?? d) * 10) / 1000;

/** A gallery shadow → [the engine's key ('shadow' or 'innerShadow'), its params]. A perspective shadow goes in as an outer one
 * (the engine draws no skewed shadow). */
export function engineShadow(v) {
  if (!v) return ['shadow', null];
  const out = { color: hex6(v.color) ?? '000000', transparency: pct(v.transparency, 0.6), blur: v.blur ?? 4, distance: v.distance ?? 3, angle: v.angle ?? 0 };
  return [v.kind === 'inner' ? 'innerShadow' : 'shadow', out];
}

/** The gallery's effects ({shadow, reflection, glow, softEdge, bevel, rotation3d}, each key present to change it, null to take
 * it off) → picture.format params. */
export function engineEffects(fx) {
  const out = {};
  if ('shadow' in fx) {
    const [key, v] = engineShadow(fx.shadow);
    out[key] = v;
    if (!v) out.innerShadow = null;
  }
  if ('reflection' in fx) {
    const r = fx.reflection;
    out.reflection = r && { size: pct(r.size, 0.5), distance: r.distance ?? 0, transparency: pct(r.transparency, 0.5), blur: r.blur ?? 0.5 };
  }
  if ('glow' in fx) {
    const g = fx.glow;
    out.glow = g && { color: hex6(g.color) ?? '156082', size: g.size ?? 8, transparency: pct(g.transparency, 0.6) };
  }
  if ('softEdge' in fx) out.softEdge = fx.softEdge ?? null;
  if ('bevel' in fx) out.bevel = fx.bevel && { kind: fx.bevel.kind, width: fx.bevel.width ?? 6, height: fx.bevel.height ?? 6 };
  if ('rotation3d' in fx) {
    const r = fx.rotation3d;
    const cam = r?.camera ? CAMERAS[r.camera] : null;
    const base = r && (['x', 'y', 'z'].some((k) => Number.isFinite(r[k])) ? r : cam);
    out.rotation = base && { x: base.x ?? 0, y: base.y ?? 0, z: base.z ?? 0, fov: base.perspective ?? 0 };
  }
  return out;
}

/** The engine's effects (object.get picture.fx) in the gallery's terms. */
export function domEffects(fx) {
  if (!fx) return {};
  const shadow = (s, kind) => s && { kind, color: css(s.color) ?? '#000000', transparency: frac(s.transparency, 60), blur: s.blur ?? 0, angle: s.angle ?? 0,
    distance: s.distance ?? 0 };
  const r = fx.reflection;
  const g = fx.glow;
  const t = fx.rotation;
  return {
    shadow: shadow(fx.shadow, 'outer') ?? shadow(fx.innerShadow, 'inner') ?? null,
    reflection: r ? { size: frac(r.size, 50), distance: r.distance ?? 0, transparency: frac(r.transparency, 50), blur: r.blur ?? 0 } : null,
    glow: g ? { size: g.size, color: css(g.color), transparency: frac(g.transparency, 60) } : null,
    softEdge: fx.softEdge ?? null,
    bevel: fx.bevel ? { kind: fx.bevel.kind, width: fx.bevel.width, height: fx.bevel.height } : null,
    rotation3d: t ? { x: t.x ?? 0, y: t.y ?? 0, z: t.z ?? 0, perspective: t.fov ?? 0 } : null,
  };
}

const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 0.051;
/** Whether the engine's effect `kind` (the gallery's: shadow, reflection, glow, softEdges, bevel, 3DRotation) is gallery item
 * `value` (null: None). */
export function sameEffect(kind, now, value) {
  if (!value || !now) return !value && !now;
  switch (kind) {
    case 'shadow': return now.kind === (value.kind === 'perspective' ? 'outer' : value.kind) && ['blur', 'distance', 'angle'].every((k) => near(now[k], value[k]));
    case 'reflection': return ['size', 'distance'].every((k) => near(now[k], value[k]));
    case 'glow': return near(now.size, value.size) && hex6(now.color) === hex6(value.color);
    case 'softEdges': return near(now, value);
    case 'bevel': return now.kind === value.kind;
    case '3DRotation': {
      const v = value.camera ? CAMERAS[value.camera] : value;
      return ['x', 'y', 'z'].every((k) => near(now[k], v?.[k])) && (now.perspective > 0) === (v?.perspective > 0);
    }
    default: return false;
  }
}

/** The gallery's effect sets by Picture Effects' submenu (index.js EFFECT_SETS), the glows' accents from `accent(slot)`. */
export const effectSets = (accent) => ({
  shadow: SHADOWS, reflection: REFLECTIONS, glow: glows(accent), softEdges: SOFT_EDGES, bevel: BEVELS, '3DRotation': ROTATIONS, preset: PRESETS,
});
/** A submenu's key in the effects object. */
export const EFFECT_KEY = { shadow: 'shadow', reflection: 'reflection', glow: 'glow', softEdges: 'softEdge', bevel: 'bevel', '3DRotation': 'rotation3d' };

/** Picture Effects' item `id` of submenu `kind` → picture.format params, or null for an unknown item. A preset sets the shadow,
 * bevel and 3-D rotation and keeps the rest, as the DOM editor's does. */
export function effectParams(kind, id, accent) {
  const it = effectSets(accent)[kind]?.find((x) => x.id === id);
  if (!it) return null;
  if (kind === 'preset') return engineEffects({ shadow: null, bevel: null, rotation3d: null, ...it.value });
  return engineEffects({ [EFFECT_KEY[kind]]: it.value });
}

/** Picture Border's weight, dash or sketch item → the outline change; null for an unknown item. */
export function outlineParams(part, id) {
  if (part === 'dash') return DASHES.some((d) => d.id === id) ? { dash: id } : null;
  if (part === 'sketch') return SKETCHES.some((d) => d.id === id) ? { sketch: id } : null;
  return null;
}

/** Picture Styles item `id` → the engine steps that give the picture Word's style (outline, effects and the shape it is cropped
 * to, as one undo step), or null. */
export function styleSteps(id) {
  const st = PICTURE_STYLES.find((s) => s.id === id);
  if (!st) return null;
  const outline = st.border ? { color: hex6(st.border.color), width: st.border.width, dash: st.border.dash ?? 'solid', sketch: 'none' } : null;
  const fx = engineEffects({ shadow: null, reflection: null, glow: null, softEdge: null, bevel: null, rotation3d: null, ...(st.effects ?? {}) });
  return [['picture.format', { clear: true, outline, ...fx }], ['picture.cropToShape', { preset: st.shape ?? 'rect' }]];
}

/** The Picture Style the engine's look `p` (object.get picture) still is, or null. */
export function styleOf(p) {
  if (!p) return null;
  const dom = domEffects(p.fx);
  return PICTURE_STYLES.find((st) => {
    const o = p.outline;
    const sameLine = st.border ? !!o && hex6(o.color) === hex6(st.border.color) && near(o.width, st.border.width) : !o;
    const shape = (p.cropShape ?? null) === (st.shape ?? null);
    const want = st.effects ?? {};
    const effects = ['shadow', 'reflection', 'softEdge', 'bevel', 'rotation3d'].every((k) => {
      const kind = { softEdge: 'softEdges', rotation3d: '3DRotation' }[k] ?? k;
      return sameEffect(kind, dom[k] ?? null, want[k] ?? null);
    });
    return sameLine && shape && effects;
  })?.id ?? null;
}

// ---------- Graphics Format (engine-pictures-2, G23) ----------
// An SVG graphic is recoloured as vector art: its SVG rewritten as the DOM editor rewrites it (pictures.mjs recolorSvg), then put back
// through picture.change, which keeps it vector and draws its PNG copy anew.

/** Graphics Styles item `id` (index.js GRAPHIC_STYLES: fill-, outline- and dark-accentN) → recolorSvg's options in `theme`'s colours, or
 * null. */
export function graphicStyle(id, theme = THEME) {
  const m = /^(fill|outline|dark)-(accent[1-6])$/.exec(String(id ?? ''));
  if (!m) return null;
  const c = resolveColor(theme, { slot: m[2] });
  if (m[1] === 'fill') return { fill: c, stroke: 'none' };
  return { fill: m[1] === 'outline' ? 'none' : resolveColor(theme, { slot: m[2], lum: -0.5 }), stroke: c, strokeWidth: 1 };
}

/** A Graphics Fill or Outline colour item (No Fill, No Outline, a theme slot, '#RRGGBB') → '#RRGGBB', 'none' or null. */
export function graphicColour(id, theme = THEME) {
  if (id === 'noFill' || id === 'noOutline') return 'none';
  if (THEME_SLOTS.includes(id)) return resolveColor(theme, { slot: id });
  return /^#[0-9a-f]{6}$/i.test(id ?? '') ? id.toUpperCase() : null;
}

/** The SVG `base64` recoloured with `opts` ({fill, stroke, strokeWidth in points}) for a graphic drawn `w` points wide → base64, or null
 * when it is no SVG. */
export function recolouredSvg(base64, opts, w) {
  const svg = svgOf(`data:image/svg+xml;base64,${base64}`);
  if (!/<svg[\s>]/i.test(svg ?? '')) return null;
  const o = opts.strokeWidth === undefined ? opts : { ...opts, strokeWidth: svgUnits(svg, opts.strokeWidth, (w * 4) / 3) };
  return svgUrl(recolorSvg(svg, o)).split(',')[1];
}
