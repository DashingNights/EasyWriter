// The Word file reader's Web Worker (docs/plans/word/briefs/open-worker.md): a .docx or .doc parses here, off the page's thread,
// so a large file never locks the app and a reader that fails ends in this worker. Bundled on its own as dist/docx-worker.js
// (package.json build); reader.js starts it, one per file.
// In: {name, bytes, settings, fresh}, then {id, pngs}, the page's answers to its metafile requests.
// Out: {stage} once it starts, {metafiles: id, items} per request, then {json} (the read {doc, title, dropped} as JSON text,
// which the page parses in about a third of the time a structured clone of the same object takes) or {error}.
import { importDoc } from './doc.mjs';
import { importDocx } from './import.mjs';

const asked = new Map(); // metafile request id → its resolve
let lastId = 0;

// EMF and WMF pictures draw here (src/vendor/wordcraft-metafile); the few it cannot draw (EMF+ only, unreadable) need the
// system's renderer (window.api.word.metafiles), which only the page reaches.
const metafiles = (items) => new Promise((resolve) => {
  asked.set(++lastId, resolve);
  self.postMessage({ metafiles: lastId, items });
});

self.onmessage = async ({ data }) => {
  if ('pngs' in data) {
    asked.get(data.id)?.(data.pngs);
    asked.delete(data.id);
    return;
  }
  self.postMessage({ stage: 'reading' });
  try {
    const { name, bytes, settings = null, fresh = false } = data;
    const read = /\.doc$/i.test(name) ? await importDoc(bytes, { settings }) : await importDocx(bytes, { settings, fresh, metafiles });
    self.postMessage({ json: JSON.stringify(read) });
  } catch (e) {
    self.postMessage({ error: e?.message || String(e) });
  }
};
