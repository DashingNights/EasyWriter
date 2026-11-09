// Runs the Word file reader (worker.js) in a Web Worker (docs/plans/word/briefs/open-worker.md): the page stays free while a
// large file parses, and Cancel ends the worker. Where no worker can start, the reader runs on the page, with a console warning.
// Plain web APIs only (the app becomes a web app): the worker's script is dist/docx-worker.js beside the page.
import { importDoc } from './doc.mjs';
import { importDocx } from './import.mjs';

/** Where the last file was read: 'worker', or 'page' when no worker could start (the harness checks it). */
export let via = null;

/** Reads Word file `name` holding `bytes` (a Uint8Array) → {doc (TipTap JSON), title, dropped}. `settings`: the app's, for the new
 * Document's defaults; `fresh`: importDocx's. Aborting `signal` ends the worker and rejects with an AbortError. */
export function readWordFile(name, bytes, { settings = null, fresh = false, signal } = {}) {
  const here = (why) => {
    console.warn('The Word reader could not start a worker, so it reads on the main thread.', why);
    via = 'page';
    return /\.doc$/i.test(name) ? importDoc(bytes, { settings }) : importDocx(bytes, { settings, fresh });
  };
  let worker;
  try {
    worker = new Worker(new URL('dist/docx-worker.js', document.baseURI));
  } catch (e) {
    return here(e);
  }
  return new Promise((resolve, reject) => {
    let started = false;
    const end = () => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
    };
    function abort() {
      end();
      reject(new DOMException('The open was cancelled.', 'AbortError'));
    }
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort);
    worker.onmessage = async ({ data }) => {
      started = true;
      if (data.stage) return;
      // A metafile the worker could not draw (EMF+ only, unreadable): the system draws it on the desktop, the web app has none.
      if (data.metafiles) {
        let pngs = null;
        try {
          pngs = (await window.api?.word?.metafiles?.(data.items)) ?? null;
        } catch { /* the importer draws placeholders */ }
        worker.postMessage({ id: data.metafiles, pngs });
        return;
      }
      end();
      if (data.error) return reject(new Error(data.error));
      via = 'worker';
      resolve(JSON.parse(data.json));
    };
    // A script that cannot load (missing, blocked) fails before the worker says anything: read here instead.
    worker.onerror = (e) => {
      e.preventDefault();
      end();
      if (started) reject(new Error(e.message || 'The reader stopped.'));
      else here(e.message || e.type).then(resolve, reject);
    };
    worker.postMessage({ name, bytes, settings, fresh });
  });
}
