import { useEffect, useRef, useState } from 'react';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import {
  BetweenHorizontalEnd, BetweenVerticalEnd, Bold, BookPlus, ClipboardPaste, ClipboardType, Copy, ExternalLink, Grid2x2X, Italic, Link, Link2Off,
  Plus, RemoveFormatting, Scissors, Strikethrough, Table, TableColumnsSplit, TableRowsSplit, TextSelect, Underline,
} from 'lucide-react';
import {
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { dismissOnly } from '../../whiteboard.js';
import { openLinkDialog, refocusEditor, run } from '../actions.js';
import { openPane } from '../browser.js';
import { keyLabel } from '../keybinds.js';
import { getState, useEditor } from '../store.js';
import { BLOCK_SECTIONS } from '../tool-rank.mjs';
import { entryKey, listTools, toolContext } from '../tools.js';
import { PointerMenu } from './board/BoardMenu.jsx';
import { textTools } from './Toolbar.jsx';

/** A right-click outside the selection moves it to the pointer first, as in a word processor: a block preview (canvas, plan
 * chart) is selected whole, text gets the caret. Inside the selection, or on a misspelling (Chromium selected it), it stays. */
function selectAt(ed, { at, target }) {
  const { state, view } = ed;
  if (!view.dom.contains(target)) return; // the pan surface around the page
  let sel = null;
  for (let el = target; el && el !== view.dom && !sel; el = el.parentElement) {
    const pos = (el.scView ?? el.pcView)?.getPos();
    if (typeof pos === 'number') sel = NodeSelection.create(state.doc, pos);
  }
  if (!sel) {
    const pos = view.posAtCoords({ left: at.x, top: at.y })?.pos;
    if (pos == null || (pos >= state.selection.from && pos <= state.selection.to)) return;
    sel = TextSelection.near(state.doc.resolve(pos));
  }
  if (sel.eq(state.selection)) return;
  view.focus(); // so a selected block shows as selected under the menu
  view.dispatch(state.tr.setSelection(sel));
}

/** The draft menu: a right-click in the editor area opens it at the pointer in place of Electron's native menu, with the
 * entries for what is under it: a block's actions, a link's, a text selection's formatting, or at a caret Insert. A board keeps
 * its own menu (§6c Board menu) and the text being edited on it the native one. Main sends every right-click's spelling, link
 * and edit state (window.api.editMenu); a right-click anywhere else gets the native menu back. A right-click while a popup is
 * open only closes it (§6c Dismiss-only clicks). A picked entry runs once the menu has closed and the editor has the focus back,
 * so a paste lands in the document. Mounted once (App.jsx). */
export function DraftMenu() {
  const [menu, setMenu] = useState(null); // {at, misspelledWord, suggestions, linkURL, editFlags, n} while open
  const picked = useRef(null);
  const ed = useEditor();
  useEffect(() => {
    const api = window.api.editMenu;
    let last = null; // the last right-click: {at, target, draft}
    let dismissed = false;
    let n = 0;
    const onDown = (e) => {
      if (e.button === 2) dismissed = dismissOnly(e);
    };
    const onMenu = (e) => {
      last = null;
      if (dismissed) e.preventDefault(); // no menu at all
      dismissed = false;
      const t = e.target instanceof Element ? e.target : null;
      if (!e.defaultPrevented) last = { at: { x: e.clientX, y: e.clientY }, target: t, draft: !!t?.closest('#editor-area') && !t.closest('.wb') };
    };
    window.addEventListener('pointerdown', onDown, true);
    document.addEventListener('contextmenu', onMenu);
    const off = api.onOpen((p) => {
      const editor = getState().editor;
      if (last?.draft && editor) {
        if (!p.misspelledWord) selectAt(editor, last);
        setMenu({ ...p, at: { x: last.at.x + 12, y: last.at.y }, n: ++n }); // 12 px right of the pointer: clear of the caret
      } else api.act('native');
      last = null;
    });
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('contextmenu', onMenu);
      off();
    };
  }, []);
  if (!menu || !ed) return null;
  const T = textTools(ed);
  const c = toolContext(null);
  const act = (name) => () => window.api.editMenu.act(name);
  // A right-click on a misspelling selects it (Chromium), so a suggestion replaces the selection, keeping its marks. Chromium's
  // own replaceMisspelling finds no misspelling once the focus has been in the menu.
  const replace = (w) => () => run((x) => x.command(({ tr }) => {
    const { from, to } = tr.selection;
    if (tr.doc.textBetween(from, to) !== menu.misspelledWord) return false;
    tr.insertText(w, from, to);
    return true;
  }));
  const item = (label, icon, shortcut, fn, enabled = true, variant) => (
    <DropdownMenuItem key={label} variant={variant} disabled={!enabled} onSelect={() => (picked.current = fn)}>{icon}{label}<DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut></DropdownMenuItem>
  );
  const tool = (key, label, icon = T[key].children) => item(label, icon, keyLabel(T[key].keyId), T[key].onClick, !T[key].disabled);
  const runPicked = (e) => {
    refocusEditor(e);
    const fn = picked.current;
    picked.current = null;
    fn?.();
  };
  // The node-selected block's actions, as the tool search lists them (tool-rank.mjs), Delete apart at the end, in red.
  const tools = c.block?.kind && listTools(c);
  const block = tools && BLOCK_SECTIONS[c.block.kind][1].map((id) => tools.find((t) => t.id === id && t.run)).filter(Boolean)
    .map((t) => ({ ...t, el: item(t.label, t.icon, entryKey(t), () => t.run(toolContext(null)), true,
      t.risk === 'destructive' ? 'destructive' : undefined) }));
  const link = menu.linkURL && ed.isActive('link') ? menu.linkURL : null;
  const selected = !ed.state.selection.empty;
  const { canCut, canCopy, canPaste } = menu.editFlags;
  const paste = [item('Paste', <ClipboardPaste />, 'Ctrl+V', act('paste'), canPaste),
    item('Paste as plain text', <ClipboardType />, 'Ctrl+Shift+V', act('pasteAndMatchStyle'), canPaste)];
  const table = ed.isActive('table') && (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger><Table />Table</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-48">
        {tool('addRow', 'Add row after', <BetweenHorizontalEnd />)}
        {tool('addColumn', 'Add column after', <BetweenVerticalEnd />)}
        {tool('deleteRow', 'Delete row', <TableRowsSplit />)}
        {tool('deleteColumn', 'Delete column', <TableColumnsSplit />)}
        {tool('deleteTable', 'Delete table', <Grid2x2X />)}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
  let body;
  if (block) {
    body = (
      <>
        {block.filter((t) => t.risk !== 'destructive').map((t) => t.el)}
        <DropdownMenuSeparator />
        {item('Cut', <Scissors />, 'Ctrl+X', act('cut'))}
        {item('Copy', <Copy />, 'Ctrl+C', act('copy'))}
        <DropdownMenuSeparator />
        {block.filter((t) => t.risk === 'destructive').map((t) => t.el)}
      </>
    );
  } else if (selected) {
    body = (
      <>
        {item('Cut', <Scissors />, 'Ctrl+X', act('cut'), canCut)}
        {item('Copy', <Copy />, 'Ctrl+C', act('copy'), canCopy)}
        {paste}
        <DropdownMenuSeparator />
        {tool('bold', 'Bold', <Bold />)}
        {tool('italic', 'Italic', <Italic />)}
        {tool('underline', 'Underline', <Underline />)}
        {tool('strike', 'Strikethrough', <Strikethrough />)}
        {!link && tool('link', 'Link...', <Link />)}
        {tool('clear', 'Clear formatting', <RemoveFormatting />)}
        {table && <><DropdownMenuSeparator />{table}</>}
      </>
    );
  } else {
    body = (
      <>
        {paste}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger><Plus />Insert</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-48">
            {!link && tool('link', 'Link...', <Link />)}
            {tool('canvas', 'Canvas')}
            {tool('flowchart', 'Flowchart')}
            {tool('planChart', 'Plan chart')}
            {tool('image', 'Images or videos')}
            {tool('table', 'Table')}
            {tool('box', 'Titled box')}
            {tool('rule', 'Horizontal rule')}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {table}
        <DropdownMenuSeparator />
        {item('Select all', <TextSelect />, 'Ctrl+A', () => run((x) => x.selectAll()))}
      </>
    );
  }
  return (
    <PointerMenu key={menu.n} at={menu.at} onClose={() => setMenu(null)} onCloseAutoFocus={runPicked}>
      {menu.misspelledWord && (
        <>
          {menu.suggestions.map((w) => <DropdownMenuItem key={w} inset className="font-medium" onSelect={() => (picked.current = replace(w))}>{w}</DropdownMenuItem>)}
          {item('Add to dictionary', <BookPlus />, '', act('learn'))}
          <DropdownMenuSeparator />
        </>
      )}
      {link && (
        <>
          {/^https?:/i.test(link) && item('Open link', <ExternalLink />, '', () => openPane(null, link))}
          {item('Copy link address', <Copy />, '', act('copyLink'))}
          {item('Edit link...', <Link />, keyLabel('text.link'), openLinkDialog)}
          {item('Remove link', <Link2Off />, '', () => run((x) => x.extendMarkRange('link').unsetLink()))}
          <DropdownMenuSeparator />
        </>
      )}
      {body}
    </PointerMenu>
  );
}
