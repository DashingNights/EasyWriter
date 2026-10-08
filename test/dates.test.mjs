import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addWorkDays, fmt, fromDay, fromWork, isWorkday, nextWorkday, prevWorkday, toDay, todayStr, weekday, weekNumber, work,
} from '../src/plan/dates.mjs';

const MON_FRI = { workdays: [1, 2, 3, 4, 5], holidays: [] };
const day = toDay;

test('day ordinals round-trip and reject impossible dates, incl. leap days', () => {
  assert.equal(day('1970-01-01'), 0);
  assert.equal(fromDay(day('2026-10-05')), '2026-10-05');
  assert.equal(day('2028-02-29') - day('2028-02-28'), 1);
  assert.equal(day('2028-03-01') - day('2028-02-29'), 1);
  for (const bad of ['2026-02-29', '2026-13-01', '2026-1-05', '', null, 20261005]) assert.equal(day(bad), null);
  assert.equal(weekday(day('2026-10-05')), 1); // a Monday
  assert.equal(weekday(day('2026-10-11')), 0);
  assert.match(todayStr(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(todayStr(new Date(2026, 9, 5, 23, 30)), '2026-10-05'); // local date
});

test('the working-day index skips weekends; a weekend day takes the next Monday\'s index', () => {
  const mon = day('2026-10-05');
  assert.equal(work(mon + 7, MON_FRI) - work(mon, MON_FRI), 5);
  assert.equal(work(mon + 4, MON_FRI) - work(mon, MON_FRI), 4); // Friday
  assert.equal(work(mon + 5, MON_FRI), work(mon + 7, MON_FRI)); // Saturday → Monday
  assert.equal(fromWork(work(mon + 5, MON_FRI), MON_FRI), mon + 7);
  assert.equal(nextWorkday(mon + 5, MON_FRI), mon + 7);
  assert.equal(prevWorkday(mon + 6, MON_FRI), mon + 4);
  assert.equal(prevWorkday(mon, MON_FRI), mon);
  assert.equal(isWorkday(mon + 5, MON_FRI), false);
});

test('fromWork inverts work on every working day, with holidays and before the epoch', () => {
  const cal = { workdays: [0, 1, 2, 3, 4], holidays: ['2026-12-25', '2026-12-24', '1999-12-31', '2026-12-26'] }; // Sun–Thu
  for (let d = day('1999-11-01'); d < day('2000-02-01'); d++) if (isWorkday(d, cal)) assert.equal(fromWork(work(d, cal), cal), d, fromDay(d));
  for (let d = day('2026-11-01'); d < day('2027-02-01'); d++) {
    if (isWorkday(d, cal)) assert.equal(fromWork(work(d, cal), cal), d, fromDay(d));
    else assert.equal(work(d + 1, cal), work(d, cal), fromDay(d)); // a non-working day adds nothing
  }
  assert.equal(isWorkday(day('2026-10-09'), cal), false); // Friday off
  assert.equal(isWorkday(day('2026-10-11'), cal), true); // Sunday on
});

test('holidays are skipped; one on a non-working day changes nothing', () => {
  const cal = { workdays: [1, 2, 3, 4, 5], holidays: ['2026-10-08', '2026-10-10'] };
  assert.equal(isWorkday(day('2026-10-08'), cal), false);
  assert.equal(work(day('2026-10-09'), cal) - work(day('2026-10-07'), cal), 1);
  assert.equal(nextWorkday(day('2026-10-08'), cal), day('2026-10-09'));
  assert.equal(addWorkDays(day('2026-10-07'), 1, cal), day('2026-10-09'));
  assert.equal(work(day('2026-10-12'), cal) - work(day('2026-10-09'), cal), 1); // the Saturday holiday is not subtracted twice
});

test('negative lags count back over weekends and holidays', () => {
  const cal = { workdays: [1, 2, 3, 4, 5], holidays: ['2026-10-02'] };
  assert.equal(addWorkDays(day('2026-10-05'), -1, cal), day('2026-10-01')); // Mon − 1 skips the weekend and the Friday holiday
  assert.equal(addWorkDays(day('2026-10-05'), -5, MON_FRI), day('2026-09-28'));
  assert.equal(addWorkDays(day('2026-10-10'), 0, MON_FRI), day('2026-10-12')); // from a Saturday: the Monday
});

test('week numbers count from calendar.weekOne; labels', () => {
  const cal = { ...MON_FRI, weekOne: '2026-09-21' };
  assert.equal(weekNumber(day('2026-09-21'), cal), 1);
  assert.equal(weekNumber(day('2026-09-27'), cal), 1);
  assert.equal(weekNumber(day('2026-10-05'), cal), 3);
  assert.equal(weekNumber(day('2026-09-14'), cal), 0);
  assert.equal(weekNumber(day('2026-10-05'), MON_FRI), null); // off until set
  assert.equal(fmt(day('2026-10-05'), 'Wk n', cal), 'Wk 3');
  assert.equal(fmt(day('2026-10-05'), 'd MMM'), '5 Oct');
  assert.equal(fmt(day('2026-09-01'), 'MMM yyyy'), 'Sep 2026');
  assert.equal(fmt(day('2026-11-30'), 'Qn'), 'Q4');
  assert.deepEqual(['d', 'MMM', 'yyyy'].map((p) => fmt(day('2026-01-09'), p)), ['9', 'Jan', '2026']);
});
