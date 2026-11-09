// Format Text Effects (docs/plans/word/briefs/font.md; no probe capture, so the layout follows Word's pane from knowledge, v): Text
// Fill and Text Outline on one tab, Shadow, Reflection, Glow, Soft Edges and 3-D Format on the other. Writes textStyle `effects`
// {fill, outline, shadow, glow, reflection} (lengths in pt). Value mode ({mode: 'value', value}) returns the effects object (the
// Font dialog's Text Effects... button); otherwise OK applies it to the selection.
import { useMemo, useState } from 'react';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Check, Fieldset, Pick, Radio, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { REASONS } from '../../../tooling/reasons.mjs';
import { ctxOf } from '../../../tooling/registry.js';
import { applyRun, selectionRuns } from './commands.js';
import { changesOf, effectsCss, effectsOfEngine, textEffectsParams } from './run.mjs';

const DASHES = [['solid', 'Solid'], ['dot', 'Round Dot'], ['dash', 'Dash'], ['dashDot', 'Dash Dot'], ['longDash', 'Long Dash']];
const REFLECTIONS = [['none', 'None'], ['30', 'Tight'], ['50', 'Half'], ['90', 'Full']];

/** → the effects object in value mode, else true after applying it (null on Cancel). On a canvas draft the row passes the engine's
 * effects at the selection (`engineEffects`, format.state's textEffects: a selected WordArt shape's text too) and OK writes
 * format.textEffects. */
export function TextEffectsDialog({ mode, value, tab: openTab, onClose, engineEffects }) {
  const canvas = engineEffects !== undefined && mode !== 'value' && !!ctxOf().engine;
  const initial = useMemo(() => {
    if (mode === 'value') return value ?? {};
    if (canvas) return effectsOfEngine(engineEffects);
    const s = ctxOf().state;
    return (s && selectionRuns(s)[0]?.effects) ?? {};
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [e, setE] = useState(initial);
  const [tab, setTab] = useState(openTab === 'effects' ? 'effects' : 'fill');
  const put = (k, v) => setE((o) => ({ ...o, [k]: v }));
  const fill = e.fill ?? null;
  const outline = e.outline ?? null;
  const fillKind = fill?.type ?? null;
  const stops = fill?.stops ?? [{ pos: 0, color: '#FFFFFF' }, { pos: 100, color: '#156082' }];

  const fillTab = () => (
    <div data-text-effects="fill" className="flex flex-col gap-3">
      <Fieldset legend="Text Fill">
        <Radio name="te-fill" value={fillKind} onChange={(k) => put('fill', k === 'none' ? { type: 'none' } : k === 'solid' ? { type: 'solid', color: fill?.color ?? '#000000' }
          : { type: 'gradient', angle: fill?.angle ?? 90, stops })}
          options={[['none', '&No fill'], ['solid', '&Solid fill'], ['gradient', '&Gradient fill']]} />
        {fillKind === 'solid' && <Row label="&Color:" htmlFor="te-fill-color"><ColorPick id="te-fill-color" automatic={null} value={fill.color} onChange={(hex) => put('fill', { ...fill, color: hex })} /></Row>}
        {fillKind === 'gradient' && (
          <>
            <Row label="Stop &1:" htmlFor="te-stop1"><ColorPick id="te-stop1" automatic={null} value={stops[0].color} onChange={(hex) => put('fill', { ...fill, stops: [{ ...stops[0], color: hex }, stops[1]] })} /></Row>
            <Row label="Stop &2:" htmlFor="te-stop2"><ColorPick id="te-stop2" automatic={null} value={stops[1].color} onChange={(hex) => put('fill', { ...fill, stops: [stops[0], { ...stops[1], color: hex }] })} /></Row>
            <Spin label="&Angle:" value={fill.angle ?? 90} unit="int" min={0} max={359} step={15} onChange={(v) => put('fill', { ...fill, angle: v })} />
          </>
        )}
      </Fieldset>
      <Fieldset legend="Text Outline">
        {/* ponytail: a gradient line keeps its end colour but draws in its first colour, and dashes are stored but drawn solid:
            -webkit-text-stroke takes one colour and no dash pattern. Outline the glyphs as SVG if either matters. */}
        <Radio name="te-line" value={outline ? (outline.type === 'gradient' ? 'gradient' : 'solid') : 'none'}
          onChange={(k) => put('outline', k === 'none' ? null : {
            color: outline?.color ?? '#000000', width: outline?.width ?? 0.75, dash: outline?.dash ?? 'solid',
            ...(k === 'gradient' && { type: 'gradient', color2: outline?.color2 ?? '#156082' }),
          })}
          options={[['none', 'No &line'], ['solid', 'S&olid line'], ['gradient', 'Gradien&t line']]} />
        {outline && (
          <>
            <Row label="Colo&r:" htmlFor="te-line-color"><ColorPick id="te-line-color" automatic={null} value={outline.color} onChange={(hex) => put('outline', { ...outline, color: hex })} /></Row>
            {outline.type === 'gradient' && <Row label="&End color:" htmlFor="te-line-color2"><ColorPick id="te-line-color2" automatic={null} value={outline.color2} onChange={(hex) => put('outline', { ...outline, color2: hex })} /></Row>}
            <Spin label="&Width:" value={outline.width} unit="pt" min={0} max={1584} step={0.25} onChange={(v) => put('outline', { ...outline, width: v })} />
            <Row label="&Dash type:" htmlFor="te-dash"><Pick id="te-dash" value={outline.dash ?? 'solid'} options={DASHES} onChange={(v) => put('outline', { ...outline, dash: v })} /></Row>
          </>
        )}
      </Fieldset>
      <Sample e={e} />
    </div>
  );

  const shadow = e.shadow ?? null;
  const glow = e.glow ?? null;
  const reflection = e.reflection ?? null;
  const effectsTab = () => (
    <div data-text-effects="effects" className="flex flex-col gap-3">
      <Fieldset legend="Shadow">
        <Check label="&Shadow" checked={!!shadow} onChange={(on) => put('shadow', on ? { color: '#000000', alpha: 0.6, blur: 4, dist: 3, angle: 45 } : null)} />
        {shadow && (
          <div className="grid grid-cols-2 gap-2">
            <Row label="&Color:" htmlFor="te-sh-color"><ColorPick id="te-sh-color" automatic={null} value={shadow.color} onChange={(hex) => put('shadow', { ...shadow, color: hex })} /></Row>
            <Spin label="&Transparency:" value={Math.round((1 - (shadow.alpha ?? 0.6)) * 100)} unit="pct" min={0} max={100} onChange={(v) => put('shadow', { ...shadow, alpha: (100 - v) / 100 })} />
            <Spin label="&Blur:" value={shadow.blur} unit="pt" min={0} max={100} onChange={(v) => put('shadow', { ...shadow, blur: v })} />
            <Spin label="An&gle:" value={shadow.angle} unit="int" min={0} max={359} onChange={(v) => put('shadow', { ...shadow, angle: v })} />
            <Spin label="&Distance:" value={shadow.dist} unit="pt" min={0} max={200} onChange={(v) => put('shadow', { ...shadow, dist: v })} />
          </div>
        )}
      </Fieldset>
      <Fieldset legend="Reflection">
        <Row label="&Presets:" htmlFor="te-refl">
          <Pick id="te-refl" value={reflection ? String(reflection.size ?? 50) : 'none'} options={REFLECTIONS}
            onChange={(v) => put('reflection', v === 'none' ? null : { size: Number(v), dist: reflection?.dist ?? 0, alpha: reflection?.alpha ?? 0.5 })} />
        </Row>
        {reflection && <Spin label="D&istance:" value={reflection.dist ?? 0} unit="pt" min={0} max={100} onChange={(v) => put('reflection', { ...reflection, dist: v })} />}
      </Fieldset>
      <Fieldset legend="Glow">
        <Spin label="Si&ze:" value={glow?.size ?? 0} unit="pt" min={0} max={150} onChange={(v) => put('glow', v ? { color: glow?.color ?? '#156082', alpha: glow?.alpha ?? 0.6, size: v } : null)} />
        {glow && <Row label="C&olor:" htmlFor="te-glow-color"><ColorPick id="te-glow-color" automatic={null} value={glow.color} onChange={(hex) => put('glow', { ...glow, color: hex })} /></Row>}
      </Fieldset>
      <Fieldset legend="Soft Edges" help="Soft edges apply to shapes and pictures, not to text." />
      <Fieldset legend="3-D Format">
        <p className="text-xs text-muted-foreground" aria-disabled>{REASONS.render3d}</p>
      </Fieldset>
      <Sample e={e} />
    </div>
  );

  // Removed effects are written as null, so OK clears them from the runs (JSON attributes are patched, plan.md §1.8).
  const out = () => Object.fromEntries(['fill', 'outline', 'shadow', 'glow', 'reflection'].map((k) => [k, e[k] ?? null]));
  const result = () => {
    if (mode === 'value') return Object.fromEntries(Object.entries(out()).filter(([, v]) => v != null));
    // Only the effects the user changed, so a mixed selection keeps each run's other effects (as the Font dialog's changesOf).
    const changed = changesOf(initial, out());
    if (canvas) {
      const c = ctxOf();
      if (Object.keys(changed).length) {
        Promise.resolve(c.engine.exec('format.textEffects', textEffectsParams(changed)))
          .then((r) => r?.ok === false && c.toast(`Could not apply the text effects: ${r.error ?? 'the engine refused them'}`));
      }
      return true;
    }
    if (Object.keys(changed).length) applyRun(ctxOf(), { effects: changed });
    return true;
  };
  return (
    <WordDialog title="Format Text Effects" size="sm" tab={tab} onTab={setTab} onClose={onClose} result={result}
      tabs={[{ id: 'fill', label: 'Text &Fill and Outline', render: fillTab }, { id: 'effects', label: 'Text Effe&cts', render: effectsTab }]} />
  );
}

const Sample = ({ e }) => {
  const css = Object.fromEntries(Object.entries(effectsCss(e)).map(([k, v]) => [k.replace(/^-webkit-/, 'Webkit-').replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
  return <div className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-center text-2xl text-black"><span style={css}>AaBbCc</span></div>;
};
