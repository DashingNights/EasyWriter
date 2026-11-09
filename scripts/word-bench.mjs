// Word parity benchmark (docs/plans/word/plan.md §1.15):
//   node scripts/word-bench.mjs [--plan <planDir>] [--registered <file>] [--checks <dir>] [--json]
// compares the ribbon spec, what the harness dumped from the registry (.smoke-data/word/out/registered.json, lib
// t.dumpRegistered()) and the harness checks (each case's checks.json) with index.json, per tab and per index status. It exits
// 1 when the spec holds an id index.json does not know (derived and EasyWriter's own ids aside) or a feature that is no
// placeholder has no owner.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BACKSTAGE, CONTROLS, ITEMS, TABS } from '../src/document/ribbon/spec.mjs';
import { ownersOf, readJson as read } from './word-spec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const planDir = arg('--plan') ?? 'A:/Programming Dumpster/DAF Writer/docs/plans/word';
const registeredFile = arg('--registered');
const checksDir = arg('--checks');
const asJson = process.argv.includes('--json');

const index = read(path.join(planDir, 'index.json'));
const plan = read(path.join(planDir, 'plan.json'));
const ix = new Map(index.map((f) => [f.id, f]));
const reg = registeredFile ? read(registeredFile) : { commands: {}, implements: {}, fields: [] };
const fields = new Set(reg.fields ?? []);

// Word's key table, once scaffold-kit has landed it: chord → the command its bind row runs.
let WORD_KEYS = [];
try {
  ({ WORD_KEYS } = await import(pathToFileURL(path.join(ROOT, 'src/document/word/keymap.mjs')).href));
} catch {
  // ponytail: before keymap.mjs exists, key features resolve to themselves and count as missing; it lands with scaffold-kit.
}
const chordKey = (c) => {
  const parts = String(c).trim().split('+');
  const key = parts.pop();
  return [...['Ctrl', 'Alt', 'Shift'].filter((m) => parts.includes(m)), key].join('+');
};
const byChord = new Map(WORD_KEYS.filter((r) => r.kind === 'bind').map((r) => [chordKey(r.chord), r.cmd]));

// Owners by the longest prefix (§4); placeholders as 'placeholder:<reason>'.
const ownerOf = ownersOf(plan);

/** The id that delivers feature `f`: a `same` feature's canonical id (chains followed), a key feature's bind row command, a
 * field feature's fields.<NAME>, else its own. */
function resolve(f) {
  if (f.kind === 'field') return f.id;
  if (f.kind === 'key') {
    for (const c of String(f.keys ?? '').split(/,\s*/).filter(Boolean)) if (byChord.has(chordKey(c))) return byChord.get(chordKey(c));
    return f.id;
  }
  let g = f;
  const seen = new Set();
  while (g?.same && !seen.has(g.id)) {
    seen.add(g.id);
    g = ix.get(g.same);
  }
  return g?.id ?? f.id;
}
const by = (o, id) => o?.[id] ?? null;
const delivered = (f) => {
  if (f.kind === 'field') return fields.has(f.id.slice(7) === 'formula' ? '=' : f.id.slice(7)) ? 'field' : null;
  const id = resolve(f);
  return by(reg.commands, id) ?? by(reg.implements, id);
};

// The spec's ids: controls, items, spinner parts, backstage entries.
const inSpec = new Set([...Object.keys(CONTROLS), ...Object.keys(ITEMS), ...BACKSTAGE.map((b) => b.id)]);
for (const c of Object.values(CONTROLS)) if (c.parts) inSpec.add(c.parts.more).add(c.parts.less);
const needsOf = new Map([...Object.values(CONTROLS), ...Object.values(ITEMS), ...BACKSTAGE].filter((x) => x.needs).map((x) => [x.id, x.needs]));

// Harness checks per feature id: [ok, failing]. Only the output of cases that still have a case file (cases/ beside the checks
// directory) counts: a renamed or deleted case leaves its last run's directory behind.
const checks = new Map();
if (checksDir && fs.existsSync(checksDir)) {
  const cases = path.join(checksDir, '..', 'cases');
  for (const d of fs.readdirSync(checksDir)) {
    const f = path.join(checksDir, d, 'checks.json');
    if (!fs.existsSync(f) || !fs.existsSync(path.join(cases, `${d}.js`))) continue;
    for (const c of read(f)) for (const id of c.ids ?? []) {
      const n = checks.get(id) ?? [0, 0];
      n[c.ok ? 0 : 1]++;
      checks.set(id, n);
    }
  }
}

// ---- count
const rowOf = (id) => id.split('.')[0];
const TAB_IDS = TABS.map((t) => t.id);
const rows = new Map();
const statusRows = new Map();
const blank = () => ({ scope: 0, spec: 0, working: 0, baseOnly: 0, placeholders: {}, checked: 0, failing: 0, derived: 0, missing: 0, unknown: 0 });
const row = (m, k) => {
  if (!m.has(k)) m.set(k, blank());
  return m.get(k);
};
const errors = [];
const missingIds = [];
for (const f of index) {
  if (f.status === 'excluded') continue;
  const tab = rowOf(f.id);
  const r = row(rows, tab);
  const s = row(statusRows, f.status);
  const owner = ownerOf(f.id);
  const needs = needsOf.get(f.id) ?? (owner?.startsWith('placeholder:') ? owner.slice(12) : f.status === 'cloud' ? 'cloud' : null);
  for (const x of [r, s]) {
    x.scope++;
    if (inSpec.has(f.id)) x.spec++;
    if (needs) x.placeholders[needs] = (x.placeholders[needs] ?? 0) + 1;
  }
  if (!needs && !owner) errors.push(`no owner: ${f.id}`);
  if (TAB_IDS.includes(tab) && !inSpec.has(f.id) && !needs) {
    r.missing++;
    s.missing++;
    missingIds.push(f.id);
  }
  const who = delivered(f);
  const resolvedOwner = ownerOf(resolve(f));
  const mine = (o) => o === 'field' || o === owner || o === resolvedOwner || (o === 'base' && [owner, resolvedOwner].includes('scaffold-core'));
  if (!needs && who && mine(who)) for (const x of [r, s]) x.working++;
  else if (!needs && who === 'base' && ['exists', 'extend'].includes(f.status)) for (const x of [r, s]) x.baseOnly++;
  const c = checks.get(f.id);
  if (c) for (const x of [r, s]) {
    if (c[1]) x.failing++;
    else x.checked++;
  }
}
for (const it of Object.values(ITEMS)) if (it.derived) row(rows, rowOf(it.id)).derived++;
for (const id of [...Object.keys(CONTROLS), ...Object.keys(ITEMS)]) {
  if (ix.has(id) || id.startsWith('x.') || ITEMS[id]?.derived) continue;
  row(rows, rowOf(id)).unknown++;
  errors.push(`spec id unknown to index.json: ${id}`);
}

// ---- print
const order = ['frame', 'file', ...TAB_IDS];
const keys = [...rows.keys()].sort((a, b) => {
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
});
const total = blank();
for (const r of rows.values()) {
  for (const k of ['scope', 'spec', 'working', 'baseOnly', 'checked', 'failing', 'derived', 'missing', 'unknown']) total[k] += r[k];
  for (const [k, v] of Object.entries(r.placeholders)) total.placeholders[k] = (total.placeholders[k] ?? 0) + v;
}
const ph = (p) => Object.values(p).reduce((a, b) => a + b, 0);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
const overall = `overall ${new Date().toISOString().slice(0, 10)}: ${total.working}/${total.scope - ph(total.placeholders)} working (${pct(total.working, total.scope - ph(total.placeholders))}), `
  + `${total.baseOnly} base only, ${ph(total.placeholders)} placeholders, ${total.checked} checked, ${total.failing} failing, ${total.spec} in the spec, `
  + `${total.derived} derived items, ${total.missing} missing from the spec, ${total.unknown} unknown`;

if (asJson) {
  console.log(JSON.stringify({ rows: Object.fromEntries(keys.map((k) => [k, rows.get(k)])), statuses: Object.fromEntries(statusRows), total, overall,
    errors, missing: missingIds }, null, 1));
} else {
  const head = ['area', 'scope', 'spec', 'working', 'base only', 'placeholders', 'checked', 'failing', 'derived', 'missing', 'unknown'];
  const line = (name, r) => [name, r.scope, r.spec, r.working, r.baseOnly, ph(r.placeholders), r.checked, r.failing, r.derived, r.missing, r.unknown];
  const table = [head, ...keys.map((k) => line(k, rows.get(k))), line('all', total)];
  const w = head.map((_, i) => Math.max(...table.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((c, i) => (i ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join('  ');
  console.log(fmt(head));
  for (const r of table.slice(1)) console.log(fmt(r));
  console.log('');
  const sHead = ['status', 'scope', 'spec', 'working', 'base only', 'placeholders', 'checked', 'failing', 'derived', 'missing', 'unknown'];
  console.log(fmt(sHead));
  for (const [k, r] of statusRows) console.log(fmt(line(k, r)));
  console.log('');
  console.log(`placeholders by reason: ${Object.entries(total.placeholders).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (!registeredFile) console.log('no --registered file: working and base only count nothing (the harness writes .smoke-data/word/out/registered.json)');
  if (!WORD_KEYS.length) console.log('src/document/word/keymap.mjs is missing: key features resolve to themselves');
  console.log(overall);
  if (errors.length) console.error(`\n${errors.length} errors:\n  ${errors.slice(0, 50).join('\n  ')}`);
}
process.exit(errors.length ? 1 : 0);
