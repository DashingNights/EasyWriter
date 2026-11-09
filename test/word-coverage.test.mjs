// scripts/word-coverage.mjs on a small checkout built in a temp folder: which sources count, sweeps, label prefixes, unbuilt
// variants, the kind of check each feature needs, and the coverage.md block it writes and reads back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { ROOT, coverage, mdTotals, needOf, totalsLine, writeMd } from '../scripts/word-coverage.mjs';

// The small checkouts live in the harness output folder, which is build output, and go when the tests end.
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const put = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof text === 'string' ? text : JSON.stringify(text));
};
const f = (id, kind, status = 'new') => ({ id, kind, status, label: id.split('.').pop() });

function checkout() {
  fs.mkdirSync(path.join(ROOT, '.smoke-data/word/out'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.smoke-data/word/out/word-coverage-test-'));
  made.push(root);
  put(root, 'docs/plans/word/index.json', [
    f('home.font.bold', 'toggle'), f('home.font.italic', 'toggle'), f('home.font.launcher', 'launcher'), f('fields.PAGE', 'field'),
    f('fields.DATE', 'field'), f('home.font.strike', 'toggle'), f('home.font.cloudy', 'button', 'cloud'), f('chart.make', 'button'),
    ...Array.from({ length: 9 }, (_, i) => f(`home.font.sweep${i}`, 'button')),
  ]);
  put(root, 'docs/plans/word/plan.json', { scaffold: [], wps: [{ id: 'font', features: ['home.font'] }, { id: 'fields-core', features: ['fields'] }],
    placeholders: { chart: ['chart'] } });
  // A run that proves bold (and fails italic), plus a sweep of nine ids that must not count.
  put(root, '.smoke-data/word/cases/font.js', "t.check('x', true, null, ['home.font.strike'])");
  put(root, '.smoke-data/word/out/font/checks.json', [{ label: 'bold', ok: true, ids: ['home.font.bold'] }, { label: 'italic', ok: false, ids: ['home.font.italic'] },
    { label: 'sweep', ok: true, ids: Array.from({ length: 9 }, (_, i) => `home.font.sweep${i}`) }]);
  // No run output: the case file's ids count. A probe starting with '_' never counts.
  put(root, '.smoke-data/word/cases/dialogs.js', "t.check('Ctrl+D', ok, null, ['home.font.launcher'])");
  put(root, '.smoke-data/word/cases/_probe.js', "['home.font.sweep0']");
  // The built fixture holds PAGE through a suffixed label; a variant whose file is missing holds DATE, unbuilt.
  put(root, '.smoke-data/word/fixture/out/labels.txt', '{\n "cases": 1\n}\nfields.PAGE.roman: i, ii\n');
  put(root, '.smoke-data/word/fixture/parts/2-fields.ps1', "Register-Part 270 'fields-core' {\n  Add-Case $doc 'fields.PAGE.roman: i, ii' 'x' $null\n}\n"
    + "Register-Variant 'fields-date' {\n  Add-Para $doc '[fields.DATE: a date] text'\n}\n");
  put(root, 'test/font.test.mjs', "assert.equal(run('home.font.strike'), true)");
  return root;
}

test('needOf: interactive kinds and window areas need a harness check, fields a fixture case, the rest either', () => {
  assert.equal(needOf(f('home.font.launcher', 'launcher')), 'harness');
  assert.equal(needOf(f('view.zoom.onePage', 'button')), 'harness');
  assert.equal(needOf(f('fields.PAGE', 'field')), 'fixture');
  assert.equal(needOf(f('home.font.bold', 'toggle')), 'any');
});

test('coverage counts runs, case files, fixture labels by prefix and unit tests, and leaves sweeps, probes and placeholders out', () => {
  const root = checkout();
  const { features, totals, sources } = coverage({ root });
  const by = Object.fromEntries(features.map((x) => [x.id, x]));
  assert.ok(!by['home.font.cloudy'] && !by['chart.make'], 'cloud and placeholder features are not built');
  assert.equal(features.length, 15);
  assert.deepEqual(by['home.font.bold'].harness, ['font']);
  assert.deepEqual(by['home.font.italic'].failing, ['font: italic']);
  assert.equal(by['home.font.italic'].covered, false, 'a failing check proves nothing');
  assert.equal(by['home.font.sweep0'].covered, false, 'a sweep proves nothing, and the _probe case is not read');
  assert.equal(by['home.font.strike'].harness.length, 0, 'a case with run output is read from it, not from its file');
  assert.deepEqual(by['home.font.strike'].unit, ['font.test.mjs']);
  assert.equal(by['home.font.strike'].covered, true);
  assert.deepEqual(by['home.font.launcher'].harness, ['dialogs']);
  assert.deepEqual(by['fields.PAGE'].fixture, { built: 1, unbuilt: 0 });
  assert.deepEqual(by['fields.DATE'].fixture, { built: 0, unbuilt: 1 });
  assert.equal(by['fields.DATE'].covered, true);
  assert.equal(sources.sweeps, 1);
  assert.deepEqual(sources.fromFile, ['dialogs']);
  assert.equal(totals.gaps, 10);
  assert.equal(totals.gapAny, 10);
  assert.equal(totals.unbuilt, 1);
});

test('with no labels.txt only variants with a built file count as built', () => {
  const root = checkout();
  fs.rmSync(path.join(root, '.smoke-data/word/fixture/out/labels.txt'));
  const by = Object.fromEntries(coverage({ root }).features.map((x) => [x.id, x]));
  assert.deepEqual(by['fields.PAGE'].fixture, { built: 0, unbuilt: 1 });
});

test('writeMd keeps the hand-written text around its block and mdTotals reads the totals back', () => {
  const root = checkout();
  const cov = coverage({ root });
  const md = path.join(root, 'coverage.md');
  fs.writeFileSync(md, '# Title\n\nHand text.\n\n<!-- coverage:begin (node scripts/word-coverage.mjs --write) -->\nold\n<!-- coverage:end -->\n\n## After\n');
  writeMd(cov, md);
  const text = fs.readFileSync(md, 'utf8');
  assert.match(text, /Hand text\./);
  assert.match(text, /## After/);
  assert.doesNotMatch(text, /\nold\n/);
  assert.match(text, /- home\.font\.sweep0 \(button\) sweep0: needs a harness check or a fixture case/);
  assert.equal(mdTotals(md), totalsLine(cov.totals));
});
