// The Clipboard pane (docs/plans/word plan.md §3 clipboard; probe/dialogs/clipboard-pane.json): Paste All and Clear All, "Click an
// Item to Paste", the items newest first (a format icon and a text excerpt or a picture thumbnail, each with Paste and Delete), and
// Options with Collect Without Showing Clipboard. Word's label "Office Clipboard" becomes Clipboard (plan.md §1.4 Names).
import { useSyncExternalStore } from 'react';
import { ChevronDown, Image, Settings2, Text, Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { keepFocus } from '../../../app/components/Toolbar.jsx';
import { run } from '../../../tooling/registry.js';
import { saveWord } from '../../word/settings.mjs';
import { clearRing, deleteFromRing, pasteData, pasteSettings, ringItems, subscribeRing } from './core.js';
import { pasteAllOrder } from './ring.mjs';

const ICONS = { picture: Image, text: Type };

/** Pastes pane item `it` into the editor the tools act on, with the default option for its source: through the registry, so a
 * canvas draft's row (rows/home.mjs x.clipboard.pasteItem) pastes through the engine and the tools read its state after. */
export const pasteItem = (_ctx, it) => run('x.clipboard.pasteItem', it.id);

/** Pastes every item, oldest first (Word's order, unverified). */
export function pasteAll(ctx) {
  let any = false;
  for (const it of pasteAllOrder(ringItems())) any = pasteData(ctx.target?.view, { html: it.html, text: it.text, image: it.image }) || any;
  return any;
}

/** The pane: the props of panes.jsx PaneSpec.Component. */
export function ClipboardPane({ ctx }) {
  const items = useSyncExternalStore(subscribeRing, ringItems);
  const hidden = !!pasteSettings().collectHidden;
  return (
    <div className="flex h-full flex-col gap-2 p-2" data-clipboard-pane="">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" data-action="pasteAll" disabled={!items.length || !(ctx.target || ctx.engine)} onMouseDown={keepFocus} onClick={() => run('x.clipboard.pasteAll')}>
          Paste All
        </Button>
        <Button size="sm" variant="outline" data-action="clearAll" disabled={!items.length} onMouseDown={keepFocus} onClick={clearRing}>Clear All</Button>
      </div>
      <p className="text-xs text-muted-foreground">{items.length ? 'Click an Item to Paste' : 'The clipboard is empty.'}</p>
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto" aria-label="Clipboard items">
        {items.map((it) => {
          const Icon = ICONS[it.kind] ?? Text;
          return (
            <li key={it.id} data-clip-item={it.id} className="group flex items-stretch rounded-md border bg-background hover:bg-accent/50">
              <button type="button" className="flex min-w-0 flex-1 items-start gap-2 p-2 text-left" onMouseDown={keepFocus} disabled={!(ctx.target || ctx.engine)}
                onClick={() => pasteItem(ctx, it)} aria-label={`Paste ${it.excerpt || 'picture'}`}>
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                {it.image && !it.text ? <img src={it.image} alt="" className="max-h-16 max-w-full object-contain" />
                  : <span className="line-clamp-3 text-xs break-words">{it.excerpt}</span>}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="Item options" data-action="itemMenu" onMouseDown={keepFocus}
                    className="px-1 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100">
                    <ChevronDown className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem data-action="paste" disabled={!(ctx.target || ctx.engine)} onSelect={() => pasteItem(ctx, it)}>Paste</DropdownMenuItem>
                  <DropdownMenuItem data-action="delete" onSelect={() => deleteFromRing(it.id)}>Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="w-fit" data-action="options" onMouseDown={keepFocus}><Settings2 />Options</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top">
          {/* ponytail: Word's other Options rows (show automatically, on Ctrl+C twice, taskbar icon and status) need the window and the
              system tray, which Word's UI may not reach here; only Collect Without Showing is kept. */}
          <DropdownMenuCheckboxItem checked={hidden} data-action="collectHidden"
            onCheckedChange={(on) => saveWord({ paste: { collectHidden: !!on } })}>Collect Without Showing Clipboard</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
