import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { cn } from 'cn';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '../app/components/Tip.jsx';
import { useStore } from '../app/store.js';
import { findOpts } from './wp/navpane/FindOptions.jsx';
import { Headings } from './wp/navpane/Headings.jsx';
import { Pages } from './wp/navpane/Pages.jsx';
import { navState, search, select, step } from './wp/navpane/plugin.js';
import { Results } from './wp/navpane/Results.jsx';
import { KINDS } from './wp/navpane/results.mjs';

// Word's Navigation pane (the pane 'navigation', left; docs/plans/word/briefs/navpane.md): the search box with Result X of N, its
// menu, and the Headings, Pages and Results tabs. Ctrl+F (find's home.editing.find) opens it and raises store word.navSearch
// {n, seed}: each new n focuses the box with the seed in it and searches. The parts live in wp/navpane/.

const TABS = [['headings', 'Headings'], ['pages', 'Pages'], ['results', 'Results']];
let seen = 0; // the last word.navSearch n handled, so reopening the pane does not search again

export function NavPane({ ctx }) {
  const ed = ctx?.ed;
  const [tab, setTab] = useState('headings');
  const [text, setText] = useState(() => (ed ? navState(ed.state).query : ''));
  const box = useRef(null);
  const frame = useRef(0);
  const ask = useStore((s) => s.word?.navSearch);
  const opts = findOpts(ctx?.settings?.word);

  const view = ed?.view;
  const run = (q) => {
    if (!view) return;
    search(view, { query: q, opts, highlight: opts.highlightAll !== false });
    if (q) select(view, navState(view.state).index);
  };
  const type = (q) => {
    setText(q);
    if (opts.incremental === false) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => run(q)); // one search per frame while typing
  };
  const clear = () => {
    cancelAnimationFrame(frame.current);
    setText('');
    if (view) search(view, {});
  };

  useEffect(() => {
    if (!ask?.n || ask.n <= seen || !box.current) return;
    seen = ask.n;
    setTab('results'); // Ctrl+F opens the pane on Results (probe navigation-pane)
    box.current.focus();
    if (ask.seed != null) {
      setText(ask.seed);
      run(ask.seed);
    }
    box.current.select();
  }, [ask?.n]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  if (!ed) return null;
  const s = navState(ed.state);
  const searching = !!(s.query || s.kind);
  const kindLabel = s.kind ? KINDS[s.kind].label : null;
  const status = !searching ? null : s.matches.length ? `Result ${s.index + 1} of ${s.matches.length}` : 'No matches';
  const options = async () => {
    const r = await ctx.dialog('findOptions', { value: opts });
    if (r && s.query && view) search(view, { query: s.query, opts: r, highlight: r.highlightAll !== false });
  };
  const find = (kind) => {
    setText('');
    search(view, { kind });
    if (navState(view.state).matches.length) select(view, 0);
  };
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (text !== s.query) run(text);
      else step(view, e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clear();
    }
  };

  return (
    <nav aria-label="Navigation pane" data-nav-pane="" className="flex min-h-full flex-col text-sm">
      <div className="flex items-center gap-1 px-2 pb-1">
        <div className="flex h-7 min-w-0 flex-1 items-center rounded-sm border bg-background focus-within:ring-2 focus-within:ring-ring/50">
          <input ref={box} data-nav-search="" type="text" value={text} placeholder={kindLabel ? `Finding ${kindLabel.toLowerCase()}` : 'Search document'}
            aria-label="Search document" onChange={(e) => type(e.target.value)} onKeyDown={onKey}
            className="h-full min-w-0 flex-1 bg-transparent px-2 outline-none" />
          {searching || text ? (
            <IconButton label="Clear search" onClick={clear}><X /></IconButton>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" data-nav-search-menu="" aria-label="Search for more things" className="grid h-full w-7 place-items-center text-muted-foreground hover:text-foreground [&_svg]:size-3.5">
                <Search />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onSelect={options}>Options...</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => ctx.run('home.editing.find.advancedFind')}>Advanced Find...</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => ctx.run('home.editing.replace')}>Replace...</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => ctx.run('home.editing.find.goTo')}>Go To...</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Find</DropdownMenuLabel>
              {Object.entries(KINDS).map(([k, v]) => (
                <DropdownMenuItem key={k} data-nav-kind={k} onSelect={() => find(k)}>{v.label}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {status && (
        <div className="flex items-center justify-between px-3 pb-1 text-xs text-muted-foreground">
          <span data-nav-status="">{status}</span>
          <span className="flex">
            <IconButton label="Previous result" disabled={!s.matches.length} onClick={() => step(view, -1)}><ChevronUp /></IconButton>
            <IconButton label="Next result" disabled={!s.matches.length} onClick={() => step(view, 1)}><ChevronDown /></IconButton>
          </span>
        </div>
      )}
      <div role="tablist" aria-label="Navigation" className="flex gap-3 border-b px-3">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" data-nav-tab={id} aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn('-mb-px border-b-2 py-1', tab === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col pt-1">
        {tab === 'headings' && <Headings ed={ed} matches={s.matches} searching={searching} run={ctx.run} />}
        {tab === 'pages' && <Pages ed={ed} matches={s.matches} searching={searching} />}
        {tab === 'results' && <Results ed={ed} matches={s.matches} index={s.index} searching={searching} />}
      </div>
    </nav>
  );
}
