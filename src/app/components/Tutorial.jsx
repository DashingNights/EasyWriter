import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from 'cn';
import { CircleCheck, GraduationCap } from 'lucide-react';
import { TITLEBAR } from '@/components/ui/bounds';
import { Button } from '@/components/ui/button';
import { enabled } from '../../integrations/index.mjs';
import { refocusEditor, saveSettings } from '../actions.js';
import { motion } from '../motion.js';
import { getState, setState, useStore } from '../store.js';
import { Help } from './Tip.jsx';

// The tutorial (SPEC §7l Tutorial): lessons played in the app itself, a step at a time. Everything but the step's target and
// the tutorial's card is dimmed and locked (the gate below), the app's keys included. A light, the dim's hole, moves from
// target to target, and on each one a large pointer shows the click every 4.5 s until the user clicks it. The first lesson
// makes a draft: a forum post while the forum is on, else a Document, the layout the next lessons build on.

const PAD = 6; // px between a target and the light's edge
const GAP = 16; // px between the light (or the target's dialog) and the card
const EDGE = 8; // px the card keeps inside the window
const FROM = [64, 48]; // px right of and below the target the pointer comes in from, mirrored near the window's edges
const FADE = 300; // ms the dim takes to fade in and out
const DOTS = [0, 45, 90, 135, 180, 225, 270, 315]; // the click's burst, by angle

/** The first lesson for a draft of `format`; `from` is the draft that was open when the tutorial started. A step: `target`, a
 * CSS selector (or a function returning one, null until it is there); `say`, the instruction; `help`, its (?); `look`, nothing
 * to click: the card's Finish ends the lesson. */
function lesson(format, from) {
  const post = format === 'forum-post';
  return [
    { target: '[data-new-draft]', say: 'Click New draft', help: 'Everything you write in EasyWriter is a draft. The sidebar lists them.' },
    { target: `[data-new-draft-format="${format}"]`, say: `Click ${post ? 'Forum post' : 'Document'}`,
      help: post ? "A forum post is written with the forum's own tools. Once it is ready, you push it to its thread."
        : 'A Document has pages, styles and a ribbon of tools, as in a word processor.' },
    { target: '[role="dialog"]:has([data-new-draft-format]) [type="submit"]', say: 'Click Create',
      help: 'The title can wait. Double-click the draft in the sidebar to rename it.' },
    { target: () => { const s = getState(); return !s.dialog && s.draft?.id && s.draft.id !== from ? `[data-draft="${s.draft.id}"]` : null; },
      look: true, say: 'Your first draft is ready', help: 'It saves as you write. More lessons are coming soon.' },
  ];
}

/** Settings > General, the setup's last page and tool search: the first lesson from its first step, with the sidebar shown
 * (its New draft button is the first target). Not in the smoke run, whose scripts it would lock out. */
export function startTutorial() {
  const s = getState();
  if (s.smoke) return;
  if (s.settings.sidebarCollapsed) saveSettings({ sidebarCollapsed: false });
  setState({ tutorial: { step: 0, format: enabled(s.settings, 'forum') ? 'forum-post' : 'document', from: s.draft?.id ?? null } });
}

/** Exit and Finish: the light fades and the app is unlocked. */
export function endTutorial() {
  setState({ tutorial: null });
  refocusEditor();
}

// The gate: window capture listeners added as this module loads, before any of the app's own (all added at start or in
// effects), so they see every event first. While a tutorial runs, an event outside the card and the shown step's target
// stops here; keys work in the card only. A click on the target moves the tutorial on before the target acts on it.
let live = { el: null, step: -1 }; // the shown step's target once the light is on it (the frame loop keeps it)

function gate(e) {
  const t = getState().tutorial;
  if (!t || e.target.closest?.('[data-tutorial-card]')) return;
  if (!e.type.startsWith('key') && live.el?.contains(e.target)) {
    if (e.type === 'click') {
      const armed = live.step;
      live = { el: null, step: -1 }; // one click per step: a second one waits for the next target
      if (armed === t.step) setState({ tutorial: { ...t, step: t.step + 1 } });
    }
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
}
for (const type of ['pointerdown', 'pointerup', 'pointermove', 'pointerover', 'mousedown', 'mouseup', 'mousemove', 'mouseover', 'click',
  'dblclick', 'auxclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'keydown', 'keypress', 'drop']) {
  addEventListener(type, gate, { capture: true, passive: false });
}

const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2); // in and out
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/** The dim: the window under the title strip with a rounded hole at `r` {x, y, w, h}. Even-odd, so the hole is not painted
 * and the pointer reaches only what is under it. */
function dimPath({ x, y, w, h }, c) {
  return `M0 ${TITLEBAR}H${innerWidth}V${innerHeight}H0Z`
    + `M${x + c} ${y}H${x + w - c}A${c} ${c} 0 0 1 ${x + w} ${y + c}V${y + h - c}A${c} ${c} 0 0 1 ${x + w - c} ${y + h}`
    + `H${x + c}A${c} ${c} 0 0 1 ${x} ${y + h - c}V${y + c}A${c} ${c} 0 0 1 ${x + c} ${y}Z`;
}

/** Where the card (w × h) goes for the light `r` on `el`: beside the target's dialog when it is in one, so it covers none of
 * the dialog, else beside the light; right, left, below or above, the first with room, level with the light, inside the window. */
function cardAt(w, h, r, el) {
  const d = el.closest('[role="dialog"]')?.getBoundingClientRect();
  const box = d ? { x: d.left, y: d.top, w: d.width, h: d.height } : r;
  const y = clamp(r.y + r.h / 2 - h / 2, TITLEBAR + EDGE, innerHeight - h - EDGE);
  const x = clamp(r.x + r.w / 2 - w / 2, EDGE, innerWidth - w - EDGE);
  if (box.x + box.w + GAP + w <= innerWidth - EDGE) return { x: box.x + box.w + GAP, y };
  if (box.x - GAP - w >= EDGE) return { x: box.x - GAP - w, y };
  if (box.y + box.h + GAP + h <= innerHeight - EDGE) return { x, y: box.y + box.h + GAP };
  return { x, y: Math.max(TITLEBAR + EDGE, box.y - GAP - h) };
}

/** The dim with its light, the card and the pointer (one, mounted in App), over everything but the title strip. */
export function Tutorial() {
  const t = useStore((s) => s.tutorial);
  const [shown, setShown] = useState(null); // the tutorial drawn: kept while it fades out after it ends
  const [arrived, setArrived] = useState(null); // {step, x, y, from}: the light reached that step's target, so its pointer plays
  const path = useRef(null);
  const glow = useRef(null);
  const card = useRef(null);
  const pointer = useRef(null);
  const light = useRef(null); // the light's last rect
  const placed = useRef(null); // the card's last place
  useEffect(() => {
    if (t) return void setShown(t);
    const out = setTimeout(() => {
      light.current = placed.current = null;
      setShown(null);
    }, FADE);
    return () => clearTimeout(out);
  }, [t]);
  const view = t ?? shown;
  const steps = useMemo(() => view && lesson(view.format, view.from), [view?.format, view?.from]);
  const i = t?.step;

  // Each frame: the step's target, the light moving to it (the tutorial length, eased) from where it was, the card beside it,
  // and once the light is there the target unlocked and the pointer on it. A target that is not there yet keeps the light still.
  useEffect(() => {
    if (i == null || !steps) return undefined;
    const s = steps[i];
    const length = motion('tutorial');
    const from = light.current ?? { x: innerWidth / 2, y: innerHeight / 2, w: 0, h: 0 }; // the first light grows from the middle
    const cardFrom = placed.current;
    let frame;
    let t0 = null;
    let scrolled = false;
    let reached = false;
    live = { el: null, step: -1 };
    const draw = (r) => {
      const c = Math.min(10, r.w / 2, r.h / 2);
      light.current = r;
      path.current.setAttribute('d', dimPath(r, c));
      Object.assign(glow.current.style, { translate: `${r.x}px ${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, borderRadius: `${c}px`, opacity: r.w ? '' : '0' });
    };
    const tick = (now) => {
      frame = requestAnimationFrame(tick);
      if (!path.current) return;
      const sel = typeof s.target === 'function' ? s.target() : s.target;
      const el = sel ? [...document.querySelectorAll(sel)].find((x) => x.checkVisibility()) : null;
      if (!el) {
        live = { el: null, step: -1 };
        return draw(light.current ?? from);
      }
      if (!scrolled) el.scrollIntoView({ block: 'nearest' });
      scrolled = true;
      const b = el.getBoundingClientRect();
      const r = { x: b.left - PAD, y: b.top - PAD, w: b.width + 2 * PAD, h: b.height + 2 * PAD };
      t0 ??= now;
      const k = length ? Math.min(1, (now - t0) / length) : 1;
      const e = ease(k);
      draw({ x: lerp(from.x, r.x, e), y: lerp(from.y, r.y, e), w: lerp(from.w, r.w, e), h: lerp(from.h, r.h, e) });
      const c = card.current;
      const to = cardAt(c.offsetWidth, c.offsetHeight, r, el);
      placed.current = cardFrom ? { x: lerp(cardFrom.x, to.x, e), y: lerp(cardFrom.y, to.y, e) } : to;
      c.style.translate = `${placed.current.x}px ${placed.current.y}px`;
      c.style.opacity = '1';
      if (k < 1) return;
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      if (pointer.current) pointer.current.style.translate = `${x}px ${y}px`;
      if (!s.look && getState().tutorial?.step === i) live = { el, step: i };
      if (reached) return;
      reached = true;
      setArrived({ step: i, x, y, from: `${x > innerWidth - 120 ? -FROM[0] : FROM[0]}px ${y > innerHeight - 120 ? -FROM[1] : FROM[1]}px` });
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [i, steps]);

  if (!view) return null;
  const n = view.step;
  const step = steps[n];
  const done = n === steps.length - 1;
  return createPortal(
    <div data-tutorial={n} className={cn('pointer-events-none fixed inset-0 z-[60] animate-in fade-in-0 transition-opacity duration-300', !t && 'opacity-0')}>
      <svg aria-hidden className="absolute inset-0 size-full"><path ref={path} fillRule="evenodd" className="pointer-events-auto fill-black/55" /></svg>
      <div ref={glow} data-tutorial-glow aria-hidden className="absolute top-0 left-0" />
      <div ref={card} data-tutorial-card role="region" aria-label="Tutorial"
        className="pointer-events-auto absolute top-0 left-0 w-72 rounded-island border bg-card p-3 text-sm text-card-foreground opacity-0 shadow-xl transition-opacity">
        <div className="flex h-6 items-center gap-2 text-xs text-muted-foreground">
          {done ? <CircleCheck className="size-4 text-success" /> : <GraduationCap className="size-4" />}
          {done ? 'Lesson done' : `Step ${n + 1} of ${steps.length - 1}`}
          {!done && <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={endTutorial}>Exit tutorial</Button>}
        </div>
        <div key={n} className="mt-1 flex animate-page-in items-center gap-1.5" aria-live="polite">
          <p className="text-base font-medium">{step.say}</p>
          <Help tipClassName="z-[61]">{step.help}</Help>
        </div>
        {done && <Button size="sm" className="mt-3 w-full" onClick={endTutorial}>Finish</Button>}
      </div>
      {arrived?.step === n && t && !step.look && (
        <div ref={pointer} data-tutorial-pointer aria-hidden className="absolute top-0 left-0" style={{ translate: `${arrived.x}px ${arrived.y}px` }}>
          <div data-tutorial-hand className="absolute top-0 left-0" style={{ '--tutorial-from': arrived.from }}>
            {DOTS.map((a) => (
              <span key={a} className="absolute top-0 left-0" style={{ rotate: `${a}deg` }}>
                <i data-tutorial-dot className="absolute -top-[2.5px] -left-[2.5px] size-[5px] rounded-full bg-(--ui-accent)" />
              </span>
            ))}
            <svg data-tutorial-arrow width="31.9" height="48.4" viewBox="-1.5 -1.5 14.5 22"
              className="absolute -top-[3.3px] -left-[3.3px] origin-[3.3px_3.3px] drop-shadow-[0_2px_3px_rgb(0_0_0/0.5)]">
              <path d="M0 0V16L3.6 12.6L6.4 18.8L9 17.6L6.3 11.6H11.2Z" fill="#fff" stroke="#111" strokeWidth="1.1" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
