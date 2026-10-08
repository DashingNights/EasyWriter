import { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { TITLEBAR } from '@/components/ui/bounds';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { canvasEditor } from '../../canvas.js';
import { closeToolSearch, returnFocus } from '../actions.js';
import { ask, refreshStatus, usable, useAssistant } from '../assistant/assistant.js';
import { invoke } from '../commands.js';
import { getState, setState, useEditor, useStore } from '../store.js';
import { paletteSections, rankTool } from '../tool-rank.mjs';
import { entryKey as shortcutOf, listTools, toolContext } from '../tools.js';
import { CHROME, useSnapshot } from './board/controls.jsx';
import { notify } from './Notices.jsx';

// §7c tool search: the palette (Ctrl+Space), the options panel (Tab) and the notice (Notices.jsx). Palette and panel are board chrome,
// so a text item being edited stays in edit and the rail keeps serving its board.

const GAP = 4; // px between the pointer and the palette
const PAD = 8; // px kept free at the window edges
const TOP = TITLEBAR + PAD; // the top edge: below the title strip

/** Top-left corner at the pointer. No room below: above the pointer, flipped (search input at the bottom, next to the
 * pointer); no room above either: as low as fits. Moved left when there is no room to the right. Decided once when it
 * opens, so filtering (the list shrinks) never moves it. */
function place(el, { x, y }) {
  if (!el || 'placed' in el.dataset) return;
  el.dataset.placed = '';
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${Math.max(PAD, Math.min(x + GAP, innerWidth - PAD - w))}px`;
  if (y + GAP + h <= innerHeight - PAD) el.style.top = `${y + GAP}px`;
  else if (y - GAP - h >= TOP) {
    el.dataset.flip = '';
    el.style.bottom = `${innerHeight - y + GAP}px`;
  } else el.style.top = `${Math.max(TOP, innerHeight - PAD - h)}px`;
}

/** Enter / click, or Tab (`tab`): the palette closes and the focus goes back, the entry runs, then the notice shows;
 * Tab, and an entry that only has options, open its options panel instead. Tab on an entry without options does nothing. */
function commit(entry, tab) {
  if (tab && !entry.options) return;
  const ctx = getState().toolSearch;
  closeToolSearch();
  if (entry.command) return runCommand(entry, ctx);
  entry.run?.(toolContext(ctx.board));
  if (tab || !entry.run) return setState({ toolOptions: { entry, ctx } });
  const c = toolContext(ctx.board);
  const text = entry.toggle ? `${entry.label} ${entry.active(c) ? 'on' : 'off'}` : entry.notice ?? entry.label;
  notify({ icon: entry.icon, text });
}

/** An entry with a `command` (SPEC §8): invoked as source 'palette' (audited); then the focus goes back again (New draft
 * remounts the editor) and the notice shows the label, or the error. */
async function runCommand(entry, ctx) {
  const res = await invoke({ id: entry.command, args: entry.args?.(toolContext(ctx.board)) ?? {}, source: 'palette' });
  returnFocus(ctx);
  notify({ icon: entry.icon, text: res.ok ? entry.notice ?? entry.label : res.error.message });
}

const PLACES = { editor: 'the draft editor', plan: 'the Plans page', flows: 'the Flowcharts page', browser: 'the browser' };

/** "Resolve with assistant" (a query no tool matches, the assistant usable): the palette closes, the chat panel shows and gets
 * the query with the selection the palette opened with as a pill (assistant.js ask), and a note for the model. */
function resolve(query) {
  const { toolSearch: ctx, view } = getState();
  closeToolSearch();
  const where = `${PLACES[view.type] ?? 'the app'}${canvasEditor.get() ? ', editing a canvas' : ''}`;
  ask([query, ...(ctx?.attach ? [' ', ctx.attach] : [])],
    `The user typed this in tool search in ${where}.${ctx?.attach ? ' The attachment is what they had selected.' : ''}`);
}

/** Closes the options panel; the focus goes back when it was in the panel. */
function closeOptions() {
  const open = getState().toolOptions;
  if (!open) return;
  setState({ toolOptions: null });
  const a = document.activeElement;
  if (!a || a === document.body || a.closest('[data-tool-options]')) returnFocus(open.ctx);
}

function Palette({ board, at }) {
  // Sections (tool-rank.mjs): a node-selected block's first (its actions, then the suggested entries), or flowchart mode's;
  // `tie`: each entry's section for the tie-break.
  const [{ entries, sections, tie }] = useState(() => {
    const c = toolContext(board);
    const entries = listTools(c);
    const sections = paletteSections(entries, { flow: c.flow, block: c.block?.kind });
    return { entries, sections, tie: new Map(sections.flatMap(([, list, t]) => (t ? list.map((x) => [x.id, t]) : []))) };
  });
  const filter = (id, search, [label, ...keywords]) => rankTool(search, label, keywords, tie.get(id));
  const [value, setValue] = useState(''); // the highlighted entry's id: the best match while typing
  const [search, setSearch] = useState('');
  const query = search.trim();
  const status = useAssistant().status;
  const assist = !!query && usable(status); // "Resolve with assistant" when no tool matches
  useEffect(() => { refreshStatus(); }, []);
  // While typing, the section with the best match goes first (stable: ties keep the default order). cmdk 1.1.1 means to
  // do this itself but looks groups up by their React id instead of their value, so it never moves them.
  const best = (list) => Math.max(0, ...list.map((x) => filter(x.id, search, [x.label, ...x.keywords])));
  const groups = [...sections];
  if (search) groups.sort((a, b) => best(b[1]) - best(a[1]));
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && assist && !e.nativeEvent.isComposing && !e.currentTarget.querySelector('[cmdk-item]')) {
      e.preventDefault(); // before cmdk's Enter, which has no entry to run
      return resolve(query);
    }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const entry = entries.find((x) => x.id === value);
    if (entry) commit(entry, true);
  };
  return (
    <Dialog open modal={false} onOpenChange={(open) => !open && closeToolSearch()}>
      <DialogContent {...CHROME} ref={(el) => place(el, at)} showCloseButton={false} onCloseAutoFocus={(e) => e.preventDefault()}
        className="top-auto left-auto translate-x-0 translate-y-0 gap-0 overflow-hidden bg-card/70 p-0 backdrop-blur-[2px] sm:max-w-md data-flip:[&_[data-slot=command]]:flex-col-reverse data-flip:[&_[data-slot=command-input-wrapper]]:border-t data-flip:[&_[data-slot=command-input-wrapper]]:border-b-0">
        <DialogTitle className="sr-only">Tool search</DialogTitle>
        <DialogDescription className="sr-only">Type a tool name. Enter switches to it, Tab opens its options.</DialogDescription>
        <Command className="bg-transparent" filter={filter} value={value} onValueChange={setValue} onKeyDown={onKeyDown}>
          <CommandInput placeholder="Search tools..." value={search} onValueChange={setSearch} />
          <CommandList className="max-h-[min(24rem,60vh)]">
            {assist ? (
              <CommandEmpty className="p-1">
                <div role="option" aria-selected data-resolve onMouseDown={(e) => e.preventDefault()} onClick={() => resolve(query)}
                  className="flex cursor-default items-center gap-2 rounded-sm bg-accent px-2 py-1.5 text-sm text-accent-foreground select-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
                  <MessageSquare />Resolve with assistant
                </div>
              </CommandEmpty>
            ) : <CommandEmpty>No tool found.</CommandEmpty>}
            {groups.map(([group, list]) => list.length > 0 && (
              <CommandGroup key={group} heading={group}>
                {list.map((x) => (
                  <CommandItem key={x.id} value={x.id} keywords={[x.label, ...x.keywords]} onSelect={() => commit(x, false)}>
                    {x.icon}
                    <span className="truncate">{x.label}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      {x.options && <span className="text-xs text-muted-foreground">Tab: options</span>}
                      {shortcutOf(x) && <CommandShortcut className="ml-0 tracking-normal">{shortcutOf(x)}</CommandShortcut>}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** A card at the palette's place (below the pointer it opened at, above it when there is no room) with the entry's
 * controls; it never takes the focus. Escape, Enter or a
 * click outside closes it; it closes too when its entry stops applying (e.g. the item is deselected). */
function OptionsPanel({ entry, ctx }) {
  useEditor(); // live: re-renders on every transaction …
  useSnapshot(ctx.board); // … and board change
  const c = toolContext(ctx.board);
  const applies = entry.when(c);
  useEffect(() => {
    if (!applies) closeOptions();
  }, [applies]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Enter' || e.target.closest?.('[role=listbox],[role=menu]')) return; // Enter in an open select picks
      e.preventDefault();
      e.stopPropagation();
      closeOptions();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <Popover open onOpenChange={(open) => !open && closeOptions()}>
      <PopoverAnchor className="fixed" style={{ left: ctx.at.x, top: ctx.at.y }} />
      <PopoverContent {...CHROME} data-tool-options="" side="bottom" align="start" sideOffset={GAP} collisionPadding={{ top: TOP, right: PAD, bottom: PAD, left: PAD }} className="flex w-auto flex-col gap-1.5 p-2"
        onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}
        onFocusOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5 px-0.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">{entry.icon}{entry.label}</div>
        <div className="flex items-center gap-1">{applies && entry.options(c)}</div>
      </PopoverContent>
    </Popover>
  );
}

/** Palette and options panel; mounted once in App (they portal to body). */
export function ToolSearch() {
  const search = useStore((s) => s.toolSearch);
  const options = useStore((s) => s.toolOptions);
  return (
    <>
      {search && <Palette board={search.board} at={search.at} />}
      {options && <OptionsPanel key={options.entry.id} entry={options.entry} ctx={options.ctx} />}
    </>
  );
}
