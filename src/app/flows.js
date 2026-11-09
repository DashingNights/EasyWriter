import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { canvasEditor, flowSource, liveBoard, openCanvasEditor } from '../canvas.js';
import { flowRefs } from '../doc-utils.mjs';
import { fromGraph, toGraph } from '../flow/graph.mjs';
import { layout } from '../flow/layout.mjs';
import { FLOW_SIZE, parseFlow, stateOf, summaryOf } from '../flow/library.mjs';
import { parseMermaid, toMermaid } from '../flow/mermaid.mjs';
import { defaultMeasure, moveItem } from '../flow/model.mjs';
import { resolveConnectors } from '../flow/route.mjs';
import { flowPreset, rotBox, rotOf } from '../flow/shapes.mjs';
import { boardBeforeCaret, columnWidth, diagramPaste, exportDensity, groupBox, rasterizeWhiteboard, setConnTool, setShapeTool } from '../whiteboard.js';
import { engineHost } from '../engine/client.js';
import { adopt, isCanvas, modelBytes, unreadable } from '../engine/model/form.mjs';
import { boardPicture } from '../export.js';
import { base64 } from '../tooling/base64.mjs';
import { areaOpens } from '../tooling/surface.js';
import { afterNodeSel, confirmDialog } from './actions.js';
import { can } from './gates.mjs';
import { getState, setState } from './store.js';
import { closeWorkspace, openWorkspace } from './views.js';

// The flowchart library's store (flowchart plan §3.8–§3.9, §4, §5.1, §5.10; roadmap B4): one record per
// `userData/flowcharts/<uuid>.json` (api.flows), the thread's flowcharts listed by `threadUrl` (null: "No thread"), loaded
// lazily, written coalesced (300 ms per record) one after another. Every library write bumps the record's `rev` and joins
// its sync chain (library.mjs) for the synced canvases' undo rule; the library editor has an undo stack per record (in
// memory). canvas.js reaches the store through `flowSource`, filled by initFlows().

const api = window.api;
const state = getState();
const LIMIT = 50; // undo steps per record
const MERGE_MS = 500; // library editor commits closer than this are one undo step (as the document's history)

let summaries = []; // every record's summaryOf, newest `updated` first: the list
const records = new Map(); // id → loaded record
const loading = new Map(); // id → its load in flight
const missing = new Set(); // ids no record was found for
const chains = new Map(); // id → this session's library writes (library.mjs)
const stacks = new Map(); // id → the library editor's undo stack {past, future, at}: [{rev, board}]
const timers = new Map(); // id → its pending write
let writes = Promise.resolve();
let pending = 0; // writes sent, not yet answered
let version = 0; // what useFlows() re-renders on

const chainOf = (id) => chains.get(id) ?? chains.set(id, new Map()).get(id);
const openDialog = (type, props = {}) => new Promise((resolve) => setState({ dialog: { type, props, resolve } }));
const frames = (n) => new Promise((resolve) => {
  const tick = () => (--n ? requestAnimationFrame(tick) : resolve());
  requestAnimationFrame(tick);
});

function notify(id, by = null) {
  version++;
  flowSource.changed(id, by);
}

function touch(r) {
  summaries = [summaryOf(r), ...summaries.filter((s) => s.id !== r.id)].sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

function persist(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const r = records.get(id);
  if (!r) return writes;
  const copy = { ...r };
  pending++;
  writes = writes.then(() => api.flows.save(copy)).then(
    ({ created, updated }) => Object.assign(r, { created, updated }),
    (e) => toast.error(`Could not save the flowchart: ${e.message || e}`), // the next change writes it again
  ).finally(() => pending--);
  return writes;
}

function schedule(id) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => persist(id), 300));
}

/** The record `id`, loaded once (calls in flight are shared); null when it does not exist (then it counts as missing). */
export function loadFlow(id) {
  if (records.has(id)) return Promise.resolve(records.get(id));
  if (missing.has(id)) return Promise.resolve(null);
  if (!loading.has(id)) {
    loading.set(id, api.flows.load(id).catch(() => null).then((json) => {
      loading.delete(id);
      const r = parseFlow(json);
      if (r?.id === id) records.set(id, r);
      else missing.add(id);
      notify(id);
      return records.get(id) ?? null;
    }));
  }
  return loading.get(id);
}

/** A library write (§3.9): the new board, rev + 1, a chain entry {pred, origin, as}. `origin`: the writing draft,
 * 'library' or 'agent'; `as`: the rev of the state the write restores; `by`: the view that wrote it. → the new rev. */
function save(id, board, { origin, as = null, by = null } = {}) {
  const r = records.get(id);
  if (!r) return null;
  const chain = chainOf(id);
  const rev = r.rev + 1;
  chain.set(rev, { pred: r.rev, origin, ...(as != null && { as: stateOf(chain, as) }) });
  Object.assign(r, { rev, board, updated: Date.now() });
  if (origin !== 'library') stacks.delete(id); // its undo would put back a board without this write
  touch(r);
  schedule(id);
  notify(id, by);
  return rev;
}

/** Startup: the library summaries (after the drafts list); fills `flowSource` for the synced canvases. */
export async function initFlows() {
  Object.assign(flowSource, {
    get: (id) => records.get(id) ?? null,
    load: loadFlow,
    save,
    isMissing: (id) => missing.has(id),
    title: (id) => records.get(id)?.title ?? summaries.find((s) => s.id === id)?.title ?? null,
    chain: chainOf,
    origin: () => state.draft?.id ?? state.draft, // per draft, so its undo after a draft switch still writes back
    open: (id) => openFlows(id),
  });
  diagramPaste.offer = (board, text) => importDiagram({ board, text });
  // Closing the window waits for the library writes (as for the draft's own save, actions.js onBeforeUnload).
  window.addEventListener('beforeunload', (e) => {
    if (state.smoke || state.syncReload || !(timers.size || pending)) return; // syncReload: GitHub backup (actions.js startGitHub)
    e.preventDefault();
    e.returnValue = false;
    flushFlows().then(() => (state.forceClose || !(state.dirty || state.saving)) && window.close()); // else the draft's save closes it
  });
  try {
    summaries = (await api.flows.list()).filter((s) => typeof s?.id === 'string').map((s) => ({
      ...s, title: typeof s.title === 'string' ? s.title : 'Flowchart', threadUrl: typeof s.threadUrl === 'string' ? s.threadUrl : null,
    }));
  } catch {
    summaries = [];
  }
  version++;
}

/** Writes the pending library writes at once. */
export function flushFlows() {
  for (const id of [...timers.keys()]) persist(id);
  return writes;
}

/** Re-renders the calling component on every library change. */
export const useFlows = () => useSyncExternalStore(flowSource.subscribe, () => version);

/** Every record's summary {id, threadUrl, title, created, updated, rev, items}, newest first. */
export const flowList = () => summaries;
export const getFlow = (id) => records.get(id) ?? null;

/** The thread a new flowchart goes to: the open draft's, else the selected one, else none. */
export const draftThread = () => state.draft?.threadUrl ?? state.settings?.selectedThread ?? null;
const defaultTitle = (threadUrl) => `Flowchart ${summaries.filter((s) => s.threadUrl === threadUrl).length + 1}`;

/** A new record (rev 1; the 1200 × 675 board unless `board`; `source`: the Mermaid text it came from), written at once. */
export function createFlow({ title, threadUrl = null, board = FLOW_SIZE, source = null } = {}) {
  const r = parseFlow({ id: crypto.randomUUID(), threadUrl, title: title ?? defaultTitle(threadUrl), rev: 1, board, source });
  records.set(r.id, r);
  touch(r);
  persist(r.id);
  notify(r.id);
  return r;
}

/** Library New flowchart: a new record in `threadUrl`, opened in the library editor. */
export const newFlow = (threadUrl = draftThread()) => openFlows(createFlow({ threadUrl }).id);

/** Rename (`title`) and Move to project (`threadUrl`): the record only, no rev (the board is unchanged). */
export async function updateFlow(id, patch) {
  const r = await loadFlow(id);
  if (!r) return;
  if ('title' in patch) {
    const title = String(patch.title).trim().slice(0, 120);
    if (!title || title === r.title) return;
    r.title = title;
  }
  if ('threadUrl' in patch) r.threadUrl = patch.threadUrl ?? null;
  r.updated = Date.now();
  touch(r);
  schedule(id);
  notify(id);
}

/** A new record with a copy of the board, "<title> (copy)"; synced canvases keep pointing at the original. */
export async function duplicateFlow(id) {
  const r = await loadFlow(id);
  return r && createFlow({ title: `${r.title} (copy)`.slice(0, 120), threadUrl: r.threadUrl, board: structuredClone(r.board), source: r.source });
}

/** Delete (§3.9): a confirm naming where it is used; then the open draft's synced canvases of it become copies (one undo
 * step; undone, they show "missing") and the file goes to the trash. Other DOM drafts are not rewritten: their canvases keep
 * their last picture and show "missing". Other canvas drafts' copies become plain copies of their last picture, rewritten in
 * the engine's helper worker and saved (unlinkElsewhere). `ask: false` skips the confirm (flow.library.delete: the agent card
 * asked). → whether it was removed. */
export async function removeFlow(id, { ask = true } = {}) {
  const r = await loadFlow(id);
  if (!r) return false;
  const session = openCanvasSession();
  if (session === false) {
    toast.error(STILL_OPENING);
    return false;
  }
  // The drafts holding it as a synced copy, but the open one: the drafts list's marks, which main.js reads from each record's
  // doc or engine model (src/draft-marks.js), so no draft is loaded to count them.
  const others = state.drafts.filter((d) => d.id !== state.draft?.id && d.flows?.includes(id)).map((d) => d.id);
  try {
    const ed = session ? null : state.editor;
    // On a canvas draft its boxes, each of which keeps its own data: the engine's box shows that, not the library's board.
    const linked = session ? (await boxList(session)).boxes.filter((b) => b.kind === 'canvas' && dataOf(b.data)?.flow?.id === id) : [];
    const here = session ? linked.length : ed ? flowRefs(ed.getJSON()).filter((ref) => ref.flowId === id).length : 0;
    if (ask) {
      const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      const used = [here && `this draft (${s(here, 'place')})`, others.length && s(others.length, 'other draft')].filter(Boolean).join(' and ');
      const effect = [here && 'here the canvases become independent copies', others.length && 'elsewhere they keep their last picture']
        .filter(Boolean).join('; ');
      const description = `${used ? `Used in ${used}: ${effect}.` : 'It is not used in any draft.'} The file is moved to the flowcharts trash folder.`;
      if (!(await confirmDialog({ title: `Delete "${r.title}"?`, description, confirmText: 'Delete', destructive: true }))) return false;
    }
    if (linked.length) {
      // One undo step, as the DOM editor's single transaction.
      const done = await session.execMany(linked.map((b) => ['box.set', { id: b.id, data: JSON.stringify({ ...dataOf(b.data), flow: null }) }]));
      if (!done?.ok) throw new Error(done?.error ?? 'the engine refused it');
    } else if (ed) {
      const { tr } = ed.state;
      ed.state.doc.descendants((node, pos) => {
        if (node.type.name === 'canvas' && node.attrs.flow?.id === id) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...structuredClone(r.board), flow: null });
      });
      if (tr.docChanged) ed.view.dispatch(tr);
    }
  } catch (e) {
    toast.error(`Could not delete the flowchart: ${e.message || e}`);
    return false;
  } finally {
    session?.release();
  }
  clearTimeout(timers.get(id));
  timers.delete(id);
  try {
    await writes; // a write in flight must not recreate the file after the removal
    await api.flows.remove(id);
  } catch (e) {
    toast.error(`Could not delete the flowchart: ${e.message || e}`);
    return false;
  }
  records.delete(id);
  chains.delete(id);
  stacks.delete(id);
  missing.add(id);
  summaries = summaries.filter((x) => x.id !== id);
  notify(id);
  if (state.view.type === 'flows' && state.view.flowId === id) openFlows(null);
  await unlinkElsewhere(others, id);
  return true;
}

// --- boxes: EasyWriter's own objects in canvas drafts (engine-canvas-read, docs/plans/engine/stage2b.md decision 8) ---

const STILL_OPENING = 'The draft is still opening in the canvas engine. Try again once it shows.';
const PT = 0.75; // points per CSS px
const FALLBACK_DPI = 300; // as the box edit mode's commits (src/document/canvas/boxes.jsx)

/** A watcher of the open draft's engine session while the canvas page area shows it (release it after), false while the page area
 * has not opened it yet, or null for a draft in the DOM editor. The session, not the hidden DOM editor under it, holds the text;
 * the page area holds it open (engine-session-release). */
export function openCanvasSession() {
  const s = getState();
  if (!areaOpens(s)) return null;
  return engineHost().ids().includes(s.draft.id) ? engineHost().watch(s.draft.id) : false;
}

/** Canvas draft session `session`'s boxes → {boxes: [{id, kind, data (JSON text), w, h}], column: the caret's text width in pt}. */
export const boxList = async (session) => (await session.query('box.list', {}))?.value ?? { boxes: [], column: 468 };

const dataOf = (data) => {
  try {
    return JSON.parse(data);
  } catch {
    return null; // data its own code cannot read either
  }
};

/** The boxes of engine model `model` (a record's, parsed) that show flowchart `flowId` as a synced copy → [{id, data}], `data`
 * the copy's own data without the link. The walk is draft-marks.js engineMarks'. */
function linkedIn(model, flowId) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x === 'object') walk(x);
      return;
    }
    for (const k in v) {
      const x = v[k];
      if (!x || typeof x !== 'object' || k === 'runs' || k === 'props') continue;
      if (k === 'box' && x.kind === 'canvas' && typeof x.data === 'string') {
        const a = dataOf(x.data);
        if (a?.flow?.id === flowId && Number.isInteger(v.id)) out.push({ id: v.id, data: JSON.stringify({ ...a, flow: null }) });
      } else walk(x);
    }
  };
  walk(model);
  return out;
}

/** Canvas drafts `ids` (not the open one) that hold flowchart `flowId` as synced copies: in each the copies become plain copies,
 * `box.set` run on its model in the engine's helper worker, and the record is saved. A draft that cannot be read, or that the
 * background window holds, keeps its copies, which then keep their last picture. */
async function unlinkElsewhere(ids, flowId) {
  for (const id of ids) {
    if (state.worker?.draftId === id) continue;
    try {
      const record = await api.drafts.load(id);
      if (!isCanvas(record) || unreadable(record.engine)) continue;
      const model = typeof record.engine.model === 'string' ? JSON.parse(record.engine.model) : record.engine.model;
      const steps = linkedIn(model, flowId).map(({ id: box, data }) => ['box.set', { id: box, data }]);
      if (!steps.length) continue;
      const bytes = await engineHost().convert(modelBytes(record.engine), 'engine', steps);
      const { updated, marks } = await api.drafts.save(adopt(record, bytes));
      setState({ drafts: state.drafts.map((d) => (d.id === id ? { ...d, updated, ...marks } : d)).sort((a, b) => b.updated - a.updated) });
    } catch (e) {
      console.warn(`The canvas draft ${id} keeps its synced copies of a deleted flowchart:`, e);
    }
  }
}

/** EasyWriter's object `kind` ('canvas' or 'planChart') as a box at the caret of canvas draft session `session`, one undo step:
 * `attrs(column)` gives its attrs for the text column, `column` CSS px wide, and a picture of it is its fallback. A canvas then
 * opens in box edit mode, in the Board's tool `mode` when given. → the new box's id, or null after a toast saying why not. */
export async function insertBox(session, kind, attrs, { mode = null } = {}) {
  const { boxes, column } = await boxList(session);
  const a = attrs(Math.round(column / PT));
  try {
    // A canvas at 300 dpi of the box's width, as the box edit mode's commits; a plan chart at the column's width.
    const width = kind === 'canvas' ? (column * FALLBACK_DPI) / 72 / exportDensity('file') : Math.round(column / PT);
    const { blob } = await boardPicture({ ...a, kind }, width, 'light', 1);
    const fallback = `data:image/png;base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
    const r = await session.exec('box.insert', { kind, data: JSON.stringify(a), fallback });
    if (!r?.ok) throw new Error(r?.error ?? 'the engine refused it');
  } catch (e) {
    toast.error(`Could not insert the ${kind === 'canvas' ? 'canvas' : 'plan chart'}: ${e.message || e}`);
    return null;
  }
  const had = new Set(boxes.map((b) => b.id));
  const id = (await boxList(session)).boxes.find((b) => !had.has(b.id))?.id ?? null;
  // Opened for editing once the page area draws it, as a new canvas opens in the DOM editor.
  if (id != null && kind === 'canvas') (await import('../document/canvas/boxes.jsx')).openBox(id, { mode });
  return id;
}

/** Insert > Canvas (and Shapes > New Drawing Canvas) on a canvas draft: an empty canvas across the text column, as canvas.js
 * insertCanvas makes one (450 px high, shown 1:1), edited in place. → the box's id or null. */
export async function insertCanvasBox() {
  const session = openCanvasSession();
  if (!session) return void toast.error(STILL_OPENING);
  try {
    return await insertBox(session, 'canvas', (w) => ({ w, h: 450, dw: w, frame: { x: 0, y: 0, w, h: 450 }, bg: 'post', items: [], flow: null, source: null }));
  } finally {
    session.release();
  }
}

// --- the library editor's undo stack (§3.9: a restore is a new rev that counts as the restored state) ---

const stackOf = (id) => stacks.get(id) ?? stacks.set(id, { past: [], future: [], at: 0 }).get(id);

/** A commit of the library editor's Board: written with origin 'library', one undo step of the record's stack (commits
 * within 500 ms merge unless `newGroup`). */
export function commitLibrary(id, { w, h, frame, bg, items }, newGroup) {
  const r = records.get(id);
  if (!r) return;
  const st = stackOf(id);
  const now = Date.now();
  if (newGroup || now - st.at > MERGE_MS || !st.past.length) {
    st.past.push({ rev: stateOf(chainOf(id), r.rev), board: r.board });
    if (st.past.length > LIMIT) st.past.shift();
  }
  st.at = now;
  st.future = [];
  save(id, { w, h, frame, bg, items }, { origin: 'library' });
}

function step(id, from, to) {
  const r = records.get(id);
  const st = stacks.get(id);
  const target = st?.[from].pop();
  if (!r || !target) return;
  st[to].push({ rev: stateOf(chainOf(id), r.rev), board: r.board });
  st.at = 0;
  save(id, target.board, { origin: 'library', as: target.rev });
}

export const undoFlow = (id) => step(id, 'past', 'future');
export const redoFlow = (id) => step(id, 'future', 'past');
export const canUndoFlow = (id) => !!stacks.get(id)?.past.length;
export const canRedoFlow = (id) => !!stacks.get(id)?.future.length;

// --- workspace and insertion ---

/** The flowchart preset (§6d, roadmap B2): the shared shape tool on Box in the page theme's card fill and ink line and label
 * colours (label 16 px), and connectors in ink. Session-wide like picking a shape kind; it stays until changed. */
function applyFlowPreset() {
  const p = flowPreset(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  setShapeTool(p);
  setConnTool({ color: p.color });
}

/** Shows the flowchart library: the flowchart `flowId` in its editor, else the list. A missing flowchart opens nothing
 * (at startup the editor stays). `opts` as for openWorkspace. */
export async function openFlows(flowId = null, opts) {
  if (flowId && !(await loadFlow(flowId))) {
    if (!opts?.startup) toast.error('That flowchart is missing from the library.');
    return false;
  }
  const shown = await openWorkspace({ type: 'flows', flowId }, opts);
  if (shown && flowId) applyFlowPreset(); // the library editor, in the page theme the workspace has set (applyPageTheme)
  return shown;
}

/** Insert flowchart (toolbar, quick tools, Ctrl+Alt+F, palette; from the library with its `flowId`, then only the mode is
 * asked): Synced (default) or Copy. */
export async function insertFlowchartDialog(flowId) {
  if (!can('doc.open', state)) return;
  const result = await openDialog('insertFlow', { flowId: typeof flowId === 'string' ? flowId : null, threadUrl: draftThread() });
  if (result) await insertFlowchart(result);
}

/** §5.1: a canvas after the selection, edited in place: synced → the record's board plus `flow` (New: a new record of the
 * draft's thread); copy → the board alone (New: an empty 1200 × 675 canvas). A new one starts with the shape tool. */
export async function insertFlowchart({ flowId = null, mode = 'synced' }) {
  if (!can('view.editor', state)) await closeWorkspace();
  await frames(2); // the dialog and the workspace return the focus first: the canvas being edited keeps it
  const session = openCanvasSession();
  if (session === false) return void toast.error(STILL_OPENING);
  const ed = state.editor;
  if (!ed && !session) return;
  let r = flowId ? await loadFlow(flowId) : null;
  if (flowId && !r) {
    session?.release();
    return void toast.error('That flowchart is missing from the library.');
  }
  if (!r && mode === 'synced') r = createFlow({ threadUrl: draftThread() });
  const board = r ? structuredClone(r.board) : { ...FLOW_SIZE };
  const flow = r && mode === 'synced' ? { id: r.id, rev: r.rev } : null;
  if (session) {
    // A canvas draft: a canvas box across the text column (box.insert's width), the flowchart's own layout scaled to fit.
    try {
      await insertBox(session, 'canvas', (dw) => ({ frame: { x: 0, y: 0, w: board.w, h: board.h }, bg: 'post', items: [], ...board, dw, flow,
        source: r?.source ?? null }), { mode: flowId ? null : 'shape' });
    } finally {
      session.release();
    }
    applyFlowPreset();
    return;
  }
  // Shown across the text column as every new canvas is (canvas.js insertCanvas), the flowchart's own layout scaled to fit.
  afterNodeSel(ed.chain()).insertCanvas({ ...board, dw: columnWidth(ed.view), flow, source: r?.source ?? null }).run();
  openCanvasEditor(ed, boardBeforeCaret(ed.state)); // insertBoard put the caret in the block after it
  applyFlowPreset();
  if (!flowId) canvasEditor.get()?.board.setMode('shape');
}

/** Save to library… (§3.9) for the document canvas of view `cv` (not synced): a new record of its picture, and the canvas
 * becomes a synced view of it (one undo step). */
export async function saveToLibrary(cv) {
  const threadUrl = draftThread();
  const title = await openDialog('saveFlow', { title: defaultTitle(threadUrl) });
  const pos = cv.getPos();
  if (title == null || typeof pos !== 'number' || cv.flow()) return;
  const r = createFlow({ title, threadUrl, board: structuredClone(liveBoard(cv)), source: cv.node.attrs.source });
  cv.view.dispatch(cv.view.state.tr.setNodeMarkup(pos, undefined, { ...cv.node.attrs, flow: { id: r.id, rev: r.rev } }));
}

// --- diagrams: Mermaid import and Copy as Mermaid, auto-layout, Copy as PNG (roadmap C3; SPEC §6d Formats, §7 Import diagram) ---

const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const MARGIN = 40; // post px around a diagram placed by an import
const MAX_ITEMS = 1000; // import cap (flowchart plan §4)
// The bounds of `items` as drawn (turned shapes; text: its stored or estimated height; unrouted connectors left out).
const drawnBox = (items) => groupBox(items.filter((i) => i.type !== 'connector' || Number.isFinite(i.h))
  .map((i) => rotBox({ ...defaultMeasure(i), rot: rotOf(i) })));

/** Items for Mermaid `text` at `unit` (board px per post px): laid out (direction `dir`, else the text's), routed, in the
 * theme's flowchart look, the drawing's top-left at 0,0; graph ids are item ids unless `taken` holds them.
 * → {items, w, h, warnings} | {error: {line, col, message}}. The Import diagram dialog previews it. */
export function diagramItems(text, { dir = null, unit = 1, taken } = {}) {
  const r = parseMermaid(text);
  if (r.error) return r;
  if (!r.graph.nodes.length) return { error: { line: 1, col: 1, message: 'The diagram has no nodes.' } };
  const g = fromGraph(r.graph, { unit, preset: flowPreset(theme()), taken, ...(dir && { dir }) });
  if (g.error) return { error: { line: 1, col: 1, message: g.error.message } };
  if (g.items.length > MAX_ITEMS) return { error: { line: 1, col: 1, message: `More than ${MAX_ITEMS} items: too large to import.` } };
  const routed = resolveConnectors(g.items).items;
  const b = drawnBox(routed);
  return { items: routed.map((i) => moveItem(i, -b.x, -b.y)), w: Math.ceil(b.w), h: Math.ceil(b.h), warnings: r.warnings };
}

// The Mermaid text an import filled `board` with: kept as the `source` attr of the canvas being edited (stored by the commit)
// and of the library flowchart the board edits (the library editor, a synced canvas).
function keepSource(board, source) {
  const s = canvasEditor.get();
  const node = s?.board === board ? s.target.owner : null;
  if (node) board.attrs = { ...board.attrs, source };
  const r = records.get(state.view.type === 'flows' ? state.view.flowId : node?.flow()?.id);
  if (!r) return;
  r.source = source;
  r.updated = Date.now();
  touch(r);
  schedule(r.id);
}

// Import diagram without a board: a new canvas holding the diagram after the selection, shown across the text column (the diagram
// scaled to fit, as insertFlowchart), edited in place (one undo step).
async function insertDiagram({ text, dir }, source) {
  if (!can('view.editor', state)) return;
  await frames(2); // the dialog returns the focus first: the canvas being edited keeps it
  const ed = state.editor;
  const r = ed && diagramItems(text, { dir });
  if (!r || r.error) return;
  const [w, h] = [r.w + 2 * MARGIN, r.h + 2 * MARGIN];
  const items = r.items.map((i) => moveItem(i, MARGIN, MARGIN));
  afterNodeSel(ed.chain()).insertCanvas({ w, h, bg: 'post', items, source, dw: columnWidth(ed.view) }).run();
  openCanvasEditor(ed, boardBeforeCaret(ed.state)); // insertBoard put the caret in the block after it
}

/** Import diagram… (tool search; Mermaid text pasted onto a board offers it, prefilled): the dialog, then the diagram onto
 * `board` (one undo step, selected: at the middle of its visible part, or with "Replace board contents" (or on an empty
 * board) at its top-left), else into a new canvas after the selection, edited in place.
 * An import that fills the whole canvas or library flowchart keeps the text as its `source`. */
export async function importDiagram({ board = null, text = '' } = {}) {
  const result = await openDialog('importDiagram', { text, board: !!board });
  if (board && !board.destroyed) board.focus();
  if (!result) return;
  const source = { format: 'mermaid', text: result.text };
  if (!board) return insertDiagram(result, source);
  if (board.destroyed) return;
  board.finishEdit();
  const u = board.unit;
  const r = diagramItems(result.text, { dir: result.dir, unit: u, taken: new Set(result.replace ? [] : board.items.map((i) => i.id)) });
  if (r.error) return;
  const { items, w, h } = r;
  const whole = result.replace || !board.items.length;
  const f = board.frame ?? { x: 0, y: 0 };
  const c = board.visibleCentre();
  const at = whole ? { x: f.x + MARGIN * u, y: f.y + MARGIN * u } : { x: c.x - w / 2, y: c.y - h / 2 };
  if (result.replace) board.items = [];
  board.moveBy(items, Math.round(at.x), Math.round(at.y));
  board.items.push(...items);
  board.sel = new Set(items.map((i) => i.id));
  if (whole) keepSource(board, source);
  board.commit(true);
  board.focus();
}

/** Auto layout (tool search; its options pick the direction): the board's shapes, text, images and canvases laid out by
 * dagre in direction `dir`, swimlanes and frames around their members, starting where the diagram began; connectors between
 * them lose their bends and re-route. One undo step. */
export function autoLayout(board, dir) {
  board.finishEdit();
  const u = board.unit;
  const graph = toGraph(board.items, { unit: u });
  if (!graph.nodes.length) return void toast('The board has no shapes to lay out.');
  const r = layout(graph, { dir });
  if (r.error) return void toast.error(r.error.message);
  const byId = new Map(board.items.map((i) => [i.id, i]));
  const laid = [...graph.nodes, ...graph.groups].map((n) => byId.get(n.id));
  const before = drawnBox(laid);
  const moved = laid.map((i) => {
    const p = r.nodes[i.id] ?? r.groups[i.id];
    return { ...i, x: Math.round(p.x * u), y: Math.round(p.y * u), ...(r.groups[i.id] && { w: Math.round(p.w * u), h: Math.round(p.h * u) }) };
  });
  const now = drawnBox(moved);
  for (const m of moved) Object.assign(byId.get(m.id), moveItem(m, before.x - now.x, before.y - now.y));
  const ids = new Set(laid.map((i) => i.id));
  for (const c of board.items) if (c.type === 'connector' && ids.has(c.from.item) && ids.has(c.to.item)) c.points = [];
  board.commit(true);
}

/** Copy as Mermaid (tool search): the board's diagram as Mermaid flowchart text on the clipboard; the toast lists what
 * Mermaid cannot hold (left out). */
export function copyMermaid(board) {
  board.finishEdit();
  const graph = toGraph(board.items, { unit: board.unit, preset: flowPreset(theme()) });
  const { text, warnings } = toMermaid(graph);
  const notes = warnings.map((w) => w.message);
  if (board.items.some((c) => c.type === 'connector' && !graph.edges.some((e) => e.id === c.id))) notes.push('Connectors that do not join two shapes were left out.');
  navigator.clipboard.writeText(text).then(() => toast('Copied as Mermaid.', notes.length ? { description: notes.join(' ') } : {}), (e) => toast.error(String(e)));
}

/** Copy as PNG (tool search): the whole board as a picture on the clipboard, at its size times the clipboard's export density. */
export async function copyPng(board) {
  board.finishEdit();
  const { w, h } = board.size();
  try {
    const scale = exportDensity('clipboard');
    const { blob } = await rasterizeWhiteboard({ height: h, bg: board.bg, items: board.items }, { width: w, theme: state.settings.theme, scale });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Copied as PNG.');
  } catch (e) {
    toast.error(`Could not copy the picture: ${e.message || e}`);
  }
}

// Smoke check of the connector live / commit path (flowchart plan §9 Phase 1a), run after window.__smoke(): edits the
// sample flowchart canvas in place, stores its routes, moves a shape a connector sticks to 80 px right and commits, then
// compares that connector's stored geometry and the canvas PNG with before. → {moved, tipsChanged, pngChanged}
window.__smokeFlow = async () => {
  const ed = state.editor;
  let pos = null;
  ed.state.doc.descendants((n, p) => {
    if (pos === null && n.type.name === 'canvas' && n.attrs.items.some((i) => i.type === 'connector')) pos = p;
  });
  if (pos === null) return { moved: false, tipsChanged: false, pngChanged: false };
  const stored = (id) => ed.state.doc.nodeAt(pos).attrs.items.find((i) => i.id === id);
  const png = async () => {
    const a = ed.state.doc.nodeAt(pos).attrs;
    return (await rasterizeWhiteboard({ height: a.h, bg: a.bg, items: a.items }, { width: a.w, theme: state.settings.theme, scale: 1 })).blob.size;
  };
  openCanvasEditor(ed, pos);
  const board = canvasEditor.get().board;
  board.commit(); // the sample stores its connectors unrouted
  const c = ed.state.doc.nodeAt(pos).attrs.items.find((i) => i.type === 'connector' && typeof i.from.item === 'string');
  const before = { geo: JSON.stringify([c.x, c.y, c.tips]), x: stored(c.from.item).x, png: await png() };
  board.moveBy([board.items.find((i) => i.id === c.from.item)], 80, 0);
  board.commit();
  const after = stored(c.id);
  const result = { moved: stored(c.from.item).x === before.x + 80, tipsChanged: JSON.stringify([after.x, after.y, after.tips]) !== before.geo,
    pngChanged: (await png()) !== before.png };
  canvasEditor.get()?.close(true);
  return result;
};
