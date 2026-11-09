import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BringToFront, ClipboardPaste, Copy, CopyPlus, Eye, EyeOff, FlipHorizontal2, FlipVertical2, Group, Lock, LockOpen, PackagePlus, Scissors, SendToBack, Shapes,
  Slash, Trash2, Ungroup,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { boardMenu, itemCopied } from '../../../whiteboard.js';
import { fixedKey, keyLabel } from '../../keybinds.js';
import { can, GATES } from '../../gates.mjs';
import { commandOf, ctxOf, run } from '../../../tooling/registry.js';
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
 * the item actions, each the board's pool command (pool-board.js; the right-clicked board has the focus, so it is ctx.board).
 * Mounted once (App.jsx). */
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
  // A command the board cannot do yet (PlaneBoard.can, through its pool command) shows disabled, as in tool search.
  const item = (label, Icon, shortcut, id, enabled = selected) => (
    <DropdownMenuItem disabled={!enabled || commandOf(id)?.enabled?.(ctxOf()) === false} onSelect={() => run(id)}>
      <Icon />{label}<DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>
    </DropdownMenuItem>
  );
  // Lock and Hide name the change they make (§6 Layer fields: Unlock / Show when every selected item already has it).
  const every = (field) => selected && board.selectedItems().every((i) => i[field]);
  const any = (field) => board.items.some((i) => i[field]);
  // An engine board's copy is bd-clip's own (api.copied); the DOM Board's is whiteboard's module clipboard.
  const copied = () => (typeof board.copied === 'function' ? board.copied() : itemCopied());
  // A Document's canvas: Set as Default Shape or Line for the one selected shape or line (the commands its format registers; only
  // the one that applies shows, as in Word's menu).
  const defaults = [['contextMenu.shape.setAsDefaultShape', 'Set as Default Shape', Shapes], ['contextMenu.shape.setAsDefaultLine', 'Set as Default Line', Slash]]
    .filter(([id]) => commandOf(id)?.enabled?.(ctxOf()));
  return (
    <PointerMenu key={menu.n} at={menu.at} board={board} onClose={() => setMenu(null)}>
      <DropdownMenuItem disabled={!selected} onSelect={() => run('board.items.prefab')} className="flex-wrap">
        <PackagePlus />Create prefab...
        {!selected && <span className="w-full pl-6 text-xs">{GATES['board.selection'].message}</span>}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {item('Cut', Scissors, keyLabel('board.cut'), 'board.items.cut')}
      {item('Copy', Copy, keyLabel('board.copy'), 'board.items.copy')}
      {item('Paste', ClipboardPaste, fixedKey('Ctrl+V'), 'board.items.paste', copied())}
      {item('Duplicate', CopyPlus, keyLabel('board.duplicate'), 'board.items.duplicate')}
      {item('Delete', Trash2, keyLabel('board.delete'), 'board.items.remove')}
      <DropdownMenuSeparator />
      {item('Bring to front', BringToFront, keyLabel('board.front'), 'board.items.arrange.front')}
      {item('Send to back', SendToBack, keyLabel('board.back'), 'board.items.arrange.back')}
      <DropdownMenuSeparator />
      {item('Group', Group, keyLabel('board.group'), 'board.items.group', can('board.selectionMany', snap))}
      {item('Ungroup', Ungroup, keyLabel('board.ungroup'), 'board.items.ungroup', selected && board.canUngroup())}
      <DropdownMenuSeparator />
      {item('Flip horizontal', FlipHorizontal2, keyLabel('board.flipH'), 'board.items.flip.x')}
      {item('Flip vertical', FlipVertical2, keyLabel('board.flipV'), 'board.items.flip.y')}
      <DropdownMenuSeparator />
      {item(every('locked') ? 'Unlock' : 'Lock', Lock, keyLabel('board.lock'), 'board.items.lock')}
      {item('Hide', EyeOff, keyLabel('board.hide'), 'board.items.hide')}
      {any('locked') && item('Unlock all', LockOpen, '', 'board.items.unlockAll', true)}
      {any('hidden') && item('Show all', Eye, '', 'board.items.showAll', true)}
      {defaults.length > 0 && <DropdownMenuSeparator />}
      {defaults.map(([id, label, Icon]) => <DropdownMenuItem key={id} onSelect={() => run(id)}><Icon />{label}</DropdownMenuItem>)}
    </PointerMenu>
  );
}
