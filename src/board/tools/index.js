// The board's tool modules, registered in the order their hooks are asked in (docs/plans/board/briefs/bd-select.md): a later
// package fills its own stub. BoardArea mounts them once its context exists.
import { registerTool } from './registry.js';
// A tool file that registers itself does so as it is imported, so dragout's import comes first: a move dropped on a page is its to
// answer before connect, layers and clip's Alt+drag duplicate see it.
import dragout from './dragout.js';
import journal from './journal.js';
import instance from './instance.js';
import section from './section.js';
import connect from './connect.js';
import layers from './layers.js';
import text from './text.js';
import pictures from './pictures.js';
import pen from './pen.js';
import place from './place.js';
import clip from './clip.js';
import snap from './snap.js';
import hud from './hud.js';
import a11y from './a11y.js';

export const modules = [journal, dragout, instance, section, connect, layers, text, pictures, pen, place, clip, snap, hud, a11y];
for (const module of modules) registerTool(module);
