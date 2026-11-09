import { useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Baseline, ChevronDown, ChevronUp, Highlighter, Palette,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { canvasEditor } from '../../canvas.js';
import { formatOf } from '../../formats.mjs';
import { ColorPick } from '../../tooling/kit/ColorPick.jsx';
import { FontPick, SizePick } from '../../tooling/kit/FontPick.jsx';
import { commandOf, ctxOf, run, useWordCtx } from '../../tooling/registry.js';
import { ToggleGroup } from '../../tooling/ribbon/parts.jsx';
import { cssFamily, openSettings, refocusEditor } from '../actions.js';
import { keyLabel, keysOf, withKey } from '../keybinds.js';
import { isMac } from '../keys.mjs';
import { ALIGNS, POOL, POOL_IDS } from '../pool.js';
import { BAR, BoardTools, RailLayout } from './board/BoardRail.jsx';
import { CHROME, keepFocus as keepBoardFocus, useBoard, useSnapshot } from './board/controls.jsx';
import { useStore } from '../store.js';
import { IconButton, Tip } from './Tip.jsx';

export { HUE } from '../pool.js';
export const NONE = '-'; // Radix Select items need a non-empty value: stands for '' (no font, no thread)
export const keepFocus = (e) => e.preventDefault(); // toolbar buttons never take focus, so the editor keeps its selection

/** Pool command `id` (pool.js) as a control draws it now: ToolButton / RailButton props {title, keyId, children, active?, disabled,
 * onClick} and the kit ToggleGroup's {id, label, icon, off, reason}. Off where the active surface does not serve it. The command's
 * own active reading wins: on a canvas draft it is its engine row's (a post's toggles read post.context). */
function toolOf(id, ctx) {
  const { meta } = POOL[id];
  const spec = commandOf(id);
  const on = !!spec && (spec.enabled?.(ctx) ?? true);
  const active = spec?.active;
  const title = withKey(meta.label, meta.key);
  return {
    id, title, label: title, keyId: meta.key, icon: meta.icon, children: <meta.icon />, active: !!active && !!spec && active(ctx),
    disabled: !on, off: !on, reason: on ? null : spec?.reason?.(ctx) ?? null, onClick: () => run(id),
  };
}

const ALIGN = { left: ['alignLeft', 'Align left', AlignLeft, 'text.alignLeft'], center: ['alignCenter', 'Align centre', AlignCenter, 'text.alignCenter'],
  right: ['alignRight', 'Align right', AlignRight, 'text.alignRight'], justify: ['justify', 'Justify', AlignJustify, 'text.alignJustify'] };

/** The forum toolset's controls (§7, shared with the rail's text mode §6c, the quick tools §7d, the draft menu and tool search §7c),
 * each acting through run(id) on the active text surface and drawn from its command's state: the POOL_IDS keys and the four
 * alignments as toolOf props, `block`, `font`, `size`, `color` and `highlight` as {value, options, set, disabled}. A reader
 * re-renders with useWordCtx; the argument some callers still pass is ignored. */
export function textTools() {
  const ctx = ctxOf();
  const T = Object.fromEntries(Object.entries(POOL_IDS).map(([key, id]) => [key, toolOf(id, ctx)]));
  T.deleteRow.children = '-Row';
  T.deleteColumn.children = '-Col';
  const value = (id) => commandOf(id)?.value?.(ctx) ?? null; // an engine row's value on a canvas draft
  const on = (id) => { const s = commandOf(id); return !!s && (s.enabled?.(ctx) ?? true); };
  const align = value('para.align');
  const off = !on('para.align');
  for (const v of ALIGNS) {
    const [key, label, Icon, keyId] = ALIGN[v];
    const title = withKey(label, keyId);
    T[key] = { id: `para.align.${v}`, title, label: title, keyId, icon: Icon, children: <Icon />, active: align === v, disabled: off, off,
      onClick: () => run('para.align', v) };
  }
  for (const [key, id] of [['block', 'para.block'], ['font', 'text.font'], ['size', 'text.size'], ['color', 'text.color'], ['highlight', 'text.highlight']]) {
    const spec = commandOf(id);
    T[key] = { value: value(id), options: spec ? POOL[id].choices(ctx) : [], set: (v) => run(id, v), disabled: !on(id) };
  }
  return T;
}

/** Whether the open draft's format inserts titled boxes (formats.mjs blocks): the toolbar, quick tools and Insert menu show Box. */
export const useBox = () => useStore((s) => !!formatOf(s.draft, s.settings)?.blocks.includes('box'));

/** Icon button (26 px high, 24 px wide: the whole bar fits one row); a toggle with pressed state when `active` is given. */
export function ToolButton({ title, onClick, active, disabled, children }) {
  return (
    <IconButton size="regular" label={title} pressed={active === undefined ? undefined : !!active} disabled={disabled} onMouseDown={keepFocus}
      onClick={onClick} className={typeof children === 'string' ? 'w-auto px-1.5' : 'w-7.5'}>
      {children}
    </IconButton>
  );
}

/** A select with its tooltip; `contentProps` go to the list (its placement). `up`: the list opens above, its chevron points up. */
export function ToolSelect({ title, value, onChange, placeholder, size = 'sm', className, disabled, up, contentProps, children }) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <Tip title={title}>
        <SelectTrigger size={size} up={up} aria-label={title} className={cn('gap-1 px-2', className)}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
      </Tip>
      <SelectContent onCloseAutoFocus={refocusEditor} {...(up && { side: 'top' })} {...contentProps}>{children}</SelectContent>
    </Select>
  );
}

// The block style select and the kit's font and size boxes over textTools() `T`; `up` in the bottom island, where they open above.
export const BlockSelect = ({ T, up }) => (
  <ToolSelect title="Block style" placeholder="Style" className="w-30" up={up} value={T.block.value ?? ''} onChange={T.block.set} disabled={T.block.disabled}>
    {T.block.options.map(([v, label], i) => (
      // Each heading shown at a size like its own (list only; the trigger keeps the toolbar's size).
      <SelectItem key={v} value={v} className={i ? 'font-semibold' : undefined} style={i ? { fontSize: `${[1.5, 1.3, 1.15, 1, 0.92, 0.85][i - 1]}rem` } : undefined}>{label}</SelectItem>
    ))}
  </ToolSelect>
);

/** The forum's fonts (the profile's list), each drawn in itself, searched as typed; Default font first. */
export const FontBox = ({ T, up }) => (
  <FontPick size="sm" className="w-38" value={T.font.value} onChange={T.font.set} disabled={T.font.disabled} contentProps={up ? { side: 'top' } : undefined}
    options={[{ id: '', label: 'Default font' }, ...T.font.options.map((o) => ({ ...o, css: cssFamily(o.font) }))]} />
);

/** The forum's sizes in percent. */
export const SizeBox = ({ T, up }) => (
  <SizePick size="sm" className="w-21" unit="%" value={T.size.value} options={T.size.options} onChange={T.size.set} disabled={T.size.disabled}
    contentProps={up ? { side: 'top' } : undefined} />
);

/** Text colour and highlight: the kit's colour picker in palette mode over the forum's named colours; the bar under the icon shows
 * the current one. In the board rail (`side` 'right') the palette opens to the right; in the quick tools island beside the whole
 * island (`anchor`, a ref to it). */
export const TextColors = ({ T, side, anchor }) => (
  <>
    <ColorPick icon={<Baseline />} label="Text colour" palette={T.color.options} value={T.color.value} onChange={T.color.set} automatic={null}
      disabled={T.color.disabled} side={side} anchor={anchor} />
    <ColorPick icon={<Highlighter />} label="Highlight" palette={T.highlight.options} value={T.highlight.value} onChange={T.highlight.set} automatic="None"
      disabled={T.highlight.disabled} side={side} anchor={anchor} />
  </>
);

/** The kit's toggle group (marks, alignment, lists) at the toolbar's button size; `items`: textTools members. */
export const Toggles = ({ label, items }) => (
  <span className="inline-flex [&_button]:h-8 [&_button]:w-7.5 [&_svg]:stroke-2"><ToggleGroup label={label} items={items} /></span>
);

/** Controls that stay together when the bar wraps, after a separator (clipped at the start of a row, see GroupRows). */
export const Group = ({ children }) => (
  <div className="flex items-center">
    <Separator orientation="vertical" className="mx-0.5 data-[orientation=vertical]:h-5" />
    {children}
  </div>
);

/** Selects side by side, a little apart so their borders do not touch, and clear of the group's separator. */
export const SelectRow = ({ children }) => <div className="flex items-center gap-1 px-0.5">{children}</div>;

/** Groups in rows that wrap between groups (the toolbar, the quick tools island). The groups start one separator width
 * left of this overflow-hidden box: a row never begins with a separator. */
export const GroupRows = ({ children }) => (
  <div className="min-w-0 overflow-hidden">
    <div className="-ml-[calc(0.25rem+1px)] flex flex-wrap items-center">{children}</div>
  </div>
);

/** Table insert, plus the row / column / table operations while the caret is in a table; with `all` (the toolbar) they
 * always show, greyed out outside a table. */
export const TableTools = ({ T, all }) => (
  <>
    <ToolButton {...T.table} />
    {(all || !T.addRow.disabled) && [T.addRow, T.addColumn, T.deleteRow, T.deleteColumn, T.deleteTable].map((t) => <ToolButton key={t.id} {...t} />)}
  </>
);

/** The presets menu's tooltip: their keys when they are the defaults (Alt+1 to Alt+9, Ctrl+Cmd+1 to 9 on a Mac), else where
 * to see them. */
const presetsTitle = () => ([1, 2, 3, 4, 5, 6, 7, 8, 9].every((n) => keysOf(`text.preset${n}`)[0] === `${isMac() ? 'Ctrl+Cmd+' : 'Alt+'}${n}`)
  ? `Apply a font preset (${keyLabel('text.preset1')} to ${keyLabel('text.preset9')})` : 'Apply a font preset (keys in Settings > Keybinds)');

/** Font presets dropdown: apply one (by its key, §7k), last entry "Manage presets…". `side` 'top' in the bottom island. */
export function PresetsMenu({ disabled, side }) {
  const presets = useStore((s) => s.settings?.presets) ?? [];
  return (
    <DropdownMenu>
      <Tip title={presetsTitle()}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button variant="ghost" size="sm" aria-label="Font presets" disabled={disabled} onMouseDown={keepFocus}><Palette />{side === 'top' ? <ChevronUp className="opacity-50" /> : <ChevronDown className="opacity-50" />}</Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent side={side} align="start" onCloseAutoFocus={refocusEditor}>
        {presets.map((p, i) => (
          <DropdownMenuItem key={p.id || i} onSelect={() => run('text.preset', i)}>
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

// The bottom island's More tools row is open (per computer).
const MORE_KEY = 'daf-writer.toolbarMore';
const readMore = () => {
  try {
    return localStorage.getItem(MORE_KEY) === '1';
  } catch {
    return false;
  }
};

/** The bottom island holds every tool (the left rail only those for what is being worked on): one row of the common text
 * tools, ending in More tools, which opens a row above it, centred, of the rest: the less common text tools and the board
 * tools. Text tools are greyed out while a canvas is being edited, board tools with none open. Undo and Redo serve whichever
 * it is. */
export function Toolbar() {
  const [more, setMore] = useState(readMore);
  const box = useBox();
  const toggleMore = () => setMore((m) => {
    try {
      localStorage.setItem(MORE_KEY, m ? '0' : '1');
    } catch {}
    return !m;
  });
  useWordCtx(); // the controls follow the editor's transactions
  const session = useSyncExternalStore(canvasEditor.subscribe, canvasEditor.get);
  const active = useBoard();
  const board = session?.board ?? active; // a canvas in edit mode, also while the focus is elsewhere (the sidebar, the chat)
  useSnapshot(board); // Undo and Redo follow its history
  const T = textTools();

  // An island floating over the editor area at the bottom centre, next to where new lines are typed. The draft actions are
  // in the sidebar's Post card. Board chrome (§6c): a click in it keeps a canvas in edit mode, and the board its focus.
  return (
    <div data-agent-area="toolbar" {...CHROME} onMouseDown={keepBoardFocus}
      className="absolute bottom-3 left-1/2 z-30 flex w-max max-w-[calc(100%-7rem)] -translate-x-1/2 flex-col items-center rounded-island border bg-island p-1 text-sm shadow-xl">
      {more && (
        <>
          <div data-toolbar-more className="flex max-w-full justify-center animate-in fade-in-0 slide-in-from-bottom-1 duration-(--motion-islands)">
            <GroupRows>
              <Group>
                <Toggles label="More text formatting" items={[T.sub, T.sup, T.code]} />
              </Group>
              <Group>
                <Toggles label="Blocks" items={[T.quote, T.codeBlock]} />
                <ToolButton {...T.rule} />
              </Group>
              <Group>
                <TableTools T={T} all />
              </Group>
              <Group>
                {box && <ToolButton {...T.box} />}
                <ToolButton {...T.planChart} />
              </Group>
              <Group>
                <ToolButton {...T.cite} />
                <ToolButton {...T.references} />
              </Group>
              <RailLayout.Provider value={BAR}>
                <BoardTools board={board} />
              </RailLayout.Provider>
            </GroupRows>
          </div>
          <Separator className="my-1 self-stretch" />
        </>
      )}
      <div className="flex max-w-full items-center">
        <GroupRows>
          <Group>
            <ToolButton {...T.undo} />
            <ToolButton {...T.redo} />
          </Group>
          <Group>
            <SelectRow>
              <BlockSelect T={T} up />
              <FontBox T={T} up />
              <SizeBox T={T} up />
            </SelectRow>
          </Group>
          <Group>
            <Toggles label="Text formatting" items={[T.bold, T.italic, T.underline, T.strike]} />
          </Group>
          <Group>
            <TextColors T={T} />
          </Group>
          <Group>
            <Toggles label="Alignment" items={[T.alignLeft, T.alignCenter, T.alignRight, T.justify]} />
          </Group>
          <Group>
            <Toggles label="Lists" items={[T.bulletList, T.orderedList]} />
          </Group>
          <Group>
            <ToolButton {...T.link} />
            <ToolButton {...T.image} />
            <ToolButton {...T.canvas} />
            <ToolButton {...T.flowchart} />
          </Group>
          <Group>
            <PresetsMenu disabled={!!board} side="top" />
            <ToolButton {...T.clear} />
          </Group>
        </GroupRows>
        <Separator orientation="vertical" className="mx-0.5 data-[orientation=vertical]:h-5" />
        <ToolButton title={more ? 'Fewer tools' : 'More tools'} active={more} onClick={toggleMore}>{more ? <ChevronDown /> : <ChevronUp />}</ToolButton>
      </div>
    </div>
  );
}
