// The File backstage pages (docs/plans/word/briefs/backstage.md): Home, New, Open, Info, Save As and Export, mapped onto drafts
// (EasyWriter has drafts, not files). The shell (src/document/ribbon/Backstage.jsx) draws the navigation and the page title and
// passes {close, go}; go(id) opens another page.
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { cn } from 'cn';
import { File, FilePlus, FileText, Folder, MessageSquareText, Search, Shapes } from 'lucide-react';
import { createDraft, draftGroups, duplicateDraft, openDraft, renameDraft, threadLabel, toast } from '../../../app/actions.js';
import { getState, useStore } from '../../../app/store.js';
import { REASONS } from '../../../tooling/reasons.mjs';
import { commandOf, panelOf, run, useWordCtx } from '../../../tooling/registry.js';
import { newDocumentJson } from '../../defaults.mjs';
import { openBackstage } from '../../ribbon/Backstage.jsx';
import { fileName, plainText, saveTitle, webPage } from './exportText.mjs';
import { CATEGORIES, describe, engineFindings, foundIn, inspect } from './inspect.mjs';
import { byUpdated, filterDrafts, groupRecent } from './recent.mjs';
import { TEMPLATES } from './templates.mjs';
import { browseWordFile, saveDocx } from '../../docx/files.js';
import { openCanvasSession } from '../../../app/flows.js';
import { base64 } from '../../../tooling/base64.mjs';
import { areaOpens } from '../../../tooling/surface.js';

export const ACCEPT_ALL = 'review.tracking.accept.acceptAllChanges';
const FORMAT_ICONS = { document: FileText, 'forum-post': MessageSquareText, board: Shapes };
const KEYTIPS = '3456789ABCDEFGHIJKLMNOPQRSTUVWXZ';

/** The doc's inspector findings, with tracked changes counted only while the tracking package can accept them. */
export function findings(json) {
  const found = inspect(json);
  if (!commandOf(ACCEPT_ALL)) found.revisions = 0;
  return found;
}

/** Where draft `d` lives: its folder's name, else its project's label, else ''. */
function placeOf(d, settings) {
  const folder = (settings.folders ?? []).find((f) => f.id === settings.draftFolders?.[d.id]);
  if (folder) return folder.name;
  const thread = d.threadUrl && (settings.threads ?? []).find((t) => t.url === d.threadUrl);
  return thread ? threadLabel(thread) : '';
}

const when = (t) => {
  const d = new Date(t ?? 0);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

/** Opens draft `id` and closes the backstage, which gives the editor the focus. */
async function openFromBackstage(id) {
  if (getState().draft?.id !== id && !(await openDraft(id))) return;
  openBackstage(null);
}

/** Creates a Document from template `t` (null: blank) and opens it. Content only, so newDocumentJson's attrs stay. */
export async function createFrom(t) {
  const sect = newDocumentJson(getState().settings).attrs.sect;
  try {
    await createDraft({ format: 'document', title: t?.label, doc: t ? { content: t.build(sect) } : null });
  } catch (e) {
    return toast(e.message, true);
  }
  openBackstage(null);
}

const linkClass = 'text-sm text-primary hover:underline';
const Heading = ({ children }) => <h2 className="mb-3 text-sm leading-none font-semibold">{children}</h2>;

function SearchBox({ value, onChange, label = 'Search' }) {
  return (
    <label className="relative mb-3 block w-72">
      <Search className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" aria-label={label} placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} className="pl-8" />
    </label>
  );
}

function DraftRow({ d, settings }) {
  const Icon = FORMAT_ICONS[d.format] ?? File;
  const current = getState().draft?.id === d.id;
  return (
    <li>
      <button type="button" data-draft={d.id} onClick={() => openFromBackstage(d.id)}
        className={cn('flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60', current && 'bg-accent/40')}>
        <Icon className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{d.title || 'Untitled'}</span>
          <span className="block truncate text-xs text-muted-foreground">{placeOf(d, settings)}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{when(d.updated)}</span>
      </button>
    </li>
  );
}

function Tile({ label, desc, id, keytip, onClick, blank }) {
  return (
    <button type="button" data-template={id} data-keytip={keytip} title={desc} onClick={onClick}
      className="flex w-36 flex-col items-center gap-2 rounded-md p-2 text-center text-sm hover:bg-accent/60">
      <span className="grid h-44 w-32 place-items-center border bg-white text-neutral-400 shadow-sm">
        {blank ? <FilePlus className="size-8" /> : <FileText className="size-8" />}
      </span>
      {label}
    </button>
  );
}

const templateTiles = (keytip = () => undefined) => [
  <Tile key="blank" blank label="Blank document" id="blank" keytip={keytip(0)} onClick={() => createFrom(null)} />,
  ...TEMPLATES.map((t, i) => (
    <Tile key={t.id} label={t.label} desc={t.desc} id={t.id} keytip={keytip(i + 1)} onClick={() => createFrom(t)} />
  )),
];

const greeting = (h = new Date().getHours()) => (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening');

/** File > Home: a greeting, New with the first templates, and the recent drafts with a Search box. */
export function Home({ go }) {
  const drafts = useStore((s) => s.drafts);
  const settings = useStore((s) => s.settings);
  const [q, setQ] = useState('');
  const recent = filterDrafts(byUpdated(drafts), q, (d) => placeOf(d, settings));
  return (
    <div data-page="file.home">
      <p className="mb-6 text-xl font-light">{greeting()}</p>
      <div className="mb-2 flex items-baseline gap-4">
        <button type="button" data-link="new" data-keytip="Y 1" onClick={() => go('file.new')} className="text-lg font-light hover:underline">New</button>
      </div>
      <div className="mb-2 flex flex-wrap gap-2">{templateTiles((i) => `Y ${KEYTIPS[i]}`)}</div>
      <button type="button" data-feature="file.new.templates" data-keytip="Y 2" onClick={() => go('file.new')} className={cn(linkClass, 'mb-8')}>More templates</button>
      <Heading>Recent</Heading>
      <SearchBox value={q} onChange={setQ} />
      <ul data-recent="" className="max-w-3xl">{recent.slice(0, 12).map((d) => <DraftRow key={d.id} d={d} settings={settings} />)}</ul>
      {!recent.length && <p className="text-sm text-muted-foreground">No drafts match.</p>}
      <button type="button" data-link="more" onClick={() => go('file.open')} className={cn(linkClass, 'mt-3')}>More documents</button>
    </div>
  );
}

/** File > New: Blank document and our templates. */
export function New() {
  return <div data-page="file.new" className="flex flex-wrap gap-2">{templateTiles()}</div>;
}

const PLACES = [['recent', 'Recent'], ['folders', 'Folders']];

/** File > Open: every draft by date group, or the folders with their drafts, with a Search box. This PC and Browse need files. */
export function Open() {
  const drafts = useStore((s) => s.drafts);
  const settings = useStore((s) => s.settings);
  const [place, setPlace] = useState('recent');
  const [q, setQ] = useState('');
  const extra = (d) => placeOf(d, settings);
  const sections = place === 'recent'
    ? groupRecent(filterDrafts(drafts, q, extra))
    : (() => {
      const { groups, loose } = draftGroups();
      return [...groups.map((g) => ({ label: g.folder.name, drafts: g.drafts })), { label: 'Not in a folder', drafts: loose }]
        .map((s) => ({ ...s, drafts: filterDrafts(s.drafts, q, extra) })).filter((s) => s.drafts.length);
    })();
  return (
    <div data-page="file.open" className="flex gap-8">
      <ul className="flex w-44 shrink-0 flex-col gap-0.5 text-sm">
        {PLACES.map(([id, label]) => (
          <li key={id}>
            <button type="button" data-place={id} aria-current={place === id || undefined} onClick={() => setPlace(id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/60 aria-[current]:bg-accent">
              {id === 'recent' ? <FileText className="size-4" /> : <Folder className="size-4" />}{label}
            </button>
          </li>
        ))}
        {['This PC', 'Browse'].map((label) => (
          <li key={label}>
            <button type="button" data-feature={label === 'Browse' ? 'file.open.dialog' : undefined} title="Open a Word file (.docx or .doc) as a new Document"
              onClick={() => browseWordFile()} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/60">
              <Folder className="size-4" />{label}
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 max-w-3xl flex-1">
        <SearchBox value={q} onChange={setQ} />
        {sections.map((s) => (
          <section key={s.label} data-group={s.label} className="mb-4">
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">{s.label}</h3>
            <ul>{s.drafts.map((d) => <DraftRow key={d.id} d={d} settings={settings} />)}</ul>
          </section>
        ))}
        {!sections.length && <p className="text-sm text-muted-foreground">No drafts match.</p>}
      </div>
    </div>
  );
}

/** One Info section: a large button with its label, and the text beside it. `menu`: [{id, label, run, disabled, reason}]. */
function InfoSection({ id, label, text, onClick, disabled, reason, menu, children }) {
  const [open, setOpen] = useState(false);
  const off = disabled || (!onClick && !menu);
  return (
    <section data-info={id} className="flex gap-4 border-b py-4">
      <div className="relative w-28 shrink-0">
        <button type="button" aria-disabled={off || undefined} title={off ? reason ?? REASONS.pending : undefined} aria-expanded={menu ? open : undefined}
          onClick={() => !off && (menu ? setOpen(!open) : onClick())}
          className="flex h-20 w-28 items-center justify-center rounded-md border p-2 text-center text-xs hover:bg-accent/60 aria-disabled:opacity-40">
          {label}
        </button>
        {open && menu && (
          <ul role="menu" className="absolute top-full left-0 z-10 mt-1 w-56 rounded-md border bg-popover p-1 text-sm shadow-lg">
            {menu.map((m) => (
              <li key={m.id} role="none">
                <button type="button" role="menuitem" data-item={m.id} aria-disabled={m.disabled || undefined} title={m.disabled ? m.reason : undefined}
                  onClick={() => !m.disabled && (setOpen(false), m.run())}
                  className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent/60 aria-disabled:opacity-40">{m.label}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0 flex-1 text-sm">
        <h3 className="mb-1 font-medium">{label === 'Check for Issues' ? 'Inspect Document' : label}</h3>
        {text && <p className="text-muted-foreground">{text}</p>}
        {children}
      </div>
    </section>
  );
}

/** A section a protect or fields-info panel fills: the panel inline when registered, else a button running the command of
 * that id, else a disabled placeholder. */
function PanelSection({ id, label, ctx, text }) {
  const [open, setOpen] = useState(false);
  const Panel = panelOf(id);
  const cmd = commandOf(id);
  if (Panel) {
    return (
      <InfoSection id={id} label={label} text={text} onClick={() => setOpen(!open)}>
        {open && <div className="mt-2"><Panel ctx={ctx} cmd={cmd} close={() => setOpen(false)} /></div>}
      </InfoSection>
    );
  }
  return <InfoSection id={id} label={label} text={cmd?.desc?.(ctx) ?? text} onClick={cmd ? () => run(id) : null} />;
}

/** File > Info: the draft's title and folder, then Protect Document, Inspect Document, Version History and Manage Document,
 * and Properties on the right. */
export function Info() {
  const ctx = useWordCtx();
  const draft = useStore((s) => s.draft);
  const settings = useStore((s) => s.settings);
  const doc = ctx.ed?.state.doc;
  const dom = useMemo(() => (!ctx.engine && doc ? findings(doc.toJSON()) : null), [doc, ctx.engine]);
  // A canvas draft: the engine's findings (backstage/inspect.mjs engineFindings).
  const found = ctx.engine ? engineFindings(ctx.read('file.inspectFindings', {})?.found) : dom;
  const hits = found ? CATEGORIES.filter((c) => foundIn(found, c.id)).map((c) => describe(found, c.id)) : [];
  const Properties = panelOf('file.info.properties');
  const accessibility = 'review.accessibility.checkAccessibility';
  return (
    <div data-page="file.info" className="flex gap-10">
      <div className="min-w-0 max-w-2xl flex-1">
        <p className="text-xl font-light">{draft?.title || 'Untitled'}</p>
        <p className="mb-4 text-sm text-muted-foreground">{draft ? placeOf(draft, settings) || 'Not in a folder' : ''}</p>
        <PanelSection id="file.info.protectDocument" label="Protect Document" ctx={ctx} text="Choose what changes others can make to this document." />
        <InfoSection id="file.info.inspectDocument" label="Check for Issues"
          text={hits.length ? 'Before you share this document, note that it holds the following.' : 'Nothing hidden or personal was found in this document.'}
          menu={[
            { id: 'file.info.inspectDocument', label: 'Inspect Document', run: () => run('file.info.inspectDocument') },
            { id: accessibility, label: 'Check Accessibility', run: () => run(accessibility), disabled: !commandOf(accessibility), reason: REASONS.pending },
            { id: 'compatibility', label: 'Check Compatibility', run: () => {}, disabled: true, reason: REASONS.docx },
          ]}>
          {hits.length > 0 && <ul data-findings="" className="mt-1 list-disc pl-5 text-muted-foreground">{hits.map((h) => <li key={h}>{h}</li>)}</ul>}
        </InfoSection>
        <InfoSection id="file.info.versionHistory" label="Version History" text="See and restore earlier versions of this draft."
          onClick={commandOf('file.info.versionHistory') ? () => run('file.info.versionHistory') : null} />
        <InfoSection id="file.info.manageDocument" label="Manage Document" disabled reason="There is nothing to recover."
          text="EasyWriter saves every change as you type, so there are no unsaved documents to recover." />
      </div>
      <aside data-feature="file.info.properties" className="w-72 shrink-0 text-sm">
        <h3 className="mb-2 font-medium">Properties</h3>
        {Properties ? <Properties ctx={ctx} close={() => {}} /> : <p className="text-muted-foreground">{REASONS.pending}</p>}
      </aside>
    </div>
  );
}

/** Save As formats: [value, label, reason when disabled in the DOM editor]. On a canvas draft none is disabled: the engine writes
 * each file format (ENGINE_FILES). */
export const SAVE_FORMATS = [
  ['draft', 'EasyWriter draft'],
  ['pdf', 'PDF'],
  ['html', 'Web Page, Filtered'],
  ['txt', 'Plain Text'],
  ['docx', 'Word Document (.docx)'],
  ['odt', 'OpenDocument Text', REASONS.docx],
  ['rtf', 'Rich Text Format', REASONS.docx],
  ['md', 'Markdown', 'Markdown files are written from canvas drafts only.'],
];

/** The files a canvas draft's engine writes (its save(kind), stage2b.md R10): format → [extensions, the Save dialog's filter name]. */
const ENGINE_FILES = { html: [['htm', 'html'], 'Web Page'], txt: [['txt'], 'Plain Text'], docx: [['docx'], 'Word Document'],
  odt: [['odt'], 'OpenDocument Text'], rtf: [['rtf'], 'Rich Text Format'], md: [['md'], 'Markdown'] };

/** Saves the open draft as `title` (empty: its own) in `folderId` in `format`. A draft copy opens unless `copy` (Save a Copy keeps
 * the original open); PDF goes to print's Create PDF; Web Page and Plain Text go to a file. */
export async function saveAs({ title, folderId = null, format = 'draft', copy = false }) {
  const { draft, editor } = getState();
  const canvas = areaOpens(getState());
  if (!draft?.id || (!editor && !canvas)) return false;
  const name = saveTitle(title, draft.title);
  if (format === 'draft') {
    let draftId;
    try {
      ({ draftId } = await duplicateDraft(draft.id, { folderId }));
    } catch (e) {
      return toast(e.message, true);
    }
    await renameDraft(draftId, name);
    if (copy) toast(`Saved a copy named ${name}.`);
    else await openDraft(draftId);
    openBackstage(null);
    return draftId;
  }
  if (format === 'pdf') return run('file.export.pdf');
  if (canvas) {
    const session = openCanvasSession(); // its session, not the hidden DOM editor under it, holds the text
    if (!session) return toast('The draft is still opening in the canvas engine. Try again once it shows.', true);
    try {
      if (format === 'docx') return await saveDocx(name, session);
      const [extensions, filter] = ENGINE_FILES[format];
      const bytes = await session.save(format);
      return await window.api.word.saveFile({ name: fileName(name, extensions[0]), data: base64(bytes), filters: [{ name: filter, extensions }], as: 'base64' });
    } catch (e) {
      return toast(`Could not save the file: ${e.message || e}`, true);
    } finally {
      session.release();
    }
  }
  if (format === 'docx') return saveDocx(name);
  const file = format === 'html'
    ? { name: fileName(name, 'htm'), data: webPage(name, editor.getHTML()), filters: [{ name: 'Web Page', extensions: ['htm', 'html'] }] }
    : { name: fileName(name, 'txt'), data: plainText(editor.getJSON()), filters: [{ name: 'Plain Text', extensions: ['txt'] }] };
  return window.api.word.saveFile({ ...file, as: 'text' });
}

/** File > Save As: a Title box, a Folder pick and a Format pick, with Save and Save a Copy. */
export function SaveAs() {
  const draft = useStore((s) => s.draft);
  const settings = useStore((s) => s.settings);
  const canvas = useStore(areaOpens);
  const folders = draftGroups().groups.map((g) => g.folder);
  const [title, setTitle] = useState(draft?.title ?? '');
  const [folder, setFolder] = useState(settings.draftFolders?.[draft?.id] ?? '');
  const [format, setFormat] = useState('draft');
  const pdfOff = format === 'pdf' && !commandOf('file.export.pdf');
  const go = (copy) => saveAs({ title, folderId: folder || null, format, copy });
  return (
    <form data-page="file.saveAs" className="flex max-w-xl flex-col gap-3 text-sm" onSubmit={(e) => (e.preventDefault(), go(false))}>
      <label className="flex flex-col gap-1">Title
        <Input data-field="title" className="w-80" value={title} placeholder={draft?.title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">Folder
        <NativeSelect data-field="folder" className="w-80" value={folder} options={[['', 'Not in a folder'], ...folders.map((f) => [f.id, f.name])]} onChange={(e) => setFolder(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">Format
        <NativeSelect data-field="format" className="w-80" value={format} onChange={(e) => setFormat(e.target.value)}
          options={SAVE_FORMATS.map(([v, label, why]) => {
            const reason = canvas ? null : why;
            return [v, label, { disabled: !!reason, title: reason }];
          })} />
      </label>
      {pdfOff && <p className="text-muted-foreground">{REASONS.pending}</p>}
      <div className="mt-2 flex gap-2">
        <Button type="submit" size="sm" data-feature="file.saveAs.save" disabled={pdfOff} className="min-w-24">Save</Button>
        <Button type="button" variant="outline" size="sm" data-feature="file.saveAs.saveAsCopy" disabled={pdfOff} onClick={() => go(true)} className="min-w-24">Save a Copy</Button>
      </div>
    </form>
  );
}

/** File > Export: Create PDF/XPS Document through print, and Change File Type, which saves a Word file. */
export function Export() {
  const pdf = !!commandOf('file.export.pdf');
  const btn = 'flex w-full flex-col items-start rounded-md border p-3 text-left text-sm hover:bg-accent/60 aria-disabled:opacity-40';
  return (
    <div data-page="file.export" className="flex max-w-xl flex-col gap-2">
      <button type="button" data-feature="file.export.pdf" aria-disabled={!pdf || undefined} title={pdf ? undefined : REASONS.pending}
        onClick={() => pdf && run('file.export.pdf')} className={btn}>
        <span className="font-medium">Create PDF/XPS Document</span>
        <span className="text-muted-foreground">Save the document as a PDF that keeps its layout.</span>
      </button>
      <button type="button" data-feature="file.export.changeFileType" onClick={() => run('file.export.changeFileType')} className={btn}>
        <span className="font-medium">Change File Type</span>
        <span className="text-muted-foreground">Save the document as a Word file (.docx).</span>
      </button>
    </div>
  );
}
