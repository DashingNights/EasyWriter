import { find as findBlocks, nodeAt, nodeText, outline as blockOutline } from '../../doc-path.mjs';
import { renderPost } from '../../document/canvas/post.js';
import { fromEngineSource, toEngineSource } from '../../document/wp/citations/canvas.mjs';
import { THEME } from '../../document/defaults.mjs';
import { MARGIN_PRESETS, PAPER_SIZES, resolveColor } from '../../office.mjs';
import { referenceList, tagOf } from '../../references.mjs';
import { ASSISTANT } from '../../suggest/core.mjs';
import { fail } from './define.mjs';
import { shown } from './references.mjs';

// The assistant's draft commands on a canvas draft (docs/plans/engine/stage2b.md decisions 4 and 7, stage2b/assistant.md sections 1
// and 2): reads come from the engine's pure queries (document.outline, find, html, selection), and every write is engine command
// steps that the executor runs in one execAs call as "Assistant" (commands.js), so the change is a tracked change by the assistant
// with its suggestion group as the tag, one undo step, and the user's author, Track Changes and selection stay theirs.
//
// Addresses: a PATH is a paragraph's path as document.outline gives it ([4], or [3, 0, 1, 0] in a table cell); a write resolves it
// to the paragraph's id and the steps address that id (select.at), so the steps of a batch never move each other's targets. A read
// keeps the outline it saw per revision (`seen`): a call with ifRev finds its paragraph in the outline of that revision and is
// refused as stale when the paragraph went or its text changed since. Offsets are UTF-16 offsets into the paragraph's stored text,
// in which every object (a picture, a field, a note mark) is one U+FFFC and text a tracked deletion removed is still there.
//
// `c` (the executor's): {eng (the draft's SessionClient), ifRev, draftId, html(content) → {html, dropped}, fromHtml(html, images) →
// TipTap JSON blocks, markdownOf(blocks), shortImages(html), noteMarkers(markdown), references (app/references.js)}. Pure: node
// tests run it on the engine's WebAssembly through an adapter.

const OBJ = '\uFFFC';
const CONTEXT = 40;
const KEEP_REVS = 4; // outlines kept per session for ifRev; each holds the draft's whole text
const KEEP_DRAFTS = 4; // sessions whose outlines are kept
// A paragraph pasted first and taken out again, so the first real one keeps its own style (a paste merges its first paragraph
// into the one at the caret, whose properties win).
const SENTINEL = '<p>\u200B</p>';
/** What a read through HTML leaves out (doc.get markdown and json on a canvas draft). */
const HTML_LOSS = 'Read from the canvas engine as HTML: fields show their results, and notes, bookmarks, comments, tracked changes and content controls are left out';

const keyOf = (path) => path.join(',');
const plain = (t) => t.split(OBJ).join('');
const cut = (s) => (s.length > 120 ? `${s.slice(0, 120)}... (cut, ${s.length} characters in all)` : s);
const startsWith = (path, pre) => pre.every((v, i) => path[i] === v);

/** Query `id`'s value from engine session `eng`; fails with the engine's reason. */
async function query(eng, id, args = {}) {
  const r = await eng.query(id, args);
  if (!r?.ok) fail('failed', `${id}: ${r?.error ?? 'the engine did not answer'}`);
  return r.value;
}

const seen = new Map(); // engine session id → {eng, revs: Map(rev → outline), the newest last}

/** The outlines kept for session `eng`. A session opened fresh for the same draft restarts its revs, so a kept entry counts only
 * for the client that read it. */
const revsOf = (eng) => {
  const e = seen.get(eng.id);
  return e?.eng === eng ? e.revs : undefined;
};

/** Keeps outline `o` as the outline of its revision for session `eng` (the revisions an agent's later calls name as ifRev are
 * its reads'). */
function remember(eng, o) {
  const revs = revsOf(eng) ?? new Map();
  // The drafts read last keep theirs: one read long ago is stale anyway.
  seen.delete(eng.id);
  seen.set(eng.id, { eng, revs });
  if (seen.size > KEEP_DRAFTS) seen.delete(seen.keys().next().value);
  revs.delete(o.rev);
  revs.set(o.rev, o);
  while (revs.size > KEEP_REVS) revs.delete(revs.keys().next().value);
}

/** The body's paragraphs now → {rev, paras: [{para, path, style, level?, list?, text, revs?, tags?, i}], byPara, byPath}. A read's
 * (`keep`) is kept as the outline of its revision: the revisions an agent's later calls name as ifRev are its reads'. A forum
 * post's allow list refuses document.outline: its own state stands in (postStateOf), also for the situation note's first read. */
export async function outlineOf(eng, keep = true) {
  if (!postOf(eng)) {
    const r = await eng.query('document.outline');
    if (r?.ok) {
      const v = r.value;
      const paras = v.paragraphs.map((p, i) => ({ ...p, para: String(p.para), i }));
      const o = { rev: v.rev, paras, byPara: new Map(paras.map((p) => [p.para, p])), byPath: new Map(paras.map((p) => [keyOf(p.path), p])) };
      if (keep) remember(eng, o);
      return o;
    }
    if (!/forum post/.test(String(r?.error ?? ''))) fail('failed', `document.outline: ${r?.error ?? 'the engine did not answer'}`);
    posts.add(eng);
  }
  return postStateOf(eng, keep);
}

/** The assistant's changes waiting in engine session `eng`: its revisions (each a call's or a step's) among review.changes. */
export async function assistantRevs(eng) {
  const changes = (await eng.query('review.changes'))?.value ?? [];
  return new Set(changes.filter((c) => c.author === ASSISTANT).map((c) => c.rev)).size;
}

/** The revision of session `eng`'s last outline read, or undefined. */
export const lastRev = (eng) => [...(revsOf(eng)?.keys() ?? [])].at(-1);

/** The paragraphs `path` names in outline `o`: the paragraph at that path, else every paragraph under it (a table). */
function under(o, path) {
  const p = o.byPath.get(keyOf(path));
  return p ? [p] : o.paras.filter((x) => x.path.length > path.length && startsWith(x.path, path));
}

/** The paragraphs `path` names now (outline `now`), read at c.ifRev: refused as stale when that revision's paragraph went or its
 * text changed since, not_found when no paragraph is there. `one`: it must name one paragraph (an insert or edit target). */
function target(c, now, path, one = false) {
  let ps;
  if (c.ifRev === undefined || c.ifRev === now.rev) ps = under(now, path);
  else {
    const then = revsOf(c.eng)?.get(c.ifRev);
    if (!then) fail('stale', `The draft changed since rev ${c.ifRev}; read it again`, { rev: now.rev });
    ps = under(then, path).map((p) => {
      const n = now.byPara.get(p.para);
      if (!n || n.text !== p.text) fail('stale', `The block at [${path}] changed since rev ${c.ifRev}; read it again`, { rev: now.rev, path });
      return n;
    });
  }
  if (!ps.length) fail('not_found', `No paragraph at [${path}]`, { path, hint: 'doc_get format outline gives the paths' });
  if (one && ps.length > 1) {
    fail('refused', `[${path}] is a table, not a paragraph`, { code: 'not_text', hint: `Its paragraphs have paths such as [${ps[0].path}]` });
  }
  return ps;
}

/** The paragraph before or after the paragraphs `ps` at their own level (the same container), or null. */
function sibling(o, ps, dir) {
  const edge = dir < 0 ? ps[0] : ps.at(-1);
  const x = o.paras[edge.i + dir];
  const depth = ps[0].path.length;
  return x && x.path.length === depth && startsWith(x.path, ps[0].path.slice(0, -1)) ? x : null;
}

/** The outline entry of paragraph `p` (doc.get outline). */
const entry = (p) => ({
  path: p.path, type: p.level ? 'heading' : 'paragraph', style: p.style, text: cut(plain(p.text)),
  ...(p.level && { attrs: { level: p.level } }), ...(p.list && { list: p.list }), ...(p.tags && { pending: p.tags }),
});

/** Where paragraph `p`'s selection end `pos` is → {p, off} through the engine's locate, or null outside the body. */
async function located(c, o, pos) {
  if (pos?.story !== 'body') return null;
  const at = await c.eng.locate(pos);
  const p = at && o.byPara.get(String(at.id));
  return p ? { p, off: at.offset } : null;
}

// ---------------------------------------------------------------------------------------------
// Forum posts (docs/plans/engine/stage3-forum.md C5): the post kit's JSON is the record, so every read comes from the engine's
// saves (save('post') for the doc, save('md') for its Markdown, renderPost for the forum's HTML) and every write from the post
// commands (post.insert, post.mark, post.block, post.toggle, post.list, post.rule, post.clear), which act on the selection. The
// engine refuses document.outline, document.find and document.text on a post (B1's allow list), so the outline, the paths and
// the textblocks are read from text.paragraphs, which the post's allow list grants. A post has no document revision of its own
// to pass as execAs's ifRev: the saved JSON's hash stands in for it, and the staleness check is ours (the target's text).

const decoder = new TextDecoder();
const encoder = new TextEncoder();
/** The post's kit's textblocks (the DOM editor's isTextblock) and its object blocks (a paragraph in the engine, no text). */
const TEXTBLOCK = new Set(['paragraph', 'heading', 'codeBlock', 'boxTitle']);
const OBJECT = new Set(['canvas', 'planChart', 'media']);
/** What a post read through Markdown leaves out. */
const POST_LOSS = 'Read from the canvas engine: fields show their results, and notes, bookmarks, comments, tracked changes and content controls are left out';

/** The engine sessions that hold a forum post (set by every post read and write). */
const posts = new WeakSet();
const postOf = (eng) => posts.has(eng);
/** Notes engine session `eng` as a forum post's, so its reads, writes and commit's outline come from the post's state. The
 * executor knows the draft's format before a command runs (commands.js engineCtx). */
export const markPost = (eng) => posts.add(eng);
/** Whether `c`'s command works on a post: the executor knows the draft's format (`post`), and an engine session a post read
 * or write has served keeps it for commit and the situation note. */
const isPost = (c) => c.post === true || postOf(c.eng);

const bytes = (text, u16) => encoder.encode(String(text).slice(0, Math.max(0, u16))).length;

/** The post's textblocks and object blocks in document order, each with the post path it sits at and, for a code block's
 * lines, the UTF-16 offset of its line in the block's text: one entry per engine paragraph. */
function postLeaves(doc) {
  const out = [];
  const walk = (nodes, path) => (nodes ?? []).forEach((n, i) => {
    const p = [...path, i];
    if (n.type === 'codeBlock') {
      let off = 0;
      for (const line of String(nodeText(n)).split('\n')) {
        out.push({ path: p, text: line, off, first: off === 0 });
        off += line.length + 1;
      }
    } else if (TEXTBLOCK.has(n.type)) out.push({ path: p, text: nodeText(n), off: 0, first: true });
    // A rule is an empty paragraph in the post's rule style: its path must be addressable too (doc_insert before or after it).
    else if (n.type === 'horizontalRule') out.push({ path: p, text: '', off: 0, first: true });
    else if (OBJECT.has(n.type)) out.push({ path: p, text: '', off: 0, first: true });
    else if (Array.isArray(n.content)) walk(n.content, p);
  });
  walk(doc?.content, []);
  return out;
}

/** The engine's document revision of a post's session, read-only (the engine's rev getter: no command runs, so a typing run
 * or an IME composition is left exactly as it was; document.outline, which gives a document's rev, is not in a post's allow
 * list). Read before the state it goes with, so a keystroke after it is refused as stale rather than landing on moved text. */
async function postRev(eng) {
  const rev = Number(await eng.rev());
  if (!Number.isInteger(rev)) fail('failed', "the post's revision could not be read");
  return rev;
}

/** The post's state now → {rev, doc, pending, paras, map, reverse, paired}: the engine's revision, its paragraphs
 * (text.paragraphs), the saved doc (save('post')), `map` from a post path to its first engine paragraph path, `reverse` back
 * (with the line offset) and `paired`, the engine paragraphs the post's blocks account for (the rest is the reader's typing
 * room). `keep` keeps it as the outline of that revision. */
async function postStateOf(eng, keep = true) {
  posts.add(eng);
  const rev = await postRev(eng);
  const text = decoder.decode(await eng.save('post'));
  const saved = JSON.parse(text);
  const v = await query(eng, 'text.paragraphs');
  const paras = v.map((p, i) => ({ path: p.path, style: 'Normal', text: p.text, i }));
  const map = new Map();
  const reverse = new Map();
  const paired = new Set();
  let j = 0;
  for (const leaf of postLeaves(saved.doc)) {
    let k = j;
    while (k < paras.length && paras[k].text !== leaf.text) k++;
    if (k >= paras.length) break; // the texts stop lining up (a hint or an unsupported block): address what matched
    if (leaf.first) map.set(keyOf(leaf.path), paras[k].path);
    reverse.set(keyOf(paras[k].path), { path: leaf.path, off: leaf.off });
    paired.add(k);
    j = k + 1;
  }
  const o = { rev, paras, byPara: new Map(), byPath: new Map(paras.map((p) => [keyOf(p.path), p])) };
  Object.assign(o, { doc: saved.doc, pending: saved.pending, map, reverse, paired });
  if (keep) remember(eng, o);
  return o;
}

/** The engine range of post blocks `path` (a textblock or a whole block) → {first, last, next}: its first leaf's engine path,
 * its last leaf's, and the leaf after it (null at the end). */
function postRange(st, path) {
  const all = postLeaves(st.doc);
  const leaves = all.filter((l) => startsWith(l.path, path));
  if (!leaves.length) fail('not_found', `No block at [${path}]`, { path });
  const engine = (leaf) => st.map.get(keyOf(leaf.path)) ?? [];
  const last = leaves.at(-1);
  const i = all.indexOf(last);
  return { first: engine(leaves[0]), text: last.text, last: engine(last), next: i >= 0 && all[i + 1] ? engine(all[i + 1]) : null };
}

/** The selection at engine path `path`, byte offsets `from`..`to`. */
const at = (path, from = 0, to = from) => ['select.range', { anchor: { story: 'body', path, off: from }, focus: { story: 'body', path, off: to } }];

/** The steps that put the caret after the post's last block: the reader's typing room after a container or a table, else a
 * new paragraph after the last one. */
function endSteps(st) {
  const last = st.paras.at(-1);
  if (!last) return [['caret.docStart']];
  return st.paired.has(st.paras.length - 1) ? [['caret.docEnd'], ['text.newParagraph']] : [['caret.docEnd']];
}

/** The steps that put the caret at the start of engine path `path`, with an empty paragraph to take the paste: the DOM
 * editor's `before` (its split, which keeps the paragraph after it as it is). */
const beforeSteps = (path) => [at(path, 0), ['text.newParagraph'], ['caret.left']];

/** doc.get on a post: the post kit's JSON, the forum's HTML, the engine's Markdown and text, and the top-level blocks. */
async function postGet(c, a) {
  const st = await postStateOf(c.eng);
  const base = { rev: st.rev, draftId: c.draftId, canvas: true };
  if (a.format === 'outline') return { ...base, content: blockOutline(st.doc, { depth: 1 }) };
  if (a.format === 'json') {
    const node = a.path ? nodeAt(st.doc, a.path) : st.doc;
    if (!node) fail('not_found', `No block at [${a.path}]`, { path: a.path });
    return { ...base, content: a.images ? node : c.stripImages(node) };
  }
  if (a.format === 'html') {
    const node = a.path ? nodeAt(st.doc, a.path) : st.doc;
    if (!node) fail('not_found', `No block at [${a.path}]`, { path: a.path });
    const html = renderPost(node);
    return { ...base, content: a.images ? html : c.shortImages(html) };
  }
  if (a.path) fail('invalid_args', 'A post\'s Markdown and text are the whole post', { path: '/path', message: 'does not apply', expected: {} });
  if (a.format === 'markdown') return { ...base, content: decoder.decode(await c.eng.save('md')), loses: POST_LOSS };
  return { ...base, content: decoder.decode(await c.eng.save('txt')) };
}

/** doc.selection on a post: the engine's selection with the post's paths and UTF-16 offsets. */
async function postSelection(c) {
  const st = await postStateOf(c.eng);
  const s = await query(c.eng, 'document.selection');
  const [a, b] = await Promise.all([c.eng.locate(s.anchor), c.eng.locate(s.focus)]);
  if (!a || !b) return { kind: 'none' };
  const end = (pos, loc) => {
    const r = st.reverse.get(keyOf(pos.path));
    if (!r) return null;
    const para = st.paras.find((p) => keyOf(p.path) === keyOf(pos.path));
    return { path: r.path, off: (r.off ?? 0) + (loc.offset ?? 0), text: para?.text ?? '' };
  };
  const x = end(s.anchor, a);
  const y = end(s.focus, b);
  if (!x || !y) return { kind: 'none' };
  // The anchor is the selection's start (the engine keeps the focus at the end of a drag).
  const [p, q] = [x, y];
  return {
    kind: 'text', path: p.path, from: p.off, to: q.off, text: String(s.text ?? '').slice(0, 4000),
    context: String(p.text).slice(Math.max(0, p.off - CONTEXT), (keyOf(p.path) === keyOf(q.path) ? q.off : p.text.length) + CONTEXT),
    ...(keyOf(p.path) !== keyOf(q.path) && { toPath: q.path }), rev: st.rev,
  };
}

/** The engine position of UTF-16 offset `u` in the text of post block `path` → {path, off (bytes)}. */
function postPos(st, path, u) {
  let left = u;
  for (const leaf of postLeaves(st.doc).filter((l) => startsWith(l.path, path))) {
    if (left <= leaf.text.length) {
      const engine = st.map.get(keyOf(leaf.path));
      if (engine) return { path: engine, off: bytes(leaf.text, left) };
      break;
    }
    left -= leaf.text.length + 1; // a code block's line break
  }
  const r = postRange(st, path);
  return { path: r.last, off: bytes(r.text, r.text.length) };
}

const pos = (p) => ({ story: 'body', path: p.path, off: p.off });

/** The post blocks a write addresses: `path`'s textblock (doc.format and doc.edit need one) and its engine range. */
function postText(st, path) {
  const node = nodeAt(st.doc, path);
  if (!node) fail('not_found', `No block at [${path}]`, { path });
  if (!TEXTBLOCK.has(node.type)) fail('refused', `The block at [${path}] is a ${node.type}, not text`, { code: 'not_text' });
  const r = postRange(st, path);
  if (!r.first.length) fail('not_found', `The block at [${path}] is not in the engine`, { path });
  return { node, ...r };
}

/** The post's write target at ifRev: the block `path` names now, refused as stale when the revision it was read at no longer
 * holds it unchanged. (A post has no engine revision, so execAs's ifRev check is not the one that runs: this is.) */
function postCheck(c, st, path) {
  if (c.ifRev === undefined || c.ifRev === st.rev) return;
  const then = revsOf(c.eng)?.get(c.ifRev);
  if (!then) fail('stale', `The post changed since rev ${c.ifRev}; read it again`, { rev: st.rev });
  const before = nodeAt(then.doc, path);
  if (!before || JSON.stringify(before) !== JSON.stringify(nodeAt(st.doc, path))) {
    fail('stale', `The block at [${path}] changed since rev ${c.ifRev}; read it again`, { rev: st.rev, path });
  }
}

/** doc.insert on a post: content (c.postContent's post kit's JSON) at the caret, the start or end, or a block's place. The
 * paste takes the paragraph at the caret, so the content goes in the empty paragraph a split leaves at the boundary. */
async function postInsert(c, a) {
  const st = await postStateOf(c.eng);
  const put = await c.postContent(a.content);
  const one = contentNodes(put.json);
  let steps;
  if (a.at === 'cursor') steps = [];
  else if (a.at === 'start') steps = beforeSteps(st.paras[0]?.path ?? [0]);
  else if (a.at === 'end') steps = endSteps(st);
  else {
    const p = postRange(st, a.at);
    postCheck(c, st, a.at);
    // A block with no text (a rule, an empty paragraph) takes the paste itself: Enter at its start does not split it, and the
    // split would leave an empty paragraph after the new content.
    const empty = !nodeText(nodeAt(st.doc, a.at) ?? {}).length;
    if (a.position === 'before') steps = empty ? [at(p.first, 0)] : beforeSteps(p.first);
    else steps = p.next ? beforeSteps(p.next) : endSteps(st);
  }
  steps.push(['post.insert', { json: put.json }]);
  // The paragraph the paste lands in kept its own properties: a single heading (or paragraph) takes its own kind back.
  if (one.length === 1) steps.push(...blockSteps(one[0]));
  return { rev: st.rev, steps, result: { inserted: one.length, ...(put.dropped?.length && { dropped: put.dropped }) } };
}

/** doc.format on a post: post.mark for the marks, post.block for the paragraph or heading, para.align for the alignment. */
async function postFormat(c, a) {
  const st = await postStateOf(c.eng);
  postCheck(c, st, a.path);
  const p = postText(st, a.path);
  const text = nodeText(p.node);
  const from = a.from ?? 0;
  const to = a.to ?? text.length;
  if (to > text.length || from > to) {
    fail('invalid_args', `from / to must keep 0 <= from <= to <= ${text.length} (the block's length)`, { path: to > text.length ? '/to' : '/from', message: 'is outside the block', expected: { type: 'integer', minimum: 0, maximum: text.length } });
  }
  if (a.run || a.paragraph) fail('refused', 'A forum post takes its own formatting, not a document\'s run and paragraph properties', { code: 'cannot_apply' });
  if (a.block?.type === 'heading' && !a.block.level) {
    fail('invalid_args', 'A heading needs its level', { path: '/block/level', message: 'is required for a heading', expected: { type: 'integer', minimum: 1, maximum: 6 } });
  }
  const steps = [['select.range', { anchor: pos(postPos(st, a.path, from)), focus: pos(postPos(st, a.path, to)) }]];
  for (const [k, v] of Object.entries(a.marks ?? {})) steps.push(...markSteps(k, v));
  const preset = a.presetId && c.presets?.find((x) => x.id === a.presetId);
  if (a.presetId && !preset) fail('not_found', `No font preset has the id ${a.presetId}`);
  if (preset) steps.push(...presetSteps(preset));
  if (a.block) steps.push(...blockSteps(a.block));
  if (!a.marks && !a.presetId && !a.block) fail('refused', 'That formatting does not apply here', { code: 'cannot_apply' });
  return { rev: st.rev, steps, result: { path: a.path, from, to } };
}

/** A doc.format mark as post.mark's steps (null takes the mark off). */
function markSteps(k, v) {
  if (k === 'link') return [v ? ['insert.link', { url: href(v) }] : ['insert.removeLink']];
  if (k === 'fontSize') return [['post.mark', { size: v }]];
  if (k === 'textColor') return [['post.mark', { color: v && v !== 'root' ? v : null }]];
  if (k === 'highlight') return [['post.mark', { highlight: v || null }]];
  if (k === 'fontFamily') return [['post.mark', { font: v || null }]];
  return [['post.mark', v ? { mark: k, on: true } : { mark: k, on: false }]];
}

/** A font preset (format.mjs presetChain) as post.mark's steps (rows/post.mjs `preset`). */
function presetSteps(p) {
  const out = [['post.mark', { font: null }], ['post.mark', { size: null }], ['post.mark', { color: null }],
    ['post.mark', { highlight: null }], ['post.mark', { mark: 'bold', on: false }], ['post.mark', { mark: 'italic', on: false }],
    ['post.mark', { mark: 'underline', on: false }]];
  if (p.fontFamily) out.push(['post.mark', { font: p.fontFamily }]);
  if (p.size && Number(p.size) !== 100) out.push(['post.mark', { size: Number(p.size) }]);
  if (p.color && p.color !== 'root') out.push(['post.mark', { color: p.color }]);
  if (p.highlight) out.push(['post.mark', { highlight: p.highlight }]);
  for (const name of ['bold', 'italic', 'underline']) if (p[name]) out.push(['post.mark', { mark: name, on: true }]);
  return out;
}

/** A paragraph, heading or alignment as the post's steps. */
function blockSteps(block) {
  const out = [];
  if (block.type === 'paragraph') out.push(['post.block', { kind: 'p' }]);
  if (block.type === 'heading') out.push(['post.block', { kind: `h${block.level ?? block.attrs?.level ?? 1}` }]);
  if (block.align) out.push(['para.align', { value: block.align }]);
  return out;
}

/** doc.replace's content as block nodes. */
const contentNodes = (json) => (Array.isArray(json) ? json : (json?.content ?? (json ? [json] : [])));

/** The post command each editor command runs (doc.command); the rest fall through to the document steps, which a post
 * refuses when they are not in its allow list. */
const POST_COMMANDS = {
  toggleBold: () => [['post.mark', { mark: 'bold' }]], setBold: () => [['post.mark', { mark: 'bold', on: true }]],
  unsetBold: () => [['post.mark', { mark: 'bold', on: false }]],
  toggleItalic: () => [['post.mark', { mark: 'italic' }]], setItalic: () => [['post.mark', { mark: 'italic', on: true }]],
  unsetItalic: () => [['post.mark', { mark: 'italic', on: false }]],
  toggleUnderline: () => [['post.mark', { mark: 'underline' }]], setUnderline: () => [['post.mark', { mark: 'underline', on: true }]],
  unsetUnderline: () => [['post.mark', { mark: 'underline', on: false }]],
  toggleStrike: () => [['post.mark', { mark: 'strike' }]], setStrike: () => [['post.mark', { mark: 'strike', on: true }]],
  unsetStrike: () => [['post.mark', { mark: 'strike', on: false }]],
  toggleSubscript: () => [['post.mark', { mark: 'subscript' }]], setSubscript: () => [['post.mark', { mark: 'subscript', on: true }]],
  unsetSubscript: () => [['post.mark', { mark: 'subscript', on: false }]],
  toggleSuperscript: () => [['post.mark', { mark: 'superscript' }]], setSuperscript: () => [['post.mark', { mark: 'superscript', on: true }]],
  unsetSuperscript: () => [['post.mark', { mark: 'superscript', on: false }]],
  toggleCode: () => [['post.mark', { mark: 'code' }]], setCode: () => [['post.mark', { mark: 'code', on: true }]],
  unsetCode: () => [['post.mark', { mark: 'code', on: false }]],
  setLink: (o) => [['insert.link', { url: href(o?.href ?? '') }]], unsetLink: () => [['insert.removeLink']],
  setTextAlign: (v) => [['para.align', { value: v }]],
  setParagraph: () => [['post.block', { kind: 'p' }]], setHeading: (o) => [['post.block', { kind: `h${o?.level ?? 1}` }]],
  toggleBulletList: () => [['post.list', { kind: 'bullet' }]], toggleOrderedList: () => [['post.list', { kind: 'ordered' }]],
  toggleBlockquote: () => [['post.toggle', { kind: 'quote' }]], toggleCodeBlock: () => [['post.toggle', { kind: 'code' }]],
  insertBox: () => [['post.toggle', { kind: 'box' }]], setHorizontalRule: () => [['post.rule']],
  unsetAllMarks: () => [['post.clear']], clearNodes: () => [['post.block', { kind: 'p' }]],
  setFontSize: (v) => [['post.mark', { size: v }]], unsetFontSize: () => [['post.mark', { size: null }]],
  setTextColor: (v) => [['post.mark', { color: v && v !== 'root' ? v : null }]], unsetTextColor: () => [['post.mark', { color: null }]],
  setHighlight: (v) => [['post.mark', { highlight: v || null }]], unsetHighlight: () => [['post.mark', { highlight: null }]],
  setFontFamily: (v) => [['post.mark', { font: v || null }]], unsetFontFamily: () => [['post.mark', { font: null }]],
};

/** doc.delete on a post: each block's range to the next block's start, else its own end, as text.delete. */
async function postDelete(c, a) {
  const st = await postStateOf(c.eng);
  const steps = [];
  const done = new Set();
  for (const path of a.paths) {
    const key = keyOf(path);
    if (done.has(key)) continue;
    done.add(key);
    postCheck(c, st, path);
    const r = postRange(st, path);
    const end = r.next ? { path: r.next, off: 0 } : { path: r.last, off: bytes(r.text, r.text.length) };
    const sel = ['select.range', { anchor: { story: 'body', path: r.first, off: 0 }, focus: { story: 'body', ...end } }];
    // A whole list deleted keeps one empty item in the accepted view (its first paragraph mark is the merge anchor): the
    // list goes off first, as the toolbar's list button does.
    const kind = { bulletList: 'bullet', orderedList: 'ordered' }[nodeAt(st.doc, path)?.type];
    steps.unshift(...(kind ? [sel, ['post.list', { kind }], ['text.delete']] : [sel, ['text.delete']])); // last first, so earlier paths hold
  }
  return { rev: st.rev, steps, result: { deleted: done.size } };
}

/** doc.edit on a post: the block's text range, as text.insert or text.delete. */
async function postEdit(c, a) {
  const st = await postStateOf(c.eng);
  postCheck(c, st, a.path);
  const p = postText(st, a.path);
  const text = nodeText(p.node);
  if (a.to > text.length || a.from > a.to) {
    fail('invalid_args', `from / to must keep 0 <= from <= to <= ${text.length} (the block's length)`, { path: a.to > text.length ? '/to' : '/from', message: 'is outside the block', expected: { type: 'integer', minimum: 0, maximum: text.length } });
  }
  const steps = [['select.range', { anchor: pos(postPos(st, a.path, a.from)), focus: pos(postPos(st, a.path, a.to)) }], a.text ? ['text.insert', { text: a.text }] : ['text.delete']];
  return { rev: st.rev, steps: a.from === a.to && !a.text ? [] : steps, result: { path: a.path, from: a.from, to: a.from + a.text.length } };
}

/** doc.replace on a post: the textblock's text replaced by post.insert's blocks (its paragraph mark stays, so a tracked
 * replace accepts cleanly), then a single block's kind put back (post.block). */
async function postReplace(c, a) {
  const st = await postStateOf(c.eng);
  postCheck(c, st, a.path);
  const put = await c.postContent(a.content);
  const p = postText(st, a.path);
  const steps = [['select.range', { anchor: { story: 'body', path: p.first, off: 0 }, focus: { story: 'body', path: p.last, off: bytes(p.text, p.text.length) } }], ['post.insert', { json: put.json }]];
  const one = contentNodes(put.json);
  if (one.length === 1) steps.push(...blockSteps(one[0]));
  return { rev: st.rev, steps, result: { path: a.path, paths: [a.path], ...(put.dropped?.length && { dropped: put.dropped }) } };
}

// ---------------------------------------------------------------------------------------------
// Reads

async function docGet(c, a) {
  if (isPost(c)) return postGet(c, a);
  const o = await outlineOf(c.eng);
  const ps = a.path ? target(c, o, a.path) : o.paras;
  const base = { rev: o.rev, draftId: c.draftId, canvas: true };
  if (a.format === 'outline') return { ...base, content: ps.map(entry) };
  if (a.format === 'text') {
    return { ...base, content: a.path ? ps.map((p) => plain(p.text)).join('\n') : (await query(c.eng, 'document.text')).text };
  }
  const { html } = await query(c.eng, 'document.html', { para: ps[0].para, toPara: ps.at(-1).para });
  if (a.format === 'html') return { ...base, content: a.images ? html : c.shortImages(html) };
  const blocks = await c.fromHtml(html, a.images);
  return { ...base, content: a.format === 'markdown' ? c.markdownOf(blocks) : blocks, loses: HTML_LOSS };
}

async function docFind(c, a) {
  if (isPost(c)) return findBlocks((await postStateOf(c.eng)).doc, { text: a.text, regex: !!a.regex, caseSensitive: !!a.caseSensitive });
  const o = await outlineOf(c.eng);
  const r = await query(c.eng, 'document.find', { text: a.text, matchCase: !!a.caseSensitive, regex: !!a.regex });
  // The user typed between the two reads: the offsets would not fit the outline.
  if (r.rev !== o.rev) fail('stale', 'The draft changed while it was searched; search again', { rev: r.rev });
  return r.matches.flatMap((m) => {
    const p = o.byPara.get(String(m.para));
    if (!p) return [];
    const to = o.byPara.get(String(m.toPara ?? m.para));
    return [{ path: p.path, from: m.from, to: m.to, ...(to !== p && { toPath: to.path }),
      context: plain(p.text.slice(Math.max(0, m.from - CONTEXT), (to === p ? m.to : p.text.length) + CONTEXT)) }];
  });
}

async function docSelection(c) {
  if (isPost(c)) return postSelection(c);
  const o = await outlineOf(c.eng);
  const s = await query(c.eng, 'document.selection');
  const [a, b] = await Promise.all([located(c, o, s.anchor), located(c, o, s.focus)]);
  if (!a || !b) return { kind: 'none' };
  const [x, y] = a.p.i < b.p.i || (a.p === b.p && a.off <= b.off) ? [a, b] : [b, a];
  const text = x.p.text;
  return {
    kind: 'text', path: x.p.path, from: x.off, to: y.off, text: String(s.text ?? '').slice(0, 4000),
    context: plain(text.slice(Math.max(0, x.off - CONTEXT), (x.p === y.p ? y.off : text.length) + CONTEXT)),
    ...(x.p !== y.p && { toPath: y.p.path }), rev: o.rev,
  };
}

async function historyState(c) {
  const [h, o] = await Promise.all([query(c.eng, 'edit.undoHistory'), outlineOf(c.eng)]);
  // ponytail: the engine names only the top redo step, so redoDepth is 0 or 1; count them when an agent needs the depth.
  return { undoDepth: h.depth ?? 0, redoDepth: h.redo ? 1 : 0, rev: o.rev };
}

/** history.undo and history.redo (`id` edit.undo or edit.redo): up to a.steps steps, as the user's Undo (a step line's Undo). */
async function walk(c, a, id) {
  let n = 0;
  while (n < a.steps && (await c.eng.exec(id))?.changed) n++;
  const h = await query(c.eng, 'edit.undoHistory');
  return { [id === 'edit.undo' ? 'undone' : 'redone']: n, undoDepth: h.depth ?? 0, redoDepth: h.redo ? 1 : 0 };
}

// ---------------------------------------------------------------------------------------------
// Writes: each returns {rev (the read the steps were built on), steps, result (a value, or (after, before) → it, once the
// outline after the call is read)}

/** The steps that put `html` after paragraph `x`: a new paragraph at its end, the paste (behind the sentinel, so the first pasted
 * paragraph keeps its style), then x's new mark and the sentinel go again, so x keeps its own properties. */
const after = (x, html) => [['select.at', { para: x.para, from: x.text.length }], ['text.newParagraph'], ['edit.paste', { html: SENTINEL + html }],
  ['select.at', { para: x.para, from: x.text.length }], ['text.delete'], ['text.delete']];

/** The style a pasted fragment's first paragraph has, for a paste that cannot keep its own (before the first paragraph). */
function firstStyle(html) {
  const tag = /<(h[1-6]|p|li|blockquote|pre|table)\b/i.exec(html)?.[1].toLowerCase();
  return tag?.[0] === 'h' && tag.length === 2 ? `Heading ${tag[1]}` : tag === 'blockquote' ? 'Quote' : 'Normal';
}

/** The steps that put `html` before paragraph `p`: after the paragraph before it, else (the first in its container) in a new
 * paragraph split off p's start. That one keeps p's id, so p's text gets a new id: `shifted` names it for the result.
 * ponytail: rejected, content of two or more paragraphs before the first one leaves an empty paragraph, because the engine's paste
 * gives its last paragraph an untracked mark; a paste that keeps the mark it lands on would fix it. */
function before(o, p, html) {
  const q = sibling(o, [p], -1);
  if (q) return { steps: after(q, html) };
  return { steps: [['select.at', { para: p.para, from: 0 }], ['text.newParagraph'], ['caret.left'], ['para.style', { style: firstStyle(html) }],
    ['edit.paste', { html }]], shifted: p.para };
}

/** The steps that delete paragraphs `ps` (consecutive, at one level): from the first's start to the next one's, else from the
 * paragraph before's end, else their text alone (a container keeps one paragraph). */
function deletion(o, ps) {
  const [first, last] = [ps[0], ps.at(-1)];
  const n = sibling(o, ps, 1);
  if (n) return [['select.at', { para: first.para, from: 0, toPara: n.para, to: 0 }], ['text.delete']];
  const q = sibling(o, ps, -1);
  if (q) return [['select.at', { para: q.para, from: q.text.length, toPara: last.para }], ['text.delete']];
  return [['select.at', { para: first.para, from: 0, toPara: last.para }], ['text.delete']];
}

/** The paths of the paragraphs outline `now` has and `old` did not. With `shifted`, a paragraph whose id moved to the new content:
 * that one counts, and the paragraph its old text moved to does not. */
function added(now, old, shifted = null) {
  const moved = shifted && old.byPara.get(shifted).text;
  return now.paras.filter((p) => (p.para === shifted || !old.byPara.has(p.para)) && !(moved != null && p.para !== shifted && p.text === moved)).map((p) => p.path);
}

/** doc.insert's and doc.replace's content as steps that put it at a caret in an empty paragraph: HTML to paste, or pictures. */
async function contentOf(c, content) {
  if (content.images) {
    return {
      pictures: content.images.map(({ dataUrl, w, alt }) => ['insert.picture', { data: String(dataUrl).replace(/^data:[^,]*,/, ''),
        ...(w && { width: w * 0.75 }), ...(alt && { alt }) }]),
      dropped: [],
    };
  }
  return c.html(content);
}

/** The steps that put `content` (contentOf) after paragraph `x`, or before paragraph `p`. */
function placed(o, put, { x = null, p = null }) {
  if (put.pictures) {
    const at = x ?? sibling(o, [p], -1);
    // ponytail: pictures before the first paragraph go after it; split it as before() does when an agent needs that.
    const anchor = at ?? p;
    return { steps: [['select.at', { para: anchor.para, from: anchor.text.length }], ...put.pictures.flatMap((pic) => [['text.newParagraph'], pic])] };
  }
  return x ? { steps: after(x, put.html) } : before(o, p, put.html);
}

/** The paragraph of the user's selection, for at: 'cursor' (its focus end). */
async function caretParagraph(c, o) {
  const s = await query(c.eng, 'document.selection');
  const at = await located(c, o, s.focus);
  if (!at) fail('refused', 'The selection is not in the main text', { code: 'not_text', hint: 'Give at as a path' });
  return at.p;
}

async function docInsert(c, a) {
  if (isPost(c)) return postInsert(c, a);
  const o = await outlineOf(c.eng, false);
  const lost = c.noteMarkers(a.content.markdown).map((marker) => ({ kind: 'note', marker }));
  guardLoss(lost, a, 'Pass allowLoss: true to keep the markers as plain text');
  const put = await contentOf(c, a.content);
  let where;
  if (a.at === 'start') where = { p: o.paras[0] };
  else if (a.at === 'end') where = { x: o.paras.findLast((p) => p.path.length === 1) ?? o.paras.at(-1) };
  else if (a.at === 'cursor') where = { x: await caretParagraph(c, o) };
  else {
    const [p] = target(c, o, a.at, true);
    where = a.position === 'before' ? { p } : { x: p };
  }
  const { steps, shifted } = placed(o, put, where);
  return { rev: o.rev, steps, result: (now) => ({ paths: added(now, o, shifted), ...(put.dropped?.length && { dropped: put.dropped }), ...(lost.length && { lost }) }) };
}

// What a rewrite of a paragraph would lose: its inline objects of these kinds, and its revisions (docs/plans/word/plan.md §1.8).
const HOLDS = {
  field: 'field', fieldStart: 'field', noteRef: 'note', bookmarkStart: 'bookmark', commentStart: 'comment', controlStart: 'contentControl',
};

/** What paragraph `p` (an outline entry) holds that a rewrite of its text range [from, to) would lose → [{kind, ...}]. */
async function holdings(c, p, from = 0, to = p.text.length) {
  const out = [];
  const { paragraph } = await query(c.eng, 'document.paragraph', { path: p.path });
  // The k-th U+FFFC of the text is the k-th object.
  let k = 0;
  for (let i = 0; i < p.text.length; i++) {
    if (p.text[i] !== OBJ) continue;
    const o = paragraph.objects?.[k++];
    const kind = HOLDS[o?.type];
    if (kind && i >= from && i < to) out.push({ kind, ...(o.name && { name: o.name }), ...(o.id !== undefined && { id: o.id }) });
  }
  if (from === 0 && to === p.text.length) for (const rev of p.revs ?? []) out.push({ kind: 'revision', id: rev });
  return out;
}

/** Refuses a change that loses `lost` unless the caller allowed it (doc.mjs guardLoss's words). */
function guardLoss(lost, a, hint = 'For a few words use doc_edit, which keeps them, or pass allowLoss: true to drop them') {
  if (!lost.length || a.allowLoss) return;
  const kinds = [...new Set(lost.map((l) => l.kind))].join(', ');
  fail('refused', `The new content would lose what the block holds (${kinds})`, { code: 'content_lost', lost, hint });
}

async function docReplace(c, a) {
  if (isPost(c)) return postReplace(c, a);
  const o = await outlineOf(c.eng, false);
  const [p] = target(c, o, a.path, true);
  const lost = await holdings(c, p);
  guardLoss(lost, a);
  const put = await contentOf(c, a.content);
  // The new content goes before p, then p goes: deleting p's text and mark keeps the paragraph after it as it is. The first
  // paragraph of its container has none before it: the content goes after it and p's mark joins the first new paragraph, which
  // then takes p's paragraph properties.
  const q = sibling(o, [p], -1);
  const steps = q ? [...placed(o, put, { x: q }).steps, ...deletion(o, [p])]
    : [...placed(o, put, { x: p }).steps, ['select.at', { para: p.para }], ['select.paragraph'], ['text.delete']];
  return { rev: o.rev, steps, result: (now) => ({ path: a.path, paths: added(now, o), ...(put.dropped?.length && { dropped: put.dropped }), ...(lost.length && { lost }) }) };
}

/** doc.edit's and doc.format's range in paragraph `p`: a.from..a.to, the whole paragraph by default. */
function range(p, a) {
  const from = a.from ?? 0;
  const to = a.to ?? p.text.length;
  if (to > p.text.length || from > to) {
    fail('invalid_args', `from / to must keep 0 <= from <= to <= ${p.text.length} (the block's length)`,
      { path: to > p.text.length ? '/to' : '/from', message: 'is outside the block', expected: { type: 'integer', minimum: 0, maximum: p.text.length } });
  }
  return { from, to };
}

async function docEdit(c, a) {
  if (isPost(c)) return postEdit(c, a);
  const o = await outlineOf(c.eng, false);
  const [p] = target(c, o, a.path, true);
  const { from, to } = range(p, a);
  guardLoss(await holdings(c, p, from, to), a, 'Leave them out of from and to, or rewrite the block with doc_replace');
  const steps = [['select.at', { para: p.para, from, to }], a.text ? ['text.insert', { text: a.text }] : ['text.delete']];
  return { rev: o.rev, steps: from === to && !a.text ? [] : steps, result: { path: a.path, from, to: from + a.text.length } };
}

async function docDelete(c, a) {
  if (isPost(c)) return postDelete(c, a);
  const o = await outlineOf(c.eng, false);
  // A path given twice, or inside another one given, deletes once; the last first.
  const runs = new Map();
  for (const path of a.paths) {
    const ps = target(c, o, path);
    runs.set(ps[0].para, ps);
  }
  const all = [...runs.values()];
  const kept = all.filter((ps) => !all.some((x) => x !== ps && x[0].i <= ps[0].i && ps.at(-1).i <= x.at(-1).i));
  const steps = kept.sort((x, y) => y[0].i - x[0].i).flatMap((ps) => deletion(o, ps));
  return { rev: o.rev, steps, result: { deleted: kept.length } };
}

// doc.format's boolean marks → the engine's character commands (`value` sets, never toggles).
const MARK_CMDS = { bold: 'format.bold', italic: 'format.italic', underline: 'format.underline', strike: 'format.strikethrough', sub: 'format.subscript', sup: 'format.superscript' };
const hex = (c) => String(c).replace(/^#/, '').toUpperCase();
const href = (v) => (/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
const cannot = (what) => fail('refused', `${what} does not apply here`, { code: 'cannot_apply' });

/** doc.format's run (office.mjs RUN_ARGS) as engine steps. A theme colour is the colour it shows (`resolve`). */
function runSteps(run, resolve) {
  const out = [];
  if ('font' in run && run.font) out.push(['format.font', { name: run.font }]);
  if ('sizePt' in run && run.sizePt) out.push(['format.size', { size: Math.round(run.sizePt * 2) / 2 }]);
  if ('color' in run) {
    const col = run.color;
    out.push(['format.color', { color: col == null ? 'auto' : hex(typeof col === 'object' ? resolve({ slot: col.theme, lum: col.lum ?? 0 }) : col) }]);
  }
  if ('highlight' in run) out.push(['format.highlight', { color: run.highlight ?? 'none' }]);
  if (run.underline === 'none') out.push(['format.underline', { value: false }]);
  else if (run.underline) out.push(['format.underline', { value: true, style: run.underline }]);
  return out;
}

/** doc.format's paragraph (office.mjs PARA_ARGS) as engine steps. */
function paraSteps(p) {
  const out = [];
  if (p.style) out.push(['para.style', { style: p.style }]);
  const spacing = { ...('spaceBeforePt' in p && { before: p.spaceBeforePt }), ...('spaceAfterPt' in p && { after: p.spaceAfterPt }) };
  if (Object.keys(spacing).length) out.push(['para.spacing', spacing]);
  const l = p.lineSpacing;
  if (l) out.push(['para.lineSpacing', l.multiple != null ? { value: l.multiple } : l.exactPt != null ? { exactly: l.exactPt } : { atLeast: l.atLeastPt }]);
  const i = p.indent;
  if (i) out.push(['para.indents', { ...('leftPt' in i && { left: i.leftPt }), ...('rightPt' in i && { right: i.rightPt }), ...('firstLinePt' in i && { firstLine: i.firstLinePt }) }]);
  if (p.list) {
    const { kind, level = 0 } = p.list;
    if (!kind) out.push(['para.numbering', { off: true }]);
    else out.push(kind === 'bullet' ? ['para.bullets', { kind: 'bullet' }] : ['para.numbering', { kind: 'numbered' }], ['para.listLevel', { level }]);
  }
  return out;
}

async function docFormat(c, a) {
  if (isPost(c)) return postFormat(c, a);
  const o = await outlineOf(c.eng, false);
  const [p] = target(c, o, a.path, true);
  const { from, to } = range(p, a);
  if (a.block?.type === 'heading' && !a.block.level) {
    fail('invalid_args', 'A heading needs its level', { path: '/block/level', message: 'is required for a heading', expected: { type: 'integer', minimum: 1, maximum: 6 } });
  }
  const steps = [];
  for (const [k, v] of Object.entries(a.marks ?? {})) {
    if (MARK_CMDS[k]) steps.push([MARK_CMDS[k], { value: !!v }]);
    else if (k === 'link') steps.push(v ? ['insert.link', { url: href(v) }] : ['insert.removeLink']);
    else cannot(`The ${k} mark`);
  }
  if (a.run) steps.push(...runSteps(a.run, (link) => resolveColor(THEME, link)));
  if (a.paragraph) steps.push(...paraSteps(a.paragraph));
  if (a.block?.type === 'paragraph') steps.push(['para.style', { style: 'Normal' }]);
  if (a.block?.type === 'heading') steps.push(['para.style', { style: `Heading ${a.block.level}` }]);
  if (a.block?.align) steps.push(['para.align', { value: a.block.align }]);
  if (!steps.length) cannot('That formatting');
  return { rev: o.rev, steps: [['select.at', { para: p.para, from, to }], ...steps], result: { path: a.path, from, to } };
}

// doc.command's editor commands → engine steps on the user's selection. Selection commands take ProseMirror positions, which mean
// nothing to the engine.
const MARK_NAMES = { Bold: 'format.bold', Italic: 'format.italic', Underline: 'format.underline', Strike: 'format.strikethrough', Subscript: 'format.subscript',
  Superscript: 'format.superscript' };
const COMMAND_STEPS = {
  ...Object.fromEntries(Object.entries(MARK_NAMES).flatMap(([m, id]) => [[`toggle${m}`, () => [[id]]], [`set${m}`, () => [[id, { value: true }]]],
    [`unset${m}`, () => [[id, { value: false }]]]])),
  setLink: (o) => [['insert.link', { url: href(o?.href ?? '') }]],
  unsetLink: () => [['insert.removeLink']],
  setTextAlign: (v) => [['para.align', { value: v }]],
  setParagraph: () => [['para.style', { style: 'Normal' }]],
  setHeading: (o) => [['para.style', { style: `Heading ${o?.level ?? 1}` }]],
  toggleBulletList: () => [['para.bullets']],
  toggleOrderedList: () => [['para.numbering']],
  insertTable: (o) => [['insert.table', { rows: o?.rows ?? 3, cols: o?.cols ?? 3 }]],
  addRowBefore: () => [['table.insertRowAbove']],
  addRowAfter: () => [['table.insertRowBelow']],
  addColumnBefore: () => [['table.insertColumnLeft']],
  addColumnAfter: () => [['table.insertColumnRight']],
  deleteRow: () => [['table.deleteRow']],
  deleteColumn: () => [['table.deleteColumn']],
  unsetAllMarks: () => [['format.resetChar']],
  clearNodes: () => [['para.normal']],
  setStyle: (name) => [['para.style', { style: name }]],
  increaseIndent: () => [['para.indent']],
  decreaseIndent: () => [['para.outdent']],
  applyList: (kind) => [kind === 'bullet' ? ['para.bullets'] : ['para.numbering', { kind: { lowerRoman: 'lowerRoman', upperLetter: 'upperLetter', lowerLetter: 'lowerLetter' }[kind] ?? 'numbered' }]],
  setPageBreak: () => [['insert.pageBreak']],
  mergeCells: () => [['table.merge']],
  splitCell: () => [['table.split']],
  toggleHeaderRow: () => [['table.repeatHeader']],
  setCellAttribute: (k, v) => [k === 'shading' ? ['table.shading', { color: v ? hex(v) : 'auto' }] : ['table.cellAlign', { value: `${v ?? 'top'}Left` }]],
  setAltText: (text) => [['picture.altText', { text }]],
};

async function docCommand(c, a) {
  // A post's own commands act on the selection as the toolbar does (C5); the rest fall through to the document steps, which
  // the engine refuses when the post's allow list does not grant them.
  const post = isPost(c);
  if (post) posts.add(c.eng); // commit reads its outline from the post's state
  const make = (post && POST_COMMANDS[a.name]) || COMMAND_STEPS[a.name];
  if (!make) {
    fail('refused', `${a.name} does not work on a canvas engine draft`, {
      code: 'cannot_apply', hint: /Selection$/.test(a.name) ? 'Give the place to doc_format, doc_edit or doc_insert as a path' : 'Use doc_format or doc_insert',
    });
  }
  // A post's revision is the engine's (postRev), as a document's comes from document.outline: the read's ifRev is checked
  // here, and execAs checks it again, so a keystroke between the two lands nowhere.
  if (!post) return { rev: c.ifRev, steps: make(...(a.args ?? [])), result: { name: a.name } };
  const rev = await postRev(c.eng);
  if (c.ifRev !== undefined && c.ifRev !== rev) fail('stale', `The post changed since rev ${c.ifRev}; read it again`, { rev });
  return { rev, steps: make(...(a.args ?? [])), result: { name: a.name } };
}

/** doc.pageSetup: every section (select.all) through Layout's commands. */
async function pageSetup(c, a) {
  const steps = [['select.all']];
  if (a.size) {
    const s = typeof a.size === 'string' ? PAPER_SIZES[a.size] : { w: a.size.widthPt, h: a.size.heightPt };
    steps.push(['layout.size', { width: s.w, height: s.h }]);
  }
  if (a.orientation) steps.push(['layout.orientation', { value: a.orientation }]);
  if (a.margins) {
    const m = typeof a.margins === 'string' ? MARGIN_PRESETS[a.margins] : { top: a.margins.topPt, right: a.margins.rightPt, bottom: a.margins.bottomPt, left: a.margins.leftPt };
    steps.push(['layout.margins', { top: m.top, right: m.right, bottom: m.bottom, left: m.left }]);
  }
  if (a.pageNumber === null) steps.push(['hf.removePageNumbers']);
  else if (a.pageNumber) steps.push(['insert.pageNumber', { position: a.pageNumber.at, align: a.pageNumber.align }]);
  const { draftId, ...sect } = a;
  return { rev: c.ifRev, steps, result: { sect } };
}

// ---------------------------------------------------------------------------------------------
// references.* on a canvas draft: the document keeps its sources (stage2.md S4, wp/citations/canvas.mjs). Source and style edits
// are no revisions: they run as plain engine commands, a row on the group's card as on the DOM path (commands.js META_ROWS).

/** The document's sources in the app's shape and the style the app formats them in (the app has Harvard and IEEE). */
async function sources(c) {
  const r = await query(c.eng, 'references.citations');
  return { style: r.style === 'IEEE' ? 'ieee' : 'harvard', list: (r.sources ?? []).map(fromEngineSource) };
}

/** Runs plain engine commands (not revisions); fails with the engine's reason. */
async function plainRun(c, steps) {
  const r = await c.eng.execMany(steps);
  if (!r?.ok) fail('refused', r?.error ?? 'The engine refused it');
}

const sourceOf = (list, id) => list.find((s) => s.id === id) ?? fail('not_found', `The draft has no source ${id}`, { hint: 'references_list gives the ids' });

async function refList(c) {
  const { style, list } = await sources(c);
  return { style, sources: shown(list, style), list: referenceList(list, style) };
}

async function refCite(c, a) {
  const { style, list } = await sources(c);
  sourceOf(list, a.id);
  const s = shown(list, style).find((x) => x.id === a.id);
  return { text: a.narrative ? s.citeNarrative : s.cite };
}

async function refSave(c, source) {
  const { style, list } = await sources(c);
  const tag = source.tag || tagOf(source, new Set(list.map((s) => s.tag)));
  const known = list.some((s) => s.tag === tag);
  await plainRun(c, [...(known ? [['references.sources', { remove: tag }]] : []), ['references.sources', { add: toEngineSource({ ...source, tag }) }]]);
  const now = await sources(c);
  return shown(now.list, style).find((s) => s.tag === tag);
}

async function refAdd(c, a) {
  if (!a.link && !a.source) fail('invalid_args', 'Give a link or the source details', { path: '', message: 'needs link or source', expected: { required: ['link'] } });
  let found = {};
  let problem = '';
  if (a.link) {
    try {
      ({ source: found, problem } = await c.references.lookupLink(a.link));
    } catch (e) {
      fail('invalid_args', e.message, { path: '/link', message: e.message });
    }
  }
  return { source: await refSave(c, { ...found, ...a.source, tag: '' }), ...(problem && { problem }) };
}

async function refUpdate(c, a) {
  const { list } = await sources(c);
  return { source: await refSave(c, { ...sourceOf(list, a.id), ...a.source, tag: a.id }) };
}

async function refRemove(c, a) {
  const { style, list } = await sources(c);
  const source = shown(list, style).find((s) => s.id === sourceOf(list, a.id).id);
  await plainRun(c, [['references.sources', { remove: a.id }]]);
  return { source };
}

async function refStyle(c, a) {
  await plainRun(c, [['references.citationStyle', { style: a.style === 'ieee' ? 'IEEE' : 'Harvard (Anglia)' }]]);
  if (a.asDefault) await c.references.setDefaultStyle(a.style);
  return { style: a.style };
}

async function refInsertList(c, a) {
  const o = await outlineOf(c.eng, false);
  if (!(await sources(c)).list.length) fail('refused', 'The draft has no sources yet', { code: 'no_sources', hint: 'Add them with references_add' });
  const at = a.at ?? 'end';
  const x = at === 'end' ? o.paras.findLast((p) => p.path.length === 1) ?? o.paras.at(-1)
    : at === 'start' ? null : at === 'cursor' ? await caretParagraph(c, o) : target(c, o, at, true)[0];
  // ponytail: at start or before a path, the list goes after the paragraph before it (or after the first paragraph).
  const anchor = x && (a.position ?? 'after') === 'after' ? x : sibling(o, [x ?? o.paras[0]], -1) ?? x ?? o.paras[0];
  const steps = [['select.at', { para: anchor.para, from: anchor.text.length }], ['text.newParagraph'], ['references.bibliography']];
  return { rev: o.rev, steps, result: (now) => ({ paths: added(now, o) }) };
}

/** The engine side of each command that works on a canvas draft: `read` (a pure read), `run` (plain engine commands that are no
 * revision) or `write` (steps for one execAs). The executor refuses the others there (gate draft.dom). */
export const ENGINE = {
  'doc.get': { read: docGet },
  'doc.find': { read: docFind },
  'doc.selection': { read: docSelection },
  'history.state': { read: historyState },
  'history.undo': { run: (c, a) => walk(c, a, 'edit.undo') },
  'history.redo': { run: (c, a) => walk(c, a, 'edit.redo') },
  'doc.insert': { write: docInsert },
  'doc.replace': { write: docReplace },
  'doc.edit': { write: docEdit },
  'doc.delete': { write: docDelete },
  'doc.format': { write: docFormat },
  'doc.command': { write: docCommand },
  'doc.pageSetup': { write: pageSetup },
  'references.list': { read: refList },
  'references.cite': { read: refCite },
  'references.add': { run: refAdd },
  'references.update': { run: refUpdate },
  'references.remove': { run: refRemove },
  'references.setStyle': { run: refStyle },
  'references.insertList': { write: refInsertList },
};

/** Runs writes `ws` (each {rev, steps, result}, from ENGINE's write) in one execAs call as the assistant with suggestion group `tag`:
 * one undo step, tracked changes by "Assistant" that carry the tag, refused as stale when the draft changed since the first write's
 * read. `agent` false: the user's own call (the palette), plain commands under the user's name and Track Changes setting.
 * → {results (each write's, read from the outline after), revisions (the new revisions' ids), rev, changed}. */
export async function commit(eng, ws, tag, agent = true) {
  const steps = ws.flatMap((w) => w.steps);
  const rev = ws.find((w) => w.rev !== undefined)?.rev;
  const r = !steps.length ? { ok: true, changed: false, revisions: [] }
    : agent ? await eng.execAs(ASSISTANT, tag ?? null, steps, rev) : await eng.execMany(steps);
  if (!r?.ok) {
    const why = String(r?.error ?? 'the engine did not answer');
    if (/^stale/.test(why)) fail('stale', 'The draft changed while the call was prepared; read it again', { rev: r?.rev });
    fail('refused', why, { code: 'engine', ...(r?.step !== undefined && { step: steps[r.step]?.[0] }) });
  }
  const now = await outlineOf(eng, false);
  return { results: ws.map((w) => (typeof w.result === 'function' ? w.result(now) : w.result)), revisions: r.revisions ?? [], rev: now.rev, changed: !!r.changed };
}

/** The text of `rev`'s outline paragraphs, for the situation note (capture.js): "[3] Heading 1: The first words..." per paragraph,
 * at most `limit`, a line saying how many more. */
export function outlineLines(o, limit) {
  const out = o.paras.slice(0, limit).map((p) => {
    const t = plain(p.text).replace(/\s+/g, ' ').trim();
    const pending = p.tags ? ` (pending: ${p.tags.join(', ')})` : '';
    return `[${p.path}] ${p.style}${t ? `: ${t.length > 100 ? `${t.slice(0, 100)}... (${t.length} characters)` : t}` : ''}${pending}`;
  });
  if (o.paras.length > limit) out.push(`... ${o.paras.length - limit} more paragraphs (doc_get outline lists them)`);
  return out;
}
