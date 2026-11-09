// Tab layout in static drawings (docs/plans/word plan.md §1.9 Static drawings): headers, footers and note areas drawn by page
// layers are DOM that editor plugins never see, so their owners call layoutTabs after drawing a part. The same line layout and
// span boxes as the editor's (measure.js), on DOM this function may change.
import { tabStopsOf } from '../../model/tabs.mjs';
import { boxStyle, layoutJobs, paraStyle } from './measure.js';

/** The paragraph's stops from its data-tabs attribute, merged by tabStopsOf. ponytail: a static drawing has no style chain here, so
 * only the paragraph's own stops count; the page-layer owner passes resolved stops through data-tabs when styles need it. */
function stopsOf(el) {
  try {
    return tabStopsOf({}, { attrs: { tabs: JSON.parse(el.getAttribute('data-tabs') ?? '[]') } }).stops;
  } catch {
    return [];
  }
}

/** Wraps each tab character inside `el` (outside existing boxes) in a span[data-tab] box. */
function wrapTabs(el) {
  const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.data.includes('\t') && !n.parentElement.closest('[data-tab], [data-ptab]')) texts.push(n);
  for (let n of texts) {
    for (let i = n.data.indexOf('\t'); i >= 0; i = n.data.indexOf('\t')) {
      const tab = n.splitText(i);
      n = tab.splitText(1);
      const span = el.ownerDocument.createElement('span');
      span.setAttribute('data-tab', '');
      tab.replaceWith(span);
      span.append(tab);
    }
  }
}

/** Lays out the tab characters inside `root` against `defaultTabStop` (pt), with `width` (px) as the column width for alignment
 * tabs relative to the margin when given. */
export function layoutTabs(root, { defaultTabStop = 36, width } = {}) {
  if (!root?.isConnected) return;
  const jobs = [];
  for (const el of root.querySelectorAll('p, h1, h2, h3, h4, h5, h6')) {
    if (!el.textContent.includes('\t') && !el.querySelector('[data-ptab]')) continue;
    wrapTabs(el);
    const spans = [...el.querySelectorAll('span[data-tab], span[data-ptab]')];
    jobs.push({ el, spans, stops: stopsOf(el), def: defaultTabStop, num: null, ...(width ? { width: width * 0.75 } : {}) });
  }
  if (!jobs.length) return;
  const zoom = root.getBoundingClientRect().width / root.offsetWidth || 1;
  layoutJobs(jobs, zoom).forEach((r, i) => {
    const { el, spans } = jobs[i];
    spans.forEach((s, k) => {
      const it = r.items[k];
      if (!it) return;
      s.style.cssText += `;${boxStyle(it)}`;
      if (s.hasAttribute('data-tab')) {
        s.setAttribute('data-align', it.align);
        s.setAttribute('data-leader', it.leader);
      }
    });
    if (r.ext) el.style.cssText += `;${paraStyle(r)}`;
  });
}
