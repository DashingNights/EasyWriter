// engine-viewport (docs/plans/engine/plan.md section 2): the canvas page area, its overlay layer and the Canvas engine switch.
// The switch is settings.word.canvasEngine, its default formats.mjs DOCUMENTS_ON_ENGINE: the View command here, its tool search entry (the command's meta),
// and the row under Word Options > Advanced > Display. While it is on, the open Document is edited and saved in the canvas page
// area; a canvas draft opens there either way (session.js setCanvasEngine). `engine` is the tooling-to-engine table
// (commands.mjs) the tools follow on a focused canvas draft (viewport-design.md section 4.7).
import { createElement as h } from 'react';
import { Cpu, Rows2 } from 'lucide-react';
import { toast } from '../../app/actions.js';
import { Help } from '../../app/components/Tip.jsx';
import { getState } from '../../app/store.js';
import { isCanvas } from '../../engine/model/form.mjs';
import { CanvasSlot } from './PageArea.jsx';
import { setCanvasEngine } from './session.js';
import { saveWord } from '../word/settings.mjs';
import { ENGINE_COMMANDS, sessionRows } from './commands.mjs';
import { POST_ROWS } from './rows/post.mjs';
import { bindReviewApp } from './rows/review.mjs';
import { registerModule } from '../../tooling/registry.js';
import { CHART_DIALOGS } from './charts/dialogs.jsx';
import { CHART_GALLERIES } from './charts/galleries.js';
import { SMART_ART_PARTS } from './smart-art/index.js';
import { registerFrameKind } from './overlay.jsx';
import { BoxFrame } from './boxes.jsx';
import { SignatureSetup } from './SignatureSetup.jsx';

export { registerFrameKind, registerOverlay, setMarks, ptBox } from './overlay.jsx';

// EasyWriter's own objects in an engine Document (smart canvases, plan charts) draw live over their fallback pictures.
registerFrameKind('box', BoxFrame);
// A forum post's (or core page's) canvas draft is a text surface: its tools run through the post kit's rows (rows/post.mjs).
registerModule({ id: 'canvas-post', engine: POST_ROWS }, ['text']);
// View > Split's row reads the app's page movement (review.mjs's move()).
bindReviewApp({ move: () => getState().viewsMove });

/** "A", "A and B", "A, B and C". */
const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Print and Create PDF on a canvas draft (commands.mjs sessionRows), with the app's dialogs and notices. */
const SESSION_ROWS = sessionRows({
  title: () => getState().draft?.title,
  saveFile: (file) => (globalThis.__wordTest?.word ?? window.api.word).saveFile(file),
  error: (text) => toast(text, true),
  // A saved PDF draws a font as outlines when its licence forbids embedding it there or it cannot be embedded: say so in one
  // line, the families behind the (?).
  notice: (families) => toast(h('span', { className: 'inline-flex items-center gap-1', 'data-pdf-outlined': '' },
    'Some text in this PDF is drawn as shapes, so it cannot be selected.',
    h(Help, { label: 'Which fonts' }, `The fonts drawn as shapes are ${listed(families)}. A font's licence can forbid embedding it `
      + 'in a saved PDF, and some fonts cannot be embedded.'))),
});

/** Whether the open Document shows in the canvas page area: the switch is on, or the draft is a canvas draft. */
const shown = (ctx) => !!ctx.settings.word.canvasEngine || isCanvas(getState().draft);

export default {
  id: 'canvas-engine',
  engine: { ...ENGINE_COMMANDS, ...SESSION_ROWS }, // the hub registers it for the Document surface (registry registerModule)
  dialogs: { ...CHART_DIALOGS, signatureSetup: SignatureSetup, ...SMART_ART_PARTS.dialogs },
  panes: SMART_ART_PARTS.panes,
  galleries: { ...CHART_GALLERIES, ...SMART_ART_PARTS.galleries },
  commands: {
    'view.canvasEngine': {
      run: (ctx) => setCanvasEngine(!shown(ctx)),
      active: shown,
      meta: {
        label: 'Canvas engine', group: 'View', icon: Cpu, toggle: true,
        keywords: ['canvas engine', 'webassembly', 'wasm', 'engine', 'renderer', 'pages on canvas', 'new editor'],
      },
    },
    // The app's own view option, not Word's: Print Layout keeps one page to a row however far it zooms out.
    'view.onePageRow': {
      run: (ctx) => saveWord({ onePageRow: !ctx.settings.word.onePageRow }),
      active: (ctx) => !!ctx.settings.word.onePageRow,
      meta: {
        label: 'One page per row', group: 'View', icon: Rows2, toggle: true,
        keywords: ['one page per row', 'single page', 'one column', 'pages side by side', 'two pages', 'vertical pages', 'page layout'],
      },
    },
  },
  slots: { viewport: CanvasSlot },
};
