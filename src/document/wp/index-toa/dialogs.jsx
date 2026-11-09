// The index-toa dialogs (docs/plans/word/plan.md §1.6, probe/dialogs/mark-index-entry.json, index.json, mark-citation.json and
// table-of-authorities.json): Mark Index Entry and Mark Citation (they stay open to mark more), the Index and Table of Authorities
// tabs of Word's four-tab dialog, and the child dialogs AutoMark, the style list behind Modify... and Category....
import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { Input } from '@/components/ui/input';
import { NativeListBox } from '@/components/ui/select';
import { openDialog } from '../../../app/actions.js';
import { getState } from '../../../app/store.js';
import { Check, Fieldset, Pick, Preview, Radio, Row, Spin, TextArea } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, TabStrip, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { ensureStyles } from '../../model/styles.mjs';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { docOfDraft } from '../../docx/files.js';
import { insertBlocks, insertHidden, mainEditor, showMarks, taEntries } from './index.js';
import { buildIndex, buildToa, categoryName, CITATION, concordanceRows, INDEX_FORMATS, LANGUAGES, levelsOf, markAllHits, STYLES, taCode, xeCode } from './index.mjs';

// The dialog registry imports the hub that imports this module, so it is read once the bundle has loaded, never at import.
let registry = {};
import('../../../tooling/dialogs.js').then((m) => { registry = m.WORD_DIALOGS; });
const isDialog = (id) => !!registry[id];

// Word's four-tab dialog (plan.md §1.6): the same strip in index, tableOfContents, tableOfFigures and tableOfAuthorities.
const INDEX_TABS = [['index', 'Inde&x'], ['tableOfContents', 'Table of &Contents'],
  ['tableOfFigures', 'Table of &Figures'],
  ['tableOfAuthorities', 'Table of &Authorities']];

/** The tab strip: another package's tab closes this dialog and opens its own; an unregistered one is disabled. */
function IndexTabs({ current, onClose }) {
  const go = (id) => {
    if (id === current) return;
    onClose(null);
    openDialog(id);
  };
  return <TabStrip value={current} onChange={go} tabs={INDEX_TABS.map(([id, label]) => ({ id, label, disabled: id !== current && !isDialog(id), attrs: { 'data-tab': id } }))} />;
}

/** A list box (a native select drawn open). The kit's ListPick is not used here: its scroll effect returns what scrollIntoView
 * returns, a Promise in this Chromium, and React then fails on unmount (reported to the integrator). */
const ListBox = ({ items, value, onChange, height, ...props }) => (
  <NativeListBox size={2} style={{ height }} options={items} value={String(value ?? '')} {...props}
    onChange={(e) => onChange(items.find(([v]) => String(v) === e.target.value)?.[0] ?? null)} />
);

/** A labelled text box. */
const Text = ({ label, id, value, onChange, disabled, readOnly }) => (
  <Row label={label} htmlFor={id}>
    <Input id={id} size="xs" className="flex-1" spellCheck={false} value={value} disabled={disabled} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />
  </Row>
);

// Each textblock of `doc` with its text, one character per position (inline atoms as U+FFFC), for Mark All and Next Citation.
// Generated results (INDEX, TOA, TOC blocks) are skipped: a mark there is lost on the next update and counts the table's own page.
function parasOf(doc) {
  const out = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'fieldBlock') return false;
    if (!n.isTextblock) return true;
    let text = '';
    n.forEach((c) => { text += c.isText ? c.text : '￼'.repeat(c.nodeSize); });
    out.push({ pos: pos + 1, text });
    return false;
  });
  return out;
}
const selected = (ed) => (ed ? ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to, ' ', '').trim() : '');

/** Inserts the hidden field codeOf(hit) after each hit, last first, as one undo step. → the count. */
function markAt(ed, hits, codeOf) {
  if (!hits.length) return 0;
  const tr = ed.state.tr;
  for (const h of [...hits].sort((a, b) => b.to - a.to)) insertHidden(ed, codeOf(h), h.to, tr);
  ed.view.dispatch(tr);
  showMarks();
  return hits.length;
}

/** The selection's text as the dialog opens and whenever the user selects other text while it stays open (it is modeless). On a
 * canvas draft `engine.watch(fn)` follows the engine's selection (the row's: canvas/rows/references.mjs). */
function useSelectedText(onText, engine = null) {
  useEffect(() => {
    if (engine?.watch) return engine.watch(onText);
    const ed = mainEditor();
    if (!ed) return undefined;
    const fn = () => { const s = selected(ed); if (s) onText(s); };
    ed.on('selectionUpdate', fn);
    return () => ed.off('selectionUpdate', fn);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------- Mark Index Entry ----------

// On a canvas draft (`engine`: {text: the selected text, mark(params)}) Mark and Mark All write through the engine's
// references.markEntry; the readings (Heading boxes) and the page range bookmark list are not on the canvas yet.
function MarkIndexEntry({ engine = null, onClose }) {
  const ed = mainEditor();
  const first = engine ? engine.text : selected(ed);
  const [text, setText] = useState(first);
  const [marked, setMarked] = useState(false);
  const [v, setV] = useState(() => ({ main: first, sub: '', yomi: '', subYomi: '', option: 'page', cross: 'See ', bookmark: '', bold: false, italic: false }));
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  useSelectedText((s) => { setText(s); setV((o) => ({ ...o, main: s })); }, engine);
  const bookmarks = ed ? [...new Set(collect(ed.state.doc, 'bookmark').filter((n) => !n.attrs.end && n.attrs.name).map((n) => n.attrs.name))] : [];
  const code = () => xeCode({ main: v.main.trim(), sub: v.sub.trim(), yomi: v.yomi.trim(), subYomi: v.subYomi.trim(), cross: v.option === 'cross' ? v.cross : null,
    bookmark: v.option === 'range' ? v.bookmark : null, bold: v.bold, italic: v.italic });
  const params = (all) => ({ entry: v.main.trim(), ...(v.sub.trim() && { subentry: v.sub.trim() }), ...(v.option === 'cross' && { crossReference: v.cross }),
    ...(v.option === 'range' && { bookmark: v.bookmark }), bold: v.bold, italic: v.italic, ...(all && { all: true }) });
  const mark = () => {
    if (!v.main.trim()) return 'Type the main entry.';
    if (v.option === 'range' && !v.bookmark) return 'Pick the bookmark that spans the pages.';
    if (engine) {
      // Marked only once the engine ran it: a refusal shows as a toast and the button keeps reading Cancel.
      engine.mark(params(false)).then((ok) => ok && setMarked(true));
      return true;
    }
    const at = ed.state.selection.to;
    markAt(ed, [{ to: at }], code);
    setMarked(true);
    return true; // stays open so that more entries can be marked: a true "message" draws nothing in the footer
  };
  const markAll = () => {
    if (engine) {
      engine.mark(params(true)).then((ok) => ok && setMarked(true));
      return;
    }
    const hits = markAllHits(parasOf(ed.state.doc), text);
    markAt(ed, hits, code);
    setMarked(true);
  };
  return (
    <WordDialog title="Mark Index Entry" size="md" modeless okText="&Mark" cancelText={marked ? 'Close' : 'Cancel'} validate={mark} onClose={onClose}
      help="This dialog box stays open so that you can mark multiple index entries."
      left={[{ label: 'Mark &All', onClick: markAll, disabled: !text }]}>
      <span hidden data-dialog-id="markIndexEntry" />
      <Fieldset legend="Index">
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <Text label="Main &entry:" id="xe-main" value={v.main} onChange={set('main')} />
          <Text label="&Heading:" id="xe-yomi" value={v.yomi} onChange={set('yomi')} />
          <Text label="&Subentry:" id="xe-sub" value={v.sub} onChange={set('sub')} />
          <Text label="Headin&g:" id="xe-sub-yomi" value={v.subYomi} onChange={set('subYomi')} />
        </div>
      </Fieldset>
      <Fieldset legend="Options">
        <Radio name="xe-option" value={v.option} onChange={set('option')}
          options={[['cross', '&Cross-reference:'], ['page', 'Current &page'], ['range', 'Page ra&nge']]} />
        <Input size="xs" aria-label="Cross-reference text" value={v.cross} disabled={v.option !== 'cross'} onChange={(e) => set('cross')(e.target.value)} />
        <Row label="Bookmark:" htmlFor="xe-bookmark">
          <Pick id="xe-bookmark" value={v.bookmark} disabled={v.option !== 'range'} onChange={set('bookmark')}
            options={[['', ''], ...bookmarks.map((b) => [b, b])]} width="12rem" />
        </Row>
      </Fieldset>
      <Fieldset legend="Page number format">
        <Check label="&Bold" checked={v.bold} onChange={set('bold')} />
        <Check label="&Italic" checked={v.italic} onChange={set('italic')} />
      </Fieldset>
    </WordDialog>
  );
}

const collect = (doc, type) => {
  const out = [];
  doc.descendants((n) => { if (n.type.name === type) out.push(n); });
  return out;
};

// ---------- Index ----------

const LEADERS = [['none', '(none)'], ['dot', '.......'], ['hyphen', '-------'], ['underscore', '____'], ['middleDot', '·······']];
const FORMAT_LABELS = [['template', 'From template'], ['classic', 'Classic'], ['fancy', 'Fancy'], ['modern', 'Modern'], ['bulleted', 'Bulleted'], ['formal', 'Formal'], ['simple', 'Simple']];

/** The INDEX code the Index tab writes: by default `INDEX \c "2" \z "1033"`. */
export function indexCode({ runIn, columns, lcid, right, format }) {
  const p = INDEX_FORMATS[format] ?? {};
  let code = 'INDEX';
  if (runIn) code += ' \\r';
  if (p.h) code += ` \\h "${p.h}"`;
  if (right || p.right) code += ' \\e "\t"';
  if (columns) code += ` \\c "${columns}"`;
  return `${code} \\z "${lcid}"`;
}

// The Print Preview samples: Word's own sample words, with our builder drawing them.
const pg = (n) => ({ n, label: String(n) });
const SAMPLE = [
  { levels: ['Aristotle'], page: pg(2) }, { levels: ['Asteroid belt'], cross: 'See Jupiter' }, { levels: ['Atmosphere', 'Earth', 'exosphere'], page: pg(4) },
  { levels: ['Atmosphere', 'Earth', 'ionosphere'], page: pg(3) }, { levels: ['Atmosphere', 'Earth', 'mesosphere'], page: pg(3), to: pg(4) },
];
/** Block JSON drawn small: one line per paragraph, indented by its level, headings bold. */
const Blocks = ({ blocks }) => blocks.flatMap((b) => (b.type === 'columns' ? b.content : [b])).map((p, i) => {
  const level = Number(/\d$/.exec(p.attrs.styleId)?.[0] ?? 1);
  return (
    <div key={i} className={cn('flex text-[11px] leading-tight', /Heading/.test(p.attrs.styleId) && 'font-bold')} style={{ paddingLeft: `${(level - 1) * 0.75}rem` }}>
      {(p.content ?? []).map((r, k) => {
        const marks = new Set((r.marks ?? []).map((m) => m.type));
        const parts = r.text.split('\t');
        return parts.map((s, j) => (
          <span key={`${k}.${j}`} className={cn(j > 0 && 'ml-auto pl-1', marks.has('bold') && 'font-bold', marks.has('italic') && 'italic')}>{s || ' '}</span>
        ));
      })}
    </div>
  );
});

function IndexDialog({ onClose }) {
  const ed = mainEditor();
  const [v, setV] = useState({ runIn: false, columns: 2, lcid: 1033, right: false, leader: 'dot', format: 'template' });
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  const sample = buildIndex(SAMPLE, { ...(v.runIn ? { r: true } : {}), ...(INDEX_FORMATS[v.format].h ? { h: INDEX_FORMATS[v.format].h } : {}),
    ...(v.right || INDEX_FORMATS[v.format].right ? { e: '\t' } : {}) });
  const ok = () => {
    if (!ed) return { ...v }; // a canvas draft: the command writes them through the engine
    insertBlocks(ed, [indexCode(v)], 'INDEX', v.right ? { id: 'Index1', leader: v.leader } : null);
    return true;
  };
  return (
    <WordDialog title="Index" size="lg" onClose={(r) => onClose(r ? ok() : null)} result={() => true}
      left={[{ label: 'Mar&k Entry...', onClick: () => openDialog('markIndexEntry') }, { label: 'A&utoMark...', onClick: () => openDialog('indexAutoMark') },
        { label: '&Modify...', onClick: () => openDialog('indexStyles', { ids: Array.from({ length: 9 }, (_, i) => `Index${i + 1}`) }) }]}>
      <span hidden data-dialog-id="index" />
      <IndexTabs current="index" onClose={onClose} />
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <span>Print Preview</span>
          <Preview height="10rem"><Blocks blocks={sample} /></Preview>
          <Check label="&Right align page numbers" checked={v.right} onChange={set('right')} />
          <Row label="Ta&b leader:" htmlFor="ix-leader">
            <Pick id="ix-leader" value={v.leader} disabled={!v.right} options={LEADERS} onChange={set('leader')} />
          </Row>
          <Row label="Forma&ts:" htmlFor="ix-format"><Pick id="ix-format" value={v.format} options={FORMAT_LABELS} onChange={set('format')} /></Row>
        </div>
        <div className="flex flex-col gap-2">
          <span>Type:</span>
          <Radio name="ix-type" value={v.runIn} onChange={set('runIn')} options={[[false, 'In&dented'], [true, 'Ru&n-in']]} />
          <Spin label="C&olumns:" unit="int" value={v.columns} onChange={set('columns')} min={1} max={4} auto="Auto" width="5rem" />
          <Row label="&Language:" htmlFor="ix-lang"><Pick id="ix-lang" value={v.lcid} options={LANGUAGES} onChange={set('lcid')} /></Row>
        </div>
      </div>
    </WordDialog>
  );
}

/** AutoMark: a concordance from a Document draft's first two-column table or a tab- or comma-separated file; marks each occurrence
 * (the same case, the whole text, the first per paragraph; unverified) with its entry. → the count marked. */
function AutoMark({ onClose }) {
  const drafts = (getState().drafts ?? []).filter((d) => (d.format ?? 'document') === 'document' && d.id !== getState().draft?.id);
  const [id, setId] = useState(drafts[0]?.id ?? '');
  const [error, setError] = useState('');
  const apply = (rows) => {
    const ed = mainEditor();
    if (!ed || !rows.length) return 0;
    const paras = parasOf(ed.state.doc);
    const hits = rows.flatMap((r) => markAllHits(paras, r.text).map((h) => ({ ...h, entry: r.entry })));
    // "Main:Sub" in the entry column is a subentry, as in Word's AutoMark file.
    // ponytail: levels past the second are dropped, as Mark Index Entry writes two; carry them if a concordance needs three.
    return markAt(ed, hits, (h) => { const [main, sub = ''] = levelsOf(h.entry); return xeCode({ main, sub }); });
  };
  const fromDraft = async () => {
    const doc = await docOfDraft(await window.api.drafts.load(id)); // a canvas draft's through the engine (engine-canvas-read)
    const table = doc && findTable(doc);
    if (!table) return null;
    return table.content.map((row) => (row.content ?? []).map((c) => textOf(c).trim())).filter((r) => r.length >= 2 && r[0])
      .map(([text, entry]) => ({ text, entry: entry || text }));
  };
  const fromFile = async () => {
    const f = await window.api.word.openFile({ filters: [{ name: 'Text', extensions: ['txt', 'csv', 'tsv'] }], as: 'text' });
    if (f) onClose(apply(concordanceRows(f.data)));
  };
  const ok = async () => {
    const rows = await fromDraft();
    if (!rows) return setError('That draft has no two-column table.');
    onClose(apply(rows));
  };
  return (
    <WordDialog title="Open Index AutoMark File" size="sm" onClose={(r) => (r ? ok() : onClose(null))} result={() => true}
      help="The first table's first column holds the text to mark and the second its entry."
      left={[{ label: '&Browse...', onClick: fromFile }]}>
      <span hidden data-dialog-id="indexAutoMark" />
      <Row label="&Draft:" htmlFor="am-draft">
        <Pick id="am-draft" value={id} options={drafts.map((d) => [d.id, d.title || 'Untitled'])} onChange={setId} width="16rem" />
      </Row>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </WordDialog>
  );
}
const findTable = (j) => (j.type === 'table' ? j : (j.content ?? []).reduce((hit, c) => hit ?? findTable(c), null));
const textOf = (j) => (j.text ?? '') + (j.content ?? []).map(textOf).join(j.type === 'tableCell' || j.type === 'tableHeader' ? ' ' : '');

const STYLE_LABELS = { IndexHeading: 'Index Heading', TableofAuthorities: 'Table of Authorities', TOAHeading: 'TOA Heading' };

/** The styles behind Modify...: pick one and open Modify Style on it (styles' dialog; disabled until it is registered). */
function StyleList({ ids, onClose }) {
  const [id, setId] = useState(ids[0]);
  const modify = async () => {
    const ed = mainEditor();
    const styles = ed && ensureStyles(ed.state.doc, STYLES);
    if (styles) ed.view.dispatch(ed.state.tr.setDocAttribute('styles', styles));
    await openDialog('modifyStyle', { styleId: id });
  };
  return (
    <WordDialog title="Style" size="sm" onClose={onClose} result={() => id}
      left={[{ label: '&Modify...', onClick: modify, disabled: !isDialog('modifyStyle') }]}>
      <span hidden data-dialog-id="indexStyles" />
      <p>Please select the appropriate style for your index or table entry</p>
      <ListBox items={ids.map((s) => [s, STYLE_LABELS[s] ?? s.replace(/(\d)$/, ' $1')])} value={id} onChange={setId} height="9rem" />
    </WordDialog>
  );
}

// ---------- Mark Citation ----------

const CATEGORIES = (names) => Array.from({ length: 16 }, (_, i) => [i + 1, categoryName(i + 1, names)]);

// On a canvas draft (`engine`: {text, known: the document's TA entries, watch, mark(params), next()}) Mark and Mark All write
// through references.markCitation with the long and short citations and the category (gap G47), and Next Citation selects
// through references.nextCitation (engine-gaps-rest).
function MarkCitation({ engine = null, onClose }) {
  const ed = mainEditor();
  const names = wordSettings(getState().settings).toaCategories;
  const first = engine ? engine.text : selected(ed);
  // long stays null until typed in, so the box follows the selection or a picked short citation.
  const [v, setV] = useState(() => ({ text: first, category: 1, short: first, long: null }));
  const [marked, setMarked] = useState(false);
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  useSelectedText((s) => setV((o) => ({ ...o, text: s, short: s, long: null })), engine);
  const setShort = (s) => setV((o) => ({ ...o, short: s, long: null }));
  const known = engine ? engine.known ?? [] : ed ? taEntries(ed.state.doc).filter((e) => e.long) : [];
  const picked = known.find((e) => e.short === v.short);
  const long = v.long ?? picked?.long ?? v.text;
  // The engine's references.markCitation params (a canvas draft): the long and short citations and the category.
  const engineMark = () => ({ entry: long.trim(), short: v.short.trim() || long.trim(), category: Number(v.category) || 1 });
  const mark = () => {
    if (!long.trim()) return 'Select or type the citation.';
    if (engine) {
      engine.mark({ ...engineMark(), shortOnly: !!picked && v.long == null }).then((ok) => ok && setMarked(true));
      return true;
    }
    const code = picked && v.long == null ? taCode({ short: v.short }) : taCode({ long: long.trim(), short: v.short.trim(), category: v.category });
    markAt(ed, [{ to: ed.state.selection.to }], () => code);
    setMarked(true);
    return true; // the dialog stays open to mark more
  };
  const markAll = () => {
    if (engine) {
      if (!long.trim()) return;
      engine.mark({ ...engineMark(), shortOnly: !!picked && v.long == null, all: true }).then((ok) => ok && setMarked(true));
      return;
    }
    const from = ed.state.selection.to;
    mark();
    const hits = markAllHits(parasOf(ed.state.doc), v.short.trim()).filter((h) => h.from >= from + 1);
    markAt(ed, hits, () => taCode({ short: v.short.trim() }));
    setMarked(true);
  };
  const next = () => {
    const { doc, selection } = ed.state;
    for (const p of parasOf(doc)) {
      const start = Math.max(0, selection.to - p.pos);
      if (start > p.text.length) continue;
      const m = CITATION.exec(p.text.slice(start));
      if (!m) continue;
      const from = p.pos + start + m.index + (m[0].startsWith(' ') ? 1 : 0);
      const to = p.pos + start + m.index + m[0].trimEnd().length;
      ed.commands.setTextSelection({ from, to });
      ed.commands.scrollIntoView();
      return;
    }
  };
  return (
    <WordDialog title="Mark Citation" size="md" modeless okText="&Mark" cancelText={marked ? 'Close' : 'Cancel'} validate={mark} onClose={onClose}
      left={[{ label: '&Next Citation', onClick: engine ? () => engine.next?.() : next, disabled: !!engine && !engine.next },
        { label: 'Mark &All', onClick: markAll, disabled: !v.short.trim() },
        { label: 'Cate&gory...', onClick: () => openDialog('toaCategory') }]}>
      <span hidden data-dialog-id="markCitation" data-marked={marked || undefined} />
      <Row label="Selec&ted text:" htmlFor="ta-text">
        <TextArea id="ta-text" rows={2} value={v.text} onChange={(e) => set('text')(e.target.value)} className="flex-1" />
      </Row>
      <Row label="&Category:" htmlFor="ta-cat"><Pick id="ta-cat" value={v.category} options={CATEGORIES(names)} onChange={set('category')} /></Row>
      <Row label="&Short citation:" htmlFor="ta-short">
        <div className="flex flex-1 flex-col">
          <Input id="ta-short" size="xs" spellCheck={false} value={v.short} onChange={(e) => setShort(e.target.value)} />
          <ListBox aria-label="Short citations" items={[...new Set(known.map((e) => e.short))].map((s) => [s, s])} value={v.short} onChange={setShort} height="4rem" />
        </div>
      </Row>
      <Text label="Long citation:" id="ta-long" value={long} onChange={set('long')} />
    </WordDialog>
  );
}

/** Category...: renames categories 8 to 16 (settings.word.toaCategories). */
function ToaCategory({ onClose }) {
  const [names, setNames] = useState(() => ({ ...wordSettings(getState().settings).toaCategories }));
  const [n, setN] = useState(8);
  const [text, setText] = useState(categoryName(8, names));
  const replace = () => setNames((o) => ({ ...o, [n]: text.trim() || undefined }));
  const pick = (x) => { setN(x); setText(categoryName(x, names)); };
  return (
    <WordDialog title="Edit Category" size="sm" onClose={(r) => { if (r) saveWord({ toaCategories: names }); onClose(r); }} result={() => names}
      left={[{ label: '&Replace', onClick: replace, disabled: n < 8 }]}>
      <span hidden data-dialog-id="toaCategory" />
      <ListBox items={CATEGORIES(names)} value={n} onChange={pick} height="9rem" />
      <Text label="Replace &with:" id="toa-cat-name" value={text} onChange={setText} disabled={n < 8} />
    </WordDialog>
  );
}

// ---------- Table of Authorities ----------

const TOA_FORMATS = [['template', 'From template'], ['classic', 'Classic'], ['distinctive', 'Distinctive'], ['formal', 'Formal'], ['simple', 'Simple']];

/** The TOA codes the dialog writes: one per category (with All, each category that has entries). */
export function toaCodes({ category, passim, keep }, used) {
  const cats = category === 'all' ? used : [category];
  return cats.map((c) => `TOA \\h \\c "${c}"${passim ? ' \\p' : ''}${keep ? '' : ' \\f'}`);
}

function TableOfAuthorities({ onClose }) {
  const ed = mainEditor();
  const names = wordSettings(getState().settings).toaCategories;
  const [v, setV] = useState({ category: 'all', passim: true, keep: true, leader: 'dot', format: 'template' });
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  const sample = buildToa([{ long: 'Mo v. Mo, 15 P. 3d 2 (Cal. 1937)', short: 'Mo', category: 1, page: pg(3) }], { h: true, c: '1' }, { names });
  const ok = () => {
    if (!ed) return { ...v }; // a canvas draft: the command writes it through the engine
    const entries = taEntries(ed.state.doc);
    const byShort = new Map(entries.filter((e) => e.long).map((e) => [e.short || e.long, e.category]));
    const used = [...new Set(entries.map((e) => (e.long ? e.category : byShort.get(e.short))).filter(Boolean))].sort((a, b) => a - b);
    const codes = toaCodes(v, used);
    if (!codes.length) return null;
    insertBlocks(ed, codes, 'TOA', { id: 'TableofAuthorities', leader: v.leader });
    return true;
  };
  return (
    <WordDialog title="Table of Authorities" size="lg" onClose={(r) => onClose(r ? ok() : null)} result={() => true}
      left={[{ label: 'Mar&k Citation...', onClick: () => openDialog('markCitation') },
        { label: '&Modify...', onClick: () => openDialog('indexStyles', { ids: ['TableofAuthorities', 'TOAHeading'] }) }]}>
      <span hidden data-dialog-id="tableOfAuthorities" />
      <IndexTabs current="tableOfAuthorities" onClose={onClose} />
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <span>Print Preview</span>
          <Preview height="8rem"><Blocks blocks={sample} /></Preview>
          <Check label="Use &passim" checked={v.passim} onChange={set('passim')} />
          <Check label="Keep o&riginal formatting" checked={v.keep} onChange={set('keep')} />
          <Row label="Ta&b leader:" htmlFor="toa-leader"><Pick id="toa-leader" value={v.leader} options={LEADERS} onChange={set('leader')} /></Row>
          <Row label="Forma&ts:" htmlFor="toa-format"><Pick id="toa-format" value={v.format} options={TOA_FORMATS} onChange={set('format')} /></Row>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="toa-cat" {...accessProps('Cate&gory:')}><AccessText label="Cate&gory:" /></label>
          <ListBox id="toa-cat" items={[['all', 'All'], ...CATEGORIES(names)]} value={v.category} onChange={set('category')} height="12rem" />
        </div>
      </div>
    </WordDialog>
  );
}

export const DIALOGS = {
  markIndexEntry: MarkIndexEntry, index: IndexDialog, indexAutoMark: AutoMark, indexStyles: StyleList,
  markCitation: MarkCitation, toaCategory: ToaCategory, tableOfAuthorities: TableOfAuthorities,
};
