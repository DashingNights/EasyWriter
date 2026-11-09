// The user's own building blocks on a canvas draft (engine-gaps-rest): they live in the app's store as Document-schema content,
// outside the draft, so the engine cannot name them. F3 and the galleries put one in by pasting its content as HTML at the
// engine's selection, as the Spike does (clipboard/index.js). The document's own blocks stay the engine's (insert.buildingBlock).
import { DOMSerializer } from '@tiptap/pm/model';
import { run } from '../../canvas/rows/references.mjs';
import { matchAutoText } from './blocks.mjs';
import { entries } from './store.js';

// Loaded late: editors.js imports the module list this module is part of.
const schemaNow = async () => (await import('../../../editors.js')).kitOf('document').schema;
const bytes = (s) => new TextEncoder().encode(s).length;

/** Block `entry`'s content as HTML. */
async function htmlOf(entry) {
  const doc = (await schemaNow()).nodeFromJSON({ type: 'doc', content: entry.content });
  const el = document.createElement('div');
  el.append(DOMSerializer.fromSchema(doc.type.schema).serializeFragment(doc.content));
  return el.innerHTML;
}

/** Puts the user's block `entry` at the engine's selection, after engine steps `before` ([[id, args]]), as one undo step through
 * the row's run(): a refusal takes every step back and says why → whether it did. */
export const pasteEntry = async (ctx, entry, before = []) => run(ctx, [...before, ['edit.paste', { html: await htmlOf(entry) }]]);

/** F3 on a canvas draft: the document's own block named before the caret (insert.autoTextF3), else the user's, which replaces
 * the name the way Word's does. */
export async function autoTextF3(ctx) {
  const own = await ctx.engine.exec('insert.autoTextF3', {});
  if (own?.ok !== false) return true;
  if (!/no building block/i.test(own?.error ?? '')) return (ctx.toast(own?.error ?? 'No building block has that name.'), false);
  const q = (await ctx.engine.query('insert.textBeforeCaret', {}))?.value;
  const hit = matchAutoText(entries(), q?.text ?? '');
  if (hit.error) {
    ctx.toast(hit.error === 'ambiguous' ? 'More than one building block starts with that text. Type more of the name.' : 'No building block has that name.');
    return true;
  }
  const at = q.at;
  const from = { ...at, off: at.off - bytes(q.text.slice(hit.start)) };
  return pasteEntry(ctx, hit.entry, [['select.range', { anchor: from, focus: at }]]);
}

/** The user's blocks of Word gallery `gallery` as canvas gallery items (`run` pastes the block). */
export const userGalleryItems = (gallery, preview, flat) => entries()
  .filter((e) => e.gallery === gallery)
  .map((e) => ({ id: `bb:${e.id}`, label: e.name, group: e.category, preview: preview(e.name, flat(e.content).slice(0, 60)), run: (ctx) => pasteEntry(ctx, e) }));

/** A canvas gallery pick `arg` that names one of the user's blocks (`bb:<id>`) → pasted, or null for another pick. */
export function pickUserEntry(ctx, arg) {
  const e = typeof arg === 'string' && arg.startsWith('bb:') ? entries().find((x) => `bb:${x.id}` === arg) : null;
  return e ? pasteEntry(ctx, e) : null;
}
