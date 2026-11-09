// One reader of canvas records for code that needs a draft that is not open (docs/plans/engine/stage2b.md, stage2b/stale-doc.md
// R12, R13, R16): Compare, Version History, mail merge's data source, AutoMark, template styles and RD fields. A canvas record
// keeps no DOM `doc` (form.mjs), so its model goes through the engine's helper worker (client.js EngineHost.convert) as .docx,
// and the Word reader reads that, as toDom does for the open draft. The host and the reader come from the caller, so this file
// imports nothing of the app (test/web-portable.test.mjs). Helper jobs run one at a time: a read waits behind a PDF export.
import { isCanvas, modelBytes, unreadable } from './form.mjs';

/** Canvas record `draft` as `kind` bytes ('docx', 'txt', 'engine'...), made by `host`'s helper worker (EngineHost.convert).
 * Rejects with why when this build cannot read the record (form.mjs unreadable: a newer schema, a missing picture). */
export async function convert(host, draft, kind) {
  const why = unreadable(draft?.engine);
  if (why) throw new Error(why);
  return host.convert(modelBytes(draft.engine), kind);
}

/** Draft record `draft`'s DOM doc (TipTap JSON): its own `doc`, or for a canvas record the engine's .docx read by `read(bytes)`
 * → {doc} (reader.js readWordFile, as toDom reads it). `host`: the window's EngineHost. */
export async function domDocOf(draft, { host, read }) {
  if (!isCanvas(draft)) return draft?.doc ?? null;
  return (await read(await convert(host, draft, 'docx'))).doc;
}
