// The viewport's tool layer (docs/plans/engine/viewport-design.md section 3; stage2b.md, engine-page-tools): the one place every
// 2D canvas product's pointer tools plug in, so documents, slides and a designer share it. One tool at a time takes the pointer on
// the viewport's surfaces instead of the text selection: it hears the press, the drag and the release in surface points, draws
// its preview over the tiles from what the engine answered, and commits through its own engine commands (one undo step each).
// Esc, or setting another tool, ends it. It knows no product types. A tool is
//   { session, cursor?, down(at, e), move?(at, e), up?(at, e), hover?(at, e), key?(e) → true when it took the key,
//     preview?(surface) → items, menu?(at, e) → entries, end?() }
// where `at` is {session, surface, x, y} in surface points: the surface under the pointer, or for a drag and a hover the
// nearest surface of the tool's session, so a drag past a page's edge keeps going. A press off every surface ends the tool,
// unless it says `anywhere`. A `passive` tool (keys only) hears the press and lets it go on to the text.
// A right-click asks the tool's `menu` for its entries [{label, run, disabled?}] (a label's & marks its access key, null is a
// separator, a promise is waited for), which show at the pointer in the screen plane until one runs, Esc or a press elsewhere.
// Preview items are in surface points, drawn in the world plane over the tool's surfaces:
//   {rect: {x, y, w, h}} | {path: [[x, y], ...], closed?} | {handle: [x, y]} (a square that keeps its screen size)
// each with optional stroke, fill, dash (true for a dashed line), width (screen px) and opacity.
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { nearest } from './placements.mjs';

const CONTROLS = 'button, a, input, select, textarea, [role="button"]';
const HANDLE = 7; // px: a handle's side
const INK = 'color-mix(in srgb, Highlight 85%, #000000)';

/** The tool layer of viewport `vp` → {current, menu, set(tool), end(), redraw(), closeMenu(), pick(entry), subscribe(fn),
 * version(), destroy()}. */
export function createTools(vp) {
  const root = vp.root;
  const win = root.ownerDocument?.defaultView ?? globalThis;
  const fns = new Set();
  let tool = null;
  let dragging = false;
  let version = 0;
  let menu = null; // {x, y (client px), entries}
  const changed = () => {
    version++;
    for (const fn of fns) fn();
  };

  /** Client point → the tool's surface point under it, or with `near` the nearest of its session's surfaces. */
  const atOf = (e, near) => {
    const { world, target } = vp.fromClient(e.clientX, e.clientY);
    if (target && target.session === tool?.session) return target;
    if (!near) return null;
    const t = nearest(vp.placements.filter((p) => p.session === tool?.session), world);
    return t && { session: t.session, surface: t.surface, x: t.x, y: t.y };
  };
  const offView = (e) => {
    const r = root.getBoundingClientRect();
    if (e.clientX - r.left - root.clientLeft >= root.clientWidth || e.clientY - r.top - root.clientTop >= root.clientHeight) return true;
    const c = e.target !== root && e.target?.closest?.(CONTROLS);
    return !!c && root.contains(c);
  };

  const move = (e) => {
    if (!tool || !dragging) return;
    if (e.buttons === 0) return up(e); // the release went elsewhere
    const at = atOf(e, true);
    if (at) tool.move?.(at, e);
  };
  const up = (e) => {
    if (!dragging) return;
    dragging = false;
    win.removeEventListener('mousemove', move, true);
    win.removeEventListener('mouseup', up, true);
    const at = tool && atOf(e, true);
    if (at) tool.up?.(at, e);
  };
  // Capture phase on the root: the tool takes the press before the text selection (src/engine/input/pointer.js) sees it.
  const down = (e) => {
    if (!tool || offView(e)) return;
    if (menu) {
      // A press away from the open menu only closes it, as a menu does.
      e.preventDefault();
      e.stopImmediatePropagation();
      return closeMenu();
    }
    if (e.button === 2 && tool.menu) {
      // Its menu follows (contextmenu); the press must not move the selection the tool works on.
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.button !== 0) return;
    if (tool.passive) return void tool.down?.(atOf(e, true), e);
    const at = atOf(e, false);
    if (!at && !tool.anywhere) {
      set(null);
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    root.focus({ preventScroll: true });
    dragging = true;
    win.addEventListener('mousemove', move, true);
    win.addEventListener('mouseup', up, true);
    tool.down(at ?? atOf(e, true), e);
  };
  const hover = (e) => {
    if (!tool?.hover || dragging) return;
    const at = atOf(e, true);
    if (at) tool.hover(at, e);
  };
  const key = (e) => {
    if (!tool) return;
    if (menu) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') return closeMenu();
      const hit = menu.entries.find((m) => m && !m.disabled && accessKey(m.label) === e.key.toLowerCase());
      if (hit) pick(hit);
      return;
    }
    if (tool.key?.(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      set(null);
    }
  };
  const context = async (e) => {
    if (!tool?.menu || offView(e)) return;
    const at = atOf(e, true);
    const got = at && tool.menu(at, e);
    if (!got) return; // no menu of the tool's here: the right-click goes on to the page's own
    e.preventDefault();
    e.stopImmediatePropagation();
    const entries = await got;
    menu = entries?.some(Boolean) ? { x: e.clientX, y: e.clientY, entries } : null;
    root.focus({ preventScroll: true });
    changed();
  };
  function closeMenu() {
    if (!menu) return;
    menu = null;
    changed();
  }
  function pick(entry) {
    closeMenu();
    entry.run?.();
  }
  root.addEventListener('mousedown', down, true);
  root.addEventListener('mousemove', hover);
  root.addEventListener('keydown', key, true);
  root.addEventListener('contextmenu', context, true);
  // A press anywhere else in the window (the ribbon, a pane) or leaving the window closes the menu too.
  const away = (e) => {
    if (menu && !root.contains(e.target)) closeMenu();
  };
  win.addEventListener('mousedown', away, true);
  win.addEventListener('blur', closeMenu);

  function set(next) {
    if (next === tool) return;
    const was = tool;
    tool = next;
    dragging = false;
    menu = null;
    root.style.cursor = next?.cursor ?? '';
    was?.end?.();
    changed();
  }
  return {
    get current() {
      return tool;
    },
    /** The tool's open right-click menu {x, y (client px), entries}, or null. */
    get menu() {
      return menu;
    },
    set,
    closeMenu,
    /** Runs menu entry `entry` once the menu has closed. */
    pick,
    /** Ends the tool now showing, if it is `t` (or any, without `t`). */
    end(t) {
      if (!t || t === tool) set(null);
    },
    /** The tool's preview changed: draw it again. */
    redraw: changed,
    subscribe(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    version: () => version,
    destroy() {
      set(null);
      root.removeEventListener('mousedown', down, true);
      root.removeEventListener('mousemove', hover);
      root.removeEventListener('keydown', key, true);
      root.removeEventListener('contextmenu', context, true);
      win.removeEventListener('mousedown', away, true);
      win.removeEventListener('blur', closeMenu);
      win.removeEventListener('mousemove', move, true);
      win.removeEventListener('mouseup', up, true);
    },
  };
}

const LAYER = { position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' };

/** The access key of menu label `label` (the letter after &), lower case, or null. */
const accessKey = (label) => /&(.)/.exec(label ?? '')?.[1]?.toLowerCase() ?? null;

/** Label `label` with its access key underlined. */
function Label({ label }) {
  const i = label.indexOf('&');
  if (i < 0) return label;
  return <>{label.slice(0, i)}<u>{label[i + 1]}</u>{label.slice(i + 2)}</>;
}

/** The tool's right-click menu at the pointer, drawn once per viewport in its screen plane. Its entries are buttons, which the
 * tool layer lets a press through to. */
export function ToolMenu({ tools }) {
  useSyncExternalStore(tools.subscribe, tools.version);
  const el = useRef(null);
  const m = tools.menu;
  useLayoutEffect(() => {
    const box = el.current;
    const host = box?.offsetParent;
    if (!box || !host || !m) return;
    const r = host.getBoundingClientRect();
    box.style.left = `${m.x - r.left + host.scrollLeft}px`;
    box.style.top = `${m.y - r.top + host.scrollTop}px`;
  });
  if (!m) return null;
  return (
    <div ref={el} role="menu" data-tool-menu="" style={{ position: 'absolute', pointerEvents: 'auto', zIndex: 20, minWidth: 160, padding: '4px 0',
      background: 'var(--popover, #ffffff)', color: 'var(--popover-foreground, #000000)', border: '1px solid var(--border, #c8c8c8)',
      boxShadow: '0 4px 12px rgb(0 0 0 / 0.2)', font: '13px system-ui, sans-serif' }}>
      {m.entries.map((it, i) => (it
        ? (
          <button key={i} type="button" role="menuitem" disabled={!!it.disabled} data-tool-menu-item={it.label.replace('&', '')}
            onMouseDown={(e) => e.preventDefault()} onClick={() => tools.pick(it)}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 20px', border: 'none', background: 'transparent', color: 'inherit',
              font: 'inherit', opacity: it.disabled ? 0.45 : 1, cursor: 'default' }}>
            <Label label={it.label} />
          </button>
        )
        : <div key={i} role="separator" style={{ height: 1, margin: '4px 0', background: 'var(--border, #c8c8c8)' }} />))}
    </div>
  );
}

/** One preview item at `k` CSS px per point. */
function Item({ it, k, i }) {
  const stroke = it.stroke ?? INK;
  const line = { stroke, strokeWidth: it.width ?? 1, fill: it.fill ?? 'none', strokeDasharray: it.dash ? '4 3' : undefined, opacity: it.opacity };
  if (it.rect) return <rect key={i} x={it.rect.x * k} y={it.rect.y * k} width={Math.max(0, it.rect.w * k)} height={Math.max(0, it.rect.h * k)} {...line} />;
  if (it.path) {
    const d = it.path.map(([x, y], j) => `${j ? 'L' : 'M'}${x * k} ${y * k}`).join(' ') + (it.closed ? ' Z' : '');
    return <path key={i} d={d} {...line} strokeLinejoin="round" strokeLinecap="round" />;
  }
  if (it.handle) {
    const [x, y] = it.handle;
    return <rect key={i} x={x * k - HANDLE / 2} y={y * k - HANDLE / 2} width={HANDLE} height={HANDLE} stroke={stroke} strokeWidth={1} fill={it.fill ?? '#ffffff'} />;
  }
  return null;
}

/** The world overlay that draws the tool's preview over surface `surface` of `session` at `k` CSS px per point. */
export function ToolLayer({ tools, session, surface, k }) {
  useSyncExternalStore(tools.subscribe, tools.version);
  const t = tools.current;
  const items = t && t.session === session ? t.preview?.(surface) : null;
  if (!items?.length) return null;
  return (
    <svg data-tool-preview={surface} style={LAYER} width="100%" height="100%">
      {items.map((it, i) => <Item key={i} it={it} k={k} i={i} />)}
    </svg>
  );
}
