// A sample of the dialog kit (docs/plans/word/plan.md §1.6): two tabs with a check box, a length box, radio buttons, a list, a
// colour box and a colour swatch (the app's picker, with opacity), and a third with the toolbar pickers (font, size, a named palette, toggles, a split button) over the forum post's
// lists. Package authors copy its shape; the scaffold-kit and kit-pickers harness cases open it (openDialog('kitSample', {modeless})).
import { useState } from 'react';
import { Bold, Highlighter, Italic, Underline } from 'lucide-react';
import { HUE } from '../../app/components/Toolbar.jsx';
import { FONT_SIZES, FONTS, HIGHLIGHTS, TEXT_COLORS } from '../../format.mjs';
import { SplitButton, ToggleGroup } from '../ribbon/parts.jsx';
import { ColorPick, PalettePanel } from './ColorPick.jsx';
import { ColorSwatch } from './ColorPicker.jsx';
import { Check, Fieldset, Pick, Preview, Radio, Row, Spin } from './controls.jsx';
import { FontPick, SizePick } from './FontPick.jsx';
import { WordDialog } from './WordDialog.jsx';

// The forum post's option lists as the pickers take them.
const FONT_OPTIONS = FONTS.map(({ label, css }) => ({ id: css, label, css }));
const TEXT_PALETTE = Object.entries(TEXT_COLORS).filter(([id]) => id !== 'root').map(([id, label]) => ({ id, label, swatch: HUE[id] }));
const HIGHLIGHT_PALETTE = HIGHLIGHTS.map((id) => ({ id, label: TEXT_COLORS[id], swatch: HUE[id] }));
const MARKS = [['bold', 'Bold', Bold], ['italic', 'Italic', Italic], ['underline', 'Underline', Underline]];
const stay = () => {}; // in a dialog the focus stays in the box after a pick

/** → {strike, indent (pt), align, size, color, fill, font, textSize, hue, highlight, marks} */
export function KitSample({ modeless = false, onClose }) {
  const [v, setV] = useState({ strike: false, indent: 0, align: 'left', size: 'a4', color: null, fill: '#4a7fe0', font: null, textSize: 100, hue: null, highlight: null, marks: [] });
  const set = (key) => (value) => setV((o) => ({ ...o, [key]: value }));
  const first = () => (
    <>
      <Fieldset legend="Effects">
        <Check label="Stri&kethrough" checked={v.strike} onChange={set('strike')} />
      </Fieldset>
      <Spin label="&Indent:" value={v.indent} onChange={set('indent')} unit="len" min={-1584} max={1584} />
      <Row label="Font &color:" htmlFor="kit-color"><ColorPick id="kit-color" value={v.color} onChange={set('color')} /></Row>
      <Row label="Fi&ll:" htmlFor="kit-fill"><ColorSwatch id="kit-fill" title="Fill" value={v.fill} onChange={set('fill')} /></Row>
      <Preview><span style={{ textDecoration: v.strike ? 'line-through' : undefined, color: v.color ?? undefined, background: v.fill }}>Sample text</span></Preview>
    </>
  );
  const second = () => (
    <>
      <Radio value={v.align} options={[['left', '&Left'], ['center', 'C&entre']]} onChange={set('align')} />
      <Row label="&Paper size:" htmlFor="kit-size">
        <Pick id="kit-size" value={v.size} options={[['a4', 'A4'], ['letter', 'Letter']]} onChange={set('size')} />
      </Row>
    </>
  );
  const toggle = (mark) => set('marks')(v.marks.includes(mark) ? v.marks.filter((m) => m !== mark) : [...v.marks, mark]);
  const third = () => (
    <>
      <Row label="Font:" htmlFor="kit-font"><FontPick id="kit-font" value={v.font} options={FONT_OPTIONS} onChange={set('font')} onDone={stay} placeholder="Default" /></Row>
      <Row label="Size:" htmlFor="kit-text-size">
        <SizePick id="kit-text-size" className="w-20" value={v.textSize} options={FONT_SIZES} unit="%" onChange={(s) => Number.isFinite(parseFloat(s)) && set('textSize')(parseFloat(s))} onDone={stay} />
      </Row>
      <Row label="Text colour:" htmlFor="kit-hue"><ColorPick id="kit-hue" palette={TEXT_PALETTE} automatic="Default" value={v.hue} onChange={set('hue')} /></Row>
      <div className="flex items-center gap-1">
        <ToggleGroup label="Marks" items={MARKS.map(([id, label, icon]) => ({ id: `kit.${id}`, label, icon, active: v.marks.includes(id), onClick: () => toggle(id) }))} />
        <SplitButton id="kit.highlight" label="Highlight" icon={Highlighter} value={HUE[v.highlight] ?? null} onClick={() => set('highlight')(v.highlight ? null : 'yellow')}>
          {(close) => <PalettePanel value={v.highlight} onChange={set('highlight')} palette={HIGHLIGHT_PALETTE} none="None" onPick={close} />}
        </SplitButton>
      </div>
      <Preview>
        <span style={{ fontFamily: v.font ?? undefined, fontSize: `${v.textSize}%`, color: HUE[v.hue] ?? undefined, background: HUE[v.highlight] ?? undefined,
          fontWeight: v.marks.includes('bold') ? 700 : undefined, fontStyle: v.marks.includes('italic') ? 'italic' : undefined,
          textDecoration: v.marks.includes('underline') ? 'underline' : undefined }}>Sample text</span>
      </Preview>
    </>
  );
  return (
    <WordDialog title="Kit sample" size="sm" modeless={modeless} onClose={onClose} result={() => v}
      tabs={[{ id: 'first', label: '&First', render: first }, { id: 'second', label: 'Seco&nd', render: second }, { id: 'toolbar', label: '&Toolbar', render: third }]} />
  );
}
