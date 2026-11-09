import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { SpellCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { openSettings, refocusEditor, saveSettings, setZoom } from '../actions.js';
import { SuggestionsSlot } from '../../suggest/Review.jsx';
import { Slot } from '../../integrations/ui.js';
import { activeSurface } from '../../tooling/surface.js';
import { on } from '../commands.js';
import { getState, useStore } from '../store.js';
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

const BAR = 'col-span-2 flex h-8 min-w-0 items-center gap-4 overflow-hidden border-t px-2 text-xs whitespace-nowrap text-muted-foreground'; // one line at any width

/** A canvas draft's words, read from the engine as Word's status bar reads them (WordStatusBar's useEngineCounts): the draft's
 * ProseMirror doc is empty, so review.wordCount on its session is the document. Read a moment after each layout or selection
 * change → the word count. */
function useEngineWords(session) {
  const [words, setWords] = useState(0);
  useEffect(() => {
    if (!session) return undefined;
    let live = true;
    let timer = 0;
    const read = () => session.query('review.wordCount', { includeTextBoxes: true }).then((r) => {
      if (live) setWords(r?.ok ? (r.value?.words ?? 0) : 0);
    }, () => {});
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(read, 150);
    };
    const offs = ['layout', 'selection', 'reopened'].map((e) => session.on?.(e, later));
    later();
    return () => {
      live = false;
      clearTimeout(timer);
      for (const off of offs) off?.();
    };
  }, [session]);
  return words;
}

/** The app's status bar. `Word`: while App.jsx shows the Word chrome (an open Document in the editor view), the statusbar package's
 * bar, which renders this bar's own items (`lead`, `tail`) around Word's and replaces the word count and zoom below. */
export function StatusBar({ Word }) {
  const saveLabel = useStore((s) => s.saveLabel);
  const saveError = useStore((s) => s.saveError);
  useStore((s) => s.focusedSession); // a canvas post's words come from its engine session
  // A Document shows Word's bar (its own count item) around this one's lead and tail: there is no word span to fill.
  const session = Word ? null : activeSurface()?.session ?? null;
  const engineWords = useEngineWords(session);
  const storeWords = useStore((s) => s.words);
  const words = session ? engineWords : storeWords;
  // A whiteboard has no text of its own (its items live in draft.board): its status bar shows no word count.
  const board = useStore((s) => s.draft?.format === 'board');
  const zoom = useStore((s) => s.zoom);
  const zoomPct = useStore((s) => s.zoomPct);
  const spell = useStore((s) => s.settings?.spellCheck ?? true);
  const lead = (
    <>
      {/* The main window's spell checker (settings.spellCheck, main.js setSpellCheckerEnabled): off clears the underlines. */}
      <Tip title={spell ? 'Turn spell check off' : 'Turn spell check on'} side="top">
        <Button variant="ghost" size="xs" aria-pressed={spell} className="-mx-1 font-normal text-muted-foreground"
          onClick={() => { toggleSpellCheck(); refocusEditor(); }}>
          <SpellCheck className={cn(!spell && 'opacity-50')} />{spell ? 'Spell check on' : 'Spell check off'}
        </Button>
      </Tip>
      <span className={cn(saveError && 'text-destructive')}>{saveLabel}</span>
    </>
  );
  const tail = (
    <>
      <Slot name="StatusBarItem" />
      <Model />
      <Agents />
      <SuggestionsSlot />
    </>
  );
  if (Word) return <Word className={BAR} lead={lead} tail={tail} />;
  return (
    <footer className={BAR}>
      {lead}
      {!board && <span data-word-count="">{`${words} ${words === 1 ? 'word' : 'words'}`}</span>}
      {tail}
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
