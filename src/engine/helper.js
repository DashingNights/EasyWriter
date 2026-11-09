// The engine's helper worker (docs/plans/engine/viewport-design.md section 8 and the first of section 16's conditional packages):
// the jobs that held the engine worker for seconds, an open's reading of a .docx and a PDF export (engine-print measured a visible
// draft stalling 2.1 to 4.3 s through them), run here on the same .wasm, so the drafts in the engine worker keep painting. client.js
// starts it on demand with the engine worker's compiled WebAssembly.Module, so the .wasm is not compiled twice, and closes it when
// it has been idle a while; its fonts and memory go with it. A module worker, like worker.js. Plain web APIs only.
//
// Messages in: {module} first, then {id, method, args}. Out: {id, result} or {id, error, dead}, and {event: 'fonts.missing', data}
// for the font provider client.js runs for this worker. `dead`: a Rust panic trapped the instance, so the host starts a new one.
//   engineForm(bytes, kind) → the engine form of a .docx or .doc, read and not laid out; the engine worker opens it as 'engine'.
//   convert(model, kind, steps) → the engine form `model` as `kind` ('docx', 'engine', 'txt'...), after engine commands `steps`
//     ([[id, args]], run in order) when given (a Compare into a new draft).
//   pdf(model, options, fonts) → {bytes, outlined, why, ms}, as the engine worker's pdf call answers: the engine form `model` laid
//     out and exported. With `fonts` (a provider answers this worker) the families layout lacks go out as fonts.missing first,
//     and the export waits for fontsDone, so no family is drawn in a stand-in because its file came late.
//   addFont(bytes), fontsDone(), setScriptFonts(lists): the provider's calls, as worker.js takes them.
//   stats() → {wasm, heap, fonts, module}: the instance's memory, the allocator's bytes in use, the font bytes it holds, and
//     whether it instantiated the module it was given (false: it compiled the .wasm itself).
import init, * as ew from './wasm/ew.js';
import { addBundledFonts } from './fonts/bundled.mjs';
import { appVersion } from './app-version.mjs';

let started = null;
let given = false;
let bundled = null;
let dead = null;
/** The Engine of the PDF being made, which a font that arrives lays out again. */
let current = null;
/** Resolves the PDF's wait for the provider's fontsDone. */
let answered = null;

/** Hands the instance the hyphenation files layout asked for (wasm/data/ beside the .wasm, as worker.js fetchData does). */
async function addData(names) {
  for (const name of names) {
    const res = await fetch(new URL(`wasm/data/${name}`, import.meta.url)).catch(() => null);
    if (res?.ok) ew.addData(name, new Uint8Array(await res.arrayBuffer()));
  }
}

const jobs = {
  engineForm: (bytes, kind) => ew.engineForm(bytes, kind),
  // engine-canvas-read: a draft that is not open, for the code that reads it. Without `steps` the model is written as `kind`
  // without a layout; with them it opens (laying out a page) and runs them as one exec each, then saves.
  async convert(model, kind, steps = null) {
    if (!steps?.length) return ew.convert(model, kind);
    await (bundled ??= addBundledFonts(ew)); // the open lays out its first page
    const e = new ew.Engine();
    try {
      e.setAhead(1);
      e.open(model, 'engine');
      for (const [id, args] of steps) {
        const r = JSON.parse(e.exec(id, JSON.stringify(args ?? {})));
        if (!r.ok) throw new Error(r.error);
      }
      return e.save(kind);
    } finally {
      e.free();
    }
  },
  async pdf(model, options = {}, fonts = false) {
    await (bundled ??= addBundledFonts(ew));
    const e = (current = new ew.Engine());
    try {
      e.open(model, 'engine');
      // Layout asks for what it lacks while it runs: hyphenation data, and fonts the provider did not load beforehand (a family
      // on no source, whose stand-in it then loads). Each round lays out again with what arrived.
      for (let round = 0; round < 3; round++) {
        e.pages();
        const wanted = ew.takeWantedData();
        const missing = e.takeMissingFonts();
        if (wanted) {
          await addData(JSON.parse(wanted));
          e.dataChanged();
        }
        if (missing && fonts) {
          const done = new Promise((r) => (answered = r));
          postMessage({ event: 'fonts.missing', data: JSON.parse(missing) });
          await done;
        }
        if (!wanted && !(missing && fonts)) break;
      }
      const t0 = performance.now();
      const r = e.pdfNamed(JSON.stringify(options));
      try {
        return { bytes: r.bytes, outlined: JSON.parse(r.outlined), why: JSON.parse(r.why ?? '[]'), ms: Math.round(performance.now() - t0) };
      } finally {
        r.free();
      }
    } finally {
      current = null;
      e.free();
    }
  },
};

const calls = {
  addFont: (bytes) => {
    const added = ew.addFont(bytes);
    if (added) current?.fontsChanged();
    return added;
  },
  fontsDone: () => {
    answered?.();
    answered = null;
    return true;
  },
  setScriptFonts: (lists) => ew.setScriptFonts(JSON.stringify(lists ?? {})),
  stats: () => {
    const e = new ew.Engine();
    try {
      const { wasm, heap, fonts } = JSON.parse(e.stats());
      return { wasm, heap, fonts, module: given };
    } finally {
      e.free();
    }
  },
};

// Jobs run one at a time; the provider's calls run at once, since a PDF waits for them.
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  if (data.module !== undefined) {
    // Without a module (a host that could not pass one) the glue fetches and compiles the .wasm itself.
    given = data.module instanceof WebAssembly.Module;
    // The app's version goes in the files this worker writes (app-version.mjs); without it they say EasyWriter alone.
    started = Promise.all([init(given ? { module_or_path: data.module } : undefined), appVersion()]).then(([, v]) => ew.setAppVersion(v));
    return;
  }
  const { id, method, args = [] } = data;
  const run = async () => {
    try {
      await started;
      if (dead) throw new Error(dead);
      const fn = jobs[method] ?? calls[method];
      if (!fn) throw new Error(`Unknown helper call ${method}.`);
      const result = await fn(...args);
      const bytes = result instanceof Uint8Array ? result : result?.bytes;
      postMessage({ id, result }, bytes instanceof Uint8Array ? [bytes.buffer] : []);
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) dead ??= `The helper worker stopped: ${e.message}`;
      postMessage({ id, error: e?.message ?? String(e), dead: !!dead });
    }
  };
  if (jobs[method]) queue = queue.then(run);
  else run();
};
