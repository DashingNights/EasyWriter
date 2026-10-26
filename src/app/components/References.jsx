import { Fragment, useMemo, useState } from 'react';
import { cn } from 'cn';
import { Trash2 } from 'lucide-react';
import { toast as sonner } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import {
  citation, cleanSource, CONTAINER, FIELDS, isoDay, labels, nextNumber, referenceRuns, sortSources, STYLES, styleOf, TYPES,
} from '../../references.mjs';
import { refocusEditor, toast } from '../actions.js';
import {
  insertCitation, insertReferenceList, lookupLink, openReferences, removeSource, saveSource, setDefaultStyle, setStyle,
} from '../references.js';
import { setState, useStore } from '../store.js';
import { DateField } from './DateField.jsx';
import { IconButton } from './Tip.jsx';

// The References dialog (openReferences: the bottom island's More tools, a Document's Insert tab, the tool search) and the
// citation picker at the text cursor (openCitePicker: Insert reference). docs/plans/references.md.

const EMPTY = [];
const useSources = () => useStore((s) => s.draft?.sources) ?? EMPTY;
const useStyle = () => useStore((s) => styleOf(s.draft, s.settings));
/** Runs (references.mjs) as text with the italic ones in <em>. */
const Runs = ({ runs }) => runs.map((r, i) => <Fragment key={i}>{r.italic ? <em>{r.text}</em> : r.text}</Fragment>);
/** The label a source cites with now: Harvard its letter; numbered its number, or the one citing it would give it. */
const labelNow = (sources, s, style) => (style === 'ieee' && !s.num ? String(nextNumber(sources)) : labels(sources, style).get(s.id) ?? '');

/** The open draft's style, and Make default while it is not the default (the References dialog, the tool search). */
export function ReferenceStyle() {
  const style = useStyle();
  const preferred = useStore((s) => styleOf(null, s.settings));
  const cited = useSources().length > 0;
  const act = (p) => p.catch((err) => toast(err.message, true));
  return (
    <div data-reference-style className="grid gap-1">
      <div className="flex items-center gap-2">
        <Label htmlFor="ref-style">Style</Label>
        <Select value={style} onValueChange={(v) => act(setStyle(v))}>
          <SelectTrigger id="ref-style" size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{STYLES.map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent>
        </Select>
        {style === preferred
          ? <span className="text-xs text-muted-foreground">Your default</span>
          : <Button type="button" variant="ghost" size="sm" onClick={() => act(setDefaultStyle(style))}>Make default</Button>}
      </div>
      {cited && <p className="text-xs text-muted-foreground">Citations already in the text keep their style.</p>}
    </div>
  );
}
const LABELS = { title: 'Title', date: 'Published', volume: 'Volume', issue: 'Issue', pages: 'Pages', place: 'Place', publisher: 'Publisher', doi: 'DOI',
  arxiv: 'arXiv id', url: 'Link', accessed: 'Accessed' };
const WIDE = ['title', 'container', 'url'];

/** A labelled field of the source form; `wide` spans both columns. */
function Field({ id, label, hint, wide, children }) {
  return (
    <div className={cn('grid content-start gap-1.5', wide && 'col-span-2')}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** One source's fields (the ones its type prints), a preview of its entry and citation, Save and Back. */
function SourceForm({ source: initial, problem, onDone }) {
  const [f, setF] = useState(initial);
  const [authors, setAuthors] = useState(initial.authors.join('\n'));
  const [error, setError] = useState('');
  const style = useStyle();
  const sources = useSources();
  const set = (k) => (v) => setF((o) => ({ ...o, [k]: v }));
  const source = cleanSource({ ...f, authors: authors.split('\n') });
  const label = labelNow(sources, source, style);
  const save = async (e) => {
    e.preventDefault();
    try {
      await saveSource(source);
      onDone();
    } catch (err) {
      setError(err.message);
    }
  };
  const input = (k) => (k === 'date' || k === 'accessed'
    ? <DateField id={`ref-${k}`} className="h-8" value={f[k]} onChange={(e) => set(k)(e.target.value)} onPick={set(k)} />
    : <Input id={`ref-${k}`} className="h-8" value={f[k]} onChange={(e) => set(k)(e.target.value)} />);
  return (
    <form onSubmit={save} className="flex min-h-0 flex-col gap-3">
      {problem && <p className="text-muted-foreground">{problem}</p>}
      <div className="-mx-1 grid min-h-0 grid-cols-2 gap-x-2 gap-y-3 overflow-y-auto px-1">
        <Field id="ref-type" label="Type">
          <Select value={f.type} onValueChange={set('type')}>
            <SelectTrigger id="ref-type" size="sm" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{TYPES.map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field id="ref-year" label="Year">
          <Input id="ref-year" className="h-8" placeholder="n.d." value={f.year} onChange={(e) => set('year')(e.target.value)} />
        </Field>
        <Field id="ref-authors" label="Authors" wide hint="One per line. A person as Family, Given. An organisation as its name.">
          <Textarea id="ref-authors" rows={3} className="min-h-0" value={authors} onChange={(e) => setAuthors(e.target.value)} />
        </Field>
        {FIELDS[f.type].map((k) => (
          <Field key={k} id={`ref-${k}`} label={k === 'container' ? CONTAINER[f.type] : LABELS[k]} wide={WIDE.includes(k)}>{input(k)}</Field>
        ))}
        <Field id="ref-note" label="Note" wide hint="For you only. The reference list leaves it out.">
          <Input id="ref-note" className="h-8" value={f.note} onChange={(e) => set('note')(e.target.value)} />
        </Field>
      </div>
      <div data-source-preview className="grid gap-1 rounded-md border bg-muted/40 px-2 py-1.5">
        <p className="break-words"><Runs runs={referenceRuns(source, label, style)} /></p>
        <p className="text-muted-foreground">{`${citation(source, label, false, style)} or ${citation(source, label, true, style)}`}</p>
      </div>
      {error && <p className="text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>Back</Button>
        <Button type="submit" size="sm">Save</Button>
      </DialogFooter>
    </form>
  );
}

/** The sources in list order, a box to add one from a link, Add by hand and Insert reference list. */
function SourceList({ onEdit, onClose }) {
  const sources = useSources();
  const style = useStyle();
  const rows = useMemo(() => {
    const lab = labels(sources, style);
    // A numbered draft's source not cited yet shows no number: citing it or listing it gives it one.
    return sortSources(sources, style).map((s) => ({ s, open: style === 'ieee' && !s.num, runs: referenceRuns(s, style === 'ieee' && !s.num ? '' : lab.get(s.id) ?? '', style) }));
  }, [sources, style]);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async (e) => {
    e.preventDefault();
    if (busy || !link.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { source, problem } = await lookupLink(link);
      onEdit(source, problem);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const remove = async (s) => {
    try {
      const gone = await removeSource(s.id);
      sonner(`Removed ${citation(gone, '', true)}`, { action: { label: 'Undo', onClick: () => saveSource(gone).catch((err) => toast(err.message, true)) } });
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <ReferenceStyle />
      <form onSubmit={add} className="flex gap-2">
        <Input autoFocus className="h-8" aria-label="Link, DOI or arXiv id" placeholder="Paste a link, DOI or arXiv id" value={link} disabled={busy}
          onChange={(e) => setLink(e.target.value)} />
        <Button type="submit" size="sm" disabled={busy || !link.trim()}>{busy && <Spinner />}Add</Button>
      </form>
      {error && <p className="text-destructive">{error}</p>}
      <div data-references-list className="-mx-1 min-h-0 overflow-y-auto">
        {rows.length ? rows.map(({ s, open, runs }) => (
          <div key={s.id} data-source={s.id} className="group flex items-start gap-1 rounded-md p-1 hover:bg-accent">
            <button type="button" className="min-w-0 flex-1 px-1 text-left break-words" onClick={() => onEdit(s)}>
              <Runs runs={runs} />
              {open && <span className="block text-xs text-muted-foreground">Not cited yet</span>}
              {s.note && <span className="block text-xs text-muted-foreground">{s.note}</span>}
            </button>
            <IconButton label="Remove source" variant="destructive-ghost" reveal onClick={() => remove(s)}><Trash2 /></IconButton>
          </div>
        )) : <p className="px-1 py-6 text-center text-muted-foreground">No sources yet. Paste a link to add one.</p>}
      </div>
      <DialogFooter className="sm:justify-between">
        <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(cleanSource({ accessed: isoDay() }))}>Add by hand</Button>
        <Button type="button" size="sm" disabled={!rows.length} onClick={() => {
          onClose();
          insertReferenceList().catch((err) => toast(err.message, true));
        }}>Insert reference list</Button>
      </DialogFooter>
    </div>
  );
}

/** The References dialog: the list, or one source's form (a looked-up link's before it is saved, Add by hand's, a row's). */
export function ReferencesDialog({ onClose }) {
  const [edit, setEdit] = useState(null); // {source, problem} while the form shows
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(null)}>
      <DialogContent data-references-dialog aria-describedby={undefined} onCloseAutoFocus={refocusEditor} onInteractOutside={(e) => e.preventDefault()}
        className="flex max-h-[85vh] flex-col gap-3 p-3 text-sm sm:max-w-xl *:data-[slot=dialog-close]:top-2 *:data-[slot=dialog-close]:right-2">
        <DialogHeader><DialogTitle>{edit ? (edit.source.id ? 'Edit source' : 'New source') : 'References'}</DialogTitle></DialogHeader>
        {edit
          ? <SourceForm {...edit} onDone={() => setEdit(null)} />
          : <SourceList onEdit={(source, problem = '') => setEdit({ source, problem })} onClose={() => onClose(null)} />}
      </DialogContent>
    </Dialog>
  );
}

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function Picker({ at }) {
  const sources = useSources();
  const style = useStyle();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const anchor = useMemo(() => ({ current: { getBoundingClientRect: () => new DOMRect(at.x, at.y, 0, 0) } }), [at]);
  const items = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    return sortSources(sources, style).map((s) => {
      const label = labelNow(sources, s, style);
      return { s, cite: citation(s, label, false, style), narrative: citation(s, label, true, style) };
    }).filter(({ s, cite }) => words.every((w) => fold([cite, s.title, ...s.authors, s.container, s.note].join(' ')).includes(w)));
  }, [sources, query, style]);
  const close = () => setState({ citePicker: null });
  const pick = (item, narrative) => {
    close();
    insertCitation(item.s.id, narrative).catch((err) => toast(err.message, true));
  };
  const current = items[Math.min(active, items.length - 1)];
  const onKeyDown = (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
      e.preventDefault();
      setActive((i) => (Math.min(i, items.length - 1) + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (e.key === 'Enter' && current) {
      e.preventDefault();
      pick(current, e.shiftKey);
    }
  };
  return (
    <Popover open onOpenChange={(open) => !open && close()}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent data-cite-picker align="start" sideOffset={6} className="w-96 p-1.5 text-sm" onCloseAutoFocus={refocusEditor}>
        <Input autoFocus className="h-8" aria-label="Search sources" placeholder="Search this draft's sources" value={query} onKeyDown={onKeyDown}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }} />
        <div role="listbox" aria-label="Sources" className="mt-1 max-h-64 overflow-y-auto">
          {items.map((it) => (
            <button key={it.s.id} type="button" role="option" aria-selected={it === current} onMouseEnter={() => setActive(items.indexOf(it))}
              onClick={(e) => pick(it, e.shiftKey)} className={cn('grid w-full rounded-sm px-2 py-1 text-left', it === current && 'bg-accent')}>
              <span>{it.cite}</span>
              <span className="truncate text-xs text-muted-foreground">{it.s.title}</span>
            </button>
          ))}
          {!items.length && <p className="px-2 py-3 text-muted-foreground">{sources.length ? 'No source matches.' : 'This draft has no sources yet.'}</p>}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 border-t pt-1 pl-2 text-xs text-muted-foreground">
          <span className="truncate">{current ? `Shift+Enter inserts ${current.narrative}` : ''}</span>
          <Button variant="ghost" size="sm" onClick={() => {
            close();
            openReferences();
          }}>{sources.length ? 'Manage sources' : 'Add sources'}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Insert reference: the open draft's sources at the text cursor, filtered as you type; Enter or a click inserts the bracketed
 * citation, Shift+Enter or a Shift+click the narrative one. Mounted once in App. */
export function CitePicker() {
  const at = useStore((s) => s.citePicker);
  return at ? <Picker at={at} /> : null;
}
