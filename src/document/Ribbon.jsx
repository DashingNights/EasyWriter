import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FONT_SIZES, fontStack, HIGHLIGHT_MENU, HIGHLIGHTS, LINE_SPACINGS, MARGIN_PRESETS, PAPER_SIZES } from '../office.mjs';
import { refocusEditor, saveSettings } from '../app/actions.js';
import { Tip } from '../app/components/Tip.jsx';
import { Group, keepFocus } from '../app/components/Toolbar.jsx';
import { getState } from '../app/store.js';
import { bindColors, ColorCell, ColorPanel as KitColorPanel } from '../tooling/kit/ColorPick.jsx';
import { FontPick, SizePick } from '../tooling/kit/FontPick.jsx';
import { THEME } from './defaults.mjs';
import { fontLabel, fontsNow, listFonts } from './fonts.js';
import { MAX_PAPER, showIn } from './pages.mjs';
import { insertTable, openPageSetup } from './tools.js';

// The Document's value controls over documentTools(ed) (tools.js): the Font and Size boxes, the colour panels and the lists
// that the ribbon's fallback boxes, its menu panels (word/base.js) and the tool search entries' options draw. The controls
// themselves are the kit's (src/tooling/kit); this file adapts them to T.

// ---------- Font ----------
/** A font's name in the list: the theme's fonts as Word names them, and an open font that stands in for a missing one first
 * (fonts.js fontLabel: "Carlito (Calibri)"). */
const fontName = (font, theme) => (font === '+major' ? `${fontLabel(theme?.fonts?.major ?? 'Aptos Display')} (Headings)`
  : font === '+minor' ? `${fontLabel(theme?.fonts?.minor ?? 'Aptos')} (Body)` : fontLabel(font));

/** The Font combobox: the theme's fonts, the curated list, then the installed families (fonts.js, loaded each time the list opens, from the field or the chevron).
 * Its list has a fixed width and long names end in an ellipsis, so it never changes width as the installed fonts arrive. */
export function FontBox({ T, wide }) {
  const [fonts, setFonts] = useState(fontsNow);
  const options = ['+major', '+minor', ...fonts].map((f) => ({ id: f, label: fontName(f, T.theme), css: fontStack(f, T.theme) }));
  return (
    <Tip title="Font">
      <FontPick size="sm" className={wide ? 'w-60' : 'w-48'} value={T.font.value} options={options} onChange={T.font.set} onOpen={() => listFonts().then(setFonts)} />
    </Tip>
  );
}

/** The Font size combobox: Word's list, or a typed size (1-1638, to the half point). */
export function SizeBox({ T }) {
  return (
    <Tip title="Font size">
      <SizePick size="sm" className="tabular-nums" value={T.size.value} options={FONT_SIZES} onChange={(v) => T.size.set(parseFloat(v))} />
    </Tip>
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

// ---------- Colours ----------
// The Document's colours for the kit's colour boxes: the open Document's theme, and Word's recent colours (settings.word).
bindColors('document', {
  theme: () => getState().editor?.state.doc.attrs.theme ?? THEME,
  recent: (s) => s.settings?.word?.recentColors,
  saveRecent: (list) => saveSettings({ word: { ...getState().settings?.word, recentColors: list } }),
});

const HIGHLIGHT_NAMES = { yellow: 'Yellow', green: 'Bright Green', cyan: 'Turquoise', magenta: 'Pink', blue: 'Blue', red: 'Red', darkBlue: 'Dark Blue',
  darkCyan: 'Teal', darkGreen: 'Green', darkMagenta: 'Violet', darkRed: 'Dark Red', darkYellow: 'Dark Yellow', darkGray: 'Gray 50%',
  lightGray: 'Gray 25%', black: 'Black' };

/** Font colour over T ({theme, color: {value, themeColor, set(hex, themeColor)}}): the kit's colour panel. `onPick` runs before a
 * pick applies (closing the menu). */
export const ColorPanel = ({ T, onPick, none = 'Automatic' }) => (
  <KitColorPanel value={T.color.value} themeColor={T.color.themeColor} onChange={T.color.set} theme={T.theme} none={none} onPick={onPick} />
);

/** Table cell shading: the font colour panel's colours, No colour first. Cells store only the hex (no theme link). */
export const ShadingPanel = ({ T, onPick }) => (
  <KitColorPanel value={T.shading.value} onChange={(color) => T.shading.set(color)} theme={T.theme} none="No colour" onPick={onPick} />
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
        {HIGHLIGHT_MENU.map((n) => <ColorCell key={n} label={HIGHLIGHT_NAMES[n]} color={HIGHLIGHTS[n]} active={T.highlight.value === n} onPick={() => pick(n)} />)}
      </div>
      <Button variant="ghost" size="xs" className="justify-start" onMouseDown={keepFocus} onClick={() => pick(null)}>No colour</Button>
    </div>
  );
}

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

// Insert > Page number: where it goes, [at, label] and [align, label].
const NUMBER_AT = [['top', 'Top of page'], ['bottom', 'Bottom of page']];
const NUMBER_ALIGN = [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']];
const numberIs = (T, at, align) => T.pageNumber.value?.at === at && T.pageNumber.value?.align === align;

/** Insert > Page number as a list (the tool search's options). */
export const PageNumberList = ({ T }) => (
  <div className="flex flex-col">
    {NUMBER_AT.flatMap(([at, label]) => NUMBER_ALIGN.map(([align, name]) => (
      <ListChoice key={at + align} on={numberIs(T, at, align)} onClick={() => T.pageNumber.set({ at, align })}>{`${label}, ${name.toLowerCase()}`}</ListChoice>
    )))}
    {T.pageNumber.value && <ListChoice onClick={() => T.pageNumber.set(null)}>Remove page numbers</ListChoice>}
  </div>
);

// ---------- Layout ----------
const ORIENTATIONS = [['portrait', 'Portrait'], ['landscape', 'Landscape']];
/** A paper's size in the page unit ('21 x 29.7 cm'). */
const sizeText = ({ w, h }, unit) => `${showIn(w, unit)} x ${showIn(h, unit)} ${unit.name}`;
/** A margins preset in the page unit: one length when every side has it, else top and left. */
const marginText = (m, unit) => (m.left === m.top ? `${showIn(m.top, unit)} ${unit.name}` : `${showIn(m.top, unit)} and ${showIn(m.left, unit)} ${unit.name}`);

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

/** A number field: `value` in points shown in `unit` ({name, pt}); a typed value applies at once (as the board's angle field),
 * Enter or Escape hands the focus back to the text. */
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
/** Indent left and right (0.1 cm or inch steps) and Spacing before and after (6 pt steps) of the selected paragraphs, as the
 * tool search shows them in an entry's options. */
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
