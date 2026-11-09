'use strict';
// A draft summary's marks, from its record alone: main.js (which loads no ProseMirror) and computer-main.js write them into the
// drafts list, and the renderer's actions.js keeps them when it updates an entry after a save (docs/wiki/suggestions.md).

/** `doc` (TipTap JSON) → {suggestions: the count of agent suggestions waiting in it (the distinct ids of its records), flows: the
 * ids of the library flowcharts its canvases show, plans: the ids of the plans its plan charts show}. */
function draftMarks(doc) {
  const ids = new Set((doc?.attrs?.suggest?.attrs ?? []).map((r) => r.id));
  const flows = new Set();
  const plans = new Set();
  const walk = (n) => {
    if (n?.type === 'canvas' && typeof n.attrs?.flow?.id === 'string') flows.add(n.attrs.flow.id);
    if (n?.type === 'planChart' && typeof n.attrs?.planId === 'string') plans.add(n.attrs.planId);
    if (Array.isArray(n?.content)) n.content.forEach(walk);
  };
  for (const b of Array.isArray(doc?.content) ? doc.content : []) {
    const r = b?.attrs?.suggest;
    if (r?.ins?.id) ids.add(r.ins.id);
    for (const x of Array.isArray(r?.del) ? r.del : []) ids.add(x.id);
    walk(b);
  }
  return { suggestions: ids.size, flows: [...flows], plans: [...plans] };
}

/** A canvas draft's engine model (src/engine/model/form.mjs: the object, or its JSON text) → the same marks, from its boxes: each
 * `box` {kind, data} (engine crates/doc para/float.rs ObjectBox) holds the object's attrs as JSON text, a smart canvas's `flow.id`
 * and a plan chart's `planId`. Its suggestions are suggestionsOf's. */
function engineMarks(model) {
  const flows = new Set();
  const plans = new Set();
  // No box and no tag (a revision's suggestion group): nothing to count, so no parse.
  if (typeof model === 'string') model = model.includes('"box":') || model.includes('"tag":') ? JSON.parse(model) : null;
  // About 4 ms for the Word fixture's model (6.4 MB, 966 pages; 13 to 17 ms with for...in over arrays and into runs and props,
  // which hold no objects).
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (v[i] && typeof v[i] === 'object') walk(v[i]);
      return;
    }
    for (const k in v) {
      const x = v[k];
      if (!x || typeof x !== 'object' || k === 'runs' || k === 'props') continue;
      if (k === 'box' && typeof x.data === 'string') {
        let a = null;
        try {
          a = JSON.parse(x.data);
        } catch { /* a box whose data its own code cannot read either */ }
        if (x.kind === 'canvas' && typeof a?.flow?.id === 'string') flows.add(a.flow.id);
        if (x.kind === 'planChart' && typeof a?.planId === 'string') plans.add(a.planId);
      } else walk(x);
    }
  };
  if (model && typeof model === 'object') walk(model);
  return { suggestions: suggestionsOf(model), flows: [...flows], plans: [...plans] };
}

/** The assistant's suggestion cards waiting in engine model `model`, counted as src/suggest/cards.mjs cardsOf makes them: the
 * revisions with a suggestion group (`tag`) that a run, a paragraph mark or a property change still points at (`ins`, `del`,
 * fmtChange/numChange `rev`, indexes into `revisions`), a deletion and an insertion of the same group in adjacent runs one card. */
// ponytail: adjacency is by run within one paragraph, where cardsOf compares positions; a change split across paragraphs next to
// its pair can count one more card here than the open draft shows.
function suggestionsOf(model) {
  const revs = Array.isArray(model?.revisions) ? model.revisions : [];
  if (!revs.some((r) => r?.tag != null)) return 0; // the usual case: the walk below goes into every run, so skip it
  const tagOf = (i) => (Number.isInteger(i) ? (revs[i]?.tag ?? null) : null);
  const live = new Set();
  let pairs = 0;
  const paired = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (v[i] && typeof v[i] === 'object') walk(v[i]);
      return;
    }
    if (Array.isArray(v.runs)) {
      let prev = null; // the run before's tagged insertion or deletion: {rev, del}
      for (const r of v.runs) {
        const p = r?.props;
        const del = tagOf(p?.del) != null;
        const rev = del ? p.del : tagOf(p?.ins) != null ? p.ins : null;
        const cur = rev == null ? null : { rev, del };
        if (cur && prev && prev.rev !== rev && prev.del !== del && revs[prev.rev].tag === revs[rev].tag && !paired.has(prev.rev) && !paired.has(rev)) {
          paired.add(prev.rev).add(rev);
          pairs++;
        }
        if (!cur || cur.rev !== prev?.rev) prev = cur;
      }
    }
    for (const k in v) {
      const x = v[k];
      if ((k === 'ins' || k === 'del') && tagOf(x) != null) live.add(x);
      else if ((k === 'fmtChange' || k === 'numChange') && tagOf(x?.rev) != null) live.add(x.rev);
      if (x && typeof x === 'object') walk(x);
    }
  };
  walk(model);
  return live.size - pairs;
}

/** A draft record → its marks: from the engine model for a canvas draft (whose `doc`, kept by records saved before, is stale), else
 * from its doc. */
const recordMarks = (d) => (d?.engine != null ? engineMarks(d.engine.model) : draftMarks(d?.doc));

module.exports = { draftMarks, engineMarks, recordMarks };
