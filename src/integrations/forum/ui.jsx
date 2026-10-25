// The forum integration's renderer contributions (docs/plans/integrations.md Registry), listed by integrations/ui.js. Hooks
// call through the actions namespace, never a bare imported binding: this module can be evaluated inside the
// app/actions.js cycle, before forum/actions.js has run. The same goes for the app/* imports below: read only at render or call.
import { useState } from 'react';
import { CircleCheck, ExternalLink, Link2, MessagesSquare, Send, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { openDraft, openSettings, threadLabel } from '../../app/actions.js';
import { FormDialog } from '../../app/components/FormDialog.jsx';
import { IconButton, Tip } from '../../app/components/Tip.jsx';
import { getState, useStore } from '../../app/store.js';
import { isProject } from '../../thread-url.mjs';
import * as actions from './actions.js';
import { enabled } from '../index.mjs';
import { forumOrigin, hasForum } from './topic.mjs';

const THREAD_HINT = 'https://forum.example.com/topic/12345-.../';
const FIELDS = 'grid grid-cols-[8rem_auto] items-center justify-start gap-x-3 gap-y-2'; // Settings' label column | control

/** The status bar's forum sign-in (once a project has a forum thread): opens the forum window, to log in or to see the forum. */
function StatusBarItem() {
  const status = useStore((s) => s.status);
  const loggingIn = useStore((s) => s.loggingIn);
  const forum = useStore((s) => hasForum(s.settings));
  if (!forum) return null;
  return (
    <Tip title={status.loggedIn ? 'Open the forum window' : 'Log in to the forum in the forum window'} side="top">
      <Button variant="ghost" size="xs" aria-label={status.loggedIn ? 'Forum window' : 'Log in'} data-agent-risk="approval" disabled={loggingIn}
        className="-mx-2 font-normal text-muted-foreground" onClick={actions.login}>
        {status.loggedIn ? `Forum: logged in as ${status.name || status.memberId}` : 'Forum: not logged in'}
      </Button>
    </Tip>
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

const DraftRowBadge = ({ d }) => d.pushedAt && <Tip title="Pushed to the forum"><CircleCheck className="size-3.5 shrink-0 text-success" aria-label="Pushed" /></Tip>;

/** Push to forum for draft `id`: the open one at once, another once it is open (push fills the reply box with the open draft). */
async function pushDraft(id) {
  if (getState().draft?.id !== id) await openDraft(id);
  if (getState().draft?.id === id) actions.push();
}

/** A draft row's hover actions: Unpush once pushed, else Push to forum while its project links a forum thread. With the forum
 * off they show on the open forum draft's row only (integrations/ui.js Slot) and first ask to turn it back on (actions.wake). */
function DraftRowActions({ d }) {
  if (d.pushedAt) {
    return <IconButton label="Unpush" data-agent-risk="destructive" onClick={async () => (await actions.wake('Unpushing')) && actions.unpushDraft(d)}><Undo2 /></IconButton>;
  }
  return actions.projectTopic(d.threadUrl)
    && <IconButton label="Push to forum" data-agent-risk="approval" onClick={async () => (await actions.wake('Pushing')) && pushDraft(d.id)}><Send /></IconButton>;
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

export default {
  actions,
  // app/actions.js init and changeSettings, never in the background window: the sign-in follows the forum site and the switch.
  init: () => actions.refreshStatus(),
  onSettings: (prev, next) => {
    if (next.forumUrl !== prev.forumUrl || hasForum(next) !== hasForum(prev)) actions.refreshStatus();
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
  TourProjects,
  FORMS: { forumNewProject: ForumNewProjectDialog, projectThread: ProjectThreadDialog, chooseThread: ChooseThreadDialog },
  // tools.js: the integration.forum gate hides them while the forum is off. Push runs push() itself (push.prepare's gates): through
  // the executor it would get the 300 s timeout while the confirm and the upload wait. push-wake is Push to forum while the
  // forum is off, on a forum draft only (gate wake.forum, untagged): it asks to turn the forum back on first (plan step 9).
  TOOLS: [
    { id: 'push', label: 'Push to forum', group: 'App', icon: <Send />, risk: 'approval', run: () => actions.push(),
      needs: ['integration.forum', 'app.forum', 'doc.open', 'draft.hasThread', 'draft.unpushed'],
      keywords: ['push', 'post', 'publish', 'send', 'forum', 'reply', 'upload', 'submit', 'share'] },
    { id: 'push-wake', label: 'Push to forum', group: 'App', icon: <Send />, risk: 'approval',
      run: async () => (await actions.wake('Pushing')) && actions.push(),
      needs: ['doc.open', 'wake.forum', 'draft.unpushed'], also: () => !enabled(getState().settings, 'forum'),
      keywords: ['push', 'post', 'publish', 'send', 'forum', 'reply', 'upload', 'submit', 'share'] },
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
