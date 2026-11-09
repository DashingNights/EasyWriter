// The Accessibility pane (docs/plans/word briefs/proofing.md; pane id accessibility, right): Errors, Warnings and Tips with counts,
// rechecked as the document changes while it is open. A click selects the item; each offers the fix that runs an existing command
// when one is registered and hides it otherwise. The Keep accessibility checker running box keeps the status bar's count live.
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Check } from '../../../tooling/kit/controls.jsx';
import { commandOf } from '../../../tooling/registry.js';
import { useEngineValue } from '../../../tooling/engine-value.js';
import { saveWord } from '../../word/settings.mjs';
import { issuesOf, tally } from './a11y.mjs';

const cache = new WeakMap(); // doc node → its issues, so the pane and the status bar value share one check per document version

/** The accessibility issues of `doc`, computed once per document version. */
export function issuesFor(doc) {
  if (!cache.has(doc)) cache.set(doc, issuesOf(doc));
  return cache.get(doc);
}

const GROUPS = [['error', 'Errors'], ['warning', 'Warnings'], ['tip', 'Tips']];

/** Selects issue `i` in editor `ed`: an object as a node selection, text as a text selection, and scrolls it into view. */
function reveal(ed, i) {
  const { state } = ed;
  const node = state.doc.nodeAt(i.from);
  const sel = node && !node.isText && i.to - i.from === node.nodeSize && NodeSelection.isSelectable(node)
    ? NodeSelection.create(state.doc, i.from) : TextSelection.create(state.doc, Math.max(0, i.from), Math.min(state.doc.content.size, i.to));
  ed.view.dispatch(state.tr.setSelection(sel).scrollIntoView());
  ed.view.focus();
}

// The fixes: a label and the registered command it runs on the selected issue (hidden while that command is unregistered).
const FIXES = {
  altText: [['Add a description', 'review.accessibility.checkAccessibility.altText'], ['Mark as decorative', null]],
  tableHeader: [['Use the first row as header', 'tableDesign.tableStyleOptions.headerRow']],
  contrast: [['Automatic colour', 'home.font.fontColor', null]],
  linkText: [['Edit the link', 'insert.links.link']],
};

/** Runs fix `fix` of issue `i` in `ctx`. Mark as decorative writes the picture's attribute itself: no command offers it. */
function runFix(ctx, i, [, id, arg]) {
  reveal(ctx.ed, i);
  if (id) return ctx.run(id, arg);
  const { state } = ctx.ed;
  return ctx.ed.view.dispatch(state.tr.setNodeAttribute(i.from, 'decorative', true));
}

/** The pane on a canvas draft: the engine's check (file.accessibility); a click selects the item, and an item the engine offers
 * an action for (In Line with Text, say) gets its button. */
function CanvasA11yPane({ ctx }) {
  const session = ctx.engine;
  const found = useEngineValue(session, 'file.accessibility');
  const issues = useMemo(() => (found?.issues ?? []).map((i) => ({ ...i, title: i.issue, label: i.fix ?? '' })), [found]);
  const counts = tally(issues);
  const [open, setOpen] = useState({ error: true, warning: true, tip: true });
  const live = !!ctx.settings.word?.proofing?.accessibilityLive;
  const reveal = (i) => {
    const a = i.select?.anchor ?? i.pos;
    if (a) session.exec('select.range', { anchor: a, focus: i.select?.focus ?? a });
  };
  return (
    <div data-a11y="" data-canvas="" className="flex flex-col gap-2 px-3 py-2">
      <div className="text-xs font-medium text-muted-foreground">Inspection results</div>
      {!issues.length && <p data-a11y-clear="">No accessibility issues found.</p>}
      {GROUPS.map(([kind, label]) => {
        const list = issues.filter((x) => x.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind} data-a11y-group={kind} data-count={counts[kind]} className="flex flex-col">
            <button type="button" className="flex items-center gap-1 py-0.5 text-left font-medium" onClick={() => setOpen({ ...open, [kind]: !open[kind] })}>
              {open[kind] ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {label} ({counts[kind]})
            </button>
            {open[kind] && list.map((i, n) => (
              <div key={`${i.rule}:${n}`} data-a11y-issue={i.rule} className="flex flex-col gap-1 border-b py-1.5 pl-4 last:border-b-0">
                <button type="button" className="text-left hover:underline" onClick={() => reveal(i)}>
                  <span className="block text-xs text-muted-foreground">{i.title}</span>
                  {i.label}
                </button>
                {i.action?.command && (
                  <div className="flex flex-wrap gap-1">
                    <Button size="xs" variant="outline" onClick={async () => {
                      reveal(i);
                      await session.exec(i.action.command, i.action.params ?? {});
                    }}>{i.action.label}</Button>
                  </div>
                )}
              </div>
            ))}
          </section>
        );
      })}
      <div className="mt-2 border-t pt-2">
        <Check label="Keep accessibility checker running" checked={live} onChange={(v) => saveWord({ proofing: { accessibilityLive: v } })} />
      </div>
    </div>
  );
}

export function A11yPane({ ctx }) {
  return ctx.engine ? <CanvasA11yPane ctx={ctx} /> : <DomA11yPane ctx={ctx} />;
}

function DomA11yPane({ ctx }) {
  const doc = ctx.ed?.state.doc ?? null;
  const [shown, setShown] = useState(doc);
  // Rechecks a moment after typing stops, so a long document does not check on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setShown(doc), 250);
    return () => clearTimeout(t);
  }, [doc]);
  const issues = useMemo(() => (shown ? issuesFor(shown) : []), [shown]);
  const counts = tally(issues);
  const [open, setOpen] = useState({ error: true, warning: true, tip: true });
  const live = !!ctx.settings.word?.proofing?.accessibilityLive;
  if (!ctx.ed) return null;
  return (
    <div data-a11y="" className="flex flex-col gap-2 px-3 py-2">
      <div className="text-xs font-medium text-muted-foreground">Inspection results</div>
      {!issues.length && <p data-a11y-clear="">No accessibility issues found.</p>}
      {GROUPS.map(([kind, label]) => {
        const list = issues.filter((x) => x.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind} data-a11y-group={kind} data-count={counts[kind]} className="flex flex-col">
            <button type="button" className="flex items-center gap-1 py-0.5 text-left font-medium" onClick={() => setOpen({ ...open, [kind]: !open[kind] })}>
              {open[kind] ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {label} ({counts[kind]})
            </button>
            {open[kind] && list.map((i) => (
              <div key={`${i.rule}:${i.from}`} data-a11y-issue={i.rule} className="flex flex-col gap-1 border-b py-1.5 pl-4 last:border-b-0">
                <button type="button" className="text-left hover:underline" onClick={() => reveal(ctx.ed, i)}>
                  <span className="block text-xs text-muted-foreground">{i.title}</span>
                  {i.label}
                </button>
                <div className="flex flex-wrap gap-1">
                  {(FIXES[i.rule] ?? []).filter(([, id]) => !id || commandOf(id)).map((fix) => (
                    <Button key={fix[0]} size="xs" variant="outline" onClick={() => runFix(ctx, i, fix)}>{fix[0]}</Button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        );
      })}
      <div className="mt-2 border-t pt-2">
        <Check label="Keep accessibility checker running" checked={live} onChange={(v) => saveWord({ proofing: { accessibilityLive: v } })} />
      </div>
    </div>
  );
}
