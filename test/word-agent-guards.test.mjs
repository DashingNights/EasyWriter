// agent-guards (docs/plans/word/briefs/agent-guards.md, docs/plans/engine/agent-rules.md): the mistakes work package agents
// kept repeating on word-parity, each turned into a check. Each runs here on this checkout, and on a small made-up case of the
// mistake it names, so the check is shown to fail on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLOCK_FIX, POLL_FIX, ROOT, budgetProblems, clockGates, stablePolls } from '../scripts/agent-guards.mjs';
import { copyHarness } from '../scripts/copy-harness.mjs';
import { header, schemaProblems, storedForm } from '../scripts/schema-fields.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ew-guards-${name}-`));
const put = (dir, rel, text) => (fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }), fs.writeFileSync(path.join(dir, rel), text));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// ---------------------------------------------------------------------------------------------------------------------------
// The stored form's version (engine-pictures-2 added Float.adjust, layer and fallback at version 6; no sample held them).

const DOC = `use serde::{Deserialize, Serialize};
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document { pub body: Vec<Arc<Block>>, #[serde(skip)] cache: u32 }
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Block { Para(Para), Rule }
#[derive(Serialize, Deserialize)]
pub struct Para { pub text: String }
#[derive(Serialize)]
pub struct Elsewhere { pub x: u32 }
`;
const tree = (version, lib) => {
  const dir = tmp('schema');
  put(dir, 'engine/crates/doc/src/lib.rs', lib);
  put(dir, 'engine/crates/doc/src/schema.rs', `pub const SCHEMA_VERSION: u32 = ${version};\n${Array.from({ length: version }, (_, v) => `// ${v} to ${v + 1} adds it\n`).join('')}`);
  put(dir, 'src/engine/model/form.mjs', `export const VERSION = ${version};\n`);
  put(dir, 'docs/plans/engine/model.md', Array.from({ length: version + 1 }, (_, v) => `| ${v} | x |\n`).join(''));
  return dir;
};
const writeList = (dir, version) => put(dir, `test/fixtures/engine-models/${version}.fields.txt`, `${header(version)}\n${storedForm(dir).join('\n')}\n`);

test('the stored form is read from the types the Document reaches, skipped fields left out', () => {
  const dir = tree(1, DOC);
  assert.deepEqual(storedForm(dir), ['Block tag=kind', 'Block::Para(Para)', 'Block::Rule', 'Document rename_all=camelCase',
    'Document.body Vec<Block>', 'Para', 'Para.text String']);
  fs.rmSync(dir, { recursive: true });
});

test('a stored field added without a new version fails the schema check, and passes once the version moved with it', () => {
  const dir = tree(1, DOC);
  writeList(dir, 1);
  assert.deepEqual(schemaProblems(dir).problems, []);
  // A field no sample holds, as engine-pictures-2's were.
  const added = DOC.replace('pub text: String }', 'pub text: String, #[serde(default)] pub adjust: Option<Box<Adjust>> }\n'
    + '#[derive(Serialize, Deserialize)]\npub struct Adjust { pub lum: f32 }');
  put(dir, 'engine/crates/doc/src/lib.rs', added);
  const [problem, ...more] = schemaProblems(dir).problems;
  assert.equal(more.length, 0);
  assert.match(problem, /changed without a new schema version: raise SCHEMA_VERSION .* to 2/);
  assert.deepEqual(problem.split('\n').slice(1), ['+ Adjust', '+ Adjust.lum f32', '+ Para.adjust Option<Adjust>']);
  // Writing the list again at the same version hides it from this checkout, not from the branch's base.
  const base = { version: 1, list: fs.readFileSync(path.join(dir, 'test/fixtures/engine-models/1.fields.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')) };
  writeList(dir, 1);
  assert.match(schemaProblems(dir, base).problems.join('\n'), /changed since this branch left the integration branch, at version 1: raise .* to 2/);
  // The bump: both constants, the upgrade line, the table's row and the new version's list.
  const bumped = tree(2, added);
  writeList(bumped, 2);
  assert.deepEqual(schemaProblems(bumped, base).problems, []);
  put(bumped, 'src/engine/model/form.mjs', 'export const VERSION = 3;\n');
  assert.match(schemaProblems(bumped, base).problems.join('\n'), /SCHEMA_VERSION is 2 .* VERSION is 3/);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(bumped, { recursive: true });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The .wasm budget (raised in every wave B package's branch, and by wave C's integrators and merges).

test('the .wasm BUDGET on this checkout was last raised by the planner', () => {
  const problems = budgetProblems(ROOT);
  assert.ok(!problems.length, problems.join('\n'));
});

test('a package\'s raise, a merge carrying it and an integrator\'s raise are refused; the planner\'s is not', () => {
  const dir = tmp('budget');
  const BUILD = 'scripts/build-engine-wasm.mjs';
  const budget = (n, message) => (put(dir, BUILD, `export const BUDGET = ${n};\n`), git(dir, 'add', '.'), git(dir, 'commit', '-q', '-m', message));
  git(dir, 'init', '-q', '-b', 'word-parity');
  budget(100, 'scaffold');
  git(dir, 'checkout', '-q', '-b', 'wp/pkg');
  budget(120, 'pkg: the .wasm budget takes the package\'s growth');
  assert.match(budgetProblems(dir).join('\n'), /is 120, raised on this branch from 100 .*Only the planner raises it/);
  git(dir, 'checkout', '-q', 'word-parity');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge pkg: the package', 'wp/pkg');
  assert.match(budgetProblems(dir).join('\n'), /went from 100 to 120 in \w+ "Merge pkg: the package", a merge that carried a package's raise/);
  budget(130, 'integrate pkg: wiring (the .wasm budget at the merged build\'s size)');
  assert.match(budgetProblems(dir).join('\n'), /went from 120 to 130 .* an integrator's commit/);
  budget(140, 'BUDGET 140: the planner\'s raise for the package');
  assert.deepEqual(budgetProblems(dir), []);
  put(dir, BUILD, 'export const BUDGET = 150;\n');
  assert.match(budgetProblems(dir).join('\n'), /raised from 140 in the working tree/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Wall-clock gates in npm test (engine-keys.test.mjs failed under load in most packages' runs and passed alone).

const npmTests = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => /\.test\./.test(f));

test('no file npm test runs asserts on a wall-clock time', () => {
  const found = npmTests.flatMap((f) => clockGates(fs.readFileSync(path.join(ROOT, 'test', f), 'utf8')).map((g) => `test/${f}:${g.line}: ${g.text}`));
  assert.ok(!found.length, `${found.join('\n')}\n${CLOCK_FIX}`);
});

test('a time asserted on through variables is caught; a printed time and a count are not', () => {
  const gate = `const edit = [];
    for (let i = 0; i < 9; i++) { const t0 = performance.now(); key(); edit.push(performance.now() - t0); }
    const row = { edit: median(edit) };
    report['page 1'] = row;
    for (const [where, r] of Object.entries(report)) assert.ok(r.edit < 2.5, \`\${where}\`);`;
  assert.deepEqual(clockGates(gate).map((g) => g.line), [5]);
  assert.deepEqual(clockGates('const t0 = Date.now();\nwork();\nassert.ok(Date.now() - t0 < 500 && done);').map((g) => g.line), [3]);
  const fine = `const t0 = performance.now(); const r = key(); const ms = performance.now() - t0;
    console.log(\`\${ms} ms\`); assert.equal(stats().lightEdits, 1, \`took \${ms} ms\`);
    const s = { t: Date.now() }; assert.ok(s.state);`;
  assert.deepEqual(clockGates(fine), []);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Harness reads repeated until two agree (engine-fidelity-5 read the caret up to ten times).

// The DOM editor's cases are frozen (docs/plans/engine/stage2b.md decision 9): their polls stay as they are, and no new ones come.
const FROZEN = ['_chunk-probe', '_chunk-real', '_eval-lib', '_layout-spike', 'budget', 'check-regressions', 'columns-objects', 'columns',
  'flow-regressions', 'font-metrics', 'font-provider', 'layout-predictor', 'page-engine', 'perf-lazy', 'scaffold-spec', 'table-row-layout'];
const CASES = path.join(ROOT, '.smoke-data', 'word', 'cases');

test('no harness case reads a value until two reads agree without naming the race it hides', { skip: !fs.existsSync(CASES) && 'no harness cases here' }, () => {
  const found = fs.readdirSync(CASES).filter((f) => f.endsWith('.js') && !FROZEN.includes(f.slice(0, -3)))
    .flatMap((f) => stablePolls(fs.readFileSync(path.join(CASES, f), 'utf8')).map((p) => `.smoke-data/word/cases/${f}:${p.line}: ${p.text}`));
  assert.ok(!found.length, `${found.join('\n')}\n${POLL_FIX}`);
});

test('a read repeated until it holds is caught, in the page\'s code too; a named race and a memo are not', () => {
  const poll = `async function top(t, c) {
    let y = null;
    for (let i = 0; i < 10; i++) {
      await t.wait(150);
      const now = (await c.caret())?.y ?? null;
      if (now != null && now === y) break;
      y = now;
    }
  }`;
  assert.deepEqual(stablePolls(poll).map((p) => p.line), [3]);
  const page = 'await t.J(`(async () => {\n  for (let i = 0, last = null; i < 30; i++) { await frame(); const now = vp.camera.y; if (now === last) break; last = now; }\n})()`);';
  assert.deepEqual(stablePolls(page).map((p) => p.line), [2]);
  assert.deepEqual(stablePolls(poll.replace('let y = null;', 'let y = null;\n    // race: the caret moves after the find\'s select')), []);
  const memo = 'const place = () => { const key = vp.camera.zoom + list.length; if (key === last) return; last = key; draw(); };';
  assert.deepEqual(stablePolls(memo), []);
});

// ---------------------------------------------------------------------------------------------------------------------------
// The merge's copy step (git status showed copied cases modified with an empty diff after every merge).

test('the integrator\'s copy leaves a tracked case to the merge, so git status stays clean', () => {
  const repo = tmp('copy-to');
  const from = tmp('copy-from');
  const crlf = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=true', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  crlf('init', '-q');
  put(repo, 'cases/x.js', 'one\ntwo\n');
  crlf('add', '.');
  crlf('commit', '-q', '-m', 'x');
  fs.rmSync(path.join(repo, 'cases/x.js'));
  crlf('checkout', '--', 'cases/x.js'); // written CRLF, as a Windows checkout does
  put(from, 'cases/x.js', 'one\ntwo\n'); // the package worktree's copy: the same text, LF
  put(from, 'cases/x-helper.js', 'helper\n');
  // The old step (copy /Y) shows the tracked case as modified though nothing changed.
  fs.copyFileSync(path.join(from, 'cases/x.js'), path.join(repo, 'cases/x.js'));
  assert.match(crlf('status', '--porcelain'), /^ M cases\/x\.js$/m);
  crlf('checkout', '--', 'cases/x.js');
  const done = copyHarness(from, repo, ['cases/x.js', 'cases/x-*', 'cases/gone.js']);
  assert.deepEqual(done, [{ path: 'cases/x.js', done: 'tracked' }, { path: 'cases/x-helper.js', done: 'copied' }, { path: 'cases/gone.js', done: 'missing' }]);
  assert.equal(crlf('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(fs.readFileSync(path.join(repo, 'cases/x-helper.js'), 'utf8'), 'helper\n');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(from, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------------------
// A package with no harness case of its own (run.js exited 2 with 'no case file' for engine-size-2 and engine-edit-cost).

test('run.js runs a package\'s own case and says so when it has none; a case named outright must exist', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, '.smoke-data/word/run.js'), ...args], { encoding: 'utf8' });
  const none = run('--package', 'no-such-package-xyz');
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /no-such-package-xyz has no harness case of its own/);
  const named = run('no-such-package-xyz');
  assert.equal(named.status, 2);
  assert.match(named.stderr, /no case file for no-such-package-xyz/);
});
