// What Settings and the setup share (docs/plans/onboarding.md): the integration rows, the GitHub status and the repository
// picker with its check.
import { useEffect, useState } from 'react';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';
import { cn } from 'cn';
import { toast } from 'sonner';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SelectButton } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { INTEGRATIONS } from '../../integrations/index.mjs';
import { IconButton } from '../components/Tip.jsx';

// An IPC rejection's own message, without Electron's "Error invoking remote method ..." prefix.
export const ipcMessage = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
export const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast.error('Could not copy'));

/** One row per integration with its switch. `value` is {<id>: {enabled}}; onChange gets the whole map. In Settings each row
 * shows what the integration does and may do; `expandable` (the setup) shows its name and first sentence, and a click on
 * the row (not the switch) shows the rest. data-agent-deny: agents never turn an integration on or off. */
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
                <span className="grid min-w-0 gap-0.5">
                  <span className="font-medium">{i.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{i.description.split(/(?<=\.)\s/)[0]}</span>
                </span>
              </button>
              <Switch aria-label={i.name} checked={value[i.id].enabled} onCheckedChange={(on) => flip(i.id, on)} />
            </div>
            {shown && <div className="grid gap-1 px-3 pb-3 pl-9" data-integration-details>{details}</div>}
          </div>
        );
      })}
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
 * Reload, and the check's line. */
export function RepoPicker({ repo, onPick, repos, loadRepos, check }) {
  const [open, setOpen] = useState(false);
  const note = repoNote(repo, check);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
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
