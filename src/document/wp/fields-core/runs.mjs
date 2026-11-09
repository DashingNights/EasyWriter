// A field's result runs (the field node's `runs`): its result split by the formatting Word gave each run of it, so "plain *italic*
// plain" keeps its italic word through a .docx round trip, an update under \* MERGEFORMAT and an unlink. Each run holds its
// formatting marks (bold, italic, textStyle...); the node's own marks hold the formatting every run shares, the marks that span the
// whole field (link, comment, revisions), and any formatting given to the whole field later, which wins over the runs' (a mark
// type, or a textStyle key, the node sets). Runs count as they are only while their texts make up `result`: a writer that changes
// the result alone (a TOC page number, a citation, a form field's value) leaves stale runs, which then stand for one run of the
// result in the first run's formatting (validRuns). Pure: import.mjs runs it in the Web Worker on mark JSON.

// The marks that are a run's formatting (w:rPr); the others span the field and stay on its node.
export const FORMAT_MARKS = new Set(['bold', 'italic', 'strike', 'underline', 'subscript', 'superscript', 'textStyle']);
const MERGE = /\\\*\s*MERGEFORMAT/i;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const byType = (a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0);
const outer = (marks) => (marks ?? []).filter((m) => !FORMAT_MARKS.has(m.type));
const runOf = (text, marks) => ({ text, ...(marks?.length && { marks }) });

/** The formatting marks of `marks` (mark JSON) in one order, textStyle without its empty keys, so equal formatting compares equal
 * whether it came from a .docx or from ProseMirror's toJSON. */
function fmt(marks) {
  return (marks ?? []).filter((m) => FORMAT_MARKS.has(m.type)).map((m) => (m.type !== 'textStyle' ? m
    : { type: 'textStyle', attrs: Object.fromEntries(Object.entries(m.attrs ?? {}).filter(([, v]) => v != null).sort(([a], [b]) => (a < b ? -1 : 1))) }))
    .filter((m) => m.type !== 'textStyle' || Object.keys(m.attrs).length).sort(byType);
}

/** Parts [{text, marks}] → runs with neighbours of the same formatting joined and empty texts left out. */
function joined(parts) {
  const out = [];
  for (const p of parts) {
    if (!p.text) continue;
    const last = out.at(-1);
    if (last && same(last.marks, p.marks?.length ? p.marks : null)) last.text += p.text;
    else out.push(runOf(p.text, p.marks));
  }
  return out;
}

/** The formatting every one of `lists` (formatting mark JSON per run) holds: a mark all of them have, and of textStyle each key
 * whose value all of them agree on. */
function shared(lists) {
  const [first = [], ...rest] = lists;
  const out = [];
  for (const m of first) {
    if (m.type === 'textStyle') {
      const attrs = Object.fromEntries(Object.entries(m.attrs ?? {}).filter(([k, v]) => rest.every((l) => same(l.find((x) => x.type === 'textStyle')?.attrs?.[k], v))));
      if (Object.keys(attrs).length) out.push({ type: 'textStyle', attrs });
    } else if (rest.every((l) => l.some((x) => same(x, m)))) out.push(m);
  }
  return out;
}

/** Runs and the marks spanning the field → {runs (null for one run), marks: the node's (the spanning ones and the shared
 * formatting, or the one run's)}. */
function pack(parts, spans) {
  const runs = joined(parts);
  if (runs.length <= 1) return { runs: null, marks: [...spans, ...((runs[0] ?? parts[0])?.marks ?? [])] };
  return { runs, marks: [...spans, ...shared(runs.map((r) => r.marks ?? []))] };
}

/** The runs a field's result draws, saves and unlinks with: its `attrs.runs` while they make up its result. Runs left stale by a
 * writer that changed the result alone become one run of the result in the first run's formatting, as Word's update without a
 * switch gives it, so the first run's own formatting stays. null when the field has no runs or no result. */
export function validRuns(attrs) {
  const r = attrs?.runs;
  if (!Array.isArray(r) || r.length < 2 || !r.every((x) => typeof x?.text === 'string' && x.text && (x.marks == null || Array.isArray(x.marks)))) return null;
  const result = attrs.result ?? '';
  if (r.map((x) => x.text).join('') === result) return r;
  return result ? [runOf(result, r[0].marks)] : null;
}

/** The formatting of run `r` that the field node's marks `marks` (mark JSON) do not set: the node's mark types and textStyle keys
 * win, as formatting given to the whole field comes after its runs'. What the node view draws inside the node's own marks. */
export function ownMarks(r, marks) {
  const style = marks.find((m) => m.type === 'textStyle')?.attrs ?? {};
  const out = [];
  for (const m of r.marks ?? []) {
    if (m.type !== 'textStyle') {
      if (!marks.some((x) => x.type === m.type)) out.push(m);
      continue;
    }
    const attrs = Object.fromEntries(Object.entries(m.attrs ?? {}).filter(([k, v]) => v != null && style[k] == null));
    if (Object.keys(attrs).length) out.push({ type: 'textStyle', attrs });
  }
  return out;
}

/** The whole mark list of run `r` of a field with node marks `marks` (mark JSON): the node's and the run's own, one textStyle
 * holding both's keys. What export writes and unlink leaves. */
export function runMarks(marks, r) {
  const own = ownMarks(r, marks);
  const ts = own.find((m) => m.type === 'textStyle');
  if (!ts) return [...marks, ...own];
  const base = marks.find((m) => m.type === 'textStyle');
  return [...marks.filter((m) => m !== base), ...own.filter((m) => m !== ts), { type: 'textStyle', attrs: { ...base?.attrs, ...ts.attrs } }];
}

/** The result parts a .docx gives a field ([{text, marks}], each run's marks with the spanning ones) → {runs, marks} for the
 * node, or null when every part has the same formatting (the node then keeps its first result run's marks, as before runs). The
 * spanning marks are the first part's. */
export function resultRuns(parts) {
  const list = parts.filter((p) => p.text).map((p) => ({ text: p.text, marks: fmt(p.marks) }));
  if (joined(list).length < 2) return null;
  return pack(list, outer(parts.find((p) => p.text).marks));
}

/** `text` in the formatting of `runs` word by word (\* MERGEFORMAT): the nth word, and the nth space, take the formatting of the
 * old result's nth one, those past the old count the last one's. ponytail: by word, as Word's help describes the switch; how Word
 * maps a result whose word count changed is unverified. */
function remap(runs, text) {
  const old = runs.map((r) => r.text).join('');
  if (text === old) return runs;
  const at = [];
  for (const r of runs) for (let i = 0; i < r.text.length; i++) at.push(r.marks ?? null);
  const tokens = (s) => [...s.matchAll(/\s+|\S+/g)].map((m) => ({ word: /\S/.test(m[0]), at: m.index, s: m[0] }));
  const before = tokens(old);
  const words = before.filter((t) => t.word).map((t) => at[t.at]);
  const gaps = before.filter((t) => !t.word).map((t) => at[t.at]);
  const n = { word: 0, gap: 0 };
  return joined(tokens(text).map((t) => {
    const list = t.word ? words : gaps;
    const i = t.word ? n.word++ : n.gap++;
    return { text: t.s, marks: list.length ? list[Math.min(i, list.length - 1)] : at[0] };
  }));
}

/** The runs a field draws for `text` (its stored result, or a value an open or layout refresh computed): its own runs while the
 * text is its result; for another text, the old runs' formatting word by word under \* MERGEFORMAT, else the first run's for all
 * (Word's update without the switch; \* CHARFORMAT takes the code's first letter, which the model does not hold apart from the
 * result, so the first run stands for it). null when the field has no runs. */
export function drawnRuns(attrs, text) {
  const runs = validRuns(attrs);
  if (!runs || text === attrs.result) return runs;
  return MERGE.test(attrs.code ?? '') ? remap(runs, text) : [runOf(text, runs[0].marks)];
}

/** Field `node`'s result runs `runs` as they draw: each run's formatting with the node's own marks in it (mark JSON). */
function baked(node, runs) {
  const marks = node.marks.map((m) => m.toJSON());
  return runs.map((r) => ({ text: r.text, marks: fmt(runMarks(marks, r)) }));
}

/** Parts [{text, marks}] (whole formatting per part) → what field `node` writes for them: {runs, marks (Marks for the node)}. The
 * node keeps its spanning marks and takes what the parts share. */
function packed(node, parts) {
  const next = pack(parts, outer(node.marks.map((m) => m.toJSON())));
  const { schema } = node.type;
  return { runs: next.runs, marks: next.marks.reduce((s, m) => schema.markFromJSON(m).addToSet(s), []) };
}

/** What a manual update (or Ctrl+3 freezing a drawn value) writes for field `node` (a ProseMirror node) with result `text`:
 * {runs, marks (Marks for setNodeMarkup), changed}. Under \* MERGEFORMAT the runs follow the text word by word; without it the
 * whole result takes the first run's formatting, even when the text stays the same, as Word's update does. Formatting given to the
 * whole field goes into the runs first, so it stays. A field without runs keeps its marks. */
export function afterUpdate(node, text) {
  const runs = validRuns(node.attrs);
  if (!runs) return { runs: null, marks: node.marks, changed: false };
  const parts = baked(node, runs);
  const next = packed(node, MERGE.test(node.attrs.code ?? '') ? remap(parts, text) : [runOf(text, parts[0].marks)]);
  const changed = !same(next.runs, node.attrs.runs) || next.marks.length !== node.marks.length || next.marks.some((m, i) => !m.eq(node.marks[i]));
  return { ...next, changed };
}

/** A strip for stripRuns: formatting mark JSON without the mark types `types` and the textStyle keys `keys` (names). */
export const without = (types, keys = []) => (marks) => marks.flatMap((m) => {
  if (types.includes(m.type)) return [];
  if (m.type !== 'textStyle' || !keys.length) return [m];
  const attrs = Object.fromEntries(Object.entries(m.attrs ?? {}).filter(([k]) => !keys.includes(k)));
  return Object.keys(attrs).length ? [{ type: 'textStyle', attrs }] : [];
});

/** Takes formatting off the result runs of the fields between `from` and `to` in `tr`. `strip` maps a run's whole formatting (the
 * field's own marks included, as mark JSON) to what stays: `without(...)`, or font's resetMarks for Ctrl+Space. The runs are then
 * packed again, so the node's marks hold what they still share and a result left in one formatting has no runs. Word formats a
 * field result run by run, and removeMark reaches only the node's marks, so without this a run's italic outlives Clear Formatting.
 * Attribute and node mark steps keep every position and a node selection. → whether a field changed. */
export function stripRuns(tr, from, to, strip) {
  let changed = false;
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== 'field') return;
    const runs = validRuns(node.attrs);
    if (!runs) return;
    const parts = baked(node, runs);
    const left = parts.map((p) => ({ text: p.text, marks: fmt(strip(p.marks)) }));
    if (same(left, parts)) return;
    const next = packed(node, left);
    tr.setNodeAttribute(pos, 'runs', next.runs);
    for (const m of node.marks) if (!m.isInSet(next.marks)) tr.removeNodeMark(pos, m);
    for (const m of next.marks) if (!m.isInSet(node.marks)) tr.addNodeMark(pos, m);
    changed = true;
  });
  return changed;
}
