// The drawing grid layer and the guide settings (docs/plans/word briefs/arrange.md Gridlines): View > Gridlines draws the grid
// over each page's text area from the doc settings grid (plan.md §1.8); settings.word.guides holds the display and snapping flags.
import { getState } from '../../../app/store.js';
import { registerPageLayer } from '../../geometry.js';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { GRID_DEFAULTS, gridLines } from './order.mjs';

/** settings.word.guides, from `ctx`'s settings when given. */
export const guides = (ctx) => (ctx?.settings?.word ?? wordSettings(getState().settings)).guides;

/** Saves settings.word.guides `p` and redraws the grid layer, whose key reads it. */
export async function saveGuides(p) {
  await saveWord({ guides: p });
  registerPageLayer(GRID_LAYER);
}

const PX = 96 / 72;
const SVG = 'http://www.w3.org/2000/svg';

/** The drawing grid over each page's text area (View > Gridlines), under the text and never printed. */
export const GRID_LAYER = {
  id: 'arrange.grid',
  z: -1,
  key: (state, page) => (guides().gridlines ? JSON.stringify([state.doc.attrs.settings?.grid ?? null, page.box]) : ''),
  render(el, page, view) {
    el.replaceChildren();
    if (!guides().gridlines) return;
    const g = { ...GRID_DEFAULTS, ...view.state.doc.attrs.settings?.grid }; // points; the page box is in layout px
    const { box } = page;
    const { xs, ys } = gridLines(box, { ...g, h: g.h * PX, v: g.v * PX, x: g.x * PX, y: g.y * PX });
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('width', box.w);
    svg.setAttribute('height', box.h);
    svg.setAttribute('class', 'arrange-grid');
    const line = (x1, y1, x2, y2) => {
      const l = document.createElementNS(SVG, 'line');
      for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) l.setAttribute(k, v);
      svg.append(l);
    };
    for (const x of xs) line(x, box.top, x, box.h - box.bottom);
    for (const y of ys) line(box.left, y, box.w - box.right, y);
    el.append(svg);
  },
};
