// The Spelling pane (docs/plans/word briefs/proofing.md; pane id spelling, right): the flagged word in its sentence, suggestions with
// Change and Change All, Ignore Once, Ignore All, Add to Dictionary, Delete Repeated Word for a repeat, and the word's language.
// Opening it (F7, the Spelling and Grammar split's main part, Spelling) starts a check from the selection.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { langName } from './languages.mjs';
import * as engineSpell from './canvas.js';
import * as domSpell from './session.js';

const act = (name, fn) => ({ 'data-spell-act': name, onClick: fn });

/** The pane's body: starts a check when opened (and again when F7 runs while it is open) and ends it when closed. On a canvas
 * draft the check reads the engine (canvas.js), else the DOM editor (session.js). */
export function SpellPane({ ctx, close, props }) {
  const target = ctx.engine ?? ctx.ed;
  const { addToDictionary, change, changeAll, deleteRepeat, endSpell, ignoreAll, ignoreOnce, onSpell, spellState, startSpell } = ctx.engine ? engineSpell : domSpell;
  const st = useSyncExternalStore(onSpell, spellState);
  const [pick, setPick] = useState(0);
  useEffect(() => {
    if (target) startSpell(target, { grammar: !!props.grammar });
  }, [target, props.n, props.grammar]);
  useEffect(() => endSpell, [endSpell]);
  useEffect(() => setPick(0), [st?.item?.from, st?.item?.start, st?.item?.word]);

  if (!st || (st.busy && !st.item)) return <p className="px-3 py-2 text-muted-foreground">Checking...</p>;
  if (st.done) {
    return (
      <div data-spell-done="" className="flex flex-col gap-3 px-3 py-2">
        <p>{st.grammar ? 'The spelling and grammar check is done.' : 'The spelling check is done.'}</p>
        <Button size="sm" variant="outline" className="w-fit" onClick={close}>Close</Button>
      </div>
    );
  }
  const it = st.item;
  if (!it) return null;
  const repeat = it.kind === 'repeat';
  const grammar = it.kind === 'grammar';
  const chosen = st.suggestions[pick] ?? null;
  const s = it.sentence;
  return (
    <div data-spell-item="" data-spell-word={it.word} data-spell-kind={it.kind} className="flex flex-col gap-3 px-3 py-2">
      <div className="text-xs font-medium text-muted-foreground">{repeat ? 'Repeated word' : grammar ? 'Grammar' : 'Not in dictionary'}</div>
      {grammar && <p data-spell-message="">{it.message}</p>}
      <p className="rounded-md border bg-background p-2 leading-relaxed">
        {s.text.slice(0, s.start)}
        <span className="font-semibold text-destructive underline decoration-wavy">{s.text.slice(s.start, s.end)}</span>
        {s.text.slice(s.end)}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {repeat && <Button size="xs" {...act('delete', deleteRepeat)}>Delete Repeated Word</Button>}
        <Button size="xs" variant="outline" {...act('ignoreOnce', ignoreOnce)}>Ignore Once</Button>
        {!repeat && !grammar && <Button size="xs" variant="outline" {...act('ignoreAll', ignoreAll)}>Ignore All</Button>}
        {!repeat && !grammar && <Button size="xs" variant="outline" {...act('add', addToDictionary)}>Add to Dictionary</Button>}
      </div>
      {!repeat && (
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-muted-foreground">Suggestions</div>
          {st.suggestions.length ? (
            <div role="listbox" aria-label="Suggestions" className="flex flex-col rounded-md border bg-background py-1">
              {st.suggestions.map((w, i) => (
                <div key={w} role="option" aria-selected={i === pick} data-spell-suggestion={w} onClick={() => setPick(i)} onDoubleClick={() => change(w)}
                  className={cn('cursor-default px-2 py-0.5', i === pick ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}>{w}</div>
              ))}
            </div>
          ) : <p className="text-muted-foreground">No suggestions</p>}
          <div className="flex gap-1.5">
            <Button size="xs" disabled={!chosen} {...act('change', () => change(chosen))}>Change</Button>
            {!grammar && <Button size="xs" variant="outline" disabled={!chosen} {...act('changeAll', () => changeAll(chosen))}>Change All</Button>}
          </div>
        </div>
      )}
      {it.lang && <div data-spell-lang={it.lang} className="text-xs text-muted-foreground">{langName(it.lang)}</div>}
    </div>
  );
}
