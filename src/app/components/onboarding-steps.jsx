import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { discoverThreads, login, openSettings } from '../actions.js';
import { refreshStatus, usable, useAssistant } from '../assistant/assistant.js';
import { openInstall } from '../dictation/dictation.js';
import { keyLabel, withKey } from '../keybinds.js';
import { useStore } from '../store.js';

// The first-run tour's steps (Onboarding.jsx runs them). Each step: `title`; `body`, a component returning one <p> (the card
// lays the body out as a grid), so the shortcuts in it follow a rebind (keyLabel / withKey read at render); `target`, a CSS
// selector of the element the ring marks (null: none); `view`, the page "Show me" opens (views.js showPage); `Actions`, a
// component ({ next }) for the footer's left side.

const Kbd = ({ id }) => <kbd className="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-xs">{keyLabel(id)}</kbd>;
const Note = ({ children }) => <span className="text-xs text-muted-foreground">{children}</span>;

function DictationActions({ next }) {
  const installed = useStore((s) => !!s.settings?.dictation?.installed);
  if (installed) return <Note>Dictation is installed.</Note>;
  return (
    <>
      <Button size="sm" variant="outline" onClick={async () => (await openInstall())?.installed && next()}>Install dictation...</Button>
      <Button size="sm" variant="ghost" onClick={next}>Skip</Button>
    </>
  );
}

function AssistantActions({ next }) {
  const ready = usable(useAssistant().status);
  useEffect(() => { refreshStatus(); }, []);
  if (ready) return <Note>The assistant is ready.</Note>;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => openSettings('assistant').then(refreshStatus)}>Set up assistant...</Button>
      <Button size="sm" variant="ghost" onClick={next}>Skip</Button>
    </>
  );
}

function ThreadActions() {
  const status = useStore((s) => s.status);
  const loggingIn = useStore((s) => s.loggingIn);
  const discovering = useStore((s) => s.discovering);
  return (
    <>
      {status.loggedIn
        ? <Note>{`Logged in as ${status.name || `member ${status.memberId}`}`}</Note>
        : <Button size="sm" variant="outline" disabled={loggingIn} onClick={login}>Log in...</Button>}
      <Button size="sm" variant="outline" disabled={!status.loggedIn || discovering} onClick={discoverThreads}>Find my threads</Button>
    </>
  );
}

const toolbar = (label) => `[data-agent-area="toolbar"] [aria-label^="${label}"]`; // its title carries the key: "Insert canvas (Ctrl+Alt+C)"
const tab = (n) => `nav[aria-label="Workspaces"] > button:nth-child(${n})`; // Plans, Flowcharts, Browser

export const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to EasyWriter',
    body: () => <p>Write your development thread posts here, then push each one into the forum's reply box. This tour shows where things are, and its card stays open while you try them.</p>,
    target: null, view: null, Actions: null,
  },
  {
    id: 'settings',
    title: 'Settings',
    body: () => <p>The gear at the top of the sidebar opens Settings. Dictation and the assistant, both later in this tour, are set up there.</p>,
    target: '[data-agent-area="sidebar"] [aria-label="Settings"]', view: null, Actions: null,
  },
  {
    id: 'whiteboard',
    title: 'Whiteboards',
    body: () => <p>{withKey('Insert whiteboard', 'insert.whiteboard')} adds a drawing board to the post. Click into it and the rail at the left of the editor shows the board tools. Paste or drop images onto it.</p>,
    target: toolbar('Insert whiteboard'), view: 'editor', Actions: null,
  },
  {
    id: 'canvas',
    title: 'Smart canvas',
    body: () => <p>{withKey('Insert canvas', 'insert.canvas')} adds a smart canvas, a drawing area that goes into the post as one picture. It opens for editing at once and Done closes it. Double-click it later to edit it again.</p>,
    target: toolbar('Insert canvas'), view: 'editor', Actions: null,
  },
  {
    id: 'flowchart',
    title: 'Flowcharts',
    body: () => <p>{withKey('Insert flowchart', 'insert.flowchart')} adds a new flowchart or one from your library. A synced flowchart matches the library, so an edit to it shows everywhere it is placed. To keep one as it is, select it and click Unlink on its bar. The Flowcharts tab in the sidebar holds the library.</p>,
    target: toolbar('Insert flowchart'), view: 'editor', Actions: null,
  },
  {
    id: 'prefabs',
    title: 'Prefabs',
    body: () => <p>Select items on a board, right-click and choose Create prefab... to save them as a group. It appears under Prefabs in the Shape tool's list, and in the shape panel when you edit a flowchart from the Flowcharts tab. Click it there, then click a board to place a copy.</p>,
    target: tab(2), view: 'flows', Actions: null,
  },
  {
    id: 'plans',
    title: 'Plans',
    body: () => <p>Each forum thread can have a plan, {withKey('opened from the Plans tab', 'app.plans')}. Backlog lists every ticket in the plan. Board shows the same tickets as cards you drag between status columns, and Gantt shows them as bars you drag to set dates.</p>,
    target: tab(1), view: 'plan', Actions: null,
  },
  {
    id: 'keys',
    title: 'Quick tools and tool search',
    body: () => (
      <p>
        <Kbd id="app.quickTools" /> opens quick tools at the pointer. <Kbd id="app.toolSearch" /> opens tool search, where you type
        what you want, such as "red" or "arrow". Both offer the tools for what you are working on, and in tool search a selected
        flowchart or plan chart lists its own actions first. Keys can be changed in Settings &gt; Keybinds.
      </p>
    ),
    target: null, view: null, Actions: null,
  },
  {
    id: 'dictation',
    title: 'Dictation',
    body: () => <p>{withKey('Hold the mic button', 'app.dictate')} and speak. The words appear in a pane at the bottom, where you can copy them. Dictation runs Whisper on this computer after a one-time download, so no audio leaves it.</p>,
    target: '[data-dictation-island]', view: null, Actions: DictationActions,
  },
  {
    id: 'assistant',
    title: 'Assistant',
    body: () => <p>{withKey('The chat button', 'app.assistant')} opens an assistant that can read and edit your drafts and plans. It needs an API key from a cloud provider, and Qwen Cloud has a free tier.</p>,
    target: '[data-chat-island]', view: null, Actions: AssistantActions,
  },
  {
    id: 'threads',
    title: 'Your threads',
    body: () => <p>Log in to the forum, then Find my threads lists your development threads in the sidebar. Add thread URL, under the list, adds one thread by its link.</p>,
    target: '[data-agent-area="sidebar"] [aria-label="Find my threads"]', view: null, Actions: ThreadActions,
  },
  {
    id: 'done',
    title: 'Ready to write',
    body: () => <p>Hover over a button to see what it does, with its key when it has one. Replay this tour any time from Settings &gt; General.</p>,
    target: null, view: null, Actions: null,
  },
];
