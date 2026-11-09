// Comments' model (docs/plans/word plan.md §3 comments, §1.8 comment mark, doc.attrs.comments and people): every change to a
// thread as one main-editor transaction, the word a caret comment anchors on, paste renumbering, the filters and the time
// strings the cards show. A thread is a comment mark {id} on its range plus doc.attrs.comments[id] = {author, initials, date,
// done, parent: null, content}; a reply is an entry whose parent is the thread id and has no mark. Pure: Node tests load it.
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, Slice } from '@tiptap/pm/model';
import { commentsOf } from '../../model/review.mjs';

export { commentsOf };

const WORD = /[\p{L}\p{N}_'’-]/u;
const ZWSP = '​';
// Author colours in the order people join, readable as a light tint behind black text and as a solid avatar.
export const COLORS = ['#c0504d', '#2e75b6', '#70ad47', '#7030a0', '#ed7d31', '#00a3a3', '#b8860b', '#d6336c'];

/** The word at `pos` in `doc` → {from, to}, or null: the word the caret is in or starts, else the word that ends at it. */
export function wordAt(doc, pos) {
  const $pos = doc.resolve(pos);
  const block = $pos.parent;
  if (!block.isTextblock) return null;
  // [char, position] of each text character; any other inline node (a content control, an image) is one separator, so the
  // offsets stay true where a node's open and close tokens add positions that its text does not show.
  const chars = [];
  const start = $pos.start();
  block.forEach((child, off) => {
    if (child.isText) for (let i = 0; i < child.text.length; i++) chars.push([child.text[i], start + off + i]);
    else chars.push(['￼', start + off]);
  });
  const isWord = (i) => WORD.test(chars[i]?.[0] ?? '');
  let a = chars.findIndex(([, p]) => p >= pos);
  if (a < 0) a = chars.length;
  let b = a;
  if (!isWord(a) && !isWord(a - 1)) return null;
  while (a > 0 && isWord(a - 1)) a--;
  while (b < chars.length && isWord(b)) b++;
  return { from: chars[a][1], to: chars[b - 1][1] + 1 };
}

/** The next free comment id of `comments` (numeric, as Word's w:id) → a string. */
export function nextId(comments) {
  let max = 0;
  for (const id of Object.keys(comments ?? {})) max = Math.max(max, Number(id) || 0);
  return String(max + 1);
}

/** The author of new comments, revisions and Compare labels → {name, initials}: the `tracking` author (Track Changes Options)
 * when given, else settings.word.user's name, else the OS `account` name (as Office does), else 'Author'; initials from the
 * name when unset. */
export function authorOf(user, account = '', tracking = '') {
  const name = tracking?.trim() || user?.name?.trim() || account?.trim() || 'Author';
  const initials = user?.initials?.trim() || name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase() || 'A';
  return { name, initials };
}

// The OS account's name, asked once for comments, revisions and Compare. The only line here that touches window; Node has none.
let account = '';
globalThis.window?.api?.word?.userName?.().then((n) => { account = n || ''; }, () => {});
/** The OS account's name, or '' until the answer arrives (or with no window.api). */
export const accountName = () => account;

/** `people` with `name` joined when missing → the same array when present, else a new one with the next colour. */
export function joinPeople(people, name, initials) {
  const list = Array.isArray(people) ? people : [];
  if (list.some((p) => p.name === name)) return list;
  return [...list, { name, initials, color: COLORS[list.length % COLORS.length] }];
}

/** The colour of `author` in `people`, else the first colour. */
export const colorOf = (people, author) => (Array.isArray(people) ? people.find((p) => p.name === author)?.color : null) ?? COLORS[0];

/** `content` (block JSON) without tracked changes: comment text is never tracked, so inserted text stays and deleted text goes. */
export function untracked(content) {
  const walk = (n) => {
    if (n.marks?.some((m) => m.type === 'deletion')) return null;
    const out = { ...n };
    if (n.marks) {
      out.marks = n.marks.filter((m) => m.type !== 'insertion' && m.type !== 'formatChange');
      if (!out.marks.length) delete out.marks;
    }
    if (Array.isArray(n.content)) out.content = n.content.map(walk).filter(Boolean);
    return out;
  };
  return (content ?? []).map(walk).filter(Boolean);
}

/** Whether block JSON `content` holds no text and no inline object. */
export function isEmpty(content) {
  const has = (n) => (n.type === 'text' ? !!n.text?.replace(/​/g, '') : !n.content ? n.type !== 'paragraph' && n.type !== 'hardBreak' : n.content.some(has));
  return !(content ?? []).some(has);
}

const entryOf = ({ author, initials, date, content }) => ({ author, initials, date, done: false, parent: null, content: content ?? [{ type: 'paragraph' }] });

// Every comment change starts its own undo step, so two quick changes never merge into one.
const begin = (state) => closeHistory(state.tr).setMeta('commentsOwn', true);

/** Adds a thread on `range` ({from, to}) of `state` with its first comment ({author, initials, date, content}) → {tr, id}. An
 * empty range takes a zero-width space to carry the mark (an empty paragraph). The author joins doc.attrs.people. */
export function addComment(state, range, c) {
  const tr = begin(state);
  const comments = state.doc.attrs.comments ?? {};
  const id = nextId(comments);
  let { from, to } = range;
  // ponytail: the zero-width space stays in the text (Word anchors on the paragraph mark); it goes with the thread's delete.
  if (from === to) {
    tr.insertText(ZWSP, from);
    to = from + 1;
  }
  tr.addMark(from, to, state.schema.marks.comment.create({ id }));
  tr.setDocAttribute('comments', { ...comments, [id]: entryOf(c) });
  const people = joinPeople(state.doc.attrs.people, c.author, c.initials);
  if (people !== state.doc.attrs.people) tr.setDocAttribute('people', people);
  return { tr, id };
}

/** Adds a reply ({author, initials, date, content}) to thread `parent` → {tr, id}; the reply has no mark. */
export function addReply(state, parent, c) {
  const tr = begin(state);
  const comments = state.doc.attrs.comments ?? {};
  const id = nextId(comments);
  tr.setDocAttribute('comments', { ...comments, [id]: { ...entryOf(c), parent } });
  const people = joinPeople(state.doc.attrs.people, c.author, c.initials);
  if (people !== state.doc.attrs.people) tr.setDocAttribute('people', people);
  return { tr, id };
}

/** Patches comment `id`'s entry with `patch` ({content}, {done}) → tr, or null when there is no such entry. Edit, resolve and
 * reopen go through it, so only that entry changes. */
export function setEntry(state, id, patch, tr = begin(state)) {
  const comments = state.doc.attrs.comments ?? {};
  if (!comments[id]) return null;
  return tr.setDocAttribute('comments', { ...comments, [id]: { ...comments[id], ...patch } });
}

/** Deletes the threads `ids` (their marks, their entries and every reply; a reply id deletes only that reply) → tr or null. A
 * mark on an inline node (a field, an image, an equation, a note reference) goes like one on text. */
export function deleteThreads(state, ids) {
  const comments = state.doc.attrs.comments ?? {};
  const top = new Set(ids.filter((id) => !comments[id]?.parent));
  const gone = new Set(ids);
  for (const [id, c] of Object.entries(comments)) if (top.has(c.parent)) gone.add(id);
  if (!gone.size) return null;
  const tr = begin(state);
  const type = state.schema.marks.comment;
  // The zero-width spaces that carried only these threads' marks go with them, from the end so positions hold.
  const carriers = [];
  state.doc.descendants((node, pos) => {
    if (!node.isInline) return;
    const mine = node.marks.filter((m) => m.type === type && top.has(m.attrs.id));
    if (!mine.length) return;
    if (node.isText && /^​+$/.test(node.text) && node.marks.filter((m) => m.type === type).length === mine.length) carriers.push([pos, pos + node.nodeSize]);
    for (const m of mine) tr.removeMark(pos, pos + node.nodeSize, m);
  });
  for (const [a, b] of carriers.reverse()) tr.delete(a, b);
  const left = Object.fromEntries(Object.entries(comments).filter(([id]) => !gone.has(id)));
  tr.setDocAttribute('comments', left);
  return tr;
}

/** `threads` (commentsOf) that pass `filter`: null keeps all, 'active' the open ones, 'resolved' the resolved ones. */
export const filterThreads = (threads, filter) => (!filter ? threads : threads.filter((c) => (filter === 'resolved' ? c.done : !c.done)));

/** Deletes every thread of `which` → tr or null: 'all', 'resolved', or 'shown' (those `filter` shows). */
export function deleteAll(state, which, filter = null) {
  const all = commentsOf(state.doc);
  const pick = which === 'all' ? all : which === 'resolved' ? all.filter((c) => c.done) : filterThreads(all, filter);
  return pick.length ? deleteThreads(state, pick.map((c) => c.id)) : null;
}

/** The thread after (`dir` 1) or before (-1) position `at` among anchored `threads` in document order, wrapping → the thread or null. */
export function stepThread(threads, at, dir) {
  const list = threads.filter((c) => c.from != null);
  if (!list.length) return null;
  if (dir > 0) return list.find((c) => c.from > at) ?? list[0];
  return list.findLast((c) => c.from < at) ?? list.at(-1);
}

/** The id of the thread under `state`'s selection (the first comment mark at the caret or in the range), or null. */
export function commentAt(state) {
  const type = state.schema.marks.comment;
  if (!type) return null;
  const { from, to, empty, $from } = state.selection;
  if (empty) {
    const m = [...$from.marks(), ...($from.nodeAfter?.marks ?? [])].find((x) => x.type === type);
    return m?.attrs.id ?? null;
  }
  let id = null;
  state.doc.nodesBetween(from, to, (n) => {
    if (id) return false;
    id = n.marks.find((x) => x.type === type)?.attrs.id ?? null;
  });
  return id;
}

/** The ranges of thread `id` in `doc` → [{from, to}], one per marked text node, merged where they touch. */
export function rangesOf(doc, id) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isInline || !node.marks.some((m) => m.type.name === 'comment' && m.attrs.id === id)) return;
    const end = pos + node.nodeSize;
    if (out.length && out.at(-1).to === pos) out.at(-1).to = end;
    else out.push({ from: pos, to: end });
  });
  return out;
}

/** `slice` with each comment mark's id passed through `decide(id)` → {slice, map}: a new id renames the mark, null drops it.
 * `map` is {oldId: newId} of the marks kept. */
export function remapSlice(slice, decide) {
  const map = {};
  const pick = (id) => {
    if (!(id in map)) map[id] = decide(id);
    return map[id];
  };
  const marks = (ms) => ms.flatMap((m) => {
    if (m.type.name !== 'comment') return [m];
    const id = pick(m.attrs.id);
    return id == null ? [] : [m.type.create({ ...m.attrs, id })];
  });
  const frag = (f) => Fragment.fromArray(f.content.map((n) => (n.isText ? n.mark(marks(n.marks))
    : n.copy(frag(n.content)).mark(marks(n.marks)))));
  const out = new Slice(frag(slice.content), slice.openStart, slice.openEnd);
  for (const [k, v] of Object.entries(map)) if (v == null) delete map[k];
  return { slice: out, map };
}

/** The thread `id` of `comments` with its replies → {entry, replies: [[id, entry]]} or null: what a copy carries. */
export function threadOf(comments, id) {
  const entry = comments?.[id];
  if (!entry) return null;
  return { entry, replies: Object.entries(comments).filter(([, c]) => c.parent === id) };
}

/** The comment marks of a pasted `slice` renumbered for a doc holding `comments` → {slice, pairs: [[newId, source thread]]}.
 * A thread comes from `clip` (what the last copy carried, as threadOf) before `comments`, so a paste from another draft brings
 * its own thread even when this doc has one with the same id. An id this doc uses gets a new id past every id in the doc and
 * the slice, so no two pasted ranges share one; a mark with no thread to copy is dropped. */
export function pasteIds(slice, comments, clip = new Map()) {
  let next = Number(nextId(comments));
  for (const id of Object.keys(remapSlice(slice, (id) => id).map)) next = Math.max(next, (Number(id) || 0) + 1);
  const pairs = [];
  const out = remapSlice(slice, (id) => {
    const src = clip.get(id) ?? threadOf(comments, id);
    if (!src) return null; // ponytail: a comment copied outside a Document arrives without its thread, so its mark is dropped
    const nid = comments[id] ? String(next++) : id;
    pairs.push([nid, src]);
    return nid;
  });
  return { slice: out.slice, pairs };
}

/** `comments` with each pasted thread copied in: `pairs` [[newId, threadOf source]] → the new comments object. The replies get
 * fresh ids after every id in use. */
export function copyThreads(comments, pairs) {
  const out = { ...comments };
  const added = pairs.filter(([id, src]) => src && !out[id]);
  // Every thread first, so a reply's fresh id never takes an id another pasted thread already holds.
  for (const [id, src] of added) out[id] = { ...src.entry, parent: null };
  for (const [id, src] of added) for (const [, r] of src.replies) out[nextId(out)] = { ...r, parent: id };
  return out;
}

// The step range of `step` in its doc, or null for a step that removes no text (marks, attributes).
const removedRange = (step) => (step.from != null && step.to != null && step.to > step.from ? [step.from, step.to] : null);

/** The threads whose anchored text the user deleted entirely in `trs` (oldState → newState) → their ids. Cheap: it looks only at
 * the removed ranges, and walks the new doc only when one held a comment mark. */
export function orphaned(trs, newState) {
  const comments = newState.doc.attrs.comments;
  if (!comments || !Object.keys(comments).length) return [];
  const hit = new Set();
  for (const tr of trs) {
    if (!tr.docChanged || tr.getMeta('commentsOwn')) continue;
    tr.steps.forEach((step, i) => {
      const r = removedRange(step);
      if (!r) return;
      tr.docs[i].nodesBetween(r[0], r[1], (n) => {
        for (const m of n.marks) if (m.type.name === 'comment' && comments[m.attrs.id] && !comments[m.attrs.id].parent) hit.add(m.attrs.id);
      });
    });
  }
  if (!hit.size) return [];
  newState.doc.descendants((n) => {
    if (!hit.size) return false;
    for (const m of n.marks) if (m.type.name === 'comment') hit.delete(m.attrs.id);
  });
  return [...hit];
}

/** The entries of `comments` without the threads `ids` and their replies → a new object. */
export function withoutThreads(comments, ids) {
  const gone = new Set(ids);
  return Object.fromEntries(Object.entries(comments).filter(([id, c]) => !gone.has(id) && !gone.has(c.parent)));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');

/** When `date` (ISO) was, in our words as of `now`: 'Just now', 'n minutes ago', then the date and time ('27 Oct 2026, 10:05');
 * '' for a missing or invalid date (new Date(null) would be 1 Jan 1970). */
export function timeAgo(date, now = Date.now()) {
  const d = new Date(date || NaN);
  if (Number.isNaN(d.getTime())) return '';
  const s = (now - d.getTime()) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}
