// Work package ruler (docs/plans/word/plan.md §3 ruler): the horizontal ruler in the belowRibbon slot, the vertical one in the
// viewport slot, View > Show > Ruler and keyboard ruler mode (Ctrl+Shift+F10). Settings: settings.word.ruler and verticalRuler.
import { saveWord } from '../../word/settings.mjs';
import { HorizontalRuler, VerticalRuler } from './Ruler.jsx';

/** Focuses the first marker of the horizontal ruler (keyboard ruler mode) → false when no ruler shows. */
function keyboardRuler() {
  const first = document.querySelector('[data-ruler="h"] [data-marker="firstLine"]') ?? document.querySelector('[data-ruler] [data-marker]');
  if (!first) return false;
  first.focus();
  return true;
}

export default {
  id: 'ruler',
  slots: { belowRibbon: HorizontalRuler, viewport: VerticalRuler },
  commands: {
    'view.show.ruler': {
      active: (ctx) => ctx.settings?.word?.ruler !== false,
      run: (ctx) => saveWord({ ruler: ctx.settings?.word?.ruler === false }),
    },
    'ruler.keyboardRuler': { run: keyboardRuler },
  },
  implements: [
    'ruler.horizontal', 'ruler.vertical', 'ruler.tabSelector', 'ruler.clickSetsTab', 'ruler.dragTab', 'ruler.firstLineIndent',
    'ruler.hangingIndent', 'ruler.leftIndent', 'ruler.rightIndent', 'ruler.marginBoundaries', 'ruler.snap', 'ruler.altDrag',
    'ruler.guideLine', 'ruler.doubleClick', 'ruler.defaultTicks', 'ruler.tooltips', 'ruler.columnMarkers', 'ruler.tableColumnMarkers',
    'ruler.tableRowMarkers', 'ruler.selectionStops', 'ruler.units',
  ],
};
