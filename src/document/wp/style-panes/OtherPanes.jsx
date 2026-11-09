// The Apply Styles box (pane 'applyStyles'), the Style Inspector (pane 'styleInspector') and Reveal Formatting (pane
// 'revealFormatting'), docs/plans/word briefs/style-panes.md and probe/dialogs.md. Word floats Apply Styles and the Style
// Inspector; here they dock on the left like any pane (a recorded deviation).
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from 'cn';
import { Eraser, FileSearch, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconButton } from '../../../app/components/Tip.jsx';
import { keepFocus } from '../../../app/components/Toolbar.jsx';
import { fontStack } from '../../../office.mjs';
import { Check, useUnit } from '../../../tooling/kit/controls.jsx';
import { saveWord } from '../../word/settings.mjs';
import { allStyles, DEFAULT_FONT, diffSections, infoOf, joinRows, nameOf, paraRows, revealSections, runRows } from './model.mjs';
import { applyStyle, formatAt, openDlg, sampleText } from './ops.js';

const nameIn = (styles, id) => nameOf(infoOf(id, styles?.list?.[id] ?? (id === DEFAULT_FONT.id ? DEFAULT_FONT : undefined)));

/** The style id whose name or id is `text` (any case), 'clear' for Clear All, else null. */
function styleNamed(styles, text) {
  const t = text.trim().toLowerCase();
  if (t === 'clear all') return 'clear';
  return allStyles(styles).find((s) => nameOf(s).toLowerCase() === t || s.id.toLowerCase() === t)?.id ?? null;
}

/** Apply Styles: a Style Name box with every style name (AutoComplete style names), Reapply, Modify... and Styles. Enter applies
 * the typed style; a new name starts a new style from the selection. */
export function ApplyStylesPane({ ctx, props }) {
  const box = useRef(null);
  const listId = useId();
  const [text, setText] = useState(null); // null: the box follows the selection's style
  const styles = ctx.state?.doc.attrs.styles;
  const at = ctx.state ? formatAt(ctx.state) : null;
  const auto = ctx.settings?.word?.stylesPane?.autoComplete !== false;
  // Opening (or Ctrl+Shift+S again) focuses the box with its text selected, as Word does.
  useEffect(() => {
    box.current?.focus();
    box.current?.select();
  }, [props.n]);
  if (!at) return null;
  const shown = text ?? nameIn(styles, at.styleId);
  const apply = () => {
    const id = styleNamed(styles, shown);
    setText(null);
    if (id) return applyStyle(ctx, id);
    if (shown.trim()) return openDlg(ctx, 'createNewStyleFromFormatting', { name: shown.trim() });
    return false;
  };
  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      <label htmlFor={`${listId}box`} className="text-xs text-muted-foreground">Style Name:</label>
      <Input ref={box} id={`${listId}box`} data-apply-styles-box="" size="xs" value={shown} list={auto ? listId : undefined} spellCheck={false}
        onChange={(e) => setText(e.target.value)} onBlur={() => setText(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setText(null);
            ctx.target?.commands.focus();
          }
        }} />
      <datalist id={listId}>{['Clear All', ...allStyles(styles).map(nameOf)].map((n) => <option key={n} value={n} />)}</datalist>
      <div className="flex items-center gap-1">
        <Button type="button" variant="outline" size="sm" onMouseDown={keepFocus} onClick={apply}>Reapply</Button>
        <Button type="button" variant="outline" size="sm" onMouseDown={keepFocus}
          onClick={() => openDlg(ctx, 'modifyStyle', { styleId: styleNamed(styles, shown) ?? at.styleId })}>Modify...</Button>
        <Button type="button" variant="outline" size="sm" onMouseDown={keepFocus} onClick={() => ctx.pane('styles', true)}>Styles</Button>
      </div>
      <Check label="AutoComplete style names" checked={auto} onChange={(v) => saveWord({ stylesPane: { autoComplete: v } })} />
    </div>
  );
}

const MARK_NAMES = ['bold', 'italic', 'underline', 'strike', 'subscript', 'superscript'];

/** Removes the selection's direct run formatting (marks and textStyle values) but keeps its character style. */
const clearRun = (ctx) => ctx.chain((c) => c.command(({ tr }) => {
  const { marks } = tr.doc.type.schema;
  const ts = marks.textStyle;
  for (const { $from, $to } of tr.selection.ranges) {
    for (const name of MARK_NAMES) if (marks[name]) tr.removeMark($from.pos, $to.pos, marks[name]);
    tr.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      const m = node.isInline && ts.isInSet(node.marks);
      if (!m) return true;
      const a = Math.max(pos, $from.pos);
      const b = Math.min(pos + node.nodeSize, $to.pos);
      if (m.attrs.charStyle) tr.addMark(a, b, ts.create({ charStyle: m.attrs.charStyle }));
      else tr.removeMark(a, b, ts);
      return false;
    });
  }
  return true;
}));

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

/** The Style Inspector: the paragraph style and character style of the selection, each with the direct formatting on top of it
 * and a button to clear each part. Follows the selection. */
export function StyleInspectorPane({ ctx }) {
  const unit = useUnit();
  if (!ctx.state) return null;
  const styles = ctx.state.doc.attrs.styles;
  const at = formatAt(ctx.state);
  const theme = ctx.state.doc.attrs.theme;
  const paraKeys = Object.keys(at.directPara);
  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      <Level title="Paragraph formatting" field="para" name={nameIn(styles, at.styleId)} resetLabel="Reset to Normal Paragraph Style"
        reset={() => applyStyle(ctx, 'Normal')} plus={joinRows(paraRows(at.directPara, { unit }))} clearLabel="Clear Paragraph Formatting"
        clear={() => ctx.chain((c) => c.setParaProps(Object.fromEntries(paraKeys.map((k) => [k, null]))))} />
      <Level title="Text level formatting" field="run" name={at.charStyle ? nameIn(styles, at.charStyle) : DEFAULT_FONT.name} resetLabel="Clear Character Style"
        reset={() => ctx.chain((c) => c.setRunProps({ charStyle: null }))} plus={joinRows(runRows(at.directRun, { theme }))}
        clearLabel="Clear Character Formatting" clear={() => clearRun(ctx)} />
      <div className="flex items-center gap-1 border-t pt-2">
        <IconButton label="New Style" onMouseDown={keepFocus} onClick={() => openDlg(ctx, 'createNewStyleFromFormatting')}><Plus /></IconButton>
        <IconButton label="Reveal Formatting" onMouseDown={keepFocus} onClick={() => ctx.run('panes.revealFormatting')}><FileSearch /></IconButton>
        <Button type="button" variant="outline" size="sm" className="ml-auto" onMouseDown={keepFocus} onClick={() => applyStyle(ctx, 'clear')}>Clear All</Button>
      </div>
    </div>
  );
}

/** The selection's text drawn in its own formatting on a white sample, as Word's Selected text box. */
function Sample({ text, run, theme }) {
  const style = {
    fontFamily: run.font ? fontStack(run.font, theme) : undefined, fontSize: `${Math.min(24, (run.size ?? 12) * 4 / 3)}px`, fontWeight: run.bold ? 700 : undefined,
    fontStyle: run.italic ? 'italic' : undefined, color: run.color ?? undefined, textDecoration: run.underline && run.underline.val !== 'none' ? 'underline' : undefined,
  };
  return <div data-reveal-sample="" className="truncate border border-neutral-300 bg-white px-2 py-1 text-black" style={style}>{text || 'Sample Text'}</div>;
}

const SOURCE = { default: 'document default', style: 'style', charStyle: 'character style', direct: 'direct formatting' };

/** Reveal Formatting: the selection's sample, its Font, Paragraph, Bullets and Numbering and Section formatting (each heading opens
 * that dialog), Compare to another selection, Distinguish style source and Show all formatting marks. */
export function RevealFormattingPane({ ctx }) {
  const unit = useUnit();
  const [first, setFirst] = useState(null); // {sections, sample, run}: the selection compared against
  const [distinguish, setDistinguish] = useState(false);
  if (!ctx.state) return null;
  const doc = ctx.state.doc;
  const theme = doc.attrs.theme;
  const at = formatAt(ctx.state);
  const sections = revealSections({ ...at, sect: ctx.sect }, { unit, theme, styles: doc.attrs.styles });
  const sample = sampleText(ctx.state);
  const shown = first ? diffSections(first.sections, sections) : sections;
  const marksOn = !!ctx.settings?.word?.marks?.all;
  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs text-muted-foreground">Selected text</h3>
        <Sample text={first ? first.sample : sample} run={first ? first.run : at.run.props} theme={theme} />
        <Check label="Compare to another selection" checked={!!first}
          onChange={(v) => setFirst(v ? { sections, sample, run: at.run.props } : null)} />
        {first && <Sample text={sample} run={at.run.props} theme={theme} />}
      </section>
      <section className="flex flex-col gap-1" aria-label="Formatting of selected text">
        <h3 className="text-xs text-muted-foreground">Formatting of selected text</h3>
        {shown.map((sec) => (
          <div key={sec.id} data-reveal-section={sec.id} className="flex flex-col">
            <button type="button" onMouseDown={keepFocus} onClick={() => openDlg(ctx, sec.dialog)}
              className="w-fit rounded-sm px-1 text-left font-medium text-primary underline-offset-2 hover:underline">{sec.title}</button>
            {sec.rows.length ? sec.rows.map((r) => (
              <div key={r.key} data-reveal-row={r.key} className={cn('pl-3 text-xs', first && 'text-foreground')}>
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

