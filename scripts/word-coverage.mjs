// Word parity check coverage (docs/plans/word/briefs/coverage.md):
//   node scripts/word-coverage.mjs [--plan <planDir>] [--json] [--write] [--check]
// lists, for every built feature of index.json (a status other than placeholder, cloud or excluded, owned by a work package or
// scaffold item of plan.json, and no `needs` in the ribbon spec), the harness checks that name it, the fixture cases that hold it
// and the unit tests that name it, then prints a table per package and writes .smoke-data/word/out/coverage.json.
// Sources, all in this checkout:
//   harness  each case's .smoke-data/word/out/<case>/checks.json; for a case with no run output, or one that ended in an
//            exception, also the ids its case file names. A check tagging more than SWEEP ids ("every command is registered")
//            proves registration, not the feature, so it does not count.
//   fixture  the labels "[feature id: state]" of .smoke-data/word/fixture/parts/*.ps1 and of the built fixture's
//            fixture/out/labels.txt (import-check.mjs --labels); a label holds every feature whose id is a prefix of it. A
//            label in the parts but not in labels.txt is written but not built.
//   unit     test/*.test.mjs string literals equal to a feature id (this script's own test aside).
// A feature needs the kind of check that can prove it: interactive ones (dialogs, keys, panes, menus, galleries, views, the
// window's frame) a harness check, fields a fixture case, the rest (buttons and options that change the document) either.
// --write replaces the generated block of docs/plans/word/coverage.md; --check exits 1 when that block's totals line differs
// from this run's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTROLS, ITEMS, BACKSTAGE } from '../src/document/ribbon/spec.mjs';
import { ownersOf, readJson } from './word-spec.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MD = path.join(ROOT, 'docs/plans/word/coverage.md');
const BEGIN = '<!-- coverage:begin (node scripts/word-coverage.mjs --write) -->';
const END = '<!-- coverage:end -->';
export const SWEEP = 8;
const LEFT_OUT = new Set(['placeholder', 'cloud', 'excluded']);
const HARNESS_KINDS = new Set(['dialog', 'pane', 'key', 'launcher', 'gallery', 'menu', 'page', 'tabs', 'group', 'toolbar', 'ruler',
  'marker', 'edit', 'combo', 'spinner', 'command', 'behaviour', 'item']);
// Areas whose features live in the window, not the file (views, panes, the frame, keys, options).
const HARNESS_AREAS = new Set(['frame', 'file', 'view', 'views', 'statusBar', 'ruler', 'keys', 'window', 'options', 'contextMenu',
  'miniToolbar', 'navPane', 'panes', 'find', 'selection', 'navigation', 'keytips', 'help', 'immersiveReader', 'readAloud', 'print',
  'proofing', 'wordCount', 'fieldsUi', 'autocorrect', 'autoformat', 'outline', 'outlining']);

/** The kind of check that proves feature `f`: 'harness', 'fixture' or 'any'. */
export const needOf = (f) => (f.kind === 'field' ? 'fixture'
  : HARNESS_KINDS.has(f.kind) || HARNESS_AREAS.has(f.id.split('.')[0]) ? 'harness' : 'any');

const literals = (src, known) => new Set([...src.matchAll(/['"`]([A-Za-z][\w.-]*)['"`]/g)].map((m) => m[1]).filter((x) => known.has(x)));
/** Label ids in PowerShell source: a quoted "id: state" or "id", or a "[id: state]" or "[id]" (Page-Case takes the bare id). */
const labelIds = (src) => [...src.matchAll(/['"[]([A-Za-z][\w.]*)(?:: |['"\]])/g)].map((m) => m[1]);
const ls = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)).sort() : []);

/** The coverage of the checkout at `root` → {features, packages, totals, sources}. Reads files only. */
export function coverage({ root = ROOT, planDir = path.join(root, 'docs/plans/word') } = {}) {
  const index = readJson(path.join(planDir, 'index.json'));
  const ownerOf = ownersOf(readJson(path.join(planDir, 'plan.json')));
  const ids = new Set(index.map((f) => f.id));
  const needs = new Set([...Object.values(CONTROLS), ...Object.values(ITEMS), ...BACKSTAGE].filter((x) => x.needs).map((x) => x.id));

  // ---- harness
  const word = path.join(root, '.smoke-data/word');
  const harness = new Map(); // feature id → [{case, ok, label}]
  const sources = { cases: 0, runs: 0, fromFile: [], sweeps: 0, fixtureLabels: 0, built: false, unbuilt: 0, tests: 0 };
  const add = (m, id, v) => (m.get(id) ?? m.set(id, []).get(id)).push(v);
  for (const file of ls(path.join(word, 'cases'), /^[^_].*\.js$/)) {
    const name = file.slice(0, -3);
    sources.cases++;
    const out = path.join(word, 'out', name, 'checks.json');
    const checks = fs.existsSync(out) ? readJson(out) : null;
    const seen = new Set();
    if (checks) {
      sources.runs++;
      for (const c of checks) {
        const own = (c.ids ?? []).filter((id) => ids.has(id));
        if (own.length > SWEEP) { sources.sweeps++; continue; }
        for (const id of own) { add(harness, id, { case: name, ok: !!c.ok, label: c.label }); seen.add(id); }
      }
    }
    if (!checks || checks.some((c) => c.label === 'exception')) {
      sources.fromFile.push(name);
      for (const id of literals(fs.readFileSync(path.join(word, 'cases', file), 'utf8'), ids)) {
        if (!seen.has(id)) add(harness, id, { case: name, ok: null, label: '(named in the case file)' });
      }
    }
  }

  // ---- fixture: label id → built?
  const labelsFile = path.join(word, 'fixture/out/labels.txt');
  const built = new Set();
  if (fs.existsSync(labelsFile)) {
    sources.built = true;
    const text = fs.readFileSync(labelsFile, 'utf8');
    for (const line of text.slice(text.search(/^}$/m) + 2).split(/\r?\n/)) {
      const m = /^([A-Za-z][\w.]*)(?::|$)/.exec(line);
      if (m) built.add(m[1]);
    }
  }
  // A variant's labels are built when a variants/*.docx carries its name, up to the first variable in it; a label in a file's helper
  // functions (before its first Register-) is built with the fixture, since only registered parts and variants call them. With no
  // labels.txt nothing outside a variant is built; with it, a part's label is built when labels.txt holds it.
  const variants = ls(path.join(word, 'fixture/variants'), /\.docx$/);
  const labels = new Map(); // label id → in a built document (true) or written only (false)
  for (const id of built) labels.set(id, true);
  for (const file of ls(path.join(word, 'fixture/parts'), /\.ps1$/)) {
    for (const block of fs.readFileSync(path.join(word, 'fixture/parts', file), 'utf8').split(/^(?=[ \t]*Register-(?:Part|Variant)\b)/m)) {
      const v = /^[ \t]*Register-Variant\s+['"]?([^'"$\s]*)/.exec(block);
      const helper = !/^[ \t]*Register-/.test(block);
      const isBuilt = v ? variants.some((d) => d.startsWith(v[1])) : helper && sources.built;
      for (const id of labelIds(block)) if (!labels.get(id)) labels.set(id, isBuilt || built.has(id));
    }
  }
  const fixture = new Map(); // feature id → {built, unbuilt}
  for (const [label, isBuilt] of labels) {
    let hit = false;
    for (let p = label; p; p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '') {
      if (!ids.has(p)) continue;
      hit = true;
      const n = fixture.get(p) ?? fixture.set(p, { built: 0, unbuilt: 0 }).get(p);
      n[isBuilt ? 'built' : 'unbuilt']++;
    }
    if (hit) sources.fixtureLabels++;
    if (hit && !isBuilt) sources.unbuilt++;
  }

  // ---- unit tests
  const unit = new Map();
  // This script's own test names feature ids as sample data, not as checks.
  for (const file of ls(path.join(root, 'test'), /\.test\.mjs$/).filter((x) => x !== 'word-coverage.test.mjs')) {
    sources.tests++;
    for (const id of literals(fs.readFileSync(path.join(root, 'test', file), 'utf8'), ids)) add(unit, id, file);
  }

  // ---- per feature
  const features = [];
  for (const f of index) {
    const owner = ownerOf(f.id);
    if (LEFT_OUT.has(f.status) || !owner || owner.startsWith('placeholder:') || needs.has(f.id)) continue;
    const need = needOf(f);
    const h = harness.get(f.id) ?? [];
    const x = fixture.get(f.id) ?? { built: 0, unbuilt: 0 };
    const u = unit.get(f.id) ?? [];
    const has = { harness: h.some((c) => c.ok !== false), fixture: x.built + x.unbuilt > 0, unit: u.length > 0 };
    const covered = need === 'harness' ? has.harness : need === 'fixture' ? has.fixture : has.harness || has.fixture || has.unit;
    features.push({ id: f.id, label: f.label, kind: f.kind, status: f.status, owner, need, covered,
      harness: [...new Set(h.map((c) => c.case))], failing: h.filter((c) => c.ok === false).map((c) => `${c.case}: ${c.label}`),
      fixture: x, unit: u });
  }

  const blank = () => ({ built: 0, covered: 0, harness: 0, fixture: 0, unit: 0, gaps: 0, gapHarness: 0, gapFixture: 0, gapAny: 0, failing: 0, unbuilt: 0 });
  const packages = {};
  const totals = blank();
  for (const f of features) {
    for (const r of [packages[f.owner] ??= blank(), totals]) {
      r.built++;
      if (f.covered) r.covered++;
      if (f.harness.length) r.harness++;
      if (f.fixture.built + f.fixture.unbuilt) r.fixture++;
      if (f.unit.length) r.unit++;
      if (f.failing.length) r.failing++;
      if (f.fixture.unbuilt && !f.fixture.built) r.unbuilt++;
      if (!f.covered) {
        r.gaps++;
        r[{ harness: 'gapHarness', fixture: 'gapFixture', any: 'gapAny' }[f.need]]++;
      }
    }
  }
  return { features, packages, totals, sources };
}

/** The one-line totals that coverage.md and the harness compare. */
export const totalsLine = (t) => `totals: ${t.built} built, ${t.covered} with a check of the kind they need, ${t.gaps} gaps `
  + `(${t.gapHarness} need a harness check, ${t.gapFixture} a fixture case, ${t.gapAny} either); ${t.harness} named by harness checks, `
  + `${t.fixture} held by fixture cases (${t.unbuilt} only in unbuilt ones), ${t.unit} named by unit tests`;

/** The totals line written in coverage.md, or null. */
export function mdTotals(file = MD) {
  if (!fs.existsSync(file)) return null;
  return /^totals: .*$/m.exec(fs.readFileSync(file, 'utf8'))?.[0] ?? null;
}

const COLS = ['package', 'built', 'covered', '%', 'harness', 'fixture', 'unit', 'gaps', 'gap h', 'gap f', 'gap any', 'failing'];
const rowOf = (name, r) => [name, r.built, r.covered, r.built ? `${Math.round((r.covered / r.built) * 100)}%` : '-', r.harness, r.fixture, r.unit,
  r.gaps, r.gapHarness, r.gapFixture, r.gapAny, r.failing];

/** The generated block of coverage.md. */
function markdown(cov) {
  const { features, packages, totals, sources } = cov;
  const order = Object.keys(packages).sort((a, b) => packages[b].gaps - packages[a].gaps || a.localeCompare(b));
  const md = [BEGIN, '', '```', totalsLine(totals), '```', '',
    `Sources: ${sources.runs} of ${sources.cases} harness cases from their last run output`
    + `${sources.fromFile.length ? ` (${sources.fromFile.join(', ')} from the case file)` : ''}, ${sources.sweeps} registration sweeps left out, `
    + `${sources.fixtureLabels} fixture labels${sources.built ? '' : ' (no built fixture: labels.txt is missing)'}, ${sources.tests} unit test files.`, '',
    `| ${COLS.join(' | ')} |`, `|${COLS.map((_, i) => (i ? '---:' : '---')).join('|')}|`,
    ...order.map((p) => `| ${rowOf(p, packages[p]).join(' | ')} |`), `| ${rowOf('all', totals).join(' | ')} |`, '',
    '### Gaps by package', '',
    'Each built feature with no check of the kind it needs: id (kind), label, the check it needs, and what it has.', ''];
  for (const p of order) {
    const gaps = features.filter((f) => f.owner === p && !f.covered);
    if (!gaps.length) continue;
    md.push(`#### ${p} (${gaps.length})`, '');
    for (const f of gaps) {
      const has = [f.harness.length && 'harness', (f.fixture.built || f.fixture.unbuilt) && 'fixture', f.unit.length && 'unit'].filter(Boolean);
      md.push(`- ${f.id} (${f.kind}) ${f.label}: needs ${f.need === 'any' ? 'a harness check or a fixture case' : f.need === 'harness' ? 'a harness check' : 'a fixture case'}${has.length ? `, has ${has.join(' and ')}` : ''}`);
    }
    md.push('');
  }
  const failing = features.filter((f) => f.failing.length);
  md.push('### Failing checks in the last run', '', ...(failing.length ? failing.map((f) => `- ${f.id}: ${f.failing.join('; ')}`) : ['None.']), '');
  const unbuilt = features.filter((f) => f.fixture.unbuilt && !f.fixture.built);
  md.push('### Fixture cases not in the last full build', '', ...(unbuilt.length ? unbuilt.map((f) => `- ${f.id}`) : ['None.']), '', END);
  return md.join('\n');
}

/** Replaces the generated block of coverage.md (or writes the file with only that block). */
export function writeMd(cov, file = MD) {
  const block = markdown(cov);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# Word parity check coverage\n\n${BEGIN}\n${END}\n`;
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  fs.writeFileSync(file, a < 0 || b < 0 ? `${text.trimEnd()}\n\n${block}\n` : text.slice(0, a) + block + text.slice(b + END.length));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  const cov = coverage(arg('--plan') ? { planDir: arg('--plan') } : {});
  const outDir = path.join(ROOT, '.smoke-data/word/out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'coverage.json'), JSON.stringify(cov, null, 1));
  if (process.argv.includes('--write')) writeMd(cov);
  if (process.argv.includes('--json')) console.log(JSON.stringify(cov, null, 1));
  else {
    const table = [COLS, ...Object.keys(cov.packages).sort().map((p) => rowOf(p, cov.packages[p])), rowOf('all', cov.totals)];
    const w = COLS.map((_, i) => Math.max(...table.map((r) => String(r[i]).length)));
    for (const r of table) console.log(r.map((c, i) => (i ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join('  '));
    console.log(`\n${totalsLine(cov.totals)}`);
  }
  if (process.argv.includes('--check')) {
    const md = mdTotals();
    if (md !== totalsLine(cov.totals)) {
      console.error(`coverage.md is out of date (run node scripts/word-coverage.mjs --write):\n  md:  ${md}\n  now: ${totalsLine(cov.totals)}`);
      process.exit(1);
    }
  }
}
