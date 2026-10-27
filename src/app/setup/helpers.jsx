// The setup's page 6, the assistant and dictation (docs/plans/onboarding.md helpers): a card for each with a switch. Switching
// one on opens its dialog over the setup; the switch stays on once that dialog is done and goes back off on Cancel. Switching
// one off saves it off at once (the assistant's provider None; dictation not installed, its files kept). data-agent-deny on the
// assistant's card and dialogs: as in Settings > Assistant, the assistant never changes its own provider or policy.
import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { AudioLines, Eye, Globe, MessageCircleQuestion, MessageSquare, Mic, ShieldCheck, Zap } from 'lucide-react';
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
  assistantFields, CLI, pathValue, PERMISSION_HINT, PERMISSIONS, Pick, PROVIDER, ProviderFields, providerOf, PROVIDERS, SpokenLanguages,
  SUGGEST_HINT, useAssistantStatus,
} from '../components/SettingsDialog.jsx';
import { Help } from '../components/Tip.jsx';
import { spokenFields } from '../dictation/core.mjs';
import { LanguageNotice, mb, ModelLevel, ModelPoints } from '../dictation/Dictation.jsx';
import { cancelInstall, dictationReady, dictationSettings, install } from '../dictation/dictation.js';
import { getState, useStore } from '../store.js';
import { AutoHeight, ipcMessage, pickCard, SUB_PLACE } from './shared.jsx';

const keep = (e) => e.preventDefault();
const assistantOf = (s) => ({ ...ASSISTANT_DEFAULTS, ...s?.assistant });
// Dictation on the user's own whisper.cpp (Settings > Dictation, advanced) is ready without an install, so this page cannot turn it off.
const ownServer = (d) => !!d?.serverUrl?.trim() || (!!d?.serverPath && !!d?.modelPath);

/** A choice card in a radiogroup: an icon, a title, a badge, small text at the end of the title row (`aside`), what goes under
 * it (`children`), and `help` behind a (?) in its corner. */
function Option({ checked, onPick, icon, title, badge, aside, help, children, ...rest }) {
  const card = (
    <button type="button" role="radio" aria-checked={checked} onClick={onPick} {...rest} className={cn(pickCard(checked), 'grid w-full gap-1 p-3 text-left')}>
      <span className={cn('flex items-center gap-2 font-medium', help && 'pr-6')}>
        {icon}{title}{badge && <Badge>{badge}</Badge>}
        {aside && <span className="ml-auto text-xs font-normal text-muted-foreground">{aside}</span>}
      </span>
      {children}
    </button>
  );
  return help ? <div className="relative">{card}<Help className="absolute top-2.5 right-2.5">{help}</Help></div> : card;
}

/** The dialog over the setup: the title with its help behind a (?), the body, which grows and shrinks smoothly at the top, and
 * its buttons (`bar`) at the bottom, 2rem under the setup's Continue (SUB_PLACE). Escape is Cancel; a click outside does
 * nothing. */
function Sub({ title, help, bar, onCancel, children, ...rest }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent showCloseButton={false} onInteractOutside={keep} {...rest}
        className={cn('gap-4 overflow-y-auto rounded-island bg-island p-5 text-sm sm:max-w-[40rem]', SUB_PLACE)}>
        <div className="flex items-center gap-1.5">
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <Help>{help}</Help>
          <DialogDescription className="sr-only">{help}</DialogDescription>
        </div>
        <AutoHeight><div className="grid gap-4">{children}</div></AutoHeight>
        <div className="flex items-center justify-end gap-2" data-sub-bar>{bar}</div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Dictation

/** The model (dictation-main.js MODELS, largest first, Small preselected), the languages (Default English, or the ones picked,
 * none = Automatic; the side touched last is used; 粵語 on Small or Base offers Best quality) and the existing install with its
 * progress. Cancel stops a download. */
function DictationDialog({ onDone, onCancel }) {
  const [model, setModel] = useState('small');
  const [side, setSide] = useState('default'); // 'default' (English) | 'pick'
  const [picked, setPicked] = useState([]);
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
  const { language, languages } = spokenFields(side === 'default' ? ['en'] : picked);
  const start = async () => {
    setBusy(true);
    setProgress(null);
    setError('');
    try {
      await install(model, language, languages); // saves settings.dictation installed, with this model and these languages
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
  const container = (id) => cn(pickCard(side === id), 'grid content-start gap-2 p-3');
  return (
    <Sub title="Set up dictation" help="Pick a model and the languages you speak, then install it. It runs on this computer with whisper.cpp, so no audio leaves it."
      onCancel={cancel} data-setup-dialog="dictation"
      bar={<>
        <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
        <Button size="sm" disabled={busy || !status} onClick={start} data-dictation-install data-agent-risk={total ? 'approval' : undefined}>
          {error ? 'Try again' : total ? `Download and install (${mb(total)})` : 'Use this model'}
        </Button>
      </>}>
      <fieldset disabled={busy} className="grid gap-2">
        <legend className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><AudioLines className="size-3.5" />Model</legend>
        <div role="radiogroup" aria-label="Dictation model" className="grid grid-cols-3 gap-2">
          {!status && !error && <p className="col-span-3 text-muted-foreground">Checking...</p>}
          {models.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={model === m.id} data-model={m.id} autoFocus={model === m.id}
              onClick={() => setModel(m.id)} className={cn(pickCard(model === m.id), 'relative flex flex-col gap-2 px-3 pt-4 pb-3 text-left')}>
              {/* On the top edge, so every card's icon and name line up (the user, 2026-10-26). */}
              {m.id === 'small' && <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2">Recommended</Badge>}
              <span className="grid justify-items-center gap-1">
                <ModelLevel id={m.id} className="size-6" />
                <span className="font-medium">{m.label}</span>
              </span>
              <ModelPoints id={m.id} className="grid gap-1" />
              <span className="mt-auto text-xs text-muted-foreground">{mb(m.bytes)}{m.downloaded && ', downloaded'}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={busy} className="grid gap-2">
        <legend className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Globe className="size-3.5" />Language
          <Help>
            The side you touched last is used. With two or more languages, dictation picks the likeliest of them each time. With none,
            it detects any language, and a short phrase can come out in another one.
          </Help>
        </legend>
        <div role="radiogroup" aria-label="Dictation language" className="grid grid-cols-2 gap-3">
          <div className={container('default')} data-language-side="default" onPointerDown={() => setSide('default')}>
            <button type="button" role="radio" aria-checked={side === 'default'} onClick={() => setSide('default')}
              className="rounded-sm text-left font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">Default</button>
            <span className="flex h-8 items-center">English</span>
          </div>
          <div className={container('pick')} data-language-side="pick" onPointerDown={() => setSide('pick')}>
            <button type="button" role="radio" aria-checked={side === 'pick'} onClick={() => setSide('pick')}
              className="rounded-sm text-left font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">Pick your languages</button>
            <SpokenLanguages value={picked} onChange={(list) => { setPicked(list); setSide('pick'); }} />
          </div>
        </div>
        {side === 'pick' && <LanguageNotice model={model} list={picked} models={status?.models ?? []} onSwitch={setModel} />}
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
const PERMISSION_ICONS = { standard: ShieldCheck, ask: MessageCircleQuestion, readonly: Eye, all: Zap };

/** The provider and its fields as Settings > Assistant has them, and the writing guide (on). Save checks it: an API key
 * through the provider's models list (assistant.checkKey, no tokens spent), Claude Code or Codex through Settings' Test. Then
 * the permission mode and Auto-approve assistant edits; Done saves it all. MCP is left as it is. */
function AssistantDialog({ onDone, onCancel }) {
  const [a, setA] = useState(() => {
    const saved = assistantOf(getState().settings);
    return { ...saved, provider: providerOf(saved) };
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
  const options = PROVIDERS.map(([id, label]) => [id, id === 'none' ? 'Pick a provider' : PROVIDER[id] ? `${label} ${API}` : missing[id] ? `${label} ${MISSING}` : label]);
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
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={checking} onClick={done} data-assistant-done>Done</Button>
      </>}>
      <div role="radiogroup" aria-label="Assistant permissions" className="grid grid-cols-2 gap-2">
        {PERMISSIONS.map(([id, label]) => {
          const hint = (a.autoApproveEdits ? PERMISSION_HINT : SUGGEST_HINT)[id];
          const Icon = PERMISSION_ICONS[id];
          return <Option key={id} data-permission={id} checked={a.permission === id} onPick={() => edit({ permission: id })}
            icon={<Icon className="size-4 shrink-0" />} title={label} help={hint.startsWith(`${label}. `) ? hint.slice(label.length + 2) : hint} />;
        })}
      </div>
      <div className="flex items-center gap-2">
        <Switch id="setup-auto" checked={a.autoApproveEdits === true} onCheckedChange={(on) => edit({ autoApproveEdits: on })} />
        <Label htmlFor="setup-auto">Auto-approve assistant edits</Label>
        <Help>When this is off, the assistant's edits wait in the draft as suggestions until you accept or reject them.</Help>
      </div>
      {error && <p className="text-destructive" data-assistant-error>{error}</p>}
    </Sub>
  );
  return (
    <Sub title="Set up the assistant" help="Pick who answers. An API provider needs your key. Claude and ChatGPT run on their own apps with your sign-in."
      onCancel={onCancel} data-setup-dialog="assistant" data-agent-deny
      bar={<>
        {checking && <span className="flex items-center gap-2 text-muted-foreground"><Spinner />{CLI[a.provider] ? 'Testing...' : 'Checking the key...'}</span>}
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={checking || a.provider === 'none'} onClick={check} data-assistant-save>Save</Button>
      </>}>
      <div className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <Label className="w-16 text-muted-foreground">Provider</Label>
          <Pick label="Assistant provider" value={a.provider} onChange={(provider) => edit({ provider })} options={options} className="w-64" />
        </div>
        <ProviderFields value={a} edit={edit} status={status} recheck={recheck} />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="setup-guide" checked={a.humanWriting !== false} onCheckedChange={(v) => edit({ humanWriting: v === true })} />
        <Label htmlFor="setup-guide">Follow the human writing guide</Label>
        <Help>Sends EasyWriter's writing guide with every message. It adds about 2,000 tokens to each request.</Help>
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
const OWN = 'It uses your own whisper.cpp, so it cannot be turned off here. Change that in Settings > Dictation.';

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
          <div className="flex items-center gap-1.5">
            <Label htmlFor={`setup-${id}`} className="font-medium">{name}</Label>
            {id === 'dictation' && own && <Badge variant="secondary" data-helper-own>Your own whisper.cpp</Badge>}
            <Help>{id === 'dictation' && own ? OWN : line}</Help>
          </div>
        </div>
      ))}
    </div>
    {open === 'assistant' && <AssistantDialog onDone={close} onCancel={close} />}
    {open === 'dictation' && <DictationDialog onDone={close} onCancel={close} />}
  </>;
}
