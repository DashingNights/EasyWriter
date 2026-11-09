// The style panes on a canvas draft (docs/plans/engine/stage2b.md, engine-gaps-styles; stage2.md G10): the Styles pane, Apply
// Styles, the Style Inspector and Reveal Formatting read the engine (styles.get's sheet, styles.usage, styles.inspect and the
// formatting at the selection) in the DOM editor's form (styles/engine.mjs), so they share model.mjs's lists, rows and
// descriptions with the DOM panes; their buttons run the canvas rows or the engine's own commands.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from 'cn';
import { ChevronDown, Eraser, FileSearch, ListTree, Plus, RotateCcw, ScanSearch, SlidersHorizontal, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { IconButton } from '../../../app/components/Tip.jsx';
import { keepFocus } from '../../../app/components/Toolbar.jsx';
import { Check, useUnit } from '../../../tooling/kit/controls.jsx';
import { paneOpen } from '../../../tooling/panes.jsx';
import { saveWord } from '../../word/settings.mjs';
import { runOfEngine } from '../font/run.mjs';
import { paraOfEngine } from '../paragraph/rules.mjs';
import { directOf, paraOfProps, readStyles, readTheme, runOfChr } from '../styles/engine.mjs';
import {
  allStyles, DEFAULT_FONT, diffSections, filterStyles, infoOf, isBuiltIn, joinRows, kindOf, MARKS, nameOf, PANE_FILTER, paraRows, revealSections, runRows,
  sortStyles, styleDescription,
} from './model.mjs';
import { askStyle } from './ops.js';
import { previewCss } from './StylesPane.jsx';

const nameIn = (styles, id) => nameOf(infoOf(id, styles?.list?.[id] ?? (id === DEFAULT_FONT.id ? DEFAULT_FONT : undefined)));
const exec = (ctx, id, args = {}) => Promise.resolve(ctx.engine.exec(id, args)).then((r) => !!r?.ok);
/** styles.inspect at the selection, read with the ribbon's state so it follows the caret. */
const inspectOf = (ctx) => ctx.stateOf?.('styles.inspect')?.value ?? null;
/** The state call stops asking for styles.inspect once neither pane that reads it is open, so typing does not pay for it. */
function useInspect(ctx) {
  useEffect(() => () => {
    if (!paneOpen('styleInspector') && !paneOpen('revealFormatting')) ctx.unwatch?.('styles.inspect');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A style on a canvas draft: para.style takes paragraph and character styles alike (the engine puts a character style on the
 * runs), and Clear All is Clear Formatting's row. */
const apply = (ctx, id) => (id === 'clear' ? ctx.run('home.styles.styles.clearFormatting') : exec(ctx, 'para.style', { style: id }));

/** The selection's formatting in model.mjs's layered form ({styleId, charStyle, run, para, directRun, directPara, list}) from the
 * engine's format.state, para.state and styles.inspect: a property the inspector lists as direct is 'direct', the rest 'style'. */
function canvasAt(ctx) {
  const ins = inspectOf(ctx);
  const directRun = runOfChr(directOf(ins?.character?.direct));
  const directPara = paraOfProps(directOf(ins?.paragraph?.direct));
  // Reveal Formatting lists what is set: a toggle that is off and the neutral scale, spacing and position say nothing.
  const NEUTRAL = { scale: 100, spacing: 0, position: 0 };
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => v != null && v !== false && NEUTRAL[k] !== v));
  const run = clean(runOfEngine(ctx.stateOf?.('format.state')?.value));
  const para = paraOfEngine(ctx.stateOf?.('para.state')?.value);
  const src = (props, direct) => Object.fromEntries(Object.keys(props).map((k) => [k, k in direct ? 'direct' : 'style']));
  const l = ctx.engineState?.['document.context']?.value?.list;
  return {
    styleId: ins?.paragraph?.style ?? ctx.stateOf?.('para.style')?.value ?? 'Normal', charStyle: ins?.character?.style ?? null,
    run: { props: run, src: src(run, directRun) }, para: { props: para, src: src(para, directPara) }, directRun, directPara,
    list: l ? { numId: l.num, ilvl: l.level, fmt: l.numbered ? 'decimal' : 'bullet' } : null,
  };
}

/** The canvas draft's styles, theme and (with `usage`) style counts in the DOM form, read through ctx.read (the pane draws again
 * when they answer). Only the Styles pane counts: styles.usage walks every paragraph of the body. */
// ponytail: the Styles pane reads the sheet and the counts again after each layout while it is open: on the 978-page Word fixture
// styles.usage takes 1.0 ms and styles.get 2.5 ms (median, the .wasm in Node, 2026-11-01); count incrementally in the engine if
// that shows in the keystroke budget.
function useSheet(ctx, { usage = false } = {}) {
  const sheet = ctx.read('styles.get', {});
  const settings = ctx.read('document.settings', {});
  const counts = (usage && ctx.read('styles.usage', {})) || {};
  const styles = useMemo(() => readStyles(ctx), [sheet]); // eslint-disable-line react-hooks/exhaustive-deps
  const theme = useMemo(() => readTheme(ctx), [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  return { styles, theme, counts };
}

const KIND_ICON = { table: Table2, numbering: ListTree };

function RowMenu({ ctx, s, n }) {
  const name = nameOf(s);
  const item = (label, onSelect, disabled) => <DropdownMenuItem disabled={disabled} onSelect={onSelect}>{label}</DropdownMenuItem>;
  const remove = async () => {
    if (await askStyle(`Do you want to delete style ${name}?`)) exec(ctx, 'styles.delete', { style: s.id });
  };
  return (
    <DropdownMenu modal={false}>
      <IconButton label={`${name} options`} slot={DropdownMenuTrigger} onMouseDown={keepFocus} reveal className="size-5"><ChevronDown /></IconButton>
      <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()} data-style-menu={s.id}>
        {item(`Update ${name} to Match Selection`, () => ctx.run('styles.updateToMatch', s.id))}
        {item('Modify...', () => ctx.run('styles.modify', s.id))}
        <DropdownMenuSeparator />
        {n ? item(`Select All ${n} Instance(s)`, () => ctx.run('styles.selectAllInstances', s.id)) : item('Select All: Not currently used', null, true)}
        {!isBuiltIn(s.id) && !s.builtIn && item(`Delete ${name}...`, remove)}
        {item(s.qFormat ? 'Remove from Style Gallery' : 'Add to Style Gallery', () => exec(ctx, 'styles.setVisibility', { style: s.id, gallery: !s.qFormat }))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Styles pane on a canvas draft: Word's recommended styles in Word's order (Style Pane Options keeps its defaults here). */
export function CanvasStylesPane({ ctx }) {
  const unit = useUnit();
  const { styles, theme, counts } = useSheet(ctx, { usage: true });
  const opts = ctx.settings?.word?.stylesPane ?? {};
  const usedKey = Object.keys(counts).sort().join(' ');
  const rows = useMemo(() => (styles ? sortStyles(filterStyles(styles, counts, { ...PANE_FILTER, pane: true }), 'recommended', styles) : []),
    [styles, usedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = ctx.stateOf?.('para.style')?.value ?? null;
  return (
    <div className="flex h-full flex-col gap-2 px-2 pb-2">
      <div role="listbox" aria-label="Styles" className="min-h-0 flex-1 overflow-auto">
        <button type="button" data-style-row="clear" onMouseDown={keepFocus} onClick={() => apply(ctx, 'clear')}
          className="flex h-6 w-full items-center rounded-sm px-2 text-left hover:bg-accent">Clear All</button>
        {!styles && <p className="px-2 py-1 text-xs text-muted-foreground">Reading the styles...</p>}
        {rows.map((s) => {
          const kind = kindOf(s, { noLinked: opts.noLinked });
          const Icon = KIND_ICON[kind];
          const on = s.id === current;
          return (
            <div key={s.id} data-style-row={s.id} data-current={on || undefined} aria-selected={on} role="option" title={styleDescription(styles, s.id, { unit, theme })}
              className={cn('group flex h-6 items-center gap-1 rounded-sm border border-transparent pr-1 hover:bg-accent', on && 'border-ring')}>
              <button type="button" onMouseDown={keepFocus} onClick={() => apply(ctx, s.id)} className="min-w-0 flex-1 truncate pl-2 text-left"
                style={opts.preview ? previewCss(styles, theme, s.id) : undefined}>{nameOf(s)}</button>
              <RowMenu ctx={ctx} s={s} n={counts[s.id] ?? 0} />
              <span aria-hidden className="w-5 shrink-0 text-center text-xs text-muted-foreground [&_svg]:inline [&_svg]:size-3.5">{Icon ? <Icon /> : MARKS[kind]}</span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-1.5 border-t pt-2">
        <Check label="Show Preview" checked={!!opts.preview} onChange={(v) => saveWord({ stylesPane: { preview: v } })} />
        <Check label="Disable Linked Styles" checked={!!opts.noLinked} onChange={(v) => saveWord({ stylesPane: { noLinked: v } })} />
      </div>
      <div className="flex items-center gap-1">
        <IconButton label="New Style" size="regular" onMouseDown={keepFocus} onClick={() => ctx.run('home.styles.styles.createAStyle')}><Plus /></IconButton>
        <IconButton label="Style Inspector" size="regular" onMouseDown={keepFocus} onClick={() => ctx.run('styles.inspector')}><ScanSearch /></IconButton>
        <IconButton label="Manage Styles" size="regular" onMouseDown={keepFocus} onClick={() => ctx.run('styles.manage')}><SlidersHorizontal /></IconButton>
      </div>
    </div>
  );
}

/** The style id whose name or id is `text` (any case), 'clear' for Clear All, else null. */
function styleNamed(styles, text) {
  const t = text.trim().toLowerCase();
  if (t === 'clear all') return 'clear';
  return allStyles(styles).find((s) => nameOf(s).toLowerCase() === t || s.id.toLowerCase() === t)?.id ?? null;
}

/** Apply Styles on a canvas draft: the box follows the caret's paragraph style; Enter applies the typed one, a new name starts
 * Create New Style. */
export function CanvasApplyStylesPane({ ctx, props }) {
  const box = useRef(null);
  const listId = useId();
  const [text, setText] = useState(null);
  const { styles } = useSheet(ctx);
  const auto = ctx.settings?.word?.stylesPane?.autoComplete !== false;
  useEffect(() => {
    box.current?.focus();
    box.current?.select();
  }, [props.n]);
  const at = ctx.stateOf?.('para.style')?.value ?? 'Normal';
  const shown = text ?? nameIn(styles, at);
  const go = () => {
    const id = styleNamed(styles, shown);
    setText(null);
    if (id) return apply(ctx, id);
    return shown.trim() ? ctx.run('home.styles.styles.createAStyle') : false;
  };
  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      <label htmlFor={`${listId}box`} className="text-xs text-muted-foreground">Style Name:</label>
      <Input ref={box} id={`${listId}box`} data-apply-styles-box="" size="xs" value={shown} list={auto ? listId : undefined} spellCheck={false}
        onChange={(e) => setText(e.target.value)} onBlur={() => setText(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            go();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setText(null);
          }
        }} />
      <datalist id={listId}>{['Clear All', ...allStyles(styles).map(nameOf)].map((n) => <option key={n} value={n} />)}</datalist>
      <div className="flex items-center gap-1">
        <Button type="button" variant="outline" size="sm" onMouseDown={keepFocus} onClick={go}>Reapply</Button>
        <Button type="button" variant="outline" size="sm" onMouseDown={keepFocus} onClick={() => ctx.run('styles.modify', styleNamed(styles, shown) ?? at)}>Modify...</Button>
        <Button type="button" variant="outline" size="sm" onMouseDown={keepFocus} onClick={() => ctx.pane('styles', true)}>Styles</Button>
      </div>
      <Check label="AutoComplete style names" checked={auto} onChange={(v) => saveWord({ stylesPane: { autoComplete: v } })} />
    </div>
  );
}

function Level({ title, name, reset, resetLabel, plus, clear, clearLabel, field }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs text-muted-foreground">{title}</h3>
      <div className="flex items-center gap-1">
        <span data-inspector={field} className="min-w-0 flex-1 truncate rounded-sm border bg-background px-2 py-1">{name}</span>
        <IconButton label={resetLabel} onMouseDown={keepFocus} onClick={reset}><RotateCcw /></IconButton>
      </div>
      <div className="flex items-center gap-1">
        <span data-inspector={`${field}Plus`} className="min-w-0 flex-1 rounded-sm border bg-background px-2 py-1 text-xs">Plus: {plus || '<none>'}</span>
        <IconButton label={clearLabel} onMouseDown={keepFocus} onClick={clear} disabled={!plus}><Eraser /></IconButton>
      </div>
    </section>
  );
}

/** The Style Inspector on a canvas draft: styles.inspect's paragraph and character levels, each cleared by
 * styles.inspectorClear. */
export function CanvasInspectorPane({ ctx }) {
  useInspect(ctx);
  const unit = useUnit();
  const { styles, theme } = useSheet(ctx);
  const at = canvasAt(ctx);
  const clear = (level) => exec(ctx, 'styles.inspectorClear', { level });
  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      <Level title="Paragraph formatting" field="para" name={nameIn(styles, at.styleId)} resetLabel="Reset to Normal Paragraph Style"
        reset={() => apply(ctx, 'Normal')} plus={joinRows(paraRows(at.directPara, { unit }))} clearLabel="Clear Paragraph Formatting"
        clear={() => clear('paragraphFormatting')} />
      <Level title="Text level formatting" field="run" name={at.charStyle ? nameIn(styles, at.charStyle) : DEFAULT_FONT.name} resetLabel="Clear Character Style"
        reset={() => clear('characterStyle')} plus={joinRows(runRows(at.directRun, { theme }))} clearLabel="Clear Character Formatting"
        clear={() => clear('characterFormatting')} />
      <div className="flex items-center gap-1 border-t pt-2">
        <IconButton label="New Style" onMouseDown={keepFocus} onClick={() => ctx.run('home.styles.styles.createAStyle')}><Plus /></IconButton>
        <IconButton label="Reveal Formatting" onMouseDown={keepFocus} onClick={() => ctx.run('panes.revealFormatting')}><FileSearch /></IconButton>
        <Button type="button" variant="outline" size="sm" className="ml-auto" onMouseDown={keepFocus} onClick={() => apply(ctx, 'clear')}>Clear All</Button>
      </div>
    </div>
  );
}

const SOURCE = { default: 'document default', style: 'style', charStyle: 'character style', direct: 'direct formatting' };
// The dialog each Reveal Formatting heading opens through its canvas row.
const HEADING_ROW = { font: 'home.font.launcher', paragraph: 'home.paragraph.launcher', defineNewNumberFormat: 'home.paragraph.numbering.defineNewNumberFormat',
  pageSetup: 'layout.pageSetup.launcher' };

/** Reveal Formatting on a canvas draft: the Font, Paragraph and Bullets and Numbering sections from the engine's formatting at
 * the selection; each heading opens its dialog through the canvas row. */
// ponytail: no selected text sample or Section rows (the engine's text and section are not in the selection state); add them
// when the state carries them.
export function CanvasRevealPane({ ctx }) {
  useInspect(ctx);
  const unit = useUnit();
  const { styles, theme } = useSheet(ctx);
  const [first, setFirst] = useState(null);
  const [distinguish, setDistinguish] = useState(false);
  const at = canvasAt(ctx);
  const sections = revealSections({ ...at, sect: null }, { unit, theme, styles }).filter((s) => s.id !== 'section');
  const shown = first ? diffSections(first, sections) : sections;
  const marksOn = !!ctx.settings?.word?.marks?.all;
  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      <Check label="Compare to another selection" checked={!!first} onChange={(v) => setFirst(v ? sections : null)} />
      <section className="flex flex-col gap-1" aria-label="Formatting of selected text">
        <h3 className="text-xs text-muted-foreground">Formatting of selected text</h3>
        {shown.map((sec) => (
          <div key={sec.id} data-reveal-section={sec.id} className="flex flex-col">
            <button type="button" onMouseDown={keepFocus} onClick={() => HEADING_ROW[sec.dialog] && ctx.run(HEADING_ROW[sec.dialog])}
              className="w-fit rounded-sm px-1 text-left font-medium text-primary underline-offset-2 hover:underline">{sec.title}</button>
            {sec.rows.length ? sec.rows.map((r) => (
              <div key={r.key} data-reveal-row={r.key} className="pl-3 text-xs">
                {r.label}: {r.value}{distinguish && <span className="text-muted-foreground"> ({SOURCE[r.source] ?? r.source})</span>}
              </div>
            )) : <div className="pl-3 text-xs text-muted-foreground">{first ? 'No differences' : 'None'}</div>}
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-1.5 border-t pt-2">
        <h3 className="text-xs text-muted-foreground">Options</h3>
        <Check label="Distinguish style source" checked={distinguish} onChange={setDistinguish} />
        <Check label="Show all formatting marks" checked={marksOn} onChange={() => ctx.run('home.paragraph.showAll')} />
      </section>
    </div>
  );
}
