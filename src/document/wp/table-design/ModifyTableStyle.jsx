// Modify Table Style and Create New Style from Formatting for a table style (dialog modifyTableStyle; the shell of
// probe/dialogs/create-new-style-from-formatting-full.json with Word's table rows): Name, Style type Table, Style based on,
// Apply formatting to (the whole table or one conditional format), a font row, a border row with cell shading, the cell
// alignment, a 5 x 5 preview, the description, Only in this document and the Format menu, which opens the owning packages'
// dialogs in value mode. Resolves {id, def}: the style's id and its whole definition, which index.js writes in one step.
// Also Stripes (tableStripes): the rows and columns in each band (w:tblStyleRowBandSize, w:tblStyleColBandSize).
import { useEffect, useState } from 'react';
import { Bold, Italic, Underline } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioInput } from '@/components/ui/radio';
import { openDialog } from '../../../app/actions.js';
import { FONT_SIZES, FONTS } from '../../../office.mjs';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Fieldset, Pick, Preview, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { resolved } from '../../stylesheet.js';
import { MiniTable } from './preview.jsx';
import { nextStyleName, partOf, PEN_STYLES, PEN_WEIGHTS, sidesOf, tableStyleDef, withPart } from './styles.mjs';

// Apply formatting to: Word's list and the conditional format each one edits.
const PARTS = [['wholeTable', 'Whole table'], ['firstRow', 'Header row'], ['lastRow', 'Total row'], ['band1Horz', 'Odd banded rows'],
  ['band2Horz', 'Even banded rows'], ['firstCol', 'First column'], ['lastCol', 'Last column'], ['band1Vert', 'Odd banded columns'],
  ['band2Vert', 'Even banded columns'], ['nwCell', 'Top left cell'], ['neCell', 'Top right cell'], ['swCell', 'Bottom left cell'], ['seCell', 'Bottom right cell']];
// The border row's edges menu: which edges of the part take the border row's line.
const EDGES = [['', 'Borders...'], ['all', 'All Borders'], ['outside', 'Outside Borders'], ['inside', 'Inside Borders'], ['top', 'Top Border'],
  ['bottom', 'Bottom Border'], ['left', 'Left Border'], ['right', 'Right Border'], ['insideH', 'Inside Horizontal Border'],
  ['insideV', 'Inside Vertical Border'], ['none', 'No Border']];
const EDGE_SETS = { all: ['top', 'bottom', 'left', 'right', 'insideH', 'insideV'], outside: ['top', 'bottom', 'left', 'right'], inside: ['insideH', 'insideV'],
  none: ['top', 'bottom', 'left', 'right', 'insideH', 'insideV'] };
// The nine cell alignments: vertical then horizontal.
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const ALIGNS = ['top', 'center', 'bottom'].flatMap((v) => ['left', 'center', 'right'].map((x) => [`${v} ${x}`,
  v === 'center' && x === 'center' ? 'Align Center' : `Align ${cap(v)} ${cap(x)}`]));
const FONT_LIST = [['', ''], ['+minor', '+Body'], ['+major', '+Headings'], ...FONTS.map((f) => [f, f])];
const SIZE_LIST = [['', ''], ...FONT_SIZES.map((s) => [String(s), String(s)])];
// Preview with every part shown, so a change to any of them shows.
const PREVIEW_LOOK = { firstRow: true, lastRow: true, firstColumn: true, lastColumn: false, noHBand: false, noVBand: true };

/** A sentence describing part `key` of `def`, as Word's description line does. */
function describe(def, key, names) {
  const p = partOf(def, key);
  const bits = [];
  if (p.run?.font) bits.push(`Font ${p.run.font.replace('+minor', '+Body').replace('+major', '+Headings')}`);
  if (p.run?.size) bits.push(`${p.run.size} pt`);
  for (const k of ['bold', 'italic']) if (p.run?.[k]) bits.push(k === 'bold' ? 'Bold' : 'Italic');
  if (p.run?.color) bits.push(`Font colour ${p.run.color}`);
  if (p.cell?.shading?.fill && p.cell.shading.fill !== 'auto') bits.push(`Shading ${p.cell.shading.fill}`);
  if (p.cell?.borders && Object.keys(p.cell.borders).length) bits.push('Borders');
  if (p.para?.align) bits.push(`Aligned ${p.para.align}`);
  const base = def.basedOn ? `Based on ${names[def.basedOn] ?? def.basedOn}` : 'No base style';
  return `${PARTS.find(([k]) => k === key)[1]}: ${bits.length ? bits.join(', ') : 'no formatting of its own'}. ${base}.`;
}

/** The registered dialogs ({id: Component}), for the Format menu to disable the ones without an owner yet. Loaded on first use:
 * the dialog registry imports the module hub, which imports this file. */
function useDialogs() {
  const [all, setAll] = useState({});
  useEffect(() => {
    import('../../../tooling/dialogs.js').then((m) => setAll(m.WORD_DIALOGS));
  }, []);
  return all;
}

/** Props: styleId (the table's style), create (Create New Style from Formatting), list (doc.attrs.styles.list), theme, look. */
export function ModifyTableStyle({ styleId, create = false, list = {}, theme, onClose }) {
  const [def, setDef] = useState(() => (create
    ? { type: 'table', name: nextStyleName(list), basedOn: 'TableNormal', table: {} }
    : structuredClone(list[styleId] ?? tableStyleDef(styleId, theme) ?? { type: 'table', name: styleId, basedOn: 'TableNormal', table: {} })));
  const [key, setKey] = useState('wholeTable');
  const [line, setLine] = useState({ style: 'single', width: 0.5, color: null });
  const part = partOf(def, key);
  const set = (patch) => setDef((d) => withPart(d, key, patch));
  // The id from the name's letters; a name with none (Chinese, say), or an id the document or the gallery already uses, gets
  // the next free StyleN.
  const stripped = def.name.replace(/[^\w-]/g, '');
  const id = !create ? styleId : stripped && !list[stripped] && !tableStyleDef(stripped, theme) ? stripped : nextStyleName(list);
  const names = Object.fromEntries(Object.entries(list).map(([k, s]) => [k, s.name ?? k]));
  const bases = [['TableNormal', names.TableNormal ?? 'Normal Table'],
    ...Object.entries(list).filter(([k, s]) => s.type === 'table' && k !== 'TableNormal' && k !== id).map(([k, s]) => [k, s.name ?? k])];
  const shown = resolved({ ...list, [id]: def }, id);
  const dialogs = useDialogs();

  const toggle = (k) => set({ run: { [k]: k === 'underline' ? (part.run?.underline ? null : 'single') : part.run?.[k] ? null : true } });
  const edges = (which) => {
    if (!which) return;
    const e = which === 'none' ? { style: 'nil' } : { style: line.style, width: line.width, space: 0, color: line.color };
    const sides = EDGE_SETS[which] ?? [which];
    // A single edge object stands for all six sides, so spell them out before replacing some.
    set({ cell: { borders: { ...sidesOf(part.cell?.borders), ...Object.fromEntries(sides.map((s) => [s, e])) } } });
  };
  const [v, x] = [part.cell?.vAlign ?? 'top', part.para?.align ?? 'left'];
  // The Format menu: another package's dialog edits this part's run, paragraph or cell borders and returns the value.
  const format = async (dialog, props, take) => {
    const r = await openDialog(dialog, { mode: 'value', ...props });
    if (r) take(r);
  };
  const FORMAT = [
    ['Table P&roperties...', 'tableProperties', () => format('tableProperties', { value: def.table },
      (r) => setDef((d) => ({ ...d, table: { ...d.table, ...r, cond: d.table?.cond } })))],
    ['&Borders and Shading...', 'bordersAndShading', () => format('bordersAndShading', { tab: 'borders', apply: 'cell', value: part.cell ?? {} },
      (r) => { const c = r.cell ?? r.para ?? r; set({ cell: { borders: c.borders ?? null, shading: c.shading ?? null } }); })],
    ['&Font...', 'font', () => format('font', { value: part.run ?? {} }, (r) => set({ run: r.run ?? r }))],
    ['&Paragraph...', 'paragraph', () => format('paragraph', { value: part.para ?? {} }, (r) => set({ para: r.para ?? r }))],
    ['&Tabs...', 'tabs', () => format('tabs', { value: part.para ?? {} }, (r) => set({ para: r.para ?? r }))],
    ['&Stripes...', 'tableStripes', async () => {
      const r = await openDialog('tableStripes', { rows: def.table?.rowBandSize ?? 1, cols: def.table?.colBandSize ?? 1 });
      if (r) setDef((d) => ({ ...d, table: { ...d.table, rowBandSize: r.rows, colBandSize: r.cols } }));
    }],
  ];
  const tool = (k, Icon, label) => (
    <Button type="button" variant="outline" size="icon-xs" aria-label={label} aria-pressed={!!part.run?.[k]} onClick={() => toggle(k)}
      className="aria-pressed:bg-accent"><Icon /></Button>
  );
  return (
    <WordDialog title={create ? 'Create New Style from Formatting' : 'Modify Style'} size="lg" onClose={onClose}
      validate={() => (!def.name?.trim() ? 'Type a name for the style.'
        : Object.entries(list).some(([k, s]) => k !== id && (s.name ?? k) === def.name.trim()) ? 'A style with this name already exists.' : null)}
      result={() => ({ id, def: { ...def, name: def.name.trim() } })}>
      <div className="td-dialog flex flex-col gap-3">
        <Fieldset legend="Properties">
          <Row label="&Name:" htmlFor="mts-name">
            <Input id="mts-name" size="xs" className="w-72" value={def.name ?? ''} onChange={(e) => setDef((d) => ({ ...d, name: e.target.value }))} />
          </Row>
          <Row label="S&tyle type:" htmlFor="mts-type"><Pick id="mts-type" value="table" options={[['table', 'Table']]} onChange={() => {}} disabled width="18rem" /></Row>
          <Row label="Style &based on:" htmlFor="mts-base">
            <Pick id="mts-base" value={def.basedOn ?? 'TableNormal'} options={bases} onChange={(b) => setDef((d) => ({ ...d, basedOn: b }))} width="18rem" />
          </Row>
        </Fieldset>
        <Fieldset legend="Formatting">
          <Row label="Apply formatting t&o:" htmlFor="mts-part"><Pick id="mts-part" value={key} options={PARTS} onChange={setKey} width="18rem" /></Row>
          <div className="flex flex-wrap items-center gap-1.5">
            <Pick aria-label="Font" value={part.run?.font ?? ''} options={FONT_LIST} onChange={(f) => set({ run: { font: f || null } })} width="10rem" />
            <Pick aria-label="Font Size" value={part.run?.size != null ? String(part.run.size) : ''} options={SIZE_LIST}
              onChange={(s) => set({ run: { size: s ? Number(s) : null } })} width="4rem" />
            {tool('bold', Bold, 'Bold')}{tool('italic', Italic, 'Italic')}{tool('underline', Underline, 'Underline')}
            <ColorPick id="mts-color" value={part.run?.color ?? null} themeColor={part.run?.themeColor ?? null}
              onChange={(color, themeColor) => set({ run: { color, themeColor } })} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Pick aria-label="Line Style" value={line.style} options={PEN_STYLES} onChange={(s) => setLine((l) => ({ ...l, style: s }))} width="10rem" />
            <Pick aria-label="Line Weight" value={String(line.width)} options={PEN_WEIGHTS.map(([w, l]) => [String(w), l])}
              onChange={(w) => setLine((l) => ({ ...l, width: Number(w) }))} width="5rem" />
            <ColorPick id="mts-line-color" value={line.color} onChange={(color) => setLine((l) => ({ ...l, color }))} />
            <Pick aria-label="Borders" value="" options={EDGES} onChange={edges} width="11rem" />
            <span className="ml-2 text-xs">Shading</span>
            <ColorPick id="mts-shading" automatic="No Color" value={part.cell?.shading?.fill && part.cell.shading.fill !== 'auto' ? part.cell.shading.fill : null}
              themeColor={part.cell?.shading?.themeFill ?? null}
              onChange={(fill, link) => set({ cell: { shading: fill ? { val: 'clear', color: 'auto', fill, ...(link && { themeFill: link }) } : null } })} />
          </div>
          <Row label="A&lignment:" htmlFor="mts-align">
            <Pick id="mts-align" value={`${v} ${x}`} options={ALIGNS} width="12rem" onChange={(a) => {
              const [nv, nx] = a.split(' ');
              set({ cell: { vAlign: nv === 'top' ? null : nv }, para: { align: nx === 'left' ? null : nx } });
            }} />
          </Row>
          <Preview height="11rem"><MiniTable def={shown} look={PREVIEW_LOOK} big /></Preview>
          <p className="text-xs text-muted-foreground" data-description="">{describe(def, key, names)}</p>
        </Fieldset>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2" {...accessProps('Only in this &document')}>
            <RadioInput name="mts-scope" checked readOnly /><AccessText label="Only in this &document" />
          </label>
          {/* The template option is out of scope: Documents have no templates yet. */}
          <label className="flex items-center gap-2 opacity-50">
            <RadioInput name="mts-scope" disabled />New documents based on this template
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="ml-auto" {...accessProps('F&ormat')}><AccessText label="F&ormat" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {FORMAT.map(([label, dialog, go]) => (
                <DropdownMenuItem key={dialog} disabled={!dialogs[dialog]} onSelect={go} data-format={dialog}>
                  <AccessText label={label} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </WordDialog>
  );
}

/** Stripes: how many rows and columns each band holds. → {rows, cols}. */
export function TableStripes({ rows = 1, cols = 1, onClose }) {
  const [v, setV] = useState({ rows, cols });
  return (
    <WordDialog title="Stripes" size="sm" onClose={onClose} result={() => v}>
      <Spin label="Number of &rows in each band:" value={v.rows} unit="int" min={1} max={99} step={1} onChange={(n) => setV((o) => ({ ...o, rows: n }))} />
      <Spin label="Number of &columns in each band:" value={v.cols} unit="int" min={1} max={99} step={1} onChange={(n) => setV((o) => ({ ...o, cols: n }))} />
    </WordDialog>
  );
}
