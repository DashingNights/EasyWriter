// Drawing of the picture attributes (docs/plans/word plan.md §1.8 Picture node view): the scaffold's view puts adjust, effects,
// border and crop on the img as data attributes, and replaces the img's style attribute on every update. So the drawing lives in
// one stylesheet with a rule per distinct combination of those attributes, keyed on their values, plus one hidden SVG holding the
// filters that CSS cannot say (Word's additive brightness, tone, recolor, sharpen, transparent colour, inner shadows and bevels).
// The rules override the scaffold's percent-based --pic-filter and --pic-opacity, since adjust holds fractions.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { adjustFilters, DASHES, effectsCss, filterSvg, shapeClip } from './pictures.mjs';

const SCOPE = '.page[data-format="document"] .ProseMirror img';
const filters = new Map(); // primitives → filter id
const ruled = new Set(); // rule keys already written
let sheet = null;
let defs = null;

function host() {
  if (sheet?.isConnected && defs?.isConnected) return;
  sheet = document.createElement('style');
  sheet.id = 'picture-format-rules';
  document.head.append(sheet);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  svg.append(defs);
  document.body.append(svg);
  filters.clear();
  ruled.clear();
}

/** The id of the shared SVG filter drawing `adjust` and the inner effects `inner`, made on first use, or null when none is needed. */
export function filterIdOf(adjust, inner = []) {
  const body = filterSvg(adjust, inner);
  if (!body) return null;
  host();
  let id = filters.get(body);
  if (!id) {
    id = `pf-${filters.size + 1}`;
    filters.set(body, id);
    const f = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    f.id = id;
    f.setAttribute('color-interpolation-filters', 'sRGB');
    // Room around the picture for the inner shadows' offsets (outer shadows are CSS drop-shadows).
    f.setAttribute('x', '-5%');
    f.setAttribute('y', '-5%');
    f.setAttribute('width', '110%');
    f.setAttribute('height', '110%');
    f.innerHTML = body;
    defs.append(f);
  }
  return id;
}

/** The CSS (camelCase properties, React style shape) that draws a picture's `attrs` beyond the scaffold's own rules. */
export function pictureCss(attrs) {
  const a = adjustFilters(attrs.adjust);
  const fx = effectsCss(attrs.effects);
  const id = filterIdOf(attrs.adjust, fx.inner);
  const css = {};
  const filter = [id && `url(#${id})`, ...a.css, ...fx.filter].filter(Boolean).join(' ');
  if (attrs.adjust || attrs.effects) css.filter = filter || 'none';
  if (attrs.adjust) css.opacity = String(a.opacity);
  if (fx.transform) css.transform = `${fx.transform} rotate(var(--pic-rotate, 0deg)) scale(var(--pic-flip-h, 1), var(--pic-flip-v, 1))`;
  if (fx.mask) Object.assign(css, { maskImage: fx.mask, maskComposite: 'intersect', WebkitMaskImage: fx.mask, WebkitMaskComposite: 'source-in' });
  if (fx.reflect) css.WebkitBoxReflect = fx.reflect;
  const clip = shapeClip(attrs.crop?.shape);
  if (clip) css.clipPath = clip;
  const dash = DASHES.find((d) => d.id === attrs.border?.dash)?.css;
  if (dash && dash !== 'solid') css.outlineStyle = dash;
  if (attrs.border?.color === 'none') css.outline = 'none';
  return css;
}

const kebab = (k) => (k.startsWith('Webkit') ? `-webkit-${k.slice(6)}` : k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const KEYS = [['adjust', 'data-adjust'], ['effects', 'data-effects'], ['border', 'data-pic-border'], ['crop', 'data-crop']];

/** Writes the rule for a picture with `attrs` unless it exists. The selector names every attribute it holds, so a picture with more
 * attributes matches a more specific rule than one made for fewer. */
function ensureRule(attrs) {
  const parts = KEYS.filter(([k]) => attrs[k] != null).map(([k, data]) => `[${data}=${CSS.escape(JSON.stringify(attrs[k]))}]`);
  if (!parts.length) return;
  const sel = `${SCOPE}${parts.join('')}`;
  if (ruled.has(sel)) return;
  const css = pictureCss(attrs);
  host();
  ruled.add(sel);
  const body = Object.entries(css).map(([k, v]) => `${kebab(k)}: ${v}`).join('; ');
  if (body) sheet.append(`${sel} { ${body}; }\n`);
}

/** Every picture of `doc` gets its rule. */
function scan(doc) {
  doc.descendants((node) => {
    if (node.type.name === 'image') ensureRule(node.attrs);
    return node.isBlock || node.type.name === 'image' ? true : undefined;
  });
}

// ponytail: rules and filters stay for the session even when no picture uses them any more; a few hundred bytes each.
export const DrawPictures = Extension.create({
  name: 'pictureFormatDraw',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('pictureFormatDraw'),
      view(view) {
        scan(view.state.doc);
        return { update(v, prev) {
          if (v.state.doc !== prev.doc) scan(v.state.doc);
        } };
      },
    })];
  },
});
