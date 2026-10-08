import { Extension } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { ArrowRight, Frame, ImagePlus, Minus, PanelTop, Presentation, Square, SquareKanban, Table, Type, Workflow } from 'lucide-react';
import { cn } from 'cn';
import { useLayoutEffect, useRef } from 'react';
import { getState, setState, useStore } from '../store.js';
import { flowchartMode } from '../tool-rank.mjs';

// The fading notices (SPEC §7c Notices): the tool search's, Canvas Mode's and the paste-replaced one, in a stack above the
// toolbar island.

let lastId = 0;

/** Shows a notice {icon, text, mode?} in front; the one that was in front goes behind it and any older one is dropped. One
 * with the same text is replaced (the front one shown again from the start). */
export function notify(notice) {
  const rest = getState().notices.filter((n) => n.text !== notice.text);
  setState({ notices: [...rest, { ...notice, id: ++lastId }].slice(-2) });
}

/** The stack, in the bottom column over the toolbar island (Dictation.jsx, centred in the page's viewport): 8 px above the
 * island, or resting 8 px above the transcript pane while it shows, following its top in every frame. The newest
 * is in front; the previous one sits behind it 3 px lower, scaled down from its bottom centre to the front one's width when
 * wider (180 ms move, instant with reduced motion). Each shows at once, stays 2 s, fades out over the third second on its
 * own timeline (behind too) and is removed; translucent, it never takes the focus or a click (clicks go through). A mode
 * notice (`mode`) is larger. */
export function Notices() {
  const notices = useStore((s) => s.notices);
  const stack = useRef(null);
  useLayoutEffect(() => {
    const [behind, front] = stack.current.children;
    if (front) behind.style.setProperty('--s', Math.min(1, front.offsetWidth / behind.offsetWidth));
  }, [notices]);
  return (
    <div ref={stack} data-notices role="status"
      className="pointer-events-none relative z-40 grid w-max items-end justify-items-center select-none">
      {notices.map((n, i) => (
        // Behind: its text and icons hidden (only its edge peeks out; the front card is translucent).
        <div key={n.id} style={i < notices.length - 1 ? { transform: 'translateY(3px) scale(var(--s, 1))' } : undefined}
          className={cn('relative col-start-1 row-start-1 origin-bottom transition-transform duration-180 ease-out motion-reduce:transition-none',
            i < notices.length - 1 && 'text-transparent [&_svg]:text-transparent')}>
          <div data-notice onAnimationEnd={() => setState({ notices: getState().notices.filter((x) => x !== n) })}
            className={cn('flex items-center border backdrop-blur-[2px] transition-none animate-out fade-out fill-mode-forwards delay-2000 duration-1000 ease-in',
              n.mode
                ? 'gap-2 rounded-full bg-card/40 px-4 py-1.5 text-base font-medium shadow-lg [&_svg]:size-5'
                : 'gap-1.5 rounded-full bg-card/70 px-3 py-1 text-sm shadow-lg [&_svg]:size-4')}>
            {n.icon}
            {n.text}
          </div>
        </div>
      ))}
    </div>
  );
}

// Paste notices (SPEC §7c Notices): a paste over a non-empty text selection shows "Paste replaced text" (T → T; Ctrl+Z
// brings it back). A paste that would replace a node-selected block is refused with a mode notice saying how to paste
// (a node-selected whiteboard takes the paste itself, WhiteboardPaste).
const BLOCK_ICONS = { whiteboard: Presentation, planChart: SquareKanban, table: Table, box: PanelTop, horizontalRule: Minus };
const HOW = { canvas: 'Enter Canvas Mode to paste', planChart: 'Open the plan to paste' };

/** The toolbar icon of block `node`. */
function blockIcon({ type, attrs }) {
  if (type.name !== 'canvas') return BLOCK_ICONS[type.name] ?? Square;
  if (flowchartMode(null, attrs)) return Workflow;
  return attrs.items.length === 1 && attrs.items[0].type === 'image' ? ImagePlus : Frame;
}

/** The document's paste notices: one per paste, from the selection before it. */
export const PasteNotice = Extension.create({
  name: 'pasteNotice',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('pasteNotice'),
      filterTransaction(tr, state) {
        const sel = state.selection;
        if (tr.getMeta('uiEvent') !== 'paste' || !(sel instanceof NodeSelection)) return true;
        const Icon = blockIcon(sel.node);
        notify({ icon: <Icon />, text: HOW[sel.node.type.name] ?? 'Place the caret to paste', mode: true });
        return false;
      },
      appendTransaction(trs, old) {
        if (old.selection.empty || !trs.some((tr) => tr.getMeta('uiEvent') === 'paste')) return null;
        notify({ icon: <><Type /><ArrowRight className="text-muted-foreground" /><Type /></>, text: 'Paste replaced text' });
        return null;
      },
    })];
  },
});
