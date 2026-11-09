// The engine's own open fonts: Source Sans 3, Source Serif 4, Inter and JetBrains Mono (SIL OFL 1.1, engine/assets/fonts). A
// native build compiles them in; the .wasm leaves their 4.3 MB out (docs/plans/engine/viewport-design.md section 11), so
// scripts/build-engine-wasm.mjs copies the files and their licences beside it, into src/engine/wasm/fonts/, and the worker adds
// them before it answers its first call: the first layout has them, as it had the compiled-in ones. Plain web code.

/** The files, in the order the native build compiles them in (engine/crates/fonts/src/fontdb/face.rs BUNDLED), so the font
 * database lists the faces as it does natively. The first is the engine's fallback face. */
export const FACES = [
  'SourceSans3-Regular.ttf', 'SourceSans3-Semibold.ttf', 'SourceSans3-Bold.ttf', 'SourceSans3-It.ttf',
  'SourceSerif4-Regular.ttf', 'SourceSerif4-It.ttf', 'SourceSerif4-Semibold.ttf', 'SourceSerif4-Bold.ttf', 'SourceSerif4-BoldIt.ttf',
  'Inter-Regular.ttf', 'Inter-Medium.ttf', 'Inter-SemiBold.ttf', 'JetBrainsMono-Regular.ttf',
];

/** Where the build puts them, beside the .wasm. */
export const FOLDER = new URL('../wasm/fonts/', import.meta.url);

/** Reads `url` with fetch → its bytes; a missing file is an error that says how to make it. */
async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the engine's font ${url.pathname.split('/').pop()} is missing (${res.status}). Run npm run build.`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Adds the bundled faces through `engine`: the glue module (its addFont, before the first session) or an ew Engine. The font
 * database is the whole worker's, so once per worker is enough. `read(url)` → the file's bytes (or a promise of them): fetch by default, fs.readFileSync in Node tests. */
export async function addBundledFonts(engine, read = fetchBytes) {
  const files = await Promise.all(FACES.map((f) => read(new URL(f, FOLDER))));
  for (const bytes of files) engine.addFont(bytes);
}
