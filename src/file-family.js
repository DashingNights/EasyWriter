'use strict';
// JSON storage of the main process: atomic writes through one queue, and file families (one `<uuid>.json` per record in
// one folder: drafts, plans, flowcharts; SPEC §3, §4).
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const ID_RE = /^[a-f0-9-]{36}$/;

// All writes go through one queue so read-modify-write and tmp+rename never interleave.
let writeQueue = Promise.resolve();
function serialized(fn) {
  const run = writeQueue.then(fn);
  writeQueue = run.catch(() => {});
  return run;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeFileAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

const writeJsonAtomic = (file, data) => writeFileAtomic(file, JSON.stringify(data));

// Pictures and videos out of the records (SPEC §3): a base64 data URL anywhere in a saved record is written once to
// `images/<sha256 of the bytes>.<type>` and the record keeps `data:<image|video>/<type>;sha256,<hex>` in its place. Loading puts the
// data URL back, so the renderer only ever sees data URLs. Records saved before this keep theirs until their next save.
const DATA_URL = /^data:(image|video)\/([a-z0-9.+-]+);base64,/i;
const IMAGE_REF = /^data:(image|video)\/([a-z0-9.+-]+);sha256,([a-f0-9]{64})$/;
const IMAGE_NAME = /^[a-f0-9]{64}\.[a-z0-9.+-]+$/;

/** [object, key] of every string value in `v` (nested objects and arrays) that passes `test`. */
function strings(v, test, out = []) {
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (typeof x === 'string') {
      if ((x.startsWith('data:image/') || x.startsWith('data:video/')) && test(x)) out.push([v, k]);
    } else if (x && typeof x === 'object') {
      strings(x, test, out);
    }
  }
  return out;
}

/** Moves the base64 pictures of record `v` (changed in place) into folder `dir` → `v`. */
async function externalize(dir, v) {
  for (const [o, k] of strings(v, (s) => DATA_URL.test(s.slice(0, 80)))) {
    const m = o[k].slice(0, 80).match(DATA_URL);
    if (!m) continue; // done already: the same object reached twice (IPC keeps shared references)
    const [head, kind, type] = m;
    const b64 = o[k].slice(head.length);
    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length || bytes.toString('base64') !== b64) continue; // not canonical base64: kept inline, so it loads back the same
    const hex = crypto.createHash('sha256').update(bytes).digest('hex');
    const file = path.join(dir, `${hex}.${type.toLowerCase()}`);
    if (!(await fs.stat(file).then((s) => s.size === bytes.length, () => false))) await writeFileAtomic(file, bytes);
    o[k] = `data:${kind.toLowerCase()}/${type.toLowerCase()};sha256,${hex}`;
  }
  return v;
}

/** Puts the pictures of folder `dir` back into record `v` (changed in place) as data URLs → `v`. A missing picture keeps its
 * reference: it shows as a broken image and saves back unchanged, so it comes back once the file does (a later sync). */
async function inline(dir, v) {
  const read = new Map();
  for (const [o, k] of strings(v, (s) => s.length < 200 && IMAGE_REF.test(s))) {
    const m = o[k].match(IMAGE_REF);
    if (!m) continue; // done already: the same object reached twice
    const [, kind, type, hex] = m;
    const name = `${hex}.${type}`;
    if (!read.has(o[k])) read.set(o[k], await fs.readFile(path.join(dir, name)).then((b) => `data:${kind}/${type};base64,${b.toString('base64')}`, () => null));
    o[k] = read.get(o[k]) ?? o[k];
  }
  return v;
}

/** Keeps an unparsable file as `<file>.corrupt-<ms>`, out of the way of reads and writes. */
const setAside = (file) => fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The records in folder `dir()` → {file, list, load, save, remove}. Options:
 * - `summary(record)`: what list() returns per record (default: the whole record);
 * - `keepPrevious`: save() keeps the replaced version as `<id>.json.bak`, and list() sets an unparsable file aside, so the
 *   next save cannot copy it over the good `.bak`;
 * - `maxBytes`: the most JSON characters a record may have;
 * - `validate(record)`: throws on a bad envelope (the message is the caller's error);
 * - `siblings(id)`: more files remove() moves to the trash with the record;
 * - `images()`: the pictures folder: save() moves the record's base64 pictures there, load() and list() put them back.
 */
function fileFamily(dir, { summary, keepPrevious = false, maxBytes, validate, siblings, images } = {}) {
  function file(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('invalid id');
    return path.join(dir(), `${id}.json`);
  }

  /** Every readable record (or its summary), newest `updated` first; unreadable files are omitted. */
  async function list() {
    let names;
    try {
      names = await fs.readdir(dir());
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const records = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !ID_RE.test(name.slice(0, -5))) continue;
      const f = path.join(dir(), name);
      try {
        const r = await readJson(f);
        if (r) records.push(images ? await inline(images(), summary ? summary(r) : r) : summary ? summary(r) : r);
      } catch (e) {
        if (keepPrevious && e instanceof SyntaxError) await setAside(f);
      }
    }
    return records.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }

  /** The record, or null when there is none. */
  const load = (id) => readJson(file(id)).then((r) => (r && images ? inline(images(), r) : r));

  /** Writes a copy of `record`: a new id (and `created`) when it has none, `updated` = now. */
  function save(record) {
    if (!isPlainObject(record)) throw new Error('record must be an object');
    validate?.(record);
    const now = Date.now();
    const saved = { ...record };
    if (saved.id == null) {
      saved.id = crypto.randomUUID();
      saved.created = now;
    }
    const f = file(saved.id);
    if (saved.created == null) saved.created = now;
    saved.updated = now;
    if (!images && maxBytes && JSON.stringify(saved).length > maxBytes) throw new Error(`record too large (over ${maxBytes} characters)`);
    return serialized(async () => {
      if (images) {
        await externalize(images(), saved); // changes the caller's nested objects: records come fresh from IPC
        if (maxBytes && JSON.stringify(saved).length > maxBytes) throw new Error(`record too large (over ${maxBytes} characters)`);
      }
      if (keepPrevious) {
        await fs.copyFile(f, `${f}.bak`).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
      }
      await writeJsonAtomic(f, saved);
      return { id: saved.id, created: saved.created, updated: saved.updated, ...(saved.rev != null && { rev: saved.rev }) };
    });
  }

  /** Moves the record, its `.bak` and its siblings into `<dir>/.trash/` (never hard-deletes). */
  function remove(id) {
    const f = file(id);
    const files = [f, `${f}.bak`, ...(siblings ? siblings(id) : [])];
    return serialized(async () => {
      const trash = path.join(dir(), '.trash');
      await fs.mkdir(trash, { recursive: true });
      for (const x of files) {
        try {
          await fs.rename(x, path.join(trash, path.basename(x)));
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      }
      return true;
    });
  }

  return { file, list, load, save, remove };
}

module.exports = { fileFamily, isPlainObject, readJson, serialized, setAside, writeFileAtomic, writeJsonAtomic, externalize, inline, IMAGE_NAME };
