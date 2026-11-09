// Shapes' drawn parts: the gallery icons of Word's own entries (its lines are the shape picker's LineIcon; the library's shapes
// draw through the picker's ShapeIcon), the Shape Styles swatches and the Format Shape pane (probe/dialogs/format-shape-pane.json).
// Controls a target cannot honour stay visible and disabled.
import { useState } from 'react';
import { cn } from 'cn';
import { panelOf, run } from '../../../tooling/registry.js';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Check, Fieldset, Pick, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { LineIcon } from '../../../tooling/ShapePicker.jsx';
import { labelFit } from '../../../whiteboard.js';
import { fitOf } from '../../docx/shapes-out.mjs';
import { DASH_MAP, dashId, HEADS, SHAPE_MAP } from './map.mjs';
import { CANVAS_ONLY, chosen, lookOf, patchBox, patchItems, targetOf } from './target.js';

/** Word's own gallery entry `name` (one of its Lines, or a text box tool) as an icon, with its name unless `label` is false. */
export function ShapeIcon({ name, label = true }) {
  const box = ['textBox', 'verticalTextBox'].includes(SHAPE_MAP[name]?.tool);
  return (
    <span className="flex min-w-0 items-center gap-2">
      {box ? (
        <svg width="20" height="16" viewBox="0 0 20 16" className="shrink-0" aria-hidden="true">
          <path d="M2 2H18V14H2Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <text x="10" y="12" textAnchor="middle" fontSize="10" fill="currentColor">A</text>
        </svg>
      ) : <LineIcon name={name} className="h-4 w-5" />}
      {label && <span className="truncate">{name}</span>}
    </span>
  );
}

/** A Shape Styles swatch: its fill and outline on a small box. */
export function StyleSwatch({ patch }) {
  const fill = patch.fill === 'none' ? 'transparent' : patch.fill === 'hatch'
    ? `repeating-linear-gradient(45deg, ${patch.fillColor} 0 1.5px, transparent 1.5px 5px)` : patch.fillColor;
  return (
    <span className="block h-7 w-12 rounded-sm"
      style={{ background: fill, border: `${Math.min(3, patch.width / 1.5)}px ${patch.dash === 'dashed' ? 'dashed' : 'solid'} ${patch.color}` }} />
  );
}

// --- the Format Shape pane ---

const FILL = 'shapeFormat.shapeStyles.shapeFill';
const LINE = 'shapeFormat.shapeStyles.shapeOutline';
const EFFECTS = [['shadow', 'Shadow'], ['reflection', 'Reflection'], ['glow', 'Glow'], ['softEdges', 'Soft Edges'], ['bevel', '3-D Format'], ['rotation3d', '3-D Rotation']];
const SECTIONS = { fill: 'fillLine', line: 'fillLine', effects: 'effects', layout: 'layout', text: 'text' };

// A colour's transparency in percent from its #RRGGBBAA alpha, and the colour with a new one.
const alphaOf = (hex) => (typeof hex === 'string' && hex.length === 9 ? Math.round((1 - parseInt(hex.slice(7), 16) / 255) * 100) : 0);
const withAlpha = (hex, pct) => {
  const base = hex.slice(0, 7);
  return pct > 0 ? base + Math.round((1 - pct / 100) * 255).toString(16).padStart(2, '0').toUpperCase() : base;
};

// The height in board px of shape `id`'s label as canvas target `t` draws it (in its editor or on the page), or null when not drawn.
const drawnLabel = (t, id) => {
  const el = t.session?.board.itemEl(id) ?? [...(t.cv.art?.children ?? [])].find((c) => c.dataset.id === id);
  return el?.querySelector(':scope > .wb-label > .wb-text')?.offsetHeight ?? null;
};
// Resize shape to fit text on canvas target `t`'s chosen shapes: turned on, each grows at once to hold its text, as in Word.
const fitText = (t, on) => patchItems(t, (it) => (it.type === 'shape' ? { autoFit: on, ...(on && { h: labelFit(it, drawnLabel(t, it.id)) }) } : null));

function Radios({ value, options, onChange }) {
  return (
    <div role="radiogroup" className="flex flex-col gap-1.5">
      {options.map(([v, label, off]) => (
        <label key={v} className={cn('flex w-fit items-center gap-2', off && 'opacity-50')} title={off ? CANVAS_ONLY : undefined}>
          <input type="radio" className="size-3.5 accent-primary" checked={v === value} disabled={!!off} onChange={() => onChange(v)} />
          {label}
        </label>
      ))}
    </div>
  );
}

/** The Format Shape pane ({ctx, close, props: {section}}): Shape Options (Fill & Line, Effects, Layout & Properties) and, for a
 * text box, Text Options (the textbox package's panels). On a canvas draft it reads and writes the engine (CanvasFormatShape). */
export function FormatShapePane({ ctx, props }) {
  const [tab, setTab] = useState(SECTIONS[props?.section] ?? 'fillLine');
  if (ctx.engine) return <CanvasFormatShape ctx={ctx} tab={tab} setTab={setTab} />;
  const t = targetOf(ctx);
  if (!t) return <p className="p-3 text-xs text-muted-foreground">Select a shape, canvas or text box to format it.</p>;
  const box = t.kind === 'textbox';
  const look = lookOf(t) ?? {};
  const conn = !box && look.item?.type === 'connector';
  const shape = !box && chosen(t).find((i) => i.type === 'shape');
  const tabs = [['fillLine', 'Fill & Line'], ['effects', 'Effects'], ['layout', 'Layout & Properties'], ...(box ? [['text', 'Text Options']] : [])];
  const setAlpha = (key, pct) => (box
    ? patchBox(t, (a) => (key === 'fill' ? (typeof a.fill === 'string' ? { fill: withAlpha(a.fill, pct) } : {}) : a.line ? { line: { ...a.line, color: withAlpha(a.line.color, pct) } } : {}))
    : patchItems(t, (it) => (key === 'fill' ? (it.type === 'shape' && it.fill !== 'none' ? { fillColor: withAlpha(it.fillColor, pct) } : null) : { color: withAlpha(it.color, pct) })));
  const Panel = (id) => {
    const P = panelOf(id);
    return P ? <P ctx={ctx} /> : <p className="text-xs text-muted-foreground">These options come with text boxes.</p>;
  };
  return (
    <div data-format-shape className="flex flex-col gap-3 p-3 text-xs">
      <div role="tablist" className="flex flex-wrap gap-1">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn('rounded-sm px-2 py-1 hover:bg-accent/60', tab === id && 'bg-accent font-medium')}>{label}</button>
        ))}
      </div>
      {tab === 'fillLine' && (
        <>
          <Fieldset legend="Fill">
            <Radios value={look.fill ? 'solid' : 'none'} onChange={(v) => {
              if (v === 'none') run(FILL, { color: null });
              else if (v === 'solid') run(FILL, { color: look.fill ?? '#156082' });
              else run(`${FILL}.${v}`);
            }} options={[['none', 'No fill'], ['solid', 'Solid fill'], ['gradient.moreGradients', 'Gradient fill', !box], ['picture', 'Picture or texture fill', !box],
              ['pattern', 'Pattern fill', !box]]} />
            <Row label="&Color"><ColorPick value={look.fill?.slice(0, 7) ?? null} automatic={null} onChange={(c) => run(FILL, { color: c })} /></Row>
            <Spin label="&Transparency" unit="pct" min={0} max={100} value={alphaOf(look.fill)} onChange={(v) => look.fill && setAlpha('fill', v ?? 0)} />
          </Fieldset>
          <Fieldset legend="Line">
            <Radios value={look.line ? 'solid' : 'none'} onChange={(v) => run(LINE, { color: v === 'none' ? null : look.line ?? '#0A2F41' })}
              options={[['none', 'No line'], ['solid', 'Solid line'], ['gradient', 'Gradient line', true]]} />
            <Row label="&Color"><ColorPick value={look.line?.slice(0, 7) ?? null} automatic={null} onChange={(c) => run(LINE, { color: c })} /></Row>
            <Spin label="&Transparency" unit="pct" min={0} max={100} value={alphaOf(look.line)} onChange={(v) => look.line && setAlpha('line', v ?? 0)} />
            <Spin label="&Width" unit="pt" min={0} max={1584} step={0.25} value={Math.round((look.width ?? 0) * 100) / 100} onChange={(v) => v != null && run(`${LINE}.weight`, v)} />
            <Row label="&Sketched style"><Pick value="none" options={[['none', 'None']]} disabled onChange={() => {}} /></Row>
            <Row label="C&ompound type"><Pick value="single" options={[['single', 'Single']]} disabled onChange={() => {}} /></Row>
            <Row label="&Dash type"><Pick value={dashId(look.dash)} options={Object.entries(DASH_MAP).map(([id, [label]]) => [id, label])} onChange={(v) => run(`${LINE}.dashes`, v)} /></Row>
            <Row label="C&ap type"><Pick value="round" options={[['round', 'Round'], ['flat', 'Flat']]} disabled onChange={() => {}} /></Row>
            <Row label="&Join type"><Pick value="round" options={[['round', 'Round'], ['miter', 'Miter']]} disabled onChange={() => {}} /></Row>
            {['start', 'end'].map((end) => (
              <Row key={end} label={end === 'start' ? '&Begin Arrow type' : '&End Arrow type'}>
                <Pick value={look.heads?.[end] ?? 'none'} disabled={!conn} options={HEADS.map((h) => [h, h])}
                  onChange={(v) => patchItems(t, (it) => (it.type === 'connector' ? { heads: { ...it.heads, [end]: v } } : null))} />
              </Row>
            ))}
          </Fieldset>
        </>
      )}
      {tab === 'effects' && (
        <Fieldset legend="Effects">
          {EFFECTS.map(([id, label]) => (
            <Check key={id} label={label} disabled={!box} checked={!!(box && t.node.attrs.effects?.[id])} onChange={() => run('shapeFormat.shapeStyles.shapeEffects', id)} />
          ))}
          {!box && <p className="text-muted-foreground">{CANVAS_ONLY}</p>}
        </Fieldset>
      )}
      {tab === 'layout' && (box ? Panel('formatShape.textBox') : (
        <>
          {shape && (
            <Fieldset legend="Text Box">
              <Check label="Resize shape to &fit text" checked={shape.autoFit ?? fitOf(t.attrs)} onChange={(on) => fitText(t, on)} />
            </Fieldset>
          )}
          <Fieldset legend="Alt Text">
            <textarea aria-label="Description" rows={4} defaultValue={t.attrs.docPr?.alt ?? ''} className="rounded-md border border-input bg-background p-1.5"
              onBlur={(e) => {
                const v = ctx.ed?.view.state.doc.nodeAt(t.pos);
                if (v?.type.name === 'canvas' && (v.attrs.docPr?.alt ?? '') !== e.target.value) {
                  ctx.ed.view.dispatch(ctx.ed.view.state.tr.setNodeMarkup(t.pos, undefined, { ...v.attrs, docPr: { ...v.attrs.docPr, alt: e.target.value } }));
                }
              }} />
          </Fieldset>
        </>
      ))}
      {tab === 'text' && Panel('formatShape.text')}
    </div>
  );
}

// --- the Format Shape pane on a canvas draft (docs/plans/engine/stage2b.md, engine-gaps-shapes) ---

const hash = (c) => (c ? `#${c}` : null);
const ENGINE_DASHES = { solid: 'solid', sysDot: 'roundDot', sysDash: 'squareDot', dash: 'dash', dashDot: 'dashDot', lgDash: 'longDash',
  lgDashDot: 'longDashDot', lgDashDotDot: 'longDashDotDot' };
const LINE_KINDS = new Set(['line', 'straightConnector', 'elbowConnector', 'curvedConnector']);
const ALIGN = [['t', 'Top'], ['ctr', 'Middle'], ['b', 'Bottom']];
const DIRECTION = [['horz', 'Horizontal'], ['vert', 'Rotate all text 90°'], ['vert270', 'Rotate all text 270°'], ['wordArtVert', 'Stacked']];
const INSETS = [['left', '&Left margin', 0], ['right', '&Right margin', 2], ['top', '&Top margin', 1], ['bottom', '&Bottom margin', 3]];
const BODY_ANCHOR = { top: 't', center: 'ctr', bottom: 'b' };
const BODY_DIR = { horz: 'horz', vert: 'vert', vert270: 'vert270', stacked: 'wordArtVert' };

/** The kind of fill object.get's `fill` is: none, solid, gradient, picture (or texture) or pattern. */
const fillKind = (f) => (!f ? 'none' : f.gradient ? 'gradient' : f.picture ? 'picture' : f.pattern ? 'pattern' : 'solid');

/** The pane on a canvas draft: the selected shape, text box or WordArt from object.get, every change through the ribbon's rows
 * (canvas/rows/objects.mjs) or the engine command they use, one undo step each. */
function CanvasFormatShape({ ctx, tab, setTab }) {
  const o = ctx.read('object.get', {});
  const sh = o?.shape;
  if (!sh) return <p className="p-3 text-xs text-muted-foreground">Select a shape or text box to format it.</p>;
  const exec = (id, args) => ctx.engine.exec(id, args);
  const fill = sh.fill;
  const line = sh.outline ?? {};
  const box = sh.textBox;
  const tabs = [['fillLine', 'Fill & Line'], ['effects', 'Effects'], ['layout', 'Layout & Properties'], ...(box ? [['text', 'Text Options']] : [])];
  const lineKind = LINE_KINDS.has(sh.kind);
  return (
    <div data-format-shape="" data-engine="" className="flex flex-col gap-3 p-3 text-xs">
      <div role="tablist" className="flex flex-wrap gap-1">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn('rounded-sm px-2 py-1 hover:bg-accent/60', tab === id && 'bg-accent font-medium')}>{label}</button>
        ))}
      </div>
      {tab === 'fillLine' && (
        <>
          <Fieldset legend="Fill">
            <Radios value={fillKind(fill)} onChange={(v) => {
              if (v === 'none') run(FILL, { color: null });
              else if (v === 'solid') run(FILL, { color: hash(fill?.color ?? '156082') });
              else run(v === 'gradient' ? `${FILL}.gradient.moreGradients` : v === 'picture' ? `${FILL}.texture` : `${FILL}.pattern`);
            }} options={[['none', 'No fill'], ['solid', 'Solid fill'], ['gradient', 'Gradient fill'], ['picture', 'Picture or texture fill'],
              ['pattern', 'Pattern fill']]} />
            <Row label="&Color"><ColorPick value={hash(fill?.color)} automatic={null} onChange={(c) => c && run(FILL, { color: c })} /></Row>
            <Spin label="&Transparency" unit="pct" min={0} max={100} value={fill?.transparency ?? 0}
              onChange={(v) => fillKind(fill) === 'solid' && exec('shape.fill', { color: fill.color, transparency: v ?? 0 })} />
          </Fieldset>
          <Fieldset legend="Line">
            <Radios value={line.color ? 'solid' : 'none'} onChange={(v) => run(LINE, { color: v === 'none' ? null : hash(line.color ?? '0F4761') })}
              options={[['none', 'No line'], ['solid', 'Solid line']]} />
            <Row label="&Color"><ColorPick value={hash(line.color)} automatic={null} onChange={(c) => c && run(LINE, { color: c })} /></Row>
            <Spin label="&Width" unit="pt" min={0} max={1584} step={0.25} value={Math.round((line.width ?? 0) * 100) / 100}
              onChange={(v) => v != null && run(`${LINE}.weight`, v)} />
            <Row label="&Dash type"><Pick value={ENGINE_DASHES[line.dash] ?? 'solid'} options={Object.entries(DASH_MAP).map(([id, [label]]) => [id, label])}
              onChange={(v) => run(`${LINE}.dashes`, v)} /></Row>
            {['start', 'end'].map((end) => (
              <Row key={end} label={end === 'start' ? '&Begin Arrow type' : '&End Arrow type'}>
                <Pick value={line.arrows?.[end] ? 'arrow' : 'none'} disabled={!lineKind} options={[['none', 'None'], ['arrow', 'Arrow']]}
                  onChange={(v) => exec('shape.outline', { arrows: { [end]: v === 'arrow' } })} />
              </Row>
            ))}
          </Fieldset>
        </>
      )}
      {tab === 'effects' && (
        <Fieldset legend="Effects">
          {[['shadow', 'Shadow', 'shadow'], ['glow', 'Glow', 'glow'], ['softEdges', 'Soft Edges', 'softEdge']].map(([id, label, key]) => (
            <Check key={id} label={label} checked={!!sh.effects?.[key]} onChange={() => run('shapeFormat.shapeStyles.shapeEffects', id)} />
          ))}
        </Fieldset>
      )}
      {tab === 'layout' && (box ? (
        <Fieldset legend="Text Box">
          <Row label="&Vertical alignment"><Pick value={BODY_ANCHOR[box.anchor] ?? 't'} options={ALIGN} onChange={(anchor) => exec('shape.alignText', { anchor })} /></Row>
          <Row label="Te&xt direction"><Pick value={BODY_DIR[box.dir] ?? 'horz'} options={DIRECTION} onChange={(dir) => exec('shape.textDirection', { dir })} /></Row>
          <Check label="Resize shape to &fit text" checked={!!box.autoFit} onChange={(autoFit) => exec('shape.textBox', { autoFit })} />
          {INSETS.map(([k, label, i]) => (
            <Spin key={k} label={label} unit="len" min={0} max={1584} value={Math.round((box.insets?.[i] ?? 0) * 100) / 100}
              onChange={(v) => v != null && exec('shape.textBox', { insets: { [k]: v } })} />
          ))}
        </Fieldset>
      ) : <p className="text-muted-foreground">Add text to the shape to set its text box options.</p>)}
      {tab === 'text' && (
        <>
          <Fieldset legend="Text Fill">
            <Row label="&Color"><ColorPick value={null} automatic={null} onChange={(c) => c && run('shapeFormat.wordArtStyles.textFill', c)} /></Row>
          </Fieldset>
          <Fieldset legend="Text Outline">
            <Row label="C&olor"><ColorPick value={null} automatic={null} onChange={(c) => c && run('shapeFormat.wordArtStyles.textOutline', c)} /></Row>
          </Fieldset>
        </>
      )}
    </div>
  );
}
