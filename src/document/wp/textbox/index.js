// Text boxes and styled text (docs/plans/word/plan.md §3 textbox): the textBox node view and editing rules, the Text Box and Styled
// Text galleries, the draw and link pointer tools, Shape Format's Text and Styled Text Styles groups, and the Format Shape pane's
// text box sections. float-layout positions the boxes; shapes styles their fill and outline.
import { ctxOf } from '../../../tooling/registry.js';
import { COMMANDS, GALLERIES, setBox } from './commands.js';
import { TextBoxSection, TextSection } from './panels.jsx';
import { TextBoxEditing } from './view.js';

// Harness cases set box attributes the Format Shape pane edits (the pane is the shapes package's) through this seam.
globalThis.__wordTextbox = { setBox: (patch) => setBox(ctxOf(), patch) };

export default {
  id: 'textbox',
  extensions: [TextBoxEditing],
  commands: COMMANDS,
  galleries: GALLERIES,
  panels: { 'formatShape.textBox': TextBoxSection, 'formatShape.text': TextSection },
};
