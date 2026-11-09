// Word's Printed Watermark dialog (Design > Watermark > Custom Watermark..., probe/dialogs/printed-watermark.json): no watermark,
// a picture (scale, washout) or a text (language, text, font, size, colour, semitransparent, diagonal or horizontal). Apply writes
// and stays open; OK writes and closes. It writes through apply.js, so the selection's section and the linked ones after it get it.
// On a canvas draft (`engine`: {now: the engine's design.watermark value, write(wm)}, canvas/rows/page.mjs) it writes the engine's
// one watermark for the document, a picture one too (engine-gaps-rest), with the text's language.
import { useId, useState } from 'react';
import { activeSurface } from '../../../tooling/surface.js';
import { Input } from '@/components/ui/input';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Check, Pick, Radio, Row } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { Button } from '@/components/ui/button';
import { FONTS } from '../../../office.mjs';
import { bodyFont, setWatermark, watermarkNow } from './apply.js';
import { WATERMARK_SCALES, WATERMARK_SIZES, WATERMARK_TEXTS } from './model.mjs';
import { PICTURE_ACCEPT } from '../../../tooling/metafile.mjs';
import { shownPicture } from '../picture-format/edit.js';

/** Asks for a picture through a hidden file input, read as a data URL, as tools.js's Pictures does → the data URL or null. A
 * watermark and a page fill hold no metafile original, so an EMF or WMF comes in as a PNG of its drawing (shownPicture).
 * Harness cases stub it through window.__wordTest.pickPicture (the native file dialog cannot be driven). */
export function pickPicture() {
  const stub = globalThis.__wordTest?.pickPicture;
  if (stub) return Promise.resolve(typeof stub === 'function' ? stub() : stub);
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: PICTURE_ACCEPT });
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? (await shownPicture(file))?.src ?? null : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// A few of Word's 211 languages: the text watermark's language is stored only (it picks Word's spelling of the text list).
const LANGUAGES = ['en-US', 'en-GB', 'en-HK', 'zh-HK', 'zh-TW', 'zh-CN', 'fr-FR', 'de-DE', 'es-ES', 'ja-JP'];
const langName = (tag) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
  } catch {
    return tag;
  }
};

/** Word's editable combo box: a text box over a list it suggests. */
function Combo({ id, value, items, onChange, disabled, width = '100%' }) {
  const list = `${id}-list`;
  return (
    <>
      <Input id={id} list={list} value={value} disabled={disabled} spellCheck={false} onChange={(e) => onChange(e.target.value)} style={{ width }} size="xs" />
      <datalist id={list}>{items.map((v) => <option key={v} value={v} />)}</datalist>
    </>
  );
}

const auto = (v, unit = '') => (v == null ? 'Auto' : `${v}${unit}`);
/** 'Auto' (or empty) → null, '72' or '72%' → 72, anything else → undefined (invalid). */
const parseAuto = (s) => {
  const t = String(s ?? '').trim();
  if (!t || /^auto$/i.test(t)) return null;
  const n = Number(t.replace(/%$/, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** The engine's watermark (design.watermark's value) in the dialog's form. A picture the engine holds shows as ENGINE_PICTURE (its
 * bytes stay in the engine; a new pick is a data URL). */
export const ENGINE_PICTURE = 'engine:picture';
const fromEngine = (w) => (!w ? null : w.picture ? { kind: 'picture', src: ENGINE_PICTURE, scale: w.picture.scale ?? null, washout: !!w.picture.washout, lang: w.lang ?? undefined }
  : { kind: 'text', text: w.text, font: w.font, size: w.size ?? null, color: `#${w.color ?? 'C0C0C0'}`, semi: !!w.semitransparent,
    layout: w.diagonal ? 'diagonal' : 'horizontal', lang: w.lang ?? undefined });

/** → the written watermark, null for No watermark, or null on Cancel. */
export function WatermarkDialog({ engine = null, onClose }) {
  const ed = engine ? null : activeSurface()?.editor ?? null;
  const now = engine ? fromEngine(engine.now) : watermarkNow(ed);
  const id = useId();
  const [v, setV] = useState(() => ({
    mode: now?.kind ?? 'none',
    src: now?.src ?? null,
    scale: auto(now?.scale, '%'),
    washout: now?.washout ?? true,
    lang: now?.lang ?? 'en-US',
    text: now?.text ?? 'ASAP',
    font: now?.font ?? bodyFont(ed),
    size: auto(now?.size),
    color: now?.color ?? '#000000',
    semi: now?.semi ?? true,
    layout: now?.layout ?? 'diagonal',
  }));
  const set = (key) => (value) => setV((o) => ({ ...o, [key]: value }));
  const pic = v.mode === 'picture';
  const txt = v.mode === 'text';

  const build = () => (v.mode === 'none' ? null : pic
    ? { kind: 'picture', src: v.src, scale: parseAuto(v.scale) ?? null, washout: v.washout }
    : { kind: 'text', lang: v.lang, text: v.text.trim(), font: v.font.trim() || bodyFont(ed), size: parseAuto(v.size) ?? null, color: v.color,
      semi: v.semi, layout: v.layout });
  const validate = () => {
    if (pic && !v.src) return 'Select a picture first.';
    if (txt && !v.text.trim()) return 'Type the watermark text.';
    if (txt && parseAuto(v.size) === undefined) return 'The size must be a number or Auto.';
    if (pic && parseAuto(v.scale) === undefined) return 'The scale must be a percent or Auto.';
    return null;
  };
  const write = () => {
    const wm = build();
    if (engine) engine.write(wm);
    else setWatermark(ed, wm);
    return wm;
  };
  const choose = async () => {
    const src = await pickPicture();
    if (src) setV((o) => ({ ...o, src, mode: 'picture' }));
  };

  return (
    <WordDialog title="Printed Watermark" size="md" onClose={onClose} validate={validate} result={write}
      left={[{ label: '&Apply', disabled: (pic && !v.src) || (txt && !v.text.trim()), onClick: () => !validate() && write() }]}>
      <div data-dialog-id="printedWatermark" className="flex flex-col gap-2 text-xs">
        <Radio name={id} value={v.mode} options={[['none', '&No watermark']]} onChange={set('mode')} />
        <Radio name={id} value={v.mode} options={[['picture', 'P&icture watermark']]} onChange={set('mode')} />
        <div className="flex flex-col gap-2 pl-6">
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="xs" disabled={!pic} onClick={choose} {...accessProps('Select &Picture...')}>
              <AccessText label="Select &Picture..." />
            </Button>
            {pic && v.src && v.src !== ENGINE_PICTURE && <img src={v.src} alt="" className="h-6 max-w-16 object-contain" />}
          </div>
          <div className="flex items-center gap-4">
            <Row label="Sca&le:" htmlFor={`${id}-scale`}>
              <Combo id={`${id}-scale`} value={v.scale} items={WATERMARK_SCALES.map((s) => auto(s, '%'))} onChange={set('scale')} disabled={!pic} width="7rem" />
            </Row>
            <Check label="&Washout" checked={v.washout} onChange={set('washout')} disabled={!pic} />
          </div>
        </div>
        <Radio name={id} value={v.mode} options={[['text', 'Te&xt watermark']]} onChange={set('mode')} />
        <div className="flex flex-col gap-2 pl-6">
          <Row label="&Language:" htmlFor={`${id}-lang`}>
            <Pick id={`${id}-lang`} value={v.lang} disabled={!txt} options={LANGUAGES.map((l) => [l, langName(l)])} onChange={set('lang')} className="w-full" />
          </Row>
          <Row label="&Text:" htmlFor={`${id}-text`}>
            <Combo id={`${id}-text`} value={v.text} items={WATERMARK_TEXTS} onChange={set('text')} disabled={!txt} />
          </Row>
          <Row label="&Font:" htmlFor={`${id}-font`}>
            <Combo id={`${id}-font`} value={v.font} items={FONTS} onChange={set('font')} disabled={!txt} />
          </Row>
          <Row label="&Size:" htmlFor={`${id}-size`}>
            <Combo id={`${id}-size`} value={v.size} items={WATERMARK_SIZES.map((s) => auto(s))} onChange={set('size')} disabled={!txt} width="7rem" />
          </Row>
          <div className="flex items-center gap-4">
            {/* A native disabled fieldset turns off the picker's button, which takes no disabled prop. */}
            <fieldset disabled={!txt} className="min-w-0 disabled:opacity-50">
              <Row label="&Color:" htmlFor={`${id}-color`}>
                <ColorPick id={`${id}-color`} value={v.color} automatic={null} onChange={(hex) => hex && set('color')(hex)} />
              </Row>
            </fieldset>
            <Check label="S&emitransparent" checked={v.semi} onChange={set('semi')} disabled={!txt} />
          </div>
          <Row label="Layout:">
            <div className={txt ? 'flex gap-4' : 'pointer-events-none flex gap-4 opacity-50'}>
              <Radio name={`${id}-layout`} value={v.layout} options={[['diagonal', '&Diagonal']]} onChange={set('layout')} />
              <Radio name={`${id}-layout`} value={v.layout} options={[['horizontal', '&Horizontal']]} onChange={set('layout')} />
            </div>
          </Row>
        </div>
      </div>
    </WordDialog>
  );
}
