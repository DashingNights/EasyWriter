// The page background's page layers (plan.md §1.9): the fill (Fill Effects) at the lowest z, rule and grid lines, the watermark,
// page borders behind the text (zOrder back) and in front of it. Each draws into the div the engine places over the page's paper;
// none takes the pointer, so nothing here is selectable.
import { borderCss, fontStack } from '../../../office.mjs';
import { sectionsOf } from '../../model/sections.mjs';
import { autoWatermarkSize, borderBox, bordersShowOn, fillCss, ruleCss } from './model.mjs';

const ids = new WeakMap();
let next = 0;
/** A short id per stored object, so a layer key names a watermark or a fill without serialising its data URL. */
const idOf = (o) => {
  if (!o || typeof o !== 'object') return '-';
  if (!ids.has(o)) ids.set(o, ++next);
  return ids.get(o);
};

const boxKey = ({ box }) => `${box.w}x${box.h}:${box.top},${box.right},${box.bottom},${box.left},${box.header},${box.footer}`;
const sectOf = (state, page) => sectionsOf(state.doc).at(page.section)?.sect ?? null;
const bg = (state) => state.doc.attrs.background ?? null;
const shown = (state) => !!state.doc.attrs.settings?.displayBackground;

/** A div covering `rect` ({left, top, width, height} in px of the paper) inside layer div `el`. */
function piece(el, rect, css = '') {
  const d = el.ownerDocument.createElement('div');
  d.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;${css}`;
  el.append(d);
  return d;
}
const paper = ({ box }) => ({ left: 0, top: 0, width: box.w, height: box.h });
const margins = ({ box }) => ({ left: box.left, top: box.top, width: box.text, height: box.body });
const bgCss = (c) => c && `background-image:${c.image};background-size:${c.size};background-repeat:${c.repeat};`
  + `background-position:${c.position ?? '0 0'}`;

const fill = {
  id: 'pageBackground.fill',
  z: -30,
  key: (state, page) => `${shown(state)}:${idOf(bg(state)?.fill)}:${boxKey(page)}`,
  render(el, page, view) {
    const f = bg(view.state)?.fill;
    const css = shown(view.state) && fillCss(f, { page: true });
    if (css) piece(el, paper(page), bgCss(css)).dataset.fill = f.kind ?? f.type;
  },
};

const rules = {
  id: 'pageBackground.rules',
  z: -25,
  key: (state, page) => `${idOf(bg(state)?.rule)}:${boxKey(page)}`,
  render(el, page, view) {
    const rule = bg(view.state)?.rule;
    const css = ruleCss(rule?.kind);
    if (css) piece(el, rule.full ? paper(page) : margins(page), bgCss(css)).dataset.rule = rule.kind;
  },
};

let measurer = null;
/** The width of `text` at 1 pt in CSS font stack `family`. */
function perPt(text, family) {
  measurer ??= document.createElement('canvas').getContext('2d');
  measurer.font = `100pt ${family}`;
  return measurer.measureText(text).width / ((100 * 4) / 3);
}

// Fonts that finish loading change the Auto size measured above, so the key carries a count of finished loads. Web fonts reflow
// the text when they load, so the next layout pass after a load redraws the watermark.
let fontLoads = 0;
globalThis.document?.fonts?.addEventListener?.('loadingdone', () => { fontLoads += 1; });
const familyOf = (wm, state) => fontStack(wm.font || '+minor', state.doc.attrs.theme);

const watermark = {
  id: 'pageBackground.watermark',
  z: -20,
  key: (state, page) => {
    const wm = sectOf(state, page)?.watermark;
    const font = wm?.kind === 'picture' || !wm ? '' : `${familyOf(wm, state)}:${fontLoads}`;
    return `${idOf(wm)}:${font}:${boxKey(page)}`;
  },
  render(el, page, view) {
    const wm = sectOf(view.state, page)?.watermark;
    if (!wm) return;
    const { box } = page;
    const centre = `left:${box.left + box.text / 2}px;top:${box.top + box.body / 2}px;`; // Word centres it on the margins box (v)
    const d = el.ownerDocument;
    if (wm.kind === 'picture') {
      if (!wm.src) return;
      const img = d.createElement('img');
      img.src = wm.src;
      img.alt = '';
      img.draggable = false;
      img.dataset.watermark = 'picture';
      if (wm.washout !== false) img.dataset.washout = '';
      // Washout: lighter and lower in contrast, as Word's (v; Word's numbers are brightness 85 and contrast 15).
      const filter = wm.washout !== false ? 'filter:contrast(0.3) brightness(1.7);' : '';
      img.style.cssText = `position:absolute;${centre}transform:translate(-50%,-50%);max-width:none;${filter}`
        + (wm.scale ? '' : `width:${box.text}px;max-height:${box.body}px;object-fit:contain`);
      // A set scale is the picture's own size times the percent, known once it loads.
      if (wm.scale) img.onload = () => { img.style.width = `${(img.naturalWidth * wm.scale) / 100}px`; };
      el.append(img);
      return;
    }
    if (!wm.text) return;
    const family = familyOf(wm, view.state);
    const layout = wm.layout === 'horizontal' ? 'horizontal' : 'diagonal';
    const size = wm.size ?? autoWatermarkSize(perPt(wm.text, family), box.text * 0.75, box.body * 0.75, layout);
    const t = d.createElement('div');
    t.textContent = wm.text;
    t.dataset.watermark = 'text';
    t.dataset.rotate = layout === 'diagonal' ? '315' : '0';
    t.style.cssText = `position:absolute;${centre}transform:translate(-50%,-50%) rotate(${t.dataset.rotate}deg);white-space:pre;`
      + `line-height:1.2;font-family:${family};font-size:${size}pt;color:${wm.color || '#000000'};opacity:${wm.semi === false ? 1 : 0.5};user-select:none`;
    el.append(t);
  },
};

/** A page border layer for `zOrder`: back draws under the text, front over it (Always display in front). */
const borders = (zOrder, z) => ({
  id: zOrder === 'back' ? 'pageBackground.bordersBack' : 'pageBackground.borders',
  z,
  key: (state, page) => {
    const b = sectOf(state, page)?.pgBorders;
    const s = state.doc.attrs.settings;
    return `${idOf(b)}:${bordersShowOn(b, page.inSection)}:${!!s?.bordersDoNotSurroundHeader}${!!s?.bordersDoNotSurroundFooter}:${boxKey(page)}`;
  },
  render(el, page, view) {
    const sect = sectOf(view.state, page);
    const b = sect?.pgBorders;
    if (!b || (b.zOrder === 'back') !== (zOrder === 'back') || !bordersShowOn(b, page.inSection)) return;
    const at = borderBox(b, sect.margin, view.state.doc.attrs.settings ?? {});
    if (!at) return;
    const { box } = page;
    const pxOf = (pt) => (pt * 4) / 3;
    // An undrawn side keeps its place 24 pt in, so the drawn sides meet as Word draws them.
    const inset = Object.fromEntries(['top', 'right', 'bottom', 'left'].map((s) => [s, pxOf(at[s] ?? 24)]));
    const css = ['top', 'right', 'bottom', 'left'].map((s) => `border-${s}:${b[s] ? borderCss(b[s]) : 'none'};`).join('');
    const shadow = ['right', 'bottom'].map((s) => b[s]).find((e) => e?.shadow);
    const d = piece(el, { left: inset.left, top: inset.top, width: box.w - inset.left - inset.right, height: box.h - inset.top - inset.bottom },
      `box-sizing:border-box;${css}${shadow ? `box-shadow:${shadow.width ?? 0.5}pt ${shadow.width ?? 0.5}pt 0 ${(shadow.width ?? 0.5) / 2}pt `
        + `${shadow.color && shadow.color !== 'auto' ? shadow.color : '#000000'};` : ''}`);
    d.dataset.pageBorder = b.zOrder === 'back' ? 'back' : 'front';
  },
});

export const LAYERS = [fill, rules, watermark, borders('back', -5), borders('front', 2)];
