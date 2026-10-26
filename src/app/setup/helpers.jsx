// The setup's page 6, the assistant and dictation (docs/plans/onboarding.md helpers): a card for each with a switch. Switching
// one on opens its dialog over the setup; the switch stays on once that dialog is done and goes back off on Cancel. Switching
// one off saves it off at once (the assistant's provider None; dictation not installed, its files kept). data-agent-deny on the
// assistant's card and dialogs: as in Settings > Assistant, the assistant never changes its own provider or policy.
import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { MessageSquare, Mic } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { saveSettings } from '../actions.js';
import { ASSISTANT_DEFAULTS, saveAssistant } from '../assistant/assistant.js';
import {
  assistantFields, CLI, pathValue, PERMISSION_HINT, PERMISSIONS, Pick, PROVIDER, ProviderFields, providerOf, PROVIDERS, SUGGEST_HINT,
  useAssistantStatus,
} from '../components/SettingsDialog.jsx';
import { LANGUAGES } from '../dictation/core.mjs';
import { mb } from '../dictation/Dictation.jsx';
import { cancelInstall, dictationReady, dictationSettings, install } from '../dictation/dictation.js';
import { getState, useStore } from '../store.js';
import { ipcMessage } from './shared.jsx';

const keep = (e) => e.preventDefault();
const assistantOf = (s) => ({ ...ASSISTANT_DEFAULTS, ...s?.assistant });
// Dictation on the user's own whisper.cpp (Settings > Dictation, advanced) is ready without an install, so this page cannot turn it off.
const ownServer = (d) => !!d?.serverUrl?.trim() || (!!d?.serverPath && !!d?.modelPath);

/** A choice card in a radiogroup: a title, an optional badge and a line under it. */
function Option({ checked, onPick, title, badge, line, ...rest }) {
  return (
    <button type="button" role="radio" aria-checked={checked} onClick={onPick} {...rest}
      className="grid gap-0.5 rounded-md border p-3 text-left outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-checked:border-primary aria-checked:bg-accent/60">
      <span className="flex items-center gap-2 font-medium">{title}{badge && <Badge>{badge}</Badge>}</span>
      {line && <span className="text-xs text-muted-foreground">{line}</span>}
    </button>
  );
}

/** The dialog over the setup: title, help, body and a bar. Escape is Cancel; a click outside does nothing. */
function Sub({ title, help, bar, onCancel, children, ...rest }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent showCloseButton={false} onInteractOutside={keep} {...rest}
        className="max-h-[88vh] gap-4 overflow-y-auto rounded-island bg-island p-5 text-sm sm:max-w-[40rem]">
        <div className="grid gap-1.5">
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription>{help}</DialogDescription>
        </div>
        {children}
        <div className="flex items-center gap-2">{bar}</div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Dictation

/** The model (dictation-main.js MODELS, largest first, Small preselected), the language (Default English, or one picked,
 * Automatic first; the side touched last is used) and the existing install with its progress. Cancel stops a download. */
function DictationDialog({ onDone, onCancel }) {
  const [model, setModel] = useState('small');
  const [side, setSide] = useState('default'); // 'default' (English) | 'pick'
  const [picked, setPicked] = useState('auto');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => {
    let on = true;
    window.api.dictation.status({ model }).then((s) => on && setStatus(s), (e) => on && setError(ipcMessage(e)));
    return () => { on = false; };
  }, [model]);
  useEffect(() => window.api.dictation.onProgress(setProgress), []);
  const language = side === 'default' ? 'en' : picked;
  const start = async () => {
    setBusy(true);
    setProgress(null);
    setError('');
    try {
      await install(model, language); // saves settings.dictation installed, with this model and language
      if (live.current) onDone();
    } catch (e) {
      if (!live.current) return;
      setBusy(false);
      setError(e.message === 'cancelled' ? 'The download was cancelled.' : e.message);
    }
  };
  const cancel = () => {
    if (busy) cancelInstall();
    onCancel();
  };
  const total = status ? status.missing.reduce((n, m) => n + m.bytes, 0) : 0;
  const pct = progress?.total ? Math.round((progress.received / progress.total) * 100) : 0;
  const models = [...(status?.models ?? [])].sort((x, y) => y.bytes - x.bytes);
  const container = (id) => cn('grid content-start gap-2 rounded-md border p-3', side === id ? 'border-primary' : 'opacity-60');
  return (
    <Sub title="Set up dictation" help="Pick a model and the language you speak, then install it. It runs with whisper.cpp."
      onCancel={cancel} data-setup-dialog="dictation"
      bar={<>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={cancel}>Cancel</Button>
        <Button size="sm" disabled={busy || !status} onClick={start} data-dictation-install data-agent-risk={total ? 'approval' : undefined}>
          {error ? 'Try again' : total ? `Download and install (${mb(total)})` : 'Use this model'}
        </Button>
      </>}>
      <fieldset disabled={busy} className="grid gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Model</legend>
        <div role="radiogroup" aria-label="Dictation model" className="grid gap-2">
          {!status && !error && <p className="text-muted-foreground">Checking...</p>}
          {models.map((m) => (
            <Option key={m.id} data-model={m.id} checked={model === m.id} autoFocus={model === m.id} onPick={() => setModel(m.id)}
              title={`${m.label} (${mb(m.bytes)})${m.downloaded ? ', downloaded' : ''}`} badge={m.id === 'small' && 'Recommended'}
              line={m.note.replace(/^Recommended\.\s*/, '')} />
          ))}
        </div>
      </fieldset>
      <fieldset disabled={busy} className="grid gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Language</legend>
        <div role="radiogroup" aria-label="Dictation language" className="grid grid-cols-2 gap-3">
          <div className={container('default')} data-language-side="default" onPointerDown={() => setSide('default')}>
            <button type="button" role="radio" aria-checked={side === 'default'} onClick={() => setSide('default')}
              className="rounded-sm text-left font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">Default</button>
            <span className="flex h-8 items-center">English</span>
          </div>
          <div className={container('pick')} data-language-side="pick" onPointerDown={() => setSide('pick')}>
            <button type="button" role="radio" aria-checked={side === 'pick'} onClick={() => setSide('pick')}
              className="rounded-sm text-left font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">Pick a language</button>
            <Pick label="Language" value={picked} className="w-full" options={[['auto', 'Automatic'], ...LANGUAGES]}
              onChange={(v) => { setPicked(v); setSide('pick'); }} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The side you touched last is used. Automatic detects the language each time, and a short phrase can come out in another one.
        </p>
      </fieldset>
      {busy && (
        <div className="grid gap-1" role="status" data-dictation-progress>
          <span>
            {progress ? `Downloading the ${progress.label} (${progress.step} of ${progress.steps})` : 'Starting...'}
            {progress?.total ? `, ${mb(progress.received)} of ${mb(progress.total)}` : ''}
          </span>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-[width] duration-(--motion-status)" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {error && <p className="text-destructive" data-dictation-error>{error}</p>}
    </Sub>
  );
}

// ---------------------------------------------------------------------------------------------
// Assistant

const API = '(API)';
const MISSING = '(not installed)';

/** The provider and its fields as Settings > Assistant has them, and the writing guide (on). Save checks it: an API key
 * through the provider's models list (assistant.checkKey, no tokens spent), Claude Code or Codex through Settings' Test. Then
 * the permission mode and Auto-approve assistant edits; Done saves it all. MCP is left as it is. */
function AssistantDialog({ onDone, onCancel }) {
  const [a, setA] = useState(() => {
    const saved = assistantOf(getState().settings);
    return { ...saved, provider: saved.provider === 'none' ? 'qwen' : providerOf(saved) };
  });
  const edit = (patch) => setA((v) => ({ ...v, ...patch }));
  const [status, recheck] = useAssistantStatus(a);
  const [page, setPage] = useState('provider'); // 'provider' | 'permission'
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [missing, setMissing] = useState({}); // {claude, codex}: true when the probe found no CLI
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => {
    for (const id of Object.keys(CLI)) {
      window.api.assistant.status({ provider: id }).then((st) => live.current && setMissing((m) => ({ ...m, [id]: st.state === 'not_found' })), () => {});
    }
  }, []);
  useEffect(() => setError(''), [a.provider]);
  const options = PROVIDERS.filter(([id]) => id !== 'none')
    .map(([id, label]) => [id, PROVIDER[id] ? `${label} ${API}` : missing[id] ? `${label} ${MISSING}` : label]);
  const check = async () => {
    setChecking(true);
    setError('');
    const f = CLI[a.provider];
    let why = '';
    try {
      if (f) {
        const t = await window.api.assistant.cliTest({ provider: a.provider, [f.path]: pathValue(a[f.path]), [f.model]: a[f.model].trim(), [f.effort]: a[f.effort] });
        why = !t.ok ? t.message || 'The test failed.' : !t.tools ? `${f.label} replied but did not reach EasyWriter's tools.` : '';
      } else {
        const r = await window.api.assistant.checkKey({ provider: a.provider, key: a[PROVIDER[a.provider].key] });
        why = r.ok ? '' : r.message;
      }
    } catch (e) {
      why = ipcMessage(e);
    }
    if (!live.current) return;
    setChecking(false);
    if (why) setError(why);
    else setPage('permission');
  };
  const done = async () => {
    setChecking(true);
    try {
      await saveAssistant(assistantFields(a));
      if (live.current) onDone();
    } catch (e) {
      if (!live.current) return;
      setChecking(false);
      setError(ipcMessage(e));
    }
  };
  if (page === 'permission') return (
    <Sub title="What may the assistant do?" help="You can change this later in Settings > Assistant." onCancel={onCancel} data-setup-dialog="assistant-permission" data-agent-deny
      bar={<>
        <Button variant="ghost" size="sm" onClick={() => setPage('provider')}>Back</Button>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={checking} onClick={done} data-assistant-done>Done</Button>
      </>}>
      <div role="radiogroup" aria-label="Assistant permissions" className="grid gap-2">
        {PERMISSIONS.map(([id, label]) => {
          const hint = (a.autoApproveEdits ? PERMISSION_HINT : SUGGEST_HINT)[id];
          return <Option key={id} data-permission={id} checked={a.permission === id} onPick={() => edit({ permission: id })}
            title={label} line={hint.startsWith(`${label}. `) ? hint.slice(label.length + 2) : hint} />;
        })}
      </div>
      <div className="flex items-start gap-2">
        <Switch id="setup-auto" className="mt-0.5" checked={a.autoApproveEdits === true} onCheckedChange={(on) => edit({ autoApproveEdits: on })} />
        <div className="grid gap-0.5">
          <Label htmlFor="setup-auto">Auto-approve assistant edits</Label>
          <span className="text-xs text-muted-foreground">When this is off, the assistant's edits wait in the draft as suggestions until you accept or reject them.</span>
        </div>
      </div>
      {error && <p className="text-destructive" data-assistant-error>{error}</p>}
    </Sub>
  );
  return (
    <Sub title="Set up the assistant" help="Pick who answers. An API provider needs your key. Claude and ChatGPT run on their own apps with your sign-in."
      onCancel={onCancel} data-setup-dialog="assistant" data-agent-deny
      bar={<>
        {checking && <span className="flex items-center gap-2 text-muted-foreground"><Spinner />{CLI[a.provider] ? 'Testing...' : 'Checking the key...'}</span>}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={checking} onClick={check} data-assistant-save>Save</Button>
      </>}>
      <div className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <Label className="w-16 text-muted-foreground">Provider</Label>
          <Pick label="Assistant provider" value={a.provider} onChange={(provider) => edit({ provider })} options={options} className="w-64" />
        </div>
        <ProviderFields value={a} edit={edit} status={status} recheck={recheck} />
      </div>
      <div className="flex items-start gap-2">
        <Checkbox id="setup-guide" className="mt-0.5" checked={a.humanWriting !== false} onCheckedChange={(v) => edit({ humanWriting: v === true })} />
        <div className="grid gap-0.5">
          <Label htmlFor="setup-guide">Follow the human writing guide</Label>
          <span className="text-xs text-muted-foreground">Sends EasyWriter's writing guide with every message. It adds about 2,000 tokens to each request.</span>
        </div>
      </div>
      {error && <p className="text-destructive" data-assistant-error>{error}</p>}
    </Sub>
  );
}

// ---------------------------------------------------------------------------------------------
// The page

const CARDS = [
  ['assistant', 'Assistant', MessageSquare, 'Answers questions about your drafts and edits them, with the AI provider you pick.'],
  ['dictation', 'Dictation', Mic, 'Turns your speech into text. It runs on this computer, so no audio leaves it.'],
];
const OWN = 'It uses your own whisper.cpp. Change that in Settings > Dictation.';

export function Helpers() {
  const settings = useStore((s) => s.settings);
  const [open, setOpen] = useState(null); // the card whose dialog shows
  const on = { assistant: assistantOf(settings).provider !== 'none', dictation: dictationReady(settings.dictation) };
  const flip = (id, v) => {
    if (v) return setOpen(id);
    if (id === 'assistant') saveAssistant({ provider: 'none' });
    else saveSettings({ dictation: { ...dictationSettings(), installed: false } });
  };
  const close = () => setOpen(null);
  const own = ownServer(settings.dictation);
  return <>
    <div className="grid grid-cols-2 gap-3">
      {CARDS.map(([id, name, Icon, line]) => (
        <div key={id} className="grid content-start gap-3 rounded-md border p-4" data-helper={id}
          data-agent-deny={id === 'assistant' || undefined}>
          <div className="flex items-center justify-between">
            <span className="flex size-9 items-center justify-center rounded-md bg-accent"><Icon className="size-5" /></span>
            <Switch id={`setup-${id}`} checked={on[id] || open === id} disabled={id === 'dictation' && own} onCheckedChange={(v) => flip(id, v)} />
          </div>
          <div className="grid gap-0.5">
            <Label htmlFor={`setup-${id}`} className="font-medium">{name}</Label>
            <span className="text-xs text-muted-foreground" data-helper-line>{id === 'dictation' && own ? OWN : line}</span>
          </div>
        </div>
      ))}
    </div>
    {open === 'assistant' && <AssistantDialog onDone={close} onCancel={close} />}
    {open === 'dictation' && <DictationDialog onDone={close} onCancel={close} />}
  </>;
}
