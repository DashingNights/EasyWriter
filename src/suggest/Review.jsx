import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { cn } from 'cn';
import { Bot, Check, CheckCheck, ChevronDown, ChevronUp, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dot } from '@/components/ui/dot';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  acceptAll, acceptChange, acceptGroup, nextSuggestion, previousSuggestion, refocusEditor, rejectAll, rejectChange, rejectGroup,
  showSuggestion,
} from '../app/actions.js';
import { saveAssistant } from '../app/assistant/assistant.js';
import { IconButton } from '../app/components/Tip.jsx';
import { can } from '../app/gates.mjs';
import { useStore } from '../app/store.js';
import { describe, places } from './core.mjs';
import { groupNotes } from './extension.js';

// The review UI of agent edits waiting as suggestions (docs/plans/suggestions.md Display, Keys): one card per decision right of
// the page, each pinned beside the yellow text it describes, and the status bar's slot. A decision is a change, or one place of
// a change decided place by place (core.places: a rewritten paragraph's word changes, each with its own card, the user,
// 2026-10-26). App chrome outside #page-wrap, so the page zoom never scales it. Agents cannot press any of it (data-agent-deny):
// the suggestions.* commands are theirs. Clicks never take the focus from the editor; Escape gives it back.

const keepFocus = (e) => e.preventDefault();
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const nameOf = (by) => (by === 'agent:assistant' ? 'Assistant' : `Agent: ${String(by ?? 'agent').replace(/^agent:/, '')}`);
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const GAP = 8;
// Page setup first, at the sheet's top; a deleted block's widget draws above the block that starts at its position; a place at its
// words.
const order = ({ e, place }) => (place ? place.from : e.kind === 'attr' ? -1 : e.kind === 'delete' ? e.from - 0.5 : e.from);

/** Turns settings.assistant.autoApproveEdits on or off (the status bar popover, Settings, tool search). */
const setAutoApprove = (on) => saveAssistant({ autoApproveEdits: on === true });

const textOnly = (n) => (n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP);
/** The screen top of `el`'s first line of text, else of its box. A Document's page end (pagination.js floats) pushes a block's
 * first line below the page breaker while its box stays above it, on the page before. */
function lineTop(el) {
  const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, textOnly).nextNode();
  if (t) {
    const r = document.createRange();
    r.selectNodeContents(t);
    const top = r.getClientRects()[0]?.top;
    if (top != null) return top;
  }
  return el.getBoundingClientRect().top;
}

/** The screen top of decision `it` in editor `ed`: a place's line; a change's first block's first line (an object: its box), its
 * deleted-block widget's first line, or the sheet's top for page setup. */
function topOf(ed, { e, place }, sheet) {
  if (place) {
    try {
      return ed.view.coordsAtPos(Math.min(place.from, ed.state.doc.content.size)).top;
    } catch {
      return null;
    }
  }
  if (e.kind === 'attr') return sheet.top;
  if (e.kind === 'delete') {
    const w = ed.view.dom.querySelector(`.sg-del-block[data-sg="${e.id}"]`);
    if (w) return lineTop(w);
  } else {
    const el = ed.view.nodeDOM(e.starts[0]);
    if (el?.getBoundingClientRect) return e.nodes[0]?.isAtom ? el.getBoundingClientRect().top : lineTop(el);
  }
  try {
    return ed.view.coordsAtPos(Math.min(e.from, ed.state.doc.content.size)).top;
  } catch {
    return null;
  }
}

/** After a card's own Accept or Reject from the keyboard, the card is gone and the focus with it: it goes back to the editor,
 * so the chords keep working. A mouse click never took it from the editor (keepFocus). */
const decide = (p) => Promise.resolve(p).then(() => setTimeout(() => {
  if (!document.activeElement || document.activeElement === document.body) refocusEditor();
}));

/** The CSS of the hovered or focused card {id, place}: its change's or its place's fill raised on the page, as hovering the words
 * themselves does (suggest.css). The other cards stay as they are (the user, 2026-10-26: no tint over them). */
const hotCss = (h) => (!/^[\w-]+$/.test(h?.id ?? '') ? ''
  : h.place ? `.page .ProseMirror [data-sgp="${h.id}"]:is(.sg-add, .sg-fmt, .sg-del) { background: var(--sg-fill-active); }`
    : `.page .ProseMirror [data-sg="${h.id}"]:is(.sg-add, .sg-fmt, .sg-del-block) { background: var(--sg-fill-active); }
.page .ProseMirror [data-sg="${h.id}"]:is(.sg-node, .sg-fmt-block) { outline-style: solid; }`);

/** One decision's card (`it`: a change, or a place of one): who and when, Accept and Reject for it, then what it does (a click
 * shows it on the page). `g` is set on the first card of its group in document order: that card also holds the request (the
 * note), the group's metadata rows and, for a request of more than one decision (`n`), Accept all and Reject all. */
const ChangeCard = memo(({ it, g, n, notes, on, schema, setHot, className, ...props }) => {
  const { e, place } = it;
  const name = nameOf(e.by);
  const text = place ? place.text : describe(e, schema);
  const note = g?.note ? ` (${cut(g.note, 60)})` : '';
  const hot = { id: it.id, place: !!place };
  return (
    <Card data-sg-card={it.id} data-sg-change={e.id} data-sg-group={e.g} role="region" aria-label={`Suggestion from ${name}, ${text}`} onMouseDown={keepFocus}
      onMouseEnter={() => setHot(hot)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(hot)} onBlur={() => setHot(null)}
      className={cn('w-[17rem] gap-0 rounded-island border-suggest/50 py-2 text-sm shadow-xl',
        on && 'ring-2 ring-suggest', className)} {...props}>
      <div className="flex items-center gap-1.5 pr-1.5 pl-3">
        <Badge variant="secondary" className="min-w-0"><Bot /><span className="truncate">{name}</span></Badge>
        <span className="text-xs text-muted-foreground tabular-nums">{clock(e.at)}</span>
        <span className="ml-auto flex">
          <IconButton label="Accept" keybind="suggest.accept" aria-label={`Accept change, ${text}`} onClick={() => decide(acceptChange(it.id))}><Check /></IconButton>
          <IconButton label="Reject" keybind="suggest.reject" aria-label={`Reject change, ${text}`} onClick={() => decide(rejectChange(it.id))}><X /></IconButton>
        </span>
      </div>
      <button type="button" data-sg-show="" onClick={() => showSuggestion(it.id)}
        className="mx-1.5 mt-1 rounded-sm px-1.5 py-0.5 text-left break-words outline-none focus-visible:ring-2 focus-visible:ring-ring">{text}</button>
      {g && (g.note || notes?.length > 0 || n > 1) && (
        <div data-sg-request="">
          <Separator className="my-2" />
          {g.note && <p className="px-3 break-words text-muted-foreground">{g.note}</p>}
          {notes?.map((t, i) => <p key={i} className="px-3 pt-1 text-muted-foreground">{t}</p>)}
          {n > 1 && (
            <div className="flex gap-1 px-1.5 pt-1">
              <Button variant="ghost" size="xs" aria-label={`Accept all ${n} of this request${note}`} onClick={() => decide(acceptGroup(g.g))}>{`Accept all ${n}`}</Button>
              <Button variant="ghost" size="xs" aria-label={`Reject all ${n} of this request${note}`} onClick={() => decide(rejectGroup(g.g))}>{`Reject all ${n}`}</Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}, (a, b) => a.on === b.on && a.schema === b.schema && a.setHot === b.setHot && a.it.id === b.it.id && a.it.place?.text === b.it.place?.text
  && a.it.e.kind === b.it.e.kind && a.it.e.by === b.it.e.by && a.it.e.at === b.it.e.at && a.it.e.old === b.it.e.old
  && a.it.e.key === b.it.e.key && a.it.e.nodes.length === b.it.e.nodes.length && a.it.e.nodes.every((x, i) => x === b.it.e.nodes[i])
  && a.g?.g === b.g?.g && a.g?.note === b.g?.note && a.n === b.n && a.notes?.join('\n') === b.notes?.join('\n'));
// Unchanged blocks keep their node objects through a transaction, so a keystroke elsewhere renders no card again (describe
// diffs a replace's words).

/** The card layer (App.jsx, in the editor column: over the page, under its islands, panels, menus and dialogs) while the open
 * draft has suggestions and the editor page shows: one card per decision right of the sheet, its top at the decision's words.
 * The cards live in the document's space, as Google Docs' do: they follow the sheet through scrolling, panning and zoom
 * (keeping their own size), and like the page they may lie outside the view (the user, 2026-10-26). An anchor never depends on
 * the view or the active change, so a card moves only when its change moves or a card above it grows: in document order, a
 * card that would overlap the one above sits 8 px below it. Positions are written straight to the DOM by a
 * requestAnimationFrame loop that stops once they hold for two frames; scrolling, zoom, resizes and transactions start it again. */
export function SuggestionCards() {
  const { groups, active } = useStore((s) => s.suggestions);
  const ed = useStore((s) => s.editor);
  const shown = useStore((s) => can('view.editor', { view: s.view }));
  const zoom = useStore((s) => s.zoomPct);
  useStore((s) => s.drafts); // a rename, tag or move rewrites the list: re-read the cards' metadata rows (groupNotes)
  const layer = useRef(null);
  const kick = useRef(() => {});
  // The hovered or focused card {id, place}, written straight into the layer's <style>: a hover renders no card again.
  const style = useRef(null);
  const hot = useRef(null);
  const setHot = useCallback((h) => {
    hot.current = h;
    if (style.current) style.current.textContent = hotCss(h);
  }, []);
  const on = shown && groups.length > 0 && !!ed && !ed.isDestroyed;
  // Every decision (a change, or each place of a change decided place by place) in document order (the DOM order, so Tab walks the
  // cards down the page), each group's first one holding its request and `n`, the number of the group's decisions.
  const schema = ed?.schema;
  const list = useMemo(() => {
    if (!schema) return [];
    const seen = new Set();
    const counts = new Map();
    const all = groups.flatMap((group) => group.changes.flatMap((e) => {
      const ps = places(e, schema);
      return ps.length ? ps.map((place) => ({ id: place.id, e, place, group })) : [{ id: e.id, e, group }];
    }));
    for (const it of all) counts.set(it.group.g, (counts.get(it.group.g) ?? 0) + 1);
    return all.sort((a, b) => order(a) - order(b))
      .map(({ group, ...it }) => ({ it, g: seen.has(group.g) ? null : (seen.add(group.g), group), n: counts.get(group.g) }));
  }, [groups, schema]);
  // A card removed while hovered or focused (its Accept or Reject) never fires mouseleave or blur: its fill goes with it.
  useLayoutEffect(() => {
    if (hot.current && !list.some(({ it }) => it.id === hot.current.id)) setHot(null);
  }, [list, setHot]);

  // The stack may run past the end of the pan surface (many changes close together, a low zoom): the surface grows below the
  // page until the last card can be scrolled into view, and gives the room back when the cards go.
  useLayoutEffect(() => {
    if (!on) return undefined;
    return () => {
      const surf = document.getElementById('editor-area')?.firstElementChild;
      if (surf) {
        surf.style.paddingBottom = '';
        delete surf.dataset.sgTail;
      }
    };
  }, [on]);

  useLayoutEffect(() => {
    if (!on) return undefined;
    const area = document.getElementById('editor-area');
    const surf = area?.firstElementChild;
    const byId = new Map(list.map(({ it }) => [it.id, it]));
    let frame = 0;
    let last = '';
    let still = 0;
    const place = () => {
      const el = layer.current;
      const sheet = document.querySelector('#page-wrap .page');
      if (!el || !area || !surf || !sheet || ed.isDestroyed) return '';
      const t0 = performance.now();
      const L = el.getBoundingClientRect();
      const v = area.getBoundingClientRect();
      const s = sheet.getBoundingClientRect();
      const u = surf.getBoundingClientRect();
      // Drawn over the editor area only, left of its scrollbar: a card panned out of it never covers the navigation pane.
      el.style.clipPath = `inset(${Math.max(0, Math.round(v.top - L.top))}px ${Math.max(0, Math.round(L.right - v.left - area.clientWidth))}px `
        + `${Math.max(0, Math.round(L.bottom - v.top - area.clientHeight))}px ${Math.max(0, Math.round(v.left - L.left))}px)`;
      const x = s.right + 16;
      let sig = `${Math.round(x)}:${Math.round(L.left)},${Math.round(L.top)}`;
      // Every anchor and height is read before any card is moved: one layout per frame however many cards there are.
      const cards = [...el.querySelectorAll('[data-sg-card]')].map((c) => {
        const it = byId.get(c.dataset.sgCard);
        return { c, it, y: (it && topOf(ed, it, s)) ?? s.top, h: c.offsetHeight };
      });
      let floor = -Infinity;
      for (const a of cards) {
        const top = Math.max(a.y, floor);
        floor = top + a.h + GAP;
        const left = (a.it?.id === active ? x - GAP : x) - L.left; // the active card 8 px nearer the page
        a.c.style.transform = `translate(${Math.round(left)}px, ${Math.round(top - L.top)}px)`;
        sig += `|${Math.round(left)},${Math.round(top)},${a.h}`;
      }
      // The surface's bottom without the room added before must sit 24 px below the last card.
      const had = Number(surf.dataset.sgTail ?? 0);
      const tail = cards.length ? Math.max(0, Math.ceil(floor - GAP + 24 - (u.bottom - had))) : 0;
      if (Math.abs(tail - had) > 1) {
        surf.style.paddingBottom = tail ? `calc(100cqh - var(--page-keep) + ${tail}px)` : '';
        surf.dataset.sgTail = String(tail);
      }
      el.dataset.sgCost = (performance.now() - t0).toFixed(2); // the last frame's cost in ms, read by .smoke-data/suggest/ui.js
      return sig;
    };
    const tick = () => {
      const sig = place();
      still = sig === last ? still + 1 : 0;
      last = sig;
      frame = still >= 2 ? 0 : requestAnimationFrame(tick);
      if (layer.current) layer.current.dataset.sgLoop = frame ? 'on' : 'off';
    };
    kick.current = () => {
      still = 0;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    tick();
    const go = () => kick.current();
    area?.addEventListener('scroll', go, { passive: true });
    area?.addEventListener('wheel', go, { passive: true });
    window.addEventListener('resize', go);
    const ro = new ResizeObserver(go);
    for (const el of [document.getElementById('page-wrap'), layer.current, area]) if (el) ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      area?.removeEventListener('scroll', go);
      area?.removeEventListener('wheel', go);
      window.removeEventListener('resize', go);
      ro.disconnect();
      kick.current = () => {};
    };
  }, [on, ed, list, active, zoom]);
  useLayoutEffect(() => kick.current());

  if (!on) return null;
  const said = list.find(({ it }) => it.id === active)?.it;
  const escape = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    refocusEditor();
  };
  // A card that takes the focus (Tab) outside the editor area's view: the area scrolls it into view, and the card follows the
  // page there. The layer clips (overflow-clip) and never scrolls itself, which would move every card off its change.
  const reveal = (ev) => {
    const c = ev.target.closest?.('[data-sg-card]');
    const area = document.getElementById('editor-area');
    if (!c || !area) return;
    const r = c.getBoundingClientRect();
    const v = area.getBoundingClientRect();
    const pad = 24;
    const into = (lo, hi, from, size) => (lo < from + pad ? lo - from - pad : hi > from + size - pad ? Math.min(hi - from - size + pad, lo - from - pad) : 0);
    area.scrollTop += into(r.top, r.bottom, v.top, area.clientHeight);
    area.scrollLeft += into(r.left, r.right, v.left, area.clientWidth);
  };
  // No data-board-chrome or data-agent-area on the layer itself: it spans the column, and the first makes it a no-drag region
  // (app.css), which over the title strip stopped the window from moving. The cards carry it.
  return (
    <div ref={layer} data-agent-deny data-sg-layer="" className="pointer-events-none absolute inset-0 z-[5] overflow-clip" onKeyDown={escape} onFocus={reveal}>
      <style ref={style}>{hotCss(hot.current)}</style>
      <div aria-live="polite" className="sr-only">{said ? (said.place ? said.place.text : describe(said.e, schema)) : ''}</div>
      {list.map(({ it, g, n }) => (
        <ChangeCard key={it.id} it={it} g={g} n={n} notes={g ? groupNotes(g.g) : null} on={it.id === active} schema={schema} setHot={setHot}
          data-board-chrome className="pointer-events-auto absolute top-0 left-0" />
      ))}
    </div>
  );
}

/** The status bar's slot (beside Agents) while the open draft has suggestions: the count with a yellow dot; its popover holds
 * Previous, Next, Accept all, Reject all and the auto-approve switch. */
export function SuggestionsSlot() {
  const count = useStore((s) => s.suggestions.count);
  const auto = useStore((s) => s.settings?.assistant?.autoApproveEdits === true);
  if (!count) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="-mx-1 font-normal text-muted-foreground" data-suggestions-slot="">
          <Dot color="var(--suggest)" />{count === 1 ? '1 suggestion' : `${count} suggestions`}
        </Button>
      </PopoverTrigger>
      <PopoverContent data-agent-deny side="top" align="start" className="flex w-64 flex-col gap-1 p-2 text-xs" onCloseAutoFocus={refocusEditor}>
        <div className="flex gap-1">
          <Button variant="ghost" size="xs" className="flex-1" onClick={previousSuggestion}><ChevronUp />Previous</Button>
          <Button variant="ghost" size="xs" className="flex-1" onClick={nextSuggestion}><ChevronDown />Next</Button>
        </div>
        <Button variant="ghost" size="xs" className="justify-start" onClick={acceptAll}><CheckCheck />Accept all</Button>
        <Button variant="ghost" size="xs" className="justify-start" onClick={rejectAll}><X />Reject all</Button>
        <Separator className="my-1" />
        <div className="flex items-center gap-2 px-2 py-1">
          <Switch id="sg-auto-approve" checked={auto} onCheckedChange={setAutoApprove} />
          <Label htmlFor="sg-auto-approve" className="text-xs">Auto-approve assistant edits</Label>
        </div>
      </PopoverContent>
    </Popover>
  );
}
