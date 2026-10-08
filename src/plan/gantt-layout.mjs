// Gantt geometry (Gantt plan §5, §6.5, §7.4) in CSS px for one <svg>: rows in tree order, bars, header ticks, shading,
// the today line and orthogonal dependency polylines, from a plan context and its schedule(). Pure; the workspace
// (Gantt.jsx) and the exported chart (ChartView) draw what it returns, and hitTest maps a pointer onto it.

import { fmt, fromDay, fromWork, isWorkday, toDay, weekday, work } from './dates.mjs';
import { filterTickets, OPTION_DEFAULTS, summary, tree } from './plan-model.mjs';

export const ZOOM_PX = { day: 36, week: 10, month: 3, quarter: 1 };
export const GANTT_MAX_ROWS = 60; // the exported chart's limit (§7.4); the workspace shows every row
const LEAD = { day: 3, week: 7, month: 31, quarter: 92, fit: 3 }; // the workspace's days before the first ticket
const ROW_H = 28;
const HEADER_H = 40;
const BAR_H = 18;
const STUB = 12; // dependency lines leave and enter a bar horizontally for this long
const EDGE = 8; // resize zone at each bar end
const PORT = 12; // dependency port beyond each bar end
const DIAMOND = 7; // half width of a milestone

const fail = (code, message) => ({ error: { code, message } });

/** The layout {pxPerDay, left, rowH, headerH, rows, ticks, shading, today, deps, width, height, zoomUsed, start, end, note?}
 * of the scheduled tickets that pass the options' filters (with their ancestors; with `unscheduled`, the workspace's rows,
 * also those without dates: {kind: 'unscheduled', bar: null}), `width` px wide including a task list of
 * `listW` px at the left while options.showTaskList; `start` … `end` are the axis's day numbers. `exporting` applies the chart
 * rules of §7.4: at most 60 rows, and the zoom falls back (day → week → month → quarter → fit, noted in `note`) until the
 * range fits, then whole days fill the rest of the width unless options.range sets the end; refusals return {error}. `fill` {from?, to?, px?} applies the workspace's rules instead: one zoom unit before the
 * tickets and at least two weeks after them (Fit fits that), also the days `from` … `to`, and the rest of the width filled
 * with days unless options.range sets the end; `px` holds Fit's px per day. */
export function ganttLayout(ctx, sched, options = {}, width = 800, { exporting = false, listW = 200, fill = null, unscheduled = false } = {}) {
  const o = { ...OPTION_DEFAULTS, ...options };
  const { plan } = ctx;
  const cal = plan.calendar;
  const shown = new Set(filterTickets(ctx, o).map((t) => t.id));
  for (const id of [...shown]) for (let p = plan.tickets.find((t) => t.id === id).parent; p; p = plan.tickets.find((t) => t.id === p).parent) shown.add(p);
  const list = [];
  const walk = (nodes) => nodes.forEach((n) => {
    if (shown.has(n.ticket.id) && (unscheduled || sched.byId[n.ticket.id]?.scheduled)) list.push(n);
    walk(n.children);
  });
  walk(tree(plan));
  if (exporting && list.length > GANTT_MAX_ROWS) return fail('too_many_rows', `${list.length} rows (at most ${GANTT_MAX_ROWS}): filter it or collapse parents`);

  const today = toDay(ctx.today);
  const [lead, tail] = fill ? [LEAD[o.zoom], Math.max(14, LEAD[o.zoom])] : [2, 2];
  const span = sched.span ? [toDay(sched.span.start) - lead, toDay(sched.span.end) + tail] : [(today ?? 0) - lead, (today ?? 0) + 10 + tail];
  let start = toDay(o.range?.start) ?? span[0];
  let end = Math.max(start, toDay(o.range?.end) ?? span[1]);
  const visible = (d) => o.showWeekends || isWorkday(d, cal);
  const count = (a, b) => (o.showWeekends ? b - a + 1 : work(b + 1, cal) - work(a, cal)); // days on the axis
  let units = count(start, end);
  const left = o.showTaskList ? listW : 0;
  const room = width - left;
  const fitPx = Math.min(36, Math.max(1, room / Math.max(1, units)));
  let zoom = o.zoom;
  let px = zoom === 'fit' ? fill?.px ?? fitPx : ZOOM_PX[zoom];
  const grow = (more) => { // `more` axis days after the end
    if (more > 0) end = o.showWeekends ? end + more : fromWork(work(end + 1, cal) + more - 1, cal);
    units = count(start, end);
  };
  if (fill) {
    start = Math.min(start, fill.from ?? start);
    end = Math.max(end, fill.to ?? end);
    grow(o.range?.end ? 0 : Math.ceil(room / px) - count(start, end));
  }
  let note;
  if (exporting) {
    const order = ['day', 'week', 'month', 'quarter', 'fit'];
    while (zoom !== 'fit' && units * px > room) {
      zoom = order[order.indexOf(zoom) + 1];
      px = zoom === 'fit' ? fitPx : ZOOM_PX[zoom];
    }
    if (units * px > room + 0.5) return fail('range_too_long', `The range of ${units} days does not fit ${Math.floor(room)} px: shorten it`);
    if (!o.range?.end) grow(Math.floor((room - units * px) / px + 1e-9)); // whole days up to the right edge, not a strip at the left
    if (zoom !== o.zoom) note = `${Math.ceil((end - start + 1) / 7)} weeks shown ${zoom === 'fit' ? 'to fit' : `at ${zoom} zoom`}`;
  }
  const x0 = o.showWeekends ? start : work(start, cal);
  const right = left + units * px;
  const pos = (day) => left + ((o.showWeekends ? day : work(day, cal)) - x0) * px;
  const clamp = (x) => Math.min(right, Math.max(left, x));
  // days s … e; never negative (a summary of milestones only has e = s − 1, a hand-edited baseline may end before it starts)
  const span1 = (s, e) => ({ x: clamp(pos(s)), w: Math.max(0, clamp(pos(e + 1)) - clamp(pos(s))) });

  const rows = list.map(({ ticket: t, depth }, i) => {
    const n = sched.byId[t.id];
    const row = { id: t.id, y: HEADER_H + i * ROW_H, depth, critical: o.showCritical && n.critical, conflict: n.conflict, blocked: n.blocked };
    if (!n.scheduled) return { ...row, kind: 'unscheduled', bar: null, progressW: 0 };
    if (n.summary) {
      return { ...row, kind: 'summary', summary: true, bar: span1(fromWork(n.s, cal), fromWork(n.e - 1, cal)), progressW: 0, progress: summary(plan, t.id)?.progress ?? 0 };
    }
    const s = toDay(t.start);
    if (t.milestone) return { ...row, kind: 'milestone', milestone: true, bar: { x: clamp(pos(s) + px / 2), w: 0 }, progressW: 0 };
    const bar = span1(s, toDay(t.end));
    const out = { ...row, kind: 'task', bar, progressW: (bar.w * t.progress) / 100 };
    if (o.showBaseline && t.baseline) out.baseline = span1(toDay(t.baseline.start), toDay(t.baseline.end));
    return out;
  });

  // Header ticks: a major (top row) and a minor (bottom row) tick on the first visible day of each period.
  const scale = zoom !== 'fit' ? zoom : px >= 20 ? 'day' : px >= 6 ? 'week' : px >= 2 ? 'month' : 'quarter';
  const weekLabel = o.weekLabels === 'number' && cal.weekOne ? 'Wk n' : 'd MMM';
  const PERIODS = { // [major key, major label, minor key, minor label]
    day: (d, ymd) => [ymd.slice(0, 7), 'MMM yyyy', ymd, 'd'],
    week: (d, ymd) => [ymd.slice(0, 7), 'MMM', d - ((weekday(d) + 6) % 7), weekLabel],
    month: (d, ymd) => [ymd.slice(0, 4), 'yyyy', ymd.slice(0, 7), 'MMM'],
    quarter: (d, ymd) => [ymd.slice(0, 4), 'yyyy', `${ymd.slice(0, 4)}Q${Math.floor((ymd.slice(5, 7) - 1) / 3)}`, 'Qn'],
  };
  const ticks = [];
  const shading = [];
  let last = [];
  for (let d = start; d <= end; d++) {
    if (!visible(d)) continue;
    const [major, majorFmt, minor, minorFmt] = PERIODS[scale](d, fromDay(d));
    if (major !== last[0]) ticks.push({ x: pos(d), label: fmt(d, majorFmt, cal), major: true });
    if (minor !== last[1]) ticks.push({ x: pos(d), label: fmt(d, minorFmt, cal), major: false });
    last = [major, minor];
    if (!isWorkday(d, cal) && o.showWeekends) { // weekends (from month zoom up) and holidays, consecutive days merged
      const kind = cal.workdays.includes(weekday(d)) ? 'holiday' : 'weekend';
      if (kind === 'weekend' && px < 3) continue;
      const prev = shading.at(-1);
      if (prev?.kind === kind && Math.abs(prev.x + prev.w - pos(d)) < 0.01) prev.w += px;
      else shading.push({ x: pos(d), w: px, kind });
    }
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const anchor = (r, atEnd) => (r.kind === 'milestone' ? r.bar.x + (atEnd ? DIAMOND : -DIAMOND) : r.bar.x + (atEnd ? r.bar.w : 0));
  const deps = [];
  if (o.showDeps) {
    for (const r of rows) {
      const t = plan.tickets.find((x) => x.id === r.id);
      for (const d of t.deps) {
        const p = byId.get(d.on);
        if (!p?.bar || !r.bar || p.kind === 'summary' || r.kind === 'summary') continue;
        const fromEnd = d.type[0] === 'F';
        const toEnd = d.type[1] === 'F';
        const [sx, sy, tx, ty] = [anchor(p, fromEnd), p.y + ROW_H / 2, anchor(r, toEnd), r.y + ROW_H / 2];
        const a = sx + (fromEnd ? STUB : -STUB);
        const b = tx + (toEnd ? STUB : -STUB);
        const gy = sy + (ty > sy ? ROW_H / 2 : -ROW_H / 2); // the gap between the rows
        const points = (toEnd ? a >= b : a <= b)
          ? [[sx, sy], [a, sy], [a, ty], [tx, ty]]
          : [[sx, sy], [a, sy], [a, gy], [b, gy], [b, ty], [tx, ty]];
        deps.push({ from: d.on, to: r.id, type: d.type, points, critical: o.showCritical && sched.byId[d.on].critical && sched.byId[r.id].critical });
      }
    }
  }
  const todayX = today !== null && today >= start && today <= end && o.showToday && visible(today) ? pos(today) + px / 2 : null;
  return {
    pxPerDay: px, left, rowH: ROW_H, headerH: HEADER_H, rows, ticks, shading, today: todayX, deps, start, end,
    width: fill && right > width && right - width < px ? width : right, // a filled last day is cut at the edge, not scrolled to
    height: HEADER_H + rows.length * ROW_H, zoomUsed: zoom, ...(note && { note }),
  };
}

// Distance from (x, y) to the axis-parallel segment a–b.
function segDist([ax, ay], [bx, by], x, y) {
  const cx = Math.min(Math.max(x, Math.min(ax, bx)), Math.max(ax, bx));
  const cy = Math.min(Math.max(y, Math.min(ay, by)), Math.max(ay, by));
  return Math.hypot(x - cx, y - cy);
}

/** What is under (x, y) in the layout: {kind: 'bar' | 'edge-l' | 'edge-r' | 'progress' | 'port-s' | 'port-e', id} on a row,
 * {kind: 'dep', id: successor, from: predecessor} within 4 px of a dependency line, {kind: 'lane', id} elsewhere on an
 * unscheduled row, else null. A summary row has only 'bar'; a milestone has 'bar' and its ports. */
export function hitTest(layout, x, y) {
  const r = layout.rows.find((row) => y >= row.y && y < row.y + layout.rowH);
  if (r?.bar) {
    const top = r.y + (layout.rowH - BAR_H) / 2;
    const inBand = y >= top && y < top + BAR_H;
    const { x: bx, w } = r.bar;
    const hit = (kind) => ({ kind, id: r.id });
    if (r.kind === 'milestone') {
      if (Math.abs(x - bx) <= DIAMOND) return hit('bar');
      if (Math.abs(x - bx) <= DIAMOND + PORT) return hit(x < bx ? 'port-s' : 'port-e');
    } else if (r.kind === 'summary') {
      if (inBand && x >= bx && x <= bx + w) return hit('bar');
    } else {
      if (y >= top + BAR_H && Math.abs(x - (bx + r.progressW)) <= 5) return hit('progress');
      if (inBand && x >= bx && x <= bx + w) {
        const e = Math.min(EDGE, w / 3);
        return hit(x - bx < e ? 'edge-l' : bx + w - x < e ? 'edge-r' : 'bar');
      }
      if (inBand && x < bx && bx - x <= PORT) return hit('port-s');
      if (inBand && x > bx + w && x - bx - w <= PORT) return hit('port-e');
    }
  }
  for (const d of layout.deps) {
    for (let i = 1; i < d.points.length; i++) if (segDist(d.points[i - 1], d.points[i], x, y) <= 4) return { kind: 'dep', id: d.to, from: d.from };
  }
  return r?.kind === 'unscheduled' ? { kind: 'lane', id: r.id } : null;
}
