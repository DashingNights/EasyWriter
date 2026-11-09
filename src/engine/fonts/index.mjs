// The font provider wired to an engine host with the app's sources (client.js starts one for each host, so one per window: the
// worker's fonts serve every draft in it): the installed fonts on the desktop (window.api.fonts), then the fonts the user added in
// the web app, then the open fonts the app ships or downloads. It also tells the worker which fonts it loads for each script, so
// a draft whose fonts lack a script falls back to the same font whatever other drafts loaded (engine fonts crate, scope.rs).
import { createFontProvider, SCRIPT_FONTS } from './provider.mjs';
import { installedSource, openSource, userSource } from './sources.mjs';

/** Answers `host`'s fonts.missing events → the provider ({request, results, label, ready, stop}). `base`: the app's root URL. */
export function startFonts(host, { base = globalThis.document?.baseURI } = {}) {
  const sources = [];
  if (globalThis.window?.api?.fonts) sources.push(installedSource());
  if (globalThis.indexedDB) sources.push(userSource());
  sources.push(openSource({ base }));
  host.call('setScriptFonts', [SCRIPT_FONTS]).catch(() => {});
  const engine = {
    on: (event, fn) => host.on(event, fn),
    // The file's bytes move to the worker rather than being copied (a document's fonts run to hundreds of MiB), unless they
    // are a slice of a larger buffer that may hold other files.
    addFont: (bytes) => host.call('addFont', [bytes], bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? [bytes.buffer] : []),
    fontsDone: () => host.call('fontsDone'),
  };
  return createFontProvider({ engine, sources });
}
