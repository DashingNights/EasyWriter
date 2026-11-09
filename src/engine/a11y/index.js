// Accessibility and spelling for every session a viewport shows (docs/plans/engine/viewport-design.md section 7, P10), in one call:
//   const a11y = attachA11y(vp, { clientOf, title, proofing: { options, rules, menu }, subscribe });
//   ...; a11y.destroy();
// One accessibility root per Viewport, in its world plane, so it moves with the tiles on a scroll and a zoom gesture. Each session
// in view is a role="document" region over its pages: the focused session's holds the copy (copy.js), its lines laid over the
// painted ones, with the DOM selection mirrored; any other is labelled with its title and page count and builds its copy when it
// takes focus. Every session in view gets spelling on its visible pages, the focused one first, drawn as the viewport's
// 'squiggle' marks; under forced colours (Windows High Contrast) every one paints its tiles in the system's colours.
// The host passes what the engine may not import (section 3): `clientOf(session)` its SessionClient, `title(session)` the draft's
// title, `proofing.options()` the proofing options with `on` (the spelling switch), `proofing.rules` and `proofing.menu` the word
// rules and the spelling menu (spell/squiggles.js), and `subscribe` the store's, so a change to the options checks again.
import { rpc } from './blocks.js';
import { createA11yCopy } from './copy.js';
import { watchForcedColors } from './forced.js';
import { createSpellChecker } from '../spell/checker.js';
import { createSpelling } from '../spell/squiggles.js';
import { kOf } from '../view/camera.mjs';
import { bounds, visible } from '../view/placements.mjs';

const GREEK_PX = 3; // the tiles' greeking size (engine/crates/wasm/src/tiles.rs): smaller text is a grey bar, so no squiggles
// ponytail: the greeking test takes a draft's text as 10 pt; the blocks' own sizes when a draft in tiny print needs them.
const TEXT_PT = 10;
// The copy and spelling follow a scroll once it rests: they ask the worker for blocks, which would hold up the tiles mid-scroll.
const SETTLE_MS = 150;

// The copy is transparent text over the painted lines: no selection colour, never forced into view by High Contrast, no pointer.
const STYLE = `[data-engine-a11y-root]{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;color:transparent;forced-color-adjust:none}
[data-engine-a11y-root]>[data-session]{position:absolute}
[data-engine-a11y-root] [data-line]{position:absolute;white-space:pre;font-family:sans-serif;transform-origin:0 0;transform:scale(calc(var(--k,1)*0.75*var(--f,1)),calc(var(--k,1)*0.75))}
[data-engine-a11y-root] [data-m]{position:absolute;right:100%}
[data-engine-a11y-root] ::selection{background:transparent;color:transparent}`;

function addStyle(doc) {
  if (doc.querySelector('style[data-engine-a11y-style]')) return;
  const s = doc.createElement('style');
  s.setAttribute('data-engine-a11y-style', '');
  s.textContent = STYLE;
  doc.head.append(s);
}

const pages = (n) => `${n} ${n === 1 ? 'page' : 'pages'}`;

/** The accessibility root and spelling of viewport `vp` (src/engine/view createViewport) → {root, regions(), destroy()}. */
export function attachA11y(vp, { clientOf, title = () => 'Document', proofing = {}, subscribe = null, checker = createSpellChecker() }) {
  const doc = vp.root.ownerDocument;
  addStyle(doc);
  const root = doc.createElement('div');
  root.setAttribute('data-engine-a11y-root', '');
  // A polite status beside the root, outside every session's role="document" region, so browse mode never reads it as the
  // document's text: the focused session's copy says there how many ranges are selected.
  const status = doc.createElement('div');
  status.setAttribute('role', 'status');
  status.setAttribute('data-engine-a11y-status', '');
  Object.assign(status.style, { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)' });
  const say = (text) => {
    if (status.textContent !== text) status.textContent = text;
  };
  // Each session's copy speaks through its own voice, and clears the status only while it was the last to speak: when the
  // focus moves, the old copy's destroy can run after the new copy's first announce.
  let speaker = null;
  const voice = () => {
    const me = {};
    return (text) => {
      if (!text && speaker !== me) return;
      speaker = me;
      say(text);
    };
  };
  (vp.root.querySelector(':scope > [data-viewport-sizer] > [data-plane="world"]') ?? vp.root).append(root, status);
  const options = () => ({ ...(proofing.options?.() ?? {}) });
  const views = new Map(); // session → its region, copy and spelling
  let colors = null;
  let k = null;

  /** Session `id`'s part of the root, on engine `client`. */
  function sessionView(id, client) {
    const el = doc.createElement('div');
    el.setAttribute('role', 'document');
    el.dataset.session = String(id);
    const vars = new Map(); // the custom properties written, so an unchanged one is not written again
    const prop = (name, v) => {
      if (vars.get(name) === v) return;
      vars.set(name, v);
      el.style.setProperty(name, v);
    };
    let list = []; // the session's placements
    let want = { seen: [], greeked: false }; // the pages in view, for read()
    let copy = null;
    let painted = null; // the colours the session has: none at first
    let at = ''; // the region's box as last written
    const spelling = createSpelling({ client, checker, options, rules: proofing.rules, menu: proofing.menu });
    let drawn = '[]'; // the squiggles given to the viewport: a check that found the same ones draws no page again
    const offs = [
      spelling.subscribe((items) => {
        const marks = items.flatMap((it) => it.rects.map((r) => ({ session: id, surface: r.page, x: r.x, y: r.y, w: r.w, h: r.h })));
        const now = JSON.stringify(marks);
        if (now === drawn) return;
        drawn = now;
        vp.marks.set(`spelling:${id}`, 'squiggle', marks);
      }),
      // A new worker after a crash starts without the colours.
      client.on?.('reopened', () => {
        painted = null;
        v.paint();
      }),
    ];
    /** The region over the session's pages, and the offsets of the surfaces its copy holds from the region's corner (points). */
    const place = () => {
      const b = bounds(list);
      const e = vp.extent;
      if (!b) return;
      const box = [(b.x - e.x) * k, (b.y - e.y) * k, b.w * k, b.h * k].map((n) => `${n}px`);
      if (box.join() !== at) {
        at = box.join();
        Object.assign(el.style, { left: box[0], top: box[1], width: box[2], height: box[3] });
      }
      for (const n of copy?.pages ?? []) {
        const p = list.find((q) => q.surface === n);
        if (!p) continue;
        prop(`--s${n}x`, String(p.x - b.x));
        prop(`--s${n}y`, String(p.y - b.y));
      }
    };
    const v = {
      el,
      spelling,
      get copy() {
        return copy;
      },
      /** Shows the session: `all` its placements, `seen` its surfaces in view, `focused` whether it has the focus, `greeked`
       * whether its text is too small for squiggles. The copy and spelling take the pages at read(). */
      show({ all, seen, focused, greeked }) {
        list = all;
        want = { seen, greeked };
        if (focused && !copy) copy = createA11yCopy({ client, el, owner: vp.root, onBuilt: place, say: voice() });
        if (!focused && copy) {
          copy.destroy();
          copy = null;
        }
        const label = focused ? title(id) : `${title(id)}, ${pages(all.length)}`;
        if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
        place();
        v.paint();
      },
      /** The copy and spelling take the pages in view. */
      read() {
        copy?.setPages(want.seen);
        spelling.setPages(want.greeked ? [] : want.seen);
      },
      /** Sends the forced colours to the session when they changed. */
      paint() {
        if (painted === colors) return;
        painted = colors;
        Promise.resolve(rpc(client, 'colors', colors)).catch(() => {});
      },
      destroy() {
        for (const off of offs) off?.();
        copy?.destroy();
        spelling.destroy();
        vp.marks.set(`spelling:${id}`, 'squiggle', null);
        el.remove();
      },
    };
    return v;
  }

  let timer = 0;
  let order = []; // the sessions shown, the focused one first

  /** Places the regions now; the copy and spelling read the pages in view now, or once a scroll rests (`settle`). */
  function update(settle = false) {
    const kNow = kOf(vp.camera.zoom);
    if (kNow !== k) root.style.setProperty('--k', String((k = kNow)));
    const all = new Map(); // session → its placements, in the placements' order
    for (const p of vp.placements) {
      if (!all.has(p.session)) all.set(p.session, []);
      all.get(p.session).push(p);
    }
    const seen = new Map(); // session → its surfaces in view
    for (const p of visible(vp.placements, vp.view())) {
      if (!seen.has(p.session)) seen.set(p.session, []);
      seen.get(p.session).push(p.surface);
    }
    const focused = vp.focus.session;
    const ids = [...all.keys()].filter((id) => seen.has(id) || id === focused);
    for (const [id, v] of views) {
      if (ids.includes(id)) continue;
      v.destroy();
      views.delete(id);
    }
    const greeked = k * devicePixelRatio * TEXT_PT < GREEK_PX;
    // The focused session first, so its copy and spelling are asked for before the others'.
    order = [...ids].sort((a, b) => (b === focused) - (a === focused));
    for (const id of order) {
      let v = views.get(id);
      const client = !v && clientOf(id);
      if (!v && !client) continue;
      if (!v) views.set(id, (v = sessionView(id, client)));
      v.show({ all: all.get(id), seen: seen.get(id) ?? [], focused: id === focused, greeked });
    }
    // The regions in reading order, the placements' order.
    const els = ids.map((id) => views.get(id)?.el).filter(Boolean);
    if (els.some((el, i) => root.children[i] !== el)) root.append(...els);
    clearTimeout(timer);
    if (settle) timer = setTimeout(read, SETTLE_MS);
    else read();
  }

  function read() {
    for (const id of order) views.get(id)?.read();
  }

  // A change to the proofing options checks every session again.
  let last = JSON.stringify(options());
  const offs = [
    vp.subscribe('camera', () => update(true)),
    vp.subscribe('placements', () => update()),
    vp.subscribe('focus', () => update()),
    subscribe?.(() => {
      const now = JSON.stringify(options());
      if (now === last) return;
      last = now;
      for (const v of views.values()) v.spelling.refresh();
    }),
    watchForcedColors(doc, (c) => {
      colors = c;
      for (const v of views.values()) v.paint();
    }),
  ];
  update();

  return {
    root,
    /** The sessions shown now → [{session, el, copy, spelling}]. */
    regions: () => [...views].map(([session, v]) => ({ session, el: v.el, copy: v.copy, spelling: v.spelling })),
    destroy() {
      clearTimeout(timer);
      for (const off of offs) off?.();
      for (const v of views.values()) v.destroy();
      views.clear();
      root.remove();
      status.remove();
    },
  };
}
