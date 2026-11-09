// The Reviewing pane (docs/plans/word plan.md §1.7 panes, §3 markup; probe/dialogs/reviewing-pane.json): the number of revisions,
// a detailed summary by kind, then one row per revision and comment in document order, a comment's replies under it. A click selects
// the item in the text; a revision inside a header, footer, note or comment goes through that story's x.reveal command when its owner
// registered it. The pane redraws on every transaction, so Refresh only redraws it (Word's pane can fall behind; this one cannot).
import { useReducer, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { keepFocus } from '../../../app/components/Toolbar.jsx';
import { commandOf } from '../../../tooling/registry.js';
import { useEngineValue } from '../../../tooling/engine-value.js';
import { commentsOf, revisionsOf, visibleText } from '../../model/review.mjs';
import { clock, cut, shownFor, summary } from './balloons.mjs';

const KIND = { insert: 'Inserted', delete: 'Deleted', format: 'Formatted', paraProps: 'Formatted', replace: 'Replaced', attr: 'Formatted', row: 'Table row',
  paraMark: 'Paragraph mark' };
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

// A comment row shows the comment's own words, as Word lists them; a reply selects its thread's anchor.
const commentRow = (c, anchor = c, reply = false) => ({ key: `c:${c.id}`, item: c, kind: reply ? 'Reply' : 'Comment', author: c.author, date: c.date,
  text: visibleText({ type: 'doc', content: c.content ?? [] }), from: anchor.from, to: anchor.to, at: null, reply });

/** The rows of `doc`: revisions and top-level comments, body items by position, story items after them; replies follow their comment. */
function rowsOf(revisions, comments) {
  const rows = [
    ...revisions.map((r) => [{ key: `r:${r.source}:${r.id}:${r.from}`, item: r, kind: r.move ? 'Moved' : r.source === 'suggestion' ? 'Suggested' : KIND[r.kind] ?? r.kind,
      author: r.source === 'suggestion' ? 'Assistant' : r.author, date: r.date, text: r.text, from: r.from, to: r.to, at: r.at }]),
    ...comments.map((c) => [commentRow(c), ...c.replies.map((x) => commentRow(x, c, true))]),
  ];
  const order = (g) => (g[0].at || g[0].from == null ? Infinity : g[0].from);
  return rows.sort((a, b) => order(a) - order(b)).flat();
}

// The engine's change kinds (review.changes) as the pane names them.
const ENGINE_KIND = { insert: 'Inserted', delete: 'Deleted', format: 'Formatted', moveFrom: 'Moved', moveTo: 'Moved', paragraph: 'Paragraph mark' };

/** A canvas draft's rows from review.changes and review.comments, in reading order. */
function engineRows(ch, cm) {
  const changes = ch.map((c, i) => ({ key: `r:${i}`, kind: ENGINE_KIND[c.kind] ?? c.kind, op: c.kind, author: c.author, date: c.date,
    text: c.description ?? c.text, start: c.start, end: c.end }));
  const comments = cm.map((c) => ({ key: `c:${c.id}`, kind: c.parent == null ? 'Comment' : 'Reply', author: c.author, date: c.date,
    text: c.text, start: c.anchor, end: c.anchor, reply: c.parent != null }));
  return { changes, comments, all: [...changes, ...comments] };
}

/** The pane on a canvas draft: the engine's changes, then its comments, of the reviewers Specific People shows (`people`, null for
 * everyone; stage2.md G25); a click selects the item in the text. */
function CanvasReviewingPane({ session, people }) {
  const [detail, setDetail] = useState(false);
  const ch = useEngineValue(session, 'review.changes');
  const cm = useEngineValue(session, 'review.comments');
  if (!ch || !cm) return null;
  const all = engineRows(ch, cm);
  const mine = (list) => list.filter((r) => shownFor(people, r.author));
  const rows = { changes: mine(all.changes), comments: mine(all.comments), all: mine(all.all) };
  const count = (op) => rows.changes.filter((r) => op.includes(r.op)).length;
  const s = { total: rows.all.length, insertions: count(['insert']), deletions: count(['delete']), moves: count(['moveFrom', 'moveTo']),
    formatting: count(['format', 'paragraph']), comments: rows.comments.length };
  const Chevron = detail ? ChevronDown : ChevronRight;
  return (
    <div data-reviewing="" data-canvas="" className="flex flex-col gap-1 px-3 pb-3">
      <div className="flex items-center gap-1">
        <button type="button" aria-expanded={detail} aria-label="Show Detailed Summary" onMouseDown={keepFocus} onClick={() => setDetail(!detail)}
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Chevron className="size-4" /></button>
        <span data-reviewing-total={s.total} className="font-medium">{plural(s.total, 'revision')}</span>
      </div>
      {detail && (
        <dl data-reviewing-summary="" className="grid grid-cols-[1fr_auto] gap-x-3 pl-2 text-xs text-muted-foreground">
          {[['Insertions', s.insertions], ['Deletions', s.deletions], ['Moves', s.moves], ['Formatting', s.formatting], ['Comments', s.comments]]
            .map(([k, v]) => [<dt key={k}>{k}</dt>, <dd key={`${k}-n`} className="text-right tabular-nums">{v}</dd>])}
        </dl>
      )}
      <ol className="flex flex-col gap-1">
        {rows.all.map((row) => (
          <li key={row.key} className={row.reply ? 'pl-4' : undefined}>
            <button type="button" data-review-row={row.key} onMouseDown={keepFocus} onClick={() => row.start && session.select(row.start, row.end ?? row.start)}
              className="flex w-full flex-col rounded-sm border-l-2 border-ring/60 px-2 py-1 text-left hover:bg-accent">
              <span className="flex gap-1 text-xs">
                <span className="truncate font-medium">{row.author || 'Unknown author'}</span>
                <span className="shrink-0">{row.kind}</span>
                <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{clock(row.date)}</span>
              </span>
              {row.text && <span className="text-xs break-words text-muted-foreground">{cut(row.text, 120)}</span>}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The pane's body ({ctx} from PaneHost). */
export function ReviewingPane({ ctx }) {
  return ctx.engine ? <CanvasReviewingPane session={ctx.engine} people={ctx.settings?.word?.tracking?.people ?? null} /> : <DomReviewingPane ctx={ctx} />;
}

function DomReviewingPane({ ctx }) {
  const [detail, setDetail] = useState(false);
  const [, refresh] = useReducer((n) => n + 1, 0);
  const ed = ctx.ed;
  if (!ed || ed.isDestroyed) return null;
  const revisions = revisionsOf(ed.state.doc);
  const comments = commentsOf(ed.state.doc);
  const s = summary(revisions, comments);
  const go = (row) => {
    if (row.at) {
      const id = `x.reveal.${row.at.story}`;
      if (commandOf(id)) ctx.run(id, { ...row.at, from: row.from, to: row.to });
      return;
    }
    if (row.from == null) return;
    ed.chain().focus().setTextSelection({ from: row.from, to: row.to }).scrollIntoView().run();
  };
  const Chevron = detail ? ChevronDown : ChevronRight;
  return (
    <div data-reviewing="" className="flex flex-col gap-1 px-3 pb-3">
      <div className="flex items-center gap-1">
        <button type="button" aria-expanded={detail} aria-label="Show Detailed Summary" onMouseDown={keepFocus} onClick={() => setDetail(!detail)}
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Chevron className="size-4" /></button>
        <span data-reviewing-total={s.total} className="font-medium">{plural(s.total, 'revision')}</span>
        <button type="button" aria-label="Refresh Reviewing Pane" onMouseDown={keepFocus} onClick={refresh}
          className="ml-auto rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"><RefreshCw className="size-4" /></button>
      </div>
      {detail && (
        <dl data-reviewing-summary="" className="grid grid-cols-[1fr_auto] gap-x-3 pl-2 text-xs text-muted-foreground">
          {[['Insertions', s.insertions], ['Deletions', s.deletions], ['Moves', s.moves], ['Formatting', s.formatting], ['Comments', s.comments]]
            .map(([k, v]) => [<dt key={k}>{k}</dt>, <dd key={`${k}-n`} className="text-right tabular-nums">{v}</dd>])}
        </dl>
      )}
      <ol className="flex flex-col gap-1">
        {rowsOf(revisions, comments).map((row) => (
          <li key={row.key} className={row.reply ? 'pl-4' : undefined}>
            <button type="button" data-review-row={row.key} onMouseDown={keepFocus} onClick={() => go(row)}
              className="flex w-full flex-col rounded-sm border-l-2 border-ring/60 px-2 py-1 text-left hover:bg-accent">
              <span className="flex gap-1 text-xs">
                <span className="truncate font-medium">{row.author || 'Unknown author'}</span>
                <span className="shrink-0">{row.kind}</span>
                <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{clock(row.date)}</span>
              </span>
              {row.text && <span className="text-xs break-words text-muted-foreground">{cut(row.text, 120)}</span>}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
