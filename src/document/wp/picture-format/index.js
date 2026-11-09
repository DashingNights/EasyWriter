// Picture Format and Graphics Format (docs/plans/word plan.md §3 picture-format, brief picture-format.md): corrections, colour and
// transparency, Compress, Change and Reset Picture, Picture Styles, Border and Effects, Alt Text, Crop with its menu, the size
// spinners, Insert > Pictures and Screenshot, Paste as Picture and the Graphics Format tab for SVG pictures. Arrange, Position,
// Wrap Text and the Layout dialog belong to arrange and float-layout. Drawing: draw.js; crop mode: crop.js; panes and dialogs.
import { both } from '../../../tooling/engine-provider.mjs';
import { toPng } from 'html-to-image';
import { createElement as h } from 'react';
import { getState, setState } from '../../../app/store.js';
import { STANDARD_COLORS, THEME_SLOTS } from '../../../office.mjs';
import { closePane, openPane, paneOpen } from '../../../tooling/panes.jsx';
import { pictureOfUrl } from '../../../tooling/picture.mjs';
import { REASONS } from '../../../tooling/reasons.mjs';
import { formatLength, UNITS, unitOf } from '../../../tooling/kit/units.mjs';
import { insertBoard, topLevelPos } from '../../../whiteboard.js';
import { armTransparentColor, clipScreen, cropping, endCrop, onCropChange, startCrop } from './crop.js';
import { CompressPictures, InsertPicture, InsertPictures, paneDialog } from './dialogs.jsx';
import { DrawPictures, pictureCss } from './draw.js';
import {
  captureApi, capped, clipboardApi, hasPic, insertPicture, merged, natural, noPic, patchPic, picOf, pickPicture, setAttrs, setPic, themeHex,
} from './edit.js';
import { domEffects, EFFECT_KEY as ENGINE_KEY, sameEffect, styleOf } from './engine.mjs';
import { AltTextPane, FormatPicturePane } from './panes.jsx';
import {
  ARTISTIC, artisticId, aspectCrop, ASPECTS, BEVELS, cropShare, DASHES, fillCrop, fitCrop, glows, PICTURE_STYLES, PRESETS, recolorSvg,
  REFLECTIONS, resetAttrs, ROTATIONS, SHADOWS, SHAPES, SKETCHES, SOFT_EDGES, svgOf, svgUnits, svgUrl, WEIGHTS,
} from './pictures.mjs';

const P = 'pictureFormat';
const ACCENTS = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];

/** A command on the selected picture: enabled only with one, its reason otherwise. */
const pic = (spec) => ({ enabled: hasPic, reason: noPic, ...spec });

/** Re-renders the ribbon and open menus after an async refresh (useWordCtx follows the store). */
const bump = () => setState({ word: { ...getState().word } });

// Crop mode's toggle state follows crop.js.
onCropChange(bump);

// ---------- Corrections ----------
const sign = (n) => (n > 0 ? `+${n}%` : n ? `${n}%` : '0% (Normal)');
const STEPS = [-40, -20, 0, 20, 40];
const CORRECTIONS = [
  ...[['soften50', 'Soften: 50%', -0.5], ['soften25', 'Soften: 25%', -0.25], ['sharpen0', 'Sharpen: 0%', 0], ['sharpen25', 'Sharpen: 25%', 0.25],
    ['sharpen50', 'Sharpen: 50%', 0.5]].map(([id, label, sharpness]) => ({ id, label, group: 'Sharpen/Soften', patch: { sharpness: sharpness || null } })),
  ...STEPS.flatMap((c) => STEPS.map((b) => ({ id: `b${b}c${c}`, label: `Brightness: ${sign(b)} Contrast: ${sign(c)}`, group: 'Brightness/Contrast',
    patch: { brightness: b / 100 || null, contrast: c / 100 || null } }))),
];
const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 1e-6;

/** A small copy of the selected picture drawn with `attrs` over its own, for gallery rows. */
function thumb(ctx, attrs) {
  const p = picOf(ctx);
  if (!p) return null;
  const all = { ...p.node.attrs, ...attrs };
  return h('img', { src: p.node.attrs.src, alt: '', draggable: false, style: { width: 40, height: 30, objectFit: 'cover', flex: 'none', ...pictureCss(all),
    ...(all.border?.width && all.border.color !== 'none' && { outline: `${Math.min(3, all.border.width / 2)}px solid ${all.border.color}` }) } });
}
const row = (preview, label) => (preview ? h('span', { className: 'flex items-center gap-2' }, preview, h('span', null, label)) : label);

// ---------- Color ----------
const SATURATIONS = [0, 33, 66, 100, 200, 300, 400];
const TONES = [4700, 5300, 5900, 6500, 7200, 8800, 11200];
const SLOT_NAME = { dk2: 'Text color 2', lt2: 'Background color 2', ...Object.fromEntries(ACCENTS.map((s, i) => [s, `Accent color ${i + 1}`])) };
function colorItems(ctx) {
  const recolors = [['none', 'No Recolor', null], ['grayscale', 'Grayscale', { kind: 'grayscale' }], ['sepia', 'Sepia', { kind: 'sepia' }],
    ['washout', 'Washout', { kind: 'washout' }], ...[25, 50, 75].map((n) => [`bw${n}`, `Black and White: ${n}%`, { kind: 'bw', threshold: n / 100 }]),
    ...['dk2', ...ACCENTS].map((s) => [`dark-${s}`, `${SLOT_NAME[s]} Dark`, { kind: 'dark', color: themeHex(ctx, s) }]),
    ...['lt2', ...ACCENTS].map((s) => [`light-${s}`, `${SLOT_NAME[s]} Light`, { kind: 'light', color: themeHex(ctx, s === 'lt2' ? 'dk2' : s) }])];
  return [
    ...SATURATIONS.map((n) => ({ id: `sat${n}`, label: `Saturation: ${n}%`, group: 'Color Saturation', patch: { saturation: n === 100 ? null : n / 100 } })),
    ...TONES.map((k) => ({ id: `tone${k}`, label: `Temperature: ${k} K`, group: 'Color Tone', patch: { temperature: k === 6500 ? null : k } })),
    ...recolors.map(([id, label, recolor]) => ({ id: `recolor-${id}`, label, group: 'Recolor', patch: { recolor } })),
  ];
}
const colorActive = (adjust, it) => Object.entries(it.patch).every(([k, v]) => (v && typeof v === 'object'
  ? adjust?.[k]?.kind === v.kind && (adjust[k].threshold ?? null) === (v.threshold ?? null) && (adjust[k].color ?? null) === (v.color ?? null)
  : k === 'saturation' ? near(adjust?.[k] ?? 1, v ?? 1) : (adjust?.[k] ?? null) === v));

// ---------- Transparency ----------
const TRANSPARENCIES = [0, 15, 30, 50, 65, 80, 95];

// ---------- Effects ----------
const EFFECT_SETS = {
  shadow: () => SHADOWS, reflection: () => REFLECTIONS, glow: (ctx) => glows((s) => themeHex(ctx, s)), softEdges: () => SOFT_EDGES, bevel: () => BEVELS,
  '3DRotation': () => ROTATIONS, preset: () => PRESETS,
};
const EFFECT_KEY = { shadow: 'shadow', reflection: 'reflection', glow: 'glow', softEdges: 'softEdge', bevel: 'bevel', '3DRotation': 'rotation3d' };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Applies effect `kind`'s item `id` to the selected picture (a preset sets several effects). */
function applyEffect(ctx, kind, id) {
  const it = EFFECT_SETS[kind](ctx).find((x) => x.id === id);
  if (!it) return false;
  if (kind === 'preset') return patchPic(ctx, 'effects', { shadow: null, bevel: null, rotation3d: null, ...it.value });
  return patchPic(ctx, 'effects', { [EFFECT_KEY[kind]]: it.value });
}
const effectGallery = (kind) => (ctx) => {
  const fx = picOf(ctx)?.node.attrs.effects;
  // A grid of pictures (word-spec-data GALLERY_VIEWS), each named in its tooltip; only None keeps its name beside it.
  return EFFECT_SETS[kind](ctx).map((it) => {
    const value = kind === 'preset' ? it.value : { [EFFECT_KEY[kind]]: it.value };
    const pic = thumb(ctx, { effects: merged(fx, kind === 'preset' ? { shadow: null, bevel: null, rotation3d: null, ...value } : value) });
    return { id: it.id, label: it.label, group: it.group, preview: it.id === 'none' ? row(pic, it.label) : pic,
      active: kind === 'preset' ? false : same(fx?.[EFFECT_KEY[kind]], it.value) };
  });
};

// ---------- Size ----------
const lenUnit = (ctx) => unitOf(ctx.settings, ctx.profile, ctx.T?.unit?.name);
const ratioOf = (node) => (node.attrs.width && node.attrs.height ? node.attrs.width / node.attrs.height : 1);

/** Sets the selected picture's height (`side` 'height') or width to `pt`, the other side following its ratio. */
function setSide(ctx, side, pt) {
  const p = picOf(ctx);
  const v = Number(pt);
  if (!p || !Number.isFinite(v) || v <= 0) return false;
  const px = (v * 4) / 3;
  const r = ratioOf(p.node);
  const round2 = (n) => Math.round(n * 100) / 100;
  return setPic(ctx, side === 'height' ? { height: round2(px), width: round2(px * r) } : { width: round2(px), height: round2(px / r) });
}
const sideCommands = (side, key) => {
  const value = (ctx) => (picOf(ctx) ? Math.round(((picOf(ctx).node.attrs[key] ?? 0) * 0.75) * 100) / 100 : null);
  const step = (dir) => pic({ run: (ctx) => setSide(ctx, side, Math.max(1, (value(ctx) ?? 0) + dir * 0.1 * UNITS[lenUnit(ctx)])) });
  const id = `${P}.size.shape${side[0].toUpperCase()}${side.slice(1)}`;
  return {
    [id]: pic({ run: (ctx, pt) => setSide(ctx, side, pt), value, desc: (ctx) => (value(ctx) == null ? '' : formatLength(value(ctx), lenUnit(ctx))) }),
    [`${id}.more`]: step(1),
    [`${id}.less`]: step(-1),
  };
};

// ---------- Crop ----------
async function cropFill(ctx, fit) {
  const p = picOf(ctx);
  if (!p) return false;
  const n = await natural(p.node.attrs.src);
  if (!n.w) return false;
  const c = fit ? fitCrop(p.node.attrs.width, p.node.attrs.height, n.w, n.h) : fillCrop(p.node.attrs.width, p.node.attrs.height, n.w, n.h);
  return setAttrs(ctx.target, p.pos, { crop: merged(p.node.attrs.crop, c) });
}
/** Crop > Aspect Ratio: the largest centred crop of the whole picture to `ratio`; the drawn size keeps the picture's scale. */
async function cropAspect(ctx, ratio) {
  const p = picOf(ctx);
  if (!p) return false;
  const old = p.node.attrs;
  const [fw, fh] = cropShare(old.crop);
  const W = old.width / fw; // the whole picture as drawn
  const H = old.height / fh;
  const c = aspectCrop(W, H, ratio);
  const [nw, nh] = cropShare(c);
  return setAttrs(ctx.target, p.pos, { crop: merged(old.crop, c), width: Math.round(W * nw * 100) / 100, height: Math.round(H * nh * 100) / 100 });
}
const toggleCrop = pic({
  run: (ctx) => (cropping(ctx.target) ? (endCrop(), true) : startCrop(ctx.target, picOf(ctx).pos)),
  active: (ctx) => cropping(ctx.target),
});

// ---------- Reset and change ----------
async function reset(ctx, size) {
  const p = picOf(ctx);
  if (!p) return false;
  const orig = size && !p.node.attrs.orig ? capped(await natural(p.node.attrs.src), ctx.target) : undefined;
  return setAttrs(ctx.target, p.pos, resetAttrs(p.node.attrs, { size, orig }));
}

/** Change Picture: `src` replaces the picture and its orig; width, adjust, border, effects, layout and alt stay, the height follows
 * the new picture's ratio and the crop goes. An EMF or WMF shows its drawing and keeps its original (tooling/picture.mjs). */
async function replacePicture(ctx, src) {
  const p = picOf(ctx);
  if (!p || !src) return false;
  const n = await pictureOfUrl(src);
  if (!n) return false;
  const width = p.node.attrs.width ?? n.w;
  const height = Math.round(width * (n.h / n.w) * 100) / 100;
  const crop = p.node.attrs.crop?.shape ? { shape: p.node.attrs.crop.shape } : null;
  // Word's fallback of an SVG and its record of the old picture's compression belong to the old picture.
  return setAttrs(ctx.target, p.pos, { src: n.src, orig: capped(n, ctx.target), width, height, crop, metafile: n.metafile ?? null, ink: null, fallback: null, cstate: null });
}

let clip = { image: false, at: 0 }; // From Clipboard's enabled state, read at most every 2 s
function clipboardHasImage() {
  if (Date.now() - clip.at > 2000) {
    clip.at = Date.now();
    Promise.resolve(clipboardApi()?.read?.()).then((r) => {
      const has = !!r?.image;
      if (has !== clip.image) {
        clip.image = has;
        bump();
      }
    }, () => {});
  }
  return clip.image;
}

// ---------- Border ----------
let lastBorder = null;
const border = (ctx) => picOf(ctx)?.node.attrs.border;
/** Sets the selected picture's border colour; null or 'none' is No Outline. A weight or dash picked with no outline gets black. */
const setBorderColor = (ctx, color) => patchPic(ctx, 'border', color && color !== 'none' ? { color, width: border(ctx)?.width ?? 0.75 } : { color: 'none' });
const borderPatch = (ctx, patch) => patchPic(ctx, 'border', { ...(!border(ctx)?.color || border(ctx).color === 'none' ? { color: '#000000' } : {}), ...patch });

// ---------- Graphics ----------
const svgEdit = (ctx, opts) => {
  const p = picOf(ctx);
  const svg = p && svgOf(p.node.attrs.src);
  if (!svg) return false;
  // Weights are points; the SVG's stroke-width is in its own user units.
  const o = opts.strokeWidth === undefined ? opts : { ...opts, strokeWidth: svgUnits(svg, opts.strokeWidth, p.node.attrs.width) };
  return setPic(ctx, { src: svgUrl(recolorSvg(svg, o)) });
};
const colourOf = (ctx, id) => (id === 'noFill' || id === 'noOutline' ? 'none' : THEME_SLOTS.includes(id) ? themeHex(ctx, id) : /^#[0-9a-f]{6}$/i.test(id ?? '') ? id.toUpperCase() : null);
const swatch = (hex, label) => h('span', { className: 'flex items-center gap-2' },
  h('span', { style: { width: 14, height: 14, border: '1px solid currentColor', background: hex === 'none' ? 'transparent' : hex, flex: 'none' } }), h('span', null, label));
const SLOT_LABEL = { lt1: 'Background 1', dk1: 'Text 1', lt2: 'Background 2', dk2: 'Text 2', ...Object.fromEntries(ACCENTS.map((s, i) => [s, `Accent ${i + 1}`])) };
/** A colour or style square of a swatch grid (word-spec-data GALLERY_VIEWS), named in its tooltip. */
const chip = (fill, stroke = null) => h('span', { style: { width: 20, height: 20, flex: 'none', background: fill === 'none' ? 'transparent' : fill,
  border: `${stroke && stroke !== 'none' ? 2 : 1}px solid ${stroke && stroke !== 'none' ? stroke : 'color-mix(in srgb, currentColor 40%, transparent)'}` } });
const colourItems = (ctx, none) => [
  { id: none, label: none === 'noFill' ? 'No Fill' : 'No Outline', preview: swatch('none', none === 'noFill' ? 'No Fill' : 'No Outline') },
  ...['lt1', 'dk1', 'lt2', 'dk2', ...ACCENTS].map((s) => ({ id: s, label: SLOT_LABEL[s], group: 'Theme Colors', preview: chip(themeHex(ctx, s)) })),
  ...STANDARD_COLORS.map((c) => ({ id: c, label: c, group: 'Standard Colors', preview: chip(c) })),
];
let lastFill = '#FF0000';
let lastOutline = '#000000';
const GRAPHIC_STYLES = (ctx) => [
  ...ACCENTS.map((s, i) => ({ id: `fill-${s}`, label: `Fill: Accent ${i + 1}`, opts: { fill: themeHex(ctx, s), stroke: 'none' } })),
  ...ACCENTS.map((s, i) => ({ id: `outline-${s}`, label: `Outline: Accent ${i + 1}`, opts: { fill: 'none', stroke: themeHex(ctx, s), strokeWidth: 1 } })),
  ...ACCENTS.map((s, i) => ({ id: `dark-${s}`, label: `Dark Fill, Outline: Accent ${i + 1}`, opts: { fill: themeHex(ctx, s, -0.5), stroke: themeHex(ctx, s), strokeWidth: 1 } })),
];

/** Convert to Shape: the SVG becomes a canvas holding it as one image item, so the Shape Format tools apply (Word splits it into
 * shapes: deviation). The canvas goes at the top level after the picture's paragraph, as every board does. */
function convertToShape(ctx) {
  const p = picOf(ctx);
  const ed = ctx.target;
  const canvas = ed?.state.schema.nodes.canvas;
  if (!p || !canvas) return false;
  const { src, width, height, alt } = p.node.attrs;
  const w = Math.round(width ?? 200);
  const hh = Math.round(height ?? 200);
  const id = Math.random().toString(36).slice(2, 9);
  const node = canvas.create({ w, h: hh, dw: w, frame: { x: 0, y: 0, w, h: hh, item: id }, bg: 'post', items: [{ id, type: 'image', src, x: 0, y: 0, w, h: hh }],
    ...(alt && { docPr: { alt } }) });
  const tr = ed.state.tr.delete(p.pos, p.pos + p.node.nodeSize);
  const at = topLevelPos(tr.doc.resolve(Math.min(p.pos, tr.doc.content.size)));
  ed.view.dispatch(insertBoard(tr, at, node).scrollIntoView());
  return true;
}

// ---------- Screenshot ----------
let shots = { list: [], at: 0, busy: false };
function screenshotItems() {
  if (!shots.busy && Date.now() - shots.at > 3000) {
    shots.busy = true;
    Promise.resolve(captureApi({ types: ['window'], thumbnail: { width: 160, height: 100 } })).then((list) => {
      // EasyWriter's own window is left out, as Word leaves out its own.
      shots = { list: (list ?? []).filter((w) => w.name && w.name !== document.title), at: Date.now(), busy: false };
      bump();
    }, () => { shots = { ...shots, at: Date.now(), busy: false }; });
  }
  return [
    ...shots.list.map((w) => ({ id: `window:${w.id}`, label: w.name, group: 'Available Windows',
      preview: h('span', { className: 'flex items-center gap-2' }, w.thumbnail && h('img', { src: w.thumbnail, alt: '', style: { width: 64, height: 40, objectFit: 'contain' } }), h('span', { className: 'truncate' }, w.name)) })),
    { id: 'screenClipping', label: 'Screen Clipping', group: shots.list.length ? 'Other' : undefined },
  ];
}
const pastePictureWrap = (ctx) => ctx.settings?.word?.paste?.pictures ?? 'inline';
async function screenshot(ctx, id) {
  const ed = ctx.target; // the open story (a header, a note, a text box) when there is one, else the body
  if (!ed) return false;
  if (id === 'screenClipping') {
    const [screen] = (await captureApi({ types: ['screen'], thumbnail: { width: Math.round(window.screen.width * devicePixelRatio), height: Math.round(window.screen.height * devicePixelRatio) } })) ?? [];
    if (!screen?.thumbnail) return false;
    const png = await clipScreen(screen.thumbnail);
    return !!png && insertPicture(ed, png, { name: 'Screen clipping.png', wrap: pastePictureWrap(ctx) });
  }
  const want = String(id ?? '').replace(/^window:/, '');
  const list = (await captureApi({ types: ['window'], thumbnail: { width: 3840, height: 2160 } })) ?? [];
  const w = list.find((x) => String(x.id) === want);
  return !!w?.thumbnail && insertPicture(ed, w.thumbnail, { name: 'Screenshot.png', wrap: pastePictureWrap(ctx) });
}

// ---------- Paste as Picture ----------
async function pastePicture(ctx) {
  const ed = ctx.target; // the open story (a header, a note, a text box) when there is one, else the body
  const c = await clipboardApi()?.read?.();
  if (!ed || !c) return false;
  if (c.image) return insertPicture(ed, c.image, { name: 'Pasted picture.png', wrap: pastePictureWrap(ctx) });
  if (!c.html && !c.text) return false;
  // HTML (or text) drawn as a picture with html-to-image, as the board's export does (whiteboard.js).
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-10000px;top:0;width:600px;padding:8px;background:#fff;color:#000;font:12pt Aptos, sans-serif';
  if (c.html) {
    // Parsed apart from the page, so nothing in it runs or restyles the app while it is drawn.
    const body = new DOMParser().parseFromString(c.html, 'text/html').body;
    body.querySelectorAll('script, style, link, meta, base, iframe, object, embed').forEach((el) => el.remove());
    box.append(...body.childNodes);
  } else box.textContent = c.text;
  document.body.append(box);
  try {
    return insertPicture(ed, await toPng(box, { pixelRatio: 1 }), { name: 'Pasted picture.png', wrap: pastePictureWrap(ctx) });
  } finally {
    box.remove();
  }
}

// ---------- Commands ----------
const pane = (section) => pic({ run: () => openPane('formatPicture', { section }) });
const altTextToggle = {
  run: (ctx) => (paneOpen('altText') ? closePane('altText') : openPane('altText')),
  active: () => paneOpen('altText'),
};

const COMMANDS = {
  // Adjust
  [`${P}.adjust.corrections`]: pic({ run: (ctx, id) => {
    const it = CORRECTIONS.find((x) => x.id === id);
    return !!it && patchPic(ctx, 'adjust', it.patch);
  } }),
  [`${P}.adjust.corrections.pictureCorrectionsOptions`]: pane('picture.corrections'),
  [`${P}.adjust.color`]: pic({ run: (ctx, id) => {
    const it = colorItems(ctx).find((x) => x.id === id);
    return !!it && patchPic(ctx, 'adjust', it.patch);
  } }),
  [`${P}.adjust.color.moreVariations`]: pic({ run: (ctx, arg) => !!arg?.color && patchPic(ctx, 'adjust', { recolor: { kind: 'dark', color: arg.color } }) }),
  [`${P}.adjust.color.moreVariations.moreColors`]: pic({ run: async (ctx) => {
    const color = await ctx.dialog('colors', { value: picOf(ctx).node.attrs.adjust?.recolor?.color ?? '#156082' });
    return !!color && patchPic(ctx, 'adjust', { recolor: { kind: 'dark', color: color.color ?? color } });
  } }),
  [`${P}.adjust.color.setTransparentColor`]: pic({ run: (ctx) => {
    const ed = ctx.target;
    armTransparentColor(ed, (pos, hex) => {
      const node = ed.state.doc.nodeAt(pos);
      if (node) setAttrs(ed, pos, { adjust: merged(node.attrs.adjust, { transparentColor: hex }) });
    });
    ctx.toast('Click the colour in the picture to make it transparent.');
    return true;
  } }),
  [`${P}.adjust.color.pictureColorOptions`]: pane('picture.color'),
  [`${P}.adjust.transparency`]: pic({
    run: (ctx, id) => {
      const n = Number(String(id ?? '').replace(/^transparency/, ''));
      return Number.isFinite(n) && patchPic(ctx, 'adjust', { transparency: n ? n / 100 : null });
    },
    value: (ctx) => `transparency${Math.round((picOf(ctx)?.node.attrs.adjust?.transparency ?? 0) * 100)}`,
  }),
  [`${P}.adjust.transparency.pictureTransparencyOptions`]: pane('picture.transparency'),
  // Not awaited: the dialog does the work on OK, and a caller of run() should not wait for the user.
  [`${P}.adjust.compressPictures`]: pic({ run: (ctx) => (ctx.dialog('compressPictures', { pos: picOf(ctx).pos }), true) }),
  [`${P}.adjust.changePicture.thisDevice`]: pic({ run: async (ctx) => {
    const r = await pickPicture();
    return !!r && replacePicture(ctx, r.src);
  } }),
  [`${P}.adjust.changePicture.fromClipboard`]: pic({
    enabled: (ctx) => hasPic(ctx) && clipboardHasImage(),
    reason: (ctx) => noPic(ctx) ?? 'The clipboard holds no picture.',
    run: async (ctx) => replacePicture(ctx, (await clipboardApi()?.read?.())?.image),
  }),
  [`${P}.adjust.resetPicture`]: pic({ run: (ctx) => reset(ctx, false) }),
  [`${P}.adjust.resetPicture.resetPicture`]: pic({ run: (ctx) => reset(ctx, false) }),
  [`${P}.adjust.resetPicture.resetPictureSize`]: pic({ run: (ctx) => reset(ctx, true) }),

  // Picture Styles
  [`${P}.pictureStyles.pictureStyles`]: pic({
    run: (ctx, id) => {
      const s = PICTURE_STYLES.find((x) => x.id === id);
      const p = picOf(ctx);
      if (!s || !p) return false;
      const crop = merged(p.node.attrs.crop, { shape: s.shape });
      return setAttrs(ctx.target, p.pos, { style: s.id, border: s.border, effects: s.effects, crop });
    },
    value: (ctx) => picOf(ctx)?.node.attrs.style ?? null,
  }),
  [`${P}.pictureStyles.pictureBorder`]: pic({
    run: (ctx, arg) => {
      const color = arg === undefined ? lastBorder ?? '#000000' : arg?.color ?? null;
      lastBorder = color;
      return setBorderColor(ctx, color);
    },
    value: (ctx) => border(ctx)?.color ?? null,
  }),
  [`${P}.pictureStyles.pictureBorder.moreOutlineColors`]: pic({ run: async (ctx) => {
    const r = await ctx.dialog('colors', { value: border(ctx)?.color ?? '#000000' });
    const color = r?.color ?? r;
    return typeof color === 'string' && setBorderColor(ctx, (lastBorder = color));
  } }),
  [`${P}.pictureStyles.pictureBorder.weight`]: pic({ run: (ctx, id) => {
    const w = WEIGHTS.find((x) => x.id === id)?.value;
    return !!w && borderPatch(ctx, { width: w });
  } }),
  [`${P}.pictureStyles.pictureBorder.sketched`]: pic({ run: (ctx, id) => SKETCHES.some((x) => x.id === id) && borderPatch(ctx, { sketched: id === 'none' ? null : id }) }),
  [`${P}.pictureStyles.pictureBorder.dashes`]: pic({ run: (ctx, id) => DASHES.some((x) => x.id === id) && borderPatch(ctx, { dash: id }) }),
  [`${P}.pictureStyles.pictureBorder.weight.moreLines`]: pane('fillLine.line'),
  [`${P}.pictureStyles.pictureBorder.sketched.moreLines`]: pane('fillLine.line'),
  [`${P}.pictureStyles.pictureBorder.dashes.moreLines`]: pane('fillLine.line'),
  ...Object.fromEntries(Object.keys(EFFECT_SETS).map((k) => [`${P}.pictureStyles.pictureEffects.${k}`, pic({ run: (ctx, id) => applyEffect(ctx, k, id) })])),
  [`${P}.pictureStyles.pictureEffects.glow.moreGlowColors`]: pic({ run: (ctx, id) => {
    const color = colourOf(ctx, id);
    return !!color && color !== 'none' && patchPic(ctx, 'effects', { glow: { size: picOf(ctx).node.attrs.effects?.glow?.size ?? 8, transparency: 0.6, color } });
  } }),
  [`${P}.pictureStyles.pictureEffects.preset.3DOptions`]: pane('effects.format3d'),
  [`${P}.pictureStyles.pictureEffects.shadow.shadowOptions`]: pane('effects.shadow'),
  [`${P}.pictureStyles.pictureEffects.reflection.reflectionOptions`]: pane('effects.reflection'),
  [`${P}.pictureStyles.pictureEffects.glow.glowOptions`]: pane('effects.glow'),
  [`${P}.pictureStyles.pictureEffects.softEdges.softEdgesOptions`]: pane('effects.softEdges'),
  [`${P}.pictureStyles.pictureEffects.bevel.3DOptions`]: pane('effects.format3d'),
  [`${P}.pictureStyles.pictureEffects.3DRotation.3DRotationOptions`]: pane('effects.rotation3d'),
  [`${P}.pictureStyles.launcher`]: pane('fillLine.line'),

  // Accessibility
  [`${P}.accessibility.altText`]: altTextToggle,
  'review.accessibility.checkAccessibility.altText': altTextToggle,

  // Size
  [`${P}.size.crop`]: toggleCrop,
  [`${P}.size.crop.crop`]: toggleCrop,
  'graphicsFormat.arrangeSize.crop': toggleCrop,
  [`${P}.size.crop.cropToShape`]: pic({ run: (ctx, id) => SHAPES.some((s) => s.id === id) && patchPic(ctx, 'crop', { shape: id === 'rect' ? null : id }) }),
  ...Object.fromEntries(ASPECTS.map((r) => [`${P}.size.crop.aspectRatio.${r.replace(':', '')}`, pic({ run: (ctx) => cropAspect(ctx, r) })])),
  [`${P}.size.crop.fill`]: pic({ run: (ctx) => cropFill(ctx, false) }),
  [`${P}.size.crop.fit`]: pic({ run: (ctx) => cropFill(ctx, true) }),
  ...sideCommands('height', 'height'),
  ...sideCommands('width', 'width'),

  // Insert, Screenshot and Paste as Picture
  'insert.illustrations.pictures.thisDevice': { enabled: (ctx) => !!ctx.ed, run: async (ctx) => {
    const r = await ctx.dialog('insertPicture');
    return !!r?.src && insertPicture(ctx.target, r.src, { name: r.name ?? 'Picture', wrap: pastePictureWrap(ctx) });
  } },
  'insert.illustrations.screenshot': { enabled: (ctx) => !!ctx.ed, run: (ctx, id) => screenshot(ctx, id) },
  'paste.pastePicture': { enabled: (ctx) => !!ctx.ed, run: (ctx) => pastePicture(ctx) },

  // Graphics Format
  'graphicsFormat.change.changeGraphic': pic({ run: async (ctx, id) => {
    if (id && id !== 'thisDevice') return ctx.toast(REASONS.cloud), false;
    const r = await pickPicture();
    return !!r && replacePicture(ctx, r.src);
  } }),
  'graphicsFormat.change.convertToShape': pic({ run: (ctx) => convertToShape(ctx) }),
  'graphicsFormat.graphicsStyles.styles': pic({ run: (ctx, id) => {
    const s = GRAPHIC_STYLES(ctx).find((x) => x.id === id);
    return !!s && svgEdit(ctx, s.opts);
  } }),
  'graphicsFormat.graphicsStyles.graphicsFill': pic({
    run: (ctx, id) => {
      const c = id === undefined ? lastFill : colourOf(ctx, id);
      if (!c) return false;
      lastFill = c;
      return svgEdit(ctx, { fill: c });
    },
    value: () => lastFill,
  }),
  'graphicsFormat.graphicsStyles.graphicsOutline': pic({
    run: (ctx, id) => {
      const w = WEIGHTS.find((x) => x.id === id)?.value;
      if (w) return svgEdit(ctx, { stroke: lastOutline === 'none' ? '#000000' : lastOutline, strokeWidth: w });
      const c = id === undefined ? lastOutline : colourOf(ctx, id);
      if (!c) return false;
      lastOutline = c;
      return svgEdit(ctx, c === 'none' ? { stroke: 'none' } : { stroke: c });
    },
    value: () => lastOutline,
  }),
  'graphicsFormat.graphicsStyles.graphicsEffects': pic({ run: (ctx, id) => {
    const [kind, item] = String(id ?? '').split(':');
    return !!EFFECT_SETS[kind] && applyEffect(ctx, kind, item);
  } }),
};

// ---------- Galleries ----------
// On a canvas draft (canvas/rows/objects.mjs): the same items read against the engine's picture (object.get), with no previews
// of the picture (they are drawn from the DOM editor's image).
const lookOf = (ctx) => ctx.read('object.get', {})?.picture ?? null;
/** Picture Effects' submenu `kind` on a canvas draft: the item the picture's effect is picked. */
const engineEffectGallery = (kind) => (ctx) => {
  const now = domEffects(lookOf(ctx)?.fx)[ENGINE_KEY[kind]] ?? null;
  return EFFECT_SETS[kind](ctx).map((it) => ({ id: it.id, label: it.label, group: it.group, active: kind !== 'preset' && sameEffect(kind, now, it.value) }));
};
// engine-pictures-2: the picture's adjustments are settings the engine keeps (object.get picture.adjust), so the item it has shows picked.
const adjOf = (ctx) => lookOf(ctx)?.adjust ?? null;
/** The Recolor item the engine's adjustments `a` are (colorItems' ids), or null. */
function recolorId(ctx, a) {
  if (a.recolor === 'blackAndWhite') return `recolor-bw${a.threshold}`;
  if (a.recolor !== 'dark' && a.recolor !== 'light') return `recolor-${a.recolor}`;
  const light = a.recolor === 'light';
  const slot = [light ? 'lt2' : 'dk2', ...ACCENTS].find((s) => themeHex(ctx, light && s === 'lt2' ? 'dk2' : s).slice(1).toUpperCase() === a.recolorColor);
  return slot ? `recolor-${a.recolor}-${slot}` : null;
}
const ENGINE_GALLERIES = {
  [`${P}.adjust.corrections`]: (ctx) => {
    const a = adjOf(ctx);
    const now = a && (a.sharpness ? `${a.sharpness < 0 ? 'soften' : 'sharpen'}${Math.abs(a.sharpness)}` : `b${a.brightness}c${a.contrast}`);
    return CORRECTIONS.map(({ id, label, group }) => ({ id, label, group, active: id === now }));
  },
  [`${P}.adjust.color`]: (ctx) => {
    const a = adjOf(ctx);
    const now = a && [`sat${a.saturation}`, `tone${a.temperature}`, recolorId(ctx, a)];
    return colorItems(ctx).map(({ id, label, group }) => ({ id, label, group, active: !!now?.includes(id) }));
  },
  [`${P}.adjust.transparency`]: (ctx) => TRANSPARENCIES.map((n) => ({ id: `transparency${n}`, label: `Transparency: ${n}%`, active: adjOf(ctx)?.transparency === n })),
  [`${P}.pictureStyles.pictureStyles`]: (ctx) => {
    const now = styleOf(lookOf(ctx));
    return PICTURE_STYLES.map((s) => ({ id: s.id, label: s.name, active: s.id === now }));
  },
  [`${P}.pictureStyles.pictureBorder.weight`]: (ctx) => {
    const o = lookOf(ctx)?.outline;
    return WEIGHTS.map((w) => ({ id: w.id, label: w.label, active: !!o && Math.abs(o.width - w.value) < 0.01 }));
  },
  [`${P}.pictureStyles.pictureBorder.sketched`]: (ctx) => SKETCHES.map((s) => ({ id: s.id, label: s.label, active: (lookOf(ctx)?.outline?.sketch ?? 'none') === s.id })),
  [`${P}.pictureStyles.pictureBorder.dashes`]: (ctx) => DASHES.map((d) => ({ id: d.id, label: d.label, active: (lookOf(ctx)?.outline?.dash ?? 'solid') === d.id })),
  ...Object.fromEntries(Object.keys(EFFECT_SETS).map((k) => [`${P}.pictureStyles.pictureEffects.${k}`, engineEffectGallery(k)])),
  [`${P}.size.crop.cropToShape`]: (ctx) => SHAPES.map((s) => ({ id: s.id, label: s.label, group: s.group, active: (lookOf(ctx)?.cropShape ?? 'rect') === s.id })),
};

const GALLERIES = {
  [`${P}.adjust.corrections`]: (ctx) => {
    const a = picOf(ctx)?.node.attrs.adjust;
    return CORRECTIONS.map((it) => ({ id: it.id, label: it.label, group: it.group, preview: row(thumb(ctx, { adjust: merged(a, it.patch) }), it.label),
      active: Object.entries(it.patch).every(([k, v]) => near(a?.[k], v)) }));
  },
  [`${P}.adjust.color`]: (ctx) => {
    const a = picOf(ctx)?.node.attrs.adjust;
    return colorItems(ctx).map((it) => ({ id: it.id, label: it.label, group: it.group, preview: row(thumb(ctx, { adjust: merged(a, it.patch) }), it.label),
      active: colorActive(a, it) }));
  },
  [`${P}.adjust.transparency`]: (ctx) => {
    const a = picOf(ctx)?.node.attrs.adjust;
    return TRANSPARENCIES.map((n) => ({ id: `transparency${n}`, label: `Transparency: ${n}%`,
      preview: row(thumb(ctx, { adjust: merged(a, { transparency: n ? n / 100 : null }) }), `Transparency: ${n}%`), active: near(a?.transparency, n / 100) }));
  },
  [`${P}.pictureStyles.pictureStyles`]: (ctx) => PICTURE_STYLES.map((s) => ({ id: s.id, label: s.name, active: picOf(ctx)?.node.attrs.style === s.id,
    preview: thumb(ctx, { border: s.border, effects: s.effects, crop: s.shape ? { shape: s.shape } : null, adjust: null }) ?? s.name })),
  [`${P}.pictureStyles.pictureBorder.weight`]: (ctx) => WEIGHTS.map((w) => ({ id: w.id, label: w.label, active: border(ctx)?.width === w.value && border(ctx)?.color !== 'none',
    preview: h('span', { className: 'flex items-center gap-2' }, h('span', { style: { width: 40, borderTop: `${Math.max(1, (w.value * 4) / 3)}px solid currentColor` } }), w.label) })),
  [`${P}.pictureStyles.pictureBorder.sketched`]: (ctx) => SKETCHES.map((s) => ({ id: s.id, label: s.label, active: (border(ctx)?.sketched ?? 'none') === s.id })),
  [`${P}.pictureStyles.pictureBorder.dashes`]: (ctx) => DASHES.map((d) => ({ id: d.id, label: d.label, active: (border(ctx)?.dash ?? 'solid') === d.id,
    preview: h('span', { className: 'flex items-center gap-2' }, h('span', { style: { width: 40, borderTop: `2px ${d.css} currentColor` } }), d.label) })),
  ...Object.fromEntries(Object.keys(EFFECT_SETS).map((k) => [`${P}.pictureStyles.pictureEffects.${k}`, effectGallery(k)])),
  [`${P}.pictureStyles.pictureEffects.glow.moreGlowColors`]: (ctx) => colourItems(ctx, 'noFill').slice(1),
  [`${P}.size.crop.cropToShape`]: (ctx) => SHAPES.map((s) => ({ id: s.id, label: s.label, group: s.group, active: (picOf(ctx)?.node.attrs.crop?.shape ?? 'rect') === s.id,
    preview: h('span', { className: 'flex items-center gap-2' }, h('span', { style: { width: 20, height: 16, background: 'currentColor', opacity: 0.7, flex: 'none',
      clipPath: s.clip === 'none' ? undefined : s.clip } }), s.label) })),
  'insert.illustrations.screenshot': () => screenshotItems(),
  'graphicsFormat.change.changeGraphic': () => [{ id: 'thisDevice', label: 'From a File...' }, { id: 'fromIcons', label: 'From Icons' }],
  'graphicsFormat.graphicsStyles.styles': (ctx) => GRAPHIC_STYLES(ctx).map((s) => ({ id: s.id, label: s.label,
    preview: chip(s.opts.fill, s.opts.stroke) })),
  'graphicsFormat.graphicsStyles.graphicsFill': (ctx) => colourItems(ctx, 'noFill'),
  'graphicsFormat.graphicsStyles.graphicsOutline': (ctx) => [...colourItems(ctx, 'noOutline'),
    ...WEIGHTS.map((w) => ({ id: w.id, label: w.label, group: 'Weight' }))],
  'graphicsFormat.graphicsStyles.graphicsEffects': (ctx) => ['shadow', 'reflection', 'glow', 'softEdges', 'bevel', '3DRotation']
    .flatMap((k) => EFFECT_SETS[k](ctx).map((it) => ({ id: `${k}:${it.id}`, label: it.label, group: `${{ softEdges: 'Soft Edges', '3DRotation': '3-D Rotation' }[k] ?? k[0].toUpperCase() + k.slice(1)}: ${it.group}` }))),
};

for (const [id, eng] of Object.entries(ENGINE_GALLERIES)) GALLERIES[id] = both(GALLERIES[id], eng);
// The DOM editor has no artistic effects, so it gets an empty gallery.
GALLERIES[`${P}.adjust.artisticEffects`] = both(() => [], (ctx) => ARTISTIC.map((e) => ({ ...e, active: e.id === artisticId(adjOf(ctx)?.artistic) })));
// These read nothing of the DOM editor, so they serve a canvas draft as they are.
for (const id of ['graphicsFormat.change.changeGraphic', `${P}.pictureStyles.pictureEffects.glow.moreGlowColors`, 'insert.illustrations.screenshot',
  'graphicsFormat.graphicsStyles.graphicsEffects', 'graphicsFormat.graphicsStyles.styles', 'graphicsFormat.graphicsStyles.graphicsFill',
  'graphicsFormat.graphicsStyles.graphicsOutline']) GALLERIES[id] = both(GALLERIES[id]);

export default {
  id: 'picture-format',
  extensions: [DrawPictures],
  commands: COMMANDS,
  // Dropdowns and a submenu that work through their menus (parts.jsx menuLive), so they have no command of their own.
  implements: [`${P}.adjust.changePicture`, `${P}.pictureStyles.pictureEffects`, `${P}.size.crop.aspectRatio`],
  galleries: GALLERIES,
  dialogs: {
    insertPicture: InsertPicture,
    insertPictures: InsertPictures,
    compressPictures: CompressPictures,
    pictureCorrectionsOptions: paneDialog('picture.corrections'),
    pictureColorOptions: paneDialog('picture.color'),
    pictureTransparencyOptions: paneDialog('picture.transparency'),
  },
  panes: {
    formatPicture: { title: 'Format Picture', side: 'right', width: 18, Component: FormatPicturePane },
    altText: { title: 'Alt Text', side: 'right', width: 18, Component: AltTextPane },
  },
  // Crop mode ends with the Document that holds it.
  setup: () => () => endCrop(),
};
