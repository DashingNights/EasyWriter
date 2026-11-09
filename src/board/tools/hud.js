// bd-hud (docs/plans/board/briefs/bd-hud.md, design section 8): a double-click on a document's page focuses it as a Documents
// view does, Enter is the keyboard path, Esc or a press elsewhere leaves. The HUD follows the most verbose format among the
// focus and the documents in view, and the camera holds the page still when the ribbon moves the view's edge.
import { getState, setState } from '../../app/store.js';
import { kOf } from '../../engine/view/camera.mjs';
import { cancelEntry, enterSelected, focusedPage, leaveDocument, onDoubleClick, refreshHud, takesDocument } from '../focus.js';
import { registerTool } from './registry.js';

/** The settle time before a camera move recalcs the HUD, matching the instance layer's (bd-instance SETTLE_MS). */
const SETTLE_MS = 160;

export default registerTool({
  id: 'hud',

  mount(ctx) {
    const vp = ctx.vp;
    const root = vp?.root;
    const offs = [];
    let last = root?.getBoundingClientRect() ?? null;

    // The ribbon or a side pane moving the view's edge: the camera takes the same delta, so the page under the pointer holds
    // still on screen (the user's anchors rule).
    const ro = root ? new ResizeObserver(() => {
      const now = root.getBoundingClientRect();
      if (!last) last = now;
      const [dx, dy] = [now.left - last.left, now.top - last.top];
      last = now;
      if (!dx && !dy) return;
      const k = kOf(vp.camera.zoom);
      vp.setCamera({ x: vp.camera.x + dx / k, y: vp.camera.y + dy / k, zoom: vp.camera.zoom });
    }) : null;
    ro?.observe(root);

    // The HUD recomputes on the settled camera: a document scrolled into a quarter of the view raises the ribbon.
    let settle = 0;
    offs.push(vp.subscribe('camera', () => {
      clearTimeout(settle);
      settle = setTimeout(() => refreshHud(ctx.api), SETTLE_MS);
    }));

    // A press cancels an entry in hand; on a focused document, one on empty plane or on another item leaves, one on its own pages
    // is the session's, and one on the chrome (the ribbon) is the chrome's.
    const onPress = (e) => {
      cancelEntry(ctx.api);
      if (e.button !== 0 || getState().boardFocus?.kind !== 'document') return;
      if (e.target?.closest?.('[data-board-chrome]')) return;
      if (takesDocument(ctx.api, e)) return;
      leaveDocument(ctx.api);
    };
    root?.addEventListener('pointerdown', onPress, true);
    offs.push(() => root?.removeEventListener('pointerdown', onPress, true));

    // Esc leaves the document's focus, but only once the session and any popover have had it. A bubble listener on the window is
    // after both. A popover's Esc never reaches the view's own keymap, and Radix prevents the default as it closes; an Esc in the
    // session clears a selection first, as Word's does, and a second Esc on the same selection leaves (its collapse may not
    // arrive). An input method's Esc cancels its composition instead.
    const win = root?.ownerDocument?.defaultView ?? globalThis;
    let escRects = null; // the rects the last Esc saw, while the session has not collapsed them
    const onEsc = (e) => {
      if (e.code !== 'Escape' || e.isComposing || e.keyCode === 229) return;
      if (cancelEntry(ctx.api)) return;
      if (getState().boardFocus?.kind !== 'document') return;
      if (!root?.contains(e.target)) {
        escRects = null;
        if (e.defaultPrevented) return; // the chrome or a popover took it
      } else {
        const rects = ctx.input?.input?.snapshot?.()?.rects ?? [];
        if (rects.length) {
          const key = JSON.stringify(rects);
          const same = key === escRects;
          escRects = key;
          if (!same) return; // the session clears the selection first
        } else {
          escRects = null;
        }
      }
      leaveDocument(ctx.api);
    };
    win?.addEventListener('keydown', onEsc);
    offs.push(() => win?.removeEventListener('keydown', onEsc));

    return () => {
      clearTimeout(settle);
      ro?.disconnect();
      cancelEntry(ctx.api);
      for (const off of offs.splice(0)) off();
      if (getState().boardFocus?.kind === 'document') {
        ctx.vp?.setFocus({ session: null, mode: null });
        setState({ focusedSession: null, boardFocus: null, boardHud: null });
      }
    };
  },

  // A press on the focused document's own page is the session's, not a pick of the board: without this pick the board would
  // find no item there, clear the selection and start a marquee, while the session places the caret (as bd-text's pick does for
  // its box). The section label, the chrome and fields keep their own presses.
  pick(ctx, world) {
    return focusedPage(ctx.api, world) ? { kind: 'doc-focus' } : null;
  },

  // Its press is taken: the session's input places the caret and selects text; the board starts nothing.
  down(ctx, hit) {
    return hit?.kind === 'doc-focus';
  },

  // The rule table: a page of a document, or empty plane with one in view, is this tool's; another item is its own tools'
  // (bd-text, bd-layers, bd-pictures answered before this in the registry). A section label renames on its own double-click,
  // and the ribbon's chrome and fields keep theirs.
  dblclick(ctx, hit, e) {
    if (e.target?.closest?.('[data-board-section-label], [data-board-chrome], input, button, textarea')) return false;
    if (hit?.item && hit.item.type !== 'doc') return false;
    return onDoubleClick(ctx.api, e, hit?.item?.type === 'doc' ? hit.item.id : null);
  },

  // Enter on a selected document is the keyboard path of the double-click rule.
  keydown(ctx, e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return false;
    return enterSelected(ctx.api);
  },
});
