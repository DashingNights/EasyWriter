// The Navigation pane's Results tab: each hit with the text around it and the term in bold; a click selects that hit.
import { cn } from 'cn';
import { select } from './plugin.js';
import { snippet } from './results.mjs';

function lineOf(doc, m) {
  if (m.label) return { before: '', term: m.label, after: '' };
  const $p = doc.resolve(m.from);
  const start = $p.start();
  // The same leaf text findMatches reads, so offsets stay positions inside the block.
  const text = $p.parent.textBetween(0, $p.parent.content.size, undefined, '￼');
  return snippet(text, m.from - start, m.to - start);
}

export function Results({ ed, matches, index, searching }) {
  const { view } = ed;
  if (!searching) {
    return <p className="px-3 py-1 text-muted-foreground">Search for text, or use the magnifier to find pictures, tables, equations, notes and comments.</p>;
  }
  if (!matches.length) return <p className="px-3 py-1 text-muted-foreground">No matches.</p>;
  return (
    <ol data-nav-results="" className="flex flex-col gap-0.5 px-1 pb-14">
      {matches.map((m, i) => {
        const line = lineOf(view.state.doc, m);
        return (
          <li key={`${m.from}-${m.to}`}>
            <button type="button" data-nav-result={i} aria-current={i === index || undefined}
              onClick={() => { select(view, i); view.focus(); }}
              className={cn('block w-full rounded-sm px-2 py-1 text-left hover:bg-accent', i === index && 'bg-accent')}>
              {line.before}<b>{line.term}</b>{line.after}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
