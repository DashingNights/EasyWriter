// The Find and Replace dialog (docs/plans/word/plan.md §3 find; probe/dialogs.md Find and Replace): tabs Find, Replace and Go To,
// modeless, so the text behind stays editable. WordDialog's frame with no footer, because Word's buttons here are Find Next, Replace
// and Go To and they sit in the body.
import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { NativeListBox } from '@/components/ui/select';
import { isMac } from '../../../app/keys.mjs';
import { Help } from '../../../app/components/Tip.jsx';
import { ctxOf, useWordCtx } from '../../../tooling/registry.js';
import { Check, Fieldset, Pick } from '../../../tooling/kit/controls.jsx';
import { accessOf } from '../../../tooling/kit/access.mjs';
import { AccessText, accessProps, TabStack, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import {
  clearHighlight, DONE, endSearch, findIn, findNext, goTo, highlightAll, last, OPTION_KEYS, replaceEvery, replaceOne, storiesPresent,
} from './actions.js';
import { NAMED, namesOf, TARGETS } from './goto.mjs';
import { queryError } from './query.mjs';

// ---------- the lists of the Special menu (probe labels) ----------
const FIND_SPECIAL = [['Paragraph Mark', '^p'], ['Tab Character', '^t'], ['Any Character', '^?'], ['Any Digit', '^#'], ['Any Letter', '^$'],
  ['Caret Character', '^^'], ['§ Section Character', '^%'], ['¶ Paragraph Character', '^v'], ['Column Break', '^n'], ['Em Dash', '^+'],
  ['En Dash', '^='], ['Endnote Mark', '^e'], ['Field', '^d'], ['Footnote Mark', '^f'], ['Graphic', '^g'], ['Manual Line Break', '^l'],
  ['Manual Page Break', '^m'], ['Nonbreaking Hyphen', '^~'], ['Nonbreaking Space', '^s'], ['Optional Hyphen', '^-'], ['Section Break', '^b'],
  ['White Space', '^w']];
const REPLACE_SPECIAL = [['Paragraph Mark', '^p'], ['Tab Character', '^t'], ['Caret Character', '^^'], ['§ Section Character', '^%'],
  ['¶ Paragraph Character', '^v'], ['Clipboard Contents', '^c'], ['Column Break', '^n'], ['Em Dash', '^+'], ['En Dash', '^='],
  ['Find What Text', '^&'], ['Manual Line Break', '^l'], ['Manual Page Break', '^m'], ['Nonbreaking Hyphen', '^~'], ['Nonbreaking Space', '^s'],
  ['Optional Hyphen', '^-']];
const WILD_CODES = [['Tab Character', '^t'], ['Caret Character', '^^'], ['§ Section Character', '^%'], ['¶ Paragraph Character', '^v'],
  ['Column Break', '^n'], ['Em Dash', '^+'], ['En Dash', '^='], ['Manual Line Break', '^l'], ['Manual Page Break / Section Break', '^m'],
  ['Nonbreaking Hyphen', '^~'], ['Nonbreaking Space', '^s'], ['Optional Hyphen', '^-']];
const FIND_WILD = [['Any Character', '?'], ['Range of Characters', '[-]'], ['Beginning of Word', '<'], ['End of Word', '>'], ['Expression', '()'],
  ['Not', '[!]'], ['Num Occurrences', '{,}'], ['Previous 1 or More', '@'], ['0 or More Characters', '*'], null, ...WILD_CODES];
const REPLACE_WILD = [['Find What Expression', '\\1'], null, ...WILD_CODES.filter(([, c]) => c !== '^m'), ['Manual Page Break', '^m'], ['Clipboard Contents', '^c'], ['Find What Text', '^&']];

const OPTION_LABELS = {
  matchCase: 'Matc&h case', wholeWord: 'Find whole words onl&y', wildcards: '&Use wildcards', soundsLike: 'Sounds li&ke (English)',
  allForms: 'Find all &word forms (English)', prefix: 'Match prefi&x', suffix: 'Ma&tch suffix', widthForms: 'Match half/full width for&ms',
  ignorePunct: 'Ignore punctuation character&s', ignoreSpace: 'Ignore white-sp&ace characters',
};
const OPTION_SHORT = {
  matchCase: 'Match Case', wholeWord: 'Whole Words', wildcards: 'Use Wildcards', soundsLike: 'Sounds Like', allForms: 'All Word Forms',
  prefix: 'Match Prefix', suffix: 'Match Suffix', widthForms: 'Match Width', ignorePunct: 'Ignore Punctuation', ignoreSpace: 'Ignore White Space',
};
const SEARCH = [['down', 'Down'], ['up', 'Up'], ['all', 'All']];
const MARK_NAMES = { bold: 'Bold', italic: 'Italic', underline: 'Underline', strike: 'Strikethrough', subscript: 'Subscript', superscript: 'Superscript' };

/** The Format line under a box: 'Font: Bold, Not Italic, Highlight, Style: Heading 1'. */
export function describeFormat(f) {
  if (!f) return '';
  const run = Object.entries(f.run ?? {}).filter(([, v]) => v != null)
    .map(([k, v]) => (MARK_NAMES[k] ? (v === false ? `Not ${MARK_NAMES[k]}` : MARK_NAMES[k]) : `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`));
  const para = Object.keys(f.para ?? {}).filter((k) => f.para[k] != null);
  return [run.length && `Font: ${run.join(', ')}`, para.length && `Paragraph: ${para.join(', ')}`, f.lang && `Language: ${f.lang}`,
    f.highlight === true && 'Highlight', f.highlight === false && 'Not Highlight', f.style && `Style: ${f.style}`].filter(Boolean).join(', ');
}

const empty = (f) => !describeFormat(f);
// Where the value of each Format dialog goes in a format.
const FORMAT_DIALOGS = [['font', 'Font...'], ['paragraph', 'Paragraph...'], ['tabs', 'Tabs...'], ['language', 'Language...'], ['frame', 'Frame...']];
function mergeFormat(f, id, v) {
  const next = { ...f };
  if (id === 'font') next.run = { ...f?.run, ...(v.run ?? v) };
  else if (id === 'paragraph') next.para = { ...f?.para, ...(v.para ?? v) };
  else if (id === 'tabs') next.para = { ...f?.para, tabs: Array.isArray(v) ? v : v.tabs ?? v.para?.tabs };
  else if (id === 'frame') next.para = { ...f?.para, frame: v.frame ?? v };
  else if (id === 'language') {
    const lang = typeof v === 'string' ? v : v.run?.lang ?? v.lang ?? v;
    next.lang = (typeof lang === 'string' ? lang : lang?.val) ?? null;
  }
  return next;
}

/** The half of format `f` that Format dialog `id` edits (§1.6 value mode), so it opens on what the box already holds. */
function formatValue(f, id) {
  if (id === 'font') return f?.run ?? null;
  if (id === 'paragraph') return f?.para ?? null;
  if (id === 'tabs') return f?.para?.tabs ? { tabs: f.para.tabs } : null;
  if (id === 'frame') return f?.para?.frame ? { frame: f.para.frame } : null;
  return f?.lang ? { lang: { val: f.lang } } : null; // language: the run's lang
}

let live = null; // the open dialog's {setTab, seed}, so a second Ctrl+H switches tabs instead of opening another

/** Opens Find and Replace on `tab` ('find', 'replace', 'goTo'), or switches the open one to it; `seed` is the selected text. */
export function openFindDialog(ctx, tab, seed) {
  if (live) live.show(tab, seed);
  else ctx.dialog('findAndReplace', { tab, seed });
}

/** The selection's text when it is one short line (Word seeds Find what with it), else null. */
export function selectionSeed(state) {
  if (!state || state.selection.empty) return null;
  const t = state.doc.textBetween(state.selection.from, state.selection.to, '\n');
  return t && !t.includes('\n') && t.length <= 255 ? t : null;
}

// Find In's places (the engine's edit.findInPlaces) as Word's menu names them, with the access keys the probe shows (probe
// dialogs.md, Menu "Find In"). ponytail: the probe's document had no headers, endnotes or comments, so those three have no key.
const IN_LABELS = { selection: 'Current &Selection', main: '&Main Document', headers: 'Headers and Footers', footnotes: '&Footnotes',
  endnotes: 'Endnotes', comments: 'Comments', textBoxes: '&Text Boxes in Main Document' };

function Menu({ label, items, onPick, disabled, onOpen }) {
  const [open, setOpen] = useState(false);
  // An item's access key picks it while the menu is open, as in Word's menus; the key goes no further, so the dialog's own
  // access keys (WordDialog) do not press a button behind the menu.
  const press = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || isMac()) return;
    const hit = items.find((it) => it && !it[2] && accessOf(it[0]).key === e.key.toLowerCase());
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    onPick(hit[1]);
  };
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={(o) => {
      setOpen(o);
      if (o) onOpen?.();
    }}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button type="button" variant="outline" size="sm" {...accessProps(label)}><AccessText label={label} /> ▾</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-80 overflow-auto" data-find-menu="" onKeyDown={press}>
        {items.map((it, i) => (it ? (
          <DropdownMenuItem key={it[0]} disabled={it[2]} onSelect={() => onPick(it[1])}><AccessText label={it[0]} /></DropdownMenuItem>
        ) : <DropdownMenuSeparator key={`s${i}`} />))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const Btn = ({ label, onClick, disabled, primary, ...props }) => (
  <Button type="button" variant={primary ? 'default' : 'outline'} size="sm" className="min-w-24" disabled={disabled} onClick={onClick} {...accessProps(label)} {...props}>
    <AccessText label={label} />
  </Button>
);

/** Find and Replace ({tab, seed, onClose}). */
export function FindDialog({ tab: first = 'find', seed, onClose }) {
  const ctx = useWordCtx();
  const settings = ctx.settings?.word?.find ?? {};
  const [tab, setTab] = useState(first);
  const [query, setQuery] = useState(seed ?? last.query);
  const [replace, setReplace] = useState(last.replace);
  const [opts, setOpts] = useState(() => last.opts ?? Object.fromEntries(OPTION_KEYS.map((k) => [k, !!settings[k]])));
  const [search, setSearch] = useState(last.search);
  const [format, setFormat] = useState(last.format);
  const [replaceFormat, setReplaceFormat] = useState(last.replaceFormat);
  const [more, setMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [status, setStatus] = useState('');
  const [stylePick, setStylePick] = useState(null);
  const [target, setTarget] = useState(last.target);
  const [box, setBox] = useState('');
  // On a canvas draft the engine says where Find In can look (edit.findInPlaces), read again each time the menu opens.
  const [places, setPlaces] = useState(null);
  const readPlaces = () => {
    const engine = ctxOf().engine;
    if (engine) Promise.resolve(engine.query('edit.findInPlaces')).then((r) => setPlaces(r?.value?.places ?? null), () => {});
  };
  useEffect(readPlaces, []);
  const root = useRef(null);
  const findBox = useRef(null);
  const focused = useRef('find'); // the box Format, Special and No Formatting act on

  // Every change goes into `last` at once, so Shift+F4 and browse repeat what the dialog shows.
  Object.assign(last, { query, replace, opts, search, format, replaceFormat });

  useEffect(() => {
    live = {
      show: (t, s) => {
        setTab(t);
        if (s) setQuery(s);
        requestAnimationFrame(() => root.current?.querySelector(t === 'goTo' ? '[data-goto-box]' : '[data-find-box]')?.select());
      },
    };
    requestAnimationFrame(() => root.current?.querySelector(first === 'goTo' ? '[data-goto-box]' : '[data-find-box]')?.select());
    return () => {
      live = null;
      endSearch(ctxOf()); // the current match's mark goes, and edits stop re-running the search
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const s = () => ({ ...last, query, replace, opts, search, format, replaceFormat });
  const report = (r) => {
    setSearched(true);
    if (r?.error) setStatus(r.error);
    else if (r?.none) setStatus('No matches found.');
    else if (r?.done) setStatus(DONE);
    else setStatus(typeof r === 'string' ? r : '');
  };
  const now = () => ctxOf(); // the ctx at the click, not the render's
  const doFind = async () => report(await findNext(now(), { s: s() }));
  const doReplace = async () => report(await replaceOne(now(), s()));
  const doReplaceAll = async () => {
    const r = await replaceEvery(now(), s());
    report(typeof r === 'number' ? '' : r);
  };
  const doGoTo = (dir) => {
    const r = goTo(now(), target, box, dir);
    report(r === true ? '' : r);
  };
  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));
  const error = query ? queryError(query, { codes: true, ...opts }) : null;
  const canFind = !!(query || !empty(format)) && !error;
  const doc = ctx.state?.doc;
  const stories = doc ? storiesPresent(doc) : new Set();
  const hasSel = !!ctx.state && !ctx.state.selection.empty;

  const TABS = [{ id: 'find', label: 'Fin&d' }, { id: 'replace', label: 'Re&place' }, { id: 'goTo', label: '&Go To' }].map((t) => ({ ...t, attrs: { 'data-tab': t.id } }));

  // ---------- Format, Special, No Formatting ----------
  const setBoxFormat = (fn) => (focused.current === 'replace' && tab === 'replace' ? setReplaceFormat(fn) : setFormat(fn));
  const pickFormat = async (id) => {
    if (id === 'style') {
      setStylePick(focused.current === 'replace' && tab === 'replace' ? 'replace' : 'find');
      return;
    }
    if (id === 'highlight') {
      setBoxFormat((f) => ({ ...f, highlight: f?.highlight == null ? true : f.highlight ? false : null }));
      return;
    }
    const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js');
    if (!WORD_DIALOGS[id]) {
      now().toast(`The ${FORMAT_DIALOGS.find(([x]) => x === id)[1].replace('...', '')} dialog is not built yet.`);
      return;
    }
    const toReplace = focused.current === 'replace' && tab === 'replace';
    const v = await now().dialog(id, { mode: 'value', value: formatValue(toReplace ? replaceFormat : format, id) });
    if (v) (toReplace ? setReplaceFormat : setFormat)((f) => mergeFormat(f, id, v));
  };
  const insertCode = (code) => {
    const input = root.current.querySelector(focused.current === 'replace' && tab === 'replace' ? '[data-replace-box]' : '[data-find-box]');
    const set = focused.current === 'replace' && tab === 'replace' ? setReplace : setQuery;
    const v = input?.value ?? '';
    const a = input?.selectionStart ?? v.length;
    const b = input?.selectionEnd ?? v.length;
    set(v.slice(0, a) + code + v.slice(b));
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(a + code.length, a + code.length);
    });
  };
  const styles = doc ? [...new Set(['Normal', 'Heading1', 'Heading2', 'Heading3', ...Object.keys(doc.attrs.styles?.list ?? {})])] : ['Normal'];

  const optionsLine = [`Search ${SEARCH.find(([v]) => v === search)[1]}`, ...OPTION_KEYS.filter((k) => opts[k]).map((k) => OPTION_SHORT[k])].join(', ');
  const findRow = (
    <>
      <div className="grid grid-cols-[7rem_1fr] items-center gap-x-2 gap-y-1">
        <label htmlFor="find-what" {...accessProps('Fi&nd what:')}><AccessText label="Fi&nd what:" /></label>
        <Input size="xs" id="find-what" data-find-box="" maxLength={255} value={query} spellCheck={false} onFocus={() => { focused.current = 'find'; }}
          onChange={(e) => { setQuery(e.target.value); setSearched(false); setStatus(''); }} ref={findBox} />
        <span className="text-muted-foreground">Options:</span>
        <span data-find-options="" className="truncate">{optionsLine}</span>
        {!empty(format) && <><span className="text-muted-foreground">Format:</span><span data-find-format="">{describeFormat(format)}</span></>}
        {tab === 'replace' ? (
          <>
            <label htmlFor="replace-with" className="mt-2" {...accessProps('Replace w&ith:')}><AccessText label="Replace w&ith:" /></label>
            <Input size="xs" id="replace-with" data-replace-box="" maxLength={255} value={replace} spellCheck={false} onFocus={() => { focused.current = 'replace'; }}
              onChange={(e) => setReplace(e.target.value)} className="mt-2" />
            {!empty(replaceFormat) && <><span className="text-muted-foreground">Format:</span><span data-replace-format="">{describeFormat(replaceFormat)}</span></>}
          </>
        ) : <div aria-hidden className="col-span-2 mt-2 h-6" /> /* Word's Find tab keeps the Replace row's room, so its buttons sit where Replace's do */}
      </div>
      {stylePick && (
        <div className="flex items-center gap-2">
          <span>Find Style:</span>
          <Pick value="" options={[['', 'Pick a style'], ...styles.map((id) => [id, id])]} onChange={(v) => {
            if (v) (stylePick === 'replace' ? setReplaceFormat : setFormat)((f) => ({ ...f, style: v }));
            setStylePick(null);
          }} />
        </div>
      )}
    </>
  );
  const moreButton = <Btn label={more ? '<< &Less' : '&More >>'} onClick={() => setMore(!more)} />;
  const closeLabel = searched ? 'Close' : 'Cancel';
  const wild = opts.wildcards;
  const morePanel = more && (
    <div className="flex flex-col gap-2">
      <Fieldset legend="Search Options">
        <label className="flex items-center gap-2" {...accessProps('Search&:')}>
          <AccessText label="Search&:" />
          <Pick value={search} options={SEARCH} onChange={setSearch} width="6rem" />
        </label>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
          <div className="flex flex-col gap-1">
            {['matchCase', 'wholeWord', 'wildcards', 'soundsLike', 'allForms'].map((k) => (
              <Check key={k} label={OPTION_LABELS[k]} checked={opts[k]} onChange={(v) => setOpt(k, v)}
                disabled={(wild && (k === 'matchCase' || k === 'wholeWord')) || ((opts.soundsLike || opts.allForms) && k === 'wildcards')
                  || (wild && (k === 'soundsLike' || k === 'allForms')) || (k === 'soundsLike' && opts.allForms) || (k === 'allForms' && opts.soundsLike)} />
            ))}
          </div>
          <div className="flex flex-col gap-1">
            {['prefix', 'suffix', 'widthForms', 'ignorePunct', 'ignoreSpace'].map((k) => (
              <Check key={k} label={OPTION_LABELS[k]} checked={opts[k]} onChange={(v) => setOpt(k, v)} disabled={wild} />
            ))}
          </div>
        </div>
      </Fieldset>
      <Fieldset legend={tab === 'replace' ? 'Replace' : 'Find'}>
        <div className="flex gap-2">
          <Menu label="F&ormat" onPick={pickFormat}
            items={[...FORMAT_DIALOGS.map(([id, label]) => [label, id]), ['Style...', 'style'], ['Highlight', 'highlight']]} />
          <Menu label="Sp&ecial" onPick={insertCode}
            items={(focused.current === 'replace' && tab === 'replace' ? (wild ? REPLACE_WILD : REPLACE_SPECIAL) : (wild ? FIND_WILD : FIND_SPECIAL)).map((x) => x && [x[0], x[1]])} />
          <Btn label="No Forma&tting" disabled={empty(format) && empty(replaceFormat)} onClick={() => setBoxFormat(() => null)} />
        </div>
      </Fieldset>
    </div>
  );

  const findTab = (
    <>
      {findRow}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto">{moreButton}</span>
        {tab === 'find' ? (
          <>
            <Menu label="&Reading Highlight" disabled={!canFind}
              items={[['Highlight All', 'all'], ['Clear Highlighting', 'clear']]}
              onPick={(v) => report(v === 'all' ? highlightAll(now(), s()) : clearHighlight(now()))} />
            <Menu label="F&ind In" disabled={!canFind} onOpen={readPlaces}
              items={places ? places.map((p) => [IN_LABELS[p] ?? p, p]) : [hasSel && ['Current Selection', 'selection'], ['Main Document', 'main'],
                stories.has('headers') && ['Headers and Footers', 'headers'], stories.has('footnotes') && ['Footnotes', 'footnotes'],
                stories.has('endnotes') && ['Endnotes', 'endnotes'], stories.has('comments') && ['Comments', 'comments']].filter(Boolean)}
              onPick={async (v) => report(await findIn(now(), v, s()))} />
          </>
        ) : (
          <>
            <Btn label="&Replace" disabled={!canFind} onClick={doReplace} />
            <Btn label="Replace &All" disabled={!canFind} onClick={doReplaceAll} />
          </>
        )}
        <Btn label="&Find Next" primary disabled={!canFind} onClick={doFind} />
        <Btn label={closeLabel} onClick={() => onClose(null)} />
      </div>
      {morePanel}
    </>
  );

  const named = NAMED.has(target);
  const boxLabel = TARGETS.find(([id]) => id === target)[2];
  const names = named && doc ? namesOf(doc, target) : [];
  const goToTab = (
    <>
      <div className="grid grid-cols-[13rem_1fr] gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="goto-list" {...accessProps('G&o to what:')}><AccessText label="G&o to what:" /></label>
          <NativeListBox id="goto-list" data-goto-list="" size={8} value={target} options={TARGETS} onChange={(e) => { setTarget(e.target.value); setBox(''); }} />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <label htmlFor="goto-box" {...accessProps(`&${boxLabel}`)}><AccessText label={`&${boxLabel}`} /></label>
            <Help>Type + or - and a number to move from where you are. +4 goes four {target === 'page' ? 'pages' : 'items'} forward.</Help>
          </div>
          <Input size="xs" id="goto-box" data-goto-box="" list={named ? 'goto-names' : undefined} value={box} onChange={(e) => setBox(e.target.value)} />
          {named && <datalist id="goto-names">{names.map((n) => <option key={n} value={n} />)}</datalist>}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Btn label="Previou&s" onClick={() => doGoTo(-1)} />
        <Btn label={box ? 'Go &To' : 'Nex&t'} primary onClick={() => doGoTo(1)} />
        <Btn label="Close" onClick={() => onClose(null)} />
      </div>
    </>
  );

  // Find and Replace share one body (Find keeps the Replace row's room); Go To has its own. Both are held to the taller one's height.
  const bodies = [{ id: 'find', render: () => findTab }, { id: 'goTo', render: () => goToTab }];

  return (
    <WordDialog id="findAndReplace" title="Find and Replace" size="wide" modeless rootRef={root} tabs={TABS} tab={tab} onTab={setTab} buttons={[]} onClose={onClose}
      onEnter={() => { if (tab === 'goTo') doGoTo(1); else if (canFind) doFind(); }}>
      <TabStack tabs={bodies} shown={bodies[tab === 'goTo' ? 1 : 0]} />
      <p role="status" data-find-status="" className={cn('min-h-5', error || status.includes('not') ? 'text-destructive' : 'text-muted-foreground')}>
        {error ?? status}
      </p>
    </WordDialog>
  );
}

// The browse object picker's kinds, in Word's order (Go To and Find open the dialog; Edits steps through revisionsOf).
const BROWSE = [['goTo', 'Go To'], ['find', 'Find'], ['edits', 'Edits'], ['heading', 'Heading'], ['graphic', 'Graphic'], ['table', 'Table'],
  ['field', 'Field'], ['endnote', 'Endnote'], ['footnote', 'Footnote'], ['comment', 'Comment'], ['section', 'Section'], ['page', 'Page']];

/** Browse by (Ctrl+Alt+Home): picks what Ctrl+PageDown and Ctrl+PageUp step through → the kind's id. */
export function BrowsePicker({ onClose }) {
  return (
    <WordDialog title="Browse by" size="sm" onClose={onClose} result={() => null}>
      <div className="grid grid-cols-3 gap-2" data-browse-picker="">
        {BROWSE.map(([id, label]) => (
          <Button key={id} type="button" variant={last.kind === id ? 'default' : 'outline'} size="sm" data-browse={id} onClick={() => onClose(id)}>{label}</Button>
        ))}
      </div>
    </WordDialog>
  );
}
