// P7 engine-rename (docs/plans/engine/viewport-design.md section 9.2, step 2): WordCraft's names in the engine's code become
// ours, from one table. A crate's library takes its package's name (`wordcraft_layout` is `ew_doc_layout`), the workspace keys
// become the package names and the `[lib] name` lines go; any other `wordcraft_<x>` is `ew_<x>`, `WORDCRAFT_<X>` is `EW_<X>`, and a
// string that starts `wordcraft-` (a temporary folder, a thread) starts `easywriter-`. Running it again changes nothing.
//   node scripts/engine-rename.mjs [path...]          rewrites the files under each path (DIRS when none) in place
//   node scripts/engine-rename.mjs --patch [in [out]]  rewrites a patch (stdin and stdout when left out)
//   node scripts/engine-rename.mjs --check [path...]  lists what is left to rename and any other `wordcraft` in the code; exit 1
// A branch made before the rename moves onto it with its own edits only. <base> is the branch's merge base with word-parity
// from before the rename (git merge-base wp/<id> <the rename merge>^1):
//   git diff --binary <base> wp/<id> > own.patch
//   node scripts/engine-rename.mjs --patch own.patch renamed.patch
//   git switch -c wp/<id>-renamed word-parity && git apply --index --reject renamed.patch
// Only hunks that touch what the rename changed by hand (the strings that say EasyWriter now, ORIGIN.md) come back as .rej files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** WordCraft's library name, without `wordcraft_` → our package (section 9.1). The library is the package's name with `_`. */
export const CRATES = {
  geom: 'ew-geom', doc: 'ew-doc', fonts: 'ew-fonts', layout: 'ew-doc-layout', docx: 'ew-docx', docbin: 'ew-docbin',
  formats: 'ew-formats', render: 'ew-scene', pdf: 'ew-pdf', proof: 'ew-proof', engine: 'ew-doc-edit', metafile: 'ew-metafile',
};
const lib = (pkg) => pkg.replaceAll('-', '_');
const LIBS = new Set(Object.values(CRATES).map(lib));
const crate = Object.keys(CRATES).sort((a, b) => b.length - a.length).join('|');

/** The one-line rules, in order. */
const RULES = [
  // A dependency key, and cargo's -p, name the package.
  [new RegExp(`^(\\s*)wordcraft-(${crate})(?=\\s*=)`, 'g'), (_, s, c) => s + CRATES[c]],
  [new RegExp(`(-p )wordcraft-(${crate})\\b`, 'g'), (_, p, c) => p + CRATES[c]],
  // A workspace key that is its package's name needs no `package`.
  [/^(ew-[a-z-]+) = \{ package = "\1", /g, '$1 = { '],
  [new RegExp(`(?<![\\w])wordcraft_(${crate})(?![\\w])`, 'g'), (_, c) => lib(CRATES[c])],
  [/(?<![\w])wordcraft_(?=[a-z])/g, 'ew_'],
  [/(?<![\w])WORDCRAFT_(?=[A-Z0-9])/g, 'EW_'],
  // The stored form's version 0 (`wordcraft-json`) and the vendored metafile reader's folder keep their names.
  [/(["'])(\.?)wordcraft-(?!json\b|metafile\b)/g, '$1$2easywriter-'],
];

const isLib = (line) => line.trim() === '[lib]';
const isLibName = (line) => LIBS.has(/^name = "([a-z_]+)"\s*$/.exec(line)?.[1]);

/** Line texts (no line ends) → the renamed ones, null for a line that goes: a `[lib]` whose only key is a renamed crate's
 * library name, with the blank line after it. */
export function renameLines(lines) {
  const out = lines.map((l) => RULES.reduce((s, [re, to]) => s.replace(re, to), l));
  for (let i = 0; i + 1 < out.length; i++) {
    const next = out[i + 2];
    if (!isLib(out[i] ?? '') || !isLibName(out[i + 1] ?? '') || (next != null && next.trim() && !next.startsWith('['))) continue;
    out[i] = out[i + 1] = null;
    if (next != null && !next.trim()) out[i + 2] = null;
  }
  return out;
}

/** A file's text → the renamed text, each line keeping its own line end. */
export function renameText(text) {
  const parts = text.split(/(\r?\n)/);
  return renameLines(parts.filter((_, i) => i % 2 === 0)).map((l, i) => (l === null ? '' : l + (parts[2 * i + 1] ?? ''))).join('');
}

/** A unified diff → the same diff against the renamed tree: its lines renamed, binary patches left as they are, and each
 * hunk's counts made again where a `[lib]` line went. */
export function renamePatch(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out = [];
  let binary = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) binary = false;
    if (line === 'GIT binary patch') binary = true;
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (binary || !head) {
      out.push(line);
      continue;
    }
    // The hunk is as long as its counts say (a blank context line may have lost its space).
    const body = [];
    for (let old = Number(head[2] ?? 1), neu = Number(head[4] ?? 1); (old > 0 || neu > 0 || lines[i + 1]?.[0] === '\\') && i + 1 < lines.length; ) {
      const l = lines[++i] || ' ';
      body.push(l);
      if (l[0] !== '+' && l[0] !== '\\') old--;
      if (l[0] !== '-' && l[0] !== '\\') neu--;
    }
    // "\ No newline at end of file" follows the line it is about; it is no line of either side.
    const renamed = renameLines(body.map((l) => (l[0] === '\\' ? '' : l.slice(1))));
    const result = body.flatMap((l, k) => (l[0] === '\\' ? (renamed[k - 1] === null ? [] : [l]) : renamed[k] === null ? [] : [l[0] + renamed[k]]));
    const count = (skip) => result.filter((l) => l[0] !== skip && l[0] !== '\\').length;
    // The text after @@ is a line of the file too (the function the hunk is in).
    out.push(`@@ -${head[1]},${count('+')} +${head[3]},${count('-')} @@${renameLines([head[5]])[0]}`, ...result);
  }
  return out.join(eol);
}

/** Where the rename runs by default: the engine, its JavaScript side, the scripts, the tests and the harness cases, and the
 * metafile binding, which builds the engine's metafile crate. Not ORIGIN.md, the licence files or ATTRIBUTION.md, which name
 * WordCraft for its licence and credit. */
export const DIRS = ['engine', 'src/engine', 'src/document/canvas', 'scripts', 'test', '.smoke-data/word/cases', 'docs/plans/engine/stage2',
  'src/vendor/wordcraft-metafile/binding'];
const KEEP = new Set(['engine/ORIGIN.md', 'engine/ATTRIBUTION.md', 'engine/NOTICE', 'engine/LICENSE-MIT', 'engine/LICENSE-APACHE',
  // This file's table, and the test that holds the rename to it.
  'scripts/engine-rename.mjs', 'test/word-engine-rename.test.mjs']);
const TEXT = /\.(rs|toml|mjs|js|jsx|cjs|json|md|txt|ps1|py|sh|yml)$/;
/** Code, where the text left after the comments is checked. */
const CODE = new Set(['rs', 'toml', 'mjs', 'js', 'jsx', 'cjs']);
// The build's output and the test fixtures (stored models, Word files) are data, not code.
const SKIP = new Set(['node_modules', 'target', 'src/engine/wasm', 'test/fixtures']);

/** The text files under `rel` (a file or folder, relative to `root`), as relative paths with forward slashes. */
export function files(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  if (!fs.statSync(abs).isDirectory()) return TEXT.test(rel) && !KEEP.has(rel) ? [rel] : [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => {
    const r = `${rel}/${d.name}`;
    if (d.isDirectory()) return SKIP.has(d.name) || SKIP.has(r) || d.name.startsWith('.') ? [] : files(root, r);
    return TEXT.test(d.name) && !KEEP.has(r) ? [r] : [];
  });
}

/** Renames every file under `paths` in place → the files it changed. */
export function renameTree(root = ROOT, paths = DIRS) {
  const changed = [];
  for (const rel of paths.flatMap((p) => files(root, p))) {
    const abs = path.join(root, rel);
    const text = fs.readFileSync(abs, 'utf8');
    const renamed = renameText(text);
    if (renamed !== text) {
      fs.writeFileSync(abs, renamed);
      changed.push(rel);
    }
  }
  return changed;
}

// ---------- What is left (test/word-engine-rename.test.mjs) ----------

/** `text` with its comments blanked, strings kept (`//` and block comments in Rust and JavaScript, `#` in TOML and the
 * others), so what is left is code and the text a user can see. Line count unchanged. */
export function codeOf(text, ext) {
  const hash = !['rs', 'mjs', 'js', 'jsx', 'cjs'].includes(ext);
  const js = ['mjs', 'js', 'jsx', 'cjs'].includes(ext);
  let out = '';
  // The last character of code before i that is not a space: a `/` after one of these starts a regular expression.
  let prev = '';
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    const skipTo = (end) => {
      const j = text.indexOf(end, i + 2);
      const stop = j < 0 ? text.length : j + (end === '\n' ? 0 : end.length);
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    };
    const before = prev;
    if (!/\s/.test(c) && !(hash ? c === '#' : two === '//' || two === '/*')) prev = c;
    if (hash ? c === '#' : two === '//') skipTo('\n');
    else if (!hash && two === '/*') skipTo('*/');
    else if (js && c === '/' && /[(,=:[!&|?{};]/.test(before || '(')) {
      // A regular expression literal (it may hold quotes): to its closing `/`, outside a [class].
      let j = i + 1;
      for (let cls = false; j < text.length && text[j] !== '\n' && (cls || text[j] !== '/'); j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') cls = true;
        else if (text[j] === ']') cls = false;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '"' || (js && (c === '\'' || c === '`')) || (ext === 'rs' && /^'(\\.|[^\\'])'/.test(text.slice(i, i + 4)))) {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ext === 'rs' && /^r#*"/.test(text.slice(i, i + 8)) && !/\w/.test(text[i - 1] ?? '')) {
      const hashes = /^r(#*)"/.exec(text.slice(i))[1];
      const j = text.indexOf(`"${hashes}`, i + hashes.length + 2);
      const stop = j < 0 ? text.length : j + hashes.length + 1;
      out += text.slice(i, stop);
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Old names and values kept on purpose, each where it is read: [file, or null for any, the text, why]. */
export const ALLOWED = [
  [null, /wordcraft-json/g, 'the stored form\'s version 0 (src/engine/model/form.mjs), which records still hold'],
  [null, /wordcraft-metafile(?!\s*=)/g, 'the vendored metafile reader\'s folder, src/vendor/wordcraft-metafile'],
  [null, /vendor(?:', '|\/)wordcraft\b(?!-)/g, 'the folder the engine moved out of, which engine-move checks is gone'],
  ['engine/crates/doc/src/schema.rs', /reads_wordcrafts_form_as_version_0/g, 'the test of version 0'],
  ['engine/crates/doc/src/byte_store.rs', /\bwordcraft:/g, 'the bookkeeping keys records and undo histories written before the rename hold'],
  ['engine/crates/doc/src/schema.rs', /`wordcraft:`/g, 'the note on those keys at schema 8'],
  ['engine/crates/doc-edit/src/session/history_file.rs', /"wordcraft:(?:app\.kept)?"/g, 'the test of a history written before the rename'],
  [null, /urn:wordcraft:canvas-xfrm/g, 'the canvas turn in .docx files written before the rename (docx lib.rs, its test)'],
];

/** Where a comment in engine/ may still say WordCraft: credit for code that came from it, the stored form it wrote (version 0)
 * and its tools and evaluation, which this repository does not have. Anywhere else the engine is EasyWriter. */
export const CREDIT = [
  /\bfrom WordCraft\b/g, /\bnot WordCraft's\b/g, /original WordCraft artwork/g, /WordCraft contributors/g,
  /WordCraft's (?:form|workspace)\b/g, /WordCraft evaluation|wordcraft-eval\.md/g, /`wordcraft-(?:cli|compose)\b/g,
];

/** What is left under `paths`: [file, line, text] for each line the rename would change, and each line whose code still says
 * wordcraft outside ALLOWED: in engine/ its comments too, outside CREDIT; elsewhere comments are left out. */
export function leftovers(root = ROOT, paths = DIRS) {
  const found = [];
  for (const rel of paths.flatMap((p) => files(root, p))) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    if (!/wordcraft/i.test(text)) continue;
    const lines = text.split(/\r?\n/);
    const renamed = renameLines(lines);
    const seen = new Set();
    lines.forEach((l, i) => {
      if (renamed[i] !== l) seen.add(i);
    });
    const ext = rel.split('.').pop();
    if (CODE.has(ext)) {
      const engine = rel.startsWith('engine/');
      let code = engine ? text : codeOf(text, ext);
      for (const re of [...ALLOWED.filter(([file]) => !file || file === rel).map(([, re]) => re), ...(engine ? CREDIT : [])]) {
        code = code.replace(re, (m) => ' '.repeat(m.length));
      }
      code.split(/\r?\n/).forEach((l, i) => {
        if (/wordcraft/i.test(l)) seen.add(i);
      });
    }
    for (const i of [...seen].sort((a, b) => a - b)) found.push([rel, i + 1, lines[i].trim()]);
  }
  return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, ...rest] = process.argv.slice(2);
  if (flag === '--patch') {
    const [input, output] = rest;
    const text = fs.readFileSync(input ?? 0, 'utf8');
    if (output) fs.writeFileSync(output, renamePatch(text));
    else process.stdout.write(renamePatch(text));
  } else if (flag === '--check') {
    const left = leftovers(ROOT, rest.length ? rest : DIRS);
    for (const [f, n, t] of left) console.log(`${f}:${n}: ${t.slice(0, 160)}`);
    process.exit(left.length ? 1 : 0);
  } else {
    const changed = renameTree(ROOT, flag ? [flag, ...rest] : DIRS);
    console.log(`${changed.length} files renamed`);
  }
}
