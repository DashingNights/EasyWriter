'use strict';
// A draft summary's marks, from its doc JSON alone: main.js (which loads no ProseMirror) and computer-main.js write them into the
// drafts list, and the renderer's actions.js keeps them when it updates an entry after a save (docs/plans/suggestions.md).

/** `doc` (TipTap JSON) → {suggestions: the count of agent suggestions waiting in it (the distinct ids of its records), flows: the
 * ids of the library flowcharts its canvases show}. */
function draftMarks(doc) {
  const ids = new Set((doc?.attrs?.suggest?.attrs ?? []).map((r) => r.id));
  const flows = new Set();
  const walk = (n) => {
    if (n?.type === 'canvas' && typeof n.attrs?.flow?.id === 'string') flows.add(n.attrs.flow.id);
    if (Array.isArray(n?.content)) n.content.forEach(walk);
  };
  for (const b of Array.isArray(doc?.content) ? doc.content : []) {
    const r = b?.attrs?.suggest;
    if (r?.ins?.id) ids.add(r.ins.id);
    for (const x of Array.isArray(r?.del) ? r.del : []) ids.add(x.id);
    walk(b);
  }
  return { suggestions: ids.size, flows: [...flows] };
}

module.exports = { draftMarks };
