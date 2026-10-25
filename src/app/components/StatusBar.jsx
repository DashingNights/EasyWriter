import { useEffect } from 'react';
import { cn } from 'cn';
import { SpellCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { openSettings, refocusEditor, saveSettings, setZoom } from '../actions.js';
import { paginationKey } from '../../document/pagination.js';
import { Slot } from '../../integrations/ui.js';
import { on } from '../commands.js';
import { getState, setState, useEditor, useStore } from '../store.js';
import { Tip } from './Tip.jsx';

const ZOOMS = ['fit', 50, 67, 75, 90, 100, 125, 150];

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Turns the main window's spell checker on or off (settings.spellCheck; main.js setSpellCheckerEnabled): the status bar's
 * button, tool search. */
export function toggleSpellCheck() {
  return saveSettings({ spellCheck: !(getState().settings?.spellCheck ?? true) });
}

/** The agents slot (SPEC §8): empty while nothing is connected; "Agent: <name>" (two or more: "Agents: N") with a popover
 * listing each connection {name, since} and its Disconnect. Connects and disconnects show a toast. */
function Agents() {
  // The in-app assistant's own turn is not shown here (the chat panel shows it): only outside agents are news.
  const connections = useStore((s) => s.agent.connections).filter((c) => c.name !== 'assistant');
  useEffect(() => {
    const offs = [on('agent.connected', ({ name }) => toast(`${name} connected`)), on('agent.disconnected', ({ name }) => toast(`${name} disconnected`))];
    return () => offs.forEach((off) => off());
  }, []);
  if (!connections.length) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" data-agent-slot="">
          {connections.length === 1 ? `Agent: ${connections[0].name}` : `Agents: ${connections.length}`}
        </Button>
      </PopoverTrigger>
      <PopoverContent data-agent-deny side="top" align="start" className="flex w-64 flex-col gap-1 p-2 text-xs" onCloseAutoFocus={refocusEditor}>
        {connections.map((c) => (
          <div key={`${c.name}-${c.since}`} className="flex items-center gap-2">
            <span className="truncate font-medium">{c.name}</span>
            <span className="text-muted-foreground">{`since ${clock(c.since)}`}</span>
            <Button variant="outline" size="xs" className="ml-auto" disabled={!c.disconnect} onClick={() => c.disconnect?.()}>Disconnect</Button>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** The model in use (SPEC §7i): while the assistant answers, the slot shows the model the server runs (its label, a custom
 * file's name, or the host of an external server); a click opens Settings > Assistant. Nothing otherwise. */
function Model() {
  const busy = useStore((s) => s.agent.connections.some((c) => c.name === 'assistant'));
  const status = useStore((s) => s.assistant?.status);
  if (!busy) return null;
  const label = status?.model?.label === 'Custom model' ? status.model.file : status?.model?.label ?? (status?.url ? new URL(status.url).host : 'Assistant');
  return (
    <Tip title="The model answering now. Change it in Settings" side="top">
      <Button variant="ghost" size="xs" data-agent-deny onClick={() => openSettings('assistant')}>{label}</Button>
    </Tip>
  );
}

const countWords = (text) => text.split(/\s+/).filter(Boolean).length;

/** Word's statistics of `doc` (a Document's ProseMirror doc; the Word count popover adds the pages): words, characters with and without spaces (paragraph marks not
 * counted), and the paragraphs that hold text. Words are read as the selection count reads them, so a line break (Shift+Enter)
 * splits two words, as in the status bar's total. */
function counts(doc) {
  const blocks = [];
  doc.descendants((n) => {
    if (n.isTextblock) blocks.push(n.textContent);
    return !n.isTextblock;
  });
  return { words: countWords(doc.textBetween(0, doc.content.size, ' ', ' ')), chars: blocks.join('').length, noSpaces: blocks.join('').replace(/\s/g, '').length, paragraphs: blocks.filter((b) => b.trim()).length };
}

/** A Document's pages (document/pagination.js): {page: the caret's, pages}, or null without an editor. */
const pagesOf = (ed) => (ed ? paginationKey.getState(ed.state) ?? null : null);

/** 'Page X of Y' (Word's status bar): the caret's page and the page count. */
function DocumentPage() {
  const p = pagesOf(useEditor());
  return p && <span data-page-count="" className="tabular-nums">{`Page ${p.page} of ${p.pages}`}</span>;
}

/** A Document's word count (Word's status bar): 'N of M words' while text is selected; a press opens the Word count popover
 * (also from the tool search, document/tools.js openWordCount). */
function DocumentWords({ total }) {
  const ed = useEditor();
  const open = useStore((s) => s.wordCount);
  const { from, to, empty } = ed?.state.selection ?? { empty: true };
  const selected = !empty && ed ? countWords(ed.state.doc.textBetween(from, to, ' ', ' ')) : null;
  const c = open && ed ? { pages: pagesOf(ed)?.pages, ...counts(ed.state.doc) } : null;
  return (
    <Popover open={open} onOpenChange={(o) => setState({ wordCount: o })}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="-mx-1 font-normal text-muted-foreground" data-word-count="">
          {selected != null ? `${selected} of ${total} ${total === 1 ? 'word' : 'words'}` : `${total} ${total === 1 ? 'word' : 'words'}`}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 p-3 text-xs" onCloseAutoFocus={refocusEditor}>
        <div className="mb-2 text-sm font-medium">Word count</div>
        {c && [['Pages', c.pages], ['Words', c.words], ['Characters (no spaces)', c.noSpaces], ['Characters (with spaces)', c.chars], ['Paragraphs', c.paragraphs]].map(([label, n]) => (
          <div key={label} className="flex justify-between py-0.5"><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{n}</span></div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function StatusBar() {
  const saveLabel = useStore((s) => s.saveLabel);
  const saveError = useStore((s) => s.saveError);
  const words = useStore((s) => s.words);
  const zoom = useStore((s) => s.zoom);
  const zoomPct = useStore((s) => s.zoomPct);
  const spell = useStore((s) => s.settings?.spellCheck ?? true);
  const isDocument = useStore((s) => s.draft?.format === 'document');
  return (
    <footer className="col-span-2 flex h-8 items-center gap-4 border-t px-2 text-xs text-muted-foreground">
      {/* The main window's spell checker (settings.spellCheck, main.js setSpellCheckerEnabled): off clears the underlines. */}
      <Tip title={spell ? 'Turn spell check off' : 'Turn spell check on'} side="top">
        <Button variant="ghost" size="xs" aria-pressed={spell} className="-mx-1 font-normal text-muted-foreground"
          onClick={() => { toggleSpellCheck(); refocusEditor(); }}>
          <SpellCheck className={cn(!spell && 'opacity-50')} />{spell ? 'Spell check on' : 'Spell check off'}
        </Button>
      </Tip>
      <span className={cn(saveError && 'text-destructive')}>{saveLabel}</span>
      {isDocument && <DocumentPage />}
      {isDocument ? <DocumentWords total={words} /> : <span>{`${words} ${words === 1 ? 'word' : 'words'}`}</span>}
      <Slot name="StatusBarItem" />
      <Model />
      <Agents />
      <div className="ml-auto flex items-center gap-2">
        Zoom
        <Slider aria-label="Page zoom" className="w-28" min={25} max={200} step={1} value={[Math.min(200, Math.max(25, zoomPct))]}
          onValueChange={([value]) => setZoom(value)} />
        <Tip title="Type an exact zoom">
          <Combobox size="xs" aria-label="Zoom percent" className="w-20 tabular-nums" value={zoom} text={`${zoomPct} %`}
            options={ZOOMS.map((v) => [v, v === 'fit' ? 'Fit' : `${v} %`])}
            onCommit={(t) => { const v = parseFloat(t); if (Number.isFinite(v)) setZoom(v); }}
            onPick={setZoom} onDone={() => refocusEditor()} contentProps={{ side: 'top', align: 'end', className: 'min-w-24' }} />
        </Tip>
      </div>
    </footer>
  );
}
