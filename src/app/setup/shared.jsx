// What Settings and the setup share (docs/plans/onboarding.md): the integration rows, the GitHub status and the repository
// picker with its check.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CircleCheck, ExternalLink, RefreshCw } from 'lucide-react';
import { cn } from 'cn';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SelectButton } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { INTEGRATIONS } from '../../integrations/index.mjs';
import { GitHubMark } from '../components/brands.jsx';
import { Help, IconButton } from '../components/Tip.jsx';

/** A box that takes the height of what it holds and moves to a new height with a transition (the user, 2026-10-26/27: the
 * dialog may change size, smoothly, without dead space). `min`, a CSS length, is the least it takes. The clip margin keeps
 * focus rings at its edges. */
export function AutoHeight({ min, children }) {
  const inner = useRef(null);
  const [h, setH] = useState(null);
  useLayoutEffect(() => {
    const el = inner.current;
    setH(el.offsetHeight);
    const watch = new ResizeObserver(() => setH(el.offsetHeight));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return (
    <div className="overflow-clip transition-[height] duration-(--motion-dialogs) ease-out [overflow-clip-margin:6px]" style={{ height: h ?? undefined }} data-auto-height>
      <div ref={inner} className="grid content-start" style={{ minHeight: min }}>{children}</div>
    </div>
  );
}

/** Where the setup sits: its bottom holds still a little below the middle of the window, so a page change or a row opening
 * grows or shrinks it at the top and Back and Continue stay where they are (the user, 2026-10-27). */
export const SETUP_PLACE = 'top-auto bottom-[max(1.5rem,calc(50vh-10rem))] translate-y-0 max-h-[calc(50vh+8.5rem)]';
/** Where a dialog over a setup page sits (helpers.jsx Sub): its bottom 4rem under the setup's, so its buttons are 2rem below
 * the setup's Continue and never line up with it (the user, 2026-10-26: a double click would go on to the next page). It also
 * grows at the top. */
export const SUB_PLACE = 'top-auto bottom-[max(0.5rem,calc(50vh-14rem))] translate-y-0 max-h-[calc(50vh+13rem)]';

/** A pick-one card of the setup (Choices, the dialogs' options, the language sides): the picked one has the primary border.
 * Once one is picked (`dim`), the others look greyed out at 60 % and a hover lifts them to 80 % (the user, 2026-10-26: slightly
 * brighter, not all the way); before that a hover only tints them. */
export const pickCard = (checked, dim = true) => cn(
  'rounded-md border outline-none transition-[opacity,background-color] duration-(--motion-status) focus-visible:ring-[3px] focus-visible:ring-ring/50',
  checked ? 'border-primary bg-accent/60' : dim ? 'opacity-60 hover:opacity-80 focus-visible:opacity-80' : 'hover:bg-accent/30',
);

// An IPC rejection's own message, without Electron's "Error invoking remote method ..." prefix.
export const ipcMessage = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
export const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast.error('Could not copy'));

/** One row per integration with its switch. `value` is {<id>: {enabled}}; onChange gets the whole map. In Settings each row
 * shows what the integration does and may do; `expandable` (the setup) shows its name, and a click on the row (not the
 * switch) shows the rest (the user, 2026-10-27: rather than a (?)). data-agent-deny: agents never turn an integration on or off. */
export function IntegrationRows({ value, onChange, expandable }) {
  const [open, setOpen] = useState(null);
  const flip = (id, on) => onChange({ ...value, [id]: { ...value[id], enabled: on } });
  return (
    <div className="grid gap-3" data-agent-deny>
      {INTEGRATIONS.map((i) => {
        const shown = !expandable || open === i.id;
        const details = (
          <>
            <span className="max-w-[36rem] text-xs text-muted-foreground">{i.description}</span>
            <ul className="list-disc pl-4 text-xs text-muted-foreground">
              {i.permissions.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </>
        );
        if (!expandable) return (
          <div key={i.id} className="flex items-start gap-3 rounded-md border p-3" data-integration={i.id}>
            <Switch id={`set-int-${i.id}`} className="mt-0.5" checked={value[i.id].enabled} onCheckedChange={(on) => flip(i.id, on)} />
            <div className="grid gap-1">
              <Label htmlFor={`set-int-${i.id}`}>{i.name}</Label>
              {details}
            </div>
          </div>
        );
        return (
          <div key={i.id} className="rounded-md border" data-integration={i.id}>
            <div className="flex items-center gap-3 pr-3">
              <button type="button" aria-expanded={shown} onClick={() => setOpen(shown ? null : i.id)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-3 text-left outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !shown && '-rotate-90')} />
                <span className="font-medium">{i.name}</span>
              </button>
              <Switch aria-label={i.name} checked={value[i.id].enabled} onCheckedChange={(on) => flip(i.id, on)} />
            </div>
            {shown && <div className="grid animate-page-in gap-1 px-3 pb-3 pl-9" data-integration-details>{details}</div>}
          </div>
        );
      })}
    </div>
  );
}

const OPEN_AFTER = 1000; // ms the ring fills before GitHub's page opens

/** A ring that fills once over `ms`. */
function Ring({ ms }) {
  const [full, setFull] = useState(false);
  useEffect(() => {
    let f = requestAnimationFrame(() => { f = requestAnimationFrame(() => setFull(true)); }); // after the empty ring is drawn
    return () => cancelAnimationFrame(f);
  }, []);
  const C = 2 * Math.PI * 6;
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90" aria-hidden data-ring>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={C}
        strokeDashoffset={full ? 0 : C} style={{ transition: `stroke-dashoffset ${ms}ms linear` }} />
    </svg>
  );
}

/** GitHub's sign-in code (github.login's {userCode, url}) and one button: it copies the code, says so, fills a ring for a second
 * with "Opening your browser...", then opens GitHub's page, and the wait shows. Nothing opens by itself, since a browser window
 * would cover the code and the app (the user, 2026-10-26). `onCancel` drops the sign-in. */
export function GitHubCode({ code, onCancel }) {
  const [step, setStep] = useState('ready'); // ready | opening | open
  useEffect(() => {
    if (step !== 'opening') return undefined;
    const t = setTimeout(() => {
      window.open(code.url); // main's window open handler sends an https link to the browser
      setStep('open');
    }, OPEN_AFTER);
    return () => clearTimeout(t);
  }, [step]);
  const go = () => navigator.clipboard.writeText(code.userCode).then(() => setStep('opening'), () => toast.error('Could not copy the code'));
  return (
    <div className="grid justify-items-start gap-3" data-github-step={step}>
      <code data-github-code className="rounded-md border bg-muted/40 px-3 py-1 font-mono text-2xl tracking-widest select-text">{code.userCode}</code>
      {step === 'ready' ? (
        <div className="flex items-center gap-2">
          <Button type="button" onClick={go} data-github-open><GitHubMark />Copy code and open GitHub</Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      ) : <p className="flex items-center gap-2" data-github-copied><CircleCheck className="size-4 text-success" />Code copied</p>}
      {step === 'opening' && <p className="flex items-center gap-2"><Ring ms={OPEN_AFTER} />Opening your browser...</p>}
      {step === 'open' && <>
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner />Waiting for you to sign in on GitHub
          <Help>Sign in on GitHub and paste the code if it is not filled in. This page goes on by itself once you are in.</Help>
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={go}><ExternalLink />Open GitHub again</Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      </>}
    </div>
  );
}

/** The GitHub backup's status (github.status, then each github.event) and its setter; null until main answers. */
export function useGitHubStatus() {
  const [st, setSt] = useState(null);
  useEffect(() => {
    window.api.github.status().then(setSt, () => {});
    return window.api.github.onEvent(setSt);
  }, []);
  return [st, setSt];
}

/** While `login` is set: the user's private repositories (null while loading), loadRepos() to ask again, and github.checkRepo
 * of `repo` (null while checking). */
export function useRepos(login, repo) {
  const [repos, setRepos] = useState(null);
  const [check, setCheck] = useState(null);
  const loadRepos = () => {
    setRepos(null); // the list shows Loading... until GitHub answers
    window.api.github.repos().then(setRepos, (e) => { setRepos([]); toast.error(ipcMessage(e)); });
  };
  useEffect(() => { if (login) loadRepos(); }, [login]);
  useEffect(() => {
    setCheck(null);
    if (!login || !repo) return undefined;
    let live = true;
    window.api.github.checkRepo(repo).then((c) => live && setCheck(c), () => {});
    return () => { live = false; };
  }, [login, repo]);
  return { repos, loadRepos, check };
}

/** The line under the picked repository: why it cannot be used (a check that failed), or what the first push does. */
export const repoNote = (repo, check) => (!repo ? '' : !check ? 'Checking...' : !check.ok ? check.error
  : check.empty ? 'Empty. The first push starts the backup.' : 'Holds an EasyWriter backup. Saving merges it with this computer.');

/** The repository picker: a button showing the pick, the list under it (search by typing, a click or Enter picks and closes),
 * Reload, and the check's line. The list is modal, so a dialog around it leaves it the wheel. */
export function RepoPicker({ repo, onPick, repos, loadRepos, check }) {
  const [open, setOpen] = useState(false);
  const note = repoNote(repo, check);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <Popover modal open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <SelectButton role="combobox" aria-expanded={open} aria-label="Repository" data-placeholder={repo ? undefined : ''} className="w-96 max-w-full">
              <span className="truncate">{repo || 'Choose a repository'}</span>
            </SelectButton>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 p-0">
            <Command className="bg-transparent">
              <CommandInput placeholder="Search your private repositories..." />
              <CommandList className="max-h-48">
                <CommandEmpty>{repos ? 'No private repository found.' : 'Loading...'}</CommandEmpty>
                {repos && [...new Set([repo, ...repos])].filter(Boolean).map((r) => (
                  <CommandItem key={r} value={r} onSelect={() => { onPick(r); setOpen(false); }}>
                    <Check className={r === repo ? '' : 'invisible'} />
                    <span className="truncate">{r}</span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <IconButton size="regular" label="Reload the list" disabled={!repos} onClick={loadRepos}><RefreshCw /></IconButton>
      </div>
      {note && <span className={`text-xs ${check && !check.ok ? 'text-destructive' : 'text-muted-foreground'}`} data-repo-note>{note}</span>}
    </div>
  );
}
