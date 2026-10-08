// What the assistant's model gets back from earlier turns (SPEC §7i Context; automation plan §13.4), pure: assistant.js and
// loop.js use it, test/assistant-context.test.mjs tests it. Past turns go back with each tool call as a summary pair (the tool
// name, its short arguments and a one-line result), never the full result; past attachments as their pill label only. Within a
// turn, only the last two tool results go in full and only the last picture keeps its image (turnMessages, wave 2b).

export const RESULT_CHARS = 160;
const ARG_CHARS = 80;
const VALUE_CHARS = 40;
export const COMPACT_AT = 0.8; // of the server's context: the next send summarizes the conversation first
export const MAX_TURNS = 20; // ponytail: a turn cap behind the 80 % compaction, for servers that report no usage
const NOTE = 'This is a summary of our earlier conversation.';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

/** A tool call's arguments (JSON text) → short JSON text: values up to 40 characters kept (longer strings cut, a longer array or
 * object as its size, "(2515 characters)"), keys added while the whole stays within 80 characters. Always an object, so chat
 * templates can read it. The size stands in for a long value because later turns replay these arguments: a dropped `content`
 * read as a call made without it (2026-10-07), and a string in place of an object or array fails validation if copied. */
export function briefArgs(json) {
  let a;
  try {
    a = JSON.parse(json || '{}');
  } catch {
    return '{}';
  }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return '{}';
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    const s = JSON.stringify(v) ?? '';
    if (typeof v === 'string') out[k] = clip(v, VALUE_CHARS);
    else if (s.length <= VALUE_CHARS) out[k] = v;
    else out[k] = `(${s.length} characters)`;
    if (JSON.stringify(out).length > ARG_CHARS) {
      delete out[k];
      break;
    }
  }
  return JSON.stringify(out);
}

/** A result's shape without its content: numbers and short strings as they are, the rest as sizes. */
function shape(r) {
  if (Array.isArray(r)) return plural(r.length, 'item');
  if (!r || typeof r !== 'object') return r === undefined || r === null ? '' : clip(String(r), VALUE_CHARS);
  return Object.entries(r).flatMap(([k, v]) => (v === null || v === undefined ? []
    : typeof v === 'number' || typeof v === 'boolean' ? [`${k} ${v}`]
      : typeof v === 'string' ? [v.length <= VALUE_CHARS ? `${k} "${v}"` : `${k} (${v.length} characters)`]
        : Array.isArray(v) ? [`${k} (${plural(v.length, 'item')})`] : [`${k} (${plural(Object.keys(v).length, 'field')})`])).join(', ');
}

/** One tool answer ({ok, result} | {ok: false, error}) → its result line of at most 160 characters: "read: …" for a read, "done:
 * …" for a change, "failed (code): message" for an error; `title` (the draft the call names) is added when given. */
export function resultLine(risk, res, title = '') {
  const named = title ? ` (draft "${clip(title, VALUE_CHARS)}")` : '';
  const s = res.ok ? shape(res.result) : '';
  const line = !res.ok ? `failed (${res.error?.code ?? 'error'}): ${res.error?.message ?? ''}` : `${risk === 'read' ? 'read' : 'done'}${named}${s ? `: ${s}` : ''}`;
  return clip(line, RESULT_CHARS);
}

/** The conversation as OpenAI messages: from the last divider on (its summary first, as a note), the last 20 user turns; the
 * user's text (the last message, the turn being answered, with its attachments: `content`), the assistant's finished text, and
 * each step's tool call as an assistant tool_calls + tool result pair of summaries (`step.call`, `step.line`). */
export function buildHistory(messages, maxTurns = MAX_TURNS) {
  const cut = messages.findLastIndex((m) => m.role === 'divider');
  let ms = messages.slice(cut + 1).filter((m) => !m.streaming);
  const starts = ms.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  if (starts.length > maxTurns) ms = ms.slice(starts.at(-maxTurns));
  const summary = messages[cut]?.summary;
  const out = summary ? [{ role: 'user', content: `${NOTE}\n\n${summary}` }] : [];
  ms.forEach((m, i) => {
    if (m.role === 'user') out.push({ role: 'user', content: i === ms.length - 1 ? m.content ?? m.text : m.text });
    else if (m.role === 'assistant' && m.text) out.push({ role: 'assistant', content: m.text });
    else if (m.role === 'step' && m.step?.call) {
      const { id, name, args } = m.step.call;
      const call = { id, type: 'function', function: { name, arguments: args } };
      const prev = out.at(-1);
      // The completion that made the call is the message just before its step line (its text, when it had any).
      if (prev?.role === 'assistant' && !prev.tool_calls && ms[i - 1]?.role === 'assistant' && ms[i - 1].text) prev.tool_calls = [call];
      else out.push({ role: 'assistant', content: '', tool_calls: [call] });
      out.push({ role: 'tool', tool_call_id: id, content: m.step.line });
    }
  });
  return out;
}

// A reply that says it did something (the user's report: "I've opened ..." with no tool call): checked when no change or
// navigation succeeded in the turn, then asked again once. The "I" starts a line or a sentence ("Sure, I've opened it."), so
// "If I removed it" and quotes of the student's first-person drafts ("I added a door") do not count, nor "Nothing has been".
const VERBS = 'opened|changed|added|deleted|removed|created|updated|inserted|replaced|renamed|moved|edited|saved|formatted|tagged';
export const CLAIM_RE = new RegExp(`(?:^\\s*[*_]*|[.!?,]\\s+)I(?:'ve|’ve| have)?\\s+(?:now\\s+|just\\s+|also\\s+)?(?:${VERBS})\\b|(?<!\\bnothing )\\b(?:has|have) been (?:${VERBS})\\b|^\\s*[*_]*(?:all\\s+)?done\\b`, 'im');
/** Whether reply `text` claims an action: CLAIM_RE up to the first line that ends with ":" (what follows is a rewrite or a quote). */
export const claims = (text) => CLAIM_RE.test(text.split(/:[ \t]*\n/)[0]);
export const CLAIM_ASK = 'No tool call in this turn did what your reply says. Make the tool call now, or say plainly that you have not done it.';

// A reply that promises an action and ends the turn (the "I'll straighten it" report, 2026-10-06): "I'll", "I will", "Let me",
// "I'm going to" or "I can do that" starting a line or a sentence, as CLAIM_RE. "Let me know" closes a reply, and "Let me explain"
// (also know, summarise, clarify, describe, walk) answers a question: neither is a promise of an action.
export const PROMISE_RE = /(?:^\s*[*_]*|[.!?,]\s+)(?:(?:I(?:'ll|’ll| will)|Let me|I(?:'m|’m| am) going to)(?!\s+(?:know|explain|summari[sz]e|clarify|describe|walk)\b)|I can do that)\b/im;
/** Whether reply `text` promises an action: PROMISE_RE up to the first line that ends with ":" (as claims), quoted text left out
 * (a quote of the student's first-person draft, "I will argue ..."). */
export const promises = (text) => PROMISE_RE.test(text.split(/:[ \t]*\n/)[0].replace(/"[^"\n]*"|“[^”\n]*”/g, '""'));
export const PROMISE_ASK = 'Do it now with a tool call, or say what stops you.';

/** Whether `usage` ({used, ctx} tokens) is at or above 80 % of the context: the next send compacts first. */
export const shouldCompact = (usage) => !!usage?.ctx && usage.used >= COMPACT_AT * usage.ctx;

export const COMPACT_SYSTEM = 'You summarize a chat between a student and the assistant in EasyWriter, a desktop app for drafting forum posts.';
export const COMPACT_ASK = 'Summarize our conversation so far in at most 300 words of plain text. Keep my goals, the decisions, the open items and '
  + 'the drafts we touched, with their titles.';

// ---------------------------------------------------------------------------------------------
// Turn guards (SPEC §7i Situation note, Tool loop; user requests 2026-10-06): the situation note, the repeat key, the cycle
// check, the repetition detector and the sparse form of an oversized tool answer.

const TITLE_CHARS = 50;
export const NOTE_DRAFTS = 30;
const PAGES = { editor: 'Editor', plan: 'Plans', flows: 'Flowcharts' };
// The assistant's permission mode (settings.assistant.permission) when it is not Standard: one line of the note.
const MODE_LINES = {
  ask: 'Permission mode: Ask first. The user approves every change on a card.',
  readonly: 'Permission mode: Read only. You can read and answer. Every change is refused.',
};

/** The situation note the app puts before the user's message at send time; `s` = {page: 'editor' | 'plan' | 'flows', plan?,
 * flow? (the workspace's title), draft: {title, tag?} | null, thread?, selection: {label, summary, attached} | null, canvas? (the
 * canvas being edited, e.g. "the canvas at block [4]"), background?: [title] (the drafts with a background session, sessions.js),
 * drafts: [{title, tag?}], total, scope: 'thread' | 'all', permission?:
 * 'standard' | 'ask' | 'readonly', playbooks?: [{id?, title, text}] (playbooks.mjs pickPlaybooks, under "How to do this:")}. Never
 * stored. */
export function situationNote(s) {
  const q = (t) => `"${clip(t || 'Untitled draft', TITLE_CHARS)}"`;
  const tagged = (d) => `${q(d.title)}${d.tag ? `, tag ${d.tag}` : ''}`;
  const page = PAGES[s.page] ?? s.page;
  const where = s.page === 'plan' && s.plan ? `, plan ${q(s.plan)}` : s.page === 'flows' && s.flow ? `, flowchart ${q(s.flow)}` : '';
  const lines = [
    '[Situation note from the app. It is current for this message.]',
    `Page: ${page}${where}`,
    `Open draft: ${s.draft ? `${tagged(s.draft)}${s.draftId ? ` (id ${s.draftId})` : ''}${s.page === 'editor' ? '' : ' (behind this page)'}` : 'none'}`,
  ];
  if (s.draft) lines.push(`Thread: ${s.thread ? q(s.thread) : 'none'}`);
  if (s.background?.length) lines.push(`Working in the background on: ${s.background.map(q).join(', ')}`);
  const sel = s.selection;
  lines.push(`Selected: ${sel ? `${clip(sel.summary, 140)}${sel.attached ? `. It is attached as [${sel.label}].` : ''}` : 'nothing'}`);
  if (s.page === 'editor' && s.draft) lines.push(`Canvas being edited: ${s.canvas || 'none'}`);
  const shown = s.drafts.slice(0, NOTE_DRAFTS);
  const head = s.scope === 'thread' ? 'Drafts in this thread' : 'Drafts';
  const count = s.total > shown.length ? `${s.total}, the first ${shown.length} in sidebar order` : String(s.total);
  lines.push(`${head} (${count})${shown.length ? '' : ': none'}`, ...shown.map((d) => `- ${tagged(d)}${d.id ? ` (id ${d.id})` : ''}`));
  // Google AI: the open draft's blocks with their paths (capture.js outlineLines), so the model knows the draft before it acts.
  if (s.outline?.length) lines.push('Open draft outline (block paths for the doc and board tools):', ...s.outline);
  if (MODE_LINES[s.permission]) lines.push(MODE_LINES[s.permission]);
  // A playbook's id goes after its title (wave 2b): the tool text of board_items_add, batch and canvas_edit names it.
  if (s.playbooks?.length) lines.push('How to do this:', ...s.playbooks.map((p) => `${p.title}${p.id ? ` (playbook ${p.id})` : ''}\n${p.text}`));
  lines.push('[End of situation note]');
  return lines.join('\n');
}

/** A user message's content (attach.mjs modelContent: text, or OpenAI content parts with pictures) with the situation note first;
 * in content parts the note joins the first text part (a chat template may trim each part and glue it to the next). */
export function withNote(note, content) {
  if (!Array.isArray(content)) return `${note}\n\n${content}`;
  const [first, ...rest] = content;
  return first?.type === 'text' ? [{ type: 'text', text: `${note}\n\n${first.text}` }, ...rest] : [{ type: 'text', text: note }, ...content];
}

const canonical = (v) => (Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);

/** The repeat key of tool call `name` with `args` (JSON text): the same tool with the same arguments in any key order. */
export function callKey(name, args) {
  try {
    return `${name} ${JSON.stringify(canonical(JSON.parse(args || '{}')))}`;
  } catch {
    return `${name} ${args}`;
  }
}
export const REPEAT_NOTE = 'You already called this with the same arguments; use that result.';

const nameOf = (key) => key.slice(0, key.indexOf(' '));

// One tool called with ever new arguments since the last write: the circle note at the 5th, the stop at the 8th (wave 1b; 4
// and 5 before, which caught five legitimate doc_get reads of a cut draft).
export const HAMMER_NOTE = 5;
export const HAMMER_STOP = 8;

/** Whether the turn's call keys (callKey, in order) go round in circles: 'cycle' when the last 4 or 6 are a run of 2 or 3
 * calls made twice (A B A B, A B C A B C; not one call four times, the repeat key's case), 'hammer' when the last call's tool
 * was called with HAMMER_NOTE or more different arguments since `from` (the index after the last successful write), 'stop'
 * at HAMMER_STOP or more, else null. */
export function loopKind(keys, from = 0) {
  for (const n of [2, 3]) {
    const run = keys.slice(-2 * n);
    if (run.length === 2 * n && new Set(run).size > 1 && run.every((k, i) => k === run[i % n])) return 'cycle';
  }
  const name = keys.length ? nameOf(keys.at(-1)) : '';
  const n = new Set(keys.slice(from).filter((k) => nameOf(k) === name)).size;
  return n >= HAMMER_STOP ? 'stop' : n >= HAMMER_NOTE ? 'hammer' : null;
}
/** The note added to the tool result of the call that `loopKind` caught first; `names`: the tools going round. */
export const loopNote = (names) => `You are going round in circles (calls: ${names.join(', ')}). Say what you have learned and what is missing, then make a different call or ask the user.`;

/** The line every tool result of the turn ends with (wave 1c): how many of the turn's calls are left. */
export const callsLeft = (n) => ` Calls left in this reply: ${n}.`;

// Reading on after a change (wave 1c, the Gemma eval: a right first write, then reads and unasked changes up to the call cap
// and an empty reply): a successful change followed by 3 successful reads and nothing else ends the turn with doneReply.
export const READS_AFTER_WRITE = 3;

/** Whether command `id` of risk `risk` is a change for readsAfterWrite (wave 2): a doc.* or board.* command that is not a read.
 * Opening a draft or Canvas Mode, closing it, selecting, scrolling and zooming are not, so reads after them go on. */
export const guardWrite = (id, risk) => risk !== 'read' && /^(doc|board)\./.test(id);

/** Whether the turn's run calls ([{write, ok}] in order, `write`: guardWrite) end in a successful change and then
 * READS_AFTER_WRITE successful reads in a row. */
export function readsAfterWrite(calls, n = READS_AFTER_WRITE) {
  const i = calls.findLastIndex((c) => c.write);
  const after = calls.slice(i + 1);
  return i >= 0 && calls[i].ok && after.length >= n && after.slice(-n).every((c) => c.ok);
}

const PAST = { find: 'found', set: 'set', run: 'ran', leave: 'left', format: 'formatted', undo: 'undid', redo: 'redid' };

/** The reply that ends a turn readsAfterWrite caught: "Done: " and the change's step title (a command title, or a past-tense
 * step label) in the past tense up to its first colon or "and", without brackets: "Change one item of a whiteboard or
 * canvas" → "Done: changed one item of a whiteboard or canvas.", "Rename or recolour a status tag" → "Done: renamed or recoloured
 * a status tag." */
export function doneReply(title) {
  const head = title.replace(/\s*\([^)]*\)/g, '').split(/:| and /)[0].trim();
  const past = (verb) => {
    const v = verb.toLowerCase();
    return v.endsWith('ed') ? v : PAST[v] ?? (v.endsWith('e') ? `${v}d` : `${v}ed`);
  };
  return `Done: ${head.replace(/^([A-Za-z]+)(?: or ([A-Za-z]+)\b)?/, (m, a, b) => `${past(a)}${b ? ` or ${past(b)}` : ''}`)}`.replace(/[.\s]*$/, '.');
}

/** A tool answer `res` with its pictures taken out (view.render's `url` beside `picture: 'next message'`, also as a batch step's
 * result) → {res, pictures: [{url, size}]} (`size`: the answer's size line, wave 2b): the model gets the answer as text and each
 * picture as the next user message (loop.js). */
export function takePictures(res) {
  const pictures = [];
  const take = (r) => {
    if (r?.picture !== 'next message' || typeof r.url !== 'string') return r;
    const { url, ...rest } = r;
    pictures.push({ url, size: typeof r.size === 'string' ? r.size : '' });
    return rest;
  };
  if (!res.ok) return { res, pictures };
  const result = Array.isArray(res.result?.results) ? { ...res.result, results: res.result.results.map(take) } : take(res.result);
  return { res: { ...res, result }, pictures };
}

/** The user message that carries picture `url` with its line `text` (OpenAI-style servers take images in user messages only). */
export const pictureMessage = (text, url) => ({ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url } }] });

// In-turn trimming (wave 2b, user decision 2026-10-07): only the last two tool results of the turn go in full.
export const KEEP_RESULTS = 2;
const isPicture = (m) => m?.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url');

/** This turn's tool messages that go in full: the last `keep` of `messages` that `lines` (Map tool message → its one-line summary)
 * holds. Keyed by the message, since a server may give every call the same id. */
export const fullResults = (messages, lines, keep = KEEP_RESULTS) => new Set(messages.filter((m) => lines.has(m)).slice(-keep));

/** `messages` as the next request sends them (wave 2b; `messages` itself is not changed): every tool message of the turn but the
 * last KEEP_RESULTS gets its one-line summary from `lines` (the step line's, resultLine, as buildHistory sends past turns), and every
 * picture message (pictureMessage) from index `from` on (after the message being answered) but the last keeps its text part only,
 * so one live picture goes per request. */
export function turnMessages(messages, from, lines, keep = KEEP_RESULTS, live = 1) {
  const full = fullResults(messages, lines, keep);
  const pics = messages.slice(from).filter(isPicture);
  const old = new Set(Number.isFinite(live) ? pics.slice(0, Math.max(0, pics.length - live)) : []); // `live`: pictures kept (Gemini: all)
  return messages.map((m) => (lines.has(m) && !full.has(m) ? { ...m, content: lines.get(m) }
    : old.has(m) ? { ...m, content: m.content.filter((p) => p?.type !== 'image_url') } : m));
}

/** Whether streamed `text` is looping: its last `span` characters occur `times` times without overlap. */
export function repeats(text, span = 60, times = 4) {
  if (sameSentence(text)) return true;
  if (text.length < span * times) return false;
  const tail = text.slice(-span);
  let n = 0;
  for (let i = text.indexOf(tail); i !== -1; i = text.indexOf(tail, i + span)) if (++n >= times) return true;
  return false;
}

/** Whether `text` says the same sentence four times (letters and digits, case-folded, quotes and spacing ignored, at least 25 characters):
** the doom loop of 2026-10-07 ("Let me actually call board_items_update with ... to rename it to 'Pump 2'." over and over, each
 * time with a different lead-in, so no 60-character span repeated). */
export function sameSentence(text, times = 4, minLetters = 25) {
  const count = new Map();
  for (const raw of text.split(/[.!?:]\s+|\n+/)) {
    const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, ''); // digits kept: numbered steps are not a loop
    if (key.length < minLetters) continue;
    const n = (count.get(key) ?? 0) + 1;
    if (n >= times) return true;
    count.set(key, n);
  }
  return false;
}

/** The marks of this turn: number → item id, read from every legend line ("3 p8w2r5d shape ...") in the texts the model got
 * (attachments, view_render legends, after-write pictures). Later lines win, so the newest picture's numbers hold. */
export function markIds(texts) {
  const map = new Map();
  for (const t of texts) for (const m of String(t ?? '').matchAll(/^(\d{1,3}) ([A-Za-z0-9_-]{5,32}) (?:shape|text|image|connector|canvas|stroke)\b/gm)) map.set(m[1], m[2]);
  return map;
}

/** `args` with a bare mark number in id, of, item or ids replaced by that mark's item id (a model that reads "1 p8w2r5d shape" often
 * sends id "1"); other values stay. → [args, [[number, id], ...] of the swaps]. */
export function withMarkIds(args, marks) {
  if (!marks.size || !args || typeof args !== 'object') return [args, []];
  const swaps = [];
  const one = (v) => (typeof v === 'string' && /^\d{1,3}$/.test(v) && marks.has(v) ? (swaps.push([v, marks.get(v)]), marks.get(v)) : v);
  const out = { ...args };
  for (const k of ['id', 'of', 'item']) if (k in out) out[k] = one(out[k]);
  if (Array.isArray(out.ids)) out.ids = out.ids.map(one);
  if (Array.isArray(out.steps)) out.steps = out.steps.map((st) => (st && typeof st === 'object' && st.args ? { ...st, args: withMarkIds(st.args, marks)[0] } : st));
  return [out, swaps];
}

/** The sparse form (wave 2b, after Figma's get_design_context) of tool answer `res` whose list `list` does not fit `max`
 * characters, as JSON text: the first whole items that fit, `sparse: true`, `next` (`key(item, k)` of each item left out, then
 * `after`, ids the answer left out already) and `hint` (`hint(the first key left out, k)`); `wrap(part, fields)` → the result
 * with the list `part` and those fields. Keys that do not all fit keep the first ones, `more` counts the rest. null when the whole
 * list fits (the overflow is elsewhere). */
function sparse(res, list, { key, wrap, hint, after = [] }, max) {
  const len = (v) => JSON.stringify(v).length + 1;
  const keys = [...list.map(key), ...after];
  const ks = keys.map(len);
  const is = list.map(len);
  // The wrapper with empty lists, 20 characters for the hint's own length to vary, and every key in `next`.
  let total = JSON.stringify({ ...res, result: wrap([], { sparse: true, next: [], hint: hint(keys[0], 0), more: 0 }) }).length + 20 + ks.reduce((n, x) => n + x, 0);
  let k = 0;
  while (k < list.length && total + is[k] - ks[k] <= max) total += is[k] - ks[k++];
  if (k === list.length) return null;
  let n = keys.length;
  while (n > k + 1 && total > max) total -= ks[--n];
  const next = keys.slice(k, n);
  return JSON.stringify({ ...res, result: wrap(list.slice(0, k), { sparse: true, next, hint: hint(next[0], k), ...(n < keys.length && { more: keys.length - n }) }) });
}

/** A tool answer as the JSON text the model gets, at most about `max` characters. A board_get or board_find answer, or a doc_get
 * read with a list (blocks or outline entries), that is too long is sparse (above): its first whole items with the ids, or the
 * first blocks with the paths, left out in `next` and a hint to read one with board_find or doc_get (wave 2b; before, `cut`).
 * Other text is cut with a note to read a smaller part. */
export function clipResult(name, args, res, max) {
  const s = JSON.stringify(res) ?? '';
  if (s.length <= max) return s;
  let a = {};
  try {
    a = JSON.parse(args || '{}') ?? {};
  } catch {}
  const base = Array.isArray(a.path) ? a.path : [];
  const p = (i) => JSON.stringify({ path: [...base, i] });
  const board = name === 'board_get' ? res.result?.board : name === 'board_find' ? res.result : null;
  const content = res.result?.content;
  const outline = Array.isArray(content);
  const blocks = name !== 'doc_get' ? null : outline ? content : Array.isArray(content?.content) ? content.content : null;
  const out = Array.isArray(board?.items) ? sparse(res, board.items, {
    key: (i) => i.id,
    wrap: (part, f) => (name === 'board_get' ? { ...res.result, board: { ...board, items: part }, ...f } : { ...res.result, items: part, ...f }),
    hint: (id) => `Read one with board_find ${JSON.stringify({ path: base, ...(Array.isArray(a.itemPath) && { itemPath: a.itemPath }), q: id })}.`,
    after: name === 'board_find' && Array.isArray(res.result.next) ? res.result.next : [],
  }, max) : blocks && sparse(res, blocks, {
    key: (b, k) => (outline ? b.path : [...base, k]),
    wrap: (part, f) => ({ ...res.result, content: outline ? part : { ...content, content: part }, ...f }),
    hint: (path, k) => (k || outline ? `Read one with doc_get ${JSON.stringify({ path })}.`
      : `Block [${path}] is too long to show. Read its text with doc_get ${JSON.stringify({ path, format: 'text' })}.`),
  }, max);
  if (out) return out;
  const next = name !== 'doc_get' ? 'Do not repeat this call. Read a smaller part, such as one block by its path.'
    : base.length ? `Read the blocks inside it one at a time with doc_get ${p(0)}, then ${p(1)}.`
      : 'Call doc_get with {"format":"outline"} for the block paths, then read one block with {"path":[n]}.';
  return `${s.slice(0, max)}... (cut. ${next})`;
}
