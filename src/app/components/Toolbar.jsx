import { useState } from 'react';
import { cn } from 'cn';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Ban, Baseline, BetweenHorizontalEnd, BetweenVerticalEnd, Bold, ChevronDown, Code, Frame,
  Grid2x2X, Highlighter, ImagePlus, Italic, Link, List, ListOrdered, Minus, Palette, PanelTop, Presentation, Quote, Redo2,
  RemoveFormatting, SquareCode, SquareKanban, Strikethrough, Subscript, Superscript, Table, Underline, Undo2, Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Toggle } from '@/components/ui/toggle';
import { FONT_SIZES, TEXT_COLORS, HIGHLIGHTS, FONTS } from '../../extensions.js';
import { addImageFilesToEditor } from '../../whiteboard.js';
import {
  afterNodeSel, applyPresetAt, cssFamily, insertCanvas, openLinkDialog, openSettings, refocusEditor, run,
} from '../actions.js';
import { insertFlowchartDialog } from '../flows.js';
import { can } from '../gates.mjs';
import { insertPlanChartDialog } from '../plans.js';
import { keyLabel, withKey } from '../keybinds.js';
import { getState, useEditor, useStore } from '../store.js';
import { Tip } from './Tip.jsx';

// Swatch colours for the app chrome (forum dark palette, SPEC §1).
const HUE = {
  root: '#c5c6d0', soft: '#a3a6b8', hard: '#ffffff', red: '#e05252', orange: '#e09952', yellow: '#e0c952',
  green: '#62d926', blue: '#3d99f5', indigo: '#9c6ef7', violet: '#e052e0',
};
export const NONE = '-'; // Radix Select items need a non-empty value: stands for '' (no font, no thread)
export const keepFocus = (e) => e.preventDefault(); // toolbar buttons never take focus, so the editor keeps its selection

// Detached file input of the Image control (click() opens the picker): each picked image goes in as a canvas.
const imageInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple: true });
imageInput.addEventListener('change', () => {
  const files = [...imageInput.files];
  imageInput.value = '';
  const editor = getState().editor;
  if (files.length && editor) addImageFilesToEditor(editor, files);
});

/** The toolbar's controls, shared with the text mode of the board rail (§6c) and the tool search (§7c), for the editor
 * `ed` (null while there is none): ToolButton / RailButton props ({title, children, active?, disabled?, onClick}),
 * SwatchMenu props for the colours, {value, set} for the selects. */
export function textTools(ed) {
  const is = (...args) => !!ed?.isActive(...args);
  const color = ed?.getAttributes('textColor').color;
  const highlight = is('highlight') ? ed.getAttributes('highlight').color : '';
  let block = is('paragraph') ? 'p' : '';
  for (let l = 1; l <= 6; l++) if (is('heading', { level: l })) block = `h${l}`;
  return {
    block: { value: block, set: (v) => run((c) => (v === 'p' ? c.setParagraph() : c.setHeading({ level: Number(v.slice(1)) }))) },
    font: { value: ed?.getAttributes('fontFamily').font || NONE, set: (v) => run((c) => (v !== NONE ? c.setFontFamily(v) : c.unsetFontFamily())) },
    size: { value: String(ed?.getAttributes('fontSize').size || 100), set: (v) => run((c) => c.setFontSize(v)) },
    undo: { title: withKey('Undo', 'edit.undo'), keyId: 'edit.undo', disabled: !can('history.canUndo', { canUndo: ed?.can().undo() }), onClick: () => run((c) => c.undo()), children: <Undo2 /> },
    redo: { title: withKey('Redo', 'edit.redo'), keyId: 'edit.redo', disabled: !can('history.canRedo', { canRedo: ed?.can().redo() }), onClick: () => run((c) => c.redo()), children: <Redo2 /> },
    bold: { title: withKey('Bold', 'text.bold'), keyId: 'text.bold', active: is('bold'), onClick: () => run((c) => c.toggleBold()), children: <Bold /> },
    italic: { title: withKey('Italic', 'text.italic'), keyId: 'text.italic', active: is('italic'), onClick: () => run((c) => c.toggleItalic()), children: <Italic /> },
    underline: { title: withKey('Underline', 'text.underline'), keyId: 'text.underline', active: is('underline'), onClick: () => run((c) => c.toggleUnderline()), children: <Underline /> },
    strike: { title: withKey('Strikethrough', 'text.strike'), keyId: 'text.strike', active: is('strike'), onClick: () => run((c) => c.toggleStrike()), children: <Strikethrough /> },
    sub: { title: withKey('Subscript', 'text.subscript'), keyId: 'text.subscript', active: is('subscript'), onClick: () => run((c) => c.toggleSubscript()), children: <Subscript /> },
    sup: { title: withKey('Superscript', 'text.superscript'), keyId: 'text.superscript', active: is('superscript'), onClick: () => run((c) => c.toggleSuperscript()), children: <Superscript /> },
    code: { title: withKey('Inline code', 'text.code'), keyId: 'text.code', active: is('code'), onClick: () => run((c) => c.toggleCode()), children: <Code /> },
    color: {
      title: 'Text colour', icon: <Baseline />, bar: HUE[color] || HUE.root,
      swatches: Object.entries(TEXT_COLORS).map(([key, label]) => ({
        key, label, color: HUE[key], active: (color || 'root') === key, pick: () => run((c) => c.setTextColor(key)),
      })),
    },
    highlight: {
      title: 'Highlight', icon: <Highlighter />, bar: highlight ? HUE[highlight] || 'transparent' : 'transparent',
      swatches: [
        { key: 'none', label: 'None', color: null, active: !highlight, pick: () => run((c) => c.unsetHighlight()) },
        ...HIGHLIGHTS.map((key) => ({
          key, label: TEXT_COLORS[key] || key, color: HUE[key], active: highlight === key, pick: () => run((c) => c.setHighlight(key)),
        })),
      ],
    },
    alignLeft: { title: withKey('Align left', 'text.alignLeft'), keyId: 'text.alignLeft', active: !['center', 'right', 'justify'].some((a) => is({ textAlign: a })), onClick: () => run((c) => c.setTextAlign('left')), children: <AlignLeft /> },
    alignCenter: { title: withKey('Align centre', 'text.alignCenter'), keyId: 'text.alignCenter', active: is({ textAlign: 'center' }), onClick: () => run((c) => c.setTextAlign('center')), children: <AlignCenter /> },
    alignRight: { title: withKey('Align right', 'text.alignRight'), keyId: 'text.alignRight', active: is({ textAlign: 'right' }), onClick: () => run((c) => c.setTextAlign('right')), children: <AlignRight /> },
    justify: { title: withKey('Justify', 'text.alignJustify'), keyId: 'text.alignJustify', active: is({ textAlign: 'justify' }), onClick: () => run((c) => c.setTextAlign('justify')), children: <AlignJustify /> },
    bulletList: { title: withKey('Bullet list', 'text.bulletList'), keyId: 'text.bulletList', active: is('bulletList'), onClick: () => run((c) => c.toggleBulletList()), children: <List /> },
    orderedList: { title: withKey('Numbered list', 'text.orderedList'), keyId: 'text.orderedList', active: is('orderedList'), onClick: () => run((c) => c.toggleOrderedList()), children: <ListOrdered /> },
    quote: { title: withKey('Quote', 'text.blockquote'), keyId: 'text.blockquote', active: is('blockquote'), onClick: () => run((c) => c.toggleBlockquote()), children: <Quote /> },
    codeBlock: { title: withKey('Code block', 'text.codeBlock'), keyId: 'text.codeBlock', active: is('codeBlock'), onClick: () => run((c) => c.toggleCodeBlock()), children: <SquareCode /> },
    rule: { title: 'Horizontal rule', onClick: () => run((c) => c.setHorizontalRule()), children: <Minus /> },
    table: { title: 'Insert 3x3 table with header row', onClick: () => run((c) => afterNodeSel(c).insertTable({ rows: 3, cols: 3, withHeaderRow: true })), children: <Table /> },
    // Shown while the caret is in a table.
    addRow: { title: 'Add row after', onClick: () => run((c) => c.addRowAfter()), children: <BetweenHorizontalEnd /> },
    addColumn: { title: 'Add column after', onClick: () => run((c) => c.addColumnAfter()), children: <BetweenVerticalEnd /> },
    deleteRow: { title: 'Delete row', onClick: () => run((c) => c.deleteRow()), children: '-Row' },
    deleteColumn: { title: 'Delete column', onClick: () => run((c) => c.deleteColumn()), children: '-Col' },
    deleteTable: { title: 'Delete table', onClick: () => run((c) => c.deleteTable()), children: <Grid2x2X /> },
    box: { title: 'Insert titled box', active: is('box'), onClick: () => run((c) => afterNodeSel(c).insertBox()), children: <PanelTop /> },
    link: { title: withKey('Link', 'text.link'), keyId: 'text.link', active: is('link'), onClick: openLinkDialog, children: <Link /> },
    whiteboard: { title: withKey('Insert whiteboard', 'insert.whiteboard'), keyId: 'insert.whiteboard', onClick: () => run((c) => afterNodeSel(c).insertWhiteboard()), children: <Presentation /> },
    canvas: { title: withKey('Insert canvas', 'insert.canvas'), keyId: 'insert.canvas', onClick: insertCanvas, children: <Frame /> },
    flowchart: { title: withKey('Insert flowchart', 'insert.flowchart'), keyId: 'insert.flowchart', disabled: !can('doc.open', { editor: ed }), onClick: insertFlowchartDialog, children: <Workflow /> },
    planChart: { title: 'Insert plan chart', disabled: !can('doc.open', { editor: ed }), onClick: insertPlanChartDialog, children: <SquareKanban /> },
    image: { title: 'Insert image(s), each as a canvas', onClick: () => imageInput.click(), children: <ImagePlus /> },
    clear: { title: 'Clear formatting', onClick: () => run((c) => c.unsetAllMarks().clearNodes()), children: <RemoveFormatting /> },
  };
}

/** Icon button (26 px high, 24 px wide: the whole bar fits one row); a toggle with pressed state when `active` is given. */
export function ToolButton({ title, onClick, active, disabled, children }) {
  const common = { 'aria-label': title, disabled, onMouseDown: keepFocus };
  return (
    <Tip title={title}>
      {active === undefined
        ? <Button variant="ghost" size="icon-sm" className={typeof children === 'string' ? 'w-auto px-1.5' : 'w-7.5'} onClick={onClick} {...common}>{children}</Button>
        : <Toggle size="sm" className="min-w-7.5" pressed={!!active} onPressedChange={() => onClick()} {...common}>{children}</Toggle>}
    </Tip>
  );
}

export function ToolSelect({ title, value, onChange, placeholder, className, disabled, children }) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <Tip title={title}>
        <SelectTrigger size="sm" aria-label={title} className={cn('gap-1 px-2', className)}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
      </Tip>
      <SelectContent onCloseAutoFocus={refocusEditor}>{children}</SelectContent>
    </Select>
  );
}

// The block style, font and size selects over textTools(ed) `T`.
export const BlockSelect = ({ T }) => (
  <ToolSelect title="Block style" placeholder="Style" className="w-26" value={T.block.value} onChange={T.block.set}>
    <SelectItem value="p">Paragraph</SelectItem>
    {/* Each heading shown at a size like its own (list only; the trigger keeps the toolbar's size). */}
    {[1, 2, 3, 4, 5, 6].map((l) => (
      <SelectItem key={l} value={`h${l}`} className="font-semibold" style={{ fontSize: `${[1.5, 1.3, 1.15, 1, 0.92, 0.85][l - 1]}rem` }}>
        {`Heading ${l}`}
      </SelectItem>
    ))}
  </ToolSelect>
);

export const FontSelect = ({ T }) => (
  <ToolSelect title="Font" className="w-38" value={T.font.value} onChange={T.font.set}>
    <SelectItem value={NONE}>Default font</SelectItem>
    {FONTS.map((f) => <SelectItem key={f.css} value={f.css} style={{ fontFamily: cssFamily(f.css) }}>{f.label}</SelectItem>)}
  </ToolSelect>
);

export const SizeSelect = ({ T }) => (
  <ToolSelect title="Font size" className="w-18" value={T.size.value} onChange={T.size.set}>
    {FONT_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{`${n}%`}</SelectItem>)}
  </ToolSelect>
);

/** The swatch grid of a colour control; `onPick` runs before the picked swatch applies. */
export function Swatches({ swatches, onPick }) {
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {swatches.map((s) => (
        <button
          key={s.key}
          type="button"
          title={s.label}
          aria-label={s.label}
          onMouseDown={keepFocus}
          onClick={() => { onPick?.(); s.pick(); }}
          className={cn('size-6.5 rounded-sm border-2', s.active ? 'border-white' : 'border-transparent',
            !s.color && 'border border-dashed border-muted-foreground text-muted-foreground')}
          style={s.color ? { background: s.color } : undefined}
        >
          {s.color ? null : <Ban className="m-auto size-3.5" aria-label="None" />}
        </button>
      ))}
    </div>
  );
}

/** Colour dropdown: a palette of swatches; the bar under the icon shows the current colour. In the board rail (`side`
 * 'right') the palette opens to the right; in the quick tools island beside the whole island (`anchor`, a ref to it). */
export function SwatchMenu({ title, icon, bar, swatches, side, anchor }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {anchor && <PopoverAnchor virtualRef={anchor} />}
      <Tip title={title} side={side}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={title} onMouseDown={keepFocus} className={cn('flex-col gap-0.5', !side && 'w-7.5')}>
            {icon}
            <span className="h-[3px] w-4 rounded-sm" style={{ background: bar }} />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent side={side} align={(side || anchor) && 'start'} sideOffset={side && 10} className="w-auto p-2"
        onOpenAutoFocus={keepFocus} onCloseAutoFocus={refocusEditor}>
        <Swatches swatches={swatches} onPick={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Controls that stay together when the bar wraps, after a separator (clipped at the start of a row, see GroupRows). */
export const Group = ({ children }) => (
  <div className="flex items-center">
    <Separator orientation="vertical" className="mx-0.5 data-[orientation=vertical]:h-5" />
    {children}
  </div>
);

/** Groups in rows that wrap between groups (the toolbar, the quick tools island). The groups start one separator width
 * left of this overflow-hidden box: a row never begins with a separator. */
export const GroupRows = ({ children }) => (
  <div className="min-w-0 overflow-hidden">
    <div className="-ml-[calc(0.25rem+1px)] flex flex-wrap items-center">{children}</div>
  </div>
);

/** Table insert, plus the row / column / table operations while the caret is in a table. */
export const TableTools = ({ T, ed }) => (
  <>
    <ToolButton {...T.table} />
    {can('doc.inTable', { inTable: ed?.isActive('table') }) && (
      <>
        <ToolButton {...T.addRow} />
        <ToolButton {...T.addColumn} />
        <ToolButton {...T.deleteRow} />
        <ToolButton {...T.deleteColumn} />
        <ToolButton {...T.deleteTable} />
      </>
    )}
  </>
);

/** The presets menu's tooltip: their keys when they are Alt+1 to Alt+9 (the defaults), else where to see them. */
const presetsTitle = () => ([1, 2, 3, 4, 5, 6, 7, 8, 9].every((n) => keyLabel(`text.preset${n}`) === `Alt+${n}`)
  ? 'Apply a font preset (Alt+1 to Alt+9)' : 'Apply a font preset (keys in Settings > Keybinds)');

/** Font presets dropdown: apply one (by its key, §7k), last entry "Manage presets…". */
export function PresetsMenu() {
  const presets = useStore((s) => s.settings?.presets) ?? [];
  return (
    <DropdownMenu>
      <Tip title={presetsTitle()}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Font presets" onMouseDown={keepFocus}><Palette /><ChevronDown /></Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" onCloseAutoFocus={refocusEditor}>
        {presets.map((p, i) => (
          <DropdownMenuItem key={p.id || i} onSelect={() => applyPresetAt(i)}>
            {p.name || `Preset ${i + 1}`}
            {i < 9 && keyLabel(`text.preset${i + 1}`) && <DropdownMenuShortcut>{keyLabel(`text.preset${i + 1}`)}</DropdownMenuShortcut>}
          </DropdownMenuItem>
        ))}
        {presets.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={openSettings}>Manage presets...</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Toolbar() {
  const ed = useEditor();

  const T = textTools(ed);

  // An island floating over the editor area at the bottom centre, next to where new lines are typed. The draft actions are
  // in the sidebar's Post card.
  return (
    <div data-agent-area="toolbar" className="absolute bottom-3 left-1/2 z-30 w-max max-w-[calc(100%-7rem)] -translate-x-1/2 rounded-island border bg-card px-1.5 py-1 text-sm shadow-xl">
      <GroupRows>
        <Group>
          <ToolButton {...T.undo} />
          <ToolButton {...T.redo} />
        </Group>
        <Group>
          <BlockSelect T={T} />
          <FontSelect T={T} />
          <SizeSelect T={T} />
        </Group>
        <Group>
          <ToolButton {...T.bold} />
          <ToolButton {...T.italic} />
          <ToolButton {...T.underline} />
          <ToolButton {...T.strike} />
          <ToolButton {...T.sub} />
          <ToolButton {...T.sup} />
          <ToolButton {...T.code} />
        </Group>
        <Group>
          <SwatchMenu {...T.color} />
          <SwatchMenu {...T.highlight} />
        </Group>
        <Group>
          <ToolButton {...T.alignLeft} />
          <ToolButton {...T.alignCenter} />
          <ToolButton {...T.alignRight} />
          <ToolButton {...T.justify} />
        </Group>
        <Group>
          <ToolButton {...T.bulletList} />
          <ToolButton {...T.orderedList} />
          <ToolButton {...T.quote} />
          <ToolButton {...T.codeBlock} />
          <ToolButton {...T.rule} />
        </Group>
        <Group>
          <TableTools T={T} ed={ed} />
          <ToolButton {...T.box} />
          <ToolButton {...T.link} />
          <ToolButton {...T.whiteboard} />
          <ToolButton {...T.canvas} />
          <ToolButton {...T.flowchart} />
          <ToolButton {...T.planChart} />
          <ToolButton {...T.image} />
        </Group>
        <Group>
          <PresetsMenu />
          <ToolButton {...T.clear} />
        </Group>
      </GroupRows>
    </div>
  );
}
