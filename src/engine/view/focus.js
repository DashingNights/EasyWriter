// A viewport's focus target (docs/plans/engine/viewport-design.md section 4.7): {session, mode: 'text' | 'object' | null}, the
// session that keys, the EditContext, the accessibility mirror and the tools follow. A pointer down on a surface or Tab sets it;
// the format host mirrors each change into the store's focusedSession through `mirror` (src/engine imports nothing of src/app).

const NONE = Object.freeze({ session: null, mode: null });

/** A focus holder → {get(), set({session, mode}), subscribe(fn)}. `mirror(focus)` hears every change. */
export function createFocus(mirror) {
  let focus = NONE;
  const fns = new Set();
  return {
    get: () => focus,
    set(next) {
      const session = next?.session ?? null;
      const mode = session == null ? null : next.mode ?? 'text';
      if (session === focus.session && mode === focus.mode) return;
      focus = Object.freeze({ session, mode });
      mirror?.(focus);
      for (const fn of fns) fn(focus);
    },
    subscribe(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
}

/** The session after (`dir` 1) or before (-1) `session` among the sessions of `placements` in their order, wrapping: Tab and
 * Shift+Tab between drafts on one plane. Null without placements. */
export function nextSession(placements, session, dir = 1) {
  const list = [...new Set(placements.map((p) => p.session ?? null))];
  if (!list.length) return null;
  const i = list.indexOf(session ?? null);
  if (i < 0) return list[dir < 0 ? list.length - 1 : 0];
  return list[(i + dir + list.length) % list.length];
}
