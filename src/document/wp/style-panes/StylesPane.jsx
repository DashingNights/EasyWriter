// The Styles pane (pane id 'styles', docs/plans/word briefs/style-panes.md; probe/dialogs.md styles-pane): Clear All, then the
// styles of the chosen filter in the chosen order, each with its type mark, the current style outlined and a menu of Word's style
// commands; Show Preview and Disable Linked Styles; New Style, Style Inspector, Manage Styles and Options... A click applies the
// style to the selection, every range of a multi-range selection included. The list is windowed: All styles can hold hundreds.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from 'cn';
import { ChevronDown, ListTree, Plus, ScanSearch, SlidersHorizontal, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { IconButton } from '../../../app/components/Tip.jsx';
import { keepFocus } from '../../../app/components/Toolbar.jsx';
import { fontStack } from '../../../office.mjs';
import { Check, useUnit } from '../../../tooling/kit/controls.jsx';
import { saveWord } from '../../word/settings.mjs';
import {
  filterStyles, isBuiltIn, kindOf, MARKS, nameOf, PANE_FILTER, patchStyles, resolvedRun, sortStyles, styleDescription, usage,
} from './model.mjs';
import { applyStyle, clearInstances, deleteStyle, formatAt, openDlg, writeStyles } from './ops.js';

// The doc's style counts, kept per doc node: the pane renders on every transaction and the walk visits every inline node.
const counted = new WeakMap();
export const countsOf = (doc) => {
  if (doc.counts) return doc.counts; // a canvas draft's stand-in (canvas-ed.mjs) carries the engine's styles.usage
  if (!counted.has(doc)) counted.set(doc, usage(doc));
  return counted.get(doc);
};

/** A list that draws only the rows in view (fixed height `rowH` px). */
export function Windowed({ items, rowH, render, label }) {
  const ref = useRef(null);
  const [top, setTop] = useState(0);
  const [h, setH] = useState(400);
  useLayoutEffect(() => {
    const el = ref.current;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(top / rowH) - 6);
  const last = Math.min(items.length, Math.ceil((top + h) / rowH) + 6);
  return (
    <div ref={ref} role="listbox" aria-label={label} onScroll={(e) => setTop(e.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-auto">
      <div style={{ height: items.length * rowH }} className="relative">
        {items.slice(first, last).map((it, i) => (
          <div key={it.id} className="absolute inset-x-0" style={{ top: (first + i) * rowH, height: rowH }}>{render(it)}</div>
        ))}
      </div>
    </div>
  );
}

/** The CSS a style's name draws in with Show Preview on: its font, size (capped to the row), weight, slant and underline. The
 * colour is left out so the names stay readable on the dark pane. */
export function previewCss(styles, theme, id) {
  const r = { ...styles?.defaults?.run, ...resolvedRun(styles, id) };
  return {
    fontFamily: r.font ? fontStack(r.font, theme) : undefined, fontSize: `${Math.min(18, (r.size ?? 12) * 4 / 3)}px`, fontWeight: r.bold ? 700 : undefined,
    fontStyle: r.italic ? 'italic' : undefined, textDecoration: r.underline && r.underline !== 'none' ? 'underline' : undefined,
  };
}

const KIND_ICON = { table: Table2, numbering: ListTree };

function RowMenu({ ctx, s, n }) {
  const ed = ctx.target;
  const name = nameOf(s);
  const styles = ed.state.doc.attrs.styles;
  const item = (label, onSelect, disabled) => <DropdownMenuItem disabled={disabled} onSelect={onSelect}>{label}</DropdownMenuItem>;
  return (
    <DropdownMenu modal={false}>
      <IconButton label={`${name} options`} slot={DropdownMenuTrigger} onMouseDown={keepFocus} reveal className="size-5"><ChevronDown /></IconButton>
      <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()} data-style-menu={s.id}>
        {item(`Update ${name} to Match Selection`, () => ctx.run('styles.updateToMatch', s.id))}
        {item('Modify...', () => openDlg(ctx, 'modifyStyle', { styleId: s.id }))}
        <DropdownMenuSeparator />
        {n ? item(`Select All ${n} Instance(s)`, () => ctx.run('styles.selectAllInstances', s.id)) : item('Select All: Not currently used', null, true)}
        {n > 0 && item(`Clear Formatting of ${n} Instance(s)`, () => clearInstances(ctx, s.id))}
        {!isBuiltIn(s.id) && item(`Delete ${name}...`, () => deleteStyle(ed, s.id))}
        {item(s.qFormat ? 'Remove from Style Gallery' : 'Add to Style Gallery', () => writeStyles(ed, patchStyles(styles, { [s.id]: { qFormat: !s.qFormat } })))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function StylesPane({ ctx }) {
  const unit = useUnit();
  const state = ctx.state;
  const doc = state?.doc;
  const styles = doc?.attrs.styles;
  const settings = doc?.attrs.settings;
  const opts = ctx.settings?.word?.stylesPane ?? {};
  const counts = doc ? countsOf(doc) : {};
  const filter = { ...PANE_FILTER, ...settings?.stylePaneFormatFilter };
  const sort = settings?.stylePaneSortMethod ?? 'recommended';
  // Recomputed when the styles, the filter or which styles are used change, not on every keystroke.
  const usedKey = Object.keys(counts).sort().join(' ');
  const rows = useMemo(() => (styles ? sortStyles(filterStyles(styles, counts, { ...filter, pane: true }), sort, styles) : []),
    [styles, usedKey, sort, settings?.stylePaneFormatFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!state) return null;
  const at = formatAt(state);
  const current = new Set([at.styleId, at.charStyle].filter(Boolean));
  const theme = doc.attrs.theme;
  const rowH = opts.preview ? 28 : 24;
  const render = (s) => {
    if (s.id === 'clear') {
      return (
        <button type="button" data-style-row="clear" onMouseDown={keepFocus} onClick={() => applyStyle(ctx, 'clear')}
          className="flex h-full w-full items-center rounded-sm px-2 text-left hover:bg-accent">Clear All</button>
      );
    }
    const kind = kindOf(s, { noLinked: opts.noLinked });
    const Icon = KIND_ICON[kind];
    return (
      <div data-style-row={s.id} data-current={current.has(s.id) || undefined} aria-selected={current.has(s.id)} role="option"
        title={styleDescription(styles, s.id, { unit, theme })}
        className={cn('group flex h-full items-center gap-1 rounded-sm border border-transparent pr-1 hover:bg-accent', current.has(s.id) && 'border-ring')}>
        <button type="button" onMouseDown={keepFocus} onClick={() => applyStyle(ctx, s.id)} className="min-w-0 flex-1 truncate pl-2 text-left"
          style={opts.preview ? previewCss(styles, theme, s.id) : undefined}>{nameOf(s)}</button>
        <RowMenu ctx={ctx} s={s} n={counts[s.id] ?? 0} />
        <span aria-hidden className="w-5 shrink-0 text-center text-xs text-muted-foreground [&_svg]:inline [&_svg]:size-3.5">{Icon ? <Icon /> : MARKS[kind]}</span>
      </div>
    );
  };
  return (
    <div className="flex h-full flex-col gap-2 px-2 pb-2">
      <Windowed items={[{ id: 'clear' }, ...rows]} rowH={rowH} render={render} label="Styles" />
      <div className="flex flex-col gap-1.5 border-t pt-2">
        <Check label="Show Preview" checked={!!opts.preview} onChange={(v) => saveWord({ stylesPane: { preview: v } })} />
        <Check label="Disable Linked Styles" checked={!!opts.noLinked} onChange={(v) => saveWord({ stylesPane: { noLinked: v } })} />
      </div>
      <div className="flex items-center gap-1">
        <IconButton label="New Style" size="regular" onMouseDown={keepFocus} onClick={() => openDlg(ctx, 'createNewStyleFromFormatting')}><Plus /></IconButton>
        <IconButton label="Style Inspector" size="regular" onMouseDown={keepFocus} onClick={() => ctx.run('styles.inspector')}><ScanSearch /></IconButton>
        <IconButton label="Manage Styles" size="regular" onMouseDown={keepFocus} onClick={() => ctx.run('styles.manage')}><SlidersHorizontal /></IconButton>
        <Button type="button" variant="outline" size="sm" className="ml-auto" onMouseDown={keepFocus} onClick={() => openDlg(ctx, 'stylePaneOptions')}>Options...</Button>
      </div>
    </div>
  );
}

