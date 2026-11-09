// Equations and the Equation tab (docs/plans/word plan.md §3 equations, briefs/equations.md): equation nodes typed in
// UnicodeMath or LaTeX and drawn as MathML, Insert > Equation and Alt+=, the Equation tab, Equation Options, display and inline
// equations, Math AutoCorrect and its tab in the AutoCorrect dialog.
import { createElement } from 'react';
import { COMMANDS, galleries } from './commands.js';
import { EquationOptions, MathAutoCorrectPanel, RecognizedMathFunctions } from './dialogs.jsx';
import { commit, equationExtension, sessionOf } from './view.js';

// A gallery tile's preview: MathML our printer made from a built-in template (escaped text, no attributes from outside).
// Inline style: menus draw outside the ribbon, where no Document-scoped rule reaches.
const TILE = { display: 'inline-block', maxWidth: '100%', overflow: 'hidden', fontFamily: '"Cambria Math", math' };
// `big`: a Structures tile in its grid, drawn larger as Word draws them.
const mathTile = (html, label, big) => createElement('span', { style: big ? { ...TILE, fontSize: '1.4rem' } : TILE, 'aria-hidden': true, title: label, dangerouslySetInnerHTML: html });

export default {
  id: 'equations',
  extensions: [equationExtension],
  commands: COMMANDS,
  dialogs: { equationOptions: EquationOptions, recognizedMathFunctions: RecognizedMathFunctions },
  galleries: galleries(mathTile),
  panels: { 'autocorrect.mathAutoCorrect': MathAutoCorrectPanel },
  implements: ['keys.equationKey', 'autocorrect.mathAutoCorrect', 'equation'],
  // An equation still open when the Document closes is written back first.
  setup: (editor) => () => {
    if (sessionOf(editor) && !editor.isDestroyed) commit(editor.view, 'keep');
  },
};
