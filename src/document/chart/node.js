// The chart node (docs/plans/word/left-out.md package 4): a chart from a .docx, read-only, inline like a picture or floating by
// its layout (float-layout places it). w and h are its extent in pt, model what svg.mjs draws (model.mjs, read at import), parts
// the package parts export writes back unchanged (parts.mjs). The editor, the header and footer layer, page copies, print and PDF
// all show what renderHTML draws: an inline-block of the chart's size holding the SVG. Without a DOM (node tests) it is the box.
import { Node } from '@tiptap/core';
import { readJson } from '../../office.mjs';
import { chartSvg } from './svg.mjs';

export const CHART_DEFAULTS = { w: 360, h: 216, layout: null, name: null, alt: '', model: null, parts: null };

export const Chart = Node.create({
  name: 'chart',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => Object.fromEntries(Object.entries(CHART_DEFAULTS).map(([k, def]) => [k, {
    default: def,
    parseHTML: (el) => readJson(el.getAttribute('data-json'))?.[k] ?? def,
    renderHTML: () => ({}),
  }])),
  parseHTML: () => [{ tag: 'span[data-chart]', priority: 60 }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const a = node.attrs;
    const attrs = {
      'data-chart': '', 'data-json': JSON.stringify(a), role: 'img', 'aria-label': a.alt || a.model?.title?.text || 'Chart',
      ...(a.layout && { 'data-layout': JSON.stringify(a.layout), 'data-wrap': a.layout.wrap ?? 'inline' }), ...HTMLAttributes,
      style: `display: inline-block; width: ${a.w}pt; height: ${a.h}pt; vertical-align: baseline; line-height: 0`,
    };
    if (typeof document === 'undefined') return ['span', attrs];
    const span = document.createElement('span');
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    span.innerHTML = chartSvg(a.model, a.w, a.h); // every text and attribute in it is escaped (svg.mjs)
    return span;
  },
  renderMarkdown: (node) => `[Chart${node.attrs?.model?.title?.text ? `: ${node.attrs.model.title.text}` : ''}]`,
});
