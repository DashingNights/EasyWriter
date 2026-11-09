// Create Source, Edit Name, Add New Placeholder, Edit Citation and Source Manager (briefs/citations.md; probe/dialogs/create-source.json
// and source-manager.json give the labels, lists and access keys). Each resolves with its result; the commands in index.js save it.
// A forum post or page uses them too (app/references.js): its Source Manager adds the style, a link lookup and Insert Bibliography.
import { useEffect, useMemo, useState } from 'react';
import { cn } from 'cn';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { openDialog, toast } from '../../../app/actions.js';
import { ReferenceStyle } from '../../../app/components/References.jsx';
import { insertReferenceList, lookupLink, removeSource, saveSource } from '../../../app/references.js';
import { getState, useStore } from '../../../app/store.js';
import {
  citation, fieldOf, formatReference, labels, modelKey, nextPlaceholder, SOURCE_TYPES, styleOf, tagOf, typeFromWord, wordCitation, wordLabels, wordStyle,
  wordTypeOf,
} from '../../../references.mjs';
import { Check, Fieldset, Pick, Row, rowClass } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { docStyle } from './doc.js';
import { citedTags } from './fields.mjs';
import { masterSources, saveMaster } from './master.js';

const EMPTY = [];
const useCurrent = () => useStore((s) => s.draft?.sources) ?? EMPTY;
const LANGUAGES = ['Default', 'Chinese (Simplified, Mainland China)', 'Chinese (Traditional, Hong Kong SAR)', 'Chinese (Traditional, Taiwan)',
  'English (Hong Kong SAR)', 'English (United Kingdom)', 'English (United States)'].map((l) => [l, l]);
// The example line under the focused field (our words, after Word's).
const EXAMPLES = {
  authors: 'Smith, John; Lee, Ann', title: 'A history of the printing press', year: '2026', place: 'London', publisher: 'Penguin',
  container: 'Journal of Print History', pages: '12-19', volume: '3', issue: '2', url: 'https://example.com/page', month: 'October', day: '28',
  yearAccessed: '2026', monthAccessed: 'October', dayAccessed: '28', doi: '10.1000/xyz123', editor: 'Brown, Ann', translator: 'Ng, Bo',
};
const TEXT = 'h-6 rounded-md text-xs';

/** One labelled text box of a form; `onFocus` tells the form which field shows its example. */
function Text({ id, label, value, onChange, onFocus, disabled, width }) {
  return (
    <Row label={label} htmlFor={id}>
      <Input id={id} size="xs" className={cn(TEXT, 'flex-1')} style={{ width }} value={value ?? ''} disabled={disabled} spellCheck={false}
        onFocus={onFocus} onChange={(e) => onChange(e.target.value)} />
    </Row>
  );
}

/** Splits the Author box ("Smith, John; Lee, Ann") into names. */
const namesOf = (text) => text.split(';').map((t) => t.trim()).filter(Boolean);

/** Create Source (Add New Source, New..., Edit Source...): Word's 17 types, the language, the type's fields (Show All Bibliography
 * Fields adds the rest), the author list with Edit... and Corporate Author, and the tag. `source`: the one edited. → the source, or
 * null. */
export function CreateSource({ source, title, onClose }) {
  const current = useCurrent();
  // A source saved here says whether its author is corporate; older ones guess from one author with no comma.
  const corporate0 = source?.corporate ?? (source?.authors?.length === 1 && !source.authors[0].includes(','));
  const [v, setV] = useState(() => ({
    wtype: source ? wordTypeOf(source) : 'Book', lang: source?.lang || 'Default', corporate: corporate0,
    author: corporate0 ? '' : (source?.authors ?? []).join('; '), corp: corporate0 ? source.authors[0] : '',
    values: Object.fromEntries(SOURCE_TYPES.flatMap((t) => [...t.short, ...t.all]).map(([k]) => [k, source ? fieldOf(source, k) : ''])),
    all: false, tag: source?.placeholder ? '' : source?.tag ?? '', tagEdited: !!source?.tag && !source.placeholder, focus: null,
  }));
  const set = (patch) => setV((o) => ({ ...o, ...patch }));
  const type = SOURCE_TYPES.find((t) => t.id === v.wtype);
  const fields = [...type.short, ...(v.all ? type.all : [])].filter(([k], i, a) => a.findIndex(([x]) => x === k) === i);
  const authors = v.corporate ? [v.corp.trim()].filter(Boolean) : namesOf(v.author);
  const others = current.filter((s) => s.id !== source?.id);
  // Word's tag follows the author and year until it is typed; an empty form shows the next placeholder name.
  const autoTag = authors.length || v.values.year || v.values.title
    ? tagOf({ authors, year: v.values.year, title: v.values.title }, new Set(others.map((s) => s.tag))) : nextPlaceholder(others);
  const tag = v.tagEdited ? v.tag : autoTag;
  const styleLabel = wordStyle(docStyle()).label;
  const editNames = async () => {
    const names = await openDialog('editName', { names: authors, title: `Edit Name` });
    if (names) set({ author: names.join('; ') });
  };
  const result = () => {
    const out = { ...(source ?? {}), wtype: v.wtype, type: typeFromWord(v.wtype, source?.type), lang: v.lang === 'Default' ? '' : v.lang, authors,
      corporate: v.corporate, tag: tag.trim(), placeholder: false, extra: { ...(source?.extra ?? {}) } };
    // The Accessed boxes on the form are the access date (cleanSource builds it from them; empty boxes clear it).
    if (fields.some(([k]) => k === 'yearAccessed')) out.accessed = '';
    for (const [k] of fields) {
      if (modelKey(k)) out[k] = v.values[k];
      else out.extra[k] = v.values[k];
    }
    return out;
  };
  const validate = () => {
    if (!tag.trim()) return 'Type a tag name.';
    if (/\s/.test(tag.trim())) return 'A tag name has no spaces.';
    if (others.some((s) => s.tag === tag.trim())) return 'Another source already has this tag name.';
    return null;
  };
  return (
    <WordDialog title={title ?? (source ? 'Edit Source' : 'Create Source')} size="lg" onClose={onClose} validate={validate} result={result}
      left={[]}>
      <div className="flex gap-4">
        <Row label="Type of &Source" htmlFor="cs-type">
          <Pick id="cs-type" value={v.wtype} options={SOURCE_TYPES.map((t) => [t.id, t.label])} onChange={(wtype) => set({ wtype })} width="12rem" />
        </Row>
        <Row label="&Language" htmlFor="cs-lang">
          <Pick id="cs-lang" value={v.lang} options={LANGUAGES} onChange={(lang) => set({ lang })} width="14rem" />
        </Row>
      </div>
      <Fieldset legend={`Bibliography Fields for ${styleLabel}`}>
        <div className="grid grid-cols-[9rem_1fr] items-center gap-x-2 gap-y-1.5" data-source-fields>
          {type.author && (
            <>
              <label htmlFor="cs-author">{type.author}</label>
              <div className="flex flex-col gap-1">
                <div className="flex gap-2">
                  <Input id="cs-author" size="xs" className={cn(TEXT, 'flex-1')} value={v.author} disabled={v.corporate} spellCheck={false}
                    onFocus={() => set({ focus: 'authors' })} onChange={(e) => set({ author: e.target.value })} />
                  <Button type="button" variant="outline" size="xs" disabled={v.corporate} onClick={editNames}>Edit</Button>
                </div>
                <div className="flex items-center gap-2">
                  <Check label="Corporate Author" checked={v.corporate} onChange={(corporate) => set({ corporate })} />
                  <Input size="xs" aria-label="Corporate Author name" className={cn(TEXT, 'flex-1')} value={v.corp} disabled={!v.corporate}
                    onFocus={() => set({ focus: 'authors' })} onChange={(e) => set({ corp: e.target.value })} />
                </div>
              </div>
            </>
          )}
          {fields.map(([k, label]) => (
            <FieldRow key={k} id={`cs-${k}`} label={label} value={v.values[k]} onFocus={() => set({ focus: k })}
              onChange={(x) => set({ values: { ...v.values, [k]: x } })} />
          ))}
        </div>
      </Fieldset>
      <div className="flex items-center gap-4">
        <Check label="Show &All Bibliography Fields" checked={v.all} onChange={(all) => set({ all })} />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-example>{v.focus && EXAMPLES[v.focus] ? `Example: ${EXAMPLES[v.focus]}` : ''}</span>
      </div>
      <Row label="&Tag name" htmlFor="cs-tag">
        <Input id="cs-tag" size="xs" className={cn(TEXT, 'w-40')} value={tag} spellCheck={false} onChange={(e) => set({ tag: e.target.value, tagEdited: true })} />
      </Row>
    </WordDialog>
  );
}

function FieldRow({ id, label, value, onChange, onFocus }) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <Input id={id} size="xs" className={TEXT} value={value ?? ''} spellCheck={false} onFocus={onFocus} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

/** Edit Name (Create Source's Edit...): Last, First and Middle, Add, the Names list with Up, Down and Delete. → the names as
 * "Last, First Middle", or null. */
export function EditName({ names: initial = [], title = 'Edit Name', onClose }) {
  const [names, setNames] = useState(initial);
  const [n, setN] = useState({ last: '', first: '', middle: '' });
  const [at, setAt] = useState(-1);
  const add = () => {
    if (!n.last.trim() && !n.first.trim()) return;
    const given = [n.first, n.middle].map((x) => x.trim()).filter(Boolean).join(' ');
    setNames((l) => [...l, given ? `${n.last.trim()}, ${given}` : n.last.trim()]);
    setN({ last: '', first: '', middle: '' });
  };
  const move = (d) => {
    const j = at + d;
    if (at < 0 || j < 0 || j >= names.length) return;
    const l = [...names];
    [l[at], l[j]] = [l[j], l[at]];
    setNames(l);
    setAt(j);
  };
  // OK takes a name still in the boxes too, as Word's does.
  const result = () => {
    const given = [n.first, n.middle].map((x) => x.trim()).filter(Boolean).join(' ');
    return n.last.trim() ? [...names, given ? `${n.last.trim()}, ${given}` : n.last.trim()] : names;
  };
  return (
    <WordDialog title={title} size="sm" onClose={onClose} result={result}>
      <Fieldset legend="Add name">
        <Text id="en-last" label="&Last:" value={n.last} onChange={(last) => setN({ ...n, last })} />
        <Text id="en-first" label="&First:" value={n.first} onChange={(first) => setN({ ...n, first })} />
        <Text id="en-middle" label="&Middle:" value={n.middle} onChange={(middle) => setN({ ...n, middle })} />
        <div className="flex justify-end"><Button type="button" variant="outline" size="xs" onClick={add} {...accessProps('&Add')}><span><AccessText label="&Add" /></span></Button></div>
      </Fieldset>
      <div className="flex gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <span {...accessProps('&Names')}><AccessText label="&Names" /></span>
          <div role="listbox" aria-label="Names" className="h-28 overflow-auto rounded-md border text-xs">
            {names.map((x, i) => (
              <div key={`${x}-${i}`} role="option" aria-selected={i === at} onClick={() => setAt(i)}
                className={cn('cursor-default px-1.5 py-0.5', rowClass(i === at))}>{x}</div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1 pt-5">
          <Button type="button" variant="outline" size="xs" disabled={at < 1} onClick={() => move(-1)}>Up</Button>
          <Button type="button" variant="outline" size="xs" disabled={at < 0 || at >= names.length - 1} onClick={() => move(1)}>Down</Button>
          <Button type="button" variant="outline" size="xs" disabled={at < 0} onClick={() => {
            setNames((l) => l.filter((_, i) => i !== at));
            setAt(-1);
          }}>Delete</Button>
        </div>
      </div>
    </WordDialog>
  );
}

/** Add New Placeholder: a tag name for a source to fill in later, Placeholder1 first. → the name, or null. */
export function AddNewPlaceholder({ onClose }) {
  const current = useCurrent();
  const [name, setName] = useState(() => nextPlaceholder(current));
  const validate = () => {
    const t = name.trim();
    if (!t) return 'Type a tag name.';
    if (/\s/.test(t)) return 'A tag name has no spaces.';
    return current.some((s) => s.tag === t) ? 'Another source already has this tag name.' : null;
  };
  return (
    <WordDialog title="Placeholder Name" size="sm" onClose={onClose} validate={validate} result={() => name.trim()}
      help="Type a tag name for the source. Fill in its details later in Manage Sources.">
      <Input aria-label="Placeholder name" size="xs" className={TEXT} autoFocus value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
    </WordDialog>
  );
}

/** Edit Citation: Add Pages and Suppress Author, Year and Title (\p, \n, \y, \t). `c`: the citation's parts (parseCitation). → the
 * changed parts, or null. */
export function EditCitation({ c, onClose }) {
  const [v, setV] = useState(c);
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  return (
    <WordDialog title="Edit Citation" size="sm" onClose={onClose} result={() => ({ ...v, pages: v.pages.trim() })}>
      <Fieldset legend="Add">
        <Text id="ec-pages" label="&Pages:" value={v.pages} onChange={set('pages')} />
      </Fieldset>
      <Fieldset legend="Suppress">
        <div className="flex gap-4">
          <Check label="&Author" checked={v.noAuthor} onChange={set('noAuthor')} />
          <Check label="&Year" checked={v.noYear} onChange={set('noYear')} />
          <Check label="&Title" checked={v.noTitle} onChange={set('noTitle')} />
        </div>
      </Fieldset>
    </WordDialog>
  );
}

const SORTS = [['author', 'Sort by Author'], ['tag', 'Sort by Tag'], ['title', 'Sort by Title'], ['year', 'Sort by Year']];
const rowText = (s) => (s.placeholder ? s.tag : [s.authors.join('; '), s.title].filter(Boolean).join('; ') + (s.year ? ` (${s.year})` : ''));
const fold = (t) => String(t ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** One of Source Manager's two lists: `marks` per source id ('✓' cited, '?' placeholder). */
function SourceList({ id, label, items, at, onPick, onOpen, marks = {}, children }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2">{label}{children}</div>
      <div role="listbox" aria-label={id === 'master' ? 'Master List' : 'Current List'} data-list={id} className="h-44 overflow-auto rounded-md border text-xs">
        {items.map((s) => (
          <div key={s.id} role="option" data-source={s.id} aria-selected={s.id === at} onClick={() => onPick(s.id)} onDoubleClick={() => onOpen(s)}
            className={cn('flex cursor-default gap-1.5 px-1.5 py-0.5', rowClass(s.id === at))}>
            <span className="w-3 shrink-0 text-center">{marks[s.id] ?? ''}</span>
            <span className="truncate">{rowText(s)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Source Manager (Manage Sources): the master list (the word store's 'sources', every draft's) and the current list (this
 * draft's), Copy between them, Delete, Edit..., New..., a search, the sort and a preview in the current style. On a canvas draft
 * (`engine`: {list, save, remove}, canvas/rows/references.mjs) the current list is the document's own sources in the engine. */
export function SourceManager({ engine = null, onClose }) {
  const draftList = useCurrent();
  const [own, setOwn] = useState(null);
  const reload = () => engine?.list().then(setOwn, () => setOwn({ sources: [], cited: [] }));
  useEffect(() => {
    reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const current = engine ? own?.sources ?? EMPTY : draftList;
  // The current list's writes: the engine's on a canvas draft (then read again), the draft's sources otherwise.
  const putSource = engine ? async (x, was = null) => {
    if (was && was !== x.tag) await engine.remove(was);
    await engine.save(x);
    await reload();
    return x;
  } : saveSource;
  const dropSource = engine ? async (id) => { await engine.remove(id); await reload(); } : removeSource;
  const forum = getState().draft?.format !== 'document';
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [master, setMaster] = useState(null);
  const [sel, setSel] = useState({ list: null, id: null });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('author');
  useEffect(() => {
    masterSources().then(setMaster, () => setMaster([]));
  }, []);
  const style = useStore((s) => styleOf(s.draft, s.settings, true));
  const doc = engine ? null : getState().editor?.state.doc;
  const cited = useMemo(() => new Set(engine ? own?.cited ?? [] : doc ? citedTags(doc) : []), [doc, current, own]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (list) => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    const key = (s) => (sort === 'tag' ? s.tag : sort === 'title' ? s.title : sort === 'year' ? s.year : s.authors.join('; ') || s.title) ?? '';
    return list.filter((s) => words.every((w) => fold([s.tag, s.title, ...s.authors, s.year].join(' ')).includes(w)))
      .sort((a, b) => String(key(a)).localeCompare(String(key(b)), undefined, { numeric: true, sensitivity: 'base' }));
  };
  const masterList = master ?? EMPTY;
  const picked = (sel.list === 'master' ? masterList : current).find((s) => s.id === sel.id) ?? null;
  const marks = Object.fromEntries(current.map((s) => [s.id, s.placeholder ? '?' : cited.has(s.tag) ? '✓' : '']));
  const writeMaster = async (list) => {
    setMaster(list);
    await saveMaster(list);
  };
  const guard = (fn) => () => Promise.resolve().then(fn).catch((e) => toast(e.message, true));
  const copy = guard(async () => {
    if (!picked) return;
    if (sel.list === 'master') {
      // Two current sources with one tag would leave their citations on whichever comes first (Word's prompt here unverified).
      if (current.some((s) => s.tag === picked.tag && s.id !== picked.id)) throw new Error('Another source in the current list already has this tag name.');
      await putSource({ ...picked });
    }
    else await writeMaster([...masterList.filter((s) => s.id !== picked.id), { ...picked, placeholder: undefined }]);
  });
  const remove = guard(async () => {
    if (!picked) return;
    if (sel.list === 'master') await writeMaster(masterList.filter((s) => s.id !== picked.id));
    else await dropSource(picked.id);
    setSel({ list: sel.list, id: null });
  });
  // Edit... changes the source in each list that holds it; New... adds it to both, as Word does.
  const edit = guard(async (s = picked) => {
    if (!s) return;
    const out = await openDialog('createSource', { source: s, title: 'Edit Source' });
    if (!out) return;
    if (current.some((x) => x.id === s.id)) await putSource(out, engine ? s.tag : undefined);
    if (masterList.some((x) => x.id === s.id)) await writeMaster(masterList.map((x) => (x.id === s.id ? { ...out, id: s.id } : x)));
  });
  const add = guard(async () => {
    const out = await openDialog('createSource', {});
    if (!out) return;
    const saved = await putSource(out);
    await writeMaster([...masterList, saved]);
  });
  // A forum post: the details of a pasted link, a DOI or an arXiv id fill a new Create Source.
  const lookUp = guard(async () => {
    if (busy || !link.trim()) return;
    setBusy(true);
    try {
      const { source, problem } = await lookupLink(link);
      if (problem) toast(problem);
      const out = await openDialog('createSource', { source, title: 'Create Source' });
      if (!out) return;
      await saveSource(out);
      setLink('');
    } finally {
      setBusy(false);
    }
  });
  const row = wordStyle(style);
  const preview = picked && !picked.placeholder && (() => {
    const list = current.some((s) => s.id === picked.id) ? current : [picked];
    // A forum post's citations are plain text with fixed numbers (labels); a Document numbers by first citation.
    const label = (forum ? labels(list, style) : wordLabels(list, style, [...cited])).get(picked.id) ?? '';
    return { cite: forum ? citation(picked, label, false, style) : wordCitation([{ s: picked, label }], style), entry: formatReference(picked, label, style) };
  })();
  const btn = (label, onClick, disabled) => (
    <Button type="button" variant="outline" size="xs" className="w-24" disabled={disabled} onClick={onClick} {...accessProps(label)}><span><AccessText label={label} /></span></Button>
  );
  return (
    <WordDialog title="Source Manager" size="lg" okText="Close" onClose={onClose} result={() => true}
      left={forum ? [{ label: 'Insert &Bibliography', disabled: !current.length, onClick: () => {
        onClose(true);
        insertReferenceList().catch((e) => toast(e.message, true));
      } }] : []}>
      {forum && (
        <div className="flex items-center gap-4">
          <ReferenceStyle />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Input size="xs" aria-label="Link, DOI or arXiv id" placeholder="Paste a link, DOI or arXiv id" className={cn(TEXT, 'min-w-0 flex-1')} value={link}
              disabled={busy} spellCheck={false} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault(); // Enter looks the link up instead of closing the dialog
                lookUp();
              }} />
            <Button type="button" variant="outline" size="xs" disabled={busy || !link.trim()} onClick={lookUp}>{busy && <Spinner />}Look up</Button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Row label="&Search:" htmlFor="sm-search">
          <Input id="sm-search" size="xs" className={cn(TEXT, 'w-64')} value={query} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        </Row>
        <Pick aria-label="Sort" value={sort} options={SORTS} onChange={setSort} width="10rem" />
      </div>
      <div className="flex gap-2">
        <SourceList id="master" label={<span {...accessProps('Sou&rces available in:')}><AccessText label="Sou&rces available in:" /> Master List</span>}
          items={shown(masterList)} at={sel.list === 'master' ? sel.id : null} onPick={(id) => setSel({ list: 'master', id })} onOpen={(s) => edit(s)}>
          <Button type="button" variant="outline" size="xs" disabled className="ml-auto" title="Not built yet.">Browse...</Button>
        </SourceList>
        <div className="flex flex-col justify-center gap-1.5">
          {btn(sel.list === 'current' ? '<- &Copy' : '&Copy ->', copy, !picked)}
          {/* A cited source stays: deleting it would turn its citations into "Invalid source specified.". */}
          {btn('&Delete', remove, !picked || (sel.list === 'current' && cited.has(picked.tag)))}
          {btn('&Edit...', () => edit(), !picked)}
          {btn('&New...', add, false)}
        </div>
        <SourceList id="current" label={<span {...accessProps('C&urrent List')}><AccessText label="C&urrent List" /></span>} items={shown(current)}
          at={sel.list === 'current' ? sel.id : null} onPick={(id) => setSel({ list: 'current', id })} onOpen={(s) => edit(s)} marks={marks} />
      </div>
      <Fieldset legend={`Preview (${row.label}):`} help="✓ cited source, ? placeholder source">
        <div data-source-preview className="min-h-14 rounded-md border bg-white p-2 text-xs text-black">
          {preview && (
            <>
              <p><span className="text-neutral-500">Citation: </span>{preview.cite}</p>
              <p className="mt-1"><span className="text-neutral-500">Bibliography Entry: </span>{preview.entry}</p>
            </>
          )}
        </div>
      </Fieldset>
    </WordDialog>
  );
}
