import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '../components/Tip.jsx';
import { setState, useStore } from '../store.js';

/** The background window's live view (SPEC §7i Background window): a floating panel at the top left of the main column,
 * resizable from its bottom-right corner, showing the offscreen window's frames (about 5 a second, sent only while it is
 * shown). View only: the assistant works there, the user watches. Hide closes it; the work goes on. */
export function BackgroundPane() {
  const title = useStore((s) => s.worker?.title ?? '');
  const [src, setSrc] = useState('');
  useEffect(() => {
    const off = window.api.computer.onEvent((e) => e.type === 'frame' && setSrc(e.url));
    window.api.computer.pane(true);
    return () => {
      off();
      window.api.computer.pane(false);
    };
  }, []);
  return (
    <div data-background-pane role="region" aria-label="Background window"
      className="absolute top-2 left-14 z-[44] flex h-80 min-h-40 w-[30rem] min-w-64 resize flex-col overflow-hidden rounded-island border bg-card/90 p-1 text-sm shadow-xl backdrop-blur-[2px]">
      <div className="flex shrink-0 items-center gap-1.5 py-0.5 pr-0.5 pl-2 select-none">
        <span className="shrink-0 font-medium">Background window</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={title}>{title}</span>
        <span className="flex-1" />
        <Tip title="Hide" side="top">
          <Button variant="ghost" size="icon-sm" aria-label="Hide" className="size-7" onMouseDown={(e) => e.preventDefault()}
            onClick={() => setState({ workerPane: false })}><X /></Button>
        </Tip>
      </div>
      {src ? <img src={src} alt="The background window" draggable={false} className="min-h-0 flex-1 rounded-md object-contain" />
        : <p className="flex-1 px-2 py-1 text-muted-foreground">Waiting for the first picture</p>}
    </div>
  );
}
