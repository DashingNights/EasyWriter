// The engine's stored form read from the model's Rust types (docs/plans/engine/model.md, 'Schema versions'): every type the
// Document reaches through its serialised fields, with each field's type and the serde attributes that change what is written
// or read. test/engine-schema.test.mjs holds this list equal to the current version's test/fixtures/engine-models/<v>.fields.txt,
// so a field added to the form fails there even when no sample holds it, until SCHEMA_VERSION moves with it.
//   node scripts/schema-fields.mjs [repo root]           prints the list
//   node scripts/schema-fields.mjs --check [repo root]   the test's checks, for another checkout
// The types are read from the source text (no Rust parser in Node), which is enough for the shapes the model uses: structs,
// enums, type aliases and Serialize or Deserialize impls written by hand (a tag-first reader beside a type's own derive reads
// that same form, so it is not listed: Block, InlineObject, MNode, ControlKind).
// ponytail: a `with` or `serialize_with` module's code is not read, only its name; a change inside byte_store.rs's functions
// needs its bump by hand.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE, git } from './agent-guards.mjs';

/** The crates whose types the stored form holds, relative to the repo root. */
export const CRATES = ['engine/crates/doc/src', 'engine/crates/geom/src'];
const ROOT_TYPE = 'Document';

/** Rust source → tokens {t: 'id' | 'str' | 'num' | 'p', v}, comments dropped, lifetimes as ids starting with '. */
export function tokens(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (src.startsWith('//', i)) i = src.indexOf('\n', i) < 0 ? n : src.indexOf('\n', i);
    else if (src.startsWith('/*', i)) {
      let depth = 0;
      do {
        if (src.startsWith('/*', i)) (depth++, (i += 2));
        else if (src.startsWith('*/', i)) (depth--, (i += 2));
        else i++;
      } while (depth > 0 && i < n);
    } else if (/^r#[A-Za-z_]/.test(src.slice(i, i + 3))) {
      // A raw identifier: r#box is the field `box`.
      const m = src.slice(i + 2).match(/^\w+/);
      out.push({ t: 'id', v: m[0] });
      i += 2 + m[0].length;
    } else if (/^(?:br|r)#*"/.test(src.slice(i, i + 40))) {
      // A raw string: r"..." or r#"..."# (b for bytes), ended by the quote and as many #.
      const m = src.slice(i).match(/^(?:br|r)(#*)"/);
      const end = src.indexOf(`"${m[1]}`, i + m[0].length);
      out.push({ t: 'str', v: src.slice(i + m[0].length, end) });
      i = end + 1 + m[1].length;
    } else if (c === '"' || (c === 'b' && src[i + 1] === '"')) {
      let j = i + (c === 'b' ? 2 : 1);
      let v = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') v += src[j++];
        v += src[j++];
      }
      out.push({ t: 'str', v });
      i = j + 1;
    } else if (c === "'") {
      // A char literal ('x', '\n', '\u{..}') or a lifetime ('a, 'de, 'static).
      const m = src.slice(i).match(/^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'])'/u);
      if (m) (out.push({ t: 'str', v: m[0] }), (i += m[0].length));
      else {
        const l = src.slice(i).match(/^'\w+/);
        out.push({ t: 'id', v: l[0] });
        i += l[0].length;
      }
    } else if (/[A-Za-z_]/.test(c)) {
      const m = src.slice(i).match(/^\w+/);
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else if (/\d/.test(c)) {
      const m = src.slice(i).match(/^[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\w*/);
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
    } else if (src.startsWith('->', i) || src.startsWith('=>', i) || src.startsWith('::', i)) {
      out.push({ t: 'p', v: src.slice(i, i + 2) });
      i += 2;
    } else out.push({ t: 'p', v: c }), i++;
  }
  return out;
}

/** The index just past the group that opens at `i` ((, [, { or <), counting nested groups. */
function close(tk, i) {
  const angle = tk[i].v === '<';
  let depth = 0;
  for (let j = i; j < tk.length; j++) {
    const v = tk[j].t === 'p' ? tk[j].v : null;
    if (v === '(' || v === '[' || v === '{' || (angle && v === '<')) depth++;
    else if (v === ')' || v === ']' || v === '}' || (angle && v === '>')) depth--;
    if (depth === 0) return j + 1;
  }
  return tk.length;
}

/** Tokens `tk[from..to)` split at commas outside any group. */
function split(tk, from, to) {
  const parts = [];
  let start = from;
  for (let j = from; j < to;) {
    const v = tk[j].t === 'p' ? tk[j].v : null;
    if (v === '(' || v === '[' || v === '{' || v === '<') j = close(tk, j);
    else if (v === ',') (parts.push(tk.slice(start, j)), (start = ++j));
    else j++;
  }
  if (start < to) parts.push(tk.slice(start, to));
  return parts.filter((p) => p.length);
}

/** The attributes at the front of `tk` → {attrs: [token lists inside #[...]], rest}. */
function attrs(tk) {
  const list = [];
  let j = 0;
  while (tk[j]?.v === '#' && tk[j + 1]?.v === '[') {
    const end = close(tk, j + 1);
    list.push(tk.slice(j + 2, end - 1));
    j = end;
  }
  return { attrs: list, rest: tk.slice(j) };
}

const text = (tk) => tk.map((x) => (x.t === 'str' ? JSON.stringify(x.v) : x.v)).join(' ');

// The serde keys that change what is written or read. `default`, `skip_serializing_if`, `alias` and `bound` only let a build
// read an older form or leave out an empty value, so a change to them needs no new version (model.md's rule).
const KEYS = new Set(['rename', 'rename_all', 'rename_all_fields', 'tag', 'content', 'untagged', 'transparent', 'flatten', 'with',
  'serialize_with', 'deserialize_with', 'from', 'into', 'try_from', 'remote', 'other', 'skip_deserializing', 'deny_unknown_fields']);

/** The serde settings in attribute lists → {skip: the item is never written, note: 'key=value ...' of KEYS}. */
function serde(list) {
  const kv = [];
  for (const a of list) {
    if (a[0]?.v !== 'serde' || a[1]?.v !== '(') continue;
    for (const part of split(a, 2, close(a, 1) - 1)) {
      const key = part[0].v;
      const value = part.find((x) => x.t === 'str')?.v;
      kv.push([key, value]);
    }
  }
  return {
    skip: kv.some(([k]) => k === 'skip' || k === 'skip_serializing'),
    note: kv.filter(([k]) => KEYS.has(k)).map(([k, v]) => (v == null ? k : `${k}=${v}`)).sort().join(' '),
  };
}

/** A field's or alias's type as text: no paths, no Arc, Box or Rc around it (serde writes what they hold). */
function typeText(tk) {
  const out = [];
  for (let j = 0; j < tk.length; j++) {
    if (tk[j].t === 'id' && tk[j + 1]?.v === '::') {
      j++;
      continue;
    }
    if (tk[j].t === 'id' && /^(Arc|Box|Rc)$/.test(tk[j].v) && tk[j + 1]?.v === '<') {
      const end = close(tk, j + 1);
      out.push(...typeText(tk.slice(j + 2, end - 1)));
      j = end - 1;
      continue;
    }
    out.push(tk[j].v);
  }
  return out.join('').replace(/,/g, ', ').replace(/;/g, '; ');
}

/** Upper-case identifiers in `tk`: the type names they may refer to. */
const names = (tk) => tk.filter((x) => x.t === 'id' && /^[A-Z]/.test(x.v)).map((x) => x.v);

/** The fields in the braces at `tk[i]` → [{name, type, note, refs}], the skipped ones left out. */
function fields(tk, i) {
  return split(tk, i + 1, close(tk, i) - 1).map((part) => {
    const { attrs: a, rest } = attrs(part);
    let j = 0;
    if (rest[j]?.v === 'pub') j += rest[j + 1]?.v === '(' ? close(rest, j + 1) - j : 1;
    const s = serde(a);
    const ty = rest.slice(j + 2);
    return s.skip ? null : { name: rest[j].v, type: typeText(ty), note: s.note, refs: names(ty) };
  }).filter(Boolean);
}

/** The items of one file: {name: [{kind, file, note, lines, refs}]} for structs, enums and aliases that derive Serialize or
 * Deserialize (or are aliases), and hand-written serde impls by type name. Test modules are left out. */
function items(tk, file, into, impls) {
  for (let i = 0; i < tk.length;) {
    if (tk[i].v === ';') {
      i++;
      continue;
    }
    if (tk[i].v === '#' && tk[i + 1]?.v === '!') {
      i = close(tk, i + 2); // an inner attribute: #![...]
      continue;
    }
    const start = i;
    const list = [];
    while (tk[i]?.v === '#' && tk[i + 1]?.v === '[') {
      const end = close(tk, i + 1);
      list.push(tk.slice(i + 2, end - 1));
      i = end;
    }
    const test = list.some((a) => text(a).replace(/\s/g, '') === 'cfg(test)');
    if (tk[i]?.v === 'pub') i += tk[i + 1]?.v === '(' ? close(tk, i + 1) - i : 1;
    const kw = tk[i]?.v;
    const derives = list.some((a) => a[0]?.v === 'derive' && a.some((x) => x.v === 'Serialize' || x.v === 'Deserialize'));
    // The item's end: its brace group, or the next ; at depth 0.
    let end = i + 1;
    while (end < tk.length && tk[end].v !== ';' && tk[end].v !== '{') end = tk[end].t === 'p' && (tk[end].v === '(' || tk[end].v === '[') ? close(tk, end) : end + 1;
    const body = tk[end]?.v === '{' ? end : -1;
    const next = body >= 0 ? close(tk, body) : end + 1;
    if (test || i >= tk.length) {
      i = Math.max(next, start + 1);
      continue;
    }
    const name = tk[i + 1]?.v;
    const s = serde(list);
    const add = (item) => (into[name] ??= []).push({ file, note: s.note, ...item });
    if (kw === 'mod' && body >= 0) items(tk.slice(body + 1, next - 1), file, into, impls);
    else if (kw === 'type' && tk[i + 2]?.v !== undefined) {
      const eq = tk.findIndex((x, j) => j > i && x.v === '=');
      const ty = tk.slice(eq + 1, end);
      add({ kind: 'type', lines: [`${name} = ${typeText(ty)}`], refs: names(ty) });
    } else if ((kw === 'struct' || kw === 'enum') && derives) {
      const lines = [`${name}${s.note ? ` ${s.note}` : ''}`];
      const refs = [];
      if (kw === 'struct' && body >= 0) {
        for (const f of fields(tk, body)) (lines.push(`${name}.${f.name} ${f.type}${f.note ? ` ${f.note}` : ''}`), refs.push(...f.refs));
      } else if (kw === 'struct') {
        const paren = tk.findIndex((x, j) => j > i && x.v === '(');
        if (paren >= 0 && paren < end) {
          split(tk, paren + 1, close(tk, paren) - 1).forEach((part, k) => {
            const { rest } = attrs(part);
            const ty = rest[0]?.v === 'pub' ? rest.slice(1) : rest;
            lines.push(`${name}.${k} ${typeText(ty)}`);
            refs.push(...names(ty));
          });
        }
      } else if (body >= 0) {
        for (const part of split(tk, body + 1, close(tk, body) - 1)) {
          const { attrs: a, rest } = attrs(part);
          const v = serde(a);
          if (v.skip) continue;
          const at = `${name}::${rest[0].v}`;
          const note = v.note ? ` ${v.note}` : '';
          if (rest[1]?.v === '(') {
            const ty = rest.slice(2, close(rest, 1) - 1);
            lines.push(`${at}(${typeText(ty)})${note}`);
            refs.push(...names(ty));
            continue;
          }
          lines.push(`${at}${note}`);
          if (rest[1]?.v === '{') for (const f of fields(rest, 1)) (lines.push(`${at}.${f.name} ${f.type}${f.note ? ` ${f.note}` : ''}`), refs.push(...f.refs));
        }
      }
      add({ kind: kw, lines, refs });
    } else if (kw === 'impl' && body >= 0) {
      // impl Serialize for X / impl<'de> Deserialize<'de> for X: the form is this code's, so it counts by its text.
      const head = tk.slice(i, body);
      const trait = head.find((x) => x.v === 'Serialize' || x.v === 'Deserialize')?.v;
      const fo = head.findIndex((x) => x.v === 'for');
      if (trait && fo >= 0) {
        const target = names(head.slice(fo + 1))[0];
        (impls[target] ??= []).push({ trait, file, code: tk.slice(body, next) });
      }
    }
    i = Math.max(next, start + 1);
  }
}

const rustFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && e.name.endsWith('.rs'))
  .map((e) => path.join(e.parentPath ?? e.path, e.name))
  .sort();

/** The stored form's lines for the checkout at `root`, sorted: one per type (with its serde settings), per field and per
 * variant, an alias as `Name = type`, and a hand-written impl as `Name: own Serialize (file) <hash>`. A name two crates or
 * modules define twice lists both, each line after the file that holds it. */
export function storedForm(root) {
  const all = {};
  const impls = {};
  for (const crate of CRATES) {
    const dir = path.join(root, crate);
    if (!fs.existsSync(dir)) continue;
    for (const f of rustFiles(dir)) {
      const rel = path.relative(path.join(root, 'engine', 'crates'), f).replaceAll('\\', '/');
      if (/(^|\/)tests?(\.rs|\/)/.test(rel)) continue; // test modules in their own files
      items(tokens(fs.readFileSync(f, 'utf8')), rel, all, impls);
    }
  }
  const seen = new Set();
  const lines = [];
  // From a hand-written impl's code only serde types count: the code also names Result, Ok, the serializer and so on.
  const serdeType = (name) => !!impls[name] || (all[name] ?? []).some((d) => d.kind !== 'type');
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const defs = all[name] ?? [];
    const twice = defs.length > 1;
    for (const d of defs) {
      lines.push(...d.lines.map((l) => (twice ? `${d.file}: ${l}` : l)));
      d.refs.forEach(visit);
    }
    // A tag-first reader (`reread`, tagged.rs) reads the fields and variants the type itself declares, only taking the tag
    // first (Block, InlineObject, MNode, ControlKind: engine-size-3), so it is no second form and is left out. Any other
    // hand-written impl counts: its code says what it reads or writes.
    const tagFirst = (m) => m.trait === 'Deserialize' && text(m.code).includes('tagged :: read');
    for (const m of (impls[name] ?? []).filter((x) => !tagFirst(x))) {
      const hash = crypto.createHash('sha256').update(text(m.code)).digest('hex').slice(0, 12);
      lines.push(`${name}: own ${m.trait} (${m.file}) ${hash}`);
      names(m.code).filter(serdeType).forEach(visit);
    }
  };
  visit(ROOT_TYPE);
  return [...new Set(lines)].sort();
}

const FIXTURES = 'test/fixtures/engine-models';
const FORM_JS = 'src/engine/model/form.mjs';
const SCHEMA_RS = 'engine/crates/doc/src/schema.rs';
const MODEL_MD = 'docs/plans/engine/model.md';
/** The first line of a field list written from the types (the older lists hold JSON paths read from the samples). */
export const header = (v) => `# easywriter.document ${v}: the stored form's types (scripts/schema-fields.mjs, test/engine-schema.test.mjs)`;
const versionIn = (text) => (text == null ? null : Number(text.match(/^export const VERSION = (\d+);/m)?.[1]));
/** A field list's lines without its header → [line], or null for none or for a list in the older form. */
const listOf = (text) => (text?.startsWith('# easywriter.document') ? text.split(/\r?\n/).filter((l) => l && !l.startsWith('#')) : null);
const changes = (now, was) => [...now.filter((l) => !was.includes(l)).map((l) => `+ ${l}`), ...was.filter((l) => !now.includes(l)).map((l) => `- ${l}`)];
const readAt = (root, rel) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), 'utf8') : null);

/** The version the checkout at `root` stamps (form.mjs VERSION) and what is out of step with its types → {version, now,
 * problems: [text]}. `base` → {version, list}: the integration branch's version and field list where this branch started
 * (git; null when there is none), so a change to the types since then needs a higher version. */
export function schemaProblems(root, base = null) {
  const version = versionIn(readAt(root, FORM_JS));
  const now = storedForm(root);
  const problems = [];
  const rs = readAt(root, SCHEMA_RS) ?? '';
  const schemaVersion = Number(rs.match(/pub const SCHEMA_VERSION: u32 = (\d+);/)?.[1]);
  const bump = (v) => `raise SCHEMA_VERSION (${SCHEMA_RS}) and VERSION (${FORM_JS}) to ${v}, add the line "// ${v - 1} to ${v} ..." `
    + `in Document::upgrade and the row for ${v} in ${MODEL_MD}'s table, add the new fields to a sample with an older version's `
    + `file beside it, then write ${v}.fields.txt and the samples: EW_SCHEMA_WRITE=1 node --test test/engine-schema.test.mjs`;
  if (schemaVersion !== version) problems.push(`SCHEMA_VERSION is ${schemaVersion} in ${SCHEMA_RS} and VERSION is ${version} in ${FORM_JS}: they move together`);
  if (version > 0 && !new RegExp(`//.*\\b${version - 1} to ${version}\\b`).test(rs)) problems.push(`${SCHEMA_RS} has no "// ${version - 1} to ${version}" line in Document::upgrade`);
  if (!new RegExp(`^\\| ${version} \\|`, 'm').test(readAt(root, MODEL_MD) ?? '')) problems.push(`${MODEL_MD}'s table has no row for version ${version}`);
  if (base?.list && version <= base.version) {
    const diff = changes(now, base.list);
    if (diff.length) problems.push(`the stored form's types changed since this branch left the integration branch, at version ${base.version}: ${bump(base.version + 1)}.\n${diff.join('\n')}`);
  }
  const list = listOf(readAt(root, `${FIXTURES}/${version}.fields.txt`));
  if (!list) problems.push(`${FIXTURES}/${version}.fields.txt is missing or not a list of the types: write it (EW_SCHEMA_WRITE=1 node --test test/engine-schema.test.mjs)`);
  else {
    const diff = changes(now, list);
    if (diff.length && !problems.some((p) => p.startsWith('the stored form'))) problems.push(`the stored form's types differ from ${version}.fields.txt, so the form changed without a new schema version: ${bump(version + 1)}.\n${diff.join('\n')}`);
  }
  return { version, now, problems };
}

/** The integration branch's version and field list at this checkout's merge base with it → {version, list}, or null. */
export function baseForm(root) {
  const at = git(root, ['merge-base', 'HEAD', BASE]);
  const version = at && versionIn(git(root, ['show', `${at}:${FORM_JS}`]));
  const list = version && listOf(git(root, ['show', `${at}:${FIXTURES}/${version}.fields.txt`]));
  return list ? { version, list, at } : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const check = process.argv[2] === '--check';
  const root = path.resolve(process.argv[check ? 3 : 2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (!check) process.stdout.write(`${storedForm(root).join('\n')}\n`);
  else {
    const { problems } = schemaProblems(root, baseForm(root));
    console.log(problems.join('\n') || 'ok');
    process.exit(problems.length ? 1 : 0);
  }
}
