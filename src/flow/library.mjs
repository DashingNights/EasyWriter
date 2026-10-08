// Flowchart library records and the sync rule of synced canvases (flowchart plan §3.8–§3.9). Pure: no DOM, no app state.
import { parseBoard, parseFrame } from '../whiteboard.js';

const ID_RE = /^[a-f0-9-]{36}$/; // the uuid pattern of file-family.js
const TOPIC_URL_RE = /^https:\/\/daf\.staffs\.ac\.uk\/topic\/\d+[^\s]*$/; // main.js
export const FLOW_SIZE = { w: 1200, h: 675 };
const TITLE_MAX = 120;

/** A canvas node's `flow` attr: {id, rev} when `id` is a uuid and `rev` an integer ≥ 1, else null. */
export const validFlow = (v) => (typeof v?.id === 'string' && ID_RE.test(v.id) && Number.isInteger(v.rev) && v.rev >= 1
  ? { id: v.id, rev: v.rev } : null);

/** The Mermaid text a canvas or a library record was imported from (flowchart plan §11 Q3, SPEC §6d Formats):
 * {format: 'mermaid', text} with a string of at most 1 MB, else null. */
export const validSource = (v) => (v?.format === 'mermaid' && typeof v.text === 'string' && v.text.length <= 1_000_000
  ? { format: 'mermaid', text: v.text } : null);

/** A board by the canvas rules (canvas.js parseCanvas: items through parseBoard, no nested canvas, a bad frame → null),
 * except that bad sizes fall back to 1200 × 675. */
export function parseFlowBoard(b) {
  const size = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const { bg, items } = parseBoard(JSON.stringify(b && typeof b === 'object' ? b : {}));
  return { w: size(b?.w, FLOW_SIZE.w), h: size(b?.h, FLOW_SIZE.h), frame: parseFrame(b?.frame), bg, items: items.filter((i) => i.type !== 'canvas') };
}

/** A library record (JSON text or object) → the record with every field valid, or null without an object or a uuid id.
 * Never throws. */
export function parseFlow(json) {
  let r = json;
  try {
    if (typeof json === 'string') r = JSON.parse(json);
  } catch {
    return null;
  }
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  const stamp = (v) => (Number.isFinite(v) ? v : null);
  return {
    version: Number.isInteger(r.version) ? r.version : 1,
    id: r.id,
    threadUrl: typeof r.threadUrl === 'string' && TOPIC_URL_RE.test(r.threadUrl) ? r.threadUrl : null,
    title: typeof r.title === 'string' ? r.title.slice(0, TITLE_MAX) : 'Flowchart',
    rev: Number.isInteger(r.rev) && r.rev >= 1 ? r.rev : 1,
    board: parseFlowBoard(r.board),
    source: validSource(r.source),
    created: stamp(r.created),
    updated: stamp(r.updated),
  };
}

/** What the library list shows of a record (as main's flows.list summary). */
export const summaryOf = (r) => ({
  id: r.id, threadUrl: r.threadUrl, title: r.title, created: r.created, updated: r.updated, rev: r.rev, items: r.board.items.length,
});

// The sync chain of one record (§3.9): Map rev → {pred, origin, as?} for this session's library writes; `pred` is the rev
// the write replaced, `origin` who wrote it (a draft, 'library', 'agent'), `as` the state a write that restores an earlier
// one (an undo written back, the library editor's undo) counts as.

/** The library state `rev` stands for: a restoring write counts as the state it restored. */
export const stateOf = (chain, rev) => chain.get(rev)?.as ?? rev;

/** Whether a synced node whose `flow.rev` went from x to y without its own commit (draft undo / redo) writes its restored
 * cache back: only while the library is at x and every write between x and y came from `origin` (an undo walks that
 * stretch back, a redo forward). Otherwise the library keeps the edits others made meanwhile. `held`: the `flow.rev`s of
 * the draft's canvases of this record; an undo back from a state one of them still holds undoes a catch-up step
 * (commitSynced), not the edit that made that state, which stays (all canvases of a draft are one origin). */
export function writeBackOk(chain, record, origin, x, y, held = []) {
  const [sx, sy] = [stateOf(chain, x), stateOf(chain, y)];
  if (sx === sy || stateOf(chain, record.rev) !== sx) return false;
  // From state `from` back along `pred` to state `to`, through writes of `origin` only. Revs only decrease: it ends.
  const walk = (from, to) => {
    for (let s = from; s !== to;) {
      const w = chain.get(s);
      if (!w || w.origin !== origin) return false;
      s = stateOf(chain, w.pred);
    }
    return true;
  };
  if (held.some((rev) => stateOf(chain, rev) === sx)) return walk(sy, sx);
  return walk(sx, sy) || walk(sy, sx);
}
