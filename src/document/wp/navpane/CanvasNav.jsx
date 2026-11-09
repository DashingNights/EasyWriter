// The Navigation pane on a canvas draft (docs/plans/engine/stage2b.md, engine-gaps-review): the same box, menu and tabs as the
// DOM pane (src/document/NavPane.jsx), read from the engine. Search runs edit.find with the Find Options and highlights every
// result in the document (the engine's Reading Highlight), the menu's Find kinds
// edit.findObjects (stage2.md G36), Headings lists nav.headings with each heading's fold (heading.collapse, G19), Pages lists the
// pages with the ones holding results marked, and Results shows each hit in its words. A pick selects through select.range, so a
// hit under a folded heading opens it (the engine's after-command reveal).
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Search, X } from 'lucide-react';
import { cn } from 'cn';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '../../../app/components/Tip.jsx';
import { useStore } from '../../../app/store.js';
import { NavPane } from '../../NavPane.jsx';
import { findOpts } from './FindOptions.jsx';
import { useEngineValue } from '../../../tooling/engine-value.js';

const TABS = [['headings', 'Headings'], ['pages', 'Pages'], ['results', 'Results']];
// The search menu's Find kinds → edit.findObjects kinds (results.mjs KINDS's labels).
const KINDS = { graphics: ['graphic', 'Graphics'], tables: ['table', 'Tables'], equations: ['equation', 'Equations'],
  notes: ['note', 'Footnotes/Endnotes'], comments: ['comment', 'Comments'] };
let seen = 0; // the last word.navSearch n handled, as NavPane.jsx keeps it
const FRESH = 2000; // ms: an ask older than this was the DOM pane's (each pane keeps its own `seen`)

const value = async (p) => (await Promise.resolve(p).catch(() => null))?.value ?? null;

const NONE = [];

/** The pages and the pages holding `matches` (one caret call per match, on the Pages tab only). */
function usePages(session, matches, on) {
  const [pages, setPages] = useState({ count: 0, hits: new Set() });
  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    (async () => {
      const count = (await Promise.resolve(session.pages()).catch(() => null))?.pages?.length ?? 0;
      const at = await Promise.all(matches.map((m) => Promise.resolve(session.caret(m.start)).catch(() => null)));
      if (live) setPages({ count, hits: new Set(at.filter(Boolean).map((c) => c.page)) });
    })();
    return () => {
      live = false;
    };
  }, [session, matches, on]);
  return pages;
}

/** The heading a match lies under: the last heading at or before its body block. */
const headingOf = (heads, m) => {
  const block = m.start?.path?.[0] ?? -1;
  let at = null;
  for (const h of heads) if (h.block <= block) at = h.id;
  return at;
};

/** Headings as a tree, each with its pane fold (the pane's own, as in Word) and its fold in the text. */
function HeadingsTab({ session, heads, hitHeads, searching }) {
  const [closed, setClosed] = useState(() => new Set());
  if (!heads.length) {
    return <p className="px-3 py-1 text-muted-foreground">Create an interactive outline of your document by applying heading styles.</p>;
  }
  const rows = [];
  let hideBelow = Infinity;
  heads.forEach((h, i) => {
    if (h.level > hideBelow) return;
    hideBelow = Infinity;
    const kids = heads[i + 1]?.level > h.level;
    if (kids && closed.has(h.id)) hideBelow = h.level;
    rows.push({ h, kids });
  });
  const flip = (id) => setClosed((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <ol data-nav-headings="" data-canvas="" className="flex flex-col px-1 pb-14">
      {rows.map(({ h, kids }) => (
        <li key={h.id} className="flex items-center" style={{ paddingLeft: (h.level - 1) * 12 }}>
          <button type="button" aria-label={closed.has(h.id) ? 'Expand' : 'Collapse'} disabled={!kids} onClick={() => flip(h.id)}
            className="grid size-5 shrink-0 place-items-center text-muted-foreground disabled:invisible [&_svg]:size-3.5">
            {closed.has(h.id) ? <ChevronRight /> : <ChevronDown />}
          </button>
          <button type="button" data-nav-heading={h.id} data-level={h.level} data-folded={h.folded || undefined}
            onClick={() => session.exec('select.range', { anchor: h.pos, focus: h.pos })}
            className={cn('min-w-0 flex-1 truncate rounded-sm px-1 py-0.5 text-left hover:bg-accent', searching && hitHeads.has(h.id) && 'bg-amber-200/60 dark:bg-amber-500/30')}>
            {h.text || 'Heading'}
          </button>
        </li>
      ))}
    </ol>
  );
}

function PagesTab({ session, pages, searching }) {
  return (
    <ol data-nav-pages="" data-canvas="" className="grid grid-cols-2 gap-2 px-3 pb-14">
      {Array.from({ length: pages.count }, (_, i) => (
        <li key={i}>
          <button type="button" data-nav-page={i} data-hit={(searching && pages.hits.has(i)) || undefined}
            onClick={() => session.exec('edit.goto', { page: i + 1 })}
            className={cn('flex aspect-[3/4] w-full items-end justify-center rounded-sm border bg-background pb-1 text-xs hover:border-ring',
              searching && pages.hits.has(i) && 'border-amber-500')}>
            {i + 1}
          </button>
        </li>
      ))}
    </ol>
  );
}

function ResultsTab({ matches, index, pick, searching }) {
  if (!searching) {
    return <p className="px-3 py-1 text-muted-foreground">Search for text, or use the magnifier to find pictures, tables, equations, notes and comments.</p>;
  }
  if (!matches.length) return <p className="px-3 py-1 text-muted-foreground">No matches.</p>;
  return (
    <ol data-nav-results="" data-canvas="" className="flex flex-col gap-0.5 px-1 pb-14">
      {matches.map((m, i) => (
        <li key={i}>
          <button type="button" data-nav-result={i} aria-current={i === index || undefined} onClick={() => pick(i)}
            className={cn('block w-full rounded-sm px-2 py-1 text-left hover:bg-accent', i === index && 'bg-accent')}>
            {m.snippet ? <>{m.snippet.before}<b>{m.snippet.term}</b>{m.snippet.after}</> : <b>{m.label}</b>}
          </button>
        </li>
      ))}
    </ol>
  );
}

export function CanvasNav({ ctx }) {
  const session = ctx.engine;
  const [tab, setTab] = useState('headings');
  const [text, setText] = useState('');
  const [found, setFound] = useState({ query: '', kind: null, matches: [], index: -1 });
  const box = useRef(null);
  const frame = useRef(0);
  const ask = useStore((s) => s.word?.navSearch);
  const opts = findOpts(ctx.settings?.word);
  const heads = useEngineValue(session, 'nav.headings') ?? NONE;
  const searching = !!(found.query || found.kind);
  const pages = usePages(session, found.matches, tab === 'pages' && searching);

  // Word highlights every result in the document while the pane searches (Find Options' Highlight all, on by default) and selects
  // the current one. The highlight is the engine's Reading Highlight of the last search, so each new search moves it. The pane
  // sends it with every search and keeps no copy of it: the Find dialog's Clear Highlighting and a switch to another draft change
  // it behind the pane's back, and the call is idempotent.
  const light = (on, s = session) => Promise.resolve(s?.exec('edit.advancedFind', { highlight: on })).catch(() => {});
  const pick = (matches, i) => {
    const m = matches[i];
    if (!m) return;
    setFound((f) => ({ ...f, index: i }));
    session.exec('select.range', { anchor: m.start, focus: m.end ?? m.start });
  };
  const run = async (q) => {
    if (!q) {
      light(false);
      return setFound({ query: '', kind: null, matches: [], index: -1 });
    }
    // Every Find Option edit.find has; Sounds like and All word forms it lacks.
    const r = await Promise.resolve(session.exec('edit.find', { text: q, snippets: true, matchCase: !!opts.matchCase, wholeWord: !!opts.wholeWord,
      wildcards: !!opts.wildcards, matchPrefix: !!opts.prefix, matchSuffix: !!opts.suffix, ignorePunct: !!opts.ignorePunct,
      ignoreSpace: !!opts.ignoreSpace })).catch(() => null);
    const matches = r?.ok ? r.value?.matches ?? [] : [];
    setFound({ query: q, kind: null, matches, index: matches.length ? 0 : -1 });
    light(opts.highlightAll !== false);
    if (matches.length) pick(matches, 0);
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
    setFound({ query: '', kind: null, matches: [], index: -1 });
    light(false);
  };
  const step = (d) => found.matches.length && pick(found.matches, (found.index + d + found.matches.length) % found.matches.length);
  const findKind = async (k) => {
    setText('');
    light(false);
    const [kind, label] = KINDS[k];
    const list = (await value(session.query('edit.findObjects', { kind }))) ?? [];
    const matches = list.map((o) => ({ start: o.pos, end: o.pos, label }));
    setFound({ query: '', kind: k, matches, index: matches.length ? 0 : -1 });
    setTab('results');
    if (matches.length) pick(matches, 0);
  };

  useEffect(() => {
    if (!ask?.n || ask.n <= seen || !box.current || !(Date.now() - (ask.at ?? 0) < FRESH)) return;
    seen = ask.n;
    setTab('results'); // Ctrl+F opens the pane on Results (probe navigation-pane)
    box.current.focus();
    if (ask.seed != null) {
      setText(ask.seed);
      run(ask.seed);
    }
    box.current.select();
  }, [ask?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  // Closing the pane, or switching it to another draft's session, ends the old session's highlight. A released draft's session
  // rejects the call, which light catches.
  useEffect(() => () => light(false, session), [session]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const status = !searching ? null : found.matches.length ? `Result ${found.index + 1} of ${found.matches.length}` : 'No matches';
  const kindLabel = found.kind ? KINDS[found.kind][1] : null;
  const hitHeads = new Set(found.matches.map((m) => headingOf(heads, m)).filter((x) => x != null));
  const options = async () => {
    const r = await ctx.dialog('findOptions', { value: opts });
    if (r && found.query) run(found.query);
  };
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (text !== found.query) run(text);
      else step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clear();
    }
  };

  return (
    <nav aria-label="Navigation pane" data-nav-pane="" data-canvas="" className="flex min-h-full flex-col text-sm">
      <div className="flex items-center gap-1 px-2 pb-1">
        <div className="flex h-7 min-w-0 flex-1 items-center rounded-sm border bg-background focus-within:ring-2 focus-within:ring-ring/50">
          <input ref={box} data-nav-search="" type="text" value={text} placeholder={kindLabel ? `Finding ${kindLabel.toLowerCase()}` : 'Search document'}
            aria-label="Search document" onChange={(e) => type(e.target.value)} onKeyDown={onKey}
            className="h-full min-w-0 flex-1 bg-transparent px-2 outline-none" />
          {searching || text ? <IconButton label="Clear search" onClick={clear}><X /></IconButton> : null}
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
              {Object.entries(KINDS).map(([k, [, label]]) => (
                <DropdownMenuItem key={k} data-nav-kind={k} onSelect={() => findKind(k)}>{label}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {status && (
        <div className="flex items-center justify-between px-3 pb-1 text-xs text-muted-foreground">
          <span data-nav-status="">{status}</span>
          <span className="flex">
            <IconButton label="Previous result" disabled={!found.matches.length} onClick={() => step(-1)}><ChevronUp /></IconButton>
            <IconButton label="Next result" disabled={!found.matches.length} onClick={() => step(1)}><ChevronDown /></IconButton>
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
        {tab === 'headings' && <HeadingsTab session={session} heads={heads} hitHeads={hitHeads} searching={searching} />}
        {tab === 'pages' && <PagesTab session={session} pages={pages} searching={searching} />}
        {tab === 'results' && <ResultsTab matches={found.matches} index={found.index} pick={(i) => pick(found.matches, i)} searching={searching} />}
      </div>
    </nav>
  );
}

/** The pane 'navigation': this one on a canvas draft, the DOM editor's otherwise. */
export function NavigationPane(props) {
  return props.ctx?.engine ? <CanvasNav {...props} /> : <NavPane {...props} />;
}
