// The chat panel's place in the page's viewport (SPEC §7i; automation plan §13.4 Move, resize and anchoring), pure: rects are
// {left, top, width, height} relative to the viewport's top-left, `vp` is {width, height}, `min` {w, h} and `m` the margin
// kept to every viewport edge (px). A stored place is {x: 'left'|'right', dx, y: 'top'|'bottom', dy, w, h}: the gaps to the
// anchored edges and the size.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** One axis of placePanel: the size shrinks toward `lo` keeping the gap, then the gap toward `m`; a viewport smaller than
 * that is filled minus the margin. → [size, gap] */
function axis(size, gap, room, lo, m) {
  const s = Math.max(0, Math.min(size, Math.max(lo, room - gap - m), room - 2 * m));
  return [s, Math.max(m, Math.min(gap, room - m - s))];
}

/** The rect of stored place `p` in `vp`, clamped without changing `p` (it comes back when room does). */
export function placePanel(p, vp, min, m) {
  const [width, gx] = axis(p.w, p.dx, vp.width, min.w, m);
  const [height, gy] = axis(p.h, p.dy, vp.height, min.h, m);
  return { left: p.x === 'left' ? gx : vp.width - gx - width, top: p.y === 'top' ? gy : vp.height - gy - height, width, height };
}

/** Rect `r` moved (`corner` null) or resized from `corner` by the pointer's travel (dx, dy): a corner ('nw' | 'ne' | 'sw' |
 * 'se', the opposite corner fixed) or an edge ('n' | 'e' | 's' | 'w', the opposite edge fixed), kept inside `vp` minus the
 * margin and at least `min`. */
export function dragPanel(r, corner, dx, dy, vp, min, m) {
  if (!corner) return { ...r, left: clamp(r.left + dx, m, vp.width - m - r.width), top: clamp(r.top + dy, m, vp.height - m - r.height) };
  let { left, top, width, height } = r;
  if (corner.includes('w')) {
    const right = left + width;
    left = clamp(left + dx, m, right - min.w);
    width = right - left;
  } else if (corner.includes('e')) width = clamp(width + dx, min.w, vp.width - m - left);
  if (corner.includes('n')) {
    const bottom = top + height;
    top = clamp(top + dy, m, bottom - min.h);
    height = bottom - top;
  } else if (corner.includes('s')) height = clamp(height + dy, min.h, vp.height - m - top);
  return { left, top, width, height };
}

/** The place stored when a drag or resize ends: anchored to the nearer horizontal and vertical edges (a tie: right, bottom). */
export function anchorPanel(r, vp) {
  const right = vp.width - r.left - r.width;
  const bottom = vp.height - r.top - r.height;
  return {
    x: right <= r.left ? 'right' : 'left', dx: Math.round(Math.min(right, r.left)),
    y: bottom <= r.top ? 'bottom' : 'top', dy: Math.round(Math.min(bottom, r.top)),
    w: Math.round(r.width), h: Math.round(r.height),
  };
}
