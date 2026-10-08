import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BringToFront, ClipboardPaste, Copy, CopyPlus, PackagePlus, Scissors, SendToBack, Trash2 } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { boardMenu, itemCopied } from '../../../whiteboard.js';
import { keyLabel } from '../../keybinds.js';
import { can, GATES } from '../../gates.mjs';
import { createPrefab } from '../../prefabs.js';
import { CHROME, refocus, useSnapshot } from './controls.jsx';

/** A dropdown menu opened at client point `at` from a fixed 0 × 0 trigger there (shadcn context-menu needs a React trigger
 * around the target; Board DOM is not React): the board menu and the shape list's entry menu. The trigger is portalled to
 * the body: inside a transformed ancestor (the shape list's popover) `fixed` would be relative to that ancestor. The
 * installed dropdown keeps one menu open at a time and counts for dismiss-only clicks (§6c). `onCloseAutoFocus` default:
 * back to `board`. */
export function PointerMenu({ at, board, onClose, onCloseAutoFocus = refocus(board), children }) {
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      {createPortal(
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: at.x, top: at.y }} />
        </DropdownMenuTrigger>,
        document.body,
      )}
      <DropdownMenuContent {...CHROME} align="start" sideOffset={2} className="min-w-52" onCloseAutoFocus={onCloseAutoFocus}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The board menu (§6c): a right-click on any Board opens it at the pointer (whiteboard.js boardMenu). Create prefab… and
 * the item actions, wired to the Board's own commands. Mounted once (App.jsx). */
export function BoardMenu() {
  const [menu, setMenu] = useState(null); // {board, at, n} while open
  useEffect(() => {
    let n = 0;
    boardMenu.open = (board, at) => setMenu({ board, at, n: ++n });
    return () => {
      boardMenu.open = () => {};
    };
  }, []);
  const snap = useSnapshot(menu?.board ?? null);
  if (!menu || menu.board.destroyed) return null;
  const { board } = menu;
  const selected = can('board.selection', snap);
  const item = (label, Icon, shortcut, run, enabled = selected) => (
    <DropdownMenuItem disabled={!enabled} onSelect={run}><Icon />{label}<DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut></DropdownMenuItem>
  );
  return (
    <PointerMenu key={menu.n} at={menu.at} board={board} onClose={() => setMenu(null)}>
      <DropdownMenuItem disabled={!selected} onSelect={() => createPrefab(board)} className="flex-wrap">
        <PackagePlus />Create prefab...
        {!selected && <span className="w-full pl-6 text-xs">{GATES['board.selection'].message}</span>}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {item('Cut', Scissors, keyLabel('board.cut'), () => board.copyItem(true))}
      {item('Copy', Copy, keyLabel('board.copy'), () => board.copyItem())}
      {item('Paste', ClipboardPaste, 'Ctrl+V', () => board.pasteItem(), itemCopied())}
      {item('Duplicate', CopyPlus, keyLabel('board.duplicate'), () => board.duplicate())}
      {item('Delete', Trash2, keyLabel('board.delete'), () => board.removeItem())}
      <DropdownMenuSeparator />
      {item('Bring to front', BringToFront, keyLabel('board.front'), () => board.arrange('front'))}
      {item('Send to back', SendToBack, keyLabel('board.back'), () => board.arrange('back'))}
    </PointerMenu>
  );
}
