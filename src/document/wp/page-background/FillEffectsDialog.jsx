// Word's Fill Effects dialog (Page Color > Fill Effects..., probe/dialogs/fill-effects.json): Gradient, Texture, Pattern and Picture
// tabs with a Sample. It returns the fill ({kind, ...}); unless opened in value mode ({mode: 'value', value}: Shape Fill and other
// owners keep the value) it also writes it as the page's background fill. Textures and patterns are our own tiles, never Word's.
// {page: true} in value mode is the page's fill on a canvas draft (canvas/rows/page.mjs): transparency and rotation stay off.
import { useId, useState } from 'react';
import { cn } from 'cn';
import { activeSurface } from '../../../tooling/surface.js';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Check, Fieldset, Pick, Radio, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { Button } from '@/components/ui/button';
import { backgroundOf, setBackground } from './apply.js';
import { fillCss, GRADIENT_PRESETS, PATTERNS, SHADING_STYLES, TEXTURES, textureCss, patternCss } from './model.mjs';
import { pickPicture } from './WatermarkDialog.jsx';

const DEFAULTS = {
  gradient: { kind: 'gradient', colors: 'one', color1: '#4472C4', color2: '#FFFFFF', shade: 0.5, preset: 'earlySunset', from: 0, to: 0,
    style: 'horizontal', variant: 0 },
  texture: { kind: 'texture', texture: 'papyrus', src: null },
  pattern: { kind: 'pattern', pattern: 'pct5', fg: '#000000', bg: '#FFFFFF' },
  picture: { kind: 'picture', src: null, lockAspect: false },
};
const kindOf = (f) => f?.kind ?? f?.type ?? null;

/** The CSS of a fill as React style. */
const styleOf = (f) => {
  const c = fillCss(f);
  return c ? { backgroundImage: c.image, backgroundSize: c.size, backgroundRepeat: c.repeat, backgroundPosition: c.position ?? '0 0' } : {};
};

/** Writes `fill` as the page's background fill: patched over a fill of the same kind, replacing one of another kind (its keys
 * would mean nothing to this one). */
export function setFill(ed, fill) {
  const old = backgroundOf(ed).fill;
  const clear = old && kindOf(old) !== fill.kind ? Object.fromEntries(Object.keys(old).map((k) => [k, null])) : {};
  return setBackground(ed, { fill: { ...clear, ...fill } });
}

/** A tile button in a picker grid. */
const Tile = ({ label, active, style, onPick, className }) => (
  <button type="button" aria-label={label} title={label} aria-pressed={active} onClick={onPick} style={style}
    className={cn('h-8 border border-neutral-400 outline-none focus-visible:ring-2 focus-visible:ring-ring/50', active && 'ring-2 ring-primary', className)} />
);

/** → the fill, or null on Cancel. */
export function FillEffectsDialog({ mode, value, tab, page, onClose }) {
  const ed = activeSurface()?.editor ?? null;
  const start = value ?? (mode === 'value' ? null : backgroundOf(ed).fill) ?? null;
  // A shape's fill takes transparency and turns with the shape; a page's does neither.
  const shapeFill = mode === 'value' && !page;
  const id = useId();
  const [at, setAt] = useState(tab ?? kindOf(start) ?? 'gradient');
  // One draft per tab, so switching tabs keeps each tab's choices; OK returns the shown tab's.
  const [fills, setFills] = useState(() => ({ ...DEFAULTS, ...(kindOf(start) && { [kindOf(start)]: { ...DEFAULTS[kindOf(start)], ...start, kind: kindOf(start) } }) }));
  const f = fills[at];
  const set = (key) => (v) => setFills((o) => ({ ...o, [at]: { ...o[at], [key]: v } }));
  const pickInto = async (key) => {
    const src = await pickPicture();
    if (src) set(key)(src);
  };

  const sample = (
    <div className="flex flex-col gap-1">
      <span>Sample:</span>
      <div data-fill-sample="" className="h-24 w-24 border border-neutral-400 bg-white" style={styleOf(f)} />
    </div>
  );
  // Every tab ends with Rotate fill effect with shape, which only a shape's fill (value mode) uses; a page has no rotation.
  const withSample = (body) => (
    <div className="flex flex-col gap-3">
      <div className="flex gap-4"><div className="flex min-w-0 flex-1 flex-col gap-3">{body}</div>{sample}</div>
      <Check label="Rotate fill effect &with shape" checked={!!f.rotateWithShape} onChange={set('rotateWithShape')} disabled={!shapeFill} />
    </div>
  );

  const variants = f.style === 'fromCenter' ? [0, 1] : [0, 1, 2, 3];
  const gradient = () => withSample(<>
    <Fieldset legend="Colors">
      <div className="flex gap-6">
        <Radio name={`${id}-c`} value={f.colors} options={[['one', 'O&ne color'], ['two', '&Two colors'], ['preset', 'Pre&set']]} onChange={set('colors')} />
        <div className="flex flex-col gap-2">
          {f.colors !== 'preset' && <Row label="Color &1:" htmlFor={`${id}-c1`}><ColorPick id={`${id}-c1`} value={f.color1} automatic={null} onChange={(h) => h && set('color1')(h)} /></Row>}
          {f.colors === 'two' && <Row label="Color &2:" htmlFor={`${id}-c2`}><ColorPick id={`${id}-c2`} value={f.color2} automatic={null} onChange={(h) => h && set('color2')(h)} /></Row>}
          {f.colors === 'one' && (
            <Row label="Dar&k" htmlFor={`${id}-shade`}>
              <input id={`${id}-shade`} type="range" min="0" max="100" value={Math.round((f.shade ?? 0.5) * 100)} onChange={(e) => set('shade')(+e.target.value / 100)} className="accent-primary" />
              <span>Light</span>
            </Row>
          )}
          {f.colors === 'preset' && (
            <Row label="Preset colors:" htmlFor={`${id}-preset`}>
              <Pick id={`${id}-preset`} value={f.preset} options={GRADIENT_PRESETS.map(([v, l]) => [v, l])} onChange={set('preset')} />
            </Row>
          )}
        </div>
      </div>
    </Fieldset>
    <Fieldset legend="Transparency">
      {/* Word turns transparency off for a page fill; a native disabled fieldset turns off the spin boxes and their arrows. */}
      <fieldset disabled={!shapeFill} className="flex min-w-0 flex-col gap-2 disabled:opacity-50">
        <Spin label="F&rom:" value={f.from} onChange={(v) => set('from')(v ?? 0)} unit="pct" min={0} max={100} step={1} />
        <Spin label="T&o:" value={f.to} onChange={(v) => set('to')(v ?? 0)} unit="pct" min={0} max={100} step={1} />
      </fieldset>
    </Fieldset>
    <div className="flex gap-6">
      <Fieldset legend="Shading styles">
        <Radio name={`${id}-s`} value={f.style} options={SHADING_STYLES} onChange={(s) => setFills((o) => ({ ...o, gradient: { ...o.gradient, style: s, variant: 0 } }))} />
      </Fieldset>
      <Fieldset legend="V&ariants">
        <div className="grid grid-cols-2 gap-1">
          {variants.map((n) => <Tile key={n} label={`Variant ${n + 1}`} active={(f.variant ?? 0) === n} className="h-14 w-20" style={styleOf({ ...f, variant: n })} onPick={() => set('variant')(n)} />)}
        </div>
      </Fieldset>
    </div>
  </>);

  const texture = () => withSample(<>
    <span {...accessProps('&Texture:')}><AccessText label="&Texture:" /></span>
    <div role="listbox" className="grid grid-cols-6 gap-1">
      {TEXTURES.map(([tid, label]) => {
        const c = textureCss({ texture: tid });
        return <Tile key={tid} label={label} active={!f.src && f.texture === tid} style={{ backgroundImage: c.image, backgroundSize: c.size }}
          onPick={() => setFills((o) => ({ ...o, texture: { ...o.texture, texture: tid, src: null } }))} />;
      })}
    </div>
    <div className="h-6 rounded-sm border px-1.5 py-1">{f.src ? 'Other texture' : TEXTURES.find(([t]) => t === f.texture)?.[1]}</div>
    <Button type="button" variant="outline" size="xs" className="w-fit" onClick={() => pickInto('src')} {...accessProps('&Other Texture...')}>
      <AccessText label="&Other Texture..." />
    </Button>
  </>);

  const pattern = () => withSample(<>
    <span {...accessProps('Pa&ttern:')}><AccessText label="Pa&ttern:" /></span>
    {/* Word's grid reads column by column: eight columns of six. */}
    <div role="listbox" className="grid grid-flow-col grid-rows-6 gap-0.5" style={{ gridTemplateColumns: 'repeat(8, 2.5rem)' }}>
      {PATTERNS.map(([pid, label]) => {
        const c = patternCss({ pattern: pid, fg: '#000000', bg: '#FFFFFF' });
        return <Tile key={pid} label={label} active={f.pattern === pid} className="h-6" style={{ backgroundImage: c.image, backgroundSize: c.size }}
          onPick={() => set('pattern')(pid)} />;
      })}
    </div>
    <div className="h-6 rounded-sm border px-1.5 py-1">{PATTERNS.find(([p]) => p === f.pattern)?.[1]}</div>
    <div className="flex gap-6">
      <Row label="&Foreground:" htmlFor={`${id}-fg`}><ColorPick id={`${id}-fg`} value={f.fg} automatic={null} onChange={(h) => h && set('fg')(h)} /></Row>
      <Row label="&Background:" htmlFor={`${id}-bg`}><ColorPick id={`${id}-bg`} value={f.bg} automatic={null} onChange={(h) => h && set('bg')(h)} /></Row>
    </div>
  </>);

  const picture = () => withSample(<>
    <div className="flex h-40 items-center justify-center border bg-white">{f.src ? <img src={f.src} alt="" className="max-h-full max-w-full object-contain" /> : null}</div>
    <span>Picture:</span>
    <Button type="button" variant="outline" size="xs" className="w-fit" onClick={() => pickInto('src')} {...accessProps('Se&lect Picture...')}>
      <AccessText label="Se&lect Picture..." />
    </Button>
    <Check label="Lock &picture aspect ratio" checked={!!f.lockAspect} onChange={set('lockAspect')} disabled={!f.src} />
  </>);

  const result = () => {
    const out = { ...f, kind: at };
    if (mode !== 'value') setFill(ed, out);
    return out;
  };
  return (
    <WordDialog title="Fill Effects" size="lg" tab={at} onTab={setAt} onClose={onClose} result={result}
      validate={() => (at === 'picture' && !f.src ? 'Select a picture first.' : null)}
      tabs={[{ id: 'gradient', label: 'Gradient', render: gradient }, { id: 'texture', label: 'Texture', render: texture },
        { id: 'pattern', label: 'Pattern', render: pattern }, { id: 'picture', label: 'Picture', render: picture }]} />
  );
}
