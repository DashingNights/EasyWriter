// ph-smartart-2: Insert > Diagram's Choose a Diagram dialog and More Layouts (Word's Choose a SmartArt Graphic): the categories
// on the left, the layout tiles in the middle, the picked layout's description on the right. Word's other categories (Picture,
// Timeline, Meet The Team, Text Card, Office.com) stay out because EasyWriter has no such layouts.
import { useState } from 'react';
import { Blend, Grid2x2, LayoutGrid, Network, Orbit, RefreshCw, Triangle, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { CATEGORIES, LAYOUTS } from './layouts.mjs';

/** A layout's `icon` name → its lucide component (ChooseDialog's tiles, the galleries' previews and tiles). */
export const ICONS = { LayoutGrid, Workflow, RefreshCw, Network, Orbit, Blend, Grid2x2, Triangle };

export function ChooseDialog({ value, onClose }) {
  const [picked, setPicked] = useState(value ?? 'basicList');
  const [cat, setCat] = useState('All');
  const shown = cat === 'All' ? LAYOUTS : LAYOUTS.filter((l) => l.groups.includes(cat));
  const layout = LAYOUTS.find((l) => l.id === picked) ?? LAYOUTS[0];
  const Icon = ICONS[layout.icon];
  // The height is fixed, so nothing moves when the category changes.
  return (
    <WordDialog title="Choose a Diagram" size="lg" result={() => picked} onClose={onClose}>
      <div className="flex h-[22rem] gap-4">
        <div className="flex w-36 shrink-0 flex-col gap-1 overflow-auto">
          {CATEGORIES.map((name) => (
            <Button key={name} type="button" variant="outline" size="xs" aria-current={name === cat ? 'true' : undefined}
              data-diagram-category={name} onClick={() => setCat(name)}
              className={name === cat ? 'justify-start border-border bg-accent' : 'justify-start border-transparent'}>
              {name}
            </Button>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-auto">
          <div className="grid grid-cols-3 gap-2">
            {shown.map((l) => {
              const TileIcon = ICONS[l.icon];
              return (
                <Button key={l.id} type="button" variant="outline" size="xs" aria-pressed={l.id === picked} data-diagram-layout={l.id}
                  onClick={() => setPicked(l.id)} onDoubleClick={() => onClose(l.id)}
                  className="h-auto flex-col gap-1 whitespace-normal p-2 text-center aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-ring/50">
                  <TileIcon className="size-8" />
                  {l.label}
                </Button>
              );
            })}
          </div>
        </div>
        <div className="flex w-52 shrink-0 flex-col items-center gap-2 overflow-auto">
          <Icon className="size-20 text-muted-foreground" />
          <p className="text-center font-medium">{layout.label}</p>
          <p className="text-muted-foreground">{layout.desc}</p>
        </div>
      </div>
    </WordDialog>
  );
}
