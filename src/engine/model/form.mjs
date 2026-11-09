// The stored form of a Document in the canvas editor (docs/plans/engine/model.md, viewport-design.md section 10): the draft record
// keeps the engine's own model, its save('engine') JSON, in `draft.engine` = {form, version, model}. The model carries the same
// schema name and version at its root, which the engine checks and upgrades at open (ew-doc's schema.rs). The envelope carries them
// too, so this thread refuses a newer record without parsing the model. A canvas record keeps no DOM `doc` (stage2b.md decision 1):
// the engine holds the document, a record saved before keeps its stale one until its next save, and toDom makes a new one. Pure:
// the page, workers and node tests use it.
export const FORM = 'easywriter.document';
/** The form a forum post's (or core page's) record keeps (docs/plans/engine/stage3-forum.md C1): the post kit's JSON, which only
 * the post host (document/canvas/post.js) opens. Every path that does not know posts (the assistant's background sessions, a .docx
 * export, compare, an older build) refuses it as a form it does not know, instead of opening it as an engine Document and saving
 * an empty one over it. */
export const POST_FORM = 'easywriter.post';

/** What the engine writes for `draft`: a Document's own model form ('engine') or a post's stored JSON ('post'). A draft with no
 * format is a forum post (formats.mjs formatOf's default). */
export const kindOfDraft = (draft) => (draft?.format === 'document' ? 'engine' : 'post');
/** The record form `draft` saves (adopt): the post kit's for a post, else a Document's. */
export const formOfDraft = (draft) => (kindOfDraft(draft) === 'post' ? POST_FORM : FORM);
/** The schema version this build writes and the newest it reads: ew-doc's SCHEMA_VERSION (test/engine-schema.test.mjs holds them
 * equal). test/fixtures/engine-models/ keeps a model saved at every version, each of which must still open. Version 2 added stable
 * block and object ids and boxes, EasyWriter's own objects (viewport-design.md section 10); version 3 a revision's suggestion
 * group, `tag` (stage2b.md decision 4); version 4 the document's mail merge, `settings.mailMerge` (stage2.md G7), with picture and
 * pattern fills and the page's fill effect; version 5 settles the rest of wave B (docs/plans/engine/model.md, 'Schema versions');
 * version 6 the drawing grid's origin and every-n lines and a freeform's Edit Points paths (engine-tools-2), and a picture
 * watermark and the watermark's language (engine-gaps-rest); version 7 a picture's colour and corrections, the original they were
 * drawn from, the picture Word showed over an HD Photo original and an SVG picture's PNG copy (engine-pictures-2); version 8 no field,
 * the .docx reader's bookkeeping keys renamed from `wordcraft:` to `easywriter:` (engine-rename); version 9 no field, a
 * freeform's Edit Points paths stored through serde so the field list sees them, which writes a coordinate from 1e-6 to under
 * 1e-5 or from 1e13 to under 1e16 in the other notation (0.000001, not 1e-6) as the same number (engine-fixes-2-layout);
 * version 10 a run's or paragraph mark's `specVanish`, the style separator (engine-style-separator); version 11 no field, a
 * picture's media key and what its bitmap is drawn from given one owner in the same keys (engine-picture-writer); version 12
 * two `TextDirection` variants and a `TextVert` one, a text box's vertical text (ph-vertical-1); version 13 a chart's look,
 * `ChartSpec.look` (ph-charts-2); version 14 the container block, a quote, code block or titled box (engine-container); version
 * 15 the post profile and a media object's file (post-schema); version 16 a diagram's right-to-left mirror and each item's
 * own look, `SmartArtSpec.rtl` and `SmartArtItem.look` (ph-smartart-1). */
export const VERSION = 17;
/** What the canvas editor stored before its own form: WordCraft's form, stamped with the commit the engine was vendored at. It
 * reads as version 0 and is written in the current form at its next save. */
const PINNED = { form: 'wordcraft-json', pin: '1be606de' };
/** The formatVersion a canvas draft carries: above every Document version a build without the canvas engine reads, so such a build
 * refuses the draft (formats.mjs formatOf) instead of opening it without the engine and saving over the engine's form. */
export const FORMAT_VERSION = 3;

/** The formatVersion a draft back in the DOM editor carries: DOM drafts stay readable by 1.x builds even once DOCUMENT.version is 3. */
export const DOM_VERSION = 2;

export const isCanvas = (draft) => draft?.engine != null;

// A picture whose file was missing from images/ when the record loaded keeps its reference (file-family.js inline). The engine's
// reader takes only base64, so such a model cannot open; refusing keeps the record unsaved until the file arrives.
const REF = /^data:(?:image|video)\/[a-z0-9.+-]+;sha256,/;
const REF_IN_TEXT = /"data:(?:image|video)\/[a-z0-9.+-]+;sha256,/;
function hasRef(v) {
  if (typeof v === 'string') return REF.test(v);
  if (v && typeof v === 'object') for (const k in v) if (hasRef(v[k])) return true;
  return false;
}

/** Why this build cannot open the engine record `engine` as form `form` (a Document's unless a post host asks for POST_FORM) →
 * a reason to show, or null when it can. A path with the wrong form, a post's among them, refuses the record. */
export function unreadable(engine, form = FORM) {
  const pinned = engine?.form === PINNED.form;
  if (!pinned && engine?.form !== form) return 'it was saved in a form this version of EasyWriter does not know';
  if (pinned ? engine.pin !== PINNED.pin : !(Number.isInteger(engine.version) && engine.version >= 0 && engine.version <= VERSION)) {
    return 'a newer version of EasyWriter saved it';
  }
  if (engine.model == null) return 'its saved document is missing';
  if (typeof engine.model === 'string' ? REF_IN_TEXT.test(engine.model) : hasRef(engine.model)) {
    return 'one of its pictures is missing (a sync may not have finished)';
  }
  return null;
}

/** The bytes for the engine's open(bytes, 'engine'). The model is the object a load gives (its pictures back as data URLs) or the
 * JSON text a save in this session left. */
export const modelBytes = (engine) => new TextEncoder().encode(typeof engine.model === 'string' ? engine.model : JSON.stringify(engine.model));

/** The record's JSON text, with the model spliced in as it is: the model is never parsed on the page (191 ms for the fixture's).
 * main.js saveDraft parses the text and moves the model's data URL pictures to images/ like any record's. */
export function recordText(draft) {
  const [head, model, tail] = recordParts(draft);
  return head + model + tail;
}

/** recordText(draft) in pieces that join to it: the head, the model's text (or `pieces` of it) and the tail. Autosave sends a large
 * record to main a piece at a time. A `doc` the draft still holds (a record saved before, or the DOM form at the switch) is left out. */
export function recordParts(draft, pieces = null) {
  const { engine: { model: m, ...envelope }, doc, ...rest } = draft;
  const head = JSON.stringify({ ...rest, engine: envelope });
  return [`${head.slice(0, -2)},"model":`, ...(pieces ?? [typeof m === 'string' ? m : JSON.stringify(m)]), '}}'];
}

/** Takes the engine's save('engine') `bytes` (or their text, decoded already) into `draft` (changed in place, its DOM `doc` dropped)
 * → the record's JSON text to store. Each engine save gets a new `stamp` in the envelope: the undo history saved beside the record
 * names the save it belongs to, and one that names another (a crash between the two writes, a backup that kept the record of one
 * side and the history of the other) is dropped at the next open (stage2b.md decision 3). A save of the record as it is (actions.js
 * draftMeta) keeps the stamp. */
export function adopt(draft, bytes) {
  const model = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  delete draft.doc;
  Object.assign(draft, { formatVersion: FORMAT_VERSION, engine: { form: formOfDraft(draft), version: VERSION, stamp: newStamp(), model } });
  return recordText(draft);
}

const newStamp = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** The engine's open kind for Word file `name`: 'doc' for the binary .doc and .dot, else 'docx'. */
export const kindOf = (name) => (/\.do[ct]$/i.test(name) ? 'doc' : 'docx');

/** What the engine opens for `draft` → {bytes, kind, dropped}: the Word file `file` ({name, bytes}, its original bytes) when given,
 * else the draft's engine form, else its DOM form. `source(draft)` is the DOM form's own bytes and kind, for a format that is not
 * a Document (post.js postSource: a forum post opens as kind 'post'), which also wraps a canvas draft's saved model again; without
 * it a DOM draft is .docx from `docx(draft)` → {bytes, dropped} (files.js docxOfOpenDraft for the open draft, which brings its
 * canvases and plan charts as live boxes through the export's STASH part and its suggestions as tracked changes). Throws when this
 * build cannot read it. */
export async function sourceOf(draft, { file, docx, source } = {}) {
  if (file) return { bytes: file.bytes, kind: kindOf(file.name), dropped: [] };
  // What the draft's own format opens as (a Document's engine form, or a post's JSON), never a default.
  const kind = kindOfDraft(draft);
  if (isCanvas(draft)) {
    const why = unreadable(draft.engine, formOfDraft(draft));
    if (why) throw new Error(`This document cannot open: ${why}.`);
    // A post's model is the post kit's JSON, which only its host reads (post.js postSource, through `source`).
    if (!source) return kind === 'post' ? noPost() : { bytes: modelBytes(draft.engine), kind, dropped: [] };
  }
  if (source) return source(draft);
  if (kind === 'post') return noPost();
  const { bytes, dropped = [] } = await docx(draft);
  return { bytes, kind: 'docx', dropped };
}

/** A post's record reached a path that does not know posts. */
function noPost() {
  throw new Error('This document cannot open: this build cannot read a forum post in the canvas engine.');
}

/** Opens `draft` in the engine of `client` (engine plan §3) → {pages, kind, dropped}. A crash reopens it from what it opened, with
 * the record's stamp, so the undo history saved for that record comes back too (client.js). */
export async function openDraft(client, draft, deps) {
  const { bytes, kind, dropped } = await sourceOf(draft, deps);
  const { pages } = await client.open(bytes, kind);
  if (kind === 'engine' || kind === 'post') client.saved?.(bytes, kind, draft.engine?.stamp ?? null);
  return { pages, kind, dropped };
}

/** Moves `draft` (changed in place) into the canvas editor: opens it in the engine and takes the engine's first save → {record,
 * pages, dropped}, the record's JSON text for the caller to store. */
export async function toCanvas(client, draft, deps) {
  const { pages, dropped } = await openDraft(client, draft, deps);
  return { record: adopt(draft, await client.save('engine')), pages, dropped };
}

/** Moves `draft` back to the DOM editor: the engine writes .docx and `read(bytes)` (reader.js readWordFile's {doc, dropped}) reads
 * it → {draft, dropped}, a new record without the engine form. Its undo history belongs to the old doc: the caller clears it. */
export async function toDom(client, draft, { read }) {
  const { doc, dropped = [] } = await read(await client.save('docx'));
  const { engine, ...rest } = draft;
  return { draft: { ...rest, doc, formatVersion: DOM_VERSION }, dropped };
}
