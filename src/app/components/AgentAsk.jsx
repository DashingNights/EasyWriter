import { useEffect, useRef } from 'react';
import { cn } from 'cn';
import { Bot } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useStore } from '../store.js';

// The agent request card (SPEC §8 Agent requests): a destructive or approval command from an agent waits here for a click.
// Non-modal, at the bottom right above the bottom row, below dialogs (z 45 < 50); while the chat panel is open, inside it above
// its input row instead (Chat.jsx renders it there, `inline`), so it never covers the panel; hidden while the user's own dialog or
// confirm is open (it waits behind them). Its buttons never take the focus, Escape does nothing to it and no shortcut is
// blocked while it waits. Deny carries a ring that runs out with the 60 s the executor waits; then the call is denied.

const keepFocus = (e) => e.preventDefault();
const R = 9;
const C = 2 * Math.PI * R;

/** The time left until `expires` (ms epoch) as a ring that empties. */
function Countdown({ expires }) {
  const ref = useRef(null);
  useEffect(() => {
    const left = Math.max(0, expires - Date.now());
    const a = ref.current.animate([{ strokeDashoffset: C * (1 - left / 60000) }, { strokeDashoffset: C }], { duration: left, fill: 'forwards' });
    return () => a.cancel();
  }, [expires]);
  return (
    <svg viewBox="0 0 22 22" className="size-4 -rotate-90" aria-hidden="true">
      <circle cx="11" cy="11" r={R} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <circle ref={ref} cx="11" cy="11" r={R} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={C} />
    </svg>
  );
}

/** The card: fixed (App.jsx), or `inline` in the open chat panel; each shows only in its own case. */
export function AgentAsk({ inline = false }) {
  const queue = useStore((s) => s.agentAsk);
  const blocked = useStore((s) => !!(s.dialog || s.confirm));
  const chatOpen = useStore((s) => !!s.assistant?.open);
  const ask = queue[0];
  if (!ask || blocked || chatOpen !== inline) return null;
  const name = ask.source.replace(/^agent:/, '');
  return (
    <div data-agent-ask data-board-chrome role="region" aria-label={`Agent request: ${name} wants to ${ask.title}`} onMouseDown={keepFocus}
      className={cn('rounded-island border bg-card p-3 text-sm', inline ? 'mx-1 max-h-[50%] shrink-0 self-stretch overflow-y-auto'
        : 'fixed right-4 bottom-24 z-45 w-[22rem] max-w-[calc(100vw-2rem)] shadow-xl')}>
      <div className="flex items-center gap-2">
        <Badge variant="secondary"><Bot />{`Agent: ${name}`}</Badge>
        {queue.length > 1 && <span className="ml-auto text-xs text-muted-foreground">{`+${queue.length - 1} more`}</span>}
      </div>
      <p className="mt-2 font-medium">{`wants to ${ask.title}`}</p>
      {ask.description && <p className="mt-1 whitespace-pre-line text-muted-foreground">{ask.description}</p>}
      {ask.steps?.length > 0 && (
        <ul data-agent-ask-steps className="mt-1 list-disc pl-5 text-muted-foreground">
          {ask.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => ask.resolve(false)}><Countdown expires={ask.expires} />Deny</Button>
        <Button variant={ask.risk === 'destructive' ? 'destructive' : 'default'} size="sm" onClick={() => ask.resolve(true)}>Allow</Button>
      </div>
    </div>
  );
}
