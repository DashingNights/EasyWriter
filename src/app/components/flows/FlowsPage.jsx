import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Copy, Ellipsis, FolderInput, LayoutGrid, List, Plus, Redo2, Shrink, SquarePlus, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { SelectItem } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { fitArtboard, setArtboardSize } from '../../../canvas.js';
import { refocusEditor, saveSettings, threadLabel } from '../../actions.js';
import {
  canRedoFlow, canUndoFlow, draftThread, duplicateFlow, getFlow, insertFlowchartDialog, newFlow, openFlows, removeFlow, updateFlow, useFlows,
} from '../../flows.js';
import { can } from '../../gates.mjs';
import { keyAmong, keyIs, keyLabel, withKey } from '../../keybinds.js';
import { useStore } from '../../store.js';
import { closeWorkspace } from '../../views.js';
import { SizeInput } from '../board/CanvasBar.jsx';
import { CHROME } from '../board/controls.jsx';
import { InlineInput } from '../InlineInput.jsx';
import { SidebarButton } from '../Sidebar.jsx';
import { Tip } from '../Tip.jsx';
import { keepFocus, NONE, ToolSelect } from '../Toolbar.jsx';
import { FlowEditor } from './FlowEditor.jsx';
import { FlowLibrary } from './FlowLibrary.jsx';

const ALL = '*'; // thread scope: every flowchart (NONE: those without a thread)
const root = () => document.getElementById('workspace-root');

/** The thread menu entries: the sidebar's threads, plus `extra` (a thread URL not in that list). */
function threadItems(threads, extra) {
  return [
    ...threads.map((t) => <SelectItem key={t.url} value={t.url}><span className="truncate">{threadLabel(t)}</span></SelectItem>),
    extra && extra !== NONE && extra !== ALL && !threads.some((t) => t.url === extra) && <SelectItem key={extra} value={extra}><span className="truncate">{extra}</span></SelectItem>,
  ];
}

/** The open flowchart's controls (board chrome, so focus in W / H keeps the board active): W / H, Fit to content, Insert
 * into draft…, Undo / Redo on the record's stack, and Duplicate, Move to thread, Delete. */
function EditorControls({ record, board }) {
  const threads = useStore((s) => s.settings?.threads) ?? [];
  const { id, board: { w, h } } = record;
  const tip = (title, button) => <Tip title={title}>{button}</Tip>;
  return (
    <div {...CHROME} className="flex items-center gap-1" onMouseDown={(e) => e.target.tagName !== 'INPUT' && e.preventDefault()}>
      <SizeInput board={board} label="W" value={w} onCommit={(v) => setArtboardSize(board, v, h)} />
      <SizeInput board={board} label="H" value={h} onCommit={(v) => setArtboardSize(board, w, v)} />
      {tip('Shrink the artboard to the items', <Button variant="ghost" size="xs" onClick={() => fitArtboard(board)}><Shrink />Fit to content</Button>)}
      {tip('Insert it into the open draft, synced or as a copy', <Button variant="ghost" size="xs" onClick={() => insertFlowchartDialog(id)}><SquarePlus />Insert into draft...</Button>)}
      {tip(withKey('Undo', 'edit.undo'), <Button variant="ghost" size="icon-xs" aria-label="Undo" disabled={!can('history.canUndo', { canUndo: canUndoFlow(id) })} onClick={() => board.undo()}><Undo2 /></Button>)}
      {tip(withKey('Redo', 'edit.redo'), <Button variant="ghost" size="icon-xs" aria-label="Redo" disabled={!can('history.canRedo', { canRedo: canRedoFlow(id) })} onClick={() => board.redo()}><Redo2 /></Button>)}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="More flowchart actions"><Ellipsis /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={refocusEditor}>
          <DropdownMenuItem onSelect={() => duplicateFlow(id).then((r) => r && openFlows(r.id))}><Copy />Duplicate</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><FolderInput />Move to thread</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-w-80">
              <DropdownMenuRadioGroup value={record.threadUrl ?? NONE} onValueChange={(v) => updateFlow(id, { threadUrl: v === NONE ? null : v })}>
                <DropdownMenuRadioItem value={NONE}>No thread</DropdownMenuRadioItem>
                {threads.map((t) => <DropdownMenuRadioItem key={t.url} value={t.url}><span className="truncate">{threadLabel(t)}</span></DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => removeFlow(id)}><Trash2 />Delete...</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The flowchart library workspace (flowchart plan §5.10): one header row, then the list of the thread's flowcharts or the
 * open one's editor. Keys: `/` filter and N new (list); Escape: the board's own steps, then the editor goes back to the list
 * (never further: Escape does not leave a page, §7g). */
export function FlowsPage() {
  useFlows();
  const flowId = useStore((s) => s.view.flowId ?? null);
  const threads = useStore((s) => s.settings?.threads) ?? [];
  const view = useStore((s) => (s.settings?.flowView === 'list' ? 'list' : 'grid'));
  const record = flowId && getFlow(flowId);
  const [board, setBoard] = useState(null);
  const [scope, setScope] = useState(() => draftThread() ?? NONE);
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState(false);
  const filterRef = useRef(null);
  const scopeThread = scope === ALL ? draftThread() : scope === NONE ? null : scope;

  // On #workspace-root itself (its focus target in the list), after the board's keys.
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented) return;
      const typing = e.target instanceof HTMLInputElement || e.target.isContentEditable;
      if (e.key === 'Escape') {
        if (typing || flowId) e.preventDefault(); // an input ends its own edit; the editor goes back to the list
        if (!typing && flowId) openFlows(null);
      } else if (!flowId && !typing && keyAmong(['flows.find', 'flows.new'], e)) { // §7k
        e.preventDefault();
        if (keyIs('flows.find', e)) filterRef.current?.focus();
        else newFlow(scopeThread);
      }
    };
    const el = root();
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [flowId, scopeThread]);

  const rename = (title) => {
    setRenaming(false);
    if (title != null) updateFlow(flowId, { title });
    (board ?? root())?.focus();
  };
  const inScope = (s) => scope === ALL || (scope === NONE ? !s.threadUrl : s.threadUrl === scope);
  return (
    <div data-viewport className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b px-1 text-xs">
        <SidebarButton />
        <Tip title="All flowcharts of the thread">
          <Button variant="ghost" size="xs" className="font-medium" disabled={!flowId} onMouseDown={keepFocus} onClick={() => openFlows(null)}>Flowcharts</Button>
        </Tip>
        {record && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        {record && (renaming
          ? <InlineInput value={record.title} maxLength={120} className="h-6 w-56 text-xs md:text-xs" aria-label="Title" onDone={rename} />
          : <span className="min-w-0 truncate px-1 font-medium" title="Double-click to rename" onDoubleClick={() => setRenaming(true)}>{record.title}</span>)}
        {!flowId && (
          <>
            <ToolSelect title="Thread" className="ml-1 h-7 max-w-64 min-w-0 text-xs" value={scope} onChange={setScope}>
              {threadItems(threads, scope)}
              <SelectItem value={NONE}>No thread</SelectItem>
              <SelectItem value={ALL}>All flowcharts</SelectItem>
            </ToolSelect>
            <Input ref={filterRef} value={filter} placeholder={(keyLabel('flows.find') ? `Filter... ( ${keyLabel('flows.find')} )` : 'Filter...')} aria-label="Filter flowcharts" className="h-7 w-44 text-xs md:text-xs"
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                setFilter('');
                root()?.focus();
              }} />
          </>
        )}
        <span className="flex-1" />
        {can('flow.open', record) && board && <EditorControls record={record} board={board} />}
        {!flowId && (
          <ToggleGroup type="single" size="sm" aria-label="View" value={view} onValueChange={(v) => v && saveSettings({ flowView: v })}>
            {[['grid', 'Grid', LayoutGrid], ['list', 'List', List]].map(([value, name, Icon]) => (
              <Tip key={value} title={name}>
                <ToggleGroupItem value={value} aria-label={name} className="h-7 px-1.5" onMouseDown={keepFocus}><Icon /></ToggleGroupItem>
              </Tip>
            ))}
          </ToggleGroup>
        )}
        {!flowId && (
          <Tip title={withKey('New flowchart in this thread', 'flows.new')}>
            <Button variant="ghost" size="xs" onMouseDown={keepFocus} onClick={() => newFlow(scopeThread)}><Plus />New flowchart</Button>
          </Tip>
        )}
        <Tip title="Back to the open draft">
          <Button variant="outline" size="xs" onMouseDown={keepFocus} onClick={() => closeWorkspace()}>Back to editor</Button>
        </Tip>
      </header>
      {record ? <FlowEditor key={record.id} id={record.id} onBoard={setBoard} /> : <FlowLibrary inScope={inScope} filter={filter} view={view} />}
    </div>
  );
}
