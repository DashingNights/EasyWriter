// The Format Shape pane's text box sections (docs/plans/word/plan.md §1.6 panels, _gaps-table-design.md G11; probe/dialogs/
// format-shape-pane.json): 'formatShape.textBox' (Layout & Properties > Text Box) and 'formatShape.text' (Text Options: Text Fill
// and Outline, Text Effects). The shapes package's pane draws them while ctx.obj is a text box; each writes on change.
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Check, Fieldset, Pick, Radio, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { DIRS, VALIGNS } from './boxes.mjs';
import { setBox } from './commands.js';
import { boxOf } from './view.js';

const MARGINS = [['l', '&Left margin'], ['r', '&Right margin'], ['t', '&Top margin'], ['b', '&Bottom margin']];

/** Layout & Properties > Text Box for the box the selection is on or in. */
export function TextBoxSection({ ctx }) {
  const b = ctx.state && boxOf(ctx.state);
  if (!b) return null;
  const a = b.node.attrs;
  const set = (patch) => setBox(ctx, patch);
  return (
    <div className="flex flex-col gap-2 text-[12px]" data-section="textBox">
      <Row label="&Vertical alignment" htmlFor="tb-valign">
        <Pick id="tb-valign" value={a.vAlign} options={VALIGNS} onChange={(vAlign) => set({ vAlign })} />
      </Row>
      <Row label="Te&xt direction" htmlFor="tb-dir">
        <Pick id="tb-dir" value={a.dir} options={DIRS} onChange={(dir) => set({ dir })} />
      </Row>
      <Check label="&Do not rotate text" checked={!!a.upright} onChange={(upright) => set({ upright })} />
      <Check label="Resize shape to &fit text" checked={!!a.autoFit} onChange={(autoFit) => set({ autoFit })} />
      {MARGINS.map(([k, label]) => (
        <Spin key={k} label={label} value={a.inset?.[k] ?? 0} unit="len" min={0} max={1584} onChange={(v) => set({ inset: { [k]: v } })} />
      ))}
      <Check label="&Wrap text in shape" checked={!a.noWrap} onChange={(on) => set({ noWrap: !on })} />
    </div>
  );
}

const run = (ctx) => {
  const range = ctx.state?.selection;
  if (!range) return {};
  const b = boxOf(ctx.state);
  const from = range.empty || range.node ? b?.pos ?? range.from : range.from;
  let attrs = null;
  ctx.state.doc.nodesBetween(from, Math.min(ctx.state.doc.content.size, from + (b?.node.nodeSize ?? 1)), (n) => {
    if (attrs || !n.isText) return !attrs;
    attrs = n.marks.find((m) => m.type.name === 'textStyle')?.attrs ?? {};
    return false;
  });
  return attrs ?? {};
};
const fillKind = (r) => r.effects?.fill?.type ?? 'solid';
const SHADOW = { shadow: 'shadow:outerBR', none: 'shadow:none' };

/** Text Options: Text Fill and Outline and Text Effects, through the Styled Text Styles commands. */
export function TextSection({ ctx }) {
  if (!ctx.state || !boxOf(ctx.state)) return null;
  const r = run(ctx);
  const o = r.effects?.outline;
  const go = (id, arg) => ctx.run(id, arg);
  return (
    <div className="flex flex-col gap-2 text-[12px]" data-section="text">
      <Fieldset legend="Text Fill">
        <Radio name="tb-fill" value={fillKind(r)} options={[['none', '&No fill'], ['solid', '&Solid fill'], ['gradient', '&Gradient fill']]}
          onChange={(v) => go('shapeFormat.wordArtStyles.textFill', v === 'none' ? 'none' : v === 'gradient' ? 'grad:light' : r.color ?? '#000000')} />
        <Row label="&Color" htmlFor="tb-fill-color">
          <ColorPick id="tb-fill-color" value={r.color ?? null} themeColor={r.themeColor} automatic={null}
            onChange={(color, themeColor) => color && go('shapeFormat.wordArtStyles.textFill', { color, themeColor })} />
        </Row>
      </Fieldset>
      <Fieldset legend="Text Outline">
        <Radio name="tb-line" value={o ? 'solid' : 'none'} options={[['none', 'N&o line'], ['solid', 'Solid l&ine']]}
          onChange={(v) => go('shapeFormat.wordArtStyles.textOutline', v === 'none' ? 'none' : o?.color ?? '#000000')} />
        <Row label="C&olor" htmlFor="tb-line-color">
          <ColorPick id="tb-line-color" value={o?.color ?? null} automatic={null}
            onChange={(color) => color && go('shapeFormat.wordArtStyles.textOutline', color)} />
        </Row>
        <Spin label="&Width" value={o?.width ?? 0.75} unit="pt" min={0} max={1584} step={0.25} onChange={(w) => go('shapeFormat.wordArtStyles.textOutline', `w:${w}`)} />
      </Fieldset>
      <Fieldset legend="Text Effects">
        <Check label="S&hadow" checked={!!r.effects?.shadow} onChange={(on) => go('shapeFormat.wordArtStyles.textEffects', SHADOW[on ? 'shadow' : 'none'])} />
        <Check label="&Reflection" checked={!!r.effects?.reflection} onChange={(on) => go('shapeFormat.wordArtStyles.textEffects', on ? 'reflection:half' : 'reflection:none')} />
        <Check label="G&low" checked={!!r.effects?.glow} onChange={(on) => go('shapeFormat.wordArtStyles.textEffects', on ? 'glow:accent1' : 'glow:none')} />
      </Fieldset>
    </div>
  );
}
