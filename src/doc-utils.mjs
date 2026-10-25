// Pure transforms on TipTap JSON. No imports; inputs are never mutated. The forum post's transforms are in
// integrations/forum/post.mjs.

// Plain text of every textblock, in document order. Non-text inline nodes count as a space.
function blockTexts(node, out = []) {
  const kids = node.content ?? [];
  if (kids.some((k) => k.type === 'text')) out.push(kids.map((k) => k.text ?? ' ').join(''));
  else for (const k of kids) blockTexts(k, out);
  return out;
}

const TITLE_MAX = 60;

/** First non-empty block's text, at most 60 chars (ellipsis included), or 'Untitled'. A title taken from content
 * (createDraft without a title); saving never rewrites a title (docs/plans/sidebar-menu.md decision 1). */
export function draftTitle(doc) {
  const text = blockTexts(doc).map((t) => t.trim()).find(Boolean);
  if (!text) return 'Untitled';
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 3) + '...' : text;
}

export const TITLE_LIMIT = 200;

/** A draft title as it is stored: whitespace runs (newlines too) become one space, trimmed, at most 200 characters;
 * nothing left gives 'Untitled'. */
export function cleanTitle(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT).trim() || 'Untitled';
}

/** The title of a copy of a draft titled `title`: the source's words first, so the narrow sidebar still shows them. */
export function copyTitle(title) {
  return cleanTitle(title).slice(0, TITLE_LIMIT - ' (copy)'.length).trimEnd() + ' (copy)';
}

/** Number of whitespace-separated words in the document. */
export function wordCount(doc) {
  return blockTexts(doc).join(' ').split(/\s+/).filter(Boolean).length;
}

const FLOW_ID = /^[a-f0-9-]{36}$/;

/** The synced canvases of `doc` (canvas nodes whose `flow` names a library flowchart) in document order: `path` = the
 * child indices from the doc down to the node, `flowId`, and `label` = `titleOf(flowId)` (the record's title), else
 * "Flowchart n" (n counts the distinct flowcharts). */
export function flowRefs(doc, titleOf = () => null) {
  const refs = [];
  const ids = [];
  const walk = (node, path) => (node.content ?? []).forEach((child, i) => {
    const id = child.type === 'canvas' ? child.attrs?.flow?.id : null;
    if (typeof id !== 'string' || !FLOW_ID.test(id)) return walk(child, [...path, i]);
    if (!ids.includes(id)) ids.push(id);
    refs.push({ path: [...path, i], flowId: id, label: titleOf(id) ?? `Flowchart ${ids.indexOf(id) + 1}` });
  });
  walk(doc, []);
  return refs;
}

/** The plan charts of `doc` in document order: [{id, planId}]. */
export function chartRefs(doc) {
  const refs = [];
  const walk = (node) => (node.content ?? []).forEach((child) => {
    if (child.type === 'planChart') refs.push({ id: child.attrs?.id ?? null, planId: child.attrs?.planId ?? null });
    else walk(child);
  });
  walk(doc);
  return refs;
}
