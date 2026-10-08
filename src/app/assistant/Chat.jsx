import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { ArrowUp, Ban, Bot, Brain, Check, ChevronDown, CircleAlert, ImagePlus, LoaderCircle, MessageSquare, MessageSquarePlus, Mic, Square, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
// import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'; // LOCAL LLM (commented out 2026-10-07): the install dialog
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { canvasEditor } from '../../canvas.js';
import { activeBoard } from '../../whiteboard.js';
import { openSettings, refocusEditor } from '../actions.js';
import { assistantMode } from '../commands/tool-sets.mjs';
import { AgentAsk } from '../components/AgentAsk.jsx';
import { Tip } from '../components/Tip.jsx';
import { joinText } from '../dictation/core.mjs';
import { hold } from '../dictation/Dictation.jsx';
import { pttDown, pttUp, warm as warmDictation } from '../dictation/dictation.js';
import { can } from '../gates.mjs';
import { keyIs, withKey } from '../keybinds.js';
import { getState, setState, useStore } from '../store.js';
import { viewportRect } from '../viewport.js';
// LOCAL LLM (commented out 2026-10-07): BACKENDS, cancelInstall, closeInstall, install, openInstall, size.
import {
  ASSISTANT_DEFAULTS, clearPending, closeChat, CTX, MODEL_FIELD, modelChoices, newChat, pickModel, refreshStatus, saveAssistant, send, setThinking, stop, EFFORTS,
  thinkingEffort, toggleChat, usable, useAssistant, wake,
} from './assistant.js';
import { BackgroundPane } from './BackgroundPane.jsx';
import { captureSelection } from './capture.js';
import { autoPill, chatEditor, dictateInto, dropWaves, imageAttachment, inlineOf, partsOf, PILL_CLASS } from './chat-input.js';
import { Markdown } from './Markdown.jsx';
import { anchorPanel, dragPanel, placePanel } from './panel.mjs';

// The assistant's chat chrome (SPEC §7i; automation plan §13.4), mounted once in the main column's area (App.jsx) after the
// dictation chrome: the chat button (the mirror of the push-to-talk island at the bottom-right; in a workspace directly above
// that island), the panel (floating over the page in its viewport, movable and resizable from its corners, anchored to the
// nearer viewport edges; never changes [data-viewport]) and the install dialog.

const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 13;
const keep = (e) => e.preventDefault(); // buttons that never take the focus
const MODE_BADGE = { ask: 'Ask first', readonly: 'Read only', all: 'Allow all' }; // the permission mode when it is not Standard
const CORNER = 10; // px from a corner that resizes
// const PRIVACY = 'Everything you send stays on this computer.'; // LOCAL LLM (commented out 2026-10-07)
const privacy = (label = 'Google AI') => `What you send, attachments and pictures included, goes to ${label}.`; // status().providerLabel

function ChatButton({ islandRef }) {
  const a = useAssistant();
  const workspace = !can('view.editor', { view: useStore((s) => s.view) });
  const Icon = a.turn ? Bot : MessageSquare;
  return (
    <div ref={islandRef} data-chat-island
      className={cn('absolute z-30 flex rounded-island border shadow-lg', workspace
        ? 'right-4 bottom-[calc(2.75rem+2px)] bg-card/70 backdrop-blur-[2px]' : 'right-2 bottom-[calc(3.75rem+2px)] bg-card p-1')}>
      <Tip title={withKey('Assistant', 'app.assistant')} side="left">
        <Button variant="ghost" size={workspace ? 'icon-xs' : 'icon-sm'} aria-label="Assistant" aria-expanded={a.open} aria-controls="assistant-panel"
          onMouseDown={keep} onClick={() => toggleChat()}>
          <Icon className={workspace ? 'size-3.5' : undefined} />
        </Button>
      </Tip>
    </div>
  );
}

/** The main column's area, the page's viewport and the chat button as client rects, measured again when the view, the window,
 * the area or the viewport changes size. */
function useFrame(islandRef) {
  const view = useStore((s) => s.view);
  const [frame, setFrame] = useState(null);
  useLayoutEffect(() => {
    const box = islandRef.current.parentElement;
    const measure = () => {
      const v = viewportRect();
      setFrame({ box: box.getBoundingClientRect(), vp: v, btn: islandRef.current.getBoundingClientRect() });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(viewportRect().el);
    addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      removeEventListener('resize', measure);
    };
  }, [view]);
  return frame;
}

/** The model the server runs, for the header: the pin's label, a custom file's name, or an external server's host. */
const modelName = (st) => (st?.model?.label === 'Custom model' ? st.model.file : st?.model?.label ?? (st?.url ? new URL(st.url).host : ''));

function StatusDot({ server }) {
  const [title, color] = !server ? ['Not installed', 'bg-muted-foreground/50']
    : server.state === 'error' ? ['Error', 'bg-destructive']
      : server.state === 'starting' ? ['Loading the model', 'bg-amber-400']
        : server.state !== 'ready' ? ['Not running', 'bg-muted-foreground/50']
          : server.sleeping ? ['Asleep', 'bg-amber-400'] : ['Ready', 'bg-green-500'];
  return <span role="img" aria-label={title} title={title} data-status={server?.state ?? 'none'} className={cn('size-2 shrink-0 rounded-full', color)} />;
}

/** How full the model's context is: the last request's prompt + completion tokens over the model's context window (`window`,
 * status().ctx: the local server's -c, an external server's n_ctx, a Google model's input limit; a compaction runs at 80 %, SPEC
 * §7i Context). */
function ContextRing({ usage, window }) {
  const used = usage?.used ?? 0;
  const ctx = window || usage?.ctx || CTX;
  const f = Math.min(1, used / ctx);
  const C = 2 * Math.PI * 6;
  const label = `${used.toLocaleString('en-US')} / ${ctx.toLocaleString('en-US')} tokens`;
  const level = f >= 0.9 ? 'high' : f >= 0.7 ? 'warn' : 'ok';
  return (
    <Tip title={label} side="top">
      <span role="img" aria-label={label} data-context-ring={level}
        className={cn('flex size-8 items-center justify-center', { ok: 'text-muted-foreground', warn: 'text-amber-500', high: 'text-destructive' }[level])}>
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={C} strokeDashoffset={C * (1 - f)} />
        </svg>
      </span>
    </Tip>
  );
}

function Message({ m, dim }) {
  if (m.role === 'divider') {
    return (
      <div data-role="divider" className={cn('flex items-center gap-2 text-xs text-muted-foreground', dim && 'opacity-50')}>
        <span className="h-px flex-1 bg-border" />
        {m.pending && <LoaderCircle className="size-3.5 animate-spin" />}{m.text}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  if (m.role === 'user') {
    // Its attachments as a row above its text, as they sat in the tray (an image as its thumbnail); older messages kept pills inline.
    const atts = m.parts?.filter((p) => typeof p !== 'string') ?? [];
    const words = m.parts ? m.parts.filter((p) => typeof p === 'string').join('').trim() : m.text;
    return (
      <div data-role="user" className={cn('ml-8 grid gap-1.5 self-end rounded-lg bg-secondary px-2.5 py-1.5 select-text', dim && 'opacity-50')}>
        {atts.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {atts.map((p, i) => (p.thumb
              ? <img key={i} data-pill src={p.thumb} alt={p.label} title={p.label} className="h-12 max-w-24 rounded-md border object-cover" />
              : <span key={i} data-pill className={cn(PILL_CLASS, 'bg-background/60')}>{p.label}</span>))}
          </div>
        )}
        {words && <div className="break-words whitespace-pre-wrap">{words}</div>}
      </div>
    );
  }
  if (m.role === 'step') {
    const s = m.step ?? {};
    const Icon = s.ok ? Check : s.code === 'denied' ? Ban : CircleAlert;
    return (
      <div data-role="step" data-ok={s.ok} className={cn('flex min-h-6 items-center gap-1.5 text-xs text-muted-foreground', dim && 'opacity-50')}>
        <Icon className={cn('size-3.5 shrink-0', !s.ok && s.code !== 'denied' && 'text-destructive')} />
        <span className="min-w-0 flex-1 truncate" title={s.summary}>{s.title}{s.summary ? `: ${s.summary}` : ''}</span>
        {s.undo && <Button variant="ghost" size="xs" onMouseDown={keep} onClick={s.undo}>Undo</Button>}
        {s.undone && <span className="px-2">Undone</span>}
      </div>
    );
  }
  if (!m.text && !m.streaming && !m.reasoning && !m.error) return null; // a completion that only called a tool
  return (
    <div data-role="assistant" className={cn('mr-4 grid gap-1 select-text', dim && 'opacity-50')}>
      {m.reasoning && (
        <details data-reasoning className="rounded-md border px-2 py-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Reasoning</summary>
          <div className="mt-1 break-words whitespace-pre-wrap">{m.reasoning}</div>
        </details>
      )}
      {(m.text || m.streaming) && (
        <Markdown text={m.text}>
          {m.streaming && <span data-caret aria-hidden className="inline-block h-[1em] w-[0.45em] animate-pulse bg-foreground/70" />}
        </Markdown>
      )}
      {m.error && <p className="text-destructive">{m.error}</p>}
    </div>
  );
}

/** The header's model menu (2026-10-08): the model of the next request among modelChoices (Settings > Assistant enables Qwen
 * Cloud's), saved at once. With one choice it is the model's name only. */
function ModelMenu({ edRef, name }) {
  const a = { ...ASSISTANT_DEFAULTS, ...useStore((s) => s.settings?.assistant) }; // a settings file may predate the Qwen fields
  const choices = modelChoices(a);
  const current = `${a.provider}|${a[MODEL_FIELD[a.provider]]}`;
  const label = choices.find(([p, id]) => `${p}|${id}` === current)?.[2] ?? name;
  if (choices.length < 2) return name ? <span data-model-name className="min-w-0 truncate text-xs text-muted-foreground" title={name}>{name}</span> : null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" data-model-name aria-label="Model" onMouseDown={keep}
          className="flex min-w-0 items-center gap-0.5 rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
          <span className="truncate">{label}</span><ChevronDown className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" data-model-menu
        onCloseAutoFocus={(e) => { if (edRef.current) { e.preventDefault(); edRef.current.commands.focus(); } }}
        onKeyDown={(e) => e.key === 'Escape' && e.stopPropagation()}>
        {choices.map(([p, id, text]) => (
          <DropdownMenuCheckboxItem key={`${p}|${id}`} checked={`${p}|${id}` === current} onCheckedChange={() => pickModel(p, id)}>
            <span className="grid"><span>{text}</span>{text !== id && <span className="text-xs text-muted-foreground">{id}</span>}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The header's Thinking menu (settings.assistant.thinking, saved at once, kept across chats and restarts): the brain looks pressed
 * at Low, Medium or High. Closing it puts the focus back in the text box; Esc in it closes the menu only, not the panel. */
function ThinkingMenu({ edRef }) {
  const effort = thinkingEffort(useStore((s) => s.settings?.assistant?.thinking));
  const provider = useStore((s) => s.settings?.assistant?.provider); // EFFORTS' fourth to sixth fields: Gemini, DeepSeek, Qwen Cloud
  const refocus = (e) => {
    if (!edRef.current) return;
    e.preventDefault();
    edRef.current.commands.focus();
  };
  return (
    <DropdownMenu modal={false}>
      <Tip title="Thinking" side="top">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Thinking" data-thinking={effort} onMouseDown={keep}
            className={cn('size-7', effort !== 'auto' && 'bg-accent text-accent-foreground')}>
            <Brain />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-72" data-thinking-menu onCloseAutoFocus={refocus}
        onKeyDown={(e) => e.key === 'Escape' && e.stopPropagation()}>
        {EFFORTS.map(([id, label, line, gemini, deepseek, qwen]) => (
          <DropdownMenuCheckboxItem key={id} checked={id === effort} onCheckedChange={() => setThinking(id)}>
            <span className="grid"><span>{label}</span><span className="text-xs text-muted-foreground">{{ deepseek, google: gemini, qwen }[provider] ?? line}</span></span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

let unsent = null; // the text box's content (TipTap JSON) while the panel is closed
let unsentAtts = []; // the tray's attachments while the panel is closed
const MAX_IMAGES = 6; // images in one message (each is about 1,000 tokens or more). ponytail: a fixed cap, a setting if it bites
const BOX = 'max-h-[calc(4lh+0.75rem)] min-h-8 w-full overflow-y-auto rounded-md border border-input bg-background/60 px-2 py-1.5 text-sm break-words '
  + 'outline-none focus-visible:border-ring dark:bg-input/30';

function ChatPanel({ islandRef }) {
  const a = useAssistant();
  const frame = useFrame(islandRef);
  const conf = useStore((s) => s.settings?.assistant);
  const stored = conf?.panel ?? null;
  const [live, setLive] = useState(null); // the rect while dragged or resized, until the anchored place is saved
  const [empty, setEmpty] = useState(true); // nothing to send
  const [blank, setBlank] = useState(true); // nothing at all in the text box: the placeholder shows
  const [locked, setLocked] = useState(false); // read-only while the dictated text is transcribed
  const panelRef = useRef(null);
  const scrollRef = useRef(null);
  const boxRef = useRef(null);
  const edRef = useRef(null); // the text box's editor (chat-input.js)
  const autoRef = useRef(null); // its selection attachment (chat-input.js autoPill)
  // The tray above the text box (2026-10-07): the message's attachments, the selection's and tool search's and the user's images.
  const [atts, setAtts] = useState(() => unsentAtts);
  const attsRef = useRef(atts);
  const tray = useRef({ get: () => attsRef.current, set: (list) => { attsRef.current = list; setAtts(list); } }).current;
  const fileRef = useRef(null);
  const imagesRef = useRef(null); // addImages, for the text box's paste and drop
  const editor = useStore((st) => st.editor); // the draft's editor, whose selection the pill follows
  // The title of the draft the assistant last wrote to in the background this turn (§7i Background drafts), for the status line.
  const working = useStore((st) => (st.bgWrites.length ? st.drafts.find((d) => d.id === st.bgWrites.at(-1))?.title || 'Untitled draft' : ''));
  // The draft in the background window of computer use (§7i Background window) and whether its pane shows.
  const worker = useStore((st) => st.worker?.title ?? null);
  const pane = useStore((st) => st.workerPane);
  const submitRef = useRef(null);
  const drag = useRef(null);
  const stick = useRef(true); // kept at the end while text streams, unless the user scrolled up
  const [mic, setMic] = useState(null); // the mic's dictation session {recording, error, ...}, kept until the next press
  const dictation = useRef(null); // the waveform's session in the text box (dictateInto), until the final text replaces it
  const held = useRef(false); // the mic is held: closing the panel meanwhile releases it (the button's capture is lost unseen)
  const s = a.status;
  const srv = s?.server;
  const ready = usable(s);
  const hasBox = !!frame && ready;
  useEffect(() => { // the text box, opened for typing; its content kept while the panel is closed
    if (!hasBox) return undefined;
    const changed = (e) => {
      setEmpty(!partsOf(e.state.doc).length);
      setBlank(e.isEmpty);
    };
    const ed = (edRef.current = chatEditor({
      element: boxRef.current, content: unsent, submit: () => submitRef.current(), onChange: changed, onImages: (files) => imagesRef.current?.(files),
      attributes: { 'aria-label': 'Message', 'aria-placeholder': 'Message the assistant', class: BOX },
    }));
    autoRef.current = autoPill(ed, captureSelection, tray); // before the focus below: opening the panel attaches the selection
    changed(ed);
    ed.commands.focus('end');
    return () => {
      dropWaves(ed);
      unsent = ed.getJSON();
      unsentAtts = attsRef.current;
      ed.destroy();
      edRef.current = null;
      autoRef.current = null;
      dictation.current = null;
      setLocked(false);
    };
  }, [hasBox]);
  useEffect(() => { // tool search asked while a turn ran: its message waits, the attachments in the tray and the words in the box
    const ed = edRef.current;
    if (!a.pending || !ed) return;
    const keyOf = (x) => `${x.kind}|${x.body}`;
    const keys = new Set(tray.get().map(keyOf));
    const more = a.pending.filter((p) => typeof p !== 'string' && !keys.has(keyOf(p))).map((p) => ({ ...p, id: p.id ?? crypto.randomUUID() }));
    if (more.length) tray.set([...tray.get(), ...more]);
    const words = a.pending.filter((p) => typeof p === 'string').join('').trim();
    if (words) ed.chain().focus('end').insertContent([...(ed.isEmpty ? [] : [{ type: 'text', text: ' ' }]), ...inlineOf([words])]).run();
    else ed.commands.focus('end');
    clearPending();
  }, [a.pending, hasBox]);
  useEffect(() => { // the pill follows the selection: the draft's, the active board's items, the canvas being edited
    const auto = autoRef.current;
    if (!auto) return undefined;
    let offBoard = () => {};
    const onBoard = () => {
      offBoard();
      offBoard = (canvasEditor.get()?.board ?? activeBoard.get())?.subscribe(auto.follow) ?? (() => {});
      auto.follow();
    };
    editor?.on('selectionUpdate', auto.follow);
    const offs = [activeBoard.subscribe(onBoard), canvasEditor.subscribe(onBoard)];
    onBoard();
    return () => {
      editor?.off('selectionUpdate', auto.follow);
      offs.forEach((off) => off());
      offBoard();
    };
  }, [hasBox, editor]);
  useEffect(() => { refreshStatus(); }, [conf]); // Settings changed it meanwhile
  useEffect(() => () => { if (held.current) pttUp(); }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [a.messages, !!frame, ready]);
  if (!frame) return null;

  const r0 = rem();
  const m = 0.5 * r0; // kept to every viewport edge: the chat button's inset, so the default place lines up with it
  const min = { w: 18 * r0, h: 20 * r0 };
  const { box, vp, btn } = frame;
  // Default place: right edges aligned with the chat button, the bottom 8 px above it, 26 × 36 rem.
  const place = stored ?? { x: 'right', dx: vp.right - btn.right, y: 'bottom', dy: vp.bottom - btn.top + 8, w: 26 * r0, h: 36 * r0 };
  const r = live ?? placePanel(place, vp, min, m);

  const cornerAt = (e) => {
    if (e.target.closest('button')) return null;
    const b = panelRef.current.getBoundingClientRect();
    const h = e.clientX - b.left < CORNER ? 'w' : b.right - e.clientX < CORNER ? 'e' : '';
    const v = e.clientY - b.top < CORNER ? 'n' : b.bottom - e.clientY < CORNER ? 's' : '';
    return h && v ? v + h : null;
  };
  // Corners resize (capture: before the text box under one); the panel's empty chrome and the header row move it.
  const onPointerDownCapture = (e) => {
    if (e.button || !panelRef.current.contains(e.target)) return; // not a press in a menu portalled out of the panel
    const corner = cornerAt(e);
    const grip = e.target === panelRef.current || (e.target.closest('[data-grip]') && !e.target.closest('button'));
    if (!corner && !grip) return;
    e.preventDefault();
    e.stopPropagation();
    panelRef.current.setPointerCapture(e.pointerId);
    drag.current = { corner, x: e.clientX, y: e.clientY, r, last: null };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (d) return setLive((d.last = dragPanel(d.r, d.corner, e.clientX - d.x, e.clientY - d.y, vp, min, m)));
    const corner = cornerAt(e);
    panelRef.current.style.cursor = corner ? (corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize') : '';
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.last) saveAssistant({ panel: anchorPanel(d.last, vp) }).finally(() => setLive(null)); // a click moves nothing
  };

  // The mic (hold to talk, as push-to-talk, §7h): a live waveform sits in the text box at the caret while it is held (no partial
  // text); on release the box is read-only, the waveform working, until the final text replaces it; it never sends. Holding it
  // also wakes the assistant. The focus stays where it is while held (a Space / Enter hold must get its keyup) and goes to the
  // text box at the end.
  const micDown = () => {
    const ed = edRef.current;
    if (!ed || held.current || dictation.current) return;
    held.current = true;
    wake();
    const d = (dictation.current = dictateInto(ed));
    pttDown((o) => {
      if (dictation.current !== d) return; // a session from before the text box was closed: its box is gone
      setMic(o);
      if (!o.done) return;
      dictation.current = null;
      setLocked(false);
      d.end(joinText(o.committed, o.partial)); // nothing said, an error or a cancel: the waveform goes, nothing is added
    });
  };
  const micUp = () => {
    if (!held.current) return;
    held.current = false;
    pttUp();
    if (dictation.current?.working()) setLocked(true);
    else edRef.current?.view.focus();
  };

  // Images pasted or dropped into the box or the panel, or picked with the Attach button, into the tray (MAX_IMAGES a message).
  const addImages = async (files) => {
    const inTray = tray.get().filter((x) => x.kind === 'image').length;
    const room = MAX_IMAGES - inTray;
    if (room <= 0) return;
    const sent = a.messages.reduce((n, x) => n + (x.parts?.filter((p) => p?.kind === 'image').length ?? 0), 0);
    const made = (await Promise.all([...files].slice(0, room).map((f, i) => imageAttachment(f, sent + inTray + 1 + i)))).filter(Boolean);
    if (made.length) tray.set([...tray.get(), ...made]);
    edRef.current?.commands.focus();
  };
  imagesRef.current = addImages;
  const removeAtt = (att) => {
    tray.set(tray.get().filter((x) => x.id !== att.id));
    autoRef.current?.removed(att);
    edRef.current?.commands.focus();
  };
  const submit = () => {
    const ed = edRef.current;
    if (!ed || dictation.current || !send([...tray.get(), ...partsOf(ed.state.doc)])) return;
    stick.current = true;
    autoRef.current?.release();
    tray.set([]);
    ed.commands.clearContent(true);
  };
  const startNewChat = () => { // the tray's attachments go too; the typed text stays
    newChat();
    const ed = edRef.current;
    if (!ed) return;
    autoRef.current?.release();
    tray.set([]);
    const { tr } = ed.state; // pills from before the tray, inline in kept text
    ed.state.doc.descendants((n, pos) => { if (n.type.name === 'pill') tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + 1)); });
    if (tr.docChanged) ed.view.dispatch(tr);
  };
  const cut = a.messages.findLastIndex((x) => x.role === 'divider'); // messages before it are not sent: dimmed
  submitRef.current = submit;
  // const missing = s?.missing.reduce((n, x) => n + x.bytes, 0); // LOCAL LLM (commented out 2026-10-07): the install size
  const badge = MODE_BADGE[assistantMode(conf).permission];
  return (
    <div ref={panelRef} id="assistant-panel" data-assistant-panel role="region" aria-label="Assistant"
      className="absolute z-[44] flex flex-col rounded-island border bg-card/70 p-1 text-sm shadow-xl backdrop-blur-[2px]"
      style={{ left: vp.left - box.left + r.left, top: vp.top - box.top + r.top, width: r.width, height: r.height }}
      onPointerDownCapture={onPointerDownCapture} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onLostPointerCapture={onPointerUp}
      onDragOver={(e) => { if (ready && [...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) e.preventDefault(); }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
        if (!ready || !files.length) return;
        e.preventDefault();
        addImages(files);
      }}
      onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), closeChat())}>
      <div data-grip className="flex shrink-0 items-center gap-1.5 py-0.5 pr-0.5 pl-2 select-none">
        <span className="font-medium">Assistant</span>
        <StatusDot server={ready ? srv : null} />
        {ready && <ModelMenu edRef={edRef} name={modelName(s)} />}
        {badge && (
          <Tip title="Permissions. Change them in Settings." side="top">
            <Badge asChild variant="outline">
              <button type="button" data-permission-badge className="cursor-pointer font-normal text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onMouseDown={keep} onClick={() => openSettings('assistant')}>{badge}</button>
            </Badge>
          </Tip>
        )}
        <span className="flex-1" />
        {ready && (
          <Tip title="New chat" side="top">
            <Button variant="ghost" size="icon-sm" aria-label="New chat" className="size-7" onMouseDown={keep} onClick={startNewChat}><MessageSquarePlus /></Button>
          </Tip>
        )}
        <ThinkingMenu edRef={edRef} />
        <Tip title="Close (Esc)" side="top">
          <Button variant="ghost" size="icon-sm" aria-label="Close" className="size-7" onMouseDown={keep} onClick={closeChat}><X /></Button>
        </Tip>
      </div>
      {!s ? (
        <>
          <p className="flex-1 px-2 py-1 text-muted-foreground">Checking...</p>
          <AgentAsk inline />
        </>
      ) : !ready ? (
        <div data-not-installed className="flex flex-1 flex-col items-start gap-2 px-2 py-1">
          {/* LOCAL LLM (commented out 2026-10-07): the install offer, "It is not installed yet. After one download it works offline."
              or "It is turned off." with Install... (N GB) / Turn on... (openInstall). */}
          <p>{privacy(s?.providerLabel)}</p>
          <p className="text-muted-foreground">Add your {s?.providerLabel ?? 'Google AI'} API key in Settings.</p>
          <Button size="sm" onMouseDown={keep} onClick={() => openSettings('assistant')}>Open Settings</Button>
          <span className="flex-1" />
          <AgentAsk inline />
        </div>
      ) : (
        <>
          <div ref={scrollRef} data-chat-messages className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-1"
            onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16; }}>
            {!a.messages.length && <p className="text-muted-foreground">{privacy(s?.providerLabel)}</p>}
            {a.messages.map((msg, i) => <Message key={msg.id} m={msg} dim={i < cut} />)}
          </div>
          {/* LOCAL LLM (commented out 2026-10-07): the local server's status lines, its error with Retry (warm) and "Loading the
              model..." / "Waking...". */}
          {a.turn && working && (
            <div data-chat-status data-chat-working className="flex shrink-0 items-center gap-1.5 px-2 py-1 text-muted-foreground">
              <LoaderCircle className="size-3.5 shrink-0 animate-spin" /><span className="min-w-0 truncate">Working on "{working}"</span>
            </div>
          )}
          {worker !== null && (
            <div data-chat-status data-chat-background className="flex shrink-0 items-center gap-1.5 px-2 py-1 text-muted-foreground">
              <Bot className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">Working in the background on "{worker}"</span>
              <Button variant="outline" size="xs" aria-pressed={pane} onMouseDown={keep} onClick={() => setState({ workerPane: !pane })}>{pane ? 'Hide' : 'Show'}</Button>
            </div>
          )}
          {mic?.error && <p data-chat-mic-error className="shrink-0 px-2 py-1 text-xs text-destructive">{mic.error}</p>}
          <AgentAsk inline />
          {atts.length > 0 && (
            <div data-chat-tray className="flex shrink-0 flex-wrap gap-1.5 px-2 pt-1.5">
              {atts.map((t) => (
                <div key={t.id} data-tray-item={t.kind} className="relative">
                  {t.thumb
                    ? <img src={t.thumb} alt={t.label} title={t.label} className="h-12 max-w-24 rounded-md border object-cover" />
                    : <span className={cn(PILL_CLASS, 'mx-0 pr-5 leading-6')} title={t.label}>{t.label}</span>}
                  <button type="button" aria-label={`Remove ${t.label}`} onMouseDown={keep} onClick={() => removeAtt(t)}
                    className={cn('absolute flex size-4 items-center justify-center rounded-full',
                      t.thumb ? '-top-1.5 -right-1.5 bg-foreground/80 text-background hover:bg-foreground'
                        : 'top-1 right-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground')}>
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <form className="flex shrink-0 items-end gap-1 p-1" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <Tip title="Hold to dictate" side="top">
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Hold to dictate into the message" aria-pressed={!!mic?.recording}
                disabled={locked} onPointerEnter={warmDictation} {...hold(micDown, micUp)}
                className={cn(mic?.recording && 'bg-destructive/20 text-destructive hover:bg-destructive/25 hover:text-destructive')}>
                <Mic />
              </Button>
            </Tip>
            <Tip title="Attach an image" side="top">
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Attach an image" disabled={locked} onMouseDown={keep}
                onClick={() => fileRef.current?.click()}>
                <ImagePlus />
              </Button>
            </Tip>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
            <div className="relative min-w-0 flex-1">
              <div ref={boxRef} />
              {blank && <span aria-hidden className="pointer-events-none absolute top-1.5 left-[calc(0.5rem+1px)] text-sm text-muted-foreground">Message the assistant</span>}
            </div>
            <ContextRing usage={a.usage} window={s?.ctx} />
            {a.turn ? (
              <Tip title="Stop" side="top">
                <Button type="button" variant="secondary" size="icon-sm" aria-label="Stop" onMouseDown={keep} onClick={stop}><Square className="fill-current" /></Button>
              </Tip>
            ) : (
              <Tip title="Send (Enter)" side="top">
                <Button type="submit" size="icon-sm" aria-label="Send" disabled={(empty && !atts.length) || locked || !!mic?.recording} onMouseDown={keep}><ArrowUp /></Button>
              </Tip>
            )}
          </form>
        </>
      )}
    </div>
  );
}

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// /** First use: what is downloaded and from where, the backend, the licences, then the download with progress. */
// function InstallForm({ open }) {
//   const [status, setStatus] = useState(null);
//   const [phase, setPhase] = useState('ready'); // 'ready' | 'download' | 'error'
//   const [error, setError] = useState('');
//   const [progress, setProgress] = useState(null);
//   useEffect(() => {
//     let live = true;
//     window.api.assistant.status().then((st) => live && setStatus(st), (e) => live && setError(String(e.message || e)));
//     return () => { live = false; };
//   }, []);
//   useEffect(() => window.api.assistant.onEvent((e) => e.type === 'progress' && setProgress(e)), []);
//   const busy = phase === 'download';
//   const start = async () => {
//     setPhase('download');
//     setProgress(null);
//     setError('');
//     try {
//       await install();
//     } catch (e) {
//       if (getState().assistantInstall !== open) return;
//       setPhase('error');
//       setError(e.message === 'cancelled' ? 'The download was cancelled.' : e.message);
//     }
//   };
//   const cancel = () => {
//     if (busy) cancelInstall();
//     closeInstall(false);
//   };
//   const total = status ? status.missing.reduce((n, x) => n + x.bytes, 0) : 0;
//   const pct = progress?.total ? Math.round((progress.received / progress.total) * 100) : 0;
//   const backend = BACKENDS.find(([id]) => id === status?.backend)?.[1];
//   return (
//     <Dialog open onOpenChange={(o) => !o && cancel()}>
//       <DialogContent aria-describedby={undefined} onInteractOutside={(e) => e.preventDefault()}
//         onCloseAutoFocus={(e) => !getState().dialog && refocusEditor(e)}
//         className="max-h-[88vh] gap-2 overflow-y-auto p-3 text-sm sm:max-w-[min(560px,92vw)] *:data-[slot=dialog-close]:top-3 *:data-[slot=dialog-close]:right-3">
//         <DialogHeader><DialogTitle className="text-base">Set up the assistant</DialogTitle></DialogHeader>
//         <p className="text-muted-foreground">
//           {PRIVACY} It runs {status?.model.label ?? 'Qwen3.5-9B'} with llama.cpp. Downloaded once into the app's data folder, each file
//           checked against its SHA-256 before it is kept:
//         </p>
//         <ul className="grid list-disc gap-0.5 pl-5" data-install-files>
//           {!status ? <li>Checking…</li> : !status.missing.length ? <li>Nothing: every file is already here.</li>
//             : status.missing.map((x) => <li key={x.label}>{x.label} ({size(x.bytes)})</li>)}
//         </ul>
//         <p className="text-muted-foreground">
//           llama.cpp comes from GitHub (ggml-org/llama.cpp, a pinned release; MIT licence). The model and its image projector come from
//           Hugging Face ({[...new Set([status?.model?.repo ?? 'unsloth/Qwen3.5-9B-GGUF', status?.model?.mmprojRepo ?? 'unsloth/Qwen3.5-9B-GGUF'])].join(' and ')});
//           {' '}{status?.licence?.model ?? 'Qwen3.5'} is licensed under {status?.licence?.name ?? 'Apache-2.0'} (
//           <a href={status?.licence?.url ?? 'https://www.apache.org/licenses/LICENSE-2.0'} target="_blank" rel="noreferrer" className="underline">licence text</a>
//           ), and a copy of the licence notice stays in the model folder.
//         </p>
//         {backend && (
//           <p>Graphics backend: {backend}{status.backend !== 'cpu' && ' (found from the graphics card)'}. Settings &gt; Assistant can change it.</p>
//         )}
//         {busy && (
//           <div className="grid gap-1" role="status">
//             <span>
//               {progress ? `Downloading the ${progress.label} (${progress.step} of ${progress.steps})` : 'Starting…'}
//               {progress?.total ? `: ${size(progress.received)} of ${size(progress.total)}` : ''}
//             </span>
//             <div className="h-1.5 overflow-hidden rounded-full bg-muted">
//               <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
//             </div>
//           </div>
//         )}
//         {error && <p className="text-destructive">{error}</p>}
//         <DialogFooter>
//           <Button type="button" variant="outline" size="sm" onClick={cancel}>Cancel</Button>
//           <Button type="button" size="sm" disabled={busy || !status} onClick={start}>
//             {phase === 'error' ? 'Retry' : total ? `Download and install (${size(total)})` : 'Turn on'}
//           </Button>
//         </DialogFooter>
//       </DialogContent>
//     </Dialog>
//   );
// }
//
// function InstallDialog() {
//   const open = useStore((s) => s.assistantInstall);
//   return open ? <InstallForm key={open.id} open={open} /> : null;
// }
//
// /** Everything the assistant shows, mounted once in the main column's area; Ctrl+Shift+A toggles the panel from anywhere. */

export function Assistant() {
  const islandRef = useRef(null);
  const open = useAssistant().open;
  const pane = useStore((s) => s.workerPane && !!s.worker); // the background window's live view (§7i Background window)
  const off = useStore((s) => s.settings?.assistant?.provider === 'none'); // Settings > Assistant > Provider > None
  useEffect(() => {
    const onKey = (e) => {
      if (!keyIs('app.assistant', e)) return; // §7k
      const st = getState();
      if (st.dialog || st.confirm || st.settings?.assistant?.provider === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) toggleChat();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <>
      {!off && <ChatButton islandRef={islandRef} />}
      {!off && open && <ChatPanel islandRef={islandRef} />}
      {pane && <BackgroundPane />}
      {/* <InstallDialog /> LOCAL LLM (commented out 2026-10-07) */}
    </>
  );
}
