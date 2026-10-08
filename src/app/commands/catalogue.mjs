import { defs as app } from './app.mjs';
import { defs as batch } from './batch.mjs';
import { defs as board } from './board.mjs';
import { defs as canvas } from './canvas.mjs';
import { defs as commands } from './commands.mjs';
import { defs as computer } from './computer.mjs';
import { defs as connectors } from './connectors.mjs';
import { defs as doc } from './doc.mjs';
import { defs as drafts } from './drafts.mjs';
import { defs as exportDefs } from './export.mjs';
import { defs as flow } from './flow.mjs';
import { defs as history } from './history.mjs';
import { defs as render } from './render.mjs';
import { ID, ITEM, ITEM_BRIEF, PATH, TAG_ID, URL } from './schema-defs.mjs';
import { defs as settings } from './settings.mjs';
import { defs as threads } from './threads.mjs';
import { defs as tool } from './tool.mjs';
import { defs as ui } from './ui.mjs';

// Every command (SPEC §8 Catalogue). Node-importable: node --test imports it (test/commands-contract.test.mjs).

export const CATALOGUE = [...app, ...ui, ...settings, ...threads, ...drafts, ...doc, ...board, ...connectors, ...flow, ...render, ...computer, ...canvas, ...exportDefs, ...history, ...tool, ...batch, ...commands];

export const $defs = { ID, PATH, URL, TAG_ID, ITEM };

/** $defs for the model form of the tools (tools-schema.mjs toolsFor form 'model'): ITEM as one flat object. */
export const MODEL_DEFS = { ...$defs, ITEM: ITEM_BRIEF };

const ids = new Map(CATALOGUE.map((d) => [d.id, d]));
if (ids.size !== CATALOGUE.length) throw new Error('command ids must be unique');

/** The command `id`, or null. */
export const byId = (id) => ids.get(id) ?? null;
