import { useState } from 'react';
import { cn } from 'cn';
import {
  ChevronRight, CircleCheck, ExternalLink, Folder, FolderInput, FolderOpen, FolderPlus, Globe, LoaderCircle, LogIn, PanelLeftClose, PanelLeftOpen, Plus, Save,
  Search, Send, Settings, SquareKanban, Tag, Undo2, Workflow, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SelectItem } from '@/components/ui/select';
import {
  addThreadUrl, deleteDraft, deleteFolder, discoverThreads, draftGroups, login, moveDraft, moveFolder, newFolder, openDraft, openInForum,
  openSettings, placeDraft, push, refocusEditor, removeThread, renameFolder, saveNow, selectThread, setDraftTag, setDraftThread,
  startNewDraft, threadLabel, toggleFolder, toggleSidebar, unpushDraft,
} from '../actions.js';
import { draftTag, tagList } from '../drafts-meta.js';
import { keyLabel, withKey } from '../keybinds.js';
import { can } from '../gates.mjs';
import { openCount, openPlan, planFor, usePlans } from '../plans.js';
import { getState, useStore } from '../store.js';
import { showPage } from '../views.js';
import { InlineInput } from './InlineInput.jsx';
import { Tip } from './Tip.jsx';
import { keepFocus, NONE, ToolSelect } from './Toolbar.jsx';

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
    <div className="invisible absolute top-1/2 right-1 flex -translate-y-1/2 items-center rounded-md bg-accent pl-1 group-hover:visible has-[[data-state=open]]:visible">
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

function Account() {
  const status = useStore((s) => s.status);
  const loggingIn = useStore((s) => s.loggingIn);
  const discovering = useStore((s) => s.discovering);
  const label = status.loggedIn ? `Logged in as ${status.name || `member ${status.memberId}`}` : 'Not logged in';
  // One row: the label takes what is left (ellipsis), the icon buttons keep fixed slots, so nothing shifts.
  return (
    <Card className={FLAT}>
      <CardHeader className="flex items-center gap-1 px-2.5">
        <CardTitle className="min-w-0 flex-1 truncate text-sm" title={label}>{label}</CardTitle>
        <Tip title={status.loggedIn ? 'Open the forum window' : 'Log in to the forum in the forum window'}>
          <Button variant="ghost" size="icon-sm" aria-label={status.loggedIn ? 'Forum window' : 'Log in'} data-agent-risk="approval" disabled={loggingIn} onClick={login}>
            {status.loggedIn ? <ExternalLink /> : <LogIn />}
          </Button>
        </Tip>
        <Tip title="Find my threads (your development threads on the forum)">
          <Button variant="ghost" size="icon-sm" aria-label="Find my threads" disabled={discovering} onClick={discoverThreads}>
            {discovering ? <LoaderCircle className="animate-spin" /> : <Search />}
          </Button>
        </Tip>
        <Tip title="Settings">
          <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={openSettings}><Settings /></Button>
        </Tip>
      </CardHeader>
    </Card>
  );
}

/** The open draft's post actions: thread select, Save, and Push / Unpush in one slot of the same width. */
function Post() {
  const threads = useStore((s) => s.settings?.threads) ?? [];
  const hasDraft = useStore((s) => !!s.draft);
  const draftThread = useStore((s) => s.draft?.threadUrl) || '';
  const pushed = useStore((s) => can('draft.pushed', s.draft));
  return (
    <Card className={FLAT}>
      {/* One line: thread select (ellipsis), then Save and Push / Unpush as same-size icon buttons, so nothing shifts. */}
      <CardContent className="flex items-center gap-1 px-2.5">
        {/* Tip wraps the trigger in a span: the wrapper makes that span (and the trigger) take the free width. */}
        <div className="min-w-0 flex-1 *:w-full">
        <ToolSelect title="Thread this draft is for" className="w-full min-w-0" disabled={!hasDraft} value={draftThread || NONE}
          onChange={(v) => setDraftThread(v === NONE ? '' : v)}>
          <SelectItem value={NONE}>No thread</SelectItem>
          {/* truncate: the capped trigger shows a long label with an ellipsis */}
          {threads.map((t) => <SelectItem key={t.url} value={t.url}><span className="truncate">{threadLabel(t)}</span></SelectItem>)}
          {draftThread && !threads.some((t) => t.url === draftThread) && <SelectItem value={draftThread}><span className="truncate">{draftThread}</span></SelectItem>}
        </ToolSelect>
        </div>
        <Tip title={withKey('Save now', 'app.save')}>
          <Button variant="outline" size="icon-sm" aria-label={withKey('Save now', 'app.save')} onMouseDown={keepFocus} onClick={() => saveNow()}><Save /></Button>
        </Tip>
        <Tip title={pushed ? 'Unpush: mark as not pushed (Submit was not pressed in the forum)' : 'Push to forum: fill the forum reply box with this draft'}>
          {pushed
            ? <Button variant="outline" size="icon-sm" aria-label="Unpush" data-agent-risk="destructive" onMouseDown={keepFocus} onClick={() => unpushDraft(getState().draft)}><Undo2 /></Button>
            : <Button size="icon-sm" aria-label="Push to forum" data-agent-risk="approval" onMouseDown={keepFocus} onClick={push}><Send /></Button>}
        </Tip>
      </CardContent>
    </Card>
  );
}

function Threads() {
  const settings = useStore((s) => s.settings);
  usePlans(); // the plan counts
  if (!settings) return null;
  const { threads, selectedThread } = settings;

  const years = new Map();
  for (const t of threads) {
    const year = t.year || 'Other';
    const subject = t.subject || 'Other';
    if (!years.has(year)) years.set(year, new Map());
    const subjects = years.get(year);
    if (!subjects.has(subject)) subjects.set(subject, []);
    subjects.get(subject).push(t);
  }
  const byName = (a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b);
  const yearOrder = [...years.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || b.localeCompare(a));

  return (
    <Card className={`${FLAT} gap-1.5`}>
      <CardHeader className="px-2.5"><SectionTitle>Threads</SectionTitle></CardHeader>
      <CardContent className="px-1">
        <Row active={!selectedThread} onClick={() => selectThread(null)}>
          <span className="min-w-0 flex-1 truncate">All drafts</span>
        </Row>
        {!threads.length && <p className="px-1.5 py-1 text-xs text-muted-foreground">No threads yet. Use "Find my threads" or add a URL.</p>}
        {yearOrder.map((year) => (
          <div key={year}>
            <div className="mt-1.5 px-1.5 text-xs text-muted-foreground">{year}</div>
            {[...years.get(year).keys()].sort(byName).map((subject) => (
              <div key={subject}>
                <div className="mt-1 truncate px-1.5 font-semibold" title={subject}>{subject}</div>
                {years.get(year).get(subject).map((t) => (
                  <Row key={t.url} active={t.url === selectedThread} title={t.forum ? `${t.forum}\n${t.url}` : t.url}
                    onClick={() => selectThread(t.url)}>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground group-hover:text-foreground">{t.title || t.url}</span>
                    {planFor(t.url) && (
                      <Tip title="Open tickets in its plan"><span className="shrink-0 text-xs text-muted-foreground tabular-nums">{openCount(planFor(t.url).id)}</span></Tip>
                    )}
                    <RowAction title="Plan board" onClick={() => openPlan(t.url)}><SquareKanban /></RowAction>
                    <RowAction title="Open in forum" risk="approval" onClick={() => openInForum(t.url)}><ExternalLink /></RowAction>
                    <RowAction title="Remove thread from list" risk="destructive" onClick={() => removeThread(t)}><X /></RowAction>
                  </Row>
                ))}
              </div>
            ))}
          </div>
        ))}
        <Button variant="ghost" size="xs" className="mt-0.5 h-7.5 w-full justify-start text-muted-foreground" onClick={addThreadUrl}>
          <Plus />Add thread URL
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

/** The draft's tag dot, in a fixed slot at the left of the row so titles line up; it opens the tag menu (so does the "Tag"
 * hover action, through `open`). Clicks stop at the dot and the menu: they bubble (through the portal) to the row. */
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

function DraftRow({ d, folderId, folders, tag, tags, active, dragging, after, onDrag }) {
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
        {d.pushedAt && <Tip title="Pushed to the forum"><CircleCheck className="size-3.5 shrink-0 text-green-500" aria-label="Pushed" /></Tip>}
        <HoverActions>
          <RowAction title="Tag" onClick={() => setTagging(true)}><Tag /></RowAction>
          <RowAction title="Move to..." slot={DropdownMenuTrigger}><FolderInput /></RowAction>
          <RowAction title="Delete draft" risk="destructive" onClick={() => deleteDraft(d)}><X /></RowAction>
        </HoverActions>
      </Row>
      {/* Outside the Row: React events bubble out of the portal, and a menu click must not open the draft. */}
      <DropdownMenuContent align="end" onCloseAutoFocus={refocusEditor}>
        {folders.map((f) => (
          <DropdownMenuCheckboxItem key={f.id} checked={folderId === f.id} onSelect={() => moveDraft(d.id, f.id)}>{f.name}</DropdownMenuCheckboxItem>
        ))}
        {folders.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuCheckboxItem checked={!folderId} onSelect={() => moveDraft(d.id, null)}>Top level</DropdownMenuCheckboxItem>
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
    <DraftRow key={d.id} d={d} folderId={folderId} folders={settings.folders || []} tag={draftTag(settings, d.id)} tags={tagList(settings)}
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
            <Badge variant="outline" className="border-amber-500/40 text-amber-300">not saved yet</Badge>
          </Row>
        )}
        {loose.map((d) => row(d, null))}
        {!showUnsaved && !groups.length && !loose.length && <p className="px-1.5 py-1 text-xs text-muted-foreground">No drafts.</p>}
      </CardContent>
    </Card>
  );
}

/** The fixed footer under the sections (§7g): the workspace tabs, Plans above Flowcharts. They navigate: the tab of the page
 * shown is highlighted and clicking it does nothing. */
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
    <nav aria-label="Workspaces" className="flex flex-col gap-0.5 border-t p-1">
      {tab('plan', <SquareKanban />, 'Plans', keyLabel('app.plans'))}
      {tab('flows', <Workflow />, 'Flowcharts')}
      {tab('browser', <Globe />, 'Browser', keyLabel('app.browser'))}
    </nav>
  );
}

export function Sidebar() {
  return (
    <div data-agent-area="sidebar" className="flex min-h-0 flex-col border-r">
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
        <aside className="flex flex-col divide-y text-sm">
          <Account />
          <Post />
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
    <div className="absolute bottom-3 left-2 z-30 rounded-island border bg-card p-1 shadow-lg">
      <SidebarButton side="right" />
    </div>
  );
}
