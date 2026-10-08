import { pathOfPos, posOfPath } from '../doc-path.mjs';
import { getState } from './store.js';

// The open draft's revision (SPEC §8 Revisions; agent-automation plan §3.4). `state.rev` only grows: every document change
// adds one, and so does every mount of a new editor, which also clears the log. The log keeps the last 500 changes
// {rev, before, maps} (ProseMirror docs share structure, so the old docs are cheap) to map a PATH read at an older rev onto
// the current doc. actions.js records, commands.js maps; neither imports the other for it. A background session of the
// assistant (assistant/sessions.js) keeps revisions of its own with revs(session).

const RING = 500;

/** Revisions in `holder.rev` with their log: record(tr, appended), clear(), map(path, ifRev, doc) as below. */
export function revs(holder) {
  let log = [];
  return {
    record(tr, appended = []) {
      const changed = [tr, ...appended].filter((t) => t.docChanged);
      if (!changed.length) return;
      holder.rev += 1; // in place: nothing renders from it
      log.push({ rev: holder.rev, before: changed[0].before, maps: changed.map((t) => t.mapping) });
      if (log.length > RING) log.shift();
    },
    clear() {
      log = [];
      holder.rev += 1;
    },
    map(path, ifRev, doc) {
      const rev = holder.rev;
      if (ifRev === rev) return path;
      const i = log.findIndex((e) => e.rev === ifRev + 1);
      if (ifRev > rev || i < 0) return 'stale';
      let pos = posOfPath(log[i].before, path);
      if (pos === null) return 'stale';
      for (const e of log.slice(i)) {
        for (const m of e.maps.flatMap((x) => x.maps ?? [x])) { // each step's map
          let inPlace = false;
          m.forEach((from, to, newFrom, newTo) => { inPlace ||= from === pos && to - from === 1 && newTo - newFrom === 1; });
          const r = m.mapResult(pos, inPlace ? -1 : 1);
          if (r.deleted) return 'stale';
          pos = r.pos;
        }
      }
      const out = pathOfPos(doc, pos);
      return out && posOfPath(doc, out) === pos ? out : 'stale';
    },
  };
}

const open = revs(getState()); // the open draft's: state.rev

/** A dispatched transaction and the ones plugins appended to it (the editor's `transaction` event). */
export const recordRev = open.record;

/** A new document in the editor (mountEditor): the next rev, and no older one maps onto it. */
export const clearRevLog = open.clear;

/** `path` read at revision `ifRev`, mapped onto `doc` (the current ProseMirror doc): the path the block has now, or
 * 'stale' when the block was deleted or merged since, or `ifRev` is newer than the doc or older than the log. A step that
 * replaces one token at the block with one (setNodeMarkup: a board write replaces the atom, a block type change its opening
 * token) keeps the block where it is; a longer replace that starts there, such as a paste over whole blocks, is still stale. */
export const mapPath = open.map;
