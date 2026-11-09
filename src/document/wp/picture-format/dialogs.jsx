// Picture Format's dialogs (plan.md §1.6): Compress Pictures (probe dialogs/compress-pictures.json), Insert Picture (the system file
// pick through api.word.openFile), Insert Pictures (the source picker Shape Fill > Picture opens; resolves {src, name}), and the three
// Options dialog ids, which Word shows as the Format Picture pane: they open the pane at their section and close.
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getState } from '../../../app/store.js';
import { openPane } from '../../../tooling/panes.jsx';
import { REASONS } from '../../../tooling/reasons.mjs';
import { Check, Fieldset, Radio } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { activeSurface } from '../../../tooling/surface.js';
import { loaded, pickPicture } from './edit.js';
import { compressSize, cropShare, RESOLUTIONS } from './pictures.mjs';

/** An Options dialog id that opens the Format Picture pane at `section` instead (Word shows these as the pane). */
export const paneDialog = (section) => function PaneRedirect({ onClose }) {
  useEffect(() => {
    openPane('formatPicture', { section });
    onClose(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
};

/** Insert Picture: the system open dialog for pictures → {src, name} or null. */
export function InsertPicture({ onClose }) {
  useEffect(() => {
    pickPicture().then((r) => onClose(r), () => onClose(null));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Insert Pictures: From a file, with the online sources as cloud placeholders → {src, name} or null. */
export function InsertPictures({ onClose }) {
  const [busy, setBusy] = useState(false);
  const fromFile = async () => {
    setBusy(true);
    const r = await pickPicture();
    setBusy(false);
    if (r) onClose(r);
  };
  const cloud = (label) => (
    <Button type="button" variant="outline" size="sm" disabled title={REASONS.cloud} className="justify-start">{label}</Button>
  );
  return (
    <WordDialog title="Insert Pictures" size="sm" okText="Cancel" cancelText={null} result={() => null} onClose={onClose}>
      <div className="flex flex-col gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={fromFile} className="justify-start">From a file</Button>
        {cloud('Stock Images')}
        {cloud('Online Pictures')}
        {cloud('From Icons')}
      </div>
    </WordDialog>
  );
}

// ---------- Compress Pictures ----------
const LEVELS = [['hifi', 'High &fidelity: preserves quality of the original picture'], ['hd', '&HD (330 ppi): good quality for high-definition (HD) displays'],
  ['print', '&Print (220 ppi): excellent quality on most printers and screens'], ['web', '&Web (150 ppi): good for web pages and projectors'],
  ['email', '&E-mail (96 ppi): minimize document size for sharing'], ['default', '&Use default resolution']];

/** Whether `img` has any pixel that is not opaque (sampled on a canvas at most 256 px across). */
function hasAlpha(img) {
  const k = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(img.naturalWidth * k));
  cv.height = Math.max(1, Math.round(img.naturalHeight * k));
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, cv.width, cv.height);
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

/** The compressed attributes of picture `attrs` at `ppi` (null keeps the pixels), baking the crop when `bake` → a patch or null. The
 * new src is used only when it is shorter, unless the crop was baked. */
async function compressOne(attrs, ppi, bake) {
  if (/^data:image\/svg/i.test(attrs.src ?? '') || attrs.metafile) return null; // Word compresses no vector picture
  const img = await loaded(attrs.src);
  const c = { t: 0, r: 0, b: 0, l: 0, ...(attrs.crop ?? {}) };
  const cropped = bake && ['t', 'r', 'b', 'l'].some((k) => c[k] > 0);
  const [fw, fh] = cropped ? cropShare(c) : [1, 1];
  const sx = cropped ? Math.max(0, c.l) * img.naturalWidth : 0;
  const sy = cropped ? Math.max(0, c.t) * img.naturalHeight : 0;
  const sw = img.naturalWidth * Math.min(1, fw);
  const sh = img.naturalHeight * Math.min(1, fh);
  // CSS px are 96 to the inch, so the drawn width in inches is width / 96.
  const w = ppi ? compressSize(Math.round(sw), (attrs.width ?? sw) / 96, ppi) : Math.round(sw);
  if (w >= Math.round(sw) && !cropped) return null;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = Math.max(1, Math.round((sh * w) / sw));
  cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  const src = hasAlpha(img) ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.85);
  if (!cropped && src.length >= attrs.src.length) return null;
  const patch = { src };
  if (cropped) patch.crop = c.shape ? { shape: c.shape } : null;
  return patch;
}

/** Compresses the pictures of `ed` (only the one at `pos` when `only`) at `level`, baking crops when `bake`, in one transaction. */
export async function compressAll(ed, { pos, only = true, bake = true, level = 'default' }) {
  const ppi = RESOLUTIONS[level];
  const targets = [];
  ed.state.doc.descendants((n, p) => {
    if (n.type.name === 'image' && (!only || p === pos)) targets.push([p, n]);
  });
  const patches = await Promise.all(targets.map(([, n]) => compressOne(n.attrs, ppi, bake).catch(() => null)));
  if (ed.isDestroyed) return false;
  const tr = ed.state.tr;
  targets.forEach(([p, n], i) => {
    // The document may have changed while the pictures were drawn: only a picture still holding the same src is rewritten.
    if (!patches[i] || tr.doc.nodeAt(p)?.attrs.src !== n.attrs.src) return;
    for (const [k, v] of Object.entries(patches[i])) tr.setNodeAttribute(p, k, v);
  });
  if (tr.docChanged) ed.view.dispatch(tr);
  return tr.docChanged;
}

/** Compress Pictures. OK is the confirmation: it rewrites the pictures' data in one undo step. Props: {pos} of the selected picture,
 * or on a canvas draft `apply`, which runs the engine's picture.compress with {ppi, deleteCropped, all}. */
export function CompressPictures({ pos, apply, onClose }) {
  const [only, setOnly] = useState(true);
  const [bake, setBake] = useState(true);
  const [level, setLevel] = useState('default');
  const ed = activeSurface()?.story?.editor ?? getState().editor;
  return (
    <WordDialog title="Compress Pictures" size="sm" onClose={onClose} result={() => {
      if (apply) apply({ ...(RESOLUTIONS[level] && { ppi: RESOLUTIONS[level] }), deleteCropped: bake, all: !only });
      else if (ed) compressAll(ed, { pos, only, bake, level });
      return true;
    }}>
      <Fieldset legend="Compression options">
        <Check label="&Apply only to this picture" checked={only} onChange={setOnly} />
        <Check label="&Delete cropped areas of pictures" checked={bake} onChange={setBake} />
      </Fieldset>
      <Fieldset legend="Resolution">
        <Radio value={level} options={LEVELS} onChange={setLevel} name="compress-resolution" />
      </Fieldset>
    </WordDialog>
  );
}
