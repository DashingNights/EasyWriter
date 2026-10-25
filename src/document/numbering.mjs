// List labels of a Document's flat list paragraphs (docs/plans/document.md Lists): each numbered paragraph holds {numId, ilvl}
// and doc.attrs.numbering holds the definitions (numbering.xml: abstract levels and the nums that use them). Pure: lists.js
// draws the labels, Node tests check them.
import { numberLabel } from '../office.mjs';
import { LIST_ABSTRACTS } from './defaults.mjs';

/** The level definition {fmt, text, start, left, hanging} of `ilvl` in num `numId`, or null. */
export function levelOf(numbering, numId, ilvl) {
  const num = numbering?.nums?.[numId];
  return numbering?.abstract?.[num?.abstract]?.levels?.[ilvl] ?? null;
}

/** 'bullet' or 'number' for num `numId` (by its first level), or null when the num is unknown. */
export function kindOf(numbering, numId) {
  const lvl = levelOf(numbering, numId, 0);
  return lvl ? (lvl.fmt === 'bullet' ? 'bullet' : 'number') : null;
}

/** The labels of `items` (the numbering attrs {numId, ilvl} of the numbered paragraphs, in document order) under `numbering`:
 * one string per item, null where the num or level is unknown. Each num counts on its own, so numbering continues across the
 * paragraphs between its items and a new num restarts at its start value; an item resets the deeper levels of its num, as
 * Word's default lvlRestart does; lvlText (%1.%2.) fills each placeholder with that level's count. */
export function listLabels(items, numbering) {
  const counts = new Map(); // numId → count per level
  return items.map(({ numId, ilvl }) => {
    const num = numbering?.nums?.[numId];
    const levels = numbering?.abstract?.[num?.abstract]?.levels;
    const lvl = levels?.[ilvl];
    if (!lvl) return null;
    const start = (k) => (k === 0 && num.start != null ? num.start : levels[k]?.start ?? 1);
    const key = String(numId);
    const c = counts.get(key) ?? [];
    counts.set(key, c);
    c[ilvl] = (c[ilvl] ?? start(ilvl) - 1) + 1;
    c.length = ilvl + 1; // the deeper levels start again
    if (lvl.fmt === 'bullet') return lvl.text;
    return lvl.text.replace(/%([1-9])/g, (_, d) => numberLabel(c[d - 1] ?? start(d - 1), levels[d - 1]?.fmt ?? 'decimal'));
  });
}

let lastKey = 0;
/** A key for a list that a parse or paste brings in (Markdown, HTML lists, Word's mso-list): negative, so it never names a num.
 * Its paragraphs carry numbering {numId: key, ilvl, abstract} until the list gets a num of its own (numberNewLists here,
 * lists.js for an open Document), so separate lists count separately, as in Word. */
export const newListKey = () => --lastKey;

/** `numbering` with a new num on definition `abstract` (copied from LIST_ABSTRACTS on first use; a definition neither has
 * becomes 'decimal'), and that num's id. */
export function addNum(numbering, abstract) {
  const numId = Math.max(0, ...Object.keys(numbering.nums).map(Number).filter(Number.isFinite)) + 1;
  return { numId, numbering: setNumsAbstract(numbering, [numId], abstract) };
}

/** `numbering` with nums `numIds` (new ones made) on definition `abstract`, added as addNum adds it; a num keeps its start. */
export function setNumsAbstract(numbering, numIds, abstract) {
  const a = numbering.abstract[abstract] || LIST_ABSTRACTS[abstract] ? abstract : 'decimal';
  const nums = { ...numbering.nums };
  for (const id of numIds) nums[id] = { ...nums[id], abstract: a };
  return { abstract: numbering.abstract[a] ? numbering.abstract : { ...numbering.abstract, [a]: structuredClone(LIST_ABSTRACTS[a]) }, nums };
}

const sameLevels = (a, b) => a.length === b.length && a.every((l, i) => Object.keys({ ...l, ...b[i] }).every((k) => l[k] === b[i][k]));

/** `numbering` with definition `abstract`'s first-level format (the Numbering library's pick) on the levels that `items` (the
 * selected paragraphs' numbering) are at, through their whole lists, as Word's library changes the selected level of the list.
 * A list whose levels then match a known definition points at it (a pick at the first level of a default list is the library's
 * own), else at a new one. Null when an item is outside a list or at a level of the other kind (bullet or number). */
export function setListFormat(numbering, items, abstract) {
  const pick = (numbering.abstract[abstract] ?? LIST_ABSTRACTS[abstract])?.levels[0];
  const bullet = (lvl) => lvl.fmt === 'bullet';
  if (!pick || !items.every((n) => n && levelOf(numbering, n.numId, n.ilvl) && bullet(levelOf(numbering, n.numId, n.ilvl)) === bullet(pick))) return null;
  let out = numbering;
  for (const numId of new Set(items.map((n) => n.numId))) {
    const ilvls = new Set(items.filter((n) => n.numId === numId).map((n) => n.ilvl));
    const levels = out.abstract[out.nums[numId].abstract].levels.map((l, k) => {
      if (!ilvls.has(k)) return l;
      const { glyph, ...rest } = l;
      return { ...rest, fmt: pick.fmt, text: pick.text.replaceAll('%1', `%${k + 1}`), ...(pick.glyph && { glyph: pick.glyph }) };
    });
    const known = { ...LIST_ABSTRACTS, ...out.abstract };
    let a = Object.keys(known).find((name) => sameLevels(known[name].levels, levels));
    if (!a) {
      let i = 1;
      while (known[`custom${i}`]) i++;
      a = `custom${i}`;
      out = { ...out, abstract: { ...out.abstract, [a]: { levels } } };
    }
    out = setNumsAbstract(out, [numId], a);
  }
  return out;
}

/** TipTap JSON `doc` of a new Document (its attrs.numbering set) with each list its content brought in on a num of its own. */
export function numberNewLists(doc) {
  let numbering = doc.attrs.numbering;
  const made = new Map(); // key:abstract → numId
  const walk = (node) => {
    const n = node.attrs?.numbering;
    if (n?.abstract) {
      const key = `${n.numId}:${n.abstract}`;
      if (!made.has(key)) {
        const added = addNum(numbering, n.abstract);
        numbering = added.numbering;
        made.set(key, added.numId);
      }
      node.attrs = { ...node.attrs, numbering: { numId: made.get(key), ilvl: n.ilvl } };
    }
    node.content?.forEach(walk);
  };
  doc.content?.forEach(walk);
  return { ...doc, attrs: { ...doc.attrs, numbering } };
}
