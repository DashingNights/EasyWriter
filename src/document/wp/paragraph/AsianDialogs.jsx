// The Asian Layout dialogs (docs/plans/word/briefs/paragraph.md; probe/dialogs/two-lines-in-one.json, combine-characters.json,
// horizontal-in-vertical.json, fit-text.json): each writes the selection's run properties (textStyle eastAsianLayout or fitText)
// and the paragraph extension draws them. Remove takes the setting off again.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Check, Pick, Preview, Row, Spin, useUnit } from '../../../tooling/kit/controls.jsx';
import { formatLength } from '../../../tooling/kit/units.mjs';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { ctxOf } from '../../../tooling/registry.js';
import { round2 } from './rules.mjs';

const BRACKETS = [['round', '()'], ['square', '[]'], ['angle', '<>'], ['curly', '{}']];
const PAIRS = { round: '()', square: '[]', angle: '<>', curly: '{}' };
const fontName = (f, theme) => (f === '+minor' ? theme?.fonts?.minor ?? 'Aptos' : f === '+major' ? theme?.fonts?.major ?? 'Aptos Display' : f);
const SIZES = ['4', '5', '6', '7', '8', '9', '10', '10.5', '11', '12', '14', '16', '18', '20', '22', '24', '26', '28', '36', '48', '72'].map((s) => [Number(s), s]);

/** The selection in the editor commands act on: {from, to, text, ts (the first run's textStyle attrs), view, theme, flat (inside
 * one paragraph, so its text can be replaced without joining paragraphs)}. */
function selection() {
  const { target } = ctxOf();
  const { from, to, $from, $to } = target.state.selection;
  let ts = null;
  target.state.doc.nodesBetween(from, to, (n) => {
    ts ??= n.isText ? n.marks.find((m) => m.type.name === 'textStyle')?.attrs ?? {} : null;
    return !ts;
  });
  return { from, to, text: target.state.doc.textBetween(from, to, ' '), ts: ts ?? {}, view: target.view, theme: target.state.doc.attrs.theme,
    flat: $from.sameParent($to) };
}

/** Writes run properties `props` over the selection, first replacing its text with `text` when the user changed it. On a canvas
 * draft (`sel.engine`, from the row) the East Asian layout goes to the engine as format.set's eastAsianLayout, a setting taken off
 * written as off. */
function write(sel, text, props) {
  if (sel.engine) {
    // A setting taken off is written off; brackets taken off are left out (the engine's layout replaces the whole setting).
    const e = Object.fromEntries(Object.entries(props.eastAsianLayout ?? {}).filter(([k, v]) => v != null || k !== 'combineBrackets')
      .map(([k, v]) => [k, v ?? false]));
    const c = ctxOf();
    // Fit Text: the engine's fitText {width, id}; width 0 takes it off.
    const fit = 'fitText' in props ? { fitText: props.fitText ? { width: props.fitText.w, id: props.fitText.id } : { width: 0 } } : null;
    const steps = [];
    // Text changed in the dialog replaces the selection's, which stays selected (offsets are UTF-8 bytes in the engine).
    if (sel.flat && sel.anchor && text != null && text && text !== sel.text) {
      const from = [sel.anchor, sel.focus].sort((a, b) => a.off - b.off)[0];
      steps.push(['text.insert', { text }], ['select.range', { anchor: from, focus: { ...from, off: from.off + new TextEncoder().encode(text).length } }]);
    }
    steps.push(['format.set', { props: fit ?? { eastAsianLayout: e } }]);
    Promise.resolve(c.engine?.execMany(steps))
      .then((r) => r?.ok === false && c.toast(`Could not apply it: ${r.error ?? 'the engine refused it'}`));
    return;
  }
  ctxOf().chain((c) => {
    let ch = c;
    // insertText keeps the marks of the replaced text; a selection across paragraphs keeps its text.
    if (sel.flat && text != null && text !== sel.text && text) {
      ch = ch.command(({ tr }) => !!tr.insertText(text, sel.from, sel.to)).setTextSelection({ from: sel.from, to: sel.from + text.length });
    }
    return ch.setRunProps(props);
  });
}

const TextBox = ({ id, value, onChange, max, disabled }) => (
  <Input id={id} size="xs" value={value} maxLength={max} disabled={disabled} spellCheck={false} onChange={(e) => onChange(e.target.value)} className="w-56" />
);

/** Two Lines in One: the selection drawn as two half-size lines in one line, optionally in brackets (eastAsianLayout combine). */
export function TwoLinesInOne({ onClose, engineSel = null }) {
  const [sel] = useState(() => (engineSel && ctxOf().engine ? { ...engineSel, engine: true } : selection()));
  const eal = sel.ts.eastAsianLayout;
  const [text, setText] = useState(sel.text);
  const [enclose, setEnclose] = useState(!!eal?.combineBrackets);
  const [bracket, setBracket] = useState(eal?.combineBrackets ?? 'round');
  const pair = enclose ? PAIRS[bracket] : '';
  return (
    <WordDialog title="Two Lines in One" size="sm" onClose={onClose}
      left={[{ label: '&Remove', disabled: !eal?.combine, onClick: () => { write(sel, null, { eastAsianLayout: { combine: null, combineBrackets: null } }); onClose(false); } }]}
      result={() => { write(sel, text, { eastAsianLayout: { combine: true, combineBrackets: enclose ? bracket : null } }); return true; }}>
      <Row label="&Text:" htmlFor="tl-text"><TextBox id="tl-text" value={text} onChange={setText} disabled={!sel.flat} /></Row>
      <Check label="&Enclose in brackets:" checked={enclose} onChange={setEnclose} />
      <Row label="&Bracket style:" htmlFor="tl-bracket">
        <Pick id="tl-bracket" value={bracket} options={BRACKETS} onChange={setBracket} disabled={!enclose} width="5rem" />
      </Row>
      <Preview>{pair[0]}<span className="inline-block w-[4ch] align-middle text-[50%] leading-none break-all">{text}</span>{pair[1]}</Preview>
    </WordDialog>
  );
}

/** Combine Characters: up to six characters stacked in two rows in one character cell, in a font and size of their own. */
export function CombineCharacters({ onClose, engineSel = null }) {
  // On a canvas draft (`engineSel`, format.combineState) Word's EQ field is made and taken off by format.combineCharacters.
  const engine = engineSel && ctxOf().engine ? engineSel : null;
  const [sel] = useState(() => (engine ? { ts: { font: engine.font, size: engine.textSize }, text: engine.text, flat: true } : selection()));
  const cc = engine ? (engine.current ? { font: engine.font, size: engine.size } : null) : sel.ts.eastAsianLayout?.combineChars;
  const [text, setText] = useState(sel.text.slice(0, 6));
  // The theme's body or heading font shows by its name, as in Word, and stays the theme token while the name is unchanged.
  const token = cc?.font ?? sel.ts.font ?? '+minor';
  const [font, setFont] = useState(() => fontName(token, sel.theme));
  const [size, setSize] = useState(cc?.size ?? (engine ? engine.size : Math.max(4, (sel.ts.size ?? 12) / 2)));
  const run = (args) => {
    const c = ctxOf();
    Promise.resolve(c.engine?.exec('format.combineCharacters', args))
      .then((r) => r?.ok === false && c.toast(`Could not apply it: ${r.error ?? 'the engine refused it'}`));
  };
  const remove = () => (engine ? run({ remove: true }) : write(sel, null, { eastAsianLayout: { combineChars: null } }));
  const apply = () => (engine
    ? run({ text, size, ...(font !== fontName(token, sel.theme) && { font }) })
    : write({ ...sel, to: Math.min(sel.to, sel.from + 6) }, text, { eastAsianLayout: { combineChars: { font: font === fontName(token, sel.theme) ? token : font, size } } }));
  return (
    <WordDialog title="Combine Characters" size="sm" onClose={onClose}
      left={[{ label: '&Remove', disabled: !cc, onClick: () => { remove(); onClose(false); } }]}
      result={() => { apply(); return true; }}>
      <Row label="&Text (up to 6):" htmlFor="cc-text"><TextBox id="cc-text" value={text} onChange={setText} max={6} disabled={!sel.flat} /></Row>
      <Row label="&Font:" htmlFor="cc-font"><TextBox id="cc-font" value={font} onChange={setFont} /></Row>
      <Row label="&Size:" htmlFor="cc-size"><Pick id="cc-size" value={size} options={SIZES} onChange={setSize} width="5rem" /> pt</Row>
      <Preview><span className="inline-block w-[3ch] align-middle leading-none break-all" style={{ fontSize: `${size}pt` }}>{text}</span></Preview>
    </WordDialog>
  );
}

/** Horizontal in Vertical: characters set across inside vertical text (eastAsianLayout vert, vertCompress for Fit in line). It shows
 * only in vertical text, which this build does not lay out yet (REASONS.verticalText), so elsewhere it is stored. */
export function HorizontalInVertical({ onClose, engineSel = null }) {
  const [sel] = useState(() => (engineSel && ctxOf().engine ? { ...engineSel, engine: true } : selection()));
  const eal = sel.ts.eastAsianLayout;
  const [fit, setFit] = useState(eal?.vertCompress ?? true);
  return (
    <WordDialog title="Horizontal in Vertical" size="sm" onClose={onClose}
      left={[{ label: '&Remove', disabled: !eal?.vert, onClick: () => { write(sel, null, { eastAsianLayout: { vert: null, vertCompress: null } }); onClose(false); } }]}
      result={() => { write(sel, null, { eastAsianLayout: { vert: true, vertCompress: fit } }); return true; }}>
      <Row label="Text:" htmlFor="hv-text"><TextBox id="hv-text" value={sel.text} onChange={() => {}} disabled /></Row>
      <Check label="&Fit in line" checked={fit} onChange={setFit} />
      <Preview><span style={{ writingMode: 'vertical-rl' }}>文<span style={{ textCombineUpright: 'all' }}>{sel.text.slice(0, 4)}</span>文</span></Preview>
    </WordDialog>
  );
}

/** The width in points the selection takes on screen (zoom removed). */
function widthOf(sel) {
  try {
    const a = sel.view.coordsAtPos(sel.from);
    const b = sel.view.coordsAtPos(sel.to);
    const dom = sel.view.dom;
    const scale = dom.getBoundingClientRect().width / (dom.offsetWidth || 1) || 1;
    return round2(Math.abs(b.left - a.left) / scale * 0.75);
  } catch {
    return 0;
  }
}

/** Fit Text: the selection squeezed or stretched to a width (textStyle fitText {w, id}). */
export function FitText({ onClose, engineSel = null }) {
  const [sel] = useState(() => (engineSel && ctxOf().engine ? { ...engineSel, engine: true } : selection()));
  const own = sel.ts.fitText;
  const [now] = useState(() => own?.w ?? (sel.engine ? sel.width ?? 0 : widthOf(sel)));
  const [w, setW] = useState(now);
  const unit = useUnit();
  return (
    <WordDialog title="Fit Text" size="sm" onClose={onClose} validate={() => (w > 0 ? null : 'Type a width above 0.')}
      left={[{ label: '&Remove', disabled: !own, onClick: () => { write(sel, null, { fitText: null }); onClose(false); } }]}
      result={() => { write(sel, null, { fitText: { w, id: own?.id ?? Math.floor(Math.random() * 1e9) } }); return true; }}>
      <Row label="Current text width:"><span data-current-width={now}>{formatLength(now, unit)}</span></Row>
      <Spin label="New &text width:" value={w} onChange={setW} unit="len" min={0} max={1584} />
    </WordDialog>
  );
}
