// layout-misc's pure parts (docs/plans/word/briefs/layout-misc.md Acceptance): hyphenate() against TeX's breaks, the CAPS rule, the
// minimum lengths, the consecutive limit and the zone in planBreaks, line number assignment, and the drop cap and lnNum values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hyphenate } from '../src/document/wp/layout-misc/hyphenate.mjs';
import { capsAllowed, coreOf, dropCapPatch, lnNumOf, numberLines, patchFrame, planBreaks } from '../src/document/wp/layout-misc/logic.mjs';

const show = (w, opts) => {
  let s = '';
  let p = 0;
  for (const k of hyphenate(w, opts)) {
    s += `${w.slice(p, k)}-`;
    p = k;
  }
  return s + w.slice(p);
};

test('hyphenate: TeX en-US breaks', () => {
  assert.equal(show('hyphenation'), 'hy-phen-ation');
  assert.equal(show('algorithm'), 'al-go-rithm');
  assert.equal(show('computer', { min: [2, 2] }), 'com-put-er');
  assert.equal(show('computer'), 'com-puter'); // TeX's 3 letters after a break
  assert.equal(show('Hyphenation'), 'Hy-phen-ation'); // case does not matter
  assert.equal(show('associate'), 'as-so-ciate'); // the exception list wins
  assert.equal(show('project'), 'project'); // an exception without breaks
  for (const w of ['word', 'cat', 'a', 'the', 'pine']) assert.deepEqual(hyphenate(w), [], w);
  assert.deepEqual(hyphenate('re-enter'), []);
  assert.deepEqual(hyphenate('hyphenation', { lang: 'fr-FR' }), []);
  assert.deepEqual(hyphenate('hyphenation', 'en-GB'), [2, 6]); // the scaffold stub's string form
});

test('hyphenate: minimum letters before and after a break', () => {
  for (const w of ['international', 'documentation', 'extraordinary', 'pneumonoultramicroscopic']) {
    for (const [l, r] of [[2, 3], [3, 3], [4, 4]]) {
      for (const k of hyphenate(w, { min: [l, r] })) assert.ok(k >= l && w.length - k >= r, `${w} ${k} min ${l},${r}`);
    }
  }
  assert.deepEqual(hyphenate('ta-ble'.replace('-', ''), { min: [3, 3] }), []);
});

test('coreOf and the CAPS rule', () => {
  assert.deepEqual(coreOf('(hyphenation),'), { at: 1, word: 'hyphenation' });
  assert.equal(coreOf("don't"), null);
  assert.equal(coreOf('abc123'), null);
  assert.equal(capsAllowed('NASA', false), false);
  assert.equal(capsAllowed('NASA', true), true);
  assert.equal(capsAllowed('Nasa', false), true);
});

// Words of 50 px with a 10 px space; breaks after 20 and 30 px (W) or every 10 px (W10).
const W = (n, breaks = [{ k: 2, w: 20 }, { k: 3, w: 30 }]) => Array.from({ length: n }, () => ({ w: 50, space: 10, breaks }));
const W10 = (n) => W(n, [1, 2, 3, 4].map((k) => ({ k, w: 10 * k })));

test('planBreaks: a word that does not fit takes its last break that fits with the hyphen', () => {
  // 150 px lines: two words use 110, the third leaves 40; 110 + 10 + 20 + 4 fits, 110 + 10 + 30 + 4 does not.
  const r = planBreaks(W(6), { widths: [150, 150], hyphen: 4, zone: 18 });
  assert.deepEqual(r.breaks[0], { word: 2, k: 2, line: 0 });
  assert.equal(planBreaks(W(6), { widths: [150, 150], hyphen: 4, zone: 18 }).lines, 3);
  assert.equal(planBreaks(W(6, []), { widths: [150, 150], hyphen: 4, zone: 18 }).lines, 3);
  assert.deepEqual(planBreaks(W(6, []), { widths: [150, 150], zone: 0 }).breaks, [], 'a word without breaks moves whole');
  assert.deepEqual(planBreaks(W(1), { widths: [20, 20], zone: 0 }).breaks, [], 'the first word of a line never breaks');
});

test('planBreaks: the zone decides', () => {
  const wide = { widths: [150, 150], hyphen: 4 }; // the gap is 40 px
  assert.equal(planBreaks(W(6), { ...wide, zone: 18 }).breaks.length > 0, true);
  assert.equal(planBreaks(W(6), { ...wide, zone: 45 }).breaks.length, 0, 'a gap narrower than the zone stays');
  assert.equal(planBreaks(W(6), { ...wide, zone: 40 }).breaks.length, 0, 'a gap equal to the zone stays');
});

test('planBreaks: the consecutive hyphen limit', () => {
  const opts = { widths: [145, 145], zone: 1 };
  const longest = (breaks) => {
    let best = 0;
    let run = 0;
    let prev = -2;
    for (const { line } of breaks) {
      run = line === prev + 1 ? run + 1 : 1;
      best = Math.max(best, run);
      prev = line;
    }
    return best;
  };
  const free = planBreaks(W10(30), opts);
  const one = planBreaks(W10(30), { ...opts, limit: 1 });
  assert.ok(longest(free.breaks) >= 2, JSON.stringify(free.breaks));
  assert.equal(longest(one.breaks), 1, JSON.stringify(one.breaks));
  assert.ok(one.breaks.length < free.breaks.length);
});

test('numberLines: count by, start, restarts, suppressed and empty paragraphs', () => {
  const L = (page, section = 0, suppressed = false) => ({ page, section, suppressed });
  const nums = (lines, lns) => numberLines(lines, lns).map((x) => (x ? (x.show ? x.n : `(${x.n})`) : '-'));
  const cont = { countBy: 1, start: 1, distance: 0, restart: 'continuous' };
  assert.deepEqual(nums([L(0), L(0), L(1), L(1)], [cont]), [1, 2, 3, 4]);
  assert.deepEqual(nums([L(0), L(0), L(1), L(1)], [{ ...cont, restart: 'newPage' }]), [1, 2, 1, 2]);
  assert.deepEqual(nums([L(0), L(0), L(1, 1), L(1, 1)], [{ ...cont, restart: 'newSection' }, { ...cont, restart: 'newSection' }]), [1, 2, 1, 2]);
  assert.deepEqual(nums([L(0), L(0), L(0, 1)], [cont, cont]), [1, 2, 3], 'continuous runs on into the next section');
  assert.deepEqual(nums(Array.from({ length: 11 }, () => L(0)), [{ ...cont, countBy: 5 }]),
    ['(1)', '(2)', '(3)', '(4)', 5, '(6)', '(7)', '(8)', '(9)', 10, '(11)']);
  assert.deepEqual(nums([L(0), L(0), L(0, 0, true), L(0)], [{ ...cont, start: 10 }]), [10, 11, '-', 12], 'a suppressed line is skipped');
  assert.deepEqual(nums([L(0), L(0, 1)], [null, cont]), ['-', 1], 'a section without numbering is not counted');
  assert.deepEqual(nums([L(0, 0, true), L(1), L(1)], [{ ...cont, restart: 'newPage' }]), ['-', 1, 2]);
});

test('lnNumOf: the dialog values within Word limits', () => {
  assert.equal(lnNumOf({ on: false, start: 3 }), null);
  assert.deepEqual(lnNumOf({ on: true }), { countBy: 1, start: 1, distance: 0, restart: 'newPage' });
  assert.deepEqual(lnNumOf({ on: true, start: 0, countBy: 500, distance: 9999, restart: 'continuous' }),
    { countBy: 100, start: 1, distance: 1584, restart: 'continuous' });
  assert.deepEqual(lnNumOf({ on: true, start: 99999, countBy: 0, distance: -5, restart: 'x' }), { countBy: 1, start: 32767, distance: 0, restart: 'newPage' });
});

test('dropCapPatch and patchFrame: positions, limits and other frame keys kept', () => {
  assert.deepEqual(dropCapPatch({ position: 'drop' }), { dropCap: 'drop', lines: 3, hSpace: 0 });
  assert.deepEqual(dropCapPatch({ position: 'margin', lines: 2, distance: 14.17 }), { dropCap: 'margin', lines: 2, hSpace: 14.17 });
  assert.deepEqual(dropCapPatch({ position: 'drop', lines: 40, distance: 5000 }), { dropCap: 'drop', lines: 10, hSpace: 1584 });
  assert.deepEqual(dropCapPatch({ position: 'drop', lines: 0, distance: -1 }), { dropCap: 'drop', lines: 1, hSpace: 0 });
  assert.equal(patchFrame({ dropCap: 'drop', lines: 3, hSpace: 0 }, dropCapPatch({ position: 'none' })), null);
  assert.deepEqual(patchFrame({ dropCap: 'drop', lines: 3, w: 100, wrap: 'around' }, dropCapPatch({ position: 'none' })), { w: 100, wrap: 'around' });
  assert.deepEqual(patchFrame({ w: 100, future: 1 }, dropCapPatch({ position: 'drop', lines: 2 })), { w: 100, future: 1, dropCap: 'drop', lines: 2, hSpace: 0 });
});
