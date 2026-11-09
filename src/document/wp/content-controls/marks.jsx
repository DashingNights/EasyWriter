// Marks drawn over a canvas draft's pages (docs/plans/engine/stage2/gaps.md fields-core and content-controls, G21): field
// shading as the app's setting says (never, always, when selected), legacy form fields' grey while Form Field Shading is on (the
// document's setting, developer.formShading), and content controls' tags while Ctrl+Shift+X shows them. The engine gives the
// ranges (fields.ranges, developer.ranges) and their boxes (rects, caret); React draws them, as the comment cards are.
import { useSyncExternalStore } from 'react';
import { afterTyping, getState, subscribe } from '../../../app/store.js';
import { ptBox, registerOverlay } from '../../canvas/overlay.jsx';
import { publish, sessionRecords } from '../../canvas/records.js';
import { hooks } from '../../canvas/rows/references.mjs';
import { wordSettings } from '../../word/settings.mjs';

// ponytail: each range is one rects call; a document with thousands of fields shown with Always reads them all after each pause
// in typing. Ask the engine for the shown pages' ranges only if that shows.
const MAX_RANGES = 500;

let tags = false;

/** Draws every session's marks again from the engine. */
function redraw() {
  for (const d of records.each()) {
    d.full = true;
    refresh(d);
  }
}

/** Shows or hides the content controls' tags (Ctrl+Shift+X) → true. */
function toggleTags() {
  tags = !tags;
  redraw();
  return true;
}
Object.assign(hooks, { toggleTags, tagsShown: () => tags });

/** The boxes of `ranges` ([{anchor, head}]) → [{page, x, y, w, h}]. */
async function boxesOf(d, ranges) {
  const out = [];
  for (const r of (ranges ?? []).slice(0, MAX_RANGES)) if (!d.gone) out.push(...((await d.client.rects(r.anchor, r.head)) ?? []));
  return out;
}

/** Engine call `id` on record `d` → its value, or null (none once the record is let go). */
const value = async (d, id, args = {}) => {
  if (d.gone) return null;
  const r = await d.client.exec(id, args);
  return r?.ok ? r.value : null;
};

async function refresh(d) {
  if (d.busy) {
    d.again = true;
    return;
  }
  d.busy = true;
  try {
    do {
      d.again = false;
      const { client } = d;
      const shading = wordSettings(getState().settings).fieldShading ?? 'selected';
      const fieldRanges = shading === 'never' ? [] : await value(d, 'fields.ranges', { all: shading === 'always' });
      const fields = await boxesOf(d, fieldRanges);
      // A caret move changes only which fields are selected: the form fields and the tags wait for an edit (the whole story's
      // scan, about the size of a find on a long document).
      if (d.full) {
        d.full = false;
        const formsOn = !(await value(d, 'document.settings'))?.noFormShading;
        // The engine answers at once for a story with no form field (fields.ranges' forms check).
        const formRanges = formsOn ? await value(d, 'fields.ranges', { all: true, forms: true }) : [];
        const controls = tags ? (await value(d, 'developer.ranges')) ?? [] : [];
        const tagMarks = [];
        for (const c of controls.slice(0, MAX_RANGES)) {
          if (d.gone) break;
          const name = c.title || c.tag || c.kind;
          const [a, b] = [await client.caret(c.start), await client.caret(c.end)];
          if (a) tagMarks.push({ ...a, label: name, open: true });
          if (b) tagMarks.push({ ...b, label: name, open: false });
        }
        d.marks = { ...d.marks, forms: await boxesOf(d, formRanges), tags: tagMarks };
      }
      if (d.gone) return;
      d.marks = { ...d.marks, fields };
      publish(d, d.marks);
    } while (d.again);
  } catch {
    // The page area let the session go (a draft switch) while this read it: a watcher's calls fail then, and nothing is drawn.
  } finally {
    d.busy = false;
  }
}

// Session `id`'s record {id, client, marks: {fields, forms, tags}, version, fns}, following its edits and selection once typing
// pauses, held by the session's drawn pages (canvas/records.js): its client is the record's own watcher, released with it.
const records = sessionRecords('marks', (client, id) => {
  const d = { id, client, marks: { fields: [], forms: [], tags: [] }, version: 0, fns: new Set(), busy: false, again: false, full: true };
  for (const event of ['layout', 'selection', 'command', 'reopened']) {
    client.on(event, () => {
      if (event !== 'selection') d.full = true;
      afterTyping(() => !d.gone && refresh(d));
    });
  }
  refresh(d);
  return d;
});

const FIELD = { background: 'rgba(0, 0, 0, 0.12)' };
const FORM = { background: 'rgba(0, 0, 0, 0.18)' };
const TAG = { position: 'absolute', fontSize: 9, lineHeight: '12px', padding: '0 3px', color: '#7a2a52', background: '#f9e1ee',
  border: '1px solid #c46a98', borderRadius: 2, whiteSpace: 'nowrap', pointerEvents: 'none' };

/** The marks on page `page` of session `session` at `k` CSS px per point. */
function CanvasMarks({ session, page, k }) {
  const d = records.use(session);
  useSyncExternalStore((fn) => (d ? (d.fns.add(fn), () => d.fns.delete(fn)) : () => {}), () => d?.version ?? 0);
  if (!d) return null;
  const on = (m) => m.page === page;
  const { fields, forms, tags: tagMarks } = d.marks;
  return (
    <>
      {forms.filter(on).map((m, i) => <div key={`fo${i}`} data-mark="formShading" style={{ ...ptBox(m, k), ...FORM }} />)}
      {fields.filter(on).map((m, i) => <div key={`fi${i}`} data-mark="fieldShading" style={{ ...ptBox(m, k), ...FIELD }} />)}
      {tagMarks.filter(on).map((m, i) => (
        <div key={`t${i}`} data-mark="xmlTag" style={{ ...TAG, left: m.x * k, top: m.y * k, transform: m.open ? 'translateX(-100%)' : undefined }}>
          {m.open ? m.label : `/${m.label}`}
        </div>
      ))}
    </>
  );
}

registerOverlay('gaps-editing-marks', CanvasMarks);

// Field shading's setting changed (File > Options, Developer's menu): draw again.
let shadingWas = null;
subscribe(() => {
  const now = wordSettings(getState().settings).fieldShading;
  if (now === shadingWas) return;
  shadingWas = now;
  redraw();
});

// The harness's view of what is drawn (engine-gaps-editing).
if (typeof window !== 'undefined') {
  window.__gapsMarks = () => records.each().map((d) => ({ id: d.id, fields: d.marks.fields.length, forms: d.marks.forms.length,
    tags: d.marks.tags.length, busy: d.busy, version: d.version, shading: wordSettings(getState().settings).fieldShading }));
}
