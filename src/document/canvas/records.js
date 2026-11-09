// One record per draft session for a reader drawn over the pages or in a pane (comment cards, heading folds, field marks,
// suggestion cards). Its client is its own watcher of the session (engine-session-release), so the record never keeps the
// session open. Each drawn page or pane, and each other reader (actions.js's suggestion mirror), holds the record while it needs
// it; a moment after the last one lets go, the record is dropped and its watcher released with it, so a draft left behind keeps
// none of them (engine-fixes-edit: they grew by one a draft).
//
// A record is made only by a hold, never during a render (engine-fixes-2-edit): a component reads it through React's external
// store, which subscribes (holds) when the component mounts and draws again with the record its hold has when that is not the
// one its render read, so a record dropped between the render and the mount (a large open blocking the main thread past the
// let-go) is never the one drawn.
import { useCallback, useSyncExternalStore } from 'react';
import { engineHost } from '../../engine/client.js';

const LET_GO = 2000; // ms a record stays after nothing holds it (a re-render or a scroll holds it again)
const readers = new Map(); // reader name → its records' session ids, for the harness
const none = () => {};

/** The records of reader `name`, each made by `make(client, id)` around its watcher `client` of session `id` → {use, hold, peek,
 * each}. A dropped record has `gone` set: what it still has in flight finds it. */
export function sessionRecords(name, make) {
  const all = new Map(); // session id → {d, client, users, timer}
  const drop = (id, e) => {
    if (e.users || all.get(id) !== e) return;
    all.delete(id);
    e.d.gone = true;
    e.client.release();
  };
  /** Holds session `id`'s record, made when it has none → a function that lets it go. */
  const hold = (id) => {
    let e = all.get(id);
    if (!e) {
      e = { client: engineHost().watch(id), users: 0, timer: 0, d: null };
      all.set(id, e);
      e.d = make(e.client, id);
    }
    e.users++;
    clearTimeout(e.timer);
    return () => {
      if (--e.users) return;
      e.timer = setTimeout(() => drop(id, e), LET_GO);
    };
  };
  const peek = (id) => all.get(id)?.d ?? null;
  readers.set(name, () => [...all.keys()]);
  return {
    /** React hook: session `id`'s record, held while the component is mounted; null for a null id, and for the first render of
     * a session no one holds yet (the mount makes it and draws again). */
    use(id) {
      const subscribe = useCallback(() => (id == null ? none : hold(id)), [id]);
      return useSyncExternalStore(subscribe, () => (id == null ? null : peek(id)));
    },
    hold,
    /** Session `id`'s record, or null: a read that makes none. */
    peek,
    /** Every record. */
    each: () => [...all.values()].map((e) => e.d),
  };
}

/** Tells record `d`'s readers (`d.fns`) that it changed, `d.version` going up, when `drawn` (what they draw from it) is not what it
 * was last time → whether it was not. Each record reads the engine again after an edit once typing pauses, and every page drew its
 * cards, folds and marks again with the same ones (engine-main-thread-2). */
export function publish(d, drawn) {
  const now = JSON.stringify(drawn);
  if (now === d.drawn) return false;
  d.drawn = now;
  d.version++;
  for (const fn of d.fns) fn();
  return true;
}

// The harness's view: each reader's records by session id (engine-fixes-edit).
if (typeof window !== 'undefined') window.__sessionRecords = () => Object.fromEntries([...readers].map(([n, ids]) => [n, ids()]));
