// The Paste menu's Paste Options gallery (docs/plans/word plan.md §1.4, §3 clipboard): only the options that fit the clipboard,
// read through api.word.clipboard.read() (core.js snapshot). A pick runs home.clipboard.paste with the item id.
import { Clipboard, ClipboardType, Image, Palette, Pilcrow, Type } from 'lucide-react';
import { commandOf } from '../../../tooling/registry.js';
import { docKey, snapshot, sourceOf } from './core.js';
import { availableModes, LABELS, LETTERS, sourceKind } from './modes.mjs';

const ICONS = { keepSourceFormatting: Clipboard, mergeFormatting: ClipboardType, useDestinationStyles: Pilcrow, useDestinationTheme: Palette,
  picture: Image, keepTextOnly: Type };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The gallery items for `ctx` → GalleryItem[]: an icon with Word's label and letter (the label hides in a grid view). */
export function pasteGallery(ctx) {
  const snap = snapshot();
  const kind = sourceKind(snap);
  if (!kind) return [];
  const src = sourceOf(snap);
  const doc = ctx.ed?.state.doc;
  const other = !!src && !!doc && src.docKey !== docKey(ctx.ed.view);
  // The menu has no parsed slice, so any style both sides define differently counts (the button checks the pasted styles only).
  const a = src?.styles?.list ?? {};
  const b = doc?.attrs.styles?.list ?? {};
  const stylesDiffer = other && Object.keys(a).some((id) => b[id] && !same(a[id], b[id]));
  const themeDiffer = other && !same(src.theme, doc.attrs.theme);
  return availableModes(kind, { stylesDiffer, themeDiffer, picture: !!commandOf('paste.pastePicture') }).map((id) => {
    const Icon = ICONS[id];
    const label = `${LABELS[id]} (${LETTERS[id]})`;
    return {
      id, label,
      preview: <span className="flex items-center gap-2" title={label}><Icon className="size-4" /><span className="in-[.grid]:sr-only">{label}</span></span>,
    };
  });
}
