import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import {
  ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, Baseline, ChevronDown, ClipboardPaste, Copy, Grid2x2X, Hash, Highlighter, PaintBucket,
  PanelsLeftRight, Proportions, RectangleHorizontal, Replace, Scissors, Search, SeparatorHorizontal, Table, TableColumnsSplit, TableRowsSplit, Trash2,
  UnfoldVertical,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SelectItem } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  FONT_SIZES, fontStack, HIGHLIGHT_MENU, HIGHLIGHTS, LINE_SPACINGS, MARGIN_PRESETS, PAPER_SIZES, resolveColor, STANDARD_COLORS, THEME_GRID,
} from '../office.mjs';
import { refocusEditor } from '../app/actions.js';
import { AlignMenu } from '../app/components/board/BoardRail.jsx';
import { openFind, openReplace } from '../app/components/FindBar.jsx';
import { CHROME, keepFocus as keepBoardFocus } from '../app/components/board/controls.jsx';
import { IconButton, Tip, TipSide } from '../app/components/Tip.jsx';
import { Group, GroupRows, keepFocus, SelectRow, ToolButton, ToolSelect } from '../app/components/Toolbar.jsx';
import { DictationButton } from '../app/dictation/Dictation.jsx';
import { keyLabel } from '../app/keybinds.js';
import { useEditor, useStore } from '../app/store.js';
import { fontsNow, listFonts } from './fonts.js';
import { MAX_PAPER, showIn } from './pages.mjs';
import { resolved } from './stylesheet.js';
import { clip, documentTools, GALLERY, HEADINGS_MORE, insertTable, openPageSetup } from './tools.js';

// A Document's tools island (docs/plans/document.md step 10, in place of the Ribbon decision's top row): a floating island at
// the editor area's left edge, where the board rail sits in a forum post, so the tools are next to the text. Its tabs on top,
// each tab's groups stacked under them with a small heading. Built over documentTools(ed) (tools.js), which the quick tools
// and the tool search entries share; the value controls (Font, Size, colours, spacing, styles) are exported for those. Table
// and Picture are contextual: they show while the caret is in a table or a picture is selected.

const TABS = [['home', 'Home'], ['insert', 'Insert'], ['layout', 'Layout'], ['view', 'View']];

/** The island element's ref while the controls render in it (DocIsland), else null (the quick tools, the tool search). */
const Island = createContext(null);

// ---------- Font ----------
/** A font's name in the list: the theme's fonts as Word names them. */
const fontName = (font, theme) => (font === '+major' ? `${theme?.fonts?.major ?? 'Aptos Display'} (Headings)`
  : font === '+minor' ? `${theme?.fonts?.minor ?? 'Aptos'} (Body)` : font);

/** The Font combobox: the theme's fonts, the curated list, then the installed families (fonts.js, loaded each time the list opens, from the field or the chevron).
 * Its list has a fixed width and long names end in an ellipsis, so it never changes width as the installed fonts arrive. */
export function FontBox({ T, wide }) {
  const island = useContext(Island);
  const [fonts, setFonts] = useState(fontsNow);
  const all = ['+major', '+minor', ...fonts];
  const commit = (text) => {
    const t = text.trim();
    if (t) T.font.set(all.find((f) => fontName(f, T.theme).toLowerCase() === t.toLowerCase()) ?? t);
  };
  return (
    <Tip title="Font" wrap={island && 'w-full'}>
      <Combobox size="sm" aria-label="Font" className={island ? 'w-full' : wide ? 'w-60' : 'w-48'} value={T.font.value} text={fontName(T.font.value, T.theme)}
        options={all.map((f) => [f, <span key={f} title={fontName(f, T.theme)} className="truncate" style={{ fontFamily: fontStack(f, T.theme) }}>{fontName(f, T.theme)}</span>])}
        onOpen={() => listFonts().then(setFonts)} onCommit={commit} onPick={T.font.set} onDone={() => refocusEditor()}
        contentProps={{ className: 'max-h-80 w-64 overflow-y-auto' }} />
    </Tip>
  );
}

/** The Font size combobox: Word's list, or a typed size (1-1638, to the half point). */
export function SizeBox({ T }) {
  return (
    <Tip title="Font size">
      <Combobox size="sm" aria-label="Font size" className="w-16 tabular-nums" value={T.size.value} text={String(T.size.value)}
        options={FONT_SIZES.map((n) => [n, String(n)])} onCommit={(t) => T.size.set(parseFloat(t))} onPick={T.size.set}
        onDone={() => refocusEditor()} contentProps={{ className: 'max-h-80 w-20 overflow-y-auto' }} />
    </Tip>
  );
}

// ---------- Split buttons and menus ----------
/** A split button's arrow: a narrow button opening `children` (DropdownMenuContent items). `children` may be a function of
 * `pick(fn)`, an onSelect that runs fn once the menu has closed and the editor has the focus back, so a paste lands in the
 * document (as DraftMenu does). */
function SplitMenu({ label, children, className }) {
  const picked = useRef(null);
  const runPicked = (e) => {
    refocusEditor(e);
    const fn = picked.current;
    picked.current = null;
    fn?.();
  };
  return (
    <DropdownMenu>
      <IconButton size="regular" label={label} slot={DropdownMenuTrigger} onMouseDown={keepFocus} className="-ml-0.5 w-4">
        <ChevronDown className="size-3 opacity-60" />
      </IconButton>
      <DropdownMenuContent align="start" className={className} onCloseAutoFocus={runPicked}>
        {typeof children === 'function' ? children((fn) => () => (picked.current = fn)) : children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The underline menu's styles (ST_Underline), each drawn as it looks.
const UNDERLINE_MENU = [['single', 'Single'], ['double', 'Double'], ['thick', 'Thick'], ['dotted', 'Dotted'], ['dash', 'Dashed'],
  ['dotDash', 'Dot dash'], ['dotDotDash', 'Dot dot dash'], ['wave', 'Wave']];
const underlineLook = (val) => ({
  textDecorationLine: 'underline', textUnderlineOffset: 3,
  textDecorationStyle: { double: 'double', dotted: 'dotted', dash: 'dashed', dotDash: 'dashed', dotDotDash: 'dashed', wave: 'wavy' }[val] ?? 'solid',
  textDecorationThickness: val === 'thick' ? 2 : 1,
});

/** Underline styles as a list (the tool search's options). */
export const UnderlineList = ({ T }) => (
  <div className="flex flex-col">
    {UNDERLINE_MENU.map(([val, label]) => (
      <Button key={val} variant="ghost" size="sm" className={cn('justify-start', T.underlineStyle.value === val && 'bg-accent')} onMouseDown={keepFocus}
        onClick={() => T.underlineStyle.set(val)}><span style={underlineLook(val)}>{label}</span></Button>
    ))}
  </div>
);

const NUMBER_MENU = [['decimal', '1. 2. 3.'], ['lowerLetter', 'a. b. c.'], ['upperLetter', 'A. B. C.'], ['lowerRoman', 'i. ii. iii.'], ['upperRoman', 'I. II. III.']];

/** The Numbering library as a list (the tool search's options). */
export const NumberingList = ({ T }) => (
  <div className="flex flex-col">
    {NUMBER_MENU.map(([abstract, label]) => (
      <Button key={abstract} variant="ghost" size="sm" className={cn('justify-start tabular-nums', T.numbering.value === abstract && 'bg-accent')}
        onMouseDown={keepFocus} onClick={() => T.numbering.set(abstract)}>{label}</Button>
    ))}
  </div>
);

const spacingLabel = (m) => (m === 1.15 ? '1.15' : m.toFixed(1));
const isSpacing = (T, m) => T.lineSpacing.value != null && Math.abs(T.lineSpacing.value - m) < 0.01; // 278/240 shows as 1.15
const spaceItems = (T) => [
  [T.spaceBefore.value ? 'Remove space before paragraph' : 'Add space before paragraph', T.spaceBefore.toggle],
  [T.spaceAfter.value ? 'Remove space after paragraph' : 'Add space after paragraph', T.spaceAfter.toggle],
];

/** Line and paragraph spacing as a list (the tool search's options). */
export const LineSpacingList = ({ T }) => (
  <div className="flex flex-col">
    {LINE_SPACINGS.map((m) => (
      <Button key={m} variant="ghost" size="sm" className={cn('justify-start tabular-nums', isSpacing(T, m) && 'bg-accent')} onMouseDown={keepFocus}
        onClick={() => T.lineSpacing.set(m)}>{spacingLabel(m)}</Button>
    ))}
    {spaceItems(T).map(([label, fn]) => <Button key={label} variant="ghost" size="sm" className="justify-start" onMouseDown={keepFocus} onClick={fn}>{label}</Button>)}
  </div>
);

function LineSpacingMenu({ T }) {
  return (
    <DropdownMenu>
      <IconButton size="regular" label="Line and paragraph spacing" slot={DropdownMenuTrigger} onMouseDown={keepFocus}><UnfoldVertical /></IconButton>
      <DropdownMenuContent align="start" onCloseAutoFocus={refocusEditor}>
        {LINE_SPACINGS.map((m) => (
          <DropdownMenuCheckboxItem key={m} checked={isSpacing(T, m)} onSelect={() => T.lineSpacing.set(m)} className="tabular-nums">{spacingLabel(m)}</DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        {spaceItems(T).map(([label, fn]) => <DropdownMenuItem key={label} onSelect={fn}>{label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------- Colours ----------
const SLOT_NAMES = { lt1: 'Background 1', dk1: 'Text 1', lt2: 'Background 2', dk2: 'Text 2', accent1: 'Accent 1', accent2: 'Accent 2',
  accent3: 'Accent 3', accent4: 'Accent 4', accent5: 'Accent 5', accent6: 'Accent 6' };
const lumName = (lum) => (!lum ? '' : `, ${lum > 0 ? 'Lighter' : 'Darker'} ${Math.round(Math.abs(lum) * 100)}%`);
const STANDARD_NAMES = ['Dark Red', 'Red', 'Orange', 'Yellow', 'Light Green', 'Green', 'Light Blue', 'Blue', 'Dark Blue', 'Purple'];
const HIGHLIGHT_NAMES = { yellow: 'Yellow', green: 'Bright Green', cyan: 'Turquoise', magenta: 'Pink', blue: 'Blue', red: 'Red', darkBlue: 'Dark Blue',
  darkCyan: 'Teal', darkGreen: 'Green', darkMagenta: 'Violet', darkRed: 'Dark Red', darkYellow: 'Dark Yellow', darkGray: 'Gray 50%',
  lightGray: 'Gray 25%', black: 'Black' };

/** One colour cell; `active` rings it. */
const Cell = ({ label, color, active, onPick }) => (
  <Tip title={label}>
    <button type="button" aria-label={label} onMouseDown={keepFocus} onClick={onPick} style={{ background: color }}
      className={cn('size-5 rounded-xs', active ? 'ring-2 ring-foreground ring-offset-1 ring-offset-popover' : 'ring-1 ring-foreground/20 ring-inset')} />
  </Tip>
);

const Heading = ({ children }) => <div className="px-0.5 text-xs text-muted-foreground">{children}</div>;

/** Font colour: Automatic, the theme's 10 x 6 grid (a cell stores its theme link, T.color.set's themeColor), the standard
 * colours and a typed hex. `onPick` runs before a pick applies (closing the menu). */
export function ColorPanel({ T, onPick, none = 'Automatic' }) {
  const [hex, setHex] = useState('');
  const pick = (color, theme = null) => {
    onPick?.();
    T.color.set(color, theme);
  };
  const { value, themeColor } = T.color;
  return (
    <div className="flex w-60 flex-col gap-1.5">
      <Button variant="ghost" size="xs" className={cn('justify-start', !value && 'bg-accent')} onMouseDown={keepFocus} onClick={() => pick(null)}>
        <span className={cn('size-3.5 rounded-xs ring-1 ring-foreground/20', none === 'Automatic' ? 'bg-black' : 'bg-white')} />{none}
      </Button>
      <Heading>Theme colours</Heading>
      <div className="grid grid-flow-col grid-cols-10 grid-rows-6 gap-0.5">
        {THEME_GRID.flatMap(({ slot, lums }) => [0, ...lums].map((lum) => (
          <Cell key={`${slot}${lum}`} label={`${SLOT_NAMES[slot]}${lumName(lum)}`} color={resolveColor(T.theme, { slot, lum })}
            active={themeColor?.slot === slot && (themeColor.lum ?? 0) === lum} onPick={() => pick(resolveColor(T.theme, { slot, lum }), { slot, lum })} />
        )))}
      </div>
      <Heading>Standard colours</Heading>
      <div className="grid grid-cols-10 gap-0.5">
        {STANDARD_COLORS.map((c, i) => <Cell key={c} label={STANDARD_NAMES[i]} color={c} active={!themeColor && value === c} onPick={() => pick(c)} />)}
      </div>
      <form className="flex items-center gap-1" onSubmit={(e) => {
        e.preventDefault();
        const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
        if (m) pick(`#${m[1].toUpperCase()}`);
      }}>
        <Input size="xs" aria-label="Custom colour" placeholder="#RRGGBB" value={hex} onChange={(e) => setHex(e.target.value)} className="flex-1 font-mono" />
        <Button type="submit" variant="outline" size="xs">Apply</Button>
      </form>
    </div>
  );
}

/** Table cell shading: the font colour panel's colours, No colour first. Cells store only the hex (no theme link). */
export const ShadingPanel = ({ T, onPick }) => (
  <ColorPanel T={{ theme: T.theme, color: { value: T.shading.value, themeColor: null, set: (color) => T.shading.set(color) } }} onPick={onPick} none="No colour" />
);

/** Text highlight colour: Word's 15 colours and No colour. */
export function HighlightPanel({ T, onPick }) {
  const pick = (name) => {
    onPick?.();
    T.highlight.set(name);
  };
  return (
    <div className="flex w-36 flex-col gap-1.5">
      <div className="grid grid-cols-5 gap-1">
        {HIGHLIGHT_MENU.map((n) => <Cell key={n} label={HIGHLIGHT_NAMES[n]} color={HIGHLIGHTS[n]} active={T.highlight.value === n} onPick={() => pick(n)} />)}
      </div>
      <Button variant="ghost" size="xs" className="justify-start" onMouseDown={keepFocus} onClick={() => pick(null)}>No colour</Button>
    </div>
  );
}

/** A button with a colour bar under its icon that opens `Panel`; in the quick tools island the panel opens beside the whole
 * island (`anchor`). */
function ColorMenu({ title, icon, bar, Panel, T, anchor }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {anchor && <PopoverAnchor virtualRef={anchor} />}
      <IconButton size="regular" label={title} slot={PopoverTrigger} onMouseDown={keepFocus} className="w-7.5 flex-col gap-0.5">
        {icon}
        <span className="h-[3px] w-4 rounded-sm ring-1 ring-foreground/25" style={{ background: bar }} />
      </IconButton>
      <PopoverContent align="start" className="w-auto p-2" onOpenAutoFocus={keepFocus} onCloseAutoFocus={refocusEditor}>
        <Panel T={T} onPick={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

const FontColor = ({ T, anchor }) => <ColorMenu title="Font colour" icon={<Baseline />} bar={T.color.value ?? '#000000'} Panel={ColorPanel} T={T} anchor={anchor} />;
const Highlight = ({ T, anchor }) => (
  <ColorMenu title="Text highlight colour" icon={<Highlighter />} bar={HIGHLIGHTS[T.highlight.value] ?? 'transparent'} Panel={HighlightPanel} T={T} anchor={anchor} />
);

// ---------- Insert ----------
const GRID = { cols: 10, rows: 8 };

/** Insert > Table: a 10 x 8 grid; the cells up to the one under the pointer (or focus) light up, a click inserts that size. */
export function TableGrid({ onPick }) {
  const [at, setAt] = useState({ r: 0, c: 0 });
  return (
    <div className="flex flex-col gap-1.5" onMouseLeave={() => setAt({ r: 0, c: 0 })}>
      <div className="text-xs text-muted-foreground">{at.r ? `${at.c} x ${at.r} table` : 'Insert table'}</div>
      <div className="grid grid-cols-10 gap-0.5">
        {Array.from({ length: GRID.rows * GRID.cols }, (_, i) => {
          const r = Math.floor(i / GRID.cols) + 1;
          const c = (i % GRID.cols) + 1;
          return (
            <button key={i} type="button" aria-label={`${c} x ${r} table`} onMouseDown={keepFocus} onMouseEnter={() => setAt({ r, c })} onFocus={() => setAt({ r, c })}
              onClick={() => {
                onPick?.();
                insertTable(r, c);
              }}
              className={cn('size-4 rounded-xs ring-1 ring-foreground/25 ring-inset', r <= at.r && c <= at.c && 'bg-primary/30 ring-primary')} />
          );
        })}
      </div>
    </div>
  );
}

function TableMenu() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <IconButton size="regular" label="Table" slot={PopoverTrigger} onMouseDown={keepFocus} className="w-7.5"><Table /></IconButton>
      <PopoverContent align="start" className="w-auto p-2" onOpenAutoFocus={keepFocus} onCloseAutoFocus={refocusEditor}>
        <TableGrid onPick={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

// Insert > Page number: where it goes, [at, label] and [align, label].
const NUMBER_AT = [['top', 'Top of page'], ['bottom', 'Bottom of page']];
const NUMBER_ALIGN = [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']];
const numberIs = (T, at, align) => T.pageNumber.value?.at === at && T.pageNumber.value?.align === align;

function PageNumberMenu({ T }) {
  return (
    <DropdownMenu>
      <IconButton size="regular" label="Page number" slot={DropdownMenuTrigger} onMouseDown={keepFocus} className="w-7.5"><Hash /></IconButton>
      <DropdownMenuContent align="start" onCloseAutoFocus={refocusEditor}>
        {NUMBER_AT.map(([at, label]) => (
          <DropdownMenuGroup key={at}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">{label}</DropdownMenuLabel>
            {NUMBER_ALIGN.map(([align, name]) => (
              <DropdownMenuCheckboxItem key={align} checked={numberIs(T, at, align)} onSelect={() => T.pageNumber.set({ at, align })}>{name}</DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!T.pageNumber.value} onSelect={() => T.pageNumber.set(null)}>Remove page numbers</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Insert > Page number as a list (the tool search's options). */
export const PageNumberList = ({ T }) => (
  <div className="flex flex-col">
    {NUMBER_AT.flatMap(([at, label]) => NUMBER_ALIGN.map(([align, name]) => (
      <ListChoice key={at + align} on={numberIs(T, at, align)} onClick={() => T.pageNumber.set({ at, align })}>{`${label}, ${name.toLowerCase()}`}</ListChoice>
    )))}
    {T.pageNumber.value && <ListChoice onClick={() => T.pageNumber.set(null)}>Remove page numbers</ListChoice>}
  </div>
);

function InsertTab({ T }) {
  return (
    <>
      <Section title="Pages">
        <ToolButton {...T.pageBreak} />
        <PageNumberMenu T={T} />
      </Section>
      <Section title="Objects">
        <TableMenu />
        <ToolButton {...T.image} />
        <ToolButton {...T.link} />
        <ToolButton {...T.canvas} />
        <ToolButton {...T.flowchart} />
        <ToolButton {...T.planChart} />
      </Section>
      <Section title="References">
        <ToolButton {...T.cite} />
        <ToolButton {...T.references} />
      </Section>
    </>
  );
}

// ---------- Table and Picture (contextual) ----------
function DeleteMenu({ T }) {
  return (
    <DropdownMenu>
      <IconButton size="regular" label="Delete" slot={DropdownMenuTrigger} onMouseDown={keepFocus} className="w-7.5"><Trash2 /></IconButton>
      <DropdownMenuContent align="start" onCloseAutoFocus={refocusEditor}>
        <DropdownMenuItem onSelect={T.deleteRow.onClick}><TableRowsSplit />Delete rows</DropdownMenuItem>
        <DropdownMenuItem onSelect={T.deleteColumn.onClick}><TableColumnsSplit />Delete columns</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" data-agent-risk="destructive" onSelect={T.deleteTable.onClick}><Grid2x2X />Delete table</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TableTab({ T }) {
  return (
    <>
      <Section title="Rows and columns">
        <ToolButton {...T.rowAbove} />
        <ToolButton {...T.rowBelow} />
        <ToolButton {...T.columnLeft} />
        <ToolButton {...T.columnRight} />
        <DeleteMenu T={T} />
      </Section>
      <Section title="Cells">
        <ToolButton {...T.merge} />
        <ToolButton {...T.split} />
        <ToolButton {...T.headerRow} />
        <ColorMenu title="Cell shading" icon={<PaintBucket />} bar={T.shading.value ?? 'transparent'} Panel={ShadingPanel} T={T} />
      </Section>
      <Section title="Alignment">
        {Object.entries(T.cellAlign).map(([v, t]) => <ToolButton key={v} {...t} />)}
      </Section>
    </>
  );
}

const PictureTab = ({ T }) => (
  <Section title="Picture">
    <Button variant="ghost" size="xs" onMouseDown={keepFocus} onClick={T.picture.edit}>Alt text</Button>
  </Section>
);

// ---------- Layout ----------
const ORIENTATIONS = [['portrait', 'Portrait'], ['landscape', 'Landscape']];
/** A paper's size in the page unit ('21 x 29.7 cm'). */
const sizeText = ({ w, h }, unit) => `${showIn(w, unit)} x ${showIn(h, unit)} ${unit.name}`;
/** A margins preset in the page unit: one length when every side has it, else top and left. */
const marginText = (m, unit) => (m.left === m.top ? `${showIn(m.top, unit)} ${unit.name}` : `${showIn(m.top, unit)} and ${showIn(m.left, unit)} ${unit.name}`);

/** A button with a word beside its icon that opens a menu. */
function LabelMenu({ label, icon, children }) {
  return (
    <DropdownMenu>
      <IconButton size="regular" label={label} slot={DropdownMenuTrigger} onMouseDown={keepFocus} className="w-auto gap-1 px-1.5">
        {icon}{label}<ChevronDown className="size-3 opacity-60" />
      </IconButton>
      <DropdownMenuContent align="start" onCloseAutoFocus={refocusEditor}>{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One choice of a list as the tool search shows it (an entry's options). */
const ListChoice = ({ on, onClick, children }) => (
  <Button variant="ghost" size="sm" className={cn('justify-between gap-4', on && 'bg-accent')} onMouseDown={keepFocus} onClick={onClick}>{children}</Button>
);
const Detail = ({ children }) => <span className="text-xs text-muted-foreground tabular-nums">{children}</span>;

/** Margins presets and Custom margins as a list (the tool search's options). */
export const MarginsList = ({ T }) => (
  <div className="flex flex-col">
    {Object.entries(MARGIN_PRESETS).map(([k, m]) => (
      <ListChoice key={k} on={T.margins.value === k} onClick={() => T.margins.set(k)}>{m.label}<Detail>{marginText(m, T.unit)}</Detail></ListChoice>
    ))}
    <ListChoice onClick={() => openPageSetup('margins')}>Custom margins...</ListChoice>
  </div>
);

/** Portrait and Landscape as a list (the tool search's options). */
export const OrientationList = ({ T }) => (
  <div className="flex flex-col">
    {ORIENTATIONS.map(([v, label]) => <ListChoice key={v} on={T.orientation.value === v} onClick={() => T.orientation.set(v)}>{label}</ListChoice>)}
  </div>
);

/** Paper sizes and More sizes as a list (the tool search's options). */
export const SizeList = ({ T }) => (
  <div className="flex flex-col">
    {Object.entries(PAPER_SIZES).map(([k, p]) => (
      <ListChoice key={k} on={T.paperSize.value === k} onClick={() => T.paperSize.set(k)}>{p.label}<Detail>{sizeText(p, T.unit)}</Detail></ListChoice>
    ))}
    <ListChoice onClick={() => openPageSetup('paper')}>More sizes...</ListChoice>
  </div>
);

/** A number spinner of the Layout tab: `value` in points shown in `unit` ({name, pt}); a typed or stepped value applies at
 * once (as the board's angle field), Enter or Escape hands the focus back to the text. */
function Field({ label, icon, value, set, unit, step }) {
  const show = (pt) => showIn(pt, unit);
  const [text, setText] = useState(show(value));
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setText(showIn(value, unit));
  }, [value, unit]);
  const type = (v) => {
    setText(v);
    const n = Number(v);
    if (v.trim() !== '' && Number.isFinite(n) && n >= 0) set(Math.min(MAX_PAPER, Math.round(n * unit.pt * 20) / 20)); // whole twips
  };
  return (
    <Tip title={label}>
      <label className="flex items-center gap-1 px-1 text-xs text-muted-foreground [&_svg]:size-3.5">
        {icon}
        <Input type="number" size="xs" min={0} step={step} aria-label={label} value={text} className="w-16 text-foreground tabular-nums"
          onFocus={() => { typing.current = true; }} onBlur={() => { typing.current = false; setText(show(value)); }} onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); refocusEditor(); } }} />
        {unit.name}
      </label>
    </Tip>
  );
}

const PT = { name: 'pt', pt: 1 };
/** Indent left and right (0.1 cm or inch steps) and Spacing before and after (6 pt steps) of the selected paragraphs; the
 * tool search shows them as an entry's options too. */
export const ParagraphFields = ({ T }) => (
  <>
    <Group>
      <Field label="Indent left" icon={<ArrowRightToLine />} {...T.indentLeft} unit={T.unit} step={0.1} />
      <Field label="Indent right" icon={<ArrowLeftToLine />} {...T.indentRight} unit={T.unit} step={0.1} />
    </Group>
    <Group>
      <Field label="Spacing before" icon={<ArrowUpToLine />} {...T.spaceBeforePt} unit={PT} step={6} />
      <Field label="Spacing after" icon={<ArrowDownToLine />} {...T.spaceAfterPt} unit={PT} step={6} />
    </Group>
  </>
);

function LayoutTab({ T }) {
  return (
    <>
      <Section title="Page setup">
        <LabelMenu label="Margins" icon={<PanelsLeftRight />}>
          {Object.entries(MARGIN_PRESETS).map(([k, m]) => (
            <DropdownMenuCheckboxItem key={k} checked={T.margins.value === k} onSelect={() => T.margins.set(k)}>
              {m.label}<DropdownMenuShortcut className="tracking-normal tabular-nums">{marginText(m, T.unit)}</DropdownMenuShortcut>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openPageSetup('margins')}>Custom margins...</DropdownMenuItem>
        </LabelMenu>
        <LabelMenu label="Orientation" icon={<RectangleHorizontal />}>
          {ORIENTATIONS.map(([v, label]) => (
            <DropdownMenuCheckboxItem key={v} checked={T.orientation.value === v} onSelect={() => T.orientation.set(v)}>{label}</DropdownMenuCheckboxItem>
          ))}
        </LabelMenu>
        <LabelMenu label="Size" icon={<Proportions />}>
          {Object.entries(PAPER_SIZES).map(([k, p]) => (
            <DropdownMenuCheckboxItem key={k} checked={T.paperSize.value === k} onSelect={() => T.paperSize.set(k)}>
              {p.label}<DropdownMenuShortcut className="tracking-normal tabular-nums">{sizeText(p, T.unit)}</DropdownMenuShortcut>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openPageSetup('paper')}>More sizes...</DropdownMenuItem>
        </LabelMenu>
        <LabelMenu label="Breaks" icon={<SeparatorHorizontal />}>
          <DropdownMenuItem disabled={T.pageBreak.disabled} onSelect={T.pageBreak.onClick}>
            Page<DropdownMenuShortcut>{keyLabel('document.pageBreak')}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </LabelMenu>
      </Section>
      <Section title="Indent">
        <Field label="Indent left" icon={<ArrowRightToLine />} {...T.indentLeft} unit={T.unit} step={0.1} />
        <Field label="Indent right" icon={<ArrowLeftToLine />} {...T.indentRight} unit={T.unit} step={0.1} />
      </Section>
      <Section title="Spacing">
        <Field label="Spacing before" icon={<ArrowUpToLine />} {...T.spaceBeforePt} unit={PT} step={6} />
        <Field label="Spacing after" icon={<ArrowDownToLine />} {...T.spaceAfterPt} unit={PT} step={6} />
      </Section>
    </>
  );
}

function ViewTab({ T }) {
  return (
    <>
      <Section title="Show"><ToolButton {...T.navPane} /></Section>
      <Section title="Zoom">
        <ToolButton {...T.zoom100} />
        <ToolButton {...T.onePage} />
        <ToolButton {...T.pageWidth} />
      </Section>
    </>
  );
}

// ---------- Styles ----------
/** The Styles gallery as a select, each style named in its own font and slant (its colour would not read on the dark menu).
 * Heading 4-6 join once the Document has such a heading. */
function StyleSelect({ T, ed }) {
  const list = ed?.state.doc.attrs.styles?.list ?? {};
  const used = new Set();
  ed?.state.doc.descendants((n) => {
    if (n.type.name === 'heading') used.add(`Heading${n.attrs.level}`);
    return !n.isTextblock;
  });
  const styles = [...GALLERY, ...HEADINGS_MORE.filter(([id]) => used.has(id))].filter(([id]) => list[id]);
  return (
    <ToolSelect title="Styles" placeholder="Style" className="w-34" value={T.style.value} onChange={T.style.set}>
      {styles.map(([id, name]) => {
        const run = resolved(list, id).run ?? {};
        return (
          <SelectItem key={id} value={id} style={{ fontFamily: fontStack(run.font ?? '+minor', T.theme), fontStyle: run.italic ? 'italic' : undefined }}>
            {name}
          </SelectItem>
        );
      })}
    </ToolSelect>
  );
}

// ---------- The island ----------
/** One group of the island: a small heading over its controls, which wrap in rows (a full-width control takes a row). */
const Section = ({ title, children }) => (
  <section className="flex flex-col gap-1 border-t px-2 py-1.5 first:border-t-0">
    <h3 className="text-xs text-muted-foreground">{title}</h3>
    <div className="flex flex-wrap items-center gap-0.5">{children}</div>
  </section>
);

/** Controls that never wrap apart (a button and its split arrow, a row of kindred buttons). */
const Pair = ({ children }) => <div className="flex items-center">{children}</div>;

function HomeTab({ T, ed }) {
  return (
    <>
      <Section title="Edit">
        <ToolButton {...T.undo} />
        <ToolButton {...T.redo} />
        <Pair>
          <ToolButton title="Paste (Ctrl+V)" onClick={clip('paste')}><ClipboardPaste /></ToolButton>
          <SplitMenu label="Paste options">
            {(pick) => (
              <>
                <DropdownMenuItem onSelect={pick(clip('paste'))}>Paste<DropdownMenuShortcut>Ctrl+V</DropdownMenuShortcut></DropdownMenuItem>
                <DropdownMenuItem onSelect={pick(clip('pasteAndMatchStyle'))}>Paste as plain text<DropdownMenuShortcut>Ctrl+Shift+V</DropdownMenuShortcut></DropdownMenuItem>
              </>
            )}
          </SplitMenu>
        </Pair>
        <ToolButton title="Cut (Ctrl+X)" onClick={clip('cut')}><Scissors /></ToolButton>
        <ToolButton title="Copy (Ctrl+C)" onClick={clip('copy')}><Copy /></ToolButton>
      </Section>
      <Section title="Font">
        <FontBox T={T} />
        <SizeBox T={T} />
        <ToolButton {...T.grow} />
        <ToolButton {...T.shrink} />
        <ToolButton {...T.clear} />
        <Pair>
          <ToolButton {...T.bold} />
          <ToolButton {...T.italic} />
          <ToolButton {...T.underline} />
          <SplitMenu label="Underline style">
            {UNDERLINE_MENU.map(([val, label]) => (
              <DropdownMenuCheckboxItem key={val} checked={T.underlineStyle.value === val} onSelect={() => T.underlineStyle.set(val)}>
                <span style={underlineLook(val)}>{label}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </SplitMenu>
          <ToolButton {...T.strike} />
          <ToolButton {...T.sub} />
          <ToolButton {...T.sup} />
        </Pair>
        <Highlight T={T} />
        <FontColor T={T} />
      </Section>
      <Section title="Paragraph">
        <Pair>
          <ToolButton {...T.bulletList} />
          <ToolButton {...T.orderedList} />
          <SplitMenu label="Numbering library">
            {NUMBER_MENU.map(([abstract, label]) => (
              <DropdownMenuCheckboxItem key={abstract} checked={T.numbering.value === abstract} onSelect={() => T.numbering.set(abstract)} className="tabular-nums">
                {label}
              </DropdownMenuCheckboxItem>
            ))}
          </SplitMenu>
          <ToolButton {...T.outdent} />
          <ToolButton {...T.indent} />
        </Pair>
        <Pair>
          <ToolButton {...T.alignLeft} />
          <ToolButton {...T.alignCenter} />
          <ToolButton {...T.alignRight} />
          <ToolButton {...T.justify} />
          <LineSpacingMenu T={T} />
        </Pair>
      </Section>
      <Section title="Styles">
        <div className="w-full [&_[data-slot=select-trigger]]:w-full [&_span:has(>[data-slot=select-trigger])]:w-full"><StyleSelect T={T} ed={ed} /></div>
      </Section>
      <Section title="Tools">
        <IconButton size="regular" label="Find" keybind="app.find" onMouseDown={keepFocus} onClick={openFind} className="w-7.5"><Search /></IconButton>
        <IconButton size="regular" label="Replace" keybind="app.replace" onMouseDown={keepFocus} onClick={openReplace} className="w-7.5"><Replace /></IconButton>
        <DictationButton size="regular" />
      </Section>
    </>
  );
}

// The picked tab outlives the island: it unmounts while a canvas is edited and remounts when the navigation pane opens or closes.
let lastTab = 'home';
let showTab = null; // the mounted island's tab setter

/** Shows the island's tab `v` now, or when the island next mounts (the tour's Insert steps, onboarding-steps.jsx `island`). */
export function showIslandTab(v) {
  lastTab = v;
  showTab?.(v);
}

/** The Document's tools island (App.jsx Rail, in place of the board rail while no canvas is being edited; forum posts keep the
 * bottom toolbar): a fixed width at the editor area's left edge, below the browser's tab strip, its body scrolling (wheel, no
 * scrollbar, as the rail) when the area is short. Tooltips open right of their control; lists and menus open under it. Its tabs keep the editor's focus: a press picks the tab without focusing it. data-ribbon tells
 * the bottom-island readers (Chat.jsx useFrame, Onboarding.jsx place) that it is not the bottom island. `className`: more
 * classes (App: pointer events beside the navigation pane). actions.js viewDoc keeps the sheet clear of it. */
export function DocIsland({ className }) {
  const ed = useEditor();
  useStore((s) => `${s.navPane}${s.settings?.paper}`); // the View tab's Navigation pane and the Layout tab's unit
  const island = useRef(null);
  const [picked, pick] = useState(lastTab);
  const setTab = (v) => pick((lastTab = v));
  useEffect(() => {
    showTab = pick;
    return () => { showTab = null; };
  }, []);
  const T = documentTools(ed);
  const tabs = [...TABS, ...(ed?.isActive('table') ? [['table', 'Table']] : []), ...(T.picture.alt != null ? [['picture', 'Picture']] : [])];
  const tab = tabs.some(([v]) => v === picked) ? picked : 'home'; // a contextual tab that went away
  useEffect(() => { if (tab !== picked) setTab('home'); }, [tab, picked]); // and stays away until clicked again
  return (
    <Island.Provider value={island}>
      <TipSide.Provider value="right">
        <div ref={island} {...CHROME} data-agent-area="toolbar" data-ribbon="" onMouseDown={keepBoardFocus}
          className={cn('absolute top-12 left-2 z-30 flex max-h-[calc(100%-7.5rem)] w-60 flex-col rounded-island border bg-island text-sm text-card-foreground shadow-xl', className)}>
          <Tabs value={tab}>
            <TabsList className="flex w-full flex-wrap p-1.5">
              {tabs.map(([value, label]) => <TabsTrigger key={value} value={value} onMouseDown={keepFocus} onClick={() => setTab(value)}>{label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          <div role="toolbar" aria-orientation="vertical" aria-label={`${tabs.find(([v]) => v === tab)[1]} tools`}
            className="min-h-0 overflow-y-auto border-t [scrollbar-width:none]">
            {tab === 'home' && <HomeTab T={T} ed={ed} />}
            {tab === 'insert' && <InsertTab T={T} />}
            {tab === 'layout' && <LayoutTab T={T} />}
            {tab === 'view' && <ViewTab T={T} />}
            {tab === 'table' && <TableTab T={T} />}
            {tab === 'picture' && <PictureTab T={T} />}
          </div>
        </div>
      </TipSide.Provider>
    </Island.Provider>
  );
}

/** The quick tools island's controls in a Document (QuickTools.jsx): style, font, size, B I U, colours, alignment, lists and
 * indents. `anchor`: the island, which the colour panels open beside. */
export function DocumentQuickTools({ anchor }) {
  const ed = useEditor();
  const T = documentTools(ed);
  return (
    <GroupRows>
      <Group>
        <SelectRow>
          <StyleSelect T={T} ed={ed} />
          <SizeBox T={T} />
        </SelectRow>
      </Group>
      <Group><SelectRow><FontBox T={T} /></SelectRow></Group>
      <Group>
        <ToolButton {...T.bold} />
        <ToolButton {...T.italic} />
        <ToolButton {...T.underline} />
        <FontColor T={T} anchor={anchor} />
        <Highlight T={T} anchor={anchor} />
      </Group>
      <Group>
        <AlignMenu aligns={[T.alignLeft, T.alignCenter, T.alignRight, T.justify]} />
        <ToolButton {...T.bulletList} />
        <ToolButton {...T.orderedList} />
        <ToolButton {...T.outdent} />
        <ToolButton {...T.indent} />
      </Group>
      <Group><ToolButton {...T.cite} /></Group>
    </GroupRows>
  );
}
