// The Navigation pane's Headings tab: the outline tree of every heading (levels 1 to 9), the heading holding the caret marked, the
// headings whose part holds a search hit highlighted. A click moves the caret there; dragging a heading moves its whole section in
// one undo step; the right-click menu promotes, demotes, inserts, deletes, selects and prints sections.
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { closeHistory } from '@tiptap/pm/history';
import { TextSelection } from '@tiptap/pm/state';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { scrollToBlock } from '../../../app/commands/ui.mjs';
import { headingsOf, moveSection, sectionRange, treeOf } from './headings.mjs';
import { navState, setFolded } from './plugin.js';

const MAX_HEADING_NODE = 6; // heading nodes stop at Heading 6 (schema levels); Heading 7 to 9 are paragraph styles

/** The style setStyle takes for outline `level` (1 to 9), as Word applies Heading N; null when the document lacks Heading 7 to 9. */
const headingStyle = (doc, level) => (level <= MAX_HEADING_NODE || doc.attrs.styles?.list?.[`Heading${level}`]?.type === 'paragraph'
  ? `Heading${level}` : null);

/** A new empty heading of outline `level` (1 to 9): a heading node, a Heading 7 to 9 paragraph, or else a paragraph with that
 * outline level. */
function emptyHeading(doc, level) {
  const { nodes } = doc.type.schema;
  if (level <= MAX_HEADING_NODE) return nodes.heading.create({ level });
  const style = headingStyle(doc, level);
  return nodes.paragraph.create(style ? { styleId: style } : { outline: level - 1 });
}

/** Whether the paragraph at `node` takes its level from its own outline attribute (kept there on Promote and Demote). */
const ownOutline = (node) => node.type.name === 'paragraph' && node.attrs.outline != null;

/** The last heading at or before `pos` (the one whose part holds it). */
const headOf = (heads, pos) => heads.findLast((h) => h.pos <= pos);

export function Headings({ ed, matches, searching, run }) {
  const { view } = ed;
  const { doc, selection } = ed.state;
  const heads = headingsOf(doc);
  const folded = new Set(navState(ed.state).folded); // tree branches folded, by heading position (the plugin maps them as you type)
  const [depth, setDepth] = useState(9);
  const [menu, setMenu] = useState(null); // {h, x, y}
  const dragged = useRef(null);
  const current = headOf(heads, selection.from)?.pos;
  const hit = new Set(searching ? matches.map((m) => headOf(heads, m.from)?.pos) : []);

  const focus = () => view.focus();
  const jump = (h) => {
    ed.chain().setTextSelection(h.pos + 1).focus(null, { scrollIntoView: false }).run();
    scrollToBlock(ed, h.pos);
  };
  const dispatch = (tr, at) => {
    if (at != null) tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
    view.dispatch(closeHistory(tr).scrollIntoView());
    focus();
  };
  const move = (from, target) => {
    const tr = ed.state.tr;
    const at = moveSection(tr, from, target);
    if (at != null) dispatch(tr, at);
  };
  const relevel = (h, d) => {
    const level = h.level + d;
    const node = doc.nodeAt(h.pos);
    if (level < 1 || level > 9) return;
    const chain = ed.chain().setTextSelection(h.pos + 1);
    const style = !ownOutline(node) && headingStyle(doc, level);
    if (style) chain.setStyle(style).run();
    else if (node.type.name === 'paragraph') chain.setParaProps({ outline: level - 1 }).run();
    focus();
  };
  const insert = (at, level) => {
    const tr = ed.state.tr.insert(at, emptyHeading(doc, level));
    dispatch(tr, at);
  };
  const actions = {
    promote: (h) => relevel(h, -1),
    demote: (h) => relevel(h, 1),
    before: (h) => insert(h.pos, h.level),
    after: (h) => insert(sectionRange(doc, h.pos).to, h.level),
    sub: (h) => insert(sectionRange(doc, h.pos).to, Math.min(9, h.level + 1)),
    delete: (h) => {
      const r = sectionRange(doc, h.pos);
      dispatch(ed.state.tr.delete(r.from, r.to));
    },
    select: (h) => {
      const r = sectionRange(doc, h.pos);
      view.dispatch(ed.state.tr.setSelection(TextSelection.between(doc.resolve(r.from + 1), doc.resolve(Math.max(r.from + 1, r.to - 1)))));
      focus();
      return true;
    },
    print: (h) => actions.select(h) && run('file.print', { selection: true }),
    expandAll: () => setFolded(view, []),
    collapseAll: () => setFolded(view, heads.map((h) => h.pos)),
  };
  const canPromote = (h) => h.level > 1;
  const canDemote = (h) => h.level < 9 && (doc.nodeAt(h.pos).type.name === 'paragraph' || !!headingStyle(doc, h.level + 1));

  const row = (n) => {
    const kids = n.children.filter((c) => c.level <= depth);
    const open = !folded.has(n.pos);
    return (
      <li key={n.pos} role="treeitem" aria-expanded={kids.length ? open : undefined} aria-selected={n.pos === current}>
        <div data-nav-heading={n.pos} data-level={n.level} draggable
          onDragStart={(e) => {
            dragged.current = n.pos;
            e.dataTransfer.setData('text/x-nav-heading', String(n.pos));
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const from = Number(e.dataTransfer.getData('text/x-nav-heading') || dragged.current);
            if (Number.isFinite(from)) move(from, n.pos);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ h: n, x: e.clientX, y: e.clientY });
          }}
          className={cn('flex w-full cursor-default items-center rounded-sm pr-2 hover:bg-accent', n.pos === current && 'bg-accent font-medium',
            hit.has(n.pos) && 'nav-hit')}
          style={{ paddingLeft: 2 + (n.level - 1) * 12 }}>
          <button type="button" tabIndex={-1} aria-label={open ? 'Collapse' : 'Expand'} disabled={!kids.length}
            onClick={() => setFolded(view, open ? [...folded, n.pos] : [...folded].filter((p) => p !== n.pos))}
            className={cn('grid size-4 shrink-0 place-items-center text-muted-foreground [&_svg]:size-3', !kids.length && 'invisible')}>
            {open ? <ChevronDown /> : <ChevronRight />}
          </button>
          <button type="button" className="min-w-0 flex-1 truncate py-1 text-left" onClick={() => jump(n)}>{n.text || 'Empty heading'}</button>
        </div>
        {kids.length > 0 && open && <ul role="group">{kids.map(row)}</ul>}
      </li>
    );
  };

  const tree = treeOf(heads.filter((h) => h.level <= depth));
  const item = (label, fn, enabled = true) => (
    <DropdownMenuItem disabled={!enabled} onSelect={() => fn(menu.h)}>{label}</DropdownMenuItem>
  );
  return (
    <div data-nav-headings="" className="min-h-0 flex-1 px-1 pb-14" onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { // below the last heading: to the end of the document
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/x-nav-heading') || dragged.current);
        if (Number.isFinite(from)) move(from, doc.content.size);
      }}>
      {tree.length ? <ul role="tree" aria-label="Headings">{tree.map(row)}</ul>
        : <p className="px-2 py-1 text-muted-foreground">Headings in the document show here.</p>}
      {menu && (
        <DropdownMenu open onOpenChange={(o) => !o && setMenu(null)}>
          {createPortal(
            <DropdownMenuTrigger asChild><span aria-hidden className="pointer-events-none fixed size-0" style={{ left: menu.x, top: menu.y }} /></DropdownMenuTrigger>,
            document.body,
          )}
          <DropdownMenuContent data-nav-headings-menu="" align="start" sideOffset={2} className="min-w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
            {item('Promote', actions.promote, canPromote(menu.h))}
            {item('Demote', actions.demote, canDemote(menu.h))}
            <DropdownMenuSeparator />
            {item('New Heading Before', actions.before)}
            {item('New Heading After', actions.after)}
            {item('New Subheading', actions.sub, menu.h.level < 9)}
            {item('Delete', actions.delete)}
            <DropdownMenuSeparator />
            {item('Select Heading and Content', actions.select)}
            {item('Print Heading and Content', actions.print)}
            <DropdownMenuSeparator />
            {item('Expand All', actions.expandAll)}
            {item('Collapse All', actions.collapseAll)}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Show Heading Levels</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-44">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => (
                  <DropdownMenuItem key={l} onSelect={() => setDepth(l)}>{`Show Heading ${l}`}</DropdownMenuItem>
                ))}
                <DropdownMenuItem onSelect={() => setDepth(9)}>Show All Headings</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
