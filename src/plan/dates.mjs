// Calendar dates of the plan workspace (Gantt plan §3.7, §5): `YYYY-MM-DD` strings in files, UTC day ordinals (days since
// 1970-01-01) in arithmetic, and a working-day index over a plan calendar `{workdays: [0..6, 0 = Sunday], holidays: [dates]}`.
// No imports, no Temporal (the Node 22 test runtime lacks it). Calendars are never mutated (they are cached by identity).

const DAY_MS = 86400000;
const EPOCH = 10959; // 2000-01-03, a Monday: the working-day index counts from here
const DEFAULT_CAL = { workdays: [1, 2, 3, 4, 5], holidays: [] };
const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

/** The day ordinal of a `YYYY-MM-DD` string; null when it is not a real date. */
export function toDay(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const day = Date.UTC(+str.slice(0, 4), str.slice(5, 7) - 1, +str.slice(8)) / DAY_MS;
  return fromDay(day) === str ? day : null; // rejects 2026-02-30
}

/** The `YYYY-MM-DD` string of a day ordinal. */
export const fromDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (day) => (((day + 4) % 7) + 7) % 7;

/** Today's local date as `YYYY-MM-DD`. */
export function todayStr(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const prepared = new WeakMap();
// Per calendar: the working weekdays, prefix[i] = working weekdays among the i days from a Monday, and the holidays that fall
// on working weekdays as sorted day ordinals.
function prep(cal = DEFAULT_CAL) {
  let p = prepared.get(cal);
  if (!p) {
    const days = new Set(cal.workdays?.length ? cal.workdays : DEFAULT_CAL.workdays);
    const prefix = [0];
    for (let i = 0; i < 7; i++) prefix.push(prefix[i] + (days.has((i + 1) % 7) ? 1 : 0));
    const holidays = [...new Set((cal.holidays ?? []).map(toDay))].filter((d) => d !== null && days.has(weekday(d)));
    p = { days, prefix, holidays: holidays.sort((a, b) => a - b) };
    prepared.set(cal, p);
  }
  return p;
}

// How many entries of the sorted list are < x.
function below(list, x) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether the day is a working day of the calendar. */
export function isWorkday(day, cal) {
  const p = prep(cal);
  return p.days.has(weekday(day)) && p.holidays[below(p.holidays, day)] !== day;
}

/** The working-day index: the working days from 2000-01-03 up to (not including) `day`; negative before it. A working day's
 * index is its own; a non-working day gets the index of the next working day. O(1) plus a binary search over the holidays. */
export function work(day, cal) {
  const p = prep(cal);
  const n = day - EPOCH;
  const weeks = Math.floor(n / 7);
  return weeks * p.prefix[7] + p.prefix[n - weeks * 7] - (below(p.holidays, day) - below(p.holidays, EPOCH));
}

/** The working day whose index is `n` (inverse of work). */
export function fromWork(n, cal) {
  const p = prep(cal);
  const guess = EPOCH + Math.floor(n / p.prefix[7]) * 7;
  const slack = 7 * (p.holidays.length + 2); // each holiday shifts the answer by at most a week
  let lo = guess - slack;
  let hi = guess + slack;
  while (lo < hi) { // the first day with more than n working days up to and including it
    const mid = Math.floor((lo + hi) / 2);
    if (work(mid + 1, cal) > n) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The day itself when it is a working day, else the next / previous working day. */
export const nextWorkday = (day, cal) => fromWork(work(day, cal), cal);
export const prevWorkday = (day, cal) => fromWork(work(day + 1, cal) - 1, cal);

/** `n` working days after `day` (before it when negative); a non-working `day` counts from the next working day. */
export const addWorkDays = (day, n, cal) => fromWork(work(day, cal) + n, cal);

/** The academic week of the day, 1 for the week starting on `calendar.weekOne`; null while weekOne is not set. */
export function weekNumber(day, cal) {
  const one = toDay(cal?.weekOne);
  return one === null ? null : Math.floor((day - one) / 7) + 1;
}

/** A stored date range normalised (Gantt plan §3.2): start → the next working day, end → the previous one, never before
 * start; a milestone ends on its start. Both null unless both are dates. */
export function normRange(start, end, cal, milestone = false) {
  let s = toDay(start);
  let e = toDay(end);
  if (s === null || e === null) return { start: null, end: null };
  s = nextWorkday(s, cal);
  e = milestone ? s : Math.max(s, prevWorkday(e, cal));
  return { start: fromDay(s), end: fromDay(e) };
}

/** A day label: 'd MMM' (5 Oct), 'MMM yyyy' (Oct 2026), 'Wk n' (needs cal.weekOne), and for axis ticks 'd', 'MMM', 'yyyy',
 * 'Qn'. Month names in English, read in UTC. */
export function fmt(day, pattern, cal) {
  const [y, m, d] = fromDay(day).split('-').map(Number);
  const mmm = month.format(new Date(day * DAY_MS));
  return {
    'd MMM': `${d} ${mmm}`,
    'MMM yyyy': `${mmm} ${y}`,
    'Wk n': `Wk ${weekNumber(day, cal)}`,
    d: String(d),
    MMM: mmm,
    yyyy: String(y),
    Qn: `Q${Math.floor((m - 1) / 3) + 1}`,
  }[pattern];
}
