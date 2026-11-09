// Version History's local versions (docs/plans/word plan.md §3 compare): a draft's history file (src/app/history.js encode: the
// base doc and the logged steps with their times) read as versions. One version per burst of edits; a pause of more than five
// minutes ends a burst (our rule: Word lists AutoSave versions, which EasyWriter does not keep). Pure: Node tests load it.
import { Step } from '@tiptap/pm/transform';

/** The pause, in ms, that ends a burst of edits. */
export const GAP = 5 * 60 * 1000;

const first = (ev) => ev.trs[0]?.time ?? 0;
const last = (ev) => ev.trs.at(-1)?.time ?? 0;

/** The bursts of `events` (history file events, each {trs: [{time}]}) → [[start, end)] index ranges, split where the pause between
 * one event's last step and the next event's first is over `gap` ms. */
export function bursts(events, gap = GAP) {
  const out = [];
  events.forEach((ev, i) => {
    if (i && first(ev) - last(events[i - 1]) <= gap) out.at(-1)[1] = i + 1;
    else out.push([i, i + 1]);
  });
  return out;
}

// JSON of the file with its pictures put back ({$img: key} → the data URL; history.js stores each once).
function unpack(file, json) {
  if (Array.isArray(json)) return json.map((x) => unpack(file, x));
  if (!json || typeof json !== 'object') return json;
  if (typeof json.$img === 'string') return file.images?.[json.$img] ?? '';
  return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, unpack(file, v)]));
}

/** The local versions of history file `file` → [{k, at, base?}] newest first: the doc before the first logged edit (base: true, at:
 * that edit's time) and the end of every burst but the last, which is the saved doc. Undone steps are not versions. [] for no file. */
export function localVersions(file) {
  if (file?.version !== 1 || !file.events?.length) return [];
  const events = file.events.slice(0, file.events.length - (file.undone ?? 0));
  if (!events.length) return [];
  const out = [{ k: 0, at: first(events[0]), base: true }];
  for (const [, end] of bursts(events).slice(0, -1)) out.push({ k: end, at: last(events[end - 1]) });
  return out.reverse();
}

const cache = new WeakMap(); // file → Map(k → doc): a version is rebuilt once, when it is opened
/** The doc of history file `file` after its first `k` events replayed from the base in `schema` → a ProseMirror node. Throws when a
 * step no longer applies. */
export function docAt(file, schema, k) {
  let m = cache.get(file);
  if (!m) cache.set(file, (m = new Map()));
  if (m.has(k)) return m.get(k);
  let doc = schema.nodeFromJSON(unpack(file, file.base));
  for (const ev of file.events.slice(0, k)) {
    for (const t of ev.trs) {
      for (const s of t.steps) {
        const r = Step.fromJSON(schema, unpack(file, s)).apply(doc);
        if (r.failed) throw new Error(r.failed);
        doc = r.doc;
      }
    }
  }
  m.set(k, doc);
  return doc;
}
