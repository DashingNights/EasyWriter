// Checks for the mistakes work package agents kept repeating on word-parity (docs/plans/engine/agent-rules.md pairs each rule
// with its check). test/word-agent-guards.test.mjs runs them in npm test; the command line runs one against another checkout or
// commit, which is how each was proven on the past mistake it names:
//   node scripts/agent-guards.mjs budget [--head <commit>]   the .wasm BUDGET raised outside the planner's commits
//   node scripts/agent-guards.mjs clock <file...>           assertions on a wall-clock time in npm test's files
//   node scripts/agent-guards.mjs polls <file...>           harness reads repeated until two agree, with no race named
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The integration branch: packages branch from it, the integrator merges into it, the planner commits on it. */
export const BASE = process.env.EW_GUARD_BASE || 'word-parity';

/** `git args` in `root` → its output, or null when git fails (no repository, no such ref or file). */
export function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).trimEnd();
  } catch {
    return null;
  }
}

/** Whether `commit` is on BASE's first-parent line: the integration branch's own commits, its merges included. */
export function onBase(root, commit) {
  const sha = git(root, ['rev-parse', commit]);
  return !!sha && !!git(root, ['rev-list', '--first-parent', BASE])?.split('\n').includes(sha);
}

// ---------------------------------------------------------------------------------------------------------------------------
// The .wasm budget. Packages raised BUDGET in their own branches (every wave B package) and integrators raised it in
// "integrate <id>: wiring" commits and merges (wave C), so the budget followed the growth instead of stopping it.

const BUILD = 'scripts/build-engine-wasm.mjs';
const budgetIn = (text) => (text == null ? null : Number(text.match(/^export const BUDGET = ([\d_]+);/m)?.[1].replaceAll('_', '')));
const OVER = 'Only the planner raises it: put it back and report the .wasm\'s size, the growth and its cause instead (npm run build prints the size).';

/** Why BUDGET in the checkout at `root` (or at commit `head`) was raised by someone other than the planner → [text], empty when
 * it was not or when git cannot tell. On a package branch the budget may not rise above the one at its merge base with BASE.
 * On BASE's first-parent line the newest change of the value must not be a merge or an integrator's commit: the planner's
 * raise is a commit of its own ("BUDGET <bytes>: ..."). */
export function budgetProblems(root = ROOT, head = null) {
  const tip = head ?? 'HEAD';
  const now = head ? budgetIn(git(root, ['show', `${head}:${BUILD}`])) : budgetIn(fs.readFileSync(path.join(root, BUILD), 'utf8'));
  if (now == null) return [`no BUDGET found in ${BUILD}`];
  const out = [];
  if (!onBase(root, tip)) {
    const base = git(root, ['merge-base', tip, BASE]);
    const was = base && budgetIn(git(root, ['show', `${base}:${BUILD}`]));
    if (was && now > was) out.push(`BUDGET in ${BUILD} is ${now}, raised on this branch from ${was} (${BASE} at ${base.slice(0, 8)}). ${OVER}`);
    return out;
  }
  if (!head) {
    const committed = budgetIn(git(root, ['show', `HEAD:${BUILD}`]));
    if (committed && now > committed) out.push(`BUDGET in ${BUILD} is ${now}, raised from ${committed} in the working tree. ${OVER}`);
  }
  const last = git(root, ['log', '--first-parent', '-1', '--format=%H%x09%P%x09%s', '-G^export const BUDGET = ', tip, '--', BUILD]);
  if (!last) return out;
  const [sha, parents, subject] = last.split('\t');
  const before = budgetIn(git(root, ['show', `${sha}^:${BUILD}`]));
  const after = budgetIn(git(root, ['show', `${sha}:${BUILD}`]));
  const merge = parents.split(' ').length > 1;
  if (before && after > before && (merge || /^integrate /.test(subject))) {
    out.push(`BUDGET in ${BUILD} went from ${before} to ${after} in ${sha.slice(0, 8)} "${subject.slice(0, 80)}", `
      + `${merge ? 'a merge that carried a package\'s raise' : 'an integrator\'s commit'}. ${OVER} `
      + 'At a merge whose build is over the budget, take the merge back out and report it.');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// JavaScript read just far enough for the two checks below: comments dropped, strings, templates and regular expressions as
// single tokens, so their contents never read as code.

const BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

/** JavaScript `src` → tokens {t: 'id' | 'num' | 'str' | 'p', v, at (offset), line}. */
export function jsTokens(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const push = (t, v, at) => out.push({ t, v, at, line });
  const skipString = (q, j) => {
    for (j++; j < n && src[j] !== q; j++) if (src[j] === '\\') j++;
    return j + 1;
  };
  const skipTemplate = (j) => {
    for (j++; j < n && src[j] !== '`'; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '$' && src[j + 1] === '{') {
        let depth = 0;
        for (j++; j < n; j++) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}' && --depth === 0) break;
          else if (src[j] === '`') j = skipTemplate(j) - 1;
          else if (src[j] === '"' || src[j] === "'") j = skipString(src[j], j) - 1;
        }
      }
    }
    return j + 1;
  };
  while (i < n) {
    const c = src[i];
    const start = i;
    if (c === '\n') (line++, i++);
    else if (/\s/.test(c)) i++;
    else if (src.startsWith('//', i)) i = src.indexOf('\n', i) < 0 ? n : src.indexOf('\n', i);
    else if (src.startsWith('/*', i)) i = src.indexOf('*/', i + 2) < 0 ? n : src.indexOf('*/', i + 2) + 2;
    else if (c === '"' || c === "'") (i = skipString(c, i), push('str', src.slice(start, i), start));
    else if (c === '`') (i = skipTemplate(i), push('str', src.slice(start, i), start));
    else if (c === '/' && !(out.at(-1) && (out.at(-1).t === 'num' || out.at(-1).t === 'str' || (out.at(-1).t === 'id' && !BEFORE_REGEX.has(out.at(-1).v))
      || /^[)\]}]$/.test(out.at(-1).v)))) {
      let j = i + 1;
      for (let cls = false; j < n && (cls || src[j] !== '/') && src[j] !== '\n'; j++) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
      }
      i = j + 1;
      while (/\w/.test(src[i] ?? '')) i++;
      push('str', src.slice(start, i), start);
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = src.slice(i).match(/^[\w$]+/);
      i += m[0].length;
      push('id', m[0], start);
    } else if (/\d/.test(c)) {
      const m = src.slice(i).match(/^[\d_.]*\w*/);
      i += m[0].length;
      push('num', m[0], start);
    } else {
      const m = src.slice(i).match(/^(?:===|!==|\?\?=|\|\|=|&&=|=>|==|!=|<=|>=|\+=|-=|\*=|\/=|\+\+|--|&&|\|\||\?\?|\?\.|\.\.\.|.)/s);
      i += m[0].length;
      push('p', m[0], start);
    }
    // Lines inside a multi-line token.
    for (let j = start; j < i && c !== '\n'; j++) if (src[j] === '\n') line++;
  }
  return out;
}

const PAIR = { '(': ')', '[': ']', '{': '}' };

/** The index just past the bracket group opening at `tk[i]`. */
function close(tk, i) {
  let depth = 0;
  for (let j = i; j < tk.length; j++) {
    if (tk[j].t !== 'p') continue;
    if (PAIR[tk[j].v]) depth++;
    else if (/^[)\]}]$/.test(tk[j].v)) depth--;
    if (depth === 0) return j + 1;
  }
  return tk.length;
}

/** Tokens `tk[from..to)` split at commas outside any bracket. */
function args(tk, from, to) {
  const parts = [];
  let start = from;
  for (let j = from; j < to;) {
    if (tk[j].t === 'p' && PAIR[tk[j].v]) j = close(tk, j);
    else if (tk[j].v === ',' && tk[j].t === 'p') (parts.push(tk.slice(start, j)), (start = ++j));
    else j++;
  }
  if (start < to) parts.push(tk.slice(start, to));
  return parts;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Wall-clock gates in npm test. npm test runs every test file at once, beside cargo builds and harness windows, so an assertion
// on a time measured there fails when the machine is busy (engine-keys.test.mjs failed in most packages' runs and passed alone),
// and agents learned to run npm test again. A time may still be measured and printed; it may not be asserted on.

/** Where a statement in `tk` reads the wall clock: performance.now(), process.hrtime, or a difference with Date.now() (a
 * Date.now() alone is a timestamp, which tests pass around as data). */
function clockAt(tk, j) {
  const v = (k) => tk[k]?.v;
  if (v(j) === 'performance' && v(j + 1) === '.' && v(j + 2) === 'now') return true;
  if (v(j) === 'process' && v(j + 1) === '.' && v(j + 2) === 'hrtime') return true;
  if (v(j) === 'Date' && v(j + 1) === '.' && v(j + 2) === 'now' && v(j + 3) === '(' && v(j + 4) === ')') return v(j + 5) === '-' || v(j - 1) === '-';
  return false;
}

/** The identifiers `tk` reads as values (not property names after a dot, not keys before a colon in an object literal). */
function reads(tk) {
  return tk.filter((x, k) => x.t === 'id' && tk[k - 1]?.v !== '.' && tk[k - 1]?.v !== '?.' && !(tk[k + 1]?.v === ':' && /^[{,]$/.test(tk[k - 1]?.v ?? '')));
}

/** The names a declaration pattern binds: `a`, `{a, b: c}`, `[a, , b]`. */
function bound(tk) {
  return tk.filter((x, k) => x.t === 'id' && tk[k + 1]?.v !== ':' && tk[k - 1]?.v !== '=' && tk[k - 1]?.v !== '.').map((x) => x.v);
}

/** The assertions in `src` (one test file) that compare a wall-clock time → [{line, text}]. Times flow through variables:
 * a value computed from the clock, or from such a value, or pushed into an array, or a function whose body reads the clock,
 * counts as a time. */
export function clockGates(src) {
  const tk = jsTokens(src);
  const timed = new Set();
  const hot = (part) => part.some((x, k) => clockAt(part, k)) || reads(part).some((x) => timed.has(x.v));
  // The end of the expression that starts at `j`: the next ; or , or closing bracket at its own depth.
  const exprEnd = (j) => {
    for (let k = j; k < tk.length;) {
      if (tk[k].t === 'p' && PAIR[tk[k].v]) k = close(tk, k);
      else if (tk[k].t === 'p' && /^[;,)\]}]$/.test(tk[k].v)) return k;
      else k++;
    }
    return tk.length;
  };
  for (let changed = true; changed;) {
    changed = false;
    const mark = (names) => names.forEach((x) => !timed.has(x) && (timed.add(x), (changed = true)));
    for (let j = 0; j < tk.length; j++) {
      const x = tk[j];
      if (x.t === 'id' && /^(const|let|var)$/.test(x.v)) {
        // const a = expr, b = expr; and for (const a of expr)
        let k = j + 1;
        for (;;) {
          const patEnd = tk[k]?.t === 'p' && PAIR[tk[k].v] ? close(tk, k) : k + 1;
          const pat = tk.slice(k, patEnd);
          if (tk[patEnd]?.v === '=') {
            const end = exprEnd(patEnd + 1);
            if (hot(tk.slice(patEnd + 1, end))) mark(bound(pat));
            k = end;
          } else if (tk[patEnd]?.v === 'of' || tk[patEnd]?.v === 'in') {
            const end = exprEnd(patEnd + 1);
            if (hot(tk.slice(patEnd + 1, end))) mark(bound(pat));
            k = end;
          } else k = patEnd;
          if (tk[k]?.v !== ',') break;
          k++;
        }
      } else if (x.t === 'id' && x.v === 'function' && tk[j + 1]?.t === 'id') {
        const body = tk.findIndex((y, k) => k > j && y.v === '{');
        if (body > 0 && hot(tk.slice(body, close(tk, body)))) mark([tk[j + 1].v]);
      } else if (x.t === 'p' && /^(=|\+=|-=|\*=|\/=|\?\?=|\|\|=)$/.test(x.v)) {
        // target = expr, target.key = expr, target[k] = expr: the target's root takes the time.
        let k = j - 1;
        for (;;) {
          if (tk[k]?.v === ']') {
            for (let depth = 0; k >= 0; k--) {
              if (tk[k].v === ']') depth++;
              else if (tk[k].v === '[' && --depth === 0) break;
            }
            k--;
          } else if (tk[k - 1]?.v === '.') k -= 2;
          else break;
        }
        const target = tk[k];
        if (target?.t === 'id' && !/^(const|let|var)$/.test(tk[k - 1]?.v ?? '') && hot(tk.slice(j + 1, exprEnd(j + 1)))) mark([target.v]);
      } else if (x.v === '.' && /^(push|unshift|set|add|concat)$/.test(tk[j + 1]?.v ?? '') && tk[j + 2]?.v === '(') {
        let k = j - 1;
        while (k > 0 && tk[k - 1]?.v === '.') k -= 2;
        if (tk[k]?.t === 'id' && hot(tk.slice(j + 2, close(tk, j + 2)))) mark([tk[k].v]);
      }
    }
  }
  const out = [];
  for (let j = 0; j < tk.length; j++) {
    if (tk[j].v !== 'assert' || tk[j - 1]?.v === '.') continue;
    const method = tk[j + 1]?.v === '.' ? tk[j + 2]?.v : '';
    const open = method ? j + 3 : j + 1;
    if (tk[open]?.v !== '(') continue;
    const end = close(tk, open);
    const list = args(tk, open + 1, end - 1);
    // The message is the last argument: assert(value, message), assert.equal(actual, expected, message).
    const checked = list.slice(0, /^(|ok|match|doesNotMatch)$/.test(method) ? 1 : 2);
    if (checked.some((part) => hot(part.filter((y) => y.t !== 'str')))) {
      out.push({ line: tk[j].line, text: src.slice(tk[j].at, tk[end - 1].at + 1).replace(/\s+/g, ' ').slice(0, 160) });
    }
  }
  return out;
}

export const CLOCK_FIX = 'npm test runs every test file at once beside cargo builds and harness windows, so a time asserted there '
  + 'fails when the machine is busy, not when the code is slow. Assert on the work instead (pages laid out, layout events, bytes, '
  + 'the engine\'s stats().lightEdits for a bounded edit) and keep the time gate in a harness case (.smoke-data/word/cases, run '
  + 'in a slot). A time may still be printed with console.log; a hang guard belongs in the test\'s timeout option.';

// ---------------------------------------------------------------------------------------------------------------------------
// Harness reads repeated until two agree. Such a loop hides a race: the value changes after the step the case waited for, so
// the case reads until it stops moving instead of waiting for the event that makes it ready.

/** The loops in harness case `src` that read a value until it equals the previous read (`if (now === last) break; last = now`,
 * or a counter of equal reads) and wait between reads, with no comment naming the race ("// race: ...", or a // comment
 * with the word race) on or up to six lines above the loop → [{line, text}]. */
export function stablePolls(src) {
  // Most of these loops run in the page, inside the template literals the case sends to t.J: read those as code too.
  const tk = jsTokens(src.replaceAll('`', ' '));
  const lines = src.split('\n');
  const out = [];
  for (let j = 0; j < tk.length; j++) {
    if (!(tk[j].v === '===' && tk[j - 1]?.t === 'id' && tk[j + 1]?.t === 'id')) continue;
    const [a, b] = [tk[j - 1].v, tk[j + 1].v];
    // The previous read takes the new one within the next statements: last = now.
    const later = tk.slice(j + 2, j + 40);
    if (!later.some((y, k) => y.v === b && later[k + 1]?.v === '=' && later[k + 2]?.v === a)) continue;
    // Inside a for or while loop whose body waits between reads.
    let loop = -1;
    for (let k = j; k >= 0 && loop < 0; k--) {
      if (/^(for|while)$/.test(tk[k].v) && tk[k + 1]?.v === '(') {
        const head = close(tk, k + 1);
        const bodyEnd = tk[head]?.v === '{' ? close(tk, head) : head;
        if (bodyEnd > j) loop = k;
      }
    }
    if (loop < 0) continue;
    const head = close(tk, loop + 1);
    const body = tk.slice(loop, tk[head]?.v === '{' ? close(tk, head) : head);
    if (!body.some((y) => y.v === 'await' || y.v === 'wait' || y.v === 'requestAnimationFrame' || y.v === 'setTimeout')) continue;
    const from = tk[loop].line;
    if (lines.slice(Math.max(0, from - 7), tk[j].line).some((l) => /\/\/.*\brace\b/.test(l))) continue;
    if (!out.some((o) => o.line === from)) out.push({ line: from, text: lines[from - 1].trim().slice(0, 160) });
  }
  return out;
}

export const POLL_FIX = 'A read repeated until two reads agree hides a race: wait instead for the event that makes the value '
  + 'ready (a layout event, the client\'s settled or ready state, t.until on the condition itself). If no such event exists yet, '
  + 'name the race it hides in a "// race: ..." comment above the loop and report it.';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [what, ...rest] = process.argv.slice(2);
  const at = rest.indexOf('--head');
  let problems = [];
  if (what === 'budget') problems = budgetProblems(ROOT, at >= 0 ? rest[at + 1] : null);
  else if (what === 'clock' || what === 'polls') {
    for (const f of rest) {
      const found = (what === 'clock' ? clockGates : stablePolls)(fs.readFileSync(f, 'utf8'));
      problems.push(...found.map((g) => `${f}:${g.line}: ${g.text}`));
    }
    if (problems.length) problems.push(what === 'clock' ? CLOCK_FIX : POLL_FIX);
  } else problems = ['usage: node scripts/agent-guards.mjs budget [--head <commit>] | clock <file...> | polls <file...>'];
  console.log(problems.join('\n') || 'ok');
  process.exit(problems.length ? 1 : 0);
}
