// The Format Picture pane (tabs Fill & Line, Effects, Layout & Properties, Picture; probe dialogs/format-picture-pane.json) and the
// Alt Text pane (plan.md §1.7 pane ids formatPicture and altText). The Options items of the ribbon menus open Format Picture at
// their section through the pane's props ({section: 'picture.corrections'}). Both act on ctx.obj; Alt Text also on a text box
// (its own alt and decorative) and a canvas or plan chart (docPr).
import { useEffect, useState } from 'react';
import { Image as ImageIcon, LayoutGrid, PaintBucket, Sparkles } from 'lucide-react';
import { openPane } from '../../../tooling/panes.jsx';
import { REASONS } from '../../../tooling/reasons.mjs';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Check, Pick, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { merged, picOf, setAttrs, themeHex } from './edit.js';
import { domEffects, engineEffects, hex6, sameEffect } from './engine.mjs';
import { ARTISTIC, artisticId, BEVELS, DASHES, glows, REFLECTIONS, ROTATIONS, SHADOWS, SKETCHES, SOFT_EDGES } from './pictures.mjs';

const TABS = [['fillLine', 'Fill & Line', PaintBucket], ['effects', 'Effects', Sparkles], ['layout', 'Layout & Properties', LayoutGrid], ['picture', 'Picture', ImageIcon]];

/** A collapsible section of the pane, open when `open` holds its id. */
function Section({ id, title, open, toggle, children }) {
  return (
    <details data-section={id} open={open.has(id)} className="border-b px-3 py-1.5"
      onToggle={(e) => { if (e.currentTarget.open !== open.has(id)) toggle(id); }}>
      <summary className="cursor-default py-1 font-medium select-none">{title}</summary>
      <div className="flex flex-col gap-2 py-1.5 [&_label]:min-w-24">{children}</div>
    </details>
  );
}

/** A preset list: the gallery's items as a select, the current one picked when it matches (`same(item value, value)`). */
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const Presets = ({ items, value, onPick, same = sameJson }) => {
  const now = items.find((it) => same(it.value, value))?.id ?? '';
  return (
    <Row label="Presets">
      <Pick aria-label="Presets" value={now} options={[['', 'Custom'], ...items.map((it) => [it.id, it.label])]}
        onChange={(id) => { const it = items.find((x) => x.id === id); if (it) onPick(it.value); }} />
    </Row>
  );
};

const pct = (v, def = 0) => Math.round((v ?? def) * 100);

/** The pane's open tab and sections: `section` opens its tab and its section (the Options items). */
function usePaneSections(props) {
  const section = props?.section ?? 'fillLine.line';
  const [tab, setTab] = useState(section.split('.')[0]);
  const [open, setOpen] = useState(() => new Set([section]));
  useEffect(() => {
    setTab(section.split('.')[0]);
    setOpen((o) => new Set([...o, section]));
  }, [section, props]);
  const toggle = (id) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return { tab, setTab, s: { open, toggle } };
}

/** The pane's tab row and the open tab's sections. */
const PaneBody = ({ tab, setTab, children }) => (
  <div data-format-picture="" className="flex flex-col">
    <div role="tablist" className="flex gap-1 border-b px-3 py-1">
      {TABS.map(([id, label, Icon]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} aria-label={label} title={label} data-pane-tab={id} onClick={() => setTab(id)}
          className="grid size-7 place-items-center rounded-md hover:bg-accent aria-selected:bg-accent"><Icon className="size-4" /></button>
      ))}
    </div>
    {children}
  </div>
);

/** The Format Picture pane. */
export function FormatPicturePane({ ctx, props }) {
  const { tab, setTab, s } = usePaneSections(props);
  if (ctx.engine) return <EnginePicturePane ctx={ctx} tab={tab} setTab={setTab} s={s} />;
  const p = picOf(ctx);
  if (!p) return <p className="p-3 text-muted-foreground">Select a picture to format it.</p>;
  const a = p.node.attrs;
  const write = (attrs) => setAttrs(ctx.target, p.pos, attrs);
  const patch = (key, part) => write({ [key]: merged(a[key], part) });
  const fx = a.effects ?? {};
  const fxPatch = (key, part) => patch('effects', { [key]: part == null ? null : { ...(fx[key] ?? {}), ...part } });
  const adj = a.adjust ?? {};
  const line = a.border && a.border.color !== 'none';

  const body = {
    fillLine: (
      <Section id="fillLine.line" title="Line" {...s}>
        <Row label="Line">
          <Pick aria-label="Line" value={line ? 'solid' : 'none'} options={[['none', 'No line'], ['solid', 'Solid line']]}
            onChange={(v) => patch('border', v === 'none' ? { color: 'none' } : { color: '#000000', width: a.border?.width ?? 0.75 })} />
        </Row>
        <Row label="Color"><ColorPick value={line ? a.border.color : null} automatic={null} onChange={(c) => patch('border', { color: c ?? 'none', width: a.border?.width ?? 0.75 })} /></Row>
        <Spin label="Width" unit="pt" min={0} max={1584} step={0.25} value={a.border?.width ?? 0.75} onChange={(w) => w != null && patch('border', { width: w, ...(!line && { color: '#000000' }) })} />
        <Row label="Dash type"><Pick aria-label="Dash type" value={a.border?.dash ?? 'solid'} options={DASHES.map((d) => [d.id, d.label])} onChange={(d) => patch('border', { dash: d })} /></Row>
        <Row label="Sketched style"><Pick aria-label="Sketched style" value={a.border?.sketched ?? 'none'} options={SKETCHES.map((d) => [d.id, d.label])} onChange={(d) => patch('border', { sketched: d === 'none' ? null : d })} /></Row>
      </Section>
    ),
    effects: (
      <>
        <Section id="effects.shadow" title="Shadow" {...s}>
          <Presets items={SHADOWS} value={fx.shadow} onPick={(v) => patch('effects', { shadow: v })} />
          <Row label="Color"><ColorPick value={fx.shadow?.color ?? '#000000'} automatic={null} onChange={(c) => fxPatch('shadow', { kind: fx.shadow?.kind ?? 'outer', color: c ?? '#000000' })} /></Row>
          <Spin label="Transparency" unit="pct" min={0} max={100} value={pct(fx.shadow?.transparency, 0.6)} onChange={(v) => v != null && fxPatch('shadow', { kind: fx.shadow?.kind ?? 'outer', transparency: v / 100 })} />
          <Spin label="Blur" unit="pt" min={0} max={100} value={fx.shadow?.blur ?? 0} onChange={(v) => v != null && fxPatch('shadow', { kind: fx.shadow?.kind ?? 'outer', blur: v })} />
          <Spin label="Angle" unit="int" min={0} max={359} value={fx.shadow?.angle ?? 0} onChange={(v) => v != null && fxPatch('shadow', { kind: fx.shadow?.kind ?? 'outer', angle: v })} />
          <Spin label="Distance" unit="pt" min={0} max={200} value={fx.shadow?.distance ?? 0} onChange={(v) => v != null && fxPatch('shadow', { kind: fx.shadow?.kind ?? 'outer', distance: v })} />
        </Section>
        <Section id="effects.reflection" title="Reflection" {...s}>
          <Presets items={REFLECTIONS} value={fx.reflection} onPick={(v) => patch('effects', { reflection: v })} />
          <Spin label="Transparency" unit="pct" min={0} max={100} value={pct(fx.reflection?.transparency, 0.5)} onChange={(v) => v != null && fxPatch('reflection', { transparency: v / 100 })} />
          <Spin label="Size" unit="pct" min={1} max={100} value={pct(fx.reflection?.size, 0)} onChange={(v) => v != null && fxPatch('reflection', { size: v / 100 })} />
          <Spin label="Distance" unit="pt" min={0} max={100} value={fx.reflection?.distance ?? 0} onChange={(v) => v != null && fxPatch('reflection', { distance: v })} />
        </Section>
        <Section id="effects.glow" title="Glow" {...s}>
          <Presets items={glows((slot) => themeHex(ctx, slot))} value={fx.glow} onPick={(v) => patch('effects', { glow: v })} />
          <Row label="Color"><ColorPick value={fx.glow?.color ?? themeHex(ctx, 'accent1')} automatic={null} onChange={(c) => c && fxPatch('glow', { color: c, size: fx.glow?.size ?? 8 })} /></Row>
          <Spin label="Size" unit="pt" min={0} max={150} value={fx.glow?.size ?? 0} onChange={(v) => v != null && fxPatch('glow', v ? { size: v, color: fx.glow?.color ?? themeHex(ctx, 'accent1') } : null)} />
          <Spin label="Transparency" unit="pct" min={0} max={100} value={pct(fx.glow?.transparency, 0.6)} onChange={(v) => v != null && fxPatch('glow', { transparency: v / 100 })} />
        </Section>
        <Section id="effects.softEdges" title="Soft Edges" {...s}>
          <Presets items={SOFT_EDGES} value={fx.softEdge} onPick={(v) => patch('effects', { softEdge: v })} />
          <Spin label="Size" unit="pt" min={0} max={100} value={fx.softEdge ?? 0} onChange={(v) => v != null && patch('effects', { softEdge: v || null })} />
        </Section>
        <Section id="effects.format3d" title="3-D Format" {...s}>
          <Row label="Top bevel">
            <Pick aria-label="Top bevel" value={fx.bevel?.kind ?? 'none'} options={BEVELS.map((b) => [b.id, b.label])} onChange={(k) => patch('effects', { bevel: BEVELS.find((b) => b.id === k)?.value ?? null })} />
          </Row>
        </Section>
        <Section id="effects.rotation3d" title="3-D Rotation" {...s}>
          <Presets items={ROTATIONS} value={fx.rotation3d} onPick={(v) => patch('effects', { rotation3d: v })} />
          {[['x', 'X Rotation'], ['y', 'Y Rotation'], ['z', 'Z Rotation'], ['perspective', 'Perspective']].map(([k, label]) => (
            <Spin key={k} label={label} unit="int" min={k === 'perspective' ? 0 : -359} max={k === 'perspective' ? 120 : 359} value={fx.rotation3d?.[k] ?? 0}
              onChange={(v) => v != null && fxPatch('rotation3d', { [k]: v })} />
          ))}
        </Section>
      </>
    ),
    layout: (
      <Section id="layout.altText" title="Alt Text" {...s}>
        <p className="text-muted-foreground">Alt text has its own pane.</p>
        <button type="button" className="w-fit rounded-md border px-2 py-0.5 hover:bg-accent" onClick={() => openPane('altText')}>Open Alt Text</button>
      </Section>
    ),
    picture: (
      <>
        <Section id="picture.corrections" title="Picture Corrections" {...s}>
          <Spin label="Sharpness" unit="pct" min={-100} max={100} value={pct(adj.sharpness)} onChange={(v) => v != null && patch('adjust', { sharpness: v / 100 || null })} />
          <Spin label="Brightness" unit="pct" min={-100} max={100} value={pct(adj.brightness)} onChange={(v) => v != null && patch('adjust', { brightness: v / 100 || null })} />
          <Spin label="Contrast" unit="pct" min={-100} max={100} value={pct(adj.contrast)} onChange={(v) => v != null && patch('adjust', { contrast: v / 100 || null })} />
          <button type="button" className="w-fit rounded-md border px-2 py-0.5 hover:bg-accent" onClick={() => patch('adjust', { sharpness: null, brightness: null, contrast: null })}>Reset</button>
        </Section>
        <Section id="picture.color" title="Picture Color" {...s}>
          <Spin label="Saturation" unit="pct" min={0} max={400} value={pct(adj.saturation, 1)} onChange={(v) => v != null && patch('adjust', { saturation: v === 100 ? null : v / 100 })} />
          <Spin label="Temperature" unit="int" min={1500} max={11500} step={100} value={adj.temperature ?? 6500} onChange={(v) => v != null && patch('adjust', { temperature: v === 6500 ? null : v })} />
          <Row label="Recolor">
            <Pick aria-label="Recolor" value={adj.recolor?.kind ?? 'none'}
              options={[['none', 'No Recolor'], ['grayscale', 'Grayscale'], ['sepia', 'Sepia'], ['washout', 'Washout'], ['bw', 'Black and White'], ['dark', 'Dark variation'], ['light', 'Light variation']]}
              onChange={(k) => patch('adjust', { recolor: k === 'none' ? null : { kind: k, ...(k === 'bw' && { threshold: 0.5 }), ...((k === 'dark' || k === 'light') && { color: adj.recolor?.color ?? themeHex(ctx, 'accent1') }) } })} />
          </Row>
          {adj.transparentColor && (
            <button type="button" className="w-fit rounded-md border px-2 py-0.5 hover:bg-accent" onClick={() => patch('adjust', { transparentColor: null })}>Clear the transparent colour</button>
          )}
        </Section>
        <Section id="picture.transparency" title="Picture Transparency" {...s}>
          <Spin label="Transparency" unit="pct" min={0} max={100} value={pct(adj.transparency)} onChange={(v) => v != null && patch('adjust', { transparency: v / 100 || null })} />
        </Section>
        <Section id="picture.crop" title="Crop" {...s}>
          {[['l', 'Left'], ['r', 'Right'], ['t', 'Top'], ['b', 'Bottom']].map(([k, label]) => (
            <Spin key={k} label={label} unit="pct" min={0} max={95} value={pct(a.crop?.[k])} onChange={(v) => {
              if (v == null) return;
              // The drawn box keeps the picture's scale: it grows or shrinks with what the crop shows.
              const old = a.crop?.[k] ?? 0;
              const across = k === 'l' || k === 'r';
              const share = across ? 1 - (a.crop?.l ?? 0) - (a.crop?.r ?? 0) : 1 - (a.crop?.t ?? 0) - (a.crop?.b ?? 0);
              const next = Math.min(v / 100, share + old - 0.02);
              const full = (across ? a.width : a.height) / share;
              const size = Math.round(full * (share + old - next) * 100) / 100;
              write({ crop: merged(a.crop, { [k]: next || null }), [across ? 'width' : 'height']: size });
            }} />
          ))}
        </Section>
      </>
    ),
  }[tab];

  return <PaneBody tab={tab} setTab={setTab}>{body}</PaneBody>;
}

/** The Format Picture pane on a canvas draft: it reads the engine's picture (object.get) and writes picture.format,
 * picture.corrections, picture.color, picture.transparency and picture.crop, one undo step per change. */
function EnginePicturePane({ ctx, tab, setTab, s }) {
  const o = ctx.read?.('object.get', {});
  const look = o?.picture;
  if (!look) return <p className="p-3 text-muted-foreground">Select a picture to format it.</p>;
  const run = (id, args) => ctx.engine.exec(id, args);
  const fmt = (args) => run('picture.format', args);
  const line = look.outline;
  const setLine = (part) => fmt({ outline: part });
  const fx = domEffects(look.fx);
  const setFx = (key, value) => fmt(engineEffects({ [key]: value }));
  const fxPatch = (key, part) => setFx(key, part == null ? null : { ...(fx[key] ?? {}), ...part });
  // engine-pictures-2: the picture's corrections and colour are settings the engine keeps (object.get picture.adjust), so the pane
  // shows them after a reload too.
  const adj = look.adjust ?? {};
  const corr = (part) => {
    const v = { sharpness: adj.sharpness ?? 0, brightness: adj.brightness ?? 0, contrast: adj.contrast ?? 0, ...part };
    return run('picture.corrections', { sharpen: v.sharpness, brightness: v.brightness, contrast: v.contrast });
  };
  const crop = look.crop ?? [0, 0, 0, 0];
  const accent = themeHex(ctx, 'accent1');
  const is = (kind) => (item, now) => sameEffect(kind, now ?? null, item ?? null);

  const body = {
    fillLine: (
      <Section id="fillLine.line" title="Line" {...s}>
        <Row label="Line">
          <Pick aria-label="Line" value={line ? 'solid' : 'none'} options={[['none', 'No line'], ['solid', 'Solid line']]}
            onChange={(v) => setLine(v === 'none' ? null : { color: hex6(line?.color) ?? '000000' })} />
        </Row>
        <Row label="Color"><ColorPick value={line ? `#${line.color}` : null} automatic={null} onChange={(c) => setLine(c ? { color: hex6(c) } : null)} /></Row>
        <Spin label="Width" unit="pt" min={0} max={1584} step={0.25} value={line?.width ?? 0.75} onChange={(w) => w != null && setLine({ width: w })} />
        <Row label="Dash type"><Pick aria-label="Dash type" value={line?.dash ?? 'solid'} options={DASHES.map((d) => [d.id, d.label])} onChange={(d) => setLine({ dash: d })} /></Row>
        <Row label="Sketched style"><Pick aria-label="Sketched style" value={line?.sketch ?? 'none'} options={SKETCHES.map((d) => [d.id, d.label])} onChange={(d) => setLine({ sketch: d })} /></Row>
      </Section>
    ),
    effects: (
      <>
        <Section id="effects.shadow" title="Shadow" {...s}>
          <Presets items={SHADOWS} value={fx.shadow} onPick={(v) => setFx('shadow', v)} same={is('shadow')} />
          <Row label="Color"><ColorPick value={fx.shadow?.color ?? '#000000'} automatic={null} onChange={(c) => fxPatch('shadow', { kind: fx.shadow?.kind ?? 'outer', color: c ?? '#000000' })} /></Row>
          <Spin label="Transparency" unit="pct" min={0} max={100} value={pct(fx.shadow?.transparency, 0.6)} onChange={(v) => v != null && fxPatch('shadow', { kind: fx.shadow?.kind ?? 'outer', transparency: v / 100 })} />
          <Spin label="Blur" unit="pt" min={0} max={100} value={fx.shadow?.blur ?? 0} onChange={(v) => v != null && fxPatch('shadow', { kind: fx.shadow?.kind ?? 'outer', blur: v })} />
          <Spin label="Angle" unit="int" min={0} max={359} value={fx.shadow?.angle ?? 0} onChange={(v) => v != null && fxPatch('shadow', { kind: fx.shadow?.kind ?? 'outer', angle: v })} />
          <Spin label="Distance" unit="pt" min={0} max={200} value={fx.shadow?.distance ?? 0} onChange={(v) => v != null && fxPatch('shadow', { kind: fx.shadow?.kind ?? 'outer', distance: v })} />
        </Section>
        <Section id="effects.reflection" title="Reflection" {...s}>
          <Presets items={REFLECTIONS} value={fx.reflection} onPick={(v) => setFx('reflection', v)} same={is('reflection')} />
          <Spin label="Transparency" unit="pct" min={0} max={100} value={pct(fx.reflection?.transparency, 0.5)} onChange={(v) => v != null && fxPatch('reflection', { transparency: v / 100 })} />
          <Spin label="Size" unit="pct" min={1} max={100} value={pct(fx.reflection?.size, 0)} onChange={(v) => v != null && fxPatch('reflection', { size: v / 100 })} />
          <Spin label="Blur" unit="pt" min={0} max={100} value={fx.reflection?.blur ?? 0} onChange={(v) => v != null && fxPatch('reflection', { blur: v })} />
          <Spin label="Distance" unit="pt" min={0} max={100} value={fx.reflection?.distance ?? 0} onChange={(v) => v != null && fxPatch('reflection', { distance: v })} />
        </Section>
        <Section id="effects.glow" title="Glow" {...s}>
          <Presets items={glows((slot) => themeHex(ctx, slot))} value={fx.glow} onPick={(v) => setFx('glow', v)} same={is('glow')} />
          <Row label="Color"><ColorPick value={fx.glow?.color ?? accent} automatic={null} onChange={(c) => c && fxPatch('glow', { color: c, size: fx.glow?.size ?? 8 })} /></Row>
          <Spin label="Size" unit="pt" min={0} max={150} value={fx.glow?.size ?? 0} onChange={(v) => v != null && fxPatch('glow', v ? { size: v, color: fx.glow?.color ?? accent } : null)} />
          <Spin label="Transparency" unit="pct" min={0} max={100} value={pct(fx.glow?.transparency, 0.6)} onChange={(v) => v != null && fxPatch('glow', { transparency: v / 100, color: fx.glow?.color ?? accent, size: fx.glow?.size ?? 8 })} />
        </Section>
        <Section id="effects.softEdges" title="Soft Edges" {...s}>
          <Presets items={SOFT_EDGES} value={fx.softEdge} onPick={(v) => setFx('softEdge', v)} same={is('softEdges')} />
          <Spin label="Size" unit="pt" min={0} max={100} value={fx.softEdge ?? 0} onChange={(v) => v != null && setFx('softEdge', v || null)} />
        </Section>
        <Section id="effects.format3d" title="3-D Format" {...s}>
          <Row label="Top bevel">
            <Pick aria-label="Top bevel" value={fx.bevel?.kind ?? 'none'} options={BEVELS.map((b) => [b.id, b.label])} onChange={(k) => setFx('bevel', BEVELS.find((b) => b.id === k)?.value ?? null)} />
          </Row>
          <Spin label="Width" unit="pt" min={0} max={1584} value={fx.bevel?.width ?? 0} onChange={(v) => v != null && fx.bevel && fxPatch('bevel', { width: v })} />
          <Spin label="Height" unit="pt" min={0} max={1584} value={fx.bevel?.height ?? 0} onChange={(v) => v != null && fx.bevel && fxPatch('bevel', { height: v })} />
        </Section>
        <Section id="effects.rotation3d" title="3-D Rotation" {...s}>
          <Presets items={ROTATIONS} value={fx.rotation3d} onPick={(v) => setFx('rotation3d', v)} same={is('3DRotation')} />
          {[['x', 'X Rotation'], ['y', 'Y Rotation'], ['z', 'Z Rotation'], ['perspective', 'Perspective']].map(([k, label]) => (
            <Spin key={k} label={label} unit="int" min={k === 'perspective' ? 0 : -359} max={k === 'perspective' ? 120 : 359} value={fx.rotation3d?.[k] ?? 0}
              onChange={(v) => v != null && fxPatch('rotation3d', { x: 0, y: 0, z: 0, perspective: 0, ...fx.rotation3d, [k]: v })} />
          ))}
        </Section>
        <Section id="effects.artistic" title="Artistic Effects" {...s}>
          <Row label="Artistic Effect">
            <Pick aria-label="Artistic Effect" value={artisticId(adj.artistic)} options={ARTISTIC.map((e) => [e.id, e.label])} onChange={(k) => run('picture.effects', { effect: k })} />
          </Row>
          <button type="button" className="w-fit rounded-md border px-2 py-0.5 hover:bg-accent" onClick={() => run('picture.effects', { effect: 'none' })}>Reset</button>
        </Section>
      </>
    ),
    layout: (
      <Section id="layout.altText" title="Alt Text" {...s}>
        <p className="text-muted-foreground">Alt text has its own pane.</p>
        <button type="button" className="w-fit rounded-md border px-2 py-0.5 hover:bg-accent" onClick={() => openPane('altText')}>Open Alt Text</button>
      </Section>
    ),
    picture: (
      <>
        <Section id="picture.corrections" title="Picture Corrections" {...s}>
          <Spin label="Sharpness" unit="pct" min={-100} max={100} value={adj.sharpness ?? 0} onChange={(v) => v != null && corr({ sharpness: v })} />
          <Spin label="Brightness" unit="pct" min={-100} max={100} value={adj.brightness ?? 0} onChange={(v) => v != null && corr({ brightness: v })} />
          <Spin label="Contrast" unit="pct" min={-100} max={100} value={adj.contrast ?? 0} onChange={(v) => v != null && corr({ contrast: v })} />
          <button type="button" className="w-fit rounded-md border px-2 py-0.5 hover:bg-accent" onClick={() => corr({ sharpness: 0, brightness: 0, contrast: 0 })}>Reset</button>
        </Section>
        <Section id="picture.color" title="Picture Color" {...s}>
          <Spin label="Saturation" unit="pct" min={0} max={400} value={adj.saturation ?? 100}
            onChange={(v) => v != null && run('picture.color', { mode: 'saturation', saturation: v })} />
          <Spin label="Temperature" unit="int" min={1500} max={11500} step={100} value={adj.temperature ?? 6500}
            onChange={(v) => v != null && run('picture.color', { mode: 'tone', temperature: v })} />
          <Row label="Recolor">
            <Pick aria-label="Recolor" value={adj.recolor ?? 'none'}
              options={[['none', 'No Recolor'], ['grayscale', 'Grayscale'], ['sepia', 'Sepia'], ['washout', 'Washout'], ['blackAndWhite', 'Black and White'], ['dark', 'Dark variation'], ['light', 'Light variation']]}
              onChange={(k) => run('picture.color', { mode: k, ...((k === 'dark' || k === 'light') && { color: adj.recolorColor ?? hex6(accent) }) })} />
          </Row>
        </Section>
        <Section id="picture.transparency" title="Picture Transparency" {...s}>
          <Spin label="Transparency" unit="pct" min={0} max={100} value={adj.transparency ?? 0}
            onChange={(v) => v != null && run('picture.transparency', { percent: v })} />
        </Section>
        <Section id="picture.crop" title="Crop" {...s}>
          {[[0, 'left', 'Left'], [2, 'right', 'Right'], [1, 'top', 'Top'], [3, 'bottom', 'Bottom']].map(([i, side, label]) => (
            <Spin key={side} label={label} unit="pct" min={0} max={95} value={Math.round((crop[i] ?? 0) * 100)} onChange={(v) => {
              if (v == null) return;
              // The drawn box keeps the picture's scale: it grows or shrinks with what the crop shows.
              const across = i % 2 === 0;
              const share = across ? 1 - crop[0] - crop[2] : 1 - crop[1] - crop[3];
              const next = Math.min(v / 100, share + crop[i] - 0.02);
              const full = (across ? o.w : o.h) / Math.max(0.05, share);
              const size = Math.round(full * (share + crop[i] - next) * 100) / 100;
              const sides = { left: crop[0], top: crop[1], right: crop[2], bottom: crop[3], [side]: next };
              run('picture.crop', { ...sides, [across ? 'width' : 'height']: size });
            }} />
          ))}
        </Section>
      </>
    ),
  }[tab];

  return <PaneBody tab={tab} setTab={setTab}>{body}</PaneBody>;
}

/** The object Alt Text edits → {pos, alt, decorative, write(patch)} or null: a picture, a text box, or a canvas or plan chart. */
function altTarget(ctx) {
  const o = ctx.obj;
  if (ctx.engine) {
    // A canvas draft: the engine's object (object.get), written through object.altText (one undo step per change).
    const got = o && ctx.read?.('object.get', {});
    const alt = got?.alt;
    if (!alt) return null;
    return {
      // The engine answers after each change: the box keeps its own text while typed (uncontrolled, reset per object).
      key: JSON.stringify(got.pos),
      alt: alt.text ?? '',
      decorative: !!alt.decorative,
      write: ({ alt: text, decorative }) => ctx.engine.exec('object.altText', {
        ...(text !== undefined && { text: text ?? '' }), ...(decorative !== undefined && { decorative: !!decorative }),
      }),
    };
  }
  const ed = ctx.target;
  if (!o || !ed) return null;
  if (o.kind === 'picture' || o.kind === 'graphic' || o.kind === 'textbox') {
    return { alt: o.node.attrs.alt ?? '', decorative: !!o.node.attrs.decorative, write: (patch) => setAttrs(ed, o.pos, patch) };
  }
  if (o.kind === 'canvas' || o.kind === 'planChart') {
    const pr = o.node.attrs.docPr ?? {};
    return { alt: pr.alt ?? '', decorative: !!pr.decorative, write: (patch) => setAttrs(ctx.ed, o.pos, { docPr: merged(pr, patch) }) };
  }
  return null;
}

/** The Alt Text pane: a description box, Mark as decorative (greys the box) and Generate a description (a cloud placeholder). */
export function AltTextPane({ ctx }) {
  const t = altTarget(ctx);
  if (!t) return <p className="p-3 text-muted-foreground">Select a picture, shape or text box to describe it.</p>;
  return (
    <div data-alt-text="" className="flex flex-col gap-2 p-3">
      <p className="text-muted-foreground">Describe the object for people who use screen readers.</p>
      <textarea key={t.key} aria-label="Alt text description" {...(t.key ? { defaultValue: t.alt } : { value: t.alt })} disabled={t.decorative} rows={5} spellCheck
        onChange={(e) => t.write({ alt: e.target.value || null })}
        className="w-full resize-y rounded-md border border-input bg-background p-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50" />
      <button type="button" disabled title={REASONS.cloud} className="w-fit rounded-md border px-2 py-0.5 opacity-50">Generate a description for me</button>
      <Check label="Mark as decorative" checked={t.decorative} onChange={(v) => t.write({ decorative: v || null })} />
    </div>
  );
}
