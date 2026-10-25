import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import {
  ChevronRight, CircleAlert, ClipboardPaste, Cloud, CloudAlert, CloudCheck, CloudOff, CloudUpload, Copy, CopyPlus, File, FilePlus, FileText, Folder,
  FolderInput, FolderOpen, FolderPlus, MessageSquareText, Globe, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Scissors, Settings, SquareKanban, Tag,
  Trash2, Workflow, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Dot } from '@/components/ui/dot';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import {
  addThreadUrl, canPaste, copyDraft, cutDraft, deleteDraft, deleteFolder, draftGroups, duplicateDraft, moveDraft, moveFolder, newFolder, openDraft,
  openSettings, pasteDraft, placeDraft, refocusEditor, removeThread, renameDraft, renameFolder, saveSettings, selectThread, setDraftTag,
  setDraftThreadFor, startNewDraft, threadLabel, toast, toggleFolder, toggleSidebar,
} from '../actions.js';
import { cleanTitle, TITLE_LIMIT } from '../../doc-utils.mjs';
import { first, Slot } from '../../integrations/ui.js';
import { draftTag, tagList } from '../drafts-meta.js';
import { keyLabel, withKey } from '../keybinds.js';
import { openCount, openPlan, planFor, usePlans } from '../plans.js';
import { getState, useStore, WORKER } from '../store.js';
import { showPage } from '../views.js';
import { InlineInput } from './InlineInput.jsx';
import { IconButton, Tip } from './Tip.jsx';
import { keepFocus } from './Toolbar.jsx';
import { PointerMenu } from './board/BoardMenu.jsx';
import { dismissOnly } from '../../whiteboard.js';

// Sidebar sections are flat (SPEC 7b): Card's layout without its box; the sidebar separates them with thin lines.
const FLAT = 'rounded-none border-0 bg-transparent py-2.5 shadow-none';
const SectionTitle = ({ children }) => <CardTitle className="text-sm">{children}</CardTitle>;

// A draft row's format icon (docs/plans/document.md newDraftModal): a draft without format is a forum post.
const FORMAT_ICONS = { document: FileText, 'forum-post': MessageSquareText, page: File };
function FormatIcon({ format }) {
  const Icon = FORMAT_ICONS[format ?? 'forum-post'] ?? File;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

/** Single-line list row; its hover actions (IconButton reveal) keep their space while hidden, so hovering shifts nothing.
 * data-on marks the active row for HoverActions. */
function Row({ active, onClick, title, className, children, ...props }) {
  return (
    <div title={title} onClick={onClick} data-on={active || undefined} {...props}
      className={cn('group flex min-h-7.5 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-accent/60', active && 'bg-accent hover:bg-accent', className)}>
      {children}
    </div>
  );
}

/** Hover actions laid over the row's right end instead of taking space, so a title can use the whole row; they show on
 * hover, while the row holds the focus and while one of their menus is open, over the row's own tint. */
function HoverActions({ children }) {
  return (
    <div className="invisible absolute top-1/2 right-1 flex -translate-y-1/2 items-center rounded-md bg-background bg-linear-to-b from-accent/60 to-accent/60 pl-1 group-focus-within:visible group-hover:visible group-data-on:from-accent group-data-on:to-accent has-[[data-state=open]]:visible">
      {children}
    </div>
  );
}

function Threads() {
  const settings = useStore((s) => s.settings);
  usePlans(); // the plan counts
  if (!settings) return null;
  const { threads, selectedThread } = settings;

  // Projects an integration groups (the forum: the year and subject of the thread) go under their two headings, indented: an
  // outer group's inner groups along a guide line, an inner group's projects under it. The rest come first, with no headings.
  const years = new Map();
  for (const t of threads) {
    const [year, subject] = first('projectGroup', t) ?? ['', ''];
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
            {year && <div className="mt-1.5 px-1.5 text-xs font-medium text-muted-foreground">{year}</div>}
            <div className={cn(year && 'ml-2.5 border-l pl-1')}>
            {[...years.get(year).keys()].sort(byName).map((subject) => (
              <div key={subject}>
                {subject && <div className="mt-1 truncate px-1.5 text-xs font-medium text-muted-foreground" title={subject}>{subject}</div>}
                {years.get(year).get(subject).map((t) => (
                  <Row key={t.url} active={t.url === selectedThread} title={first('projectHint', t) ?? t.title}
                    className={cn(subject && 'pl-4')} onClick={() => selectThread(t.url)}>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground group-hover:text-foreground">{t.title || t.url}</span>
                    {planFor(t.url) && (
                      <Tip title="Open tickets in its plan"><span className="shrink-0 text-xs text-muted-foreground tabular-nums">{openCount(planFor(t.url).id)}</span></Tip>
                    )}
                    <IconButton reveal label="Plan board" onClick={() => openPlan(t.url)}><SquareKanban /></IconButton>
                    <Slot name="ProjectRowActions" t={t} />
                    <IconButton reveal label="Remove project from list" data-agent-risk="destructive" onClick={() => removeThread(t)}><X /></IconButton>
                  </Row>
                ))}
              </div>
            ))}
            </div>
          </div>
        ))}
        <Button variant="ghost" size="xs" className="mt-0.5 w-full justify-start text-muted-foreground" data-add-thread onClick={addThreadUrl}>
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

/** The draft's tag dot, in a fixed slot at the left of the row so titles line up; it opens the tag menu. Clicks stop at the
 * dot and the menu: they bubble (through the portal) to the row. */
function TagMenu({ id, tag, tags, open, setOpen }) {
  const stop = (e) => e.stopPropagation();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tip title={tag?.name ?? 'No tag'}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`Tag: ${tag?.name ?? 'none'}`} onClick={stop}
            className="flex size-4 shrink-0 items-center justify-center rounded-full outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent">
            <Dot color={tag?.color} />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" onCloseAutoFocus={refocusEditor} onClick={stop} onPointerDown={stop}>
        <TagItems id={id} tag={tag} tags={tags} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The tag choices of draft `id` (its tag `tag`): the tag dot's menu and the sidebar menu's Tag submenu. */
function TagItems({ id, tag, tags }) {
  return (
    <>
      {tags.map((t) => (
        <DropdownMenuCheckboxItem key={t.id} checked={tag?.id === t.id} onSelect={() => setDraftTag(id, t.id)}><Dot color={t.color} />{t.name}</DropdownMenuCheckboxItem>
      ))}
      {tags.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuCheckboxItem checked={!tag} onSelect={() => setDraftTag(id, null)}><Dot />No tag</DropdownMenuCheckboxItem>
    </>
  );
}

/** The Folder and Project choices of draft `d` (in `folderId`): the row's Move to... menu and the sidebar menu's Move to
 * submenu. The project is fixed while the background window holds the draft (§7i). */
function MoveItems({ d, folderId, folders, threads, background }) {
  return (
    <>
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
    </>
  );
}

/** A draft row: a click opens the draft; a double-click on the title renames it in place (docs/plans/sidebar-menu.md decision
 * 1; its first click opens the draft): Enter or blur saves, Escape, an empty box or the same title saves nothing. */
function DraftRow({ d, folderId, folders, threads, tag, tags, active, dragging, cut, menu, after, renaming, setRenaming, onDrag }) {
  const [tagging, setTagging] = useState(false); // the tag menu is open
  const working = useStore((s) => s.bgWrites.includes(d.id)); // the assistant wrote to it in the background this turn (§7i)
  const background = useStore((s) => s.worker?.draftId === d.id); // the background window of computer use has it (§7i)
  return (
    <DropdownMenu>
      <Row active={active} title={d.title || 'Untitled draft'} data-draft={d.id}
        className={cn('relative select-none', folderId && 'pl-6', (dragging || cut) && 'opacity-50', menu && !active && 'bg-accent/60', line(after, folderId))}
        onPointerDown={onDrag} onClick={(e) => {
          if (e.target.closest('input')) return; // the rename box
          if (getState().draft?.id === d.id) showPage('editor');
          else openDraft(d.id);
        }}>
        <TagMenu id={d.id} tag={tag} tags={tags} open={tagging} setOpen={setTagging} />
        <FormatIcon format={d.format} />
        {renaming ? (
          <InlineInput aria-label="Draft title" value={d.title} maxLength={TITLE_LIMIT} className="flex-1 text-sm"
            onDone={(title) => {
              setRenaming(null);
              if (title?.trim() && cleanTitle(title) !== d.title) renameDraft(d.id, title);
            }} />
        ) : (
          <span className="min-w-0 flex-1 truncate" onDoubleClick={() => setRenaming(d.id)}>{d.title || 'Untitled draft'}</span>
        )}
        {(working || background) && (
          <Badge variant="secondary" data-draft-assistant className="shrink-0 gap-1 px-1.5 py-0">{working && <Spinner className="size-3" />}Assistant</Badge>
        )}
        <Slot name="DraftRowBadge" d={d} />
        {!renaming && ( // they would show over the rename box, which has the focus
          <HoverActions>
            <Slot name="DraftRowActions" d={d} />
            <IconButton label="Move to..." slot={DropdownMenuTrigger}><FolderInput /></IconButton>
            <IconButton label="Delete draft" variant="destructive-ghost" data-agent-risk="destructive" onClick={() => deleteDraft(d)}><Trash2 /></IconButton>
          </HoverActions>
        )}
      </Row>
      {/* Outside the Row: React events bubble out of the portal, and a menu click must not open the draft. */}
      <DropdownMenuContent align="end" className="max-w-72" onCloseAutoFocus={refocusEditor}>
        <MoveItems d={d} folderId={folderId} folders={folders} threads={threads} background={background} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One click opens or closes the folder; a double-click on the name renames it (its two clicks toggle twice). */
function FolderRow({ group: { folder, drafts }, over, menu, renaming, setRenaming, onDrag }) {
  const Icon = folder.open ? FolderOpen : Folder;
  return (
    <Row className={cn('select-none', menu && 'bg-accent/60', over && 'bg-accent ring-1 ring-ring')} onPointerDown={onDrag}
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
      <IconButton reveal label="Delete folder" variant="destructive-ghost" data-agent-risk="destructive" onClick={() => deleteFolder(folder)}><Trash2 /></IconButton>
    </Row>
  );
}

/** The Drafts right-click menu (docs/plans/sidebar-menu.md decision 4) at `menu.at` for a draft row, a folder row or the empty
 * space (`menu.kind`, `menu.id`; `menu.folderId`: the folder the right-click was in, null: the top level). A picked item runs
 * once the menu has closed and the focus is back (DraftMenu's pattern), so the rename box and the dialogs get the focus. */
function DraftsMenu({ menu, settings, setRenaming, onClose }) {
  const picked = useRef(null);
  const background = useStore((s) => s.worker?.draftId ?? null);
  useStore((s) => s.draftClip); // Paste follows the clipboard
  const pick = (fn) => (picked.current = fn);
  const item = (label, Icon, fn, { disabled, risk } = {}) => (
    <DropdownMenuItem key={label} disabled={disabled} variant={risk === 'destructive' ? 'destructive' : undefined} data-agent-risk={risk}
      onSelect={() => pick(fn)}><Icon />{label}</DropdownMenuItem>
  );
  const newFolderItem = item('New folder', FolderPlus, async () => setRenaming(await newFolder()));
  const paste = item('Paste', ClipboardPaste, () => pasteDraft(menu.folderId), { disabled: !canPaste() });
  let body;
  if (menu.kind === 'draft') {
    const d = getState().drafts.find((x) => x.id === menu.id);
    if (!d) return null;
    body = (
      <>
        <DropdownMenuItem inset onSelect={() => pick(() => (getState().draft?.id === d.id ? showPage('editor') : openDraft(d.id)))}>Open</DropdownMenuItem>
        {item('New draft here', FilePlus, () => startNewDraft({ folderId: menu.folderId }))}
        <DropdownMenuSeparator />
        {item('Rename', Pencil, () => setRenaming(d.id), { disabled: background === d.id })}
        {item('Duplicate', CopyPlus, () => duplicateDraft(d.id).catch((e) => toast(e.message, true)))}
        <DropdownMenuSeparator />
        {item('Cut', Scissors, () => cutDraft(d.id))}
        {item('Copy', Copy, () => copyDraft(d.id))}
        {paste}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger><FolderInput />Move to</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-w-72">
            <MoveItems d={d} folderId={menu.folderId} folders={settings.folders || []} threads={settings.threads} background={background === d.id} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger><Tag />Tag</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <TagItems id={d.id} tag={draftTag(settings, d.id)} tags={tagList(settings)} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <Slot name="DraftMenuItems" d={d} pick={pick} />
        <DropdownMenuSeparator />
        {item('Delete', Trash2, () => deleteDraft(d), { risk: 'destructive' })}
      </>
    );
  } else if (menu.kind === 'folder') {
    const folder = (settings.folders || []).find((f) => f.id === menu.id);
    if (!folder) return null;
    body = (
      <>
        {item('New draft here', FilePlus, () => startNewDraft({ folderId: folder.id }))}
        {newFolderItem}
        <DropdownMenuSeparator />
        {item('Rename', Pencil, () => setRenaming(folder.id))}
        {paste}
        <DropdownMenuSeparator />
        {item('Delete folder', Trash2, () => deleteFolder(folder), { risk: 'destructive' })}
      </>
    );
  } else {
    body = (
      <>
        {item('New draft', FilePlus, () => startNewDraft({ folderId: null }))}
        {newFolderItem}
        <DropdownMenuSeparator />
        {paste}
      </>
    );
  }
  const runPicked = (e) => {
    refocusEditor(e);
    const fn = picked.current;
    picked.current = null;
    fn?.();
  };
  return <PointerMenu key={menu.n} at={menu.at} onClose={onClose} onCloseAutoFocus={runPicked}>{body}</PointerMenu>;
}

let menus = 0; // DraftsMenu's key: each right-click opens a new menu

function Drafts() {
  const settings = useStore((s) => s.settings);
  useStore((s) => s.drafts);
  const currentId = useStore((s) => s.draft?.id);
  const editorShown = useStore((s) => s.view.type === 'editor'); // the open draft's row is highlighted only on the editor page
  const cutId = useStore((s) => (s.draftClip?.cut ? s.draftClip.id : null)); // the cut row shows faded until it is pasted
  const [renaming, setRenaming] = useState(null); // id of the folder or draft being renamed
  const [drag, setDrag] = useState(null); // { id, folder, to, after } while a draft or folder row is dragged (dragRow)
  const [menu, setMenu] = useState(null); // { at, kind, id, folderId, n } while the right-click menu is open (DraftsMenu)
  const dismissed = useRef(false); // this right-click only closes a popup (SPEC 6c Dismiss-only clicks)
  if (!settings) return null;
  const { groups, loose } = draftGroups();
  const row = (d, folderId) => (
    <DraftRow key={d.id} d={d} folderId={folderId} folders={settings.folders || []} threads={settings.threads} tag={draftTag(settings, d.id)} tags={tagList(settings)}
      active={editorShown && currentId === d.id} cut={cutId === d.id} menu={menu?.kind === 'draft' && menu.id === d.id}
      dragging={drag?.id === d.id} after={!drag?.folder && drag?.to === d.id ? drag.after : undefined}
      renaming={renaming === d.id} setRenaming={setRenaming} onDrag={(e) => dragRow(e, d.id, false, setDrag)} />
  );
  // The target: a draft row, else a folder (its wrapper holds its rows), else the card's empty space (its header too). The
  // menu replaces the native one (main never gets context-menu); the rename box keeps the native text menu. A right-click in a
  // portalled menu bubbles here through React and opens nothing. Shift+F10 on a row's focused tag dot targets that row.
  const onContextMenu = (e) => {
    const only = dismissed.current;
    dismissed.current = false; // a keyboard-opened menu has no pointerdown, so it never reads a stale flag
    if (e.target.closest('input')) return;
    e.preventDefault();
    if (only || !e.currentTarget.contains(e.target)) return;
    const draft = e.target.closest('[data-draft]');
    const folderId = e.target.closest('[data-drop]')?.dataset.drop || null;
    setMenu({ at: { x: e.clientX, y: e.clientY }, kind: draft ? 'draft' : folderId ? 'folder' : 'space', id: draft?.dataset.draft ?? folderId,
      folderId, n: ++menus });
  };

  return (
    <Card className={`${FLAT} flex-1 gap-1.5`} data-drop="" onContextMenu={onContextMenu}
      onPointerDownCapture={(e) => { if (e.button === 2) dismissed.current = dismissOnly(e); }}>
      <CardHeader className="px-2.5">
        <SectionTitle>Drafts</SectionTitle>
        <CardAction className="flex">
          <IconButton label="New folder" className="text-muted-foreground" onClick={async () => setRenaming(await newFolder())}><FolderPlus /></IconButton>
          <Tip title={withKey('New draft', 'app.newDraft')}>
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={startNewDraft}><Plus />New draft</Button>
          </Tip>
        </CardAction>
      </CardHeader>
      <CardContent className="px-1">
        {groups.map((g) => (
          <div key={g.folder.id} data-drop={g.folder.id}
            className={cn(drag?.id === g.folder.id && 'opacity-50', drag?.folder && drag.to === g.folder.id && line(drag.after))}>
            <FolderRow group={g} over={!drag?.folder && drag?.to === g.folder.id} menu={menu?.kind === 'folder' && menu.id === g.folder.id}
              renaming={renaming === g.folder.id} setRenaming={setRenaming}
              onDrag={(e) => dragRow(e, g.folder.id, true, setDrag)} />
            {g.folder.open && g.drafts.map((d) => row(d, g.folder.id))}
          </div>
        ))}
        {loose.map((d) => row(d, null))}
        {!groups.length && !loose.length && <p className="px-1.5 py-1 text-xs text-muted-foreground">No drafts.</p>}
      </CardContent>
      {menu && <DraftsMenu menu={menu} settings={settings} setRenaming={setRenaming} onClose={() => setMenu(null)} />}
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
        <IconButton size="regular" label="Your work is not backed up" tip={{ side: 'top' }} data-backup-warning className="text-destructive hover:text-destructive"
          onMouseDown={keepFocus} onClick={() => setWarning(true)}><CircleAlert /></IconButton>
      )}
      <IconButton size="regular" label={title} tip={{ side: 'top' }} data-backup-status onMouseDown={keepFocus} onClick={() => openSettings('github')}>
        <Icon className={cls} />
      </IconButton>
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
      {/* The viewport's content box is a full-height column (the ! beats Radix's inline display: table), so the Drafts card
          reaches the bottom: a right-click or a drop under the list lands on its empty space (sidebar-menu.md decision 4). */}
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:flex! [&_[data-slot=scroll-area-viewport]>div]:min-h-full [&_[data-slot=scroll-area-viewport]>div]:flex-col">
        <aside className="flex flex-1 flex-col divide-y text-sm">
          <Threads />
          <Drafts />
        </aside>
      </ScrollArea>
      <SidebarNav />
    </div>
  );
}

/** Hides or shows the sidebar (also Ctrl+\): in the editor's corner (SidebarToggle, `size` 'regular') and, compact, in the
 * workspace headers. */
export function SidebarButton({ side, size }) {
  const collapsed = useStore((s) => !!s.settings?.sidebarCollapsed);
  return (
    <IconButton label={`${collapsed ? 'Show' : 'Hide'} sidebar`} keybind="app.sidebar" size={size} tip={{ side }} onMouseDown={keepFocus} onClick={toggleSidebar}>
      {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
    </IconButton>
  );
}

/** Floating at the bottom-left of the editor area, the width of the board rail above it. In the editor, the only sidebar
 * control while the sidebar is hidden. */
export function SidebarToggle() {
  return (
    <div className="absolute bottom-3 left-2 z-30 rounded-island border bg-island p-1 shadow-xl">
      <SidebarButton side="right" size="regular" />
    </div>
  );
}
