import { toast } from 'sonner';
import { invoke } from '../commands.js';
import { byId, MODEL_DEFS } from '../commands/catalogue.mjs';
import { assistantMode, COMPUTER, CORE, DESCRIBED_CHARS, refusal, VIEW_SETS, viewOf } from '../commands/tool-sets.mjs';
import { commandIdOf, toolsFor } from '../commands/tools-schema.mjs';
import { getState, setState } from '../store.js';
import { addMessage, assistantSettings, complete, history, patchMessage, stop, wantsThinking } from './assistant.js';
import { situation } from './capture.js';
import {
  briefArgs, callKey, callsLeft, CLAIM_ASK, claims, clipResult, doneReply, fullResults, guardWrite, loopKind, loopNote, pictureMessage, PROMISE_ASK,
  markIds, promises, readsAfterWrite, REPEAT_NOTE, resultLine, takePictures, turnMessages, withMarkIds, withNote,
} from './context.mjs';
import { familyOf, systemPrompt } from './prompts.mjs';
import { fix, lint, styleArgs, styleAsk } from './style-lint.mjs';
import { endTurn } from './sessions.js';

// The assistant's tool loop (SPEC §7i Tool loop; automation plan §13.1, §13.2 Tool calls): the model calls registry commands as
// OpenAI tool calls through llama-server, one per request; each runs through invoke() as source 'agent:assistant' (schema,
// gates, the AgentAsk card for destructive steps, audit) and its answer goes back as a role 'tool' message.

// The tools offered (tool-sets.mjs): the core, the current view's set and the tools commands_describe added, in the model form;
// the core and view tools only while their gates hold. Never offered, not even through commands_describe: history.undo /
// history.redo (the model must not undo the user's own typing; each step line has its own Undo), and tool.run, whose palette
// Undo / Redo entries would do the same.
const NEVER = ['history.undo', 'history.redo', 'tool.run'];
const MAX_CALLS = 20; // user decision 2026-10-07: 8 halted promising multi-step work; in-turn trimming (wave 2b) keeps the context in bounds
const MAX_RESULT = 8000; // characters of one tool answer sent back (about 2.3 K tokens of the 16 K); ponytail: a char cap, count tokens if it overflows
const SHOTS = 3; // computer use: only the turn's last 3 screenshots keep their image (each request resends every picture it keeps)
const CLOUD_KEEP = 4; // the cloud models: tool results kept in full per request (the older ones go as their step line)
const CLOUD_LIVE = 3; // the cloud models: pictures kept with their image per request
const TOOL_TEXT = /<tool_call>|<function=/; // a tool call the model wrote into its text (§13.2: re-asked once)
// The system prompt (the procedure the model follows) is the model family's (prompts.mjs, wave 1c).
const REPEAT_STOP = 'Stopped a repeated call.';
const CIRCLE_STOP = 'Stopped: the assistant kept repeating itself.';
const LOOP_STOP = 'The reply started repeating itself and was stopped.';
const TOOL_ASK = 'Make that tool call as a real tool call, not as text.';
const REPLY_ASK = 'Reply to the user now, in plain text.'; // an empty reply (thinking used it all), asked once without thinking
const afterWriteText = (size) => `The board after your change${size ? `, ${size}` : ''}. Check it against the request, then reply.`;
const brief = (v) => {
  const s = JSON.stringify(v) ?? '';
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

/** One user turn: requests until a text-only reply, Stop, an error, 8 commands, the same command failing twice in a row, the
 * third identical call (the second is answered with REPEAT_NOTE and not run), a cycle after the calls went round in circles
 * once or one tool's 8th set of arguments (context.mjs loopKind; the first time the call runs and its result gets loopNote), a
 * reply that loops twice (the first loop is asked again without thinking), or a successful doc.* or board.* change followed by 3
 * successful reads (context.mjs readsAfterWrite and guardWrite, waves 1c and 2: the change's summary becomes the reply, doneReply).
 * Every tool result ends with the calls left (callsLeft). A tool answer with a picture (view.render) goes as the tool message (the
 * legend and size) and a user message with the picture right after it (context.mjs takePictures); after the turn's first
 * successful board.* change the board's marked picture follows its tool message (afterWrite; once a turn, not in Read only, off
 * with settings.assistant.pictureAfterWrite false). Neither picture goes into later turns (buildHistory keeps the step lines).
 * Each request sends only the turn's last two tool results in full, the older ones as their step line's summary, and only the
 * last picture message with its image (context.mjs turnMessages, wave 2b); a repeated call whose result went down to its
 * summary runs again instead of getting REPEAT_NOTE. A
 * reply that claims a change (context.mjs CLAIM_RE) or promises one (PROMISE_RE) while no change or navigation succeeded in the
 * turn is asked again once (each) and replaced by the new reply. An empty reply (no text, no call: in the eval, thinking that
 * used the whole reply after a read) is asked once with REPLY_ASK, that request without thinking, and its answer is taken as it is.
 * `session` = {signal (Stop), lastRev (the rev of the last document read, sent as ifRev), described
 * (Map tool name → tool: added by commands_describe, kept while viewKey stays), viewKey (tool-sets.mjs viewOf)}; `parts`, the
 * message's parts (the situation note says whether the selection is attached; board items make the board set). */
export async function runTurn(session, userText, parts = []) {
  const { signal } = session;
  let think = wantsThinking(userText); // the Thinking menu's effort (assistant.js)
  const conn = { name: 'assistant', since: Date.now(), disconnect: stop };
  const connections = (fn) => setState({ agent: { ...getState().agent, connections: fn(getState().agent.connections) } });
  connections((c) => [...c, conn]); // the status bar shows "Agent: assistant" while the turn runs
  try {
    const family = familyOf(assistantSettings().model, assistantSettings().provider); // prompts.mjs: the system prompt and the model form of the tools
    // The cloud models (2026-10-07): 40 calls, no re-asks, they may read after a write to check their work. Each request resends
    // the turn so far, so what it keeps in full is capped (2026-10-08: one annotation case cost 755,556 tokens with everything kept,
    // and a Qwen Cloud model's free quota is 1M): the last CLOUD_KEEP results in full, the last CLOUD_LIVE pictures with their image
    // (the rest keep their caption), the situation note carrying the draft ids the small models' trimming used to lose.
    const gemini = family === 'gemini';
    const qwen = assistantSettings().provider === 'qwen';
    const maxCalls = gemini ? 40 : MAX_CALLS;
    const keep = gemini ? CLOUD_KEEP : undefined;
    const tools = await toolList(session, parts, family); // also when thinking: Think must never take the tools away (it used to, and the model then faked actions)
    const render = tools.some((t) => t.function.name === 'view_render'); // the prompt's view_render line
    // Qwen Cloud boxes come in thousandths of the picture (2026-10-08, prompts.mjs THOUSANDTHS_RULE).
    const messages = [{ role: 'system', content: systemPrompt(family, { tools: tools.length > 0, uiControl: modeNow().uiControl, render, thousandths: qwen }) }, ...history()];
    const asked = messages.findLastIndex((m) => m.role === 'user'); // the message being answered: this turn's requests only
    const content = messages[asked]?.content;
    let note = '';
    let calls = 0;
    let reasked = false;
    let claimed = false;
    let promised = false;
    let emptied = false; // an empty reply was asked once with REPLY_ASK
    let changed = false; // a change or navigation succeeded in this turn
    let lastFail = null;
    let looped = false;
    const seen = new Map(); // callKey → calls since the last change (a change makes the same read new again)
    const keys = []; // this turn's call keys in order (loopKind)
    let sinceWrite = 0; // the index in keys after the last successful change
    let circled = false; // loopKind caught the calls once: the next time stops the turn
    const ran = []; // this turn's calls that ran, [{write, ok}] (readsAfterWrite)
    let done = ''; // doneReply of the last successful change
    let pictured = false; // the board's picture went after a board change (once a turn)
    const lines = new Map(); // this turn's tool message → its step line's summary (turnMessages)
    const ranAt = new Map(); // callKey → the tool message of its last run
    const shots = []; // this turn's screenshot messages (computer_act, background_open), oldest first
    // The plain output rules (style-lint.mjs, plan §13.13): the user's own text (their message and the open draft) is left as it is.
    // ponytail: only the open draft counts as theirs; a background draft's text gets fixed where the model copies it.
    const known = () => {
      const doc = getState().editor?.state.doc;
      return `${userText}\n${doc ? doc.textBetween(0, doc.content.size, '\n', ' ') : ''}`;
    };
    let restyled = false; // the reply was asked once to follow the writing rules
    const restyledCalls = new Set(); // tool names whose text was sent back once for the writing rules
    // The request's messages: turnMessages, and every screenshot but the last SHOTS without its image (its caption stays).
    const request = () => {
      const old = new Set(shots.slice(0, -SHOTS));
      return turnMessages(messages, asked + 1, lines, keep, gemini ? CLOUD_LIVE : 1).map((m) => (old.has(m) ? { ...m, content: m.content.filter((p) => p?.type !== 'image_url') } : m));
    };
    while (!signal.aborted) {
      // Rebuilt for every request, so a navigation in this turn shows; the server's prompt cache holds while it stays the same.
      // Its playbooks follow the turn's view key, so they stay the same within the turn.
      const fresh = situation(parts, session.viewKey);
      if (asked > 0 && fresh !== note) messages[asked] = { ...messages[asked], content: withNote(note = fresh, content) };
      const replyNow = messages.at(-1)?.content === REPLY_ASK; // that request goes without thinking
      const r = await complete({ messages: request(), ...(tools.length && { tools }), think: think && !replyNow }, signal);
      if (r.finish === 'cancelled' || r.error) return;
      if (r.finish === 'repeat') { // the stream looped (assistant.js): hidden; once more without thinking, then stopped
        patchMessage(r.id, () => ({ text: '', reasoning: '' }));
        if (looped) {
          addMessage({ role: 'assistant', error: LOOP_STOP });
          return;
        }
        looped = true;
        think = false;
        continue;
      }
      // Gemini may make several calls in one reply (parallel function calling): all of them run, in order, in this round trip;
      // the small models keep one command per request (parallel_tool_calls: false, any extra call dropped).
      const batch = gemini ? r.toolCalls : r.toolCalls.slice(0, 1);
      // Dashes, curly quotes and the like are fixed in place; a pattern the fixer cannot change asks for the reply again, once.
      const text = fix(r.text, known());
      if (text !== r.text) patchMessage(r.id, () => ({ text }));
      if (!batch.length) {
        const styleQ = replyNow || restyled ? '' : (() => { const i = lint(text, known()); return i.length ? styleAsk(i) : ''; })();
        const ask = replyNow ? '' // the answer to REPLY_ASK is taken as it is
          : !emptied && !r.text.trim() ? REPLY_ASK
            : styleQ || (gemini ? '' // Gemini decides for itself (the user: "loosen up the guardrails"): no nudges for tool text, claims or promises
            : tools.length && !reasked && TOOL_TEXT.test(r.text) ? TOOL_ASK
              : !claimed && !changed && claims(r.text) ? CLAIM_ASK
                : tools.length && !promised && !changed && promises(r.text) ? PROMISE_ASK : '');
        if (!ask) return; // a text-only reply ends the turn
        if (ask === styleQ) restyled = true;
        else if (ask === CLAIM_ASK) claimed = true;
        else if (ask === PROMISE_ASK) promised = true;
        else if (ask === REPLY_ASK) emptied = true;
        else reasked = true;
        patchMessage(r.id, () => ({ text: '', reasoning: '' })); // the next reply replaces it
        messages.push({ role: 'assistant', content: r.text }, { role: 'user', content: ask });
        continue;
      }
      // `extra` (Gemini's extra_content.google.thought_signature) goes back with its call: Gemini 3 refuses a function call of the
      // current turn sent without it. Earlier turns replay their calls from the step lines, without it.
      // Qwen Cloud wants the reasoning back with the calls (docs.qwencloud.com function calling: accuracy drops without it).
      messages.push({ role: 'assistant', content: r.text, ...(qwen && r.reasoning && { reasoning_content: r.reasoning }), tool_calls: batch.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments }, ...(c.extra && { extra_content: c.extra }) })) });
      const later = []; // picture messages go after every tool message of the reply (each tool message follows its call)
      for (const call of batch) {
        const key = callKey(call.name, call.arguments);
        keys.push(key);
        const times = (seen.get(key) ?? 0) + 1;
        seen.set(key, times);
        // A repeated read never ends the turn (user, 2026-10-07: the stop kept halting promising work): while its full result is
        // still in the messages it is answered with the note, else it runs again. A repeated write is a mistake: the note once, then stop.
        const isRead = byId(commandIdOf(call.name))?.risk === 'read';
        if (times > 2 && !isRead && !gemini) {
          addMessage({ role: 'assistant', error: REPEAT_STOP });
          return;
        }
        if (!gemini && times >= 2 && fullResults(messages, lines, keep).has(ranAt.get(key))) { // not run: the model has the answer already
          messages.push({ role: 'tool', tool_call_id: call.id, content: `${REPEAT_NOTE}${callsLeft(maxCalls - calls)}` });
          continue;
        }
        if (times >= 2) seen.set(key, 1); // its result went down to its summary line (turnMessages): it runs again
        // Going round in circles (A B A B, or one tool with ever new arguments): the first time the call runs and its result says
        // so; a cycle after that stops the turn before the call runs, and so does the 8th set of arguments for one tool.
        const circle = gemini ? null : loopKind(keys, sinceWrite); // Gemini: no circle stop (loosened guardrails)
        if (circle === 'stop' || (circle === 'cycle' && circled)) {
          addMessage({ role: 'assistant', error: CIRCLE_STOP });
          return;
        }
        // Every text the model has seen this turn: the legends in it map mark numbers to ids (runCall, withMarkIds).
        session.legendTexts = messages.slice(asked).flatMap((m) => (typeof m.content === 'string' ? [m.content] : Array.isArray(m.content) ? m.content.map((q) => q?.text ?? '') : []));
        // The prose of a write (inserted text, labels, notes) follows the writing rules: fixed in place, or sent back once.
        let run = call;
        if (!isRead) {
          const st = styleArgs(call.arguments, known());
          if (st.issues.length && !restyledCalls.has(call.name)) {
            restyledCalls.add(call.name);
            messages.push({ role: 'tool', tool_call_id: call.id, content: `${styleAsk(st.issues, 'the text of this call')}${callsLeft(maxCalls - calls)}` });
            continue;
          }
          run = { ...call, arguments: st.arguments };
        }
        const { res, pictures, line } = await runCall(session, run, tools);
        const answer = clipResult(call.name, call.arguments, res, MAX_RESULT);
        const names = [...new Set(keys.slice(circle === 'cycle' ? -4 : -1).map((k) => k.slice(0, k.indexOf(' '))))];
        const left = callsLeft(maxCalls - calls - 1);
        const toolMessage = { role: 'tool', tool_call_id: call.id, content: `${circle && !circled ? `${answer}\n\n${loopNote(names)}` : answer}${left}` };
        messages.push(toolMessage);
        if (line) lines.set(toolMessage, line);
        ranAt.set(key, toolMessage);
        for (const p of pictures) { // after the reply's tool messages
          const m = pictureMessage(p.text, p.url);
          if (p.shot) shots.push(m);
          later.push(m);
        }
        circled ||= !!circle;
        const def = byId(commandIdOf(call.name));
        if (def?.risk !== 'read' && (res.ok || res.error?.code === 'stale')) {
          changed ||= res.ok;
          if (res.ok) sinceWrite = keys.length;
          seen.clear(); // the draft changed: the same read is new again (the rules ask for one after a write or a stale error)
        }
        if (res.error?.code === 'cancelled' || signal.aborted) return;
        ran.push({ write: !!def && guardWrite(def.id, def.risk), ok: res.ok });
        if (ran.at(-1).write && res.ok) done = doneReply(STEP_LABELS[def.id] ?? def.title);
        if (!gemini && readsAfterWrite(ran)) { // the change is made and the model only reads on: its summary is the reply
          addMessage({ role: 'assistant', text: done });
          return;
        }
        // The same call failing the same way twice in a row stops the turn (2026-10-07: a second try with other arguments, as a
        // corrected id, goes on).
        const fail = res.ok ? null : `${call.name}\n${res.error?.message}`;
        const end = fail && lastFail === fail ? `Stopped: ${call.name} failed twice (${res.error.message})`
          : ++calls >= maxCalls ? `Stopped after ${maxCalls} commands.` : '';
        if (end) {
          addMessage({ role: 'assistant', error: end });
          return;
        }
        lastFail = fail;
        // Rule 5 asks for the reply after a write that succeeded: the board's picture goes with that request (wave 2).
        if (res.ok && def?.risk !== 'read' && def?.id.startsWith('board.') && !pictured && pictureAfterWrite()) {
          pictured = true;
          const m = await afterWrite(session, call, res);
          if (m) later.push(m);
        }
      }
      messages.push(...later);
    }
  } finally {
    connections((c) => c.filter((x) => x !== conn));
    endTurn(); // the sidebar badges of background drafts go (sessions.js)
  }
}

const modeNow = () => assistantMode(getState().settings?.assistant);
const pictureAfterWrite = () => assistantSettings().pictureAfterWrite !== false && modeNow().permission !== 'readonly';

/** The marked picture of the board that the successful board.* `call` changed (its path, or board.insert's new block) as a user
 * message: afterWriteText with view.render's size line (wave 2b) and its legend, then the picture; null when it does not render. */
async function afterWrite(session, call, res) {
  let a = {};
  try {
    a = JSON.parse(call.arguments || '{}') ?? {};
  } catch {}
  const path = Array.isArray(a.path) ? a.path : res.result?.path;
  if (!Array.isArray(path)) return null;
  const args = { path, ...(Array.isArray(a.itemPath) && { itemPath: a.itemPath }), ...(typeof a.draftId === 'string' && { draftId: a.draftId }) };
  const pic = await invoke({ id: 'view.render', args, source: 'agent:assistant', signal: session.signal });
  return pic.ok ? pictureMessage(`${afterWriteText(pic.result.size)}\n${pic.result.legend}`, pic.result.url) : null;
}

/** The tools of this turn in the model form of `family`: core ∪ the view's set (those whose gates hold now; `parts` with board
 * items make it the board set) ∪ the described ones, which are dropped when the view changes (a board tool is dead weight on the
 * Plans page); none that the permission mode refuses (Read only: reads only). */
async function toolList(session, parts, family) {
  const { signal } = session;
  const ui = await invoke({ id: 'ui.state', source: 'agent:assistant', signal });
  const g = ui.ok ? ui.result.gates : {};
  const boardItems = parts.some((p) => typeof p !== 'string' && p.kind === 'items');
  const key = ui.ok ? viewOf({ view: ui.result.view, mode: ui.result.mode, hasDoc: !!g['doc.open'], nodeBoard: !!g['node.board'], boardItems }) : 'none';
  if (key !== session.viewKey) {
    session.described.clear();
    session.viewKey = key;
  }
  const res = await invoke({ id: 'app.capabilities', args: { available: true }, source: 'agent:assistant', signal });
  if (!res.ok) return [];
  const mode = modeNow();
  const allowed = (t) => !refusal(byId(commandIdOf(t.function.name)) ?? {}, mode);
  // Gemini gets the draft, board and drafts tools in every view with a draft open (it had to load the board tools with
  // commands_describe with the caret in text); the small models get the view's set. The cloud models also get computer use
  // (computer_act and the background window, §7i) in every view.
  const ids = family === 'gemini' && (key === 'editor' || key === 'board') ? [...VIEW_SETS.editor, ...VIEW_SETS.board, ...VIEW_SETS.none] : VIEW_SETS[key];
  const tools = toolsFor(res.result, { ids: [...new Set([...CORE, ...ids, ...(family === 'gemini' ? COMPUTER : [])])], $defs: MODEL_DEFS, form: 'model', family }).filter(allowed);
  return [...tools, ...[...session.described.values()].filter((d) => allowed(d) && !tools.some((t) => t.function.name === d.function.name))];
}

/** Offers the tools of a commands.describe answer from the next request on and keeps them in the session (oldest dropped past
 * DESCRIBED_CHARS); → the answer the model gets: the names and risks, not the schemas again (they are in the tools block). */
function describe(session, { tools: found, risk, unknown }, tools) {
  const size = (t) => JSON.stringify(t).length;
  for (const t of found) {
    if (NEVER.includes(commandIdOf(t.function.name)) || tools.some((x) => x.function.name === t.function.name)) continue;
    tools.push(t);
    session.described.set(t.function.name, t);
  }
  let total = [...session.described.values()].reduce((n, t) => n + size(t), 0);
  for (const [name, t] of session.described) {
    if (total <= DESCRIBED_CHARS) break;
    session.described.delete(name);
    total -= size(t);
    if (tools.includes(t)) tools.splice(tools.indexOf(t), 1);
  }
  const names = found.map((t) => t.function.name);
  const added = names.filter((n) => tools.some((t) => t.function.name === n));
  const notAdded = names.filter((n) => !added.includes(n));
  return {
    ok: true,
    result: { added, risk: Object.fromEntries(added.map((n) => [n, risk[n]])), ...(unknown.length && { unknown }), ...(notAdded.length && { notAdded }) },
  };
}

/** Runs tool call {id, name, arguments} as a command; adds its step line, which keeps the call's summary for later turns
 * (context.mjs: short arguments and a result line); → {res: the invoke answer (commands.describe: describe()'s) without its
 * pictures, pictures: [{text (with the size line, wave 2b), url}] (view.render's, context.mjs takePictures), line: the result
 * line (turnMessages)}. Only the commands of `tools` run, also as batch steps (a step id may be a tool name). */
async function runCall(session, call, tools) {
  const offered = tools.map((t) => commandIdOf(t.function.name));
  const id = commandIdOf(call.name);
  const def = id && byId(id);
  let args;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch (e) {
    args = e;
  }
  // A mark number sent as an id ("1" for the item the legend lists as "1 p8w2r5d ...") becomes that id; the step line says so.
  let swaps = [];
  if (!(args instanceof Error)) [args, swaps] = withMarkIds(args, markIds(session.legendTexts ?? []));
  const stepId = (s) => (byId(s) ? s : commandIdOf(s));
  const other = !offered.includes(id) ? call.name : id === 'batch' && [args?.steps].flat().find((s) => !offered.includes(stepId(s?.id)))?.id;
  const hint = NEVER.includes(stepId(other)) ? '' : ' (commands_describe adds it)';
  const why = def && !offered.includes(id) && refusal(def, modeNow()); // not offered in this mode: its step line says so
  // Revisions are per draft: a call with another draft's draftId (a background session) sends the rev of that draft's last read.
  const open = getState().draft?.id;
  const bg = typeof args?.draftId === 'string' && args.draftId !== open ? args.draftId : null;
  const ran = args instanceof Error
    ? { ok: false, error: { code: 'invalid_args', message: `The arguments are not JSON: ${args.message}` } }
    : why ? { ok: false, error: { code: 'denied', message: why, data: { reason: 'policy' } } }
    : other ? { ok: false, error: { code: 'unknown_command', message: `${other} is not one of your tools${hint}` } }
    : await invoke({ id: id ?? call.name, args, source: 'agent:assistant', ifRev: bg ? session.revs?.[bg] : session.lastRev, signal: session.signal });
  if (ran.ok && def.risk === 'read' && (def.group === 'doc' || ran.result?.rev !== undefined)) {
    if (ran.draftId && ran.draftId !== open) (session.revs ??= {})[ran.draftId] = ran.rev;
    else session.lastRev = ran.rev;
  }
  const { res, pictures: pics } = takePictures(ran.ok && id === 'commands.describe' ? describe(session, ran.result, tools) : ran);
  const of = id === 'view.render' ? ` of ${args?.path ? `the board at block [${args.path}]` : 'the view'}` : '';
  // A screenshot (computer_act, background_open: "1344 x 840 screenshot of the main window") has no marks.
  const pictures = pics.map(({ url, size }) => ({ url, shot: /screenshot/.test(size), text: `Picture from ${call.name}${of}${size ? `, ${size}` : ''}.${/screenshot/.test(size) ? '' : " The numbers on it are the legend's."}` }));
  if (res.error?.code === 'cancelled') return { res, pictures };
  const draftId = args?.draftId ?? res.result?.draftId;
  const title = typeof draftId === 'string' ? getState().drafts.find((d) => d.id === draftId)?.title ?? '' : '';
  const label = id === 'ui.invoke' && res.ok ? uiStep(args, res.result) : id === 'view.render' ? `Rendered the ${args?.path ? 'board' : 'view'}`
    : id === 'computer.act' && res.ok ? computerStep(args) : null;
  const line = resultLine(def?.risk, res, title) + (swaps.length ? ` (mark ${swaps.map(([n, v]) => `${n} = ${v}`).join(', ')})` : '');
  step(def, call.name, res, { id: call.id, name: call.name, args: briefArgs(call.arguments) }, line, label);
  return { res, pictures, line };
}

// The step line of a ui.invoke that ran: what was pressed (on which list row), in which area.
const UI_STEPS = {
  click: (a, r) => `Pressed "${r.name}"`,
  type: (a, r) => `Typed ${a.text.length} characters into "${r.name}"`,
  select: (a, r) => `Chose "${a.value}" in "${r.name}"`,
  key: (a, r) => `Sent ${a.key} to "${r.name}"`,
};
const uiStep = (a, r) => `${UI_STEPS[a.action](a, r)}${r.in ? ` on "${r.in}"` : ''} (${r.area})`;

// The step line of a computer_act call: what it did, in which window.
const COMPUTER_STEPS = {
  screenshot: () => 'Looked at', click: () => 'Clicked in', double_click: () => 'Double-clicked in', move: () => 'Moved the pointer in',
  drag: () => 'Dragged in', type: (a) => `Typed ${a.text?.length ?? 0} characters in`, key: (a) => `Pressed ${a.keys} in`, scroll: () => 'Scrolled',
  wait: (a) => `Waited ${a.ms} ms for`,
};
const computerStep = (a) => `${(COMPUTER_STEPS[a.action] ?? (() => 'Used'))(a)} the ${a.target === 'background' ? 'background' : 'main'} window`;

// Short transcript labels for the reads (a command's title is written for the model, not for the line).
const STEP_LABELS = { 'ui.state': 'Checked the screen', 'ui.snapshot': 'Read the controls on screen', 'app.info': 'Checked the app', 'doc.get': 'Read the draft',
  'doc.find': 'Searched the draft', 'doc.selection': 'Read the selection', 'commands.index': 'Looked up tools', 'commands.describe': 'Loaded tools',
  'board.list': 'Listed the boards', 'board.get': 'Read the board', 'board.find': 'Searched the board',
  'canvas.edit': 'Opened the canvas', 'canvas.close': 'Closed the canvas', 'background.open': 'Opened a draft in the background window',
  'background.close': 'Closed the background window' };

/** The transcript line of one command: title, result or error, and Undo for a document change; `call` and `line`, its summary
 * for the model's later turns. */
function step(def, name, res, call, line, label = null) {
  const id = addMessage({
    role: 'step',
    step: { title: label ?? STEP_LABELS[def?.id] ?? def?.title ?? name, ok: res.ok, code: res.error?.code, undoSteps: res.undoSteps ?? 0, summary: res.ok ? (def.risk === 'read' ? '' : brief(res.result)) : res.error.message, call, line },
  });
  // A background draft's step has no Undo: history.undo acts on the open draft (after opening it, Ctrl+Z undoes the step).
  if (!res.ok || def.undo !== 'doc' || !(res.undoSteps > 0) || res.draftId !== (getState().draft?.id ?? null)) return;
  const { rev, draftId } = res;
  const setStep = (patch) => patchMessage(id, (m) => ({ step: { ...m.step, ...patch } }));
  // Undo is history.undo once, only while the draft is as this step left it (else it would undo a later change).
  setStep({
    undo: async () => {
      const st = getState();
      if (st.rev !== rev || st.draft?.id !== draftId) {
        toast('The draft changed after this step: use Ctrl+Z');
        return;
      }
      setStep({ undo: null });
      const u = await invoke({ id: 'history.undo', source: 'ui' }); // the user's click: no permission mode applies
      setStep(u.ok ? { undone: true } : { summary: u.error.message });
    },
  });
}
