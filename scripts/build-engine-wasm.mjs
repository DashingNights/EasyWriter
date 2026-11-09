// Builds the document engine's WebAssembly (docs/plans/engine/plan.md section 1, viewport-design.md section 11):
// the wasm host crate (engine/crates/wasm, package ew-wasm) with cargo for wasm32-unknown-unknown, then wasm-bindgen --target
// web into src/engine/wasm/ (ew.js and ew_bg.wasm), with the files the .wasm leaves out beside it (DATA: the engine's own fonts
// and the hyphenation data), and fails when the .wasm is over its BUDGET. npm run build runs it first. Git does not carry the
// build (.gitignore), so a fresh checkout makes it here.
//   node scripts/build-engine-wasm.mjs [--force] [--ci]
// STAMP holds the hash of the sources a build came from, and the .wasm carries the same hash (buildStamp(), which the worker
// checks against STAMP). A checkout whose .wasm and STAMP match its sources is left alone, so it needs no Rust toolchain: the
// release workflow's Windows and Mac jobs get them from its engine job. Otherwise the build comes from the cache in the OS temp
// folder (easywriter-engine/<hash>/, shared by every worktree), and only sources no worktree has built yet run cargo. --force
// builds again even when the cache has them. --ci is the release workflow's engine job: it also fails unless rustc and
// wasm-bindgen are exactly the pinned versions, always builds, runs wasm-opt (binaryen, which only that job installs) over the
// module, and leaves ew.js, ew_bg.wasm and STAMP in src/engine/wasm for the artifact. Where wasm-opt is missing, fails or writes
// a module that does not validate, the module ships unoptimised with a warning (optimise), so a release never stops on that step.
// Needs cargo with the toolchain engine/rust-toolchain.toml pins and its wasm32-unknown-unknown target, and wasm-bindgen-cli at
// the version engine/crates/wasm/Cargo.toml pins (0.2.129); without them it stops with a message that says what to install.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'engine');
const presets = path.join(root, 'src', 'vendor', 'ooxml-presets');
const out = path.join(root, 'src', 'engine', 'wasm');
const stampFile = path.join(out, 'STAMP');
/** The build cache: one folder per source hash with ew.js, ew_bg.wasm, and ew_bg.full.wasm, the same module with its name
 * section, which turns the function numbers in a crash stack into names. */
export const cache = path.join(os.tmpdir(), 'easywriter-engine');
// Cargo's output stays out of the repository (and out of esbuild's and the graph's way). One target for every worktree, so a
// worktree's first build reuses what the others compiled; only this script builds in it, under the lock.
const target = path.join(cache, 'target');
/** The content of each source file as the target last compiled it (see freshen). */
const record = path.join(cache, 'target.json');
const ENTRY = ['ew.js', 'ew_bg.wasm', 'ew_bg.full.wasm'];
const KEEP = 10; // cache folders kept, about 60 MB each
/** The most bytes ew_bg.wasm may have: the measured size plus 2 % (viewport-design.md sections 9 and 11). A build above it
 * fails. Only the planner raises it: a package whose build passes it reports the growth and its cause instead. */
// 20,923,602 bytes after engine-size (2026-10-31), raised for the Stage 2b gap packages and wave C to 22,586,000
// (suggestion-cards-engine measured 22,585,399). engine-size-2 (2026-11-01) cut it to 20,326,054 on word-parity c382f9dc: one
// compiled copy of each picture decoder and encoder and of the model's JSON writer, and zip without zopfli
// (docs/plans/engine/bench.log). That plus 2 %: 20,732,576. The planner raised it on 2026-11-01 for engine-pictures-2's own
// features (the SVG reader, picture settings drawn live, their commands): 20,892,999 bytes merged, plus 1 %:
// 2026-11-03: 21,150,000 for the board, then the user lifted the cap ("infinite budget"): this number never stops a build, and
// npm run build still prints the size, so packages report their growth as before.
export const BUDGET = 1_000_000_000;
/** The files the .wasm leaves out, which the worker fetches from beside it: engine/<from> → src/engine/wasm/<to>. The engine's
 * own fonts with their licences (src/engine/fonts/bundled.mjs adds them before the first layout) and the hyphenation data
 * (fetched on first use). */
export const DATA = [['assets/fonts', 'fonts'], ['assets/hyphenation', 'data']];

/** Every file under `dir` but its notes (.md) → sorted [relative path, bytes], CRLF read as LF so that a Windows checkout
 * (core.autocrlf) and a Linux one agree. */
export function sources(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      // target/ is cargo's output when the crates' own tests run natively in the checkout (cargo test), not a source.
      if (e.isDirectory()) {
        if (!(d === dir && e.name === 'target')) walk(p);
      } else if (!e.name.endsWith('.md')) files.push(path.relative(dir, p).replaceAll('\\', '/'));
    }
  };
  walk(dir);
  return files.sort().map((f) => [f, Buffer.from(fs.readFileSync(path.join(dir, f)).toString('latin1').replaceAll('\r\n', '\n'), 'latin1')]);
}

/** The engine's sources: engine/, and src/vendor/ooxml-presets, which the docx crate compiles in (its build.rs), as
 * ../src/vendor/ooxml-presets/..., so freshen finds them from src too. */
export const engineSources = () => [...sources(src), ...sources(presets).map(([f, bytes]) => [`../src/vendor/ooxml-presets/${f}`, bytes])];

/** One hash over the sources under `dir` (the engine's for src): STAMP's, the cache's key and buildStamp's. */
export function sourceHash(dir = src, files = dir === src ? engineSources() : sources(dir)) {
  const h = crypto.createHash('sha256');
  for (const [f, bytes] of files) {
    // The length is taken after the CRLF fold too, or a CRLF checkout hashes differently and rebuilds.
    h.update(`${f}\n${bytes.length}\n`);
    h.update(bytes);
  }
  return h.digest('hex');
}

/** Cargo decides what to recompile from file times, and the target is shared by every worktree: a file this checkout holds
 * differently from the target's last build, but older than it, would leave the other worktree's code in this build. Such
 * files get the current time. They count as unknown until cargo succeeds, so a failed build leaves the next one to give them
 * the time again. `files` are sources(dir). Runs under the lock → a function that records this build once cargo has succeeded. */
export function freshen(files, dir = src, file = record) {
  let last = {};
  try {
    last = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const sums = Object.fromEntries(files.map(([f, bytes]) => [f, crypto.createHash('sha1').update(bytes).digest('hex')]));
  const now = new Date();
  for (const f in sums) {
    if (last[f] === sums[f]) continue;
    fs.utimesSync(path.join(dir, f), now, now);
    last[f] = null;
  }
  fs.writeFileSync(file, JSON.stringify(last));
  return () => fs.writeFileSync(file, JSON.stringify(sums));
}

/** Whether `dir` holds the build of `hash`: ew.js, and an ew_bg.wasm with that hash inside (buildStamp's string). */
const holds = (dir, hash) =>
  fs.existsSync(path.join(dir, 'ew.js')) && fs.existsSync(path.join(dir, 'ew_bg.wasm')) && fs.readFileSync(path.join(dir, 'ew_bg.wasm')).includes(hash);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Whether the lock in `file` was left behind: its process is gone, it is over an hour old (Windows reuses pids), or it stayed
 * unreadable for a minute. */
function stale(file) {
  try {
    const { pid, at } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return !alive(pid) || Date.now() - at > 3600e3;
  } catch {
    try {
      return Date.now() - fs.statSync(file).mtimeMs > 60e3;
    } catch {
      return false; // released meanwhile: try again
    }
  }
}

/** Runs `fn` holding the lock `file`. Cargo's target, the ew.wasm wasm-bindgen reads and the cache are shared by every
 * worktree, so another build waits here rather than bind or cache the ew.wasm a different source tree just wrote. */
export function locked(file, fn) {
  for (let said = false; ; ) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, root, at: Date.now() }), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    // ponytail: two builds that find the same stale lock both remove it; only after a crashed build, so left as it is.
    if (stale(file)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (!said) {
      said = true;
      let by = '';
      try {
        by = ` (${JSON.parse(fs.readFileSync(file, 'utf8')).root})`;
      } catch {}
      console.log(`engine wasm: waiting for another engine build${by}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  try {
    return fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Removes a cache folder: the files this script writes there, then the folder when that leaves it empty. */
function drop(dir) {
  for (const f of ENTRY) fs.rmSync(path.join(dir, f), { force: true });
  try {
    fs.rmdirSync(dir);
  } catch {}
}

/** The versions a build is made with: the compiler engine/rust-toolchain.toml names and the wasm-bindgen
 * engine/crates/wasm/Cargo.toml pins with `=` (the CLI must match the crate). */
export function pins() {
  const rust = /^channel\s*=\s*"(.+)"/m.exec(fs.readFileSync(path.join(src, 'rust-toolchain.toml'), 'utf8'))[1];
  const bindgen = /^wasm-bindgen\s*=\s*"=(.+)"/m.exec(fs.readFileSync(path.join(src, 'crates', 'wasm', 'Cargo.toml'), 'utf8'))[1];
  return { rust, bindgen };
}

/** rust-toolchain.toml pins the compiler. Where that toolchain is not installed but stable is the same version, cargo runs on
 * stable, rather than rustup downloading the same compiler again under the version's name. */
function toolchain() {
  if (process.env.RUSTUP_TOOLCHAIN) return {};
  try {
    const pin = pins().rust;
    const list = execFileSync('rustup', ['toolchain', 'list'], { encoding: 'utf8' });
    if (list.split(/\r?\n/).some((l) => l.startsWith(`${pin}-`)) || !/^stable-/m.test(list)) return {};
    const stable = execFileSync('rustup', ['run', 'stable', 'rustc', '--version'], { encoding: 'utf8' });
    return stable.startsWith(`rustc ${pin} `) ? { RUSTUP_TOOLCHAIN: 'stable' } : {};
  } catch {
    return {}; // no rustup: cargo is whichever is installed
  }
}

/** Stops with a message that says what to install when Rust or wasm-bindgen does not run, and with `exact` (--ci) when either
 * is not the pinned version. `env` is the one cargo gets, so rustc answers for the toolchain the build would use. */
export function tools(env, exact) {
  const { rust, bindgen } = pins();
  const version = (cmd) => {
    try {
      // stderr stays visible: rustup may be installing the pinned toolchain.
      return execFileSync(cmd, ['--version'], { cwd: src, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
    } catch {
      return '';
    }
  };
  const rustc = version('rustc');
  const wb = version('wasm-bindgen');
  const wrong = !rustc ? 'Rust is not installed'
    : !wb ? 'wasm-bindgen is not installed'
    : exact && !rustc.startsWith(`rustc ${rust} `) ? `${rustc} is not the pinned Rust ${rust}`
    : exact && wb !== `wasm-bindgen ${bindgen}` ? `${wb} is not the pinned wasm-bindgen ${bindgen}`
    : '';
  if (!wrong) return;
  console.error(`engine wasm: ${wrong}. Building the engine needs Rust ${rust} with its wasm32-unknown-unknown target (rustup ` +
    `installs both from rust-toolchain.toml) and wasm-bindgen-cli ${bindgen} (cargo install wasm-bindgen-cli --version ${bindgen} --locked).`);
  process.exit(1);
}

/** Binaryen's name for a target_features name where it is not the same (wasm-opt --help lists the --enable-* flags). */
const BINARYEN = { 'nontrapping-fptoint': 'nontrapping-float-to-int', simd128: 'simd', atomics: 'threads' };

/** The wasm-opt flags for the features the module `bytes` uses: the ones its target_features section (which the linker writes
 * and wasm-bindgen keeps) marks used (+) or required (=). A name binaryen does not know becomes a flag it rejects, so that
 * build falls back (optimise) rather than optimise with a feature switched off. */
export function features(bytes) {
  let p = 8; // past the magic number and the version
  const leb = () => {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      const b = bytes[p++];
      n += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return n;
    }
  };
  const name = () => {
    const n = leb();
    return bytes.toString('utf8', p, (p += n));
  };
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = leb();
    const end = p + size;
    if (id === 0 && name() === 'target_features') {
      const flags = [];
      for (let n = leb(); n > 0; n--) {
        const prefix = String.fromCharCode(bytes[p++]);
        const feature = name();
        if (prefix !== '-') flags.push(`--enable-${BINARYEN[feature] ?? feature}`);
      }
      return flags;
    }
    p = end;
  }
  return [];
}

/** wasm-opt over the named module `full` (-Oz, -g keeps its names, in place) and the app's module `app` as the same without
 * them, so the cache's full module still names the functions of the module the app ships (viewport-design.md section 11, step
 * 6, size first). `run(cmd, args)` runs a command and throws when it fails. → false, with `full` as it was and no `app`, when
 * wasm-opt is missing, rejects the module or writes one WebAssembly.validate refuses (an exit code of 0 says nothing about
 * the output): the caller then ships it unoptimised. */
export function optimise(full, app, run) {
  const flags = features(fs.readFileSync(full));
  const named = `${full}.opt`;
  const before = fs.statSync(full).size;
  try {
    // wasm-opt does not write the target_features section back, so the second run needs the flags too.
    run('wasm-opt', ['-Oz', '-g', ...flags, full, '-o', named]);
    run('wasm-opt', ['--strip-debug', ...flags, named, '-o', app]);
    for (const f of [named, app]) {
      if (!WebAssembly.validate(fs.readFileSync(f))) throw new Error(`it wrote ${path.basename(f)}, which does not validate`);
    }
  } catch (e) {
    for (const f of [named, app]) fs.rmSync(f, { force: true });
    // ::warning:: is a GitHub Actions annotation: the release run's summary shows it.
    console.log(`::warning::engine wasm: wasm-opt failed (${String(e.message).split('\n')[0]}), so the module ships unoptimised`);
    return false;
  }
  fs.renameSync(named, full);
  console.log(`engine wasm: wasm-opt -Oz ${flags.join(' ')} took the named module from ${before} to ${fs.statSync(full).size} bytes`);
  return true;
}

/** Builds `files`, the sources of `hash`, into the cache folder `entry` with the Rust environment `rust`, the module through
 * wasm-opt when `opt` (--ci). Runs under the lock. */
function build(hash, entry, files, rust, opt) {
  const tmp = `${entry}.tmp`;
  drop(tmp);
  const env = { ...rust, CARGO_TARGET_DIR: target, EW_BUILD_STAMP: hash };
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: src, stdio: 'inherit', env });
  const wasm = path.join(target, 'wasm32-unknown-unknown', 'release', 'ew.wasm');
  const t0 = performance.now();
  try {
    const compiled = freshen(files);
    run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'ew-wasm']);
    compiled();
    // The module twice: with its name section for the cache, and without it (about 2 MB smaller) for the app.
    const bindgen = ['--target', 'web', '--no-typescript', '--out-name', 'ew', '--out-dir', tmp, wasm];
    run('wasm-bindgen', bindgen);
    const full = path.join(tmp, 'ew_bg.full.wasm');
    fs.renameSync(path.join(tmp, 'ew_bg.wasm'), full);
    if (!(opt && optimise(full, path.join(tmp, 'ew_bg.wasm'), run))) run('wasm-bindgen', ['--remove-name-section', ...bindgen]);
    if (!holds(tmp, hash)) throw new Error(`engine wasm: the build of ${hash} does not carry its stamp`);
    drop(entry);
    fs.renameSync(tmp, entry);
  } finally {
    drop(tmp);
  }
  const size = (f) => fs.statSync(path.join(entry, f)).size;
  console.log(`engine wasm: ew_bg.wasm ${size('ew_bg.wasm')} bytes (${size('ew_bg.full.wasm')} with its name section), built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

/** Stops the build when `wasm` is over BUDGET. */
function budget(wasm) {
  const size = fs.statSync(wasm).size;
  if (size <= BUDGET) return;
  console.error(`engine wasm: ew_bg.wasm is ${size} bytes, over its budget of ${BUDGET} (BUDGET in scripts/build-engine-wasm.mjs). ` +
    'Cut it, or report the growth and its cause: only the planner raises the budget.');
  process.exit(1);
}

/** Copies DATA beside the .wasm, as `dir` (out by default) needs it. On every run, the up-to-date one too: the release
 * workflow's Windows and Mac jobs get only the .wasm and STAMP from its engine job, and these from their own checkout. */
export function copyData(dir = out) {
  for (const [from, to] of DATA) {
    fs.mkdirSync(path.join(dir, to), { recursive: true });
    for (const f of fs.readdirSync(path.join(src, from))) {
      const bytes = fs.readFileSync(path.join(src, from, f));
      const there = path.join(dir, to, f);
      if (!fs.existsSync(there) || !fs.readFileSync(there).equals(bytes)) fs.writeFileSync(there, bytes);
    }
  }
}

/** Keeps the KEEP cache folders used last. Runs under the lock, so a .tmp folder is one a build left behind. */
function prune() {
  const dirs = fs.readdirSync(cache, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(cache, e.name));
  for (const d of dirs.filter((d) => d.endsWith('.tmp'))) drop(d);
  const builds = dirs.filter((d) => /[0-9a-f]{64}$/.test(d)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const d of builds.slice(KEEP)) drop(d);
}

function main() {
  const force = process.argv.includes('--force');
  const ci = process.argv.includes('--ci');
  const files = engineSources();
  const hash = sourceHash(src, files);
  // Only a build asks rustup, so an up-to-date checkout needs no Rust at all.
  let env;
  const rust = () => (env ??= { ...process.env, ...toolchain() });
  if (ci) tools(rust(), true);
  const stamp = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';
  if (!force && !ci && stamp === hash && holds(out, hash)) {
    budget(path.join(out, 'ew_bg.wasm'));
    copyData();
    return console.log('engine wasm: up to date');
  }
  const entry = path.join(cache, hash);
  if (!ci && (force || !fs.existsSync(entry))) tools(rust(), false);
  fs.mkdirSync(cache, { recursive: true });
  if (force || ci || !fs.existsSync(entry)) {
    // Looked at again under the lock: another worktree may have built the same sources while this one waited.
    locked(path.join(cache, 'build.lock'), () => {
      if (force || ci || !fs.existsSync(entry)) build(hash, entry, files, rust(), ci);
      prune();
    });
  } else console.log(`engine wasm: ${hash.slice(0, 12)} from the build cache`);
  const now = new Date();
  fs.utimesSync(entry, now, now); // the prune keeps the folders used last
  budget(path.join(entry, 'ew_bg.wasm'));
  fs.mkdirSync(out, { recursive: true });
  for (const f of ['ew.js', 'ew_bg.wasm']) fs.copyFileSync(path.join(entry, f), path.join(out, f));
  copyData();
  fs.writeFileSync(stampFile, `${hash}\n`);
}

// Run as a script, not imported (test/engine-build.test.mjs imports it); real paths, so a junction or the drive letter's case
// cannot hide the build.
const real = (p) => fs.realpathSync.native(p);
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
