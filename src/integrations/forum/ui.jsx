// The forum integration's renderer contributions (docs/plans/integrations.md Registry), listed by integrations/ui.js. Hooks
// call through the actions namespace, never a bare imported binding: this module can be evaluated inside the
// app/actions.js cycle, before forum/actions.js has run. The same goes for the app/* imports below: read only at render or call.
import { useEffect, useRef, useState } from 'react';
import { CircleCheck, Download, ExternalLink, Link2, LogIn, MessageSquareText, MessagesSquare, Plus, RotateCw, Send, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { openDraft, openSettings, threadLabel } from '../../app/actions.js';
import { FormDialog } from '../../app/components/FormDialog.jsx';
import { IconButton, Tip } from '../../app/components/Tip.jsx';
import { PALETTE } from '../../app/commands/palette.mjs';
import { ipcMessage } from '../../app/setup/shared.jsx';
import { can } from '../../app/gates.mjs';
import { getState, useStore } from '../../app/store.js';
import { isProject } from '../../thread-url.mjs';
import * as actions from './actions.js';
import { FORMAT_POST } from './commands.mjs';
import { enabled } from '../index.mjs';
import { forumOrigin, hasForum, listTopic, siteOf, topicId } from './topic.mjs';

const THREAD_HINT = 'https://forum.example.com/topic/12345-.../';
const FIELDS = 'grid grid-cols-[8rem_auto] items-center justify-start gap-x-3 gap-y-2'; // Settings' label column | control

/** The status bar's forum sign-in (once a project has a forum thread): opens the forum window, to log in or to see the forum.
 * While imported posts' pictures and videos download (actions.downloadMedia), their count. */
function StatusBarItem() {
  const status = useStore((s) => s.status);
  const loggingIn = useStore((s) => s.loggingIn);
  const forum = useStore((s) => hasForum(s.settings));
  const downloads = useStore((s) => s.forumDownloads ?? 0);
  if (!forum) return null;
  return (
    <>
      {downloads > 0 && <span className="text-muted-foreground" data-forum-downloads={downloads}>{`Downloading ${downloads} ${downloads === 1 ? 'picture or video' : 'pictures and videos'}`}</span>}
      <Tip title={status.loggedIn ? 'Open the forum window' : 'Log in to the forum in the forum window'} side="top">
        <Button variant="ghost" size="xs" aria-label={status.loggedIn ? 'Forum window' : 'Log in'} data-agent-risk="approval" disabled={loggingIn}
          className="-mx-2 font-normal text-muted-foreground" onClick={actions.login}>
          {status.loggedIn ? `Forum: logged in as ${status.name || status.memberId}` : 'Forum: not logged in'}
        </Button>
      </Tip>
    </>
  );
}

/** A project row's forum actions, after Plan board: open its thread, and link, change or unlink it (project keys only). */
function ProjectRowActions({ t }) {
  const topic = actions.projectTopic(t.url);
  return (
    <>
      {topic && <IconButton reveal label="Open in forum" data-agent-risk="approval" onClick={() => actions.openInForum(topic)}><ExternalLink /></IconButton>}
      {isProject(t.url) && <IconButton reveal label={topic ? 'Change or unlink the forum thread' : 'Link a forum thread'} onClick={() => actions.editProjectThread(t)}><Link2 /></IconButton>}
    </>
  );
}

// Forum services follow the draft's format (gate format.post): a document's row has no push badge or push actions.
const DraftRowBadge = ({ d }) => d.pushedAt && can('format.post', d)
  && <Tip title="Pushed to the forum"><CircleCheck className="size-3.5 shrink-0 text-success" aria-label="Pushed" /></Tip>;

/** Push to forum for draft `id`: the open one at once, another once it is open (push fills the reply box with the open draft). */
async function pushDraft(id) {
  if (getState().draft?.id !== id) await openDraft(id);
  if (getState().draft?.id === id) actions.push();
}

/** A draft's forum action → {label, Icon, risk, run}, or null: Unpush once pushed, else Push to forum while its project links a
 * forum thread. With the forum off, the slots show it on the open forum draft only (integrations/ui.js Slot), and `run` first
 * asks to turn the forum back on (actions.wake). */
function pushAction(d) {
  if (!can('format.post', d)) return null;
  if (d.pushedAt) return { label: 'Unpush', Icon: Undo2, risk: 'destructive', run: async () => (await actions.wake('Unpushing')) && actions.unpushDraft(d) };
  if (!actions.projectTopic(d.threadUrl)) return null;
  // Not while suggestions wait in it (gate draft.settled): the open draft's live count, another's summary.
  const st = getState();
  if (!can('draft.settled', st.draft?.id === d.id && st.editor ? { suggestions: st.suggestions.count } : d)) return null;
  return { label: 'Push to forum', Icon: Send, risk: 'approval', run: async () => (await actions.wake('Pushing')) && pushDraft(d.id) };
}

/** A draft row's hover action (pushAction). */
function DraftRowActions({ d }) {
  const a = pushAction(d);
  return a && <IconButton label={a.label} data-agent-risk={a.risk} onClick={a.run}><a.Icon /></IconButton>;
}

/** The same action in the sidebar's right-click menu of a draft (docs/plans/sidebar-menu.md decision 4): `pick` runs it once
 * the menu has closed. */
function DraftMenuItems({ d, pick }) {
  const a = pushAction(d);
  return a && (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem data-agent-risk={a.risk} onSelect={() => pick(a.run)}><a.Icon />{a.label}</DropdownMenuItem>
    </>
  );
}

/** New project (actions.newProject): a name, a forum thread (optional), or both → {name, thread}. */
function ForumNewProjectDialog({ validate, onClose }) {
  const [name, setName] = useState('');
  const [thread, setThread] = useState('');
  return (
    <FormDialog title="New project" okText="Create" validate={() => validate({ name, thread })} result={() => ({ name, thread })} onClose={onClose}>
      <Input aria-label="Project name" className="h-8" maxLength={200} value={name} placeholder="Project name" onChange={(e) => setName(e.target.value)} />
      <Input aria-label="Forum thread" spellCheck={false} className="h-8" value={thread} placeholder="Forum thread link (optional)"
        onChange={(e) => setThread(e.target.value)} />
    </FormDialog>
  );
}

/** A project's forum thread: its topic URL, or empty to unlink it. */
function ProjectThreadDialog({ value: start, validate, onClose }) {
  const [value, setValue] = useState(start);
  return (
    <FormDialog title="Forum thread" okText={value.trim() || !start ? 'Link' : 'Unlink'} validate={() => validate(value)} result={() => value} onClose={onClose}>
      <Input aria-label="Forum thread" spellCheck={false} className="h-8" value={value} placeholder={THREAD_HINT} onChange={(e) => setValue(e.target.value)} />
    </FormDialog>
  );
}

function ChooseThreadDialog({ threads, selected, onClose }) {
  const [value, setValue] = useState(threads.some((t) => t.url === selected) ? selected : threads[0].url);
  return (
    <FormDialog title="Choose the project to push this draft to" okText="Use project" result={() => value} onClose={onClose}>
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {threads.map((t) => <SelectItem key={t.url} value={t.url}>{threadLabel(t)}</SelectItem>)}
        </SelectContent>
      </Select>
    </FormDialog>
  );
}

/** Settings > Forum: the forum site. `value` is {forumUrl} as typed. The page width is core (Settings > General). */
function ForumSection({ value, onChange }) {
  const edit = (patch) => onChange({ ...value, ...patch });
  return (
    <div className={FIELDS}>
      <Label htmlFor="set-forum" className="text-muted-foreground">Forum site</Label>
      <div className="flex items-center gap-2">
        <Input id="set-forum" type="url" className="h-8 w-72" spellCheck={false} placeholder="None yet" value={value.forumUrl}
          onChange={(e) => edit({ forumUrl: e.target.value })} />
        <span className="text-xs text-muted-foreground">The first forum thread you link to a project sets it</span>
      </div>
    </div>
  );
}

/** The tour's Projects step: what a forum thread does, and the forum's sign-in once a project has one (settings.forumUrl). */
function TourProjects() {
  const forum = useStore((s) => hasForum(s.settings));
  const status = useStore((s) => s.status);
  const loggingIn = useStore((s) => s.loggingIn);
  return (
    <>
      <p className="basis-full">A project can link a forum thread, and Push on its row then fills that thread's reply box with the open draft.</p>
      {forum && (status.loggedIn
        ? <span className="text-xs text-muted-foreground">{`Logged in as ${status.name || `member ${status.memberId}`}`}</span>
        : <Button size="sm" variant="outline" disabled={loggingIn} onClick={actions.login}>Log in...</Button>)}
    </>
  );
}

const count = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

/** The setup's forum page (docs/plans/onboarding.md, Forum import), shown while the forum is on: the user lists the links of
 * their forum threads and signs in in the forum window, the threads become projects, and the member's earlier posts in them
 * can come in as drafts. With no threads the user skips it. */
function SetupThreads({ next, setBusy, setDone }) {
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.status);
  const [links, setLinks] = useState([]); // canonical topic URLs
  const [text, setText] = useState('');
  const [bad, setBad] = useState(''); // why the typed link was refused
  const [error, setError] = useState('');
  // list, checking (asks the forum whether the member is signed in), waiting (the forum window is open), closed (it closed with
  // nobody signed in), linking, ask, importing, done
  const [phase, setPhase] = useState('list');
  const [keys, setKeys] = useState([]); // the threads' project keys, once linked
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const run = useRef(0); // the sign-in in progress: Cancel and leaving the page drop it
  useEffect(() => () => { run.current++; }, []);
  const site = settings.forumUrl || siteOf(links[0]);
  const editable = phase === 'list' || phase === 'closed';
  const projectOf = (u) => settings.threads.find((t) => topicId(actions.projectTopic(t.url)) === topicId(u));

  const add = (e) => {
    e.preventDefault();
    const r = listTopic(links, text, site);
    setBad(r.error ?? '');
    if (!r.topic) return;
    setLinks([...links, r.topic]);
    setText('');
  };
  // Cancel stops the wait here only: the forum window stays open until the user closes it.
  const signIn = async () => {
    const at = ++run.current;
    setError('');
    setPhase('checking');
    try {
      const st = await actions.signIn(site, () => {
        if (run.current !== at) return false; // cancelled while the forum was asked
        setPhase('waiting');
      });
      if (run.current !== at) return;
      if (!st.loggedIn) return setPhase('closed');
      setPhase('linking');
      const k = await actions.linkThreads(links);
      if (run.current !== at) return;
      setKeys(k);
      setPhase('ask');
    } catch (e) {
      if (run.current !== at) return;
      setError(ipcMessage(e));
      setPhase('list');
    }
  };
  const importNow = async () => {
    setError('');
    setProgress(null);
    setPhase('importing');
    setBusy(true);
    try {
      setResult(await actions.importPosts(keys, setProgress));
      setPhase('done');
      setDone(true);
    } catch (e) {
      setError(ipcMessage(e));
      setPhase('ask');
    } finally {
      setBusy(false);
    }
  };
  const summary = phase === 'done'
    ? [`${count(result.imported, 'post')} imported`, result.skipped && `${result.skipped} imported before`, result.failed.length && `${result.failed.length} could not be read`]
      .filter(Boolean).join(', ') + '.'
    : progress ? `${count(progress.found, 'post')} found, ${progress.imported} imported` : 'Looking for your posts';

  return (
    <div className="grid gap-3" data-forum-setup={phase}>
      <p className="text-muted-foreground">Optional. Paste the full link of each forum thread you write in, and each one becomes a project.</p>
      {editable && (
        <form className="flex items-center gap-2" onSubmit={add}>
          <Input aria-label="Forum thread link" spellCheck={false} className="h-8 flex-1" placeholder={THREAD_HINT} value={text} aria-invalid={!!bad || undefined}
            onChange={(e) => { setText(e.target.value); setBad(''); }} />
          <Button type="submit" size="sm" variant="outline" disabled={!text.trim()}><Plus />Add</Button>
        </form>
      )}
      {bad && <p className="text-destructive" data-forum-bad>{bad}</p>}
      {links.length > 0 && (
        <ul className="grid gap-1.5" data-forum-threads>
          {links.map((u) => {
            const t = projectOf(u);
            return (
              <li key={u} title={u} className="flex h-8 items-center gap-2 rounded-md border pr-1 pl-3">
                <span className="min-w-0 flex-1 truncate">{t ? threadLabel(t) : u}</span>
                {editable && <IconButton label="Remove thread" onClick={() => setLinks(links.filter((x) => x !== u))}><X /></IconButton>}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="text-destructive" data-forum-error>{error}</p>}
      {phase === 'list' && (
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!links.length} onClick={signIn}><LogIn />Sign in to the forum</Button>
          <span className="text-xs text-muted-foreground">The forum window opens, where you sign in with your Microsoft account.</span>
        </div>
      )}
      {(phase === 'checking' || phase === 'waiting') && (
        <div className="flex items-center gap-2">
          <Spinner /><span className="flex-1">{phase === 'checking' ? 'Checking whether you are signed in' : 'Waiting for you to sign in in the forum window'}</span>
          <Button autoFocus variant="ghost" size="sm" onClick={() => { run.current++; setPhase('list'); }}>Cancel</Button>
        </div>
      )}
      {phase === 'closed' && (
        <div className="flex items-center gap-2">
          <span className="flex-1">The forum window closed before you signed in.</span>
          <Button autoFocus size="sm" disabled={!links.length} data-agent-risk="approval" onClick={signIn}><RotateCw />Try again</Button>
        </div>
      )}
      {phase === 'linking' && <p className="flex items-center gap-2"><Spinner />Adding the threads as projects</p>}
      {phase === 'ask' && (
        <div className="grid gap-2">
          {status.loggedIn && <p className="text-muted-foreground">{`Signed in as ${status.name || `member ${status.memberId}`}.`}</p>}
          <p className="font-medium">Import your earlier posts in these threads as drafts?</p>
          <p className="text-muted-foreground">Your own posts become drafts, marked pushed and tagged Done.</p>
          <div className="flex gap-2">
            <Button autoFocus size="sm" data-agent-risk="approval" onClick={importNow}>Yes</Button>
            <Button variant="outline" size="sm" onClick={() => { setDone(true); next(); }}>No</Button>
          </div>
        </div>
      )}
      {(phase === 'importing' || phase === 'done') && (
        <div className="grid gap-1">
          <p className="flex items-center gap-2" data-forum-progress>{phase === 'importing' && <Spinner />}{summary}</p>
          {(phase === 'importing' || result.downloads > 0) && <p className="text-muted-foreground">Pictures and videos download in the background, so you can start writing now.</p>}
        </div>
      )}
    </div>
  );
}

export default {
  actions,
  // app/actions.js init and changeSettings, never in the background window: the sign-in follows the forum site and the switch.
  // The import's downloads left from the last run go on (actions.downloadMedia), also once the forum is turned back on.
  init: () => {
    actions.refreshStatus();
    actions.downloadMedia();
  },
  onSettings: (prev, next) => {
    if (next.forumUrl !== prev.forumUrl || hasForum(next) !== hasForum(prev)) actions.refreshStatus();
    if (enabled(next, 'forum') && !enabled(prev, 'forum')) actions.downloadMedia();
  },
  projectLabel: (t) => (t.subject ? `${t.subject} / ${t.title}` : undefined),
  // Sidebar grouping: the year and subject the forum names on the thread's page.
  projectGroup: (t) => [t.year || '', t.subject || ''],
  projectHint: (t) => {
    const topic = actions.projectTopic(t.url);
    return topic ? (t.forum ? `${t.forum}\n${topic}` : topic) : undefined;
  },
  resolveProject: (url) => actions.resolveProject(url),
  newProject: () => actions.newProject(),
  opensUrl: (url) => actions.opensUrl(url),
  StatusBarItem,
  ProjectRowActions,
  DraftRowBadge,
  DraftRowActions,
  DraftMenuItems,
  TourProjects,
  // The setup's page after Assistant and dictation while the forum is on (integrations/ui.js setupPages).
  SetupPages: [{ id: 'threads', title: 'Add your forum threads', Page: SetupThreads }],
  FORMS: { forumNewProject: ForumNewProjectDialog, projectThread: ProjectThreadDialog, chooseThread: ChooseThreadDialog },
  // tools.js: the integration.forum gate hides them while the forum is off. Push runs push() itself (push.prepare's gates): through
  // the executor it would get the 300 s timeout while the confirm and the upload wait. push-wake is Push to forum while the
  // forum is off, on a forum draft only (gate wake.forum, untagged): it asks to turn the forum back on first (plan step 9).
  TOOLS: [
    { id: 'push', label: 'Push to forum', group: 'App', icon: <Send />, risk: 'approval', run: () => actions.push(),
      needs: ['integration.forum', 'app.forum', 'doc.open', FORMAT_POST, 'draft.hasThread', 'draft.unpushed', 'draft.settled'],
      keywords: ['push', 'post', 'publish', 'send', 'forum', 'reply', 'upload', 'submit', 'share'] },
    { id: 'push-wake', label: 'Push to forum', group: 'App', icon: <Send />, risk: 'approval',
      run: async () => (await actions.wake('Pushing')) && actions.push(),
      needs: ['doc.open', FORMAT_POST, 'wake.forum', 'draft.unpushed', 'draft.settled'], also: () => !enabled(getState().settings, 'forum'),
      keywords: ['push', 'post', 'publish', 'send', 'forum', 'reply', 'upload', 'submit', 'share'] },
    { id: 'new-forum-post', label: 'New forum post', group: 'App', icon: <MessageSquareText />, command: PALETTE.newDraft,
      args: () => ({ format: 'forum-post' }), needs: ['integration.forum'], keywords: ['new forum post', 'new post', 'forum', 'reply', 'new reply'] },
    { id: 'forum-import', label: 'Import my forum posts', group: 'App', icon: <Download />, risk: 'approval', headless: false,
      run: () => actions.importAll(), needs: ['integration.forum', 'app.forum'],
      keywords: ['import', 'download', 'my posts', 'earlier posts', 'old posts', 'forum', 'drafts'] },
    { id: 'forum-settings', label: 'Forum settings', group: 'App', icon: <MessagesSquare />, needs: ['integration.forum'], headless: false,
      run: () => openSettings('forum'), keywords: ['forum', 'forum site', 'forum address'] },
  ],
  settings: {
    id: 'forum', title: 'Forum', icon: MessagesSquare, hint: 'The forum the drafts are pushed to',
    Section: ForumSection,
    read: (s) => ({ forumUrl: s.forumUrl ?? '' }),
    check: (v) => (v.forumUrl.trim() && !forumOrigin(v.forumUrl) ? 'Enter the forum site address, like https://forum.example.com, or leave it empty.' : ''),
    write: (v) => ({ forumUrl: forumOrigin(v.forumUrl) }),
  },
};
