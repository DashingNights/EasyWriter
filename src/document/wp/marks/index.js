// Formatting marks (docs/plans/word/briefs/marks.md): Show All (Ctrl+Shift+8 through the keymap row), the editor decorations
// (plugin.js), the CSS under #editor-area[data-marks] (style.css) and one page layer for crop marks and text boundaries.
import { saveWord } from '../../word/settings.mjs';
import { boundaryRect, cropLines } from './kinds.mjs';
import { WordMarks } from './plugin.js';

const SVG = 'http://www.w3.org/2000/svg';

// Harness cases set the always-show boxes, crop marks and text boundaries here until the Options dialog writes them (as
// window.__word.ribbon does for the store).
if (typeof window !== 'undefined') window.__word = Object.assign(window.__word ?? {}, { marks: { save: saveWord } });

/** Crop marks and the text boundary of one page. Both are always drawn; style.css shows them by the editor root's
 * data-wm-crop and data-wm-bounds (plugin.js) and only in Print Layout, so a settings change needs no relayout. */
const pageMarks = {
  id: 'marks.page',
  z: 3,
  key: (_state, page) => JSON.stringify(page.box),
  render(el, page) {
    const d = el.ownerDocument;
    const svg = d.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'wm-crop');
    svg.setAttribute('width', page.box.w);
    svg.setAttribute('height', page.box.h);
    for (const l of cropLines(page.box)) {
      const line = svg.appendChild(d.createElementNS(SVG, 'line'));
      for (const k of ['x1', 'y1', 'x2', 'y2']) line.setAttribute(k, l[k]);
    }
    const r = boundaryRect(page.box);
    const bounds = d.createElement('div');
    bounds.className = 'wm-bounds';
    bounds.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    el.append(svg, bounds);
  },
};

export default {
  id: 'marks',
  extensions: [WordMarks],
  commands: {
    'home.paragraph.showAll': {
      // Declined outside a Document, so the chord keeps its app meaning there.
      run: (ctx) => (ctx.ed ? (saveWord({ marks: { all: !ctx.settings?.word?.marks?.all } }), true) : false),
      active: (ctx) => !!ctx.settings?.word?.marks?.all,
    },
  },
  layers: [pageMarks],
  implements: ['marks.glyphs', 'marks.alwaysShow', 'marks.textBoundaries', 'marks.cropMarks', 'tabs.showMark', 'keys.showAllKey'],
};
