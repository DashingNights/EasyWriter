import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { X } from 'lucide-react';
import { TITLEBAR } from '@/components/ui/bounds';
import { Button } from '@/components/ui/button';
import { saveSettings } from '../actions.js';
import { getState, setState, useStore, WORKER } from '../store.js';
import { useViewportBox } from '../viewport.js';
import { showPage } from '../views.js';
import { CHROME, keepFocus } from './board/controls.jsx';
import { STEPS } from './onboarding-steps.jsx';

// The tour (STEPS in onboarding-steps.jsx): a card mounted in the main column's area, above the islands and below dialogs
// (z 45, like the agent request card). It starts on the first start (settings.onboarded not true; never in the background
// window, §7i) and from Settings > General; it is not shown during smoke. Non-modal: it never takes the focus or a key and its
// buttons keep the editor's selection, so the app can be used while it is open. Done, Skip tour and its X end it and save
// `onboarded: true`. A step's `target` (a CSS selector) gets a ring while a visible element matching it is on screen, and the
// card then sits beside the ring with an arrow pointing at it, following it; with no target on screen the card is at the top
// centre of the page's viewport (§7g). A step's `view` gets a "Show me" button that shows that page.

const PAD = 4; // px between a target and its ring
const GAP = 12; // px between the ring and the card
const EDGE = 8; // px the card keeps inside the window
const STRIP = 64; // px along the main column's left edge where the board rail, the push-to-talk island and the sidebar button float
const ARROW = { // the arrow on the card's edge that faces the target, `a` px along that edge (the card is `dir` of the target)
  right: (a) => ({ left: -1, top: a, translate: '-50% -50%' }),
  left: (a) => ({ right: -1, top: a, translate: '50% -50%' }),
  above: (a) => ({ left: a, bottom: -1, translate: '-50% 50%' }),
  below: (a) => ({ left: a, top: -1, translate: '-50% -50%' }),
};

/** Starts the tour at its first step. */
export const startTour = () => setState({ tour: { step: 0 } });

/** From step `from` to step `to`; past the last step the tour ends. A stale call (the tour has moved on or closed) does nothing. */
function go(from, to) {
  if (getState().tour?.step !== from) return;
  if (to < STEPS.length) return setState({ tour: { step: to } });
  setState({ tour: null });
  saveSettings({ onboarded: true });
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/** The ring and the card `card` for target element `el` (client rect `r`): a target in the sidebar or in the main column's
 * left STRIP has the card on its right, one at the window's right edge on its left, both vertically centred on it; one in the
 * lower half has it above; any other has it below, both centred on it. Beside the sidebar the card is flush with the islands
 * in the STRIP (left-2) and covers them whole; any other card stays right of the STRIP. It stays EDGE inside the window,
 * below the title strip and above the status bar, and GAP above the toolbar island. */
function place(el, r, card) {
  const [w, h] = [card.offsetWidth, card.offsetHeight];
  const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2];
  const side = el.closest('[data-agent-area="sidebar"]')?.getBoundingClientRect();
  const main = document.querySelector('main').getBoundingClientRect();
  const dir = side || r.left - main.left < STRIP ? 'right' : innerWidth - r.right < STRIP ? 'left' : cy > innerHeight / 2 ? 'above' : 'below';
  const across = dir === 'right' || dir === 'left';
  const x = { right: side ? side.right + 8 : r.right + PAD + GAP, left: r.left - PAD - GAP - w }[dir] ?? cx - w / 2;
  const left = clamp(x, side ? EDGE : main.left + STRIP, innerWidth - w - EDGE);
  const bar = document.querySelector('[data-agent-area="toolbar"]')?.getBoundingClientRect();
  const floor = bar?.width && left < bar.right && left + w > bar.left ? bar.top - GAP : main.bottom - EDGE;
  const top = clamp(across ? cy - h / 2 : dir === 'above' ? r.top - PAD - GAP - h : r.bottom + PAD + GAP, TITLEBAR + EDGE, floor - h);
  // The arrow at the target's centre along that edge; none where that is past the card's rounded corners (a clamped card).
  const arrow = Math.round(across ? cy - top : cx - left);
  return {
    ring: { left: r.left - PAD, top: r.top - PAD, width: r.width + 2 * PAD, height: r.height + 2 * PAD },
    left: Math.round(left), top: Math.round(top), dir, arrow: arrow >= 12 && arrow <= (across ? h : w) - 12 ? arrow : null,
  };
}

/** place() for the first visible element matching `target` while it is on screen, else null; recomputed every frame, so the
 * ring and the card follow it (resize, scroll, layout, the card's own height). */
function useAnchor(target, card) {
  const [at, setAt] = useState(null);
  useEffect(() => {
    setAt(null);
    if (!target) return undefined;
    let frame;
    let last = 'null';
    const follow = () => {
      frame = requestAnimationFrame(follow);
      const el = [...document.querySelectorAll(target)].find((x) => x.checkVisibility({ visibilityProperty: true }));
      const r = el?.getBoundingClientRect();
      const next = r?.width && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && card.current ? place(el, r, card.current) : null;
      const key = JSON.stringify(next);
      if (key !== last) setAt(next);
      last = key;
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return at;
}

/** The tour card and its ring (one, mounted in App). */
export function Onboarding() {
  const tour = useStore((s) => s.tour);
  const fresh = useStore((s) => !!s.settings && !s.settings.onboarded);
  const smoke = useStore((s) => s.smoke);
  const page = useStore((s) => s.view.type);
  const box = useViewportBox(!!tour);
  const card = useRef(null);
  const step = tour && STEPS[tour.step];
  const at = useAnchor(!smoke && step?.target, card);
  useEffect(() => {
    if (fresh && !WORKER) startTour();
  }, [fresh]);
  if (!tour || smoke || !box) return null;
  const i = tour.step;
  const { title, body: Body, view, Actions } = step;
  return (
    <>
      {at && <div data-tour-ring aria-hidden className="pointer-events-none fixed z-45 rounded-island border-2 border-primary ring-4 ring-primary/25" style={at.ring} />}
      <div ref={card} {...CHROME} data-tour role="region" aria-label="Tour" onMouseDown={keepFocus}
        className={cn('z-45 w-[26rem] max-w-[calc(100%-2rem)] rounded-island border bg-card p-3 text-sm shadow-xl', at ? 'fixed' : 'absolute -translate-x-1/2')}
        style={at ? { left: at.left, top: at.top } : { left: box.left + box.width / 2, top: box.top + 12 }}>
        {at?.arrow != null && (
          <span aria-hidden data-dir={at.dir} style={ARROW[at.dir](at.arrow)}
            className="absolute size-2.5 rotate-45 bg-card data-[dir=above]:border-r data-[dir=above]:border-b data-[dir=below]:border-t data-[dir=below]:border-l data-[dir=right]:border-b data-[dir=right]:border-l data-[dir=left]:border-t data-[dir=left]:border-r" />
        )}
        <div className="flex items-center gap-2">
          <p className="font-medium">{title}</p>
          <span className="ml-auto text-xs text-muted-foreground">{`${i + 1} / ${STEPS.length}`}</span>
          <Button variant="ghost" size="icon-xs" aria-label="Close tour" title="Close tour" onClick={() => go(i, STEPS.length)}><X /></Button>
        </div>
        <div className="mt-2 grid gap-2">{typeof Body === 'function' ? <Body /> : Body}</div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {view && page !== view && <Button variant="outline" size="sm" onClick={() => showPage(view)}>Show me</Button>}
          {Actions && <Actions next={() => go(i, i + 1)} />}
          <div className="ml-auto flex gap-2">
            {i
              ? <Button variant="ghost" size="sm" onClick={() => go(i, i - 1)}>Back</Button>
              : <Button variant="ghost" size="sm" onClick={() => go(i, STEPS.length)}>Skip tour</Button>}
            <Button size="sm" onClick={() => go(i, i + 1)}>{i === STEPS.length - 1 ? 'Done' : 'Next'}</Button>
          </div>
        </div>
      </div>
    </>
  );
}
