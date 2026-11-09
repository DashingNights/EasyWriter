// The enforcement filter's decisions (docs/plans/word/briefs/protect.md Enforcement filter). Pure: the protect extension asks it
// about every transaction of every Document kit editor, and node tests feed it transactions. One rule set covers Restrict
// Editing's protection, the Viewing mode, a session opened read-only and a document marked as final.
import { AddMarkStep, AddNodeMarkStep, AttrStep, DocAttrStep, RemoveMarkStep, RemoveNodeMarkStep, ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import { sectionAt, sectionsOf } from '../../model/sections.mjs';
import { styleIdOf } from '../../model/styles.mjs';

// Marks that are not formatting: Word lets them through a formatting restriction.
const NOT_FORMATTING = new Set(['comment', 'permission', 'insertion', 'deletion', 'formatChange', 'link']);
// Paragraph attributes a formatting restriction leaves free: the style (checked against the locked ones) and the review records.
const FREE_ATTRS = new Set(['styleId', 'level', 'suggest', 'rev', 'markRev', 'pChange']);
// Doc attributes the Comments mode lets change: the comments and their authors.
const COMMENT_ATTRS = new Set(['comments', 'people']);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const formProtOf = (sect) => !!sect?.formProt;

/** Whether `doc` is marked as final (File > Info > Protect Document > Mark as Final). */
export const isFinal = (doc) => !!doc.attrs.props?.custom?.some?.((p) => p?.name === '_MarkAsFinal' && p.value === true);

/** The rules in force for `doc` → null when nothing is enforced, else {edit: null | 'readOnly' | 'comments' | 'trackedChanges' |
 * 'forms', formatting, lockTheme, locked: Set of style ids, regions (whether permission marks open exceptions), user}. viewing:
 * store word.mode is 'viewing'; session: opened read-only; final: marked as final elsewhere (a story editor asks its main doc).
 * protection.lockQFSet and autoFormatOverride are stored only, until the style set and AutoFormat owners read them. */
export function rulesOf(doc, { viewing = false, session = false, final = false, user = '' } = {}) {
  const p = doc.attrs.settings?.protection;
  const on = !!p?.enforcement;
  let edit = on && p.edit && p.edit !== 'none' ? p.edit : null;
  const locked = viewing || session || final || isFinal(doc); // read-only with no exceptions
  if (locked) edit = 'readOnly';
  const formatting = on && !!p.formatting;
  if (!edit && !formatting) return null;
  const list = doc.attrs.styles?.list ?? {};
  const lockedStyles = new Set(formatting ? Object.keys(list).filter((id) => list[id]?.locked) : []);
  return { edit, formatting, lockTheme: formatting && !!p.lockTheme, locked: lockedStyles, regions: !locked, user: user ?? '' };
}

/** Whether a permission mark's editor `ed` lets `user` edit. */
export const mayEdit = (ed, user) => ed === 'everyone' || (!!user && !!ed && ed.toLowerCase() === user.toLowerCase());

const rangeMemo = new WeakMap(); // doc → Map(user → ranges)

/** The ranges of `doc` that `user` may edit: inline content under a permission mark for everyone or for `user`, adjacent runs
 * merged → [{from, to}] in document order. */
export function regionsOf(doc, user = '') {
  let byUser = rangeMemo.get(doc);
  if (!byUser) rangeMemo.set(doc, (byUser = new Map()));
  let out = byUser.get(user);
  if (out) return out;
  out = [];
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    if (node.marks.some((m) => m.type.name === 'permission' && mayEdit(m.attrs.ed, user))) {
      const last = out.at(-1);
      if (last && last.to === pos) last.to = pos + node.nodeSize;
      else out.push({ from: pos, to: pos + node.nodeSize });
    }
    return false;
  });
  byUser.set(user, out);
  return out;
}

/** Whether `from`..`to` lies inside one region `user` may edit. A point counts inside when text typed there joins the region:
 * after its first character up to its end (the mark is inclusive). */
export function inRegion(doc, from, to, user) {
  return regionsOf(doc, user).some((r) => (from === to ? from > r.from && from <= r.to : from >= r.from && to <= r.to));
}

/** Whether `from`..`to` lies inside one content control, or is exactly a legacy form field (its result). */
function inForm(doc, from, to) {
  const node = doc.nodeAt(from);
  if (node?.type.name === 'field' && node.attrs.ff && (to === from || to === from + node.nodeSize)) return true;
  const $from = doc.resolve(from);
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if ((name === 'sdtInline' || name === 'sdtBlock') && to <= $from.end(d)) return true;
  }
  return false;
}

/** Whether a section touching `from`..`to` is protected for forms (sect.formProt). */
function formProtected(doc, from, to) {
  const all = sectionsOf(doc);
  const a = sectionAt(all, from).index;
  const b = sectionAt(all, to).index;
  return all.slice(a, b + 1).some((s) => s.sect.formProt);
}

/** Whether the editing restriction lets `from`..`to` of `doc` change; `comment`: the change is a comment mark. */
function editOk(doc, from, to, rules, comment = false) {
  const { edit, user } = rules;
  if (!edit || edit === 'trackedChanges') return true;
  if (edit === 'comments' && comment) return true;
  if (edit === 'forms') return !formProtected(doc, from, to) || inForm(doc, from, to);
  return rules.regions && inRegion(doc, from, to, user);
}

/** The node `step` swaps for one of different attributes or type around the same content (setNodeMarkup, setBlockType) →
 * {before, after} or null. */
function markupChange(step, doc) {
  if (!(step instanceof ReplaceAroundStep) || step.insert !== 1 || step.slice.content.childCount !== 1) return null;
  if (step.gapFrom !== step.from + 1 || step.gapTo !== step.to - 1) return null;
  const before = doc.nodeAt(step.from);
  return before ? { before, after: step.slice.content.firstChild } : null;
}

/** Whether a formatting restriction lets `before` become `after` (paragraph properties): only the style may change, to one that
 * is not locked. */
function styleOk(before, after, rules) {
  if (!before.isTextblock) return true;
  const keys = new Set([...Object.keys(before.attrs), ...Object.keys(after.attrs)]);
  for (const k of keys) {
    if (!FREE_ATTRS.has(k) && JSON.stringify(before.attrs[k] ?? null) !== JSON.stringify(after.attrs[k] ?? null)) return false;
  }
  return styleIdOf(before) === styleIdOf(after) || !rules.locked.has(styleIdOf(after));
}

/** Whether `step` may apply to `doc` (the doc before it) under `rules`. */
export function stepAllowed(step, doc, rules) {
  if (step instanceof DocAttrStep) {
    // Only protect's own engine changes may change the protection or a section's form protection (an undo must not drop them).
    if (step.attr === 'settings' && !same(step.value?.protection, doc.attrs.settings?.protection)) return false;
    if (step.attr === 'sect' && formProtOf(step.value) !== formProtOf(doc.attrs.sect)) return false;
    if (rules.formatting && (step.attr === 'styles' || (step.attr === 'theme' && rules.lockTheme))) return false;
    const { edit } = rules;
    return !edit || edit === 'trackedChanges' || (edit === 'comments' && COMMENT_ATTRS.has(step.attr));
  }
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
    const name = step.mark.type.name;
    if (rules.formatting && !NOT_FORMATTING.has(name)) return false;
    return editOk(doc, step.from, step.to, rules, name === 'comment');
  }
  if (step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) {
    const name = step.mark.type.name;
    if (rules.formatting && !NOT_FORMATTING.has(name)) return false;
    const node = doc.nodeAt(step.pos);
    return editOk(doc, step.pos, step.pos + (node?.nodeSize ?? 1), rules, name === 'comment');
  }
  if (step instanceof AttrStep) {
    const node = doc.nodeAt(step.pos);
    if (!node) return false;
    if (step.attr === 'sect' && formProtOf(step.value) !== formProtOf(node.attrs.sect)) return false;
    if (rules.formatting && !styleOk(node, node.type.create({ ...node.attrs, [step.attr]: step.value }), rules)) return false;
    return editOk(doc, step.pos, step.pos + node.nodeSize, rules);
  }
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
    const change = markupChange(step, doc);
    if (change && formProtOf(change.before.attrs.sect) !== formProtOf(change.after.attrs.sect)) return false;
    if (change && rules.formatting && !styleOk(change.before, change.after, rules)) return false;
    return editOk(doc, step.from, step.to, rules);
  }
  return !rules.edit || rules.edit === 'trackedChanges'; // a step kind this filter does not know
}

/** Whether transaction `tr` may apply under `rules` (rulesOf the state before it). Meta-only transactions and those an engine
 * makes on the user's behalf (meta 'wordEngine') pass; each step is judged against the doc before it. */
export function allowed(tr, rules) {
  if (!rules || !tr.docChanged || tr.getMeta('wordEngine')) return true;
  return tr.steps.every((step, i) => stepAllowed(step, tr.docs[i], rules));
}

const passed = new WeakSet(); // root transactions judge() let through

/** allowed(), plus: a transaction a plugin appended passes when its root passed (Suggestions' and Lists' appends survive). */
export function judge(tr, rules) {
  const root = tr.getMeta('appendedTransaction');
  if (root && passed.has(root)) return true;
  if (!allowed(tr, rules)) return false;
  if (tr.docChanged) passed.add(tr);
  return true;
}
