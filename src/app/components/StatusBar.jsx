import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { openSettings, refocusEditor, setZoom } from '../actions.js';
import { on } from '../commands.js';
import { useStore } from '../store.js';
import { InlineInput } from './InlineInput.jsx';
import { Tip } from './Tip.jsx';

const ZOOMS = ['fit', 50, 67, 75, 90, 100, 125, 150];

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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

export function StatusBar() {
  const saveLabel = useStore((s) => s.saveLabel);
  const saveError = useStore((s) => s.saveError);
  const words = useStore((s) => s.words);
  const status = useStore((s) => s.status);
  const zoom = useStore((s) => s.zoom);
  const zoomPct = useStore((s) => s.zoomPct);
  const [editing, setEditing] = useState(false);
  return (
    <footer className="col-span-2 flex h-8 items-center gap-4 border-t px-2 text-xs text-muted-foreground">
      <span className={cn(saveError && 'text-destructive')}>{saveLabel}</span>
      <span>{`${words} ${words === 1 ? 'word' : 'words'}`}</span>
      <span>{status.loggedIn ? `Forum: logged in as ${status.name || status.memberId}` : 'Forum: not logged in'}</span>
      <Model />
      <Agents />
      <div className="ml-auto flex items-center gap-2">
        Zoom
        <Slider aria-label="Page zoom" className="w-28" min={25} max={200} step={1} value={[Math.min(200, Math.max(25, zoomPct))]}
          onValueChange={([value]) => setZoom(value)} />
        {editing ? (
          <InlineInput aria-label="Zoom percent" value={zoomPct} className="h-6 w-13 text-xs md:text-xs"
            onDone={(text) => {
              setEditing(false);
              const value = parseFloat(text);
              if (Number.isFinite(value)) setZoom(value);
            }} />
        ) : (
          <Tip title="Type an exact zoom">
            <Button variant="ghost" size="xs" className="w-13 tabular-nums" onClick={() => setEditing(true)}>{`${zoomPct} %`}</Button>
          </Tip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="xs" aria-label="Zoom presets" className="w-12 justify-end">
              {zoom === 'fit' && 'Fit'}<ChevronUp />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="min-w-24" onCloseAutoFocus={refocusEditor}>
            {ZOOMS.map((value) => (
              <DropdownMenuCheckboxItem key={value} checked={zoom === value} onSelect={() => setZoom(value)}>
                {value === 'fit' ? 'Fit' : `${value} %`}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </footer>
  );
}
