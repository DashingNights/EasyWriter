import { useEffect, useState } from 'react';
import { cn } from 'cn';
import {
  ChevronRight, CircleAlert, CircleCheck, Cloud, CloudAlert, CloudCheck, CloudOff, CloudUpload, ExternalLink, Folder, FolderInput, FolderOpen,
  FolderPlus, Globe, Link2, LoaderCircle, PanelLeftClose, PanelLeftOpen, Plus, Send, Settings, SquareKanban, Undo2, Workflow, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  addThreadUrl, deleteDraft, deleteFolder, draftGroups, editProjectThread, moveDraft, moveFolder, newFolder, openDraft, openInForum,
  openSettings, placeDraft, push, refocusEditor, removeThread, renameFolder, saveSettings, selectThread, setDraftTag, setDraftThreadFor,
  startNewDraft, threadLabel, toggleFolder, toggleSidebar, unpushDraft,
} from '../actions.js';
import { isProject, topicOf } from '../../thread-url.mjs';
import { draftTag, tagList } from '../drafts-meta.js';
import { keyLabel, withKey } from '../keybinds.js';
import { openCount, openPlan, planFor, usePlans } from '../plans.js';
import { getState, useStore, WORKER } from '../store.js';
import { showPage } from '../views.js';
import { InlineInput } from './InlineInput.jsx';
import { Tip } from './Tip.jsx';
import { keepFocus } from './Toolbar.jsx';

// Sidebar sections are flat (SPEC 7b): Card's layout without its box; the sidebar separates them with thin lines.
const FLAT = 'rounded-none border-0 bg-transparent py-2.5 shadow-none';
const SectionTitle = ({ children }) => <CardTitle className="text-xs tracking-wider text-muted-foreground uppercase">{children}</CardTitle>;

/** Single-line list row; its hover actions (RowAction) keep their space while hidden, so hovering shifts nothing. */
function Row({ active, onClick, title, className, children, ...props }) {
  return (
    <div title={title} onClick={onClick} {...props}
      className={cn('group flex min-h-7.5 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-accent/60', active && 'bg-accent hover:bg-accent', className)}>
      {children}
    </div>
  );
}

/** Hover actions laid over the row's right end instead of taking space, so a title can use the whole row; they show on
 * hover and while one of their menus is open. */
function HoverActions({ children }) {
  return (
    <div className="invisible absolute top-1/2 right-1 flex -translate-y-1/2 items-center rounded-md bg-background bg-[image:linear-gradient(var(--accent),var(--accent))] pl-1 group-hover:visible has-[[data-state=open]]:visible">
      {children}
    </div>
  );
}

/** `slot` (DropdownMenuTrigger) wraps the button for its menu; the button stays shown while the menu is open. `risk`
 * ('destructive' | 'approval'): the assistant's ui.invoke asks on the approval card before pressing it (SPEC §8). */
function RowAction({ title, onClick, slot: Slot, risk, children }) {
  let button = (
    <Button variant="ghost" size="icon-xs" aria-label={title} data-agent-risk={risk} className="invisible shrink-0 group-hover:visible data-[state=open]:visible"
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}>
      {children}
    </Button>
  );
  if (Slot) button = <Slot asChild>{button}</Slot>;
  return <Tip title={title}>{button}</Tip>;
}

function Threads() {
  const settings = useStore((s) => s.settings);
  usePlans(); // the plan counts
  if (!settings) return null;
  const { threads, selectedThread } = settings;

  // Projects whose forum thread names a year and subject group under them, indented: a year's subjects along a guide line,
  // a subject's projects under it. The rest come first, with no headings.
  const years = new Map();
  for (const t of threads) {
    const year = t.year || '';
    const subject = t.subject || '';
    if (!years.has(year)) years.set(year, new Map());
    const subjects = years.get(year);
    if (!subjects.has(subject)) subjects.set(subject, []);
    subjects.get(subject).push(t);
  }
  const byName = (a, b) => (b === '') - (a === '') || a.localeCompare(b);
  const yearOrder = [...years.keys()].sort((a, b) => (b === '') - (a === '') || b.localeCompare(a));

  return (
    <Card className={`${FLAT} gap-1.5`}>
      <CardHeader className="px-2.5"><SectionTitle>Projects</SectionTitle></CardHeader>
      <CardContent className="px-1">
        <Row active={!selectedThread} onClick={() => selectThread(null)}>
          <span className="min-w-0 flex-1 truncate">All drafts</span>
        </Row>
        {!threads.length && <p className="px-1.5 py-1 text-xs text-muted-foreground">No projects yet.</p>}
        {yearOrder.map((year) => (
          <div key={year}>
            {year && <div className="mt-1.5 px-1.5 text-xs text-muted-foreground">{year}</div>}
            <div className={cn(year && 'ml-2.5 border-l pl-1')}>
            {[...years.get(year).keys()].sort(byName).map((subject) => (
              <div key={subject}>
                {subject && <div className="mt-1 truncate px-1.5 font-semibold" title={subject}>{subject}</div>}
                {years.get(year).get(subject).map((t) => {
                  const topic = topicOf(threads, t.url);
                  return (
                  <Row key={t.url} active={t.url === selectedThread} title={t.forum ? `${t.forum}\n${topic}` : topic || t.title}
                    className={cn(subject && 'pl-4')} onClick={() => selectThread(t.url)}>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground group-hover:text-foreground">{t.title || t.url}</span>
                    {planFor(t.url) && (
                      <Tip title="Open tickets in its plan"><span className="shrink-0 text-xs text-muted-foreground tabular-nums">{openCount(planFor(t.url).id)}</span></Tip>
                    )}
                    <RowAction title="Plan board" onClick={() => openPlan(t.url)}><SquareKanban /></RowAction>
                    {topic && <RowAction title="Open in forum" risk="approval" onClick={() => openInForum(topic)}><ExternalLink /></RowAction>}
                    {isProject(t.url) && <RowAction title={topic ? 'Forum thread: change or unlink' : 'Link a forum thread'} onClick={() => editProjectThread(t)}><Link2 /></RowAction>}
                    <RowAction title="Remove project from list" risk="destructive" onClick={() => removeThread(t)}><X /></RowAction>
                  </Row>
                  );
                })}
              </div>
            ))}
            </div>
          </div>
        ))}
        <Button variant="ghost" size="xs" className="mt-0.5 h-7.5 w-full justify-start text-muted-foreground" data-add-thread onClick={addThreadUrl}>
          <Plus />New project
        </Button>
      </CardContent>
    </Card>
  );
}

/** Drags a draft row (`folder` false) or a folder row with pointer events (no OS drag and drop), after 4 px of movement so
 * a click stays a click. `to` is what is under the pointer: for a draft, a draft row ([data-draft]) with `after` telling
 * which half, else a [data-drop] (a folder id, '' for the top level); for a folder, another folder ([data-drop]) and its half.
 * The drop puts the row there; the click that ends a drag opens nothing. */
function dragRow(e, id, folder, setDrag) {
  if (e.button !== 0 || e.target.closest('button, input')) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let moved = false;
  let to;
  let after;
  const move = (ev) => {
    moved ||= Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4;
    if (!moved) return;
    const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(folder ? '[data-drop]' : '[data-draft], [data-drop]');
    to = el?.dataset.draft ?? el?.dataset.drop;
    after = undefined;
    if (to === id || (folder && !to)) to = undefined; // its own row; a folder goes only between folders
    else if (el?.dataset.draft || folder) {
      const r = el.getBoundingClientRect();
      after = ev.clientY > r.top + r.height / 2;
    }
    setDrag({ id, folder, to, after });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (!moved) return;
    setDrag(null);
    const swallow = (c) => c.stopPropagation();
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true));
    if (to === undefined) return;
    if (folder) moveFolder(id, to, after);
    else if (after !== undefined) placeDraft(id, to, after);
    else moveDraft(id, to || null);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Insertion line on the top edge of a row, or on its bottom edge with `after` (undefined: none). */
const line = (after, indent) => after !== undefined && cn('relative before:absolute before:right-1 before:h-0.5 before:rounded-full before:bg-primary',
  indent ? 'before:left-6' : 'before:left-1', after ? 'before:-bottom-px' : 'before:-top-px');

/** A tag's colour dot; an empty, dimmed ring for no tag. */
const Dot = ({ tag }) => (
  <span className={cn('size-2.5 shrink-0 rounded-full', !tag && 'border border-muted-foreground/60')} style={tag && { background: tag.color }} />
);

/** The draft's tag dot, in a fixed slot at the left of the row so titles line up; it opens the tag menu. Clicks stop at the
 * dot and the menu: they bubble (through the portal) to the row. */
function TagMenu({ id, tag, tags, open, setOpen }) {
  const stop = (e) => e.stopPropagation();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tip title={tag?.name ?? 'No tag'}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`Tag: ${tag?.name ?? 'none'}`} onClick={stop}
            className="flex size-4 shrink-0 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50">
            <Dot tag={tag} />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" onCloseAutoFocus={refocusEditor} onClick={stop} onPointerDown={stop}>
        {tags.map((t) => (
          <DropdownMenuCheckboxItem key={t.id} checked={tag?.id === t.id} onSelect={() => setDraftTag(id, t.id)}><Dot tag={t} />{t.name}</DropdownMenuCheckboxItem>
        ))}
        {tags.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuCheckboxItem checked={!tag} onSelect={() => setDraftTag(id, null)}><Dot />No tag</DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Push to forum for draft `id`: the open one at once, another once it is open (push fills the reply box with the open draft). */
async function pushDraft(id) {
  if (getState().draft?.id !== id) await openDraft(id);
  if (getState().draft?.id === id) push();
}

function DraftRow({ d, folderId, folders, threads, tag, tags, active, dragging, after, onDrag }) {
  const [tagging, setTagging] = useState(false); // the tag menu is open
  const working = useStore((s) => s.bgWrites.includes(d.id)); // the assistant wrote to it in the background this turn (§7i)
  const background = useStore((s) => s.worker?.draftId === d.id); // the background window of computer use has it (§7i)
  return (
    <DropdownMenu>
      <Row active={active} title={d.title || 'Untitled draft'} data-draft={d.id}
        className={cn('relative select-none', folderId && 'pl-6', dragging && 'opacity-50', line(after, folderId))}
        onPointerDown={onDrag} onClick={() => (getState().draft?.id === d.id ? showPage('editor') : openDraft(d.id))}>
        <TagMenu id={d.id} tag={tag} tags={tags} open={tagging} setOpen={setTagging} />
        <span className="min-w-0 flex-1 truncate">{d.title || 'Untitled draft'}</span>
        {(working || background) && (
          <Badge variant="secondary" data-draft-assistant className="shrink-0 gap-1 px-1.5 py-0 text-[10px]">{working && <LoaderCircle className="size-3 animate-spin" />}Assistant</Badge>
        )}
        {d.pushedAt && <Tip title="Pushed to the forum"><CircleCheck className="size-3.5 shrink-0 text-success" aria-label="Pushed" /></Tip>}
        <HoverActions>
          {d.pushedAt
            ? <RowAction title="Unpush: mark as not pushed (Submit was not pressed in the forum)" risk="destructive" onClick={() => unpushDraft(d)}><Undo2 /></RowAction>
            : topicOf(threads, d.threadUrl) && <RowAction title="Push to forum: fill the forum reply box with this draft" risk="approval" onClick={() => pushDraft(d.id)}><Send /></RowAction>}
          <RowAction title="Move to..." slot={DropdownMenuTrigger}><FolderInput /></RowAction>
          <RowAction title="Delete draft" risk="destructive" onClick={() => deleteDraft(d)}><X /></RowAction>
        </HoverActions>
      </Row>
      {/* Outside the Row: React events bubble out of the portal, and a menu click must not open the draft. */}
      <DropdownMenuContent align="end" className="max-w-72" onCloseAutoFocus={refocusEditor}>
        <DropdownMenuLabel>Folder</DropdownMenuLabel>
        {folders.map((f) => (
          <DropdownMenuCheckboxItem key={f.id} checked={folderId === f.id} onSelect={() => moveDraft(d.id, f.id)}>{f.name}</DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuCheckboxItem checked={!folderId} onSelect={() => moveDraft(d.id, null)}>Top level</DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Project</DropdownMenuLabel>
        {threads.map((t) => (
          <DropdownMenuCheckboxItem key={t.url} checked={d.threadUrl === t.url} disabled={background} onSelect={() => setDraftThreadFor(d.id, t.url)}>
            <span className="truncate">{threadLabel(t)}</span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuCheckboxItem checked={!d.threadUrl} disabled={background} onSelect={() => setDraftThreadFor(d.id, '')}>No project</DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One click opens or closes the folder; a double-click on the name renames it (its two clicks toggle twice). */
function FolderRow({ group: { folder, drafts }, over, renaming, setRenaming, onDrag }) {
  const Icon = folder.open ? FolderOpen : Folder;
  return (
    <Row className={cn('select-none', over && 'bg-accent ring-1 ring-ring')} onPointerDown={onDrag}
      onClick={() => { if (!renaming) toggleFolder(folder.id); }}>
      <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground', folder.open && 'rotate-90')} />
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      {renaming ? (
        <InlineInput aria-label="Folder name" value={folder.name} className="flex-1 text-sm"
          onDone={(name) => { setRenaming(null); if (name != null) renameFolder(folder.id, name); }} />
      ) : (
        <span className="min-w-0 flex-1 truncate" title={folder.name} onDoubleClick={() => setRenaming(folder.id)}>{folder.name}</span>
      )}
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{drafts.length}</span>
      <RowAction title="Delete folder" risk="destructive" onClick={() => deleteFolder(folder)}><X /></RowAction>
    </Row>
  );
}

function Drafts() {
  const settings = useStore((s) => s.settings);
  useStore((s) => s.drafts);
  const currentId = useStore((s) => s.draft?.id);
  const editorShown = useStore((s) => s.view.type === 'editor'); // the open draft's row is highlighted only on the editor page
  const unsaved = useStore((s) => !!s.draft && !s.draft.id);
  const unsavedThread = useStore((s) => s.draft?.threadUrl);
  const [renaming, setRenaming] = useState(null); // id of the folder whose name is being edited
  const [drag, setDrag] = useState(null); // { id, folder, to, after } while a draft or folder row is dragged (dragRow)
  if (!settings) return null;
  const sel = settings.selectedThread;
  const showUnsaved = unsaved && (!sel || unsavedThread === sel);
  const { groups, loose } = draftGroups();
  const row = (d, folderId) => (
    <DraftRow key={d.id} d={d} folderId={folderId} folders={settings.folders || []} threads={settings.threads} tag={draftTag(settings, d.id)} tags={tagList(settings)}
      active={editorShown && currentId === d.id}
      dragging={drag?.id === d.id} after={!drag?.folder && drag?.to === d.id ? drag.after : undefined}
      onDrag={(e) => dragRow(e, d.id, false, setDrag)} />
  );

  return (
    <Card className={`${FLAT} gap-1.5`} data-drop="">
      <CardHeader className="px-2.5">
        <SectionTitle>Drafts</SectionTitle>
        <CardAction className="flex">
          <Tip title="New folder">
            <Button variant="ghost" size="icon-xs" aria-label="New folder" className="text-muted-foreground"
              onClick={async () => setRenaming(await newFolder())}><FolderPlus /></Button>
          </Tip>
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={startNewDraft}><Plus />New draft</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-1">
        {groups.map((g) => (
          <div key={g.folder.id} data-drop={g.folder.id}
            className={cn(drag?.id === g.folder.id && 'opacity-50', drag?.folder && drag.to === g.folder.id && line(drag.after))}>
            <FolderRow group={g} over={!drag?.folder && drag?.to === g.folder.id} renaming={renaming === g.folder.id} setRenaming={setRenaming}
              onDrag={(e) => dragRow(e, g.folder.id, true, setDrag)} />
            {g.folder.open && g.drafts.map((d) => row(d, g.folder.id))}
          </div>
        ))}
        {showUnsaved && (
          <Row active={editorShown} onClick={() => showPage('editor')}>
            <span className="size-4 shrink-0" />{/* the tag dot's slot: a draft can be tagged once it is saved */}
            <span className="min-w-0 flex-1 truncate">Untitled draft</span>
            <Badge variant="outline" className="border-warning/40 text-warning">not saved yet</Badge>
          </Row>
        )}
        {loose.map((d) => row(d, null))}
        {!showUnsaved && !groups.length && !loose.length && <p className="px-1.5 py-1 text-xs text-muted-foreground">No drafts.</p>}
      </CardContent>
    </Card>
  );
}

// The GitHub backup's state (SPEC §4b, main's github.status / github.event): [icon, tooltip, icon classes].
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const backupState = (st) => (!(st.login && st.enabled && st.repo) ? [CloudOff, 'Not backed up. GitHub backup is not set up.', 'text-muted-foreground']
  : st.busy ? [Cloud, 'Backing up to GitHub...', 'animate-pulse text-muted-foreground']
    : st.error ? [CloudAlert, st.error, 'text-destructive']
      : st.dirty ? [CloudUpload, 'Changes not backed up yet. The next push sends them to GitHub.', 'text-muted-foreground']
        : [CloudCheck, st.lastSync ? `Backed up to GitHub at ${clock(st.lastSync)}` : 'Backed up to GitHub', 'text-success']);

/** The warning of a backup that is not set up: what it means, a way to set it up, and "Don't show this warning again", which
 * hides the warning icon at once (settings.hideBackupWarning) and leaves the dialog open. */
function BackupWarning({ onClose }) {
  const hidden = useStore((s) => !!s.settings?.hideBackupWarning);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} onCloseAutoFocus={refocusEditor}
        className="gap-3 p-4 text-sm sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CircleAlert className="size-5 text-destructive" />Your work is not backed up</DialogTitle>
        </DialogHeader>
        <p className="text-muted-foreground">
          GitHub backup is not set up, so your drafts and plans are only on this computer. If it breaks or is lost, they are lost with it.
        </p>
        <label className="flex w-fit cursor-pointer items-center gap-2">
          <Checkbox checked={hidden} onCheckedChange={(v) => saveSettings({ hideBackupWarning: v === true })} />
          Don't show this warning again
        </label>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Dismiss</Button>
          <Button size="sm" onClick={() => { onClose(); openSettings('github'); }}>Set up GitHub backup</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Whether the changes are backed up to GitHub (a click opens Settings > GitHub backup); with the backup not set up, a red
 * warning before it that opens BackupWarning, unless the user turned the warning off. */
function BackupStatus() {
  const [st, setSt] = useState(null);
  const [warning, setWarning] = useState(false);
  const hidden = useStore((s) => !!s.settings?.hideBackupWarning);
  useEffect(() => {
    if (WORKER) return undefined;
    window.api.github.status().then(setSt, () => {});
    return window.api.github.onEvent(setSt);
  }, []);
  if (!st) return null;
  const [Icon, title, cls] = backupState(st);
  const off = !(st.login && st.enabled && st.repo);
  return (
    <>
      {off && !hidden && (
        <Tip title="Your work is not backed up" side="top">
          <Button variant="ghost" size="icon-sm" aria-label="Backup warning" data-backup-warning className="text-destructive hover:text-destructive"
            onMouseDown={keepFocus} onClick={() => setWarning(true)}><CircleAlert /></Button>
        </Tip>
      )}
      <Tip title={title} side="top">
        <Button variant="ghost" size="icon-sm" aria-label="GitHub backup status" aria-description={title} data-backup-status onMouseDown={keepFocus} onClick={() => openSettings('github')}>
          <Icon className={cls} />
        </Button>
      </Tip>
      {warning && <BackupWarning onClose={() => setWarning(false)} />}
    </>
  );
}

/** The fixed footer under the sections (§7g): the workspace tabs, Plans above Flowcharts, then Settings with the GitHub
 * backup's state at the right. The tabs navigate: the tab of the page shown is highlighted and clicking it does nothing. */
function SidebarNav() {
  const view = useStore((s) => s.view.type);
  const tab = (type, icon, label, hint) => (
    <Button variant="ghost" size="sm" aria-current={view === type ? 'page' : undefined} onMouseDown={keepFocus} onClick={() => showPage(type)}
      className={cn('h-8 w-full justify-start px-2 font-normal', view === type && 'bg-accent hover:bg-accent')}>
      {icon}
      {label}
      {hint && <span className="ml-auto text-xs text-muted-foreground">{hint}</span>}
    </Button>
  );
  return (
    <div className="flex flex-col gap-0.5 border-t p-1">
      <nav aria-label="Workspaces" className="flex flex-col gap-0.5">
        {tab('plan', <SquareKanban />, 'Plans', keyLabel('app.plans'))}
        {tab('flows', <Workflow />, 'Flowcharts')}
        {tab('browser', <Globe />, 'Browser', keyLabel('app.browser'))}
      </nav>
      <div className="flex items-center gap-0.5">
        <Button variant="ghost" size="sm" aria-label="Settings" onMouseDown={keepFocus} onClick={() => openSettings()} className="h-8 flex-1 justify-start px-2 font-normal">
          <Settings />Settings
        </Button>
        <BackupStatus />
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <div data-agent-area="sidebar" className="flex min-h-0 flex-col border-r">
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
        <aside className="flex flex-col divide-y text-sm">
          <Threads />
          <Drafts />
        </aside>
      </ScrollArea>
      <SidebarNav />
    </div>
  );
}

/** Hides or shows the sidebar (also Ctrl+\): in the editor's corner (SidebarToggle) and in the workspace headers. */
export function SidebarButton({ side }) {
  const collapsed = useStore((s) => !!s.settings?.sidebarCollapsed);
  const title = withKey(`${collapsed ? 'Show' : 'Hide'} sidebar`, 'app.sidebar');
  return (
    <Tip title={title} side={side}>
      <Button variant="ghost" size="icon-sm" aria-label={title} onMouseDown={keepFocus} onClick={toggleSidebar}>
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </Button>
    </Tip>
  );
}

/** Floating at the bottom-left of the editor area, the width of the board rail above it. In the editor, the only sidebar
 * control while the sidebar is hidden. */
export function SidebarToggle() {
  return (
    <div className="absolute bottom-3 left-2 z-30 rounded-island border bg-island p-1 shadow-xl">
      <SidebarButton side="right" />
    </div>
  );
}
