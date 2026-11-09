// The Selection pane (pane selection; docs/plans/word probe/dialogs/selection-pane.json): the objects on the page holding the
// selection, front-most first. Click selects, double-click or F2 renames, dragging reorders the layers, the eye hides. While a
// canvas is edited in place its items list under it with their own eyes. It lists one page and redraws on the target's
// transactions, so a long document stays cheap.
import { useState } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-react';
import { NodeSelection } from '@tiptap/pm/state';
import { canvasEditor } from '../../../canvas.js';
import { htmlToText } from '../../../flow/graph.mjs';
import { kindOf } from '../../../flow/shapes.mjs';
import { run } from '../../../tooling/registry.js';
import { lineOf, shapeName } from '../../../tooling/shape-picker.mjs';
import { geometryOf } from '../../geometry.js';
import { objectsAt, patch, selectAt } from './index.js';
import { dropOrder, objectNames } from './order.mjs';

/** The rows of `state`'s page holding the selection → [{pos, node, name, float, z}], front-most first; inline objects last. */
export function paneRows(state) {
  const all = objectsAt(state);
  const names = objectNames(all.map((o) => o.node));
  const geo = geometryOf(state);
  const page = geo?.pageOf(state.selection.from);
  const rows = all.map((o, i) => ({ ...o, name: names[i], i })).filter((o) => !geo || geo.pageOf(o.pos) === page);
  // Front-most first: floats by z (a later one wins a tie), then the inline objects, which sit in the text.
  return rows.sort((a, b) => (b.float - a.float) || (a.float ? b.z - a.z : 0) || b.i - a.i);
}

/** The name the attribute holds for object `node` (image and textBox name, canvas and plan chart docPr.name) → attrs patch. */
const renamed = (node, name) => (['image', 'textBox'].includes(node.type.name) ? { name } : { docPr: { ...node.attrs.docPr, name } });

const itemName = (i) => htmlToText(i.html ?? '') || (i.type === 'shape' && kindOf(i.shape) && shapeName(i.shape))
  || (i.type === 'connector' && lineOf(i)) || i.type[0].toUpperCase() + i.type.slice(1);

const Btn = ({ label, onClick, disabled, children }) => (
  <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
    className="flex h-7 items-center justify-center rounded-md border px-2 text-xs hover:bg-accent disabled:opacity-50">{children ?? label}</button>
);

/** The pane on a canvas draft: the engine's list (arrange.selectionPane), front-most first; a click selects, the eye hides
 * (object.hidden), the arrows step the order. */
// ponytail: lists the whole document's objects and has no rename or drag reorder (the engine keeps no object names, and
// arrange.order steps one place). List one page, rename and drag when the engine has a name and an order-to command.
function CanvasSelectionPane({ ctx }) {
  const list = ctx.read('arrange.selectionPane', {}) ?? [];
  const at = JSON.stringify(ctx.read('object.get', {})?.pos ?? null);
  const rows = [...list].sort((a, b) => (b.floating - a.floating) || (a.floating ? b.z - a.z : 0) || b.index - a.index);
  const exec = (id, args) => ctx.engine.exec(id, args);
  const isFloat = rows.some((r) => r.floating && JSON.stringify(r.pos) === at);
  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-1">
        <Btn label="Show All" onClick={() => exec('object.hidden', { hidden: false })} />
        <Btn label="Hide All" onClick={() => exec('object.hidden', { hidden: true })} />
        <Btn label="Bring Forward" disabled={!isFloat} onClick={() => run('layout.arrange.bringForward.bringForward')}><ChevronUp className="size-4" /></Btn>
        <Btn label="Send Backward" disabled={!isFloat} onClick={() => run('layout.arrange.sendBackward.sendBackward')}><ChevronDown className="size-4" /></Btn>
      </div>
      <ul role="tree" aria-label="Objects in this document" className="flex flex-col">
        {!rows.length && <li className="px-2 py-1 text-xs text-muted-foreground">No objects in this document.</li>}
        {rows.map((r) => {
          const on = JSON.stringify(r.pos) === at;
          return (
            <li key={r.index} role="treeitem" aria-selected={on} data-object={r.name}>
              <div className={`flex items-center gap-1 rounded-md px-2 py-0.5 ${on ? 'bg-accent' : 'hover:bg-accent/50'}`}>
                <button type="button" className={`min-w-0 flex-1 truncate text-left text-xs ${r.hidden ? 'text-muted-foreground' : ''}`}
                  onClick={() => exec('select.objects', { index: r.index })}>{r.name}</button>
                {r.floating && (
                  <button type="button" data-eye="" aria-label={r.hidden ? `Show ${r.name}` : `Hide ${r.name}`} aria-pressed={!r.hidden}
                    onClick={() => exec('object.hidden', { hidden: !r.hidden, index: r.index })}
                    className="flex size-6 items-center justify-center rounded-sm hover:bg-accent [&_svg]:size-3.5">
                    {r.hidden ? <EyeOff /> : <Eye />}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SelectionPane({ ctx }) {
  if (ctx.engine) return <CanvasSelectionPane ctx={ctx} />;
  const editor = ctx.target;
  const [edit, setEdit] = useState(null); // {pos, text} while a row is renamed
  const [drag, setDrag] = useState(null); // the pos of the row being dragged
  if (!editor?.view) return null;
  const { state, view } = editor;
  const rows = paneRows(state);
  const floats = rows.filter((r) => r.float);
  const sel = state.selection instanceof NodeSelection ? state.selection.from : null;
  const session = canvasEditor.get();
  const board = session?.editor === editor && ctx.obj?.kind === 'canvas' ? session.board : null;

  const write = (patches) => patch(view, patches);
  const hide = (r, hidden) => [r.pos, { layout: { ...r.node.attrs.layout, hidden } }];
  const commit = () => {
    if (edit?.text.trim()) write([[edit.pos, renamed(state.doc.nodeAt(edit.pos), edit.text.trim())]]);
    setEdit(null);
  };
  // Dropping the dragged row on row `to` puts it in that place; the floats then take z values from the bottom up.
  const drop = (to) => {
    const order = dropOrder(floats.map((r) => r.pos), drag, to);
    setDrag(null);
    if (!order) return;
    write(order.map((p, k) => {
      const r = floats.find((f) => f.pos === p);
      const z = order.length - k;
      return r.z === z ? null : [p, { layout: { ...r.node.attrs.layout, z } }];
    }).filter(Boolean));
  };
  const isFloat = floats.some((r) => r.pos === sel);

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-1">
        <Btn label="Show All" onClick={() => write(floats.filter((r) => r.node.attrs.layout.hidden).map((r) => hide(r, false)))} />
        <Btn label="Hide All" onClick={() => write(floats.filter((r) => !r.node.attrs.layout.hidden).map((r) => hide(r, true)))} />
        <Btn label="Bring Forward" disabled={!isFloat} onClick={() => run('layout.arrange.bringForward.bringForward')}><ChevronUp className="size-4" /></Btn>
        <Btn label="Send Backward" disabled={!isFloat} onClick={() => run('layout.arrange.sendBackward.sendBackward')}><ChevronDown className="size-4" /></Btn>
      </div>
      <ul role="tree" aria-label="Objects on this page" className="flex flex-col">
        {!rows.length && <li className="px-2 py-1 text-xs text-muted-foreground">No objects on this page.</li>}
        {rows.map((r) => (
          <li key={r.pos} role="treeitem" aria-selected={r.pos === sel} data-object={r.name} draggable={r.float && !edit}
            onDragStart={() => setDrag(r.pos)} onDragEnd={() => setDrag(null)} onDragOver={(e) => r.float && drag != null && e.preventDefault()} onDrop={() => drop(r.pos)}>
            <div className={`flex items-center gap-1 rounded-md px-2 py-0.5 ${r.pos === sel ? 'bg-accent' : 'hover:bg-accent/50'}`}>
              {edit?.pos === r.pos ? (
                <input autoFocus value={edit.text} aria-label="Name" className="h-6 min-w-0 flex-1 rounded-sm border bg-transparent px-1 text-xs"
                  onChange={(e) => setEdit({ ...edit, text: e.target.value })} onBlur={commit}
                  onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setEdit(null); }} />
              ) : (
                <button type="button" className={`min-w-0 flex-1 truncate text-left text-xs ${r.node.attrs.layout?.hidden ? 'text-muted-foreground' : ''}`}
                  onClick={() => selectAt(view, r.pos, false)} onDoubleClick={() => setEdit({ pos: r.pos, text: r.name })}
                  onKeyDown={(e) => { if (e.key === 'F2') { e.preventDefault(); setEdit({ pos: r.pos, text: r.name }); } }}>{r.name}</button>
              )}
              {r.float && (
                <button type="button" data-eye="" aria-label={r.node.attrs.layout.hidden ? `Show ${r.name}` : `Hide ${r.name}`}
                  aria-pressed={!r.node.attrs.layout.hidden} onClick={() => write([hide(r, !r.node.attrs.layout.hidden)])}
                  className="flex size-6 items-center justify-center rounded-sm hover:bg-accent [&_svg]:size-3.5">
                  {r.node.attrs.layout.hidden ? <EyeOff /> : <Eye />}
                </button>
              )}
            </div>
            {board && ctx.obj.pos === r.pos && (
              <ul role="group" className="flex flex-col pl-4">
                {[...board.items].reverse().map((i) => (
                  <li key={i.id} role="treeitem" aria-selected={board.sel.has(i.id)} className="flex items-center gap-1 px-2 py-0.5 text-xs">
                    <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => board.select(i.hidden ? [] : [i.id])}>{itemName(i)}</button>
                    <button type="button" aria-label={i.hidden ? 'Show' : 'Hide'} onClick={() => board.setLayer('hidden', false, [i.id])}
                      className="flex size-6 items-center justify-center rounded-sm hover:bg-accent [&_svg]:size-3.5">{i.hidden ? <EyeOff /> : <Eye />}</button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
