import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TextSelection } from '@tiptap/pm/state';
import { cn } from 'cn';
import { ArrowRight, Bot, Check, ChevronDown, CircleCheck, GraduationCap, Lock, Trash2 } from 'lucide-react';
import { TITLEBAR } from '@/components/ui/bounds';
import { Button } from '@/components/ui/button';
import { canvasEditor } from '../../canvas.js';
import { enabled } from '../../integrations/index.mjs';
import { refocusEditor, saveSettings, toast } from '../actions.js';
import { codeOf } from '../keys.mjs';
import { motion } from '../motion.js';
import { getState, setState, useStore } from '../store.js';
import { Help } from './Tip.jsx';
import { LESSONS, lessons } from './tutorial-lessons.jsx';

// The tutorial (SPEC §7l Tutorial): lessons played in the app itself, a step at a time (tutorial-lessons.jsx holds them).
// Everything but the step's target and the tutorial's card is dimmed and locked (the gate below), the app's keys included. A
// light, the dim's hole, moves from target to target, and a large pointer shows each click, drag or double-click, over and
// over, until the user does it.

const PAD = 6; // px between a target and the light's edge
const GAP = 16; // px between the light (or the target's dialog or menu) and the card
const EDGE = 8; // px the card keeps inside the window
const OVER = 32; // px the card beside the light overlaps its span by, at least
const LEAD = 0.7; // the share of its way the light covers before the card sets off after it (the user, 2026-10-27)
const GLIDE = 11; // per s: the card's glide after the light, at rest in about 0.6 s
const FROM = [64, 48]; // px right of and below the target the pointer comes in from (left of it for a drag), mirrored near the window's edges
const FADE = 300; // ms the dim takes to fade in and out
const CHEER = 600; // ms a task's completion plays
const REST = 1400; // ms after it before the tutorial moves on (the user, 2026-10-27)
const QUICK = 450; // ms before a step with no task to tick moves on
const UNLOCKED = 2550; // ms from a progress card showing to its icon unlocked (app.css: the bar fills 0.9 s from 0.9 s, rests, unlocks 0.5 s)
const LOOP = [900, 1600, 3300, 4000]; // ms into lesson 3's light loop: off the page, on the canvas, off it, round (app.css tutorial-double-*)
const REACH = 30; // px round a drag's hint where a press or a release counts as on it, and lands on it (the user's magnet)
const DOTS = [0, 45, 90, 135, 180, 225, 270, 315]; // a burst, by angle
const TYPE = 28; // ms per character a dialogue line types out in

// The shown step as the gate reads it: its kind and fields (act, done, drag, word, field), and what takes the pointer once the
// light is on it.
let live = { el: null, kind: null, step: -1 };
let spent = -1; // the step whose click was taken: another click waits for the next step's target
let sense = null; // the keys step's keycaps (Combo), told every key while they show
let nudge = null; // shakes the card's instruction when a drag ends wrong
let held = null; // {pointerId}: a drag step's press, taken to its hint 1; its release is the step's to judge
let judged = null; // the shown step's handler of a drag done right
let anchor = null; // a select step's press: the doc position its drag selects from
const ours = new WeakSet(); // the pointer events the tutorial sends itself (a drag's magnet)

/** Settings > General, the setup's last page and tool search: the first lesson from its first step, with the sidebar shown
 * (its New draft button is the first target). Not in the smoke run, whose scripts it would lock out. */
export function startTutorial() {
  const s = getState();
  if (s.smoke) return;
  if (s.settings.sidebarCollapsed) saveSettings({ sidebarCollapsed: false });
  live = { el: null, kind: null, step: -1 };
  spent = -1;
  held = null;
  setState({ tutorial: { step: 0, format: enabled(s.settings, 'forum') ? 'forum-post' : 'document', from: s.draft?.id ?? null } });
}

/** Exit and Finish: the light fades and the app is unlocked. A canvas being edited (lesson 3's end) keeps the keys. */
export function endTutorial() {
  setState({ tutorial: null });
  const board = canvasEditor.get()?.board;
  if (board) board.focus();
  else refocusEditor();
}

/** From step `from` to the next, `patch` merged into the tutorial; a stale call (it moved on or ended) does nothing. */
function advance(from, patch) {
  const t = getState().tutorial;
  if (t?.step === from) setState({ tutorial: { ...t, ...patch, step: from + 1 } });
}

/** A select step's drag ended (step `step`, event `e`): with the right text selected (`done`) the tutorial moves on, keeping
 * where the drag ended for the menu; a selection of other text shakes the instruction. After the editor has read it. */
function settle(step, e) {
  const at = { x: e.clientX, y: e.clientY };
  setTimeout(() => {
    if (getState().tutorial?.step !== step) return;
    if (live.done?.()) advance(step, { at });
    else if (!getState().editor?.state.selection.empty) nudge?.();
  }, 60);
}

// The gate: window capture listeners added as this module loads, before any of the app's own (all added at start or in
// effects), so they see every event first. While a tutorial runs, an event outside the card and the shown step's target
// stops here, and keys work in the card only; a keys step's keys go to its keycaps instead (the ones its `pass` names on to the
// app too), a type step's next letter to the text. A step with `context` lets a right-click on its target open the menu there.
// Releases always pass: they start nothing, and a stopped one would leave a press hanging. A drag step has its own rules
// (dragGate), and so does a select step's drag (pick).
const NEVER = new Set(['contextmenu', 'auxclick', 'dragstart', 'drop']);
const UP = new Set(['pointerup', 'mouseup', 'keyup']);
const block = (e) => {
  e.preventDefault();
  e.stopImmediatePropagation();
};

function gate(e) {
  if (ours.has(e)) return;
  const t = getState().tutorial;
  if (!t) return;
  const key = e.type.startsWith('key');
  if (key && live.kind === 'keys') sense?.(e);
  const card = !key && e.target.closest?.('[data-tutorial-card]');
  if (live.kind === 'drag' && !key && (!card || held)) return dragGate(e, t.step);
  if (live.kind === 'select' && pick(e)) return;
  if (UP.has(e.type)) {
    if (e.type === 'pointerup' && live.kind === 'select' && live.el) settle(t.step, e);
    return;
  }
  if (key && live.kind === 'keys') return live.pass?.(e) ? undefined : block(e); // `pass`: the chord also does its own job
  if (NEVER.has(e.type) && !(e.type === 'contextmenu' && live.context && live.el?.contains(e.target))) return block(e);
  if (key && live.kind === 'type' && !e.target.closest?.('[data-tutorial-card]')) return typed(e) ? undefined : block(e);
  if (e.target.closest?.('[data-tutorial-card]')) {
    if (e.type === 'pointerdown' || e.type === 'mousedown') {
      e.stopImmediatePropagation(); // the app never sees a press on the card, so an open menu stays open
      if (e.type === 'mousedown') e.preventDefault(); // and the editor keeps the focus and its selection
    }
    return;
  }
  if (!key && live.el?.contains(e.target)) {
    // A right-click step (`context`): the target's left-button actions stay shut (a draft row's own Delete, its drag, a rename).
    if (live.context && /^(pointerdown|mousedown|click|dblclick)$/.test(e.type) && e.button !== 2) return block(e);
    if (e.type === 'click' && live.kind === 'click' && (!live.only || e.target.closest?.(live.only))) { // `only`: what a click must hit
      const { step, act } = live;
      spent = step;
      live = { ...live, el: null };
      if (act) {
        block(e); // the step's own action in place of the target's
        act();
      }
      setTimeout(() => advance(step)); // after the target's own click: the next step may close what holds the target
    }
    return;
  }
  block(e);
}

/** What a type step's field holds: an input's value, else its text. */
const textOf = (el) => (el ? el.value ?? el.textContent : '');

/** A type step's key: Shift, Caps Lock or the word's next letter in either case, which then goes into the text. */
function typed(e) {
  if (e.key === 'Shift' || e.key === 'CapsLock') return true;
  const next = live.word?.[textOf(live.field?.()).length];
  return !!next && e.key.length === 1 && e.key.toLowerCase() === next && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** A select step's press and drag (the user, 2026-10-27: it selects no more than the lines asked for). A press on the target
 * and the moves while it is held select as the editor's own drag would, but only within the step's `within` (a doc range
 * [from, to]); the editor never sees them. True when it took the event. */
function pick(e) {
  if (!(e.buttons & 1)) anchor = null; // let go
  const view = getState().editor?.view;
  const span = view && live.within?.();
  const press = e.type === 'pointerdown' && e.button === 0 && !!live.el?.contains(e.target);
  if (!span || !/^(pointer|mouse)(down|move)$/.test(e.type) || (!press && anchor == null)) return false;
  block(e);
  const at = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? (e.clientY < view.coordsAtPos(span[0]).top ? span[0] : span[1]);
  const head = clamp(at, ...span);
  if (press) {
    anchor = head;
    view.focus();
  }
  if (e.type.startsWith('pointer')) {
    const { doc } = view.state;
    view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(anchor), doc.resolve(head))));
  }
  return true;
}

const away = (e, p) => Math.hypot(e.clientX - p.x, e.clientY - p.y);

/** A drag step's pointer events (the user, 2026-10-27: only that drag can be done, and its two hints are magnets). A press
 * within REACH of hint 1 goes to the step's target as a press right on the hint; any other press stops here. While held, the
 * moves go on to the board; a release within reach of hint 2 lands right on it (with Shift when the step pins), anywhere else
 * where it is. Then the step judges what the drag did. */
function dragGate(e, step) {
  const d = live.drag;
  if (!held) {
    const from = live.el && d.from();
    if (e.type !== 'pointerdown' || e.button !== 0 || !from || away(e, from) > REACH) return block(e);
    block(e);
    d.before?.();
    held = { pointerId: e.pointerId };
    send('pointerdown', d.press?.() ?? document.elementFromPoint(from.x, from.y), from, e);
    return;
  }
  if (e.type === 'pointermove') return; // the board follows it (it holds the pointer)
  if (e.type !== 'pointerup') return block(e);
  held = null;
  const to = d.to?.();
  const near = !!to && away(e, to) <= (d.reach ?? REACH);
  if (near) {
    block(e);
    send('pointermove', e.target, to, e, { shiftKey: !!d.pin });
    send('pointerup', e.target, to, e, { shiftKey: !!d.pin, buttons: 0 });
  }
  setTimeout(() => {
    if (getState().tutorial?.step !== step || live.drag !== d) return;
    const ok = d.check(near);
    if (ok === true) judged?.(step);
    else if (ok === false) {
      d.undo?.();
      nudge?.();
    }
  }, 60);
}

/** A click on `el` by the tutorial itself, past the gate: a tab it shows, a toggle it flips. */
export function tap(el) {
  if (!el) return;
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 });
  ours.add(ev);
  el.dispatchEvent(ev);
}

/** A pointer event of type `type` at window point `p` on `el`, as the user's `e` would be: one of the tutorial's own. */
function send(type, el, p, e, extra = {}) {
  if (!el) return;
  const ev = new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, pointerId: e.pointerId,
    pointerType: e.pointerType || 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: 1, ...extra });
  ours.add(ev);
  el.dispatchEvent(ev);
}

for (const type of ['pointerdown', 'pointerup', 'pointermove', 'pointerover', 'mousedown', 'mouseup', 'mousemove', 'mouseover', 'click',
  'dblclick', 'auxclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'keydown', 'keypress', 'keyup', 'dragstart', 'drop']) {
  addEventListener(type, gate, { capture: true, passive: false });
}

const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2); // in and out
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
const isEl = (x) => typeof x?.getBoundingClientRect === 'function';

/** What step target `target` shows: its elements that show, or rects {x, y, w, h} in window px; null while there is none. */
function targets(target) {
  const found = typeof target === 'function' ? target() : target;
  if (!found) return null;
  const els = (typeof found === 'string' ? [[...document.querySelectorAll(found)].find((x) => x.checkVisibility())] : [].concat(found))
    .filter((x) => (isEl(x) ? x.checkVisibility() : x && x.w >= 0));
  return els.length ? els : null;
}

/** The light's rect {x, y, w, h} around `els` (elements or rects), PAD px out, a hanging indent's marker included (a
 * Document's list paragraph, document.css). `text`: it ends where their text ends, not at the page's edge; `clip`: a selector
 * of the element it is cut to (a page, to the part the editor area shows). */
function around(els, text, clip) {
  const rs = els.map((x) => {
    if (!isEl(x)) return { left: x.x, top: x.y, right: x.x + x.w, bottom: x.y + x.h };
    const r = x.getBoundingClientRect();
    const range = text && document.createRange();
    range?.selectNodeContents(x);
    return { left: r.left + Math.min(0, parseFloat(getComputedStyle(x).textIndent) || 0), top: r.top, bottom: r.bottom,
      right: range ? Math.min(r.right, range.getBoundingClientRect().right) : r.right };
  });
  const c = clip && document.querySelector(clip)?.getBoundingClientRect();
  const [left, top] = [Math.max(Math.min(...rs.map((r) => r.left)), c?.left ?? -Infinity), Math.max(Math.min(...rs.map((r) => r.top)), c?.top ?? -Infinity)];
  const [right, bottom] = [Math.min(Math.max(...rs.map((r) => r.right)), c?.right ?? Infinity), Math.min(Math.max(...rs.map((r) => r.bottom)), c?.bottom ?? Infinity)];
  return { x: left - PAD, y: top - PAD, w: right - left + 2 * PAD, h: bottom - top + 2 * PAD };
}
const mix = (a, b, k) => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) });
const grow = (r, by) => r && { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };

/** What a drag step lights: its two hints with their reach and what its ghost covers. */
function dragArea(d) {
  const g = d.ghost?.() ?? {};
  const at = (p) => p && { x: p.x - REACH, y: p.y - REACH, w: 2 * REACH, h: 2 * REACH };
  const rects = [at(d.from()), at(d.to?.()), g.a, g.b, g.turn && grow(g.turn, Math.max(g.turn.w, g.turn.h) * 0.22)].filter(Boolean);
  return rects.length > 1 || (rects.length && !d.to) ? rects : null;
}

/** The dim: the window under the title strip with a rounded hole at `r` {x, y, w, h}. Even-odd, so the hole is not painted
 * and the pointer reaches only what is under it. */
function dimPath({ x, y, w, h }, c) {
  return `M0 ${TITLEBAR}H${innerWidth}V${innerHeight}H0Z`
    + `M${x + c} ${y}H${x + w - c}A${c} ${c} 0 0 1 ${x + w} ${y + c}V${y + h - c}A${c} ${c} 0 0 1 ${x + w - c} ${y + h}`
    + `H${x + c}A${c} ${c} 0 0 1 ${x} ${y + h - c}V${y + c}A${c} ${c} 0 0 1 ${x + c} ${y}Z`;
}

const overlaps = (p, w, h, a) => p.x < a.x + a.w && p.x + w > a.x && p.y < a.y + a.h && p.y + h > a.y;

/** Where the card (w × h) goes for the light `r` on `el`: beside the light, or beside the dialog or menu holding it so it
 * covers none of that, and as near the window's middle as that allows, so it never travels far between steps (the user,
 * 2026-10-27). Each side's spot overlaps the light's span by OVER px at least; a spot right or left of it moves on past
 * `avoid` rects in its way. Of the spots inside the window and clear of them, the one nearest the middle wins. */
function cardAt(w, h, r, el, avoid) {
  const d = isEl(el) ? el.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [data-quick-tools]')?.getBoundingClientRect() : null;
  const box = d ? { x: d.left, y: d.top, w: d.width, h: d.height } : r;
  const [cx, cy] = [innerWidth / 2, (innerHeight + TITLEBAR) / 2];
  const y = clamp(cy - h / 2, Math.max(r.y - h + OVER, TITLEBAR + EDGE), Math.min(r.y + r.h - OVER, innerHeight - h - EDGE));
  const x = clamp(cx - w / 2, Math.max(r.x - w + OVER, EDGE), Math.min(r.x + r.w - OVER, innerWidth - w - EDGE));
  const past = (p, dir) => {
    for (const a of avoid) if (overlaps(p, w, h, a)) p.x = dir > 0 ? Math.max(p.x, a.x + a.w + GAP) : Math.min(p.x, a.x - GAP - w);
    return p;
  };
  const spots = [past({ x: box.x + box.w + GAP, y }, 1), past({ x: box.x - GAP - w, y }, -1), { x, y: box.y + box.h + GAP }, { x, y: box.y - GAP - h }]
    .filter((p) => p.x >= EDGE && p.x + w <= innerWidth - EDGE && p.y >= TITLEBAR + EDGE && p.y + h <= innerHeight - EDGE && !avoid.some((a) => overlaps(p, w, h, a)));
  const far = (p) => Math.hypot(p.x + w / 2 - cx, p.y + h / 2 - cy);
  return spots.sort((a, b) => far(a) - far(b))[0] ?? { x, y: clamp(box.y + box.h + GAP, TITLEBAR + EDGE, innerHeight - h - EDGE) };
}

/** The card (w × h) over the middle of `r`, inside the window: a step that acts where its light is (`over`). */
const cardOver = (w, h, r) => ({ x: clamp(r.x + r.w / 2 - w / 2, EDGE, innerWidth - w - EDGE), y: clamp(r.y + r.h / 2 - h / 2, TITLEBAR + EDGE, innerHeight - h - EDGE) });

/** One frame (`dt` s) of the card at `p` {x, y, vx, vy} gliding to `g` {x, y}: a critically damped spring, solved exactly, so it
 * eases in and out and never overshoots (the user, 2026-10-27: smooth, no bounce); at rest once there. */
function glide(p, g, dt) {
  const fade = Math.exp(-GLIDE * dt);
  for (const [a, v] of [['x', 'vx'], ['y', 'vy']]) {
    const off = p[a] - g[a];
    const lead = (p[v] + GLIDE * off) * dt;
    p[v] = (p[v] - GLIDE * lead) * fade;
    p[a] = g[a] + (off + lead) * fade;
  }
  if (Math.abs(p.x - g.x) + Math.abs(p.y - g.y) < 0.5 && Math.hypot(p.vx, p.vy) < 3) Object.assign(p, { x: g.x, y: g.y, vx: 0, vy: 0 });
}

/** A task's circle (the user's sketch, 2026-10-27), ticked with a pop once `done`, `delay` ms late. */
const Tick = ({ done, delay = 0 }) => (
  <svg data-tutorial-tick data-done={done || undefined} viewBox="0 0 20 20" aria-hidden className="size-5 shrink-0" style={{ '--tick-delay': `${delay}ms` }}>
    <circle cx="10" cy="10" r="8.5" />
    <path pathLength="1" d="M6 10.4l2.7 2.7L14.2 7.4" />
  </svg>
);

/** Dots bursting once out of the middle of what holds them. */
const Burst = () => DOTS.map((a) => (
  <span key={a} aria-hidden className="absolute top-1/2 left-1/2" style={{ rotate: `${a}deg` }}>
    <i data-tutorial-burst className="absolute -top-0.5 -left-0.5 size-1 rounded-full bg-success" />
  </span>
));

const KEYCAP = 'inline-flex h-10 min-w-12 items-center justify-center justify-self-center rounded-lg border bg-card px-3 font-sans text-sm font-medium';
const Key = ({ label, down, demo }) => <kbd data-down={down || undefined} data-demo={demo} className={KEYCAP}>{label}</kbd>;

const Stage = ({ n, on, done, children }) => (
  <span data-on={on || undefined} data-done={done || undefined}
    className="flex items-center gap-1.5 justify-self-center text-xs text-muted-foreground transition-colors data-[done]:text-success data-[on]:text-foreground">
    <span className="flex size-5 items-center justify-center rounded-full border border-current text-[11px] font-medium tabular-nums">{done ? <Check className="size-3" /> : n}</span>
    {children}
  </span>
);

/** The keys step's keycaps (the user's sketch, 2026-10-27): 1 hold the chord's modifiers, 2 press its key, each keycap going down
 * with the real key. Untouched (and 2.5 s after every key is let go) they play the chord themselves. The chord done (`match`),
 * they turn green, the task gets its tick and `onDone` runs. */
function Combo({ chord, match, task, onDone }) {
  const keys = chord.split('+');
  const [mods, key] = [keys.slice(0, -1), keys.at(-1)];
  const [down, setDown] = useState(null); // which keys are down; null: none touched, the keycaps show the chord
  const [done, setDone] = useState(false);
  useEffect(() => {
    let finished = false;
    sense = (e) => {
      if (finished) return;
      const held = { Ctrl: e.ctrlKey || e.metaKey, Alt: e.altKey, Shift: e.shiftKey };
      setDown((d) => ({ ...Object.fromEntries(mods.map((m) => [m, !!held[m]])), [key]: e.code === codeOf(key) ? e.type === 'keydown' : !!d?.[key] }));
      if (e.type !== 'keydown' || !match(e)) return;
      finished = true;
      setDone(true);
      onDone();
    };
    const lift = () => !finished && setDown((d) => d && {}); // the window lost the keyboard: every key is up
    addEventListener('blur', lift);
    return () => {
      sense = null;
      removeEventListener('blur', lift);
    };
  }, []);
  const idle = !!down && !Object.values(down).some(Boolean);
  useEffect(() => {
    if (!idle || done) return undefined;
    const back = setTimeout(() => setDown(null), 2500);
    return () => clearTimeout(back);
  }, [idle, done]);
  const demo = down === null && !done;
  const held = mods.every((m) => down?.[m]);
  return (
    <div data-tutorial-combo data-done={done || undefined} className="grid gap-3">
      <div className={cn('mx-auto grid w-fit items-center gap-x-3 gap-y-2', mods.length ? 'grid-cols-[auto_auto_auto]' : 'grid-cols-1')}>
        {!!mods.length && (
          <>
            <Stage n={1} on={!held && !done} done={held || done}>Hold</Stage>
            <ArrowRight className="size-3.5 justify-self-center text-muted-foreground" />
          </>
        )}
        <Stage n={mods.length ? 2 : 1} on={held && !done} done={done}>Press</Stage>
        <div className="col-span-full grid grid-cols-subgrid items-center rounded-2xl border bg-background/40 px-3 py-2.5">
          {!!mods.length && (
            <>
              <span className="flex gap-1.5 justify-self-center">{mods.map((m) => <Key key={m} label={m} down={!!down?.[m]} demo={demo ? 'hold' : undefined} />)}</span>
              <span className="justify-self-center text-muted-foreground">+</span>
            </>
          )}
          <Key label={key} down={!!down?.[key]} demo={demo ? 'tap' : undefined} />
        </div>
      </div>
      <Task done={done}>{task}</Task>
    </div>
  );
}

/** The type step's keycaps, one per letter of `word` (a space a wide Space key): the typed ones green, the next one lit;
 * untouched, they type the word themselves over and over (the user: a demo of typing dog). A longer word's keys are smaller, so
 * they fit the card. */
const Typing = ({ word, typed }) => {
  const small = word.length > 4;
  return (
    <div data-tutorial-typing data-idle={!typed || undefined} className={cn('flex justify-center rounded-2xl border bg-background/40 px-3 py-2.5', small ? 'gap-1' : 'gap-1.5')}>
      {[...word].map((ch, k) => (
        <kbd key={k} data-typed={k < typed || undefined} data-next={k === typed || undefined} style={{ '--k': k }}
          className={cn(KEYCAP, small && 'h-9 min-w-7 px-1.5', ch === ' ' && 'min-w-14 text-xs text-muted-foreground')}>
          {ch === ' ' ? 'Space' : ch.toUpperCase()}
        </kbd>
      ))}
    </div>
  );
};

/** A task to do, its circle ticked with a burst once `done` (the keys, watch and drag steps). */
const Task = ({ done, children }) => (
  <p className="flex items-center gap-2" data-tutorial-task><span className="relative flex"><Tick done={done} />{done && <Burst />}</span>{children}</p>
);

/** A character's lines, as a game's talking scene (the ending, the user 2026-10-27): each one types itself out, a click shows it
 * whole, the next click shows the next line; the last one ends with `last` (a button) or by itself (`onEnd` on the click). A line
 * may be a function, read as it shows. The text not typed yet takes its room, so the card never grows while it types. */
function Dialogue({ lines, last, onEnd }) {
  const [k, setK] = useState(0);
  const [n, setN] = useState(0); // the line's characters shown
  const text = typeof lines[k] === 'function' ? lines[k]() : lines[k];
  const whole = n >= text.length;
  const end = k === lines.length - 1;
  useEffect(() => {
    if (whole) return undefined;
    const t = setTimeout(() => setN(motion('tutorial') ? n + 1 : text.length), TYPE);
    return () => clearTimeout(t);
  }, [n, whole]);
  const next = () => {
    if (!whole) return setN(text.length);
    if (!end) {
      setK(k + 1);
      setN(0);
    } else if (!last) onEnd();
  };
  return (
    <div data-tutorial-dialogue className="grid gap-2.5">
      <div role="button" tabIndex={0} onClick={next} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), next())}
        className="grid cursor-pointer gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <p key={k} className="min-h-12 text-base font-medium">{text.slice(0, n)}<span className="opacity-0">{text.slice(n)}</span></p>
        {!(end && last) && <ChevronDown data-more={whole || undefined} aria-label="Next" className="size-4 justify-self-end text-muted-foreground opacity-0 data-[more]:opacity-100" />}
      </div>
      {end && last && <Button size="sm" className="w-full" disabled={!whole} onClick={onEnd}>{last}</Button>}
    </div>
  );
}

/** A lesson's end (the user, 2026-10-27): "Next up" with lesson `next`, and the tutorial's bar, which fills to that lesson's
 * place among LESSONS, rests, and unlocks its icon there (app.css tutorial-bar, tutorial-badge). */
function Progress({ next }) {
  const { name, Icon } = LESSONS[next];
  const at = `${(next / LESSONS.length) * 100}%`;
  return (
    <div data-tutorial-progress className="grid gap-2 border-t pt-2.5">
      <p className="flex items-baseline gap-1.5"><span className="text-xs text-muted-foreground">Next up</span><span className="font-medium">{name}</span></p>
      <div className="relative mx-3.5 h-7">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
        <div data-tutorial-bar className="absolute top-1/2 left-0 h-1.5 -translate-y-1/2 rounded-full bg-(--ui-accent)" style={{ width: at }} />
        <span data-tutorial-badge className="absolute top-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 bg-card text-muted-foreground"
          style={{ left: at }}>
          <Icon data-tutorial-icon className="col-start-1 row-start-1 size-3.5" />
          <Lock data-tutorial-lock className="col-start-1 row-start-1 size-3.5" />
          <Burst />
        </span>
      </div>
    </div>
  );
}

/** A drag's hint: its number on its reach (the magnet's zone), and what to do there. */
const Hint = ({ n, label, at }) => (
  <div ref={at} data-tutorial-hint={n} aria-hidden className="absolute top-0 left-0" style={{ width: 2 * REACH, height: 2 * REACH, margin: -REACH }}>
    <span className="absolute inset-0 rounded-full border-2 border-dashed border-(--ui-accent)/60 bg-(--ui-accent)/10" />
    <span className="absolute top-1/2 left-1/2 grid size-6 -translate-1/2 place-items-center rounded-full bg-(--ui-accent) text-xs font-semibold text-white shadow-md">{n}</span>
    <span className="absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded-md bg-card px-1.5 py-0.5 text-xs whitespace-nowrap text-card-foreground shadow-md">{label}</span>
  </div>
);

/** The dim with its light, the card and the pointer (one, mounted in App), over everything but the title strip. */
export function Tutorial() {
  const t = useStore((s) => s.tutorial);
  const [shown, setShown] = useState(null); // the tutorial drawn: kept while it fades out after it ends
  const [arrived, setArrived] = useState(null); // {step, x, y, from, drag, pivot}: the light reached that step's target, so its pointer plays
  const [nudged, setNudged] = useState(null); // {step, count}: tries that went wrong in that step
  const [ticked, setTicked] = useState(-1); // the step whose task is done
  const [typing, setTyping] = useState(null); // {step, n}: letters of a type step's word typed so far
  const [quitting, setQuitting] = useState(false); // Exit tutorial was clicked: the card asks first (the user, 2026-10-27)
  const path = useRef(null);
  const glow = useRef(null);
  const card = useRef(null);
  const pointer = useRef(null);
  const ghost = useRef(null);
  const hint1 = useRef(null);
  const hint2 = useRef(null);
  const light = useRef(null); // the light's last rect
  const placed = useRef(null); // the card's last place
  const gone = useRef(null); // {from}: the card went with that step, a lesson's end; it shows again at the next step's place
  useEffect(() => {
    if (t) return void setShown(t);
    setQuitting(false);
    const out = setTimeout(() => {
      light.current = placed.current = gone.current = null;
      setShown(null);
    }, FADE);
    return () => clearTimeout(out);
  }, [t]);
  useEffect(() => {
    nudge = () => setNudged((x) => ({ step: getState().tutorial?.step, count: (x?.count ?? 0) + 1 }));
    return () => { nudge = null; };
  }, []);
  const view = t ?? shown;
  const steps = useMemo(() => view && lessons(view), [view?.format, view?.from]);
  const i = t?.step;

  // Each frame: the step's target and the light moving to it (the tutorial length, eased) from where it was. Once the light has
  // covered LEAD of its way the card glides after it to its place beside it (the user, 2026-10-27: the light leads, the card
  // follows), and once the light is there the target unlocks and the pointer plays. A step with a `loop` then sends the light
  // from the target to the loop's element and back, round and round (a canvas in the page, where the pointer double-clicks),
  // until its task is done. A target that is not there yet keeps the light and the card still.
  useEffect(() => {
    if (i == null || !steps) return undefined;
    const s = steps[i];
    const kind = s.kind ?? 'click';
    const length = motion('tutorial');
    const from = light.current ?? { x: innerWidth / 2, y: innerHeight / 2, w: 0, h: 0 }; // the first light grows from the middle
    let frame;
    let t0 = null;
    let off = false; // the card has set off after the light
    let last = null; // the last frame's time
    let round = null; // when the loop began
    let held_ = 0; // how far the light is on the loop's element: 0 the target, 1 the element
    let done = false;
    let scrolled = false;
    let reached = false;
    live = { el: null, kind, step: i, act: s.act, done: s.done, drag: s.drag, word: s.word, field: s.field, within: s.within, pass: s.pass, only: s.only,
      context: s.context };
    held = null;
    s.enter?.();
    // Done: the task ticks, then on (a step with no task to tick, sooner).
    const finish = () => {
      if (done) return;
      done = true;
      setTicked(i);
      setTimeout(() => advance(i), s.task ? CHEER + REST : QUICK);
    };
    judged = (step) => {
      if (step !== i) return;
      s.drag?.then?.();
      finish();
    };
    const timers = (s.script ?? []).map(([ms, fn]) => setTimeout(() => fn(() => advance(i)), ms));
    // A lesson's end with a next lesson goes by itself: its card fades once the icon has unlocked and the user has rested.
    if (s.next != null) {
      timers.push(setTimeout(() => {
        gone.current = { from: i };
        card.current.style.opacity = '0';
        setTimeout(() => advance(i), FADE);
      }, (length ? UNLOCKED : 600) + REST));
    }
    const draw = (r) => {
      const c = Math.min(10, r.w / 2, r.h / 2);
      light.current = r;
      path.current.setAttribute('d', dimPath(r, c));
      Object.assign(glow.current.style, { translate: `${r.x}px ${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, borderRadius: `${c}px`, opacity: r.w ? '' : '0' });
    };
    // The card glides to `goal`, or holds still while there is none; with the tutorial's motion off it jumps. The first one
    // appears in the window's middle, and one that went with its lesson's end appears at its next place.
    const follow = (goal, dt) => {
      const c = card.current;
      if (gone.current) {
        if (gone.current.from === i || !goal) return;
        gone.current = null;
        placed.current = { ...goal, vx: 0, vy: 0 };
      }
      const p = (placed.current ??= { x: (innerWidth - c.offsetWidth) / 2, y: (innerHeight + TITLEBAR - c.offsetHeight) / 2, vx: 0, vy: 0 });
      if (goal && !length) Object.assign(p, goal, { vx: 0, vy: 0 });
      else glide(p, goal ?? p, dt);
      c.style.translate = `${p.x}px ${p.y}px`;
      c.style.opacity = '1';
    };
    // A drag step's hints and ghost, where the board shows them this frame (hidden while the user drags).
    const place = (el, p) => el && p && (el.style.translate = `${p.x}px ${p.y}px`);
    const dressDrag = () => {
      const d = s.drag;
      const [a, b] = [d.from(), d.to?.()];
      place(hint1.current, a);
      place(hint2.current, b);
      for (const el of [pointer.current, ghost.current]) if (el) el.style.visibility = held ? 'hidden' : '';
      const g = ghost.current;
      const shape = d.ghost?.() ?? {};
      if (!g || !a) return;
      if (shape.a && shape.b) {
        for (const [k, r] of [['0', shape.a], ['1', shape.b]]) for (const f of ['x', 'y', 'w', 'h']) g.style.setProperty(`--g${f}${k}`, `${r[f]}px`);
      } else if (shape.turn) {
        Object.assign(g.style, { left: `${shape.turn.x}px`, top: `${shape.turn.y}px`, width: `${shape.turn.w}px`, height: `${shape.turn.h}px` });
      } else if (shape.line) {
        // The arrow's path, drawn along by its mask, and its head at the last point, pointing along the last segment.
        const d = `M${shape.line.map((q) => `${q.x} ${q.y}`).join('L')}`;
        for (const el of g.querySelectorAll('[data-draw], [data-shaft]')) el.setAttribute('d', d);
        const [q, r] = shape.line.slice(-2);
        const len = Math.hypot(r.x - q.x, r.y - q.y) || 1;
        const [ux, uy] = [(r.x - q.x) / len, (r.y - q.y) / len];
        const back = (side) => `${r.x - ux * 11 - uy * side} ${r.y - uy * 11 + ux * side}`;
        g.querySelector('[data-head]').setAttribute('d', `M${r.x} ${r.y}L${back(6)}L${back(-6)}Z`);
      }
    };
    const tick = (now) => {
      frame = requestAnimationFrame(tick);
      const dt = last == null ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!path.current) return;
      s.hold?.();
      if (held) s.drag?.track?.();
      const els = targets(s.drag && !s.target ? () => dragArea(s.drag) : s.target);
      if (!els) {
        live = { ...live, el: null };
        follow(null, dt);
        return draw(light.current ?? from);
      }
      const loop = s.loop && targets(s.loop);
      if (!scrolled) [...(loop ?? []), ...els].find(isEl)?.scrollIntoView({ block: 'nearest' });
      scrolled = true;
      const r = around(els, s.text, s.clip);
      // A light already on this target (the keys step's, on the selected lines) does not travel.
      t0 ??= Math.max(...['x', 'y', 'w', 'h'].map((k) => Math.abs(r[k] - from[k]))) < 2 ? now - length : now;
      const k = length ? Math.min(1, (now - t0) / length) : 1;
      const e = ease(k);
      // The loop: the light rests on the target, goes to the element and stays while the pointer double-clicks it, comes back
      // (LOOP); once the task is done it settles on the element. With the tutorial's motion off it stays on the element.
      const spot = loop && around(loop);
      if (spot && k === 1) {
        round ??= now;
        const at = (now - round) % LOOP[3];
        const go = !length ? 1 : at < LOOP[0] ? 0 : at < LOOP[1] ? ease((at - LOOP[0]) / (LOOP[1] - LOOP[0]))
          : at < LOOP[2] ? 1 : 1 - ease((at - LOOP[2]) / (LOOP[3] - LOOP[2]));
        held_ = done ? Math.min(1, held_ + dt * 2.5) : go;
      }
      draw(spot && k === 1 ? mix(r, spot, held_) : mix(from, r, e));
      off ||= e >= LEAD; // the light's share of its way: it moves by lerp, eased
      const c = card.current;
      const near = s.near && targets(s.near);
      const by = near ? around(near) : spot ?? r; // the card sits by `near`, else by the loop's element (still while the light goes round), else the light
      const [cw, ch] = [c.offsetWidth, c.offsetHeight];
      follow(off ? (s.over ? cardOver(cw, ch, by) : cardAt(cw, ch, by, (near ?? loop ?? els)[0], s.avoid?.() ?? [])) : null, dt);
      if (s.drag) dressDrag();
      if (k < 1) return;
      if (kind === 'watch' && s.done()) finish();
      if (kind === 'type') {
        const text = textOf(s.field?.()).toLowerCase().replace(/\xa0/g, ' '); // a space typed last is a no-break space
        let n = 0;
        while (n < text.length && text[n] === s.word[n]) n += 1;
        setTyping((x) => (x?.step === i && x.n === n ? x : { step: i, n }));
        if (text === s.word) {
          s.finish?.();
          finish();
        }
      }
      const d = s.drag && s.drag.from();
      const p = s.point?.() ?? (d ? { ...d, drag: s.drag.to?.() && [s.drag.to().x - d.x, s.drag.to().y - d.y] } : { x: by.x + by.w / 2, y: by.y + by.h / 2 });
      if (pointer.current) pointer.current.style.translate = `${p.x}px ${p.y}px`;
      if (['click', 'select', 'watch', 'drag'].includes(kind) && spent !== i && getState().tutorial?.step === i) {
        live = { ...live, el: s.drag ? document.body : s.allow?.() ?? els[0] };
      }
      if (reached) return;
      reached = true;
      const fx = kind === 'select' ? -FROM[0] : FROM[0];
      // The wiggle drags the pointer round the middle of what it turns: its hand turns about that point (app.css).
      const turn = s.drag?.ghost?.()?.turn;
      const pivot = turn && `${turn.x + turn.w / 2 - p.x}px ${turn.y + turn.h / 2 - p.y}px`;
      setArrived({ step: i, x: p.x, y: p.y, drag: p.drag, pivot,
        from: `${p.x + fx > innerWidth - 40 || p.x + fx < 40 ? -fx : fx}px ${p.y > innerHeight - 120 ? -FROM[1] : FROM[1]}px` });
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
      judged = null;
    };
  }, [i, steps]);

  if (!view) return null;
  const n = view.step;
  const step = steps[n];
  const kind = step.kind ?? 'click';
  const own = steps.filter((x) => x.lesson === step.lesson && !x.end && x.kind !== 'auto');
  const last = n === steps.length - 1;
  const shake = nudged?.step === n ? nudged.count : 0;
  const done = ticked === n;
  // A keys step's chord done: its action at once, and on after the completion and a rest.
  const chordDone = () => {
    step.onChord?.();
    setTimeout(() => advance(n), CHEER + REST);
  };
  const live_ = arrived?.step === n && t && !done;
  const pointing = live_ && (step.pointer ?? { click: 'click', select: 'drag', watch: 'double', drag: 'drag' }[kind]);
  const shape = step.drag && live_ ? step.drag.ghost?.() ?? {} : null;
  // A button that is not there yet (its target a rect, not an element): its dashed outline with the step's `mark` icon.
  const Mark = step.mark;
  const spot = Mark && t ? targets(step.target)?.find((x) => !isEl(x)) ?? null : null;
  return createPortal(
    <div data-tutorial={n} className={cn('pointer-events-none fixed inset-0 z-[60] animate-in fade-in-0 transition-opacity duration-300', !t && 'opacity-0')}>
      <svg aria-hidden className="absolute inset-0 size-full"><path ref={path} fillRule="evenodd" className="pointer-events-auto fill-black/55" /></svg>
      <div ref={glow} data-tutorial-glow aria-hidden className="absolute top-0 left-0" />
      {shape && (shape.a || shape.turn) && (
        <div ref={ghost} data-tutorial-ghost={shape.turn ? 'turn' : 'morph'} aria-hidden className="absolute top-0 left-0" />
      )}
      {shape?.line && (
        <svg ref={ghost} data-tutorial-ghost="line" aria-hidden className="absolute inset-0 size-full overflow-visible">
          <mask id="tutorial-ghost-draw" maskUnits="userSpaceOnUse"><path data-draw pathLength="1" /></mask>
          <g mask="url(#tutorial-ghost-draw)"><path data-shaft /><path data-head /></g>
        </svg>
      )}
      {step.drag && live_ && (
        <>
          <Hint n={1} label="Press" at={hint1} />
          {step.drag.to && <Hint n={2} label="Let go" at={hint2} />}
        </>
      )}
      {spot && (
        <div data-tutorial-mark aria-hidden className="absolute grid place-items-center rounded-lg border-2 border-dashed border-(--ui-accent) bg-(--ui-accent)/10 text-(--ui-accent)"
          style={{ left: spot.x, top: spot.y, width: spot.w, height: spot.h }}><Mark className="size-4" /></div>
      )}
      <div ref={card} data-tutorial-card data-shake={step.shake ? n : undefined} data-who={step.who ? '' : undefined} role="region" aria-label="Tutorial"
        className="pointer-events-auto absolute top-0 left-0 w-80 rounded-island border bg-card p-3 text-sm text-card-foreground opacity-0 shadow-xl transition-opacity">
        <div className="flex h-6 items-center gap-2 text-xs text-muted-foreground">
          {step.who
            ? <span key="who" className="relative flex"><Bot data-tutorial-reveal className="size-4 text-(--ui-accent)" /><Burst /></span>
            : step.end || step.cheer
              ? <span key={n} className="relative flex"><CircleCheck data-tutorial-cheer className="size-4 text-success" /><Burst /></span>
              : <GraduationCap className="size-4 shrink-0" />}
          <span className="truncate">{step.who ?? `${LESSONS[step.lesson].name}${step.end ? ' · done' : own.includes(step) ? ` · ${own.indexOf(step) + 1} of ${own.length}` : ''}`}</span>
          {!last && !quitting && <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => setQuitting(true)}>Exit tutorial</Button>}
        </div>
        {/* Exit asks first; once out, a notice says where to start it again (the user, 2026-10-27: keep it simple). */}
        {quitting && (
          <div data-tutorial-quit className="mt-1 grid animate-page-in gap-2.5" aria-live="polite">
            <p className="text-base font-medium">Exit the tutorial?</p>
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" variant="secondary" onClick={() => setQuitting(false)}>Keep going</Button>
              <Button size="sm" onClick={() => { endTutorial(); toast('You can start the tutorial again in Settings > General.'); }}>Exit</Button>
            </div>
          </div>
        )}
        <div key={n} hidden={quitting} className="mt-1 grid animate-page-in gap-2.5" aria-live="polite">
          {step.lines ? <Dialogue lines={step.lines} last={last ? 'Goodbye' : null} onEnd={() => (last ? endTutorial() : advance(n))} /> : (
            <div className="flex items-center gap-1.5">
              {step.bin && <Trash2 data-tutorial-bin className="size-5 shrink-0 text-muted-foreground" />}
              <p key={shake} data-nudge={shake || undefined} className="text-base font-medium">{step.say}</p>
              {step.help && <Help tipClassName="z-[61]">{step.help}</Help>}
            </div>
          )}
          {step.line && <p className="-mt-1.5 text-muted-foreground">{typeof step.line === 'function' ? step.line() : step.line}</p>}
          {kind === 'keys' && <Combo chord={step.chord} match={step.match} task={step.task} onDone={chordDone} />}
          {kind === 'type' && <Typing word={step.word} typed={typing?.step === n ? typing.n : 0} />}
          {(kind === 'watch' || kind === 'drag') && step.task && <Task done={done}>{step.task}</Task>}
          {step.Widget && <step.Widget go={() => advance(n)} />}
          {step.tasks && (
            <ul className="grid gap-1.5">
              {step.tasks.map((x, j) => <li key={x} className="flex items-center gap-2"><Tick done delay={200 + j * 150} />{x}</li>)}
            </ul>
          )}
          {step.next != null && <Progress next={step.next} />}
          {step.button && <Button size="sm" className="w-full" onClick={() => (last ? endTutorial() : advance(n))}>{step.button}</Button>}
        </div>
      </div>
      {pointing && (
        <div ref={pointer} data-tutorial-pointer={pointing} aria-hidden className="absolute top-0 left-0"
          style={{ translate: `${arrived.x}px ${arrived.y}px` }}>
          <div data-tutorial-hand className="absolute top-0 left-0"
            style={{ '--tutorial-from': arrived.from, '--tutorial-drag': arrived.drag && `${arrived.drag[0]}px ${arrived.drag[1]}px`,
              transformOrigin: arrived.pivot }}>
            {(pointing === 'click' || pointing === 'double') && DOTS.map((a) => (
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
