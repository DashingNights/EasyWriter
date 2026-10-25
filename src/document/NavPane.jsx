import { cn } from 'cn';
import { X } from 'lucide-react';
import { scrollToBlock } from '../app/commands/ui.mjs';
import { IconButton } from '../app/components/Tip.jsx';
import { keepFocus } from '../app/components/Toolbar.jsx';
import { useEditor } from '../app/store.js';
import { toggleNavPane } from './tools.js';

// View > Navigation pane (docs/plans/document.md Ribbon View): the Document's headings beside the editor area (App.jsx), indented
// by level. A click puts the caret at the start of that heading and scrolls it into the middle of the view; the heading the caret
// is under is highlighted, as Word's pane follows the reading place.

export function NavPane() {
  const ed = useEditor();
  if (!ed) return null;
  const heads = [];
  ed.state.doc.forEach((n, pos) => { if (n.type.name === 'heading') heads.push({ pos, level: n.attrs.level, text: n.textContent }); });
  const at = ed.state.selection.from;
  const current = heads.findLast((h) => h.pos < at)?.pos;
  const jump = (pos) => {
    ed.chain().setTextSelection(pos + 1).focus(null, { scrollIntoView: false }).run();
    scrollToBlock(ed, pos); // by hand: the page's CSS zoom misleads scrollIntoView
  };
  return (
    <nav aria-label="Navigation pane" data-nav-pane="" className="flex w-56 shrink-0 flex-col border-r bg-card text-sm text-card-foreground">
      <div className="flex items-center justify-between py-1 pr-1 pl-3">
        <span className="font-medium">Navigation</span>
        <IconButton label="Close navigation pane" onMouseDown={keepFocus} onClick={toggleNavPane}><X /></IconButton>
      </div>
      {/* bottom room for the sidebar button, which floats over this corner */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-14">
        {heads.length ? heads.map((h) => (
          <button key={h.pos} type="button" aria-current={h.pos === current || undefined} onMouseDown={keepFocus} onClick={() => jump(h.pos)}
            style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
            className={cn('block w-full truncate rounded-sm py-1 pr-2 text-left hover:bg-accent', h.pos === current && 'bg-accent font-medium')}>
            {h.text || 'Empty heading'}
          </button>
        )) : <p className="px-2 py-1 text-muted-foreground">No headings yet</p>}
      </div>
    </nav>
  );
}
