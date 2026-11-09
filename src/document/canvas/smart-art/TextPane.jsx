// ph-smartart-2: the Text Pane (Word's SmartArt Text Pane): the diagram's outline, one row per item, its levels indented. Typing
// commits after a pause; Enter, Tab, Shift+Tab, Backspace and the arrows edit the outline as Word does. The pane does not open by
// itself on insert; the ribbon's Text Pane button opens it.
import { useEffect, useRef, useState } from 'react';
import { setState } from '../../../app/store.js';
import { addAfter, canDemote, canPromote, commitText, removeItem } from './outline.mjs';
import { diagramNow, diagramOf, pickItem, pickedOf } from './state.mjs';

const BULLET = '•';
const PAUSE = 600;

export function TextPane({ ctx }) {
  const d = diagramOf(ctx);
  const items = d?.spec.items ?? [];
  const [draft, setDraft] = useState(null); // {i, text}: the row typed in, until it commits
  const draftRef = useRef(null);
  const timer = useRef(0);
  const focusAt = useRef(null); // the row to focus once the new items have drawn
  const root = useRef(null);
  const row = (i) => root.current?.querySelector(`[data-diagram-row="${i}"]`);
  // The outline as drawn, so a run's new rows reach the focus effect.
  const shape = items.map((it) => `${it.level}:${it.text}`).join('\n');

  useEffect(() => {
    if (focusAt.current == null) return;
    const el = row(focusAt.current);
    focusAt.current = null;
    el?.focus();
  }, [shape]);

  // Opened from the page (a double click on a shape): the pane takes the focus on the picked row as it mounts. The page's click
  // ran first, so a wait for the pane in the caller would race it.
  useEffect(() => {
    const i = pickedOf(d);
    if (i != null) row(i)?.focus();
  }, []);

  /** Commits the draft if there is one → the diagram's items now, with the typed text. Clears the draft after the engine answers. */
  const commit = async () => {
    clearTimeout(timer.current);
    const m = draftRef.current;
    const now = (await diagramNow(ctx))?.spec.items ?? items;
    if (!m) return now;
    // A later keystroke's draft (the ref is cleared before the await) is not this commit's.
    draftRef.current = null;
    setDraft(null);
    const r = await commitText(now, m, (next) => ctx.engine.exec('smartArt.items', { items: next }));
    if (r.failed && !draftRef.current) {
      // The engine refused the write: the typed text goes back in the row, never lost.
      draftRef.current = m;
      setDraft(m);
    }
    return r.items ?? now;
  };

  /** Runs an outline edit and picks the item it gives. */
  const apply = async (r) => {
    if (!r) return false;
    const done = await ctx.engine.exec('smartArt.items', { items: r.items }).then((x) => !!x?.ok, () => false);
    if (done) {
      pickItem(d.pos, r.at);
      focusAt.current = r.at;
    }
    setState({});
    return done;
  };

  const edit = (i, text) => {
    draftRef.current = { i, text };
    setDraft({ i, text });
    clearTimeout(timer.current);
    timer.current = setTimeout(commit, PAUSE);
  };

  const key = async (e, i) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await apply(addAfter(await commit(), i));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const after = await commit();
      if (e.shiftKey ? canPromote(after, i) : canDemote(after, i)) {
        await ctx.engine.exec(e.shiftKey ? 'smartArt.promote' : 'smartArt.demote', { index: i }).catch(() => null);
      }
      // The focus stays on the row.
      focusAt.current = i;
      setState({});
    } else if (e.key === 'Backspace') {
      const after = await commit();
      if (after[i]?.text !== '') return; // the input deletes the character
      e.preventDefault();
      await apply(removeItem(after, i));
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      await commit();
      const at = i + (e.key === 'ArrowDown' ? 1 : -1);
      if (at >= 0 && at < items.length) row(at)?.focus();
    }
  };

  if (!d) return <p className="p-3 text-muted-foreground">Select a diagram to edit its text.</p>;
  return (
    <div ref={root} data-smart-art-text-pane="" className="flex flex-col gap-1 p-3">
      {items.map((it, i) => {
        const text = draft?.i === i ? draft.text : it.text;
        return (
          <div key={i} className="flex items-center gap-1" style={{ paddingLeft: `${0.5 + it.level * 1}rem` }}>
            <span aria-hidden="true" className="text-muted-foreground">{BULLET}</span>
            <input value={text} data-diagram-row={i} placeholder="[Text]" aria-label={`Item ${i + 1}`}
              onChange={(e) => edit(i, e.target.value)}
              onKeyDown={(e) => key(e, i)}
              onFocus={() => { pickItem(d.pos, i); setState({}); }}
              onBlur={() => commit()}
              className="h-6 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
          </div>
        );
      })}
    </div>
  );
}
