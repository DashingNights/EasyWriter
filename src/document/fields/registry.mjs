// The field registry and field context (docs/plans/word/plan.md §1.10). A field is an inline atom (or a fieldBlock) holding its
// code; each field type registers how it computes its result from a FieldCtx. The code parser follows Word's rules in
// docs/plans/word/index-fields.md Field code syntax: case-insensitive names, straight double quotes with \" and \\ inside,
// backslash switches, nested fields in braces, and the implicit REF (a first word that is no field name is a bookmark).
// Pure: ProseMirror nodes in, plain data out; nothing here imports the app or docs/plans.
import { listLabels } from '../numbering.mjs';
import { FIELD_NAMES } from './names.mjs';

export { FIELD_NAMES };
const KNOWN = new Set(FIELD_NAMES);

// ---------- the registry ----------
const types = new Map();
const providers = new Map();

/** Registers field type `type` (plan §1.10 FieldType; also `bare`: the switch letters that take no argument, and `caseSwitches`: the
 * letters whose case Word reads) under `name`. → a function that unregisters it. */
export function registerField(name, type) {
  const key = String(name).toUpperCase();
  types.set(key, type);
  return () => types.get(key) === type && types.delete(key);
}

/** The type registered for field name `name`, or null. */
export const fieldType = (name) => types.get(String(name).toUpperCase()) ?? null;

/** The registered type names (the benchmark counts fields.<NAME>, '=' as fields.formula). */
export const fieldNames = () => [...types.keys()];

/** Registers provider `key`: `fn(ctx, ...args)` gives a value fields read through ctx.get(key, ...args). → unregister. */
export function registerFieldProvider(key, fn) {
  providers.set(key, fn);
  return () => providers.get(key) === fn && providers.delete(key);
}

// ---------- the parser ----------
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ';

// The nested field whose `{` is at `at` in `code`: its code and the index after its `}` (the end of the code when unbalanced).
function nestedAt(code, at) {
  let depth = 0;
  let quoted = false;
  for (let k = at; k < code.length; k++) {
    const c = code[k];
    if (quoted && c === '\\') k++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === '{') depth++;
    else if (!quoted && c === '}' && --depth === 0) return { code: code.slice(at + 1, k).trim(), end: k + 1 };
  }
  return { code: code.slice(at + 1).trim(), end: code.length };
}

// Tokens of `code`: words ({text, quoted}: bare characters, quoted parts and nested fields up to a space or a backslash) and
// switches ({sw}: the character after a backslash outside quotes).
function lex(code, nest) {
  const toks = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    if (isSpace(code[i])) {
      i++;
      continue;
    }
    if (code[i] === '\\') {
      toks.push({ sw: code[i + 1] ?? '' });
      i += 2;
      continue;
    }
    let text = '';
    let quoted = false;
    while (i < n && !isSpace(code[i]) && code[i] !== '\\') {
      const c = code[i];
      if (c === '"') {
        quoted = true;
        i++;
        while (i < n && code[i] !== '"') {
          if (code[i] === '\\' && (code[i + 1] === '"' || code[i + 1] === '\\')) {
            text += code[i + 1];
            i += 2;
          } else if (code[i] === '{') {
            const f = nestedAt(code, i);
            text += nest(f.code);
            i = f.end;
          } else text += code[i++];
        }
        i++; // the closing quote
      } else if (c === '{') {
        const f = nestedAt(code, i);
        text += nest(f.code);
        i = f.end;
      } else text += code[i++];
    }
    toks.push({ text, quoted });
  }
  return toks;
}

// Where the first general switch (\# \* \@ \!) starts in formula text `s`, outside quotes and nested fields.
function generalAt(s) {
  let depth = 0;
  let quoted = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (quoted && c === '\\') k++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === '{') depth++;
    else if (!quoted && c === '}') depth--;
    else if (!quoted && !depth && c === '\\' && '#*@!'.includes(s[k + 1])) return k;
  }
  return s.length;
}

// Formula text `s` with its nested fields replaced through `nest`.
function expand(s, nest) {
  let out = '';
  for (let k = 0; k < s.length;) {
    if (s[k] === '{') {
      const f = nestedAt(s, k);
      out += nest(f.code);
      k = f.end;
    } else out += s[k++];
  }
  return out;
}

/** Field code `code` read as Word reads it → {name, args, sw, format, numeric, date, lock, code} (plan §1.10 ParsedField). `nest`
 * (optional): (innerCode) → its result, for nested fields; without it a nested field stays as written, `{ CODE }`. A switch takes the
 * next word as its argument unless the type lists the letter in `bare` or another switch follows. */
export function parseField(code, nest = null) {
  const src = String(code ?? '');
  const inner = nest ?? ((c) => `{ ${c} }`);
  const out = { name: '', args: [], sw: {}, format: [], numeric: null, date: null, lock: false, code: src };
  let rest = src.trimStart();
  let toks;
  if (rest.startsWith('=')) {
    out.name = '=';
    const body = rest.slice(1);
    const k = generalAt(body);
    const expr = expand(body.slice(0, k), inner).trim();
    if (expr) out.args.push(expr);
    toks = lex(body.slice(k), inner);
  } else {
    toks = lex(rest, inner);
    const first = toks[0];
    if (first && !('sw' in first)) {
      toks.shift();
      const name = first.text.toUpperCase();
      if (KNOWN.has(name) || types.has(name)) out.name = name;
      else {
        out.name = 'REF'; // Word's implicit REF: { num } is { REF num }
        out.args.push(first.text);
      }
    }
  }
  const type = types.get(out.name);
  const bare = new Set(type?.bare ?? '');
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (!('sw' in t)) {
      out.args.push(t.text);
      continue;
    }
    const next = toks[k + 1];
    const arg = next && !('sw' in next) ? next.text : null;
    const key = type?.caseSwitches?.includes(t.sw) ? t.sw : t.sw.toLowerCase();
    if (t.sw === '!' || !t.sw) {
      out.lock ||= t.sw === '!';
      continue;
    }
    const takes = arg !== null && (t.sw === '*' || t.sw === '#' || t.sw === '@' || !bare.has(key));
    if (takes) k++; // the word is this switch's argument
    if (t.sw === '*') {
      if (takes) out.format.push(arg);
    } else if (t.sw === '#') out.numeric = takes ? arg : '';
    else if (t.sw === '@') out.date = takes ? arg : '';
    else out.sw[key] = takes ? arg : true;
  }
  return out;
}

// ---------- providers the scaffold registers ----------
const memo = (fn) => {
  const cache = new WeakMap();
  return (doc) => {
    let v = cache.get(doc);
    if (v === undefined) cache.set(doc, (v = fn(doc)));
    return v;
  };
};

// Bookmark ranges by lower-case name: from after the start marker to the end marker (Word's names are case-insensitive).
const bookmarksIn = memo((doc) => {
  const out = new Map();
  const open = new Map();
  doc.descendants((n, pos) => {
    if (n.type.name !== 'bookmark') return true;
    const key = n.attrs.id || n.attrs.name;
    if (!n.attrs.end) open.set(key, { name: String(n.attrs.name).toLowerCase(), from: pos + n.nodeSize });
    else {
      const s = open.get(key);
      open.delete(key);
      if (s && !out.has(s.name)) out.set(s.name, { from: s.from, to: pos });
    }
    return false;
  });
  for (const s of open.values()) if (!out.has(s.name)) out.set(s.name, { from: s.from, to: s.from }); // no end marker
  return out;
});

// The numbered paragraphs of a doc with their labels and the label of each level above them (REF \w's full context).
const listsIn = memo((doc) => {
  const paras = [];
  doc.descendants((n, pos) => {
    if (!n.isTextblock) return true;
    if (n.attrs.numbering) paras.push({ from: pos, to: pos + n.nodeSize, num: n.attrs.numbering });
    return false;
  });
  const labels = listLabels(paras.map((p) => p.num), doc.attrs.numbering);
  const last = new Map();
  return paras.map((p, i) => {
    const l = last.get(p.num.numId) ?? [];
    l[p.num.ilvl] = labels[i];
    l.length = p.num.ilvl + 1;
    last.set(p.num.numId, l);
    return { ...p, text: labels[i], levels: [...l] };
  });
});

// Document properties by Word's names (DOCPROPERTY, INFO and the property fields): doc.attrs.props, then the draft record. Title
// reads only the Title property, as in Word, never the draft's name.
const PROPS = {
  title: (p) => p.core?.title ?? null, subject: (p) => p.core?.subject, author: (p) => p.core?.creator,
  keywords: (p) => p.core?.keywords, comments: (p) => p.core?.description, category: (p) => p.core?.category,
  contentstatus: (p) => p.core?.contentStatus, company: (p) => p.app?.company, manager: (p) => p.app?.manager,
  hyperlinkbase: (p) => p.app?.hyperlinkBase, template: (p) => p.app?.template, nameofapplication: () => 'EasyWriter',
  lastsavedby: (p, d) => d.savedBy, revisionnumber: (p, d) => d.revision, createtime: (p, d) => d.created,
  lastsavedtime: (p, d) => d.saved, lastprinted: (p, d) => d.printed, totaleditingtime: (p, d) => d.editMinutes,
};

registerFieldProvider('bookmark', (ctx, name) => bookmarksIn(ctx.doc).get(String(name).toLowerCase()) ?? null);
registerFieldProvider('listLabel', (ctx, pos) => {
  const p = listsIn(ctx.doc).find((x) => x.from <= pos && pos < x.to);
  return p?.text == null ? null : { text: p.text, levels: p.levels };
});
registerFieldProvider('prop', (ctx, name) => {
  const key = String(name).toLowerCase();
  const props = ctx.doc.attrs.props ?? {};
  if (PROPS[key]) return PROPS[key](props, ctx.draft) ?? null;
  return (props.custom ?? []).find((c) => String(c.name).toLowerCase() === key)?.value ?? null;
});
registerFieldProvider('variable', (ctx, name) => {
  const vars = ctx.doc.attrs.vars ?? {};
  if (Object.hasOwn(vars, name)) return vars[name];
  const key = Object.keys(vars).find((k) => k.toLowerCase() === String(name).toLowerCase());
  return key === undefined ? null : vars[key];
});

// ---------- the context ----------
const NO_DRAFT = Object.freeze({ title: '', created: 0, saved: 0, savedBy: '', printed: null, editMinutes: 0, revision: 0 });
const NO_USER = Object.freeze({ name: '', initials: '', address: '' });

/** A fresh per-update state for fieldCtx's `shared`: SEQ counters, assigned bookmark texts, the queued property writes (null outside a
 * manual update, so setProp is ignored) and the provider cache. */
export const updateState = ({ props = null } = {}) => ({ seq: new Map(), assigned: new Map(), props, cache: new Map() });

/** The FieldCtx of the field at `pos` (plan §1.10). `pageAt` defaults to the geometry's page holding the position; `shared` (from
 * updateState) carries the counters, assignments, queued props and provider cache across one update. */
export function fieldCtx({ doc, pos = 0, story = 'body', page = null, geometry = null, now = new Date(), draft = null, user = null,
  pageAt = null, mode = null, answer = null, shared = null }) {
  const s = shared ?? updateState();
  const ctx = {
    doc, pos, story, page, geometry, now, mode, answer,
    draft: { ...NO_DRAFT, ...draft },
    user: { ...NO_USER, ...user },
    seq: s.seq,
    assigned: s.assigned,
    pageAt: pageAt ?? ((p) => geometry?.pages?.find((g) => g.from <= p && p < g.to) ?? null),
    setProp: (path, value) => void s.props?.push({ path, value }),
    get: (key, ...args) => {
      const fn = providers.get(key);
      if (!fn) return null;
      const k = args.length ? `${key}\u0000${JSON.stringify(args)}` : key;
      if (!s.cache.has(k)) s.cache.set(k, fn(ctx, ...args));
      return s.cache.get(k);
    },
    bookmark: (name) => ctx.get('bookmark', name),
    listLabel: (p) => ctx.get('listLabel', p),
  };
  return ctx;
}
