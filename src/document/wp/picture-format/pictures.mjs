// Picture Format's pure part (docs/plans/word plan.md §3 picture-format, §1.8 image attributes): the corrections, colour and
// transparency filters, the effects as CSS, crop arithmetic, compression sizes, the Picture Styles presets, Reset Picture and the
// SVG recolouring of Graphics Format. No DOM, and its one import is the shared 3-D rotation (pure), so node tests load it. Lengths are
// points, fractions are 0..1.
import { CAMERAS, rotationCss } from '../../../tooling/rotation3d.mjs';

// ---------- adjust: corrections, colour, transparency ----------

/** RGB of a black body at `k` kelvin (Tanner Helland's fit), 0..255 per channel. */
function kelvinRgb(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((v) => Math.min(255, Math.max(0, v)));
}

/** Per-channel gains of Color Tone `k` kelvin, 6500 K (Word's current) being neutral: [r, g, b]. */
export function toneGains(k) {
  if (!k || k === 6500) return [1, 1, 1];
  const base = kelvinRgb(6500);
  const at = kelvinRgb(k);
  const g = at.map((v, i) => v / base[i]);
  const top = Math.max(...g); // keep the brightest channel at 1 so the tone shifts colour, not brightness
  return g.map((v) => Math.round((v / top) * 1000) / 1000);
}

/** Word's corrections and colour for `adjust` → what the drawing needs: the linear transfer {slope, intercept} that brightness and
 * contrast make (Word's brightness adds, so it is an intercept, not CSS brightness()), the tone gains, the CSS filter functions,
 * sharpen and blur amounts, the recolor, the transparent colour and the opacity. */
export function adjustFilters(adjust) {
  const a = adjust ?? {};
  const b = a.brightness ?? 0;
  const c = a.contrast ?? 0;
  // Contrast pivots on mid grey: -1 flattens to grey, +1 is a hard threshold (slope ∞, capped).
  const slope = c >= 0 ? Math.min(100, 1 / Math.max(0.01, 1 - c)) : 1 + c;
  const intercept = 0.5 - 0.5 * slope + b;
  const css = [];
  if (a.saturation != null && a.saturation !== 1) css.push(`saturate(${a.saturation})`);
  const s = a.sharpness ?? 0;
  return {
    transfer: b || c ? { slope: round(slope), intercept: round(intercept) } : null,
    gains: toneGains(a.temperature),
    css,
    sharpen: s > 0 ? s : 0,
    blur: s < 0 ? -s * 2 : 0,
    recolor: a.recolor ?? null,
    transparentColor: a.transparentColor ?? null,
    opacity: a.transparency != null ? round(1 - a.transparency) : 1,
  };
}

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const rgb01 = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** The SVG filter primitives (one string) that draw `adjust` and the inner effects `inner` ([{dx, dy, blur, color, alpha}], points
 * as px) on SourceGraphic, or '' when nothing needs a filter. */
export function filterSvg(adjust, inner = []) {
  const f = adjustFilters(adjust);
  const out = [];
  let last = 'SourceGraphic';
  const step = (s, name) => {
    out.push(s.replace('IN', last).replace('OUT', name));
    last = name;
  };
  if (f.transparentColor) {
    // Set Transparent Color: per channel a discrete table that is 1 only in the picked value's bucket, summed into alpha = 0 where
    // all three match. 32 buckets: JPEG noise near the colour still counts as the colour, as Word's tolerance does.
    const n = 32;
    const [r, g, b] = rgb01(f.transparentColor).map((v) => Math.min(n - 1, Math.floor(v * n)));
    const table = (k) => Array.from({ length: n }, (_, i) => (i === k ? 1 : 0)).join(' ');
    out.push(`<feComponentTransfer in="SourceGraphic" result="tcm"><feFuncR type="discrete" tableValues="${table(r)}"/><feFuncG type="discrete" tableValues="${table(g)}"/><feFuncB type="discrete" tableValues="${table(b)}"/></feComponentTransfer>`);
    out.push('<feColorMatrix in="tcm" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1 -1 -1 0 3" result="tcmask"/>');
  }
  if (f.sharpen) {
    const k = round(f.sharpen);
    step(`<feConvolveMatrix in="IN" order="3" preserveAlpha="true" kernelMatrix="0 ${-k} 0 ${-k} ${round(1 + 4 * k)} ${-k} 0 ${-k} 0" result="OUT"/>`, 'sharp');
  }
  if (f.blur) step(`<feGaussianBlur in="IN" stdDeviation="${round(f.blur)}" result="OUT"/>`, 'soft');
  const { slope = 1, intercept = 0 } = f.transfer ?? {};
  if (f.transfer || f.gains.some((g) => g !== 1)) {
    const fn = (ch, g) => `<feFunc${ch} type="linear" slope="${round(slope * g)}" intercept="${round(intercept * g)}"/>`;
    step(`<feComponentTransfer in="IN" result="OUT">${fn('R', f.gains[0])}${fn('G', f.gains[1])}${fn('B', f.gains[2])}</feComponentTransfer>`, 'bc');
  }
  const rc = f.recolor;
  if (rc?.kind) {
    const grey = (name) => step(`<feColorMatrix in="IN" type="saturate" values="0" result="OUT"/>`, name);
    if (rc.kind === 'grayscale') grey('rc');
    else if (rc.kind === 'sepia') step('<feColorMatrix in="IN" type="matrix" values="0.393 0.769 0.189 0 0  0.349 0.686 0.168 0 0  0.272 0.534 0.131 0 0  0 0 0 1 0" result="OUT"/>', 'rc');
    else if (rc.kind === 'washout') step('<feComponentTransfer in="IN" result="OUT"><feFuncR type="linear" slope="0.3" intercept="0.65"/><feFuncG type="linear" slope="0.3" intercept="0.65"/><feFuncB type="linear" slope="0.3" intercept="0.65"/></feComponentTransfer>', 'rc');
    else if (rc.kind === 'bw') {
      grey('rcg');
      // A threshold t as a discrete table: the share of 0s is t.
      const n = 20;
      const tv = Array.from({ length: n }, (_, i) => (i / n < (rc.threshold ?? 0.5) ? 0 : 1)).join(' ');
      step(`<feComponentTransfer in="IN" result="OUT"><feFuncR type="discrete" tableValues="${tv}"/><feFuncG type="discrete" tableValues="${tv}"/><feFuncB type="discrete" tableValues="${tv}"/></feComponentTransfer>`, 'rc');
    } else if ((rc.kind === 'dark' || rc.kind === 'light') && rc.color) {
      grey('rcg');
      // Duotone: grey 0..1 runs black → colour (dark variants) or colour → white (light variants).
      const col = rgb01(rc.color);
      const fn = (ch, v) => `<feFunc${ch} type="table" tableValues="${rc.kind === 'dark' ? `0 ${round(v)}` : `${round(v)} 1`}"/>`;
      step(`<feComponentTransfer in="IN" result="OUT">${fn('R', col[0])}${fn('G', col[1])}${fn('B', col[2])}</feComponentTransfer>`, 'rc');
    }
  }
  for (const [i, s] of inner.entries()) {
    // An inner shadow: the alpha the shifted, blurred copy leaves uncovered, filled with the colour, over the picture.
    const [r, g, b] = rgb01(s.color ?? '#000000');
    out.push(`<feOffset in="SourceAlpha" dx="${round(s.dx)}" dy="${round(s.dy)}" result="io${i}"/>`,
      `<feGaussianBlur in="io${i}" stdDeviation="${round(Math.max(0.01, s.blur / 2))}" result="ib${i}"/>`,
      `<feComposite in="SourceAlpha" in2="ib${i}" operator="arithmetic" k2="1" k3="-1" result="ic${i}"/>`,
      `<feColorMatrix in="ic${i}" type="matrix" values="0 0 0 0 ${round(r)}  0 0 0 0 ${round(g)}  0 0 0 0 ${round(b)}  0 0 0 ${round(s.alpha ?? 0.5)} 0" result="is${i}"/>`);
    step(`<feMerge result="OUT"><feMergeNode in="IN"/><feMergeNode in="is${i}"/></feMerge>`, `in${i}`);
  }
  if (f.transparentColor) step('<feComposite in="IN" in2="tcmask" operator="in" result="OUT"/>', 'tc');
  return out.join('');
}

// ---------- effects ----------
const rgba = (hex, alpha) => {
  const [r, g, b] = rgb01(hex ?? '#000000').map((v) => Math.round(v * 255));
  return `rgba(${r}, ${g}, ${b}, ${round(alpha, 3)})`;
};
const polar = (angle, dist) => [round(Math.cos((angle * Math.PI) / 180) * dist, 2), round(Math.sin((angle * Math.PI) / 180) * dist, 2)];

// Bevel presets as two inner shadows (a highlight from the top left and a shade from the bottom right): CSS has no lighting model
// for a picture, so this draws the bevel's edge only (deviation: no 3-D surface).
const BEVEL_DEPTH = { circle: 6, relaxedInset: 4, cross: 6, slope: 6, angle: 6, softRound: 8, convex: 6, coolSlant: 6, divot: 5, riblet: 3, hardEdge: 4, artDeco: 6 };

/** The CSS (and the SVG inner shadows) that draw `effects` ({shadow, reflection, glow, softEdge, bevel, rotation3d}) →
 * {filter: [css functions], inner: [{dx, dy, blur, color, alpha}] in px, transform, mask, reflect}. */
export function effectsCss(effects) {
  const e = effects ?? {};
  const out = { filter: [], inner: [], transform: null, mask: null, reflect: null };
  const pt = (n) => `${round(n, 2)}pt`;
  const sh = e.shadow;
  if (sh) {
    const [dx, dy] = polar(sh.angle ?? 45, sh.distance ?? 3);
    const color = rgba(sh.color, 1 - (sh.transparency ?? 0.6));
    // An inner shadow lies along the edges its angle points to, as Word draws it (engine-gaps-pictures' Word probe): the filter
    // shows the edges a copy moved the other way leaves uncovered.
    if (sh.kind === 'inner') out.inner.push({ dx: -(dx * 4) / 3, dy: -(dy * 4) / 3, blur: ((sh.blur ?? 5) * 4) / 3, color: sh.color ?? '#000000', alpha: 1 - (sh.transparency ?? 0.6) });
    else out.filter.push(`drop-shadow(${pt(dx)} ${pt(dy)} ${pt(sh.blur ?? 4)} ${color})`);
  }
  if (e.glow) {
    const c = rgba(e.glow.color ?? '#156082', 1 - (e.glow.transparency ?? 0.4));
    out.filter.push(`drop-shadow(0 0 ${pt(e.glow.size / 2)} ${c})`, `drop-shadow(0 0 ${pt(e.glow.size / 2)} ${c})`);
  }
  if (e.bevel?.kind) {
    const d = (BEVEL_DEPTH[e.bevel.kind] ?? 6) * (4 / 3);
    out.inner.push({ dx: d / 2, dy: d / 2, blur: d, color: '#FFFFFF', alpha: 0.55 }, { dx: -d / 2, dy: -d / 2, blur: d, color: '#000000', alpha: 0.45 });
  }
  if (e.softEdge) {
    const s = pt(e.softEdge);
    const side = (dir) => `linear-gradient(${dir}, transparent, #000 ${s}, #000 calc(100% - ${s}), transparent)`;
    out.mask = `${side('to right')}, ${side('to bottom')}`;
  }
  if (e.reflection) {
    const r = e.reflection;
    out.reflect = `below ${pt(r.distance ?? 0)} linear-gradient(to bottom, ${rgba('#FFFFFF', 1 - (r.transparency ?? 0.5))}, transparent ${round((r.size ?? 0.5) * 100, 1)}%)`;
  }
  if (e.rotation3d) out.transform = rotationCss(e.rotation3d) || null; // Word's X, Y and Z, or its preset camera's (src/tooling/rotation3d.mjs)
  return out;
}

// Gallery data. Ids are the gallery item ids the commands take.
const ACCENTS = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
const DIRS = [['BottomRight', 'Bottom Right', 45], ['Bottom', 'Bottom', 90], ['BottomLeft', 'Bottom Left', 135], ['Right', 'Right', 0], ['Center', 'Center', null],
  ['Left', 'Left', 180], ['TopRight', 'Top Right', 315], ['Top', 'Top', 270], ['TopLeft', 'Top Left', 225]];
const INSIDE = ['TopLeft', 'Top', 'TopRight', 'Left', 'Center', 'Right', 'BottomLeft', 'Bottom', 'BottomRight'];

/** Picture Effects > Shadow: [{id, label, group, value}]. */
export const SHADOWS = [
  { id: 'none', label: 'None', group: 'No Shadow', value: null },
  ...DIRS.map(([id, label, a]) => ({ id: `outer${id}`, label: `Offset: ${label}`, group: 'Outer',
    value: { kind: 'outer', color: '#000000', transparency: 0.6, size: a == null ? 1.02 : 1, blur: a == null ? 5 : 4, angle: a ?? 0, distance: a == null ? 0 : 3 } })),
  ...INSIDE.map((id) => {
    const [, label, a] = DIRS.find((d) => d[0] === id);
    return { id: `inner${id}`, label: `Inside: ${label}`, group: 'Inner', value: { kind: 'inner', color: '#000000', transparency: 0.6, blur: a == null ? 9 : 5, angle: a ?? 0, distance: a == null ? 0 : 4 } };
  }),
  ...[['UpperLeft', 'Upper Left', 225], ['UpperRight', 'Upper Right', 315], ['Below', 'Below', 90], ['LowerLeft', 'Lower Left', 135], ['LowerRight', 'Lower Right', 45]]
    .map(([id, label, a]) => ({ id: `perspective${id}`, label: `Perspective: ${label}`, group: 'Perspective',
      value: { kind: 'perspective', color: '#000000', transparency: 0.8, blur: 6, angle: a, distance: 12 } })),
];

/** Picture Effects > Reflection. */
export const REFLECTIONS = [
  { id: 'none', label: 'None', group: 'No Reflection', value: null },
  ...[0, 4, 8].flatMap((d) => [['tight', 'Tight', 0.33], ['half', 'Half', 0.5], ['full', 'Full', 1]].map(([id, label, size]) => ({
    id: `${id}${d}`, label: `${label} Reflection: ${d ? `${d} point offset` : 'Touching'}`, group: 'Reflection Variations',
    value: { size, distance: d, transparency: 0.5, blur: 0.5 } }))),
];

/** Picture Effects > Glow, with the theme's accents resolved by `accent(slot)` → '#RRGGBB'. */
export const glows = (accent) => [
  { id: 'none', label: 'None', group: 'No Glow', value: null },
  ...[5, 8, 11, 18].flatMap((size) => ACCENTS.map((slot, i) => ({ id: `${size}${slot}`, label: `Glow: ${size} point; Accent ${i + 1}`, group: 'Glow Variations',
    value: { size, color: accent(slot), transparency: 0.6 } }))),
];

/** Picture Effects > Soft Edges (points). */
export const SOFT_EDGES = [{ id: 'none', label: 'None', group: 'No Soft Edges', value: null },
  ...[1, 2.5, 5, 10, 25, 50].map((n) => ({ id: `soft${String(n).replace('.', '_')}`, label: `${n} Point`, group: 'Soft Edge Variations', value: n }))];

/** Picture Effects > Bevel (a:bevelT prst names). */
export const BEVELS = [{ id: 'none', label: 'None', group: 'No Bevel', value: null },
  ...[['circle', 'Round'], ['relaxedInset', 'Relaxed Inset'], ['cross', 'Cross'], ['coolSlant', 'Slant'], ['angle', 'Angle'], ['softRound', 'Soft Round'],
    ['convex', 'Convex'], ['slope', 'Cutout'], ['divot', 'Divot'], ['riblet', 'Riblet'], ['hardEdge', 'Hard Edge'], ['artDeco', 'Round Convex']]
    .map(([kind, label]) => ({ id: kind, label, group: 'Bevel', value: { kind, width: 6, height: 6 } }))];

/** Picture Effects > 3-D Rotation: each item is Word's preset camera of that name, with its angles (src/tooling/rotation3d.mjs
 * CAMERAS: x, y and z in degrees, perspective the field of view, 0 for parallel), so a picked preset draws as Word draws it and
 * goes out as Word's preset. Word draws the obliques unturned (they slant a depth a picture does not have). */
const cam = (camera) => ({ ...CAMERAS[camera], camera });
export const ROTATIONS = [{ id: 'none', label: 'None', group: 'No Rotation', value: null },
  ...[['isoLeftDown', 'Isometric: Left Down', 'isometricLeftDown'], ['isoRightUp', 'Isometric: Right Up', 'isometricRightUp'],
    ['isoTopUp', 'Isometric: Top Up', 'isometricTopUp'], ['isoBottomDown', 'Isometric: Bottom Down', 'isometricBottomDown'],
    ['offAxis1Left', 'Off Axis 1: Left', 'isometricOffAxis1Left'], ['offAxis1Right', 'Off Axis 1: Right', 'isometricOffAxis1Right'],
    ['offAxis1Top', 'Off Axis 1: Top', 'isometricOffAxis1Top'], ['offAxis2Left', 'Off Axis 2: Left', 'isometricOffAxis2Left'],
    ['offAxis2Right', 'Off Axis 2: Right', 'isometricOffAxis2Right'], ['offAxis2Top', 'Off Axis 2: Top', 'isometricOffAxis2Top']]
    .map(([id, label, c]) => ({ id, label, group: 'Parallel', value: cam(c) })),
  ...[['front', 'Front', 'perspectiveFront'], ['left', 'Left', 'perspectiveLeft'], ['right', 'Right', 'perspectiveRight'], ['below', 'Below', 'perspectiveBelow'],
    ['above', 'Above', 'perspectiveAbove'], ['relaxedModerately', 'Relaxed Moderately', 'perspectiveRelaxedModerately'], ['relaxed', 'Relaxed', 'perspectiveRelaxed'],
    ['contrastingLeft', 'Contrasting Left', 'perspectiveContrastingLeftFacing'], ['contrastingRight', 'Contrasting Right', 'perspectiveContrastingRightFacing'],
    ['turnedLeftTiltedUp', 'Turned Left, Tilted Up', 'perspectiveHeroicExtremeLeftFacing'], ['turnedRightTiltedUp', 'Turned Right, Tilted Up', 'perspectiveHeroicExtremeRightFacing']]
    .map(([id, label, c]) => ({ id: `persp${id[0].toUpperCase()}${id.slice(1)}`, label: `Perspective: ${label}`, group: 'Perspective', value: cam(c) })),
  ...[['TopLeft', 'Top Left'], ['TopRight', 'Top Right'], ['BottomLeft', 'Bottom Left'], ['BottomRight', 'Bottom Right']]
    .map(([id, label]) => ({ id: `oblique${id}`, label: `Oblique: ${label}`, group: 'Oblique', value: cam(`oblique${id}`) })),
];

/** Picture Effects > Preset: Word's 12 presets as combinations of the above. */
export const PRESETS = [{ id: 'none', label: 'None', group: 'No Presets', value: {} },
  ...[[{ shadow: 'outerBottomRight' }], [{ shadow: 'outerBottom', bevel: 'circle' }], [{ bevel: 'circle' }], [{ bevel: 'softRound', shadow: 'outerBottom' }],
    [{ bevel: 'relaxedInset' }], [{ bevel: 'angle', shadow: 'outerBottomRight' }], [{ bevel: 'convex', shadow: 'outerCenter' }], [{ bevel: 'slope' }],
    [{ bevel: 'divot', rotation3d: 'perspFront' }], [{ bevel: 'cross', shadow: 'perspectiveBelow' }], [{ bevel: 'hardEdge', rotation3d: 'isoLeftDown' }],
    [{ bevel: 'artDeco', rotation3d: 'perspRelaxed', shadow: 'outerBottom' }]]
    .map(([p], i) => ({ id: `preset${i + 1}`, label: `Preset ${i + 1}`, group: 'Presets', value: {
      shadow: p.shadow ? SHADOWS.find((s) => s.id === p.shadow).value : null,
      bevel: p.bevel ? BEVELS.find((s) => s.id === p.bevel).value : null,
      rotation3d: p.rotation3d ? ROTATIONS.find((s) => s.id === p.rotation3d).value : null } })),
];

// ---------- border ----------
/** Picture Border > Weight (points). */
export const WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6].map((w) => ({ id: `w${String(w).replace('.', '_')}`, label: `${w} pt`, value: w }));
/** Picture Border > Dashes (a:prstDash names) and the CSS outline style that draws each (the nearest of dotted and dashed). */
export const DASHES = [['solid', 'Solid', 'solid'], ['sysDot', 'Round Dot', 'dotted'], ['sysDash', 'Square Dot', 'dotted'], ['dash', 'Dash', 'dashed'],
  ['dashDot', 'Dash Dot', 'dashed'], ['lgDash', 'Long Dash', 'dashed'], ['lgDashDot', 'Long Dash Dot', 'dashed'], ['lgDashDotDot', 'Long Dash Dot Dot', 'dashed']]
  .map(([id, label, css]) => ({ id, label, css }));
/** Picture Border > Sketched: kept on the border, drawn solid (deviation: no hand-drawn line). */
export const SKETCHES = [['none', 'None'], ['curved', 'Curved'], ['freehand', 'Freehand'], ['scribble', 'Scribble']].map(([id, label]) => ({ id, label }));

// ---------- adjust: artistic effects ----------
/** Adjust > Artistic Effects (Word's gallery, ph-misc-1). An id is the name picture.effects takes, so the row needs no map. */
export const ARTISTIC = [
  { id: 'none', label: 'None' }, { id: 'marker', label: 'Marker' }, { id: 'pencilGrayscale', label: 'Pencil Grayscale' },
  { id: 'pencilSketch', label: 'Pencil Sketch' }, { id: 'lineDrawing', label: 'Line Drawing' }, { id: 'chalkSketch', label: 'Chalk Sketch' },
  { id: 'paintStrokes', label: 'Paint Strokes' }, { id: 'paintBrush', label: 'Paint Brush' }, { id: 'glowDiffused', label: 'Glow Diffused' },
  { id: 'blur', label: 'Blur' }, { id: 'lightScreen', label: 'Light Screen' }, { id: 'watercolorSponge', label: 'Watercolor Sponge' },
  { id: 'filmGrain', label: 'Film Grain' }, { id: 'mosiaicBubbles', label: 'Mosaic Bubbles' }, { id: 'glass', label: 'Glass' },
  { id: 'cement', label: 'Cement' }, { id: 'texturizer', label: 'Texturizer' }, { id: 'crisscrossEtching', label: 'Crisscross Etching' },
  { id: 'pastelsSmooth', label: 'Pastels Smooth' }, { id: 'plasticWrap', label: 'Plastic Wrap' }, { id: 'cutout', label: 'Cutout' },
  { id: 'photocopy', label: 'Photocopy' }, { id: 'glowEdges', label: 'Glow Edges' },
];
/** The ARTISTIC id of the engine's effect name (object.get picture.adjust.artistic: 'Marker'), or 'none'. */
export const artisticId = (name) => (name ? name[0].toLowerCase() + name.slice(1) : 'none');

// ---------- crop ----------
/** The largest centred crop of a `w` x `h` picture to `ratio` ('16:9' or a number w/h) → {t, r, b, l} fractions of each side. */
export function aspectCrop(w, h, ratio) {
  const want = typeof ratio === 'number' ? ratio : (([a, b]) => a / b)(String(ratio).split(':').map(Number));
  const have = w / h;
  if (Math.abs(have - want) < 1e-9) return { t: 0, r: 0, b: 0, l: 0 };
  if (have > want) {
    const side = round((1 - want / have) / 2, 6);
    return { t: 0, r: side, b: 0, l: side };
  }
  const side = round((1 - have / want) / 2, 6);
  return { t: side, r: 0, b: side, l: 0 };
}

/** Crop > Fill: the `imgW` x `imgH` picture fills a `boxW` x `boxH` box keeping its ratio, the overflow cropped evenly. */
export const fillCrop = (boxW, boxH, imgW, imgH) => aspectCrop(imgW, imgH, boxW / boxH);

/** Crop > Fit: the whole picture fits the box; the spare room is a negative crop (Word's a:srcRect padding) on the short sides. */
export function fitCrop(boxW, boxH, imgW, imgH) {
  const box = boxW / boxH;
  const img = imgW / imgH;
  if (Math.abs(box - img) < 1e-9) return { t: 0, r: 0, b: 0, l: 0 };
  if (box > img) {
    const side = round(-(box / img - 1) / 2, 6);
    return { t: 0, r: side, b: 0, l: side };
  }
  const side = round(-(img / box - 1) / 2, 6);
  return { t: side, r: 0, b: side, l: 0 };
}

/** The share of the picture a crop shows across and down → [fw, fh]. */
export const cropShare = (crop) => [1 - (crop?.l ?? 0) - (crop?.r ?? 0), 1 - (crop?.t ?? 0) - (crop?.b ?? 0)];

/** Crop > Aspect Ratio items: id (the label without its colon) → ratio. */
export const ASPECTS = ['1:1', '2:3', '3:4', '3:5', '4:5', '3:2', '4:3', '5:3', '5:4', '16:9', '16:10'];

// Crop to Shape: a:prstGeom names and the CSS clip-path that draws each. The full Word list has about 150 shapes; these are the
// ones a polygon or a basic shape draws well (ponytail: the curved callouts, ribbons and waves need SVG paths, add them with shapes').
const poly = (pts) => `polygon(${pts.map(([x, y]) => `${x}% ${y}%`).join(', ')})`;
const ngon = (n, rot = -90) => poly(Array.from({ length: n }, (_, i) => {
  const a = ((rot + (360 / n) * i) * Math.PI) / 180;
  return [round(50 + 50 * Math.cos(a), 2), round(50 + 50 * Math.sin(a), 2)];
}));
const star = (n, inner = 0.4) => poly(Array.from({ length: n * 2 }, (_, i) => {
  const a = ((-90 + (180 / n) * i) * Math.PI) / 180;
  const r = i % 2 ? 50 * inner : 50;
  return [round(50 + r * Math.cos(a), 2), round(50 + r * Math.sin(a), 2)];
}));
export const SHAPES = [
  ['rect', 'Rectangle', 'Basic Shapes', 'none'],
  ['roundRect', 'Rectangle: Rounded Corners', 'Basic Shapes', 'inset(0 round 16.7%)'],
  ['ellipse', 'Oval', 'Basic Shapes', 'ellipse(50% 50%)'],
  ['snip1Rect', 'Rectangle: Single Corner Snipped', 'Basic Shapes', poly([[0, 0], [83, 0], [100, 17], [100, 100], [0, 100]])],
  ['snip2SameRect', 'Rectangle: Top Corners Snipped', 'Basic Shapes', poly([[17, 0], [83, 0], [100, 17], [100, 100], [0, 100], [0, 17]])],
  ['snip2DiagRect', 'Rectangle: Diagonal Corners Snipped', 'Basic Shapes', poly([[17, 0], [100, 0], [100, 83], [83, 100], [0, 100], [0, 17]])],
  ['round1Rect', 'Rectangle: Single Corner Rounded', 'Basic Shapes', 'inset(0 round 0 16.7% 0 0)'],
  ['round2SameRect', 'Rectangle: Top Corners Rounded', 'Basic Shapes', 'inset(0 round 16.7% 16.7% 0 0)'],
  ['round2DiagRect', 'Rectangle: Diagonal Corners Rounded', 'Basic Shapes', 'inset(0 round 16.7% 0)'],
  ['triangle', 'Isosceles Triangle', 'Basic Shapes', poly([[50, 0], [100, 100], [0, 100]])],
  ['rtTriangle', 'Right Triangle', 'Basic Shapes', poly([[0, 0], [100, 100], [0, 100]])],
  ['parallelogram', 'Parallelogram', 'Basic Shapes', poly([[25, 0], [100, 0], [75, 100], [0, 100]])],
  ['trapezoid', 'Trapezoid', 'Basic Shapes', poly([[25, 0], [75, 0], [100, 100], [0, 100]])],
  ['diamond', 'Diamond', 'Basic Shapes', poly([[50, 0], [100, 50], [50, 100], [0, 50]])],
  ['pentagon', 'Pentagon', 'Basic Shapes', ngon(5)],
  ['hexagon', 'Hexagon', 'Basic Shapes', poly([[25, 0], [75, 0], [100, 50], [75, 100], [25, 100], [0, 50]])],
  ['heptagon', 'Heptagon', 'Basic Shapes', ngon(7)],
  ['octagon', 'Octagon', 'Basic Shapes', poly([[29, 0], [71, 0], [100, 29], [100, 71], [71, 100], [29, 100], [0, 71], [0, 29]])],
  ['decagon', 'Decagon', 'Basic Shapes', ngon(10, 0)],
  ['dodecagon', 'Dodecagon', 'Basic Shapes', ngon(12, 0)],
  ['plaque', 'Plaque', 'Basic Shapes', 'inset(0 round 16.7%)'],
  ['plus', 'Cross', 'Basic Shapes', poly([[25, 0], [75, 0], [75, 25], [100, 25], [100, 75], [75, 75], [75, 100], [25, 100], [25, 75], [0, 75], [0, 25], [25, 25]])],
  ['bevel', 'Rectangle: Beveled', 'Basic Shapes', 'none'],
  ['rightArrow', 'Arrow: Right', 'Arrows', poly([[0, 25], [50, 25], [50, 0], [100, 50], [50, 100], [50, 75], [0, 75]])],
  ['leftArrow', 'Arrow: Left', 'Arrows', poly([[100, 25], [50, 25], [50, 0], [0, 50], [50, 100], [50, 75], [100, 75]])],
  ['upArrow', 'Arrow: Up', 'Arrows', poly([[25, 100], [25, 50], [0, 50], [50, 0], [100, 50], [75, 50], [75, 100]])],
  ['downArrow', 'Arrow: Down', 'Arrows', poly([[25, 0], [25, 50], [0, 50], [50, 100], [100, 50], [75, 50], [75, 0]])],
  ['leftRightArrow', 'Arrow: Left-Right', 'Arrows', poly([[0, 50], [20, 0], [20, 25], [80, 25], [80, 0], [100, 50], [80, 100], [80, 75], [20, 75], [20, 100]])],
  ['upDownArrow', 'Arrow: Up-Down', 'Arrows', poly([[50, 0], [100, 20], [75, 20], [75, 80], [100, 80], [50, 100], [0, 80], [25, 80], [25, 20], [0, 20]])],
  ['homePlate', 'Arrow: Pentagon', 'Arrows', poly([[0, 0], [75, 0], [100, 50], [75, 100], [0, 100]])],
  ['chevron', 'Arrow: Chevron', 'Arrows', poly([[0, 0], [75, 0], [100, 50], [75, 100], [0, 100], [25, 50]])],
  ['notchedRightArrow', 'Arrow: Notched Right', 'Arrows', poly([[0, 25], [50, 25], [50, 0], [100, 50], [50, 100], [50, 75], [0, 75], [12, 50]])],
  ['flowChartProcess', 'Flowchart: Process', 'Flowchart', 'none'],
  ['flowChartAlternateProcess', 'Flowchart: Alternate Process', 'Flowchart', 'inset(0 round 16.7%)'],
  ['flowChartDecision', 'Flowchart: Decision', 'Flowchart', poly([[50, 0], [100, 50], [50, 100], [0, 50]])],
  ['flowChartInputOutput', 'Flowchart: Data', 'Flowchart', poly([[20, 0], [100, 0], [80, 100], [0, 100]])],
  ['flowChartTerminator', 'Flowchart: Terminator', 'Flowchart', 'inset(0 round 50%)'],
  ['flowChartPreparation', 'Flowchart: Preparation', 'Flowchart', poly([[20, 0], [80, 0], [100, 50], [80, 100], [20, 100], [0, 50]])],
  ['flowChartManualInput', 'Flowchart: Manual Input', 'Flowchart', poly([[0, 20], [100, 0], [100, 100], [0, 100]])],
  ['flowChartManualOperation', 'Flowchart: Manual Operation', 'Flowchart', poly([[0, 0], [100, 0], [80, 100], [20, 100]])],
  ['flowChartConnector', 'Flowchart: Connector', 'Flowchart', 'circle(50%)'],
  ['flowChartOffpageConnector', 'Flowchart: Off-page Connector', 'Flowchart', poly([[0, 0], [100, 0], [100, 80], [50, 100], [0, 80]])],
  ['flowChartPunchedCard', 'Flowchart: Card', 'Flowchart', poly([[20, 0], [100, 0], [100, 100], [0, 100], [0, 20]])],
  ['flowChartExtract', 'Flowchart: Extract', 'Flowchart', poly([[50, 0], [100, 100], [0, 100]])],
  ['flowChartMerge', 'Flowchart: Merge', 'Flowchart', poly([[0, 0], [100, 0], [50, 100]])],
  ['irregularSeal1', 'Explosion: 8 Points', 'Stars and Banners', star(8, 0.6)],
  ['star4', 'Star: 4 Points', 'Stars and Banners', star(4, 0.38)],
  ['star5', 'Star: 5 Points', 'Stars and Banners', star(5, 0.38)],
  ['star6', 'Star: 6 Points', 'Stars and Banners', star(6, 0.58)],
  ['star7', 'Star: 7 Points', 'Stars and Banners', star(7, 0.6)],
  ['star8', 'Star: 8 Points', 'Stars and Banners', star(8, 0.7)],
  ['star10', 'Star: 10 Points', 'Stars and Banners', star(10, 0.75)],
  ['star12', 'Star: 12 Points', 'Stars and Banners', star(12, 0.75)],
  ['star16', 'Star: 16 Points', 'Stars and Banners', star(16, 0.8)],
  ['star24', 'Star: 24 Points', 'Stars and Banners', star(24, 0.8)],
  ['star32', 'Star: 32 Points', 'Stars and Banners', star(32, 0.85)],
].map(([id, label, group, clip]) => ({ id, label, group, clip }));

/** The clip-path of Crop to Shape `name`, or null for a rectangle or a shape this build cannot draw. */
export const shapeClip = (name) => {
  const c = SHAPES.find((s) => s.id === name)?.clip;
  return c && c !== 'none' ? c : null;
};

// ---------- compress ----------
/** Compress Pictures: the pixel width a picture of `origPx` pixels drawn `drawnIn` inches wide gets at `ppi`, never more than it has. */
export const compressSize = (origPx, drawnIn, ppi) => Math.min(origPx, Math.max(1, Math.round(drawnIn * ppi)));

/** Compress Pictures' resolutions: id → ppi (null: High fidelity keeps the pixels). */
export const RESOLUTIONS = { hifi: null, hd: 330, print: 220, web: 150, email: 96, default: 220 };

// ---------- picture styles ----------
const W = '#FFFFFF';
const K = '#000000';
const MET = '#A5A5A5';
const sh = (id) => SHADOWS.find((s) => s.id === id).value;
const rf = (id) => REFLECTIONS.find((s) => s.id === id).value;
const bv = (kind) => ({ kind, width: 6, height: 6 });
const ro = (id) => ROTATIONS.find((s) => s.id === id).value;
// The 28 presets by Word's names (probe menus picture.picture-format.picture-styles.json), in Word's order. Our own drawings of
// them through border, effects and crop.shape; Word's exact frames (double lines, mattes) are approximated by one outline.
const STYLE_DATA = [
  ['Simple Frame, White', { border: { color: W, width: 7 }, effects: { shadow: sh('outerBottomRight') } }],
  ['Beveled Matte, White', { border: { color: W, width: 8 }, effects: { bevel: bv('circle'), shadow: sh('outerBottom') } }],
  ['Metal Frame', { border: { color: MET, width: 6 }, effects: { bevel: bv('angle') } }],
  ['Drop Shadow Rectangle', { effects: { shadow: { ...sh('outerBottomRight'), blur: 8, distance: 4, transparency: 0.5 } } }],
  ['Reflected Rounded Rectangle', { shape: 'roundRect', effects: { reflection: rf('half0') } }],
  ['Soft Edge Rectangle', { effects: { softEdge: 10 } }],
  ['Double Frame, Black', { border: { color: K, width: 4.5 } }],
  ['Thick Matte, Black', { border: { color: K, width: 12 }, effects: { shadow: sh('innerCenter') } }],
  ['Simple Frame, Black', { border: { color: K, width: 7 } }],
  ['Beveled Oval, Black', { shape: 'ellipse', border: { color: K, width: 6 }, effects: { bevel: bv('circle') } }],
  ['Compound Frame, Black', { border: { color: K, width: 6 } }],
  ['Moderate Frame, Black', { border: { color: K, width: 5 }, effects: { shadow: sh('outerBottom') } }],
  ['Center Shadow Rectangle', { effects: { shadow: sh('outerCenter') } }],
  ['Rounded Diagonal Corner, White', { shape: 'round2DiagRect', border: { color: W, width: 6 }, effects: { shadow: sh('outerBottomRight') } }],
  ['Snip Diagonal Corner, White', { shape: 'snip2DiagRect', border: { color: W, width: 6 }, effects: { shadow: sh('outerBottomRight') } }],
  ['Moderate Frame, White', { border: { color: W, width: 5 }, effects: { shadow: sh('outerBottom') } }],
  ['Rotated, White', { border: { color: W, width: 6 }, effects: { shadow: sh('outerBottomRight'), rotation3d: { x: 0, y: 0, z: -4, perspective: 0 } } }],
  ['Perspective Shadow, White', { border: { color: W, width: 6 }, effects: { shadow: sh('perspectiveUpperLeft') } }],
  ['Relaxed Perspective, White', { border: { color: W, width: 6 }, effects: { rotation3d: ro('perspRelaxed'), shadow: sh('outerBottom') } }],
  ['Soft Edge Oval', { shape: 'ellipse', effects: { softEdge: 25 } }],
  ['Bevel Rectangle', { effects: { bevel: bv('circle'), shadow: sh('outerBottom') } }],
  ['Bevel Perspective', { effects: { bevel: bv('circle'), rotation3d: ro('perspLeft') } }],
  ['Reflected Perspective Right', { effects: { rotation3d: ro('perspRight'), reflection: rf('half4') } }],
  ['Bevel Perspective Left, White', { border: { color: W, width: 4 }, effects: { bevel: bv('angle'), rotation3d: ro('perspLeft') } }],
  ['Reflected Bevel, Black', { border: { color: K, width: 5 }, effects: { bevel: bv('circle'), reflection: rf('tight0') } }],
  ['Reflected Bevel, White', { border: { color: W, width: 5 }, effects: { bevel: bv('circle'), reflection: rf('tight0') } }],
  ['Metal Rounded Rectangle', { shape: 'roundRect', border: { color: MET, width: 6 }, effects: { bevel: bv('angle') } }],
  ['Metal Oval', { shape: 'ellipse', border: { color: MET, width: 6 }, effects: { bevel: bv('angle') } }],
];
const camel = (s) => s.replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join('');

/** Picture Styles: [{id, name, border, effects, shape}] in Word's order; id is the name in camelCase ('dropShadowRectangle'). */
export const PICTURE_STYLES = STYLE_DATA.map(([name, s]) => ({ id: camel(name), name, border: s.border ? { dash: 'solid', ...s.border } : null,
  effects: s.effects ?? null, shape: s.shape ?? null }));

// ---------- reset ----------
/** Reset Picture's attribute patch for an image with `attrs`: Reset Picture clears adjust, border, effects, style and crop.shape;
 * with `size` (Reset Picture & Size) also the crop and rotation, and the size goes back to `orig` ({w, h}, else attrs.orig). Alt,
 * name, layout, decorative and src stay. */
export function resetAttrs(attrs, { size = false, orig } = {}) {
  const patch = { adjust: null, border: null, effects: null, style: null };
  const crop = attrs.crop ? { ...attrs.crop } : null;
  if (crop) delete crop.shape;
  const cropped = crop && ['t', 'r', 'b', 'l'].some((k) => crop[k]);
  patch.crop = size || !cropped ? null : crop;
  if (size) {
    const o = orig ?? attrs.orig;
    patch.rotate = null;
    patch.flipH = null;
    patch.flipV = null;
    if (o?.w && o?.h) Object.assign(patch, { width: Math.round(o.w), height: Math.round(o.h) });
  }
  return patch;
}

// ---------- SVG (Graphics Format) ----------
/** The SVG text of a data URL (base64 or percent-encoded), or null when it is no SVG. */
export function svgOf(src) {
  const m = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/is.exec(src ?? '');
  if (!m) return null;
  if (/;base64/i.test(m[1] ?? '')) {
    const bin = atob(m[2]);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }
  return decodeURIComponent(m[2]);
}

/** `svg` text as a base64 data URL. */
export function svgUrl(svg) {
  const bytes = new TextEncoder().encode(svg);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

/** `pt` points as user units of `svg` drawn `drawn` px wide: its viewBox width (else its width) sets the scale. */
export function svgUnits(svg, pt, drawn) {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const w = Number(/\sviewBox\s*=\s*["']\s*\S+[\s,]+\S+[\s,]+([\d.]+)/i.exec(root)?.[1] ?? /\swidth\s*=\s*["']\s*([\d.]+)(px)?\s*["']/i.exec(root)?.[1]);
  const px = (pt * 4) / 3;
  return round(w > 0 && drawn > 0 ? (px * w) / drawn : px, 4);
}

/** Graphics Fill and Outline: `svg` with every fill (fill="none" kept, so outlines stay outlines) set to `fill`, and every stroke and
 * stroke-width to `stroke` and `strokeWidth` (the SVG's user units, see svgUnits), in attributes and style declarations; the root takes
 * them too so shapes without their own inherit them. Undefined leaves that property alone; 'none' removes fills or strokes. */
export function recolorSvg(svg, { fill, stroke, strokeWidth } = {}) {
  let out = svg;
  const set = (prop, value, keepNone) => {
    // Attributes: fill="..." on any element.
    out = out.replace(new RegExp(`(\\s${prop}\\s*=\\s*)(["'])(.*?)\\2`, 'gi'), (all, pre, q, v) => (keepNone && v.trim() === 'none' ? all : `${pre}${q}${value}${q}`));
    // Style declarations: fill: ...; inside style="" and <style> blocks.
    out = out.replace(new RegExp(`(^|[;{\\s"'])(${prop}\\s*:\\s*)([^;}"']+)`, 'gi'), (all, lead, pre, v) => (keepNone && v.trim() === 'none' ? all : `${lead}${pre}${value}`));
    // The root, so shapes with no fill of their own (black by default) follow too.
    out = out.replace(/<svg\b([^>]*)>/i, (all, attrs) => (new RegExp(`\\s${prop}\\s*=`, 'i').test(attrs) ? all : `<svg${attrs} ${prop}="${value}">`));
  };
  if (fill !== undefined) set('fill', fill, true);
  if (stroke !== undefined) set('stroke', stroke, false);
  if (strokeWidth !== undefined) set('stroke-width', String(strokeWidth), false);
  return out;
}
