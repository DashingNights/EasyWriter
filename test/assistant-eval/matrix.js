'use strict';
// The eval matrix (docs/plans/assistant-reliability.md §3 Wave 0): every <run>/result.json of a folder → <folder>/matrix.md, with
// the cases as rows and the runs as columns (PASS or FAIL, a stepped case's score in percent, with FAIL when it failed on another
// check; - when the run did not have the case), each run's pass count, average score (an unstepped case counts 100 or 0), seconds
// and tokens, then a table of the run headers.
//   npm run assistant:matrix [-- <folder>]   (default: DAF_EVAL_OUT or %TEMP%/daf-writer-eval, as run.js)
// Runs from before the header named them: the model file comes from <folder>/<run>.server.log ("loading model '...'") and
// thinking from result.md, else "?". A chat template hash is shown as the name of the .jinja file in the folder or in
// src/assistant that has the same hash.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.resolve(process.argv[2] ?? process.env.DAF_EVAL_OUT ?? path.join(os.tmpdir(), 'daf-writer-eval'));
const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
let dirs = [];
try {
  dirs = fs.readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
} catch (e) {
  console.log(`Cannot read ${DIR}: ${e.message}`);
}
const skipped = []; // a result.json that is not JSON or has no results list (a run cut off mid-write)
const runs = dirs.flatMap((d) => {
  const json = read(path.join(DIR, d.name, 'result.json'));
  if (!json) return [];
  try {
    const r = JSON.parse(json);
    if (!Array.isArray(r.results)) throw new Error('no results');
    return [{ ...r, run: d.name, results: r.results.filter((x) => typeof x?.id === 'string') }];
  } catch {
    skipped.push(d.name);
    return [];
  }
}).sort((a, b) => String(a.date).localeCompare(String(b.date)));
if (skipped.length) console.log(`Skipped (unreadable result.json): ${skipped.join(', ')}`);
if (!runs.length) {
  console.log(`No <run>/result.json in ${DIR}`);
  process.exit(1);
}

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompts.json'), 'utf8'));
const seen = new Set(runs.flatMap((r) => r.results.map((x) => x.id)));
const ids = [...new Set([...CASES.map((c) => c.id), ...seen])].filter((id) => seen.has(id)); // prompts.json order, then retired cases
const xfail = new Set(CASES.filter((c) => c.expectedFail).map((c) => c.id));
const threshold = Object.fromEntries(CASES.map((c) => [c.id, c.expect?.threshold ?? 100])); // a stepped case that met it and still failed (never, maxCalls, ...) shows FAIL too

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const jinja = Object.fromEntries([DIR, path.join(__dirname, '..', '..', 'src', 'assistant')].flatMap((d) => {
  try {
    return fs.readdirSync(d).filter((f) => f.endsWith('.jinja')).map((f) => [sha(read(path.join(d, f))), f]);
  } catch {
    return [];
  }
}));
const modelFile = (r) => (r.modelPath ? String(r.modelPath).split(/[\\/]/).pop() : r.model && !String(r.model).startsWith('(') ? r.model
  : read(path.join(DIR, `${r.run}.server.log`)).match(/loading model '([^']+)'/)?.[1].split(/[\\/]/).pop() ?? '?');
const sampling = (r) => {
  const s = r.results.find((x) => x.sampling)?.sampling;
  return s ? `temp ${s.temperature}, top_p ${s.top_p}, top_k ${s.top_k}, presence ${s.presence_penalty}` : '?';
};
const counted = (r) => r.results.filter((x) => !x.expectedFail);
const row = (cells) => `| ${cells.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`;

const lines = [
  '# Assistant eval matrix',
  '',
  `${runs.length} runs in ${DIR}, oldest first. Expected-fail cases are not counted in Passed or Average score.${skipped.length ? ` Skipped (unreadable result.json): ${skipped.join(', ')}.` : ''}`,
  '',
  row(['Case', ...runs.map((r) => r.run)]),
  row(['---', ...runs.map(() => '---')]),
  ...ids.map((id) => row([`${id}${xfail.has(id) ? ' (expected fail)' : ''}`, ...runs.map((r) => {
    const x = r.results.find((y) => y.id === id);
    return !x ? '-' : typeof x.score === 'number' ? `${x.score}%${!x.pass && x.score >= (threshold[id] ?? 100) ? ' FAIL' : ''}` : x.pass ? 'PASS' : 'FAIL';
  })])),
  row(['Passed', ...runs.map((r) => `${counted(r).filter((x) => x.pass).length} of ${counted(r).length}`)]),
  row(['Average score', ...runs.map((r) => `${Math.round(counted(r).reduce((n, x) => n + (typeof x.score === 'number' ? x.score : x.pass ? 100 : 0), 0) / (counted(r).length || 1))}%`)]),
  row(['Seconds', ...runs.map((r) => Math.round(r.results.reduce((n, x) => n + (Number(x.seconds) || 0), 0)))]),
  row(['Tokens', ...runs.map((r) => r.results.reduce((n, x) => n + (Number(x.tokens) || 0), 0))]),
  '',
  '## Runs',
  '',
  row(['Run', 'Date (UTC)', 'Mode', 'Model file', 'Model id', 'Sampling sent', 'Thinking', 'Template']),
  row(Array(8).fill('---')),
  ...runs.map((r) => row([r.run, String(r.date ?? '?').slice(0, 16).replace('T', ' '), r.mode ?? '?', modelFile(r), r.modelId ?? '?', sampling(r),
    r.thinking ?? read(path.join(DIR, r.run, 'result.md')).match(/Thinking: (\w+)\./)?.[1] ?? '?', r.template ? jinja[r.template] ?? r.template : '?'])),
  '',
];
fs.writeFileSync(path.join(DIR, 'matrix.md'), lines.join('\n'));
console.log(path.join(DIR, 'matrix.md'));
