// The Word layer's hub (docs/plans/word plan.md §1.2): every work package's module in §3 table order, registered here after the
// base commands (src/document/word/base.js), so no package edits a shared file. Keyed parts merge by the registries' rules;
// layers, passes, fields, providers and cards register here; extensions, setup and slots are read from MODULES by their owners
// (editors.js, the ribbon). Frozen after the scaffold.
import { DOCUMENT } from '../word/base.js';
import font from './font/index.js';
import paragraph from './paragraph/index.js';
import borders from './borders/index.js';
import tabs from './tabs/index.js';
import ruler from './ruler/index.js';
import lists from './lists/index.js';
import styles from './styles/index.js';
import stylePanes from './style-panes/index.js';
import design from './design/index.js';
import pageBackground from './page-background/index.js';
import clipboard from './clipboard/index.js';
import editingKeys from './editing-keys/index.js';
import find from './find/index.js';
import navpane from './navpane/index.js';
import fieldsCore from './fields-core/index.js';
import fieldsInfo from './fields-info/index.js';
import fieldsRef from './fields-ref/index.js';
import fieldsDraw from './fields-draw/index.js';
import toc from './toc/index.js';
import indexToa from './index-toa/index.js';
import citations from './citations/index.js';
import notes from './notes/index.js';
import sections from './sections/index.js';
import pageEngine from './page-engine/index.js';
import headersFooters from './headers-footers/index.js';
import layoutMisc from './layout-misc/index.js';
import columns from './columns/index.js';
import tableDesign from './table-design/index.js';
import tableLayout from './table-layout/index.js';
import tableTools from './table-tools/index.js';
import pictureFormat from './picture-format/index.js';
import floatLayout from './float-layout/index.js';
import arrange from './arrange/index.js';
import shapes from './shapes/index.js';
import textbox from './textbox/index.js';
import equations from './equations/index.js';
import symbols from './symbols/index.js';
import buildingBlocks from './building-blocks/index.js';
import comments from './comments/index.js';
import tracking from './tracking/index.js';
import markup from './markup/index.js';
import compare from './compare/index.js';
import protect from './protect/index.js';
import proofing from './proofing/index.js';
import views from './views/index.js';
import outline from './outline/index.js';
import statusbar from './statusbar/index.js';
import backstage from './backstage/index.js';
import print from './print/index.js';
import options from './options/index.js';
import autocorrect from './autocorrect/index.js';
import contextMenu from './context-menu/index.js';
import ribbonChrome from './ribbon-chrome/index.js';
import mailings from './mailings/index.js';
import contentControls from './content-controls/index.js';
import draw from './draw/index.js';
import marks from './marks/index.js';
import canvasEngine from '../canvas/index.js';
import { registerCards } from '../../tooling/cards.jsx';
import { registerPanes } from '../../tooling/panes.jsx';
import { noteDuplicate, registerModule } from '../../tooling/registry.js';
import { fieldType, registerField, registerFieldProvider } from '../fields/registry.mjs';
import { registerLayoutPass, registerPageLayer } from '../geometry.js';
import './harness.js';

/** Every work package's module in hub order. */
export const MODULES = [
  font, paragraph, borders, tabs, ruler, lists, styles, stylePanes, design, pageBackground, clipboard, editingKeys, find, navpane, fieldsCore,
  fieldsInfo, fieldsRef, fieldsDraw, toc, indexToa, citations, notes, sections, pageEngine, headersFooters, layoutMisc, columns, tableDesign,
  tableLayout, tableTools, pictureFormat, floatLayout, arrange, shapes, textbox, equations, symbols, buildingBlocks, comments, tracking, markup,
  compare, protect, proofing, views, outline, statusbar, backstage, print, options, autocorrect, contextMenu, ribbonChrome, mailings,
  contentControls, draw, marks, canvasEngine,
];

const fieldOwners = new Map(); // upper-case field name → the module that registered it

for (const mod of MODULES) {
  registerModule(mod, DOCUMENT); // Word's commands serve the Document surface only
  registerPanes(mod.id, mod.panes);
  for (const [id, source] of Object.entries(mod.cards ?? {})) registerCards(id, source);
  for (const layer of mod.layers ?? []) registerPageLayer(layer);
  for (const pass of mod.passes ?? []) registerLayoutPass(pass);
  for (const [key, fn] of Object.entries(mod.providers ?? {})) registerFieldProvider(key, fn);
  for (const [name, type] of Object.entries(mod.fields ?? {})) {
    const key = name.toUpperCase();
    // A duplicate field name is an error (§1.2), whether another module or a type registered at import holds it.
    if (fieldType(key)) noteDuplicate('field', key, fieldOwners.get(key) ?? 'fields registry', mod.id);
    else {
      registerField(key, type);
      fieldOwners.set(key, mod.id);
    }
  }
}

/** The modules' editor extensions in hub order; editors.js appends them to the Document kit after its own. */
export const EXTENSIONS = MODULES.flatMap((m) => m.extensions ?? []);

/** Runs every module's setup on a Document's main editor `editor` once it mounts → one cleanup for all of them. */
export function setupModules(editor) {
  const cleanups = MODULES.map((m) => m.setup?.(editor)).filter((f) => typeof f === 'function');
  return () => {
    for (const f of cleanups) f();
  };
}
