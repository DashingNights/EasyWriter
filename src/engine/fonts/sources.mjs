// Where the engine's fonts come from (provider.mjs takes a list of these, first that has a family wins). Each source is
// {name, faces(family) → promise of [{name, bytes}]}, [] when it lacks the family.
//   installedSource: the desktop's installed fonts, read by the main process (window.api.fonts, electron/fonts-main.js).
//   openSource: the open fonts the app ships or downloads (catalogue.mjs), shared with the DOM editor:
//     a downloaded family (Noto Sans TC) sits in the same Cache Storage, so it downloads once for both.
//   userSource: fonts the user adds in the web app, kept in IndexedDB by family.
import { BUNDLED, CATALOGUE } from './catalogue.mjs';
import { familiesOf } from './sfnt.mjs';

const asBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

/** The installed fonts through `api` ({family(name) → [{name}], file(name, fileName) → bytes or null}, window.api.fonts on the
 * desktop). Each file comes in a reply of its own: the page's thread reads a reply in one piece, about 1.3 ms a MB, and a
 * family's files in one (Yu Gothic's 54 MB) held every draft's calls for 69 ms (engine-print-bench). */
export function installedSource(api = globalThis.window?.api?.fonts) {
  return {
    name: 'installed',
    faces: async (family) => {
      const out = [];
      for (const f of api ? await api.family(family) : []) {
        const bytes = await api.file(family, f.name);
        if (bytes) out.push({ name: f.name, bytes: asBytes(bytes) });
      }
      return out;
    },
  };
}

const CACHE = 'easywriter-fonts'; // provider.mjs's download cache
const byFamily = new Map(CATALOGUE.map((e) => [e.family.toLowerCase(), e]));
// A download that sends nothing for this long is dropped (engine-fixes-2-edit: a stalled one held fonts.ready(), and with it
// whenSettled and turning the canvas engine off, for as long as it stalled). The family is then missing: its text keeps the
// font it is drawn in now, as when no source has it, and the reader waiting on the fonts goes on. A slow download that keeps
// sending is not cut off.
const STALL_MS = 15000;

/** `url`'s bytes through `fetch`, dropped with an error once nothing arrives for `stall` ms. */
async function download(fetch, url, stall) {
  const ctl = new AbortController();
  // Whatever `fetch` does with the signal, the wait itself ends at the abort.
  const aborted = new Promise((_, reject) => ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason)));
  aborted.catch(() => {});
  let timer = 0;
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(new Error(`${url}: nothing arrived for ${stall / 1000} s`)), stall);
  };
  wait();
  let reader = null;
  try {
    const res = await Promise.race([fetch(url, { signal: ctl.signal }), aborted]);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    reader = res.body.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      parts.push(value);
      wait();
    }
    return await new Blob(parts).arrayBuffer();
  } catch (e) {
    reader?.cancel().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** The open fonts: bundled ones from the app's folder `base` (its root URL), download ones from Cache Storage or their source.
 * `fetch` and `caches` are the page's, `stall` the ms a download may send nothing (passed in by tests). */
export function openSource({ base, fetch = globalThis.fetch, caches = globalThis.caches, stall = STALL_MS } = {}) {
  const get = async (f) => {
    if (f.file) {
      const res = await fetch(new URL(BUNDLED + f.file, base).href);
      if (!res.ok) throw new Error(`${f.file}: ${res.status}`);
      return res.arrayBuffer();
    }
    const cache = caches && await caches.open(CACHE);
    const res = await cache?.match(f.url);
    if (res) return res.arrayBuffer();
    const bytes = await download(fetch, f.url, stall);
    await cache?.put(f.url, new Response(bytes, { headers: { 'content-type': 'font/ttf' } }));
    return bytes;
  };
  return {
    name: 'open',
    faces: async (family) => {
      const e = byFamily.get(family.toLowerCase());
      if (!e) return [];
      return Promise.all(e.faces.map(async (f) => ({ name: (f.file ?? f.url).split('/').pop(), bytes: new Uint8Array(await get(f)) })));
    },
  };
}

const DB = 'easywriter-engine-fonts';
/** IndexedDB request `r` → a promise of its result. */
const done = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** The fonts the user added (web app), in IndexedDB `idb` (the page's indexedDB). add(name, bytes) → the families it holds, or []
 * when it is not a font; remove(family); list() → [{name, families}]. */
export function userSource(idb = globalThis.indexedDB) {
  let db = null;
  const open = () => (db ??= (() => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('fonts', { autoIncrement: true });
    return done(r);
  })());
  const store = async (mode) => (await open()).transaction('fonts', mode).objectStore('fonts');
  const all = async () => {
    const s = await store('readonly');
    const [keys, values] = await Promise.all([done(s.getAllKeys()), done(s.getAll())]);
    return values.map((v, i) => ({ key: keys[i], ...v }));
  };
  return {
    name: 'user',
    async add(name, bytes) {
      const b = asBytes(bytes);
      const families = await familiesOf(b);
      if (families.length) await done((await store('readwrite')).add({ name: String(name), families, bytes: b }));
      return families;
    },
    async remove(family) {
      const f = family.toLowerCase();
      const keys = (await all()).filter((v) => v.families.some((x) => x.toLowerCase() === f)).map((v) => v.key);
      // Every delete is issued before the first await, while the transaction is still active.
      const s = await store('readwrite');
      await Promise.all(keys.map((k) => done(s.delete(k))));
    },
    list: async () => (await all()).map(({ name, families }) => ({ name, families })),
    faces: async (family) => {
      const f = family.toLowerCase();
      return (await all()).filter((v) => v.families.some((x) => x.toLowerCase() === f)).map((v) => ({ name: v.name, bytes: v.bytes }));
    },
  };
}
