// Comment cards on a canvas draft (canvas.js): one card per thread the filter shows, beside the page at its anchor's height, and
// the same cards in the Comments pane's list view, with the revision balloons (review.balloons, stage2.md G43) and the assistant's
// suggestion cards (src/suggest/canvas.js, drawn by the DOM path's ChangeCard) in the same column.
// A comment keeps its bold, italic, underline and strikethrough (the engine's `paras`, stage2.md G55); a card's story is a text box
// (TextBox): Ctrl+B, Ctrl+I and Ctrl+U format, Ctrl+Enter posts, Esc leaves, and a new comment left empty goes away.
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MessageSquare, MessageSquarePlus, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useViewport } from '../../../engine/view/Viewport.jsx';
import { run } from '../../../tooling/registry.js';
import { activeComment, cardsMode, setUi, shownOf, ui, useThreads, useUi } from './canvas.js';
import { COLORS, timeAgo } from './comments.mjs';
import { refocusEditor } from '../../../app/actions.js';
import { useStore } from '../../../app/store.js';
import { useCards } from '../../../suggest/canvas.js';
import { cmpPos, groupsOf } from '../../../suggest/cards.mjs';
import { groupNotes } from '../../../suggest/extension.js';
import { ChangeCard } from '../../../suggest/Review.jsx';
import { shownFor } from '../markup/balloons.mjs';

const CARD_W = 240; // px, at any zoom: the cards keep their size as the DOM editor's margin cards do
const GAP_PT = 10; // pt between the page's edge and the cards
const SPACE = 8; // px between stacked cards

/** An author's colour, the same for a name in every card. */
const colorFor = (name = '') => COLORS[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

/** Runs engine command `id` on `session` and reports a refusal in the console. → its result. */
async function exec(session, id, args) {
  const r = await Promise.resolve(session.exec(id, args)).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
  if (!r?.ok) console.error(`Comments: ${id} failed:`, r?.error);
  return r;
}

// The page area is an EditContext editing host: an element inside it cannot take the focus, so a card's text box is drawn in
// <body> over the place the card keeps for it (EDIT_H px), following it when the camera moves, and clipped to the page area
// ([data-viewport]) so it never draws over the ribbon or the status bar. A card in the Comments pane is outside the page area and
// keeps its box in place.
const EDIT_H = 96;

const SAME = ['left', 'top', 'width', 'vl', 'vt', 'vw', 'vh'];

// ---------- formatted comment text: the engine's paras ([[{text, b?, i?, u?, s?}]]) ----------

const MARKS = ['b', 'i', 'u', 's'];
const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TAG = { b: 'b', i: 'i', u: 'u', s: 's' };

/** `paras` as the text box's HTML: a <div> per paragraph, each run in its marks' tags. */
function htmlOf(paras) {
  return paras.map((runs) => `<div>${runs.map((r) => MARKS.filter((m) => r[m]).reduce((h, m) => `<${TAG[m]}>${h}</${TAG[m]}>`, esc(r.text))).join('') || '<br>'}</div>`).join('');
}

/** The marks an element adds, by its tag or its style (what Chromium's bold, italic and underline commands write). */
function marksOf(el, on) {
  const st = el.style ?? {};
  const deco = `${st.textDecoration ?? ''} ${st.textDecorationLine ?? ''}`;
  return {
    b: on.b || /^(B|STRONG)$/.test(el.tagName) || st.fontWeight === 'bold' || +st.fontWeight >= 600,
    i: on.i || /^(I|EM)$/.test(el.tagName) || st.fontStyle === 'italic',
    u: on.u || el.tagName === 'U' || deco.includes('underline'),
    s: on.s || /^(S|STRIKE|DEL)$/.test(el.tagName) || deco.includes('line-through'),
  };
}

/** The text box's content as paras: block elements and line breaks start paragraphs, neighbouring runs alike are joined. */
function parasOf(root) {
  const out = [[]];
  const push = (text, on) => {
    const runs = out.at(-1);
    const last = runs.at(-1);
    if (last && MARKS.every((m) => !!last[m] === !!on[m])) last.text += text;
    else runs.push({ text, ...Object.fromEntries(MARKS.filter((m) => on[m]).map((m) => [m, true])) });
  };
  const walk = (node, on) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        if (n.data) push(n.data.replace(/\n/g, ' '), on);
      } else if (n.nodeName === 'BR') out.push([]);
      else if (n.nodeType === 1) {
        const block = /^(DIV|P|LI)$/.test(n.nodeName);
        if (block && out.at(-1).length) out.push([]);
        walk(n, marksOf(n, on));
        if (block && out.at(-1).length) out.push([]);
      }
    }
  };
  walk(root, {});
  while (out.length > 1 && !out.at(-1).length) out.pop();
  return out;
}

const plainOf = (paras) => paras.map((runs) => runs.map((r) => r.text).join('')).join('\n');

/** The UTF-16 index in `text` of UTF-8 byte offset `bytes` (the engine's offsets). */
function charAt(text, bytes) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (n >= bytes) return i;
    const cp = text.codePointAt(i);
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (cp >= 0x10000) i++;
  }
  return text.length;
}

/** Run text `t` starting at `from` in its paragraph, cut at the edges of `marks` ([start, end] there) → [[text, marked]]. */
function cut(t, from, marks) {
  const edges = [...new Set([0, t.length, ...marks.flat().map((x) => x - from).filter((x) => x > 0 && x < t.length)])].sort((a, b) => a - b);
  return edges.slice(1).map((e, k) => [t.slice(edges[k], e), marks.some(([a, b]) => a <= from + edges[k] && from + e <= b)]);
}

/** A comment's formatted text: its paras, or its plain text from an engine without them. Find In's matches selected in it
 * (ui.found) show as the selection does on the page. */
function Runs({ c }) {
  if (!Array.isArray(c.paras)) return c.text;
  const found = ui.found?.id === c.id ? ui.found.matches : [];
  return c.paras.map((runs, i) => {
    const text = runs.map((r) => r.text).join('');
    const marks = found.filter((m) => m.start?.path?.length === 1 && m.start.path[0] === i).map((m) => [charAt(text, m.start.off), charAt(text, m.end.off)]);
    let at = 0;
    return (
      <div key={i}>
        {runs.length ? runs.flatMap((r, j) => {
          const from = at;
          at += r.text.length;
          return cut(r.text, from, marks).map(([t, on], k) => (
            <span key={`${j}.${k}`} data-comment-found={on ? '' : undefined} style={{ fontWeight: r.b ? 600 : undefined, fontStyle: r.i ? 'italic' : undefined,
              textDecoration: [r.u && 'underline', r.s && 'line-through'].filter(Boolean).join(' ') || undefined,
              background: on ? 'color-mix(in srgb, Highlight 35%, transparent)' : undefined }}>{t}</span>
          ));
        }) : <br />}
      </div>
    );
  });
}

/** The text box of comment `id` ('edit') or of a reply to thread `id` ('reply'). `isNew`: the comment was just made (New Comment),
 * as the engine's undo step id that made it when known, else true. */
function TextBox({ session, id, mode, isNew, text = '', paras = null }) {
  // The box's HTML lives here: the box is drawn again in <body> once its place is known, and keeps what was typed.
  const html = useRef(htmlOf(paras ?? [[{ text }]]));
  const [empty, setEmpty] = useState(!text.trim());
  const box = useRef(null);
  const setBox = (el) => {
    box.current = el;
    if (el && !el.dataset.filled) {
      el.innerHTML = html.current;
      el.dataset.filled = '1';
    }
  };
  const slot = useRef(null);
  const editorEl = useRef(null);
  const [at, setAt] = useState(null);
  const vp = useViewport();
  const floating = () => !!slot.current?.closest('[data-viewport]');
  const follow = useRef(null);
  follow.current = () => {
    const r = slot.current?.getBoundingClientRect();
    const v = slot.current?.closest('[data-viewport]')?.getBoundingClientRect();
    if (!r || !v) return;
    const next = { left: r.left, top: r.top, width: r.width, vl: v.left, vt: v.top, vw: v.width, vh: v.height };
    setAt((o) => (o && SAME.every((k) => o[k] === next[k]) ? o : next));
  };
  useLayoutEffect(() => {
    if (!floating()) return undefined;
    const update = () => follow.current();
    const offs = [vp?.subscribe?.('camera', update), vp?.subscribe?.('placements', update)];
    const root = slot.current?.closest('[data-viewport]');
    root?.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      for (const off of offs) off?.();
      root?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [vp]);
  // The cards restack when threads change: place the box again after each render of the card.
  useLayoutEffect(() => {
    if (floating()) follow.current();
  });
  useLayoutEffect(() => box.current?.focus(), [at != null]);
  const gated = isNew || mode === 'reply';
  const done = useRef(false);
  const leave = async (post) => {
    if (done.current) return;
    done.current = true;
    setUi({ editing: null });
    const out = box.current ? parasOf(box.current) : [[{ text }]];
    const t = plainOf(out).trim();
    if (post && t) await exec(session, mode === 'reply' ? 'review.reply' : 'review.editComment', { id, paras: out });
    else if (isNew && !t) await dropNew(session, id, isNew); // a new comment left empty goes away, as in Word
    if (floating()) document.querySelector('[data-canvas-pages]')?.focus({ preventScroll: true }); // back to the text
  };
  // A click elsewhere (on the page) leaves a new empty comment as Cancel does; one with text stays open until Post or Cancel.
  const blur = (e) => {
    if (isNew && empty && document.hasFocus() && !editorEl.current?.contains(e.relatedTarget)) leave(false);
  };
  const FORMAT = { b: 'bold', i: 'italic', u: 'underline' };
  const editor = (
    <div ref={editorEl} className="flex flex-col gap-1" data-comment-story="">
      <div ref={setBox} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" tabIndex={0}
        aria-label={mode === 'reply' ? 'Reply' : 'Comment'} data-canvas-comment-text=""
        onInput={(e) => {
          html.current = e.currentTarget.innerHTML;
          setEmpty(!e.currentTarget.textContent.trim());
        }}
        onBlur={blur}
        // A paste comes in as plain text: rich HTML could bring pictures the box would fetch and parasOf would drop on save.
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
        onKeyDown={(e) => {
          e.stopPropagation(); // the app's keys stay out of the text box
          const mark = e.ctrlKey && !e.shiftKey && !e.altKey && FORMAT[e.key.toLowerCase()];
          if (mark) {
            e.preventDefault();
            document.execCommand(mark);
            html.current = e.currentTarget.innerHTML;
          } else if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            if (!(gated && empty)) leave(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            leave(false);
          }
        }}
        className="min-h-12 rounded-md border bg-background px-2 py-1 text-[13px] break-words whitespace-pre-wrap outline-none focus:border-ring" />
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="ghost" data-comment-action="cancel" onClick={() => leave(false)}>Cancel</Button>
        <Button size="xs" data-comment-action="post" disabled={gated && empty} onClick={() => leave(true)}>
          {mode === 'reply' ? 'Reply' : isNew ? 'Post' : 'Save'}
        </Button>
      </div>
    </div>
  );
  return (
    <div ref={slot} style={{ minHeight: at ? EDIT_H : undefined }}>
      {!at ? (floating() ? null : editor)
        : createPortal(
          <div data-canvas-comment-clip="" className="z-50" style={{ position: 'fixed', left: at.vl, top: at.vt, width: at.vw, height: at.vh, overflow: 'hidden', pointerEvents: 'none' }}>
            <div data-canvas-comment-editor="" className="rounded-md border bg-card p-2 text-[13px] shadow-md"
              style={{ position: 'absolute', left: at.left - at.vl, top: at.top - at.vt, width: at.width, pointerEvents: 'auto' }}>{editor}</div>
          </div>, document.body)}
    </div>
  );
}

/** Removes new comment `id` left empty: the undo of the step that made it when that is still the top one, so the comment leaves
 * no step behind, else a delete. */
// ponytail: the undone step stays on the redo list (Ctrl+Y brings the empty comment back); drop it if the engine gets a call that
// discards the top step.
async function dropNew(session, id, step) {
  const top = typeof step === 'number' || typeof step === 'string' ? (await Promise.resolve(session.steps?.()).catch(() => null))?.undo : null;
  if (top != null && top === step) await Promise.resolve(session.undo()).catch(() => null);
  else await exec(session, 'review.deleteComment', { id });
}

/** One comment of a thread: author, time, the '...' menu and the text (or its text box while edited). */
function Entry({ session, c, top }) {
  const edited = ui.editing?.mode === 'edit' && ui.editing.id === c.id;
  return (
    <div data-comment-entry={c.id} className="flex flex-col">
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white" style={{ background: colorFor(c.author) }}>
          {initials(c.author)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span data-comment-author="" className="truncate font-medium">{c.author || 'Author'}</span>
          <span className="text-[11px] text-muted-foreground">{timeAgo(c.date)}</span>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label="More thread actions" data-comment-action="menu"><MoreHorizontal /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuItem data-comment-action="edit" onSelect={() => setUi({ editing: { id: c.id, mode: 'edit', isNew: false } })}>Edit comment</DropdownMenuItem>
            <DropdownMenuItem data-comment-action="delete" onSelect={() => exec(session, 'review.deleteComment', { id: c.id })}>
              {top ? 'Delete thread' : 'Delete comment'}
            </DropdownMenuItem>
            {top && <DropdownMenuItem data-comment-action="resolve" onSelect={() => exec(session, 'review.resolveComment', { id: c.id, value: true })}>Resolve thread</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {edited ? <TextBox session={session} id={c.id} mode="edit" isNew={ui.editing.isNew} text={c.text} paras={c.paras} />
        : <div data-comment-text="" className="mt-1 pl-7.5 break-words whitespace-pre-wrap"><Runs c={c} /></div>}
    </div>
  );
}

/** A thread card: its comment, the replies and the Reply box; collapsed with Reopen once resolved. A click selects the anchor. */
export function CanvasThreadCard({ session, thread, active }) {
  const editingHere = ui.editing && [thread.id, ...thread.replies.map((r) => r.id)].includes(ui.editing.id);
  const collapsed = thread.resolved && !editingHere;
  const replying = ui.editing?.mode === 'reply' && ui.editing.id === thread.id;
  const activate = (e) => {
    if (e.target.closest('button, textarea, [contenteditable], [role="menu"]')) return;
    setUi({ active: thread.id });
    if (thread.anchor) session.select(thread.anchor, thread.anchor);
  };
  return (
    <div data-canvas-comment={thread.id} data-done={thread.resolved || undefined} data-active={active || undefined} tabIndex={-1} onMouseDown={activate}
      className={`flex flex-col gap-2 rounded-md border bg-card p-2 text-[13px] text-card-foreground shadow-sm outline-none ${
        active ? 'border-ring' : ''} ${thread.resolved ? 'opacity-60' : ''}`}>
      {collapsed ? (
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{thread.author}: resolved</span>
          <Button size="xs" variant="ghost" data-comment-action="reopen" onClick={() => exec(session, 'review.resolveComment', { id: thread.id, value: false })}>Reopen</Button>
        </div>
      ) : (
        <>
          <Entry session={session} c={thread} top />
          {thread.replies.map((r) => <Entry key={r.id} session={session} c={r} />)}
          {replying ? <TextBox session={session} id={thread.id} mode="reply" />
            : !(ui.editing?.isNew && ui.editing.id === thread.id) && (
              <button type="button" data-comment-action="reply" onClick={() => setUi({ active: thread.id, editing: { id: thread.id, mode: 'reply', isNew: false } })}
                className="rounded-md border bg-background px-2 py-1 text-left text-muted-foreground hover:bg-accent">Reply</button>
            )}
        </>
      )}
    </div>
  );
}

/** Specific People (settings.word.tracking.people, null for everyone) hides a reviewer's comments as well (stage2.md G25). */
const usePeople = () => useStore((s) => s.settings?.word?.tracking?.people ?? null);

/** The threads the filter and Specific People show (the Reviewing pane's filter, shownFor). */
const shownThreads = (d, people) => {
  const keep = new Set(shownOf(d.list).filter((c) => shownFor(people, c.author)).map((c) => c.id));
  return d.threads.filter((t) => keep.has(t.id));
};

// A card's own events stay in it: the page area's input (src/engine/input) listens on an ancestor and would take them as typing,
// keys and caret moves in the text (as canvas/boxes.jsx OWN). They stop on the island's outer box, so the cards render in a
// React root of their own inside it, whose listeners hear them first.
const OWN = ['mousedown', 'pointerdown', 'dblclick', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'compositionstart',
  'compositionupdate', 'compositionend', 'paste', 'copy', 'cut', 'contextmenu', 'wheel'];

/** A box with a React root of its own for `children`, whose events never reach the page area. */
function Island({ style, children, ...attrs }) {
  const outer = useRef(null);
  const root = useRef(null);
  useLayoutEffect(() => {
    const el = outer.current;
    const inner = el.appendChild(document.createElement('div'));
    root.current = createRoot(inner);
    const stop = (e) => e.stopPropagation();
    for (const t of OWN) el.addEventListener(t, stop, t === 'wheel' ? { passive: true } : undefined);
    return () => {
      for (const t of OWN) el.removeEventListener(t, stop);
      const r = root.current;
      root.current = null;
      setTimeout(() => r.unmount()); // not while React renders the page
    };
  }, []);
  // Its own root has none of the app's providers: the tooltips (a suggestion card's buttons) need theirs.
  useLayoutEffect(() => root.current?.render(<TooltipProvider delayDuration={300}>{children}</TooltipProvider>));
  return <div ref={outer} style={style} {...attrs} />;
}

const BALLOON_KIND = { delete: 'Deleted', format: 'Formatted', moveFrom: 'Moved', moveTo: 'Moved' };

/** A revision balloon (stage2.md G43): who changed what, joined to the change; a click selects it. */
function Balloon({ session, b }) {
  const label = BALLOON_KIND[b.kind] ?? b.kind;
  return (
    <div data-canvas-balloon={b.kind} tabIndex={-1} onMouseDown={() => b.at && session.select(b.at, b.at)}
      className="flex flex-col rounded-md border border-dashed bg-card px-2 py-1 text-[12px] text-card-foreground shadow-sm"
      style={{ borderLeft: `3px solid ${colorFor(b.author)}` }}>
      <span className="flex gap-1">
        <span className="truncate font-medium">{b.author || 'Author'}</span>
        <span className="shrink-0 text-muted-foreground">{label}</span>
      </span>
      {b.text && <span data-balloon-text="" className="break-words text-muted-foreground">{b.kind === 'delete' ? b.text : b.text.replace(/^Formatted: /, '')}</span>}
    </div>
  );
}

const NO_NODES = [];
const noHot = () => {};
/** Escape on a suggestion card gives the focus back to the text, as on the DOM path's cards. */
const escape = (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  refocusEditor();
};

/** A suggestion card (src/suggest/canvas.js) in the DOM path's ChangeCard: `first` when it is its group's first card, which holds
 * the group's note rows and, for more than one, Accept all and Reject all. */
function Suggestion({ s }) {
  const { card: c, group, active } = s;
  const it = { id: c.id, e: { id: c.id, g: c.g, by: c.by, at: c.at, kind: c.kind, nodes: NO_NODES }, place: { text: c.text } };
  const g = group.changes[0] === c ? group : null;
  return <ChangeCard it={it} g={g} n={group.changes.length} notes={g ? groupNotes(g.g) : null} on={active} schema={null} setHot={noHot}
    onKeyDown={escape} data-board-chrome data-agent-deny className="w-full" />;
}

/** The cards of one page, each at its anchor's height and pushed down below the card above. `threads` holds the comment threads,
 * the revision balloons ({balloon: true}) and the suggestion cards ({suggestion}), sorted by height. */
function CardsColumn({ session, threads, k, mode, active }) {
  const box = useRef(null);
  const [tops, setTops] = useState({});
  useLayoutEffect(() => {
    if (!box.current) return;
    const next = {};
    let bottom = -Infinity;
    for (const t of threads) {
      const el = box.current.querySelector(`[data-card-slot="${t.id}"]`);
      const top = Math.max(t.place.y * k, bottom + SPACE);
      next[t.id] = top;
      bottom = top + (el?.offsetHeight ?? 0);
    }
    if (JSON.stringify(next) !== JSON.stringify(tops)) setTops(next);
  });
  return (
    <div ref={box} style={{ position: 'relative' }}>
      {threads.map((t) => (
        <div key={t.id} data-card-slot={t.id} style={{ position: 'absolute', left: 0, top: tops[t.id] ?? t.place.y * k, width: CARD_W }}>
          {t.balloon ? <Balloon session={session} b={t} /> : t.suggestion ? <Suggestion s={t.suggestion} /> : mode === 'icons' && ui.opened !== t.id ? (
            <Button size="icon-xs" variant="ghost" aria-label={`Show comment by ${t.author || 'Author'}`} data-comment-icon={t.id}
              onClick={() => setUi({ opened: t.id, active: t.id })}>
              <MessageSquare className="size-4" />
            </Button>
          ) : <CanvasThreadCard session={session} thread={t} active={active === t.id} />}
        </div>
      ))}
    </div>
  );
}

/** The world overlay of one page (canvas/overlay.jsx registerOverlay): its threads' cards right of the page. */
export function PageCards({ session: id, page, k, placement }) {
  const d = useThreads(id);
  const session = d?.client;
  useUi();
  const people = usePeople();
  const mode = cardsMode();
  const sg = useCards(id);
  const cards = sg?.cards ?? [];
  // A balloon of a suggestion's own change would say again what its card says.
  const ofCard = (b) => cards.some((c) => c.author === b.author && cmpPos(c.start, b.at) <= 0 && cmpPos(b.at, c.end) <= 0);
  const balloons = (d?.balloons ?? []).filter((b) => b.place?.page === page && !ofCard(b)).map((b) => ({ ...b, balloon: true }));
  const groups = new Map(groupsOf(cards).map((g) => [g.g, g]));
  const suggestions = cards.filter((c) => c.place?.page === page)
    .map((c) => ({ id: `sg-${c.id}`, place: c.place, suggestion: { card: c, group: groups.get(c.g), active: c.id === sg.active } }));
  const threads = [...(d && mode !== 'pane' ? shownThreads(d, people).filter((t) => t.place?.page === page) : []), ...balloons, ...suggestions]
    .sort((a, b) => a.place.y - b.place.y);
  if (!threads.length) return null;
  return (
    <Island data-canvas-comments={page} style={{ position: 'absolute', left: (placement.w + GAP_PT) * k, top: 0, width: CARD_W, pointerEvents: 'auto' }}>
      <CardsColumn session={session} threads={threads} k={k} mode={mode} active={activeComment()} />
    </Island>
  );
}

/** The Comments pane on a canvas draft: every thread the filter shows, in reading order, a New button and the filter. */
export function CanvasCommentsPane({ session: client }) {
  const d = useThreads(client);
  const session = d?.client;
  useUi();
  const people = usePeople();
  const active = activeComment();
  const threads = d ? shownThreads(d, people) : [];
  return (
    <div data-comments-pane="" data-canvas="" className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-2">
        <Button size="xs" variant="outline" data-comment-action="new" onMouseDown={(e) => e.preventDefault()} onClick={() => run('review.comments.newComment')}>
          <MessageSquarePlus /> New
        </Button>
        <select aria-label="Filter comments" value={ui.filter ?? ''} onChange={(e) => setUi({ filter: e.target.value || null })}
          className="h-6 rounded-md border bg-background px-1 text-xs">
          <option value="">All comments</option>
          <option value="active">Active only</option>
          <option value="resolved">Resolved only</option>
        </select>
      </div>
      {threads.length ? threads.map((t) => <CanvasThreadCard key={t.id} session={session} thread={t} active={active === t.id} />)
        : <p className="px-1 text-muted-foreground">No comments to show.</p>}
    </div>
  );
}
