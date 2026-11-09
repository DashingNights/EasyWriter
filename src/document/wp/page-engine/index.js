// page-engine (docs/plans/word/briefs/page-engine.md): pagination engine 2 lives in document/pagination.js and the pure layout in
// layout.mjs; this module binds Word's white space option (settings.word.display.whiteSpace) to it and lists the behaviours the
// engine delivers.
import { getState, subscribe } from '../../../app/store.js';
import { pageOptionsChanged, setPageOptions } from '../../pagination.js';
import { saveWord, wordSettings } from '../../word/settings.mjs';

// Side to Side and Multiple Pages (views, store viewsMove) draw whole pages as copies of the laid-out text, so white space shows
// while either is on: copies cut from pages joined without their margins came out as split boxes and detached footer strips.
const whiteSpace = () => wordSettings(getState().settings).display.whiteSpace !== false || (getState().viewsMove?.kind ?? 'vertical') !== 'vertical';

setPageOptions({
  whiteSpace,
  setWhiteSpace: (on) => saveWord({ display: { whiteSpace: !!on } }),
});
// The option changes through the Options dialog too: relayout when the stored value does.
let shown = whiteSpace();
subscribe(() => {
  const now = whiteSpace();
  if (now === shown) return;
  shown = now;
  pageOptionsChanged();
});

export default {
  id: 'page-engine',
  implements: [
    'paragraph.widowControl', 'paragraph.keepWithNext', 'paragraph.keepLinesTogether', 'paragraph.pageBreakBefore', 'paragraph.spaceAtPageTop',
    'sections.model', 'sections.verticalAlignment', 'sections.oddEvenBlank', 'sections.continuousNewPage', 'views.whiteSpace', 'sections.perSection',
  ],
};
