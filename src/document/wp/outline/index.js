// Outline view and the Outlining tab (docs/plans/word/plan.md §3 outline): the outline tree drawn by node decorations, its
// commands and keys, and the Outline Level and Show Level lists. Master Document's two controls stay placeholders (subdocs).
import { ACT, COMMANDS, GALLERIES } from './commands.js';
import { outlineExtension } from './plugin.js';

export default {
  id: 'outline',
  extensions: [outlineExtension(ACT)],
  commands: COMMANDS,
  galleries: GALLERIES,
  implements: ['outline.symbols'],
};
