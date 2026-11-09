'use strict';
// The installed fonts for the canvas engine (docs/plans/engine/plan.md section 1, Fonts): the renderer's font provider
// (src/engine/fonts) asks for a family by name and gets its files, then each file's bytes, which it hands to the engine's worker. The index is
// built once a session, on the first ask, from the system's fonts, the user's per-user fonts (where Aptos lands when installed
// from Microsoft's page) and Office's cloud fonts (%LOCALAPPDATA%\Microsoft\FontCache\4\CloudFonts: a folder per family, numeric
// file names and several revisions of a face, so each face is picked by its name table and the newest revision wins). Only the
// name and head tables of each file are read to index it (src/engine/fonts/sfnt.mjs).
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i;
const MAX_FILE = 64 * 1024 * 1024; // larger files are not fonts a document needs (and would stall the IPC)

/** The font folders of this system, in the order a face wins a tie: [{dir, source, deep}]. `deep`: read subfolders too. */
function fontDirs(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      { dir: path.join(env.WINDIR || env.SystemRoot || 'C:\\Windows', 'Fonts'), source: 'system', deep: false },
      { dir: path.join(local, 'Microsoft', 'Windows', 'Fonts'), source: 'user', deep: false },
      { dir: path.join(local, 'Microsoft', 'FontCache', '4', 'CloudFonts'), source: 'cloud', deep: true },
    ];
  }
  if (platform === 'darwin') {
    return [
      { dir: '/System/Library/Fonts', source: 'system', deep: true },
      { dir: '/Library/Fonts', source: 'system', deep: true },
      { dir: path.join(home, 'Library', 'Fonts'), source: 'user', deep: true },
    ];
  }
  return [
    { dir: '/usr/share/fonts', source: 'system', deep: true },
    { dir: '/usr/local/share/fonts', source: 'system', deep: true },
    { dir: path.join(home, '.local', 'share', 'fonts'), source: 'user', deep: true },
    { dir: path.join(home, '.fonts'), source: 'user', deep: true },
  ];
}

/** The font files under `dir` (its subfolders too when `deep`); none when it does not exist. */
async function fontFiles(dir, deep) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && deep) out.push(...await fontFiles(p, true));
    else if (e.isFile() && FONT_FILE.test(e.name)) out.push(p);
  }
  return out;
}

let sfnt = null;
const sfntModule = () => (sfnt ??= import('../src/engine/fonts/sfnt.mjs'));

/** The faces of font file `file` → [{file, index, family, style, names, revision, mtime, size, source}], [] when unreadable. */
async function facesOf(file, source) {
  const { readFaces } = await sfntModule();
  let h;
  try {
    h = await fs.open(file, 'r');
    const { size, mtimeMs } = await h.stat();
    if (size > MAX_FILE) return [];
    const read = async (at, n) => {
      const b = Buffer.alloc(Math.max(0, Math.min(n, size - at)));
      if (b.length) await h.read(b, 0, b.length, at);
      return b;
    };
    return (await readFaces(read)).map((f) => ({ ...f, file, mtime: mtimeMs, size, source }));
  } catch {
    return [];
  } finally {
    await h?.close();
  }
}

/** Of faces that share a family and style, the one that draws: the highest revision, then the newest file, then the earlier
 * folder (system before user before cloud). → the chosen faces, in their input order. */
function choose(faces) {
  const win = new Map();
  for (const f of faces) {
    const key = `${f.family.toLowerCase()}|${f.style.toLowerCase()}`;
    const w = win.get(key);
    if (!w || f.revision > w.revision || (f.revision === w.revision && f.mtime > w.mtime)) win.set(key, f);
  }
  const chosen = new Set(win.values());
  return faces.filter((f) => chosen.has(f));
}

/** The index of the fonts in `dirs` (fontDirs()): {byName: Map(lower-case name → faces), faces, ms}. Files are read in small
 * batches, so a folder of 700 fonts indexes in a fraction of a second without opening them all at once. */
async function buildIndex(dirs = fontDirs()) {
  const t0 = Date.now();
  const files = [];
  for (const d of dirs) for (const file of await fontFiles(d.dir, d.deep)) files.push({ file, source: d.source });
  const all = [];
  for (let i = 0; i < files.length; i += 32) {
    for (const faces of await Promise.all(files.slice(i, i + 32).map((f) => facesOf(f.file, f.source)))) all.push(...faces);
  }
  const faces = choose(all);
  const byName = new Map();
  for (const f of faces) {
    for (const n of f.names) {
      const k = n.toLowerCase();
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(f);
    }
  }
  return { byName, faces, files: files.length, ms: Date.now() - t0 };
}

let index = null;
/** This session's index, built on the first call. */
const getIndex = () => (index ??= buildIndex().catch((e) => {
  index = null; // the next ask tries again
  throw e;
}));

/** Every family name the installed fonts answer to (typographic, legacy and localized), sorted, with how long indexing took. */
async function families() {
  const ix = await getIndex();
  return { families: [...new Set(ix.faces.flatMap((f) => f.names))].sort((a, b) => a.localeCompare(b)), files: ix.files, ms: ix.ms };
}

/** The files of installed family `name` (any of its names, any case), each once → [{file (its path), name, source}], [] when none
 * is installed. `name` is the file's own name, numbered from the second when two folders hold a file of that name (the system's
 * and the per-user fonts, say), so each names one file. */
async function filesOf(name) {
  const faces = (await getIndex()).byName.get(String(name ?? '').trim().toLowerCase()) ?? [];
  const seen = new Map();
  return [...new Set(faces.map((f) => f.file))].map((file) => {
    const base = path.basename(file);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { file, name: n > 1 ? `${base} (${n})` : base, source: faces.find((f) => f.file === file).source };
  });
}

/** The files of installed family `name` (any of its names, any case): [{name (the file's), source}], [] when none is installed.
 * A collection comes whole; the engine takes each of its faces. Their bytes come one file a call (`file`): a family's files in
 * one reply held the page's thread while it read them, and every draft's calls with it (engine-print-bench: 69 ms for Yu
 * Gothic's 54 MB). */
async function family(name) {
  return (await filesOf(name)).map(({ name: fileName, source }) => ({ name: fileName, source }));
}

/** The bytes of file `fileName` (as `family` names it) of installed family `name`, or null when it is not one of its files or is
 * gone since indexing (the family draws without it). */
async function file(name, fileName) {
  const f = (await filesOf(name)).find((x) => x.name === fileName);
  return f ? fs.readFile(f.file).catch(() => null) : null;
}

module.exports = { fontDirs, fontFiles, choose, buildIndex, families, family, file };
