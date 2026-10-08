import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, FileCode, Plus, Workflow } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { drawCanvas } from '../../../whiteboard.js';
import { diagramItems, flowList, useFlows } from '../../flows.js';
import { FormDialog } from '../FormDialog.jsx';

const NEW = 'new';
const HELP = {
  synced: 'A live view of the library flowchart. Edits here change it everywhere it is inserted.',
  copy: 'An independent canvas; the library is not changed.',
};

/** Insert flowchart (flowchart plan §5.1): New flowchart, the draft's thread's flowcharts, then those without a thread
 * (skipped when the library passes its `flowId`); Synced (default) or Copy. → {flowId | null, mode}. */
function InsertFlowDialog({ flowId, threadUrl, onClose }) {
  useFlows();
  const [value, setValue] = useState(flowId ?? NEW);
  const [mode, setMode] = useState('synced');
  const item = (s) => (
    <CommandItem key={s.id} value={s.id} keywords={[s.title]} onSelect={setValue}>
      <Workflow />
      <span className="truncate">{s.title}</span>
    </CommandItem>
  );
  const own = threadUrl ? flowList().filter((s) => s.threadUrl === threadUrl) : [];
  const loose = flowList().filter((s) => !s.threadUrl);
  return (
    <FormDialog title="Insert flowchart" okText="Insert" result={() => ({ flowId: value === NEW ? null : value, mode })} onClose={onClose}>
      {!flowId && (
        // Clicks and arrow keys choose; the pointer only hovers.
        <Command value={value} onValueChange={setValue} disablePointerSelection className="rounded-md border">
          <CommandInput placeholder="Search flowcharts..." />
          <CommandList>
            <CommandEmpty>No flowchart found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value={NEW} keywords={['new flowchart']} onSelect={setValue}><Plus />New flowchart</CommandItem>
            </CommandGroup>
            {own.length > 0 && <CommandGroup heading="This thread">{own.map(item)}</CommandGroup>}
            {loose.length > 0 && <CommandGroup heading="No thread">{loose.map(item)}</CommandGroup>}
          </CommandList>
        </Command>
      )}
      <ToggleGroup type="single" variant="outline" size="sm" aria-label="Insert as" value={mode} onValueChange={(v) => v && setMode(v)}>
        <ToggleGroupItem value="synced">Synced</ToggleGroupItem>
        <ToggleGroupItem value="copy">Copy</ToggleGroupItem>
      </ToggleGroup>
      <p className="text-xs text-muted-foreground">{HELP[mode]}</p>
    </FormDialog>
  );
}

/** Save to library… (§3.9): the new library flowchart's title. */
function SaveFlowDialog({ title, onClose }) {
  const [value, setValue] = useState(title);
  return (
    <FormDialog title="Save to library" okText="Save" validate={() => (value.trim() ? '' : 'Enter a title.')} result={() => value.trim()}
      onClose={onClose}>
      <Input className="h-8" autoFocus maxLength={120} value={value} aria-label="Title" onChange={(e) => setValue(e.target.value)} />
      <p className="text-xs text-muted-foreground">The canvas becomes a synced view of the new library flowchart.</p>
    </FormDialog>
  );
}

/** Create prefab… / Rename… (flowchart plan §5.12): the prefab's name, at most 80 characters (`rename`: OK = Rename). */
function PrefabNameDialog({ name, rename = false, onClose }) {
  const [value, setValue] = useState(name);
  return (
    <FormDialog title={rename ? 'Rename prefab' : 'Create prefab'} okText={rename ? 'Rename' : 'Create'}
      validate={() => (value.trim() ? '' : 'Enter a name.')} result={() => value.trim()} onClose={onClose}>
      <Input className="h-8" autoFocus maxLength={80} value={value} aria-label="Name" onFocus={(e) => e.target.select()}
        onChange={(e) => setValue(e.target.value)} />
    </FormDialog>
  );
}

/** The layout directions (auto layout's options, the import's direction list): [dir, label, icon]. */
export const DIRECTIONS = [['TB', 'Top to bottom', ArrowDown], ['LR', 'Left to right', ArrowRight], ['BT', 'Bottom to top', ArrowUp],
  ['RL', 'Right to left', ArrowLeft]];
const AS_WRITTEN = 'text';
const EXAMPLE = 'flowchart LR\n  A[Start] --> B{OK?}\n  B -->|yes| C[Ship]\n  B -->|no| A';
const where = (e) => `Line ${e.line}, column ${e.col}: ${e.message}`;

// The laid-out diagram (diagramItems) drawn by the canvas preview, fitted into the box and centred.
function DiagramPreview({ shown }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const box = ref.current;
    box.replaceChildren();
    box.style.background = '';
    if (!shown?.items) return;
    const art = drawCanvas(box, { aw: shown.w, ah: shown.h, bg: 'post', items: shown.items });
    const k = Math.min(1, (box.clientWidth - 16) / shown.w, (box.clientHeight - 16) / shown.h);
    Object.assign(art.style, { transform: `scale(${k})`, left: `${(box.clientWidth - shown.w * k) / 2}px`, top: `${(box.clientHeight - shown.h * k) / 2}px` });
  }, [shown]);
  return <div ref={ref} data-diagram-preview="" className="relative h-52 overflow-hidden rounded-md border" />;
}

/** Import diagram (SPEC §7): Mermaid flowchart text (prefilled by a paste onto a board), a live preview of the laid-out
 * result or the parser's first error with its line and column, the layout direction (as in the text, or one of four), and
 * on a board "Replace board contents" (off: the diagram is added). → {text, dir: null | TB | LR | BT | RL, replace} */
function ImportDiagramDialog({ text: initial = '', board = false, onClose }) {
  const [text, setText] = useState(initial);
  const [dir, setDir] = useState(AS_WRITTEN);
  const [replace, setReplace] = useState(false);
  const read = (t, d) => (t.trim() ? diagramItems(t, { dir: d === AS_WRITTEN ? null : d }) : null);
  const [shown, setShown] = useState(() => read(initial, AS_WRITTEN));
  useEffect(() => {
    const timer = setTimeout(() => setShown(read(text, dir)), 150); // parse and lay out after a pause in typing
    return () => clearTimeout(timer);
  }, [text, dir]);
  const warnings = shown?.warnings ?? [];
  return (
    <FormDialog title="Import diagram" okText="Import" className="sm:max-w-2xl" onClose={onClose}
      validate={() => {
        const r = read(text, dir);
        return !r ? 'Paste or type a Mermaid flowchart.' : r.error ? where(r.error) : '';
      }}
      result={() => ({ text, dir: dir === AS_WRITTEN ? null : dir, replace })}>
      <Textarea autoFocus spellCheck={false} aria-label="Mermaid flowchart" placeholder={EXAMPLE} value={text} onChange={(e) => setText(e.target.value)}
        className="max-h-40 min-h-40 resize-none font-mono text-xs md:text-xs" />
      {shown?.error
        ? <p className="text-xs text-destructive" data-diagram-error="">{where(shown.error)}</p>
        : <p className="text-xs text-muted-foreground">Mermaid flowchart: shapes, links and their labels, subgraphs and classDef fills.</p>}
      <DiagramPreview shown={shown} />
      {warnings.length > 0 && <p className="text-xs text-muted-foreground">{warnings.map((w) => `Line ${w.line}: ${w.message}`).join(' ')}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={dir} onValueChange={setDir}>
          <SelectTrigger size="sm" aria-label="Direction" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={AS_WRITTEN}><FileCode />As in the text</SelectItem>
            {DIRECTIONS.map(([d, label, Icon]) => <SelectItem key={d} value={d}><Icon />{label}</SelectItem>)}
          </SelectContent>
        </Select>
        {board && (
          <Label className="font-normal">
            <Checkbox checked={replace} onCheckedChange={(v) => setReplace(v === true)} />
            Replace board contents
          </Label>
        )}
      </div>
    </FormDialog>
  );
}

// Form dialogs of flowcharts (openDialog types: insertFlow, saveFlow, prefabName, importDiagram), spread into FORMS
// (Dialogs.jsx).
export const FLOW_FORMS = { insertFlow: InsertFlowDialog, saveFlow: SaveFlowDialog, prefabName: PrefabNameDialog, importDiagram: ImportDiagramDialog };
