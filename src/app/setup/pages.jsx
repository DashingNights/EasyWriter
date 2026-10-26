// The setup's own pages (docs/plans/onboarding.md Pages), in order: {id, title, help, Page, step, branch} (flow.mjs). The
// shell (Setup.jsx) draws the step label, title, help and the Back / Continue bar; a Page draws its body and may set the
// bar with setNav({label, disabled, go, hidden, skip: {label, go}}), from an effect. Integration pages come after these but
// before `finish`, so the Assistant and dictation page (`helpers`, helpers.jsx) comes before them.
import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { CloudOff, CloudUpload, Copy, ExternalLink, GraduationCap, History, LogIn, Monitor, Moon, Smile, Sun, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Spinner } from '@/components/ui/spinner';
import { enabled, INTEGRATIONS } from '../../integrations/index.mjs';
import { changeSettings, saveSettings } from '../actions.js';
import { getState, useStore } from '../store.js';
import { scalePercent } from './flow.mjs';
import { Helpers } from './helpers.jsx';
import { copy, IntegrationRows, ipcMessage, RepoPicker, useGitHubStatus, useRepos } from './shared.jsx';

const JOIN = 'https://docs.github.com/en/account-and-profile/how-tos/account-management/creating-an-account-on-github';
const NEW_REPO = 'https://github.com/new';

/** Large choice cards, one of which is picked (a radio group): options [value, label, Icon, picture]. */
function Choices({ label, value, onChange, options }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('grid gap-3', options.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
      {options.map(([v, text, Icon, picture]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} data-choice={String(v)} onClick={() => onChange(v)}
          className="flex flex-col items-center gap-2 rounded-md border p-4 text-center outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-checked:border-primary aria-checked:bg-accent/60">
          {picture}
          <span className="flex items-center gap-2 font-medium">{Icon && <Icon className="size-4" />}{text}</span>
        </button>
      ))}
    </div>
  );
}

const SKIP = (leave) => ({ label: 'Skip backup', go: leave });

function Welcome({ usedBefore, setUsedBefore, setNav }) {
  useEffect(() => setNav({ disabled: usedBefore == null }), [usedBefore]);
  return <>
    <p className="font-medium">Have you used EasyWriter before?</p>
    <Choices label="Have you used EasyWriter before?" value={usedBefore} onChange={setUsedBefore}
      options={[[true, 'Yes, I have', History], [false, "No, I'm new", Smile]]} />
  </>;
}

/** The window zoom (settings.uiScale), so this dialog grows and shrinks with it. A key press applies it at once; a drag
 * shows the percent as it moves and applies it on release, since zooming the bar under the pointer throws the drag off. */
function Scale() {
  const saved = useStore((s) => s.settings?.uiScale ?? 0); // Ctrl+= and Ctrl+- change it too
  const [drag, setDrag] = useState(null);
  const level = drag ?? saved;
  const set = (v) => saveSettings({ uiScale: v }).finally(() => setDrag(null));
  return <>
    <div className="flex items-center gap-3">
      <Slider aria-label="UI scale" min={-3} max={5} step={0.5} value={[level]} onValueChange={([v]) => setDrag(v)} onValueCommit={([v]) => set(v)} className="flex-1" />
      <span className="w-12 text-right tabular-nums" data-scale>{scalePercent(level)}%</span>
    </div>
    <div><Button variant="ghost" size="xs" disabled={!level} onClick={() => set(0)}>Reset to 100%</Button></div>
  </>;
}

// What each theme looks like: its own panel, bar and text colours (app.css :root and .dark), whatever the theme in effect.
const LOOK = { light: ['#f5f5f5', '#ffffff', '#1f1f1f'], dark: ['#1a1a1a', '#262626', '#e6e6e6'] };

function Look({ theme }) {
  const half = (t) => (
    <div key={t} className="flex flex-1 flex-col" style={{ background: LOOK[t][0] }}>
      <div className="h-2.5" style={{ background: LOOK[t][1] }} />
      <div className="m-2 h-1 w-3/4 rounded-full opacity-60" style={{ background: LOOK[t][2] }} />
      <div className="mx-2 h-1 w-1/2 rounded-full opacity-40" style={{ background: LOOK[t][2] }} />
    </div>
  );
  return <div aria-hidden className="flex h-14 w-full overflow-hidden rounded-sm border">{theme === 'system' ? ['light', 'dark'].map(half) : half(theme)}</div>;
}

/** settings.uiTheme, applied at once (changeSettings) so a pick shows on the whole app behind the dialog. */
function Theme() {
  const value = useStore((s) => s.settings?.uiTheme ?? 'system');
  return (
    <Choices label="Theme" value={value} onChange={(uiTheme) => changeSettings({ uiTheme })}
      options={[['light', 'Light', Sun], ['system', 'System', Monitor], ['dark', 'Dark', Moon]].map(([v, t, I]) => [v, t, I, <Look theme={v} />])} />
  );
}

/** The integrations as Settings > Integrations has them; a switch saves at once, through the same settings change. */
function Integrations() {
  const settings = useStore((s) => s.settings);
  const value = Object.fromEntries(INTEGRATIONS.map((i) => [i.id, { ...settings.integrations?.[i.id], enabled: enabled(settings, i.id) }]));
  return <IntegrationRows expandable value={value} onChange={(integrations) => changeSettings({ integrations })} />;
}

function GitHubAsk({ next, setNav }) {
  const [yes, setYes] = useState(null);
  useEffect(() => setNav({ disabled: yes == null, go: () => next(yes ? undefined : 'github-warn') }), [yes]);
  return <Choices label="Back up your drafts to GitHub?" value={yes} onChange={setYes} options={[[true, 'Yes, back them up', CloudUpload], [false, 'No', CloudOff]]} />;
}

function GitHubWarn({ next, leave, setNav }) {
  useEffect(() => setNav({ label: 'Set up backup', go: () => next('github-account'), skip: SKIP(leave) }), []);
  return (
    <p className="flex items-start gap-2" data-backup-warning>
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
      Without a backup, your drafts live only on this computer. If something goes wrong with it, you may lose everything.
    </p>
  );
}

function GitHubAccount({ leave, setNav }) {
  const [has, setHas] = useState(null);
  useEffect(() => setNav({ disabled: has == null, label: has === false ? 'I have an account now' : undefined, skip: SKIP(leave) }), [has]);
  return <>
    <Choices label="Do you have a GitHub account?" value={has} onChange={setHas} options={[[true, 'Yes'], [false, 'No']]} />
    {has === false && <div className="grid gap-2">
      <p>Create one on GitHub, then come back here.</p>
      <div><Button asChild variant="outline" size="sm"><a href={JOIN} target="_blank" rel="noreferrer"><ExternalLink />Create a GitHub account</a></Button></div>
    </div>}
  </>;
}

function GitHubRepo({ leave, setNav }) {
  useEffect(() => setNav({ label: 'I created the private repository', skip: SKIP(leave) }), []);
  return <>
    <ol className="grid list-decimal gap-2 pl-5">
      <li>Open a new repository on GitHub.</li>
      <li>Set it to <strong>Private</strong>.</li>
      <li>Give it a name you will recognise, for example easywriter-backup.</li>
      <li>Add nothing to it. Leave README, .gitignore and licence off, so it stays empty.</li>
    </ol>
    <div><Button asChild variant="outline" size="sm"><a href={NEW_REPO} target="_blank" rel="noreferrer"><ExternalLink />Open github.com/new</a></Button></div>
  </>;
}

/** GitHub's device flow, as Settings > GitHub backup runs it: the code goes on the clipboard and GitHub's page opens; once
 * the user has entered it, the setup moves on by itself. Leaving the page while it waits cancels it. */
function GitHubSignIn({ next, leave, setNav }) {
  const [st, setSt] = useGitHubStatus();
  const [code, setCode] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(true);
  const waiting = useRef(false);
  useEffect(() => () => {
    live.current = false;
    if (waiting.current) window.api.github.logout(); // cancels the login that is waiting
  }, []);
  useEffect(() => setNav({ disabled: !st?.login, skip: SKIP(leave) }), [st?.login]);
  const start = async () => {
    setError('');
    setStarting(true);
    waiting.current = true;
    try {
      const c = await window.api.github.login();
      if (live.current) setCode(c);
      const s = await window.api.github.loginWait();
      waiting.current = false;
      if (live.current) {
        setSt(s);
        if (s.login) next();
      }
    } catch (e) {
      if (live.current && !/cancelled/.test(ipcMessage(e))) setError(ipcMessage(e));
    }
    waiting.current = false;
    if (live.current) {
      setCode(null);
      setStarting(false);
    }
  };
  if (!st) return <p className="text-muted-foreground">Checking...</p>;
  if (st.login) return <p data-github-login>{`Signed in as ${st.login}.`}</p>;
  if (!st.configured) return <p className="text-muted-foreground">This build has no GitHub app ID, so it cannot sign in. Skip the backup for now.</p>;
  if (code) return (
    <div className="grid gap-3">
      <p>Enter this code on GitHub if it is not filled in. It is on your clipboard.</p>
      <div className="flex items-center gap-2">
        <code data-github-code className="rounded-md border bg-muted/40 px-3 py-1 font-mono text-2xl tracking-widest select-text">{code.userCode}</code>
        <Button variant="outline" size="sm" onClick={() => copy(code.userCode)}><Copy />Copy</Button>
      </div>
      <p className="flex items-center gap-2 text-muted-foreground"><Spinner />Waiting for you to sign in on GitHub</p>
      <div><Button variant="ghost" size="sm" onClick={() => window.api.github.logout()}>Cancel</Button></div>
    </div>
  );
  return (
    <div className="grid gap-2">
      <p>GitHub opens in your browser. Sign in there and enter the code shown here.</p>
      <div><Button disabled={starting} onClick={start}><LogIn />Sign in with GitHub</Button></div>
      {error && <p className="text-destructive" data-github-error>{error}</p>}
    </div>
  );
}

/** The repository picker of Settings > GitHub backup. Continue saves the backup on; on the first start it also sets pushing
 * every 5 minutes and on close (not shown here; Settings changes them), while Run setup again keeps the saved cadence. A
 * repository GitHub refuses (public, not empty) stops it. */
function GitHubPick({ next, leave, setNav }) {
  const [st] = useGitHubStatus();
  const login = st?.login;
  const [repo, setRepo] = useState(() => getState().settings.github?.repo ?? '');
  const { repos, loadRepos, check } = useRepos(login, repo);
  const ok = !!login && !!repo && !!check && !check.refused;
  useEffect(() => setNav({
    disabled: !ok,
    go: async () => {
      const { onboarded, github } = getState().settings;
      await saveSettings({ github: { ...github, ...(!onboarded && { intervalSec: 300, onClose: 'push' }), enabled: true, repo } });
      next();
    },
    skip: SKIP(leave),
  }), [ok, repo]);
  if (!st) return <p className="text-muted-foreground">Checking...</p>;
  if (!login) return <p>Sign in with GitHub on the page before this one first.</p>;
  return <RepoPicker repo={repo} onPick={setRepo} repos={repos} loadRepos={loadRepos} check={check} />;
}

function Finish({ usedBefore, finish, setNav }) {
  useEffect(() => setNav({ label: 'Start writing', go: finish }), []);
  if (usedBefore !== false) return null;
  return (
    <button type="button" disabled data-tutorial className="flex items-center gap-3 rounded-md border p-3 text-left disabled:opacity-60">
      <GraduationCap className="size-5 shrink-0" />
      <span className="grid gap-0.5">
        <span className="font-medium">Take the tutorial</span>
        <span className="text-xs text-muted-foreground">A short walk through writing your first draft.</span>
      </span>
      <Badge className="ml-auto">Coming soon</Badge>
    </button>
  );
}

const github = (id, title, help, Page, branch) => ({ id, step: 'github', title, help, Page, branch });

export const PAGES = [
  { id: 'welcome', title: 'Welcome to EasyWriter', help: 'A few questions to set up the app. You can change every answer later in Settings.', Page: Welcome },
  { id: 'scale', title: 'UI scale', help: "100% matches your computer's own scale. Drag the bar to make everything bigger or smaller.", Page: Scale },
  { id: 'theme', title: 'Theme', help: "System follows your computer's light or dark mode. You can fine-tune the theme's colours later in Settings > General.", Page: Theme },
  { id: 'integrations', title: 'Integrations', help: 'Optional. Click a row to read what it does.', Page: Integrations },
  github('github', 'Back up your drafts to GitHub?', 'EasyWriter can push your drafts to a private GitHub repository of yours every few minutes.', GitHubAsk),
  github('github-warn', 'Skip the backup?', '', GitHubWarn, true),
  github('github-account', 'Do you have a GitHub account?', 'The backup goes to a repository in your GitHub account.', GitHubAccount),
  github('github-repo', 'Create a private repository', 'EasyWriter backs up to an empty private repository of yours.', GitHubRepo),
  github('github-signin', 'Sign in with GitHub', 'EasyWriter asks GitHub for access to your private repositories.', GitHubSignIn),
  github('github-pick', 'Pick the repository', 'Choose the private repository you created.', GitHubPick),
  { id: 'helpers', title: 'Assistant and dictation', help: 'Optional. Turn one on to set it up.', Page: Helpers },
  { id: 'finish', title: "You're all set", Page: Finish },
].map((p) => ({ step: p.id, ...p }));
