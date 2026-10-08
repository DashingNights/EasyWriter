import { NodeSelection } from '@tiptap/pm/state';
import { canvasEditor, liveBoard as canvasBoard } from '../../canvas.js';
import { pathOfPos } from '../../doc-path.mjs';
import { toGraph } from '../../flow/graph.mjs';
import { toMermaid } from '../../flow/mermaid.mjs';
import { flowPreset } from '../../flow/shapes.mjs';
import { statusOf } from '../../plan/plan-model.mjs';
import { planSource } from '../../plan-chart.js';
import { activeBoard } from '../../whiteboard.js';
import { selection } from '../commands.js';
import { assistantMode } from '../commands/tool-sets.mjs';
import { sortDrafts } from '../draft-order.mjs';
import { draftTag } from '../drafts-meta.js';
import { getFlow } from '../flows.js';
import { can } from '../gates.mjs';
import { getState } from '../store.js';
import { blockKind } from '../tool-rank.mjs';
import { blockAttachment, boardOrder, itemsAttachment, OTHER_ITEMS, textAttachment } from './attach.mjs';
import { situationNote } from './context.mjs';
import { boardPicture } from './marks.mjs';
import { pickPlaybooks } from './playbooks.mjs';
import { sessionIds } from './sessions.js';

// What the user has selected now, as an assistant attachment (attach.mjs), or null: the items selected on the canvas being edited
// or the active board, else (the editor shown) the editor's text or node selection. Tool search takes it when it opens (SPEC §7c);
// the chat box when it gains the focus (chat-input.js autoPill). A canvas, flowchart canvas, image or whiteboard, and board items,
// also carry `picture()`, its rendering for the model with its size line (SPEC §7i Vision), with numbered marks (`marked`, marks.mjs) except an image's;
// situation() builds the note each turn starts with.

const mermaidOf = (items) => toMermaid(toGraph(items, { preset: flowPreset(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark') })).text;

function planOf(attrs) {
  const ctx = attrs.frozen?.ctx ?? planSource.context(attrs.planId);
  if (!ctx) return null;
  const counts = [{ id: null, name: 'No status' }, ...ctx.plan.columns]
    .map((c) => [c.name, ctx.plan.tickets.filter((t) => (statusOf(t, ctx) ?? null) === c.id).length]).filter(([, n]) => n);
  return { title: ctx.plan.title, view: attrs.view, total: ctx.plan.tickets.length, counts, frozen: !!attrs.frozen };
}

/** Board {w, h, bg, items} as marks.mjs boardPicture draws it, the badges in the order `order` (the attachment's legend) → {url
 * (a PNG data URL), size (its size line, wave 2b: "1280 x 512 of a 1000 x 400 board"; `what` 'image' for an image)}. */
const picture = (board, order, what) => boardPicture(board, { theme: getState().settings?.theme === 'light' ? 'light' : 'dark', order, what })
  .then((p) => ({ url: p.url, size: p.size }));

export function captureSelection() {
  const { editor: ed, view } = getState();
  const doc = ed?.state.doc;
  const session = canvasEditor.get();
  const board = session?.board ?? activeBoard.get();
  if (board?.sel.size) {
    let pos = session?.target.owner?.getPos?.();
    if (!session) doc?.forEach((n, off) => { if (ed.view.nodeDOM(off)?.wbView === board) pos = off; });
    const path = typeof pos === 'number' ? ` at block [${pathOfPos(doc, pos)}]` : '';
    const where = view.type === 'flows' ? 'the flowchart in the library editor' : session ? `the canvas being edited${path}` : `the whiteboard${path}`;
    const sel = board.items.filter((i) => board.sel.has(i.id));
    const { w, h } = board.size(); // a whiteboard's drawn width and height, a canvas's artboard
    const items = [...board.items];
    const att = itemsAttachment(sel, where, items);
    // The whole board, the selected items' marks first (their legend lines come first, attach.mjs boardOrder).
    return Object.assign(att, { marked: true, picture: () => picture({ w, h, bg: board.bg, items }, boardOrder(sel, items)) });
  }
  if (!ed || !can('view.editor', { view })) return null; // a workspace hides the document
  const sel = ed.state.selection;
  if (sel instanceof NodeSelection) {
    const { type: { name: type }, attrs } = sel.node;
    const kind = blockKind(type, attrs) ?? type;
    const dom = ed.view.nodeDOM(sel.from);
    const b = dom?.scView ? canvasBoard(dom.scView) : attrs; // a synced canvas shows its library flowchart's board
    const items = b.items;
    const att = blockAttachment(kind, {
      path: pathOfPos(doc, sel.from), type, attrs: { ...attrs, items },
      ...(kind === 'flowchart' && { mermaid: mermaidOf(items ?? []), flowTitle: attrs.flow ? getFlow(attrs.flow.id)?.title ?? '' : '' }),
      ...(kind === 'planChart' && { plan: planOf(attrs) }),
    });
    const marked = kind !== 'image'; // a picture's own content is what the model looks at
    if (type === 'canvas') Object.assign(att, { marked, picture: () => picture({ w: b.w, h: b.h, bg: b.bg, items }, marked ? items : [], marked ? 'board' : 'image') });
    const width = dom?.offsetWidth || getState().settings?.forumWidth || 1000;
    if (type === 'whiteboard') Object.assign(att, { marked, picture: () => picture({ w: width, h: attrs.height, bg: attrs.bg, items }, items) });
    return att;
  }
  if (sel.empty) return null;
  let s = selection();
  if (s.kind !== 'text') { // table cells
    const c = sel.content().content;
    s = { path: pathOfPos(doc, sel.from), toPath: pathOfPos(doc, sel.to), text: c.textBetween(0, c.size, '\n', '\n'), context: '' };
  }
  return s.text.trim() ? textAttachment(s) : null;
}

/** The situation note (context.mjs situationNote) for a message with `parts`: the page, the open draft, its thread, what is
 * selected (and whether it is attached; board items the message attaches count as selected), the canvas being edited, the drafts of the thread (else all drafts) and the playbooks
 * for the message (playbooks.mjs pickPlaybooks; `viewKey`: the turn's tool-set key, tool-sets.mjs viewOf). */
export function situation(parts = [], viewKey = '') {
  const st = getState();
  const { view, settings = {} } = st;
  const draft = st.draft;
  let sel = null;
  try {
    sel = captureSelection();
  } catch {}
  // Board items the message attaches (their pill was captured while the board was active; the chat box's focus ends that,
  // whiteboard.js updateActive) are still the selection (wave 1c).
  const items = parts.find((p) => typeof p !== 'string' && p.kind === 'items');
  if (items && sel?.kind !== 'items') sel = items;
  // Its first line, the selected items' lines after it without their numbers: "1 selected item on the whiteboard at block [4]:
  // g3n7c1f shape rect "Gearbox" at 40,40 size 160x80".
  const lines = sel?.body.split('\n') ?? [];
  const others = lines.indexOf(OTHER_ITEMS);
  const summary = sel?.kind === 'items' ? `${lines[0]}: ${lines.slice(1, others < 0 ? undefined : others).map((l) => l.replace(/^(- |\d+ )/, '')).join('; ')}`
    : lines.slice(0, sel?.kind === 'text' ? 2 : 1).join(' ');
  const tag = (id) => draftTag(settings, id)?.name ?? '';
  const scope = draft?.threadUrl ? 'thread' : 'all';
  const list = sortDrafts(st.drafts, settings.draftOrder).filter((d) => scope === 'all' || d.threadUrl === draft.threadUrl);
  const pos = canvasEditor.get()?.target.owner?.getPos?.();
  const { permission } = assistantMode(settings.assistant);
  const google = ['google', 'deepseek', 'qwen'].includes(settings.assistant?.provider); // the cloud models' note
  return situationNote({
    page: view.type,
    plan: view.type === 'plan' ? planSource.context(view.planId)?.plan.title ?? '' : '',
    flow: view.type === 'flows' && view.flowId ? getFlow(view.flowId)?.title ?? '' : '',
    draft: draft && { title: draft.title, tag: draft.id ? tag(draft.id) : '' },
    thread: draft?.threadUrl ? (settings.threads ?? []).find((t) => t.url === draft.threadUrl)?.title || draft.threadUrl : '',
    selection: sel && {
      label: sel.label,
      summary,
      attached: parts.some((p) => typeof p !== 'string' && p.kind === sel.kind && p.body === sel.body),
    },
    canvas: typeof pos === 'number' && st.editor ? `the canvas at block [${pathOfPos(st.editor.state.doc, pos)}]` : '',
    background: sessionIds().map((id) => st.drafts.find((d) => d.id === id)?.title ?? ''),
    drafts: list.map((d) => ({ title: d.id === draft?.id ? draft.title : d.title, tag: tag(d.id), ...(google && { id: d.id }) })),
    ...(google && { draftId: draft?.id ?? '', outline: st.editor && draft ? outlineLines(st.editor.state.doc) : [] }),
    total: list.length,
    scope,
    permission,
    playbooks: google ? [] : pickPlaybooks({ parts, view: viewKey, permission }),
  });
}

const OUTLINE_BLOCKS = 120; // blocks in the note's outline; a longer draft says how many more

/** The open draft's top-level blocks for the situation note (Google AI): "[3] paragraph: The first words..." per block, a board as
 * "[6] whiteboard, 7 items, 989 high" (a canvas: its size), the start of its text cut at 100 characters with its length. */
function outlineLines(doc) {
  const out = [];
  doc.forEach((n, _, i) => {
    if (i >= OUTLINE_BLOCKS) return;
    const a = n.attrs ?? {};
    if (Array.isArray(a.items)) {
      out.push(`[${i}] ${n.type.name}, ${a.items.length} item${a.items.length === 1 ? '' : 's'}${n.type.name === 'whiteboard' ? `, ${a.height} high` : a.w ? `, ${a.w} x ${a.h}` : ''}`);
      return;
    }
    const t = n.textContent.replace(/\s+/g, ' ').trim();
    out.push(`[${i}] ${n.type.name}${n.type.name === 'heading' ? ` ${a.level}` : ''}${t ? `: ${t.length > 100 ? `${t.slice(0, 100)}... (${t.length} characters)` : t}` : ''}`);
  });
  if (doc.childCount > OUTLINE_BLOCKS) out.push(`... ${doc.childCount - OUTLINE_BLOCKS} more blocks (doc_get outline lists them)`);
  return out;
}
