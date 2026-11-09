// What a Document's tools draw new shapes, lines and text boxes with (docs/plans/word/briefs/default-shape-look.md): the document's
// default looks from its theme (map.mjs defaultLooks), with the changes made on the canvas rail's options card over them. Insert >
// Shapes, the rail, tool search and the keys all draw through lookFor, and its canvases get it through canvas.js canvasLooks.
// The card's changes last for this Document until it closes and never go into the file: a tool option is the tool's, a user does
// not expect picking a colour for the next shape to change the document, and Set as Default Shape, Line and Text Box are how a look
// becomes the document's, as in Word (they drop the card's changes to the tools they cover).
import { canvasLooks } from '../../../canvas.js';
import { activeSurface } from '../../../tooling/surface.js';
import { defaultLooks, toolLook } from './map.mjs';

const changes = new WeakMap(); // a Document's main editor → {shape, conn, path}: the card's changes this session

/** The open Document's main editor, or null (a forum post, a plan, the flowchart editor: their boards keep the shared tools). */
const docEditor = () => {
  const s = activeSurface();
  return s?.kind === 'document' ? s.editor : null;
};

/** The look board tool `tool` ('shape' with shape kind `kind`, 'conn', 'path' → {open, closed}, 'textbox') draws with in Document `ed`. */
export function lookFor(ed, tool, kind = null) {
  // No autoFit: a shape drawn on a canvas takes its host's (canvas.js: a Document's keeps its size, a synced flowchart's grows).
  const look = toolLook(defaultLooks(ed?.state.doc.attrs.theme), tool, kind);
  const own = changes.get(ed)?.[tool];
  if (!own) return look;
  return tool === 'path' ? { open: { ...look.open, ...own }, closed: { ...look.closed, ...own } } : { ...look, ...own };
}

/** Insert > Shapes' look for Document `ed` (map.mjs shapeItem). */
export const looksIn = (ed) => (tool, kind) => lookFor(ed, tool, kind);

// The tools whose look each default sets.
const TOOLS = { spDef: ['shape', 'path'], lnDef: ['conn', 'path'], txDef: [] };

/** Drops the card's changes in Document `ed` to the tools default `key` covers. */
export function forgetChanges(ed, key) {
  const c = changes.get(ed);
  if (c) changes.set(ed, Object.fromEntries(Object.entries(c).filter(([tool]) => !TOOLS[key].includes(tool))));
}

canvasLooks.look = (tool, kind) => {
  const ed = docEditor();
  return ed ? lookFor(ed, tool, kind) : null;
};
canvasLooks.setLook = (tool, patch) => {
  const ed = docEditor();
  if (!ed) return false;
  const c = changes.get(ed) ?? {};
  changes.set(ed, { ...c, [tool]: { ...c[tool], ...structuredClone(patch) } });
  return true;
};
