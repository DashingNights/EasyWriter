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

async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(data));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
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
 * - `siblings(id)`: more files remove() moves to the trash with the record.
 */
function fileFamily(dir, { summary, keepPrevious = false, maxBytes, validate, siblings } = {}) {
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
        if (r) records.push(summary ? summary(r) : r);
      } catch (e) {
        if (keepPrevious && e instanceof SyntaxError) await setAside(f);
      }
    }
    return records.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }

  /** The record, or null when there is none. */
  const load = (id) => readJson(file(id));

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
    if (maxBytes && JSON.stringify(saved).length > maxBytes) throw new Error(`record too large (over ${maxBytes} characters)`);
    return serialized(async () => {
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

module.exports = { fileFamily, isPlainObject, readJson, serialized, setAside, writeJsonAtomic };
