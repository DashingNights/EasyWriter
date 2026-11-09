import { useEffect, useRef, useState } from 'react';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import {
  BetweenHorizontalEnd, BetweenVerticalEnd, Bold, BookPlus, Captions, ClipboardPaste, ClipboardType, Copy, ExternalLink, Grid2x2X, Italic, Link, Link2Off,
  Plus, RemoveFormatting, Scissors, Strikethrough, Table, TableColumnsSplit, TableRowsSplit, TextSelect, Underline,
} from 'lucide-react';
import {
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { dismissOnly } from '../../whiteboard.js';
import { openLinkDialog, refocusEditor, run } from '../actions.js';
import { openPane } from '../browser.js';
import { fixedKey, keyLabel } from '../keybinds.js';
import { getState, useEditor } from '../store.js';
import { BLOCK_SECTIONS } from '../tool-rank.mjs';
import { entryKey, listTools, toolContext } from '../tools.js';
import { PointerMenu } from './board/BoardMenu.jsx';
import { documentTools, editAltText, insertTable } from '../../document/tools.js';
import { headerAreaAt, hitOf, wordAt } from '../../document/wp/context-menu/hit.js';
import { mini, MiniToolbar } from '../../document/wp/context-menu/MiniToolbar.jsx';
import { entriesFor, WordMenu } from '../../document/wp/context-menu/WordMenu.jsx';
import { ctxOf } from '../../tooling/registry.js';
import { activeSurface } from '../../tooling/surface.js';
import { textTools, useBox } from './Toolbar.jsx';

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

/** Whether the DOM selection covers the client point `at` (Chromium selects a misspelled word on a right-click before the
 * editor sees it). */
function domSelectionAt(at) {
  const s = getSelection();
  if (!s?.rangeCount || s.isCollapsed) return false;
  return [...s.getRangeAt(0).getClientRects()].some((r) => at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom);
}

/** The misspelling at the caret of `ed` for a menu opened from the keyboard (no right-click, so main sends no spelling): {word,
 * suggestions} or null. */
function caretSpelling(ed) {
  const w = wordAt(ed.state);
  const spell = globalThis.__wordTest?.spell ?? window.api.word?.spell; // plan.md §1.16: the harness stubs the checker
  try {
    return w && spell?.misspelled(w.text) ? { word: w.text, suggestions: spell.suggest(w.text) ?? [] } : null;
  } catch {
    return null;
  }
}

// The atoms a right-click selects, so ctxOf flags them and Word's menu for them opens.
const SELECTED_ON_CLICK = new Set(['image', 'field', 'equation']);

/** A right-click on a picture, field or equation selects it, as Word does (selectAt would put the caret beside it). → true when
 * it did. */
function selectAtom(ed, at) {
  const { view, state } = ed;
  const hit = view.posAtCoords({ left: at.x, top: at.y });
  if (!hit || hit.inside < 0 || !SELECTED_ON_CLICK.has(state.doc.nodeAt(hit.inside)?.type.name)) return false;
  if (state.selection.from !== hit.inside || !SELECTED_ON_CLICK.has(state.selection.node?.type.name)) {
    view.focus();
    view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, hit.inside)));
  }
  return true;
}

const inDocument = () => activeSurface()?.format === 'document';
const isMenuKey = (e) => e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey);

/** The draft menu: a right-click in the editor area opens it at the pointer in place of Electron's native menu, with the
 * entries for what is under it: a block's actions, a link's, a text selection's formatting, or at a caret Insert. A board keeps
 * its own menu (§6c Board menu) and the text being edited on it the native one. Main sends every right-click's spelling, link
 * and edit state (window.api.editMenu); a right-click anywhere else gets the native menu back. A right-click while a popup is
 * open only closes it (§6c Dismiss-only clicks). A picked entry runs once the menu has closed and the editor has the focus back,
 * so a paste lands in the document. In a Document, Word's menu (WordMenu.jsx) opens on the right-click itself, so a synthetic one
 * opens it too, and the spelling main sends after it joins it; Shift+F10 and the Menu key open it at the caret; a node-selected
 * canvas or plan chart keeps the block menu. It also hosts the mini toolbar. Mounted once (App.jsx). */
export function DraftMenu() {
  const [menu, setMenu] = useState(null); // {at, misspelledWord, suggestions, linkURL, editFlags, n} while open
  const [word, setWord] = useState(null); // Word's menu in a Document: {at, hit, n} while open
  const picked = useRef(null);
  const ed = useEditor();
  const box = useBox();
  useEffect(() => {
    const api = window.api.editMenu;
    let last = null; // the last right-click: {at, target, draft}
    let dismissed = false;
    let n = 0;
    let armed = false; // a left press in Document text, so its release may end a mouse selection
    const onDown = (e) => {
      if (e.button === 2) dismissed = dismissOnly(e);
      armed = e.button === 0 && inDocument() && !!e.target?.closest?.('[data-doc-text]');
    };
    // A text selection made with the mouse shows the mini toolbar, faded, once the editor has taken the selection, when Options
    // turns that on (off by default); a clicked picture or shape never does.
    const onUp = (e) => {
      if (!armed) return;
      armed = false;
      const at = { x: e.clientX, y: e.clientY };
      setTimeout(() => {
        const t = ctxOf().target;
        if (t && !t.state.selection.empty && !t.state.selection.node && !getState().quickTools) mini.show(at);
      });
    };
    /** Opens Word's menu at `at` for what is there now: the header band of a page, else the target's selection. */
    const openWord = (at, opts = {}) => {
      const hit = hitOf(ctxOf(), opts);
      const { id, entries } = entriesFor(hit);
      window.__word = Object.assign(window.__word ?? {}, { contextMenuLast: { id, hit, count: entries.length } }); // for harness cases
      if (!entries.length) return; // nothing registered for this place yet (Edit Header before headers-footers)
      setMenu(null);
      setWord({ at, hit, n: ++n });
    };
    const onMenu = (e) => {
      last = null;
      if (dismissed) e.preventDefault(); // no menu at all
      dismissed = false;
      const t = e.target instanceof Element ? e.target : null;
      if (!e.defaultPrevented) last = { at: { x: e.clientX, y: e.clientY }, target: t, draft: !!t?.closest('#editor-area, [data-canvas-pages]') && !t.closest('.wb') };
      if (!last?.draft || !inDocument()) return;
      // A canvas draft has no DOM editor to read: Word's menu comes from the engine's document.context (hit.js canvasHit).
      const canvas = !!activeSurface()?.session;
      const main = canvas ? null : getState().editor;
      const ed = canvas ? null : t.closest('.ProseMirror')?.editor ?? null; // the main editor or a story editor
      const headerArea = !canvas && (!ed || ed === main) ? headerAreaAt(main, last.at) : null;
      if (!headerArea && ed && !selectAtom(ed, last.at) && !domSelectionAt(last.at)) selectAt(ed, last);
      const sel = main?.state.selection;
      if (!headerArea && ed && ed === main && ['canvas', 'planChart'].includes(sel?.node?.type.name)) return; // a canvas or plan chart: the block menu (onOpen)
      last.word = true;
      openWord({ x: last.at.x + 12, y: last.at.y }, { headerArea }); // 12 px right of the pointer: clear of the caret
    };
    const onKey = (e) => {
      if (!isMenuKey(e)) return;
      const root = e.target?.closest?.('[data-doc-text]');
      if (!root || !inDocument()) return;
      // Chromium opens its own menu on the key's release on Windows, so both halves are taken.
      e.preventDefault();
      e.stopPropagation();
      if (e.type !== 'keydown' || e.repeat) return;
      const ed = root.editor ?? ctxOf().target;
      const c = ed.view.coordsAtPos(ed.state.selection.head);
      openWord({ x: c.left, y: c.bottom }, { spelling: caretSpelling(ed) });
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    document.addEventListener('contextmenu', onMenu);
    const off = api.onOpen((p) => {
      const editor = getState().editor;
      if (last?.word) {
        // Main's spelling for the right-click that opened Word's menu.
        if (p.misspelledWord) {
          const spelling = { word: p.misspelledWord, suggestions: p.suggestions ?? [] };
          setWord((m) => m && { ...m, hit: { ...m.hit, spelling } });
        }
      } else if (last?.draft && editor) {
        if (!p.misspelledWord) selectAt(editor, last);
        setMenu({ ...p, at: { x: last.at.x + 12, y: last.at.y }, n: ++n }); // 12 px right of the pointer: clear of the caret
      } else api.act('native');
      last = null;
    });
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      document.removeEventListener('contextmenu', onMenu);
      off();
    };
  }, []);
  const doc = (
    <>
      {word && <WordMenu key={word.n} menu={word} onClose={() => setWord(null)} />}
      <MiniToolbar />
    </>
  );
  if (!menu || !ed) return doc;
  const isDocument = getState().draft?.format === 'document';
  const T = isDocument ? documentTools(ed) : textTools(ed); // the open format's own commands (docs/plans/document.md Risks)
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
  const paste = [item('Paste', <ClipboardPaste />, fixedKey('Ctrl+V'), act('paste'), canPaste),
    item('Paste as plain text', <ClipboardType />, fixedKey('Ctrl+Shift+V'), act('pasteAndMatchStyle'), canPaste)];
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
        {item('Cut', <Scissors />, fixedKey('Ctrl+X'), act('cut'))}
        {item('Copy', <Copy />, fixedKey('Ctrl+C'), act('copy'))}
        <DropdownMenuSeparator />
        {block.filter((t) => t.risk === 'destructive').map((t) => t.el)}
      </>
    );
  } else if (selected) {
    body = (
      <>
        {T.picture?.alt != null && <>{item('Alt text...', <Captions />, '', editAltText)}<DropdownMenuSeparator /></>}
        {item('Cut', <Scissors />, fixedKey('Ctrl+X'), act('cut'), canCut)}
        {item('Copy', <Copy />, fixedKey('Ctrl+C'), act('copy'), canCopy)}
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
          {isDocument ? (
            // A Document's Insert tab (docs/plans/document.md editorAndUi); its table is a 3 x 3 Table Grid.
            <DropdownMenuSubContent className="min-w-48">
              {tool('pageBreak', 'Page break')}
              {item('Table', <Table />, '', () => insertTable(3, 3))}
              {tool('image', 'Pictures')}
              {!link && tool('link', 'Link...', <Link />)}
              {tool('canvas', 'Smart canvas')}
              {tool('flowchart', 'Flowchart')}
              {tool('planChart', 'Plan chart')}
            </DropdownMenuSubContent>
          ) : (
            <DropdownMenuSubContent className="min-w-48">
              {!link && tool('link', 'Link...', <Link />)}
              {tool('canvas', 'Canvas')}
              {tool('flowchart', 'Flowchart')}
              {tool('planChart', 'Plan chart')}
              {tool('image', 'Images or videos')}
              {tool('table', 'Table')}
              {box && tool('box', 'Titled box')}
              {tool('rule', 'Horizontal rule')}
            </DropdownMenuSubContent>
          )}
        </DropdownMenuSub>
        {table}
        <DropdownMenuSeparator />
        {item('Select all', <TextSelect />, fixedKey('Ctrl+A'), () => run((x) => x.selectAll()))}
      </>
    );
  }
  return (
    <>
      {doc}
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
    </>
  );
}
